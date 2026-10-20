import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ScreenTransition } from "@shared/components/ScreenTransition";
import { getTokens } from "@shared/lib/session";
import { flushAttempts } from "@shared/lib/attempts";
import { endCustomerSession, setTunnelTeardown, type SessionEnd } from "@shared/lib/session-end";
import { autoReconnect } from "@shared/lib/auto-reconnect";
import { onSessionRevoked } from "@shared/lib/session-revoked";
import { useI18n } from "@shared/lib/i18n";
import { tearDownMobileForSignOut, vpnStatus } from "./lib/vpn";
import { setRelayTunnelReader } from "@shared/lib/last-resort";
import { BackupRouteChip } from "@shared/components/BackupRoute";
import { AppShell, type NavId } from "@shared/components/shell/AppShell";
import { PageScene } from "@shared/components/shell/Page";
import { forgetShellProfile, planLineText, requestLocations, shellProfile } from "@shared/lib/shell-nav";
import { Login } from "@shared/screens/Login";
import { Register } from "@shared/screens/Register";
import { VerifyEmail } from "@shared/screens/VerifyEmail";
import { ForgotPassword } from "@shared/screens/ForgotPassword";
import { Plans } from "@shared/screens/Plans";
import { StorePlans } from "@shared/screens/StorePlans";
import { Referrals } from "@shared/screens/Referrals";
import { Support } from "@shared/screens/Support";
import { Settings } from "@shared/screens/Settings";
import { Activity } from "@shared/screens/Activity";
import { logout } from "@shared/lib/auth";
import { networkKeyFromAsn } from "@shared/lib/network-identity";
import { IS_STORE_BUILD } from "@shared/lib/distribution";
import { sweepUnfinishedPurchases } from "@shared/lib/iap";
import { Dashboard } from "./screens/Dashboard";
import { PerAppCard } from "./components/PerAppCard";
import { isAndroid, isIOS } from "./lib/platform";
import { ProminentDisclosure, hasAcceptedDisclosure } from "./components/ProminentDisclosure";
import { appPrefs } from "@shared/lib/app-prefs";
import { PHONE_DEVICE, noticesFor, setNotices } from "./lib/phone-notices";
import { AndroidUpdateRow } from "./components/AndroidUpdateRow";
import { autoConnectLatch } from "@shared/lib/auto-connect";
import { sessionLog } from "@shared/lib/session-log";
import { PHONE_MAIN_PAGE_EXTRAS } from "./lib/phone-main-extras";

/** How often a queued diagnostic report retries. Matches the desktop
 * client so the two do not report at different rates for no reason. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// Every session end on this device -- the shared `logout()` and
// `deleteAccount()` included -- takes the phone's tunnel down and
// forgets the profiles the system keeps, rather than asking the desktop
// service that does not exist here. At module scope so it is in place
// before any screen can end a session.
setTunnelTeardown(tearDownMobileForSignOut);

// An automatic reconnect after a drop waits for the app to be in front.
// Neither phone has background work of this kind to run it from: the
// Android tunnel's foreground service lives in its own process and runs
// no JavaScript, and iOS suspends the app within seconds -- a pass begun
// there would be frozen half-way. So a drop noticed in the background is
// reconnected when the app is next opened, and says "Reconnecting..."
// then. See lib/reconnect-steps.ts and the journal.
autoReconnect.setRequiresForeground(true);

// The relay of last resort is dialled only while the phone reports no
// tunnel (docs/relay-last-resort.md, R1.5), asked at send time. An error
// or no answer keeps it closed (last-resort.ts).
setRelayTunnelReader(async () => (await vpnStatus()).connected);

/** The Android client.
 *
 * Every screen here except the Dashboard is the Windows client's,
 * imported rather than copied. Sign-in, registration, verification,
 * password reset, plans and purchase, vouchers, referrals, support and
 * settings are the same product on both platforms; duplicating them
 * would mean every future fix landing twice, and one of the two copies
 * eventually not getting it.
 *
 * The Dashboard is local because it is the screen that drives the
 * tunnel, and the tunnel is nothing alike -- one VpnService and one file
 * descriptor here, against a privileged service owning adapters and the
 * routing table there. Custom mode splits for the same reason, and is
 * passed into the shared Settings as a slot.
 *
 * Updates: Android cannot silently replace its own APK, so the direct
 * build says in Settings when a newer one is published and opens its
 * download (components/AndroidUpdateRow.tsx); Android's installer asks
 * before replacing anything. Play and the App Store update their own.
 */
