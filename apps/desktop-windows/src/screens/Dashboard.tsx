import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gamepad2, Globe, Repeat, Shield, Sparkles } from "lucide-react";
import { describesTunnel, displayedProtocol, displayedRoute, displayedRouteId, heldListLook, showsAutomatic } from "../lib/displayed-route";
import { getAvailableRoutes, getMe, getProtocolUsers, getSubscriptions } from "../lib/customer";
import { logout } from "../lib/auth";
import type { Customer, ProtocolUser, RouteOption, Subscription } from "../lib/types";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { concurrentExitsFor } from "../lib/concurrent-exits";
import { settleAndCaptureBaseline } from "../lib/baseline-settle";
import {
  captureBaselineIp,
  captureIpv6Baseline,
  checkIpv6,
  EGRESS_TIMEOUT_MS,
  verifyEgress,
  confirmEgressWithin,
  type BaselineIp,
  type EgressVerdict,
  type TunnelServer,
} from "../lib/egress";
import { knownServerHosts, literalTunnelServer, nodeAddressesOf, tunnelServerOf } from "../lib/tunnel-server";
import {
  combineEvidence,
  customModePollState,
  droppedFromPoll,
  droppedUnseen,
  fullTunnelPollState,
  handshakeEvidence,
  HEADLINE_HINTS,
  headlineFor,
  isTunnelUp,
  LIVENESS_POLL_MS,
  noTunnelVerified,
  rungJudgedByHandshake,
  showsIpv6Escape,
  stateFromStatus,
  type VpnStatus,
  unconfinedByChoice,
  unconfinedLine,
  warnsUnconfined,
} from "../lib/connection-evidence";
import { orbCaution, orbHold, orbTone } from "../lib/orb-caution";
import { networkWait, waitForNetwork } from "../lib/network-wait";
import {
  NEW_UPLINK_WATCH,
  UPLINK_POLL_MS,
  UPLINK_RECHECK_MS,
  afterUplinkRecheck,
  nextUplink,
  withinMs,
  type RecheckVerdict,
  type UplinkWatch,
} from "../lib/uplink-watch";
import { classifyConnectionError, type ClassifiedError } from "../lib/connection-errors";
import { orderCandidates, ispTagsOf, lastGoodFor, rememberLastGood, type LastGoodMap } from "../lib/failover";
import { recordAttempt, type ConnectHistory } from "../lib/connect-history";
import { probeCandidates } from "../lib/reachability";
import {
  loadChosenRoute,
  loadConnectHistory,
  loadLastGood,
  saveChosenRoute,
  saveConnectHistory,
  saveLastGood,
} from "../lib/failover-store";
import {
  isEffective,
  loadSplitTunnel,
  pushSplitTunnel,
  type SplitTunnelSettings,
} from "../lib/split-tunnel";
import { exitOfRoute } from "../lib/exit-options";
import { gamingDisarm, loadGaming, saveGaming, type AppMode } from "../lib/gaming";
import type { TranslationKey as HintKey } from "../lib/i18n";
import {
  cachedRoutesFor,
  loadSnapshot,
  maySaveSnapshot,
  NO_ROUTES_SHOWN,
  noteCredentialsShown,
  planOf,
  routesForSnapshot,
  saveSnapshot,
  standInRoutes,
  takesRouteList,
  updateSnapshotRoutes,
  type ConnectionSnapshot,
  type ShownRoutes,
} from "../lib/credential-cache";
import { sessionGeneration } from "../lib/session-end";
import { onLateConfig, refreshConnectionConfig } from "../lib/connection-config";
import { useRefreshOnResume } from "../lib/resume";
import { swapView } from "../lib/view-transition";
import { rearmCheckPop } from "../lib/check-pop";
import { IS_STORE_BUILD } from "../lib/distribution";
import { endedNotice } from "../lib/subscription-state";
import { failedDial, outcomeFromError, reportAttempt, rungsFrom, type Dial } from "../lib/attempts";
import {
  failoverNotice,
  failoverText,
  rungFate,
  type FailedRung,
  type FailoverNotice,
} from "../lib/failover-notice";
import { snapshotAge, traceRequests } from "../lib/unanswered-report";
import {
  deviceSlot,
  slotNoticeStore,
  slotStop,
  slotTeardown,
  slotTeardownShown,
  teardownSignal,
  type SlotStop,
  type SlotStopReason,
} from "../lib/device-slot-session";
import { createSessionTracker } from "../lib/session-report";
import { ladderPass } from "../lib/ladder-pass";
import { credentialOnTunnel, tunnelCredential, type TunnelDial } from "../lib/tunnel-credential";
import { setTunnelServer as setEndpointTunnelServer, tunnelServerFromService } from "../lib/api-endpoints";
import { setConfinedAround } from "../lib/connected-mirrors";
import { egressWorthAnotherLook } from "../lib/confinement-recheck";
import { repairUnderWay } from "../lib/repair";
import { appPrefs } from "../lib/app-prefs";
import { autoConnectDecision, autoConnectLatch } from "../lib/auto-connect";
import {
  createStatusRelease,
  gapTraffic,
  gapWord,
  HOLD_HINTS,
  HOLD_WORD_GRACE_MS,
  holdHint,
  holdNotes,
  holdService,
  holdStore,
  holdWanted,
  passTeardown,
} from "../lib/reconnect-hold";
import { NOTIFY_TEXT, notifyMemory, notifyStep } from "../lib/connection-notify";
import { showNotification } from "../lib/notify";
import { trafficMeter } from "../lib/traffic-meter";
import { customModeProblemText, readCustomModeProblem, type CustomModeProblem } from "../lib/custom-mode-problem";
import { adoptedSince } from "../lib/session-clock";
import { ladderProgress } from "../lib/ladder-progress";
import { createRecordBytes, loggedCredential, movedRoute, sessionLog } from "../lib/session-log";
import { ProgressLine } from "../components/main/ProgressLine";
import { SpeedCard, SpeedSection, useTrafficShown } from "../components/main/TrafficSpeed";
import {
  asReconnectReport,
  autoReconnect,
  passStopped,
  reconnectingView,
  reconnectLost,
  reconnectOutcomeOf,
  slotStopWhy,
  vouching,
  type ReconnectAttempt,
  type ReconnectStop,
} from "../lib/auto-reconnect";
import { isServiceTimeout, withTimeout } from "../lib/service-call";
import { PROBE_CAP_MS, statusDisturbances } from "../lib/status-disturbance";
import {
  concludeIntent,
  declareIntent,
  IDLE_INTENT,
  isCurrent,
  phaseFor,
  pressFor,
  supersedeAnswers,
  type IntentState,
  type PressAction,
} from "../lib/connect-intent";
import { Banner, Note, PillButton, Presence, Segmented } from "../components/ui";
import { Dialog, LocationSheet } from "../components/overlay";
import { Page, PageScene } from "../components/shell/Page";
import { AppShell, type ShellPage } from "../components/shell/AppShell";
import { noteWayOut, planLineText, rememberShellProfile, takeLocationsRequest, type ShellPlan } from "../lib/shell-nav";
import { MainView } from "../components/main/MainView";
import { Decor, Hint, StateAnnouncer, StateLine, StatusChip, WayOut } from "../components/main/Hero";
import { LocationCard, MetricCards, SessionTray, SummaryLine, type TrayLocation, type TrayPlan } from "../components/main/SessionTray";
import { HeroArt } from "../components/main/HeroArt";
import { SLOT, Slotted } from "../components/Slotted";
import { MapLegend } from "../components/main/MapLegend";
import { WorldMap } from "../components/main/WorldMap";
import { mapCountries, mapLights, ownWorkedAt, placesEvidence, type EvidenceContext } from "../lib/map-lights";
import {
  IDLE_WAY_OUT_POLL_MS,
  NO_ROAM,
  idleWayOut,
  mapNetwork,
  tagsCurrent,
  tunnelWayOut,
  withoutTags,
  type NetworkFreshness,
} from "../lib/map-network";
import { currentNetwork } from "../lib/network-identity";
import {
  chipFor,
  hintTone,
  ipFor,
  lineFor,
  pillFor,
  planCaution,
  secondaryFor,
  shownTone,
  type ShownTone,
} from "../lib/hero-model";
import { useWindowLayout } from "../lib/layout-mode";
import { formatDateTime, formatNumber, formatSize, sizeParts } from "../lib/locale-format";
import { describeSlotNotice, slotNoticeShown } from "../lib/device-slot-notice";
import { ConnectOrb, type ConnectionState } from "../components/ConnectOrb";
import { GamingStatusPanel } from "../components/GamingStatusPanel";
import { Logo } from "../components/Logo";
import { RouteFlag } from "../components/Flag";
import { placeKey, placeLabel, routePlace } from "../lib/route-place";
import { LocationPicker } from "../components/LocationPicker";
import { CommunityLinks } from "../components/CommunityLinks";
import { RepairNetwork } from "../components/RepairNetwork";
import { DeviceSlotCard } from "../components/DeviceSlotCard";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { failureText, offlineReason as reasonFor, offlineText, type OfflineReason, type ShownFailure } from "../lib/failure-text";
import { STILL_TRYING_AFTER_MS, useStillTrying } from "../lib/still-trying";
import { onBackendAnswer } from "../lib/api";
import {
  answerAsksAgain,
  reasonAfterAnswer,
  reasonAfterUnansweredLoad,
  reasonWhileWaiting,
  useOfflineRetry,
  type OfflineLoadOutcome,
  type OfflineRetryTrigger,
} from "../lib/offline-retry";

/** How a ladder pass ended.
 *
 * "declined" is its own answer rather than folded into "failed", because
 * the two need different words to the customer: a pass that ran and
 * could not carry traffic has a report to show, while one that never
 * started has nothing to say about any server and must not pretend
 * otherwise. It also used to be silent, which is what a dead-looking
 * button is made of.
 *
 * "refused" is the plan's device limit: nothing was dialled, because
 * Neoxify is in use on another of the customer's devices. Neither a
 * failure nor a decline -- the card says where, and how to move it here.
 */
type LadderOutcome = "connected" | "failed" | "declined" | "refused";

/** Kinds of connect error a network repair cannot help with. Offering it
 * under "your plan's device limit is in use" would send somebody to fix
 * a machine that is not broken. */
const NOT_THE_NETWORK = new Set(["concurrentLimit", "quotaExhausted", "subscriptionInactive"]);

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

/** The most one health poll's egress check may spend walking the
 * endpoint list. Two endpoints' worth: a first endpoint that hangs still
 * leaves the next its full timeout, and a tunnel that black-holes
 * everything is called out in about twelve seconds plus the internet
 * probe, not after every endpoint in the list has timed out in turn. */
const HEALTH_EGRESS_TOTAL_MS = 2 * EGRESS_TIMEOUT_MS;

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

/** Waits for traffic to actually start flowing, rather than asking once.
 * See `confirmEgressWithin` for how the attempts are made, and
 * `TunnelServer` for why the rung's server goes with it.
 *
 * The baseline's endpoint first even on the last rung, where the rest of
 * the list is still asked after it: in list order, a baseline taken from
 * a mirror on a network that filters the panel hosts was compared with
 * nothing, because through the tunnel the panel host answers first --
 * and the one connect that could have been proven landed "not
 * confirmed". See `VerifyOptions.baselineFirst`. */
