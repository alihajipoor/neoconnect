import { useEffect, useRef, useState } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";
import { getTokens } from "./lib/session";
import { verifyEmailByToken } from "./lib/auth";
import { flushAttempts } from "./lib/attempts";
import { Login } from "./screens/Login";
import { Register } from "./screens/Register";
import { VerifyEmail } from "./screens/VerifyEmail";
import { ForgotPassword } from "./screens/ForgotPassword";
import { Dashboard } from "./screens/Dashboard";
import { Plans } from "./screens/Plans";
import { Settings } from "./screens/Settings";
import { Referrals } from "./screens/Referrals";
import { Support } from "./screens/Support";
import { CustomModeCard } from "./components/CustomModeCard";
import { UpdateBanner } from "./components/UpdateBanner";
import { applyStagedUpdate, startUpdateChecks, type UpdateState } from "./lib/updates";

/** How often a queued diagnostic report retries.
 *
 * Five minutes is short enough that a customer whose connection comes
 * and goes gets their failures out during the same sitting, and long
 * enough to be nothing on a network that is simply down. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

type Screen =
  | "loading"
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
  // Carries the just-submitted credentials from register/login into the
  // verify screen so it can auto-sign-in the moment the code is confirmed
  // -- see VerifyEmail's doc comment. Password is only ever held in
  // memory for this handoff, never persisted.
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "none" });
  const [restarting, setRestarting] = useState(false);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  // Guards against processing the same deep-link URL twice -- the launch
  // URL can plausibly reach handleDeepLinkUrl via both the Rust-side
  // get_launch_deep_link command and the plugin's own onOpenUrl forwarding
  // it a second time. Verifying a valid token twice concurrently is a
  // real correctness risk (two racing calls could both see the account as
  // not-yet-verified and each try to grant a trial), not just a
  // cosmetic double-render.
  const handledDeepLinkUrls = useRef(new Set<string>());

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
    setPendingAuth(null);
    setLoginNotice(
      result.ok ? "Email verified! Sign in to continue." : `Couldn't verify your email: ${result.error}`,
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

  if (screen === "loading") {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
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
    return <Register onNeedsVerification={goToVerify} onGoLogin={() => setScreen("login")} />;
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
        onLoggedOut={() => setScreen("login")}
        customSection={<CustomModeCard />}
      />
    );
  }
  if (screen === "referrals") {
    // Back to Settings rather than the Dashboard: that is where the
    // customer came from, and dropping them somewhere else is how a
    // two-tap detour starts feeling like getting lost.
    return <Referrals onBack={() => setScreen("settings")} />;
  }
  if (screen === "support") {
    // Same reasoning as Referrals: back where they came from.
    return <Support onBack={() => setScreen("settings")} />;
  }
  if (screen === "plans") {
    return <Plans onActivated={() => setScreen("dashboard")} onBack={() => setScreen("dashboard")} />;
  }
  // The banner rides above the Dashboard only. It is the screen people
  // sit on, and putting it above every screen would mean it appears
  // over the sign-in form -- telling somebody who cannot get into their
  // account yet about a version number.
  return (
    <div className="flex h-full flex-col">
      <UpdateBanner
        state={updateState}
        onRestart={() => void restartForUpdate()}
        busy={restarting}
        blocked={updateBlocked}
      />
      <div className="min-h-0 flex-1">
        <Dashboard
          onLoggedOut={() => setScreen("login")}
          onBrowsePlans={() => setScreen("plans")}
          onOpenSettings={() => setScreen("settings")}
        />
      </div>
    </div>
  );
}
