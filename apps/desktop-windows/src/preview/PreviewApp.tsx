import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Gamepad2, Globe, Repeat, Shield, Sparkles } from "lucide-react";
import type { ConnectionState } from "../components/ConnectOrb";
import { ConnectOrb } from "../components/ConnectOrb";
import { DeviceSlotCard } from "../components/DeviceSlotCard";
import { RouteFlag } from "../components/Flag";
import { GamingStatusPanel } from "../components/GamingStatusPanel";
import { LocationPicker } from "../components/LocationPicker";
import { Decor, Hint, StateAnnouncer, StateLine, StatusChip, WayOut } from "../components/main/Hero";
import { HeroArt } from "../components/main/HeroArt";
import { SLOT as PROTOCOL_SLOT, Slotted } from "../components/Slotted";
import { MapLegend } from "../components/main/MapLegend";
import { WorldMap } from "../components/main/WorldMap";
import { MainView } from "../components/main/MainView";
import { LocationCard, MetricCards, SessionTray, SummaryLine, type TrayLocation, type TrayPlan } from "../components/main/SessionTray";
import { Dialog, LocationSheet } from "../components/overlay";
import { AppShell } from "../components/shell/AppShell";
import { Banner, Note, PillButton, Segmented } from "../components/ui";
import { MARK_TONE, type LogoTone } from "../lib/logo-geometry";
import { HEADLINE_HINTS, headlineFor, isTunnelUp } from "../lib/connection-evidence";
import { failoverNotice, failoverText } from "../lib/failover-notice";
import { pressFor } from "../lib/connect-intent";
import { effects, type GlassChoice, type ThemeChoice } from "../lib/effects";
import { chipFor, hintTone, ipFor, lineFor, pillFor, planCaution, secondaryFor, shownTone, type ShownTone } from "../lib/hero-model";
import { useI18n, type Language, type TranslationKey } from "../lib/i18n";
import { planLineText } from "../lib/shell-nav";
import { formatDateTime, formatNumber, formatSize, sizeParts } from "../lib/locale-format";
import { orbTone } from "../lib/orb-caution";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { placeLabel, routePlace } from "../lib/route-place";
import { recordAttempt, type ConnectHistory } from "../lib/connect-history";
import { mapCountries, mapLights, ownWorkedAt, placesEvidence } from "../lib/map-lights";
import type { SlotNotice } from "../lib/device-slot-notice";
import type { RouteOption } from "../lib/types";
import { PAGE_SCREENS, PreviewPage } from "./PreviewPages";
import { ProgressLineView } from "../components/main/ProgressLine";
import { SpeedCard, SpeedSection } from "../components/main/TrafficSpeed";
import { createTrafficMeter } from "../lib/traffic-meter";
import type { LadderRung } from "../lib/ladder-progress";
import type { CountdownLine } from "../lib/reconnect-countdown";
import type { HoldNoteKey } from "../lib/reconnect-hold";
import { SAMPLE_SUBSCRIPTION } from "./mocks/customer";
import { ScreenTransition } from "../components/ScreenTransition";
import { firstViews } from "../lib/motion";

/** DEV ONLY: the preview's screens as the app's screen machine names them
 * (App.tsx), so a change of screen here slides the way it does there --
 * deeper forward, back back (ScreenTransition's depths). */
const APP_SCREEN: Record<string, string> = {
  main: "dashboard",
  locations: "dashboard:locations",
  settings: "settings",
  pickGame: "settings",
  pickApps: "settings",
  activity: "activity",
  activityLog: "activity",
  activityFailed: "activity",
  activitySignOut: "activity",
  activityEmpty: "activity",
  activityLoading: "activity",
  plans: "plans",
  support: "support",
  referrals: "referrals",
};

/** DEV ONLY: the scenarios the state switcher offers. Each is the inputs the
 * Dashboard would have -- the service's state, the look `orbHold` holds,
 * the reconnect, the plan -- and the page is drawn from them through the
 * same tables the Dashboard uses (lib/hero-model.ts). */
