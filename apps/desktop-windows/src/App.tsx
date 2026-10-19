import { useEffect, useRef, useState, type ReactNode } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";
import { getTokens } from "./lib/session";
import { logout, verifyEmailByToken } from "./lib/auth";
import { autoReconnect } from "./lib/auto-reconnect";
import { flushAttempts } from "./lib/attempts";
import { endCustomerSession, type SessionEnd } from "./lib/session-end";
import { onSessionRevoked } from "./lib/session-revoked";
import { useI18n } from "./lib/i18n";
import { failureText } from "./lib/failure-text";
import { Login } from "./screens/Login";
import { Register } from "./screens/Register";
import { VerifyEmail } from "./screens/VerifyEmail";
import { ForgotPassword } from "./screens/ForgotPassword";
import { Dashboard } from "./screens/Dashboard";
import { ScreenTransition } from "./components/ScreenTransition";
import { Plans } from "./screens/Plans";
import { Settings } from "./screens/Settings";
import { Referrals } from "./screens/Referrals";
import { Support } from "./screens/Support";
import { Activity } from "./screens/Activity";
import { AppShell, type NavId } from "./components/shell/AppShell";
import { PageScene } from "./components/shell/Page";
import { CommunityLinks } from "./components/CommunityLinks";
import { forgetShellProfile, planLineText, requestLocations, shellProfile } from "./lib/shell-nav";
import { CustomModeCard } from "./components/CustomModeCard";
import { GamingModeCard } from "./components/GamingModeCard";
import { UpdateBanner } from "./components/UpdateBanner";
import { applyStagedUpdate, startUpdateChecks, type UpdateState } from "./lib/updates";
import { setRelayTunnelReader } from "./lib/last-resort";
import { BackupRouteChip } from "./components/BackupRoute";

