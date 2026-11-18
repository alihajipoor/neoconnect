import type {
  ClientAttemptKind,
  ClientAttemptOutcome,
  CustomerAttemptDetail,
  InsightCredentials,
  InsightNetworkOthers,
} from "@/lib/types";
import { KINDS, OUTCOMES } from "@/lib/attempt-labels";
import { protocolLabel } from "@/lib/protocol-labels";
import { duration } from "@/lib/time";
import { CATEGORY_LABELS, FAILURE_LABELS, categoryLabel, failureLabel } from "./insight-labels";

/** Pure helpers for the customer page's views: reading the query string,
 * building links and API queries, and the short sentences shown beside
 * the counts. No React, so each can be unit tested. */

export type CustomerView = "overview" | "connections" | "usage" | "history";

export const VIEWS: { view: CustomerView; label: string }[] = [
  { view: "overview", label: "Overview" },
  { view: "connections", label: "Connections" },
  { view: "usage", label: "Usage" },
  { view: "history", label: "History" },
];

export function parseView(value: string | undefined): CustomerView {
  return VIEWS.some((v) => v.view === value) ? (value as CustomerView) : "overview";
}

/** The connection report windows on offer, in days. */
export const DAY_WINDOWS = [
  { value: 1, label: "24 hours" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
] as const;

/** The usage windows on offer, in hours. */
export const HOUR_WINDOWS = [
  { value: 24, label: "24 hours" },
  { value: 72, label: "72 hours" },
  { value: 168, label: "7 days" },
  { value: 336, label: "14 days" },
] as const;

export function parseDays(value: string | undefined): number {
  const n = Number(value);
  return DAY_WINDOWS.some((w) => w.value === n) ? n : 7;
}

export function parseHours(value: string | undefined): number {
  const n = Number(value);
  return HOUR_WINDOWS.some((w) => w.value === n) ? n : 72;
}

/** The log's filters, each checked against what the backend accepts: it
 * answers 400 to an unknown kind, outcome, category or cause, and a
 * hand-edited URL should drop the bad filter, not fail the whole log. */
export interface AttemptFilters {
  kind?: string;
  outcome?: string;
  category?: string;
  failureCode?: string;
  platform?: string;
  asn?: string;
  q?: string;
}

export const FILTER_KEYS = ["kind", "outcome", "category", "failureCode", "platform", "asn", "q"] as const;

export function parseAttemptFilters(params: Record<string, string | string[] | undefined>): AttemptFilters {
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const filters: AttemptFilters = {};
  const kind = one("kind");
  if (kind && kind in KINDS) filters.kind = kind;
  const outcome = one("outcome");
  if (outcome && outcome in OUTCOMES) filters.outcome = outcome;
  const category = one("category");
  if (category && category in CATEGORY_LABELS) filters.category = category;
  const failureCode = one("failureCode");
  if (failureCode && failureCode in FAILURE_LABELS) filters.failureCode = failureCode;
  const platform = one("platform");
  if (platform && /^[A-Za-z0-9_.-]{1,32}$/.test(platform)) filters.platform = platform;
  const asn = one("asn");
  if (asn && /^\d{1,10}$/.test(asn)) filters.asn = String(Number(asn));
  const q = one("q");
  if (q) filters.q = q.slice(0, 200);
  return filters;
}

export function hasFilters(filters: AttemptFilters): boolean {
  return FILTER_KEYS.some((key) => filters[key] !== undefined);
}

/** The query for GET /customers/:id/attempts. */
export function attemptsQuery(filters: AttemptFilters, take: number, skip: number): string {
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) query.set(key, value);
  }
  query.set("take", String(take));
  if (skip > 0) query.set("skip", String(skip));
  return query.toString();
}

/** A link to this customer's page with the given query; empty values and
 * the defaults (overview, 7 days, 72 hours) are left out so links stay
 * short and one view has one URL. */
export function customerHref(customerId: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === "") continue;
    const value = String(raw);
    if (key === "view" && value === "overview") continue;
    if (key === "days" && value === "7") continue;
    if (key === "hours" && value === "72") continue;
    query.set(key, value);
  }
  const text = query.toString();
  return `/customers/${encodeURIComponent(customerId)}${text ? `?${text}` : ""}`;
}

/** One quiet line under a subscription: whether its credentials are on
 * the servers, and how many the device limit holds. */
export function credentialLine(c: InsightCredentials): string {
  if (c.total === 0) return "No credentials";
  const parts = [
    c.notProvisioned === 0
      ? `${c.total} ${c.total === 1 ? "credential" : "credentials"}, all on the servers`
      : `${c.notProvisioned} of ${c.total} not yet on the servers`,
  ];
  if (c.held > 0) parts.push(`${c.held} held by the device limit`);
  return parts.join(", ");
}

