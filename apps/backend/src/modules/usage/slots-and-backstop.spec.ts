/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { ConflictException, Logger } from "@nestjs/common";
import { ConcurrencyService } from "./concurrency.service";
import { DevicePresence } from "../device-slots/device-presence";
import { DeviceStateStore } from "../device-slots/device-state.store";
import { DeviceSlotsService } from "../device-slots/device-slots.service";

/** Device slots and the node-side backstop together, over one stand-in
 * database and one in-memory store -- the way they meet in production:
 * the backstop reads who holds a slot, and a grant has to undo what the
 * backstop did. Each service has its own spec; this one is for what only
 * shows when both run. Unit tests: nothing here has seen a node. */

const SUB = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "customer-1";
const PC = "pc";
const PHONE = "phone";

interface Row {
  id: string;
  nodeId: string;
  externalUserId: string;
  protocol: string;
  status: string;
  subscriptionId: string;
  sessionId: string | null;
  routeId: string;
  provisionedAt: Date | null;
  heldUntil: Date | null;
  protocolConfig: { transport: string; inboundTag: string | null };
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    nodeId: "node-1",
    externalUserId: `ext-${id}`,
    protocol: "XRAY_VLESS_REALITY",
    status: "ACTIVE",
    subscriptionId: SUB,
    sessionId: null,
    routeId: `route-${id}`,
    provisionedAt: new Date(0),
    heldUntil: null,
    protocolConfig: { transport: "TCP", inboundTag: null },
    ...over,
  };
}

function world(limit: number, rows: Row[]) {
  const matches = (r: Row, w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([key, value]) => {
      if (key === "externalUserId") return (value as { in: string[] }).in.includes(r.externalUserId);
      if (key === "id" && typeof value === "object" && value !== null) {
        const v = value as { in?: string[]; notIn?: string[] };
        return (v.in === undefined || v.in.includes(r.id)) && (v.notIn === undefined || !v.notIn.includes(r.id));
      }
      if (key === "heldUntil") return r.heldUntil !== null && r.heldUntil > (value as { gt: Date }).gt;
      return (r as unknown as Record<string, unknown>)[key] === value;
    });
  const sessions: Record<string, { revokedAt: Date | null; label: string | null; platform: string | null }> = {
    [PC]: { revokedAt: null, label: null, platform: "windows" },
    [PHONE]: { revokedAt: null, label: null, platform: "android" },
  };
  const subscription = { id: SUB, customerId: CUSTOMER, status: "ACTIVE", plan: { maxConcurrentConnections: limit } };
  const prisma = {
    customerSession: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
        sessions[where.id] ? { id: where.id, ...sessions[where.id] } : null,
      ),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => sessions[id]).map((id) => ({ id, revokedAt: sessions[id].revokedAt })),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    subscription: {
      findFirst: jest.fn(async () => subscription),
      findUnique: jest.fn(async () => subscription),
      findMany: jest.fn(async () => [{ id: SUB }]),
    },
    protocolUser: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: { heldUntil: Date | null } }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) r.heldUntil = data.heldUntil;
        return { count: hit.length };
      }),
    },
  };
  const store = DeviceStateStore.inMemory();
  const presence = new DevicePresence(store);
  const slots = new DeviceSlotsService(prisma as never, store, presence);
  const gateway = {
    enqueueCommand: jest.fn().mockResolvedValue({}),
    reassertCredentials: jest.fn().mockResolvedValue(undefined),
  };
  const backstop = new ConcurrencyService(prisma as never, gateway as never, presence, slots);
  return { prisma, slots, backstop, gateway, rows, sessions, store, presence };
}

type Seen = { ext: string; bytes?: number; sources?: number };

async function report(backstop: ConcurrencyService, nodeId: string, seen: Seen[]) {
  await backstop.handleReport(nodeId, {
    deltas: seen
      .filter((s) => s.bytes)
      .map((s) => ({ externalUserId: s.ext, protocol: "XRAY_VLESS_REALITY", bytesUp: String(s.bytes), bytesDown: "0" })),
    sessions: seen
      .filter((s) => s.sources)
      .map((s) => ({ externalUserId: s.ext, protocol: "XRAY_VLESS_REALITY", distinctSources: s.sources! })),
  });
}

