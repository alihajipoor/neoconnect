import { Injectable } from "@nestjs/common";
import { DeviceStateStore } from "./device-state.store";

/** Which device a credential belongs to, as presence and the plan's
 * device limit see it.
 *
 * A device credential (ProtocolUser.sessionId set) is its signed-in
 * device. Every shared credential of a subscription (sessionId NULL)
 * counts together as ONE pseudo-device: they cannot be traced to a
 * device, and counting them per credential or per node would let one PC
 * using concurrent exits -- several routes at once -- look like several
 * devices on its own. */
export type DeviceKey = `s:${string}` | "shared";

export const SHARED_DEVICE: DeviceKey = "shared";

export function deviceKeyOf(sessionId: string | null | undefined): DeviceKey {
  return sessionId ? `s:${sessionId}` : SHARED_DEVICE;
}

export function sessionIdOf(key: DeviceKey): string | null {
  return key === SHARED_DEVICE ? null : key.slice(2);
}

/** One credential seen carrying traffic, as stored. */
export interface PresenceEntry {
  protocolUserId: string;
  deviceKey: DeviceKey;
  nodeId: string;
  /** When this credential's current run of activity began -- reset after
   * a gap longer than CONTINUITY_MS. "Newest device" means the latest of
   * these. */
  firstSeen: number;
  lastSeen: number;
}

/** What evaluation needs to know about a subscription's credentials to
 * attribute shared-credential traffic: which route each is on, whose it
 * is, and whether a node has confirmed it. */
export interface CredentialInfo {
  id: string;
  routeId: string;
  sessionId: string | null;
  provisionedAt: Date | null;
}

/** A device, with when its activity began and was last seen. */
export interface ActiveDevice {
  firstSeen: number;
  lastSeen: number;
}

/** How long a gap in a credential's activity may be before its run is
 * considered over and `firstSeen` restarts. Five minutes: a phone
 * changing networks, a laptop lid closed for a coffee. */
const CONTINUITY_MS = 5 * 60_000;

/** How long a subscription's presence is kept with no report at all.
 * Housekeeping only -- every read filters by freshness itself. */
const KEY_TTL_MS = 10 * 60_000;

const keyFor = (subscriptionId: string) => `presence:${subscriptionId}`;

function encode(e: Omit<PresenceEntry, "protocolUserId">): string {
  return `${e.firstSeen}:${e.lastSeen}:${e.nodeId}:${e.deviceKey}`;
}

function decode(protocolUserId: string, raw: string): PresenceEntry | null {
  // The device key may itself contain a colon ("s:<id>"), so it is last
  // and taken whole.
  const [first, last, nodeId, ...rest] = raw.split(":");
  const deviceKey = rest.join(":") as DeviceKey;
  const firstSeen = Number(first);
  const lastSeen = Number(last);
  if (!Number.isFinite(firstSeen) || !Number.isFinite(lastSeen) || !nodeId) return null;
  if (deviceKey !== SHARED_DEVICE && !deviceKey.startsWith("s:")) return null;
  return { protocolUserId, deviceKey, nodeId, firstSeen, lastSeen };
}

/** Which devices of a subscription are carrying traffic.
 *
 * Fed from what nodes already report every ~30 s (see
 * ConcurrencyService.handleReport): a usage delta with bytes in it, or a
 * session count from an engine whose count has no tail. WireGuard
 * clients send a keepalive every 25 s and OpenVPN pings every 10 s, so a
 * connected WireGuard or OpenVPN device always moves bytes and stops the
 * moment it disconnects -- no three-minute handshake tail, no NAT or
 * roaming double count. An Xray device shows only while it carries
 * traffic, which errs towards counting fewer devices, never more.
 *
 * Stored per credential rather than per device so a shared credential's
 * traffic can be attributed to the device that was handed it (see
 * resolveDevices). */
@Injectable()
export class DevicePresence {
  constructor(private readonly store: DeviceStateStore) {}

