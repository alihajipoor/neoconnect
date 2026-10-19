import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { getTokens } from "@shared/lib/session";
import { AuthShell, type AuthScreen } from "./auth/AuthShell";
import { PortalLogin } from "./auth/PortalLogin";
import { PortalRegister } from "./auth/PortalRegister";
import { PortalVerifyEmail } from "./auth/PortalVerifyEmail";
import { PortalForgotPassword } from "./auth/PortalForgotPassword";
import { useCopy } from "./auth/copy";

/**
 * The screens behind sign-in, each in its own file the page asks for only
 * when it needs it. The sign-in page is what everyone loads, often over a
 * slow or filtered link, and it should not wait on the account, plans,
 * settings, referrals and support screens too -- together most of the
 * script. Once the sign-in card is drawn they are fetched in the
 * background (prefetchSignedInScreens), so signing in rarely waits for
 * them either.
 */
const SIGNED_IN = {
  account: () => import("./screens/Account"),
  plans: () => import("@shared/screens/Plans"),
  settings: () => import("@shared/screens/Settings"),
  referrals: () => import("@shared/screens/Referrals"),
  support: () => import("@shared/screens/Support"),
};
const Account = lazy(() => SIGNED_IN.account().then((m) => ({ default: m.Account })));
const Plans = lazy(() => SIGNED_IN.plans().then((m) => ({ default: m.Plans })));
const Settings = lazy(() => SIGNED_IN.settings().then((m) => ({ default: m.Settings })));
const Referrals = lazy(() => SIGNED_IN.referrals().then((m) => ({ default: m.Referrals })));
const Support = lazy(() => SIGNED_IN.support().then((m) => ({ default: m.Support })));

/** How long after the sign-in card is drawn the signed-in screens start
 * downloading: after the page's own first requests, while the visitor is
 * still typing. */
const PREFETCH_DELAY_MS = 1500;

function prefetchSignedInScreens() {
  // A failure here is said, if it matters, when the screen is opened.
  for (const load of Object.values(SIGNED_IN)) load().catch(() => {});
}

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

  // The sign-in steps wear the new look (./auth); the account screens
  // keep the apps' dark one until their own redesign. Worked out from what
  // actually renders below, so the two cannot disagree.
  const authScreen: AuthScreen | null =
    screen === "loading" || screen === "login" || screen === "register" || screen === "forgot"
      ? screen
      : screen === "verify" && pendingAuth
        ? "verify"
        : null;

  // The canvas and map in index.html, and this surface's colours, follow
  // the same switch.
  useEffect(() => {
    document.documentElement.dataset.surface = authScreen ? "auth" : "app";
  }, [authScreen]);

  // Once a sign-in step is on screen, fetch what comes after it.
  const signingIn = authScreen !== null && authScreen !== "loading";
  useEffect(() => {
    if (!signingIn) return;
    const timer = setTimeout(prefetchSignedInScreens, PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signingIn]);

  if (screen === "loading") {
    content = null;
  } else if (screen === "login") {
    content = (
      <PortalLogin
        onSuccess={afterAuth}
        onNeedsVerification={goToVerify}
        onGoRegister={() => setScreen("register")}
        onGoForgotPassword={() => setScreen("forgot")}
        notice={loginNotice}
      />
    );
  } else if (screen === "register") {
    content = (
      <PortalRegister
        onNeedsVerification={goToVerify}
        // Unreachable here: the only path to it is a provider sign-in,
        // and the portal offers none. Wired to the same handler Login
        // uses rather than left to throw, so the day the web flow does
        // exist this is already correct.
        onSuccess={afterAuth}
        onGoLogin={() => setScreen("login")}
      />
    );
  } else if (screen === "forgot") {
    content = (
      <PortalForgotPassword
        onDone={(notice) => {
          setLoginNotice(notice);
          setScreen("login");
        }}
        onCancel={() => setScreen("login")}
      />
    );
  } else if (screen === "verify" && pendingAuth) {
    content = (
      <PortalVerifyEmail
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
        // Android slots its per-app split-tunnel card in here. The web
        // has no equivalent -- nothing on this page can touch a tunnel --
        // so it is explicitly empty rather than omitted, which the prop
        // does not allow.
        customSection={null}
      />
    );
  } else if (screen === "referrals") {
    content = <Referrals onBack={() => setScreen("settings")} />;
  } else if (screen === "support") {
    content = <Support onBack={() => setScreen("settings")} />;
  } else if (screen === "plans") {
    content = (
      <Plans
        onActivated={() => setScreen("account")}
        onBack={() => setScreen("account")}
        // Prefilled from the /r/CODE link they followed, so the code is
        // already in the box and they only confirm.
        voucherCode={voucher ?? undefined}
      />
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

  if (authScreen) return <AuthShell screen={authScreen}>{content}</AuthShell>;
  return (
    <div className="portal-frame">
      {/* Keyed, so a screen that failed to arrive does not stand in for
          the next one opened. */}
      <ScreenLoadBoundary key={screen}>
        <Suspense fallback={<ScreenLoading />}>{content}</Suspense>
      </ScreenLoadBoundary>
    </div>
  );
}

/** While a signed-in screen's file is still on its way. */
function ScreenLoading() {
  const copy = useCopy();
  return (
    <p className="py-16 text-center text-sm text-muted-foreground" role="status">
      {copy.loading}
    </p>
  );
}

/** A signed-in screen whose file did not arrive -- the connection dropped,
 * or a filter cut it. Said plainly, with the one thing that helps. */
function LoadFailed() {
  const copy = useCopy();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center" role="alert">
      <p className="text-sm">{copy.loadFailed}</p>
      <button
        type="button"
        className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium hover:bg-white/5"
        onClick={() => window.location.reload()}
      >
        {copy.reload}
      </button>
    </div>
  );
}

class ScreenLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <LoadFailed /> : this.props.children;
  }
}
