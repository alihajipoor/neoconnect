import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronRight,
  Clock,
  Globe,
  MapPin,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Tag,
} from "lucide-react";
import { displayedRoute, showsAutomatic } from "@shared/lib/displayed-route";
import {
  ispTagsOf,
  lastGoodFor,
  rememberLastGood,
} from "@shared/lib/failover";
import { recordAttempt } from "@shared/lib/connect-history";
import {
  loadConnectHistory,
  loadLastGood,
  saveConnectHistory,
  saveLastGood,
} from "@shared/lib/failover-store";
import { probeCandidates } from "@shared/lib/reachability";
import { networkKeyFromAsn } from "@shared/lib/network-identity";
import { createSessionTracker } from "@shared/lib/session-report";
import {
  getAvailableRoutes,
  getMe,
  getProtocolUsers,
  getSubscriptions,
} from "@shared/lib/customer";
import { logout } from "@shared/lib/auth";
import type {
  Customer,
  ProtocolUser,
  RouteOption,
  Subscription,
} from "@shared/lib/types";
import { formatBytes } from "@shared/lib/utils";
import { IS_STORE_BUILD } from "@shared/lib/distribution";
import { iapAvailable } from "@shared/lib/iap";
import { endedNotice } from "@shared/lib/subscription-state";
import { customerProtocolLabel } from "@shared/lib/protocol-labels";
import { askedAroundTunnel, type BaselineIp, type TunnelServer } from "@shared/lib/egress";
import { tunnelServerOf } from "@shared/lib/tunnel-server";
import {
  classifyConnectionError,
  type ClassifiedError,
} from "@shared/lib/connection-errors";
import { orderCandidates } from "@shared/lib/failover";
import { Button, Card, Stat } from "@shared/components/ui";
import {
  ConnectOrb,
  type ConnectionState,
} from "@shared/components/ConnectOrb";
import { Logo } from "@shared/components/Logo";
import { Flag } from "@shared/components/Flag";
import { LocationPicker } from "@shared/components/LocationPicker";
import { Sheet } from "@shared/components/Sheet";
import { CommunityLinks } from "@shared/components/CommunityLinks";
import { useI18n } from "@shared/lib/i18n";
import { sessionGeneration } from "@shared/lib/session-end";
import {
  loadSnapshot,
  saveSnapshot,
} from "@shared/lib/credential-cache";
import { refreshConnectionConfig } from "@shared/lib/connection-config";
import { useRefreshOnResume } from "@shared/lib/resume";
import {
  failedDial,
  outcomeFromError,
  reportAttempt,
  rungsFrom,
  type Dial,
} from "@shared/lib/attempts";
import {
  createSlotTeardown,
  deviceSlot,
  slotNoticeStore,
  slotStop,
  slotTeardown,
  slotTeardownShown,
  type SlotStop,
  type SlotStopReason,
} from "@shared/lib/device-slot-session";
import { DeviceSlotCard } from "@shared/components/DeviceSlotCard";
import {
  asReconnectReport,
  autoReconnect,
  reconnectingView,
  reconnectLost,
  reconnectOutcomeOf,
  vouching,
  type ReconnectAttempt,
  type ReconnectStop,
} from "@shared/lib/auto-reconnect";
import { headlineFor, type HeadlineTone } from "@shared/lib/connection-evidence";
import { pressFor } from "@shared/lib/connect-intent";
import { droppedWhileAway, reconnectPreflight } from "../lib/reconnect-steps";
import {
  claimWhileRefreshing,
  renewInForeground,
  slotTeardownAttempt,
  whenForegrounded,
} from "../lib/device-slot-steps";
import { loadAllowedApps } from "../lib/per-app";
import { protocolSupported } from "../lib/platform";
import {
  connectIkev2,
  connectWireGuard,
  connectXray,
  disconnect,
  forgetProfiles,
  tunnelGone,
  hasVpnPermission,
  requestVpnPermission,
  vpnStatus,
} from "../lib/vpn";
import {
  buildXrayConfig,
  isXrayProtocol,
  TUN_DNS,
  TUN_MTU,
} from "../lib/xray-config";
import { loadChosenRoute, saveChosenRoute } from "../lib/route-preference";
import {
  confirmEgress,
  nodeAddressesOf,
  pollEgress,
  pollState,
  rejectionIsEvidence,
  rungOutcome,
  stateFromStatus,
  takeBaseline,
  tunnelUp,
} from "../lib/tunnel-evidence";

/** The Android dashboard.
 *
 * Deliberately a sibling of the Windows client's rather than a copy of
 * it: the two screens show the same things and reuse the same components,
 * but every line that touches the tunnel differs. Windows drives a
 * privileged service that owns adapters and the routing table; Android
 * drives one VpnService that owns a single file descriptor and needs the
 * customer's consent before it may exist at all.
 *
 * What is *not* different, and must not become different, is the standard
 * of evidence. "Connected" here means the same thing it means there --
 * traffic was proven to leave through the tunnel -- because a VPN client
 * that says connected when it is not is the one bug that actually harms
 * the person using it.
 */
const HEALTH_POLL_MS = 15_000;

// What a status, an egress reading or a ladder rung entitles this screen
// to say lives in ../lib/tunnel-evidence, where it is tested.

/** How a ladder pass ended, for the automatic reconnect: see
 * `reconnectOutcomeOf`. "unusable" is a plan with nothing this build
 * can dial. */
type LadderOutcome = "connected" | "failed" | "refused" | "cancelled" | "unusable";

/** The headline's colour for each tone `headlineFor` asks for. Full class
 * names, so the stylesheet build can see them. */
const HEADLINE_TONE: Record<HeadlineTone, string> = {
  success: "text-success",
  highlight: "text-highlight",
  warning: "text-warning",
  muted: "text-muted-foreground",
  plain: "text-foreground",
  destructive: "text-destructive",
};

/** How long to wait for the device to stop being routed through a VPN
 * before telling the customer the disconnect did not finish.
 *
 * A ceiling, not a delay: this is polled twice a second and the orb
 * flips the moment the tunnel is gone, which on the emulator is inside
 * a second now that the engine process is not allowed to sit on the
 * descriptor. Eight seconds is headroom for a slower phone, and long
 * enough that the warning means something when it does appear. */
const TEARDOWN_WAIT_MS = 8_000;
const TEARDOWN_POLL_MS = 500;

/** Waits for the tunnel to actually be gone.
 *
 * The disconnect call returns as soon as every engine has been told to
 * stop, which is not the same as the device being out of the tunnel --
 * and announcing "disconnected" at that moment is what left customers
 * looking at an app that claimed to be off while their traffic still
 * went into it. */
async function waitForTeardown(): Promise<boolean> {
  const deadline = Date.now() + TEARDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      if (await tunnelGone()) return true;
    } catch {
      // Not knowing is not the same as knowing it is down; keep asking
      // until the deadline rather than assuming either way.
    }
    await new Promise((r) => setTimeout(r, TEARDOWN_POLL_MS));
  }
  return false;
}

/** The subscription worth showing. PENDING and CANCELLED entitle nobody
 * to anything; SUSPENDED and EXPIRED are real subscriptions in a bad
 * state, and hiding those would be its own lie. */
/** The hostname to dial for IKEv2.
 *
 * An error rather than a fallback to `connection.host` when it is
 * missing. Android checks the server's certificate against the address
 * it dialled and offers no way to set the remote identity separately,
 * so the IP fails on the certificate -- at the end of a slow
 * negotiation, with a message that says nothing about the real cause.
 * Failing here is both faster and legible.
 */
function ikev2Server(user: ProtocolUser): string {
  const host = user.connection?.publicParams?.endpointHost;
  if (typeof host !== "string" || host.length === 0) {
    throw new Error(
      "This server has no hostname recorded, and IKEv2 cannot be dialled by address.",
    );
  }
  return host;
}

