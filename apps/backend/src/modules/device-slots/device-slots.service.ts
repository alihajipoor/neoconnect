import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { KeyedLock } from "../protocol-users/keyed-lock";
import { hasDeviceInfo, specificLabel, type DeviceInfo } from "../../common/device-info";
import { DeviceStateStore } from "./device-state.store";
import { DevicePresence, deviceKeyOf, resolveDevices, type DeviceKey } from "./device-presence";
import { deviceSlotsMode } from "./modes";

/** How often a device holding a slot renews it, told to the client in
 * every grant. */
export const RENEW_EVERY_SEC = 60;
/** A holder neither renewed nor seen carrying traffic for this long has
 * stopped using the slot: a claim against it is granted without asking.
 * One and a half renewals, and presence covers a phone in the background
 * that cannot renew (WireGuard and OpenVPN keepalives always show it). */
export const STALE_AFTER_SEC = 90;
const STALE_MS = STALE_AFTER_SEC * 1000;

/** The node-side backstop gives a displaced device this long to notice
 * (its next renewal) and disconnect before it may be held -- unless that
 * device had itself taken the slot over within RECENT_TAKEOVER_MS, which
 * is what two devices overlapping grace periods on purpose looks like. */
export const DISPLACED_GRACE_MS = 90_000;
const RECENT_TAKEOVER_MS = 5 * 60_000;

/** Takeovers per subscription per hour. Past the first, an admin should
 * hear about it; past the second, takeovers are refused for the rest of
 * the hour (a person tapping "use here instead" does not get near it). */
const TAKEOVER_WINDOW_MS = 60 * 60_000;
const TAKEOVERS_LOGGED_PAST = 10;
const TAKEOVERS_REFUSED_PAST = 30;

/** How long a subscription's slots outlive the last write to them --
 * a claim, a renewal, or (keepAlive) a report of its devices carrying
 * traffic. Housekeeping: whether a holder is still using its slot is
 * decided by STALE_MS, never by this. But it must not run out under a
 * holder that is in use without renewing -- a phone's always-on tunnel
 * nobody opens the app on -- or the next device would be let in with no
 * refusal and the phone told later it had been displaced. */
const SLOT_TTL_MS = 24 * 60 * 60_000;
const DISPLACED_TTL_MS = 60 * 60_000;

const slotsKey = (subscriptionId: string) => `slots:${subscriptionId}`;
const displacedKey = (subscriptionId: string) => `slots-displaced:${subscriptionId}`;
const takeoversKey = (subscriptionId: string) => `slots-takeovers:${subscriptionId}`;

interface Holder {
  sessionId: string;
  /** Opaque, new with every grant -- a claim while holding the slot
   * included. What another device names to take this one over (a session
   * id is never handed to another device), and what this device's release
   * names, so a release that arrives after a newer claim drops nothing. */
  handle: string;
  /** The handle before the last re-claim, still good for a takeover: a
   * refusal card shown just before this device claimed again must not
   * need a second tap. Absent on records from before it existed. */
  previousHandle?: string | null;
  since: number;
  lastRenew: number;
  label: string | null;
  platform: string | null;
  /** A shared credential this device said it is connecting with, so that
   * credential's traffic counts as this device's (see resolveDevices). */
  protocolUserId: string | null;
  /** When this device got its slot by taking it over, if it did. */
  tookOverAt: number | null;
}

interface Displacement {
  by: { handle: string; label: string | null; platform: string | null };
  at: number;
  /** The displaced device had itself taken over within
   * RECENT_TAKEOVER_MS: the backstop gives it no grace. */
  noGrace: boolean;
}

/** Who is asking: the customer, and the signed-in device (session) their
 * token names. A token from before sessions names none. */
export interface SlotCaller {
  customerId: string;
  sessionId?: string;
}

export interface HolderView {
  handle: string;
  label: string | null;
  platform: string | null;
  since: string;
  lastSeen: string;
}