/** "7 of 9 connected", or why there is no comparison. `others` is null
 * when fewer than three other customers tried the network, and also for
 * networks past the ten busiest, which are not compared at all -- so with
 * more than ten networks a null cannot be told apart and says so. */
export function othersLine(others: InsightNetworkOthers | null, knownNetworks: number): string {
  if (others) return `${others.connected} of ${others.customers} connected`;
  return knownNetworks <= 10 ? "too few to compare" : "too few to compare, or not compared";
}

/** Kilobits a second as megabits: "0.3", "1.7", "12", "240". */
export function mbps(kbps: number): string {
  const value = kbps / 1000;
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** "about 12 Mbps down / 1.7 up" from two medians, or null. */
export function speedText(downKbps: number | null, upKbps: number | null): string | null {
  const down = downKbps === null ? null : `${mbps(downKbps)} Mbps down`;
  const up = upKbps === null ? null : `${mbps(upKbps)}${down ? "" : " Mbps"} up`;
  if (!down && !up) return null;
  return [down, up].filter(Boolean).join(" / ");
}

/** When the app said it happened and when we received it, if those are
 * more than a minute apart -- the apps queue reports while offline. */
export function timesDiffer(attempt: Pick<CustomerAttemptDetail, "at" | "occurredAt" | "receivedAt">): boolean {
  const happened = Date.parse(attempt.occurredAt ?? attempt.at);
  const received = Date.parse(attempt.receivedAt);
  if (Number.isNaN(happened) || Number.isNaN(received)) return false;
  return Math.abs(received - happened) > 60_000;
}

/** A plain-text account of one attempt, to paste into a support thread
 * or an engineering note. Deliberately without the customer's email or
 * address: it is about what the app saw, and it travels. Times in UTC so
 * the reader's time zone cannot shift them. */
export function supportText(attempt: CustomerAttemptDetail): string {
  const outcome = OUTCOMES[attempt.outcome as ClientAttemptOutcome]?.label ?? attempt.outcome;
  const kind = KINDS[attempt.kind as ClientAttemptKind] ?? attempt.kind;
  const lines: string[] = [];
  lines.push(`Report ${attempt.id}`);
  const happened = attempt.occurredAt ?? attempt.at;
  lines.push(`Happened: ${utc(happened)}`);
  if (timesDiffer(attempt)) lines.push(`Received: ${utc(attempt.receivedAt)}`);
  lines.push(`What: ${kind} (${categoryLabel(attempt.category)})`);
  lines.push(`Outcome: ${outcome}`);
  if (attempt.failureCode) lines.push(`Cause: ${failureLabel(attempt.failureCode)}`);
  lines.push(`App: ${attempt.platform} ${attempt.appVersion}`);
  lines.push(
    `Network: ${attempt.network ? `${attempt.network.name ?? "Unnamed network"} AS${attempt.network.asn}` : "unknown"}`,
  );
  if (attempt.server || attempt.protocol) {
    const landed = [attempt.server ?? "unknown server", attempt.protocol ? protocolLabel(attempt.protocol) : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`Landed on: ${landed}${attempt.sessionSeconds !== null ? `, up ${duration(attempt.sessionSeconds)}` : ""}`);
  }
  if (attempt.reason) lines.push(`App said: ${attempt.reason}`);
  if (attempt.rungs.length > 0) {
    lines.push("Tried, in order:");
    attempt.rungs.forEach((rung, i) => {
      const carried = rung.carried === true ? ", carried traffic" : rung.carried === false ? ", carried nothing" : "";
      const speed = speedText(rung.downKbps, rung.upKbps);
      lines.push(
        `  ${i + 1}. ${rung.server ?? "unknown server"} ${rung.protocol ? protocolLabel(rung.protocol) : "unknown protocol"}: ${rung.result}${carried}${speed ? `, about ${speed}` : ""}`,
      );
    });
  }
  if (attempt.apiTrace) {
    const trace = attempt.apiTrace;
    if (trace.noneDialled) lines.push("API trace: none dialled");
    if (trace.entries.length > 0) {
      lines.push("API trace:");
      for (const e of trace.entries) {
        lines.push(`  ${e.leg ?? "-"} ${e.target} ${e.outcome ?? "-"}${e.ms !== null ? ` ${e.ms} ms` : ""}`);
      }
    }
    if (trace.cut > 0) lines.push(`  (${trace.cut} more not kept)`);
    if (trace.probe) lines.push(`Probe: ${trace.probe}`);
  }
  return lines.join("\n");
}

function utc(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
