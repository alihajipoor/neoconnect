import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, Globe, MapPin, Settings as SettingsIcon, Shield, Tag } from "lucide-react";
import { getAvailableRoutes, getMe, getProtocolUsers, getSubscriptions } from "../lib/customer";
import { logout } from "../lib/auth";
import type { Customer, ProtocolUser, RouteOption, Subscription } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { CUSTOMER_PROTOCOL_LABELS } from "../lib/protocol-labels";
import { captureBaselineIp, verifyEgress, type EgressVerdict } from "../lib/egress";
import { classifyConnectionError, type ClassifiedError } from "../lib/connection-errors";
import { Button, Card, Stat } from "../components/ui";
import { ConnectOrb, type ConnectionState } from "../components/ConnectOrb";
import { Logo } from "../components/Logo";
import { LocationPicker } from "../components/LocationPicker";
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
async function confirmEgress(baselineIp: string | null): Promise<EgressVerdict> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last: EgressVerdict = { state: "unreachable" };

  while (Date.now() < deadline) {
    const verdict = await verifyEgress(baselineIp);
    if (verdict.state === "throughTunnel") return verdict;
    last = verdict;
    await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
  return last;
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

  useEffect(() => {
    void loadAll();
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

  async function loadAll() {
    setLoading(true);
    setError(null);
    const [meResult, subsResult, usersResult] = await Promise.all([getMe(), getSubscriptions(), getProtocolUsers()]);

    if (!meResult.ok || !subsResult.ok || !usersResult.ok) {
      const failed = [meResult, subsResult, usersResult].find((r) => !r.ok);
      if (failed && !failed.ok && failed.sessionExpired) {
        onLoggedOut();
        return;
      }
      setError(!meResult.ok ? meResult.error : !subsResult.ok ? subsResult.error : t("dash.loadFailed"));
      setLoading(false);
      return;
    }

    setMe(meResult.data);
    const sub = usableSubscription(subsResult.data);
    setSubscription(sub);
    setProtocolUser(usersResult.data[0] ?? null);
    setLoading(false);

    // Purely to name the server the customer is actually on -- the
    // protocol-user row carries a routeId but no human-readable
    // location. Best-effort: a failure here costs a label, not the
    // screen, so it must never surface as an error.
    if (sub) {
      const routesResult = await getAvailableRoutes(sub.id);
      if (routesResult.ok) setRoutes(routesResult.data);
    }

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

  // Keeps checking a live tunnel. Without this the app showed whatever
  // was true at connect time forever, so a tunnel that died an hour ago
  // still read as "Connected".
  useEffect(() => {
    if (connectionState !== "connected" && connectionState !== "degraded") return;
    const id = setInterval(async () => {
      try {
        const status = await invoke<VpnStatus>("vpn_status");
        setConnectionState(stateFromStatus(status));
      } catch {
        // Leave the last known state alone: failing to ask is not the
        // same as learning the tunnel is down.
      }
    }, HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [connectionState]);

  async function handleConnectToggle() {
    if (!protocolUser) return;
    setConnectionError(null);

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

    setConnectionState("connecting");
    try {
      // The whole protocol-user row goes to the helper service, which
      // picks the right engine -- the app deliberately doesn't branch on
      // protocol here, so adding one later needs no change in the UI.
      await invoke("vpn_connect", { payload: protocolUser });

      setConnectedAt(Date.now());

      // Egress first, and the order is the whole point. WireGuard does
      // not handshake until it has something to send, so immediately
      // after connect there is no handshake to find -- checking for one
      // first meant every healthy connection sat on "Not carrying
      // traffic" for the best part of a minute and only went green when
      // the customer opened a website and generated traffic themselves.
      // Reported exactly that way.
      //
      // This request *is* that traffic. It forces the handshake and
      // answers the stronger question at the same time: did our packets
      // actually leave via the server.
      //
      // Shown as its own state while it runs. The honest answer during
      // these seconds is "we do not know yet", and both neighbouring
      // states assert something false -- which is why a still-negotiating
      // OpenVPN tunnel was being reported as unprotected.
      setConnectionState("verifying");
      const egress = await confirmEgress(baselineIpRef.current);
      setExitIp(egress.state === "unreachable" ? null : egress.exitIp);

      // Proof the tunnel carries traffic needs no second opinion, and
      // returning here is what makes a working connection feel instant.
      if (egress.state === "throughTunnel") {
        setConnectionState("connected");
        return;
      }

      // Otherwise ask the far end whether it is answering at all, which
      // separates "server is dead" from "server is fine but our traffic
      // is going around it". The request above has already given
      // WireGuard a reason to handshake, so this now sees the truth
      // rather than an interface that has simply never spoken yet.
      const fromHandshake = await confirmReachable();
      setConnectionState(combineEvidence(fromHandshake, egress));
    } catch (err) {
      setConnectionError(classifyConnectionError(err));
      setConnectionState("disconnected");
    }
  }

  async function handleLogout() {
    await logout();
    onLoggedOut();
  }

  const currentRoute = useMemo(
    () => routes.find((r) => r.id === protocolUser?.routeId) ?? null,
    [routes, protocolUser],
  );

  const usage = useMemo(() => {
    if (!subscription) return null;
    const used = Number(subscription.dataUsedBytes);
    const cap = Number(subscription.dataCapBytes);
    if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
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
                <Stat
                  icon={<Globe className="size-3" />}
                  label={t("dash.server")}
                  value={currentRoute ? currentRoute.location.region : "—"}
                />
                <Stat
                  icon={<Shield className="size-3" />}
                  label={t("dash.protocol")}
                  value={protocolUser ? (CUSTOMER_PROTOCOL_LABELS[protocolUser.protocol] ?? protocolUser.protocol) : "—"}
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
                        <span className="font-normal text-muted-foreground">/ {formatBytes(usage.cap)}</span>
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
                {usage ? (
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
                className="w-full justify-between px-3"
              >
                <span className="flex items-center gap-2">
                  <MapPin className="size-4 text-primary" />
                  {currentRoute ? currentRoute.location.region : t("dash.changeLocation")}
                </span>
                <span className="text-xs text-muted-foreground">{t("dash.change")}</span>
              </Button>
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
          onClose={() => setShowLocationPicker(false)}
          // Re-reads the provisioned connection rather than adopting the
          // switch response directly. Two reasons, one of which was a
          // real bug: the switch endpoint's payload didn't carry the
          // `connection` field that listing does, so switching servers
          // left the app holding credentials with no server address and
          // Connect failed. Re-fetching also means an app running
          // against an older backend still works, instead of depending
          // on that endpoint's exact shape.
          onSwitched={() => void loadAll()}
        />
      ) : null}
    </div>
  );
}
