/** Day arithmetic for the daily usage history, kept free of Prisma so it
 * can be tested on its own.
 *
 * Usage is summed by the database into quarter-hour buckets in UTC (see
 * DailyUsageService), and each bucket is given to a day here, in the
 * customer's IANA time zone. Quarter hours because every UTC offset in
 * use is a whole number of them -- Tehran is +03:30, Kathmandu +05:45 --
 * so a local midnight is always a bucket boundary, never inside a bucket,
 * and a bucket belongs entirely to the day its first instant falls on.
 * The time zone stays out of SQL: Postgres and ICU each carry their own
 * tz database, and a name one knows and the other does not would turn a
 * request into a 500 instead of a 400. */

/** Seconds in one bucket. */
export const BUCKET_SECONDS = 900;

/** The furthest any time zone is ahead of UTC (Kiribati, +14:00). Local
 * midnight of a date is never earlier than this before UTC midnight of
 * the same date. */
export const MAX_AHEAD_OF_UTC_MS = 14 * 60 * 60 * 1000;

export interface UsageBucket {
  /** Start of the bucket, seconds since the epoch, a multiple of 900. */
  startSec: number;
  bytesUp: bigint;
  bytesDown: bigint;
}

export interface DayTotal {
  /** The local calendar date, YYYY-MM-DD (Gregorian; the client renders
   * it in the reader's calendar). */
  date: string;
  /** Decimal strings: a day's bytes can pass 2^53. */
  bytesUp: string;
  bytesDown: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      calendar: "gregory",
      numberingSystem: "latn",
    });
    // Bounded by the zones that exist; a name is only cached once valid.
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The canonical name of an IANA time zone ("asia/tehran" ->
 * "Asia/Tehran"), or null when it is not one. */
export function canonicalTimeZone(value: string): string | null {
  if (!value || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The calendar date `instant` falls on in `timeZone`, as YYYY-MM-DD. */
export function localDate(instant: Date | number, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(typeof instant === "number" ? new Date(instant) : instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** UTC midnight of a YYYY-MM-DD date, in epoch milliseconds. */
export function utcMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** `date` moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
  return new Date(utcMidnight(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** One total per calendar day from `first` to `last` inclusive, oldest
 * first. A day with no bucket is 0 -- nothing was recorded on it, which is
 * what the history says, not an estimate. Buckets outside the range are
 * dropped. */
export function dailyTotals(buckets: UsageBucket[], timeZone: string, first: string, last: string): DayTotal[] {
  const totals = new Map<string, { up: bigint; down: bigint }>();
  for (let date = first; date <= last; date = addDays(date, 1)) totals.set(date, { up: 0n, down: 0n });
  for (const bucket of buckets) {
    const total = totals.get(localDate(bucket.startSec * 1000, timeZone));
    if (!total) continue;
    total.up += bucket.bytesUp;
    total.down += bucket.bytesDown;
  }
  return [...totals].map(([date, t]) => ({ date, bytesUp: t.up.toString(), bytesDown: t.down.toString() }));
}
