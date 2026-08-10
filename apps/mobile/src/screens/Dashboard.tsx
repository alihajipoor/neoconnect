import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, Globe, MapPin, Settings as SettingsIcon, Shield, Tag } from "lucide-react";
import { getAvailableRoutes, getMe, getProtocolUsers, getSubscriptions } from "@shared/lib/customer";
import { logout } from "@shared/lib/auth";
import type { Customer, ProtocolUser, RouteOption, Subscription } from "@shared/lib/types";
import { formatBytes } from "@shared/lib/utils";
import { customerProtocolLabel } from "@shared/lib/protocol-labels";
import { captureBaselineIp, verifyEgress } from "@shared/lib/egress";
import { classifyConnectionError, type ClassifiedError } from "@shared/lib/connection-errors";
import { orderCandidates } from "@shared/lib/failover";
import { Button, Card, Stat } from "@shared/components/ui";
import { ConnectOrb, type ConnectionState } from "@shared/components/ConnectOrb";
import { Logo } from "@shared/components/Logo";
import { LocationPicker } from "@shared/components/LocationPicker";
import { CommunityLinks } from "@shared/components/CommunityLinks";
import { useI18n } from "@shared/lib/i18n";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "@shared/lib/credential-cache";
import { outcomeFromError, reportAttempt, rungsFrom } from "@shared/lib/attempts";
import { loadAllowedApps } from "../lib/per-app";
import {
  connectWireGuard,
  connectXray,
  disconnect,
  hasVpnPermission,
  requestVpnPermission,
  vpnStatus,
  type VpnStatus,
} from "../lib/vpn";
import { buildXrayConfig, isXrayProtocol, TUN_DNS, TUN_MTU } from "../lib/xray-config";

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

/** How long a fresh tunnel gets to prove it carries traffic.
 *
 * More patient than the Windows client's six seconds, and for a reason
 * that only applies here: a phone's radio may be idle when the tunnel
 * comes up, and the first packet after that pays for waking it. */
const VERIFY_TIMEOUT_MS = 12_000;
const VERIFY_INTERVAL_MS = 1_200;

/** Seconds without a WireGuard handshake before the tunnel is treated as
 * dead. Matches the Windows service's own threshold -- WireGuard
 * rehandshakes about every two minutes under traffic, so three is late
 * enough not to cry wolf and early enough to be useful. */
const HANDSHAKE_STALE_SECS = 180;

/** Waits for traffic to actually flow, rather than asking once.
 *
 * Returns as soon as there is proof, so a working connection stays fast.
 */
