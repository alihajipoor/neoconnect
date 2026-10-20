import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Globe, Repeat, Sparkles } from "lucide-react";
import type { ConnectionState } from "@shared/components/ConnectOrb";
import { BackupRouteChip } from "@shared/components/BackupRoute";
import { ConnectOrb } from "@shared/components/ConnectOrb";
import { DeviceSlotCard } from "@shared/components/DeviceSlotCard";
import { RouteFlag } from "@shared/components/Flag";
import { LocationPicker } from "@shared/components/LocationPicker";
import { Decor, Hint, StateAnnouncer, StateLine, StatusChip, WayOut } from "@shared/components/main/Hero";
import { HeroArt } from "@shared/components/main/HeroArt";
import { SLOT as PROTOCOL_SLOT, Slotted } from "@shared/components/Slotted";
import { MapLegend } from "@shared/components/main/MapLegend";
import { WorldMap } from "@shared/components/main/WorldMap";
import { MainView } from "@shared/components/main/MainView";
import { LocationCard, MetricCards, SessionTray, SummaryLine, type TrayLocation, type TrayPlan } from "@shared/components/main/SessionTray";
import { Dialog, LocationSheet } from "@shared/components/overlay";
import { AppShell } from "@shared/components/shell/AppShell";
import { ScreenTransition } from "@shared/components/ScreenTransition";
import { swapView } from "@shared/lib/view-transition";
import { heldListLook } from "@shared/lib/displayed-route";
import { Page, PageScene } from "@shared/components/shell/Page";
import { Banner, Note, PillButton } from "@shared/components/ui";
import { Login } from "@shared/screens/Login";
import { Register } from "@shared/screens/Register";
import { ForgotPassword } from "@shared/screens/ForgotPassword";
import { VerifyEmail } from "@shared/screens/VerifyEmail";
import { HEADLINE_HINTS, headlineFor } from "@shared/lib/connection-evidence";
import { pressFor } from "@shared/lib/connect-intent";
import { effects, type GlassChoice, type ThemeChoice } from "@shared/lib/effects";
import { chipFor, hintTone, ipFor, lineFor, pillFor, planCaution, secondaryFor, shownTone } from "@shared/lib/hero-model";
import { useI18n, type Language, type TranslationKey } from "@shared/lib/i18n";
import { planLineText } from "@shared/lib/shell-nav";
import { layoutFor, useLayoutMode } from "@shared/lib/layout-mode";
import { resetLastResortForTests } from "@shared/lib/last-resort";
import { networkKeyFromAsn } from "@shared/lib/network-identity";
import { formatDateTime, formatNumber, formatSize, sizeParts } from "@shared/lib/locale-format";
import { orbTone } from "@shared/lib/orb-caution";
import { customerProtocolLabel } from "@shared/lib/protocol-labels";
import { placeLabel, routePlace } from "@shared/lib/route-place";
import { recordAttempt, type ConnectHistory } from "@shared/lib/connect-history";
import { mapCountries, mapLights, ownWorkedAt, placesEvidence } from "@shared/lib/map-lights";
import type { SlotNotice } from "@shared/lib/device-slot-notice";
import type { RouteOption } from "@shared/lib/types";
import type { ShownFailure } from "@shared/lib/failure-text";
import type { SocialProvider } from "@shared/lib/social-auth";
import { ProminentDisclosure } from "../components/ProminentDisclosure";
import { PerAppCard } from "../components/PerAppCard";
import type { InstalledApp } from "../lib/per-app";

/** DEV ONLY: the phone's main page, drawn the way its Dashboard draws it
 * (src/screens/Dashboard.tsx) from the inputs that screen has -- the
 * platform's state, the held look, the reconnect, the plan -- through the
 * same tables (lib/hero-model.ts) and the same parts. Kept in step with the
 * Dashboard by hand, as the Windows preview is with its own: the state
 * switcher cannot drive a real VpnService. */

