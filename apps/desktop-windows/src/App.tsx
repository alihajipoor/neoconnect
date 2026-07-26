import { useEffect, useRef, useState } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";
import { getTokens } from "./lib/session";
import { verifyEmailByToken } from "./lib/auth";
import { Login } from "./screens/Login";
import { Register } from "./screens/Register";
import { VerifyEmail } from "./screens/VerifyEmail";
import { Dashboard } from "./screens/Dashboard";
import { Plans } from "./screens/Plans";
import { Settings } from "./screens/Settings";

type Screen = "loading" | "login" | "register" | "verify" | "dashboard" | "plans" | "settings";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Carries the just-submitted credentials from register/login into the
  // verify screen so it can auto-sign-in the moment the code is confirmed
  // -- see VerifyEmail's doc comment. Password is only ever held in
  // memory for this handoff, never persisted.
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
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

  function goToVerify(email: string, password: string) {
    setPendingAuth({ email, password });
    setScreen("verify");
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
        notice={loginNotice}
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
    return <Settings onBack={() => setScreen("dashboard")} />;
  }
  if (screen === "plans") {
    return <Plans onActivated={() => setScreen("dashboard")} onBack={() => setScreen("dashboard")} />;
  }
  return (
    <Dashboard
      onLoggedOut={() => setScreen("login")}
      onBrowsePlans={() => setScreen("plans")}
      onOpenSettings={() => setScreen("settings")}
    />
  );
}
