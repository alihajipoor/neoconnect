import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { formatDuration } from "../../lib/locale-format";
import type { ChipGlyph, HintTone, LineModel } from "../../lib/hero-model";
import { cn } from "../../lib/utils";

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
  // The check is its own element, so its pop runs once each time it
  // appears -- the moment a session is first verified -- and never again
  // while it stays.
  return (
    <p className="nx-chip">
      {glyph === "check" ? (
        <span className="nx-dot check nx-popc" aria-hidden>
          <Check />
        </span>
      ) : (
        <span className={cn("nx-dot", glyph)} aria-hidden />
      )}
      <span key={label} className="nx-swap">
        {label}
      </span>
    </p>
  );
}

/** How long a state has to stand before it is spoken: long enough that a
 * pass's rungs and a one-second re-check never are. */
const SETTLE_MS = 900;

/** One polite live region for settled state changes: "{headline}. {hint}". */
export function StateAnnouncer({ text }: { text: string }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSaid(text), SETTLE_MS);
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
 * sustained, real problem; it reserves three lines so a longer sentence
 * does not push the button down. */
export function Hint({ tone, children }: { tone: HintTone; children: ReactNode }) {
  return <p className={cn("nx-hint", tone)}>{children}</p>;
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