interface Scenario {
  label: string;
  state: ConnectionState;
  /** The held look (`orbHold`); the state itself when nothing is held. */
  held?: ConnectionState;
  caution?: boolean;
  pressed?: boolean;
  reconnecting?: { waiting: boolean; offline: boolean };
  dropped?: boolean;
  unconfined?: boolean;
  waitingForNetwork?: boolean;
  timed?: boolean;
  failed?: boolean;
  slot?: boolean;
  offline?: boolean;
  plan?: "unlimited" | "capped" | "low" | "none" | "ended";
  failover?: boolean;
  details?: boolean;
  leak?: boolean;
  gaming?: "off" | "active" | "partial" | "unknown";
  switchDialog?: boolean;
  /** On the relay through Iran rather than the German route. */
  relay?: boolean;
  /** The relay is pinned, nothing is up: the quiet dashed arc. */
  relayPinned?: boolean;
  /** Failed over from Germany, the one on screen, to Finland: the
   * failover line names both countries. */
  crossed?: boolean;
  /** The tunnel's counters are being read: the tray's speed section. */
  speed?: boolean;
  /** The line under the state: the ladder's rung, the reconnect's
   * countdown, and why it connects when nobody pressed. */
  progress?: { rung?: [index: number, total: number]; count?: CountdownLine; auto?: boolean };
  /** "Block the internet while reconnecting": what the service says. */
  hold?: HoldNoteKey;
  /** A tunnel the screen found up and cannot name (`tunnelNamed`): back
   * from Settings, its last dial on another protocol. */
  unnamed?: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  idle: { label: "Not connected", state: "disconnected" },
  connecting: { label: "Connecting (pressed)", state: "connecting", pressed: true },
  verifying: { label: "Checking (pressed)", state: "verifying", pressed: true },
  connected: { label: "Connected, verified", state: "connected", timed: true, failover: true, details: true },
  adopted: { label: "Connected, adopted at launch", state: "connected" },
  unnamed: { label: "Connected, route not known (back from Settings)", state: "connected", unnamed: true },
  unconfined: { label: "Connected, not confined", state: "connected", unconfined: true, caution: true, timed: true, leak: true },
  unverified: { label: "Connected, not confirmed", state: "unverified" },
  degraded: { label: "Not carrying traffic", state: "degraded" },
  reconnectHeld: {
    label: "Reconnecting, inside the 10 s hold",
    state: "connecting",
    held: "connected",
    dropped: true,
    reconnecting: { waiting: false, offline: false },
  },
  reconnectLong: {
    label: "Reconnecting, past the hold",
    state: "disconnected",
    dropped: true,
    reconnecting: { waiting: true, offline: false },
  },
  noNetwork: { label: "Waiting for a network", state: "connecting", pressed: true, waitingForNetwork: true },
  unknown: { label: "Status unknown", state: "unknown" },
  disconnecting: { label: "Disconnecting", state: "disconnecting", pressed: true },
  dropped: { label: "Connection lost", state: "disconnected", dropped: true },
  failed: { label: "Connect failed", state: "disconnected", failed: true },
  slot: { label: "Device limit", state: "disconnected", slot: true },
  blocked: { label: "Blocked network (offline banner)", state: "disconnected", offline: true },
  capped: { label: "Capped plan, running low", state: "disconnected", plan: "low" },
  ended: { label: "Plan ended", state: "disconnected", plan: "ended" },
  none: { label: "No subscription", state: "disconnected", plan: "none" },
  switch: { label: "Switch location while connected", state: "connected", timed: true, switchDialog: true },
  speed: { label: "Connected, live speed", state: "connected", timed: true, speed: true },
  ladder: { label: "Connecting, trying 3 of 8", state: "connecting", pressed: true, progress: { rung: [2, 8] } },
  autoConnect: { label: "Connecting on start (setting on)", state: "connecting", progress: { rung: [0, 8], auto: true } },
  reconnectCountdown: {
    label: "Reconnecting, next try in 5 s",
    state: "disconnected",
    dropped: true,
    reconnecting: { waiting: true, offline: false },
    progress: { count: { kind: "next", attempt: 3, max: 6, seconds: 5 } },
  },
  reconnectAttempt: {
    label: "Reconnecting, attempt 3 on rung 2 of 8",
    state: "connecting",
    dropped: true,
    reconnecting: { waiting: false, offline: false },
    progress: { count: { kind: "attempt", attempt: 3, max: 6 }, rung: [1, 8] },
  },
  holding: {
    label: "Reconnecting, internet blocked (setting on)",
    state: "disconnected",
    dropped: true,
    reconnecting: { waiting: true, offline: false },
    hold: "hold.holding",
    progress: { count: { kind: "next", attempt: 2, max: 6, seconds: 2 } },
  },
  holdRefused: {
    label: "Reconnecting, Windows refused the block",
    state: "disconnected",
    dropped: true,
    reconnecting: { waiting: true, offline: false },
    hold: "hold.filtersRefused",
  },
  relayConnected: { label: "Connected via Iran (relay), verified", state: "connected", timed: true, relay: true },
  relayUnverified: { label: "Via Iran (relay), not confirmed", state: "unverified", relay: true },
  relayPinned: { label: "Via Iran (relay) pinned, not connected", state: "disconnected", relayPinned: true },
  crossed: { label: "Connected in another country (failover)", state: "connected", timed: true, crossed: true },
  crossedDegraded: { label: "Another country (failover), not carrying traffic", state: "degraded", crossed: true },
  gamingOff: { label: "Gaming mode off", state: "disconnected", gaming: "off" },
  gamingOn: { label: "Gaming mode on", state: "disconnected", gaming: "active" },
  gamingUnknown: { label: "Gaming mode, status unknown", state: "disconnected", gaming: "unknown" },
};

