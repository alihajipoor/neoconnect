import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { claimCheckPop } from "../../lib/check-pop";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { formatDuration } from "../../lib/locale-format";
import { announcedAtOnce, announcedOnSettle, SETTLE_MS, type ChipGlyph, type HintTone, type LineModel } from "../../lib/hero-model";
import { cn } from "../../lib/utils";
import { PillButton } from "../ui";

/** The pieces of the main page's hero column. Each says one thing: the
 * fixed tagline, the state in a chip, the timer or the state in words, and
 * the sentence under it. Their colour comes from the calm tone on the app
 * root (`data-shown`); their words from the tables in lib/hero-model.ts. */

/** "Your internet. / Without limits." -- the same in every state. The
 * honest state lives in the chip, the line, the sentence and the button. */
export function Tagline({ id }: { id: string }) {
  const { t } = useI18n();
  return (
    <h1 id={id} className="nx-tag">
      <span className="dsk">{t("tagline.line1")}</span>
      <span className="dsk">{t("tagline.line2")}</span>
      <span className="mob">{t("tagline.mobile1")}</span>
      <span className="mob">{t("tagline.mobile2")}</span>
    </h1>
  );
}

/** The status chip: the calm tone's tint, the state's own glyph and word.
 * The check appears only for verified traffic, and pops in on the first
 * verified look of a session (not under reduced motion). */
export function StatusChip({ glyph, label }: { glyph: ChipGlyph; label: string }) {
  return (
    <p className="nx-chip">
      {glyph === "check" ? (
        <CheckDot />
      ) : (
        <span className={cn("nx-dot", glyph)} aria-hidden />
      )}
      <span key={label} className="nx-swap">
        {label}
      </span>
    </p>
  );
}

/** The check. It bounces the first time it is drawn in a session
 * (lib/check-pop.ts) -- decided before the first paint, so it never shows
 * full size and then jumps -- and arrives by the colour cross-fade alone
 * after a brief reconnect, a cleared banner or a remount, so the end of a
 * gap is never marked with motion. */
function CheckDot() {
  const [pop, setPop] = useState(false);
  useLayoutEffect(() => {
    if (claimCheckPop()) setPop(true);
  }, []);
  return (
    <span className={cn("nx-dot check", pop && "nx-popc")} aria-hidden>
      <Check />
    </span>
  );
}

/** One polite live region for settled state changes: "{headline}. {hint}".
 * What it said goes the moment the state changes (`announcedAtOnce`); the
 * new state is said once it has stood for `SETTLE_MS` -- unless it is what
 * was said last, back from a blip (`announcedOnSettle`). */
export function StateAnnouncer({ text }: { text: string }) {
  const [said, setSaid] = useState("");
  const spoken = useRef("");
  useEffect(() => {
    setSaid((before) => announcedAtOnce(before, text));
    const timer = setTimeout(() => {
      const next = announcedOnSettle(spoken.current, text);
      if (next === null) return;
      spoken.current = next;
      setSaid(next);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <p className="nx-sr" role="status" aria-live="polite">
      {said}
    </p>
  );
}

/** The session timer: its own small component, so the one-second tick
 * re-renders this span and nothing else; stopped while the window is
 * hidden. Read once by a screen reader, as words, not every second. */
export function SessionTimer({ since, label }: { since: number; label: string }) {
  const { language } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null || document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1_000);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <p className="nx-big">
      <span className="nx-sr">{label}</span>
      <span className="nx-timer" aria-hidden>
        {formatDuration((now - since) / 1000, language)}
      </span>
    </p>
  );
}

/** The timer for a verified tunnel, the state in words otherwise, in a row
 * that reserves its height so switching between them never moves the
 * button. `decor` is the decorative word list, wide windows only. */
export function StateLine({ line, words, decor }: { line: LineModel; words: string; decor?: ReactNode }) {
  return (
    <div className="nx-bigrow">
      {line.kind === "timer" ? (
        <SessionTimer since={line.since} label={words} />
      ) : (
        <p key={words} className="nx-big words nx-swap">
          {words}
        </p>
      )}
      {decor}
    </div>
  );
}

/** The sentence under the line. Its ink follows the calm tone only for a
 * sustained, real problem; it reserves room so a longer sentence does not
 * push the button down.
 *
 * `reserve`: every sentence this place can say. On a phone (pearl.css)
 * they are laid, unseen, in the sentence's own cell, so it is as tall as
 * the longest of them at this width, in this language and at this text
 * size -- and the map and the foot below keep still whichever is said.
 * Wider layouts keep their fixed number of lines. */
export function Hint({ tone, reserve, children }: { tone: HintTone; reserve?: readonly TranslationKey[]; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <p className={cn("nx-hint", tone)}>
      <span className="tx">{children}</span>
      {reserve && reserve.length > 0 ? (
        <span className="rsv" aria-hidden>
          {reserve.map((key) => (
            <span key={key}>{t(key)}</span>
          ))}
        </span>
      ) : null}
    </p>
  );
}

/** "BROWSE / STREAM / WORK / ANYWHERE": decoration, hidden from assistive
 * technology, on wide windows only. Keys passed in so both languages have
 * their own. */
export function Decor({ keys }: { keys: readonly TranslationKey[] }) {
  const { t } = useI18n();
  return (
    <p className="nx-decor" aria-hidden>
      {keys.map((key) => (
        <span key={key}>{t(key)}</span>
      ))}
    </p>
  );
}

/** The quieter way out beside the button -- Stop, Try another. On a phone
 * it shares the button's row whatever the state, so the foot keeps still
 * and the button stays under the thumb: there it says the short words
 * (pearl.css), and its accessible name is the full words everywhere. */
export function WayOut({ label, short, onClick }: { label: string; short: string; onClick?: () => void }) {
  return (
    <PillButton variant="ghost" className="nx-wayout" aria-label={label} onClick={onClick}>
      <span className="lf">{label}</span>
      <span className="ls">{short}</span>
    </PillButton>
  );
}