interface Scenario {
  label: string;
  state: ConnectionState;
  /** The held look (`orbHold`); the state itself when nothing is held. */
  held?: ConnectionState;
  pressed?: boolean;
  reconnecting?: { waiting: boolean; offline: boolean };
  dropped?: boolean;
  timed?: boolean;
  failed?: boolean;
  slot?: boolean;
  offline?: boolean;
  plan?: "unlimited" | "capped" | "low" | "none" | "ended";
  /** A failover in the same country: the line folds into the sheet. */
  failover?: boolean;
  /** Failed over from Germany, the one chosen, to Finland. */
  crossed?: boolean;
  relay?: boolean;
  relayPinned?: boolean;
  /** The customer's own teardown did not finish. */
  teardownStuck?: boolean;
  /** The VPN consent dialog was declined. */
  permission?: boolean;
  /** The chosen protocol has no engine in this build. */
  unsupported?: boolean;
  /** On an iPhone: the platform's own words for a declined prompt. */
  ios?: boolean;
  /** A tunnel the app found up and cannot name (`tunnelNamed`): reopened
   * over a VPN the platform kept, its last dial on another protocol. */
  unnamed?: boolean;
}

export const SCENARIOS: Record<string, Scenario> = {
  idle: { label: "Not connected", state: "disconnected" },
  connecting: { label: "Connecting (pressed)", state: "connecting", pressed: true },
  verifying: { label: "Checking (pressed)", state: "verifying", pressed: true },
  connected: { label: "Connected, verified (protocol changed)", state: "connected", timed: true, failover: true },
  adopted: { label: "Connected, adopted at launch", state: "connected" },
  unnamed: { label: "Connected, route not known (reopened)", state: "connected", unnamed: true },
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
  reconnectOffline: {
    label: "Reconnecting, no network",
    state: "disconnected",
    dropped: true,
    reconnecting: { waiting: true, offline: true },
  },
  disconnecting: { label: "Disconnecting", state: "disconnecting", pressed: true },
  teardownStuck: { label: "Disconnect not confirmed", state: "disconnecting", teardownStuck: true },
  dropped: { label: "Connection lost", state: "disconnected", dropped: true },
  failed: { label: "Connect failed", state: "disconnected", failed: true },
  permission: { label: "VPN permission declined", state: "disconnected", permission: true },
  permissionIos: { label: "VPN permission declined (iPhone)", state: "disconnected", permission: true, ios: true },
  unsupported: { label: "Connected, chosen protocol not in the app", state: "connected", timed: true, unsupported: true },
  slot: { label: "Device limit", state: "disconnected", slot: true },
  blocked: { label: "Blocked network (offline banner)", state: "disconnected", offline: true },
  capped: { label: "Capped plan, running low", state: "disconnected", plan: "low" },
  ended: { label: "Plan ended", state: "disconnected", plan: "ended" },
  none: { label: "No subscription", state: "disconnected", plan: "none" },
  relayConnected: { label: "Connected via Iran (relay), verified", state: "connected", timed: true, relay: true },
  relayUnverified: { label: "Via Iran (relay), not confirmed", state: "unverified", relay: true },
  relayPinned: { label: "Via Iran (relay) pinned, not connected", state: "disconnected", relayPinned: true },
  crossed: { label: "Connected in another country (failover)", state: "connected", timed: true, crossed: true },
  crossedUnverified: { label: "Another country (failover), not confirmed", state: "unverified", crossed: true },
};

/** The screens the switcher offers besides the main page. */
export const SCREENS: Record<string, string> = {
  main: "Main page",
  locations: "Locations page",
  disclosure: "First-run disclosure",
  perapp: "Per-app routing (Android)",
  perappOff: "Per-app routing, off",
  signin: "Sign in",
  signinError: "Sign in, network blocked",
  register: "Create account",
  forgot: "Forgot password",
  verify: "Verify email",
};

/** Width, height and the safe areas the device reports with the app drawn
 * edge to edge (top, bottom, and each side), as the Windows preview has
 * them. The preview cannot get them from env(), so it sets the app's own
 * variables, and pads the sides as #root does (globals.css). On its side an
 * iPhone keeps its notch out of the way with the side insets; an Android
 * phone keeps its status bar and its gesture bar. */
const SIZES: Record<string, [number, number, number, number, number]> = {
  "360 × 640 (small Android)": [360, 640, 24, 48, 0],
  "375 × 667 (iPhone SE)": [375, 667, 20, 0, 0],
  "390 × 844 (phone)": [390, 844, 47, 34, 0],
  "412 × 915 (Android)": [412, 915, 32, 24, 0],
  "430 × 932 (large iPhone)": [430, 932, 59, 34, 0],
  "834 × 1112 (tablet)": [834, 1112, 24, 20, 0],
  "1112 × 834 (tablet, landscape)": [1112, 834, 24, 20, 0],
  "800 × 1280 (Android tablet, buttons)": [800, 1280, 24, 48, 0],
  "844 × 390 (phone, landscape)": [844, 390, 0, 21, 47],
  "932 × 430 (large iPhone, landscape)": [932, 430, 0, 21, 59],
  "915 × 412 (Android, landscape)": [915, 412, 24, 24, 0],
};