/** Width, height and, for tablets and phones, the safe areas the device
 * reports with the app drawn edge to edge (top, bottom): the status bar,
 * the notch or island, the home indicator or the button bar. The preview
 * cannot get them from env(), so it sets the app's own variables. */
const SIZES: Record<string, [number, number, number?, number?]> = {
  "1180 × 760 (first launch)": [1180, 760],
  "940 × 700 (old default)": [940, 700],
  // A 1280x720 screen at 150%: the window fitted to its work area
  // (window_fit.rs), where the mark once stepped aside at 92px.
  "922 × 648 (fitted, 1280×720 at 150%)": [922, 648],
  "1440 × 900": [1440, 900],
  "1280 × 800": [1280, 800],
  "720 × 600 (minimum)": [720, 600],
  "834 × 1112 (tablet)": [834, 1112, 24, 20],
  "360 × 640 (small Android)": [360, 640, 24, 48],
  "375 × 667 (iPhone SE)": [375, 667, 20, 0],
  "390 × 844 (phone)": [390, 844, 47, 34],
  "412 × 915 (Android)": [412, 915, 32, 24],
  "430 × 932 (large iPhone)": [430, 932, 59, 34],
};

let sampleHost = 10;
function route(id: string, region: string, node: string, protocol: RouteOption["protocol"], transport: string | undefined, extra: Partial<RouteOption> = {}): RouteOption {
  sampleHost += 1;
  return {
    id,
    name: id,
    protocol,
    transport,
    isRelay: false,
    location: { region, nodeName: node },
    // Documentation addresses (RFC 5737), never a node's.
    endpoint: { host: `203.0.113.${sampleHost}`, port: protocol === "WIREGUARD" ? 51820 : protocol === "IKEV2" ? 500 : 443 },
    nodeStatus: "ONLINE",
    ...extra,
  };
}

const ROUTES: RouteOption[] = [
  route("de-stealth", "de-germany", "node-de-1", "XRAY_VLESS_TLS", "WS", { ispTag: { code: "worksOnYourIsp", customers: 14, outOf: 17, windowHours: 24 } }),
  route("de-wg", "de-germany", "node-de-1", "WIREGUARD", undefined),
  route("fi-reality", "fi-finland", "node-fi-1", "XRAY_VLESS_REALITY", undefined),
  route("fr-ss", "fr-france", "node-fr-1", "SHADOWSOCKS", undefined),
  route("gb-reality", "gb-united-kingdom", "node-gb-1", "XRAY_VLESS_REALITY", undefined),
  route("sg-reality", "sg-singapore", "node-sg-1", "XRAY_VLESS_REALITY", undefined),
  route("tr-ikev2", "tr-turkey", "node-tr-1", "IKEV2", undefined, {
    ispTag: { code: "failingOnYourIsp", customers: 9, outOf: 11, windowHours: 24 },
  }),
  route("ir-de", "ir-iran", "node-ir-1", "XRAY_VLESS_TLS", "WS", { isRelay: true, exitLocation: { region: "de-germany" } }),
  route("ir-fi", "ir-iran", "node-ir-1", "XRAY_VLESS_REALITY", undefined, { isRelay: true, exitLocation: { region: "fi-finland" } }),
];

/** DEV ONLY: what this device and other people on its network have seen,
 * for the map's lights. The real screen reads connect-history and the
 * route list's tags; these are samples of each. */
const PREVIEW_NET = "preview-network";
const EVIDENCE: Record<string, { label: string; routes: (r: RouteOption[]) => RouteOption[]; own: [string, boolean, number][] }> = {
  mixed: {
    label: "Mixed",
    routes: (r) => r,
    own: [
      ["fi-reality", true, 2 * 60],
      ["sg-reality", true, 5 * 60],
      ["fr-ss", false, 60],
    ],
  },
  fresh: { label: "New install", routes: (r) => r.map((x) => ({ ...x, ispTag: null })), own: [] },
  censored: {
    label: "Censored network",
    routes: (r) =>
      r.map((x) =>
        x.id === "gb-reality"
          ? { ...x, nodeStatus: "PENDING" as const }
          : x.id === "ir-fi"
            ? { ...x, ispTag: { code: "worksOnYourIsp" as const, customers: 6, outOf: 8, windowHours: 24 } }
            : { ...x, ispTag: null },
      ),
    own: [
      ["de-stealth", false, 20],
      ["de-wg", false, 21],
      ["fi-reality", false, 22],
      ["fr-ss", false, 23],
      ["tr-ikev2", false, 24],
      ["sg-reality", false, 25],
      ["ir-de", true, 8],
    ],
  },
};

