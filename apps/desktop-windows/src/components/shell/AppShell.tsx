import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CreditCard, Gift, Home, LayoutGrid, LifeBuoy, LogOut, MapPin, Settings as SettingsIcon } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { IS_STORE_BUILD } from "../../lib/distribution";
import { probeFrames } from "../../lib/effects";
import type { ShownTone } from "../../lib/hero-model";
import { Glass } from "../ui";
import { Menu } from "../overlay";

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
 * the session ends. */

export type NavId = "overview" | "locations" | "settings";

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
    { id: "overview", label: t("nav.overview"), icon: <LayoutGrid className="nx-i" aria-hidden />, go: props.onOverview },
    { id: "locations", label: t("nav.locations"), icon: <MapPin className="nx-i" aria-hidden />, go: props.onLocations },
    { id: "settings", label: t("nav.settings"), icon: <SettingsIcon className="nx-i" aria-hidden />, go: props.onOpenSettings },
  ];
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === active),
  );

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
      className="nx-app"
      data-shown={props.shown}
      data-busy={props.busy ? "1" : undefined}
      data-banner={props.banner ? "1" : undefined}
      data-titlebar={props.titlebar ? "1" : undefined}
    >
      {props.scene}
      <div className="nx-shell">
        <nav className="nx-side" aria-label={t("nav.main")}>
          {/* The brand stays Latin and left-to-right in both languages. */}
          <p className="nx-wm" lang="en" dir="ltr">
            NEOXIFY
          </p>
          <div className="nx-nav" style={{ "--ni": index } as React.CSSProperties}>
            <span className="nx-nav-pill" aria-hidden />
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
              <span className="n" dir="ltr">
                {email ?? "—"}
              </span>
              {props.planLine ? <span className="s">{props.planLine}</span> : null}
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
          <div className="nx-view">{props.children}</div>
          <Glass as="nav" strong className="nx-mnav" aria-label={t("nav.main")}>
            <button type="button" aria-current={active === "overview" ? "page" : undefined} onClick={props.onOverview}>
              <Home className="nx-i" aria-hidden />
              {t("nav.home")}
            </button>
            <button type="button" aria-current={active === "locations" ? "page" : undefined} onClick={props.onLocations}>
              <MapPin className="nx-i" aria-hidden />
              {t("nav.locations")}
            </button>
            <button type="button" aria-current={active === "settings" ? "page" : undefined} onClick={props.onOpenSettings}>
              <SettingsIcon className="nx-i" aria-hidden />
              {t("nav.settings")}
            </button>
          </Glass>
        </div>
      </div>

      <Menu
        open={menuOpen}
        anchor={anchor === "side" ? sideProfile : headAvatar}
        placement={anchor === "side" ? "above" : "below"}
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
            props.onSignOut();
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
    </div>
  );
}
