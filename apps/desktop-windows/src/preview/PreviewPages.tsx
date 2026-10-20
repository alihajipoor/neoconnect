import { useMemo } from "react";
import { Login } from "../screens/Login";
import { Register } from "../screens/Register";
import { ForgotPassword } from "../screens/ForgotPassword";
import { VerifyEmail } from "../screens/VerifyEmail";
import { Settings } from "../screens/Settings";
import { Plans } from "../screens/Plans";
import { Support } from "../screens/Support";
import { Referrals } from "../screens/Referrals";
import { ActivityView, type ActivityData } from "../screens/Activity";
import { CustomModeCard } from "../components/CustomModeCard";
import { GamingModeCard } from "../components/GamingModeCard";
import { AppShell, type NavId } from "../components/shell/AppShell";
import { PageScene } from "../components/shell/Page";
import { CommunityLinks } from "../components/CommunityLinks";
import { recordAttempt, type ConnectHistory } from "../lib/connect-history";
import { LocationPicker } from "../components/LocationPicker";
import { Page } from "../components/shell/Page";
import { ownWorkedAt, placesEvidence } from "../lib/map-lights";
import { isTunnelUp } from "../lib/connection-evidence";
import { useI18n } from "../lib/i18n";
import { planLineText } from "../lib/shell-nav";
import type { RouteOption, Subscription } from "../lib/types";
import type { ShownFailure } from "../lib/failure-text";
import type { SocialProvider } from "../lib/social-auth";
import type { DeviceSettings } from "../screens/Settings";
import type { AccountDevices, DailyUsage } from "../lib/customer";
import type { SessionRecord } from "../lib/session-log";

/** DEV ONLY: the screens of phase 2 in the preview -- sign-in and its steps,
 * and the signed-in pages in the shell -- each drawn by the real component.
 * The account API answers from samples when the dev server runs with
 * NX_PREVIEW_MOCKS=1 (vite.config.ts); without it, those pages show what
 * they show when Neoxify cannot be reached. Activity is drawn from sample
 * history through its view, as the store it reads is the app's. */

export const PAGE_SCREENS: Record<string, string> = {
  main: "Main page",
  locations: "Locations page",
  signin: "Sign in",
  signinNotice: "Sign in, with a notice",
  signinError: "Sign in, network blocked",
  signinIntranet: "Sign in, intranet",
  signinIntranetError: "Sign in, intranet and an error",
  signinIos: "Sign in, iPhone (three providers)",
  register: "Create account",
  registerError: "Create account, an error",
  registerRelayOffer: "Create account, backup route offered",
  registerIos: "Create account, iPhone (three providers)",
  forgot: "Forgot password",
  verify: "Verify email",
  settings: "Settings",
  activity: "Activity",
  activityLog: "Activity, session log on",
  activityFailed: "Activity, account not reached",
  activityEmpty: "Activity, network unknown",
  plans: "Plans",
  support: "Support",
  referrals: "Invite friends",
};

const NAV: Record<string, NavId> = {
  locations: "locations",
  settings: "settings",
  activity: "activity",
  activityLog: "activity",
  activityFailed: "activity",
  activityEmpty: "activity",
  plans: "none",
  support: "none",
  referrals: "none",
};

const noop = () => undefined;

/** DEV ONLY: Windows' device rows, answered here (Settings' `DeviceSettings`). */
const PREVIEW_DEVICE: DeviceSettings = {
  autostart: { read: async () => true, write: async (on) => on },
  autoConnect: true,
  notifications: { setting: async () => "enabled" },
  reconnectHold: { apply: async () => undefined },
};

const DAY_MS = 86_400_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** DEV ONLY: the account's devices and a fortnight of usage, in the
 * backend's shapes (docs/account-activity.md). */