function confirmEgress(
  baseline: BaselineIp | null,
  budgetMs: number,
  sameEndpointOnly: boolean,
  tunnelServer: TunnelServer,
): Promise<EgressVerdict> {
  return confirmEgressWithin(baseline, budgetMs, { sameEndpointOnly, tunnelServer, baselineFirst: true });
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

// `settleAndCaptureBaseline`, which waits for the bare network before
// each rung and takes its baseline, is in lib/baseline-settle.ts.

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

export function Dashboard({
  onLoggedOut,
  onBrowsePlans,
  onOpenSettings,
  onOpenReferrals,
  onOpenSupport,
  onOpenActivity,
  update,
  page = null,
  onShowMain,
}: {
  onLoggedOut: () => void;
  onBrowsePlans: () => void;
  onOpenSettings: () => void;
  onOpenReferrals?: () => void;
  onOpenSupport?: () => void;
  /** The Activity page, in the shell's nav. */
  onOpenActivity?: () => void;
  /** The update notice, which the shell places. */
  update?: ReactNode;
  /** Another page of the shell, drawn in this screen's own shell in place
   * of the main page; null on the main page. This screen stays mounted
   * under it -- its load, the service's word, the verified tunnel, the
   * route list -- so coming back draws the main page as it was, never a
   * load in front of it, and asks again only behind it (`revalidate`). */
  page?: ShellPage | null;
  /** Back to the main page from `page`, as a plain change of state: this
   * screen's own nav makes it inside its transition (`showMainFrom`). */
  onShowMain?: () => void;
}) {
  const { t, language } = useI18n();
  /** The main page itself is in view, not another page of the shell. */
  const onMainPage = page === null;
  const [loading, setLoading] = useState(true);
  // The loading screen waits on three reads, each given up to twenty
  // seconds an address; past eight it says it is still trying.
  const loadingLong = useStillTrying(loading);
  // "Locations" pressed on another page of the shell: once this screen has
  // loaded, its Locations page is shown as if it had been pressed here.
  useEffect(() => {
    if (!loading && onMainPage && takeLocationsRequest()) openLocationsPage();
    // Once per load, or per return to the main page; openLocationsPage is
    // this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, onMainPage]);
  // Kept as it came, and worded as the screen renders (`ShownFailure`):
  // worded when it came in, it was in the language the app was in when the
  // load began, which country detection may have changed since.
  const [error, setError] = useState<ShownFailure | "loadFailed" | null>(null);
  const [me, setMe] = useState<Customer | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  /** The same, for callbacks registered once that run much later -- an
   * adopted pass ending. */
  const subscriptionRef = useRef<Subscription | null>(null);
  subscriptionRef.current = subscription;
  const [protocolUser, setProtocolUser] = useState<ProtocolUser | null>(null);
  /** Every credential this subscription holds -- one per route its plan
   * allows. The list is the failover ladder; `protocolUser` is whichever
   * rung is currently in use. */
  const [protocolUsers, setProtocolUsers] = useState<ProtocolUser[]>([]);
  /** The server the customer picked from the list, if any. Tried
   * first; deliberately does not disable the others. */
  const [chosenRouteId, setChosenRouteId] = useState<string | null>(null);
  /** A tunnel this screen found up -- back from Settings, or after a
   * restart -- whose credential it cannot name: the service reports a
   * protocol, and the last dial is not the tunnel's
   * (`credentialOnTunnel`). The tiles then name no route rather than the
   * pin `protocolUser` holds for the next connect. Cleared once a pass of
   * this screen has an engine up, which it names itself, or once a read
   * of the service names the tunnel it found up (`nameFoundTunnel`).
   *
   * True to begin with, and again whenever a load puts the pin on screen:
   * a tunnel that comes to be shown up by any way that does not name it is
   * then named as nothing, never as the pin. While nothing is up it
   * changes nothing on screen. */
  const [tunnelRouteUnknown, setTunnelRouteUnknown] = useState(true);
  /** The same, as the tiles' rule takes it (`settledKnown` in
   * displayed-route.ts). */
  const tunnelNamed = !tunnelRouteUnknown;
  /** The same, for effects that read it as they run (the session log). */
  const tunnelNamedRef = useRef(tunnelNamed);
  tunnelNamedRef.current = tunnelNamed;
  /** Counts a session that keeps passing its health checks, once, for
   * the per-ISP tags. See session-report.ts. */
  const sessionTrackerRef = useRef(createSessionTracker());
  /** The reads a hold may be let go of on from status alone
   * (`createStatusRelease`): two, apart, each of a tunnel landed under it. */
  const statusReleaseRef = useRef(createStatusRelease());
  /** The route the tunnel is on, readable from inside the health poll's
   * interval without depending on which render created it. */
  const settledRouteRef = useRef<string | null>(null);
  settledRouteRef.current = tunnelRouteUnknown ? null : (protocolUser?.routeId ?? null);
  /** The route the tunnel was on the last time traffic was verified, for
   * the world map's connected light. Drawn only while the screen wears the
   * verified tone (`mapLights`), so it holds through a brief gap exactly as
   * the chip's colour does and never stands for an unconfirmed tunnel. */
  const verifiedRouteRef = useRef<RouteOption | null>(null);
  /** The route the location list named the last time the session was
   * settled, for its row in use through a brief gap (`heldListLook`): null
   * for a tunnel it could not name. */
  const listSettledRef = useRef<string | null>(null);
  /** Which network we are on, so "what worked here last time" means
   * here and not somewhere else. Null when it cannot be determined. */
  const [networkId, setNetworkId] = useState<string | null>(null);
  /** When the way out last changed under this screen, and when the network
   * id and the route list's per-network tags were last read: whether the
   * map's evidence still describes the network the device is on
   * (`lib/map-network.ts`). */
  const [netFresh, setNetFresh] = useState<NetworkFreshness>(NO_ROAM);
  const [lastGood, setLastGood] = useState<LastGoodMap>({});
  /** Per route and protocol, how recent attempts went on this network.
   * Richer than `lastGood`, which holds one route and no outcome. */
  const [history, setHistory] = useState<ConnectHistory>({});
  /** Whether the three above have been read for this screen -- see
   * `loadRouteMemory`. Until then they are empty placeholders, not this
   * network's memory. */
  const [routeMemoryLoaded, setRouteMemoryLoaded] = useState(false);
  /** Whether `loadAll` has asked for the route list -- answered or not --
   * or put the cached one on screen. Until then `routes` is the empty
   * placeholder, not this subscription's list. What an automatic
   * reconnect's attempt waits for besides the route memory: the pass
   * reads the list throughout, for the extra exits of concurrent
   * multi-exit (`concurrentExitsFor`), the egress the split tunnel places
   * games against (`exitOfRoute`), and the per-ISP tie-break. Run before
   * it had arrived, a held attempt landed with no extra exits and every
   * game's placement Unknown, and kept that until the next connect. */
  const [routeListLoaded, setRouteListLoaded] = useState(false);
  /** How many loads this screen has started, and which of them put the
   * route list on screen, for which plan (`standInRoutes`). */
  const loadSeqRef = useRef(0);
  const routesShownRef = useRef<ShownRoutes>(NO_ROUTES_SHOWN);
  /** The latest of this screen's loads to have written the snapshot
   * (`maySaveSnapshot`). */
  const snapshotWriterRef = useRef(0);
  /** Whether this screen has shown the dashboard yet, from an answer or
   * from the cache: a load before then puts the snapshot on screen while it
   * waits (`loadAll`). */
  const shownOnceRef = useRef(false);
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
  // And what became of the server on screen -- dialled and failed, never
  // dialled for want of a network, or never asked -- because each takes a
  // different sentence and only one of them is true (`failoverNotice`).
  const [failedOverTo, setFailedOverTo] = useState<FailoverNotice | null>(null);
  /** Guards the ladder against running twice at once. The health poll
   * and the Connect button can both start one, and two of them
   * interleaving would have each tearing down the other's engine.
   *
   * Read through `ladderInFlight`, never directly: the guard is held for
   * as long as a pass could still plausibly be alive, not forever.
   *
   * One per app, not per screen (`lib/ladder-pass`): a pass outlives the
   * Dashboard that started it whenever Settings is opened mid-connect,
   * and the screen mounted on return has to see it. */
  const ladderRunningRef = ladderPass.running;
  /** When the pass holding the guard began, so the guard can expire. */
  const ladderStartedAtRef = ladderPass.startedAt;
  /** Which pass is the current one. A pass that outlived its deadline
   * has been superseded, and must not be allowed to clear a newer
   * pass's guard or write state on its way out. */
  const ladderGenerationRef = ladderPass.generation;
  /** The pass this screen started, if any -- as opposed to one it found
   * running when it mounted, which it adopts instead. */
  const ownPassRef = useRef(0);
  /** The intent this screen declared on adopting a pass it did not
   * start, until that pass ends. */
  const adoptedPassIntentRef = useRef<number | null>(null);
  /** Consecutive polls that found a live tunnel not carrying traffic. */
  const strikesRef = useRef(0);
  /** Consecutive polls the service did not answer at all. */
  const statusMissesRef = useRef(0);
  /** The service's last answer as it came, or null when it did not
   * answer: `readServiceState` hands on only the state it implies, and a
   * screen mounting has to know whether "nothing is running" was the
   * service's verified word (`droppedUnseen`). */
  const lastStatusRef = useRef<VpnStatus | null>(null);
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
   * left half-started. Shared with the pass for the same reason as the
   * guard: a stop pressed on a remounted screen has to reach it. */
  const cancelRef = ladderPass.cancel;
  const [signingOut, setSigningOut] = useState(false);
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
  /** The same, for a press reported after an await: the server list says
   * which location was chosen only once its switch request has answered. */
  const connectionStateRef = useRef<ConnectionState>("disconnected");
  connectionStateRef.current = connectionState;
  /** Whether the tunnel the screen was vouching for closed without anyone
   * asking. Only ever true alongside "disconnected", and it changes the
   * words from "connect to be protected" to "your connection was lost".
   * See `droppedFromPoll`. */
  const [tunnelDropped, setTunnelDropped] = useState(false);
  /** Single-flight for the one-second liveness poll. */
  const livenessInFlightRef = useRef(false);
  /** Single-flight for the fifteen-second health poll's measurement. */
  const healthCheckInFlightRef = useRef(false);
  /** A newer run's first check, waiting for the one in flight to end. */
  const healthCheckWantedRef = useRef<(() => Promise<void>) | null>(null);
  /** The way out this session's tunnel was proven over, as the watch last
   * saw it (`lib/uplink-watch.ts`). Back to "not looked at" whenever no
   * tunnel is up, so each session's first look is its own. */
  const uplinkRef = useRef<UplinkWatch>(NEW_UPLINK_WATCH);
  /** Single-flight for that watch, its re-verification included. */
  const uplinkInFlightRef = useRef(false);
  /** Moved on each change of the way out, so a health poll measuring
   * across one lands nothing: its reading is about the way out that was. */
  const uplinkEpochRef = useRef(0);
  const [connectionError, setConnectionError] = useState<ClassifiedError | null>(null);
  /** What the plan's device limit has to say, when it is why this device
   * is not connected: refused before dialling, taken over by another
   * device, or a check that could not be made. See `deviceSlot`.
   *
   * Kept beside the slot, not in this screen: a claim through the tunnel
   * can be refused while the screen is away in Settings, and the tunnel
   * comes down regardless. The card written then is here on return. */
  const slotNotice = useSyncExternalStore(slotNoticeStore.subscribe, slotNoticeStore.current);
  const setSlotNotice = slotNoticeStore.set;
  /** Whether a teardown the device limit asked for is still owed, and
   * whether an attempt at it has already come back without the tunnel
   * down. Beside the slot for the same reason the card is; see
   * `slotTeardown`. */
  const slotTeardownState = useSyncExternalStore(slotTeardown.subscribe, slotTeardown.state);
  /** That teardown, while the screen shows it under way. Worded as what
   * it is -- still disconnecting -- rather than as "You're not
   * protected", which the service has not said. */
  const slotTeardownShowing = slotTeardownState !== "none" && connectionState === "disconnecting";
  /** Set when the device limit ended or refused this device's session.
   * The automatic ladder must not run then -- it would only take the
   * slot back from the device the customer is now using, or fail on
   * every protocol and say so about servers that are fine. Cleared by the
   * customer's own next connect. */
  const slotLostRef = useRef(false);
  /** The automatic reconnect after a drop (`lib/auto-reconnect`): one per
   * app, so an episode under way survives this screen unmounting for
   * Settings, and the screen mounted on return words it the same way --
   * for the session in force only, so an episode a sign-out left behind
   * says nothing to the next sign-in. */
  const reconnect = useSyncExternalStore(autoReconnect.subscribe, autoReconnect.current);
  const reconnecting = reconnectingView(reconnect, sessionGeneration());
  /** The same, for the switch confirmation, which reads it after an await. */
  const reconnectingRef = useRef(reconnecting);
  reconnectingRef.current = reconnecting;
  /** What the service last said about "Block the internet while
   * reconnecting" (lib/reconnect-hold.ts), and the device's preferences
   * (lib/app-prefs.ts). */
  const hold = useSyncExternalStore(holdStore.subscribe, holdStore.current, holdStore.current);
  const prefs = useSyncExternalStore(appPrefs.subscribe, appPrefs.current, appPrefs.current);
  /** Whether the tray has a measured speed to show (lib/traffic-meter.ts). */
  const trafficShown = useTrafficShown();
  /** The run's own connect at launch is under way, and says why
   * (lib/auto-connect.ts). */
  const [autoConnecting, setAutoConnecting] = useState(false);
  /** How the last ladder pass ended, beyond its outcome: which route it
   * landed on, or the kind of error it stopped on. Read by the reconnect
   * runner, which has to tell "the plan said no" from "the network did". */
  const passResultRef = useRef<{ routeId: string | null; errorKind: string | null }>({
    routeId: null,
    errorKind: null,
  });
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  /** A server's switch request is out, from the pick until it is answered
   * (`onPicking` to `onSwitched` or `onPickFailed`): the phone's sheet does
   * not close meanwhile (`LocationSheet`'s `dismissible`). */
  const [switchInFlight, setSwitchInFlight] = useState(false);
  /** Which of the three layouts the window is in: where the one location
   * list lives -- the panel, or a sheet on a phone-sized window. */
  const layout = useWindowLayout();
  /** Bumped to flash the locations panel when it is asked for. */
  const [panelFlash, setPanelFlash] = useState(0);
  /** The main page, or its Locations page: the full list, with each
   * protocol's hint and what the evidence means (design-system.md 4.8).
   * Drawn by this screen, so a pick there goes through the same
   * confirmation and the same wiring as one in the panel. */
  const [view, setViewNow] = useState<"overview" | "locations">("overview");
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The main page or the Locations page: the change slides like a change
   * of page (lib/view-transition.ts), and asking for the one on screen
   * changes nothing. */
  const setView = (next: "overview" | "locations") => {
    if (viewRef.current === next) return;
    viewRef.current = next;
    swapView(() => setViewNow(next), next === "locations" ? "forward" : "back");
  };
  const [locSection, setLocSection] = useState<"explain" | undefined>(undefined);
  /** The switch confirmation open, and how it is answered (`confirmPick`). */
  const [switchAsk, setSwitchAsk] = useState<{
    place: string | null;
    protocol: string | null;
    tunnelUp: boolean;
    resolve: (go: boolean) => void;
  } | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  /** A confirmed switch owes a connect once the pick has landed. */
  const connectAfterSwitchRef = useRef(false);
  const [switchConnect, setSwitchConnect] = useState(0);
  /** Gaming mode's own calm tone and summary, from its panel. */
  const [gamingTone, setGamingTone] = useState<ShownTone>("idle");
  const [gamingSummary, setGamingSummary] = useState<{ picked: number; resolver: string | null } | null>(null);

  // Set when *this* app instance brought the tunnel up, or -- for a tunnel
  // adopted on launch -- from the age the service reports for its session
  // (`sessionSecs`, lib/session-clock.ts). A service that does not say has
  // no honest duration to show, and the timer stays blank rather than
  // inventing one from the moment the window opened.
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** The address the world saw before connecting. Captured while still
   * disconnected -- taken afterwards it would be the tunnel's own exit
   * address and the comparison would be meaningless. A ref rather than
   * state because nothing renders from it, and the pass's rather than
   * this screen's: a screen remounted mid-connect adopts the pass, and
   * must compare against the baseline that pass took. See
   * `ladderPass.baseline`. */
  const baselineIpRef = ladderPass.baseline;
  const [exitIp, setExitIp] = useState<string | null>(null);
  /** Taken from the service, never from the Settings toggle.
   *
   * The two disagree in a state the customer can easily reach: switch
   * Custom mode on while already connected, and the setting says yes
   * while the live tunnel is still carrying everything. Showing the
   * toggle here would tell them only their game is routed when the whole
   * machine is. */
  const [splitTunnelActive, setSplitTunnelActive] = useState(false);
  /** Whether the saved settings ask for Custom mode -- what the *next*
   * connect will do. Used only while no tunnel is up, for the line under
   * the mode switch; once one is, `splitTunnelActive` is the truth. */
  const [customConfigured, setCustomConfigured] = useState(false);
  /** Which way the saved Custom mode cuts: only the chosen apps through
   * the VPN, or everything except them. The line under the mode switch
   * said "only the apps you chose go through Neoxify" for both, which
   * in "All except these" is the opposite of what is happening. */
  const [customExcept, setCustomExcept] = useState(false);
  // Read whenever the main page comes into view -- at mount, and back from
  // a page of the shell: Settings is where Custom mode is changed, and this
  // screen stays mounted under it.
  useEffect(() => {
    if (!onMainPage) return;
    loadSplitTunnel()
      .then((settings) => {
        setCustomConfigured(isEffective(settings));
        setCustomExcept(settings.mode === "allExcept");
      })
      .catch(() => undefined);
  }, [onMainPage]);
  const [splitTunnelProblem, setSplitTunnelProblem] = useState<CustomModeProblem | null>(null);
  // Whether the service asked for the tunnel's DNS rule and did not get
  // it. Read from the service, never derived: only it knows whether an
  // engine tried. `false` is "nothing was reported", not "DNS is
  // protected" -- see VpnStatus.tunnelDnsUnprotected.
  const [tunnelDnsUnprotected, setTunnelDnsUnprotected] = useState(false);
  // Applications the customer selected while they were already open.
  // Named rather than counted, because someone with six things selected
  // has to know which one to close -- see VpnStatus.splitTunnelRestartNeeded.
  const [restartNeeded, setRestartNeeded] = useState<string[]>([]);
  /** VPN mode or gaming mode.
   *
   * Read before anything else on the screen, because it changes what
   * every element below it means: in gaming mode there is no tunnel and
   * no adapter, so "Connected" has nothing it could stand for and the
   * exit-IP pill would be describing an address the product did not
   * change. */
  const [appMode, setAppMode] = useState<AppMode>("vpn");
  /** The same, for the reconnect's exclusions, which run from callbacks
   * registered once. */
  const appModeRef = useRef<AppMode>(appMode);
  appModeRef.current = appMode;
  /** Whether the service says IPv6 is blocked for this session. */
  const [ipv6Blocked, setIpv6Blocked] = useState(false);
  /** Whether the service says this full tunnel should hold the machine's
   * IPv4 to it and does not (`warnsUnconfined`): the headline then says
   * "connected, not fully protected", and a line says what is not covered. */
  const [ipv4NotConfined, setIpv4NotConfined] = useState(false);
  /** Which words say what is not covered (`unconfinedLine`): Built-in's
   * own, where reconnecting changes nothing, or the general one. */
  const [unconfinedKey, setUnconfinedKey] = useState<TranslationKey>("dash.ipv4NotConfined");
  /** Whether the orb and the status dot show the warning colour: only for a
   * confirmed connection that has been "not fully protected" long enough,
   * unbroken, or is Built-in's, never confined (`orb-caution.ts`). The
   * owner's rule: a few seconds of not being connected -- a reconnect, a
   * rung, an engine restarted, a drop's gap -- must not change the colour.
   * The headline's words follow `ipv4NotConfined` at once, as before. */
  const [cautionShown, setCautionShown] = useState(() => orbHold.caution());
  /** The state the orb and the status dot are drawn as: a confirmed
   * session's, held over a short "degraded" / "unverified" / "unknown"
   * (`orbHold`). The headline still follows `connectionState`. */
  const [orbState, setOrbState] = useState<ConnectionState>(() => orbHold.current());
  const unconfinedChosen = unconfinedByChoice(unconfinedKey);
  /** A press of the customer's is in flight -- Connect, Disconnect, Stop,
   * Check again, a switch of location -- from the press until the state
   * settles. Nothing is held over one (`orbHold`), and a busy it started
   * wears the quiet glass fill rather than the held cobalt (`pillFor`). */
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (connectionState !== "connecting" && connectionState !== "verifying" && connectionState !== "disconnecting") setPressed(false);
  }, [connectionState]);
  const reconnectRunning = reconnecting !== null;
  useEffect(() => {
    const look = () => {
      const caution = orbCaution.observe({ state: connectionState, unconfined: ipv4NotConfined, byChoice: unconfinedChosen });
      setOrbState(
        orbHold.observe(connectionState, {
          // Read from the store as it is now rather than as this render
          // saw it: a drop publishes "disconnected" and starts its
          // reconnect in one go, and the hold has to see both.
          reconnecting: reconnectingView(autoReconnect.current(), sessionGeneration()) !== null,
          pressed,
          caution,
        }),
      );
      setCautionShown(orbHold.caution());
    };
    look();
    // Looked at every second while up, or while a look is held over a gap,
    // so a condition that holds is seen to hold -- and a hold ends on time
    // -- whether or not anything else renders.
    const up =
      connectionState === "connected" || connectionState === "degraded" || connectionState === "unverified" || connectionState === "unknown";
    if (!up && !orbHold.holding() && !reconnectRunning) return;
    const id = setInterval(look, 1_000);
    return () => clearInterval(id);
  }, [connectionState, ipv4NotConfined, unconfinedChosen, pressed, reconnectRunning]);
  /** A pass waiting on its rung for a network to dial over
   * (`network-wait.ts`), from whichever screen started it. */
  const waitingForNetwork = useSyncExternalStore(networkWait.subscribe, networkWait.current);
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
  /** The same, for callbacks registered once (`onBackendAnswer`). */
  const offlineSinceRef = useRef<number | null>(null);
  offlineSinceRef.current = offlineSince;
  /** Why the screen is on the snapshot, as the banner says it. */
  const [offlineReason, setOfflineReason] = useState<OfflineReason>("unreached");
  /** How many times Neoxify has answered anything this app sent, while
   * this screen has been mounted (`onBackendAnswer`). A load that got no
   * answer compares it with the count when it began: an answer since then
   * is newer than its failure, and the banner says that instead
   * (`reasonAfterUnansweredLoad`). */
  const answersHeardRef = useRef(0);
  /** While the screen is on its snapshot, the load is made again in the
   * background, and at once when there is a reason to think it would now
   * be answered. See offline-retry.ts. Started where a load falls back to
   * the snapshot, stopped where one gets its answer. The screen's own
   * loads run through it (`loadAll`), so the two never overlap. */
  const offlineRetry = useOfflineRetry({
    load: (why) => loadInBackground(why),
  });
  /** Says that the load a server switch starts has begun, or that the
   * switch failed and none will (`expectOwnLoad`). Set while a switch is
   * out. */
  const switchLoadExpectedRef = useRef<(() => void) | null>(null);

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
    return ladderPass.inFlight();
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
    // The service saying the tunnel is down is what a teardown the device
    // limit still owes waits for, whoever asked: a remount after
    // Settings, a recheck pressed while the state was unknown, the
    // health poll. The retry only runs on the transient recheck, which
    // has nothing to do once the screen says "disconnected" -- so
    // without this the stuck line, saying the tunnel has not been
    // confirmed closed, outlived the service confirming exactly that.
    if (observed === "disconnected") slotTeardown.confirmDown();
    // A tunnel still up after the device limit ended the session is one
    // still being taken down, never one that is fine -- whichever path
    // observed it: the teardown's own check, a recheck, a remount.
    const phase = phaseFor(intentRef.current.intent, slotTeardownShown(slotTeardown.owed(), observed));
    setConnectionState(phase);
    return phase;
  }

  /** Puts "VPN connection lost" on screen -- the one place it is said --
   * once `droppedFromPoll` has agreed that it is true.
   *
   * Then it makes every answer still in flight old news. The health
   * check takes its status first and its egress or probe reading seconds
   * later, so one that asked before the engine died would otherwise land
   * its verdict -- "unverified", "degraded", even "connected" -- on top
   * of this, about a tunnel that is gone. See `supersedeAnswers`.
   *
   * Returns whether it was shown; it is not when a press has overtaken
   * the answer it rests on.
   *
   * And it is where an automatic reconnect begins (`lib/auto-reconnect`):
   * this is the one moment the app knows a tunnel ended that nobody of
   * ours asked to end -- `droppedFromPoll` has already ruled out a
   * Disconnect, a connect's own teardown, and anything our Custom-mode
   * changes or probe disturbed. While it runs the headline says
   * "Reconnecting..."; if it does not start, or gives up, it says this. */
  function publishDrop(generation: number): boolean {
    if (publishObserved(generation, "disconnected") === null) return false;
    intentRef.current = supersedeAnswers(intentRef.current);
    setTunnelDropped(true);
    setConnectedAt(null);
    strikesRef.current = 0;
    sessionTrackerRef.current.broken();
    // Nothing renews a slot without a tunnel, and nothing is going to
    // bring one back: given back, rather than left to turn the
    // customer's other device away as "in use" until it goes stale. Kept
    // while a reconnect runs, whose claim renews it -- and given back by
    // the episode itself if it ends before a pass of it claimed
    // (`slotIdle`). And the reconnect hold, which the service began the
    // moment the engine died: with nothing to reconnect, nothing is to be
    // held -- whatever phase the drop found (lib/reconnect-hold.ts).
    if (autoReconnect.dropped({ exclusion: reconnectExclusion() }) === "lost") {
      void deviceSlot.release();
      if (holdWanted(appPrefs.current().blockWhileReconnecting)) void holdService.release();
    }
    return true;
  }

  /** A tunnel whose way out has gone (`lib/uplink-watch.ts`): the link
   * dropped, or a roam the tunnel did not survive. Its engine may still be
   * running, but it cannot carry anything, and the screen must not go on
   * saying "You're protected" over it -- measured on the VM at 20 s after
   * the link went and 26 s after a roam.
   *
   * Said as a drop is said, and handed to the same automatic reconnect: the
   * existing "Reconnecting..." look, "Waiting for a network connection"
   * while there is none, the same server first, and "protected" only from
   * that reconnect's own proof. Its first attempt takes the dead tunnel
   * down. Where no reconnect will run -- the episode would not start --
   * the dead tunnel is taken down here, so nothing is left running behind
   * "VPN connection lost". Not over the device limit's own teardown. */
  function publishCarrierLost(generation: number): void {
    if (slotLostRef.current || slotTeardown.owed()) return;
    if (!publishDrop(generation)) return;
    const phase = autoReconnect.current().kind;
    if (phase !== "waiting" && phase !== "attempting") void serviceDisconnect().catch(() => undefined);
  }

  /** The tunnel measured again, now, after its way out changed: what the
   * routine health poll would conclude -- the same evidence, from the
   * status, the egress check or Custom mode's probe -- within
   * `UPLINK_RECHECK_MS`, or "timedOut". Nothing here is shown or counted;
   * the watch decides what it means (`afterUplinkRecheck`). */
  async function recheckAfterUplinkChange(): Promise<RecheckVerdict> {
    let status: VpnStatus;
    try {
      status = await serviceStatus();
    } catch {
      return "unknown";
    }
    const fromStatus = stateFromStatus(status);
    if (fromStatus === "disconnected") return "disconnected";
    let measured: Promise<ConnectionState>;
    if (status.splitTunnelActive) {
      // The probe holds the service's owning thread, as the health poll's
      // does: marked, so a liveness answer it causes is not read as a drop.
      const probed = statusDisturbances.begin(PROBE_CAP_MS);
      measured = invoke("vpn_probe_split_tunnel")
        .then(() => true)
        .catch(() => false)
        .finally(probed)
        .then((carried) => customModePollState(fromStatus, carried));
    } else {
      const tunnelServer = ladderPass.tunnelServer.current ?? undefined;
      measured = verifyEgress(baselineIpRef.current, {
        totalMs: UPLINK_RECHECK_MS,
        tunnelServer,
        baselineFirst: true,
      }).then((egress) => fullTunnelPollState(fromStatus, egress));
    }
    return withinMs(measured, UPLINK_RECHECK_MS, "timedOut" as const);
  }

  /** What, at this moment, rules an automatic reconnect out -- asked at
   * the drop and again before every attempt.
   *
   *  - The plan's device limit ended or refused this device's session, or
   *    its teardown is still owed: reconnecting would only take the slot
   *    back from the device the customer is now using
   *    (docs/device-slots.md, obligations 7 and 11).
   *  - The subscription is not active: every pass would be refused.
   *  - Gaming mode: there is no tunnel in it to bring back.
   *
   * A sign-out is not here: `sessionGeneration` moves before its teardown
   * starts, and the episode checks that itself. */
  function reconnectExclusion(): ReconnectStop | null {
    if (slotLostRef.current || slotTeardown.owed()) return "refused";
    const status = subscriptionRef.current?.status;
    if (status !== undefined && status !== "ACTIVE") return "notEntitled";
    if (appModeRef.current === "gaming") return "excluded";
    return null;
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
      lastStatusRef.current = null;
      return "unknown";
    }

    lastStatusRef.current = status;
    statusMissesRef.current = 0;
    noteStatus(status);
    setSplitTunnelActive(Boolean(status.splitTunnelActive));
    setSplitTunnelProblem(readCustomModeProblem(status));
    setTunnelDnsUnprotected(status.tunnelDnsUnprotected ?? false);
    setRestartNeeded(status.splitTunnelRestartNeeded ?? []);
    setIpv6Blocked(Boolean(status.ipv6Blocked));
    setIpv4NotConfined(warnsUnconfined(status, Boolean(status.splitTunnelActive)));
    setConfinedAround(status.ipv4Confined === true);
    setUnconfinedKey(unconfinedLine(status));
    const observed = stateFromStatus(status);
    followTunnelForEndpoints(observed);
    return observed;
  }

  /** What every status read says beyond the tunnel's state: the reconnect
   * hold (lib/reconnect-hold.ts) and the tunnel's own counters
   * (lib/traffic-meter.ts). And a hold the service still reports over a
   * tunnel that landed under it, verified, with no pass of ours keeping it,
   * is let go of -- the gap it was for is over -- but never on one read,
   * nor on a read that contradicts it (`createStatusRelease`). */
  function noteStatus(status: VpnStatus): void {
    holdStore.observe(status.reconnectHold);
    if (status.connected) trafficMeter.observe(status.traffic);
    const release = statusReleaseRef.current.see({
      hold: holdStore.current(),
      status,
      passRunning: ladderInFlight(),
      now: Date.now(),
    });
    if (release) void holdService.release();
  }

  /** Tells the control plane's endpoint order what the service just said
   * about the tunnel (`tunnelServerFromService` in api-endpoints.ts): the
   * connected server's own mirrors stay last while it is up and reached
   * around, and the usual order comes back once it is down. From the
   * service's answer, never from this screen's state, whose first value
   * on every mount is its own "disconnected". */
  function followTunnelForEndpoints(observed: ConnectionState): void {
    const tunnelUp = isTunnelUp(observed) ? true : observed === "disconnected" ? false : null;
    const told = tunnelServerFromService(tunnelUp, ladderPass.inFlight(), ladderPass.tunnelServer.current);
    if (told !== undefined) setEndpointTunnelServer(told);
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
   *
   * `under`: the stamp, for a caller that took it before a wait of its own
   * (`syncNamingTunnel`), so a press made during that wait still makes the
   * answer old news.
   */
  async function syncFromService(under?: number): Promise<ConnectionState> {
    const generation = under ?? intentRef.current.generation;
    const settled = await readServiceState();
    publishObserved(generation, settled);
    // The clock is only honest while something is up.
    if (settled === "disconnected") setConnectedAt(null);
    else if (isTunnelUp(settled)) {
      // A tunnel this window did not bring up -- found up at launch -- is
      // timed from the age the service reports for its session, never from
      // when the window opened; nothing when it says nothing. A stamp this
      // window's own connect made stays.
      const since = lastStatusRef.current ? adoptedSince(lastStatusRef.current, Date.now()) : null;
      if (since !== null) setConnectedAt((own) => own ?? since);
    }
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
    // Allowed while a reconnect waits between attempts -- nothing is up
    // -- and it ends that reconnect: the next attempt would otherwise
    // bring a VPN tunnel up under a screen that says gaming mode.
    autoReconnect.cancel("customer");
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
  /** Holds credentials a refresh has just fetched: the list, and the one
   * on screen replaced by its new copy. */
  function adoptRefreshed(fresh: ProtocolUser[]) {
    setProtocolUsers(fresh);
    setProtocolUser((current) => fresh.find((u) => u.id === current?.id) ?? current);
  }

  // A refresh's answer that comes after its budget is the same answer,
  // late: held here whichever screen asked for it. Told only through the
  // refresh that asked, it reached a dashboard that had unmounted when
  // Settings opened, and this one kept the old values while the cache said
  // they were fresh. Setters only, so the first render's function serves.
  useEffect(() => onLateConfig(adoptRefreshed), []);

  useRefreshOnResume(async (trigger) => {
    const refreshed = await refreshConnectionConfig({
      held: protocolUsers,
      force: true,
      trigger,
      appState: connectionState,
    });
    if (refreshed.source !== "network") return;
    adoptRefreshed(refreshed.protocolUsers);
  });

  // Ticks for as long as the screen is mounted, for the days left, which
  // would otherwise freeze at whatever they were when the screen loaded.
  // Every half minute: the session timer keeps its own second-by-second
  // clock (`SessionTimer`), so the whole screen is not re-rendered every
  // second.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  /** Asks the service what is running and puts that on screen -- called
   * before the screen leaves its loading state, on both the online and
   * the offline path.
   *
   * The screen starts at "disconnected" on every mount, and a mount is
   * every return from Settings or Plans, not only a launch. The offline
   * path used to return before ever asking, and nothing revisits
   * "disconnected" -- no poll runs there and it is not a transient state
   * -- so a customer in Custom mode on a network that filters our API,
   * whose own app traffic goes direct by design, came back from Settings
   * to "You're not protected" and a Connect button over a tunnel carrying
   * their traffic, indefinitely; a press tore that tunnel down. The
   * online path showed the same for the length of one more request. If
   * the service does not answer, this is "unknown", which says so and
   * asks again on its own.
   *
   * A pass already under way owns the state and is left alone -- it
   * takes its own baseline besides, so null here leaves both alone. If
   * it is a pass this screen did not start (one started by a Dashboard
   * that unmounted when Settings opened; see `lib/ladder-pass`), the
   * screen adopts it: it says "Connecting...", a press means stop, and
   * when the pass ends the screen asks the service what it left.
   *
   * A tunnel found up is named as the route it is on, from the last dial
   * (`tunnelCredential`), among `users`, the credentials this load put on
   * screen -- or as no route, when that cannot be said. The screen's own
   * credential at this point is its load's, the pin, which the ladder may
   * have walked past: named as the tunnel's, it said the UK and Stealth
   * Web over a tunnel exiting in Singapore on Stealth, after Settings and
   * back, on the VM.
   */
  async function adoptServiceState(
    sub: Subscription | null,
    users: readonly ProtocolUser[],
  ): Promise<ConnectionState | null> {
    // Which credential the last dial was on, read first, so that nothing
    // below -- the check for a pass, the stamps, the service's answer -- is
    // taken before a wait: the state the service answers and the route it
    // is on then land on screen together. A pass begun while the service is
    // asked names its own candidate, and is left to (`passAtStart`).
    const passAtStart = ladderGenerationRef.current;
    const dial = await tunnelCredential.last();
    if (ladderInFlight()) {
      if (ladderGenerationRef.current !== ownPassRef.current && adoptedPassIntentRef.current === null) {
        const intent = beginIntent("connect");
        adoptedPassIntentRef.current = intent;
        publishObserved(intent, "connecting");
      }
      return null;
    }
    // A tunnel that ended while no screen was watching -- this one was
    // away in Settings, and both polls with it -- is a drop like any
    // other, if the app was vouching for it and nothing of ours has
    // ended or forgotten it since: said, and reconnected. Without this
    // the screen came back to a plain "You're not protected", and the
    // reconnect never began. Stamped and marked before asking, as every
    // drop check is.
    const vouched = vouching(autoReconnect.current(), sessionGeneration());
    // And what a tunnel found up quotes when it is armed below: a press, a
    // sign-out or the device limit landing while the service is asked
    // overrules the answer. See `autoReconnect.stamp`.
    const reconnectStamp = autoReconnect.stamp();
    const generation = intentRef.current.generation;
    const mark = statusDisturbances.mark();
    const adopted = await syncFromService();
    nameFoundTunnel(adopted, dial, passAtStart, users);
    if (
      adopted === "disconnected" &&
      droppedUnseen(vouched, intentRef.current.intent, lastStatusRef.current, statusDisturbances.since(mark))
    ) {
      publishDrop(generation);
      return adopted;
    }
    // A tunnel this window did not bring up still uses one of the plan's
    // devices. Nothing is known about its slot, so the first health poll
    // claims it -- or, if the dashboard has merely been away in
    // Settings, carries on with what was already known. Not one the
    // device limit is still taking down: that one is not being used, it
    // is being given up, and the recheck below goes on doing that.
    if (isTunnelUp(adopted) && !slotTeardown.owed()) {
      deviceSlot.adopt({ subscriptionId: sub?.id, deviceLimit: sub?.deviceLimit });
      // And it is one to reconnect if it drops: the service kept it up
      // while the window was closed, or this screen was away in
      // Settings. Its route is not known here -- the service reports the
      // protocol, not the credential -- so a reconnect of it walks the
      // ladder's ordinary order.
      autoReconnect.tunnelUp({ routeId: null, stamp: reconnectStamp });
    }
    return adopted;
  }

  /** Names the route of a tunnel a read of the service found up outside a
   * pass: the last dial's credential among `users`, when the service's
   * protocol agrees with it, and no route when that cannot be said
   * (`credentialOnTunnel`) -- never the credential the screen holds, which
   * after a load is the pin.
   *
   * Every read that can move the screen to a tunnel up from outside a
   * pass names it here: `adoptServiceState`, and `syncNamingTunnel` for the
   * rest. Named only in the first, the screen was still wrong by another
   * way: a load whose own read of the service failed or timed out went to
   * "unknown" over the pin, and the recheck of "unknown" eight seconds
   * later put "connected" under it -- the UK and Stealth Web over a
   * tunnel to Singapore, as before.
   *
   * `dial` and `passAtStart` are taken before the service is asked. A pass
   * begun since, or still under way, names its own candidate, and is left
   * to. */
  function nameFoundTunnel(
    found: ConnectionState,
    dial: TunnelDial | null,
    passAtStart: number,
    users: readonly ProtocolUser[],
  ): void {
    if (!isTunnelUp(found) || ladderGenerationRef.current !== passAtStart || ladderInFlight()) return;
    const on = credentialOnTunnel(dial, lastStatusRef.current?.protocol, users);
    if (on !== null) setProtocolUser(on);
    setTunnelRouteUnknown(on === null);
  }

  /** `syncFromService` for a read outside a pass that can find a tunnel up
   * -- the recheck of "unknown" and of a state past its deadline, a press
   * that buys an answer, a connect declined for a pass in the way -- with
   * what it finds named (`nameFoundTunnel`) against the credentials on
   * screen. Stamped before the dial is read, as `adoptServiceState` is, so
   * nothing is taken after a wait: a press during the read overrules the
   * answer, and a pass begun during it names its own. */
  async function syncNamingTunnel(): Promise<ConnectionState> {
    const generation = intentRef.current.generation;
    const passAtStart = ladderGenerationRef.current;
    const dial = await tunnelCredential.last();
    const settled = await syncFromService(generation);
    nameFoundTunnel(settled, dial, passAtStart, protocolUsersRef.current);
    return settled;
  }

  /** The IPv4 and IPv6 baselines, once the service has said nothing is
   * up.
   *
   * Only meaningful while nothing is up: taken through a live tunnel this
   * would record the exit address as the "before" value and every later
   * comparison would wrongly read as a leak. The same window, for the
   * same reason, and the same trap for IPv6: asked while a tunnel is up,
   * "can this machine reach public IPv6" is the question being tested
   * rather than the baseline for it.
   *
   * Bounded, and dropped if a connect began meanwhile. Unbounded, a walk
   * of a filtered endpoint list outlived a connect pressed during it,
   * finished through the new tunnel, and wrote the tunnel's own exit
   * address over the pass's baseline -- which reads every later check as
   * a leak.
   *
   * `users` are the credentials on screen, for their nodes' addresses:
   * see `settleAndCaptureBaseline`. */
  async function captureBaselinesWhileDown(users: readonly ProtocolUser[]): Promise<void> {
    const passAtStart = ladderGenerationRef.current;
    const baseline = await captureBaselineIp({
      deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS,
      nodeAddresses: nodeAddressesOf(users),
    });
    const hadIpv6 = await captureIpv6Baseline();
    if (ladderGenerationRef.current !== passAtStart || ladderInFlight()) return;
    baselineIpRef.current = baseline;
    ipv6BaselineRef.current = hadIpv6;
    setExitIp(null);
  }

  /** This network's route memory: which network this is, the route that
   * last carried traffic on it, and how each route and protocol has done.
   *
   * Best-effort, and deliberately not awaited by `loadAll`: a machine
   * whose gateway cannot be identified simply shares one memory bucket,
   * which is worse than per-network but not broken.
   *
   * An automatic reconnect's attempt does wait for it (the runner's
   * effect). The ladder orders by it, and a landing writes it back whole --
   * `rememberLastGood` and `recordAttempt` over what the screen holds,
   * then saved over what is stored. An attempt held while Settings was open
   * ran the moment the screen left loading, with the empty placeholders
   * still in its closure: it led with protocols this network had already
   * refused, and its landing replaced every network's remembered route and
   * history with its own single entry. */
  function loadRouteMemory(): void {
    void Promise.all([
      readNetworkId(),
      loadLastGood().then(setLastGood),
      loadConnectHistory().then(setHistory),
    ]).finally(() => setRouteMemoryLoaded(true));
  }

  /** Which network this is, asked again. `keepOnNull` is for a tunnel that
   * is up: with one owning the default route the fingerprint cannot be
   * read at all, and that is no reason to take the ladder's memory away
   * from a reconnect -- the id is asked again once the tunnel is down. */
  function readNetworkId(keepOnNull = false): Promise<void> {
    const askedAt = Date.now();
    return invoke<string | null>("network_fingerprint")
      .catch(() => null)
      .then((id) => {
        if (id === null && keepOnNull) return;
        setNetworkId(id);
        setNetFresh((fresh) => ({ ...fresh, idReadAt: Math.max(fresh.idReadAt, askedAt) }));
      });
  }

  /** The way out changed under the window, or went altogether: until the
   * network id and the route list are read again, the map does without
   * them (`lib/map-network.ts`). A different way out under a live tunnel
   * asks for the id at once; a lost one does not -- whichever network comes
   * back is asked about once the tunnel is down. */
  function noteRoam(reread: "now" | "tunnelUp" | "later") {
    const at = Date.now();
    setNetFresh((fresh) => ({ ...fresh, roamedAt: at }));
    if (reread !== "later") void readNetworkId(reread === "tunnelUp");
  }

  /** The server list's own answer, newer than anything this screen holds:
   * put on screen, as the list a later load whose route request fails
   * keeps (`standInRoutes`), and into the snapshot, so the next start with
   * Neoxify out of reach has it (`updateSnapshotRoutes`). Only for the
   * subscription on screen. */
  function adoptPickerRoutes(subscriptionId: string, list: RouteOption[]) {
    const sub = subscriptionRef.current;
    if (!sub || sub.id !== subscriptionId) return;
    setRoutes(list);
    routesShownRef.current = { plan: planOf(sub), load: loadSeqRef.current, routes: list, answered: true };
    const sessionAtStart = sessionGeneration();
    void updateSnapshotRoutes(sub, list, () => sessionGeneration() === sessionAtStart);
  }

  /** Which of a load's credentials the screen holds from here: the one on
   * `routeId` -- the pin, which Connect dials first -- or the first.
   *
   * Not chosen again over one the screen may be using: when it has been in
   * use on the cached snapshot while the load waited (`keepHeld`), or
   * shows a tunnel up, the credential it holds is replaced by its new copy,
   * by id, as a refresh's are. That may be the one the tunnel is on.
   *
   * And the pin is never taken for a tunnel's route: from here a tunnel
   * shown up is named by the read that finds it (`nameFoundTunnel`) or the
   * pass that lands it, and otherwise as no route at all
   * (`tunnelRouteUnknown`). The pin named so was the UK and Stealth Web
   * over a tunnel to Singapore, after Settings and back. */
  function showLoadedCredential(
    users: readonly ProtocolUser[],
    routeId: string | null | undefined,
    keepHeld: boolean,
  ): void {
    if (keepHeld || describesTunnel(connectionStateRef.current)) {
      setProtocolUser((current) => users.find((u) => u.id === current?.id) ?? current);
      return;
    }
    setProtocolUser(users.find((u) => u.routeId === routeId) ?? users[0] ?? null);
    setTunnelRouteUnknown(true);
  }

  /** Puts a cached snapshot on screen, for a load that has nothing fresher
   * to show: one that failed, or one still waiting past the point where it
   * used to give up (`loadAll`). `reason` is what the banner says
   * (`offlineText`). Run to the end even when the load answers while it
   * waits on the service: the load then leaves the service, the route
   * memory and the baselines to this, so each is done once. */
  async function showCached(
    cached: ConnectionSnapshot,
    preferRouteId: string | undefined,
    load: number,
    reason: OfflineReason,
  ): Promise<void> {
    setSubscription(cached.subscription);
    setProtocolUsers(cached.protocolUsers);
    setRoutes(cached.routes);
    routesShownRef.current = {
      plan: cached.subscription ? planOf(cached.subscription) : null,
      load,
      routes: cached.routes,
      answered: false,
    };
    setRouteListLoaded(true);
    const preferred = preferRouteId ?? chosenRouteId;
    showLoadedCredential(cached.protocolUsers, preferred, false);
    setOfflineSince(cached.savedAt);
    setOfflineReason(reason);
    setError(null);
    // The service, before the screen claims anything. This path is the one
    // that matters most: our API unreachable is the ordinary state of a
    // censored network, tunnel or no tunnel.
    const adopted = await adoptServiceState(cached.subscription, cached.protocolUsers);
    setLoading(false);
    shownOnceRef.current = true;
    loadRouteMemory();
    if (adopted === "disconnected") await captureBaselinesWhileDown(cached.protocolUsers);
  }

  /** One of the screen's own loads -- the mount's, a server switch's, the
   * error card's retry -- run through `offlineRetry`, so no background
   * load starts beside it, and a reason to ask again that comes while it
   * runs is asked about once it has failed. Says whether it got its
   * answer. */
  async function loadAll(preferRouteId?: string): Promise<boolean> {
    return (await offlineRetry.ownLoad(() => loadScreen(preferRouteId, null))) === "answered";
  }

  /** The load again, in the background, while the screen is on its cached
   * snapshot (`offlineRetry`). */
  function loadInBackground(why: OfflineRetryTrigger): Promise<OfflineLoadOutcome> {
    return loadScreen(undefined, why);
  }

  /** Loads the screen, and says what that came to: answered (the
   * credentials and the plan), unanswered, or, for a background load,
   * superseded by a load of the screen's own begun meanwhile.
   *
   * `retry` names what started a load made in the background while the
   * screen is on its cached snapshot and in use (`offlineRetry`), and is
   * null for the screen's own. A background load does not raise the
   * loading screen, and is treated throughout as a load the snapshot went
   * on screen in front of (`shownWhileWaiting`): the credential on screen,
   * perhaps the one a tunnel is up on, is replaced by its new copy rather
   * than chosen again, and the service, the route memory and the
   * baselines are left as they are. When nothing answers it, it is
   * reported as the mount's load is -- at most once in ten minutes
   * (unanswered-report.ts), so the retries add a row now and then, not one
   * each. */
  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {
    const background = retry !== null;
    // Which customer session this load is for. See sessionGeneration: a
    // sign-out bumps it before it clears anything.
    const sessionAtStart = sessionGeneration();
    // And its place among this screen's loads: a server switch starts one
    // while the mount's may still be waiting (`standInRoutes`).
    const load = ++loadSeqRef.current;
    // What Neoxify had answered when this began. See `answersHeardRef`.
    const answersAtStart = answersHeardRef.current;
    // When the credentials were asked for: a refresh's late answer asked
    // for before this is older than what this load puts on screen
    // (`noteCredentialsShown`).
    const askedAt = Date.now();
    if (!background) {
      setLoading(true);
      setError(null);
    }
    // Traced, so a load that nothing answered is reported with the
    // addresses it tried. See unanswered-report.ts. The state as it is
    // when the report is made, not as it was when the load began: the
    // screen may be in use on the cached snapshot by then.
    const requests = traceRequests("dashboard load", () => connectionStateRef.current);
    // Past the point where every address used to be given up on, with a
    // snapshot to show and nothing else on screen yet: the snapshot goes
    // on screen, and Connect with it, while this goes on waiting. On a
    // network where every address is blackholed the reads take eleven and
    // a half seconds to fail, and twenty-three where the filter lets the
    // handshake through and then stalls; the start sat on "Loading..." for
    // all of it, holding credentials that would have connected at eight.
    // Only before the screen has shown anything: a load after a server
    // switch holds a newer choice than the cache does. A background load
    // is one the snapshot is already in front of.
    let settled = false;
    let shownWhileWaiting = background;
    const waiting = shownOnceRef.current || background
      ? undefined
      : setTimeout(() => {
          void (async () => {
            const cached = await loadSnapshot();
            if (settled || !cached || loadSeqRef.current !== load || sessionGeneration() !== sessionAtStart) return;
            shownWhileWaiting = true;
            // "Still trying" only while nothing has answered: the account
            // may have, with the credentials still out.
            await showCached(
              cached,
              preferRouteId,
              load,
              reasonWhileWaiting(answersHeardRef.current !== answersAtStart),
            );
          })();
        }, STILL_TRYING_AFTER_MS);
    const [meResult, subsResult, usersResult] = await Promise.all([
      getMe(requests.trace("me")),
      getSubscriptions(requests.trace("subscriptions")),
      getProtocolUsers(requests.trace("protocol-users")),
    ]).finally(() => {
      settled = true;
      clearTimeout(waiting);
    });
    const unanswered = requests.settle({ me: meResult, subscriptions: subsResult, "protocol-users": usersResult });

    if (!meResult.ok || !subsResult.ok || !usersResult.ok) {
      const failed = [meResult, subsResult, usersResult].find((r) => !r.ok);
      if (failed && !failed.ok && failed.sessionExpired) {
        onLoggedOut();
        return "unanswered";
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
      // A load of the screen's own began while this one waited in the
      // background -- a server switch -- and what that one finds is the
      // screen's to show. Said here, it would put this older failure on
      // the banner over a newer answer, and start the retrying again on a
      // screen that load may already have taken off its snapshot.
      const superseded = background && loadSeqRef.current !== load;
      // Asked again on coming back to the main page, with the screen's own
      // last answer on it rather than the snapshot (`revalidate`).
      const keptAnswer = retry === "returned" && offlineSinceRef.current === null;
      unanswered?.(
        superseded
          ? `asked again in the background (${retry}); a load of the screen's own had begun meanwhile`
          : keptAnswer
            ? "asked again in the background on returning to the main page; still showing the screen's own last answer"
            : cached
              ? `${background ? `asked again in the background (${retry}); still ` : ""}showing the cached credentials, ${snapshotAge(cached.savedAt)}`
              : "showed the load error, with nothing cached to show",
      );
      if (superseded) return "superseded";
      // That answer stays on screen, under no banner: a load not answered
      // now says nothing about it, and the next return, or the next load,
      // asks again. Nothing is retried for it -- the screen is not on its
      // snapshot.
      if (keptAnswer) return "unanswered";
      // Said as what happened: nothing answered, or something answered
      // with an error (`offlineReason`) -- unless Neoxify has answered
      // something since this load began, which is the newer word on it.
      const reason = reasonAfterUnansweredLoad(
        failed && !failed.ok ? reasonFor(failed) : "unreached",
        answersHeardRef.current !== answersAtStart,
      );
      if (shownWhileWaiting) {
        // Already on screen, and perhaps in use: only the banner changes,
        // to what was heard last, and the load is made again later
        // (`offlineRetry`).
        setOfflineReason(reason);
        offlineRetry.start();
        return "unanswered";
      }
      if (cached) {
        await showCached(cached, preferRouteId, load, reason);
        offlineRetry.start();
        return "unanswered";
      }

      // Kept as it came and worded as the screen renders, so it is in the
      // language the app is in then (`ShownFailure`).
      setError(!meResult.ok ? meResult : !subsResult.ok ? subsResult : "loadFailed");
      setLoading(false);
      // Nothing here to dial with, but an attempt held for this screen
      // waits for the memory and the list too, and is ended by the runner
      // once it runs.
      setRouteListLoaded(true);
      loadRouteMemory();
      return "unanswered";
    }

    // A load of the screen's own began while this one waited in the
    // background -- a server switch -- and puts its own answer on screen,
    // with the choice it was made for.
    if (background && loadSeqRef.current !== load) return "superseded";

    // Reached the server, so anything remembered about being offline is
    // stale, and there is nothing more to ask again.
    setOfflineSince(null);
    offlineRetry.stop();

    setMe(meResult.data);
    const sub = usableSubscription(subsResult.data);
    setSubscription(sub);
    setProtocolUsers(usersResult.data);
    // From now on a refresh's late answer asked for before this load is
    // older than what is on screen, though the snapshot is written only
    // once the route list below has answered.
    noteCredentialsShown(askedAt);
    // Which credential the screen represents. It used to be whichever
    // the API happened to list first, so choosing a server from the list
    // changed nothing visible: the protocol tile kept naming the old one
    // and the tick in the picker stayed on the wrong row. It also made
    // that row unclickable, since the picker skips one already marked
    // current. Reported as "clicking a location doesn't show that the
    // change worked" -- and it hadn't, on screen; only the connect
    // itself honoured the choice.
    //
    // Not when the screen has been in use on the cached snapshot while
    // this waited, or shows a tunnel up: the credential it holds --
    // perhaps the one a tunnel is up on -- is replaced by its new copy, as
    // a refresh's are (`showLoadedCredential`).
    const chosen = preferRouteId ?? chosenRouteId;
    // Asked again on coming back to the main page: the credential held is
    // replaced by its new copy as long as the answer still lists it, or a
    // pass is dialling. One the answer no longer lists -- the plan changed
    // on the Plans page -- is chosen again, as a load of the screen's own
    // would, unless a tunnel is shown up on it (`showLoadedCredential`).
    const heldListed = usersResult.data.some((u) => u.id === protocolUserRef.current?.id);
    showLoadedCredential(
      usersResult.data,
      chosen,
      shownWhileWaiting && (retry !== "returned" || heldListed || ladderInFlight()),
    );
    // The tunnel outlives the app: the helper service keeps it up if the
    // window is closed, so on open the UI has to adopt whatever is
    // actually running rather than assuming disconnected -- and before
    // the screen is drawn, not after the route list below has answered.
    // Asked already, with the snapshot on screen, if that went first: the
    // screen has been watching the service since.
    const adopted = shownWhileWaiting ? null : await adoptServiceState(sub, usersResult.data);
    setLoading(false);
    shownOnceRef.current = true;
    if (!shownWhileWaiting) loadRouteMemory();

    // Purely to name the server the customer is actually on -- the
    // protocol-user row carries a routeId but no human-readable
    // location. Best-effort: a failure here costs a label, not the
    // screen, so it must never surface as an error.
    //
    // Not only a label, though: an automatic reconnect's pass reads it
    // throughout, and an attempt held for this screen waits for it
    // (`routeListLoaded`) -- answered or not, so a list that cannot be
    // had never holds an attempt for good.
    let currentRoutes: RouteOption[] = [];
    try {
      if (sub) {
        // The state as it is when a report is made, which the route list's
        // wait can outlast: a Disconnect pressed meanwhile breaks the
        // request, and its report must not say nothing was being dialled.
        const routeList = traceRequests("dashboard route list", () => connectionStateRef.current);
        // Which network the list's per-network tags will be about: the
        // reading the request carries, or without one the request's own
        // address, now (`lib/map-network.ts`).
        const tagsAt = currentNetwork()?.at ?? Date.now();
        const routesResult = await getAvailableRoutes(sub.id, routeList.trace("routes"));
        const routesUnanswered = routeList.settle({ routes: routesResult });
        if (routesResult.ok) {
          currentRoutes = routesResult.data;
          // Not over a list a later load has put there from an answer of
          // its own (`takesRouteList`).
          if (takesRouteList(routesShownRef.current, load)) {
            setRoutes(currentRoutes);
            routesShownRef.current = { plan: planOf(sub), load, routes: currentRoutes, answered: true };
            setNetFresh((fresh) => ({ ...fresh, tagsReadAt: Math.max(fresh.tagsReadAt, tagsAt) }));
          }
        } else {
          // Everything else answered and the list did not, so the list
          // this plan already has stands in for it -- on screen, and in the
          // snapshot below. Cached as an empty list, it left the next start
          // with Neoxify out of reach no servers to show; see
          // `cachedRoutesFor`. On screen it gives the picker rows to open
          // on, and a reconnect's pass the exits and egress it reads from
          // them. What goes on screen is `standInRoutes`'s to decide: not
          // over a later load's list, not over this plan's list already
          // there, and never another plan's left standing. What is written
          // is what the screen then holds for this plan (`routesForSnapshot`).
          const cachedRoutes = await cachedRoutesFor(sub);
          const shown = routesShownRef.current;
          const standIn = standInRoutes(cachedRoutes, shown, planOf(sub), load);
          currentRoutes = routesForSnapshot(standIn, shown, planOf(sub), cachedRoutes);
          if (standIn !== null) {
            setRoutes(standIn);
            routesShownRef.current = { plan: planOf(sub), load, routes: standIn, answered: false };
          }
          routesUnanswered?.(
            currentRoutes.length > 0
              ? `the rest of the load had answered; showing ${currentRoutes.length} servers already held for this plan`
              : "the rest of the load had answered; no servers held for this plan to show",
          );
        }
      }
    } finally {
      setRouteListLoaded(true);
    }

    // A sign-out landed while the route list was in flight -- the button
    // is drawn as soon as the screen leaves loading, before that request
    // returns. Everything below is for a session that has ended: the
    // snapshot above all, which would write the signed-out customer's
    // credentials back to disk after the sign-out cleared them.
    if (sessionGeneration() !== sessionAtStart) return "answered";

    // Written only once the credentials and the plan have answered, so a
    // partial answer can never overwrite a good cache with a worse one --
    // and with the route list this plan already had when only that request
    // failed, never an empty one in its place. Asked again at the moment of
    // writing, for a sign-out that lands in between. Not by a load after a
    // later one has written (`maySaveSnapshot`): this one's, landing after
    // it, would put the older answer back. A later load that fell back to
    // the cache writes nothing, and does not keep this one from writing.
    if (maySaveSnapshot(snapshotWriterRef.current, load)) {
      snapshotWriterRef.current = load;
      void saveSnapshot(
        {
          subscription: sub,
          protocolUsers: usersResult.data,
          routes: currentRoutes,
          askedAt,
        },
        () => sessionGeneration() === sessionAtStart,
      );
    }

    // Only when the service actually said so -- "unknown" is not a no,
    // and a baseline captured through a tunnel we simply could not ask
    // about turns every later comparison into a false leak report.
    if (adopted === "disconnected") await captureBaselinesWhileDown(usersResult.data);
    return "answered";
  }

  // Neoxify answered something while the screen says it cannot be reached
  // -- the claim before a connect, a queued report, a renewal through a
  // tunnel, the updater's check, the tunnel's health check. The banner
  // stops saying so at once, keeping only that what is on screen is the
  // saved copy, and -- for any but the health check, which is asked every
  // fifteen seconds while connected (`answerAsksAgain`) -- the load is made
  // again now rather than at the next step of the backoff. On the test VM
  // the banner said "Can't reach Neoxify right now" above "You're
  // protected" a minute after the claim and the reports had been answered;
  // with those heard, it still said so 43 seconds after the updater's
  // check, and a second after the tunnel's health check, neither of which
  // goes through api.ts (backend-answer.ts). Through the ref: registered
  // once, for the life of the screen.
  //
  // Counted whether or not the screen is on its snapshot, for a load that
  // fails after it (`answersHeardRef`). An answer to a read that comes
  // while a load is under way is most likely that load's own, and asks
  // nothing more: that load's outcome is the one that counts, and kept, a
  // load answered only in part would be made again the moment it failed.
  useEffect(
    () =>
      onBackendAnswer((answer) => {
        answersHeardRef.current += 1;
        if (offlineSinceRef.current === null) return;
        setOfflineReason((current) => reasonAfterAnswer(current, answer));
        if (answerAsksAgain(answer)) offlineRetry.trigger("answered", { ifLoading: answer.read ? "drop" : "keep" });
      }),
    [],
  );

  // Back on the main page from another page of the shell. This screen
  // stayed mounted under that page, its polls with it, so nothing it holds
  // went: the main page is drawn as it was -- verified, the route named,
  // the list loaded -- with no load in front of it. What it shows is asked
  // for again behind it (stale-while-revalidate): a plan bought or renewed
  // on Plans, credentials refreshed meanwhile. The service is not asked
  // here; the polls never stopped asking it. The VM showed what the old
  // way cost: "Loading..." over the whole window for a second and a half,
  // then "Connected, not confirmed", no route and no list for two to three
  // seconds more, over a tunnel that never changed.
  const onMainPageRef = useRef(onMainPage);
  useEffect(() => {
    const was = onMainPageRef.current;
    onMainPageRef.current = onMainPage;
    if (was || !onMainPage || loading) return;
    offlineRetry.revalidate();
    // On the return only; the retry is one per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMainPage]);

  // A tunnel verified: the path to Neoxify is a different one now, and on
  // a network that filters it, the likeliest one to be answered.
  useEffect(() => {
    if (connectionState === "connected") offlineRetry.trigger("tunnel");
  }, [connectionState]);

  // A pass this screen adopted rather than started (see
  // `adoptServiceState`) reports its outcome to the screen that started
  // it, which is gone. When it ends, this screen asks the service what it
  // left -- a verified tunnel, a failed pass's teardown -- and the polls
  // take over from there. Not after a press of its own since: a stop has
  // its own answer coming.
  useEffect(
    () =>
      ladderPass.onEnd(() => {
        const adopted = adoptedPassIntentRef.current;
        if (adopted === null) return;
        adoptedPassIntentRef.current = null;
        if (!isCurrent(intentRef.current, adopted)) return;
        endIntent(adopted);
        void adoptServiceState(subscriptionRef.current, protocolUsersRef.current);
      }),
    [],
  );

  // The pass an automatic reconnect runs, from whichever Dashboard is
  // mounted. Through a ref, so an attempt that falls due long after this
  // effect ran still dials with the credentials, routes and memory on
  // screen now rather than the ones from the first render.
  //
  // Each attempt is an ordinary ladder pass, `automatic` like the
  // mid-session failover's: the same order (led by the route that was
  // up), the same device-limit claim, and the same evidence before
  // anything is called connected. What is checked here first is only
  // what rules the attempt out altogether.
  //
  // Bound only once the screen has loaded, and again after every load.
  // The dashboard unmounts whenever Settings opens, so an attempt can fall
  // due with no screen bound; the episode holds it, unspent, and runs it
  // the moment one binds. Bound at mount, that was before `loadAll` had
  // answered: the first render's `runLadder` has no credential, so the
  // held attempt was declined at once and counted as failed -- an attempt
  // and its backoff spent without a dial, and on the last one "VPN
  // connection lost" with a row counting a dial that never happened.
  // `loading` ends once the credentials are in and the service's state is
  // on screen; what `loadAll` does after that stands aside for a pass
  // (`captureBaselinesWhileDown`) -- except the route memory, which the
  // pass orders by and writes back, and the route list, which it reads
  // for the extra exits and the split tunnel's egress, and both of which
  // are waited for too (`loadRouteMemory`, `routeListLoaded`). The pass
  // runs on the `runLadder` of the render it starts in, so whatever it
  // reads has to be on screen by then: arriving a moment later is too late.
  //
  // A screen that has loaded and still has nothing to dial with -- no
  // credential on the account, or no answer and nothing cached -- ends
  // the episode instead. Held, it would say "Reconnecting..." over a
  // screen that never will; declined, every attempt would be spent on
  // nothing. Ended as what it is (`nothingToDial`), an attempt that
  // dialled nothing: filed as `excluded` it read "ruled out at the moment
  // of the drop" -- after earlier attempts had dialled -- and counted
  // itself among the attempts made.
  const runLadderRef = useRef(runLadder);
  runLadderRef.current = runLadder;
  const protocolUserRef = useRef(protocolUser);
  protocolUserRef.current = protocolUser;
  /** The credentials on screen, for an adopted pass's end, which is heard
   * by a listener registered once (`adoptServiceState`). */
  const protocolUsersRef = useRef(protocolUsers);
  protocolUsersRef.current = protocolUsers;
  useEffect(() => {
    if (loading || !routeMemoryLoaded || !routeListLoaded) return;
    return autoReconnect.bind(async (attempt) => {
      const excluded = reconnectExclusion();
      if (excluded !== null) return { kind: "stop", why: excluded };
      if (protocolUserRef.current === null) return { kind: "stop", why: "nothingToDial" };
      passResultRef.current = { routeId: null, errorKind: null };
      // The last attempt's error line is put away as this one's pass begins
      // (`runLadder`, for every automatic pass): between attempts it is
      // back, with nothing dialling, and the repair ends the episode before
      // it starts.
      const outcome = await runLadderRef.current({ automatic: true, reconnect: attempt });
      return reconnectOutcomeOf(outcome, passResultRef.current);
    });
  }, [loading, routeMemoryLoaded, routeListLoaded]);

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

    // One measurement: what the poll found, and whether it calls for the
    // automatic ladder. The ladder itself runs outside the single-flight
    // below, which only covers the measuring.
    const measure = async (): Promise<boolean> => {
      // A ladder already running will decide the state itself; polling
      // underneath it would fight over the same fields. Nor during a
      // repair: what it reads then is the repair at work -- the service's
      // fallback while the repair holds its thread, egress through
      // adapters being removed -- and its strikes started the failover
      // into the middle of the repair (`duringRepair`).
      if (ladderInFlight() || repairUnderWay()) return false;
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
      // And which way out it measures over: one that changes meanwhile is
      // re-verified by the watch (`uplink-watch.ts`), and this reading,
      // about the way out that was, must not land over it or count.
      const uplinkEpoch = uplinkEpochRef.current;
      // And marked, so an answer one of our own Custom-mode changes or
      // probes may have caught can be told apart afterwards. See
      // `status-disturbance`.
      const mark = statusDisturbances.mark();

      // Failing to ask is not the same as learning the tunnel is down,
      // so the last known state stands and no strike is counted.
      //
      // It does not stand indefinitely, though. The last answer was an
      // observation when it arrived; a minute of silence later it is
      // only a memory, and leaving "You're protected" on screen on the
      // strength of a memory is the same claim-without-evidence this
      // screen exists to refuse. Several misses in a row means the
      // honest answer has become "we don't know".
      const miss = () => {
        statusMissesRef.current += 1;
        if (statusMissesRef.current >= STATUS_MISSES_BEFORE_UNKNOWN) {
          if (publishObserved(generation, "unknown")) strikesRef.current = 0;
        }
      };

      let status: VpnStatus;
      try {
        status = await serviceStatus();
      } catch {
        miss();
        return false;
      }

      // A "no tunnel" the service could not verify -- its fallback's
      // guess while the owning thread was busy -- or one our own
      // Custom-mode change or probe may have caused, is not an
      // observation either. It is counted as a miss, not shown: shown,
      // it put "You're not protected" over a tunnel a Custom-mode rebuild
      // was a second from bringing back -- and once the screen shows no
      // tunnel, neither poll runs, so it stood until the app next
      // reloaded its state.
      const disturbed = statusDisturbances.since(mark);
      if (!status.connected && (disturbed || !noTunnelVerified(status))) {
        miss();
        return false;
      }
      statusMissesRef.current = 0;
      noteStatus(status);

      // The plan's device limit, renewed on this poll every
      // `renewEverySec` (four polls at the contract's sixty seconds);
      // `onPoll` answers at once when nothing is due. Before the tunnel
      // checks, because if another device has the slot there is nothing
      // left to check: this device stops, says why, and does not run
      // the ladder. Not gated on `generation` -- a takeover is news
      // whatever the customer pressed meanwhile.
      const slotEvent = await deviceSlot.onPoll();
      if (slotEvent.kind !== "keep") {
        await endForSlot(slotEvent);
        return false;
      }

      // Read from the status this check just took, not from the
      // `splitTunnelActive` this effect closed over. On the first check
      // after a connect that captured value is still the `false` from
      // before the tunnel existed -- the setter below changes the next
      // render, not this closure -- so Custom mode was judged by the
      // full-tunnel egress check, saw this app's own (correctly direct)
      // address, and showed "Not carrying traffic" over a tunnel that
      // was carrying the selected apps. Measured on a Windows 11 guest:
      // curl.exe selected and exiting through the node, the screen
      // yellow for one poll.
      const customMode = Boolean(status.splitTunnelActive);
      setSplitTunnelActive(customMode);
      setSplitTunnelProblem(readCustomModeProblem(status));
      setTunnelDnsUnprotected(status.tunnelDnsUnprotected ?? false);
      setRestartNeeded(status.splitTunnelRestartNeeded ?? []);
      setIpv6Blocked(Boolean(status.ipv6Blocked));
      setIpv4NotConfined(warnsUnconfined(status, Boolean(status.splitTunnelActive)));
      setConfinedAround(status.ipv4Confined === true);
      setUnconfinedKey(unconfinedLine(status));
      const fromStatus = stateFromStatus(status);

      if (fromStatus === "disconnected") {
        sessionTrackerRef.current.broken();
        // Usually the one-second liveness poll below gets here first.
        // This is the same conclusion from the slower instrument, so it
        // goes through the same rule and is worded the same way.
        if (droppedFromPoll(connectionState, intentRef.current.intent, status, disturbed)) {
          publishDrop(generation);
          return false;
        }
        if (publishObserved(generation, "disconnected") === null) return false;
        // The tunnel went on its own, and nothing renews a slot without
        // one. Given back, rather than left to turn the customer's other
        // device away as "in use" for the ninety seconds it takes to go
        // stale.
        void deviceSlot.release();
        setConnectedAt(null);
        strikesRef.current = 0;
        return false;
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
      if (customMode) {
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
        //
        // Marked while it runs: it holds the service's owning thread, and
        // a liveness status asked meanwhile is answered by the fallback.
        const probed = statusDisturbances.begin(PROBE_CAP_MS);
        const carried = await invoke("vpn_probe_split_tunnel")
          .then(() => true)
          .catch(() => false)
          .finally(probed);
        verdict = customModePollState(fromStatus, carried);
      } else {
        // A ceiling on the whole walk: through a tunnel that black-holes
        // everything, every endpoint times out, and at six seconds each
        // the first strike used to land a minute after the tunnel died.
        //
        // And never an answer from the connected server's own mirror
        // where that is reached around the tunnel: with the baseline from
        // it, the home address came back unchanged and a working tunnel
        // read "NOT protected", struck, and was in time torn down. See
        // `TunnelServer` in egress.ts.
        //
        // The baseline's endpoint first, then the rest of the list. In
        // list order, a baseline from a mirror -- what answers on a
        // network that filters the panel hosts -- was never compared:
        // through the tunnel the panel host answers first, and every
        // poll of a working tunnel said "Connected, not confirmed".
        const tunnelServer = ladderPass.tunnelServer.current ?? undefined;
        const egress = await verifyEgress(baselineIpRef.current, {
          totalMs: HEALTH_EGRESS_TOTAL_MS,
          tunnelServer,
          baselineFirst: true,
        });
        if (!isCurrent(intentRef.current, generation)) return false;
        if (egress.state === "throughTunnel") setExitIp(egress.exitIp);
        verdict = fullTunnelPollState(fromStatus, egress);
      }

      // Overtaken while it measured -- by a press, or by the liveness
      // poll finding the tunnel gone (`publishDrop`). Either way what
      // follows is about a tunnel the screen no longer describes, and a
      // reading taken through a tunnel that has since ended must not
      // count towards the per-ISP tags.
      if (!isCurrent(intentRef.current, generation)) return false;
      // Or by a change of the way out, which the watch re-verified on its
      // own: this reading straddles it, and is neither shown nor a strike.
      if (uplinkEpochRef.current !== uplinkEpoch) return false;

      // "It kept working", for the per-ISP tags: a proven check advances
      // the session clock, a failed one restarts it. `unverified` does
      // neither -- an abstention is not evidence either way, the same
      // reasoning as the strike count below.
      if (verdict === "connected") sessionTrackerRef.current.healthy(settledRouteRef.current);
      else if (verdict !== "unverified") sessionTrackerRef.current.broken();

      if (verdict === "connected" || verdict === "unverified") {
        // `unverified` resets the strike count with the same authority
        // `connected` does, and deliberately. A strike is evidence that
        // this tunnel has stopped working, and an abstention is not
        // evidence of anything -- letting abstentions accumulate into a
        // teardown would hand every Xray session in Custom mode to the
        // failover ladder on a timer.
        if (publishObserved(generation, verdict) !== null) strikesRef.current = 0;
        return false;
      }

      // Dropped rather than counted when it has been overtaken: a strike
      // is evidence about the tunnel the customer is on, and this
      // verdict is about one they have already asked to leave.
      if (publishObserved(generation, verdict) === null) return false;
      strikesRef.current += 1;

      // Below the threshold, or too soon after a full pass already
      // failed, this only reports -- it does not act.
      if (strikesRef.current < MID_SESSION_STRIKES) return false;
      if (Date.now() < cooldownUntilRef.current) return false;
      // Never after the device limit ended this session. See slotLostRef.
      if (slotLostRef.current) return false;

      // A tunnel that is up and carrying nothing is the case a customer
      // cannot fix themselves and should not have to: the old behaviour
      // was to sit yellow advising them to reconnect by hand, which on a
      // network that has just started filtering is the least useful
      // moment to ask anything of them.
      strikesRef.current = 0;
      cooldownUntilRef.current = Date.now() + MID_SESSION_COOLDOWN_MS;
      return true;
    };

    // Single-flight, like the liveness poll. A measurement through a dead
    // tunnel waits out every endpoint's timeout, and the interval kept
    // starting new ones on top of it every fifteen seconds -- each
    // holding requests on a link that was already not answering.
    //
    // Shared across runs of this effect, deliberately: two measurements
    // at once could count two strikes off one failure. But a run's own
    // first check (`catchUp`) is not simply dropped when one from before
    // the state changed is still going -- it used to be, and then nothing
    // measured the new state until the interval came round, up to
    // fifteen seconds later. It runs as soon as that one finishes, unless
    // that one handed the tunnel to the ladder, or this run has ended.
    let live = true;
    const check = async ({ catchUp = false } = {}) => {
      if (!live) return;
      if (healthCheckInFlightRef.current) {
        if (catchUp) healthCheckWantedRef.current = () => check();
        return;
      }
      healthCheckInFlightRef.current = true;
      let failover = false;
      try {
        failover = await measure();
      } finally {
        healthCheckInFlightRef.current = false;
      }
      const wanted = healthCheckWantedRef.current;
      healthCheckWantedRef.current = null;
      if (failover) await runLadder({ automatic: true });
      else if (wanted) void wanted();
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
    if (Date.now() - lastCheckAtRef.current >= MIN_CHECK_GAP_MS) void check({ catchUp: true });
    const id = setInterval(() => void check(), HEALTH_POLL_MS);

    return () => {
      live = false;
      clearInterval(id);
      // Any change of state ends the stretch of continuous health being
      // timed -- a disconnect, a reconnect onto the same route, or a dip
      // to degraded. Without this a reconnect to the same server would
      // inherit the previous session's clock.
      sessionTrackerRef.current.broken();
    };
    // Not `splitTunnelActive`: the poll picks its evidence from the
    // status each check reads, because a value captured here is stale on
    // exactly the check that matters -- the first one after a connect.
  }, [connectionState]);

  // Is the tunnel still there -- asked every second, and nothing else.
  //
  // The poll above proves traffic flows, and it is right that it runs
  // only every fifteen seconds: it fetches through the tunnel, on links
  // that are often slow and censored. But its verdict then stood on
  // screen until the next one, and that is how, measured on 2026-10-06,
  // "You're protected" outlived a killed engine by 17.0 seconds while
  // every packet went out direct. Custom mode: 8.1s.
  //
  // So the cheap half of the question is asked on its own, often. One
  // status call: the service answers from the engine's own process
  // handle, the tunnel service's state or RAS, and since the service
  // now tears a dead session down the moment the kernel reports it, the
  // answer is already "nothing is running" by the time this asks. It
  // never promotes anything -- a live answer changes nothing here -- and
  // nothing but the service's verified "no tunnel" is a drop: not a
  // failed call, and not the fallback's guess (`droppedFromPoll`).
  //
  // Stays out of the way of the things that own the tunnel or the
  // service's attention: a ladder pass, a press in flight, a Custom-mode
  // change and the Custom-mode probe. Not only by not starting while one
  // runs: the probe is started by the health poll after its own status
  // returns, so one can begin while this look is already waiting on the
  // service -- and the answer is then discarded, by the mark taken here.
  //
  // A page timer, so it stops when the page's timers do -- seen on the VM
  // (2026-10-19, 0.9.51 and the redesign alike): 5 to 21 s at a time,
  // every two or three minutes, idle and connected, this poll and the
  // health poll with it, while the page stayed visible and focused. No
  // visibilitychange, no freeze, no long task, the same with every CSS
  // animation off, and a separate process on the guest ran on throughout.
  // So not Chromium's background, occlusion or freezing throttling, each
  // of which hides or freezes the page first; what is left is the
  // renderer not running at all, most likely on the VM's software-drawn
  // display (VBoxSVGA, 3D off, the DevTools port open). Not seen on real
  // hardware, and unverified there. It stays here anyway: what it changes
  // is this page, so a poll driven from Rust would wait on the same
  // renderer, and Tauri cannot turn throttling off on Windows (wry:
  // unsupported). What keeps traffic in the tunnel -- the confinement, the
  // IPv6 block, the DNS rule -- is the service's own and needs no page. A
  // stall delays what the screen says, a dead tunnel's "You're protected"
  // included, and the reconnect, by its length; the first look after it
  // catches up.
  useEffect(() => {
    if (!isTunnelUp(connectionState)) return;

    const look = async () => {
      if (livenessInFlightRef.current || ladderInFlight()) return;
      if (intentRef.current.intent !== "idle") return;
      if (statusDisturbances.busy()) return;
      livenessInFlightRef.current = true;
      // Stamped before asking, like every other writer here: a press
      // landing while this waits makes the answer old news.
      const generation = intentRef.current.generation;
      const mark = statusDisturbances.mark();
      try {
        const status = await serviceStatus().catch(() => null);
        const disturbed = statusDisturbances.since(mark);
        // Every read's word on the hold, the drop's own included: the read
        // that finds the tunnel gone is the one that says whether the
        // service is holding the internet for it. Left unread, the screen
        // went on with the "armed" from before the drop and said traffic
        // was going out without Neoxify while the service held it (the
        // VM, 0.25 to 0.5 s at every reconnect's start).
        if (status !== null) noteStatus(status);
        if (!droppedFromPoll(connectionState, intentRef.current.intent, status, disturbed)) return;
        publishDrop(generation);
      } finally {
        livenessInFlightRef.current = false;
      }
    };

    const id = setInterval(() => void look(), LIVENESS_POLL_MS);
    return () => clearInterval(id);
  }, [connectionState]);

  // Is the way out the tunnel was proven over still there -- asked every
  // second, of the machine's own tables (`lib/uplink-watch.ts`).
  //
  // The liveness poll above cannot tell: the engine of a tunnel whose link
  // has gone is still running, and the service says what it always says.
  // The health poll can, but every fifteen seconds and then after its own
  // walk, and that is how "You're protected" stood 20 s over a dropped link
  // and 26 s after a roam on the VM. So a change of the way out is noticed
  // here within a second and the tunnel re-verified at once: what that
  // proves is shown -- nothing changes on screen for a change it survives --
  // and a tunnel that cannot carry is handed to the reconnect
  // (`publishCarrierLost`), never left saying "protected".
  //
  // Stays out of the way of what owns the tunnel or the service's
  // attention, as the liveness poll does; a look it skips is taken on the
  // next second, the change still there to find.
  useEffect(() => {
    if (!isTunnelUp(connectionState)) {
      uplinkRef.current = NEW_UPLINK_WATCH;
      return;
    }

    const look = async () => {
      if (uplinkInFlightRef.current) return;
      if (ladderInFlight() || repairUnderWay()) return;
      if (intentRef.current.intent !== "idle") return;
      if (statusDisturbances.busy()) return;
      // Gaming mode has no tunnel of this screen's to re-verify or hand on.
      if (appModeRef.current === "gaming") return;
      uplinkInFlightRef.current = true;
      try {
        const seen = await invoke<string | null>("network_uplinks").catch(() => null);
        noteWayOut(seen);
        const before = uplinkRef.current.seen;
        const [next, step] = nextUplink(uplinkRef.current, seen);
        uplinkRef.current = next;
        if (step === "same") return;
        // For the map: another network's evidence is not this one's.
        const moved = tunnelWayOut(before, step, next.seen);
        if (moved !== null) noteRoam(moved === "moved" ? "tunnelUp" : "later");
        // Stamped as every writer here is: a press landing meanwhile
        // makes what follows old news.
        const generation = intentRef.current.generation;
        uplinkEpochRef.current += 1;
        if (step === "lost") {
          publishCarrierLost(generation);
          return;
        }
        const verdict = await recheckAfterUplinkChange();
        if (!isCurrent(intentRef.current, generation)) return;
        const action = afterUplinkRecheck(verdict);
        if (action === "lost") {
          publishCarrierLost(generation);
        } else if (action === "show" && verdict !== "timedOut") {
          // Proof restores "protected", and an abstention says so; either
          // way the strike count starts again, as the health poll's does.
          if (publishObserved(generation, verdict) !== null) strikesRef.current = 0;
        }
      } finally {
        uplinkInFlightRef.current = false;
      }
    };

    const id = setInterval(() => void look(), UPLINK_POLL_MS);
    return () => clearInterval(id);
  }, [connectionState]);

  // The same question while nothing is up, slower, for the map alone: a
  // roam with the window open and disconnected is noticed, and the network
  // asked about again (`lib/map-network.ts`). Only while "disconnected":
  // a connect installs routes of its own, which would read as a roam. And a
  // roam seen under a tunnel is asked about here, once it is down.
  useEffect(() => {
    if (connectionState !== "disconnected") return;
    if (netFresh.roamedAt !== null && netFresh.idReadAt < netFresh.roamedAt) void readNetworkId();
    let seen: string | null = null;
    let asking = false;
    const look = async () => {
      if (asking) return;
      asking = true;
      try {
        const now = await invoke<string | null>("network_uplinks").catch(() => null);
        noteWayOut(now);
        const step = idleWayOut(seen, now);
        seen = step.next;
        if (step.roamed) noteRoam("now");
      } finally {
        asking = false;
      }
    };
    void look();
    const id = setInterval(() => void look(), IDLE_WAY_OUT_POLL_MS);
    return () => clearInterval(id);
    // The roam check reads the freshness as it was when the state settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState]);

  // The speeds belong to the session they were read in: none while no
  // tunnel is up, and the next one starts from nothing.
  useEffect(() => {
    if (!isTunnelUp(connectionState)) trafficMeter.reset();
  }, [connectionState]);

  // While an automatic reconnect runs, or after a drop nothing reconnects,
  // nothing else asks the service, so its word on the reconnect hold is
  // asked here -- at once, then every two seconds -- for the line and the
  // notification that say the internet is blocked, or why it is not
  // (`gapTraffic`): until it answers they say neither. Only with the
  // setting on: off, there is nothing to say.
  const gapDropped = tunnelDropped || reconnectLost(reconnect, sessionGeneration());
  const inHoldGap = reconnectRunning || gapDropped;
  useEffect(() => {
    if (!inHoldGap || !holdWanted(prefs.blockWhileReconnecting)) return;
    let asking = false;
    const look = () => {
      if (asking) return;
      asking = true;
      serviceStatus()
        .then((status) => holdStore.observe(status.reconnectHold), () => undefined)
        .finally(() => {
          asking = false;
        });
    };
    look();
    const id = setInterval(look, 2_000);
    return () => clearInterval(id);
  }, [inHoldGap, prefs.blockWhileReconnecting]);

  // "Connect when Neoxify starts" (lib/auto-connect.ts): once per run, at
  // the first main page of a run that opened signed in, and only over
  // nothing the service has up -- the customer's own Connect, pressed for
  // them, which never takes the device slot from another device. Waits for
  // what a pass reads (the route memory and the list, as the reconnect's
  // attempt does), for the preference itself and for the mode the app was
  // left in: a default is never acted on.
  const connectNowRef = useRef(connectNow);
  connectNowRef.current = connectNow;
  useEffect(() => {
    if (loading || !routeMemoryLoaded || !routeListLoaded || !autoConnectLatch.armed()) return;
    let alive = true;
    void Promise.all([appPrefs.load(), loadGaming()]).then(([loadedPrefs, gamingSaved]) => {
      if (!alive || !autoConnectLatch.take()) return;
      const decision = autoConnectDecision({
        enabled: loadedPrefs.autoConnect,
        mode: gamingSaved.mode,
        state: connectionStateRef.current,
        passRunning: ladderInFlight(),
        reconnecting: reconnectingView(autoReconnect.current(), sessionGeneration()) !== null,
        hasCredential: protocolUserRef.current !== null,
        subscriptionStatus: subscriptionRef.current?.status,
        deviceLimitNotice: slotNoticeStore.current() !== null || slotLostRef.current,
      });
      if (!decision.go) return;
      setAutoConnecting(true);
      void connectNowRef.current().finally(() => setAutoConnecting(false));
    });
    return () => {
      alive = false;
    };
    // Once the screen has what a pass reads; the latch keeps it to once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, routeMemoryLoaded, routeListLoaded]);

  // "Notify me when the connection changes" (lib/connection-notify.ts):
  // read off the calm tone the screen wears, which holds through a short
  // gap, so a few seconds' gap is never a notification -- as it is never a
  // colour. Words in the app's language; nothing while the window is in
  // front, where the screen says it.
  const notifyTone: ShownTone =
    appMode === "gaming"
      ? "idle"
      : shownTone(orbTone(orbState, cautionShown), {
          reconnecting: reconnectRunning,
          dropped: gapDropped,
        });
  /** Where other traffic goes in the gap, as the service has said: the
   * same source the sentence under the state reads (`holdHint`). */
  const gap = gapTraffic(hold, holdWanted(prefs.blockWhileReconnecting));
  // The service's word, given HOLD_WORD_GRACE_MS in the gap before it is said
  // not to have come: it answers within about half a second, and "checking"
  // then "blocked" was a sentence changing twice at every short reconnect.
  // The hint's room stays empty meanwhile, and no notification goes.
  const holdWordAwaited = (inHoldGap || waitingForNetwork) && gap === "unconfirmed";
  const [holdWordLate, setHoldWordLate] = useState(false);
  useEffect(() => {
    setHoldWordLate(false);
    if (!holdWordAwaited) return;
    const id = setTimeout(() => setHoldWordLate(true), HOLD_WORD_GRACE_MS);
    return () => clearTimeout(id);
  }, [holdWordAwaited]);
  const gapSaid = gapWord(gap, holdWordLate);
  useEffect(() => {
    if (loading) return;
    const step = notifyStep(notifyMemory.current(), {
      tone: notifyTone,
      reconnecting: reconnectRunning,
      gap: gapSaid,
      // In front, and on the main page: another page of the shell does not
      // say the connection's state, so it is said as for a window behind.
      focused: typeof document !== "undefined" && document.hasFocus() && onMainPage,
      gaming: appMode === "gaming",
    });
    notifyMemory.set(step.memory);
    if (step.say === null || !appPrefs.current().notifications) return;
    const text = NOTIFY_TEXT[step.say];
    void showNotification(t(text.title), t(text.body), language).catch(() => undefined);
    // On a change of what is said, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, notifyTone, reconnectRunning, appMode, gapSaid]);

  // The session log (lib/session-log.ts), only when the customer has
  // turned it on: a record opens when the screen first shows a tunnel up
  // and closes when it shows it gone -- lost, or ended -- with what the
  // tunnel's adapter counted, if it counted -- every session of it, a
  // reconnect onto the same route included (`createRecordBytes`). A tunnel
  // the failover moved to another route is a new record: the old one
  // stopped carrying.
  const loggedBytesRef = useRef(createRecordBytes());
  useEffect(
    () =>
      trafficMeter.subscribe(() => {
        const view = trafficMeter.view();
        loggedBytesRef.current.see(trafficMeter.generation(), view ? { rx: view.rxBytes, tx: view.txBytes } : null);
      }),
    [],
  );
  useEffect(() => {
    if (loading) return;
    const up = connectionState === "connected" || connectionState === "unverified" || connectionState === "degraded";
    // The credential the tunnel is on, or none when the screen cannot name
    // it -- never the pin a load put on screen (`loggedCredential`).
    const user = loggedCredential(protocolUserRef.current, tunnelNamedRef.current);
    const open = sessionLog.openRecord();
    const close = (ended: "disconnected" | "lost", bytes: { rx: number; tx: number } | null) => {
      void sessionLog.finish({ end: Date.now(), rxBytes: bytes?.rx ?? null, txBytes: bytes?.tx ?? null, ended });
    };
    if (up && appModeRef.current !== "gaming") {
      const moved = movedRoute(open, user);
      if (moved) close("lost", loggedBytesRef.current.split());
      else if (open === null) loggedBytesRef.current.restart();
      if (open === null || moved) {
        void sessionLog.begin({
          start: connectedAt ?? Date.now(),
          routeId: user?.routeId ?? null,
          protocol: user?.protocol ?? null,
          transport: user?.connection?.transport,
        });
      }
    } else if (connectionState === "disconnected" && open !== null) {
      close(tunnelDropped ? "lost" : "disconnected", loggedBytesRef.current.total());
      loggedBytesRef.current.restart();
    }
    // On a change of what the screen shows; the credential is read as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, connectionState, tunnelDropped]);

  // "Connection lost" describes the moment a tunnel went, and only for as
  // long as nothing has happened since. Any other state -- a connect
  // starting, a tunnel adopted, a teardown -- retires it.
  useEffect(() => {
    if (connectionState !== "disconnected") setTunnelDropped(false);
  }, [connectionState]);

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
      // A teardown the device limit still owes is this recheck's to try
      // again, rather than only to look at: the tunnel it found up last
      // time is one this device was told to give up. One attempt at a
      // time (`retry` joins one still running), each bounded by the
      // teardown's own deadline, every recheck until the service says
      // the tunnel is down -- and the card waiting on that shows then.
      if (slotTeardown.owed()) {
        void slotTeardown.retry(tearDownForSlotOnce);
        return;
      }
      // Past its deadline, it owns nothing -- and the intent it declared
      // has to go with it. Leaving that standing would be a new way to
      // wedge the screen rather than a fix for the old one: `phaseFor`
      // would keep rewording every "disconnected" this recheck fetched
      // back into "Connecting..." on behalf of a pass that is never
      // going to report, which is the exact stuck spinner this recheck
      // exists to end.
      endIntent(intentRef.current.generation);
      // "Nothing is running", found this way, is not a drop by the rule
      // the polls use -- the screen was saying it could not tell, or was
      // mid-operation -- so a tunnel the reconnect was armed for is
      // forgotten rather than left for the next screen to mount to call
      // a drop it missed. A tunnel it finds up is named as the route it is
      // on, or as none (`syncNamingTunnel`): from "unknown" after a load
      // whose own read failed, the screen held the pin.
      void syncNamingTunnel().then((settled) => {
        if (settled === "disconnected") autoReconnect.forget();
      });
    }, recheckMs);

    return () => clearInterval(id);
  }, [connectionState]);

  /** Stops a ladder pass in flight and takes down whatever it left.
   *
   * The ladder checks `cancelRef` between steps and unwinds itself; the
   * teardown below is what actually makes the machine usable again. Then
   * the service is asked, because a cancelled pass is exactly the case
   * where what the app was about to claim and what is actually installed
   * have most reason to differ.
   *
   * The intent flips to "disconnect" first, which does three things at
   * once: it stamps out every answer the abandoned pass is still owed, it
   * lets this teardown be shown as a teardown (the customer did ask for
   * this one), and it means the *next* press reads the settled state
   * rather than finding a pass still nominally in flight. Needing three
   * or four presses was that last one. */
  async function stopPass() {
    const generation = beginIntent("disconnect");
    cancelRef.current = true;
    // The pass may already hold a slot. Given back fire and forget,
    // never in front of the teardown (docs/device-slots.md, 8) -- and
    // again once it is over, if the teardown took the first one with it
    // and the service says the tunnel is gone.
    const teardown = teardownSignal();
    void deviceSlot.release({ tunnelGone: teardown.over });
    setSlotNotice(null);
    setConnectionState("disconnecting");
    let gone = false;
    try {
      await serviceDisconnect().catch(() => undefined);
      gone = (await confirmTornDown()) === "disconnected";
    } finally {
      teardown.done(gone);
    }
    endIntent(generation);
  }

  /** "Stop reconnecting": the customer has seen the tunnel go and does
   * not want it back by itself. The headline then says what is true --
   * the connection was lost -- with Connect to bring it back by hand. A
   * pass already dialling is stopped the way a press of the orb stops
   * one; between attempts nothing is up, and the slot the dead tunnel
   * held is given back. */
  async function stopReconnecting() {
    const dialling = autoReconnect.current().kind === "attempting";
    autoReconnect.cancel("stopped");
    if (dialling) {
      await stopPass();
      return;
    }
    void deviceSlot.release();
  }

  /** A location, or Automatic, chosen from the server list -- which opens
   * only while nothing is up, but stays open while a reconnect moves on
   * beneath it. Between attempts that ends the episode; during one it
   * ends it and stops the pass, as "Stop reconnecting" does; over a tunnel
   * the app vouches for, and the screen shows, it changes nothing about
   * that tunnel. Armed beneath a screen that shows nothing up, it takes
   * over as any press does. See `autoReconnect.chose`.
   *
   * Returns the route the screen goes on naming: the tunnel's, while one
   * stays up, and otherwise the choice. Read through the refs: the list
   * reports a server only once the switch request has answered, and the
   * render it was pressed in can predate the pass that landed meanwhile. */
  function chooseLocation(routeId: string | null): string | null {
    const choice = autoReconnect.chose({ tunnelShown: connectionStateRef.current !== "disconnected" });
    if (choice === "stopPass") void stopPass();
    return choice === "keepTunnel" ? (protocolUserRef.current?.routeId ?? routeId) : routeId;
  }

  /** A server, or Automatic, picked in the list -- heard as it is picked,
   * before a server's switch request answers (`chooseLocation` waits for
   * that). A reconnect between attempts ends here, and one dialling has
   * its pass stopped, as "Stop reconnecting" does: heard only with the
   * answer, which on a filtered network takes seconds, a backoff falling
   * due meanwhile dialled the old route after the press, and an attempt
   * that landed first stayed up and armed on it. Over a tunnel the screen
   * shows, its reconnect leads with the pick from here, should it drop
   * before the answer; beneath a screen that shows nothing up, the pick
   * takes over as any press does. See `autoReconnect.choosing`. */
  function pickingLocation(routeId: string | null) {
    const choice = autoReconnect.choosing({ routeId, tunnelShown: connectionStateRef.current !== "disconnected" });
    if (choice === "stopPass") void stopPass();
    if (routeId !== null) expectSwitchLoad();
  }

  /** A server's switch request is going out, and its answer starts a load
   * of the screen's own. Until that load has begun, or the switch has
   * failed, nothing is asked in the background (`expectOwnLoad`): the
   * switch's answer is one of Neoxify's, and asked about at once it
   * started a background load a moment before the switch's load began
   * beside it -- two copies of the account, the plan and the credentials
   * on a censored network. */
  function expectSwitchLoad() {
    switchLoadExpectedRef.current?.();
    switchLoadExpectedRef.current = offlineRetry.expectOwnLoad();
  }

  /** The switch's load has begun, or the switch failed and none will. */
  function switchLoadSettled() {
    switchLoadExpectedRef.current?.();
    switchLoadExpectedRef.current = null;
  }

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
    setPressed(true);
    setConnectionError(null);
    // A press of the customer's own supersedes the connect a confirmed
    // switch still owes (`connectAfterSwitch`): it does what it says, and
    // nothing dials after it on the switch's behalf.
    connectAfterSwitchRef.current = false;
    // Whatever the press does next, the screen is no longer describing
    // the moment the last tunnel went.
    setTunnelDropped(false);
    // Nor is the app reconnecting by itself any more: the customer's
    // press takes over, and does what it says. A recheck is the
    // exception -- it asks a question, and takes nothing over.
    if (action !== "recheck") autoReconnect.cancel("customer");

    switch (action) {
      // Pressing during a pass means stop -- a pass the customer started,
      // or one an automatic reconnect did. See `stopPass`.
      case "cancelConnect": {
        await stopPass();
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
        // The device limit's teardown is still owed: this press is that
        // teardown, asked for again now rather than at the next recheck.
        // Not the ordinary Disconnect below, which would clear the card
        // that teardown is for -- it shows once the tunnel is down.
        if (slotTeardown.owed()) {
          await slotTeardown.retry(tearDownForSlotOnce);
          return;
        }
        // The customer ends this session: their next verified connection
        // is a new one, and its check bounces again (lib/check-pop.ts).
        rearmCheckPop();
        const generation = beginIntent("disconnect");
        // This device stops using one of the plan's devices. Released
        // fire and forget, within a second and a half, and never in
        // front of the teardown: while the tunnel is still up the request
        // goes through it, which on a filtered network is the likeliest
        // way to reach the API at all. The teardown is under way before
        // that request can finish its handshakes, though, and on the test
        // VM it took every one down with it: so a release that got no
        // answer goes again on the bare line once the teardown is over and
        // the service says the tunnel is gone (`ReleaseOptions` in
        // device-slot-session.ts).
        const teardown = teardownSignal();
        void deviceSlot.release({ tunnelGone: teardown.over });
        setSlotNotice(null);
        setConnectionState("disconnecting");
        let gone = false;
        try {
          await serviceDisconnect();
          // Acknowledged is not the same as finished, so the state comes
          // from what the service reports once the teardown has settled
          // rather than from the acknowledgement. An engine that
          // survives it is a thing the customer needs to know about, and
          // setting "disconnected" here on the strength of an ack is
          // exactly how that would be hidden.
          gone = (await confirmTornDown()) === "disconnected";
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
          gone = (await confirmTornDown()) === "disconnected";
        } finally {
          teardown.done(gone);
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
        // As the transient recheck does: an answer that says nothing is
        // running here was not a drop, so nothing is left armed for one;
        // and a tunnel it finds up is named, or named as none.
        if ((await syncNamingTunnel()) === "disconnected") autoReconnect.forget();
        return;
      }

      case "connect": {
        await connectNow();
        return;
      }
    }
  }

  /** A connect the customer asked for: the button, or "Use on this
   * device instead" with the devices to take the slot over from. */
  async function connectNow(takeover?: string[]) {
    // The customer's own connect, from the orb or the device-limit card:
    // an automatic reconnect under way, or waiting, ends here.
    autoReconnect.cancel("customer");
    setPressed(true);
    // "Use on this device instead" can be pressed while the device limit's
    // teardown is still owed -- a takeover's card shows over a tunnel
    // still up. That tunnel comes down first, on the service's word, and
    // if it will not, nothing is dialled: the stuck line stays, and the
    // pass below would otherwise start from "nothing is up" when
    // something is.
    if (slotTeardown.owed()) {
      if ((await slotTeardown.retry(tearDownForSlotOnce)) === "stuck") return;
    }
    // Their own connect from here; nothing is owed any more.
    slotTeardown.clear();
    setConnectionError(null);
    setSlotNotice(null);
    // Their own press: whatever the device limit stopped is theirs to
    // start again.
    slotLostRef.current = false;
    const outcome = await runLadder({ takeover });
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
      await syncNamingTunnel();
    }
  }

  /** Says why the device limit stopped this device -- see `slotStop`
   * for what is shown and reported, which both clients share. A
   * refusal is reported as a limit, never as a failed dial: no rungs, so
   * no route is marked as failing for anybody, and nothing is
   * remembered as this network's best or worst route.
   *
   * One that stopped an automatic reconnect's pass is reported as that
   * pass's (`asReconnectReport`), as every other way it can end is. Sent
   * as it was, it read as the customer pressing Connect and being refused
   * -- by somebody who had pressed nothing. */
  function showSlotStop(stop: SlotStop, reconnect?: ReconnectAttempt) {
    if (stop.notice) setSlotNotice(stop.notice);
    if (stop.report) void reportAttempt(asReconnectReport(stop.report, reconnect));
    if (stop.inactive) {
      // The plan-ended card already says what to do about SUSPENDED and
      // EXPIRED; anything else gets the error line.
      const status = stop.subscriptionStatus;
      if (status) setSubscription((current) => (current ? { ...current, status } : current));
      if (status !== "SUSPENDED" && status !== "EXPIRED") {
        setConnectionError({
          kind: "subscriptionInactive",
          messageKey: "err.subscriptionInactive",
          detail: `subscription ${status ?? "not active"}`,
        });
      }
    }
  }

  /** The device limit ended this device's session while it was
   * connected: another device took the slot over, a claim made through
   * the tunnel was refused, or the subscription stopped.
   *
   * Disconnects and says why, and does NOT run the failover ladder
   * (docs/device-slots.md, obligations 7 and 11): it would only take the
   * slot back from the device the customer is now using, or fail on every
   * protocol and blame servers that are fine. Records nothing either --
   * no attempt, no route marked failing, no best route moved: the dial
   * worked and was reported as it happened; the plan refused the device.
   * "Disconnected:" waits for the service to confirm it, and a refusal's
   * card waits for that altogether -- see DeviceSlotCard.
   *
   * A teardown that does not finish is not left there. The tunnel stays
   * shown as still disconnecting, never as working, with the stuck line
   * saying so; the recheck tries again until the service says it is
   * down; and the card shows then. See `slotTeardown`. */
  async function endForSlot(event: SlotStopReason) {
    // The session has ended and the app is already on its way to the
    // sign-in screen, tunnel included; there is nothing to add.
    if (event.kind === "signedOut") return;
    slotLostRef.current = true;
    const stop = slotStop(event, "whileConnected");
    // Nothing reconnects after this either: the teardown below is the
    // device limit's, and the tunnel's end is not a drop. Ended as what
    // it is -- the plan, when it was the plan that stopped.
    autoReconnect.cancel(slotStopWhy(stop.errorKind));
    // A pass in flight stops between its steps rather than dialling the
    // next protocol on a slot that is somebody else's.
    cancelRef.current = true;
    showSlotStop(stop);
    setFailedOverTo(null);
    await slotTeardown.begin(tearDownForSlotOnce);
  }

  /** One attempt at the device limit's teardown. True only when the
   * service has said the tunnel is down; a tunnel still up after the
   * settle time, or a service that will not answer, is not down. */
  async function tearDownForSlotOnce(): Promise<boolean> {
    const generation = beginIntent("disconnect");
    setConnectionState("disconnecting");
    await serviceDisconnect().catch(() => undefined);
    const state = await confirmTornDown();
    endIntent(generation);
    return state === "disconnected";
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
  async function runLadder(
    options: {
      /** Handles from a device-limit card: take the slot over from them. */
      takeover?: string[];
      /** Started by the health poll rather than by the customer. */
      automatic?: boolean;
      /** An automatic reconnect's attempt, after the tunnel dropped
       * (`lib/auto-reconnect`): led by the route that was up, and
       * reported as automatic. Always with `automatic`. */
      reconnect?: ReconnectAttempt;
    } = {},
  ): Promise<LadderOutcome> {
    if (!protocolUser || ladderInFlight()) return "declined";
    // Never an automatic pass while a repair runs -- the health poll's
    // failover, or a reconnect's attempt. Its first act is a Disconnect,
    // which cancels the repair mid-step on the service, and its connect
    // comes up behind the repair. See `duringRepair`.
    if (options.automatic && repairUnderWay()) return "declined";
    // An automatic pass -- a reconnect's attempt, or the mid-session
    // failover -- puts the last pass's error line away as it begins, as a
    // press does before its own: that pass is over. Left up, the inline
    // "Repair my network" stayed under "Connecting..." -- offered at the
    // one moment a repair has a pass to fight. The failover did leave it:
    // after a failed pass shown "degraded", run from there, the repair
    // stopped the failover's pass (`stopPassBeforeRepair`), whose end then
    // cleared the line, and with it the panel running the repair -- its
    // report, or the elevated command when the service could not be
    // reached, never shown. After the declines, so a pass turned away
    // while a repair runs leaves that repair's panel where it is.
    if (options.automatic) setConnectionError(null);
    // Its own number, so a pass that stalled past its deadline can be
    // told apart from the one that replaced it. Without that, a stalled
    // pass finally waking would clear the live pass's guard and write
    // its own long-obsolete verdict over the screen.
    const generation = ++ladderGenerationRef.current;
    ownPassRef.current = generation;
    // Which customer session this pass dials for. See sessionGeneration:
    // a sign-out can land while the pass is mid-ladder, from this screen
    // or from one that cannot reach `cancelRef`.
    const sessionAtStart = sessionGeneration();
    // And what its landing quotes to the reconnect, taken here, after the
    // press that began it: anything that overrules the pass from now on --
    // a stop, a sign-out, the device limit, a repair from Settings while
    // this screen is gone -- leaves nothing armed when it lands. See
    // `autoReconnect.stamp`.
    const reconnectStamp = autoReconnect.stamp();
    // The customer's side of the same fact. The ladder generation guards
    // the ladder against itself; this one tells every answer still in
    // flight anywhere in the file that a connect is now what the app is
    // doing -- and, through `phaseFor`, that the teardowns inside it are
    // part of connecting rather than something to narrate.
    const intent = beginIntent("connect");
    ladderRunningRef.current = true;
    ladderStartedAtRef.current = Date.now();
    cancelRef.current = false;
    /** Whether this pass has been told to stop: the stop flag, from
     * whichever screen pressed, or -- for an automatic reconnect's -- the
     * attempt it dials for being over. Not everything that ends an episode
     * reaches the flag (a change of mode, an expired session, the attempt's
     * ceiling), and a pass that asked only the flag went on dialling the
     * old order behind a repair or a new location and landed on the old
     * server. Asked wherever the flag used to be. See `passStopped`. */
    const stopped = () => passStopped(cancelRef.current, options.reconnect);
    /** "Block the internet while reconnecting": whether this pass keeps the
     * service's hold through its own teardowns -- an automatic pass, or a
     * press made while the hold is holding -- or lets go of it, as a press
     * from a quiet screen always has (`passTeardown`). */
    const holdThrough =
      passTeardown({
        setting: holdWanted(appPrefs.current().blockWhileReconnecting),
        automatic: options.automatic === true,
        holding: holdStore.current()?.state === "holding",
      }) === "keepHold";
    const takeDown = (): Promise<void> => (holdThrough ? holdService.disconnectKeepingHold() : serviceDisconnect());
    /** Whether this pass brought a tunnel up. One of the app's own
     * automatic passes that did not -- the mid-session failover -- has
     * just taken the tunnel the episode was armed for down on purpose,
     * and that is not something to reconnect. */
    let landed = false;
    // Whether this pass says it is waiting for a network (`network-wait.ts`):
    // said once the service refuses a rung for want of one, and kept until it
    // takes a dial again or the pass ends -- not cleared before each retry,
    // which turned the headline to "Reconnecting..." and back every 30 s.
    let networkWaitShown = false;
    const showNetworkWait = (on: boolean) => {
      if (networkWaitShown === on) return;
      networkWaitShown = on;
      // The store is shared: only the pass that owns the ladder speaks for
      // it, so one superseded mid-wait cannot clear a newer pass's wait.
      if (ladderGenerationRef.current === generation) networkWait.set(on);
      options.reconnect?.waitingForNetwork?.(on);
    };
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
      //
      // The plan's device limit is asked at the same time, not after:
      // both are before anything is dialled or torn down, and on a
      // network where the API is blackholed running them one after the
      // other would add the claim's three seconds to the refresh's six
      // for no answer from either. The credential named is the one on
      // screen; once the ladder lands, the slot is moved to the one it
      // landed on (`afterConnected`).
      //
      // Not for an automatic pass whose slot was never confirmed. A
      // degraded tunnel there may be the device limit rather than the
      // network, and asking through it is asking into the thing that
      // stopped working -- that case tears down first and asks below.
      const checkFirst = options.automatic === true && deviceSlot.needsStandingCheck();
      const subscriptionId = subscription?.id ?? protocolUser.subscriptionId;
      const slotDecision = checkFirst
        ? null
        : deviceSlot.beforeDial({
            subscriptionId,
            protocolUserId: protocolUser.id,
            takeover: options.takeover,
            deviceLimit: subscription?.deviceLimit,
          });
      // `appState` is the state this pass started from: "disconnected"
      // from the button, or whatever the health poll saw when it began
      // a failover -- in which case the refresh went through that tunnel.
      // An answer after the budget is too late for this pass, which has
      // dialled what it held by then, but is held for the next one
      // (`onLateConfig` above): inside the freshness horizon that one
      // asks nothing and dials what the screen holds.
      const refreshed = await refreshConnectionConfig({
        held: protocolUsers,
        trigger: "connect",
        appState: connectionState,
      });
      if (refreshed.source === "network") setProtocolUsers(refreshed.protocolUsers);
      const dialable = refreshed.protocolUsers.length > 0 ? refreshed.protocolUsers : [protocolUser];

      // Refused, or the check says this device's slot is somebody
      // else's: nothing is dialled. Never a failed dial in the attempt
      // history, never a "best route" learned, never the ladder.
      let stoppedBySlot: SlotStopReason | null = null;
      if (slotDecision) {
        const decision = await slotDecision;
        if (decision.kind !== "dial") stoppedBySlot = decision;
      } else {
        // Obligation 9: down first, so the question does not go into a
        // tunnel that may be held, then four seconds to ask.
        await takeDown().catch(() => undefined);
        const standing = await deviceSlot.checkStanding();
        if (standing.kind === "unanswered") {
          // Said, and then the ladder runs as usual: a limit that could
          // not be checked is a possibility, not a verdict. Worded by
          // whether anything came back: "couldn't reach Neoxify" only
          // when nothing did, never over an answer that was an error.
          const limit = deviceSlot.limit() ?? subscription?.deviceLimit ?? null;
          if (typeof limit === "number") setSlotNotice({ kind: "unchecked", limit, noAnswer: standing.noAnswer });
        } else if (standing.kind !== "clear") {
          stoppedBySlot = standing;
        }
      }
      if (stoppedBySlot !== null) {
        const stop = slotStop(stoppedBySlot, "beforeDial");
        // What an automatic reconnect's episode ends on: the device limit,
        // or the plan, when the claim said the subscription has stopped
        // (`slotStopWhy`).
        passResultRef.current = { routeId: null, errorKind: stop.errorKind };
        // Said only to a customer still waiting on this pass: one who
        // pressed stop, or signed out, has already moved on.
        const stillWanted = !stopped() && sessionGeneration() === sessionAtStart;
        if (stillWanted) {
          showSlotStop(stop, options.reconnect);
          if (options.automatic || stoppedBySlot.kind === "displaced") slotLostRef.current = true;
        }
        // A pass started by the poll still had a tunnel up, and a slot
        // that is not this device's leaves it nothing to stay up for.
        // From the button nothing is up, so there is nothing to take
        // down -- and nothing was dialled either way.
        //
        // That teardown is the device limit's, the same one a stop while
        // connected owes (`endForSlot`), and it goes through the same
        // place: owed until the service says the tunnel is down, a tunnel
        // still up meanwhile shown as still disconnecting -- never as the
        // raw "connected" the health poll would then pick up and turn
        // green over a refusal -- and tried again on the recheck. Taken
        // down here once and left, a tunnel that outlived the wait sat
        // there with the card hidden (it waits for "down") and nothing
        // trying again: `slotLostRef` keeps the ladder away, by design.
        //
        // Not for a pass the customer cancelled or a sign-out overtook --
        // each runs its own teardown -- nor for one a newer pass has
        // replaced, whose intent the attempt would stamp out.
        if (options.automatic && stillWanted && ladderGenerationRef.current === generation) {
          endIntent(intent);
          await slotTeardown.begin(tearDownForSlotOnce);
          return "refused";
        }
        if (options.automatic) await serviceDisconnect().catch(() => undefined);
        if (ladderGenerationRef.current !== generation) return "refused";
        endIntent(intent);
        // The service's answer, not an assumption -- the same as a
        // failed pass ends with.
        await confirmTornDown(intent);
        return "refused";
      }

      // Whatever is up comes down first, and this is not a formality.
      // Run from the health poll, the tunnel that just stopped working
      // is still installed and still holding the default route, so every
      // probe below would be fired into a black hole and burn its full
      // timeout rather than answering. That turned a pass that should
      // take seconds into minutes of "Checking connection..." -- observed
      // exactly that way when a live WireGuard tunnel was blocked.
      //
      // Harmless from the Connect button, where nothing is up.
      //
      // An automatic pass keeps the reconnect hold through it, if it is on:
      // the gap between the dead tunnel and the next is the one it blocks.
      await takeDown().catch(() => undefined);

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
      // Kept past the try so the success path can send the same
      // selection again with an egress attached. Re-reading the store
      // there instead would open a window in which the customer changes
      // their selection mid-connect and the second push overwrites the
      // first with something they no longer have on screen.
      let splitTunnelSettings: SplitTunnelSettings | null = null;
      try {
        const settings = await loadSplitTunnel();
        // No egress named, and that is not a placeholder. Nothing is
        // established yet, and the ladder below may well settle
        // somewhere other than its first pick -- so any exit named here
        // would be a guess. The service reports a preference it cannot
        // compare as `unknown`, which is the truthful answer for the
        // seconds this covers.
        await pushSplitTunnel(settings);
        splitTunnelSettings = settings;
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
      // Asked of every candidate at once, before anything is dialled.
      //
      // About a second, against the tens of seconds a dead rung costs
      // when the ladder discovers the same thing by dialling it. The
      // answer only covers the TCP-carried protocols -- UDP cannot be
      // probed this way -- and a probe that cannot be run leaves the
      // candidate unknown rather than condemned.
      //
      // Placed after the teardown above, so this is dead time that
      // would otherwise be spent dialling something that cannot answer.
      // A cancel landing during it needs no handling here: the loop
      // below checks `stopped` on its first pass and a superseded
      // generation is caught after it, and adding a third exit would
      // mean a third opinion about what that outcome is called.
      const reachability = await probeCandidates(dialable).catch(() => ({}));

      const candidates = orderCandidates(dialable, {
        // A reconnect starts where the tunnel was, then falls back in
        // the ordinary order.
        resumeRouteId: options.reconnect?.resumeRouteId ?? null,
        pinnedRouteId: chosenRouteId,
        lastGoodRouteId: lastGoodFor(lastGood, networkId),
        history,
        network: networkId,
        reachability,
        preferredRouteId: null,
        // What others on this network got through on. A tie-break only,
        // and only while this device has no history here -- the first
        // run, which is when a wrong guess makes people quit.
        ispTags: ispTagsOf(routes),
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
      //
      // What the SERVER tile showed (`displayedRouteId`), which is not
      // always the credential the screen holds. A location chosen over a
      // tunnel that stays up (`chooseLocation`) leaves the credential on
      // the tunnel's route while the pin moves; once that tunnel is gone the
      // tile names the pin. Compared against the credential, the next
      // Connect -- landing on the very server just chosen -- was told it had
      // moved off the old one: "Your usual protocol didn't get through"
      // about a route it never dialled.
      const shownRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed);

      // Every rung that failed, with what it did with its route: whether
      // the route on screen was actually dialled before we settled
      // somewhere else, or only refused for want of a network.
      //
      // Without this the app tells the customer "Couldn't reach
      // sg-singapore" in the one case it never tried Singapore at all --
      // nothing pinned, ladder ordered by speed, WireGuard on another
      // continent won at index 0. Observed exactly that. Asserting a
      // failure that did not happen is the same dishonesty as the
      // silence it replaced, just louder, and it sends the customer to
      // support over a server that is fine. Being reached by the ladder
      // is not being dialled either: with the network adapter off, every
      // rung failed in the service before anything was sent, and the
      // screen said "Couldn't reach fi-finland" once the network was back
      // and another country answered (`failoverNotice`).
      const failedRungs: FailedRung[] = [];

      let lastError: ClassifiedError | null = null;
      // Why each attempt failed, in order. Kept because diagnosing the
      // first version of this needed a firewall rule and the server's
      // own logs -- the app knew and said nothing.
      const attempts: string[] = [];
      // One per entry in `attempts`, by index: which route that rung
      // dialled and whether it carried, or null when the rung says
      // nothing about the network. Feeds the per-ISP tags; see
      // `failedDial`.
      const dials: Dial[] = [];
      // An endpoint known to answer `/health/ip` on this network without
      // a tunnel: the baseline taken when the screen loaded or the last
      // pass connected, then each candidate's own. Asked first when
      // settling, so a candidate does not walk the whole list again. See
      // settleAndCaptureBaseline.
      let knownBaseline: BaselineIp | null = baselineIpRef.current;
      // Every node the account holds a credential on, for the baselines:
      // a reading of one of them is never this machine's own address.
      const nodeAddresses = nodeAddressesOf(dialable);
      // The same servers as the service reads them: before each rung's
      // tunnel is built it removes host routes to any of these that an
      // earlier session left on the physical adapter (`knownServerHosts`).
      const knownNodes = knownServerHosts(dialable);
      // Whether this pass began with nothing up: pressed on a screen that
      // showed nothing connected, rather than a failover or a reconnect
      // from a tunnel that was there. Its first rung then has no previous
      // engine's routes to wait out, and its settle does not ask again
      // (`settleAndCaptureBaseline`).
      const nothingUpAtStart = connectionState === "disconnected" && !options.automatic;

      // When this rung was first refused for want of a network, while it
      // waits for one (`network-wait.ts`). Cleared once the ladder moves on.
      let noNetworkSince: number | null = null;
      // And how many times it has waited, each wait ended by a dial the
      // service refused again: each puts the next dial further off
      // (`nextLookIn`), so a hint it keeps refusing is never hammered.
      let noNetworkRounds = 0;
      // The rung about to be dialled is one dialled again after a wait for
      // a network: nothing of ours is up -- the service refused the dial
      // before starting anything, and any earlier rung's routes were proven
      // gone by this rung's own settle before that -- so its IPv6 baseline
      // can be taken beside the settle rather than after it.
      let redialAfterWait = false;
      // Over an index, not an iterator: a rung the service refused for want
      // of a network is dialled again, on the same server, once there is one.
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (stopped() || sessionGeneration() !== sessionAtStart) break;
        // A pass whose guard expired and that a newer pass has replaced
        // stops dialling here, rather than tearing that pass's engine
        // down with its next connect.
        if (ladderGenerationRef.current !== generation) break;
        // Still alive: each rung renews the guard, so a long ladder on a
        // filtered network keeps it while a wedged step still loses it.
        // See `LADDER_MAX_MS`. And a reconnect's attempt, whose own
        // ceiling is measured the same way (`ATTEMPT_MAX_MS`): renewed
        // only by the guard, it gave up on this pass at three minutes
        // while it was still dialling.
        ladderPass.progress(generation);
        options.reconnect?.progress();
        ladderProgress.rung({
          pass: generation,
          index,
          total: candidates.length,
          routeId: candidate.routeId,
          protocol: candidate.protocol,
          transport: candidate.connection?.transport,
        });
        const label = customerProtocolLabel(candidate.protocol, candidate.connection?.transport);
        const isLast = index === candidates.length - 1;

        // Patient only for the last candidate. With another protocol
        // sitting untried, waiting out a long budget on this one is
        // ruinous; with nowhere left to go, it is the right call.
        const settleBudget = isLast ? SETTLE_TIMEOUT_MS : FAILOVER_SETTLE_TIMEOUT_MS;
        const verifyBudget = isLast ? VERIFY_TIMEOUT_MS : FAILOVER_VERIFY_TIMEOUT_MS;

        // Where this rung's tunnel will be dialled. For every engine but
        // WireGuard the service (or the engine) routes that address
        // around the tunnel, so an endpoint on it -- the node's own API
        // mirror -- answers with the customer's home address however
        // well the tunnel works: no baseline from it, and no reading
        // from it while connected. See `TunnelServer` in egress.ts.
        //
        // The settle gets the literal addresses only: `connection.host`
        // is one and names the node. Names are resolved after it, once
        // the previous rung's tunnel is known to be gone -- a lookup
        // before then could go into it -- and just before this one is
        // dialled, as the engine is about to.
        const settleServer = literalTunnelServer(candidate, "windows");
        // Beside the settle after a wait for a network (`redialAfterWait`).
        // After it, on the VM, the probe waited out its timeout (about two
        // seconds) on a network with IPv6 addresses and no IPv6 route,
        // the settle's half second before it. Beside it saves only that
        // half second -- the dial still waits for the probe below. By the
        // VM's R3d timings a four-second blip is still verified about
        // 1.7 s past the screen's ten-second calm hold: shortened, and
        // still amber, not fixed.
        const ipv6Beside = redialAfterWait && ipv6BaselineRef.current === null ? captureIpv6Baseline() : null;
        redialAfterWait = false;
        // Fresh every attempt, and taken only once plain networking is
        // confirmed working. See settleAndCaptureBaseline.
        baselineIpRef.current = await settleAndCaptureBaseline(
          settleBudget,
          knownBaseline,
          settleServer,
          nodeAddresses,
          index > 0 || !nothingUpAtStart,
        );
        if (baselineIpRef.current !== null) knownBaseline = baselineIpRef.current;
        const tunnelServer = await tunnelServerOf(candidate, "windows");
        // Once per pass, not once per candidate: whether this machine
        // has public IPv6 is a fact about its network, not about which
        // protocol is being tried, and re-measuring it five times would
        // add a timeout to each rejected candidate for no new
        // information. Taken here rather than before the loop so it
        // still lands after the previous engine's routes are gone.
        if (ipv6BaselineRef.current === null) {
          ipv6BaselineRef.current = await (ipv6Beside ?? captureIpv6Baseline());
        }

        try {
          // The concurrent exits this candidate can carry alongside
          // itself, worked out from credentials the client already
          // holds. Empty unless the customer placed a game on an exit
          // other than this one and the protocol can carry it -- see
          // `concurrentExitsFor`, where every rule fails toward fewer
          // exits and none of them can stop the connection.
          //
          // Recomputed per candidate rather than once before the
          // ladder: the ladder settles wherever it settles, and which
          // exits are *additional* depends on where it landed.
          const concurrent = splitTunnelSettings
            ? concurrentExitsFor(
                candidate,
                dialable,
                routes,
                splitTunnelSettings.games,
                splitTunnelSettings.apps,
              )
            : [];
          // Which credential the tunnel about to come up is on, for a screen
          // mounted while it is up -- back from Settings, or the app opened
          // again -- which the service cannot tell (`tunnelCredential`). On
          // disk before the dial: an app that exits while the engine comes
          // up leaves the tunnel up, and a record still on the dial before
          // would name it. Recorded ahead of the check below, which nothing
          // may be awaited after before the dial; a record of a dial the
          // check then stops names nothing -- the stop takes down what is up,
          // and a newer pass records its own before dialling.
          await tunnelCredential.dialling(candidate);
          // Asked again right before the connect. The settle, the names and
          // the IPv6 baseline above run to seventeen seconds or so, and a
          // stop that landed in them -- "Stop reconnecting", a location
          // chosen, a repair -- used to be heard only after this rung's
          // connect: the old route dialled once more after the press. A
          // repair's own Disconnect, sent before that connect, had nothing
          // to cancel, so the connect waited behind the repair's teardown
          // and ran to the app's reply timeout, the pass held the guard past
          // the repair's wait for it (`REPAIR_PASS_WAIT_MS`), and its
          // teardown then cancelled the repair mid-step.
          if (stopped() || sessionGeneration() !== sessionAtStart || ladderGenerationRef.current !== generation) break;
          // From here a tunnel to this server may be up, and the health
          // poll -- from whichever Dashboard is mounted -- needs to know
          // which endpoints it reaches around it.
          ladderPass.tunnelServer.current = tunnelServer;
          setEndpointTunnelServer(tunnelServer);
          await invoke("vpn_connect", {
            payload: candidate,
            exits: concurrent.map((entry) => ({ exit: entry.exit, payload: entry.payload })),
            knownNodes,
            // "Block the internet while reconnecting": the service arms this
            // session when it is on (lib/reconnect-hold.ts).
            blockWhileReconnecting: holdWanted(appPrefs.current().blockWhileReconnecting),
          });
          showNetworkWait(false);
          // The session this pass was started under ended while the
          // engine was coming up. The sign-out's own teardown may have
          // run before this connect finished, in which case this tunnel
          // is one nothing else will ever take down -- so this pass does
          // it, says nothing (the screen is gone), and stops.
          if (sessionGeneration() !== sessionAtStart) {
            await serviceDisconnect().catch(() => undefined);
            return "failed";
          }
          // Stopped while the engine came up: nothing about this rung
          // reaches the screen. Not its route least of all -- a location
          // chosen meanwhile has just named its own, and this one landing
          // on top of it named a server nothing will dial. The teardown
          // after the loop takes the engine down.
          if (stopped()) break;
          setProtocolUser(candidate);
          setTunnelRouteUnknown(false);
          setConnectedAt(Date.now());

          // Egress first. WireGuard does not handshake until it has
          // something to send, so this request *is* that traffic: it
          // forces the handshake and answers the stronger question at
          // the same time -- did our packets actually leave via the
          // server.
          publishObserved(intent, "verifying");

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
            // The service's word on whether the redirect is running,
            // read now rather than left to the first health poll. Until
            // that poll the screen otherwise said "Everything on this
            // computer goes through Neoxify" for about fifteen seconds
            // of a Custom-mode session -- seen on a Windows 11 guest
            // with only curl.exe selected.
            await serviceStatus()
              .then((status) => setSplitTunnelActive(Boolean(status.splitTunnelActive)))
              .catch(() => undefined);

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
            // Whether the service confined this session's IPv4 to the
            // tunnel, read now rather than left to the first status poll:
            // the check below takes its endpoints from the order, and while
            // confined the connected server's own mirror is refused on this
            // PC (10013) -- a refusal here, which must not be asked, let
            // alone counted against the network (`setConfinedAround`).
            const confinedBefore = await serviceStatus()
              .then((status) => {
                setConfinedAround(status.ipv4Confined === true);
                setIpv4NotConfined(warnsUnconfined(status, Boolean(status.splitTunnelActive)));
                setUnconfinedKey(unconfinedLine(status));
                return status.ipv4Confined;
              })
              .catch(() => undefined);
            // Only the last rung can use an answer from an endpoint other
            // than the baseline's; see `VerifyOptions.sameEndpointOnly`.
            let egress = await confirmEgress(baselineIpRef.current, verifyBudget, !isLast, tunnelServer);
            // And again once the check is over. The service's plan-error
            // valve trips during it -- the check is what makes the engine
            // dial -- and lets go of a confinement the engine itself was
            // refused by. Read only before, the screen said "You're
            // protected" over it until the next health poll; and the rung
            // was judged on a check our own filter had failed, so a protocol
            // it broke was dropped as if the network had blocked it. A
            // confinement let go of during a failed check earns the rung one
            // more check, now that it runs as it would have without it
            // (`egressWorthAnotherLook`).
            const after = await serviceStatus().catch(() => null);
            if (after) {
              setConfinedAround(after.ipv4Confined === true);
              setIpv4NotConfined(warnsUnconfined(after, Boolean(after.splitTunnelActive)));
              setUnconfinedKey(unconfinedLine(after));
            }
            // Said in the rung's line if it still fails -- not as a line of
            // its own: `attempts` and `dials` pair by index.
            const checkedAgain = egressWorthAnotherLook(confinedBefore, after, egress.state);
            if (checkedAgain) {
              egress = await confirmEgress(baselineIpRef.current, verifyBudget, !isLast, tunnelServer);
            }
            setExitIp(egress.state === "unreachable" ? null : egress.exitIp);

            // The reachability check is worth its eight seconds only
            // when this is the last hope: it distinguishes "server is
            // dead" from "server is fine but our traffic goes around
            // it", which is a distinction for the error message, not
            // for deciding whether to try the next protocol. Another
            // candidate waiting makes moving on strictly better than
            // diagnosing -- except when no baseline could be taken, and
            // no candidate can ever be proven; see
            // `rungJudgedByHandshake`.
            verdict =
              egress.state === "throughTunnel"
                ? "connected"
                : rungJudgedByHandshake(egress, {
                      isLast,
                      baselineTaken: baselineIpRef.current !== null,
                    })
                  ? combineEvidence(await confirmReachable(), egress)
                  : "degraded";
            reason = checkedAgain ? `${egress.state}, checked again after the IPv4 confinement was let go of` : egress.state;
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
            // A tunnel is up: whatever the reconnect hold was holding is
            // over. Asked of the service at once; nothing waits on it.
            if (holdWanted(appPrefs.current().blockWhileReconnecting)) void holdService.release();
            // Which exit this session actually leaves from, sent now
            // that a route has come up rather than guessed before one
            // had.
            //
            // Taken from the route the ladder LANDED on, not the one
            // that was on screen. Those come apart routinely -- nothing
            // pinned, the ladder orders by speed, and the app could show
            // one server while connecting to another -- and an egress
            // taken from the intended route would tell a customer their
            // game is on the exit they chose while it is somewhere else.
            //
            // `exitOfRoute` resolves it through the route's own exit
            // handle, which is the only thing that survives a relay: a
            // relayed route is dialled at the entry and leaves from the
            // exit leg, and naming the entry would be silently wrong for
            // exactly the routes where the customer's choice matters
            // most.
            //
            // Best-effort. A failure here costs an honest `unknown`
            // placement, and failing the connection over a reporting
            // detail would be out of all proportion.
            if (splitTunnelSettings) {
              await pushSplitTunnel(
                splitTunnelSettings,
                exitOfRoute(routes, candidate.routeId),
              ).catch(() => undefined);
            }
            // The last moment this pass can hear a stop before the rung is
            // recorded as a landing: nothing from here to the end of it
            // awaits. Verifying takes seconds -- the egress check up to its
            // whole budget on the last rung, the Custom-mode probe holding
            // the service's one thread while the stop's teardown queues
            // behind it -- and a stop pressed meanwhile cannot recall a
            // request already in flight: a tunnel that carried it answers
            // "connected" about a connect the customer has called off. That
            // rung is cancelled, not landed. Taken as a landing, it reported
            // a success nobody got, claimed the plan's slot back after the
            // stop had given it up, and armed the reconnect for the tunnel
            // the stop was taking down. What ran above is already harmless:
            // the stop's own intent stamps out the publish (or it lands on
            // a screen that has gone), and every pass sends the split-tunnel
            // selection afresh. The phone's ladder asks the same after its
            // verdict; a sign-out is handled as after the connect above.
            if (sessionGeneration() !== sessionAtStart) {
              await serviceDisconnect().catch(() => undefined);
              return "failed";
            }
            if (stopped() || ladderGenerationRef.current !== generation) break;
            const movedFromShown = Boolean(shownRouteId) && candidate.routeId !== shownRouteId;
            if (index > 0 || movedFromShown) {
              // Compared against what was on screen when Connect was
              // pressed, falling back to the head of the ladder. Using
              // the head alone missed the case this exists for.
              const intended = routes.find((r) => r.id === (shownRouteId ?? candidates[0]?.routeId));
              const landed = routes.find((r) => r.id === candidate.routeId);
              // Compared as places, not entry regions: a relay that fell
              // from Iran → Germany to Iran → France crossed a border,
              // though both are dialled in Iran.
              const crossed = intended !== undefined && landed !== undefined && placeKey(intended) !== placeKey(landed);
              const from = intended ? placeLabel(intended, language) : null;
              const to = landed ? placeLabel(landed, language) : null;
              setFailedOverTo(
                failoverNotice({
                  label,
                  fromRegion: crossed ? from : null,
                  toRegion: to,
                  // Only "couldn't reach it" if we actually dialled it.
                  shownRouteId: shownRouteId ?? null,
                  failed: failedRungs,
                }),
              );
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
            // Both outcomes, and the failures are the valuable half.
            //
            // `lastGood` above only ever learns what worked, so the
            // ladder could rediscover the same dead protocol every time
            // it ran. Recording that this route and protocol did not
            // carry traffic here is what lets the next attempt start
            // somewhere else. `unverified` counts as a failure for the
            // same reason it is excluded above: an engine that started
            // and proved nothing is not evidence that it works.
            {
              const recorded = recordAttempt(
                history,
                networkId,
                candidate.routeId,
                candidate.protocol,
                verdict === "connected",
              );
              setHistory(recorded);
              void saveConnectHistory(recorded);
            }
            strikesRef.current = 0;
            // Successes are reported too, and they are not filler. A
            // failure rate needs a denominator, and "Stealth works from
            // this network while Fast does not" is a fact only the
            // successes can establish. The ladder is attached whenever
            // something had to be walked past to get here.
            //
            // Always with the ladder now, even a one-rung one: the
            // per-ISP tags count only explicit, proven rungs, so the rung
            // that worked has to be there to be counted -- and an
            // `unverified` landing is a SUCCESS that proved nothing, so
            // its rung carries no dial.
            //
            // An automatic reconnect's is marked as one, so it is not read
            // as somebody pressing Connect (`asReconnectReport`).
            void reportAttempt(
              asReconnectReport(
                {
                  kind: "CONNECT",
                  outcome: "SUCCESS",
                  protocol: label,
                  routeId: candidate.routeId,
                  attempts: rungsFrom(
                    [...attempts, `${label}: connected`],
                    [...dials, verdict === "connected" ? { routeId: candidate.routeId, carried: true } : null],
                  ),
                },
                options.reconnect,
              ),
            );
            // A tunnel to reconnect if it drops. A reconnect's own landing
            // is armed by the episode, which carries its count of quick
            // deaths; every other pass starts the clock afresh -- unless
            // something overruled it that the checks above did not see;
            // the stamp has the last word on that.
            passResultRef.current = { routeId: candidate.routeId, errorKind: null };
            if (!options.reconnect) {
              autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true, stamp: reconnectStamp });
            }
            // Whatever the device limit had to say before this pass is
            // answered by it.
            setSlotNotice(null);
            // The slot, now that a tunnel is up: claimed through it if the
            // claim before dialling went unanswered, or moved to the
            // credential the ladder landed on. Not awaited -- the pass is
            // over and its guard must not wait on the API. A refusal that
            // arrives this way is the limit enforced late, and ends the
            // session like a takeover does.
            void deviceSlot.afterConnected({ protocolUserId: candidate.id }).then((event) => {
              if (event.kind !== "keep" && sessionGeneration() === sessionAtStart) void endForSlot(event);
            });
            landed = true;
            return "connected";
          }

          attempts.push(`${label}: up but ${reason}`);
          dials.push({ routeId: candidate.routeId, carried: false });
          // Its tunnel came up: dialled, whatever else is true of it.
          failedRungs.push({ routeId: candidate.routeId, fate: "dialled" });
          lastError = {
            kind: "serverUnreachable",
            messageKey: candidates.length > 1 ? "err.allProtocolsFailed" : "err.notCarryingTraffic",
            detail: describeAttempts(attempts, candidates.length),
          };
        } catch (err) {
          const classified = classifyConnectionError(err);
          if (classified.kind !== "noNetwork") showNetworkWait(false);
          // No network to dial over: the service refused the rung before
          // anything was dialled. Not a rung that failed -- moving on to the
          // next server for it walked the whole list in seconds, and a
          // reconnect spent its six attempts in a minute and landed in
          // another country once the network was back (G8, g8-01: fi to
          // sg). So wait here for a network, on this rung: nothing counted,
          // nothing recorded against the route, the same server dialled
          // again when there is one -- and said on screen meanwhile.
          if (classified.kind === "noNetwork" && !stopped()) {
            noNetworkSince ??= Date.now();
            showNetworkWait(true);
            const waited = await waitForNetwork(
              {
                // The service's own rule, toward this rung's server.
                wayOut: () => invoke<boolean>("network_way_out", { payload: candidate }),
                stopped: () =>
                  stopped() || sessionGeneration() !== sessionAtStart || ladderGenerationRef.current !== generation,
                progress: () => {
                  ladderPass.progress(generation);
                  options.reconnect?.progress();
                },
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                now: () => Date.now(),
              },
              noNetworkSince,
              noNetworkRounds,
            );
            noNetworkRounds += 1;
            if (waited === "back" || waited === "retry") {
              // The same rung again, from its settle: the baseline is taken
              // afresh on the network that is back -- the IPv6 one too,
              // which a pass begun with no network took on none at all.
              // Still said on screen until the service takes the dial.
              ipv6BaselineRef.current = null;
              redialAfterWait = true;
              // Rungs this pass dialled before the network went may have
              // failed for that, not for their servers: fi timed out as
              // Wi-Fi left, sg waited, and the pass went on to sg once the
              // network was back -- another country, with a notice that fi
              // did not get through. So it starts again from its first
              // rung, and says nothing against the ones before -- on screen
              // or in the pass's report, which pairs `attempts` and `dials`.
              if (index > 0) {
                failedRungs.length = 0;
                attempts.length = 0;
                dials.length = 0;
                lastError = null;
                index = -1;
              } else {
                index -= 1;
              }
              continue;
            }
            showNetworkWait(false);
            if (waited === "stopped") break;
            // Gave up after the half hour: said below as no network, and no
            // other server is dialled for it.
          }
          attempts.push(`${label}: ${classified.detail}`);
          dials.push(failedDial(candidate.routeId, classified.kind));
          // A rung the service could not dial for want of a network is not
          // one that failed to reach its server (`rungFate`). And when it is
          // the last word, the screen says there is no network rather than
          // naming anything: `err.noNetwork`.
          failedRungs.push({ routeId: candidate.routeId, fate: rungFate(classified.kind) });
          lastError = { ...classified, detail: describeAttempts(attempts, candidates.length) };
          if (classified.kind === "noNetwork") break;
        }

        noNetworkSince = null;
        noNetworkRounds = 0;
        // Always tear down before moving on, or the next engine inherits
        // this one's routes and fails for a reason that has nothing to
        // do with it. Keeping the hold between rungs, when it is kept.
        await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect").catch(() => undefined);
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
      // reported as one -- nor one whose episode a press ended, which has
      // filed its own row.
      setConnectionError(stopped() ? null : lastError);
      // Nothing came up, so this device is not using one of the plan's
      // devices. Kept, the slot would turn the customer's phone away for
      // the next ninety seconds with "Neoxify is in use on Windows PC" --
      // a claim about a device that is not connected.
      void deviceSlot.release();
      passResultRef.current = { routeId: null, errorKind: lastError?.kind ?? null };
      if (!stopped()) {
        // The whole ladder failed. This is the report that has been
        // costing a screenshot and a conversation every time: which
        // protocols were tried, in order, and what each one did. An
        // automatic reconnect's is filed as one, not as a customer's
        // failed connect.
        void reportAttempt(
          asReconnectReport(
            {
              kind: "CONNECT",
              outcome: lastError ? outcomeFromError(lastError.kind) : "OTHER",
              reason: lastError?.detail,
              attempts: rungsFrom(attempts, dials),
            },
            options.reconnect,
          ),
        );
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
      //
      // A reconnect's attempt that failed keeps the hold for the next one;
      // any other pass that failed lets go -- nothing is reconnecting after
      // it, and the product fails open.
      await (options.reconnect && holdThrough ? holdService.disconnectKeepingHold() : serviceDisconnect()).catch(() => undefined);
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
      // A wait for a network ends with its pass, however it ended.
      showNetworkWait(false);
      // And the line saying which rung it was on.
      ladderProgress.ended(generation);
      // Only the pass that still owns the guard may release it. One that
      // outlived its deadline has already been replaced, and clearing
      // the guard here would unlock a newer pass that is still running.
      if (ladderGenerationRef.current === generation) ladderRunningRef.current = false;
      // Before the pass is announced as ended, so a screen adopting what
      // it left cannot take its teardown for a drop it missed. A
      // reconnect's own pass is the episode's to account for. And only a
      // pass still current: one a newer pass replaced after its guard
      // lapsed -- a step wedged past it -- forgot the tunnel that newer
      // pass had landed and armed, and its next drop then reconnected
      // nothing.
      if (!landed && !options.reconnect && ladderGenerationRef.current === generation) autoReconnect.forget();
      // A screen mounted while this pass ran -- Settings opened and closed
      // mid-connect -- adopted it and is waiting to ask the service what
      // it left. This screen, if it is still the one mounted, ignores it.
      if (ladderGenerationRef.current === generation) ladderPass.ended();
    }
  }

  /** Decision 3 of the redesign (owner, 2026-10-19): a location picked
   * while a tunnel is up -- or while a connect or an automatic reconnect is
   * under way -- is confirmed first, because switching takes the tunnel
   * down. On "Switch" this takes it down the way Disconnect does, and only
   * once the service says nothing is up does the list go on to its own
   * pick (`onPicking`, the switch request, `onSwitched`), after which
   * `connectAfterSwitch` connects again. Every state on the way is the
   * service's: the chip says "Disconnecting", then "Connecting", then what
   * the new connection proves.
   *
   * With nothing up, the pick goes ahead as it always has. */
  async function confirmPick(route: RouteOption | null): Promise<boolean> {
    const state = connectionStateRef.current;
    const live =
      state === "connected" || state === "unverified" || state === "degraded" || state === "connecting" || state === "verifying";
    if (!live && reconnectingRef.current === null) return true;
    const go = await new Promise<boolean>((resolve) =>
      setSwitchAsk({
        place: route ? placeLabel(route, language) : null,
        protocol: route ? customerProtocolLabel(route.protocol, route.transport) : null,
        tunnelUp: isTunnelUp(state),
        resolve,
      }),
    );
    setSwitchAsk(null);
    if (!go) return false;
    const now = connectionStateRef.current;
    if (now === "connected" || now === "unverified" || now === "degraded") await handleConnectToggle("disconnect");
    else if (now === "connecting" || now === "verifying") await handleConnectToggle("cancelConnect");
    // The service's word that nothing is up, not the screen's: a teardown
    // that did not finish leaves the pick undone and says why. The service
    // is asked once more; if that one question goes unanswered -- busy
    // just after a teardown -- the answer the teardown itself settled on
    // (`confirmTornDown`, now the screen's state) stands in for it.
    const status = await serviceStatus().catch(() => null);
    const down = status ? !status.connected : connectionStateRef.current === "disconnected";
    if (!down) {
      setConnectionError({ kind: "serviceUnavailable", messageKey: "sw.notSwitched", detail: status ? "still connected after the switch's teardown" : "no answer after the switch's teardown" });
      return false;
    }
    connectAfterSwitchRef.current = true;
    return true;
  }

  /** The other half of `confirmPick`: once the pick has landed -- for a
   * server, once the load it starts has settled -- or its switch request
   * failed, which leaves the previous choice, the customer is connected
   * again, as the confirmation said. The connect runs from the render the
   * count lands in, so it dials the new pin. A press of the customer's own
   * meanwhile cancels it (`handleConnectToggle`). */
  function connectAfterSwitch() {
    if (!connectAfterSwitchRef.current) return;
    connectAfterSwitchRef.current = false;
    setSwitchConnect((n) => n + 1);
  }
  useEffect(() => {
    if (switchConnect === 0) return;
    if (connectionStateRef.current !== "disconnected") return;
    void handleConnectToggle("connect");
    // Once per landed switch; the handler is this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchConnect]);

  /** "Try another location" and the tray's change button: the panel beside
   * the hero, flashed and with its current row focused, or the sheet on a
   * phone-sized window. */
  function showLocations() {
    if (view !== "overview") setView("overview");
    if (layout === "narrow") {
      setShowLocationPicker(true);
      return;
    }
    setPanelFlash((n) => n + 1);
    requestAnimationFrame(() => {
      const row =
        document.querySelector<HTMLElement>('.nx-panel .nx-row[tabindex="0"]') ??
        document.querySelector<HTMLElement>(".nx-panel .nx-row");
      row?.focus();
    });
  }

  /** "Locations" in the nav, and "Open the full list" in the panel's menu:
   * the Locations page. */
  function openLocationsPage(section?: "explain") {
    setShowLocationPicker(false);
    setLocSection(section);
    setView("locations");
  }

  /** From another page of the shell to the main page, or to its Locations
   * page: the page goes and the view comes in one change, animated as a
   * change of page is (lib/view-transition.ts) -- never two transitions,
   * the second cutting the first short. */
  function showMainFrom(next: "overview" | "locations") {
    swapView(() => {
      setShowLocationPicker(false);
      if (next === "locations") setLocSection(undefined);
      viewRef.current = next;
      setViewNow(next);
      onShowMain?.();
    }, "back");
  }

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    // The sign-out's teardown is not a drop. The session generation the
    // episode checks moves too, inside `logout()`; this is the earlier,
    // cheaper half, for a reconnect waiting between attempts.
    autoReconnect.cancel("signedOut");
    // A connect still walking its protocols stops here rather than
    // bringing the next one up after the teardown has run. The session
    // generation catches the same case from outside this screen; this
    // is the cheaper half, for the pass this screen can reach.
    cancelRef.current = true;
    // `logout()` takes the tunnel down before it deletes anything --
    // see endCustomerSession. That used to be the other way round: the
    // credentials were cleared here first and the tunnel never, so the
    // sign-in screen appeared over a connection that was still carrying
    // traffic. The credentials still go, after the tunnel, and whatever
    // the server said.
    await logout();
    onLoggedOut();
  }

  /** The route this screen should name.
   *
   * While nothing is up this is the pinned choice, which is what a
   * connect will dial first; once an engine is up it is the route the
   * ladder actually settled on. Both halves exist because the tile got
   * each of them wrong in turn -- naming a route the app had stopped
   * dialling, and then naming a pin the ladder had walked past. See
   * `displayedRoute`, which holds the decision so the two clients cannot
   * drift and so it can be tested without an unreachable server. */
  const currentRoute = useMemo(
    () => displayedRoute(routes, connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed),
    [routes, protocolUser, chosenRouteId, connectionState, tunnelNamed],
  );
  /** The same route, by id, for the location picker's "current" row, and
   * its protocol for the PROTOCOL tile. Both used to read the credential
   * the screen holds, which after an automatic switch is the one the
   * session ended on: the idle screen then named a protocol, and marked a
   * row, that Connect does not dial first. See `displayedProtocol`. */
  const screenRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed);
  const shownProtocol = displayedProtocol(connectionState, protocolUser, chosenRouteId, protocolUsers, routes, tunnelNamed);
  /** Nothing pinned and no settled tunnel yet: the honest name for the
   * next connect's server is "Automatic", not whichever route happens to
   * be provisioned. */
  const automaticPending = showsAutomatic(connectionState, chosenRouteId);

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
  //
  // Between an automatic reconnect's attempts the press is the
  // customer's own connect, now, and says so.
  const press = pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true });
  // The same discipline for the headline: one table, one render. "VPN
  // connection lost" is this screen's own word at the drop, or the
  // episode's once it has stopped without a tunnel; "Reconnecting..."
  // while one runs.
  const headline = headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect, sessionGeneration()), customMode: splitTunnelActive, reconnecting, unconfined: ipv4NotConfined, waitingForNetwork });

  // Only for the first load of a session, and only on the main page: a page
  // of the shell opened before it ends (Plans, after a sign-up through the
  // backup route) is drawn in the shell meanwhile, and a return from one
  // never meets this -- the screen stayed mounted under it, loaded.
  if (loading && onMainPage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 pt-8">
        <div className="animate-breathe">
          <Logo />
        </div>
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        {loadingLong ? (
          <p className="max-w-xs px-6 text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p>
        ) : null}
      </div>
    );
  }

  // --- The Pearl Glass main page (design-system.md, sections 3 and 4) ---
  //
  // Every fact below comes from the tables above it -- `headlineFor`,
  // `pressFor` and the held look (`orbState`, `cautionShown`) -- through
  // lib/hero-model.ts. The words change at once; the colour the screen
  // wears is the calm tone, held through a short gap.
  const gaming = appMode === "gaming";
  const dropped = tunnelDropped || reconnectLost(reconnect, sessionGeneration());
  /** The colour the status chip, the ambient glow and the sentence wear:
   * the control's own held tone (`orbTone(orbState, cautionShown)`), and
   * the two the control has no colour for -- a reconnect past its hold,
   * and a drop. */
  const calmTone: ShownTone = gaming
    ? gamingTone
    : shownTone(orbTone(orbState, cautionShown), { reconnecting: reconnecting !== null, dropped });
  const chip = chipFor(connectionState, headline, { teardownShowing: slotTeardownShowing });
  const line = lineFor(connectionState, headline, { connectedAt, teardownShowing: slotTeardownShowing });
  const lineWords = t(line.kind === "words" ? line.key : headline.title);
  const pill = pillFor(connectionState, press, {
    pressed,
    waitingForNetwork,
    teardownShowing: slotTeardownShowing,
    failed: connectionError !== null,
  });
  const secondary = secondaryFor(press, {
    reconnecting: reconnecting !== null,
    failed: connectionError !== null,
    teardownShowing: slotTeardownShowing,
  });
  /** The reconnect hold, in the gap it is for: the sentence under the
   * state while it holds (the internet is not going out "without
   * Neoxify" then, and saying so would be false), a note when it should
   * and does not (`holdNote`). */
  const holdSetting = holdWanted(prefs.blockWhileReconnecting);
  const heldNotes = holdNotes(hold, { inGap: reconnecting !== null || dropped, setting: holdSetting });
  // A pass waiting for a network under the hold is a reconnect's gap too:
  // its headline's "your traffic is not protected" would be false. Only in
  // the gap itself: over a tunnel that is up -- a reconnect's attempt that
  // has landed, before its episode ends -- the headline's own sentence
  // stands, whatever the hold's last word.
  const heldHint = isTunnelUp(connectionState)
    ? null
    : holdHint(hold, { reconnecting: reconnecting !== null || waitingForNetwork, dropped, setting: holdSetting, wordLate: holdWordLate });
  const hintText = slotTeardownShowing
    ? ""
    : connectionError
      ? t(connectionError.messageKey)
      : heldHint === "pending"
        ? ""
        : heldHint !== null
          ? t(heldHint)
          : t(headline.hint);
  /** Every sentence the hint can say, for the room it keeps: the hold's
   * only where the setting can make it say them. */
  const hintReserve: readonly HintKey[] = holdSetting ? [...HEADLINE_HINTS, ...HOLD_HINTS] : HEADLINE_HINTS;
  const slotShowing = slotNotice !== null && slotNoticeShown(slotNotice, connectionState === "disconnected");
  /** The device limit's card carries its own primary press ("Use on this
   * device instead") and its way out: with nothing up, the pill steps aside
   * for it rather than offering a second Connect beside it. */
  const slotChoice =
    slotShowing &&
    slotNotice !== null &&
    connectionState === "disconnected" &&
    (() => {
      const copy = describeSlotNotice(slotNotice, { t, language, tunnelDown: true });
      return copy.useHere !== null || copy.dismiss !== null;
    })();
  const busy = pill.progress;

  // The tray's facts. A pinned server's place, Automatic until a tunnel has
  // settled with nothing pinned, and the protocol the next connect dials.
  const protocolName = shownProtocol ? customerProtocolLabel(shownProtocol.protocol, shownProtocol.transport) : null;
  const landedAutomatically = !chosenRouteId && !automaticPending;
  const trayLocation: TrayLocation = gaming
    ? {
        flag: (
          <span className="nx-flagbox auto">
            <Gamepad2 aria-hidden />
          </span>
        ),
        name: t("gaming.games"),
        sub: gamingSummary
          ? t("tr.gamesChosen", { n: formatNumber(gamingSummary.picked, language) }) +
            (gamingSummary.resolver ? ` · ${t("gaming.resolver")} ${gamingSummary.resolver}` : "")
          : null,
        onChange: onOpenSettings,
      }
    : {
        flag: automaticPending ? (
          <span className="nx-flagbox auto">
            <Sparkles aria-hidden />
          </span>
        ) : currentRoute ? (
          <RouteFlag
            region={routePlace(currentRoute).entry}
            exitRegion={routePlace(currentRoute).exit}
            label={placeLabel(currentRoute, language)}
            size="lg"
          />
        ) : (
          <Globe className="size-5 text-ink-2" aria-hidden />
        ),
        name: automaticPending ? t("loc.automaticShort") : currentRoute ? placeLabel(currentRoute, language) : "—",
        sub: automaticPending
          ? null
          : landedAutomatically && protocolName
            ? `${t("loc.automaticShort")} · ${protocolName}`
            : protocolName,
        onChange: subscription ? showLocations : undefined,
      };

  const usedFraction = usage && usage.cap !== null ? usage.used / usage.cap : null;
  const caution = planCaution(usedFraction, daysLeft);
  const used = sizeParts(usage ? usage.used : Number(subscription?.dataUsedBytes ?? 0), language);
  const trayPlan: TrayPlan | null = subscription
    ? {
        label: usage && usage.cap === null ? t("tr.planUnl") : t("dash.dataUsed"),
        value: (
          <>
            {used.value}
            <small>
              {usage && usage.cap !== null
                ? `${used.unit} ${t("tr.ofCap", { cap: formatSize(usage.cap, language) })}`
                : t("tr.used", { size: used.unit })}
            </small>
          </>
        ),
        meter: usedFraction !== null ? { fraction: usedFraction, caution: caution.meter } : null,
        days:
          daysLeft !== null
            ? {
                text: t(daysLeft === 1 ? "tr.dayLeft" : "tr.daysLeft", { n: formatNumber(daysLeft, language) }),
                caution: caution.days,
              }
            : null,
        // No Renew while Neoxify cannot be reached; "Plans" on a store build.
        renew:
          offlineSince === null
            ? { label: IS_STORE_BUILD ? t("nav.plansStore") : t("tr.renew"), onClick: onBrowsePlans }
            : null,
      }
    : null;
  const ip = ipFor(connectionState, exitIp, { gaming });

  // The world map's lights (lib/map-lights.ts): one per country in the
  // list, twinkling only on evidence that traffic was carried on this
  // network lately -- this device's own verified connects, or the server's
  // per-network tags -- and never on a latency number. Recomputed from the
  // route list, the connect history and the network, which change only
  // when evidence settles (a pass ends, the list arrives), and from the
  // minute, so evidence expires; never per rung of the ladder.
  if (!gaming && connectionState === "connected" && currentRoute) verifiedRouteRef.current = currentRoute;
  // The arc's route: the pin while nothing has settled, the route the
  // tunnel settled on once one has.
  const settledNow = connectionState === "connected" || connectionState === "unverified" || connectionState === "degraded";
  const arcRoute = gaming ? null : settledNow ? currentRoute : chosenRouteId ? (routes.find((r) => r.id === chosenRouteId) ?? null) : null;
  // The verified place holds through a brief gap, as the chip's colour
  // does -- but not once the tunnel has settled somewhere else: a
  // reconnect that landed unconfirmed on France while the hold ran would
  // otherwise keep "your verified connection leaves from" on Germany.
  const verifiedShown =
    gaming || (settledNow && verifiedRouteRef.current?.id !== currentRoute?.id) ? null : verifiedRouteRef.current;
  // Evidence about the network the device is on now: after a roam, this
  // device's history and the list's tags wait to be read again
  // (`lib/map-network.ts`).
  const mapRoutes = tagsCurrent(netFresh) ? routes : withoutTags(routes);
  const evidenceCtx: EvidenceContext = { history, network: mapNetwork(networkId, netFresh), now: Math.floor(now / 60_000) * 60_000 };
  const mapScene = mapLights({
    routes: mapRoutes,
    ...evidenceCtx,
    verified: verifiedShown,
    tone: calmTone,
    shown: arcRoute,
    up: gaming || !settledNow ? null : currentRoute,
  });
  const mapPlaces = mapCountries(routes);
  // What the list says beside each place, from the same evidence.
  const workedPlaces = new Set<string>();
  for (const [key, evidence] of placesEvidence(mapRoutes, evidenceCtx)) if (evidence.look === "live") workedPlaces.add(key);
  const listEvidence = {
    places: placesEvidence(mapRoutes, evidenceCtx),
    worked: workedPlaces,
    ownAt: (route: RouteOption) => ownWorkedAt(route, evidenceCtx),
    tags: tagsCurrent(netFresh),
  };

  // The sidebar's line under the email (`planLineText`): the days left,
  // then "Unlimited" when the plan has no cap.
  const shellPlan: ShellPlan | null = subscription ? { daysLeft, unlimited: Boolean(usage && usage.cap === null) } : null;
  const planLine = planLineText(shellPlan, t, language);

  // The mode switch: refused while a tunnel is up, as the location list
  // once was -- a mode cannot be retrofitted onto a live session -- and
  // saying why rather than doing nothing. Its line says what the chosen
  // half does, conditionally while nothing is up: never a present-tense
  // claim about a tunnel that is not there.
  const modeHint =
    appMode === "gaming"
      ? t("mode.gamingHintShort")
      : (isTunnelUp(connectionState) ? splitTunnelActive : customConfigured)
        ? t(customExcept ? "dash.modeCustomExceptHint" : "dash.modeCustomHint")
        : !isTunnelUp(connectionState)
          ? t("mode.vpnHintIdle")
          : // Beside the warning that some connections go around a
            // tunnel not confined, not contradicting it.
            t(isTunnelUp(connectionState) && ipv4NotConfined ? "dash.modeVpnHintNotConfined" : "dash.modeVpnHint");
  const modeBar = subscription ? (
    <div className="nx-modebar">
      <Segmented
        label={t("mode.label")}
        value={appMode}
        onChange={(value) => void changeMode(value)}
        locked={connectionState !== "disconnected"}
        lockedReason={t("mode.locked")}
        options={[
          { value: "vpn", label: t("dash.modeVpn"), icon: <Shield aria-hidden /> },
          { value: "gaming", label: t("dash.modeGaming"), icon: <Gamepad2 aria-hidden /> },
        ]}
      />
      {/* Clamped to two lines beside the hero; the whole sentence is the title. */}
      <p className="nx-modehint" title={modeHint}>
        {modeHint}
      </p>
    </div>
  ) : null;

  // What only applies while a tunnel is up, below the button. Red only for
  // real leaks, always in the column; the informational lines fold behind
  // a counted disclosure (MainView), or into the summary's sheet on a phone.
  const details: ReactNode[] = [];
  if (isTunnelUp(connectionState) && splitTunnelActive && !splitTunnelProblem) {
    details.push(<Note key="custom" tone="info">{t("dash.customActive")}</Note>);
  }
  // Only when the service reports the block installed -- never derived
  // from the protocol. Not in Custom mode, whose line says what happens
  // to IPv6 there.
  if (isTunnelUp(connectionState) && !splitTunnelActive && ipv6Blocked) {
    details.push(<Note key="v6" tone="info">{t("dash.fullTunnelIpv6Blocked")}</Note>);
  }
  // Not an error: the customer has simply got less than they would assume
  // from silence. The list is the service's; the sentence is local.
  if (restartNeeded.length > 0) {
    details.push(
      <Note key="restart">
        {t("dash.splitTunnelRestartNeeded", { apps: restartNeeded.join(language === "fa" ? "، " : ", ") })}
      </Note>,
    );
  }
  const notes = (
    <div className="nx-notes">
      {/* From the service's counters on the path the chosen apps' packets
          travel -- on and working are not the same thing -- in the app's
          words for its code (lib/custom-mode-problem.ts). */}
      {isTunnelUp(connectionState) && splitTunnelActive && splitTunnelProblem ? (
        <Note tone="danger">{customModeProblemText(splitTunnelProblem, t)}</Note>
      ) : null}
      {/* IPv6 observed reaching the internet while connected. Not in
          Custom mode, where the probe sees only this app's own, direct,
          traffic -- see `showsIpv6Escape`. */}
      {showsIpv6Escape(connectionState, { customMode: splitTunnelActive, escaping: ipv6Escaping }) ? (
        <Note tone="danger">{t("dash.ipv6Escaping")}</Note>
      ) : null}
      {/* The tunnel is up and name lookups are not pinned to it: shown
          rather than refused, for someone who may have no other protocol
          that works. */}
      {isTunnelUp(connectionState) && tunnelDnsUnprotected ? <Note tone="danger">{t("dash.tunnelDnsUnforced")}</Note> : null}
      {/* This computer's other IPv4 connections are not held to the
          tunnel. In Built-in's own words on IKEv2 (`unconfinedLine`).
          Never in Custom mode or on WireGuard (`warnsUnconfined`). */}
      {isTunnelUp(connectionState) && ipv4NotConfined ? (
        <Note tone="danger">{t(unconfinedKey)}</Note>
      ) : null}
      {/* The reconnect hold should be blocking and is not, or let go so a
          new tunnel could carry: the service's own reason, in words. */}
      {heldNotes
        .filter((note) => note !== "hold.holding")
        .map((note) => (
          <Note key={note} tone={note === "hold.tunnelNotPermitted" ? "info" : "caution"}>
            {t(note)}
          </Note>
        ))}
    </div>
  );

  // The way out of a failed connect: the raw engine text out of the way,
  // and the repair offered only where a repair of this machine could help
  // -- never for a plan's limit or state. Reserved for real errors.
  const errorBlock = (
    <>
      {/* The device limit ended this session and the tunnel is not
          confirmed down yet: said, and kept while the recheck tries. */}
      {slotTeardownState === "stuck" ? <Note tone="danger">{t("slots.teardownStuck")}</Note> : null}
      {connectionError ? (
        <div className="flex flex-col items-start gap-1">
          <details className="nx-errdetail">
            <summary>{t("err.showDetail")}</summary>
            <p data-ltr>{connectionError.detail}</p>
          </details>
          {NOT_THE_NETWORK.has(connectionError.kind) ? null : <RepairNetwork variant="inline" />}
        </div>
      ) : null}
    </>
  );

  // The banner at the top of the hero: the update notice on a narrower
  // window, the offline notice, and a plan that has stopped working. Each
  // neutral: the customer can still act.
  const banner = (
    <>
      {update ? <div className="nx-upd-hero">{update}</div> : null}
      {/* Each rises in when it is needed and fades when it is not
          (Presence): none of them says anything about the tunnel. */}
      <Presence show={Boolean(error)}>
        {error ? (
          <Banner title={error === "loadFailed" ? t("dash.loadFailed") : failureText(error, t)}>
            <PillButton variant="ghost" size="sm" className="mt-2 self-start" onClick={() => void loadAll()}>
              {t("dash.retry")}
            </PillButton>
          </Banner>
        ) : null}
      </Presence>
      {/* The numbers on screen are old, and connecting still works. */}
      <Presence show={offlineSince !== null}>
        {offlineSince !== null ? (
          <Banner>
            {offlineText(offlineReason, t).title !== null ? (
              <b>{offlineText(offlineReason, t).title}</b>
            ) : null}
            {offlineText(offlineReason, t).detail !== null ? <span>{offlineText(offlineReason, t).detail}</span> : null}
            <span>{t("dash.offlineHint", { when: formatDateTime(offlineSince, language) })}</span>
          </Banner>
        ) : null}
      </Presence>
      <Presence show={Boolean(endedState)}>
        {endedState ? (
          <Banner title={t(endedState.titleKey)}>
            <span>{t(endedState.bodyKey)}</span>
            {endedState.showPlansButton ? (
              <PillButton size="sm" className="mt-2 self-start" onClick={onBrowsePlans}>
                {t("dash.renewCta")}
              </PillButton>
            ) : null}
          </Banner>
        ) : null}
      </Presence>
    </>
  );
  const bannerShowing = Boolean(error || offlineSince !== null || endedState);
  /** A message the customer must read: the compact window's band of lights,
   * and a phone's map, give way to it. */
  const mapAlert = bannerShowing || slotShowing || connectionError !== null;
  /** Medium and phone windows: the map in the hero's column. */
  const mapStage =
    layout !== "wide" ? (
      <WorldMap host="stage" lights={mapScene.lights} arc={mapScene.arc} countries={mapPlaces} alert={mapAlert} />
    ) : null;

  /** The list's row in use and its words, held through a brief gap with
   * the chip's colour, the button's fill and the map's light: "Connected
   * here" stays on the row the session settled on until the hold ends
   * (`heldListLook`). */
  if (settledNow) listSettledRef.current = screenRouteId;
  const listLook = heldListLook({ state: connectionState, look: orbState, routeId: screenRouteId, settledRouteId: listSettledRef.current });

  // The one location list: the panel beside the hero, or a sheet on a
  // phone-sized window. One element either way.
  const picker = subscription ? (
    <LocationPicker
      subscriptionId={subscription.id}
      // What the tray names: the pin while nothing is up, the route the
      // tunnel is on once one is (`screenRouteId`), held through a brief
      // gap (`listLook`).
      currentRouteId={listLook.routeId ?? undefined}
      lookState={listLook.state}
      // Latency cannot be measured from inside the tunnel; anything but
      // "disconnected" means routes are installed.
      tunnelActive={connectionState !== "disconnected"}
      // As it changes, for the report on a list nothing answered.
      connectionState={connectionState}
      // Already loaded here, so the list shows real content at once.
      initialRoutes={routes}
      // And what its own request is answered with comes back here.
      onRoutes={adoptPickerRoutes}
      // Nothing pinned is Automatic, and it is what a new install starts
      // on. Choosing it clears the pin on this device; no server call.
      automatic={!chosenRouteId}
      // The pick, as it is made: a reconnect under way ends there, not
      // once a server's switch request has answered.
      onPicking={(routeId) => {
        if (routeId !== null) setSwitchInFlight(true);
        pickingLocation(routeId);
      }}
      // A switch that failed chose nothing: the reconnect leads with what
      // it led with before the pick.
      onPickFailed={() => {
        setSwitchInFlight(false);
        autoReconnect.pickFailed();
        switchLoadSettled();
        connectAfterSwitch();
      }}
      onChooseAutomatic={() => {
        // A new choice while a reconnect waits ends the reconnect: its
        // next attempt would lead with the old route regardless.
        chooseLocation(null);
        setChosenRouteId(null);
        void saveChosenRoute(null);
        connectAfterSwitch();
      }}
      onClose={() => {
        setShowLocationPicker(false);
        // A pick on the Locations page lands on the main page, where the
        // connection's state is said.
        setView("overview");
      }}
      // Re-reads the provisioned connection rather than adopting the
      // switch response directly: that payload carries no `connection`.
      onSwitched={(routeId) => {
        setSwitchInFlight(false);
        // As for Automatic, above.
        const shown = chooseLocation(routeId ?? null);
        // Their choice leads the order; it does not disable failover.
        setChosenRouteId(routeId ?? null);
        // Persisted, so the pin outlives the process.
        void saveChosenRoute(routeId ?? null);
        // Passed explicitly: the state set above has not landed yet when
        // loadAll reads it. Over a tunnel that stays up, the route it is
        // on.
        //
        // The connect a confirmed switch owes waits for this load, as the
        // customer's own press used to: it takes the screen to "Loading..."
        // (seconds on a filtered network), where a ladder dialling beneath
        // would have no state, no chip and no Stop on screen -- and the
        // load's answer would put the chosen credential back over the
        // candidate the ladder had moved on to.
        void loadAll(shown ?? undefined).finally(connectAfterSwitch);
        // Begun: the wait for it is over, and nothing in the background
        // starts beside it.
        switchLoadSettled();
      }}
      evidence={listEvidence}
      variant={view === "locations" ? "page" : layout === "narrow" ? "sheet" : "panel"}
      confirmPick={confirmPick}
      onOpenFull={openLocationsPage}
      focusSection={view === "locations" ? locSection : undefined}
    />
  ) : null;

  const actions = protocolUser ? (
    <div className="nx-actions">
      <ConnectOrb
        state={orbState}
        caution={cautionShown}
        // The action travels with the press, decided in the same render
        // as the label on it (`pressFor`).
        onToggle={() => void handleConnectToggle(press.action)}
        label={t(pill.labelKey)}
        // "Connecting..." stops the connect when pressed: said so to
        // assistive technology, which would otherwise hear only the label.
        pressLabel={press.action === "cancelConnect" ? t("btn.stop") : undefined}
        look="pill"
        pill={pill}
      />
      {/* The way out of an automatic reconnect that is not the pill: the
          pill between attempts connects now, and during one stops only
          that pass. This stops the reconnecting itself. */}
      {secondary === "stopReconnecting" ? (
        <WayOut label={t("dash.reconnectStop")} short={t("btn.stopShort")} onClick={() => void stopReconnecting()} />
      ) : secondary === "stopConnecting" ? (
        <WayOut label={t("btn.stop")} short={t("btn.stopShort")} onClick={() => void handleConnectToggle(press.action)} />
      ) : secondary === "tryAnother" && subscription ? (
        <WayOut label={t("btn.tryAnother")} short={t("btn.tryAnotherShort")} onClick={showLocations} />
      ) : null}
    </div>
  ) : subscription ? (
    <p className="nx-hint">{t("dash.noProvision")}</p>
  ) : (
    // No subscription: a dead end no longer -- the way to get one.
    <div className="nx-actions">
      <PillButton onClick={onBrowsePlans}>{t("dash.viewPlans")}</PillButton>
    </div>
  );

  // The state in words for a screen reader, once it has settled.
  const announcement = gaming ? "" : `${lineWords}. ${hintText}`;

  // What the other pages of the shell show under the avatar.
  rememberShellProfile({ email: me?.email ?? null, plan: shellPlan, network: evidenceCtx.network });

  // One shell for the main page and every other page of it: the sidebar,
  // the tabs and the phone's nav stay mounted across a change of page, and
  // so does this screen under a page (`page`). A page wears the quiet look
  // the pages always had: no tone, no sweep, no banner's room.
  return (
    <AppShell
      active={page ? page.nav : view === "locations" ? "locations" : "overview"}
      shown={page ? "idle" : calmTone}
      busy={page ? false : busy}
      banner={page ? false : bannerShowing}
      titlebar
      email={me?.email ?? null}
      planLine={planLine}
      onOverview={() => {
        if (page) showMainFrom("overview");
        else if (view !== "overview") setView("overview");
        else document.querySelector<HTMLElement>(".nx-hero")?.scrollTo({ top: 0 });
      }}
      onLocations={() => (page ? showMainFrom("locations") : openLocationsPage())}
      onOpenActivity={onOpenActivity ?? onOpenSettings}
      onOpenSettings={onOpenSettings}
      onBrowsePlans={onBrowsePlans}
      onOpenReferrals={onOpenReferrals}
      onOpenSupport={onOpenSupport}
      onSignOut={() => void handleLogout()}
      signingOut={signingOut}
      update={
        <>
          {update}
          <CommunityLinks />
        </>
      }
      scene={
        // A page speaks for no route: no lights behind the Locations page,
        // or behind any other page of the shell.
        page || view === "locations" ? (
          <PageScene />
        ) : (
          <HeroArt tone={calmTone} layout={layout} map={mapScene} countries={mapPlaces} alert={mapAlert} />
        )
      }
    >
      {page ? (
        <Fragment key={page.key}>{page.node}</Fragment>
      ) : view === "locations" ? (
        <Page title={t("loc.panelTitle")} lede={t("loc.pageLede")} className="nx-locpg">
          {picker ?? <p className="nx-csub">{t("dash.noPlanHint")}</p>}
        </Page>
      ) : gaming && subscription && !error ? (
        <MainView
          banner={banner}
          gaming={
            /* Its own hero, not a re-labelled tunnel one: gaming mode
               brings up no tunnel and no adapter, so it has its own five
               states, its own words, and no exit IP. */
            <GamingStatusPanel onOpenSettings={onOpenSettings} onTone={setGamingTone} onSummary={setGamingSummary} />
          }
          modeBar={modeBar}
          locationCard={<LocationCard location={trayLocation} />}
          metrics={<MetricCards plan={trayPlan} ip={ip} />}
          summary={<SummaryLine plan={trayPlan} ip={ip} />}
          mapStage={mapStage}
          tray={<SessionTray label={t("tr.location")} location={trayLocation} plan={trayPlan} ip={ip} />}
        />
      ) : (
        <MainView
          banner={banner}
          chip={error ? null : <StatusChip glyph={chip.glyph} label={t(chip.labelKey)} />}
          line={
            error ? null : (
              <StateLine
                line={line}
                words={lineWords}
                decor={<Decor keys={["decor.browse", "decor.stream", "decor.work", "decor.anywhere"]} />}
              />
            )
          }
          hint={
            error ? null : (
              <Hint tone={hintTone(calmTone, { failed: connectionError !== null })} reserve={hintReserve}>
                {hintText}
              </Hint>
            )
          }
          slot={
            slotShowing && slotNotice ? (
              /* The plan's device limit, when it is why this device is not
                 connected: where Neoxify is in use, and the one press that
                 moves it here. "Disconnected:" waits for the service. */
              <DeviceSlotCard
                notice={slotNotice}
                tunnelDown={connectionState === "disconnected"}
                onUseHere={(takeover) => void connectNow(takeover)}
                onDismiss={() => setSlotNotice(null)}
              />
            ) : undefined
          }
          subline={
            // Which protocol, and where, when it is not the one set out
            // for. Neutral: it is information, not a fault. Which sentence
            // depends on whether the server on screen was ever dialled
            // (`failoverText`).
            isTunnelUp(connectionState) && failedOverTo
              ? (() => {
                  const said = failoverText(failedOverTo);
                  return (
                    <p className="nx-subline">
                      <Repeat aria-hidden />
                      <span>
                        <Slotted text={t(said.key, { ...said.vars, protocol: SLOT })}>
                          <bdi className="font-medium text-ink">{said.vars.protocol}</bdi>
                        </Slotted>
                      </span>
                    </p>
                  );
                })()
              : !isTunnelUp(connectionState)
                ? // The ladder's rung, the reconnect's attempt and countdown,
                  // and why it is connecting when nobody pressed.
                  <ProgressLine routes={routes} autoConnecting={autoConnecting} />
                : null
          }
          // A failover that crossed a border says why the exit is not the
          // country chosen: a phone keeps it in the column.
          sublineStays={Boolean(failedOverTo?.fromRegion)}
          actions={error || slotChoice ? null : actions}
          error={errorBlock}
          notes={notes}
          details={details}
          modeBar={modeBar}
          locationCard={subscription ? <LocationCard location={trayLocation} /> : null}
          metrics={subscription ? <MetricCards plan={trayPlan} ip={ip} speed={trafficShown ? <SpeedCard /> : undefined} /> : null}
          summary={subscription ? <SummaryLine plan={trayPlan} ip={ip} /> : null}
          panel={layout !== "narrow" ? picker : null}
          panelLabel={t("loc.panelTitle")}
          panelFlash={panelFlash}
          legend={routes.length > 0 ? <MapLegend /> : null}
          mapStage={mapStage}
          tray={
            <SessionTray
              label={t("tr.location")}
              location={trayLocation}
              plan={trayPlan}
              ip={ip}
              // Download and upload, only while Windows' counters for the
              // tunnel are being read (lib/traffic-meter.ts).
              speed={trafficShown ? <SpeedSection /> : undefined}
            />
          }
          announcer={<StateAnnouncer text={announcement} />}
        />
      )}

      {layout === "narrow" && view === "overview" && !page ? (
        <LocationSheet
          open={showLocationPicker && subscription !== null}
          title={t("loc.panelTitle")}
          closeLabel={t("loc.close")}
          onClose={() => setShowLocationPicker(false)}
          dismissible={!switchInFlight}
        >
          {picker}
        </LocationSheet>
      ) : null}

      <Dialog
        open={switchAsk !== null}
        title={
          switchAsk?.place
            ? t("sw.title", { place: switchAsk.protocol ? `${switchAsk.place} · ${switchAsk.protocol}` : switchAsk.place })
            : t("sw.titleAuto")
        }
        description={t("sw.body")}
        onClose={() => switchAsk?.resolve(false)}
        initialFocus={stayRef}
        actions={
          <>
            <PillButton ref={stayRef} variant="ghost" size="sm" onClick={() => switchAsk?.resolve(false)}>
              {switchAsk?.tunnelUp ? t("sw.stay") : t("btn.cancel")}
            </PillButton>
            <PillButton size="sm" onClick={() => switchAsk?.resolve(true)}>
              {t("sw.go")}
            </PillButton>
          </>
        }
      />
    </AppShell>
  );
}
