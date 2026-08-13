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
import { Account } from "./screens/Account";

/**
 * The web customer portal.
 *
 * Structurally the Android client's App with the Dashboard swapped for
 * Account -- same screens, same state machine, no router. A state
 * machine rather than URL routing is not laziness here: it means the
 * whole portal is one index.html with no server rewrites, which is what
 * lets it live inside the existing PHP site on shared hosting.
 *
 * Purchase and voucher redemption are present, unlike the store builds
 * of the mobile app. That is the entire point of this portal: the app
 * stores forbid selling outside their billing, so the commerce surface
 * moves to the web, where crypto, vouchers, giveaways and reseller
 * pricing can all work as intended.
 */
type Screen =
  | "loading"
  | "login"
  | "register"
  | "forgot"
  | "verify"
  | "account"
  | "plans"
  | "settings"
  | "referrals"
  | "support";

/**
 * A voucher code carried in from a link.
 *
 * Read once, at startup, and then removed from the address bar with
 * replaceState so it is not left sitting in history or copied into a
 * shared URL. Kept in memory for the session so it survives the sign-in
 * or registration the recipient may still have to do.
 */
function takeFromUrl(key: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(key);
  if (!value) return null;
  params.delete(key);
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  return value;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [pendingAuth, setPendingAuth] = useState<{ email: string; password?: string } | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [voucher] = useState<string | null>(() => takeFromUrl("voucher"));
  // Set by the website's pricing buttons (nx_buy_url). Someone who has
  // already picked a plan and pressed Buy must not be dropped back onto
  // a list of plans -- that is the moment a sale is lost.
  const [wantsPlans] = useState<boolean>(() => takeFromUrl("plan") !== null);

  useEffect(() => {
    getTokens()
      .then((tokens) => {
        if (!tokens) return setScreen("login");
        // Someone arriving on a voucher or a pricing link who is already
        // signed in goes straight to where they can act on it, rather
        // than to an account page that says nothing about the link they
        // followed.
        setScreen(voucher || wantsPlans ? "plans" : "account");
      })
      .catch(() => setScreen("login"));
  }, [voucher, wantsPlans]);

  function goToVerify(email: string, password: string) {
    setPendingAuth({ email, password });
    setScreen("verify");
  }

  /** Where a successful sign-in lands. A voucher or pricing link
   * overrides the usual destination for the same reason as above --
   * including after a brand-new registration, which is the whole
   * journey the website's Buy buttons start. */
  function afterAuth() {
    setScreen(voucher || wantsPlans ? "plans" : "account");
  }

  let content: React.ReactNode;

  if (screen === "loading") {
    content = (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  } else if (screen === "login") {
    content = (
      <Login
        onSuccess={afterAuth}
        onNeedsVerification={goToVerify}
        onGoRegister={() => setScreen("register")}
        onGoForgotPassword={() => setScreen("forgot")}
        notice={loginNotice}
      />
    );
  } else if (screen === "register") {
    content = <Register onNeedsVerification={goToVerify} onGoLogin={() => setScreen("login")} />;
  } else if (screen === "forgot") {
    content = (
      <ForgotPassword
        onDone={(notice) => {
          setLoginNotice(notice);
          setScreen("login");
        }}
        onCancel={() => setScreen("login")}
      />
    );
  } else if (screen === "verify" && pendingAuth) {
    content = (
      <VerifyEmail
        email={pendingAuth.email}
        password={pendingAuth.password}
        onVerified={() => {
          setPendingAuth(null);
          afterAuth();
        }}
        onGoLogin={() => {
          setPendingAuth(null);
          setScreen("login");
        }}
      />
    );
  } else if (screen === "settings") {
    content = (
      <Settings
        onBack={() => setScreen("account")}
        onOpenReferrals={() => setScreen("referrals")}
        onOpenSupport={() => setScreen("support")}
        onLoggedOut={() => setScreen("login")}
      />
    );
  } else if (screen === "referrals") {
    content = <Referrals onBack={() => setScreen("settings")} />;
  } else if (screen === "support") {
    content = <Support onBack={() => setScreen("settings")} />;
  } else if (screen === "plans") {
    content = (
      <Plans onActivated={() => setScreen("account")} onBack={() => setScreen("account")} />
    );
  } else {
    content = (
      <Account
        onBrowsePlans={() => setScreen("plans")}
        onOpenSettings={() => setScreen("settings")}
        onOpenSupport={() => setScreen("support")}
        onOpenReferrals={() => setScreen("referrals")}
        onLoggedOut={() => setScreen("login")}
      />
    );
  }

  return <div className="portal-frame">{content}</div>;
}
