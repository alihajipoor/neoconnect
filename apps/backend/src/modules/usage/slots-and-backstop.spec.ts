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

  // And the housekeeping still happens: a subscription nobody uses lets
  // its slots go.
  it("still lets the slots of a subscription with no traffic and no renewals expire", async () => {
    const { slots, store } = world(1, [row(PHONE, { sessionId: PHONE })]);
    await slots.claim(as(PHONE), { subscriptionId: SUB });

    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1_000);

    expect(await store.hgetall(`slots:${SUB}`)).toEqual({});
  });
});
