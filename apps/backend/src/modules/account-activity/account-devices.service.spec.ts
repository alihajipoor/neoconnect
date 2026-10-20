/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { DeviceSlotsService } from "../device-slots/device-slots.service";
import { DeviceStateStore } from "../device-slots/device-state.store";
import { DevicePresence } from "../device-slots/device-presence";
import { AccountDevicesService } from "./account-devices.service";
import { deviceIdFor } from "./device-id";

/** The account's device list, over the real device-slot service on an
 * in-memory store and a stand-in Postgres that applies the filters the
 * service asks for. Pinned: only this customer's signed-in devices, this
 * one marked, nothing about them but what they said and what was
 * measured, "in use" only from a slot -- and signing another device out
 * the way it would sign itself out. */

const CUSTOMER = "customer-1";
const SUB = "11111111-1111-4111-8111-111111111111";
const SECRET = "test-access-secret";
const DAY = 86_400_000;
const NOW = new Date("2026-10-19T12:00:00Z").getTime();

interface SessionRow {
  id: string;
  customerId: string;
  label: string | null;
  platform: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  /** A column no response may carry; here to prove it does not leak. */
  channel: string | null;
}

type Where = {
  id?: string | { in: string[] };
  customerId?: string;
  revokedAt?: null;
  lastUsedAt?: { gte: Date };
};

function matches(row: SessionRow, where: Where): boolean {
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (where.id && typeof where.id === "object" && !where.id.in.includes(row.id)) return false;
  if (where.customerId !== undefined && row.customerId !== where.customerId) return false;
  if (where.revokedAt === null && row.revokedAt !== null) return false;
  if (where.lastUsedAt && row.lastUsedAt < where.lastUsedAt.gte) return false;
  return true;
}

function pick(row: SessionRow, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof SessionRow]]));
}

function build(opts: { limit?: number | null; refreshTtl?: string } = {}) {
  const session = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
    id,
    customerId: CUSTOMER,
    label: null,
    platform: null,
    createdAt: new Date(NOW - 20 * DAY),
    lastUsedAt: new Date(NOW - 60_000),
    revokedAt: null,
    channel: "RELAY",
    ...over,
  });
  const rows: SessionRow[] = [
    session("session-pc", { platform: "windows", label: "Windows PC", lastUsedAt: new Date(NOW - 5 * 60_000) }),
    session("session-phone", { platform: "android", label: "Android phone (Pixel 7)", lastUsedAt: new Date(NOW - 2 * 3_600_000) }),
    // Not refreshed for ten days: its refresh token (7d) has run out.
    session("session-old", { platform: "ios", lastUsedAt: new Date(NOW - 10 * DAY) }),
    session("session-signed-out", { platform: "macos", revokedAt: new Date(NOW - DAY) }),
    session("session-elsewhere", { customerId: "customer-2", platform: "windows" }),
  ];

  const subscription = { id: SUB, customerId: CUSTOMER, status: "ACTIVE", plan: { maxConcurrentConnections: opts.limit === undefined ? 1 : opts.limit } };
  const prisma = {
    customerSession: {
      findMany: jest.fn(async (args: { where: Where; select?: Record<string, boolean>; take?: number }) =>
        rows.filter((r) => matches(r, args.where)).map((r) => pick(r, args.select)),
      ),
      findFirst: jest.fn(async (args: { where: Where; select?: Record<string, boolean> }) => {
        const row = rows.find((r) => matches(r, args.where));
        return row ? pick(row, args.select) : null;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    subscription: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) =>
        where.id === SUB && where.customerId === CUSTOMER ? subscription : null,
      ),
      findMany: jest.fn(async ({ where }: { where: { customerId: string; status?: string } }) =>
        where.customerId === CUSTOMER && (!where.status || where.status === subscription.status) ? [subscription] : [],
      ),
    },
    protocolUser: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const config = {
    get: (key: string) =>
      ({ "customerJwt.accessSecret": SECRET, "customerJwt.refreshTtl": opts.refreshTtl ?? "7d" })[key],
  } as unknown as ConfigService;
  const store = DeviceStateStore.inMemory();
  const slots = new DeviceSlotsService(prisma as never, store, new DevicePresence(store));
  const auth = { revokeSession: jest.fn(async () => undefined) };
  const service = new AccountDevicesService(prisma as never, config, slots, auth as never);
  return { service, slots, auth, prisma, rows };
}

const idOf = (sessionId: string, customerId = CUSTOMER, secret = SECRET) => deviceIdFor(secret, customerId, sessionId);
const caller = (sessionId?: string) => ({ customerId: CUSTOMER, sessionId });

