import { useEffect, useState } from "react";
import { getTokens } from "@shared/lib/session";
import { Login } from "@shared/screens/Login";
import { Register } from "@shared/screens/Register";
import { VerifyEmail } from "@shared/screens/VerifyEmail";
import { ForgotPassword } from "@shared/screens/ForgotPassword";
import { Plans } from "@shared/screens/Plans";
import { Referrals } from "@shared/screens/Referrals";
import { Support } from "@shared/screens/Support";
import { Settings } from "@shared/screens/Settings";
import { Dashboard } from "./screens/Dashboard";
import { PerAppCard } from "./components/PerAppCard";

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

  useEffect(() => {
    getTokens()
      .then((tokens) => setScreen(tokens ? "dashboard" : "login"))
      .catch(() => setScreen("login"));
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

  function goToVerify(email: string, password: string) {
    setPendingAuth({ email, password });
    setScreen("verify");
  }

  if (screen === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
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
  if (screen === "register") {
    return <Register onNeedsVerification={goToVerify} onGoLogin={() => setScreen("login")} />;
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
        customSection={<PerAppCard />}
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