/** Relay mode as last-resort.ts keeps it -- the backend answered through
 * the relay on this network moments ago -- written where that file reads
 * it ("neoxify.relay"), with its memory of it dropped, so the backup-route
 * chip and sign-in draw it. Nothing is sent: the preview has no relay. */
function holdRelayMode(on: boolean) {
  resetLastResortForTests();
  if (!on) return;
  try {
    const network = networkKeyFromAsn() ?? "unknown";
    localStorage.setItem("neoxify.relay", JSON.stringify({ mode: { [network]: Date.now() + 3_600_000 }, off: {}, sent: [] }));
  } catch {
    // No storage: no chip, which the fit check says.
  }
}

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

const PREVIEW_NET = "asn:preview";
/** This phone's own verified connects on the sample network. */
const OWN: [string, boolean, number][] = [
  ["fi-reality", true, 2 * 60],
  ["sg-reality", true, 5 * 60],
  ["fr-ss", false, 60],
];

function sampleHistory(routes: RouteOption[]): ConnectHistory {
  let h: ConnectHistory = {};
  const now = Date.now();
  for (const [id, ok, minutesAgo] of OWN) {
    const r = routes.find((x) => x.id === id);
    if (r) h = recordAttempt(h, PREVIEW_NET, r.id, r.protocol, ok, now - minutesAgo * 60_000);
  }
  return h;
}

const SLOT_NOTICE: SlotNotice = {
  kind: "refused",
  refusal: { limit: 2, holders: [{ handle: "h1", label: "Pixel 7", platform: "android", since: new Date(Date.now() - 3_600_000).toISOString() }] },
} as SlotNotice;

/** A tile in a colour, standing in for an app's icon. */
function icon(fill: string, letter: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${fill}"/><text x="24" y="31" font-family="Arial" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const SAMPLE_APPS: InstalledApp[] = [
  { packageName: "org.telegram.messenger", label: "Telegram", icon: icon("#2AABEE", "T") },
  { packageName: "com.instagram.android", label: "Instagram", icon: icon("#C13584", "I") },
  { packageName: "com.whatsapp", label: "WhatsApp", icon: icon("#25D366", "W") },
  { packageName: "com.google.android.youtube", label: "YouTube", icon: icon("#FF0000", "Y") },
  { packageName: "com.android.chrome", label: "Chrome", icon: icon("#1A73E8", "C") },
  { packageName: "com.spotify.music", label: "Spotify", icon: icon("#1DB954", "S") },
  { packageName: "com.example.bank", label: "Bank", icon: null },
];

/** The phone's words for two shared sentences (Dashboard.tsx). */
const PHONE_HINT: Partial<Record<TranslationKey, TranslationKey>> = {
  "dash.verifyingHint": "dash.verifyingHintPhone",
  "dash.waitingForNetworkHint": "dash.waitingForNetworkHintPhone",
};
const phoneHint = (key: TranslationKey): TranslationKey => PHONE_HINT[key] ?? key;
const PHONE_HEADLINE_HINTS: readonly TranslationKey[] = HEADLINE_HINTS.map(phoneHint);

const BLOCKED: ShownFailure = { error: "", noResponse: true, blockPage: true };
const IOS_PROVIDERS: SocialProvider[] = ["apple", "google", "facebook"];
const noop = () => undefined;

