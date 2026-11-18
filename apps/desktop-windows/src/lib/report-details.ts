import { invoke } from "@tauri-apps/api/core";

/** The `details` a report carries (docs/client-diagnostics.md, section A):
 * the device, the network under the tunnel, the tunnel's own settings, and
 * what the connect measured on the way -- the data check's two legs, the
 * exit check, the reconnect's state, why a session ended.
 *
 * Everything here is best effort. A native command that is missing, slow
 * or wrong leaves its part out and nothing else; nothing here throws, and
 * nothing a connect waits on calls it.
 *
 * THE BOUNDARY. Nothing here may name a site the customer visits or looks
 * up. The only addresses are the device's own DNS settings and the
 * resolvers this app itself sets inside the tunnel; the only name is
 * Android's Private DNS host, a setting. Every field is copied by name and
 * bounded by the server's own validators (`report-details.dto.ts`), so a
 * field the server would refuse never leaves: a refused report is counted
 * as delivered and lost (attempts.ts `send`). The local session log
 * (session-log.ts) and engine logs never pass through here. */

export type NetType = "wifi" | "cellular" | "ethernet" | "other" | "none" | "unknown";
export type TunnelMode = "full" | "custom" | "gaming";
export type SessionEndCause = "disconnected" | "lost" | "replaced" | "app_closed" | "unknown";
export type ServiceStage = "dns" | "connect" | "tls" | "http" | "ok";

export interface DeviceDetails {
  model?: string;
  os?: string;
  osVersion?: string;
  language?: string;
  lowPower?: boolean;
  dataSaver?: boolean;
  memFreeMb?: number;
}

export interface NetDetails {
  type?: NetType;
  metered?: boolean;
  ipv4?: boolean;
  ipv6?: boolean;
  otherVpn?: boolean;
  dns?: string[];
  privateDns?: "off" | "auto" | "host" | "unknown";
  privateDnsHost?: string;
}

export interface TunnelDetails {
  mode?: TunnelMode;
  dns?: string[];
  splitTunnel?: boolean;
  ipv6Blocked?: boolean;
  dnsUnprotected?: boolean;
}

export interface DataLegDetails {
  status: string;
  bytes: number;
  ms: number;
}

export interface ServiceResult {
  key: string;
  host: string;
  ok: boolean;
  stage: ServiceStage;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  firstByteMs?: number;
  status?: number;
  address?: string;
  error?: string;
}

export interface ReportDetails {
  device?: DeviceDetails;
  net?: NetDetails;
  tunnel?: TunnelDetails;
  errorKind?: string;
  dataCheck?: { down?: DataLegDetails; up?: DataLegDetails };
  egress?: { state: string; ms?: number };
  reconnect?: { attempt?: number; quickDeaths?: number; spentMs?: number; droppedSecondsAgo?: number };
  sessionEnd?: { cause: SessionEndCause; seconds: number };
  via?: "tunnel" | "direct";
  targetsVersion?: number;
  services?: ServiceResult[];
}

/* ------------------------------------------------------------------ *
 * Bounds: the server's, from report-details.dto.ts.
 * ------------------------------------------------------------------ */

const NET_TYPES = new Set(["wifi", "cellular", "ethernet", "other", "none", "unknown"]);
const PRIVATE_DNS_MODES = new Set(["off", "auto", "host", "unknown"]);
const TUNNEL_MODES = new Set(["full", "custom", "gaming"]);
const SESSION_END_CAUSES = new Set(["disconnected", "lost", "replaced", "app_closed", "unknown"]);
const STAGES = new Set(["dns", "connect", "tls", "http", "ok"]);
const MAX_DNS = 4;
const MAX_SERVICES = 16;
const SERVICE_MS_MAX = 120_000;
const INT_MAX = 2_147_483_647;

/** The most a report's details may serialize to here. The server drops
 * the whole object over 8 KB (`DETAILS_MAX_BYTES`); this keeps well under
 * it, and gives way part by part rather than all at once (`capDetails`). */
export const DETAILS_CAP_BYTES = 6_000;