function sampleHistory(routes: RouteOption[], own: [string, boolean, number][]): ConnectHistory {
  let h: ConnectHistory = {};
  const now = Date.now();
  for (const [id, ok, minutesAgo] of own) {
    const r = routes.find((x) => x.id === id);
    if (r) h = recordAttempt(h, PREVIEW_NET, r.id, r.protocol, ok, now - minutesAgo * 60_000);
  }
  return h;
}

/** DEV ONLY: a meter of the preview's own, fed a minute of sample
 * readings and then one a second, as the liveness poll would. */
const PREVIEW_METER = createTrafficMeter();
const SAMPLE_RATES = Array.from({ length: 60 }, (_, i) => [
  Math.round(600_000 + 450_000 * Math.sin(i / 4) + 200_000 * Math.sin(i / 1.7)),
  Math.round(40_000 + 25_000 * Math.sin(i / 3)),
]);
function feedPreviewMeter(step: number): void {
  const [rx, tx] = SAMPLE_RATES[step % SAMPLE_RATES.length];
  PREVIEW_METER.observe({ rx_bytes: 1_250_000_000 + step * rx, tx_bytes: 84_000_000 + step * tx, rx_per_sec: rx, tx_per_sec: tx, window_ms: 1000 });
}

const SLOT: SlotNotice = {
  kind: "refused",
  refusal: { limit: 2, holders: [{ handle: "h1", label: "Pixel 7", platform: "android", since: new Date(Date.now() - 3_600_000).toISOString() }] },
} as SlotNotice;