  /** Records that these credentials carried traffic just now. */
  async record(
    subscriptionId: string,
    seen: { protocolUserId: string; deviceKey: DeviceKey; nodeId: string }[],
    now = Date.now(),
  ): Promise<void> {
    if (seen.length === 0) return;
    const key = keyFor(subscriptionId);
    const existing = await this.store.hgetall(key);
    const fields: Record<string, string> = {};
    for (const s of seen) {
      const previous = existing[s.protocolUserId] ? decode(s.protocolUserId, existing[s.protocolUserId]) : null;
      const continuing = previous && now - previous.lastSeen <= CONTINUITY_MS;
      fields[s.protocolUserId] = encode({
        deviceKey: s.deviceKey,
        nodeId: s.nodeId,
        firstSeen: continuing ? previous.firstSeen : now,
        lastSeen: now,
      });
    }
    await this.store.hset(key, fields, KEY_TTL_MS);
  }

  /** Every credential of the subscription seen within `withinMs`. */
  async entries(subscriptionId: string, withinMs: number, now = Date.now()): Promise<PresenceEntry[]> {
    const raw = await this.store.hgetall(keyFor(subscriptionId));
    const out: PresenceEntry[] = [];
    const stale: string[] = [];
    for (const [id, value] of Object.entries(raw)) {
      const entry = decode(id, value);
      // Malformed: forgotten rather than counted forever.
      if (!entry) {
        stale.push(id);
        continue;
      }
      if (now - entry.lastSeen > CONTINUITY_MS) stale.push(id);
      if (now - entry.lastSeen <= withinMs) out.push(entry);
    }
    if (stale.length > 0) await this.store.hdel(keyFor(subscriptionId), ...stale);
    return out;
  }
}

/** Groups fresh presence into devices.
 *
 * Shared-credential traffic is folded into a signed-in device when that
 * device would have been handed those shared credentials: it holds no
 * confirmed credential of its own on their routes (ProtocolUsersService
 * .deviceView gap-fills exactly those). In the transition a device can
 * run some routes on its own credentials and others on shared ones --
 * concurrent exits make that one PC on two kinds of credential at once
 * -- and counting the shared half as a second device would hold a
 * single-device customer against a limit of one.
 *
 * That can fold an old client's shared traffic into a new client's
 * device, counting two devices as one. That is the direction to err in:
 * too few devices means nobody is held who should not be. */
export function resolveDevices(
  rawEntries: PresenceEntry[],
  credentials: CredentialInfo[],
  /** Shared credentials a device holding a slot said it connects with:
   * their traffic is that device's, whatever the heuristic below says. */
  credit: Map<string, DeviceKey> = new Map(),
): Map<DeviceKey, ActiveDevice> {
  const entries = rawEntries.map((e) => {
    const credited = credit.get(e.protocolUserId);
    return credited && e.deviceKey === SHARED_DEVICE ? { ...e, deviceKey: credited } : e;
  });
  const devices = new Map<DeviceKey, ActiveDevice>();
  const add = (key: DeviceKey, e: { firstSeen: number; lastSeen: number }) => {
    const seen = devices.get(key);
    devices.set(key, {
      firstSeen: seen ? Math.min(seen.firstSeen, e.firstSeen) : e.firstSeen,
      lastSeen: seen ? Math.max(seen.lastSeen, e.lastSeen) : e.lastSeen,
    });
  };

  const sharedEntries = entries.filter((e) => e.deviceKey === SHARED_DEVICE);
  for (const e of entries) if (e.deviceKey !== SHARED_DEVICE) add(e.deviceKey, e);
  if (sharedEntries.length === 0) return devices;

  const routeOf = new Map(credentials.map((c) => [c.id, c.routeId]));
  const sharedRoutes = new Set(sharedEntries.map((e) => routeOf.get(e.protocolUserId)).filter(Boolean));
  const confirmedRoutesOf = (key: DeviceKey) =>
    new Set(
      credentials
        .filter((c) => c.sessionId === sessionIdOf(key) && c.provisionedAt !== null)
        .map((c) => c.routeId),
    );

  // The device the shared traffic most plausibly belongs to: one active
  // device that would have been handed every one of those shared routes.
  const host = [...devices.keys()].find((key) => {
    const own = confirmedRoutesOf(key);
    return [...sharedRoutes].every((route) => !own.has(route as string));
  });
  for (const e of sharedEntries) add(host ?? SHARED_DEVICE, e);
  return devices;
}