async function confirmEgress(
  baselineIp: string | null,
  cancelled: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  for (;;) {
    // Checked every pass, not only at the end: this loop is most of the
    // time a hanging protocol spends in "checking connection", so a
    // cancel that is not honoured here is a button that does nothing.
    if (cancelled()) return false;
    const verdict = await verifyEgress(baselineIp);
    if (verdict.state === "throughTunnel") return true;
    // No baseline to compare against means the check cannot answer the
    // question. Falling back to handshake evidence beats inventing a
    // verdict from a comparison that was never valid.
    if (verdict.state === "indeterminate") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
}

/** Turns what the plugin reports into the one thing to display.
 *
 * `lastHandshakeAgeSecs` is null for protocols with no handshake to read.
 * That stays optimistic on purpose -- the alternative is marking every
 * connection of those protocols degraded, which is crying wolf, and the
 * egress check is the honest signal for them anyway.
 */
function stateFromStatus(status: VpnStatus): ConnectionState {
  if (!status.connected) return "disconnected";
  if (status.lastHandshakeAgeSecs === null) return "connected";
  return status.lastHandshakeAgeSecs <= HANDSHAKE_STALE_SECS ? "connected" : "degraded";
}

/** The subscription worth showing. PENDING and CANCELLED entitle nobody
 * to anything; SUSPENDED and EXPIRED are real subscriptions in a bad
 * state, and hiding those would be its own lie. */
function usableSubscription(all: Subscription[]): Subscription | null {
  const real = all.filter((s) => s.status !== "PENDING" && s.status !== "CANCELLED");
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
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState<ClassifiedError | null>(null);
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

  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [exitIp, setExitIp] = useState<string | null>(null);
  const [baselineIp, setBaselineIp] = useState<string | null>(null);
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
  const [unsupportedChoice, setUnsupportedChoice] = useState<string | null>(null);
  /** When the shown data was last fetched, if the server could not be
   * reached this time. Null means everything on screen is current. */
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Set when the customer declined Android's VPN consent dialog. Shown
   * rather than swallowed: a refusal looks exactly like a failed connect
   * from the outside, and telling them to check their internet when they
   * pressed Deny is how a product earns a one-star review. */
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function loadAll(preferRouteId?: string) {
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
          cached.protocolUsers.find((u) => u.routeId === preferred) ?? cached.protocolUsers[0] ?? null,
        );
        setOfflineSince(cached.savedAt);
        setError(null);
        setLoading(false);
        return;
      }

      setError(!meResult.ok ? meResult.error : !subsResult.ok ? subsResult.error : t("dash.loadFailed"));
      setLoading(false);
      return;
    }

    setOfflineSince(null);

    setMe(meResult.data);
    const sub = usableSubscription(subsResult.data);
    setSubscription(sub);
    setProtocolUsers(usersResult.data);
    const chosen = preferRouteId ?? chosenRouteId;
    setProtocolUser(usersResult.data.find((u) => u.routeId === chosen) ?? usersResult.data[0] ?? null);
    setLoading(false);

    let currentRoutes: RouteOption[] = [];
    if (sub) {
      const routesResult = await getAvailableRoutes(sub.id);
      if (routesResult.ok) {
        currentRoutes = routesResult.data;
        setRoutes(currentRoutes);
      }
    }

    // Only after a wholly successful fetch, so a partial answer cannot
    // overwrite a good cache with a worse one.
    void saveSnapshot({
      subscription: sub,
      protocolUsers: usersResult.data,
      routes: currentRoutes,
    });

    // The tunnel outlives the UI here even more than on Windows: Android
    // keeps a VpnService running with its own notification while the
    // activity is destroyed, so on open the screen has to adopt whatever
    // is actually running rather than assume disconnected.
    let adopted: ConnectionState = "disconnected";
    try {
      adopted = stateFromStatus(await vpnStatus());
      setConnectionState(adopted);
    } catch {
      setConnectionState("disconnected");
    }

    if (adopted === "disconnected") {
      setBaselineIp(await captureBaselineIp());
      setExitIp(null);
    }
  }

  // Keeps checking a live tunnel. Reports honestly; deliberately does not
  // yet move the connection by itself the way the Windows client does --
  // with one engine in this build there is nowhere to move it to, and a
  // ladder that can only retry the protocol that just failed is a loop,
  // not a recovery. This becomes the mid-session failover trigger when
  // the Xray engines land.
  useEffect(() => {
    if (connectionState !== "connected" && connectionState !== "degraded") return;

    const id = setInterval(async () => {
      let fromStatus: ConnectionState;
      try {
        fromStatus = stateFromStatus(await vpnStatus());
      } catch {
        // Failing to ask is not the same as learning the tunnel is down.
        return;
      }

      if (fromStatus === "disconnected") {
        setConnectionState("disconnected");
        setConnectedAt(null);
        return;
      }

      const egress = await verifyEgress(baselineIp);
      const carrying = egress.state === "throughTunnel" || egress.state === "indeterminate";
      if (egress.state === "throughTunnel") setExitIp(egress.exitIp);
      setConnectionState(carrying && fromStatus === "connected" ? "connected" : "degraded");
    }, HEALTH_POLL_MS);

    return () => clearInterval(id);
  }, [connectionState, baselineIp]);

  async function handleConnectToggle() {
    if (!protocolUser) return;
    setConnectionError(null);
    setPermissionDenied(false);

    // Pressing the button during an attempt means stop, not start
    // another. Handled before the connect path below, which would
    // otherwise begin a second ladder on top of the running one.
    if (connectionState === "connecting" || connectionState === "verifying") {
      cancelRef.current = true;
      setConnectionState("disconnecting");
      try {
        await disconnect();
      } catch {
        // The tunnel may not exist yet; the customer asked to stop
        // either way, and reporting a teardown failure for something
        // that was never up would be noise.
      }
      setConnectionState("disconnected");
      setConnectedAt(null);
      setExitIp(null);
      return;
    }

    if (connectionState === "connected" || connectionState === "degraded") {
      setConnectionState("disconnecting");
      try {
        await disconnect();
        setConnectionState("disconnected");
        setConnectedAt(null);
        setExitIp(null);
      } catch (err) {
        setConnectionError(classifyConnectionError(err));
        setConnectionState("connected");
      }
      return;
    }

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

    await runLadder();
  }

  /** Works down the credentials this subscription holds until one is
   * proven to be carrying traffic.
   *
   * A list rather than a single credential even though only WireGuard is
   * supported today: a plan can allow WireGuard on several locations, so
   * the ladder is already doing real work, and the shape is the one the
   * other engines slot into unchanged.
   */
  async function runLadder() {
    setFailedOverTo(null);
    setUnsupportedChoice(null);
    cancelRef.current = false;

    const all = protocolUsers.length > 0 ? protocolUsers : [protocolUser!];
    const usable = all.filter((u) => SUPPORTED.has(u.protocol));

    // Said before the attempt rather than discovered after it. A customer
    // who deliberately picked Stealth and silently got Fast has no way to
    // tell a deliberate fallback from a broken picker -- and on Windows,
    // where exactly that happened, they reasonably concluded the app was
    // ignoring them.
    const chosen = all.find((u) => u.routeId === chosenRouteId) ?? all[0];
    if (chosen && !SUPPORTED.has(chosen.protocol)) {
      setUnsupportedChoice(customerProtocolLabel(chosen.protocol, chosen.connection?.transport));
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
      void reportAttempt({ kind: "CONNECT", outcome: "OTHER", reason: detail });
      return;
    }

    setConnectionState("connecting");
    const candidates = orderCandidates(usable, {
      pinnedRouteId: chosenRouteId,
      lastGoodRouteId: null,
      preferredRouteId: null,
    });

    const allowedApps = await loadAllowedApps();
    let lastError: ClassifiedError | null = null;
    const attempts: string[] = [];

    for (const candidate of candidates) {
      // The customer pressed stop. Whatever this attempt left behind is
      // torn down by the toggle that set the flag, so this only has to
      // stop walking the list.
      if (cancelRef.current) return;
      const label = customerProtocolLabel(candidate.protocol, candidate.connection?.transport);

      // Taken while nothing is up. Captured through a live tunnel it
      // would record the exit address as the "before" value, and every
      // later comparison would read a working connection as a leak.
      const baseline = await captureBaselineIp();
      setBaselineIp(baseline);

      try {
        if (isXrayProtocol(candidate.protocol)) {
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
        if (cancelRef.current) return;
        setProtocolUser(candidate);
        setConnectedAt(Date.now());
        setConnectionState("verifying");

        // Egress first: WireGuard does not handshake until it has
        // something to send, so this request *is* that traffic. It forces
        // the handshake and answers the stronger question at the same
        // time -- did our packets actually leave via the server.
        const carried = await confirmEgress(baseline, () => cancelRef.current);
        if (cancelRef.current) return;
        if (carried) {
          const verdict = await verifyEgress(baseline);
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
          if (chosenRouteId && candidate.routeId !== chosenRouteId) setFailedOverTo(label);
          setConnectionState("connected");
          // Successes carry the denominator. A failure count without one
          // cannot distinguish "the tablet build is broken" from "one
          // person tried once".
          void reportAttempt({
            kind: "CONNECT",
            outcome: "SUCCESS",
            protocol: label,
            routeId: candidate.routeId,
            attempts: attempts.length > 0 ? rungsFrom([...attempts, `${label}: connected`]) : undefined,
          });
          return;
        }

        attempts.push(`${label}: up but not carrying traffic`);
        lastError = {
          kind: "serverUnreachable",
          messageKey: candidates.length > 1 ? "err.allProtocolsFailed" : "err.notCarryingTraffic",
          detail: `tried ${attempts.length} of ${candidates.length} available\n${attempts.join("\n")}`,
        };
      } catch (err) {
        const classified = classifyConnectionError(err);
        attempts.push(`${label}: ${classified.detail}`);
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
    // The report that has been costing a screenshot and a conversation
    // every time a tablet could not connect: which protocols were tried,
    // in order, and what each one did.
    void reportAttempt({
      kind: "CONNECT",
      outcome: lastError ? outcomeFromError(lastError.kind) : "OTHER",
      reason: lastError?.detail,
      attempts: rungsFrom(attempts),
    });
  }

  async function handleLogout() {
    // Before the session goes: one customer's credentials left on the
    // device for the next person to connect with is a leak, not a cache.
    await clearSnapshot();
    await logout();
    onLoggedOut();
  }

  const currentRoute = useMemo(
    () => routes.find((r) => r.id === protocolUser?.routeId) ?? null,
    [routes, protocolUser],
  );

  /** Null cap means unlimited, which is a different thing from a cap we
   * could not read. Both end up without a bar, but only one of them
   * should say "unlimited". */
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
          <CommunityLinks />
          <Button
            variant="ghost"
            onClick={onOpenSettings}
            aria-label={t("nav.settings")}
            className="size-9 justify-center px-0"
          >
            <SettingsIcon className="size-4" />
          </Button>
          <Button variant="ghost" onClick={handleLogout} className="h-9 px-2 text-xs">
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
                      {/* Never move the customer without saying so. The
                          Windows client learned this the expensive way:
                          five releases of "it always connects as Fast"
                          were a working failover that told nobody. */}
                      {connectionState === "connected" && failedOverTo ? (
                        <p className="mt-1 text-xs text-amber-400/90">
                          {t("dash.switchedTo")} <span className="font-medium">{failedOverTo}</span>
                        </p>
                      ) : null}

                      {unsupportedChoice ? (
                        <p className="mt-1 text-xs text-amber-400/90">
                          {t("dash.androidWireguardOnly", { protocol: unsupportedChoice })}
                        </p>
                      ) : null}

                      {connectionState === "connected" && exitIp ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          {t("dash.yourIp")}{" "}
                          <span className="tabular-nums font-medium text-foreground">{exitIp}</span>
                        </p>
                      ) : null}
                    </div>

                    <div className="min-h-4 px-2 text-center">
                      {permissionDenied ? (
                        <p className="text-xs text-destructive">
                          Android needs your permission to create a VPN connection. Tap Connect again and
                          choose OK.
                        </p>
                      ) : connectionError ? (
                        <>
                          <p className="text-xs text-destructive">{t(connectionError.messageKey)}</p>
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

              <div className="animate-rise grid grid-cols-3 gap-2">
                {/* Both open the picker. Customers tapped these tiles
                    -- which highlight on touch and show the very value
                    they wanted to change -- and reported the app broken
                    when nothing happened, because the working control
                    was a separate button further down showing the same
                    text. The tile is the control now. */}
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
                  value={
                    protocolUser
                      ? customerProtocolLabel(protocolUser.protocol, protocolUser.connection?.transport)
                      : "—"
                  }
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
                <ChevronRight className="size-4 text-muted-foreground" />
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
          onSwitched={(routeId) => {
            setChosenRouteId(routeId ?? null);
            void loadAll(routeId);
          }}
        />
      ) : null}
    </div>
  );
}