export function PreviewApp() {
  const { t, language, setLanguage } = useI18n();
  const [key, setKey] = useState("connected");
  const [screen, setScreen] = useState("main");
  const [size, setSize] = useState("1180 × 760 (first launch)");
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [glass, setGlass] = useState<GlassChoice>("auto");
  const [motion, setMotion] = useState<boolean>(false);
  const [evidence, setEvidence] = useState("mixed");
  const [logo, setLogo] = useState(true);
  const [logoTone, setLogoTone] = useState<LogoTone>(MARK_TONE);
  const sc = SCENARIOS[key];
  const [w, h, safeT = 0, safeB = 0] = SIZES[size];
  const [askOpen, setAskOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  /** The shell's nav works in the preview: each press changes the screen
   * as the app does, through the same transition. */
  const go = (next: string) => setScreen(next);
  const [replay, setReplay] = useState(0);

  useEffect(() => effects.setTheme(theme), [theme]);
  useEffect(() => effects.setGlass(glass), [glass]);
  useEffect(() => effects.setMotion(motion ? true : null), [motion]);
  useEffect(() => setAskOpen(Boolean(sc.switchDialog)), [sc]);
  window.__NX_PREVIEW_GAMING__ = sc.gaming;

  const connectedAt = useMemo(() => (sc.timed ? Date.now() - 6_128_000 : null), [sc]);
  const pageRoutes = useMemo(() => (EVIDENCE[evidence] ?? EVIDENCE.mixed).routes(ROUTES), [evidence]);
  const pageHistory = useMemo(() => sampleHistory(pageRoutes, (EVIDENCE[evidence] ?? EVIDENCE.mixed).own), [pageRoutes, evidence]);

  const controls = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "10px 16px", fontSize: 13, color: "#1a1f2b", fontFamily: "system-ui, sans-serif" }} lang="en" dir="ltr">
      <strong>App preview (dev only)</strong>
      <label>
        Screen{" "}
        <select value={screen} onChange={(e) => setScreen(e.target.value)} data-testid="screen">
          {Object.entries(PAGE_SCREENS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        State{" "}
        <select value={key} onChange={(e) => setKey(e.target.value)} data-testid="scenario">
          {Object.entries(SCENARIOS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Window{" "}
        <select value={size} onChange={(e) => setSize(e.target.value)} data-testid="size">
          {Object.keys(SIZES).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Language{" "}
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)} data-testid="language">
          <option value="en">English</option>
          <option value="fa">فارسی</option>
        </select>
      </label>
      <label>
        Theme{" "}
        <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeChoice)} data-testid="theme">
          <option value="system">System</option>
          <option value="light">Pearl</option>
          <option value="dark">Smoked</option>
        </select>
      </label>
      <label>
        Glass{" "}
        <select value={glass} onChange={(e) => setGlass(e.target.value as GlassChoice)} data-testid="glass">
          <option value="auto">Auto</option>
          <option value="full">Full</option>
          <option value="lite">Lite</option>
          <option value="flat">Off</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} /> Reduce motion
      </label>
      <label>
        Map lights{" "}
        <select value={evidence} onChange={(e) => setEvidence(e.target.value)} data-testid="evidence">
          {Object.entries(EVIDENCE).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={logo} onChange={(e) => setLogo(e.target.checked)} data-testid="logo" /> Logo
      </label>
      <label>
        <input type="checkbox" checked={sheet} onChange={(e) => setSheet(e.target.checked)} data-testid="sheet" /> Locations sheet (phone)
      </label>
      <button
        type="button"
        data-testid="replay"
        style={{ padding: "2px 8px", border: "1px solid #9aa3b5", borderRadius: 6, background: "#fff" }}
        onClick={() => {
          // Every view's first entrance again, as on a fresh launch.
          firstViews.reset();
          setReplay((n) => n + 1);
        }}
      >
        Replay first entrances
      </button>
      <label>
        Logo tone{" "}
        <select value={logoTone} onChange={(e) => setLogoTone(e.target.value as LogoTone)} data-testid="logotone">
          <option value="brand">Brand (violet to cyan)</option>
          <option value="cobalt">Cobalt</option>
        </select>
      </label>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#d9dde5", overflow: "auto", userSelect: "text" }}>
      {controls}
      <div
        style={{
          width: w,
          height: h,
          margin: "0 16px 24px",
          position: "relative",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 30px 80px -30px rgba(20,30,60,.45), 0 0 0 1px rgba(20,30,60,.12)",
          // A containing block for the app's fixed overlays.
          transform: "translateZ(0)",
          ...({ "--pv-safe-t": `${safeT}px`, "--pv-safe-b": `${safeB}px` } as React.CSSProperties),
        }}
        data-testid="frame"
        data-safe={safeT || safeB ? `${safeT},${safeB}` : undefined}
      >
        {/* The device's safe areas, which env() cannot report here. */}
        <style>{`[data-testid="frame"] .nx-app { --safe-t: var(--pv-safe-t); --safe-b: var(--pv-safe-b); }`}</style>
        <ScreenTransition key={replay} screenKey={APP_SCREEN[screen] ?? screen} viewTransitions>
          {screen === "main" ? (
            <Composed
              sc={sc}
              t={t}
              language={language}
              connectedAt={connectedAt}
              askOpen={askOpen}
              onAsk={setAskOpen}
              width={w}
              evidence={evidence}
              logo={logo}
              logoTone={logoTone}
              sheet={sheet}
              onSheet={setSheet}
              onNavigate={go}
            />
          ) : (
            <PreviewPage
              key={screen}
              screen={screen}
              width={w}
              routes={pageRoutes}
              history={pageHistory}
              network={PREVIEW_NET}
              subscription={SAMPLE_SUBSCRIPTION}
              tunnel={sc.state}
              onNavigate={go}
            />
          )}
        </ScreenTransition>
      </div>
    </div>
  );
}

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function Composed({
  sc,
  t,
  language,
  connectedAt,
  askOpen,
  onAsk,
  width,
  evidence,
  logo,
  logoTone,
  sheet,
  onSheet,
  onNavigate,
}: {
  sheet: boolean;
  onSheet: (open: boolean) => void;
  onNavigate: (screen: string) => void;
  sc: Scenario;
  t: T;
  language: Language;
  connectedAt: number | null;
  askOpen: boolean;
  onAsk: (open: boolean) => void;
  width: number;
  evidence: string;
  logo: boolean;
  logoTone: LogoTone;
}) {
  const layout = width >= 900 ? "wide" : width >= 640 ? "medium" : "narrow";
  const [gamingTone, setGamingTone] = useState<ShownTone>("idle");
  useEffect(() => {
    PREVIEW_METER.reset();
    if (!sc.speed) return;
    let step = 0;
    for (; step < SAMPLE_RATES.length; step += 1) feedPreviewMeter(step);
    const id = setInterval(() => feedPreviewMeter(step++), 1_000);
    return () => clearInterval(id);
  }, [sc]);
  const gaming = sc.gaming !== undefined;
  const reconnecting = sc.reconnecting ?? null;
  const headline = headlineFor(sc.state, {
    dropped: sc.dropped ?? false,
    customMode: false,
    reconnecting,
    unconfined: sc.unconfined ?? false,
    waitingForNetwork: sc.waitingForNetwork ?? false,
  });
  const press = pressFor(sc.state, { reconnectWaiting: reconnecting?.waiting === true });
  const held = sc.held ?? sc.state;
  const calmTone = gaming ? gamingTone : shownTone(orbTone(held, sc.caution ?? false), { reconnecting: reconnecting !== null, dropped: sc.dropped ?? false });
  const chip = chipFor(sc.state, headline);
  const line = lineFor(sc.state, headline, { connectedAt });
  const lineWords = t(line.kind === "words" ? line.key : headline.title);
  const pill = pillFor(sc.state, press, { pressed: sc.pressed ?? false, waitingForNetwork: sc.waitingForNetwork, failed: sc.failed });
  const secondary = secondaryFor(press, { reconnecting: reconnecting !== null, failed: sc.failed ?? false });
  const hintText = sc.failed ? t("err.allProtocolsFailed") : sc.hold === "hold.holding" ? t("hold.holding") : t(headline.hint);
  /** As the main page's: the hold's sentences only where the setting is on
   * -- here, the states that show the hold. */
  const hintReserve: readonly TranslationKey[] = sc.hold ? [...HEADLINE_HINTS, "hold.holding", "hold.heldAfterDrop"] : HEADLINE_HINTS;
  const sample = EVIDENCE[evidence] ?? EVIDENCE.mixed;
  const routes = useMemo(() => sample.routes(ROUTES), [sample]);
  const history = useMemo(() => sampleHistory(routes, sample.own), [routes, sample]);
  const current = sc.relay || sc.relayPinned ? routes.find((r) => r.id === "ir-de")! : sc.crossed ? routes.find((r) => r.id === "fi-reality")! : routes[0];
  const protocol = customerProtocolLabel(current.protocol, current.transport);

  const plan = sc.plan ?? "unlimited";
  const cap = plan === "capped" || plan === "low" ? 30 * 1024 ** 3 : null;
  const usedBytes = plan === "low" ? 28.4 * 1024 ** 3 : 7.2 * 1024 ** 3;
  const daysLeft = plan === "low" ? 2 : 6;
  const caution = planCaution(cap ? usedBytes / cap : null, daysLeft);
  const used = sizeParts(usedBytes, language);
  const trayPlan: TrayPlan | null =
    plan === "none"
      ? null
      : {
          label: cap === null ? t("tr.planUnl") : t("dash.dataUsed"),
          value: (
            <>
              {used.value}
              <small>{cap !== null ? `${used.unit} ${t("tr.ofCap", { cap: formatSize(cap, language) })}` : t("tr.used", { size: used.unit })}</small>
            </>
          ),
          meter: cap !== null ? { fraction: usedBytes / cap, caution: caution.meter } : null,
          days: { text: t("tr.daysLeft", { n: formatNumber(daysLeft, language) }), caution: caution.days },
          renew: sc.offline ? null : { label: t("tr.renew"), onClick: () => undefined },
        };
  // Over a tunnel the screen cannot name: no place, no protocol, no light
  // -- "—", as the Dashboard says it (`tunnelNamed`).
  const named = !sc.unnamed;
  const location: TrayLocation = gaming
    ? { flag: <span className="nx-flagbox auto"><Gamepad2 aria-hidden /></span>, name: t("gaming.games"), sub: t("tr.gamesChosen", { n: formatNumber(2, language) }) }
    : !named
      ? { flag: <Globe className="size-5 text-ink-2" aria-hidden />, name: "—", sub: null, onChange: () => onSheet(true) }
    : sc.state === "disconnected" && !sc.timed
      ? { flag: <span className="nx-flagbox auto"><Sparkles aria-hidden /></span>, name: t("loc.automaticShort"), sub: null, onChange: () => onSheet(true) }
      : {
          flag: <RouteFlag region={routePlace(current).entry} exitRegion={routePlace(current).exit} label={placeLabel(current, language)} size="lg" />,
          name: placeLabel(current, language),
          sub: `${t("loc.automaticShort")} · ${protocol}`,
          onChange: () => onSheet(true),
        };
  const ip = ipFor(sc.state, "198.51.100.42", { gaming });

  // The map, from the same function the Dashboard uses.
  const verified = !gaming && named && (sc.state === "connected" || held === "connected") ? current : null;
  const settled = sc.state === "connected" || sc.state === "unverified" || sc.state === "degraded";
  const evidenceCtx = { history, network: PREVIEW_NET, now: Date.now() };
  const mapScene = mapLights({
    routes,
    ...evidenceCtx,
    verified,
    tone: calmTone,
    shown: gaming || (settled && !named) ? null : settled || sc.relayPinned ? current : null,
    up: gaming || !settled || !named ? null : current,
  });
  const workedPlaces = new Set<string>();
  for (const [key, evidence] of placesEvidence(routes, evidenceCtx)) if (evidence.look === "live") workedPlaces.add(key);
  const mapPlaces = mapCountries(routes);
  const mapAlert = Boolean(sc.offline || plan === "ended" || sc.slot || sc.failed);
  const mapStage =
    layout !== "wide" ? <WorldMap host="stage" lights={mapScene.lights} arc={mapScene.arc} countries={mapPlaces} logo={logo} logoTone={logoTone} alert={mapAlert} /> : null;

  const modeBar =
    plan === "none" ? null : (
      <div className="nx-modebar">
        <Segmented
          label={t("mode.label")}
          value={gaming ? "gaming" : "vpn"}
          onChange={() => undefined}
          locked={sc.state !== "disconnected"}
          lockedReason={t("mode.locked")}
          options={[
            { value: "vpn", label: t("dash.modeVpn"), icon: <Shield aria-hidden /> },
            { value: "gaming", label: t("dash.modeGaming"), icon: <Gamepad2 aria-hidden /> },
          ]}
        />
        <p
          className="nx-modehint"
          title={gaming ? t("mode.gamingHintShort") : !isTunnelUp(sc.state) ? t("mode.vpnHintIdle") : t(sc.unconfined ? "dash.modeVpnHintNotConfined" : "dash.modeVpnHint")}
        >
          {gaming
            ? t("mode.gamingHintShort")
            : !isTunnelUp(sc.state)
              ? t("mode.vpnHintIdle")
              : t(sc.unconfined ? "dash.modeVpnHintNotConfined" : "dash.modeVpnHint")}
        </p>
      </div>
    );

  const banner: ReactNode = (
    <>
      {sc.offline ? (
        <Banner>
          <b>{t("dash.offlineTitle")}</b>
          <span>{t("dash.offlineHint", { when: formatDateTime(Date.now() - 86_400_000 * 2, language) })}</span>
        </Banner>
      ) : null}
      {plan === "ended" ? (
        <Banner title={t("dash.planExpired")}>
          <span>{t("dash.renewHint")}</span>
          <PillButton size="sm" className="mt-2 self-start">
            {t("dash.renewCta")}
          </PillButton>
        </Banner>
      ) : null}
    </>
  );

  const actions =
    plan === "none" ? (
      <div className="nx-actions">
        <PillButton>{t("dash.viewPlans")}</PillButton>
      </div>
    ) : (
      <div className="nx-actions">
        <ConnectOrb state={held} caution={sc.caution} onToggle={() => undefined} label={t(pill.labelKey)} look="pill" pill={pill} />
        {secondary === "stopReconnecting" ? (
          <WayOut label={t("dash.reconnectStop")} short={t("btn.stopShort")} />
        ) : secondary === "stopConnecting" ? (
          <WayOut label={t("btn.stop")} short={t("btn.stopShort")} />
        ) : secondary === "tryAnother" ? (
          <WayOut label={t("btn.tryAnother")} short={t("btn.tryAnotherShort")} />
        ) : null}
      </div>
    );

  const notes = (
    <div className="nx-notes">
      {sc.leak ? <Note tone="danger">{t("dash.ipv4NotConfined")}</Note> : null}
      {sc.hold && sc.hold !== "hold.holding" ? <Note tone="caution">{t(sc.hold)}</Note> : null}
    </div>
  );
  const progressRung: LadderRung | null = sc.progress?.rung
    ? {
        pass: 1,
        index: sc.progress.rung[0],
        total: sc.progress.rung[1],
        routeId: routes[sc.progress.rung[0] % routes.length].id,
        protocol: routes[sc.progress.rung[0] % routes.length].protocol,
        transport: routes[sc.progress.rung[0] % routes.length].transport,
      }
    : null;
  const details = sc.details ? [<Note key="v6" tone="info">{t("dash.fullTunnelIpv6Blocked")}</Note>] : [];

  const panel = (
    <LocationPicker
      variant={layout === "narrow" ? "sheet" : "panel"}
      subscriptionId="preview"
      currentRouteId={isTunnelUp(sc.state) && named ? current.id : undefined}
      tunnelActive={sc.state !== "disconnected"}
      connectionState={sc.state}
      initialRoutes={routes}
      evidence={{ places: placesEvidence(routes, evidenceCtx), worked: workedPlaces, ownAt: (route) => ownWorkedAt(route, evidenceCtx), tags: true }}
      automatic={!isTunnelUp(sc.state)}
      onChooseAutomatic={() => undefined}
      onClose={() => onSheet(false)}
      onSwitched={() => undefined}
      onOpenFull={() => undefined}
      confirmPick={async () => {
        if (isTunnelUp(sc.state)) onAsk(true);
        return false;
      }}
    />
  );

  return (
    <AppShell
      active="overview"
      shown={calmTone}
      busy={pill.progress}
      banner={Boolean(sc.offline || plan === "ended")}
      titlebar
      email="you@example.com"
      planLine={planLineText(plan === "none" ? null : { daysLeft, unlimited: cap === null }, t, language)}
      onOverview={() => undefined}
      onLocations={() => (layout === "narrow" ? onSheet(true) : onNavigate("locations"))}
      onOpenActivity={() => onNavigate("activity")}
      onOpenSettings={() => onNavigate("settings")}
      onBrowsePlans={() => onNavigate("plans")}
      onOpenReferrals={() => onNavigate("referrals")}
      onOpenSupport={() => onNavigate("support")}
      onSignOut={() => undefined}
      signingOut={false}
      scene={<HeroArt tone={calmTone} layout={layout} map={mapScene} countries={mapPlaces} logo={logo} logoTone={logoTone} alert={mapAlert} />}
    >
      {gaming ? (
        <MainView
          banner={banner}
          gaming={<GamingStatusPanel onOpenSettings={() => undefined} onTone={setGamingTone} />}
          modeBar={modeBar}
          locationCard={<LocationCard location={location} />}
          metrics={<MetricCards plan={trayPlan} ip={ip} />}
          summary={<SummaryLine plan={trayPlan} ip={ip} />}
          mapStage={mapStage}
          tray={<SessionTray label={t("tr.location")} location={location} plan={trayPlan} ip={ip} />}
        />
      ) : (
        <MainView
          banner={banner}
          chip={<StatusChip glyph={chip.glyph} label={t(chip.labelKey)} />}
          line={<StateLine line={line} words={lineWords} decor={<Decor keys={["decor.browse", "decor.stream", "decor.work", "decor.anywhere"]} />} />}
          hint={
            <Hint tone={hintTone(calmTone, { failed: sc.failed })} reserve={hintReserve}>
              {hintText}
            </Hint>
          }
          slot={
            sc.slot ? (
              <DeviceSlotCard notice={SLOT} tunnelDown onUseHere={() => undefined} onDismiss={() => undefined} />
            ) : undefined
          }
          subline={
            sc.failover || sc.crossed ? (
              (() => {
                const said = failoverText(
                  failoverNotice({
                    label: protocol,
                    fromRegion: sc.crossed ? placeLabel(routes[0], language) : null,
                    toRegion: placeLabel(current, language),
                    shownRouteId: routes[0].id,
                    failed: sc.crossed ? [{ routeId: routes[0].id, fate: "dialled" }] : [],
                  }),
                );
                return (
                  <p className="nx-subline">
                    <Repeat aria-hidden />
                    <span>
                      <Slotted text={t(said.key, { ...said.vars, protocol: PROTOCOL_SLOT })}>
                        <bdi className="font-medium text-ink">{said.vars.protocol}</bdi>
                      </Slotted>
                    </span>
                  </p>
                );
              })()
            ) : sc.progress ? (
              <ProgressLineView routes={routes} autoConnecting={sc.progress.auto ?? false} rung={progressRung} count={sc.progress.count ?? null} />
            ) : null
          }
          sublineStays={Boolean(sc.crossed)}
          actions={sc.slot ? null : actions}
          error={
            sc.failed ? (
              <details className="nx-errdetail">
                <summary>{t("err.showDetail")}</summary>
                <p data-ltr>tried 4 of 4 available{"\n"}Stealth: timed out</p>
              </details>
            ) : null
          }
          notes={notes}
          details={details}
          modeBar={modeBar}
          locationCard={<LocationCard location={location} />}
          metrics={<MetricCards plan={trayPlan} ip={ip} speed={sc.speed ? <SpeedCard meter={PREVIEW_METER} /> : undefined} />}
          summary={plan === "none" ? null : <SummaryLine plan={trayPlan} ip={ip} />}
          panel={layout !== "narrow" ? panel : null}
          panelLabel={t("loc.panelTitle")}
          legend={<MapLegend />}
          mapStage={mapStage}
          tray={
            <SessionTray
              label={t("tr.location")}
              location={location}
              plan={trayPlan}
              ip={ip}
              speed={sc.speed ? <SpeedSection meter={PREVIEW_METER} /> : undefined}
            />
          }
          announcer={<StateAnnouncer text={`${lineWords}. ${hintText}`} />}
        />
      )}
      {layout === "narrow" ? (
        <LocationSheet open={sheet} title={t("loc.panelTitle")} closeLabel={t("loc.close")} onClose={() => onSheet(false)}>
          {panel}
        </LocationSheet>
      ) : null}
      <Dialog
        open={askOpen}
        title={t("sw.title", { place: `${placeLabel(ROUTES[2], language)} · ${customerProtocolLabel(ROUTES[2].protocol, ROUTES[2].transport)}` })}
        description={t("sw.body")}
        onClose={() => onAsk(false)}
        actions={
          <>
            <PillButton variant="ghost" size="sm" onClick={() => onAsk(false)}>
              {t("sw.stay")}
            </PillButton>
            <PillButton size="sm" onClick={() => onAsk(false)}>
              {t("sw.go")}
            </PillButton>
          </>
        }
      />
    </AppShell>
  );
}
