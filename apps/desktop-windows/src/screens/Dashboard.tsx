import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Clock, Globe, MapPin, Settings as SettingsIcon, Shield, Tag } from "lucide-react";
import { getAvailableRoutes, getMe, getProtocolUsers, getSubscriptions } from "../lib/customer";
import { logout } from "../lib/auth";
import type { Customer, ProtocolUser, RouteOption, Subscription } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { captureBaselineIp, verifyEgress, type EgressVerdict } from "../lib/egress";
import { classifyConnectionError, type ClassifiedError } from "../lib/connection-errors";
import { orderCandidates, lastGoodFor, rememberLastGood, type LastGoodMap } from "../lib/failover";
import { loadChosenRoute, loadLastGood, saveChosenRoute, saveLastGood } from "../lib/failover-store";
import { isEffective, loadSplitTunnel, pushSplitTunnel } from "../lib/split-tunnel";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "../lib/credential-cache";
import { outcomeFromError, reportAttempt, rungsFrom } from "../lib/attempts";
import { Button, Card, Stat } from "../components/ui";
import { ConnectOrb, type ConnectionState } from "../components/ConnectOrb";
import { Logo } from "../components/Logo";
import { LocationPicker } from "../components/LocationPicker";
import { CommunityLinks } from "../components/CommunityLinks";
import { useI18n } from "../lib/i18n";

/** What the helper service reports about the far end.
 *
 * `connected` only means an engine is running locally. `health` is the
 * part that required the server to participate, so it is what decides
 * what the customer is told.
 */
type VpnStatus = {
  connected: boolean;
  protocol: string | null;
  /** Whether Custom mode is intercepting right now, as opposed to being
   * switched on in Settings. The difference is real -- turning it on
   * mid-session cannot retrofit itself onto a tunnel already carrying
   * everything -- and the customer is told which they have. */
  splitTunnelActive?: boolean;
  health:
    | { state: "alive"; age_secs: number }
    | { state: "stale"; age_secs: number }
    | { state: "neverHandshaked" }
    | { state: "down" }
    | { state: "unknown" };
};

/** How often to re-check a live tunnel.
 *
 * WireGuard rehandshakes roughly every two minutes, so this is frequent
 * enough to notice a dead tunnel well inside one cycle without polling
 * the service pointlessly hard. */