export type ClaimResult = {
  granted: true;
  /** False when nothing was recorded: DEVICE_SLOTS=off, an unlimited
   * plan, or a token that names no device. The client goes ahead either
   * way; it means renewals are pointless but harmless. */
  enforced: boolean;
  subscriptionId: string;
  limit: number | null;
  handle: string | null;
  renewEverySec: number;
  staleAfterSec: number;
};

export type RenewResult =
  | (Omit<ClaimResult, "granted"> & { status: "held" })
  | {
      status: "displaced";
      subscriptionId: string;
      limit: number | null;
      by: { handle: string; label: string | null; platform: string | null };
      at: string;
    }
  | { status: "inactive"; subscriptionId: string; subscriptionStatus: string };

/** What the node-side backstop needs to know about a subscription's
 * slots: who holds one (never held), who was displaced and when (held
 * first, after a grace), and which shared credentials a holder named. */
export interface SlotState {
  holders: Set<DeviceKey>;
  /** Holders that renewed within STALE_AFTER_SEC: using their slot
   * whether or not their traffic shows yet. */
  live: Set<DeviceKey>;
  displaced: Map<DeviceKey, { at: number; noGrace: boolean }>;
  credit: Map<string, DeviceKey>;
}

/** A device was just let in: by a claim (with or without a takeover) or
 * by a renewal that gave a lapsed slot back. */
export interface SlotGrant {
  subscriptionId: string;
  sessionId: string;
  /** The shared credential it said it is connecting with, if any. */
  protocolUserId: string | null;
}

/** Device slots: the plan's device limit as the apps ask for it before
 * connecting (docs/device-slots.md).
 *
 * A plan's maxConcurrentConnections is how many of the customer's
 * devices may use the VPN at the same time (owner decision, 2026-10-06:
 * "if someone uses the VPN on their PC, they shouldn't be able to use it
 * on the phone at the same time if the plan limit is 1"). A device
 * claims a slot before it dials; if the slots are taken, the claim is
 * refused with 409 DEVICE_LIMIT naming where Neoxify is in use, and the
 * app offers "Use on this device instead", which claims again with
 * takeover. The device taken over learns it on its next renewal and
 * disconnects without running its failover ladder.
 *
 * Never a precondition for connecting. An app that cannot reach the API
 * -- in Iran, often -- dials anyway and claims once it can; that is the
 * client's side of the contract, and the backstop covers the gap.
 *
 * State is in Redis (DeviceStateStore), changed one claim at a time per
 * subscription (KeyedLock, the single-instance assumption the rest of
 * the backend makes). */