function usableSubscription(all: Subscription[]): Subscription | null {
  const real = all.filter(
    (s) => s.status !== "PENDING" && s.status !== "CANCELLED",
  );
  return real.find((s) => s.status === "ACTIVE") ?? real[0] ?? null;
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Which credentials this build can actually connect with.
 *
 * Four of the five the platform sells. Offering a customer a protocol
 * whose engine is not in the APK would fail every time while looking
 * like the server's fault, so the ladder never considers one.
 *
 * OpenVPN is the omission, and it is a licensing decision rather than an
 * unfinished one: the usable Android OpenVPN implementation is GPLv2,
 * which this closed-source app cannot link. Both other engines --
 * WireGuard's tunnel library and xray-core -- are permissively licensed,
 * which is why they are here. */
const SUPPORTED = new Set([
  "WIREGUARD",
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_TROJAN",
  // Carried by the xray-core already in the APK, so it costs nothing to
  // support here -- no second engine, no extra megabytes.
  "SHADOWSOCKS",
  // No engine of ours at all: Android has spoken IKEv2 since 11 and the
  // platform holds the tunnel. It costs the APK nothing, and it is the
  // only protocol here that works on a device where a bundled engine
  // will not load -- which is exactly why some customers ask for it.
  "IKEV2",
]);

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
  const [protocolUsers, setProtocolUsers] = useState<ProtocolUser[]>([]);
  const [chosenRouteId, setChosenRouteId] = useState<string | null>(null);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  /** Counts a session that keeps passing its health checks, once, for the
   * per-ISP tags. See session-report.ts. */
  const sessionTrackerRef = useRef(createSessionTracker());
  /** The route the tunnel is on, for the health poll's interval. */
  const settledRouteRef = useRef<string | null>(null);
  settledRouteRef.current = protocolUser?.routeId ?? null;
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] =
    useState<ClassifiedError | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  /** Set when the customer presses the button during a connect.
   *
   * A ref rather than state because runLadder is one long async call:
   * it captured its own copy of every state value when it started and
   * would never see a later update. Without this the button did nothing
   * at all while a protocol hung in "checking connection", and the only
   * way out was to wait for the timeout -- reported from a real phone.
   */
  const cancelRef = useRef(false);
  const [signingOut, setSigningOut] = useState(false);

  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [exitIp, setExitIp] = useState<string | null>(null);
  const [baselineIp, setBaselineIp] = useState<BaselineIp | null>(null);
  /** Where the connected rung's tunnel is dialled, and whether the phone
   * reaches it around the tunnel, for the health poll: where it does, an
   * endpoint there answers with the phone's own address, so the poll
   * passes it over (`TunnelServer` in the shared egress.ts). Set as each
   * rung is dialled.
   * Lost with the screen, like the baseline -- and with no baseline there
   * is nothing for that mirror's answer to be compared with. */
  const tunnelServerRef = useRef<TunnelServer | null>(null);
  /** Names the protocol actually in use when it is not the one the
   * customer asked for.
   *
   * Not cosmetic. On Windows the absence of this cost five releases of
   * "no matter what I pick it connects as Fast" -- the app was moving
   * them and saying nothing, so a working failover was indistinguishable
   * from a bug. */
  const [failedOverTo, setFailedOverTo] = useState<string | null>(null);
  /** Set when the chosen server's protocol has no engine in this build,
   * so the reason is a missing feature rather than a blocked network. */
  const [unsupportedChoice, setUnsupportedChoice] = useState<string | null>(
    null,
  );
  /** When the shown data was last fetched, if the server could not be
   * reached this time. Null means everything on screen is current. */
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Set when the customer declined Android's VPN consent dialog. Shown
   * rather than swallowed: a refusal looks exactly like a failed connect
   * from the outside, and telling them to check their internet when they
   * pressed Deny is how a product earns a one-star review. */
  const [permissionDenied, setPermissionDenied] = useState(false);
  /** What the plan's device limit has to say, when it is why this phone
   * is not connected: refused before dialling, or taken over by another
   * device. See `deviceSlot`, shared with the Windows client.
   *
   * Kept beside the slot, not in this screen: a claim through the tunnel
   * can be refused while the screen is away in Settings, and the tunnel
   * comes down regardless. The card written then is here on return. */
  const slotNotice = useSyncExternalStore(slotNoticeStore.subscribe, slotNoticeStore.current);
  const setSlotNotice = slotNoticeStore.set;
  /** The teardown the device limit asked for, from the stop until the
   * platform says the tunnel is down: whether one is owed, and whether an
   * attempt has already come back without the tunnel gone. A connect
   * pressed meanwhile -- "Use on this device instead" on the card that
   * teardown put up -- waits for it rather than dialling over a tunnel
   * that is still coming down, and a second slot event joins it rather
   * than starting a second. Beside the slot, like the card; see
   * `slotTeardown`. */
  const slotTeardownState = useSyncExternalStore(slotTeardown.subscribe, slotTeardown.state);
  /** The customer's own teardown -- Disconnect, a stop pressed during a
   * connect, or a tunnel a connect has to clear first -- from the press
   * until the platform says the tunnel is down.
   *
   * The same bookkeeping as the device limit's (one attempt at a time,
   * each bounded, tried again on the poll while it has not finished),
   * kept apart from it because what is said differs: no card waits on
   * this one, and its line is the plain one that the tunnel is still
   * shutting down. One that did not finish used to be shown as
   * "degraded", whose words -- the server isn't responding -- are about a
   * server nothing measured. What is true is that the phone is still
   * disconnecting. Per screen: back from Settings, the dashboard shows
   * what the platform says. */
  const [customerTeardown] = useState(createSlotTeardown);
  const customerTeardownState = useSyncExternalStore(customerTeardown.subscribe, customerTeardown.state);
  /** A teardown, either one, while the screen shows it under way. Worded
   * as what it is -- still disconnecting -- not as "You're not
   * protected", which the platform has not said. */
  const teardownShowing =
    (slotTeardownState !== "none" || customerTeardownState !== "none") && connectionState === "disconnecting";
  /** Whether the tunnel the screen was vouching for closed without anyone
   * asking. Only ever true alongside "disconnected": it turns "connect to
   * be protected" into "your connection was lost". Retired by any press
   * and by any other state. */
  const [tunnelDropped, setTunnelDropped] = useState(false);
  useEffect(() => {
    if (connectionState !== "disconnected") setTunnelDropped(false);
  }, [connectionState]);
  /** The automatic reconnect after a drop, shared with the Windows client
   * (`@shared/lib/auto-reconnect`). One per app, so an episode survives
   * this screen unmounting for Settings. */
  const reconnect = useSyncExternalStore(autoReconnect.subscribe, autoReconnect.current);
  const reconnecting = reconnectingView(reconnect);
  /** How the last pass ended beyond its outcome, for the reconnect: the
   * route it landed on, or the kind of error it stopped on. */
  const passResultRef = useRef<{ routeId: string | null; errorKind: string | null }>({
    routeId: null,
    errorKind: null,
  });
  /** The subscription, for callbacks registered once. */
  const subscriptionRef = useRef<Subscription | null>(null);
  subscriptionRef.current = subscription;

  useEffect(() => {
    // The remembered route is read first and handed straight to
    // loadAll, rather than set and left for a later render: loadAll
    // resolves which credential to show against it, and passing it
    // explicitly avoids a first pass that picks the wrong one and a
    // second that corrects it.
    void (async () => {
      const remembered = await loadChosenRoute();
      if (remembered) setChosenRouteId(remembered);
      await loadAll(remembered ?? undefined);
    })();
  }, []);

  // The case that made the stale-config window unbounded rather than
  // merely long. Android keeps this WebView across backgrounding, so
  // re-opening the app restores the same React tree and `loadAll` --
  // which only runs on mount -- never runs again. A customer who has not
  // force-stopped the app since install is dialling install-day values.
  //
  // Credentials only, and only when the cache is past its horizon. See
  // useRefreshOnResume for why this is not a poll.
  useRefreshOnResume(async (trigger) => {
    const refreshed = await refreshConnectionConfig({
      held: protocolUsers,
      force: true,
      // A foreground or a returning network, not a connect: its failure
      // report must not say it is connecting. On the phones this fires
      // on every foreground past the horizon, so it is most of them.
      trigger,
      appState: connectionState,
    });
    if (refreshed.source !== "network") return;
    setProtocolUsers(refreshed.protocolUsers);
    setProtocolUser(
      (current) =>
        refreshed.protocolUsers.find((u) => u.id === current?.id) ?? current,
    );
  });

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function loadAll(preferRouteId?: string) {
    // Which customer session this load is for; see sessionGeneration.
    const sessionAtStart = sessionGeneration();
    setLoading(true);
    setError(null);
    const [meResult, subsResult, usersResult] = await Promise.all([
      getMe(),
      getSubscriptions(),
      getProtocolUsers(),
    ]);

    if (!meResult.ok || !subsResult.ok || !usersResult.ok) {
      const failed = [meResult, subsResult, usersResult].find((r) => !r.ok);
      if (failed && !failed.ok && failed.sessionExpired) {
        onLoggedOut();
        return;
      }
      // The control plane is unreachable, which is not the same as the
      // subscription being gone. Everything needed to build a tunnel was
      // handed over last time, so fall back to it rather than stranding
      // a paying customer whose nodes are perfectly reachable.
      const cached = await loadSnapshot();
      if (cached) {
        setSubscription(cached.subscription);
        setProtocolUsers(cached.protocolUsers);
        setRoutes(cached.routes);
        const preferred = preferRouteId ?? chosenRouteId;
        setProtocolUser(
          cached.protocolUsers.find((u) => u.routeId === preferred) ??
            cached.protocolUsers[0] ??
            null,
        );
        setOfflineSince(cached.savedAt);
        setError(null);
        setLoading(false);
        return;
      }

      setError(
        !meResult.ok
          ? meResult.error
          : !subsResult.ok
            ? subsResult.error
            : t("dash.loadFailed"),
      );
      setLoading(false);
      return;
    }

    setOfflineSince(null);

    setMe(meResult.data);
    const sub = usableSubscription(subsResult.data);
    setSubscription(sub);
    setProtocolUsers(usersResult.data);
    const chosen = preferRouteId ?? chosenRouteId;
    setProtocolUser(
      usersResult.data.find((u) => u.routeId === chosen) ??
        usersResult.data[0] ??
        null,
    );
    setLoading(false);

    let currentRoutes: RouteOption[] = [];
    if (sub) {
      const routesResult = await getAvailableRoutes(sub.id);
      if (routesResult.ok) {
        currentRoutes = routesResult.data;
        setRoutes(currentRoutes);
      }
    }

    // A sign-out landed while the route list was in flight. Nothing below
    // is for an ended session -- the snapshot least of all, which would
    // write the signed-out customer's credentials back to disk after the
    // sign-out cleared them. The same guard as the Windows screen.
    if (sessionGeneration() !== sessionAtStart) return;

    // Only after a wholly successful fetch, so a partial answer cannot
    // overwrite a good cache with a worse one.
    void saveSnapshot(
      {
        subscription: sub,
        protocolUsers: usersResult.data,
        routes: currentRoutes,
      },
      () => sessionGeneration() === sessionAtStart,
    );

    // The tunnel outlives the UI here even more than on Windows: Android
    // keeps a VpnService running with its own notification while the
    // activity is destroyed, so on open the screen has to adopt whatever
    // is actually running rather than assume disconnected.
    let adopted: ConnectionState = "disconnected";
    // A teardown still owed -- the device limit's, or the customer's own
    // when this runs again on the same screen (a new location, the retry
    // button) -- is the one that decides what a tunnel still up is.
    const tearingDown = slotTeardown.owed() || customerTeardown.owed();
    // Whether the app was vouching for a tunnel before asking: a screen
    // away in Settings had no poll running, so a tunnel that dropped
    // meanwhile is found here or nowhere. See `droppedWhileAway`.
    const vouched = vouching(autoReconnect.current());
    let answered = false;
    try {
      adopted = stateFromStatus(await vpnStatus());
      answered = true;
      // A tunnel still being taken down is shown as that, never as a
      // connection -- back from Settings mid-teardown included.
      setConnectionState(slotTeardownShown(tearingDown, adopted));
    } catch {
      // Not "disconnected" while a teardown is owed: that would put up
      // the card that waits for the tunnel to be down, on the strength of
      // a question nobody answered.
      setConnectionState(tearingDown ? "disconnecting" : "disconnected");
    }
    if (
      droppedWhileAway({ vouching: vouched, answered, connected: adopted !== "disconnected", tearingDown }) &&
      sessionGeneration() === sessionAtStart
    ) {
      // Said, and reconnected, as the poll would have done had it been
      // running.
      reportDrop();
    }

    // A tunnel this screen did not bring up -- the app reopened over a
    // running VpnService, or the dashboard back from Settings -- still
    // uses one of the plan's devices. Back from Settings, what was known
    // about its slot stands; otherwise nothing is known, and the first
    // foreground poll claims it. Not one being taken down: that one is
    // being given up, and the retry below goes on doing so.
    if (adopted !== "disconnected" && !tearingDown) {
      deviceSlot.adopt({ subscriptionId: sub?.id, deviceLimit: sub?.deviceLimit });
      // One to reconnect if it drops. Its credential is not known here,
      // so a reconnect of it walks the ladder's ordinary order.
      autoReconnect.tunnelUp({ routeId: null });
    }

    if (adopted === "disconnected") {
      // Never one of our nodes' addresses; see `nodeAddressesOf`. Within
      // a ceiling; see `takeBaseline`.
      setBaselineIp(await takeBaseline({ nodeAddresses: nodeAddressesOf(usersResult.data) }));
      setExitIp(null);
    }
  }

  /** The tunnel the screen was vouching for has gone, and nobody of ours
   * asked: the health poll found it, or a screen mounting found it gone
   * while it was away.
   *
   * Said as lost, and handed to the automatic reconnect
   * (`@shared/lib/auto-reconnect`), which says "Reconnecting..." instead
   * while it runs. The slot is given back only when nothing is coming
   * back: a reconnect's own claim renews it. */
  function reportDrop() {
    sessionTrackerRef.current.broken();
    setConnectionState("disconnected");
    setConnectedAt(null);
    setTunnelDropped(true);
    if (autoReconnect.dropped({ exclusion: reconnectExclusion() }) === "lost") void deviceSlot.release();
  }

  /** What, at this moment, rules an automatic reconnect out -- asked at
   * the drop and before every attempt. A teardown owed is somebody's
   * request that the tunnel be down: the device limit's (whose card says
   * where Neoxify is in use now), or the customer's own. A subscription
   * that is not active would refuse every pass. A sign-out is the
   * episode's own check (`sessionGeneration`). */
  function reconnectExclusion(): ReconnectStop | null {
    if (slotTeardown.owed()) return "refused";
    if (customerTeardown.owed()) return "customer";
    const status = subscriptionRef.current?.status;
    if (status !== undefined && status !== "ACTIVE") return "notEntitled";
    return null;
  }

  // Keeps checking a live tunnel. Reports honestly, and does not move a
  // tunnel that is up the way the Windows client's mid-session failover
  // does. A tunnel that has gone is another matter: that is handed to
  // the automatic reconnect (`reportDrop`).
  useEffect(() => {
    if (!tunnelUp(connectionState)) return;

    // The plan's device limit, renewed on this poll every
    // `renewEverySec` (every fourth poll at the contract's sixty seconds;
    // `onPoll` answers at once when nothing is due), in the foreground
    // only -- see renewInForeground. Also as the app comes back to the
    // front, so a phone taken over while it was in a pocket says so as
    // it is opened rather than a poll later. If another device has the
    // slot there is nothing left to check: this phone disconnects and
    // says why. True when it did.
    const checkSlot = async (): Promise<boolean> => {
      const event = await renewInForeground();
      if (event.kind === "keep") return false;
      await endForSlot(event);
      return true;
    };
    /** False once the state this poll was started for has moved on. A
     * check still waiting on the egress probe when the slot check above
     * (from the foreground handler) or a Disconnect starts a teardown
     * must not then write "connected" over it -- a tunnel state read
     * before the teardown, reported after it. */
    let live = true;
    /** One check at a time: the interval and the app coming to the front
     * can both start one. */
    let checking = false;

    const checkOnce = async () => {
      // A tunnel the device limit is taking down is not checked for
      // health: "connected" written over it would be a working tunnel
      // after a refusal. The retry below owns it until it is down.
      if (slotTeardown.owed()) return;
      if (await checkSlot()) return;

      let fromStatus: ConnectionState;
      try {
        fromStatus = stateFromStatus(await vpnStatus());
      } catch {
        // Failing to ask is not the same as learning the tunnel is down.
        return;
      }
      if (!live) return;

      if (fromStatus === "disconnected") {
        // The tunnel went on its own -- this poll runs only while one is
        // shown, and stops the moment a press of ours changes that. Said
        // as such, and reconnected; see `reportDrop`.
        reportDrop();
        return;
      }

      // Never an answer from the connected server's own mirror where that
      // is reached around the tunnel; see `tunnelServerRef`.
      const egress = await pollEgress(baselineIp, tunnelServerRef.current ?? undefined);
      if (!live || slotTeardown.owed()) return;
      if (egress.state === "throughTunnel") setExitIp(egress.exitIp);
      // An indeterminate reading -- no baseline, as for every tunnel
      // adopted on relaunch, or no comparable endpoint -- used to count
      // as carrying, so an adopted tunnel read "You're protected" on
      // every poll whether or not anything was behind it. It is
      // "unverified" now unless a fresh handshake vouches for it.
      const next = pollState(fromStatus, egress);
      // "It kept working", for the per-ISP tags. Only a changed exit
      // address advances the clock; an indeterminate reading neither
      // advances nor resets it, and anything else starts it over.
      if (egress.state === "throughTunnel" && next === "connected") {
        sessionTrackerRef.current.healthy(settledRouteRef.current);
      } else if (egress.state !== "indeterminate") {
        sessionTrackerRef.current.broken();
      }
      setConnectionState(next);
    };

    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        await checkOnce();
      } finally {
        checking = false;
      }
    };

    // On the interval, and as the app comes back to the front -- which
    // used to renew the slot only. A phone taken out of a pocket is when
    // a tunnel that died meanwhile matters: iOS ran no timer while the
    // app was suspended, and Android's may have been held back, so
    // without this the screen kept saying "You're protected" for up to a
    // poll after being opened, and the reconnect waited as long. One
    // status call and one egress request, on a transition the customer
    // made -- not background work.
    const stopWatching = whenForegrounded(() => void check());
    const id = setInterval(() => void check(), HEALTH_POLL_MS);

    return () => {
      live = false;
      clearInterval(id);
      stopWatching();
      // A change of state ends the stretch being timed, so a reconnect
      // to the same server does not inherit the last session's clock.
      sessionTrackerRef.current.broken();
    };
  }, [connectionState, baselineIp]);

  // The pass an automatic reconnect runs, from whichever Dashboard is
  // mounted -- through a ref, so an attempt that falls due long after
  // this effect ran dials with the credentials and choices on screen now.
  //
  // The phone's own questions first (`reconnectPreflight`): is another
  // VPN holding the device, and is the permission still this app's --
  // never by raising the consent dialog. Then an ordinary ladder pass,
  // led by the route that was up, claiming the slot as any pass does and
  // judged by the same egress evidence before anything is called
  // connected.
  const runLadderRef = useRef(runLadder);
  runLadderRef.current = runLadder;
  useEffect(
    () =>
      autoReconnect.bind(async (attempt) => {
        const blocked = await reconnectPreflight({
          exclusion: reconnectExclusion,
          vpnGone: waitForTeardown,
          hasPermission: hasVpnPermission,
        });
        if (blocked !== null) return blocked;
        passResultRef.current = { routeId: null, errorKind: null };
        const outcome = await runLadderRef.current({ reconnect: attempt });
        return reconnectOutcomeOf(outcome, passResultRef.current);
      }),
    [],
  );

  // The device limit's teardown, tried again while it has not finished.
  //
  // Once per poll, never two at once (`retry` joins an attempt still
  // running), each bounded by `waitForTeardown`'s own deadline, and as
  // the app comes back to the front -- until the platform says the
  // tunnel is down, when the card that waits for that shows. Not held to
  // the foreground the way a renewal is: a renewal is a question the
  // tunnel's own traffic answers meanwhile, and this is a tunnel that
  // must not be left up.
  useEffect(() => {
    if (slotTeardownState !== "stuck") return;
    const id = setInterval(() => void retrySlotTeardown(), HEALTH_POLL_MS);
    const stopWatching = whenForegrounded(() => void retrySlotTeardown());
    return () => {
      clearInterval(id);
      stopWatching();
    };
  }, [slotTeardownState]);

  // The customer's own teardown, tried again the same way while it has
  // not finished: what they asked for is the tunnel down, and a phone
  // left on "Disconnecting..." with nothing asking again would only be a
  // new way to be stuck.
  useEffect(() => {
    if (customerTeardownState !== "stuck") return;
    const id = setInterval(() => void retryCustomerTeardown(), HEALTH_POLL_MS);
    const stopWatching = whenForegrounded(() => void retryCustomerTeardown());
    return () => {
      clearInterval(id);
      stopWatching();
    };
  }, [customerTeardownState]);

  /** One attempt at a teardown, either one: the disconnect, then the
   * platform's word, each bounded (see `tearDownForSlot`). */
  const teardownOnce = slotTeardownAttempt({ disconnect, waitForTeardown });

  /** What an attempt came to, on screen: down on the platform's word, or
   * still disconnecting -- never "connected" or "degraded" over a tunnel
   * this phone is giving up. "degraded" says the server isn't responding,
   * and nothing measured that. */
  function settleTeardown(result: "down" | "stuck" | null) {
    if (result === "down") {
      setConnectionState("disconnected");
      setConnectedAt(null);
      setExitIp(null);
    } else if (result === "stuck") {
      setConnectionState("disconnecting");
    }
  }

  async function retrySlotTeardown() {
    settleTeardown(await slotTeardown.retry(teardownOnce));
  }

  async function retryCustomerTeardown() {
    settleTeardown(await customerTeardown.retry(teardownOnce));
  }

  /** Stops a ladder pass in flight -- the customer's, or one an automatic
   * reconnect started -- and takes down what it left, down only on the
   * platform's word. */
  async function stopPass() {
    cancelRef.current = true;
    // The pass may already hold a slot. Given back fire and forget,
    // never in front of the teardown (docs/device-slots.md, 8).
    void deviceSlot.release();
    setSlotNotice(null);
    setConnectionState("disconnecting");
    // Down only on the platform's word. Still in a tunnel, the phone
    // stays shown as disconnecting, with the line that says so, and the
    // teardown is tried again on the poll: saying "disconnected" here is
    // the lie that sent customers to Android's settings to force-stop
    // the app before their internet came back. The platform is asked
    // even when the disconnect call failed -- a call that failed may
    // still have stopped the engine.
    settleTeardown(await customerTeardown.begin(teardownOnce));
  }

  /** "Stop reconnecting": the customer does not want the tunnel back by
   * itself. The headline then says the connection was lost, with Connect
   * to bring it back by hand. A pass already dialling is stopped as a
   * press of the orb stops one; between attempts nothing is up, and the
   * slot the dead tunnel held is given back. */
  async function stopReconnecting() {
    const dialling = autoReconnect.current().kind === "attempting";
    autoReconnect.cancel("stopped");
    if (dialling) {
      await stopPass();
      return;
    }
    void deviceSlot.release();
  }

  async function handleConnectToggle() {
    if (!protocolUser) return;
    // Every press takes over from an automatic reconnect, and does what
    // it says -- including a stop pressed during one of its passes.
    autoReconnect.cancel("customer");
    setTunnelDropped(false);
    setConnectionError(null);
    setPermissionDenied(false);

    // The device limit's teardown is still owed: a press on
    // "Disconnecting..." is that teardown, asked for again now. Not a
    // connect, and not the ordinary Disconnect, which would clear the
    // card that teardown is for -- it shows once the tunnel is down.
    if (slotTeardown.owed()) {
      setConnectionState("disconnecting");
      await retrySlotTeardown();
      return;
    }

    // The customer's own teardown has not finished: a press on
    // "Disconnecting..." is that teardown, asked for again now -- never a
    // connect over a tunnel the platform still has up.
    if (customerTeardown.owed()) {
      setConnectionState("disconnecting");
      await retryCustomerTeardown();
      return;
    }

    // Pressing the button during an attempt means stop, not start
    // another. Handled before the connect path below, which would
    // otherwise begin a second ladder on top of the running one.
    if (connectionState === "connecting" || connectionState === "verifying") {
      await stopPass();
      return;
    }

    if (tunnelUp(connectionState)) {
      // This phone stops using one of the plan's devices. Released fire
      // and forget, within a second and a half, and never in front of
      // the teardown: started while the tunnel is still up, the request
      // goes through it, which on a filtered network is the likeliest
      // way to reach the API at all.
      void deviceSlot.release();
      setSlotNotice(null);
      setConnectionState("disconnecting");
      // As above: down on the platform's word, or still disconnecting and
      // tried again -- not a green orb, and not "degraded" either.
      settleTeardown(await customerTeardown.begin(teardownOnce));
      return;
    }

    await connectNow();
  }

  /** A connect the customer asked for: the button, or "Use on this
   * device instead" with the devices to take the slot over from. */
  async function connectNow(takeover?: string[]) {
    if (!protocolUser) return;
    // The customer's own connect, from the orb or the device-limit card:
    // an automatic reconnect under way, or waiting, ends here.
    autoReconnect.cancel("customer");

    // A tunnel the device limit is still taking down comes down first,
    // and so does one an earlier teardown left up -- the card can still
    // be showing over it, and its "Use on this device instead" is the
    // only way here with a tunnel up (the orb disconnects then). Dialling
    // over it would hand the next engine a descriptor the last one has
    // not let go of, so if it does not come down, nothing is dialled, and
    // the card stays up beside the line that says the disconnect did not
    // finish. The customer's own teardown, still owed or started here for
    // a tunnel still up, is the same: tried, and if it does not finish,
    // left owed and retried, with the line that says so -- shown as
    // still disconnecting, never "degraded", which would say the server
    // isn't responding when nothing measured that.
    const slotOwed = slotTeardown.owed();
    const customerOwed = customerTeardown.owed();
    if (slotOwed || customerOwed || tunnelUp(connectionState)) {
      setConnectionState("disconnecting");
      const result = slotOwed
        ? await slotTeardown.retry(teardownOnce)
        : customerOwed
          ? await customerTeardown.retry(teardownOnce)
          : await customerTeardown.begin(teardownOnce);
      // Down, on the platform's word -- and said, so a connect that stops
      // at the consent dialog below does not leave the orb on
      // "disconnecting". Not down: nothing is dialled over it.
      settleTeardown(result);
      if (result === "stuck") return;
    }

    // Their own connect from here; nothing is owed any more.
    slotTeardown.clear();
    customerTeardown.clear();
    setConnectionError(null);
    setPermissionDenied(false);
    setSlotNotice(null);

    // Consent first, and before anything is torn down or started.
    // Android raises a system dialog the first time any app asks to
    // create a VpnService, and it cannot be pre-granted -- so this is a
    // real branch on first run, not a formality.
    try {
      if (!(await hasVpnPermission()) && !(await requestVpnPermission())) {
        setPermissionDenied(true);
        return;
      }
    } catch (err) {
      setConnectionError(classifyConnectionError(err));
      return;
    }

    await runLadder({ takeover });
  }

  /** Says why the device limit stopped this phone -- see `slotStop` for
   * what is shown and reported, which both clients share. A refusal is
   * reported as a limit, never as a failed dial: no rungs, so no route
   * is marked as failing for anybody, and nothing is remembered as this
   * network's best or worst route. */
  function showSlotStop(stop: SlotStop) {
    if (stop.notice) setSlotNotice(stop.notice);
    if (stop.report) void reportAttempt(stop.report);
    if (stop.inactive) {
      // The plan-ended card already says what to do about SUSPENDED and
      // EXPIRED; anything else gets the error line.
      const status = stop.subscriptionStatus;
      if (status) {
        setSubscription((current) => (current ? { ...current, status } : current));
      }
      if (status !== "SUSPENDED" && status !== "EXPIRED") {
        setConnectionError({
          kind: "subscriptionInactive",
          messageKey: "err.subscriptionInactive",
          detail: `subscription ${status ?? "not active"}`,
        });
      }
    }
  }

  /** Ends a pass that dialled nothing -- refused by the device limit, or
   * left with no protocol this build can use.
   *
   * The orb went to "connecting" on the press, and it goes back to what
   * the platform says rather than to an assumed "disconnected": a press
   * landing during an earlier teardown that did not finish would
   * otherwise be told that a tunnel still up was down. Read the way
   * `loadAll` adopts a tunnel, so the two agree. */
  async function settleUndialled() {
    let state: ConnectionState = "disconnected";
    try {
      state = stateFromStatus(await vpnStatus());
    } catch {
      // As in loadAll. This pass brought nothing up, so a platform that
      // cannot answer has nothing of this pass's to report.
    }
    setConnectionState(state);
  }

  /** The device limit ended this phone's session while it was connected:
   * another device took the slot over, a claim made through the tunnel
   * was refused, or the subscription stopped.
   *
   * Disconnects and says why. Nothing redials afterwards -- this screen
   * has no automatic ladder, and must not grow one that runs here: it
   * would only take the slot back from the device the customer is now
   * using (docs/device-slots.md, obligations 7 and 11). Nothing is
   * recorded either: the dial worked and was reported as it happened;
   * the plan refused the device. "Disconnected:" waits for the platform
   * to confirm the tunnel is gone, and a refusal's card waits for that
   * altogether; see DeviceSlotCard.
   *
   * A teardown that does not finish is not left there. The phone stays
   * shown as still disconnecting -- not "connected", and not "degraded",
   * whose words are about a server nobody measured -- with the line that
   * says so, and the retry above tries again until the platform says the
   * tunnel is down. The card shows then. See `slotTeardown`. */
  async function endForSlot(reason: SlotStopReason) {
    // The session has ended and the app is already on its way to the
    // sign-in screen, tunnel included; there is nothing to add.
    if (reason.kind === "signedOut") return;
    // Nothing reconnects after this: the teardown is the device limit's,
    // not a drop.
    autoReconnect.cancel("refused");
    // A teardown already under way for an earlier event is the one this
    // event asks for too.
    if (slotTeardown.running()) return;
    // A pass still walking its protocols stops between them rather than
    // dialling the next one on a slot that is somebody else's.
    cancelRef.current = true;
    showSlotStop(slotStop(reason, "whileConnected"));
    setFailedOverTo(null);
    setConnectionState("disconnecting");
    // Down only on the platform's word. Still routed through a VPN, the
    // phone stays shown as disconnecting: "disconnected" would be the lie
    // the toggle's own teardown refuses to tell.
    settleTeardown(await slotTeardown.begin(teardownOnce));
  }

  /** Works down the credentials this subscription holds until one is
   * proven to be carrying traffic.
   *
   * A list rather than a single credential even though only WireGuard is
   * supported today: a plan can allow WireGuard on several locations, so
   * the ladder is already doing real work, and the shape is the one the
   * other engines slot into unchanged.
   */
  async function runLadder(
    options: {
      /** Handles from a device-limit card: take the slot over from them. */
      takeover?: string[];
      /** An automatic reconnect's attempt, after the tunnel dropped
       * (`@shared/lib/auto-reconnect`): led by the route that was up, and
       * reported as automatic. */
      reconnect?: ReconnectAttempt;
    } = {},
  ): Promise<LadderOutcome> {
    setFailedOverTo(null);
    setUnsupportedChoice(null);
    cancelRef.current = false;
    // The customer session this pass dials for. A sign-out can land
    // mid-ladder; `cancelRef` stops the walk, but its own path leaves the
    // teardown to the toggle that set it -- and a sign-out's teardown
    // may already have finished by the time a slow connect returns. See
    // the check after each connect below.
    const sessionAtStart = sessionGeneration();
    // Busy from the press, not from after the questions below. They can
    // take a few seconds on a filtered network, and an orb still showing
    // "Connect" meanwhile took a second press as a second connect, which
    // would claim a second time over the first. Pressed now, it stops
    // the pass instead, like any other press during a connect.
    setConnectionState("connecting");

    // Two small questions before dialling, asked together: are these
    // still the right servers, and may this phone use the VPN now, or is
    // the plan's device limit in use elsewhere? Neither can block the
    // connect -- `refreshConnectionConfig` never throws, gives up on its
    // own short budget and hands back what is already held, and the
    // claim says "dial" when it gets no answer in three seconds. A
    // control plane that could not be reached must never be the reason
    // somebody on a censored network cannot connect.
    //
    // The credential named is the one on screen; once the ladder lands,
    // the slot is moved to the one it landed on (`afterConnected`).
    const { refreshed, stop } = await claimWhileRefreshing(
      {
        subscriptionId: subscription?.id ?? protocolUser!.subscriptionId,
        protocolUserId: protocolUser!.id,
        takeover: options.takeover,
        deviceLimit: subscription?.deviceLimit,
      },
      () =>
        refreshConnectionConfig({
          held: protocolUsers.length > 0 ? protocolUsers : [protocolUser!],
          trigger: "connect",
          appState: connectionState,
        }),
    );
    if (refreshed.source === "network") {
      setProtocolUsers(refreshed.protocolUsers);
      setProtocolUser(
        (current) =>
          refreshed.protocolUsers.find((u) => u.id === current?.id) ?? current,
      );
    }
    // Signed out, or stopped, while those were asked: whoever did it owns
    // the state from here, and nothing has been dialled. (A sign-out is
    // "failed" to a reconnect, whose own session check then ends it
    // without a word.)
    if (sessionGeneration() !== sessionAtStart) return "failed";
    if (cancelRef.current) return "cancelled";

    // Every one of the plan's devices is in use elsewhere, or the plan has
    // stopped: nothing is dialled. Never a failed dial in the attempt
    // history, never a "best route" learned, never the ladder.
    if (stop) {
      showSlotStop(stop);
      await settleUndialled();
      return "refused";
    }

    const all =
      refreshed.protocolUsers.length > 0
        ? refreshed.protocolUsers
        : [protocolUser!];
    const usable = all.filter((u) => SUPPORTED.has(u.protocol));

    // Said before the attempt rather than discovered after it. A customer
    // who deliberately picked Stealth and silently got Fast has no way to
    // tell a deliberate fallback from a broken picker -- and on Windows,
    // where exactly that happened, they reasonably concluded the app was
    // ignoring them.
    const chosen = all.find((u) => u.routeId === chosenRouteId) ?? all[0];
    if (chosen && !SUPPORTED.has(chosen.protocol)) {
      setUnsupportedChoice(
        customerProtocolLabel(chosen.protocol, chosen.connection?.transport),
      );
    }

    if (usable.length === 0) {
      const detail =
        "None of this subscription's servers offer a protocol this app can use. " +
        "OpenVPN is Windows-only; pick a different location.";
      setConnectionError({
        kind: "serverUnreachable",
        messageKey: "err.notCarryingTraffic",
        detail,
      });
      // Worth reporting even though nothing was attempted. It is not a
      // network fault at all -- it means a plan is being sold with
      // routes this build cannot use -- and that is invisible from the
      // panel unless somebody says so.
      void reportAttempt(asReconnectReport({ kind: "CONNECT", outcome: "OTHER", reason: detail }, options.reconnect));
      // The claim may have been granted; nothing is going to use it.
      void deviceSlot.release();
      await settleUndialled();
      return "unusable";
    }

    // The same ladder order the Windows client uses, which this screen
    // did not: it walked "pin, then the fixed protocol list" with no
    // memory and no probe, so a phone on a filtered network re-tried the
    // same blocked protocols first on every single connect.
    //
    // The baseline is taken first because the network is read from it.
    // Android and iOS have no gateway fingerprint like the Windows
    // service's, so the per-network memories here are keyed on the ASN
    // the server reports for the pre-connect address (`asn:<number>`;
    // see `networkKeyFromAsn`) -- coarser than per-Wi-Fi, but it does
    // separate mobile data from home broadband and one carrier from
    // another, which is what makes filtering differ. Unknown shares one
    // bucket, as on Windows. Reused as the first candidate's baseline
    // below rather than asked for twice.
    //
    // Every baseline in this pass passes over a reading of one of our
    // own nodes' addresses: a mirror reporting its node's address gives
    // one to anyone who asks, and compared against it again through
    // that mirror, a working tunnel read as a leak. See `nodeAddressesOf`.
    // Every credential the account holds, not only the usable ones: a
    // mirror's node is a node whatever this build can dial on it.
    const nodeAddresses = nodeAddressesOf(all);
    // Within a ceiling, as every baseline in the pass; see `takeBaseline`.
    let pendingBaseline: BaselineIp | null | undefined = await takeBaseline({ nodeAddresses });
    setBaselineIp(pendingBaseline);
    const networkId = networkKeyFromAsn();
    const [lastGood, history, reachability] = await Promise.all([
      loadLastGood(),
      loadConnectHistory(),
      // About a second, all candidates at once, before anything is
      // dialled; UDP protocols are not asked and stay "unknown". See
      // reachability.ts.
      probeCandidates(usable).catch(() => ({})),
    ]);
    // Stopped before anything was dialled: the toggle that set the flag
    // owns the state from here, as it does for every cancel below.
    if (cancelRef.current) return "cancelled";

    const candidates = orderCandidates(usable, {
      // A reconnect starts where the tunnel was, then falls back in the
      // ordinary order.
      resumeRouteId: options.reconnect?.resumeRouteId ?? null,
      pinnedRouteId: chosenRouteId,
      lastGoodRouteId: lastGoodFor(lastGood, networkId),
      history,
      network: networkId,
      reachability,
      preferredRouteId: null,
      // A tie-break only on a network this phone has no history for --
      // the first run, which is when people give up. See failover.ts.
      ispTags: ispTagsOf(routes),
    });
    let historyNow = history;
    const remember = (routeId: string, protocol: ProtocolUser["protocol"], ok: boolean) => {
      historyNow = recordAttempt(historyNow, networkId, routeId, protocol, ok);
      void saveConnectHistory(historyNow);
    };

    const allowedApps = await loadAllowedApps();
    let lastError: ClassifiedError | null = null;
    const attempts: string[] = [];
    // Parallel to `attempts`: which route each rung dialled and whether
    // it carried, or null for a rung that says nothing about the network.
    const dials: Dial[] = [];

    /* Someone giving up is a result, and it used to be recorded as
     * nothing at all.
     *
     * Every cancel path below returned straight out of the ladder, so a
     * customer who waited, lost patience and pressed stop left no trace
     * -- while the same connect, allowed to run to the end, would have
     * reported in full. That hides the one signal a beta most wants:
     * not which protocols fail, but which ones people abandon because
     * they are too slow to be worth waiting for.
     *
     * OTHER rather than a CANCELLED of its own. The enum documents
     * OTHER as "something else, with the detail in reason", which this
     * is; if the count turns out to matter enough to filter on, it can
     * be promoted to its own value then. */
    const reportCancelled = (): LadderOutcome => {
      void reportAttempt(
        asReconnectReport(
          {
            kind: "CONNECT",
            outcome: "OTHER",
            reason: `cancelled by the customer after ${attempts.length} of ${candidates.length} attempt(s)`,
            attempts: attempts.length > 0 ? rungsFrom(attempts) : undefined,
          },
          options.reconnect,
        ),
      );
      return "cancelled";
    };

    /** Whether the ladder would dial this candidate rather than skip it.
     * Kept beside the skip below, so "the last rung" means the last one
     * actually dialled. */
    const willDial = (c: ProtocolUser) => !(c.protocol === "IKEV2" && allowedApps.length > 0);

    for (const [index, candidate] of candidates.entries()) {
      // The customer pressed stop. Whatever this attempt left behind is
      // torn down by the toggle that set the flag, so this only has to
      // stop walking the list.
      if (sessionGeneration() !== sessionAtStart) return "failed";
      if (cancelRef.current) return reportCancelled();
      const label = customerProtocolLabel(
        candidate.protocol,
        candidate.connection?.transport,
      );
      // The last rung may land on an answer from an endpoint other than
      // the baseline's, as "unverified"; every earlier one asks only the
      // baseline's endpoint, where an answer can prove something, and
      // moves on otherwise. The Windows ladder's rule.
      const isLast = !candidates.slice(index + 1).some(willDial);

      // Taken while nothing is up. Captured through a live tunnel it
      // would record the exit address as the "before" value, and every
      // later comparison would read a working connection as a leak.
      //
      // Which for every rung after the first means waiting for the last
      // one to be gone: `disconnect` deliberately returns before the
      // platform has finished, and a baseline taken in that window went
      // into the dying tunnel -- timing out on the first endpoint and
      // shifting the reading to another, or, for a tunnel that started
      // carrying just too late, recording the node's exit address as the
      // "before". Not gone within the wait, there is no baseline: the
      // rung can still land, as "unverified", never as proven.
      //
      // And never from an endpoint on this rung's own server where the
      // phone reaches that address around the tunnel -- IKEv2, by
      // assumption; Xray and WireGuard send it through the tunnel, by the
      // source (`reachesServerAround` in the shared tunnel-server.ts).
      // There, once the tunnel is up, the node's own mirror answers with
      // the phone's own address however well the tunnel works, and a
      // baseline from it read a working tunnel as a leak (`TunnelServer`
      // in the shared egress.ts). The pass's first baseline was taken
      // before the rung was known; if it came from there, nothing is up
      // yet and it is simply taken again, passing that endpoint over.
      //
      // Names resolve once nothing of ours is up -- for every rung after
      // the first, after the wait -- so the lookup cannot go into the
      // last rung's tunnel, and just before this one is dialled, as the
      // engine is about to.
      let tunnelServer: TunnelServer;
      let baseline: BaselineIp | null;
      if (pendingBaseline !== undefined) {
        // The first rung: the pass tore everything down before it began.
        tunnelServer = await tunnelServerOf(candidate, "phone");
        baseline = askedAroundTunnel(pendingBaseline, tunnelServer)
          ? await takeBaseline({ nodeAddresses, tunnelServer })
          : pendingBaseline;
      } else {
        const nothingUp = await waitForTeardown();
        tunnelServer = await tunnelServerOf(candidate, "phone");
        baseline = nothingUp ? await takeBaseline({ nodeAddresses, tunnelServer }) : null;
      }
      pendingBaseline = undefined;
      setBaselineIp(baseline);

      // Android's platform VPN profile has no per-app allowlist -- the
      // API simply has none -- so with apps selected this protocol would
      // route the whole device instead. Skipped with a reason rather
      // than connected anyway: giving a customer a full tunnel when they
      // asked for two apps is the same shape of lie as a false
      // "Connected".
      if (candidate.protocol === "IKEV2" && allowedApps.length > 0) {
        attempts.push(`${label}: not available with selected apps`);
        // Skipped, not dialled: says nothing about the network.
        dials.push(null);
        // iOS carries Xray in a packet-tunnel extension and nothing else.
        // WireGuard and IKEv2 would each need their own provider and
        // neither is built, so attempting one fails at the system
        // boundary with a configuration error -- which reads to a customer
        // as their network being at fault rather than the app lacking a
        // feature. Skipped with a reason, like the case above.
        if (!protocolSupported(candidate.protocol)) {
          attempts.push(`${label}: not supported on this platform`);
          dials.push(null);
          continue;
        }
        continue;
      }

      try {
        // From here a tunnel to this server may be up; the health poll
        // needs to know how its endpoints are reached.
        tunnelServerRef.current = tunnelServer;
        if (candidate.protocol === "IKEV2") {
          await connectIkev2({
            // The hostname, never connection.host -- Android validates
            // the node's certificate against whatever it dialled, so an
            // address fails on the certificate rather than on anything
            // real, and only after a slow negotiation.
            server: ikev2Server(candidate),
            username: candidate.credentials.username,
            password: candidate.credentials.password,
          });
        } else if (isXrayProtocol(candidate.protocol)) {
          await connectXray({
            config: buildXrayConfig(candidate),
            protocol: candidate.protocol,
            dns: TUN_DNS,
            mtu: TUN_MTU,
            allowedApps,
          });
        } else {
          await connectWireGuard({
            privateKey: candidate.credentials.privateKey,
            address: candidate.credentials.address,
            dns: candidate.credentials.dns,
            serverPublicKey: candidate.credentials.serverPublicKey,
            endpoint: candidate.credentials.endpoint,
            allowedIPs: candidate.credentials.allowedIPs,
            allowedApps,
          });
        }
        // Signed out while this engine was coming up. Nothing else will
        // take this tunnel down -- the sign-out's teardown may already
        // have run -- so this pass does, silently, and stops.
        if (sessionGeneration() !== sessionAtStart) {
          await forgetProfiles().catch(() => disconnect()).catch(() => undefined);
          return "failed";
        }
        if (cancelRef.current) return reportCancelled();
        setProtocolUser(candidate);
        setConnectedAt(Date.now());
        setConnectionState("verifying");

        // Egress first: WireGuard does not handshake until it has
        // something to send, so this request *is* that traffic. It forces
        // the handshake and answers the stronger question at the same
        // time -- did our packets actually leave via the server.
        const verdict = await confirmEgress(baseline, {
          cancelled: () => cancelRef.current,
          sameEndpointOnly: !isLast,
          tunnelServer,
        });
        if (verdict === null || cancelRef.current) return reportCancelled();
        const outcome = rungOutcome(verdict, { baselineTaken: baseline !== null, isLast });
        if (outcome !== "notCarrying") {
          setExitIp(verdict.state === "throughTunnel" ? verdict.exitIp : null);
          // Only when it is not what they asked for. Announcing "switched
          // to Fast" to somebody who chose Fast is noise.
          //
          // Keyed on chosenRouteId, not `chosen`. `chosen` falls back to
          // all[0] so the unsupported-protocol notice has something to
          // name, and all[0] is just whichever credential the API listed
          // first -- nobody picked it. Testing against that told every
          // customer on a fresh install "your usual protocol didn't get
          // through" the first time they connected, when they had chosen
          // nothing and nothing had failed. Seen twice while testing
          // before it was recognised as a bug rather than the ladder
          // reporting real work.
          if (chosenRouteId && candidate.routeId !== chosenRouteId)
            setFailedOverTo(label);
          // "unverified" is a landing, not a failure -- nothing measured a
          // problem -- but it is shown as "Connected, not confirmed". It
          // used to be shown as "You're protected". Only a changed exit
          // address is proof, and only that is remembered as working on
          // this network or counted for the per-ISP tags -- the same rule
          // the Windows ladder follows for `unverified`.
          setConnectionState(outcome);
          const proven = outcome === "connected";
          remember(candidate.routeId, candidate.protocol, proven);
          if (proven) {
            void saveLastGood(rememberLastGood(lastGood, networkId, candidate.routeId));
          }
          // Successes carry the denominator. A failure count without one
          // cannot distinguish "the tablet build is broken" from "one
          // person tried once". Always with the ladder now, even one
          // rung, because the per-ISP tags count only explicit rungs.
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
                  [...dials, proven ? { routeId: candidate.routeId, carried: true } : null],
                ),
              },
              options.reconnect,
            ),
          );
          // A tunnel to reconnect if it drops. A reconnect's own landing
          // is armed by the episode, which carries its count of quick
          // deaths; a customer's connect starts the clock afresh.
          passResultRef.current = { routeId: candidate.routeId, errorKind: null };
          if (!options.reconnect) autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true });
          // The slot, now that a tunnel is up: claimed through it if the
          // claim before dialling went unanswered, or moved to the
          // credential the ladder landed on. Not awaited -- the pass is
          // over. A refusal that arrives this way is the limit enforced
          // late, and ends the session the way a takeover does.
          void deviceSlot.afterConnected({ protocolUserId: candidate.id }).then((event) => {
            if (event.kind !== "keep" && sessionGeneration() === sessionAtStart) {
              void endForSlot(event);
            }
          });
          return "connected";
        }

        // Moved on from either way, but only a measured negative is held
        // against the route; see `rejectionIsEvidence`.
        if (rejectionIsEvidence(verdict)) {
          attempts.push(`${label}: up but not carrying traffic`);
          dials.push({ routeId: candidate.routeId, carried: false });
          remember(candidate.routeId, candidate.protocol, false);
        } else {
          attempts.push(`${label}: up, traffic could not be confirmed`);
          dials.push(null);
        }
        lastError = {
          kind: "serverUnreachable",
          messageKey:
            candidates.length > 1
              ? "err.allProtocolsFailed"
              : "err.notCarryingTraffic",
          detail: `tried ${attempts.length} of ${candidates.length} available\n${attempts.join("\n")}`,
        };
      } catch (err) {
        const classified = classifyConnectionError(err);
        attempts.push(`${label}: ${classified.detail}`);
        const dial = failedDial(candidate.routeId, classified.kind);
        dials.push(dial);
        // Only a network failure teaches the per-network memory anything;
        // an exhausted quota on this route is not evidence about it.
        if (dial) remember(candidate.routeId, candidate.protocol, false);
        lastError = {
          ...classified,
          detail: `tried ${attempts.length} of ${candidates.length} available\n${attempts.join("\n")}`,
        };
      }

      // Always tear down before the next attempt, or it inherits this
      // one's tunnel and fails for a reason of its own.
      await disconnect().catch(() => undefined);
    }

    setConnectedAt(null);
    setExitIp(null);
    setConnectionError(lastError);
    setConnectionState("disconnected");
    // Nothing came up, so this phone is not using one of the plan's
    // devices. Kept, the slot would turn the customer's other device away
    // for the next ninety seconds with "Neoxify is in use on Android
    // phone" -- a claim about a phone that is not connected.
    void deviceSlot.release();
    passResultRef.current = { routeId: null, errorKind: lastError?.kind ?? null };
    // The report that has been costing a screenshot and a conversation
    // every time a tablet could not connect: which protocols were tried,
    // in order, and what each one did. An automatic reconnect's is filed
    // as one, not as a customer's failed connect.
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
    return "failed";
  }

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    // The sign-out's teardown is not a drop. The session generation the
    // episode checks moves too, inside `logout()`; this is the earlier
    // half, for a reconnect waiting between attempts.
    autoReconnect.cancel("signedOut");
    // A connect still walking its protocols stops rather than bringing
    // the next one up after the teardown. The session generation covers
    // the same race from outside this screen; see runLadder.
    cancelRef.current = true;
    // `logout()` takes the tunnel down -- and forgets the profiles the
    // system keeps -- before it deletes the credentials. This used to
    // clear the credentials and stop there, which is the reported bug:
    // signed out, still connected, still carrying traffic.
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
    () =>
      displayedRoute(
        routes,
        connectionState,
        protocolUser?.routeId,
        chosenRouteId,
        protocolUser?.routeId,
      ),
    [routes, protocolUser, chosenRouteId, connectionState],
  );
  /** Nothing pinned and no settled tunnel yet: the next connect's server
   * is "Automatic", not whichever route happens to be provisioned. */
  const automaticPending = showsAutomatic(connectionState, chosenRouteId);

  /** Null cap means unlimited, which is a different thing from a cap we
   * could not read. Both end up without a bar, but only one of them
   * should say "unlimited". */
  const usage = useMemo(() => {
    if (!subscription) return null;
    const used = Number(subscription.dataUsedBytes);
    if (!Number.isFinite(used)) return null;
    if (subscription.dataCapBytes === null)
      return { used, cap: null as number | null, percent: 0 };
    const cap = Number(subscription.dataCapBytes);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return { used, cap, percent: Math.min(100, (used / cap) * 100) };
  }, [subscription]);

  /** Set only when the subscription exists but no longer entitles the
   * customer to connect. See subscription-state for why the decision
   * lives outside the component. */
  const endedState = useMemo(
    () =>
      subscription ? endedNotice(subscription.status, IS_STORE_BUILD, iapAvailable()) : null,
    [subscription],
  );

  const daysLeft = useMemo(() => {
    if (!subscription) return null;
    const ms = new Date(subscription.expireAt).getTime() - now;
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }, [subscription, now]);

  // The orb's label and the headline from the Windows client's tables,
  // which this screen used to restate as two chains of ternaries. They
  // agreed state for state; what the tables add is the automatic
  // reconnect -- "Reconnect now" between attempts, "Reconnecting..." and
  // its unprotected-meanwhile hint while one runs, and "VPN connection
  // lost" after a drop -- and a single place for it. The press itself is
  // still this screen's own (`handleConnectToggle`), because what it
  // does to a phone's tunnel differs; only the words are shared.
  const connectLabel = t(pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true }).labelKey);
  const headline = headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect), customMode: false, reconnecting });

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
    <div className="relative mx-auto flex h-full w-full max-w-xl flex-col gap-3 p-4 sm:max-w-2xl sm:gap-4 sm:p-6 md:h-auto md:max-h-[46rem] lg:max-w-3xl lg:gap-5 lg:p-8">
      <header className="flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <CommunityLinks />
          <Button
            variant="ghost"
            onClick={onOpenSettings}
            aria-label={t("nav.settings")}
            className="size-9 justify-center px-0"
          >
            <SettingsIcon className="size-4 sm:size-5" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => void handleLogout()}
            disabled={signingOut}
            className="h-9 px-2 text-xs"
          >
            {signingOut ? t("nav.signingOut") : t("nav.signOut")}
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
          {offlineSince !== null ? (
            <div className="animate-rise rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="text-xs font-medium text-warning">
                {t("dash.offlineTitle")}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("dash.offlineHint", {
                  when: new Date(offlineSince).toLocaleString(),
                })}
              </p>
            </div>
          ) : null}

          <div className="animate-rise flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={
                connectionState === "connected"
                  ? "size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_8px_var(--success)]"
                  : connectionState === "unverified"
                    ? "size-1.5 shrink-0 rounded-full bg-highlight shadow-[0_0_8px_var(--highlight)]"
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

                    <div className="px-4 text-center">
                      <p
                        className={`text-sm font-semibold ${HEADLINE_TONE[teardownShowing ? "plain" : headline.tone]}`}
                      >
                        {/* A teardown, the device limit's or the
                            customer's own, while it runs: the platform
                            has not said the tunnel is down, so "You're
                            not protected" is not the headline -- still
                            disconnecting is. */}
                        {teardownShowing ? t("dash.disconnecting") : t(headline.title)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {teardownShowing ? null : t(headline.hint)}
                      </p>
                      {/* The way out of an automatic reconnect that is
                          not the orb: between attempts the orb connects
                          now, and during one stops only that pass. This
                          stops the reconnecting itself; the headline then
                          says the connection was lost. */}
                      {reconnecting !== null && !teardownShowing ? (
                        <Button
                          variant="ghost"
                          onClick={() => void stopReconnecting()}
                          className="mt-1 h-8 px-2 text-xs text-muted-foreground"
                        >
                          {t("dash.reconnectStop")}
                        </Button>
                      ) : null}
                      {/* Never move the customer without saying so. The
                          Windows client learned this the expensive way:
                          five releases of "it always connects as Fast"
                          were a working failover that told nobody. */}
                      {(connectionState === "connected" || connectionState === "unverified") &&
                      failedOverTo ? (
                        <p className="mt-1 text-xs text-amber-400/90">
                          {t("dash.switchedTo")}{" "}
                          <span className="font-medium">{failedOverTo}</span>
                        </p>
                      ) : null}

                      {unsupportedChoice ? (
                        <p className="mt-1 text-xs text-amber-400/90">
                          {t("dash.androidWireguardOnly", {
                            protocol: unsupportedChoice,
                          })}
                        </p>
                      ) : null}

                      {connectionState === "connected" && exitIp ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          {t("dash.yourIp")}{" "}
                          <span className="tabular-nums font-medium text-foreground">
                            {exitIp}
                          </span>
                        </p>
                      ) : null}
                    </div>

                    {/* The plan's device limit, when it is why this phone
                        is not connected: where Neoxify is in use, and the
                        one press that moves it here. */}
                    {slotNotice ? (
                      <DeviceSlotCard
                        notice={slotNotice}
                        // "Disconnected:" is a claim about the tunnel, so
                        // it waits for the platform to have said so.
                        tunnelDown={connectionState === "disconnected"}
                        onUseHere={(takeover) => void connectNow(takeover)}
                        onDismiss={() => setSlotNotice(null)}
                      />
                    ) : null}

                    <div className="min-h-4 px-2 text-center">
                      {/* The device limit ended this session and the
                          tunnel is not confirmed down yet. Kept while the
                          retry keeps trying; a refusal's card waits for
                          the tunnel to be down. */}
                      {slotTeardownState === "stuck" ? (
                        <p className="text-xs text-destructive">
                          {t("slots.teardownStuck")}
                        </p>
                      ) : customerTeardownState === "stuck" ? (
                        // The customer's own Disconnect has not been
                        // confirmed: said, kept while the retry keeps
                        // trying, and gone once the platform says the
                        // tunnel is down.
                        <p className="text-xs text-destructive">
                          {t("err.teardownStuck")}
                        </p>
                      ) : null}
                      {permissionDenied ? (
                        <p className="text-xs text-destructive">
                          Android needs your permission to create a VPN
                          connection. Tap Connect again and choose OK.
                        </p>
                      ) : connectionError ? (
                        <>
                          <p className="text-xs text-destructive">
                            {t(connectionError.messageKey)}
                          </p>
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[10px] text-muted-foreground select-none">
                              {t("err.showDetail")}
                            </summary>
                            <p
                              className="mt-1 font-mono text-[10px] break-words text-muted-foreground"
                              data-ltr
                            >
                              {connectionError.detail}
                            </p>
                          </details>
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>

              {/* The plan has stopped working. Until now this said so
                  only in the error a connect attempt produced -- text
                  that told the customer to "upgrade or wait for it to
                  renew" on a screen with nothing to press. */}
              {endedState ? (
                <Card className="ring-brand animate-rise flex flex-col gap-2 text-center">
                  <p className="text-sm font-semibold">
                    {t(endedState.titleKey)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(endedState.bodyKey)}
                  </p>
                  {endedState.showPlansButton ? (
                    <Button
                      onClick={onBrowsePlans}
                      className="mt-2 w-full justify-center gap-2"
                    >
                      <Tag className="size-4" />
                      {t("dash.renewCta")}
                    </Button>
                  ) : null}
                </Card>
              ) : null}
              <div className="animate-rise grid grid-cols-3 gap-2">
                {/* Both open the picker. Customers tapped these tiles
                    -- which highlight on touch and show the very value
                    they wanted to change -- and reported the app broken
                    when nothing happened, because the working control
                    was a separate button further down showing the same
                    text. The tile is the control now. */}
                <Stat
                  icon={
                    automaticPending ? (
                      <Sparkles className="size-3" />
                    ) : currentRoute ? (
                      <Flag
                        region={currentRoute.location.region}
                        className="h-3 w-[1rem]"
                      />
                    ) : (
                      <Globe className="size-3" />
                    )
                  }
                  // With nothing pinned: "Automatic" until a tunnel has
                  // settled, then where it landed, captioned as the app's
                  // pick. See `showsAutomatic`.
                  label={t(
                    !chosenRouteId && !automaticPending
                      ? "dash.serverAuto"
                      : "dash.server",
                  )}
                  value={
                    automaticPending
                      ? t("loc.automaticShort")
                      : currentRoute
                        ? currentRoute.location.region
                        : "—"
                  }
                  onClick={() => setShowLocationPicker(true)}
                  actionLabel={t("dash.change")}
                  disabledReason={
                    connectionState === "disconnected"
                      ? undefined
                      : t("dash.disconnectToChange")
                  }
                />
                <Stat
                  icon={<Shield className="size-3" />}
                  label={t("dash.protocol")}
                  value={
                    automaticPending
                      ? t("loc.automaticShort")
                      : protocolUser
                      ? customerProtocolLabel(
                          protocolUser.protocol,
                          protocolUser.connection?.transport,
                        )
                      : "—"
                  }
                  onClick={() => setShowLocationPicker(true)}
                  actionLabel={t("dash.change")}
                  disabledReason={
                    connectionState === "disconnected"
                      ? undefined
                      : t("dash.disconnectToChange")
                  }
                />
                <Stat
                  icon={<Clock className="size-3" />}
                  label={t("dash.session")}
                  value={
                    connectedAt !== null ? (
                      <span className="tabular-nums">
                        {formatDuration(Math.floor((now - connectedAt) / 1000))}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>

              <Card className="animate-rise flex flex-col gap-2.5 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("dash.dataUsed")}
                  </span>
                  <span className="tabular-nums text-xs font-semibold">
                    {usage ? (
                      <>
                        {formatBytes(usage.used)}{" "}
                        <span className="font-normal text-muted-foreground">
                          /{" "}
                          {usage.cap === null
                            ? t("dash.unlimited")
                            : formatBytes(usage.cap)}
                        </span>
                      </>
                    ) : (
                      formatBytes(Number(subscription.dataUsedBytes))
                    )}
                  </span>
                </div>

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
                      <span className="tabular-nums">{daysLeft}</span>{" "}
                      {t("dash.daysLeft")}
                    </span>
                  ) : null}
                </div>

                {/* A way to buy while a plan is still running.
                    endedNotice only offers one once the plan has ENDED,
                    which left an App Store build with no route to its
                    own purchase screen for anybody currently subscribed
                    -- including a reviewer on the free trial, who would
                    have had no way to reach the in-app purchase at all.
                    Only shown where buying actually works: the Play
                    build sells nothing. */}
                {iapAvailable() ? (
                  <Button
                    variant="outline"
                    onClick={onBrowsePlans}
                    className="mt-3 w-full justify-center gap-2"
                  >
                    <Tag className="size-4" />
                    {t("dash.viewPlans")}
                  </Button>
                ) : null}
              </Card>

              <Button
                variant="outline"
                onClick={() => setShowLocationPicker(true)}
                disabled={connectionState !== "disconnected"}
                className="w-full justify-between px-3 py-3"
              >
                <span className="flex items-center gap-2">
                  <MapPin className="size-4 text-primary" />
                  {t("dash.changeLocation")}
                </span>
                {/* Points the way the language reads. This screen is
                    mobile's own copy, so the shared fix did not reach
                    it. */}
                <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" />
              </Button>
              {connectionState !== "disconnected" ? (
                <p className="-mt-1 text-center text-xs text-muted-foreground">
                  {t("dash.disconnectToChange")}
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <Card className="ring-brand w-full text-center">
                <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Tag className="size-5" />
                </div>
                <p className="text-sm font-semibold">
                  {t("dash.noSubscription")}
                </p>
                {/* A store build cannot sell, and cannot point at where
                    to buy either -- both stores restrict steering a
                    customer to an outside payment. What it must not do
                    is leave them on a screen that explains nothing,
                    which is what hiding the button alone would have
                    done. So it says plainly what state the account is
                    in and what will happen when that changes. */}
                {IS_STORE_BUILD && !iapAvailable() ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("dash.noPlanStore")}
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("dash.noPlanHint")}
                    </p>
                    <Button
                      onClick={onBrowsePlans}
                      className="mt-4 w-full justify-center gap-2"
                    >
                      <Tag className="size-4" />
                      {t("dash.viewPlans")}
                    </Button>
                  </>
                )}
              </Card>
            </div>
          )}
        </>
      )}

      <Sheet open={showLocationPicker && subscription !== null}>
        {subscription ? (
          <LocationPicker
            subscriptionId={subscription.id}
            currentRouteId={protocolUser?.routeId}
            // Latency cannot be measured from inside the tunnel; see
            // the prop's own note. Anything but "disconnected" means
            // routes are installed, including the verifying and
            // degraded states where a tunnel exists but is not
            // trusted yet.
            tunnelActive={connectionState !== "disconnected"}
            // Nothing pinned is Automatic, which is what a new install
            // starts on; choosing it clears the pin on this device. Every
            // route is already provisioned, so there is no server call.
            automatic={!chosenRouteId}
            onChooseAutomatic={() => {
              // A new choice while a reconnect waits ends the reconnect:
              // its next attempt would lead with the old route regardless.
              autoReconnect.cancel("customer");
              setChosenRouteId(null);
              void saveChosenRoute(null);
            }}
            onClose={() => setShowLocationPicker(false)}
            onSwitched={(routeId) => {
              // As for Automatic, above.
              autoReconnect.cancel("customer");
              setChosenRouteId(routeId ?? null);
              // Best-effort and deliberately not awaited: the customer's
              // connection should not wait on a disk write, and losing
              // the preference costs them one re-pick rather than a
              // connection.
              void saveChosenRoute(routeId ?? null);
              void loadAll(routeId);
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