export function PhonePreview() {
  const { language, setLanguage } = useI18n();
  const [key, setKey] = useState("connected");
  const [screen, setScreen] = useState("main");
  const [size, setSize] = useState("390 × 844 (phone)");
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [glass, setGlass] = useState<GlassChoice>("auto");
  const [motion, setMotion] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [ios, setIos] = useState(false);
  const [relay, setRelay] = useState(false);
  const sc = SCENARIOS[key];
  const [w, h, safeT, safeB, side] = SIZES[size];

  useEffect(() => effects.setTheme(theme), [theme]);
  useEffect(() => effects.setGlass(glass), [glass]);
  useEffect(() => effects.setMotion(motion ? true : null), [motion]);

  // Relay mode, before the chip and the screens under it mount.
  useMemo(() => holdRelayMode(relay), [relay]);

  // The per-app card's stored settings, set as its screen is chosen and
  // before it mounts.
  useMemo(() => {
    window.__NX_PREVIEW_PERAPP__ =
      screen === "perappOff" ? { enabled: false, packages: [] } : { enabled: true, packages: ["org.telegram.messenger", "com.instagram.android"] };
  }, [screen]);

  const controls = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "10px 16px", fontSize: 13, color: "#1a1f2b", fontFamily: "system-ui, sans-serif" }} lang="en" dir="ltr">
      <strong>Phone preview (dev only)</strong>
      <label>
        Screen{" "}
        <select value={screen} onChange={(e) => setScreen(e.target.value)} data-testid="screen">
          {Object.entries(SCREENS).map(([k, label]) => (
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
        Phone{" "}
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
        <input type="checkbox" checked={sheet} onChange={(e) => setSheet(e.target.checked)} data-testid="sheet" /> Locations sheet
      </label>
      <label>
        <input type="checkbox" checked={ios} onChange={(e) => setIos(e.target.checked)} data-testid="ios" /> iPhone sign-in providers
      </label>
      <label>
        <input type="checkbox" checked={relay} onChange={(e) => setRelay(e.target.checked)} data-testid="relay" /> Backup route (relay mode)
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
          // The page's own background, behind #root's side padding.
          background: "var(--background)",
          // A containing block for the app's fixed overlays.
          transform: "translateZ(0)",
          ...({ "--pv-safe-t": `${safeT}px`, "--pv-safe-b": `${safeB}px` } as CSSProperties),
        }}
        data-testid="frame"
        data-safe={`${safeT},${safeB},${side}`}
      >
        {/* The device's safe areas, which env() cannot report here: the
            app's own variables, and the backup-route chip's row, which
            takes the status bar's inset itself (globals.css). */}
        <style>{`[data-testid="frame"] .nx-app { --safe-t: var(--pv-safe-t); --safe-b: var(--pv-safe-b); }
[data-testid="frame"] .nx-relayrow:not(:empty) { padding-top: var(--pv-safe-t); }`}</style>
        {/* #root, with the side insets as its padding (globals.css). */}
        <div style={{ height: "100%", paddingLeft: side, paddingRight: side, boxSizing: "border-box" }}>
          {/* App.tsx's frame around every screen: the backup-route chip's
              row, then the screen in the app's own ScreenTransition, so a
              change of screen here moves as it does there. Keyed, so the
              chip and sign-in read relay mode afresh. */}
          <div key={relay ? "relay" : "plain"} className="flex h-full flex-col">
            <div className="nx-relayrow">
              <BackupRouteChip />
            </div>
            <div className="nx-screen min-h-0 flex-1">
              <ScreenTransition screenKey={screen === "locations" ? "main" : screen} viewTransitions>
                {screen === "main" || screen === "locations" ? (
                  <Composed
                    sc={sc}
                    language={language}
                    width={w - 2 * side}
                    sheet={sheet}
                    onSheet={setSheet}
                    view={screen === "locations" ? "locations" : "overview"}
                    onNavigate={(next) =>
                      // The main page and Locations are one screen in the
                      // app (Dashboard.tsx), changed by swapView.
                      next === "main" || next === "locations"
                        ? swapView(() => setScreen(next), next === "locations" ? "forward" : "back")
                        : setScreen(next)
                    }
                  />
                ) : (
                  <Other key={screen} screen={screen} ios={ios} />
                )}
              </ScreenTransition>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Other({ screen, ios }: { screen: string; ios: boolean }) {
  const { t, language } = useI18n();
  const providers = ios ? IOS_PROVIDERS : undefined;
  switch (screen) {
    case "disclosure":
      return <ProminentDisclosure onAccept={noop} />;
    case "signin":
    case "signinError":
      return (
        <Login
          onSuccess={noop}
          onNeedsVerification={noop}
          onGoRegister={noop}
          onGoForgotPassword={noop}
          seed={{ error: screen === "signinError" ? BLOCKED : undefined, providers }}
        />
      );
    case "register":
      return <Register onNeedsVerification={noop} onSuccess={noop} onGoLogin={noop} seed={{ providers }} />;
    case "forgot":
      return <ForgotPassword onDone={noop} onCancel={noop} />;
    case "verify":
      return <VerifyEmail email="you@example.com" onVerified={noop} onGoLogin={noop} />;
  }
  // Settings › Per-app routing, as Settings draws its sub-page.
  return (
    <AppShell
      active="settings"
      shown="idle"
      email="you@example.com"
      planLine={planLineText({ daysLeft: 6, unlimited: true }, t, language)}
      onOverview={noop}
      onLocations={noop}
      onOpenActivity={noop}
      onOpenSettings={noop}
      onBrowsePlans={noop}
      onOpenReferrals={noop}
      onOpenSupport={noop}
      onSignOut={noop}
      signingOut={false}
      scene={<PageScene />}
    >
      <Page title={t("set.perApp")} back={noop} backAlways backLabel={t("settings.title")} data-settings-sub="custom">
        <div className="nx-sub">
          <div className="nx-stack">
            <PerAppCard />
          </div>
        </div>
      </Page>
    </AppShell>
  );
}

function Composed({
  sc,
  language,
  width,
  sheet,
  onSheet,
  view,
  onNavigate,
}: {
  sc: Scenario;
  language: Language;
  width: number;
  sheet: boolean;
  onSheet: (open: boolean) => void;
  view: "overview" | "locations";
  /** The shell's nav, as the app wires it: another screen or view. */
  onNavigate: (screen: string) => void;
}) {
  const { t } = useI18n();
  // As the Dashboard decides it (lib/app-layout.ts): by the app root's
  // width, which is the frame's less the side insets.
  const appRootRef = useRef<HTMLDivElement>(null);
  const layout = useLayoutMode(appRootRef, layoutFor(width));
  const [askDisconnect, setAskDisconnect] = useState(false);
  const askRef = useRef<HTMLButtonElement>(null);
  const reconnecting = sc.reconnecting ?? null;
  const dropped = sc.dropped ?? false;
  const teardownShowing = sc.teardownStuck ?? false;
  // As the Dashboard calls them.
  const press = pressFor(sc.state, { reconnectWaiting: reconnecting?.waiting === true });
  const headline = headlineFor(sc.state, { dropped, customMode: false, reconnecting });
  const held = sc.held ?? sc.state;
  const calmTone = shownTone(orbTone(held, false), { reconnecting: reconnecting !== null, dropped });
  const failed = sc.failed ?? false;
  const connectedAt = useMemo(() => (sc.timed ? Date.now() - 6_128_000 : null), [sc]);
  const chip = chipFor(sc.state, headline, { teardownShowing });
  const line = lineFor(sc.state, headline, { connectedAt, teardownShowing });
  const lineWords = t(line.kind === "words" ? line.key : headline.title);
  const pill = pillFor(sc.state, press, { pressed: sc.pressed ?? false, teardownShowing, failed });
  const secondary = secondaryFor(press, { reconnecting: reconnecting !== null, failed, teardownShowing });
  const hintText = teardownShowing ? "" : failed ? t("err.allProtocolsFailed") : t(phoneHint(headline.hint));

  const routes = ROUTES;
  const history = useMemo(() => sampleHistory(routes), [routes]);
  const current = sc.relay || sc.relayPinned ? routes.find((r) => r.id === "ir-de")! : sc.crossed ? routes.find((r) => r.id === "fi-reality")! : routes[0];
  // A failover is said only away from a pin (Dashboard.tsx): the same
  // country's other protocol, or Germany when it crossed to Finland.
  const chosen = sc.crossed ? routes[0] : sc.failover ? routes[1] : current;
  const pinned = Boolean(sc.relay || sc.relayPinned || sc.crossed || sc.failover);
  const protocol = customerProtocolLabel(current.protocol, current.transport);

  const plan = sc.plan ?? "unlimited";
  const subscribed = plan !== "none";
  const cap = plan === "capped" || plan === "low" ? 30 * 1024 ** 3 : null;
  const usedBytes = plan === "low" ? 28.4 * 1024 ** 3 : 7.2 * 1024 ** 3;
  const daysLeft = plan === "low" ? 2 : 6;
  const caution = planCaution(cap ? usedBytes / cap : null, daysLeft);
  const used = sizeParts(usedBytes, language);
  const trayPlan: TrayPlan | null = !subscribed
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
        renew: sc.offline ? null : { label: t("tr.renew"), onClick: noop },
      };
  const settled = sc.state === "connected" || sc.state === "unverified" || sc.state === "degraded";
  const automaticPending = !pinned && !settled;
  // Over a tunnel the app cannot name: no place, no protocol, no light --
  // "—", as the Dashboard says it (`tunnelNamed`).
  const named = !sc.unnamed;
  const location: TrayLocation = {
    flag: automaticPending ? (
      <span className="nx-flagbox auto">
        <Sparkles aria-hidden />
      </span>
    ) : current && named ? (
      <RouteFlag region={routePlace(current).entry} exitRegion={routePlace(current).exit} label={placeLabel(current, language)} size="lg" />
    ) : (
      <Globe className="size-5 text-ink-2" aria-hidden />
    ),
    name: automaticPending ? t("loc.automaticShort") : named ? placeLabel(current, language) : "—",
    sub: automaticPending || !named ? null : pinned ? protocol : `${t("loc.automaticShort")} · ${protocol}`,
    onChange: () => onSheet(true),
  };
  const ip = ipFor(sc.state, "198.51.100.42", { gaming: false });

  // The map, from the same function the Dashboard uses.
  const verified = named && (sc.state === "connected" || held === "connected") ? current : null;
  const evidenceCtx = { history, network: PREVIEW_NET, now: Date.now() };
  const mapScene = mapLights({
    routes,
    ...evidenceCtx,
    verified,
    tone: calmTone,
    shown: settled ? (named ? current : null) : sc.relayPinned ? current : null,
    up: settled && named ? current : null,
  });
  const mapPlaces = mapCountries(routes);
  const placeEvidence = placesEvidence(routes, evidenceCtx);
  const workedPlaces = new Set<string>();
  for (const [k, e] of placeEvidence) if (e.look === "live") workedPlaces.add(k);

  const notes = (
    <div className="nx-notes">
      {sc.teardownStuck ? <Note tone="danger">{t("err.teardownStuck")}</Note> : null}
      {sc.permission ? <Note tone="caution">{t(sc.ios ? "dash.vpnPermissionDeniedIos" : "dash.vpnPermissionDenied")}</Note> : null}
      {sc.unsupported ? <Note>{t("dash.androidWireguardOnly", { protocol: "OpenVPN" })}</Note> : null}
    </div>
  );
  const errorBlock = failed ? (
    <details className="nx-errdetail">
      <summary>{t("err.showDetail")}</summary>
      <p data-ltr>tried 4 of 4 available{"\n"}Stealth: timed out</p>
    </details>
  ) : null;
  const subline =
    (sc.state === "connected" || sc.state === "unverified") && (sc.failover || sc.crossed) ? (
      <p className="nx-subline">
        <Repeat aria-hidden />
        <span>
          <Slotted text={t("dash.switchedTo", { protocol: PROTOCOL_SLOT })}>
            <bdi className="font-medium text-ink">{protocol}</bdi>
          </Slotted>
        </span>
      </p>
    ) : null;
  const exitOf = (r: RouteOption) => routePlace(r).exit ?? routePlace(r).entry;
  const crossedBorder = subline !== null && exitOf(chosen) !== exitOf(current);

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
      {!subscribed ? (
        <Banner title={t("dash.noSubscription")}>
          <span>{t("dash.noPlanHint")}</span>
        </Banner>
      ) : null}
    </>
  );
  const bannerShowing = Boolean(sc.offline || plan === "ended" || !subscribed);
  const mapAlert = bannerShowing || Boolean(sc.slot) || failed || Boolean(sc.teardownStuck || sc.permission || sc.unsupported);

  const actions = subscribed ? (
    <div className="nx-actions">
      <ConnectOrb state={held} caution={false} onToggle={noop} label={t(pill.labelKey)} pressLabel={press.action === "cancelConnect" ? t("btn.stop") : undefined} look="pill" pill={pill} />
      {secondary === "stopReconnecting" ? (
        <WayOut label={t("dash.reconnectStop")} short={t("btn.stopShort")} />
      ) : secondary === "stopConnecting" ? (
        <WayOut label={t("btn.stop")} short={t("btn.stopShort")} />
      ) : secondary === "tryAnother" ? (
        <WayOut label={t("btn.tryAnother")} short={t("btn.tryAnotherShort")} onClick={() => onSheet(true)} />
      ) : null}
    </div>
  ) : (
    <div className="nx-actions">
      <PillButton>{t("dash.viewPlans")}</PillButton>
    </div>
  );

  // The list's row in use, held through a brief gap as the main page's is.
  const listLook = heldListLook({
    state: sc.state,
    look: held,
    routeId: settled && named ? current.id : null,
    settledRouteId: named ? current.id : null,
  });
  const picker = subscribed ? (
    <LocationPicker
      variant={view === "locations" ? "page" : layout === "narrow" ? "sheet" : "panel"}
      subscriptionId="preview"
      currentRouteId={listLook.routeId ?? undefined}
      tunnelActive={sc.state !== "disconnected"}
      connectionState={sc.state}
      lookState={listLook.state}
      initialRoutes={routes}
      evidence={{ places: placeEvidence, worked: workedPlaces, ownAt: (r) => ownWorkedAt(r, evidenceCtx), tags: true }}
      automatic={automaticPending && listLook.state === sc.state}
      onChooseAutomatic={noop}
      onClose={() => onSheet(false)}
      onSwitched={noop}
      onOpenFull={noop}
      confirmPick={async () => {
        if (sc.state !== "disconnected") setAskDisconnect(true);
        return false;
      }}
    />
  ) : null;

  return (
    <AppShell
      rootRef={appRootRef}
      active={view === "locations" ? "locations" : "overview"}
      shown={calmTone}
      busy={pill.progress}
      banner={bannerShowing}
      email="you@example.com"
      planLine={planLineText(subscribed ? { daysLeft, unlimited: cap === null } : null, t, language)}
      onOverview={() => onNavigate("main")}
      onLocations={() => onNavigate("locations")}
      onOpenActivity={noop}
      onOpenSettings={() => onNavigate("perapp")}
      onBrowsePlans={noop}
      onOpenReferrals={noop}
      onOpenSupport={noop}
      onSignOut={noop}
      signingOut={false}
      scene={view === "locations" ? <PageScene /> : <HeroArt tone={calmTone} layout={layout} map={mapScene} countries={mapPlaces} alert={mapAlert} />}
    >
      {view === "locations" ? (
        <Page title={t("loc.panelTitle")} lede={t("loc.pageLede")} className="nx-locpg">
          {picker}
        </Page>
      ) : (
        <MainView
          banner={banner}
          chip={<StatusChip glyph={chip.glyph} label={t(chip.labelKey)} />}
          line={<StateLine line={line} words={lineWords} decor={<Decor keys={["decor.browse", "decor.stream", "decor.work", "decor.anywhere"]} />} />}
          hint={
            <Hint tone={hintTone(calmTone, { failed })} reserve={PHONE_HEADLINE_HINTS}>
              {hintText}
            </Hint>
          }
          slot={sc.slot ? <DeviceSlotCard notice={SLOT_NOTICE} tunnelDown onUseHere={noop} onDismiss={noop} /> : undefined}
          subline={subline}
          sublineStays={crossedBorder}
          actions={sc.slot ? null : actions}
          error={errorBlock}
          notes={notes}
          locationCard={subscribed ? <LocationCard location={location} /> : null}
          metrics={subscribed ? <MetricCards plan={trayPlan} ip={ip} /> : null}
          summary={subscribed ? <SummaryLine plan={trayPlan} ip={ip} /> : null}
          panel={layout !== "narrow" ? picker : null}
          panelLabel={t("loc.panelTitle")}
          legend={<MapLegend />}
          mapStage={layout !== "wide" ? <WorldMap host="stage" lights={mapScene.lights} arc={mapScene.arc} countries={mapPlaces} alert={mapAlert} /> : null}
          tray={<SessionTray label={t("tr.location")} location={location} plan={trayPlan} ip={ip} />}
          announcer={<StateAnnouncer text={`${lineWords}. ${hintText}`} />}
        />
      )}
      {layout === "narrow" && view === "overview" ? (
        <LocationSheet open={sheet && subscribed} title={t("loc.panelTitle")} closeLabel={t("loc.close")} onClose={() => onSheet(false)}>
          {picker}
        </LocationSheet>
      ) : null}
      <Dialog
        open={askDisconnect}
        title={t("dash.disconnectToChange")}
        onClose={() => setAskDisconnect(false)}
        initialFocus={askRef}
        actions={
          <PillButton ref={askRef} size="sm" onClick={() => setAskDisconnect(false)}>
            {t("sum.close")}
          </PillButton>
        }
      />
    </AppShell>
  );
}