type Screen =
  | "loading"
  | "signingOut"
  | "disclosure"
  | "login"
  | "register"
  | "forgot"
  | "verify"
  | "dashboard"
  | "plans"
  | "settings"
  | "referrals"
  | "support"
  | "activity";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Carries the just-submitted credentials into the verify screen so it
  // can sign in the moment the code is confirmed. Held in memory only.
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  // After a sign-up through the relay: "enter an Ultimate voucher code".
  const [plansNotice, setPlansNotice] = useState<string | null>(null);
  const endingRef = useRef(false);
  // A sign-out from one of the shell's pages, from its profile menu.
  const [pageSigningOut, setPageSigningOut] = useState(false);
  const { t, language } = useI18n();
  const prefs = useSyncExternalStore(appPrefs.subscribe, appPrefs.current, appPrefs.current);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // The device's preferences, read once per run (lib/app-prefs.ts).
  useEffect(() => {
    let alive = true;
    void appPrefs.load().then(() => alive && setPrefsLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  // The session log keeps seven days while the app runs, not only at each
  // start (lib/session-log.ts).
  useEffect(() => sessionLog.keepPruned(), []);

  // The tunnel's own notifications (lib/phone-notices.ts) in the app's
  // language, with the customer's setting: handed to the native side now
  // and whenever either changes, so what it posts in the background is
  // what Settings says. Not before the setting has been read -- a default
  // is not the customer's answer.
  useEffect(() => {
    if (!prefsLoaded) return;
    const platform = isAndroid() ? "android" : isIOS() ? "ios" : null;
    if (platform === null) return;
    void setNotices(noticesFor(t, prefs.notifications, platform)).catch(() => undefined);
    // `t` follows the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, prefs.notifications, language]);

  // The disclosure gates everything, including a session that is already
  // signed in. Play wants it shown before the data collection begins,
  // and someone upgrading from an earlier build has never seen it -- so
  // "has a token" is not evidence of having been told.
  //
  // "Connect when Neoxify starts" is for a run that opens on the main page
  // signed in, with the disclosure already accepted: a run that opens on
  // either of the other two has nothing to connect "on start", now or after
  // (lib/auto-connect.ts, lib/phone-main-extras.ts).
  useEffect(() => {
    void (async () => {
      if (!(await hasAcceptedDisclosure())) {
        autoConnectLatch.disarm();
        setScreen("disclosure");
        return;
      }
      try {
        const tokens = await getTokens();
        if (!tokens) autoConnectLatch.disarm();
        setScreen(tokens ? "dashboard" : "login");
      } catch {
        autoConnectLatch.disarm();
        setScreen("login");
      }
    })();
  }, []);

  /** Where to land once the disclosure is accepted -- the same decision
   * the effect above makes, deferred until now because it was skipped. */
  async function afterDisclosure() {
    try {
      const tokens = await getTokens();
      setScreen(tokens ? "dashboard" : "login");
    } catch {
      setScreen("login");
    }
  }

  // Anything the device could not report at the time -- which is every
  // "could not reach the control plane", since it cannot be reported
  // while it is true -- goes out now. Unawaited and silent by design.
  //
  // Retried on a timer as well as at startup. Flushing only on a cold
  // start meant the reports that matter most never arrived: a customer
  // whose network is being interfered with keeps the app open and keeps
  // retrying, so the moment when the control plane is reachable again
  // often came while the app was already running. The panel has
  // recorded successes and not one failure from any customer, which is
  // not what was happening -- only what we could see.
  useEffect(() => {
    void flushAttempts();
    const timer = setInterval(() => void flushAttempts(), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Deliberately no deep-link handling, unlike the Windows client.
  //
  // There the `neoconnect://` scheme is registered with Windows and the
  // email's "Open in Neoxify" link launches the app. Claiming the
  // equivalent on Android means hosting a signed assetlinks.json for the
  // domain and matching it to the release signing key -- until that
  // exists, an intent filter would produce a link that opens the app and
  // then does nothing, which is worse than one that opens the browser
  // page that already works. The 6-digit code in the same email is the
  // route that works today, on both platforms.


  // Anything paid for but never granted, from a run that died between
  // Apple taking the money and our API hearing about it. Rare, and the
  // customer is out of pocket until it runs -- so it runs on every
  // launch rather than being triggered by anything they have to find.
  //
  // Silent either way: a recovered purchase simply appears on the
  // dashboard, and a failure here must not push itself in front of
  // somebody trying to connect. It is retried on the next launch.
  useEffect(() => {
    void sweepUnfinishedPurchases().catch(() => undefined);
  }, []);

  function goToVerify(email: string, password: string) {
    setPendingAuth({ email, password });
    setScreen("verify");
  }

  /** The one place a session ends on this device, whatever ended it.
   *
   * This is the reported bug. An Android tester signed out and the VPN
   * stayed connected and kept carrying traffic: every route back to
   * sign-in here was a bare `setScreen("login")`, the expired-session
   * route did not even clear the cached credentials, and nothing on any
   * of them touched the tunnel -- which lives in a VpnService or a
   * NetworkExtension and outlives every screen.
   *
   * Same shape as the desktop App's: the tunnel comes down (and the
   * stored profiles are forgotten) before the sign-in screen is drawn,
   * and a teardown that could not be confirmed is said, not hidden. */
  async function handleLoggedOut(reason: "signedOut" | "revoked" = "signedOut") {
    if (endingRef.current) return;
    endingRef.current = true;
    setScreen("signingOut");
    // The avatar line belongs to the account that just left; a later
    // sign-in in this run is not "when Neoxify starts"; and the session log
    // goes with the session, off for whoever signs in next
    // (lib/session-log.ts).
    forgetShellProfile();
    autoConnectLatch.disarm();
    void sessionLog.wipe();
    try {
      let ended: SessionEnd;
      try {
        ended = await endCustomerSession();
      } catch {
        ended = { tunnel: "unconfirmed" };
      }
      setPendingAuth(null);
      setLoginNotice(
        ended.tunnel === "unconfirmed"
          ? t("signout.tunnelUnconfirmed")
          : reason === "revoked"
            ? t("signout.sessionEnded")
            : null,
      );
      setScreen("login");
    } finally {
      endingRef.current = false;
    }
  }

  /** Signing out from Settings, after it has asked: an automatic
   * reconnect waiting for the app to be in front is cancelled, then
   * `logout()` takes the tunnel down (setTunnelTeardown above) before it
   * deletes anything, then the session ends as every other way does. */
  async function signOutFromSettings() {
    if (pageSigningOut) return;
    setPageSigningOut(true);
    autoReconnect.cancel("signedOut");
    try {
      await logout();
    } finally {
      setPageSigningOut(false);
      await handleLoggedOut();
    }
  }

  // See the desktop App: registered once, always calling the current
  // render's handler.
  const handleLoggedOutRef = useRef(handleLoggedOut);
  handleLoggedOutRef.current = handleLoggedOut;
  useEffect(() => onSessionRevoked(() => void handleLoggedOutRef.current("revoked")), []);

  /** One of the signed-in pages in the same shell as the main page -- the
   * bottom nav on a phone, the tabs or the sidebar on a tablet -- as on
   * Windows. `active` is the nav item it belongs to. The avatar line is
   * the one the main page last showed (`shellProfile`). */
  const inShell = (active: NavId, content: ReactNode) => {
    const profile = shellProfile();
    return (
      <AppShell
        active={active}
        shown="idle"
        email={profile.email}
        planLine={planLineText(profile.plan, t, language)}
        onOverview={() => setScreen("dashboard")}
        onLocations={() => {
          requestLocations();
          setScreen("dashboard");
        }}
        onOpenActivity={() => setScreen("activity")}
        onOpenSettings={() => setScreen("settings")}
        onBrowsePlans={() => setScreen("plans")}
        onOpenReferrals={() => setScreen("referrals")}
        onOpenSupport={() => setScreen("support")}
        onSignOut={() => void signOutFromSettings()}
        signingOut={pageSigningOut}
        scene={<PageScene />}
      >
        {content}
      </AppShell>
    );
  };

  function renderScreen() {
  if (screen === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }
  if (screen === "signingOut") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("nav.signingOut")}
      </div>
    );
  }
  if (screen === "disclosure") {
    return <ProminentDisclosure onAccept={() => void afterDisclosure()} />;
  }
  if (screen === "login") {
    return (
      <Login
        onSuccess={() => setScreen("dashboard")}
        onNeedsVerification={goToVerify}
        onGoRegister={() => setScreen("register")}
        onGoForgotPassword={() => setScreen("forgot")}
        notice={loginNotice}
      />
    );
  }
  if (screen === "register") {
    return <Register
        onNeedsVerification={goToVerify}
        onSuccess={() => setScreen("dashboard")}
        onGoLogin={() => setScreen("login")}
        // Where the voucher field is. Not in a store build, which cannot
        // redeem one (guideline 3.1.1): an iPhone customer redeems on
        // another device, a gap docs/relay-last-resort.md states (R5.4).
        onRelaySignedUp={() => {
          if (IS_STORE_BUILD) {
            setScreen("dashboard");
            return;
          }
          setPlansNotice(t("relay.created"));
          setScreen("plans");
        }}
      />;
  }
  if (screen === "forgot") {
    return (
      <ForgotPassword
        onDone={(notice) => {
          setLoginNotice(notice);
          setScreen("login");
        }}
        onCancel={() => setScreen("login")}
      />
    );
  }
  if (screen === "verify" && pendingAuth) {
    return (
      <VerifyEmail
        email={pendingAuth.email}
        password={pendingAuth.password}
        onVerified={() => {
          setPendingAuth(null);
          setScreen("dashboard");
        }}
        onGoLogin={() => {
          setPendingAuth(null);
          setScreen("login");
        }}
      />
    );
  }
  if (screen === "settings") {
    return inShell(
      "settings",
      <Settings
        onBack={() => setScreen("dashboard")}
        onOpenReferrals={() => setScreen("referrals")}
        onOpenSupport={() => setScreen("support")}
        onLoggedOut={() => void handleLoggedOut()}
        // Android only. Custom mode is per-app routing, which on iOS
        // belongs to the system: `vpn_list_apps` has no iOS
        // implementation and returns unavailable(), so this card
        // offered a feature that errored the moment it was switched
        // on -- which is also what App Review would find. Positive
        // test rather than `!isIOS()`, so a platform this does not
        // recognise hides the section instead of offering a broken one.
        customSection={isAndroid() ? <PerAppCard /> : null}
        onOpenPlans={() => setScreen("plans")}
        onOpenActivity={() => setScreen("activity")}
        onSignOut={() => void signOutFromSettings()}
        platform={isAndroid() ? "android" : isIOS() ? "ios" : "web"}
        // Notifications only (lib/phone-notices.ts): the rows a phone does
        // not honour are not drawn.
        device={isAndroid() || isIOS() ? PHONE_DEVICE : undefined}
        // The direct APK only: Play and the App Store update their own
        // builds, and a store build never carries the check.
        aboutExtra={isAndroid() && !IS_STORE_BUILD ? <AndroidUpdateRow /> : null}
      />,
    );
  }
  if (screen === "activity") {
    return inShell(
      "activity",
      <Activity
        // The network the phone's connect history is filed under: the
        // address block the control plane last reported for it.
        readNetwork={async () => networkKeyFromAsn()}
        onOpenPlans={() => setScreen("plans")}
        onBack={() => setScreen("settings")}
        // Offered once the phone's main page records it
        // (lib/phone-main-extras.ts); not before.
        sessionLog={PHONE_MAIN_PAGE_EXTRAS}
      />,
    );
  }
  if (screen === "referrals") {
    // Back to Settings rather than the Dashboard: that is where they came
    // from, and landing somewhere else is how a detour starts feeling
    // like getting lost.
    return inShell("none", <Referrals onBack={() => setScreen("settings")} />);
  }
  if (screen === "support") {
    return inShell("none", <Support onBack={() => setScreen("settings")} />);
  }
  // Unreachable in a store build, and unreachable rather than merely
  // unlinked: the condition is a build-time constant, so the bundler
  // drops this branch and the Plans screen -- with its purchase flow and
  // its voucher field -- is not present in the artifact at all. Hiding
  // the entrance would still ship the room, which is what a reviewer
  // looks for and what a determined customer finds.
  if (screen === "plans" && !IS_STORE_BUILD) {
    const leavePlans = () => {
      setPlansNotice(null);
      setScreen("dashboard");
    };
    return inShell("none", <Plans onActivated={leavePlans} onBack={leavePlans} notice={plansNotice} />);
  }
  // The App Store counterpart, and the mirror image of the branch above:
  // this one is dropped from every non-store build for the same reason,
  // so neither artifact carries the other's purchase path.
  if (screen === "plans" && IS_STORE_BUILD) {
    return inShell(
      "none",
      <StorePlans
        onActivated={() => setScreen("dashboard")}
        onBack={() => setScreen("dashboard")}
      />,
    );
  }
    return (
      <Dashboard
        onLoggedOut={() => void handleLoggedOut()}
        onBrowsePlans={() => setScreen("plans")}
        onOpenSettings={() => setScreen("settings")}
        onOpenActivity={() => setScreen("activity")}
        onOpenReferrals={() => setScreen("referrals")}
        onOpenSupport={() => setScreen("support")}
      />
    );
  }

  // As on the desktop: the backup-route chip above every screen while
  // relay mode lasts. Its row takes the status bar's inset while it shows,
  // and the screen beneath then takes none (globals.css).
  return (
    <div className="flex h-full flex-col">
      <div className="nx-relayrow">
        <BackupRouteChip />
      </div>
      <div className="nx-screen min-h-0 flex-1">
        {/* Through the View Transitions API where the WebView has it
            (Android's Chromium WebView; WKWebView from iOS 18), so the
            bottom nav keeps still and its pill travels while the page
            slides; the CSS slide where it does not. */}
        <ScreenTransition screenKey={screen} viewTransitions>
          {renderScreen()}
        </ScreenTransition>
      </div>
    </div>
  );
}