const HEALTH_POLL_MS = 15_000;

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
      status = await invoke<VpnStatus>("vpn_status");
    } catch {
      // The service being briefly unreachable is not evidence about the
      // tunnel, so keep waiting rather than concluding anything.
      await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
      continue;
    }

    if (!status.connected) return "disconnected";

    // "unknown" means no handshake evidence exists for this protocol
    // (Xray, OpenVPN) -- there is nothing more to wait for, so don't.
    if (status.health.state === "alive" || status.health.state === "unknown") return "connected";

    last = stateFromStatus(status);
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
  baselineIp: string | null,
  budgetMs = VERIFY_TIMEOUT_MS,
): Promise<EgressVerdict> {
  const deadline = Date.now() + budgetMs;
  let last: EgressVerdict = { state: "unreachable" };

  while (Date.now() < deadline) {
    const verdict = await verifyEgress(baselineIp);
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
async function settleAndCaptureBaseline(budgetMs = SETTLE_TIMEOUT_MS): Promise<string | null> {
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

/** Combines the two independent pieces of evidence.
 *
 * They answer different questions and neither alone is enough: the
 * handshake proves the *server* is talking to us, the egress check proves
 * *our traffic* is going through it. A tunnel can pass the first and fail
 * the second -- the interface is healthy but the routing table never sent
 * anything into it -- which looks perfect locally while the customer is
 * completely unprotected.
 *
 * Egress therefore wins where they disagree: it is the one measured from
 * the far side of the whole path.
 */
function combineEvidence(fromHandshake: ConnectionState, egress: EgressVerdict): ConnectionState {
  if (fromHandshake === "disconnected") return "disconnected";

  switch (egress.state) {
    case "throughTunnel":
      return "connected";
    case "bypassingTunnel":
    case "unreachable":
      return "degraded";
    case "indeterminate":
      // No baseline to compare against, so fall back to whatever the
      // handshake said rather than inventing a verdict.
      return fromHandshake;
  }
}

/** Turns the service's two facts into the one thing to display.
 *
 * `stale` and `neverHandshaked` both become "degraded" rather than
 * "connected": in both cases an interface exists and nothing is reaching
 * the other end, which is precisely the situation that used to render as
 * a confident "Connected".
 *
 * `unknown` stays optimistic deliberately -- it is what Xray and OpenVPN
 * report, where no cheap handshake evidence exists. Showing those as
 * degraded would cry wolf on every connection of those protocols.
 */
function stateFromStatus(status: VpnStatus): ConnectionState {
  if (!status.connected) return "disconnected";
  switch (status.health.state) {
    case "stale":
    case "neverHandshaked":
      return "degraded";
    default:
      return "connected";
  }
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
   * interleaving would have each tearing down the other's engine. */
  const ladderRunningRef = useRef(false);
  /** Consecutive polls that found a live tunnel not carrying traffic. */
  const strikesRef = useRef(0);
  /** Earliest time an automatic attempt may run again. */
  const cooldownUntilRef = useRef(0);
  /** Set when the customer asks to stop a ladder in progress. Checked
   * between steps rather than interrupting one, so the engine is never
   * left half-started. */
  const cancelRef = useRef(false);
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
  const baselineIpRef = useRef<string | null>(null);
  const [exitIp, setExitIp] = useState<string | null>(null);
  /** Taken from the service, never from the Settings toggle.
   *
   * The two disagree in a state the customer can easily reach: switch
   * Custom mode on while already connected, and the setting says yes
   * while the live tunnel is still carrying everything. Showing the
   * toggle here would tell them only their game is routed when the whole
   * machine is. */
  const [splitTunnelActive, setSplitTunnelActive] = useState(false);
  /** When the shown data was last fetched, if the server could not be
   * reached this time. Null means everything on screen is current.
   *
   * Shown rather than hidden: usage figures and expiry dates go stale,
   * and a customer reading a three-day-old data total as today's is
   * exactly the kind of quiet wrongness the rest of this screen exists
   * to avoid. */
  const [offlineSince, setOfflineSince] = useState<number | null>(null);

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
    // actually running rather than assuming disconnected. Failure here is
    // deliberately silent -- it just means "show disconnected", and the
    // real error surfaces on the next Connect attempt with context.
    let adopted: ConnectionState = "disconnected";
    try {
      const status = await invoke<VpnStatus>("vpn_status");
      adopted = stateFromStatus(status);
      setConnectionState(adopted);
      setSplitTunnelActive(Boolean(status.splitTunnelActive));
    } catch {
      setConnectionState("disconnected");
    }

    // Only meaningful while nothing is up: taken through a live tunnel
    // this would record the exit address as the "before" value and every
    // later comparison would wrongly read as a leak.
    if (adopted === "disconnected") {
      baselineIpRef.current = await captureBaselineIp();
      setExitIp(null);
    }
  }

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
    if (connectionState !== "connected" && connectionState !== "degraded") return;

    const id = setInterval(async () => {
      // A ladder already running will decide the state itself; polling
      // underneath it would fight over the same fields.
      if (ladderRunningRef.current) return;

      let fromStatus: ConnectionState;
      try {
        const status = await invoke<VpnStatus>("vpn_status");
        setSplitTunnelActive(Boolean(status.splitTunnelActive));
        fromStatus = stateFromStatus(status);
      } catch {
        // Failing to ask is not the same as learning the tunnel is
        // down, so the last known state stands and no strike is counted.
        return;
      }

      if (fromStatus === "disconnected") {
        setConnectionState("disconnected");
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
      let carrying: boolean;
      if (splitTunnelActive) {
        carrying = await invoke("vpn_probe_split_tunnel")
          .then(() => true)
          .catch(() => false);
      } else {
        const egress = await verifyEgress(baselineIpRef.current);
        carrying = egress.state === "throughTunnel" || egress.state === "indeterminate";
        if (egress.state === "throughTunnel") setExitIp(egress.exitIp);
      }
      const live = carrying && fromStatus === "connected";

      if (live) {
        strikesRef.current = 0;
        setConnectionState("connected");
        return;
      }

      // Custom mode not carrying, but the tunnel itself is healthy.
      //
      // This is the whole "no matter which protocol I pick it ends up on
      // Fast" report. The connect path was taught this and the poll was
      // not, so a protocol would connect correctly and then be dragged
      // off it seconds later: probe fails, strikes accumulate, the
      // ladder runs, WireGuard wins. Every time, on every protocol,
      // which is exactly what it looked like from outside.
      //
      // The probe is also demonstrably capable of false negatives -- it
      // flashed "not carrying traffic" while Chrome was visibly going
      // through the tunnel. Letting a check that flaky throw away a
      // working protocol is indefensible.
      //
      // So: a split-tunnel probe failure is never grounds to change
      // protocol. The engine's own handshake decides whether the tunnel
      // is alive; if it is, the session stands.
      if (splitTunnelActive && fromStatus === "connected") {
        strikesRef.current = 0;
        setConnectionState("connected");
        return;
      }

      setConnectionState("degraded");
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
    }, HEALTH_POLL_MS);

    return () => clearInterval(id);
    // splitTunnelActive is a dependency, not incidental: the poll picks
    // its evidence from it, and a stale `false` would send a Custom-mode
    // session straight back down the egress-check path this exists to
    // avoid.
  }, [connectionState, splitTunnelActive]);

  async function handleConnectToggle() {
    if (!protocolUser) return;
    setConnectionError(null);

    // Pressing it during a pass means stop. The ladder checks this
    // between steps and unwinds itself; the tunnel teardown below is
    // what actually makes the machine usable again.
    if (ladderRunningRef.current) {
      cancelRef.current = true;
      setConnectionState("disconnecting");
      await invoke("vpn_disconnect").catch(() => undefined);
      return;
    }

    if (connectionState === "connected" || connectionState === "degraded") {
      setConnectionState("disconnecting");
      try {
        await invoke("vpn_disconnect");
        setConnectionState("disconnected");
        setConnectedAt(null);
      } catch (err) {
        setConnectionError(classifyConnectionError(err));
        setConnectionState("connected");
      }
      return;
    }

    await runLadder();
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
  async function runLadder(): Promise<boolean> {
    if (!protocolUser || ladderRunningRef.current) return false;
    ladderRunningRef.current = true;
    cancelRef.current = false;
    try {
      setConnectionState("connecting");
      setFailedOverTo(null);

      // Whatever is up comes down first, and this is not a formality.
      // Run from the health poll, the tunnel that just stopped working
      // is still installed and still holding the default route, so every
      // probe below would be fired into a black hole and burn its full
      // timeout rather than answering. That turned a pass that should
      // take seconds into minutes of "Checking connection..." -- observed
      // exactly that way when a live WireGuard tunnel was blocked.
      //
      // Harmless from the Connect button, where nothing is up.
      await invoke("vpn_disconnect").catch(() => undefined);

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
      const candidates = orderCandidates(protocolUsers.length > 0 ? protocolUsers : [protocolUser], {
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

        try {
          await invoke("vpn_connect", { payload: candidate });
          setProtocolUser(candidate);
          setConnectedAt(Date.now());

          // Egress first. WireGuard does not handshake until it has
          // something to send, so this request *is* that traffic: it
          // forces the handshake and answers the stronger question at
          // the same time -- did our packets actually leave via the
          // server.
          setConnectionState("verifying");
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
              const status = await invoke<VpnStatus>("vpn_status").catch(() => null);
              const tunnelAlive = status?.health.state === "alive";
              verdict = tunnelAlive ? "connected" : "degraded";
              if (tunnelAlive) {
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

          if (verdict === "connected") {
            setConnectionState("connected");
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
            // protocol that does not actually work here.
            const updated = rememberLastGood(lastGood, networkId, candidate.routeId);
            setLastGood(updated);
            void saveLastGood(updated);
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
            return true;
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
        if (!isLast) setConnectionState("connecting");
      }

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
      setConnectionState("disconnected");
      await invoke("vpn_disconnect").catch(() => undefined);
      return false;
    } finally {
      ladderRunningRef.current = false;
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

  const currentRoute = useMemo(
    () => routes.find((r) => r.id === protocolUser?.routeId) ?? null,
    [routes, protocolUser],
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

  const daysLeft = useMemo(() => {
    if (!subscription) return null;
    const ms = new Date(subscription.expireAt).getTime() - now;
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }, [subscription, now]);

  const connectLabel =
    connectionState === "connected"
      ? t("dash.connected")
      : connectionState === "degraded"
        ? t("dash.degraded")
        : connectionState === "connecting"
          ? t("dash.connecting")
          : connectionState === "verifying"
            ? t("dash.verifying")
            : connectionState === "disconnecting"
              ? t("dash.disconnecting")
              : t("dash.connect");

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

          <div className="animate-rise flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={
                connectionState === "connected"
                  ? "size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_8px_var(--success)]"
                  : connectionState === "degraded"
                    ? "size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_8px_var(--warning)]"
                  : "size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
              }
            />
            <span className="truncate">{me?.email}</span>
          </div>

          {subscription ? (
            <>
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
                      onToggle={() => void handleConnectToggle()}
                      label={connectLabel}
                    />

                    {/* Says in words what the orb says in colour. The
                        orb alone leaves "am I actually protected right
                        now?" to be inferred from a hue, which is the one
                        question this screen exists to answer. */}
                    <div className="px-4 text-center">
                      <p
                        className={
                          connectionState === "connected"
                            ? "text-sm font-semibold text-success"
                            : connectionState === "degraded"
                              ? "text-sm font-semibold text-warning"
                              : "text-sm font-semibold text-foreground"
                        }
                      >
                        {connectionState === "connected"
                          ? t("dash.protected")
                          : connectionState === "degraded"
                            ? t("dash.degraded")
                            : connectionState === "connecting" || connectionState === "verifying"
                              ? t("dash.verifying")
                              : t("dash.notProtected")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {connectionState === "connected"
                          ? t("dash.protectedHint")
                          : connectionState === "degraded"
                            ? t("dash.degradedHint")
                            : connectionState === "connecting" || connectionState === "verifying"
                              ? t("dash.verifyingHint")
                            : t("dash.notProtectedHint")}
                      </p>
                      {/* The proof, shown rather than just acted on: this
                          is the address the outside world actually saw,
                          which is what makes "protected" verifiable
                          instead of a claim. */}
                      {connectionState === "connected" && exitIp ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          {t("dash.yourIp")}{" "}
                          <span className="tabular-nums font-medium text-foreground">{exitIp}</span>
                        </p>
                      ) : null}

                      {/* Says so when the protocol in use is not the one
                          we set out to use. Quietly landing somewhere
                          else is the same class of dishonesty as a false
                          "Connected" -- and a customer who is told which
                          transport got through has something useful to
                          report when none of them do. */}
                      {connectionState === "connected" && failedOverTo ? (
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
                      {connectionState === "connected" && splitTunnelActive ? (
                        <p className="mt-1 text-xs text-highlight">{t("dash.customActive")}</p>
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
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>

              {/* What the connection actually is. These three answer the
                  questions a customer asks while looking at the orb. */}
              <div className="animate-rise grid grid-cols-3 gap-2">
                {/* Both open the same picker, because a customer asking
                    to "change the protocol" and one asking to "change the
                    server" are choosing from the same list -- a location
                    and the protocol it speaks are one choice here. Two
                    entry points because people look for the word they
                    have in mind. */}
                <Stat
                  icon={<Globe className="size-3" />}
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

              <Card className="animate-rise flex flex-col gap-2.5 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("dash.dataUsed")}</span>
                  <span className="tabular-nums text-xs font-semibold">
                    {usage ? (
                      <>
                        {formatBytes(usage.used)}{" "}
                        <span className="font-normal text-muted-foreground">
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
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{
                        width: `${Math.max(usage.percent, 1.5)}%`,
                        background:
                          usage.percent >= 80
                            ? "linear-gradient(90deg, #f59e0b, #ef4444)"
                            : "linear-gradient(90deg, var(--primary), var(--highlight))",
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
                <ChevronRight className="size-4 text-muted-foreground" />
              </Button>
              {connectionState !== "disconnected" ? (
                <p className="-mt-1 text-center text-xs text-muted-foreground">
                  {t("dash.disconnectToChange")}
                </p>
              ) : null}
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