describe("AccountDevicesService", () => {
  const savedMode = process.env.DEVICE_SLOTS;
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (savedMode === undefined) delete process.env.DEVICE_SLOTS;
    else process.env.DEVICE_SLOTS = savedMode;
  });

  it("lists this customer's signed-in devices, this one first, with nothing but what they said and what was measured", async () => {
    const { service, prisma } = build();

    const list = await service.list(caller("session-phone"));

    expect(list).toEqual({
      inUseKnown: true,
      devices: [
        {
          id: idOf("session-phone"),
          thisDevice: true,
          // The model out of "Android phone (Pixel 7)"; the kind is the
          // reader's to name, from platform.
          label: "Pixel 7",
          platform: "android",
          signedInAt: new Date(NOW - 20 * DAY).toISOString(),
          lastSeenAt: new Date(NOW - 2 * 3_600_000).toISOString(),
          inUse: null,
        },
        {
          id: idOf("session-pc"),
          thisDevice: false,
          label: null,
          platform: "windows",
          signedInAt: new Date(NOW - 20 * DAY).toISOString(),
          lastSeenAt: new Date(NOW - 5 * 60_000).toISOString(),
          inUse: null,
        },
      ],
    });
    // Named columns only: nothing else about a session is even read.
    expect(prisma.customerSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: CUSTOMER, revokedAt: null }),
        select: { id: true, label: true, platform: true, createdAt: true, lastUsedAt: true },
      }),
    );
  });

  it("never hands out a session id", async () => {
    const { service } = build();
    const list = await service.list(caller("session-pc"));
    const body = JSON.stringify(list);
    for (const id of ["session-pc", "session-phone", "session-old"]) expect(body).not.toContain(id);
    expect(list.devices.every((d) => /^[A-Za-z0-9_-]{22}$/.test(d.id))).toBe(true);
  });

  it("names the same device by the same id on every call, and differently under another account", async () => {
    const { service } = build();
    const first = await service.list(caller("session-pc"));
    const second = await service.list(caller("session-pc"));
    expect(second.devices.map((d) => d.id)).toEqual(first.devices.map((d) => d.id));
    expect(idOf("session-pc", "customer-2")).not.toBe(idOf("session-pc"));
  });

  it("says which device is using the VPN, from the slot it holds", async () => {
    const { service, slots } = build();
    await slots.claim(caller("session-pc"), { subscriptionId: SUB }, { label: null, platform: "windows" });
    await jest.advanceTimersByTimeAsync(30_000);

    const list = await service.list(caller("session-phone"));

    expect(list.inUseKnown).toBe(true);
    const pc = list.devices.find((d) => d.platform === "windows");
    expect(pc?.inUse).toEqual({ since: new Date(NOW).toISOString(), lastSeen: new Date(NOW).toISOString() });
    // In use comes before merely signed in, after this device.
    expect(list.devices.map((d) => d.platform)).toEqual(["android", "windows"]);
    expect(list.devices.find((d) => d.platform === "android")?.inUse).toBeNull();
  });

  it("stops calling a device in use once it has neither renewed nor carried traffic for 90 s", async () => {
    const { service, slots } = build();
    await slots.claim(caller("session-pc"), { subscriptionId: SUB }, { label: null, platform: "windows" });
    await jest.advanceTimersByTimeAsync(91_000);

    const list = await service.list(caller("session-phone"));
    expect(list.devices.find((d) => d.platform === "windows")?.inUse).toBeNull();
  });

  it("leaves out a device whose refresh token has run out -- unless it is still using a slot", async () => {
    const { service, slots } = build({ limit: 2 });
    expect((await service.list(caller("session-pc"))).devices.map((d) => d.platform)).not.toContain("ios");

    await slots.claim(caller("session-old"), { subscriptionId: SUB });
    const list = await service.list(caller("session-pc"));
    expect(list.devices.find((d) => d.platform === "ios")).toMatchObject({ inUse: expect.any(Object) });
  });

  it("lists a session whose refresh lifetime cannot be read for as long as its row can live", async () => {
    const { service } = build({ refreshTtl: "forever" });
    const list = await service.list(caller("session-pc"));
    expect(list.devices.map((d) => d.platform)).toEqual(["windows", "android", "ios"]);
  });

  it("never lists a signed-out device or another customer's", async () => {
    const { service } = build();
    const list = await service.list(caller("session-pc"));
    expect(list.devices.map((d) => d.platform)).not.toContain("macos");
    expect(list.devices).toHaveLength(2);
  });

  it.each([
    ["an unlimited plan", { limit: null }, undefined],
    ["device slots switched off", {}, "off"],
  ])("says nothing about use on %s", async (_label, opts, mode) => {
    if (mode) process.env.DEVICE_SLOTS = mode;
    const { service, slots } = build(opts);
    await slots.claim(caller("session-pc"), { subscriptionId: SUB });

    const list = await service.list(caller("session-phone"));
    expect(list.inUseKnown).toBe(false);
    expect(list.devices.every((d) => d.inUse === null)).toBe(true);
  });

  describe("signing another device out", () => {
    it("ends that device's session the way its own sign-out would", async () => {
      const { service, auth } = build();
      await service.signOut(caller("session-pc"), idOf("session-phone"));
      expect(auth.revokeSession).toHaveBeenCalledWith(CUSTOMER, "session-phone");
    });

    it("refuses this device with 400 THIS_DEVICE -- that is the app's own sign-out", async () => {
      const { service, auth } = build();
      const err = await service.signOut(caller("session-pc"), idOf("session-pc")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: "THIS_DEVICE" });
      expect(auth.revokeSession).not.toHaveBeenCalled();
    });

    it.each([
      ["another customer's device", () => idOf("session-elsewhere", "customer-2")],
      ["this customer's id for another customer's session", () => idOf("session-elsewhere")],
      ["a device already signed out", () => idOf("session-signed-out")],
      ["an id made with another key", () => idOf("session-phone", CUSTOMER, "other-secret")],
      ["something that is not an id", () => "session-phone"],
    ])("answers 404 for %s, and signs nothing out", async (_label, id) => {
      const { service, auth } = build();
      await expect(service.signOut(caller("session-pc"), id())).rejects.toBeInstanceOf(NotFoundException);
      expect(auth.revokeSession).not.toHaveBeenCalled();
    });
  });
});