const IPV4_PART = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_PART}(?:\\.${IPV4_PART}){3}$`);

/** An IP literal as the server's `IsIP` reads one -- stricter, if
 * anything: no zone index, no leading zeros. Anything else is left out
 * rather than sent to be refused. */
export function isIpLiteral(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 45) return false;
  if (IPV4.test(value)) return true;
  if (!value.includes(":") || value.includes("%")) return false;
  let text = value;
  let groupsNeeded = 8;
  // An embedded IPv4 tail counts as two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return false;
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const group = /^[0-9a-fA-F]{1,4}$/;
  const parts = (half: string) => (half === "" ? [] : half.split(":"));
  if (halves.length === 1) {
    const all = parts(halves[0]);
    return all.length === groupsNeeded && all.every((g) => group.test(g));
  }
  const [head, rest] = [parts(halves[0]), parts(halves[1])];
  groupsNeeded -= 1;
  return head.length + rest.length <= groupsNeeded && [...head, ...rest].every((g) => group.test(g));
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function int(value: unknown, max = INT_MAX): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), 0), max);
}

function oneOf<T extends string>(value: unknown, allowed: Set<string>): T | undefined {
  return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

/** The sixteen bytes of an IPv6 literal `isIpLiteral` accepted. */
function v6Bytes(value: string): number[] {
  let text = value;
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, text.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const groups = (half: string | undefined) => (half ? half.split(":").map((g) => parseInt(g, 16)) : []);
  const front = groups(head);
  const back = groups(rest);
  const all = rest === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  return all.flatMap((g) => [g >> 8, g & 0xff]);
}

/** A resolver address that can carry the router's hardware address: an
 * IPv6 link-local one (fe80::/10, what home routers commonly advertise as
 * themselves) or one whose interface ID is EUI-64 (ff:fe in its middle,
 * built from a MAC). The native side drops these already
 * (device_facts.rs `names_hardware`); this is the backstop. */
export function namesHardware(ip: string): boolean {
  if (!ip.includes(":")) return false;
  const bytes = v6Bytes(ip);
  return (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || (bytes[11] === 0xff && bytes[12] === 0xfe);
}

function ips(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = [...new Set(value.filter(isIpLiteral).filter((ip) => !namesHardware(ip)))].slice(0, MAX_DNS);
  return kept.length > 0 ? kept : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `parts` with its undefined keys taken out, or undefined when none is left. */
function compact<T extends object>(parts: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function cleanDevice(value: unknown): DeviceDetails | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return compact<DeviceDetails>({
    model: str(raw.model, 64),
    os: str(raw.os, 32),
    osVersion: str(raw.osVersion, 48),
    language: str(raw.language, 16),
    lowPower: bool(raw.lowPower),
    dataSaver: bool(raw.dataSaver),
    memFreeMb: int(raw.memFreeMb, 1_048_576),
  });
}

export function cleanNet(value: unknown): NetDetails | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return compact<NetDetails>({
    type: oneOf<NetType>(raw.type, NET_TYPES),
    metered: bool(raw.metered),
    ipv4: bool(raw.ipv4),
    ipv6: bool(raw.ipv6),
    otherVpn: bool(raw.otherVpn),
    dns: ips(raw.dns),
    privateDns: oneOf<NonNullable<NetDetails["privateDns"]>>(raw.privateDns, PRIVATE_DNS_MODES),
    privateDnsHost: str(raw.privateDnsHost, 128),
  });
}

function cleanTunnel(value: unknown): TunnelDetails | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return compact<TunnelDetails>({
    mode: oneOf<TunnelMode>(raw.mode, TUNNEL_MODES),
    // Addresses only: the resolver-URL form the server also takes is
    // nothing this app sets.
    dns: ips(raw.dns),
    splitTunnel: bool(raw.splitTunnel),
    ipv6Blocked: bool(raw.ipv6Blocked),
    dnsUnprotected: bool(raw.dnsUnprotected),
  });
}

function cleanLeg(value: unknown): DataLegDetails | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const status = str(raw.status, 24);
  const bytes = int(raw.bytes);
  const ms = int(raw.ms);
  return status !== undefined && bytes !== undefined && ms !== undefined ? { status, bytes, ms } : undefined;
}

export function cleanService(value: unknown): ServiceResult | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const key = str(raw.key, 32);
  const host = typeof raw.host === "string" && raw.host.length <= 128 ? raw.host : undefined;
  const ok = bool(raw.ok);
  const stage = oneOf<ServiceStage>(raw.stage, STAGES);
  if (key === undefined || host === undefined || ok === undefined || stage === undefined) return undefined;
  return {
    key,
    host,
    ok,
    stage,
    ...compact({
      dnsMs: int(raw.dnsMs, SERVICE_MS_MAX),
      connectMs: int(raw.connectMs, SERVICE_MS_MAX),
      tlsMs: int(raw.tlsMs, SERVICE_MS_MAX),
      firstByteMs: int(raw.firstByteMs, SERVICE_MS_MAX),
      status: int(raw.status, 999),
      address: isIpLiteral(raw.address) ? raw.address : undefined,
      error: str(raw.error, 120),
    }),
  };
}

/** `value` as the server accepts it: every known key bounded, every
 * unknown one dropped, each part left out when nothing of it is left.
 * Undefined when nothing at all is. */
export function sanitizeDetails(value: unknown): ReportDetails | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const dataCheck = obj(raw.dataCheck);
  const egress = obj(raw.egress);
  const reconnect = obj(raw.reconnect);
  const sessionEnd = obj(raw.sessionEnd);
  const egressState = egress ? str(egress.state, 32) : undefined;
  const endCause = sessionEnd ? oneOf<SessionEndCause>(sessionEnd.cause, SESSION_END_CAUSES) : undefined;
  const endSeconds = sessionEnd ? int(sessionEnd.seconds, 7 * 86_400) : undefined;
  const services = Array.isArray(raw.services)
    ? raw.services.map(cleanService).filter((s): s is ServiceResult => s !== undefined).slice(0, MAX_SERVICES)
    : undefined;
  return compact<ReportDetails>({
    device: cleanDevice(raw.device),
    net: cleanNet(raw.net),
    tunnel: cleanTunnel(raw.tunnel),
    errorKind: str(raw.errorKind, 40),
    dataCheck: dataCheck ? compact({ down: cleanLeg(dataCheck.down), up: cleanLeg(dataCheck.up) }) : undefined,
    egress: egressState !== undefined ? { state: egressState, ...compact({ ms: int(egress?.ms) }) } : undefined,
    reconnect: reconnect
      ? compact({
          attempt: int(reconnect.attempt),
          quickDeaths: int(reconnect.quickDeaths),
          spentMs: int(reconnect.spentMs),
          droppedSecondsAgo: int(reconnect.droppedSecondsAgo),
        })
      : undefined,
    sessionEnd: endCause !== undefined && endSeconds !== undefined ? { cause: endCause, seconds: endSeconds } : undefined,
    via: raw.via === "tunnel" || raw.via === "direct" ? raw.via : undefined,
    targetsVersion: int(raw.targetsVersion),
    services: services && services.length > 0 ? services : undefined,
  });
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** The parts given up first when a report's details are too long: the
 * least useful first. The service results go last, and only after their
 * error words; the object as a whole is never dropped for being long. */
const DROP_ORDER: (keyof ReportDetails)[] = ["reconnect", "egress", "dataCheck", "tunnel", "device", "net", "errorKind"];

export function capDetails(details: ReportDetails | undefined, maxBytes = DETAILS_CAP_BYTES): ReportDetails | undefined {
  if (!details) return undefined;
  let fitted: ReportDetails = { ...details };
  if (byteSize(fitted) <= maxBytes) return fitted;
  if (fitted.services) {
    fitted = { ...fitted, services: fitted.services.map(({ error: _error, ...rest }) => rest) };
    if (byteSize(fitted) <= maxBytes) return fitted;
  }
  for (const key of DROP_ORDER) {
    if (fitted[key] === undefined) continue;
    const { [key]: _gone, ...rest } = fitted;
    fitted = rest;
    if (byteSize(fitted) <= maxBytes) return compact(fitted);
  }
  while (fitted.services && fitted.services.length > 0 && byteSize(fitted) > maxBytes) {
    const services = fitted.services.slice(0, -1);
    fitted = services.length > 0 ? { ...fitted, services } : (({ services: _s, ...rest }) => rest)(fitted);
  }
  return byteSize(fitted) <= maxBytes ? compact(fitted) : undefined;
}

/* ------------------------------------------------------------------ *
 * The device and its network (`device_facts`).
 * ------------------------------------------------------------------ */

/** How long the facts are waited for. The native side holds itself to
 * about a second; this only covers an IPC answer that never comes. */
export const FACTS_WAIT_MS = 1_500;
/** How long a network reading is reused. */
export const NET_FRESH_MS = 30_000;

type Facts = { device?: DeviceDetails; net?: NetDetails };
/** What cannot change while the app runs: kept from the first good read. */
type FixedDevice = Pick<DeviceDetails, "model" | "os" | "osVersion">;
/** What can (free memory, battery saver, data saver): read again with the
 * network, at most every `NET_FRESH_MS`. */
type LiveDevice = Pick<DeviceDetails, "lowPower" | "dataSaver" | "memFreeMb">;

let deviceCache: FixedDevice | null | undefined;
let netCache: { net: NetDetails | undefined; live: LiveDevice | undefined; at: number } | null = null;
let factsInFlight: Promise<Facts | null> | null = null;
let languageOf: () => string | undefined = () => undefined;

/** Where the interface language is read from. Set by the i18n module, so
 * this one -- loaded by the report queue -- does not load the dictionaries. */
export function setLanguageSource(source: () => string | undefined): void {
  languageOf = source;
}

async function askFacts(): Promise<Facts | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      invoke<unknown>("device_facts"),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FACTS_WAIT_MS);
      }),
    ]);
    const raw = obj(answer);
    if (!raw) return null;
    return { device: cleanDevice(raw), net: cleanNet(raw.net) };
  } catch {
    // A shell without the command (the macOS shell): nothing is known.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The device's model and system (asked once a run), and its free memory,
 * battery saver and data saver with the network (at most every
 * `NET_FRESH_MS`). All absent when the command is missing or failed: the
 * language alone is not sent as if the device had been read. */
export async function readFacts(now: () => number = Date.now): Promise<Facts> {
  const netFresh = netCache !== null && now() - netCache.at < NET_FRESH_MS;
  if (deviceCache === undefined || !netFresh) {
    factsInFlight ??= askFacts().finally(() => {
      factsInFlight = null;
    });
    const facts = await factsInFlight;
    if (facts !== null) {
      const device = facts.device ?? {};
      // A failed read is asked again next time; a good one is kept.
      if (deviceCache === undefined || deviceCache === null) {
        deviceCache = compact<FixedDevice>({ model: device.model, os: device.os, osVersion: device.osVersion }) ?? null;
      }
      const live = compact<LiveDevice>({ lowPower: device.lowPower, dataSaver: device.dataSaver, memFreeMb: device.memFreeMb });
      netCache = { net: facts.net, live, at: now() };
    } else {
      // An old reading of the network, or of the free memory, is not sent
      // as the current one.
      netCache = null;
      if (deviceCache === undefined) return {};
    }
  }
  const language = str(languageOf(), 16);
  const known = compact<DeviceDetails>({ ...deviceCache, ...netCache?.live });
  const device = known ? { ...known, ...(language ? { language } : {}) } : undefined;
  return compact<Facts>({ device, net: netCache?.net }) ?? {};
}

/* ------------------------------------------------------------------ *
 * What the app knows of its own tunnel, kept as the screens learn it.
 * ------------------------------------------------------------------ */

let tunnelFacts: TunnelDetails = {};

/** A rung landed: its settings (mode, resolvers) replace whatever the last
 * tunnel's were, so nothing of an older session -- its resolvers, its
 * Custom mode -- is reported as this one's. */
export function landTunnel(facts: TunnelDetails): void {
  tunnelFacts = compact(facts) ?? {};
}

/** More of the live tunnel's settings, from the status poll (Custom mode,
 * IPv6, DNS): merged into the landing's. Ignored while no tunnel has
 * landed, so a poll answering after a teardown does not start a record
 * of its own. */
export function noteTunnel(facts: TunnelDetails): void {
  if (Object.keys(tunnelFacts).length === 0) return;
  tunnelFacts = { ...tunnelFacts, ...compact(facts) };
}

/** The tunnel is gone (a disconnect, a drop, a teardown) or about to be
 * replaced (a pass begins): nothing of it goes with a later report. */
export function clearTunnel(): void {
  tunnelFacts = {};
}

export function currentTunnel(): TunnelDetails | undefined {
  return cleanTunnel(tunnelFacts);
}

/** The resolvers this app sets inside the tunnel for `protocol`, where it
 * is one address the app itself chooses: Xray's TUN resolver (both apps'
 * `TUN_DNS`), the Windows IKEv2 one (`IKEV2_DNS` in the service), and a
 * WireGuard credential's own `dns`. Undefined where this layer does not
 * know -- OpenVPN's pushed resolvers, IKEv2 on a phone or on Linux. */
export function tunnelResolvers(
  protocol: string,
  credentials: Record<string, string> | undefined,
  platform: string,
): string[] | undefined {
  if (protocol === "WIREGUARD") return ips(credentials?.dns?.split(",").map((part) => part.trim()));
  if (protocol.startsWith("XRAY_") || protocol === "SHADOWSOCKS") return platform === "linux" ? undefined : ["1.1.1.1"];
  if (protocol === "IKEV2" && platform === "windows") return ["1.1.1.1"];
  return undefined;
}

/* ------------------------------------------------------------------ *
 * What the last connect measured, kept until a CONNECT report takes it.
 * ------------------------------------------------------------------ */

/** How old a measurement may be and still go with a connect report. */
export const MEASUREMENT_FRESH_MS = 120_000;

type Leg = { status: number | null; bytes: number; ms: number };
let lastDataCheck: { down: DataLegDetails; up: DataLegDetails; at: number } | null = null;
let lastEgress: { state: string; ms: number; at: number } | null = null;

function legOf(leg: Leg): DataLegDetails {
  return { status: leg.status === null ? "none" : String(leg.status), bytes: int(leg.bytes) ?? 0, ms: int(leg.ms) ?? 0 };
}

/** The data check's two legs, as measured: kept beside its verdict, which
 * is not changed by this (data-check.ts). */
export function noteDataCheck(check: { down: Leg; up: Leg } | null, now: () => number = Date.now): void {
  if (!check || !check.down || !check.up) return;
  lastDataCheck = { down: legOf(check.down), up: legOf(check.up), at: now() };
}

/** The exit check's verdict and how long it took (egress.ts). */
export function noteEgress(state: string, ms: number, now: () => number = Date.now): void {
  lastEgress = { state, ms: int(ms) ?? 0, at: now() };
}

/** A connect pass begins: what an earlier pass measured is not this
 * one's, even inside the two minutes. */
export function clearMeasurements(): void {
  lastDataCheck = null;
  lastEgress = null;
}

/** The last data check and exit check, when recent, given up once taken:
 * each goes with one connect report. */
export function takeMeasurements(now: () => number = Date.now): Pick<ReportDetails, "dataCheck" | "egress"> {
  const fresh = (at: number) => now() - at <= MEASUREMENT_FRESH_MS;
  const out: Pick<ReportDetails, "dataCheck" | "egress"> = {};
  if (lastDataCheck && fresh(lastDataCheck.at)) out.dataCheck = { down: lastDataCheck.down, up: lastDataCheck.up };
  if (lastEgress && fresh(lastEgress.at)) out.egress = { state: lastEgress.state, ms: lastEgress.ms };
  lastDataCheck = null;
  lastEgress = null;
  return out;
}

/* ------------------------------------------------------------------ *
 * A report's details, whole.
 * ------------------------------------------------------------------ */

/** The details for a report of `kind`: the device and network, the
 * tunnel's settings (a successful connect, sessions, service checks), the
 * last measurements (a connect), with `own` -- what the caller knows,
 * which wins -- on top. Sanitized and capped; undefined when nothing is
 * known. Never rejects.
 *
 * The tunnel and the measurements are read at the call, before anything
 * is awaited: a teardown right after the call (a session's end, then the
 * disconnect) does not take them from the report it was made for. A
 * failed connect landed nothing, so it carries no tunnel. */
export async function collectDetails(kind: string, own?: ReportDetails, outcome?: string): Promise<ReportDetails | undefined> {
  try {
    const base: ReportDetails = {};
    const withTunnel = (kind === "CONNECT" && outcome === "SUCCESS") || kind === "SESSION" || kind === "SERVICE_CHECK";
    const tunnel = withTunnel ? currentTunnel() : undefined;
    if (tunnel) base.tunnel = tunnel;
    if (kind === "CONNECT") Object.assign(base, takeMeasurements());
    Object.assign(base, await readFacts());
    return capDetails(sanitizeDetails({ ...base, ...own }));
  } catch {
    return capDetails(sanitizeDetails(own));
  }
}

export function resetReportDetailsForTests(): void {
  deviceCache = undefined;
  netCache = null;
  factsInFlight = null;
  tunnelFacts = {};
  lastDataCheck = null;
  lastEgress = null;
  languageOf = () => undefined;
}