const SAMPLE_DEVICES: AccountDevices = {
  inUseKnown: true,
  devices: [
    { id: "d1", thisDevice: true, label: null, platform: "windows", signedInAt: isoAgo(17 * DAY_MS), lastSeenAt: isoAgo(60_000), inUse: { since: isoAgo(3_600_000), lastSeen: isoAgo(30_000) } },
    { id: "d2", thisDevice: false, label: "Pixel 7", platform: "android", signedInAt: isoAgo(21 * DAY_MS), lastSeenAt: isoAgo(5 * 3_600_000), inUse: null },
    { id: "d3", thisDevice: false, label: null, platform: "ios", signedInAt: isoAgo(3 * DAY_MS), lastSeenAt: isoAgo(DAY_MS), inUse: null },
  ],
};

function sampleUsage(): DailyUsage {
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * DAY_MS).toISOString().slice(0, 10);
    const down = i === 4 ? 0 : Math.round((0.4 + 0.6 * Math.abs(Math.sin(i * 1.3))) * 1.6e9);
    return { date: d, bytesDown: String(down), bytesUp: String(Math.round(down / 14)) };
  });
  return { subscriptionId: null, timeZone: "Asia/Tehran", from: days[0].date, to: days[13].date, asOf: isoAgo(90_000), days };
}

function sampleLog(): SessionRecord[] {
  const at = (h: number) => Date.now() - h * 3_600_000;
  return [
    { id: "s1", start: at(50), end: at(48.5), open: false, routeId: "de-stealth", protocol: "XRAY_VLESS_TLS", transport: "WS", rxBytes: 1.4e9, txBytes: 6.1e7, ended: "disconnected" },
    { id: "s2", start: at(26), end: null, open: false, routeId: "fi-reality", protocol: "XRAY_VLESS_REALITY", rxBytes: null, txBytes: null, ended: null },
    { id: "s3", start: at(3), end: at(2.2), open: false, routeId: "de-wg", protocol: "WIREGUARD", rxBytes: 3.2e8, txBytes: 1.2e7, ended: "lost" },
  ];
}

/** The failures a blocked network gives sign-in, the longest of each kind:
 * the network's block page, and nothing answering, the backup server
 * included (failure-text.ts). */
const BLOCKED: ShownFailure = { error: "", noResponse: true, blockPage: true };
const NOTHING_ANSWERED: ShownFailure = { error: "", noResponse: true, relayTried: true };
/** What an iPhone offers (`availableSocialProviders`); a browser has no Apple. */
const IOS_PROVIDERS: SocialProvider[] = ["apple", "google", "facebook"];

