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

/** A calendar day as the server sends it ("2026-10-19", already a day in
 * the reader's own time zone): "19 Oct", or the same day in the Solar
 * Hijri calendar. Read at noon UTC and formatted in UTC, so no zone can
 * move it to the day before. */
export function formatDay(day: string, language: Language): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return localDigits(day, language);
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  try {
    return new Intl.DateTimeFormat(dateLocale(language), { day: "numeric", month: "short", timeZone: "UTC" }).format(at);
  } catch {
    return localDigits(day, language);
  }
}

/** The time of day alone: "14:05", in Persian digits in Persian. */
export function formatTime(when: Date | number | string, language: Language): string {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(language === "fa" ? "fa-IR" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return localDigits(date.toISOString().slice(11, 16), language);
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

/** A price in US dollars, as the language writes money: "$4.99", or the
 * same amount in Persian digits. The amount is the server's; only its
 * digits change. */
export function formatPrice(usd: number | string, language: Language): string {
  const value = Number(usd);
  if (!Number.isFinite(value)) return String(usd);
  const latin = `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
  return language === "fa" ? `${localDigits(latin.slice(1), language)} دلار` : latin;
}

/** How long ago, in words: "12 minutes ago", "yesterday", or the Persian.
 * A time in the future (a clock that moved) reads as now. */
export function formatAgo(when: number, language: Language, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  const locale = language === "fa" ? "fa-IR" : "en";
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (seconds < 60) return rtf.format(0, "second");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return rtf.format(-minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return rtf.format(-hours, "hour");
    return rtf.format(-Math.round(hours / 24), "day");
  } catch {
    return formatDateTime(when, language);
  }
}
