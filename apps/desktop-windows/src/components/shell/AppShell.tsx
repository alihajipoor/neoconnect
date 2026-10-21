import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { BarChart3, CreditCard, Gift, Home, LifeBuoy, LogOut, MapPin, Settings as SettingsIcon } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { IS_STORE_BUILD } from "../../lib/distribution";
import { probeFrames } from "../../lib/effects";
import { useHeldThroughExit } from "../../lib/motion";
import type { ShownTone } from "../../lib/hero-model";
import { Glass, PillButton } from "../ui";
import { Dialog, Menu } from "../overlay";
import { ShellContext } from "./Page";

/** The signed-in window's frame: a sidebar on wide windows, a compact
 * header with tabs on medium ones, a docked bottom nav on phones -- all
 * from one nav model, switched by container queries on the app root
 * (pearl.css), so the window decides the layout, not the monitor.
 *
 * It carries the calm tone (`data-shown`) the whole screen wears, and a
 * busy flag for the art's light sweep. It decides nothing about either.
 *
 * Sign-out is the screen's own (`onSignOut`): on the Dashboard it is the
 * one that also stops an automatic reconnect and a pass in flight before
 * the session ends. It asks first (design-system.md 4.13): it disconnects,
 * and on a blocked network signing back in may need the backup route.
 *
 * The same shell frames the other signed-in pages -- Activity, Settings,
 * Plans, Support, Invite friends -- with `active` naming the nav item they
 * belong to ("none" for the pages reached from the profile menu). */

export type NavId = "overview" | "locations" | "activity" | "settings" | "none";

/** Another page of the signed-in shell -- Activity, Settings, Plans,
 * Support, Invite friends -- drawn inside the main page's own shell in
 * place of the main page (the Dashboard's `page`). The shell, and the main
 * page's screen with everything it has loaded and verified, stay mounted
 * underneath: going back draws the main page as it was, with no load in
 * front of it. `key` tells one page from the next. */
export interface ShellPage {
  nav: NavId;
  key: string;
  node: ReactNode;
}

export interface ShellProps {
  active: NavId;
  shown: ShownTone;
  busy?: boolean;
  /** A banner is showing in the hero: the mode switch rejoins the column. */
  banner?: boolean;
  /** The Windows title strip is drawn over the shell (32px). */
  titlebar?: boolean;
  email: string | null;
  /** The second line under the email: the plan and its days left. */
  planLine?: string | null;
  onOverview: () => void;
  onLocations: () => void;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
  onBrowsePlans: () => void;
  onOpenReferrals?: () => void;
  onOpenSupport?: () => void;
  onSignOut: () => void;
  signingOut: boolean;
  /** The update notice, in the sidebar on wide windows. */
  update?: ReactNode;
  /** The full-bleed scene behind everything (HeroArt). */
  scene?: ReactNode;
  /** The app root (.nx-app), whose width the container queries lay the
   * shell out by: for a screen that has to make the same choice in script
   * (the phone's main page, apps/mobile/src/lib/app-layout.ts). */
  rootRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

function initial(email: string | null): string {
  const letter = email?.trim()[0];
  return letter ? letter.toUpperCase() : "·";
}

export function AppShell(props: ShellProps) {
  const { t } = useI18n();
  const { active, email } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const sideProfile = useRef<HTMLButtonElement>(null);
  const headAvatar = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<"side" | "head">("side");
  const [askSignOut, setAskSignOut] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);