export function PreviewPage({
  screen,
  width,
  routes,
  history,
  network,
  subscription,
  tunnel = "disconnected",
}: {
  /** The tunnel state the scenario switcher has chosen, for the list. */
  tunnel?: string;
  screen: string;
  width: number;
  routes: RouteOption[];
  history: ConnectHistory;
  network: string;
  subscription: Subscription;
}) {
  const phone = width < 640;
  const { t, language } = useI18n();
  const activity = useMemo<ActivityData>(
    () => ({
      history: withMoreTries(history, network, routes),
      network: screen === "activityEmpty" ? null : network,
      routes,
      subscription,
      savedAt: Date.now() - 4 * 60_000,
    }),
    [history, network, routes, subscription, screen],
  );

  switch (screen) {
    case "signin":
    case "signinError":
    case "signinIntranet":
    case "signinIntranetError":
    case "signinIos":
      return (
        <Login
          onSuccess={noop}
          onNeedsVerification={noop}
          onGoRegister={noop}
          onGoForgotPassword={noop}
          seed={{
            error: screen === "signinError" ? BLOCKED : screen === "signinIntranetError" ? NOTHING_ANSWERED : undefined,
            intranet: screen === "signinIntranet" || screen === "signinIntranetError",
            providers: screen === "signinIos" ? IOS_PROVIDERS : undefined,
          }}
        />
      );
    case "signinNotice":
      return (
        <Login
          onSuccess={noop}
          onNeedsVerification={noop}
          onGoRegister={noop}
          onGoForgotPassword={noop}
          notice="Password changed. You can sign in now."
        />
      );
    case "register":
    case "registerError":
    case "registerRelayOffer":
    case "registerIos":
      return (
        <Register
          onNeedsVerification={noop}
          onSuccess={noop}
          onGoLogin={noop}
          seed={{
            error: screen === "registerError" ? NOTHING_ANSWERED : screen === "registerRelayOffer" ? BLOCKED : undefined,
            relayOffered: screen === "registerRelayOffer",
            providers: screen === "registerIos" ? IOS_PROVIDERS : undefined,
          }}
        />
      );
    case "forgot":
      return <ForgotPassword onDone={noop} onCancel={noop} />;
    case "verify":
      return <VerifyEmail email="you@example.com" onVerified={noop} onGoLogin={noop} />;
  }

  const ctx = { history, network, now: Date.now() };
  const up = isTunnelUp(tunnel as never);
  const page =
    screen === "locations" ? (
      <Page title={t("loc.panelTitle")} lede={t("loc.pageLede")} className="nx-locpg">
        <LocationPicker
          variant="page"
          subscriptionId={subscription.id}
          currentRouteId={up ? routes[0]?.id : undefined}
          tunnelActive={tunnel !== "disconnected"}
          connectionState={tunnel}
          initialRoutes={routes}
          automatic={!up}
          onChooseAutomatic={noop}
          onClose={noop}
          onSwitched={noop}
          confirmPick={async () => false}
          evidence={{
            places: placesEvidence(routes, ctx),
            worked: new Set([...placesEvidence(routes, ctx)].filter(([, e]) => e.look === "live").map(([k]) => k)),
            ownAt: (route) => ownWorkedAt(route, ctx),
            tags: true,
          }}
        />
      </Page>
    ) : screen === "settings" ? (
      <Settings
        onBack={noop}
        onOpenReferrals={noop}
        onOpenSupport={noop}
        onLoggedOut={noop}
        customSection={<CustomModeCard />}
        gamingSection={phone ? undefined : <GamingModeCard />}
        onOpenPlans={noop}
        onOpenActivity={noop}
        onSignOut={noop}
        platform={phone ? "android" : "windows"}
        device={phone ? undefined : PREVIEW_DEVICE}
      />
    ) : screen === "activity" || screen === "activityEmpty" || screen === "activityLog" || screen === "activityFailed" ? (
      <ActivityView
        data={activity}
        devices={screen === "activityFailed" ? { state: "failed", noAnswer: true } : { state: "ok", data: SAMPLE_DEVICES }}
        usage={screen === "activityFailed" ? { state: "failed", noAnswer: false } : { state: "ok", data: sampleUsage() }}
        log={
          phone
            ? undefined
            : {
                enabled: screen === "activityLog",
                loaded: true,
                records: screen === "activityLog" ? sampleLog() : [],
                onEnabled: noop,
                onClear: noop,
              }
        }
        onRetryDevices={noop}
        onRetryUsage={noop}
        onOpenPlans={noop}
      />
    ) : screen === "plans" ? (
      <Plans onActivated={noop} onBack={noop} />
    ) : screen === "support" ? (
      <Support onBack={noop} />
    ) : screen === "referrals" ? (
      <Referrals onBack={noop} />
    ) : null;

  return (
    <AppShell
      active={NAV[screen] ?? "none"}
      shown="idle"
      titlebar
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
      update={<CommunityLinks />}
      scene={<PageScene />}
    >
      {page}
    </AppShell>
  );
}

/** A few more tries on the sample network, so the Activity list shows a
 * failure after a success and a count above one. */
function withMoreTries(history: ConnectHistory, network: string, routes: RouteOption[]): ConnectHistory {
  let h = history;
  const now = Date.now();
  const de = routes.find((r) => r.id === "de-stealth");
  const wg = routes.find((r) => r.id === "de-wg");
  if (de) {
    h = recordAttempt(h, network, de.id, de.protocol, true, now - 50 * 60_000);
    h = recordAttempt(h, network, de.id, de.protocol, true, now - 12 * 60_000);
  }
  if (wg) h = recordAttempt(h, network, wg.id, wg.protocol, false, now - 13 * 60_000);
  return h;
}
