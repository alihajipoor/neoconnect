import type { CustomerTrafficRow, CustomerUsageHour, InsightFailure, InsightFinding } from "@/lib/types";
import type { AttemptFilters } from "./insight-format";

/** Pure helpers for how the customer page lays its numbers out: shares
 * for the success bars, the columns of the usage charts, the history's
 * day groups and where a finding links to. No React, so each can be unit
 * tested; none of them changes what a number means. */

/** How a "part of whole" count reads: nothing to compare, none, some or all. */
export type RatioTone = "empty" | "none" | "some" | "all";

export function ratioTone(part: number, whole: number): RatioTone {
  if (whole <= 0) return "empty";
  if (part <= 0) return "none";
  return part >= whole ? "all" : "some";
}

/** The share as a whole percent (0-100), or null when there is no whole. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((Math.min(Math.max(part, 0), whole) / whole) * 100);
}

/** The failure cause counted most often, and how many others share that
 * count -- with a tie, "most common" alone would pick one arbitrarily. */
export function topFailure(failures: InsightFailure[]): { failure: InsightFailure; tiedWith: number } | null {
  if (failures.length === 0) return null;
  const max = Math.max(...failures.map((f) => f.count));
  const top = failures.filter((f) => f.count === max);
  return { failure: top[0], tiedWith: top.length - 1 };
}

/** The log filters that show the reports a finding was counted from, or
 * null when it is not about reports (plans, codes, email). An empty
 * object is the whole log. The network findings name the network they
 * are about first ("Fails on Name (AS64500), connects elsewhere"). */
export function findingFilters(finding: Pick<InsightFinding, "code" | "title">): AttemptFilters | null {
  switch (finding.code) {
    case "NETWORK_SPECIFIC":
    case "NETWORK_OTHERS_OK":
    case "NETWORK_OTHERS_FAIL": {
      const asn = /\bAS(\d{1,10})\b/.exec(finding.title)?.[1];
      return asn ? { asn } : null;
    }
    case "API_UNREACHABLE_OFTEN":
      return { failureCode: "API_UNREACHABLE" };
    case "NOT_CARRYING_OFTEN":
      return { outcome: "NOT_CARRYING_TRAFFIC" };
    case "SERVICE_NOT_ANSWERING":
      return { failureCode: "SERVICE_NOT_ANSWERING" };
    case "OTHER_VPN":
      return { failureCode: "OTHER_VPN_ACTIVE" };
    case "APP_BEHIND": {
      const platform = /^([A-Za-z0-9_.-]{1,32}) app\b/.exec(finding.title)?.[1];
      return platform ? { platform } : null;
    }
    case "NEVER_CONNECTED":
      return {};
    default:
      return null;
  }
}

export interface UsageColumn {
  /** Start of the column, ISO. */
  start: string;
  /** Hours the column covers. */
  hours: number;
  up: number;
  down: number;
}

const HOUR = 3_600_000;

/** The usage window as chart columns, oldest first, empty hours included.
 * One column an hour up to 72 hours; a longer window folds hours together
 * (2 a column for 7 days, 4 for 14) so a phone still shows every column. */
export function hourColumns(rows: CustomerUsageHour[], windowHours: number, now: number = Date.now()): UsageColumn[] {
  const per = windowHours <= 72 ? 1 : Math.ceil(windowHours / 84);
  const count = Math.ceil(windowHours / per);
  const endHour = Math.floor(now / HOUR) * HOUR; // start of the current hour
  const first = endHour - (count * per - 1) * HOUR;
  const columns: UsageColumn[] = Array.from({ length: count }, (_, i) => ({
    start: new Date(first + i * per * HOUR).toISOString(),
    hours: per,
    up: 0,
    down: 0,
  }));
  for (const row of rows) {
    const at = Date.parse(row.hour);
    if (Number.isNaN(at)) continue;
    const index = Math.floor((at - first) / (per * HOUR));
    if (index < 0 || index >= count) continue;
    columns[index].up += Number(row.bytesUp);
    columns[index].down += Number(row.bytesDown);
  }
  return columns;
}

/** The last `days` UTC days as chart columns, oldest first, empty days
 * included. */
export function dayColumns(rows: CustomerTrafficRow[], days: number, now: number = Date.now()): UsageColumn[] {
  const today = Math.floor(now / (24 * HOUR)) * 24 * HOUR;
  const columns: UsageColumn[] = Array.from({ length: days }, (_, i) => ({
    start: new Date(today - (days - 1 - i) * 24 * HOUR).toISOString(),
    hours: 24,
    up: 0,
    down: 0,
  }));
  const byDay = new Map(columns.map((c) => [c.start.slice(0, 10), c]));
  for (const row of rows) {
    const column = byDay.get(row.day.slice(0, 10));
    if (!column) continue;
    column.up += Number(row.bytesUp);
    column.down += Number(row.bytesDown);
  }
  return columns;
}

/** Items grouped under their UTC day, keeping the order they came in. */
export function groupByUtcDay<T extends { at: string }>(items: T[]): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const ms = Date.parse(item.at);
    const day = Number.isNaN(ms) ? "unknown" : new Date(ms).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 18 Nov 2026" for "2026-11-18". */
export function dayHeading(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) return day;
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14:03" in UTC. */
export function utcClock(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(11, 16);
}
