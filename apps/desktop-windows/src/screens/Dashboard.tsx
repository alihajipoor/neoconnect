import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Clock, Gamepad2, Globe, MapPin, Settings as SettingsIcon, Shield, Tag } from "lucide-react";
import { getAvailableRoutes, getMe, getProtocolUsers, getSubscriptions } from "../lib/customer";
import { logout } from "../lib/auth";
import type { Customer, ProtocolUser, RouteOption, Subscription } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { customerProtocolLabel } from "../lib/protocol-labels";
import {
  captureBaselineIp,
  captureIpv6Baseline,
  checkIpv6,
  verifyEgress,
  type BaselineIp,
  type EgressVerdict,
} from "../lib/egress";
import {
  combineEvidence,
  customModePollState,
  fullTunnelPollState,
  handshakeEvidence,
  isTunnelUp,
  stateFromStatus,
  type VpnStatus,
} from "../lib/connection-evidence";
import { classifyConnectionError, type ClassifiedError } from "../lib/connection-errors";
import { orderCandidates, lastGoodFor, rememberLastGood, type LastGoodMap } from "../lib/failover";
import { loadChosenRoute, loadLastGood, saveChosenRoute, saveLastGood } from "../lib/failover-store";
import { isEffective, loadSplitTunnel, pushSplitTunnel } from "../lib/split-tunnel";
import { gamingDisarm, loadGaming, saveGaming, type AppMode } from "../lib/gaming";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "../lib/credential-cache";
import { refreshConnectionConfig } from "../lib/connection-config";
import { useRefreshOnResume } from "../lib/resume";
import { IS_STORE_BUILD } from "../lib/distribution";
import { endedNotice } from "../lib/subscription-state";
import { outcomeFromError, reportAttempt, rungsFrom } from "../lib/attempts";
import { isServiceTimeout, withTimeout } from "../lib/service-call";
import {
  concludeIntent,
  declareIntent,
  IDLE_INTENT,
  isCurrent,
  phaseFor,
  pressFor,
  type IntentState,
  type PressAction,
} from "../lib/connect-intent";
import { Button, Card, Stat } from "../components/ui";
import { ConnectOrb, type ConnectionState } from "../components/ConnectOrb";
import { GamingStatusPanel } from "../components/GamingStatusPanel";
import { Logo } from "../components/Logo";
import { Flag } from "../components/Flag";
import { LocationPicker } from "../components/LocationPicker";
import { CommunityLinks } from "../components/CommunityLinks";
import { RepairNetwork } from "../components/RepairNetwork";
import { useI18n } from "../lib/i18n";

/** How a ladder pass ended.
 *
 * "declined" is its own answer rather than folded into "failed", because
 * the two need different words to the customer: a pass that ran and
 * could not carry traffic has a report to show, while one that never
 * started has nothing to say about any server and must not pretend
 * otherwise. It also used to be silent, which is what a dead-looking
 * button is made of.
 */
type LadderOutcome = "connected" | "failed" | "declined";

/** Every call the screen makes to the service goes through one of these
 * two, never through a bare invoke.
 *
 * A call that can hang forever is a state that can stay on screen
 * forever -- see service-call for the teardown that proved it. */
function serviceStatus(): Promise<VpnStatus> {
  return withTimeout(invoke<VpnStatus>("vpn_status"), "vpn_status");
}

function serviceDisconnect(): Promise<void> {
  return withTimeout(invoke<void>("vpn_disconnect"), "vpn_disconnect");
}

/** How often to re-check a live tunnel.
 *
 * WireGuard rehandshakes roughly every two minutes, so this is frequent
 * enough to notice a dead tunnel well inside one cycle without polling
 * the service pointlessly hard. */
const HEALTH_POLL_MS = 15_000;

/** Floor on how often the poll's traffic check may actually run.
 *
 * The check fires once on entering a live state as well as on the
 * interval, and the live states can alternate, so the leading edge can
 * in principle re-arm far more often than the interval. This is what
 * stops a flapping tunnel from turning an every-fifteen-seconds check
 * into an every-transition one -- it runs on every customer's machine,
 * some of them on slow censored links, and the cost of a check that
 * cannot be throttled is paid by exactly the people least able to pay
 * it. */
const MIN_CHECK_GAP_MS = 5_000;

/** Consecutive bad polls before the app moves a live connection itself.
 *
 * One bad reading is not evidence: a laptop waking, a moment of packet
 * loss, or a network handover all produce one. Two in a row about thirty
 * seconds apart distinguishes "briefly unlucky" from "this protocol has
 * stopped working", which is the distinction that matters before
 * tearing down a tunnel someone is using. */
const MID_SESSION_STRIKES = 2;

/** How long to leave a live connection alone after an automatic attempt
 * has already failed its way through every protocol.
 *
 * Without this, a customer whose internet has simply gone down would
 * have the app rebuilding tunnels every thirty seconds forever, which
 * burns battery and makes the real problem harder to see. */
const MID_SESSION_COOLDOWN_MS = 120_000;

/** Consecutive unanswered polls before a live-looking connection is
 * downgraded to "we don't know".
 *
 * One miss holds the last answer, because failing to ask is not the
 * same as learning the tunnel is down. But an answer nothing has been
 * able to confirm for a minute is no longer an observation, and a green
 * "You're protected" that the app cannot currently back is the exact
 * shape of claim this screen exists not to make. */
const STATUS_MISSES_BEFORE_UNKNOWN = 4;

/** How long a state that is supposed to be passing through may stand
 * before the app stops believing its own bookkeeping and asks the
 * service instead.
 *
 * Transient states describe an operation, not the tunnel, and both of
 * them outlived their operation tonight: "Disconnecting..." stayed on
 * screen after the engines and adapters were gone, and a connect
 * spinner survived every press that was supposed to end it. Whatever
 * was driving the state is not always going to arrive, so each one gets
 * a deadline and the service settles it.
 *
 * Also the retry clock for "unknown": that state is not a resting place
 * either, and the service is usually back within seconds. */
const TRANSIENT_RECHECK_MS: Partial<Record<ConnectionState, number>> = {
  // Every one of these is longer than SERVICE_CALL_TIMEOUT_MS on
  // purpose: a shorter one would start a second question before the
  // first had been given up on, and against a service that has stopped
  // answering they would simply accumulate.
  disconnecting: 10_000,
  connecting: 30_000,
  verifying: 30_000,
  unknown: 8_000,
};

/** How long to keep asking after a teardown before believing a status
 * that still reports a tunnel. See confirmTornDown -- Windows removes
 * the adapter after the service has acknowledged the request, so the
 * first answer is routinely a stale "up". */
const TEARDOWN_SETTLE_MS = 6_000;
const TEARDOWN_POLL_MS = 1_000;

/** After this, a ladder pass is presumed never to return.
 *
 * A boolean guard was enough while every step was guaranteed to finish.
 * It is not once a step can hang forever: the pass holding the guard
 * may never reach its own `finally`, and then every press of Connect
 * reads as "cancel the pass in progress" and the app can never connect
 * again. That is the third press that froze the window.
 *
 * Sized off the ladder's own worst case rather than picked: four
 * rejected candidates at roughly ten seconds each, plus a last one
 * given the patient budgets (six to settle, thirty to prove egress,
 * eight to confirm reachability), lands near ninety seconds. Two and a
 * half minutes is comfortably past that, so no real pass is ever
 * declared dead, and a wedged one stops holding the app hostage. */
const LADDER_MAX_MS = 150_000;

/** How long to give a fresh tunnel to prove itself before calling it
 * degraded.
 *
 * A WireGuard handshake normally completes within a second or two, but
 * it is not instant, and checking the moment vpn_connect returns would
 * report every healthy connection as broken. Eight seconds is far longer
 * than a working handshake needs and still short enough that a genuinely
 * dead tunnel is called out while the customer is still looking. */
const CONFIRM_TIMEOUT_MS = 8_000;
const CONFIRM_INTERVAL_MS = 700;

/** Waits for the far end to answer, then reports what is actually true.
 *
 * Returns as soon as there is a definite answer rather than always
 * burning the full timeout, so a working connection still feels instant.
 */
async function confirmReachable(): Promise<ConnectionState> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let last: ConnectionState = "degraded";

  while (Date.now() < deadline) {
    let status: VpnStatus;
    try {
      status = await serviceStatus();
    } catch {
      // The service being briefly unreachable is not evidence about the
      // tunnel, so keep waiting rather than concluding anything.
      await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
      continue;
    }

    if (!status.connected) return "disconnected";

    // Two reasons to stop waiting, and they are not the same answer.
    //
    // `alive` is a handshake: the far end is talking to us, and that is
    // as much as this function was ever able to establish.
    //
    // `unknown` means no handshake evidence exists for this protocol
    // (Xray, OpenVPN, IKEv2), so there is nothing more to wait for --
    // but there is also nothing to report. This used to return
    // "connected" for it, which is the process-is-alive substitution
    // this change exists to remove: `stateFromStatus` now answers
    // `unverified`, and waiting longer cannot turn that into evidence.
    const settled = stateFromStatus(status);
    if (settled === "connected" || settled === "unverified") return settled;

    last = settled;
    await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
  }

  return last;
}

/** How long a tunnel gets to start carrying traffic before the app is
 * willing to say something is wrong.
 *
 * The helper service reports success 1.5s after spawning an engine, but
 * OpenVPN spends ten to twenty seconds negotiating and installing routes
 * after that. Judging it immediately produced a red warning -- "your
 * traffic is NOT protected" -- over a connection that was simply still
 * coming up, which is exactly the thing that makes someone give up and
 * assume the product is broken. Reported that way.
 *
 * Thirty seconds is longer than any of the three protocols needs and
 * still short enough that a genuinely dead server is called out while
 * the customer is watching. */
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_INTERVAL_MS = 1_500;

/** Waits for traffic to actually start flowing, rather than asking once.
 *
 * Retries even on a definite-looking "bypassing" answer, because early in
 * a connection it is not definite at all: OpenVPN's routes arrive from
 * the server partway through negotiation, so traffic genuinely does go
 * around the tunnel for a moment before it goes through it.
 *
 * Returns as soon as it has proof, so a fast protocol stays fast.
 */