@Injectable()
export class DeviceSlotsService {
  private readonly logger = new Logger(DeviceSlotsService.name);
  private readonly lock = new KeyedLock();
  private readonly grantListeners: ((grant: SlotGrant) => Promise<void>)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DeviceStateStore,
    private readonly presence: DevicePresence,
  ) {}

  /** Tells `listener` about every device let in, before its grant is
   * answered -- how the backstop lifts a hold on a device the moment it
   * holds a slot, so the dial that follows the grant works. A listener
   * here rather than a dependency: this module imports nothing, so the
   * modules that act on slots can all import it without a cycle. */
  onGrant(listener: (grant: SlotGrant) => Promise<void>): void {
    this.grantListeners.push(listener);
  }

  /** Never fails the grant: a listener's failure is logged, and the
   * backstop's own evaluation lifts the hold at its next reading. */
  private async announce(grant: SlotGrant) {
    for (const listener of this.grantListeners) {
      try {
        await listener(grant);
      } catch (err) {
        this.logger.warn(
          `After granting session ${grant.sessionId} a slot on ${grant.subscriptionId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Asks for a slot on one subscription, optionally taking over the
   * holders named by handle. Throws 401 (device signed out), 404 (not the
   * caller's subscription), 409 DEVICE_LIMIT, 409 SUBSCRIPTION_INACTIVE,
   * or 429 TAKEOVER_LIMIT; never 401 for the limit itself. */
  async claim(
    caller: SlotCaller,
    request: { subscriptionId: string; protocolUserId?: string; takeover?: string[] },
    device?: DeviceInfo,
  ): Promise<ClaimResult> {
    const { subscription, session } = await this.context(caller, request.subscriptionId);
    if (subscription.status !== "ACTIVE") {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        code: "SUBSCRIPTION_INACTIVE",
        message: "This subscription is not active.",
        subscriptionStatus: subscription.status,
      });
    }
    if (session && device && hasDeviceInfo(device)) await this.nameSession(session.id, device);

    const limit = positive(subscription.limit);
    if (!session || limit === null || deviceSlotsMode() === "off") {
      return this.unenforced(subscription.id, limit);
    }

    const label = specificLabel(device?.label) ?? specificLabel(session.label);
    const platform = (device?.platform ?? null) || session.platform;
    const named = request.protocolUserId
      ? await this.sharedCredentialOf(subscription.id, request.protocolUserId)
      : null;

    let credited: string | null = named;
    const result = await this.lock.run(subscription.id, async () => {
      const now = Date.now();
      const holders = await this.holders(subscription.id);
      const mine = holders.find((h) => h.sessionId === session.id);
      if (mine) {
        // The same slot, under a new handle: Disconnect then Connect
        // sends a release and then a claim, and the release can arrive
        // second. Naming the old handle, it then finds nothing to drop.
        credited = named ?? mine.protocolUserId;
        const handle = newHandle();
        await this.writeHolder(subscription.id, {
          ...mine,
          handle,
          previousHandle: mine.handle,
          lastRenew: now,
          label,
          platform,
          protocolUserId: credited,
        });
        await this.store.hdel(displacedKey(subscription.id), session.id);
        return this.granted(subscription.id, limit, handle);
      }

      const [seen, gone] = await Promise.all([this.lastSeen(subscription.id, holders, now), this.signedOut(holders)]);
      const live = holders.filter(
        (h) => !gone.has(h.sessionId) && now - (seen.get(h.sessionId) ?? h.lastRenew) <= STALE_MS,
      );
      const stale = holders.filter((h) => !live.includes(h));

      // Only as many as it takes to make room, from those named: the
      // least recently seen first. A device that sent every handle a 409
      // showed it on a plan of two must not displace both.
      const wanted = new Set(request.takeover ?? []);
      const needed = live.length - limit + 1;
      const takenOver = live
        .filter((h) => wanted.has(h.handle) || (!!h.previousHandle && wanted.has(h.previousHandle)))
        .sort((a, b) => (seen.get(a.sessionId) ?? a.lastRenew) - (seen.get(b.sessionId) ?? b.lastRenew))
        .slice(0, Math.max(0, needed));
      const remaining = live.filter((h) => !takenOver.includes(h));

      if (remaining.length >= limit) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: "DEVICE_LIMIT",
          message: `Your plan allows ${limit} ${limit === 1 ? "device" : "devices"} at a time.`,
          limit,
          holders: remaining.map((h) => view(h, seen.get(h.sessionId) ?? h.lastRenew)),
        });
      }
      // Counted (and possibly refused) only for a takeover that is about
      // to happen.
      if (takenOver.length > 0) await this.countTakeover(subscription.id, now);

      const handle = newHandle();
      const holder: Holder = {
        sessionId: session.id,
        handle,
        since: now,
        lastRenew: now,
        label,
        platform,
        protocolUserId: named,
        tookOverAt: takenOver.length > 0 ? now : null,
      };

      // Stale holders lose a slot they have stopped using without being
      // asked; they find out on their next renewal, which re-grants if
      // there is room by then. Taken-over holders are told why.
      await this.store.hdel(slotsKey(subscription.id), ...[...stale, ...takenOver].map((h) => h.sessionId));
      const marks: Record<string, string> = {};
      for (const h of takenOver) {
        const displacement: Displacement = {
          by: { handle, label, platform },
          at: now,
          noGrace: h.tookOverAt !== null && now - h.tookOverAt < RECENT_TAKEOVER_MS,
        };
        marks[h.sessionId] = JSON.stringify(displacement);
      }
      await this.store.hset(displacedKey(subscription.id), marks, DISPLACED_TTL_MS);
      await this.store.hdel(displacedKey(subscription.id), session.id);
      await this.writeHolder(subscription.id, holder);

      if (takenOver.length > 0) {
        this.logger.log(
          `Subscription ${subscription.id}: session ${session.id} took the slot over from ` +
            takenOver.map((h) => h.sessionId).join(", "),
        );
      }
      return this.granted(subscription.id, limit, handle);
    });
    await this.announce({ subscriptionId: subscription.id, sessionId: session.id, protocolUserId: credited });
    return result;
  }

  /** Keeps a slot. Answers `held`, or `displaced` (with by whom) for a
   * device whose slot was taken over -- always 200, never 401 or 409 for
   * that. A device whose slot lapsed while it was quiet gets it back if
   * there is room, and is told it is displaced if there is not. */
  async renew(caller: SlotCaller, request: { subscriptionId: string }): Promise<RenewResult> {
    const { subscription, session } = await this.context(caller, request.subscriptionId);
    if (subscription.status !== "ACTIVE") {
      return { status: "inactive", subscriptionId: subscription.id, subscriptionStatus: subscription.status };
    }
    const limit = positive(subscription.limit);
    if (!session || limit === null || deviceSlotsMode() === "off") {
      return { status: "held", ...withoutGranted(this.unenforced(subscription.id, limit)) };
    }

    let regranted = false;
    const result = await this.lock.run(subscription.id, async (): Promise<RenewResult> => {
      const now = Date.now();
      const holders = await this.holders(subscription.id);
      const mine = holders.find((h) => h.sessionId === session.id);
      if (mine) {
        await this.writeHolder(subscription.id, { ...mine, lastRenew: now });
        return { status: "held" as const, ...withoutGranted(this.granted(subscription.id, limit, mine.handle)) };
      }

      const displaced = await this.displacement(subscription.id, session.id);
      if (displaced) {
        return {
          status: "displaced" as const,
          subscriptionId: subscription.id,
          limit,
          by: { ...displaced.by, label: specificLabel(displaced.by.label) },
          at: new Date(displaced.at).toISOString(),
        };
      }

      // Lapsed while quiet (or forgotten, if Redis was lost): back in if
      // there is room, as a claim without takeover would be.
      const [seen, gone] = await Promise.all([this.lastSeen(subscription.id, holders, now), this.signedOut(holders)]);
      const live = holders.filter(
        (h) => !gone.has(h.sessionId) && now - (seen.get(h.sessionId) ?? h.lastRenew) <= STALE_MS,
      );
      if (live.length < limit) {
        const handle = newHandle();
        await this.store.hdel(
          slotsKey(subscription.id),
          ...holders.filter((h) => !live.includes(h)).map((h) => h.sessionId),
        );
        await this.writeHolder(subscription.id, {
          sessionId: session.id,
          handle,
          since: now,
          lastRenew: now,
          label: specificLabel(session.label),
          platform: session.platform,
          protocolUserId: null,
          tookOverAt: null,
        });
        regranted = true;
        return { status: "held" as const, ...withoutGranted(this.granted(subscription.id, limit, handle)) };
      }
      const current = [...live].sort((a, b) => b.since - a.since)[0];
      return {
        status: "displaced" as const,
        subscriptionId: subscription.id,
        limit,
        by: { handle: current.handle, label: specificLabel(current.label), platform: current.platform },
        at: new Date(current.since).toISOString(),
      };
    });
    if (regranted) await this.announce({ subscriptionId: subscription.id, sessionId: session.id, protocolUserId: null });
    return result;
  }

  /** Gives this device's slot back: on one subscription, or on all of the
   * customer's. What the app sends when the customer presses Disconnect.
   *
   * With `handle`, only the grant it names: the app sends the release
   * fire-and-forget and moves on, while the request can still be walking
   * the API's endpoints seconds later -- after a Connect pressed in the
   * meantime has claimed the slot again (under a new handle). Dropping
   * whatever this device held then would free the slot it is using, let
   * the next device in without a card, and tell this one at its next
   * renewal that it had been displaced. Without `handle`, as before. */
  async release(caller: SlotCaller, request: { subscriptionId?: string; handle?: string }): Promise<void> {
    if (!caller.sessionId) return;
    const sessionId = caller.sessionId;
    const mine = (id: string) => id === sessionId;
    if (request.subscriptionId) {
      const owned = await this.prisma.subscription.findFirst({
        where: { id: request.subscriptionId, customerId: caller.customerId },
        select: { id: true },
      });
      if (!owned) throw new NotFoundException("Subscription not found");
      await this.dropSessions(owned.id, mine, request.handle);
      return;
    }
    await this.forEachSubscription(caller.customerId, (id) => this.dropSessions(id, mine, request.handle));
  }

  /** A device's slots, on every subscription of its customer -- for
   * sign-out and for the device cap's eviction. Never throws: neither of
   * those may fail over a slot. */
  async releaseSession(customerId: string, sessionId: string): Promise<void> {
    await this.forEachSubscription(customerId, (id) => this.dropSessions(id, (s) => s === sessionId));
  }

  /** Every device's slots but `keep`'s -- for a password change, which
   * ends the other sessions. */
  async releaseOtherSessions(customerId: string, keep?: string): Promise<void> {
    await this.forEachSubscription(customerId, (id) => this.dropSessions(id, (s) => s !== keep));
  }

  /** Every slot on a subscription -- for a suspension or an expiry. */
  async releaseSubscription(subscriptionId: string): Promise<void> {
    try {
      await this.lock.run(subscriptionId, async () => {
        await this.store.del(slotsKey(subscriptionId));
        await this.store.del(displacedKey(subscriptionId));
      });
    } catch (err) {
      this.logger.warn(`Could not release the slots of subscription ${subscriptionId}: ${(err as Error).message}`);
    }
  }

  /** Every slot of every subscription of a customer -- for deleting the
   * account. */
  async releaseCustomer(customerId: string): Promise<void> {
    await this.forEachSubscription(customerId, (id) => this.releaseSubscription(id));
  }

  /** Called for every report of a subscription's devices carrying
   * traffic: keeps its slots from expiring while they are in use. A
   * holder that renews keeps them alive by itself; one that only carries
   * traffic -- the mobile apps do not renew in the background -- would
   * otherwise lose its slot SLOT_TTL_MS after its last renewal, however
   * busy its tunnel. Never throws. */
  async keepAlive(subscriptionId: string): Promise<void> {
    if (deviceSlotsMode() === "off") return;
    try {
      await this.store.expire(slotsKey(subscriptionId), SLOT_TTL_MS);
    } catch (err) {
      this.logger.warn(`Could not keep the slots of subscription ${subscriptionId}: ${(err as Error).message}`);
    }
  }

  /** For the backstop. Empty when slots are off. */
  async state(subscriptionId: string): Promise<SlotState> {
    const empty: SlotState = { holders: new Set(), live: new Set(), displaced: new Map(), credit: new Map() };
    if (deviceSlotsMode() === "off") return empty;
    const now = Date.now();
    const [all, displacedRaw] = await Promise.all([
      this.holders(subscriptionId),
      this.store.hgetall(displacedKey(subscriptionId)),
    ]);
    // A signed-out device protects nothing, and lends its credit to no
    // shared credential.
    const gone = await this.signedOut(all);
    const holders = all.filter((h) => !gone.has(h.sessionId));
    for (const h of holders) {
      empty.holders.add(deviceKeyOf(h.sessionId));
      if (now - h.lastRenew <= STALE_MS) empty.live.add(deviceKeyOf(h.sessionId));
      if (h.protocolUserId) empty.credit.set(h.protocolUserId, deviceKeyOf(h.sessionId));
    }
    for (const [sessionId, raw] of Object.entries(displacedRaw)) {
      const d = parse<Displacement>(raw);
      if (d) empty.displaced.set(deviceKeyOf(sessionId), { at: d.at, noGrace: d.noGrace });
    }
    return empty;
  }

  private async context(caller: SlotCaller, subscriptionId: string) {
    // The device first: a signed-out device is told so (401), and its app
    // signs out -- correct for a session that has ended, and the only 401
    // these endpoints ever give.
    let session: { id: string; label: string | null; platform: string | null } | null = null;
    if (caller.sessionId) {
      const row = await this.prisma.customerSession.findFirst({
        where: { id: caller.sessionId, customerId: caller.customerId },
        select: { id: true, revokedAt: true, label: true, platform: true },
      });
      if (!row || row.revokedAt) throw new UnauthorizedException("This device has been signed out");
      session = { id: row.id, label: row.label, platform: row.platform };
    }
    const row = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, customerId: caller.customerId },
      select: { id: true, status: true, plan: { select: { maxConcurrentConnections: true } } },
    });
    // Not found and not yours look the same, as everywhere else.
    if (!row) throw new NotFoundException("Subscription not found");
    return {
      session,
      subscription: { id: row.id, status: row.status as string, limit: row.plan?.maxConcurrentConnections ?? null },
    };
  }

  private async nameSession(sessionId: string, device: DeviceInfo) {
    const label = specificLabel(device.label);
    await this.prisma.customerSession
      .updateMany({
        where: { id: sessionId },
        data: {
          ...(label !== null ? { label } : {}),
          ...(device.platform !== null ? { platform: device.platform } : {}),
        },
      })
      .catch(() => undefined);
  }

  /** The id of a shared credential of this subscription, or null -- what
   * a claim may name to have that credential's traffic counted as its own. */
  private async sharedCredentialOf(subscriptionId: string, protocolUserId: string): Promise<string | null> {
    const row = await this.prisma.protocolUser.findFirst({
      where: { id: protocolUserId, subscriptionId, sessionId: null },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private async holders(subscriptionId: string): Promise<Holder[]> {
    const raw = await this.store.hgetall(slotsKey(subscriptionId));
    return Object.values(raw)
      .map((value) => parse<Holder>(value))
      .filter((h): h is Holder => h !== null && typeof h.sessionId === "string");
  }

  /** Which of these holders' devices are signed out: session revoked, or
   * gone. Sign-out frees a device's slots itself, but not every path that
   * ends sessions did (an admin setting a password, the hourly sweep),
   * and a release that fails leaves the slot behind; a signed-out device
   * must never be the one a refusal names. */
  private async signedOut(holders: Holder[]): Promise<Set<string>> {
    if (holders.length === 0) return new Set();
    const ids = holders.map((h) => h.sessionId);
    const rows = await this.prisma.customerSession.findMany({
      where: { id: { in: ids } },
      select: { id: true, revokedAt: true },
    });
    const live = new Set(rows.filter((r) => r.revokedAt === null).map((r) => r.id));
    return new Set(ids.filter((id) => !live.has(id)));
  }

  private async writeHolder(subscriptionId: string, holder: Holder) {
    await this.store.hset(slotsKey(subscriptionId), { [holder.sessionId]: JSON.stringify(holder) }, SLOT_TTL_MS);
  }

  private async displacement(subscriptionId: string, sessionId: string): Promise<Displacement | null> {
    const raw = (await this.store.hgetall(displacedKey(subscriptionId)))[sessionId];
    return raw ? parse<Displacement>(raw) : null;
  }

  /** When each holder was last renewed or seen carrying traffic. Presence
   * is only read when some holder has not renewed recently -- the common
   * case costs nothing. */
  private async lastSeen(subscriptionId: string, holders: Holder[], now: number): Promise<Map<string, number>> {
    const seen = new Map(holders.map((h) => [h.sessionId, h.lastRenew]));
    if (!holders.some((h) => now - h.lastRenew > STALE_MS)) return seen;

    const [entries, credentials] = await Promise.all([
      this.presence.entries(subscriptionId, STALE_MS, now),
      this.prisma.protocolUser.findMany({
        where: { subscriptionId },
        select: { id: true, routeId: true, sessionId: true, provisionedAt: true },
      }),
    ]);
    const credit = new Map<string, DeviceKey>();
    for (const h of holders) if (h.protocolUserId) credit.set(h.protocolUserId, deviceKeyOf(h.sessionId));
    const devices = resolveDevices(entries, credentials, credit);
    for (const h of holders) {
      const traffic = devices.get(deviceKeyOf(h.sessionId))?.lastSeen ?? 0;
      seen.set(h.sessionId, Math.max(h.lastRenew, traffic));
    }
    return seen;
  }

  private async countTakeover(subscriptionId: string, now: number) {
    const raw = (await this.store.hgetall(takeoversKey(subscriptionId))).times;
    const times = (parse<number[]>(raw ?? "[]") ?? []).filter((t) => now - t < TAKEOVER_WINDOW_MS);
    if (times.length >= TAKEOVERS_REFUSED_PAST) {
      this.logger.warn(`Subscription ${subscriptionId}: takeover refused, ${times.length} in the last hour`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "TAKEOVER_LIMIT",
          message: "Too many switches between devices in the last hour. Try again later.",
          retryAfterSec: Math.ceil((times[0] + TAKEOVER_WINDOW_MS - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    times.push(now);
    await this.store.hset(takeoversKey(subscriptionId), { times: JSON.stringify(times) }, TAKEOVER_WINDOW_MS);
    if (times.length > TAKEOVERS_LOGGED_PAST) {
      this.logger.warn(
        `Subscription ${subscriptionId}: ${times.length} device takeovers in the last hour ` +
          `(more than ${TAKEOVERS_LOGGED_PAST} -- two people sharing one slot?)`,
      );
    }
  }

  /** `handle`: drop nothing if a matching holder holds its slot under a
   * different, newer grant (see release). */
  private async dropSessions(subscriptionId: string, match: (sessionId: string) => boolean, handle?: string) {
    await this.lock.run(subscriptionId, async () => {
      const holders = await this.holders(subscriptionId);
      if (handle !== undefined && holders.some((h) => match(h.sessionId) && h.handle !== handle)) return;
      await this.store.hdel(slotsKey(subscriptionId), ...holders.map((h) => h.sessionId).filter(match));
      const displaced = Object.keys(await this.store.hgetall(displacedKey(subscriptionId)));
      await this.store.hdel(displacedKey(subscriptionId), ...displaced.filter(match));
    });
  }

  private async forEachSubscription(customerId: string, work: (subscriptionId: string) => Promise<void>) {
    try {
      const subscriptions = await this.prisma.subscription.findMany({ where: { customerId }, select: { id: true } });
      for (const s of subscriptions) await work(s.id);
    } catch (err) {
      this.logger.warn(`Could not release the slots of customer ${customerId}: ${(err as Error).message}`);
    }
  }

  private granted(subscriptionId: string, limit: number, handle: string): ClaimResult {
    return {
      granted: true,
      enforced: true,
      subscriptionId,
      limit,
      handle,
      renewEverySec: RENEW_EVERY_SEC,
      staleAfterSec: STALE_AFTER_SEC,
    };
  }

  private unenforced(subscriptionId: string, limit: number | null): ClaimResult {
    return {
      granted: true,
      enforced: false,
      subscriptionId,
      limit,
      handle: null,
      renewEverySec: RENEW_EVERY_SEC,
      staleAfterSec: STALE_AFTER_SEC,
    };
  }
}

function newHandle(): string {
  return randomBytes(9).toString("base64url");
}

function positive(limit: number | null): number | null {
  return limit !== null && limit > 0 ? limit : null;
}

function view(h: Holder, lastSeen: number): HolderView {
  return {
    handle: h.handle,
    label: specificLabel(h.label),
    platform: h.platform,
    since: new Date(h.since).toISOString(),
    lastSeen: new Date(lastSeen).toISOString(),
  };
}

function withoutGranted(result: ClaimResult): Omit<ClaimResult, "granted"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { granted, ...rest } = result;
  return rest;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
