import type {
  AddressKind,
  CustomerDevice,
  InsightDeviceFacts,
  InsightServiceChecks,
  ReportDataCheckLeg,
  ReportDetails,
  ReportDeviceDetails,
  ReportNetDetails,
  ReportTunnelDetails,
} from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { duration } from "@/lib/time";
import {
  NET_TYPE_LABELS,
  PRIVATE_DNS_LABELS,
  SESSION_END_LABELS,
  TUNNEL_MODE_LABELS,
  VIA_LABELS,
  labelOf,
} from "./insight-labels";
import { customerHref } from "./insight-format";

/** Pure helpers for the client-diagnostics parts of the customer page and
 * the fleet service-check page (docs/client-diagnostics.md): the facts a
 * report carried, said in plain words, and the counts of the service
 * check. Every field is optional on the wire and rows outlive client
 * versions, so each helper says only what is there and never fills a gap
 * with a guess. */

const PLATFORMS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

export function platformName(platform: string | null | undefined): string | null {
  if (!platform) return null;
  return PLATFORMS[platform.toLowerCase()] ?? platform;
}

/** "840 ms", "4.2 s", "38 s". */
export function msText(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** "512 B", "48 KB", "1.2 MB". */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "18 Nov 14:03 UTC": the exact time, readable without a hover. */
export function utcStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month} ${d.toISOString().slice(11, 16)} UTC`;
}

const yesNo = (v: boolean) => (v ? "yes" : "no");

/** The device's system and version: "Android 14". */
function systemText(device: ReportDeviceDetails | null | undefined): string | null {
  if (!device) return null;
  const os = device.os ? (platformName(device.os) ?? device.os) : null;
  const text = [os, device.osVersion].filter(Boolean).join(" ");
  return text || null;
}

/** "Mobile data, metered" / "Wi-Fi". */
function networkText(net: ReportNetDetails | null | undefined): string | null {
  if (!net) return null;
  const type = labelOf(NET_TYPE_LABELS, net.type);
  if (!type) return net.metered === true ? "Metered network" : null;
  if (net.metered === true) return `${type}, metered`;
  if (net.metered === false) return `${type}, not metered`;
  return type;
}

/** Android's Private DNS: the host when one is set, else the mode. */
function privateDnsText(net: ReportNetDetails | null | undefined): string | null {
  if (!net) return null;
  if (net.privateDnsHost) return `Private DNS ${net.privateDnsHost}`;
  return labelOf(PRIVATE_DNS_LABELS, net.privateDns);
}

/** The short facts line under a device on the overview: only what the
 * newest reports said, in the order support reads them. Empty when the
 * reports carried nothing usable. */
export function deviceFactsLine(facts: Pick<InsightDeviceFacts, "device" | "net" | "tunnel">): string[] {
  const { device, net, tunnel } = facts;
  const mode = labelOf(TUNNEL_MODE_LABELS, tunnel?.mode);
  const parts: (string | null | undefined)[] = [
    device?.model,
    systemText(device),
    device?.language ? `language ${device.language}` : null,
    networkText(net),
    net?.dns && net.dns.length > 0 ? `DNS ${net.dns.join(", ")}` : null,
    privateDnsText(net),
    net?.otherVpn === true ? "another VPN active" : null,
    device?.lowPower === true ? "battery saver on" : null,
    device?.dataSaver === true ? "data saver on" : null,
    mode ? `VPN mode ${mode.toLowerCase()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** One labelled fact; `warn` is for the few that are a warning on their
 * own (another VPN active, DNS outside the tunnel). */
export interface Fact {
  label: string;
  value: string;
  warn?: boolean;
}

export interface FactGroup {
  title: string;
  facts: Fact[];
}

function push(facts: Fact[], label: string, value: string | null | undefined, warn?: boolean) {
  if (value === null || value === undefined || value === "") return;
  facts.push(warn ? { label, value, warn } : { label, value });
}

/** The device, network and tunnel facts of one details object as
 * labelled rows, grouped; groups with nothing in them are left out. */
export function detailFactGroups(details: Pick<ReportDetails, "device" | "net" | "tunnel"> | null | undefined): FactGroup[] {
  if (!details) return [];
  const groups: FactGroup[] = [];

  const device: Fact[] = [];
  const d = details.device;
  if (d) {
    push(device, "Model", d.model);
    push(device, "System", systemText(d));
    push(device, "Language", d.language);
    if (typeof d.lowPower === "boolean") push(device, "Battery saver", d.lowPower ? "on" : "off");
    if (typeof d.dataSaver === "boolean") push(device, "Data saver", d.dataSaver ? "on" : "off");
    if (typeof d.memFreeMb === "number") push(device, "Free memory", `${d.memFreeMb.toLocaleString("en-US")} MB`);
  }
  if (device.length > 0) groups.push({ title: "Device", facts: device });

  const network: Fact[] = [];
  const n = details.net;
  if (n) {
    push(network, "Network", labelOf(NET_TYPE_LABELS, n.type));
    if (typeof n.metered === "boolean") push(network, "Metered", yesNo(n.metered));
    if (typeof n.ipv4 === "boolean") push(network, "IPv4", n.ipv4 ? "available" : "not available");
    if (typeof n.ipv6 === "boolean") push(network, "IPv6", n.ipv6 ? "available" : "not available");
    if (typeof n.otherVpn === "boolean") push(network, "Another VPN active", yesNo(n.otherVpn), n.otherVpn);
    if (n.dns && n.dns.length > 0) push(network, "Device DNS", n.dns.join(", "));
    push(network, "Private DNS", n.privateDnsHost ? `set to ${n.privateDnsHost}` : labelOf(PRIVATE_DNS_LABELS, n.privateDns));
  }
  if (network.length > 0) groups.push({ title: "Network", facts: network });

  const tunnel: Fact[] = [];
  const t: ReportTunnelDetails | undefined = details.tunnel;
  if (t) {
    push(tunnel, "Mode", labelOf(TUNNEL_MODE_LABELS, t.mode));
    if (t.dns && t.dns.length > 0) push(tunnel, "VPN DNS", t.dns.join(", "));
    if (typeof t.splitTunnel === "boolean") push(tunnel, "Split tunnel", yesNo(t.splitTunnel));
    if (typeof t.ipv6Blocked === "boolean") push(tunnel, "IPv6 blocked", yesNo(t.ipv6Blocked));
    if (typeof t.dnsUnprotected === "boolean") push(tunnel, "DNS outside the VPN", yesNo(t.dnsUnprotected), t.dnsUnprotected);
  }
  if (tunnel.length > 0) groups.push({ title: "VPN settings", facts: tunnel });

  return groups;
}

/** One leg of the data check: "ok, 48 KB in 320 ms". */
export function dataCheckLegText(leg: ReportDataCheckLeg | null | undefined): string | null {
  if (!leg) return null;
  return `${leg.status}, ${bytesText(leg.bytes)} in ${msText(leg.ms) ?? `${leg.ms} ms`}`;
}

/** "try 3, 2 quick drops, 41 s spent, dropped 2m before". */
export function reconnectText(r: ReportDetails["reconnect"] | null | undefined): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (typeof r.attempt === "number") parts.push(`try ${r.attempt}`);
  if (typeof r.quickDeaths === "number") parts.push(`${r.quickDeaths} quick ${r.quickDeaths === 1 ? "drop" : "drops"}`);
  if (typeof r.spentMs === "number") parts.push(`${msText(r.spentMs)} spent`);
  if (typeof r.droppedSecondsAgo === "number") parts.push(`dropped ${duration(r.droppedSecondsAgo)} before`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "Connection lost after 1h 4m". */
export function sessionEndText(s: ReportDetails["sessionEnd"] | null | undefined): string | null {
  if (!s) return null;
  return `${labelOf(SESSION_END_LABELS, s.cause) ?? "Ended"} after ${duration(s.seconds)}`;
}

/** "ok in 320 ms". */
export function egressText(e: ReportDetails["egress"] | null | undefined): string | null {
  if (!e) return null;
  const ms = msText(e.ms);
  return ms ? `${e.state} in ${ms}` : e.state;
}

/** "through the VPN", "outside the VPN", or the value. */
export function viaText(via: string | null | undefined): string | null {
  return labelOf(VIA_LABELS, via);
}

/** Device facts matched to the device rows: by session where a report
 * named one that is listed, and the rest grouped by platform, so facts
 * from a device with no matching row still show. */
export function factsByDevice(
  devices: Pick<CustomerDevice, "sessionId">[] | null,
  facts: InsightDeviceFacts[] | null | undefined,
): { bySession: Map<string, InsightDeviceFacts>; unmatched: { platform: string; facts: InsightDeviceFacts[] }[] } {
  const listed = new Set((devices ?? []).map((d) => d.sessionId));
  const bySession = new Map<string, InsightDeviceFacts>();
  const groups = new Map<string, InsightDeviceFacts[]>();
  for (const f of facts ?? []) {
    if (f.sessionId && listed.has(f.sessionId) && !bySession.has(f.sessionId)) {
      bySession.set(f.sessionId, f);
      continue;
    }
    const key = f.platform.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const unmatched = [...groups]
    .map(([platform, list]) => ({
      platform,
      facts: [...list].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)),
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
  return { bySession, unmatched };
}

/** Where the customer's newest service-check run went: its server and
 * connection type, or outside the VPN. Null when nothing says. */
export function lastRunRoute(checks: InsightServiceChecks): string | null {
  if (!checks.lastRunAt) return null;
  const run = checks.latest.find((r) => r.at === checks.lastRunAt);
  if (!run) return null;
  if (run.via === "direct") return "outside the VPN";
  if (run.server) return `through ${run.server}${run.protocol ? `, ${protocolLabel(run.protocol)}` : ""}`;
  return run.via === "tunnel" ? "through the VPN, server not named" : null;
}

/** How many of the newest run's own results were reachable. `latest`
 * holds the newest result per service across every run in the window, so
 * a count over all of it would pin older runs' results (other servers,
 * outside the VPN) on the newest run's route. Null when no result is from
 * the newest run. */
export function lastRunCounts(checks: InsightServiceChecks): { reachable: number; total: number } | null {
  if (!checks.lastRunAt) return null;
  const run = checks.latest.filter((r) => r.at === checks.lastRunAt);
  if (run.length === 0) return null;
  return { reachable: run.filter((r) => r.ok).length, total: run.length };
}

const ADDRESS_KIND_LABELS: Record<AddressKind, string> = {
  public: "a public address",
  private: "a private address",
  loopback: "this device (loopback)",
  "link-local": "a link-local address",
  reserved: "a reserved address",
};

/** What kind of address a target resolved to; null when not reported. */
export function addressKindText(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return ADDRESS_KIND_LABELS[kind as AddressKind] ?? kind;
}

/** The address a target resolved to, with its kind: "203.0.113.7 (a
 * reserved address)". The kind alone when an older row has no address;
 * null when neither was reported. */
export function resolvedText(address: string | null | undefined, kind: string | null | undefined): string | null {
  const kindText = addressKindText(kind);
  if (address) return kindText ? `${address} (${kindText})` : address;
  return kindText;
}

/** Whether an address kind is one a well-known name should not resolve
 * to: what a poisoned lookup looks like. Said as the kind, not a cause. */
export function addressKindOdd(kind: string | null | undefined): boolean {
  return !!kind && kind !== "public";
}

/** The first cell of a by-server row: the server, or what the run said
 * about its route. Only a run that said "direct" is outside the VPN. */
export function routeGroupLabel(row: { server: string | null; via: string | null }): string {
  if (row.server) return row.server;
  if (row.via === "direct") return "Outside the VPN";
  if (row.via === "tunnel") return "unknown server";
  return "Route not stated";
}

/** A link to the customer's diagnostics view, opened on one bundle. From
 * a row of the list, pass the list's page so the bundle is on the page
 * the link opens. */
export function diagnosticsHref(
  customerId: string,
  reference?: string | null,
  page?: { take: number; skip: number },
): string {
  return customerHref(customerId, {
    view: "diagnostics",
    ref: reference ?? undefined,
    take: page ? page.take : undefined,
    skip: page && page.skip > 0 ? page.skip : undefined,
  });
}

/** The bundle reference in a history link (`...&ref=ab12cd34`), or null. */
export function referenceFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const query = link.split("?")[1];
  if (!query) return null;
  const ref = new URLSearchParams(query).get("ref");
  return ref && /^[A-Za-z0-9-]{1,36}$/.test(ref) ? ref : null;
}

/** A `ref` from the query, or undefined when it is not one. */
export function parseReference(value: string | undefined): string | undefined {
  const ref = value?.trim().toLowerCase();
  return ref && /^[0-9a-f-]{1,36}$/.test(ref) ? ref : undefined;
}
