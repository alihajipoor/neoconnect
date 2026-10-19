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
import type { RouteOption, Subscription } from "../lib/types";

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
  register: "Create account",
  forgot: "Forgot password",
  verify: "Verify email",
  settings: "Settings",
  activity: "Activity",
  activityEmpty: "Activity, network unknown",
  plans: "Plans",
  support: "Support",
  referrals: "Invite friends",
};

const NAV: Record<string, NavId> = {
  locations: "locations",
  settings: "settings",
  activity: "activity",
  activityEmpty: "activity",
  plans: "none",
  support: "none",
  referrals: "none",
};

const noop = () => undefined;

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
  const { t } = useI18n();
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
      return <Login onSuccess={noop} onNeedsVerification={noop} onGoRegister={noop} onGoForgotPassword={noop} />;
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
      return <Register onNeedsVerification={noop} onSuccess={noop} onGoLogin={noop} />;
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
      />
    ) : screen === "activity" || screen === "activityEmpty" ? (
      <ActivityView data={activity} onOpenPlans={noop} />
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
      planLine="6 days left · Unlimited"
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