  // Once the glass has painted and the first load has settled: a device
  // whose frames are slow drops a tier (lib/effects.ts). Never during the
  // loading screen, where there is no glass to measure.
  useEffect(() => {
    const timer = setTimeout(probeFrames, 3_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    void getVersion().then(
      (v) => alive && setVersion(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const items: { id: NavId; label: string; icon: ReactNode; go: () => void }[] = [
    { id: "overview", label: t("nav.overview"), icon: <Home className="nx-i" aria-hidden />, go: props.onOverview },
    { id: "locations", label: t("nav.locations"), icon: <MapPin className="nx-i" aria-hidden />, go: props.onLocations },
    { id: "activity", label: t("nav.activity"), icon: <BarChart3 className="nx-i" aria-hidden />, go: props.onOpenActivity },
    { id: "settings", label: t("nav.settings"), icon: <SettingsIcon className="nx-i" aria-hidden />, go: props.onOpenSettings },
  ];
  const index = items.findIndex((item) => item.id === active);
  /** Kept through a leaving banner's fade: the room it is given goes back
   * only once it is gone (lib/motion.ts). */
  const bannerHeld = useHeldThroughExit(Boolean(props.banner));

  const openMenu = (from: "side" | "head") => {
    if (menuOpen && anchor === from) {
      setMenuOpen(false);
      return;
    }
    setAnchor(from);
    setMenuOpen(true);
  };
  const run = (action?: () => void) => () => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <div
      ref={props.rootRef}
      className="nx-app"
      data-shown={props.shown}
      data-busy={props.busy ? "1" : undefined}
      data-banner={bannerHeld ? "1" : undefined}
      data-titlebar={props.titlebar ? "1" : undefined}
    >
      {props.scene}
      <div className="nx-shell">
        <nav className="nx-side" aria-label={t("nav.main")}>
          {/* The brand stays Latin and left-to-right in both languages. */}
          <p className="nx-wm" lang="en" dir="ltr">
            NEOXIFY
          </p>
          <div className="nx-nav" style={{ "--ni": Math.max(0, index) } as React.CSSProperties}>
            {index >= 0 ? <span className="nx-nav-pill" aria-hidden /> : null}
            {items.map((item) => (
              <button key={item.id} type="button" aria-current={item.id === active ? "page" : undefined} onClick={item.go}>
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
          <div className="nx-grow" />
          {props.update}
          <button
            ref={sideProfile}
            type="button"
            className="nx-profile"
            aria-haspopup="menu"
            aria-expanded={menuOpen && anchor === "side"}
            aria-label={t("nav.account")}
            onClick={() => openMenu("side")}
          >
            <span className="nx-avatar" aria-hidden>
              {initial(email)}
            </span>
            <span className="t">
              <span className="n" dir="ltr" title={email ?? undefined}>
                {email ?? "—"}
              </span>
              {props.planLine ? (
                <span className="s" title={props.planLine}>
                  {props.planLine}
                </span>
              ) : null}
            </span>
          </button>
        </nav>

        <div className="nx-main">
          <header className="nx-mhead">
            <p className="nx-wm" lang="en" dir="ltr">
              NEOXIFY
            </p>
            <div className="nx-mtabs" role="group" aria-label={t("nav.main")}>
              {items.map((item) => (
                <button key={item.id} type="button" aria-current={item.id === active ? "page" : undefined} onClick={item.go}>
                  {/* The selected tab's pill: one at a time, and carried to
                      the next tab across a page change (motion.css). */}
                  {item.id === active ? <span className="nx-tabpill" aria-hidden /> : null}
                  {item.label}
                </button>
              ))}
            </div>
            <div className="nx-grow" />
            <button
              ref={headAvatar}
              type="button"
              className="nx-avbtn"
              aria-haspopup="menu"
              aria-expanded={menuOpen && anchor === "head"}
              aria-label={t("nav.account")}
              onClick={() => openMenu("head")}
            >
              <span className="nx-avatar" aria-hidden>
                {initial(email)}
              </span>
            </button>
          </header>
          <div className="nx-view">
            <ShellContext.Provider value>{props.children}</ShellContext.Provider>
          </div>
          <Glass as="nav" strong className="nx-mnav" aria-label={t("nav.main")}>
            {items.map((item) => (
              <button key={item.id} type="button" aria-current={item.id === active ? "page" : undefined} onClick={item.go}>
                {item.id === active ? <span className="nx-tabpill" aria-hidden /> : null}
                {item.icon}
                {item.id === "overview" ? t("nav.home") : item.label}
              </button>
            ))}
          </Glass>
        </div>
      </div>

      <Menu
        open={menuOpen}
        anchor={anchor === "side" ? sideProfile : headAvatar}
        placement={anchor === "side" ? "above" : "below"}
        // The phone header's avatar sits at the window's end edge: lined up
        // with its start, the menu ran off the screen (seen on an iPhone 17
        // Pro Max, 0.2.31). The sidebar's profile sits at the start edge.
        align={anchor === "side" ? "start" : "end"}
        onClose={() => setMenuOpen(false)}
        label={t("nav.account")}
      >
        {email ? (
          <p className="mi-s" dir="auto">
            {t("menu.signedIn", { email })}
          </p>
        ) : null}
        {/* The store build sells through the store only: "Plans", never a
            voucher or a web checkout (App Store 3.1.1). */}
        <button type="button" role="menuitem" onClick={run(props.onBrowsePlans)}>
          <CreditCard aria-hidden />
          {t(IS_STORE_BUILD ? "nav.plansStore" : "nav.plans")}
        </button>
        {props.onOpenReferrals ? (
          <button type="button" role="menuitem" onClick={run(props.onOpenReferrals)}>
            <Gift aria-hidden />
            {t("nav.referrals")}
          </button>
        ) : null}
        {props.onOpenSupport ? (
          <button type="button" role="menuitem" onClick={run(props.onOpenSupport)}>
            <LifeBuoy aria-hidden />
            {t("nav.support")}
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={run(props.onOpenSettings)}>
          <SettingsIcon aria-hidden />
          {t("nav.settings")}
        </button>
        <hr />
        <button
          type="button"
          role="menuitem"
          className="danger"
          aria-disabled={props.signingOut || undefined}
          onClick={() => {
            if (props.signingOut) return;
            setMenuOpen(false);
            setAskSignOut(true);
          }}
        >
          <LogOut aria-hidden />
          {props.signingOut ? t("nav.signingOut") : t("nav.signOut")}
        </button>
        {version ? (
          <p className="foot" dir="auto">
            {t("menu.version", { version })}
          </p>
        ) : null}
      </Menu>

      <Dialog
        open={askSignOut}
        title={t("so.title")}
        description={t("so.body")}
        onClose={() => setAskSignOut(false)}
        initialFocus={stayRef}
        actions={
          <>
            <PillButton ref={stayRef} variant="ghost" size="sm" onClick={() => setAskSignOut(false)}>
              {t("btn.cancel")}
            </PillButton>
            <PillButton
              size="sm"
              onClick={() => {
                setAskSignOut(false);
                props.onSignOut();
              }}
            >
              {t("so.go")}
            </PillButton>
          </>
        }
      />
    </div>
  );
}