async function confirmEgress(
  baseline: BaselineIp | null,
  budgetMs = VERIFY_TIMEOUT_MS,
): Promise<EgressVerdict> {
  const deadline = Date.now() + budgetMs;
  let last: EgressVerdict = { state: "unreachable" };

  while (Date.now() < deadline) {
    const verdict = await verifyEgress(baseline);
    if (verdict.state === "throughTunnel") return verdict;
    last = verdict;
    await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
  return last;
}

/** How long to wait for ordinary networking to come back after tearing
 * an engine down.
 *
 * `wireguard.exe /uninstalltunnelservice` returns as soon as the command
 * completes, but Windows removes the service and its adapter
 * asynchronously -- and while that is happening the default route can
 * still point into a tunnel that no longer carries anything. An engine
 * started inside that window has its packets black-holed and fails for a
 * reason that has nothing to do with the protocol it was testing. */
const SETTLE_TIMEOUT_MS = 6_000;
const SETTLE_INTERVAL_MS = 400;

/** The budgets that apply while there is another protocol to fall back
 * to, as opposed to the patient ones used for a lone connection.
 *
 * The patient budgets exist for a good reason: with nowhere else to go,
 * waiting 30 seconds for a slow OpenVPN negotiation beats declaring
 * failure on something that was about to work. Inside a loop that same
 * patience is ruinous -- worst case per rejected candidate was a 6s
 * settle, a 1.5s start, a 30s egress wait and an 8s reachability check,
 * about 45 seconds each, so a customer whose first protocol was blocked
 * could wait minutes. Nobody waits minutes for a VPN; they conclude it
 * is broken and close it, which is the correct conclusion about a
 * product that behaves that way.
 *
 * A candidate that has not proven it carries traffic within a few
 * seconds is not worth more time when another one is sitting right
 * there untried.
 *
 * Six seconds, not the four this started at, and the difference was
 * measured rather than guessed. In a live mid-session test REALITY came
 * up, carried real traffic including a DNS lookup, and was abandoned
 * eight seconds later because it had not finished proving itself inside
 * four -- an Xray protocol whose TUN adapter is still being created,
 * over a 155ms round trip, does not always make that. The customer
 * ended up on the next protocol down instead of the best one available.
 *
 * That also corrects the reasoning this comment used to carry. "Being
 * wrong is cheap, the ladder comes back round" is false: the ladder does
 * not come back round. It moves on and settles wherever it first
 * succeeds, so rejecting a working candidate is not a retry, it is a
 * worse outcome that looks like success.
 *
 * The cost of the extra two seconds falls only on protocols that really
 * are blocked -- worst case across five goes from about twenty seconds
 * to thirty. Being too impatient costs the right answer; being too
 * patient costs a few seconds. */
const FAILOVER_VERIFY_TIMEOUT_MS = 6_000;
const FAILOVER_SETTLE_TIMEOUT_MS = 2_500;

/** Waits until the machine can reach the outside world unaided, and
 * returns the address the world sees.
 *
 * Serves two purposes at once, which is why it is one function. It
 * proves the previous engine's routes are really gone before the next
 * one is tried -- without this, one failed attempt poisoned every
 * attempt after it, and a whole failover run reported "no traffic got
 * through" while the server never saw so much as a connection. And the
 * moment it succeeds is the only correct moment to take a baseline: an
 * address captured through a live tunnel makes the next comparison read
 * every working connection as a leak.
 *
 * Null means we could not reach our own API even unprotected. That is
 * not a reason to refuse to connect -- their network may be fine and
 * ours may not be -- so the caller proceeds without a baseline and falls
 * back to handshake evidence.
 */
async function settleAndCaptureBaseline(budgetMs = SETTLE_TIMEOUT_MS): Promise<BaselineIp | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const ip = await captureBaselineIp();
    if (ip !== null) return ip;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
  }
}

/** What was tried, and how much of what was available.
 *
 * The count is there because its absence cost a whole debugging round:
 * the app reported "every protocol was tried" after trying exactly one,
 * and nothing on screen contradicted it. A run that considered one
 * candidate out of five is a different bug from five that all failed,
 * and the difference has to be visible without a server log.
 */
function describeAttempts(attempts: string[], considered: number): string {
  return `tried ${attempts.length} of ${considered} available\n${attempts.join("\n")}`;
}

/** The subscription worth showing, out of everything the account has.
 *
 * The list includes every subscription ever created, newest first, and
 * simply taking the first one was wrong in a way customers hit: starting
 * a purchase and not finishing it leaves a PENDING row, which then
 * rendered as a real subscription -- an expiry date, a data allowance,
 * "no connection provisioned yet" -- while nothing had been paid for.
 * Worse, it hid the "choose a plan" screen, so there was no way back:
 * the app insisted you had a subscription you could not use.
 *
 * PENDING and CANCELLED are excluded because neither entitles anyone to
 * anything. SUSPENDED and EXPIRED are kept: those are real subscriptions
 * in a bad state, and hiding them would be its own lie.
 */
function usableSubscription(all: Subscription[]): Subscription | null {
  const real = all.filter((s) => s.status !== "PENDING" && s.status !== "CANCELLED");
  return real.find((s) => s.status === "ACTIVE") ?? real[0] ?? null;
}

