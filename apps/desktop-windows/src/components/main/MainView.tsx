import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { formatNumber } from "../../lib/locale-format";
import { Disclosure, Glass } from "../ui";
import { BottomSheet } from "../overlay";
import { Tagline } from "./Hero";

/** Where the main page's pieces go. The Dashboard builds them -- every
 * fact and every press stays in its source, where the tests read them --
 * and this places them: the hero column (anchored at a fixed top, so a
 * state change never moves the tagline), the VPN / Gaming switch, the
 * locations panel and the tray. Which of them show at which width and
 * height is pearl.css's: the window decides, not the monitor.
 *
 * Wide and medium windows: the column scrolls rather than clips. When it
 * overflows, its bottom fades and a "More below" pill scrolls it by most of
 * its height.
 *
 * Phones: one screen, nothing scrolls (owner, 2026-10-19). The plan, the
 * address and the connection details fold into one line at the foot of
 * the column that opens a sheet, the one thing that may scroll; the map
 * and the mark give up their room first. The honest state -- chip, line,
 * sentence, banners, notes, the device limit, a failover that crossed a
 * border -- stays in the column. The VPN / Gaming switch is not offered
 * there: Gaming mode is Windows only, and a phone-sized window is the
 * reference for the mobile app. */

export interface MainSlots {
  banner?: ReactNode;
  chip?: ReactNode;
  line?: ReactNode;
  /** Gaming mode's own hero -- chip, line, sentence, button and notes --
   * in place of the tunnel's. */
  gaming?: ReactNode;
  hint?: ReactNode;
  subline?: ReactNode;
  /** The subline says the exit is in another country than the one chosen
   * (a failover that crossed a border): why must be read, so a phone keeps
   * it in the column rather than in the sheet. A same-country protocol
   * change folds there: the location card names the protocol. */
  sublineStays?: boolean;
  /** The device limit, after the hint: the hint still says what the
   * tunnel is doing -- degraded, dropped, not confined -- beside it. */
  slot?: ReactNode;
  actions?: ReactNode;
  error?: ReactNode;
  /** What must be read while it is true -- a leak, unprotected lookups:
   * always in the column. */
  notes?: ReactNode;
  /** What is only worth knowing: behind "Connection details" in the
   * column, in the sheet on a phone. */
  details?: ReactNode[];
  modeBar?: ReactNode;
  /** Medium and phone layouts: the location card, and plan and IP cards. */
  locationCard?: ReactNode;
  metrics?: ReactNode;
  /** Phones: the one line the plan, the address and the details fold
   * into (`SummaryLine`). Absent, nothing folds. */
  summary?: ReactNode;
  /** The locations panel's contents; absent, no panel is drawn. */
  panel?: ReactNode;
  panelLabel?: string;
  panelFlash?: number;
  tray?: ReactNode;
  /** The art in the hero's own grid area, clear of every blur. */
  art?: ReactNode;
  /** Medium and phone layouts: the world map's stage in the hero's column,
   * where its lights live (`WorldMap` host "stage"). */
  mapStage?: ReactNode;
  /** What the map's lights mean, in words, at the foot of the panel. */
  legend?: ReactNode;
  announcer?: ReactNode;
}

export function MainView(slots: MainSlots) {
  const { t, language } = useI18n();
  const taglineId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  // Scrolled at all: the room kept under the last control for the pill
  // stays while the column is scrolled, so reaching the end does not take
  // it away (pearl.css).
  const [scrolled, setScrolled] = useState(false);
  const [flash, setFlash] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const details = slots.details ?? [];

  // "More below": shown only while the column has more than it shows.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const check = () => {
      setMore(hero.scrollHeight - hero.clientHeight - hero.scrollTop > 24);
      setScrolled(hero.scrollTop > 0);
    };
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

  const detailsInline =
    details.length > 0 ? (
      <div className="nx-details">
        <Disclosure label={t("notes.details")} count={details.length}>
          {details}
        </Disclosure>
      </div>
    ) : null;

  // The phone's one line, and the sheet it opens: the plan and the address,
  // and the details open -- a same-country protocol change among them,
  // which the location card names already. Shown by pearl.css on phones
  // only. Its name begins with what it opens and goes on with the words on
  // it, so a screen reader hears what is seen (WCAG 2.5.3).
  const sublineFolds = Boolean(slots.subline) && !slots.sublineStays;
  const sheetCount = details.length + (sublineFolds ? 1 : 0);
  const summary = slots.summary ? (
    <button
      type="button"
      className="nx-glass strong nx-sumline"
      onClick={() => setSheetOpen(true)}
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
    >
      <span className="nx-sr">{t("sum.open")}: </span>
      {slots.summary}
      {sheetCount > 0 ? <span className="cnt nx-num">{formatNumber(sheetCount, language)}</span> : null}
      <ChevronUp className="nx-i sm" aria-hidden />
    </button>
  ) : null;
  const sheet = slots.summary ? (
    <BottomSheet
      open={sheetOpen}
      title={t("sum.title")}
      closeLabel={t("sum.close")}
      onClose={() => setSheetOpen(false)}
      container={sheetOpen ? (rootRef.current?.closest(".nx-app") ?? null) : null}
    >
      {slots.metrics}
      {sheetCount > 0 ? (
        <section className="nx-sheet-sec" aria-label={t("notes.details")}>
          <h3>{t("notes.details")}</h3>
          {sublineFolds ? slots.subline : null}
          {details.length > 0 ? <div className="nx-notes">{details}</div> : null}
        </section>
      ) : null}
    </BottomSheet>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={slots.panel ? "nx-ov" : "nx-ov nopanel"}
      data-more={more ? "1" : undefined}
      data-scrolled={scrolled ? "1" : undefined}
    >
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
              {slots.hint}
              {slots.slot}
              {slots.subline ? (
                <div className="nx-sublinebox" data-stays={slots.sublineStays ? "1" : undefined}>
                  {slots.subline}
                </div>
              ) : null}
              {slots.actions}
              {slots.error ? <div className="nx-err">{slots.error}</div> : null}
              {slots.notes}
              {detailsInline}
            </>
          )}
          {slots.mapStage}
          {slots.modeBar}
          {slots.metrics}
          {summary}
        </div>
      </section>
      {slots.modeBar}
      {slots.panel ? (
        <Glass as="aside" strong className={flash ? "nx-panel flash" : "nx-panel"} aria-label={slots.panelLabel}>
          {slots.panel}
          {slots.legend}
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
      {sheet}
      {slots.announcer}
    </div>
  );
}