const as = (sessionId: string) => ({ customerId: CUSTOMER, sessionId });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse() as { code: string; holders: { handle: string }[] };
  }
  throw new Error("expected the claim to be refused");
}

describe("device slots and the backstop together", () => {
  const saved = process.env.CONCURRENCY_CUT;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.CONCURRENCY_CUT;
    else process.env.CONCURRENCY_CUT = saved;
  });

  /** The mobile apps do not renew in the background; the contract says
   * traffic keeps the slot. A slot that expired a day after its last
   * renewal, under a phone whose tunnel was busy all along, let the PC in
   * with no refusal -- and then told the phone, the device in use first,
   * that it had been displaced. */
  it("keeps a slot for a day and more on traffic alone, so the second device is still refused", async () => {
    const { slots, backstop } = world(1, [row(PHONE, { sessionId: PHONE })]);
    await slots.claim(as(PHONE), { subscriptionId: SUB });

    // Twenty-six hours of an always-on tunnel and not one renewal
    // (reported every ten minutes here, to keep the test quick; nodes
    // report every thirty seconds).
    for (let t = 0; t < 26 * 6; t++) {
      await report(backstop, "node-1", [{ ext: `ext-${PHONE}`, bytes: 120 }]);
      await jest.advanceTimersByTimeAsync(10 * 60_000);
    }
    await report(backstop, "node-1", [{ ext: `ext-${PHONE}`, bytes: 120 }]);

    const body = await refusal(slots.claim(as(PC), { subscriptionId: SUB }));
    expect(body.code).toBe("DEVICE_LIMIT");
    await expect(slots.renew(as(PHONE), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
  });

  /** Holds the phone the backstop's way: the PC holds the slot, the
   * phone dialled without claiming (the API did not answer within 3 s),
   * and both carried traffic for three readings. */
  async function phoneHeldWhilePcHoldsTheSlot() {
    process.env.CONCURRENCY_CUT = "enforce";
    const w = world(1, [row(PC, { sessionId: PC }), row(PHONE, { sessionId: PHONE, nodeId: "node-2" })]);
    await w.slots.claim(as(PC), { subscriptionId: SUB });
    for (let i = 0; i < 4; i++) {
      await report(w.backstop, "node-1", [{ ext: `ext-${PC}`, bytes: 500 }]);
      await report(w.backstop, "node-2", [{ ext: `ext-${PHONE}`, bytes: 500 }]);
      await jest.advanceTimersByTimeAsync(30_000);
      await w.slots.renew(as(PC), { subscriptionId: SUB });
    }
    const phoneRow = w.rows.find((r) => r.id === PHONE)!;
    expect(phoneRow.heldUntil!.getTime()).toBeGreaterThan(Date.now());
    return { ...w, phoneRow, pcRow: w.rows.find((r) => r.id === PC)! };
  }

  /** The customer then taps "Use on this device instead" on the phone
   * whose API has come back. */
  async function phoneTakesOver(w: Awaited<ReturnType<typeof phoneHeldWhilePcHoldsTheSlot>>) {
    const { holders } = await refusal(w.slots.claim(as(PHONE), { subscriptionId: SUB }));
    return w.slots.claim(as(PHONE), { subscriptionId: SUB, takeover: [holders[0].handle] });
  }

  /** The hold outlived the grant: the device the customer had just
   * chosen stayed off its nodes, and the lease was renewed for as long as
   * the PC it displaced -- on a censored path, never hearing it was
   * displaced -- kept going. The PC was never held at all. */
  it("lifts the hold on a device the moment it is let in, and holds the device it displaced instead", async () => {
    const w = await phoneHeldWhilePcHoldsTheSlot();

    const granted = await phoneTakesOver(w);
    expect(granted.granted).toBe(true);

    // Lifted before the grant was answered, and put back on its node at
    // once: the app dials as soon as the grant arrives.
    expect(w.phoneRow.heldUntil).toBeNull();
    expect(w.gateway.reassertCredentials).toHaveBeenCalledWith([PHONE]);

    // Ten minutes: the phone in use and renewing, the PC still going.
    for (let i = 0; i < 20; i++) {
      await report(w.backstop, "node-1", [{ ext: `ext-${PC}`, bytes: 500 }]);
      await report(w.backstop, "node-2", [{ ext: `ext-${PHONE}`, bytes: 500 }]);
      await jest.advanceTimersByTimeAsync(30_000);
      if (i % 2 === 1) await w.slots.renew(as(PHONE), { subscriptionId: SUB });
    }

    expect(w.phoneRow.heldUntil === null || w.phoneRow.heldUntil.getTime() <= Date.now()).toBe(true);
    expect(w.pcRow.heldUntil!.getTime()).toBeGreaterThan(Date.now());
    const disabled = w.gateway.enqueueCommand.mock.calls
      .filter((c) => c[1] === "DISABLE_USER")
      .map((c) => (c[2] as { externalUserId: string }).externalUserId);
    expect(disabled).toEqual([`ext-${PHONE}`, `ext-${PC}`]);
    expect([...(await w.slots.state(SUB)).holders]).toEqual([`s:${PHONE}`]);
  });

  /** The phone holds the slot and renews, but its traffic does not show
   * (it is still dialling, or idle). The PC it displaced keeps going. By
   * traffic alone that is one device on a plan of one -- and it was, for
   * as long as the PC ran. */
  it("holds a displaced device that keeps going after its grace while the holder is quiet", async () => {
    const w = await phoneHeldWhilePcHoldsTheSlot();
    await phoneTakesOver(w);

    for (let i = 0; i < 12; i++) {
      await report(w.backstop, "node-1", [{ ext: `ext-${PC}`, bytes: 500 }]);
      await jest.advanceTimersByTimeAsync(30_000);
      if (i % 2 === 1) await w.slots.renew(as(PHONE), { subscriptionId: SUB });
    }

    expect(w.pcRow.heldUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  /** The other side of that rule: a quiet holder counts only against a
   * device it displaced. The PC holds the slot and goes quiet (crashed,
   * or the lid closed) while an old app on the phone -- one that never
   * claims -- connects. Nobody was displaced; nobody is held. */
  it("does not count a quiet holder against a device that was never displaced", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const w = world(1, [row(PC, { sessionId: PC }), row(PHONE, { sessionId: PHONE, nodeId: "node-2" })]);
    await w.slots.claim(as(PC), { subscriptionId: SUB });

    for (let i = 0; i < 8; i++) {
      await report(w.backstop, "node-2", [{ ext: `ext-${PHONE}`, bytes: 500 }]);
      await jest.advanceTimersByTimeAsync(30_000);
      if (i % 2 === 1) await w.slots.renew(as(PC), { subscriptionId: SUB });
    }

    expect(w.gateway.enqueueCommand).not.toHaveBeenCalled();
  });

  /** A hold can land between the backstop reading who holds a slot and
   * the claim that makes the device one. The next reading lifts it. */
  it("lifts, at its next reading, a hold that raced a device's claim", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const w = world(1, [row(PC, { sessionId: PC }), row(PHONE, { sessionId: PHONE, nodeId: "node-2" })]);
    await w.slots.claim(as(PHONE), { subscriptionId: SUB });
    const phoneRow = w.rows.find((r) => r.id === PHONE)!;
    phoneRow.heldUntil = new Date(Date.now() + 90_000);

    await report(w.backstop, "node-1", [{ ext: `ext-${PC}`, bytes: 500 }]);

    expect(phoneRow.heldUntil).toBeNull();
    expect(w.gateway.reassertCredentials).toHaveBeenCalledWith([PHONE]);
  });

  // And the housekeeping still happens: a subscription nobody uses lets
  // its slots go.
  it("still lets the slots of a subscription with no traffic and no renewals expire", async () => {
    const { slots, store } = world(1, [row(PHONE, { sessionId: PHONE })]);
    await slots.claim(as(PHONE), { subscriptionId: SUB });

    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1_000);

    expect(await store.hgetall(`slots:${SUB}`)).toEqual({});
  });
});
