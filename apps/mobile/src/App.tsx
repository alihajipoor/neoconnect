import { useEffect, useRef, useState } from "react";
import { ScreenTransition } from "@shared/components/ScreenTransition";
import { getTokens } from "@shared/lib/session";
import { flushAttempts } from "@shared/lib/attempts";
import { endCustomerSession, setTunnelTeardown, type SessionEnd } from "@shared/lib/session-end";
import { onSessionRevoked } from "@shared/lib/session-revoked";
import { useI18n } from "@shared/lib/i18n";
import { tearDownMobileForSignOut } from "./lib/vpn";
import { Login } from "@shared/screens/Login";
import { Register } from "@shared/screens/Register";
import { VerifyEmail } from "@shared/screens/VerifyEmail";
import { ForgotPassword } from "@shared/screens/ForgotPassword";
import { Plans } from "@shared/screens/Plans";
import { StorePlans } from "@shared/screens/StorePlans";
import { Referrals } from "@shared/screens/Referrals";
import { Support } from "@shared/screens/Support";
import { Settings } from "@shared/screens/Settings";
import { IS_STORE_BUILD } from "@shared/lib/distribution";
import { sweepUnfinishedPurchases } from "@shared/lib/iap";
import { Dashboard } from "./screens/Dashboard";
import { PerAppCard } from "./components/PerAppCard";
import { isAndroid } from "./lib/platform";
import { ProminentDisclosure, hasAcceptedDisclosure } from "./components/ProminentDisclosure";

/** How often a queued diagnostic report retries. Matches the desktop
 * client so the two do not report at different rates for no reason. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// Every session end on this device -- the shared `logout()` and
// `deleteAccount()` included -- takes the phone's tunnel down and
// forgets the profiles the system keeps, rather than asking the desktop
// service that does not exist here. At module scope so it is in place
// before any screen can end a session.
setTunnelTeardown(tearDownMobileForSignOut);

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
 * No update banner: Android cannot silently replace its own APK, so
 * in-app updating is a different mechanism entirely and is not wired up
 * yet. Better absent than present and lying about what it will do.
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
  | "support";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Carries the just-submitted credentials into the verify screen so it
  // can sign in the moment the code is confirmed. Held in memory only.
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const endingRef = useRef(false);
  const { t } = useI18n();

  // The disclosure gates everything, including a session that is already
  // signed in. Play wants it shown before the data collection begins,
  // and someone upgrading from an earlier build has never seen it -- so
  // "has a token" is not evidence of having been told.
  useEffect(() => {
    void (async () => {
      if (!(await hasAcceptedDisclosure())) {
        setScreen("disclosure");
        return;
      }
      try {
        const tokens = await getTokens();
        setScreen(tokens ? "dashboard" : "login");
      } catch {
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

  // See the desktop App: registered once, always calling the current
  // render's handler.
  const handleLoggedOutRef = useRef(handleLoggedOut);
  handleLoggedOutRef.current = handleLoggedOut;
  useEffect(() => onSessionRevoked(() => void handleLoggedOutRef.current("revoked")), []);

  function renderScreen() {
  if (screen === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
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
    return (
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
      />
    );
  }
  if (screen === "referrals") {
    // Back to Settings rather than the Dashboard: that is where they came
    // from, and landing somewhere else is how a detour starts feeling
    // like getting lost.
    return <Referrals onBack={() => setScreen("settings")} />;
  }
  if (screen === "support") {
    return <Support onBack={() => setScreen("settings")} />;
  }
  // Unreachable in a store build, and unreachable rather than merely
  // unlinked: the condition is a build-time constant, so the bundler
  // drops this branch and the Plans screen -- with its purchase flow and
  // its voucher field -- is not present in the artifact at all. Hiding
  // the entrance would still ship the room, which is what a reviewer
  // looks for and what a determined customer finds.
  if (screen === "plans" && !IS_STORE_BUILD) {
    return <Plans onActivated={() => setScreen("dashboard")} onBack={() => setScreen("dashboard")} />;
  }
  // The App Store counterpart, and the mirror image of the branch above:
  // this one is dropped from every non-store build for the same reason,
  // so neither artifact carries the other's purchase path.
  if (screen === "plans" && IS_STORE_BUILD) {
    return (
      <StorePlans
        onActivated={() => setScreen("dashboard")}
        onBack={() => setScreen("dashboard")}
      />
    );
  }
    return (
      <Dashboard
        onLoggedOut={() => void handleLoggedOut()}
        onBrowsePlans={() => setScreen("plans")}
        onOpenSettings={() => setScreen("settings")}
      />
    );
  }

  return <ScreenTransition screenKey={screen}>{renderScreen()}</ScreenTransition>;
}
