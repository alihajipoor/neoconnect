import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { Glass } from "../ui";
import { Tagline } from "./Hero";

/** Where the main page's pieces go. The Dashboard builds them -- every
 * fact and every press stays in its source, where the tests read them --
 * and this places them: the hero column (anchored at a fixed top, so a
 * state change never moves the tagline), the VPN / Gaming switch, the
 * locations panel and the tray. Which of them show at which width is
 * pearl.css's: the window decides, not the monitor.
 *
 * The hero column scrolls rather than clips. When it overflows, its bottom
 * fades and a "More below" pill scrolls it by most of its height. */

export interface MainSlots {
  banner?: ReactNode;
  chip?: ReactNode;
  line?: ReactNode;
  /** Gaming mode's own hero -- chip, line, sentence, button and notes --
   * in place of the tunnel's. */
  gaming?: ReactNode;
  hint?: ReactNode;
  subline?: ReactNode;
  /** The device limit, in the hint's place. */
  slot?: ReactNode;
  actions?: ReactNode;
  error?: ReactNode;
  notes?: ReactNode;
  modeBar?: ReactNode;
  /** Medium and phone layouts: the location card, and plan and IP cards. */
  locationCard?: ReactNode;
  metrics?: ReactNode;
  /** The locations panel's contents; absent, no panel is drawn. */
  panel?: ReactNode;
  panelLabel?: string;
  panelFlash?: number;
  tray?: ReactNode;
  /** The art in the hero's own grid area (the ribbon), clear of every blur. */
  art?: ReactNode;
  announcer?: ReactNode;
}

export function MainView(slots: MainSlots) {
  const { t } = useI18n();
  const taglineId = useId();
  const heroRef = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const [flash, setFlash] = useState(false);

  // "More below": shown only while the column has more than it shows.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const check = () => setMore(hero.scrollHeight - hero.clientHeight - hero.scrollTop > 24);
    check();
    hero.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(hero);
    const copy = hero.firstElementChild;
    if (copy) observer?.observe(copy);
    return () => {
      hero.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, []);

  // The panel's flash when the customer asks for Locations on a wide window.
  useEffect(() => {
    if (!slots.panelFlash) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(timer);
  }, [slots.panelFlash]);

  return (
    <div className={slots.panel ? "nx-ov" : "nx-ov nopanel"} data-more={more ? "1" : undefined}>
      {slots.art}
      <section ref={heroRef} className="nx-hero" aria-labelledby={taglineId}>
        <div className="nx-hero-copy">
          {slots.banner}
          <Tagline id={taglineId} />
          {slots.gaming ? (
            <>
              {slots.gaming}
              {slots.locationCard}
            </>
          ) : (
            <>
              {slots.chip ? <div className="nx-chiprow">{slots.chip}</div> : null}
              {slots.locationCard}
              {slots.line}
              {slots.slot ?? slots.hint}
              {slots.subline}
              {slots.actions}
              {slots.error}
              {slots.notes}
            </>
          )}
          {slots.modeBar}
          {slots.metrics}
        </div>
      </section>
      {slots.modeBar}
      {slots.panel ? (
        <Glass as="aside" strong className={flash ? "nx-panel flash" : "nx-panel"} aria-label={slots.panelLabel}>
          {slots.panel}
        </Glass>
      ) : null}
      {slots.tray}
      <button
        type="button"
        className="nx-glass strong nx-morecue"
        onClick={() => {
          const hero = heroRef.current;
          if (!hero) return;
          const reduce = document.documentElement.dataset.motion === "reduce";
          hero.scrollBy({ top: hero.clientHeight * 0.7, behavior: reduce ? "auto" : "smooth" });
        }}
        tabIndex={more ? 0 : -1}
        aria-hidden={!more}
      >
        {t("more.below")}
        <ChevronDown aria-hidden />
      </button>
      {slots.announcer}
    </div>
  );
}
