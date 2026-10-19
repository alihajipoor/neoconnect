/** Numbers, sizes, durations and dates in the app's language.
 *
 * Persian gets Persian digits and the Solar Hijri calendar (owner
 * decision, 2026-10-19). IP addresses, latency in ms, codes and emails are
 * not run through here: they stay Latin, in left-to-right isolates. Every
 * date on the redesigned screens goes through these rather than a bare
 * `toLocale*()`, which formats in whatever locale Windows happens to be in
 * rather than the one the app is speaking. */

import type { Language } from "./i18n";
import { formatBytes } from "./utils";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits in `text` as the language writes them. Persian also takes
 * the Arabic decimal separator, so "7.2" reads "۷٫۲". */
export function localDigits(text: string, language: Language): string {
  if (language !== "fa") return text;
  return text.replace(/(\d)\.(\d)/g, "$1٫$2").replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

export function formatNumber(value: number, language: Language): string {
  return localDigits(String(value), language);
}

const BYTE_UNITS_FA: Record<string, string> = {
  B: "بایت",
  KB: "کیلوبایت",
  MB: "مگابایت",
  GB: "گیگابایت",
  TB: "ترابایت",
};

/** "7.2 GB", or "۷٫۲ گیگابایت". */
export function formatSize(bytes: number | string, language: Language): string {
  const latin = formatBytes(bytes);
  if (language !== "fa") return latin;
  const [value, unit] = latin.split(" ");
  return `${localDigits(value, language)} ${BYTE_UNITS_FA[unit] ?? unit}`;
}

/** The figure and its unit apart, for a layout that sets the unit small. */
export function sizeParts(bytes: number | string, language: Language): { value: string; unit: string } {
  const [value, unit] = formatSize(bytes, language).split(" ");
  return { value, unit: unit ?? "" };
}

/** "01:42:08" or "42:08" -- hours padded like the rest, so the clock keeps
 * one shape as it passes an hour; clamped, so a clock moved back
 * mid-session can never show a negative duration. */
export function formatDuration(totalSeconds: number, language: Language): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return localDigits(h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`, language);
}

function dateLocale(language: Language): string {
  return language === "fa" ? "fa-IR-u-ca-persian" : "en-GB";
}

/** "19 Oct 2026", or the same day in the Solar Hijri calendar. */
export function formatDate(when: Date | number | string, language: Language): string {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(dateLocale(language), { day: "numeric", month: "short", year: "numeric" }).format(date);
  } catch {
    return localDigits(date.toISOString().slice(0, 10), language);
  }
}

/** The same with the time of day. */
export function formatDateTime(when: Date | number | string, language: Language): string {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(dateLocale(language), {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return localDigits(date.toISOString().slice(0, 16).replace("T", " "), language);
  }
}
