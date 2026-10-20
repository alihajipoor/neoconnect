import { BadRequestException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { DEVICE_PLATFORMS, specificLabel, type DevicePlatform } from "../../common/device-info";
import { DeviceSlotsService } from "../device-slots/device-slots.service";
import { CustomerAuthService } from "../customer-auth/customer-auth.service";
import { SESSION_IDLE_LIFETIME_MS } from "../customer-auth/session-lifetime";
import { deviceIdFor, isDeviceId } from "./device-id";
import { tokenLifetimeMs } from "./token-lifetime";

/** A customer is capped at 10 signed-in devices (docs/per-device-credentials.md);
 * this is a bound on the query, not a page anyone should reach. */
const MAX_LISTED = 50;

/** One signed-in device, as the account's device list shows it.
 *
 * Only what the device said about itself and what the server measured:
 * never an address, a node, a location or a session id. */
export interface DeviceView {
  /** Opaque; see device-id.ts. What DELETE /customer/devices/:id names. */
  id: string;
  /** The device asking. */
  thisDevice: boolean;
  /** A model or the user's own name for it ("Pixel 7"), or null -- the
   * reader names the kind from `platform`, in its own language. */
  label: string | null;
  platform: DevicePlatform | null;
  /** When this device signed in. */
  signedInAt: string;
  /** The last time the server heard from it: a token refresh, or, while
   * it holds a slot, a renewal or its tunnel's traffic. */
  lastSeenAt: string;
  /** Holding a device slot it is using now (renewed or carried traffic in
   * the last 90 s), or null. Null is not "not in use" -- see `inUseKnown`. */
  inUse: { since: string; lastSeen: string } | null;
}

export interface DeviceList {
  /** False when the server keeps no slots that could say which devices
   * are in use (an unlimited plan, no active plan, DEVICE_SLOTS=off): then
   * every `inUse` is null and means nothing. True does not make a null
   * `inUse` a "no" either -- an app from before slots connects without
   * one -- so a client says "In use now" for a device that has one, and
   * says nothing about the others. */
  inUseKnown: boolean;
  /** This device first, then the ones in use, then the most recently
   * seen. */
  devices: DeviceView[];
}

export interface DeviceCaller {
  customerId: string;
  /** The session the access token names; absent on tokens from before
   * sessions existed. */
  sessionId?: string;
}

/** The devices signed in to an account (A5 in the client work list):
 * their sessions, joined with which of them hold a device slot now.
 *
 * Signed in means a session that is not signed out and whose refresh
 * token can still work. A session nobody has refreshed for longer than a
 * refresh token lives is over for its device -- it has to sign in again
 * -- even though its row is kept for up to SESSION_IDLE_LIFETIME_MS; it
 * is listed only if it still holds a slot (a phone whose always-on tunnel
 * nobody opens the app on keeps using the VPN on its own credentials). */
@Injectable()
export class AccountDevicesService {
  private readonly logger = new Logger(AccountDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly slots: DeviceSlotsService,
    private readonly auth: CustomerAuthService,
  ) {}

  async list(caller: DeviceCaller): Promise<DeviceList> {
    const now = Date.now();
    const [rows, inUse] = await Promise.all([
      this.prisma.customerSession.findMany({
        where: {
          customerId: caller.customerId,
          revokedAt: null,
          lastUsedAt: { gte: new Date(now - SESSION_IDLE_LIFETIME_MS) },
        },
        // Named columns: nothing else about a session leaves.
        select: { id: true, label: true, platform: true, createdAt: true, lastUsedAt: true },
        orderBy: { lastUsedAt: "desc" },
        take: MAX_LISTED,
      }),
      this.slots.inUse(caller.customerId),
    ]);

    const refreshCutoff = now - this.refreshLifetimeMs();
    const devices = rows
      .filter(
        (row) =>
          row.id === caller.sessionId || inUse.sessions.has(row.id) || row.lastUsedAt.getTime() >= refreshCutoff,
      )
      .map((row): DeviceView => {
        const slot = inUse.sessions.get(row.id);
        const lastSeen = Math.max(row.lastUsedAt.getTime(), slot?.lastSeen ?? 0);
        return {
          id: this.idOf(caller.customerId, row.id),
          thisDevice: row.id === caller.sessionId,
          label: specificLabel(row.label),
          platform: platformOf(row.platform),
          signedInAt: row.createdAt.toISOString(),
          lastSeenAt: new Date(lastSeen).toISOString(),
          inUse: slot ? { since: new Date(slot.since).toISOString(), lastSeen: new Date(slot.lastSeen).toISOString() } : null,
        };
      })
      .sort(
        (a, b) =>
          Number(b.thisDevice) - Number(a.thisDevice) ||
          Number(b.inUse !== null) - Number(a.inUse !== null) ||
          b.lastSeenAt.localeCompare(a.lastSeenAt),
      );

    return { inUseKnown: inUse.known, devices };
  }

  /** Signs another of the customer's devices out, exactly as that device
   * signing itself out would: its session revoked, its own VPN credentials
   * taken off the nodes, its slot freed (CustomerAuthService.revokeSession).
   * Its next refresh is refused, and the app signs out. A tunnel on its
   * own credentials stops once the nodes have dropped them; one on the
   * subscription's shared credentials (an app from before per-device
   * credentials) is not ended by this.
   *
   * Not this device: that is `POST /customer-auth/logout`, which the app
   * already runs with its own teardown. An id that is not one of this
   * customer's signed-in devices is a 404, the same as one that never
   * existed. */
  async signOut(caller: DeviceCaller, id: string): Promise<void> {
    if (!isDeviceId(id)) throw new NotFoundException("Device not found");
    const rows = await this.prisma.customerSession.findMany({
      where: { customerId: caller.customerId, revokedAt: null },
      select: { id: true },
    });
    const target = rows.find((row) => this.idOf(caller.customerId, row.id) === id);
    if (!target) throw new NotFoundException("Device not found");
    if (target.id === caller.sessionId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: "THIS_DEVICE",
        message: "This is the device you are using. Sign out from its own menu instead.",
      });
    }
    await this.auth.revokeSession(caller.customerId, target.id);
    this.logger.log(
      `Customer ${caller.customerId}: session ${target.id} signed out from session ${caller.sessionId ?? "(none)"}`,
    );
  }

  private idOf(customerId: string, sessionId: string): string {
    return deviceIdFor(this.config.get<string>("customerJwt.accessSecret") ?? "", customerId, sessionId);
  }

  private refreshLifetimeMs(): number {
    const lifetime = tokenLifetimeMs(this.config.get<string>("customerJwt.refreshTtl"));
    return lifetime === null ? SESSION_IDLE_LIFETIME_MS : Math.min(lifetime, SESSION_IDLE_LIFETIME_MS);
  }
}

function platformOf(value: string | null): DevicePlatform | null {
  return (DEVICE_PLATFORMS as readonly string[]).includes(value ?? "") ? (value as DevicePlatform) : null;
}