/** How often a queued diagnostic report retries.
 *
 * Five minutes is short enough that a customer whose connection comes
 * and goes gets their failures out during the same sitting, and long
 * enough to be nothing on a network that is simply down. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// The relay of last resort is dialled only while the service reports no
// tunnel (docs/relay-last-resort.md, R1.5): asked at send time, every
// time, here as the Dashboard asks it. An error or no answer keeps the
// relay closed (last-resort.ts). At module scope, so it is in place
// before any screen can make a request.
setRelayTunnelReader(async () => (await invoke<{ connected: boolean }>("vpn_status")).connected);

type Screen =
  | "loading"
  | "signingOut"
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
  // Carries the just-submitted credentials from register/login into the
  // verify screen so it can auto-sign-in the moment the code is confirmed
  // -- see VerifyEmail's doc comment. Password is only ever held in
  // memory for this handoff, never persisted.
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  // What brought the customer to the plans screen, when it was a sign-up
  // through the relay: "enter an Ultimate voucher code".
  const [plansNotice, setPlansNotice] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "none" });
  const [restarting, setRestarting] = useState(false);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  // A sign-out pressed on one of the shell's pages, under way.
  const [pageSigningOut, setPageSigningOut] = useState(false);
  // Guards against processing the same deep-link URL twice -- the launch
  // URL can plausibly reach handleDeepLinkUrl via both the Rust-side
  // get_launch_deep_link command and the plugin's own onOpenUrl forwarding
  // it a second time. Verifying a valid token twice concurrently is a
  // real correctness risk (two racing calls could both see the account as
  // not-yet-verified and each try to grant a trial), not just a
  // cosmetic double-render.
  const handledDeepLinkUrls = useRef(new Set<string>());
  const endingRef = useRef(false);
  const { t, language } = useI18n();
  // Read through a ref by the deep-link handler, which is registered once
  // and would otherwise word its notice in the language of the first
  // render -- before the saved choice was read back from disk.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    // getTokens() swallows its own read failures, but a catch here too
    // means no future change to it can strand the app on "Loading..."
    // with no way forward.
    getTokens()
      .then((tokens) => setScreen(tokens ? "dashboard" : "login"))
      .catch(() => setScreen("login"));
  }, []);

  // Handles the "Open in Neoxify" link from the verification email --
  // `neoconnect://verify-email?token=...`. No password is available at
  // this point (a launch via a clicked link, not a live register/login
  // session in this same app instance), so this can't auto-sign-in the
  // way the in-app code flow does -- it verifies, then sends the user to
  // a normal sign-in with a confirmation message.
  async function handleDeepLinkUrl(url: string | undefined) {
    if (!url) return;
    if (handledDeepLinkUrls.current.has(url)) return;
    handledDeepLinkUrls.current.add(url);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.host !== "verify-email" && parsed.pathname !== "//verify-email") return;
    const token = parsed.searchParams.get("token");
    if (!token) return;

    const result = await verifyEmailByToken(token);
    // Somebody is signed in: leave them, and their tunnel, alone. Tokens
    // are only ever stored for a verified account, so a verify link has
    // nothing for a signed-in app to act on -- the common case is the
    // customer clicking the email's button after verifying by code. It
    // used to switch to the sign-in screen regardless, over a session
    // that was never ended: the tunnel stayed up with its polls stopped,
    // "Sign in" implied a device doing nothing, and signing in as someone
    // else adopted the first account's tunnel. Asked of the store, not of
    // `screen`, which this handler -- registered once -- would see stale.
    if (await getTokens().catch(() => null)) return;
    setPendingAuth(null);
    // In the customer's language, the reason included (failure-text.ts).
    // It used to be English whatever the app was in, and on a filtered
    // network the reason was "Could not reach Neoxify. Check your internet
    // connection." -- the one sentence the error text exists to translate.
    const say = tRef.current;
    setLoginNotice(
      result.ok
        ? say("auth.emailVerifiedNotice")
        : say("auth.verifyLinkFailed", { reason: failureText(result, say) }),
    );
    setScreen("login");
  }

  useEffect(() => {
    // Two distinct cases, both real: the link launches a fresh instance
    // of the app (the common case -- confirmed live, this is what
    // actually happens when Windows resolves the neoconnect:// scheme),
    // vs. the app is already running and gets the URL forwarded to it.
    // onOpenUrl covers the latter. For the former, a real bug found
    // live: the deep-link plugin's own getCurrent() JS API returned
    // nothing on a cold launch even though the URL was unambiguously
    // present in the process's argv (confirmed directly) -- the registry
    // association and launch worked, but the token was never consumed,
    // landing on a plain unnotified Login screen. get_launch_deep_link is
    // a small Rust command that reads argv itself instead of trusting
    // the plugin's capture path, since that's the exact thing already
    // proven to work.
    void invoke<string | null>("get_launch_deep_link").then((url) => handleDeepLinkUrl(url ?? undefined));
    const unlisten = onOpenUrl((urls) => void handleDeepLinkUrl(urls[0]));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Background update checking. Downloading is automatic; applying is
  // not -- see the note below on why there is no install-on-close.
  useEffect(() => startUpdateChecks(setUpdateState), []);

  // Anything the app could not report at the time -- which is every
  // "could not reach the control plane", since a client cannot tell us
  // that while it is true -- goes out now. Deliberately unawaited and
  // silent: it is diagnostics, and the customer is here to connect.
  //
  // Repeated, not just at startup, and that is the whole point. In ten
  // months of real use the panel has recorded successes and not one
  // failure, from any customer, on either platform -- while customers
  // were demonstrably failing to connect. The reports were being
  // written; they were queued because the control plane was unreachable
  // at that moment, and then only ever retried on the next cold start.
  // A customer whose network is being interfered with keeps the app
  // open and keeps retrying, so that moment often never came, and the
  // one class of failure worth seeing was the one that could never
  // reach us.
  //
  // Cheap when there is nothing to send: flushAttempts reads a local
  // store and returns.
  useEffect(() => {
    void flushAttempts();
    const timer = setInterval(() => void flushAttempts(), FLUSH_INTERVAL_MS);
    // Whenever the machine has just been given a working path to the
    // internet, the queue has its best chance of draining.
    const onOnline = () => void flushAttempts();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // There is deliberately no install-on-close handler here.
  //
  // There was one, and it made the app impossible to close. It called
  // `preventDefault()` and then awaited the install, but the NSIS
  // installer waits for the app to exit before it can replace the
  // files -- so the app waited for the installer and the installer
  // waited for the app. The X button did nothing and the only way out
  // was Task Manager, on every launch, because the update re-staged
  // itself twenty seconds later.
  //
  // Closing an app is the one interaction that must never be
  // negotiable. The update now applies only through the explicit
  // Restart button, which exits first and lets the installer own the
  // rest -- the path that actually works.

  function goToVerify(email: string, password: string) {
    setPendingAuth({ email, password });
    setScreen("verify");
  }

  async function restartForUpdate() {
    setRestarting(true);
    try {
      const status = await invoke<{ connected: boolean }>("vpn_status");
      if (status.connected) {
        // Refusing rather than silently dropping their tunnel:
        // replacing the binaries under a live VPN -- the helper service
        // among them -- cuts the connection with no warning.
        setUpdateBlocked(true);
        return;
      }
      await applyStagedUpdate(true);
    } catch {
      setUpdateBlocked(true);
    } finally {
      setRestarting(false);
    }
  }

  /** The one place a session ends, whatever ended it.
   *
   * Both screens that can drop the customer back to sign-in route
   * through here, and they arrive by more routes than the Sign out
   * button: `Dashboard.loadAll` calls it when the API reports the
   * session expired, `DeleteAccountSection` calls it after the account
   * is gone, and the API announces a refresh the server refused from
   * whichever screen made the request. `logout()` and `deleteAccount()`
   * do their own teardown, so for those this is a second, idempotent
   * pass -- the expired-session routes are the ones that had none,
   * because they never go through either function.
   *
   * The sign-in screen waits for the tunnel. It used to be drawn at
   * once, over a tunnel that was still up and that nothing on the
   * sign-in screen can disconnect; a screen that says "signed out" has
   * to mean the device has stopped sending traffic under that account,
   * or that the customer is told it could not be confirmed. The
   * teardown is bounded (see tunnel-teardown.ts), so this cannot strand
   * anybody on "Signing out...".
   *
   * One at a time: the routes above can fire together -- a refused
   * refresh during the Dashboard's first load is both of the first and
   * third -- and two passes would race each other's notices. */
  async function handleLoggedOut(reason: "signedOut" | "revoked" = "signedOut") {
    if (endingRef.current) return;
    endingRef.current = true;
    setScreen("signingOut");
    // The avatar line belongs to the account that just left.
    forgetShellProfile();
    try {
      let ended: SessionEnd;
      try {
        ended = await endCustomerSession();
      } catch {
        // The tokens or the snapshot could not be deleted. Not a reason
        // to keep showing a signed-in screen, but nothing was confirmed.
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

  /** Signing out from one of the shell's pages (the profile menu, Settings).
   *
   * The Dashboard's own sign-out, less the half only it can reach: an
   * automatic reconnect waiting between attempts is cancelled, then
   * `logout()` takes the tunnel down before it deletes anything, then the
   * session ends as every other way does. A connect pass still walking its
   * protocols is caught by the session generation `logout()` moves. */
  async function signOutFromPage() {
    if (pageSigningOut) return;
    setPageSigningOut(true);
    try {
      autoReconnect.cancel("signedOut");
      await logout();
    } finally {
      setPageSigningOut(false);
    }
    await handleLoggedOut();
  }

  // Read through a ref so the listener, registered once, always calls
  // the current render's handler -- and with it the current language.
  const handleLoggedOutRef = useRef(handleLoggedOut);
  handleLoggedOutRef.current = handleLoggedOut;
  useEffect(() => onSessionRevoked(() => void handleLoggedOutRef.current("revoked")), []);

  // Every screen goes through one function so the transition can see
  // both halves of a navigation: the one leaving and the one
  // arriving. As a chain of early returns only one screen was ever
  // in scope, which is why this build cuts between screens while
  // the mobile one animates -- the component lived here and only
  // mobile was ever wired into it.
  /** One of the signed-in pages, in the same shell as the main page: the
   * sidebar on a wide window, the tabs on a medium one, the bottom nav on
   * a phone-sized one. `active` is the nav item it belongs to. */
  const inShell = (active: NavId, content: ReactNode) => {
    const profile = shellProfile();
    return (
      <AppShell
        active={active}
        shown="idle"
        titlebar
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
        onSignOut={() => void signOutFromPage()}
        signingOut={pageSigningOut}
        update={
          <>
            <UpdateBanner state={updateState} onRestart={() => void restartForUpdate()} busy={restarting} blocked={updateBlocked} />
            <CommunityLinks />
          </>
        }
        scene={<PageScene />}
      >
        {content}
      </AppShell>
    );
  };

  const renderScreen = () => {
  if (screen === "loading") {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  if (screen === "signingOut") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("nav.signingOut")}
      </div>
    );
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
  if (screen === "forgot") {
    return (
      <ForgotPassword
        // Reuses the same notice slot a verification success uses, so a
        // reset lands the customer on sign-in already knowing it worked.
        onDone={(notice) => {
          setLoginNotice(notice);
          setScreen("login");
        }}
        onCancel={() => setScreen("login")}
      />
    );
  }

  if (screen === "register") {
    return <Register
        onNeedsVerification={goToVerify}
        onSuccess={() => setScreen("dashboard")}
        onGoLogin={() => setScreen("login")}
        onRelaySignedUp={() => {
          setPlansNotice(t("relay.created"));
          setScreen("plans");
        }}
      />;
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
        customSection={<CustomModeCard />}
        // Supplied here rather than imported by the screen, the same way
        // Custom mode is: gaming mode drives the Windows helper service
        // and has no counterpart on the mobile build that shares this
        // screen. Passing it is what makes its row exist.
        gamingSection={<GamingModeCard />}
        onOpenPlans={() => setScreen("plans")}
        onOpenActivity={() => setScreen("activity")}
        onSignOut={() => void signOutFromPage()}
        platform="windows"
      />,
    );
  }
  if (screen === "activity") {
    return inShell(
      "activity",
      <Activity
        // The Windows helper's fingerprint of the network; and, for when it
        // cannot be read (under a tunnel), the ways out, to tell whether the
        // main page's network is still the one (`currentNetwork`).
        readNetwork={() => invoke<string | null>("network_fingerprint")}
        readWayOut={() => invoke<string | null>("network_uplinks")}
        onOpenPlans={() => setScreen("plans")}
      />,
    );
  }
  if (screen === "referrals") {
    // Back to Settings rather than the Dashboard: that is where the
    // customer came from, and dropping them somewhere else is how a
    // two-tap detour starts feeling like getting lost.
    return inShell("none", <Referrals onBack={() => setScreen("settings")} />);
  }
  if (screen === "support") {
    // Same reasoning as Referrals: back where they came from.
    return inShell("none", <Support onBack={() => setScreen("settings")} />);
  }
  if (screen === "plans") {
    const leavePlans = () => {
      setPlansNotice(null);
      setScreen("dashboard");
    };
    return inShell("none", <Plans onActivated={leavePlans} onBack={leavePlans} notice={plansNotice} />);
  }
  // The update notice rides on the Dashboard only -- in its sidebar, or
  // at the top of the hero on a narrower window. It is the screen people
  // sit on, and putting it on every screen would mean it appears over the
  // sign-in form, telling somebody who cannot get into their account yet
  // about a version number.
  return (
    <Dashboard
      onLoggedOut={() => void handleLoggedOut()}
      onBrowsePlans={() => setScreen("plans")}
      onOpenSettings={() => setScreen("settings")}
      onOpenReferrals={() => setScreen("referrals")}
      onOpenSupport={() => setScreen("support")}
      onOpenActivity={() => setScreen("activity")}
      update={
        <UpdateBanner
          state={updateState}
          onRestart={() => void restartForUpdate()}
          busy={restarting}
          blocked={updateBlocked}
        />
      }
    />
  );
  };

  // The redesigned screens keep the title strip in their own padding: the
  // shell's pages and the Dashboard through the shell, sign-in and the
  // rest of its steps through AuthFrame. Only the two plain waits are
  // given the strip's 32px here. The version moved to Settings › About
  // and the profile menu's foot.
  const framed = (content: ReactNode) =>
    screen === "loading" || screen === "signingOut" ? <div className="relative h-full pt-8">{content}</div> : content;

  // The backup-route chip above every screen while relay mode lasts, and
  // the consent prompt over them when a request the customer made needs
  // it: both at the root, so neither touches the Dashboard's orb or
  // headline (calm UI).
  return (
    <div className="relative h-full">
      <ScreenTransition screenKey={screen} viewTransitions>
        {framed(renderScreen())}
      </ScreenTransition>
      {/* In the title strip, clear of the caption buttons. */}
      <div className="nx-tbchip">
        <BackupRouteChip />
      </div>
    </div>
  );
}