function formatDuration(totalSeconds: number) {
  // Clamped so a clock adjustment mid-session can never render a
  // negative duration -- the sign would leak into every field.
  const seconds = Math.max(0, totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function Dashboard({
  onLoggedOut,
  onBrowsePlans,
  onOpenSettings,
}: {
  onLoggedOut: () => void;
  onBrowsePlans: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Customer | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [protocolUser, setProtocolUser] = useState<ProtocolUser | null>(null);
  /** Every credential this subscription holds -- one per route its plan
   * allows. The list is the failover ladder; `protocolUser` is whichever
   * rung is currently in use. */
  const [protocolUsers, setProtocolUsers] = useState<ProtocolUser[]>([]);
  /** The server the customer picked from the list, if any. Tried
   * first; deliberately does not disable the others. */
  const [chosenRouteId, setChosenRouteId] = useState<string | null>(null);
  /** Which network we are on, so "what worked here last time" means
   * here and not somewhere else. Null when it cannot be determined. */
  const [networkId, setNetworkId] = useState<string | null>(null);
  const [lastGood, setLastGood] = useState<LastGoodMap>({});
  /** Names the protocol we ended up on when it is not the one we
   * started with. Landing somewhere else without saying so is the same
   * dishonesty as a false "Connected". */
  /** Where the ladder actually landed, when that is not where it set out
   * to go.
   *
   * Carries the region as well as the protocol because failover can
   * cross a border. Saying only "now using Fast" is true and
   * insufficient: someone who chose Singapore chose it for a reason, and
   * the fact that they are now leaving from France should not have to be
   * inferred from a field elsewhere on the screen. */
  const [failedOverTo, setFailedOverTo] = useState<{
    label: string;
    /** Region we meant to use, only when it differs from where we landed. */
    fromRegion: string | null;
    toRegion: string | null;
    /** Whether `fromRegion` was actually dialled and failed, as opposed
     * to never being attempted. Picks between two different sentences,
     * because only one of them is true in each case. */
    intendedWasTried: boolean;
  } | null>(null);
  /** Guards the ladder against running twice at once. The health poll
   * and the Connect button can both start one, and two of them
   * interleaving would have each tearing down the other's engine.
   *
   * Read through `ladderInFlight`, never directly: the guard is held for
   * as long as a pass could still plausibly be alive, not forever. */
  const ladderRunningRef = useRef(false);
  /** When the pass holding the guard began, so the guard can expire. */
  const ladderStartedAtRef = useRef(0);
  /** Which pass is the current one. A pass that outlived its deadline
   * has been superseded, and must not be allowed to clear a newer
   * pass's guard or write state on its way out. */
  const ladderGenerationRef = useRef(0);
  /** Consecutive polls that found a live tunnel not carrying traffic. */
  const strikesRef = useRef(0);
  /** Consecutive polls the service did not answer at all. */
  const statusMissesRef = useRef(0);
  /** Earliest time an automatic attempt may run again. */
  const cooldownUntilRef = useRef(0);
  /** When the health poll's traffic check last started.
   *
   * The poll now fires once immediately on entering a live state as well
   * as on its interval, so that `unverified` is resolved in a second
   * rather than in fifteen. That leading edge re-arms on every state
   * change, and the states it runs in can alternate -- `connected` to
   * `unverified` and back -- so without this a flapping tunnel would put
   * a fresh round of requests on a censored link for every flap.
   * Cheapness is a requirement here, not a preference. */
  const lastCheckAtRef = useRef(0);
  /** Set when the customer asks to stop a ladder in progress. Checked
   * between steps rather than interrupting one, so the engine is never
   * left half-started. */
  const cancelRef = useRef(false);
  /** What the customer last asked for, and the stamp that lets an answer
   * still in flight discover it has been overtaken.
   *
   * The screen's phase and the customer's intent used to be the same
   * variable, which is how a press could come to mean the opposite of
   * its label: any of three async writers could land an old observation
   * on top of a fresh press, and the next press branched on it. See
   * `lib/connect-intent`. */
  const intentRef = useRef<IntentState>(IDLE_INTENT);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState<ClassifiedError | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  // Only set when *this* app instance brought the tunnel up. The helper
  // service doesn't report a start time, so a tunnel adopted on launch
  // has no honest duration to show and the timer stays blank rather than
  // inventing one from the moment the window opened.
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** The address the world saw before connecting. Captured while still
   * disconnected -- taken afterwards it would be the tunnel's own exit
   * address and the comparison would be meaningless. A ref rather than
   * state because nothing renders from it. */
  const baselineIpRef = useRef<BaselineIp | null>(null);
  const [exitIp, setExitIp] = useState<string | null>(null);
  /** Taken from the service, never from the Settings toggle.
   *
   * The two disagree in a state the customer can easily reach: switch
   * Custom mode on while already connected, and the setting says yes
   * while the live tunnel is still carrying everything. Showing the
   * toggle here would tell them only their game is routed when the whole
   * machine is. */
  const [splitTunnelActive, setSplitTunnelActive] = useState(false);
  const [splitTunnelProblem, setSplitTunnelProblem] = useState<string | null>(null);
  /** VPN mode or gaming mode.
   *
   * Read before anything else on the screen, because it changes what
   * every element below it means: in gaming mode there is no tunnel and
   * no adapter, so "Connected" has nothing it could stand for and the
   * exit-IP pill would be describing an address the product did not
   * change. */
  const [appMode, setAppMode] = useState<AppMode>("vpn");
  /** Whether the service says IPv6 is blocked for this session. */
  const [ipv6Blocked, setIpv6Blocked] = useState(false);
  /** Whether this machine could reach public IPv6 *before* connecting.
   *
   * The whole point of taking it beforehand: most machines cannot reach
   * public IPv6 at all, and without this a failed probe while connected
   * is indistinguishable between "we blocked it" and "there was never
   * any". A ref, like the IPv4 baseline, because nothing renders from
   * it. */
  const ipv6BaselineRef = useRef<boolean | null>(null);
  /** True only when the app has *observed* IPv6 still reaching the
   * internet while connected. Never inferred, and never set from the
   * absence of a block. */
  const [ipv6Escaping, setIpv6Escaping] = useState(false);
  /** When the shown data was last fetched, if the server could not be
   * reached this time. Null means everything on screen is current.
   *
   * Shown rather than hidden: usage figures and expiry dates go stale,
   * and a customer reading a three-day-old data total as today's is
   * exactly the kind of quiet wrongness the rest of this screen exists
   * to avoid. */
  const [offlineSince, setOfflineSince] = useState<number | null>(null);

  /** Whether a ladder pass could still be running.
   *
   * Time-limited rather than a plain flag, because a pass can hang on a
   * service call that never returns, and a guard that can never be
   * released turns every later press into a cancel for a pass that is
   * not going to end. Letting a stale guard expire risks a stalled pass
   * waking up beside a newer one; leaving it set guaranteed an app the
   * customer had to kill. The generation check on the way out is what
   * keeps the first risk from costing anything visible.
   */
  function ladderInFlight(): boolean {
    return ladderRunningRef.current && Date.now() - ladderStartedAtRef.current < LADDER_MAX_MS;
  }

  /** Records what the customer just asked for and returns its stamp.
   *
   * Everything published from then on has to quote the stamp, so an
   * answer that was already in flight when the press happened is dropped
   * instead of overwriting it. */
  function beginIntent(intent: IntentState["intent"]): number {
    intentRef.current = declareIntent(intentRef.current, intent);
    return intentRef.current.generation;
  }

  /** Marks an operation finished, so later observations are shown as
   * they are rather than through the wording of an operation that is
   * over.
   *
   * Only the operation that still owns the stamp may do this. One that
   * has been superseded is not entitled to declare the app idle -- its
   * replacement is still running. */
  function endIntent(generation: number): void {
    intentRef.current = concludeIntent(intentRef.current, generation);
  }

  /** Puts an observation on screen, unless it has been overtaken.
   *
   * Two guards, and they answer different questions. `isCurrent` asks
   * whether this answer is still about the operation the app is running
   * -- a status fetched before Connect was pressed says nothing about
   * the connect, and landing it afterwards is what let the button come
   * to mean the opposite of its label. `phaseFor` asks how the answer
   * should be worded given what the customer asked for, which is why a
   * teardown inside a connect never reaches the screen as
   * "Disconnecting...".
   *
   * Returns what was shown, or null when the answer was dropped, so a
   * caller waiting on a settled state can tell the difference.
   */
  function publishObserved(generation: number, observed: ConnectionState): ConnectionState | null {
    if (!isCurrent(intentRef.current, generation)) return null;
    const phase = phaseFor(intentRef.current.intent, observed);
    setConnectionState(phase);
    return phase;
  }

  /** What the service says, without putting it on screen.
   *
   * Separate from `syncFromService` so a caller waiting for something to
   * settle can look more than once without showing the customer each
   * intermediate answer.
   */
  async function readServiceState(): Promise<ConnectionState> {
    let status: VpnStatus;
    try {
      status = await serviceStatus();
    } catch {
      // Not answered is not the same as not connected, and saying
      // "You're not protected" here is a lie in the one direction that
      // still gets somebody hurt: they believe it, and act as though
      // their traffic is their own.
      //
      // Seen exactly that way -- the app could not reach the service, so
      // it showed a Connect button and "You're not protected", while the
      // browser beside it was going out through the node's exit address.
      // Failing to ask the question is reported as not knowing the
      // answer.
      return "unknown";
    }

    statusMissesRef.current = 0;
    setSplitTunnelActive(Boolean(status.splitTunnelActive));
    setSplitTunnelProblem(status.splitTunnelProblem ?? null);
    setIpv6Blocked(Boolean(status.ipv6Blocked));
    return stateFromStatus(status);
  }

  /** Replaces what the screen believes with what the service says.
   *
   * The single place a connection state is allowed to come from. Every
   * wrong state shown tonight was the UI concluding something on its
   * own -- a Connect button over a live tunnel, a "Disconnecting..."
   * that outlived the engine it was tearing down -- and the service knew
   * better in all three cases. It always does: it is the thing that
   * starts and stops the engines.
   *
   * Returns what it settled on so a caller can act on the answer rather
   * than on the state it was hoping for.
   */
  async function syncFromService(): Promise<ConnectionState> {
    const generation = intentRef.current.generation;
    const settled = await readServiceState();
    publishObserved(generation, settled);
    // The clock is only honest while something is up.
    if (settled === "disconnected") setConnectedAt(null);
    return settled;
  }

  /** Waits for a teardown to actually be gone before reporting on it.
   *
   * `vpn_disconnect` returns when the service has asked for the
   * teardown, not when Windows has finished it -- the tunnel service and
   * its adapter go away asynchronously, which is the same lag
   * settleAndCaptureBaseline exists for. For a second or two afterwards
   * the service's status, which asks the OS rather than remembering,
   * still answers "up". Publishing that first answer would flip the
   * screen back to "You're protected" the instant someone pressed
   * Disconnect and make a teardown that worked look like one that
   * failed.
   *
   * So it is only the settled answer that reaches the screen -- and a
   * tunnel that really is still installed after the wait still gets
   * reported, which is the case that must not be swallowed.
   */
  async function confirmTornDown(under?: number): Promise<ConnectionState> {
    // Captured once, not per iteration: a press that arrives while this
    // is settling declares its own intent, and every answer this loop is
    // still owed belongs to the teardown that press replaced.
    //
    // A caller may supply its own stamp instead. The ladder does, so a
    // pass the customer cancelled still tears its engines down -- which
    // it must, or one started just before the press outlives it -- while
    // saying nothing on screen about a teardown the press has already
    // reported.
    const generation = under ?? intentRef.current.generation;
    const deadline = Date.now() + TEARDOWN_SETTLE_MS;
    for (;;) {
      const state = await readServiceState();
      if (!isTunnelUp(state)) {
        publishObserved(generation, state);
        if (state === "disconnected") setConnectedAt(null);
        return state;
      }
      if (Date.now() >= deadline) {
        publishObserved(generation, state);
        return state;
      }
      if (!isCurrent(intentRef.current, generation)) return state;
      await new Promise((r) => setTimeout(r, TEARDOWN_POLL_MS));
    }
  }

  // The stored pin is read *before* the first load, and handed to it
  // directly rather than left to arrive via state.
  //
  // Loading it alongside lost the race: loadAll picked which credential
  // the screen represents while chosenRouteId was still null, so a
  // customer who had pinned Singapore/Built-in came back to
  // Singapore/Compatible. The server name looked right purely because
  // the first credential in the list happened to be Singapore too --
  // the protocol gave it away.
  //
  // That is worse than cosmetic. The pin does reach the ladder by the
  // time Connect is pressed, so the app would have connected on the
  // pinned protocol while the tile named another, then announced a
  // switch that never happened. Observed on a real restart.
  useEffect(() => {
    void (async () => {
      const saved = await loadChosenRoute();
      if (saved) setChosenRouteId((current) => current ?? saved);
      await loadAll(saved ?? undefined);
    })();
  }, []);

  // Which mode the app was left in. Persisted rather than reset, because
  // starting in VPN mode somebody who chose gaming mode would quietly
  // offer to tunnel a machine whose owner had asked for the opposite.
  useEffect(() => {
    let cancelled = false;
    void loadGaming().then((loaded) => {
      if (!cancelled) setAppMode(loaded.mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Switches mode, and leaves nothing behind from the one being left.
   *
   * Going back to VPN tears the gaming rules down. Leaving them installed
   * under a screen that no longer mentions them is exactly the kind of
   * state this app is not allowed to have: DNS for the customer's games
   * would still be pointed at the node while nothing on screen said so.
   *
   * Refused outright while a tunnel is up -- the same rule the location
   * picker follows, and for the same reason the Dashboard already gives:
   * turning a mode on mid-session cannot retrofit onto a live tunnel.
   */
  async function changeMode(next: AppMode) {
    if (next === appMode) return;
    if (connectionState !== "disconnected") return;
    setAppMode(next);
    const current = await loadGaming();
    await saveGaming({ ...current, mode: next });
    if (next === "vpn") {
      try {
        await gamingDisarm();
      } catch {
        // The service may be stopped. Nothing on screen claims the rules
        // are gone: the gaming panel reads the service on every poll and
        // is the only thing that reports what is installed.
      }
    }
  }

  // A window restored from the tray after a week is holding a week-old
  // answer, and nothing before this ever asked for a newer one.
  //
  // The credentials only, not `loadAll`. Two reasons: `loadAll` raises
  // the loading screen, and putting a spinner over the dashboard every
  // time somebody alt-tabs back would be a worse product than the stale
  // SNI this is fixing; and the connection parameters are the whole of
  // what goes stale dangerously -- a day-old usage figure is wrong in a
  // way nobody acts on.
  //
  // `force` because the hook has already done the staleness check; it
  // does not call this at all inside the horizon.
  useRefreshOnResume(async () => {
    const refreshed = await refreshConnectionConfig({ held: protocolUsers, force: true });
    if (refreshed.source !== "network") return;
    setProtocolUsers(refreshed.protocolUsers);
    setProtocolUser(
      (current) => refreshed.protocolUsers.find((u) => u.id === current?.id) ?? current,
    );
  });

  // Ticks for as long as the screen is mounted, not just while connected.
  // Two reasons: the days-remaining badge would otherwise freeze at
  // whatever it was when the screen loaded, and gating the interval on
  // connectedAt left `now` older than the connection start for a full
  // second, which rendered the session as "-1:-51".
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function loadAll(preferRouteId?: string) {
    setLoading(true);
    setError(null);
    const [meResult, subsResult, usersResult] = await Promise.all([getMe(), getSubscriptions(), getProtocolUsers()]);

    if (!meResult.ok || !subsResult.ok || !usersResult.ok) {
      const failed = [meResult, subsResult, usersResult].find((r) => !r.ok);
      if (failed && !failed.ok && failed.sessionExpired) {
        onLoggedOut();
        return;
      }

      // The control plane is unreachable, which is not the same as the
      // subscription being gone. Everything needed to build a tunnel was
      // handed over last time and has not changed, so fall back to it
      // rather than stranding a paying customer.
      //
      // This is why the cache exists: the panel's address was filtered in
      // Iran and every customer there lost the product entirely -- on
      // every protocol, on every node, none of which were blocked.
      const cached = await loadSnapshot();
      if (cached) {
        setSubscription(cached.subscription);
        setProtocolUsers(cached.protocolUsers);
        setRoutes(cached.routes);
        const preferred = preferRouteId ?? chosenRouteId;
        setProtocolUser(
          cached.protocolUsers.find((u) => u.routeId === preferred) ?? cached.protocolUsers[0] ?? null,
        );
        setOfflineSince(cached.savedAt);
        setError(null);
        setLoading(false);
        void invoke<string | null>("network_fingerprint")
          .then(setNetworkId)
          .catch(() => setNetworkId(null));
        void loadLastGood().then(setLastGood);
        return;
      }

      setError(!meResult.ok ? meResult.error : !subsResult.ok ? subsResult.error : t("dash.loadFailed"));
      setLoading(false);
      return;
    }

    // Reached the server, so anything remembered about being offline is
    // stale.
    setOfflineSince(null);

    setMe(meResult.data);
    const sub = usableSubscription(subsResult.data);
    setSubscription(sub);
    setProtocolUsers(usersResult.data);
    // Which credential the screen represents. It used to be whichever
    // the API happened to list first, so choosing a server from the list
    // changed nothing visible: the protocol tile kept naming the old one
    // and the tick in the picker stayed on the wrong row. It also made
    // that row unclickable, since the picker skips one already marked
    // current. Reported as "clicking a location doesn't show that the
    // change worked" -- and it hadn't, on screen; only the connect
    // itself honoured the choice.
    const chosen = preferRouteId ?? chosenRouteId;
    setProtocolUser(usersResult.data.find((u) => u.routeId === chosen) ?? usersResult.data[0] ?? null);
    setLoading(false);

    // Best-effort, and deliberately not awaited together with the rest:
    // a machine whose gateway cannot be identified simply shares one
    // memory bucket, which is worse than per-network but not broken.
    void invoke<string | null>("network_fingerprint")
      .then(setNetworkId)
      .catch(() => setNetworkId(null));
    void loadLastGood().then(setLastGood);

    // Purely to name the server the customer is actually on -- the
    // protocol-user row carries a routeId but no human-readable
    // location. Best-effort: a failure here costs a label, not the
    // screen, so it must never surface as an error.
    let currentRoutes: RouteOption[] = [];
    if (sub) {
      const routesResult = await getAvailableRoutes(sub.id);
      if (routesResult.ok) {
        currentRoutes = routesResult.data;
        setRoutes(currentRoutes);
      }
    }

    // Written only after a wholly successful fetch, so a partial answer
    // can never overwrite a good cache with a worse one.
    void saveSnapshot({
      subscription: sub,
      protocolUsers: usersResult.data,
      routes: currentRoutes,
    });

    // The tunnel outlives the app: the helper service keeps it up if the
    // window is closed, so on open the UI has to adopt whatever is
    // actually running rather than assuming disconnected. A pass already
    // under way owns the state and must not be overwritten by a reload
    // of the account data -- and takes its own baseline besides, so null
    // here leaves both alone.
    const adopted = ladderInFlight() ? null : await syncFromService();

    // Only meaningful while nothing is up: taken through a live tunnel
    // this would record the exit address as the "before" value and every
    // later comparison would wrongly read as a leak.
    // Only when the service actually said so -- "unknown" is not a no,
    // and a baseline captured through a tunnel we simply could not ask
    // about turns every later comparison into a false leak report.
    if (adopted === "disconnected") {
      baselineIpRef.current = await captureBaselineIp();
      // The same window, for the same reason, and the same trap: asked
      // while a tunnel is up, "can this machine reach public IPv6" is
      // the question being tested rather than the baseline for it.
      ipv6BaselineRef.current = await captureIpv6Baseline();
      setExitIp(null);
    }
  }

  // Asks the one question the IPv4 egress check cannot: is IPv6 still
  // reaching the internet while we are connected?
  //
  // Every node is IPv4-only, so there is no tunnel for a v6 packet to
  // have gone through. A yes therefore means it left around the VPN, in
  // the clear, from the customer's own address -- which is exactly what
  // was measured on OpenVPN, IKEv2 and REALITY while this screen said
  // "You're protected".
  //
  // Three things this deliberately does not do.
  //
  // It does not block anything. The check fires once the state has
  // already settled, and the customer never waits on it.
  //
  // It does not alarm on a machine with no IPv6, which is most of them.
  // A probe that fails is evidence only when one succeeded before
  // connecting -- see `checkIpv6`.
  //
  // And it does not feed `combineEvidence`. Reporting "degraded" would
  // hand the tunnel to the failover ladder, which would tear down a
  // working connection and try the next protocol -- which leaks IPv6
  // identically. It would cycle every candidate, break an IPv4 tunnel
  // that was fine, and end where it started. The honest response to a
  // gap every protocol shares is to say so, not to shuffle.
  useEffect(() => {
    if (!isTunnelUp(connectionState)) {
      // Cleared on the way out, and the baseline with it: the next
      // connect may be on a different network, where the answer
      // differs.
      setIpv6Escaping(false);
      if (connectionState === "disconnected") ipv6BaselineRef.current = null;
      return;
    }

    let abandoned = false;
    void checkIpv6(ipv6BaselineRef.current).then((verdict) => {
      // A verdict about a tunnel that has since gone must not land on a
      // screen describing a different one.
      if (!abandoned) setIpv6Escaping(verdict === "escaping");
    });
    return () => {
      abandoned = true;
    };
  }, [connectionState]);

  // Keeps checking a live tunnel, and moves it if it has stopped
  // working.
  //
  // Two signals, because neither is enough alone. The service's own
  // health answers "is the far end talking to us", which only WireGuard
  // can cheaply prove -- Xray and OpenVPN report `unknown`, and
  // stateFromStatus treats that optimistically so they do not cry wolf.
  // That optimism is exactly why a blocked Xray tunnel would sit green
  // forever, so the second signal is a real request through the tunnel:
  // the same evidence the connect path uses, and the only one that works
  // for every protocol.
  useEffect(() => {
    if (!isTunnelUp(connectionState)) return;

    const check = async () => {
      // A ladder already running will decide the state itself; polling
      // underneath it would fight over the same fields.
      if (ladderInFlight()) return;
      lastCheckAtRef.current = Date.now();

      // Stamped before the first question, not after the last answer.
      //
      // This callback takes seconds -- a status call has a six-second
      // budget and the egress probe below has its own -- and for all of
      // that time it is holding a verdict about a tunnel the customer
      // may since have asked to replace. The guard at the top of this
      // function was the only one there was, and it is checked before
      // any of the waiting rather than after it, so a press landing in
      // between used to be overwritten by an observation older than
      // itself. That is how a screen came to read "You're protected"
      // over a connect that had already begun, and the next press then
      // meant Disconnect.
      const generation = intentRef.current.generation;

      let fromStatus: ConnectionState;
      try {
        const status = await serviceStatus();
        setSplitTunnelActive(Boolean(status.splitTunnelActive));
        setSplitTunnelProblem(status.splitTunnelProblem ?? null);
        setIpv6Blocked(Boolean(status.ipv6Blocked));
        fromStatus = stateFromStatus(status);
        statusMissesRef.current = 0;
      } catch {
        // Failing to ask is not the same as learning the tunnel is
        // down, so the last known state stands and no strike is counted.
        //
        // It does not stand indefinitely, though. The last answer was an
        // observation when it arrived; a minute of silence later it is
        // only a memory, and leaving "You're protected" on screen on the
        // strength of a memory is the same claim-without-evidence this
        // screen exists to refuse. Several misses in a row means the
        // honest answer has become "we don't know".
        statusMissesRef.current += 1;
        if (statusMissesRef.current >= STATUS_MISSES_BEFORE_UNKNOWN) {
          if (publishObserved(generation, "unknown")) strikesRef.current = 0;
        }
        return;
      }

      if (fromStatus === "disconnected") {
        if (publishObserved(generation, "disconnected") === null) return;
        setConnectedAt(null);
        strikesRef.current = 0;
        return;
      }

      // Proof rather than inference: did a packet just make the round
      // trip through this tunnel.
      //
      // Which packet depends on the mode, and getting that wrong is not
      // cosmetic. In Custom mode this app is deliberately not one of the
      // selected apps, so asking a server what address it sees us from
      // correctly reports the tunnel bypassed -- and the code below
      // correctly concluded the tunnel was dead, went yellow, and then
      // tore down a tunnel that was carrying the customer's game
      // perfectly well. Confirmed from the split-tunnel log: 328 flows
      // matched and 703 packets redirected while the UI said "not
      // carrying traffic".
      //
      // The same fix as the connect path, which had this corrected
      // already -- this poll was simply missed.
      let verdict: ConnectionState;
      if (splitTunnelActive) {
        // A failed probe is never grounds to change protocol -- see
        // `customModePollState`, and the "no matter which protocol I
        // pick it ends up on Fast" report behind it. But it is not
        // grounds to say "protected" either, and that is the half this
        // branch used to get wrong: it published "connected" whenever
        // the engine was up, discarding the probe result entirely.
        //
        // For Xray "the engine is up" means "the process has not
        // exited", which is true forever. So a customer in Custom mode
        // on an Xray protocol sat on a green orb indefinitely while
        // nothing flowed -- the one instrument that could have caught it
        // was skipped in exactly the case it was needed.
        const carried = await invoke("vpn_probe_split_tunnel")
          .then(() => true)
          .catch(() => false);
        verdict = customModePollState(fromStatus, carried);
      } else {
        const egress = await verifyEgress(baselineIpRef.current);
        if (egress.state === "throughTunnel") setExitIp(egress.exitIp);
        verdict = fullTunnelPollState(fromStatus, egress);
      }

      if (verdict === "connected" || verdict === "unverified") {
        // `unverified` resets the strike count with the same authority
        // `connected` does, and deliberately. A strike is evidence that
        // this tunnel has stopped working, and an abstention is not
        // evidence of anything -- letting abstentions accumulate into a
        // teardown would hand every Xray session in Custom mode to the
        // failover ladder on a timer.
        if (publishObserved(generation, verdict) !== null) strikesRef.current = 0;
        return;
      }

      // Dropped rather than counted when it has been overtaken: a strike
      // is evidence about the tunnel the customer is on, and this
      // verdict is about one they have already asked to leave.
      if (publishObserved(generation, verdict) === null) return;
      strikesRef.current += 1;

      // Below the threshold, or too soon after a full pass already
      // failed, this only reports -- it does not act.
      if (strikesRef.current < MID_SESSION_STRIKES) return;
      if (Date.now() < cooldownUntilRef.current) return;

      // A tunnel that is up and carrying nothing is the case a customer
      // cannot fix themselves and should not have to: the old behaviour
      // was to sit yellow advising them to reconnect by hand, which on a
      // network that has just started filtering is the least useful
      // moment to ask anything of them.
      strikesRef.current = 0;
      cooldownUntilRef.current = Date.now() + MID_SESSION_COOLDOWN_MS;
      await runLadder();
    };

    // Once straight away, then on the interval.
    //
    // This is what keeps the honest third state from becoming a worse
    // lie than the one it replaced. `stateFromStatus` answers
    // `unverified` for Xray, OpenVPN and IKEv2 the moment a status is
    // read -- including when the app opens over a tunnel the service
    // kept up while the window was closed -- and with a leading edge of
    // fifteen seconds the customer would stare at "not confirmed" for
    // that whole time before the check that resolves it ever ran.
    //
    // Nothing on screen waits for this: it is fired and forgotten, and
    // every write it makes goes through `publishObserved`, so an answer
    // overtaken by a press is dropped rather than shown.
    if (Date.now() - lastCheckAtRef.current >= MIN_CHECK_GAP_MS) void check();
    const id = setInterval(() => void check(), HEALTH_POLL_MS);

    return () => clearInterval(id);
    // splitTunnelActive is a dependency, not incidental: the poll picks
    // its evidence from it, and a stale `false` would send a Custom-mode
    // session straight back down the egress-check path this exists to
    // avoid.
  }, [connectionState, splitTunnelActive]);

  // Nothing that is only passing through gets to stay.
  //
  // "Connecting...", "Disconnecting..." and "Can't tell right now" all
  // describe an operation or an absence of information, not the tunnel,
  // and each of them is set by code that assumes something later will
  // move it on. Twice tonight nothing did: a teardown whose reply never
  // came left "Disconnecting..." on screen over a machine with no engine
  // and no adapter, and a connect spinner outlived every press meant to
  // end it. Neither state could be argued out of on its own terms,
  // because neither was ever measured.
  //
  // So they expire. What replaces them comes from the service, which is
  // the only party that knows -- including, when it will not answer,
  // that we do not.
  useEffect(() => {
    const recheckMs = TRANSIENT_RECHECK_MS[connectionState];
    if (recheckMs === undefined) return;

    const id = setInterval(() => {
      // A pass inside its own deadline owns the state, and overwriting
      // it here would put "You're not protected" on screen in the middle
      // of a connect that is still working.
      if (ladderInFlight()) return;
      // Past its deadline, it owns nothing -- and the intent it declared
      // has to go with it. Leaving that standing would be a new way to
      // wedge the screen rather than a fix for the old one: `phaseFor`
      // would keep rewording every "disconnected" this recheck fetched
      // back into "Connecting..." on behalf of a pass that is never
      // going to report, which is the exact stuck spinner this recheck
      // exists to end.
      endIntent(intentRef.current.generation);
      void syncFromService();
    }, recheckMs);

    return () => clearInterval(id);
  }, [connectionState]);

  /** Every press does something, and no press can leave the app worse
   * off than it found it.
   *
   * The action is not worked out here. It is computed in the render that
   * drew the label -- see `pressFor` -- and handed in with the press, so
   * the button cannot dispatch the opposite of what it promised. That
   * was not a theoretical hazard: the label came from one chain of
   * ternaries and the press from another, over a `connectionState` that
   * three asynchronous writers could overwrite between the render and
   * the click, and the customer-visible result was Connect running a
   * teardown.
   *
   * Every branch finishes by asking the service what is true, so the
   * worst a redundant press can do is refresh the screen with the truth.
   */
  async function handleConnectToggle(action: PressAction) {
    if (!protocolUser) return;
    setConnectionError(null);

    switch (action) {
      // Pressing during a pass means stop. The ladder checks `cancelRef`
      // between steps and unwinds itself; the teardown below is what
      // actually makes the machine usable again. Then the service is
      // asked, because a cancelled pass is exactly the case where what
      // the app was about to claim and what is actually installed have
      // most reason to differ.
      //
      // The intent flips to "disconnect" first, which does three things
      // at once: it stamps out every answer the abandoned pass is still
      // owed, it lets this teardown be shown as a teardown (the customer
      // did ask for this one), and it means the *next* press reads the
      // settled state rather than finding a pass still nominally in
      // flight. Needing three or four presses was that last one.
      case "cancelConnect": {
        const generation = beginIntent("disconnect");
        cancelRef.current = true;
        setConnectionState("disconnecting");
        await serviceDisconnect().catch(() => undefined);
        await confirmTornDown();
        endIntent(generation);
        return;
      }

      // Covers both a live tunnel and a teardown already in flight. A
      // press during a teardown must not start a connect on top of it,
      // and must not do nothing either -- doing nothing is what made the
      // window look frozen. Repeating the teardown is safe (the service
      // tears down whatever is there, and there is nothing there twice),
      // and the answer that follows is the way out of a
      // "Disconnecting..." that has stopped describing anything.
      case "disconnect": {
        const generation = beginIntent("disconnect");
        setConnectionState("disconnecting");
        try {
          await serviceDisconnect();
          // Acknowledged is not the same as finished, so the state comes
          // from what the service reports once the teardown has settled
          // rather than from the acknowledgement. An engine that
          // survives it is a thing the customer needs to know about, and
          // setting "disconnected" here on the strength of an ack is
          // exactly how that would be hidden.
          await confirmTornDown();
        } catch (err) {
          // A teardown that never answered is not a teardown that
          // failed. The engines may well be gone -- that is how the app
          // came to be stuck on "Disconnecting..." with nothing left
          // running -- so the generic classifier's "Couldn't reach this
          // server", which is where anything containing "timeout" lands,
          // would assert something about the node that nothing here
          // measured.
          setConnectionError(
            isServiceTimeout(err)
              ? { kind: "serviceUnavailable", messageKey: "err.teardownStuck", detail: String(err) }
              : classifyConnectionError(err),
          );
          // Not back to "connected": the tunnel may be down, may be up,
          // and this press produced no evidence either way. Ask.
          await confirmTornDown();
        }
        endIntent(generation);
        return;
      }

      // Nothing is known, so this press buys an answer rather than an
      // action. Connecting on the assumption that nothing is up would
      // tear down a tunnel the customer may be relying on, and
      // disconnecting on the same assumption is no better -- both are
      // acting on a guess about the one thing the app has just admitted
      // it cannot see. Once the service answers, the orb says what it is
      // and the next press means what it says.
      case "recheck": {
        await syncFromService();
        return;
      }

      case "connect": {
        const outcome = await runLadder();
        // A press that produced no attempt at all has to say so. It used
        // to return quietly: the guard from a pass that had stalled was
        // still set, `runLadder` declined, and the button looked dead
        // for as long as the guard lasted. Silence there is part of what
        // taught people to press three or four times.
        if (outcome === "declined") {
          setConnectionError({
            kind: "serviceUnavailable",
            messageKey: "err.connectBusy",
            detail: "a connection attempt was already running",
          });
          await syncFromService();
        }
        return;
      }
    }
  }

  /** Works down the protocols this subscription holds until one is
   * proven to be carrying traffic.
   *
   * Shared by the Connect button and by the health poll below, which is
   * the whole reason it is a function: a connection that stops working
   * mid-session should recover the same way one that never started
   * does, using the same order, the same evidence and the same memory.
   * Duplicating it would mean two ladders drifting apart.
   */
  async function runLadder(): Promise<LadderOutcome> {
    if (!protocolUser || ladderInFlight()) return "declined";
    // Its own number, so a pass that stalled past its deadline can be
    // told apart from the one that replaced it. Without that, a stalled
    // pass finally waking would clear the live pass's guard and write
    // its own long-obsolete verdict over the screen.
    const generation = ++ladderGenerationRef.current;
    // The customer's side of the same fact. The ladder generation guards
    // the ladder against itself; this one tells every answer still in
    // flight anywhere in the file that a connect is now what the app is
    // doing -- and, through `phaseFor`, that the teardowns inside it are
    // part of connecting rather than something to narrate.
    const intent = beginIntent("connect");
    ladderRunningRef.current = true;
    ladderStartedAtRef.current = Date.now();
    cancelRef.current = false;
    try {
      // Every phase this pass shows goes through its own stamp, progress
      // included. A pass the customer has since cancelled, or one a
      // newer pass replaced, is not entitled to keep narrating: it used
      // to be able to put "Connected" on screen after the press that
      // stopped it, which is the same claim-without-evidence the rest of
      // this screen exists to refuse.
      publishObserved(intent, "connecting");
      setFailedOverTo(null);

      // One small question to the control plane before anything is
      // dialled: are these still the right servers?
      //
      // Deliberately here, above the teardown. Run from the health poll
      // there is still a tunnel up, and on a filtered network that
      // tunnel is by far the most likely way to reach the control plane
      // at all -- tearing it down first would throw away the only route
      // to the answer.
      //
      // It cannot block the connect. `refreshConnectionConfig` never
      // throws, gives up after its own short budget, and falls back to
      // the credentials already in hand; see the note there about why a
      // failed refresh must never cost somebody in Iran their VPN.
      const refreshed = await refreshConnectionConfig({ held: protocolUsers });
      if (refreshed.source === "network") setProtocolUsers(refreshed.protocolUsers);
      const dialable = refreshed.protocolUsers.length > 0 ? refreshed.protocolUsers : [protocolUser];

      // Whatever is up comes down first, and this is not a formality.
      // Run from the health poll, the tunnel that just stopped working
      // is still installed and still holding the default route, so every
      // probe below would be fired into a black hole and burn its full
      // timeout rather than answering. That turned a pass that should
      // take seconds into minutes of "Checking connection..." -- observed
      // exactly that way when a live WireGuard tunnel was blocked.
      //
      // Harmless from the Connect button, where nothing is up.
      await serviceDisconnect().catch(() => undefined);

      // Re-sent on every pass, not only when the setting changes. The
      // helper is a Windows service with its own lifetime: it can be
      // restarted underneath a running app and come back knowing
      // nothing about Custom mode. Re-sending is one cheap IPC call and
      // removes the whole class of "it quietly stopped applying".
      //
      // It has to happen before the connect below, because it decides
      // whether the tunnel comes up passively or takes the default
      // route -- a decision that cannot be changed afterwards.
      let customMode = false;
      try {
        const settings = await loadSplitTunnel();
        await pushSplitTunnel(settings);
        customMode = isEffective(settings);
      } catch {
        // A failure here means Custom mode does not apply to this
        // attempt, which the status poll will report honestly rather
        // than the connection being blocked over a preference.
      }

      // The ladder, not a single credential. Everything the subscription
      // holds is already provisioned, so moving to another protocol
      // needs no server contact -- which is the point, since on a
      // filtered network the control plane is a plausible thing to lose
      // first.
      const candidates = orderCandidates(dialable, {
        pinnedRouteId: chosenRouteId,
        lastGoodRouteId: lastGoodFor(lastGood, networkId),
        preferredRouteId: null,
      });

      // What the dashboard was promising before any of this ran.
      //
      // Captured up front because the loop replaces it, and because the
      // honest question is not "did the ladder move past its own first
      // pick" but "did the customer end up somewhere other than what
      // the screen said". Those come apart whenever nothing is pinned:
      // the SERVER field shows the provisioned route while the ladder
      // orders by speed, so the app could show sg-singapore, connect to
      // France, and say nothing -- index was still 0, so by the old
      // test nothing had failed over.
      const shownRouteId = protocolUser?.routeId ?? null;

      // Whether the route on screen was actually dialled before we
      // settled somewhere else.
      //
      // Without this the app tells the customer "Couldn't reach
      // sg-singapore" in the one case it never tried Singapore at all --
      // nothing pinned, ladder ordered by speed, WireGuard on another
      // continent won at index 0. Observed exactly that. Asserting a
      // failure that did not happen is the same dishonesty as the
      // silence it replaced, just louder, and it sends the customer to
      // support over a server that is fine.
      let triedShownRoute = false;

      let lastError: ClassifiedError | null = null;
      // Why each attempt failed, in order. Kept because diagnosing the
      // first version of this needed a firewall rule and the server's
      // own logs -- the app knew and said nothing.
      const attempts: string[] = [];

      for (const [index, candidate] of candidates.entries()) {
        if (cancelRef.current) break;
        const label = customerProtocolLabel(candidate.protocol, candidate.connection?.transport);
        const isLast = index === candidates.length - 1;
        if (candidate.routeId === shownRouteId) triedShownRoute = true;

        // Patient only for the last candidate. With another protocol
        // sitting untried, waiting out a long budget on this one is
        // ruinous; with nowhere left to go, it is the right call.
        const settleBudget = isLast ? SETTLE_TIMEOUT_MS : FAILOVER_SETTLE_TIMEOUT_MS;
        const verifyBudget = isLast ? VERIFY_TIMEOUT_MS : FAILOVER_VERIFY_TIMEOUT_MS;

        // Fresh every attempt, and taken only once plain networking is
        // confirmed working. See settleAndCaptureBaseline.
        baselineIpRef.current = await settleAndCaptureBaseline(settleBudget);
        // Once per pass, not once per candidate: whether this machine
        // has public IPv6 is a fact about its network, not about which
        // protocol is being tried, and re-measuring it five times would
        // add a timeout to each rejected candidate for no new
        // information. Taken here rather than before the loop so it
        // still lands after the previous engine's routes are gone.
        if (ipv6BaselineRef.current === null) {
          ipv6BaselineRef.current = await captureIpv6Baseline();
        }

        try {
          await invoke("vpn_connect", { payload: candidate });
          setProtocolUser(candidate);
          setConnectedAt(Date.now());

          // Egress first. WireGuard does not handshake until it has
          // something to send, so this request *is* that traffic: it
          // forces the handshake and answers the stronger question at
          // the same time -- did our packets actually leave via the
          // server.
          publishObserved(intent, "verifying");
          if (cancelRef.current) break;

          // Custom mode has to be checked a different way, and the
          // reason is structural rather than a quirk worth working
          // around. The egress check below works by asking a server what
          // address it sees us from -- but in Custom mode this app is
          // not one of the selected apps, so that request correctly
          // leaves by the ordinary route and correctly reports the
          // tunnel bypassed. Every protocol then "failed", the ladder
          // walked all five, and the customer was told it could not
          // connect while the tunnel was up and carrying their game.
          //
          // The service answers instead, over a socket pinned to the
          // tunnel exactly as a selected app's traffic is -- which is
          // stronger evidence anyway, because it tests the path that
          // actually matters rather than this app's.
          let verdict: ConnectionState;
          // Why this attempt was rejected, for the technical details
          // the customer can expand. Kept as text rather than as an
          // EgressVerdict because Custom mode's evidence is a different
          // kind of thing: there is no exit address to compare, and
          // inventing one to fit the type would be a lie in a field the
          // UI shows.
          let reason = "";

          if (customMode) {
            // The service's own words when it fails, not a generic
            // message: it distinguishes "no tunnel is up" from "the
            // tunnel did not carry a test connection", and that is the
            // whole difference between a failed connect and a leak.
            const carried = await invoke("vpn_probe_split_tunnel")
              .then(() => true)
              .catch((err: unknown) => {
                reason = String(err);
                return false;
              });
            // Nothing this app does goes through the tunnel, so it has
            // no way to observe an exit address. Blank is honest.
            setExitIp(null);

            if (carried) {
              verdict = "connected";
            } else {
              // Custom mode failing is not the protocol failing, and
              // conflating the two cost the customer every protocol
              // they ever picked.
              //
              // This branch used to go straight to "degraded", so the
              // ladder rejected the attempt and walked down to the next
              // candidate -- every time, on every protocol, landing on
              // WireGuard. From the outside that looked like "Stealth
              // never connects". It was not: the tunnel was up and
              // healthy, and only the split-tunnel redirect could not
              // reach through it.
              //
              // So ask the tunnel itself. A live handshake means the
              // protocol works and deserves to be kept; the customer
              // gets what they chose, and the fact that their selected
              // apps are NOT being routed is reported rather than
              // hidden behind a silent downgrade.
              //
              // What that live handshake does NOT license is the word
              // "protected". It proves the tunnel, not the redirect --
              // whether the apps the customer chose are being carried is
              // a different fact, and this branch had no evidence for
              // it. Keeping the candidate and reporting `unverified` is
              // the answer to both halves at once. A protocol with no
              // handshake to read (Xray, OpenVPN, IKEv2) has no evidence
              // of any kind here, so it is still rejected and the ladder
              // moves on: with another candidate sitting untried, moving
              // on beats settling for a tunnel nothing has vouched for.
              const status = await invoke<VpnStatus>("vpn_status").catch(() => null);
              const tunnelProven = status !== null && handshakeEvidence(status) === "proves";
              verdict = tunnelProven ? "unverified" : "degraded";
              if (tunnelProven) {
                reason = `${t("dash.customModeDetached")} ${reason}`.trim();
              }
            }
          } else {
            const egress = await confirmEgress(baselineIpRef.current, verifyBudget);
            setExitIp(egress.state === "unreachable" ? null : egress.exitIp);

            // The reachability check is worth its eight seconds only
            // when this is the last hope: it distinguishes "server is
            // dead" from "server is fine but our traffic goes around
            // it", which is a distinction for the error message, not
            // for deciding whether to try the next protocol. Another
            // candidate waiting makes moving on strictly better than
            // diagnosing.
            verdict =
              egress.state === "throughTunnel"
                ? "connected"
                : isLast
                  ? combineEvidence(await confirmReachable(), egress)
                  : "degraded";
            reason = egress.state;
          }

          // `unverified` lands the pass rather than rejecting it, and the
          // distinction it draws is the point of this whole change.
          //
          // Rejecting would mean walking on to the next protocol because
          // the app could not *prove* this one carries traffic -- and
          // for Custom mode with a live handshake, or a full tunnel with
          // no baseline to compare against, there was never going to be
          // proof to find. The ladder would abandon working connections
          // in a loop and settle on whichever candidate happened to
          // produce evidence, which is how "no matter which protocol I
          // pick it ends up on Fast" was reported in the first place.
          //
          // So the pass ends here, on the protocol the customer chose,
          // and the screen says plainly that traffic is not confirmed.
          // What is not allowed is the old behaviour: ending here and
          // calling it "protected".
          if (verdict === "connected" || verdict === "unverified") {
            publishObserved(intent, verdict);
            const movedFromShown = Boolean(shownRouteId) && candidate.routeId !== shownRouteId;
            if (index > 0 || movedFromShown) {
              // Compared against what was on screen when Connect was
              // pressed, falling back to the head of the ladder. Using
              // the head alone missed the case this exists for.
              const intended = routes.find((r) => r.id === (shownRouteId ?? candidates[0]?.routeId));
              const landed = routes.find((r) => r.id === candidate.routeId);
              const from = intended?.location.region ?? null;
              const to = landed?.location.region ?? null;
              setFailedOverTo({
                label,
                fromRegion: from && to && from !== to ? from : null,
                toRegion: to,
                // Only "couldn't reach it" if we actually tried it.
                intendedWasTried: triedShownRoute,
              });
            }
            // Remembered only on proof it carried traffic. Recording a
            // merely-started engine would teach the app to lead with a
            // protocol that does not actually work here -- which is
            // exactly why `unverified` is excluded: it is the state that
            // means no such proof was obtained. A candidate that lands
            // here is kept for this session and no longer, rather than
            // promoted to the head of every future ladder on this
            // network on the strength of nothing.
            if (verdict === "connected") {
              const updated = rememberLastGood(lastGood, networkId, candidate.routeId);
              setLastGood(updated);
              void saveLastGood(updated);
            }
            strikesRef.current = 0;
            // Successes are reported too, and they are not filler. A
            // failure rate needs a denominator, and "Stealth works from
            // this network while Fast does not" is a fact only the
            // successes can establish. The ladder is attached whenever
            // something had to be walked past to get here.
            void reportAttempt({
              kind: "CONNECT",
              outcome: "SUCCESS",
              protocol: label,
              routeId: candidate.routeId,
              attempts: attempts.length > 0 ? rungsFrom([...attempts, `${label}: connected`]) : undefined,
            });
            return "connected";
          }

          attempts.push(`${label}: up but ${reason}`);
          lastError = {
            kind: "serverUnreachable",
            messageKey: candidates.length > 1 ? "err.allProtocolsFailed" : "err.notCarryingTraffic",
            detail: describeAttempts(attempts, candidates.length),
          };
        } catch (err) {
          const classified = classifyConnectionError(err);
          attempts.push(`${label}: ${classified.detail}`);
          lastError = { ...classified, detail: describeAttempts(attempts, candidates.length) };
        }

        // Always tear down before moving on, or the next engine inherits
        // this one's routes and fails for a reason that has nothing to
        // do with it.
        await invoke("vpn_disconnect").catch(() => undefined);
        if (!isLast) publishObserved(intent, "connecting");
      }

      // Superseded while it was running: a newer pass is now driving the
      // engines, so this one leaves without tearing anything down and
      // without a word on screen. Its verdict is about a tunnel that no
      // longer exists.
      if (ladderGenerationRef.current !== generation) return "failed";

      // The clock is set on each engine start, so a run that ultimately
      // failed leaves it running against nothing.
      setConnectedAt(null);
      setExitIp(null);
      // A pass the customer stopped is not a failure and must not be
      // reported as one.
      setConnectionError(cancelRef.current ? null : lastError);
      if (!cancelRef.current) {
        // The whole ladder failed. This is the report that has been
        // costing a screenshot and a conversation every time: which
        // protocols were tried, in order, and what each one did.
        void reportAttempt({
          kind: "CONNECT",
          outcome: lastError ? outcomeFromError(lastError.kind) : "OTHER",
          reason: lastError?.detail,
          attempts: rungsFrom(attempts),
        });
      }
      // No "Disconnecting..." here, and this line is the whole reported
      // bug.
      //
      // A failed pass still has to clear up after itself -- an engine
      // left running would hold the default route -- but that teardown
      // is the app's housekeeping, not something the customer asked for.
      // Announcing it told someone who had pressed Connect that the app
      // was disconnecting, for the second or two the cleanup takes, and
      // then dropped back to "Connect" with nothing having happened.
      // Pressed again, they got the same thing again. That is the
      // "shows DISCONNECTING, stops after 1-2 seconds, takes three or
      // four tries" report, and there was no tunnel state involved in it
      // at all -- only the app narrating its own cleanup as the opposite
      // of the request.
      //
      // The phase stays "connecting" until there is an outcome to give,
      // which is the truth of the operation from where the customer is
      // standing. `phaseFor` enforces it rather than this comment: while
      // the intent is "connect", nothing published can render as a
      // teardown.
      await serviceDisconnect().catch(() => undefined);
      // The outcome is now known, so the wording rule is lifted before
      // the answer is asked for -- otherwise the settled "disconnected"
      // below would come back out as "connecting" and the spinner would
      // never end.
      endIntent(intent);
      // What the service says, not what this pass assumes. The
      // assumption is usually right, and "disconnected" is still the one
      // wrong answer that matters: a failed pass can leave an engine
      // running -- that is why the teardown above exists -- and telling
      // someone they are unprotected while an adapter is still carrying
      // their traffic is the same lie in the other direction.
      const left = await confirmTornDown(intent);
      // An engine that outlived the teardown is one this pass has just
      // proven carries nothing. "Connected" would throw that proof away
      // for the sake of a handshake; degraded is what was measured.
      if (isTunnelUp(left)) publishObserved(intent, "degraded");
      return "failed";
    } finally {
      // Same ownership rule as the guard below: a pass that has been
      // superseded does not get to declare the app idle, because its
      // replacement is still connecting.
      endIntent(intent);
      // Only the pass that still owns the guard may release it. One that
      // outlived its deadline has already been replaced, and clearing
      // the guard here would unlock a newer pass that is still running.
      if (ladderGenerationRef.current === generation) ladderRunningRef.current = false;
    }
  }

  async function handleLogout() {
    // Before the session goes, not after: leaving one customer's
    // credentials on a shared machine for the next person to connect
    // with is not a cache, it is a leak.
    await clearSnapshot();
    await logout();
    onLoggedOut();
  }

  /** The route this screen should name, which is the one a connect will
   * actually dial.
   *
   * The pinned choice leads, and the provisioned route only fills in
   * when nothing is pinned. They can disagree: switching the route
   * through another device changes what the backend has provisioned
   * while this app keeps dialling what its customer picked here. When
   * that happened the SERVER tile read de-germany and every connect went
   * to fr-france -- the app naming one server and using another, which
   * is the same shape of lie as a false "Connected". */
  const currentRoute = useMemo(
    () =>
      routes.find((r) => r.id === chosenRouteId) ??
      routes.find((r) => r.id === protocolUser?.routeId) ??
      null,
    [routes, protocolUser, chosenRouteId],
  );

  /** Null cap means unlimited, and that is a different thing from a
   * cap we could not read. Both end up without a bar -- there is no
   * proportion to draw -- but only one of them should say "unlimited",
   * so the two cases stay distinguishable rather than collapsing into
   * one silent fallback. */
  const usage = useMemo(() => {
    if (!subscription) return null;
    const used = Number(subscription.dataUsedBytes);
    if (!Number.isFinite(used)) return null;
    if (subscription.dataCapBytes === null) return { used, cap: null as number | null, percent: 0 };
    const cap = Number(subscription.dataCapBytes);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return { used, cap, percent: Math.min(100, (used / cap) * 100) };
  }, [subscription]);

  /** Set only when the subscription exists but no longer entitles the
   * customer to connect. See subscription-state for why the decision
   * lives outside the component. */
  const endedState = useMemo(
    () => (subscription ? endedNotice(subscription.status, IS_STORE_BUILD) : null),
    [subscription],
  );

  const daysLeft = useMemo(() => {
    if (!subscription) return null;
    const ms = new Date(subscription.expireAt).getTime() - now;
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }, [subscription, now]);

  // The label and what the press does, from one table, in one render.
  //
  // They used to be two independent chains of ternaries -- this one, and
  // another inside the press handler -- over a `connectionState` that
  // could change between the render and the click. Nothing made them
  // agree, and when they did not, the button ran the opposite of what it
  // said. `pressFor` is total over the phase and returns both, so there
  // is no longer a pair to disagree.
  const press = pressFor(connectionState);
  const connectLabel = t(press.labelKey);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="animate-breathe">
          <Logo />
        </div>
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto flex h-full w-full max-w-xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          {/* Left of the gear, and only for links the operator has
              actually set -- see CommunityLinks. */}
          <CommunityLinks />
          <Button
            variant="ghost"
            onClick={onOpenSettings}
            aria-label={t("nav.settings")}
            title={t("nav.settings")}
            className="size-8 justify-center px-0"
          >
            <SettingsIcon className="size-4" />
          </Button>
          <Button variant="ghost" onClick={handleLogout} className="h-8 px-2 text-xs">
            {t("nav.signOut")}
          </Button>
        </div>
      </header>

      {error ? (
        <Card className="animate-rise">
          <p className="text-sm text-destructive">{error}</p>
          <Button onClick={() => void loadAll()} className="mt-3">
            {t("dash.retry")}
          </Button>
        </Card>
      ) : (
        <>
          {/* Identity strip: a live status dot beside the account, so the
              single most important fact is legible before reading a word. */}
          {/* Says plainly that the numbers below are old, and that
              connecting still works. Without this the screen shows a
              stale data total and expiry date as though they were
              today's -- the same class of quiet wrongness as a false
              "Connected". */}
          {offlineSince !== null ? (
            <div className="animate-rise rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="text-xs font-medium text-warning">{t("dash.offlineTitle")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("dash.offlineHint", { when: new Date(offlineSince).toLocaleString() })}
              </p>
            </div>
          ) : null}

          {/* The mode selector, above everything it changes the meaning
              of. Two segments and no sliding marker: the chosen half is
              carried by its own background, which is the one thing on
              this control that must never be misread. A marker positioned
              physically is how the Custom toggle's knob came to sit under
              "off" in Persian while the mode was on -- if one is ever
              added here it animates `inset-inline-start`, never `left`.

              Refused while a tunnel is up, the same way the location
              picker is: a mode cannot be retrofitted onto a live
              session, and a control that silently did nothing would be
              worse than one that says why. */}
          <div className="animate-rise flex flex-col gap-1">
            <div className="flex gap-1 rounded-lg border border-white/8 bg-white/[0.025] p-1">
              {(
                [
                  ["vpn", t("dash.modeVpn"), Shield],
                  ["gaming", t("dash.modeGaming"), Gamepad2],
                ] as [AppMode, string, typeof Shield][]
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={appMode === value}
                  disabled={connectionState !== "disconnected"}
                  title={
                    connectionState !== "disconnected" ? t("dash.disconnectToChange") : undefined
                  }
                  onClick={() => void changeMode(value)}
                  className={[
                    "press flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                    "inline-flex items-center justify-center gap-1.5",
                    "disabled:pointer-events-none disabled:opacity-50",
                    appMode === value
                      ? "bg-[linear-gradient(120deg,var(--primary),var(--highlight))] text-white shadow-[0_2px_10px_-4px_var(--primary)]"
                      : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </div>
            {/* One sentence saying what the chosen half actually does.
                The gaming line names the limit rather than the promise:
                only the services you chose are carried, and the game
                itself is left on the direct path. */}
            <p className="text-[11px] text-muted-foreground">
              {appMode === "gaming" ? t("dash.modeGamingHint") : t("dash.modeVpnHint")}
            </p>
          </div>

          <div className="animate-rise flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={
                connectionState === "connected"
                  ? "size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_8px_var(--success)]"
                  : connectionState === "unverified"
                    ? // Lit, because an engine really is up -- but not in
                      // the success green, which from across a room is
                      // the claim itself.
                      "size-1.5 shrink-0 rounded-full bg-highlight shadow-[0_0_8px_var(--highlight)]"
                    : connectionState === "degraded"
                    ? "size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_8px_var(--warning)]"
                    : connectionState === "unknown"
                      ? // Neither lit nor plainly off: the dot is the one
                        // thing read from across a room, and both of the
                        // other two would answer a question the app
                        // cannot answer.
                        "size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground"
                      : "size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
              }
            />
            <span className="truncate">{me?.email}</span>
          </div>

          {subscription ? (
            <>
              {appMode === "gaming" ? (
                /* Its own hero, not a re-labelled version of the tunnel
                   one. Gaming mode installs DNS rules and brings up no
                   tunnel and no adapter, so it has its own five-value
                   state, its own words, and no exit-IP pill -- the
                   machine's address is unchanged by design and showing
                   one would be a plain lie about what the product did. */
                <GamingStatusPanel onOpenSettings={onOpenSettings} />
              ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4">
                {!protocolUser ? (
                  <Card className="w-full text-center">
                    <p className="text-sm text-muted-foreground">
                      No connection provisioned on your subscription yet.
                    </p>
                  </Card>
                ) : (
                  <>
                    <ConnectOrb
                      state={connectionState}
                      // The action travels with the press, decided in the
                      // same render as the label above it.
                      onToggle={() => void handleConnectToggle(press.action)}
                      label={connectLabel}
                    />

                    {/* Says in words what the orb says in colour. The
                        orb alone leaves "am I actually protected right
                        now?" to be inferred from a hue, which is the one
                        question this screen exists to answer. */}
                    <div className="px-4 text-center">
                      {/* The answer to the only question this screen
                          exists to answer, and it was set at the same
                          size and weight as a form label. It is the
                          headline; it now looks like one. */}
                      <p
                        className={
                          connectionState === "connected"
                            ? "text-base font-semibold tracking-tight text-success"
                            : connectionState === "unverified"
                              ? "text-base font-semibold tracking-tight text-highlight"
                              : connectionState === "degraded"
                              ? "text-base font-semibold tracking-tight text-warning"
                              : connectionState === "unknown"
                                ? "text-base font-semibold tracking-tight text-muted-foreground"
                                : "text-base font-semibold tracking-tight text-foreground"
                        }
                      >
                        {/* "Not protected" is a claim, and it only gets
                            made where the service has actually said so.
                            The unknown branch sits above the fallback for
                            that reason: it is the case that used to fall
                            through to it and tell a customer with a live
                            tunnel that they had none. */}
                        {connectionState === "connected"
                          ? t("dash.protected")
                          : connectionState === "unverified"
                            ? t("dash.unverified")
                            : connectionState === "degraded"
                            ? t("dash.degraded")
                            : connectionState === "connecting" || connectionState === "verifying"
                              ? t("dash.verifying")
                              : connectionState === "unknown"
                                ? t("dash.unknown")
                                : t("dash.notProtected")}
                      </p>
                      {/* text-pretty rather than a raw wrap: these hints
                          run two lines in English and three in Persian,
                          and a one-word last line under the hero control
                          is the thing that made the block look thrown
                          together. */}
                      <p className="mt-1 text-xs text-pretty text-muted-foreground">
                        {connectionState === "connected"
                          ? t("dash.protectedHint")
                          : connectionState === "unverified"
                            ? // Custom mode is a narrower claim than a
                              // full tunnel, so it gets the narrower
                              // sentence: what could not be confirmed
                              // there is that the *chosen apps* are
                              // being carried, which is a different fact
                              // from whether this machine is tunnelled.
                              t(splitTunnelActive ? "dash.unverifiedCustomHint" : "dash.unverifiedHint")
                            : connectionState === "degraded"
                            ? t("dash.degradedHint")
                            : connectionState === "connecting" || connectionState === "verifying"
                              ? t("dash.verifyingHint")
                              : connectionState === "unknown"
                                ? t("dash.unknownHint")
                                : t("dash.notProtectedHint")}
                      </p>
                      {/* The proof, shown rather than just acted on: this
                          is the address the outside world actually saw,
                          which is what makes "protected" verifiable
                          instead of a claim. */}
                      {connectionState === "connected" && exitIp ? (
                        // Set as a chip rather than a third sentence.
                        // It is evidence, not prose, and running it on
                        // in the same grey as the hint above buried the
                        // one line on the screen a customer can check
                        // against a what-is-my-ip page.
                        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[11px] text-muted-foreground">
                          {t("dash.yourIp")}
                          <span className="tabular-nums font-semibold text-success">{exitIp}</span>
                        </p>
                      ) : null}

                      {/* Says so when the protocol in use is not the one
                          we set out to use. Quietly landing somewhere
                          else is the same class of dishonesty as a false
                          "Connected" -- and a customer who is told which
                          transport got through has something useful to
                          report when none of them do. */}
                      {isTunnelUp(connectionState) && failedOverTo ? (
                        <p className="mt-1 text-xs text-amber-400/90">
                          {failedOverTo.fromRegion ? (
                            // Crossed a border, so the country is named
                            // -- and which sentence depends on whether
                            // that country was ever dialled. "Couldn't
                            // reach it" is a claim about the server, and
                            // it must not be made about one we skipped.
                            t(
                              failedOverTo.intendedWasTried
                                ? "dash.switchedServer"
                                : "dash.usedInstead",
                              {
                                from: failedOverTo.fromRegion,
                                to: failedOverTo.toRegion ?? "",
                                protocol: failedOverTo.label,
                              },
                            )
                          ) : (
                            <>
                              {t("dash.switchedTo")}{" "}
                              <span className="font-medium">{failedOverTo.label}</span>
                            </>
                          )}
                        </p>
                      ) : null}

                      {/* Custom mode changes what "protected" covers, so
                          the same word must not stand for both. Read
                          from the service rather than from the setting:
                          only the service knows whether this tunnel was
                          actually brought up to carry one app or all of
                          them. */}
                      {isTunnelUp(connectionState) && splitTunnelActive ? (
                        splitTunnelProblem ? (
                          /* The service's own words, from counters taken
                             on the path the chosen apps' packets travel.
                             It outranks "Custom mode is on", because on
                             and working are not the same thing and a
                             tester spent three sessions believing they
                             were -- his traffic was being redirected into
                             a tunnel that answered none of it while this
                             line said everything was fine. */
                          <p className="mt-1 text-xs text-destructive">{splitTunnelProblem}</p>
                        ) : (
                          <p className="mt-1 text-xs text-highlight">{t("dash.customActive")}</p>
                        )
                      ) : null}

                      {/* The full-tunnel counterpart, in the same place
                          and the same voice. Shown only when the service
                          reports a block is actually installed -- never
                          derived from the protocol -- because this is a
                          statement about the machine's state and the
                          rule on this screen is that it does not make
                          those without evidence.

                          Not shown in Custom mode: the line above
                          already describes what happens to IPv6 there,
                          and it is a different thing (per app, not
                          machine-wide). */}
                      {isTunnelUp(connectionState) && !splitTunnelActive && ipv6Blocked ? (
                        <p className="mt-1 text-xs text-highlight">
                          {t("dash.fullTunnelIpv6Blocked")}
                        </p>
                      ) : null}

                      {/* And the case both of the above are meant to
                          make impossible: IPv6 observed still reaching
                          the internet while connected. Destructive
                          styling and no hedging -- their IPv4 may be
                          perfectly tunnelled and their IPv6 is going out
                          in the clear, which is the exact combination
                          that made this leak invisible for so long. */}
                      {isTunnelUp(connectionState) && ipv6Escaping ? (
                        <p className="mt-1 text-xs text-destructive">{t("dash.ipv6Escaping")}</p>
                      ) : null}
                    </div>

                    {/* Reserved space either way, so the layout doesn't
                        jump when an error appears or clears. */}
                    <div className="min-h-4 px-2 text-center">
                      {connectionError ? (
                        <>
                          <p className="text-xs text-destructive">{t(connectionError.messageKey)}</p>
                          {/* The raw engine text stays available but out
                              of the way: useless to a customer, essential
                              to whoever they send it to. */}
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[10px] text-muted-foreground select-none">
                              {t("err.showDetail")}
                            </summary>
                            <p className="mt-1 font-mono text-[10px] break-words text-muted-foreground" data-ltr>
                              {connectionError.detail}
                            </p>
                          </details>
                          {/* The moment the repair is worth offering.
                              Leftover state from a previous session --
                              an NRPT rule pointing at an unreachable
                              resolver, routes on an adapter whose engine
                              is gone, a stranded tunnel service holding
                              the default route -- presents exactly like
                              this: a connect that will not complete. Put
                              here rather than only in Settings because
                              somebody who cannot connect is already
                              looking at this line, and asking them to go
                              hunting for a fix is how a fix goes unused.

                              Collapsed until asked for. Most connect
                              failures are a blocked server, not a broken
                              machine, and a repair offered as the first
                              answer to every failure would train people
                              to reach for it instead of switching
                              location.

                              No state is set here when it finishes: the
                              repair disconnects, and the status poll a
                              few seconds later is what observes that.
                              Writing "disconnected" from here would be
                              this screen asserting a tunnel state it had
                              not checked. */}
                          <RepairNetwork variant="inline" />
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
              )}

              {/* What the connection actually is. These three answer the
                  questions a customer asks while looking at the orb. */}

              {/* The plan has stopped working. Until now this said so
                  only in the error a connect attempt produced -- text
                  that told the customer to "upgrade or wait for it to
                  renew" on a screen with nothing to press. */}
              {endedState ? (
                <Card className="ring-brand animate-rise flex flex-col gap-2 text-center">
                  <p className="text-sm font-semibold">{t(endedState.titleKey)}</p>
                  <p className="text-xs text-muted-foreground">{t(endedState.bodyKey)}</p>
                  {endedState.showPlansButton ? (
                    <Button onClick={onBrowsePlans} className="mt-2 w-full justify-center gap-2">
                      <Tag className="size-4" />
                      {t("dash.renewCta")}
                    </Button>
                  ) : null}
                </Card>
              ) : null}
              {/* Server, protocol and session length are facts about a
                  tunnel. In gaming mode there is none, so rather than
                  show three tiles describing something that is not
                  running, the gaming panel shows the two facts that are
                  true there. */}
              {appMode === "gaming" ? null : (
              <div className="animate-rise grid grid-cols-3 gap-2">
                {/* Both open the same picker, because a customer asking
                    to "change the protocol" and one asking to "change the
                    server" are choosing from the same list -- a location
                    and the protocol it speaks are one choice here. Two
                    entry points because people look for the word they
                    have in mind. */}
                <Stat
                  icon={
                    currentRoute ? (
                      <Flag region={currentRoute.location.region} className="h-3 w-[1rem]" />
                    ) : (
                      <Globe className="size-3" />
                    )
                  }
                  label={t("dash.server")}
                  value={currentRoute ? currentRoute.location.region : "—"}
                  onClick={() => setShowLocationPicker(true)}
                  actionLabel={t("dash.change")}
                  disabledReason={
                    connectionState === "disconnected" ? undefined : t("dash.disconnectToChange")
                  }
                />
                <Stat
                  icon={<Shield className="size-3" />}
                  label={t("dash.protocol")}
                  value={protocolUser ? customerProtocolLabel(protocolUser.protocol, protocolUser.connection?.transport) : "—"}
                  onClick={() => setShowLocationPicker(true)}
                  actionLabel={t("dash.change")}
                  disabledReason={
                    connectionState === "disconnected" ? undefined : t("dash.disconnectToChange")
                  }
                />
                <Stat
                  icon={<Clock className="size-3" />}
                  label={t("dash.session")}
                  value={
                    connectedAt !== null ? (
                      <span className="tabular-nums">{formatDuration(Math.floor((now - connectedAt) / 1000))}</span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
              )}

              <Card className="animate-rise flex flex-col gap-2.5 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  {/* Same caption treatment as the tiles directly above,
                      so the two blocks read as one column rather than as
                      two cards that happened to land together. */}
                  <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("dash.dataUsed")}
                  </span>
                  {/* The figure carries the card; the cap is context for
                      it. Setting both at one size made a customer read
                      the whole string to find out how much was left. */}
                  <span className="tabular-nums text-sm font-semibold">
                    {usage ? (
                      <>
                        {formatBytes(usage.used)}
                        <span className="text-xs font-normal text-muted-foreground">
                          {" "}
                          / {usage.cap === null ? t("dash.unlimited") : formatBytes(usage.cap)}
                        </span>
                      </>
                    ) : (
                      formatBytes(Number(subscription.dataUsedBytes))
                    )}
                  </span>
                </div>

                {/* A bar rather than a second line of text: proportion is
                    the whole point of a quota, and it's the one thing a
                    number alone can't show at a glance. Turns amber past
                    80% so running low is noticed before it bites. */}
                {usage && usage.cap !== null ? (
                  // The track is inset rather than painted on: a flat
                  // white/8 strip looked like a divider somebody had
                  // thickened, where a recessed groove reads as a gauge.
                  <div className="h-2 w-full overflow-hidden rounded-full bg-black/40 ring-1 ring-white/8 ring-inset">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{
                        width: `${Math.max(usage.percent, 1.5)}%`,
                        background:
                          usage.percent >= 80
                            ? "linear-gradient(90deg, #f59e0b, #ef4444)"
                            : "linear-gradient(90deg, var(--primary), var(--highlight))",
                        // The fill carries its own light, which is what
                        // separates the app's own accent from a generic
                        // progress bar at this size.
                        boxShadow:
                          usage.percent >= 80
                            ? "0 0 10px -1px rgba(239,68,68,0.7)"
                            : "0 0 10px -1px color-mix(in oklab, var(--highlight) 70%, transparent)",
                      }}
                    />
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {t("dash.expires")}{" "}
                    <span className="tabular-nums text-foreground">
                      {new Date(subscription.expireAt).toLocaleDateString()}
                    </span>
                  </span>
                  {daysLeft !== null ? (
                    <span
                      className={
                        daysLeft <= 3
                          ? "rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive"
                          : "rounded-full bg-white/6 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
                      }
                    >
                      <span className="tabular-nums">{daysLeft}</span> {t("dash.daysLeft")}
                    </span>
                  ) : null}
                </div>
              </Card>

              {/* Deliberately not a second copy of the server name.
                  This button used to show the same region as the Server
                  tile above while being the only one that worked, which
                  is precisely what made customers report the app broken:
                  they pressed the thing displaying their server, nothing
                  happened, and the working control looked like a repeat
                  of it. The tile is now the control; this stays only as
                  the plainly-worded way in, and says what it does rather
                  than what is currently set. */}
              {/* Hidden in gaming mode: there is no location in use to
                  change. The resolver's region is named on the gaming
                  panel instead, where it is a fact rather than a
                  control. */}
              {appMode === "gaming" ? null : (
              <>
              <Button
                variant="outline"
                onClick={() => setShowLocationPicker(true)}
                disabled={connectionState !== "disconnected"}
                className="w-full justify-between px-3"
                title={connectionState !== "disconnected" ? t("dash.disconnectToChange") : undefined}
              >
                <span className="flex items-center gap-2">
                  <MapPin className="size-4 text-primary" />
                  {t("dash.changeLocation")}
                </span>
                {/* Points the way the language reads. */}
                <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" />
              </Button>
              {connectionState !== "disconnected" ? (
                <p className="-mt-1 text-center text-xs text-muted-foreground">
                  {t("dash.disconnectToChange")}
                </p>
              ) : null}
              </>
              )}
            </>
          ) : (
            // Previously a dead end: a customer with no subscription --
            // which is everyone, now that trial mode can be turned off --
            // was told they had nothing and given no way to get one.
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <Card className="ring-brand w-full text-center">
                <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Tag className="size-5" />
                </div>
                <p className="text-sm font-semibold">{t("dash.noSubscription")}</p>
                <p className="mt-1 text-xs text-muted-foreground">Choose a plan to start using Neoxify.</p>
                <Button onClick={onBrowsePlans} className="mt-4 w-full justify-center gap-2">
                  <Tag className="size-4" />
                  {t("dash.viewPlans")}
                </Button>
              </Card>
            </div>
          )}
        </>
      )}

      {showLocationPicker && subscription ? (
        <LocationPicker
          subscriptionId={subscription.id}
          currentRouteId={protocolUser?.routeId}
          // Latency cannot be measured from inside the tunnel; see
          // the prop's own note. Anything but "disconnected" means
          // routes are installed, including the verifying and
          // degraded states where a tunnel exists but is not
          // trusted yet.
          tunnelActive={connectionState !== "disconnected"}
          onClose={() => setShowLocationPicker(false)}
          // Re-reads the provisioned connection rather than adopting the
          // switch response directly. Two reasons, one of which was a
          // real bug: the switch endpoint's payload didn't carry the
          // `connection` field that listing does, so switching servers
          // left the app holding credentials with no server address and
          // Connect failed. Re-fetching also means an app running
          // against an older backend still works, instead of depending
          // on that endpoint's exact shape.
          onSwitched={(routeId) => {
            // Their choice leads the order. It used to be the only
            // candidate, which quietly disabled failover for anyone who
            // had ever opened this list.
            setChosenRouteId(routeId ?? null);
            // Persisted, so the pin outlives the process. Without this
            // the dashboard kept showing the chosen server after a
            // restart while the ladder no longer honoured it.
            void saveChosenRoute(routeId ?? null);
            // Passed explicitly: the state set above has not landed yet
            // when loadAll reads it, which is why the screen kept
            // showing the previous choice.
            void loadAll(routeId);
          }}
        />
      ) : null}
    </div>
  );
}
