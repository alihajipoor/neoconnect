/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { Logger } from "@nestjs/common";
import { ConcurrencyService, HOLD_LEASE_MS } from "./concurrency.service";
import { DevicePresence, resolveDevices, type PresenceEntry } from "../device-slots/device-presence";
import { DeviceStateStore } from "../device-slots/device-state.store";
import type { SlotState } from "../device-slots/device-slots.service";

/** The plan's device limit, judged per device on what nodes report.
 *
 * The expensive mistake here is a false positive -- holding a customer
 * who is only switching from the PC to the phone, or one device that
 * happens to use several routes at once -- so most of what is pinned
 * down is when it must NOT act. Nothing here has run against a node. */

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

const PC = "session-pc";
const PHONE = "session-phone";

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    nodeId: "node-1",
    externalUserId: `ext-${id}`,
    protocol: "XRAY_VLESS_REALITY",
    status: "ACTIVE",
    subscriptionId: "sub-1",
    sessionId: null,
    routeId: `route-${id}`,
    provisionedAt: new Date(0),
    heldUntil: null,
    protocolConfig: { transport: "TCP", inboundTag: null },
    ...over,
  };
}

function build(opts: {
  limit: number | null;
  rows: Row[];
  subscriptionStatus?: string;
  slots?: Partial<SlotState>;
}) {
  const rows = opts.rows;
  const where = (r: Row, w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([key, value]) => {
      if (key === "externalUserId") return (value as { in: string[] }).in.includes(r.externalUserId);
      if (key === "id") return (value as { in: string[] }).in.includes(r.id);
      if (key === "heldUntil") return r.heldUntil !== null && r.heldUntil > (value as { gt: Date }).gt;
      return (r as unknown as Record<string, unknown>)[key] === value;
    });

  const prisma = {
    protocolUser: {
      findMany: jest.fn(async ({ where: w }: { where: Record<string, unknown> }) =>
        rows.filter((r) => where(r, w)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where: w, data }: { where: Record<string, unknown>; data: { heldUntil: Date } }) => {
        const hit = rows.filter((r) => where(r, w));
        for (const r of hit) r.heldUntil = data.heldUntil;
        return { count: hit.length };
      }),
    },
    subscription: {
      findUnique: jest.fn(async () => ({
        status: opts.subscriptionStatus ?? "ACTIVE",
        plan: { maxConcurrentConnections: opts.limit },
      })),
    },
  };
  const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue({}) };
  // Who holds a device slot, as DeviceSlotsService.state reports it.
  const slotState: SlotState = {
    holders: opts.slots?.holders ?? new Set(),
    displaced: opts.slots?.displaced ?? new Map(),
    credit: opts.slots?.credit ?? new Map(),
  };
  const slots = { state: jest.fn(async () => slotState), keepAlive: jest.fn(async () => undefined) };
  const service = new ConcurrencyService(
    prisma as never,
    agentGateway as never,
    new DevicePresence(DeviceStateStore.inMemory()),
    slots as never,
  );
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  return { service, prisma, agentGateway, rows, warn };
}

/** What a node reports in one cycle: bytes for some credentials, session
 * counts for others. */
type Seen = { ext: string; bytes?: number; sources?: number; protocol?: string };

async function cycle(service: ConcurrencyService, nodeId: string, seen: Seen[]) {
  await service.handleReport(nodeId, {
    deltas: seen
      .filter((s) => s.bytes !== undefined)
      .map((s) => ({ externalUserId: s.ext, protocol: s.protocol ?? "XRAY_VLESS_REALITY", bytesUp: String(s.bytes), bytesDown: "0" })),
    sessions: seen
      .filter((s) => s.sources !== undefined)
      .map((s) => ({ externalUserId: s.ext, protocol: s.protocol ?? "XRAY_VLESS_REALITY", distinctSources: s.sources! })),
  });
}

/** One report from each node, then the ~30 s until the next. */
async function tick(service: ConcurrencyService, perNode: Record<string, Seen[]>) {
  for (const [node, seen] of Object.entries(perNode)) await cycle(service, node, seen);
  await jest.advanceTimersByTimeAsync(30_000);
}

const commands = (gw: { enqueueCommand: jest.Mock }, type: string) =>
  gw.enqueueCommand.mock.calls.filter((c) => c[1] === type);
const shadowLines = (warn: jest.SpyInstance) =>
  warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("[shadow]"));

describe("ConcurrencyService (device-limit backstop)", () => {
  const savedMode = process.env.CONCURRENCY_CUT;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (savedMode === undefined) delete process.env.CONCURRENCY_CUT;
    else process.env.CONCURRENCY_CUT = savedMode;
  });

  /** A PC and a phone, each with its own credential. */
  const twoDevices = () => [row("pc", { sessionId: PC }), row("phone", { sessionId: PHONE, nodeId: "node-2" })];

  it("does nothing while the devices in use are within the limit", async () => {
    const { service, agentGateway, warn } = build({ limit: 2, rows: twoDevices() });

    for (let i = 0; i < 6; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 500 }], "node-2": [{ ext: "ext-phone", bytes: 500 }] });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    expect(shadowLines(warn)).toHaveLength(0);
  });

  /** Every Xray inbound on a node has its own counter on the same access
   * log, so one phone on REALITY was reported five times -- and summed to
   * five, over Starter's, Pro's and Trial's limits alike. */
  it("counts one device once however many Xray inbounds report it", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway, warn } = build({ limit: 1, rows: [row("phone", { sessionId: PHONE })] });
    const fiveCounters = ["XRAY_VLESS_REALITY", "XRAY_TROJAN", "XRAY_VLESS_TLS", "XRAY_VLESS_TLS", "SHADOWSOCKS"].map(
      (protocol) => ({ ext: "ext-phone", sources: 1, protocol }),
    );

    for (let i = 0; i < 6; i++) await tick(service, { "node-1": fiveCounters });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  /** Concurrent exits: one PC on several routes, on several nodes, at
   * once. Summing per credential made it several devices on its own. */
  it("counts every credential of one device as that one device, across routes and nodes", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: [
        row("pc-fi", { sessionId: PC }),
        row("pc-fr", { sessionId: PC, nodeId: "node-2" }),
        row("pc-wg", { sessionId: PC, nodeId: "node-2", protocol: "WIREGUARD" }),
      ],
    });

    for (let i = 0; i < 6; i++) {
      await tick(service, {
        "node-1": [{ ext: "ext-pc-fi", bytes: 10 }],
        "node-2": [
          { ext: "ext-pc-fr", bytes: 10 },
          { ext: "ext-pc-wg", bytes: 10, protocol: "WIREGUARD" },
        ],
      });
    }

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  // The PC disconnects and the phone connects. For one report both look
  // active; that must not be enough -- and nor may the PC's Xray session
  // count, which goes on counting it for 60 s after its last connection.
  // That tail is what this test used to leave out: with it, the PC read
  // as active at 30, 60 and 90 s, three strikes, and the phone -- the
  // newer device, the one the customer had just switched to -- was held.
  it("does not act on a clean switch from the PC to the phone, Xray's session-count tail included", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway, warn } = build({ limit: 1, rows: twoDevices() });

    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 900, sources: 1 }] });
    // t=30: the PC opened a connection at 20 s and left at 25 s; the
    // phone is on.
    await tick(service, {
      "node-1": [{ ext: "ext-pc", bytes: 40, sources: 1 }],
      "node-2": [{ ext: "ext-phone", bytes: 900, sources: 1 }],
    });
    // t=60 and t=90: no bytes from the PC, but Xray still counts its
    // source from 20 s.
    for (let i = 0; i < 2; i++) {
      await tick(service, {
        "node-1": [{ ext: "ext-pc", sources: 1 }],
        "node-2": [{ ext: "ext-phone", bytes: 900, sources: 1 }],
      });
    }
    for (let i = 0; i < 6; i++) await tick(service, { "node-1": [], "node-2": [{ ext: "ext-phone", bytes: 900, sources: 1 }] });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  /** OpenVPN's count is the connections open right now: no tail, so it
   * still counts. A connected OpenVPN client moves bytes anyway; this
   * pins down that the count alone is enough. */
  it("still counts a device from an engine whose session count has no tail", async () => {
    const { service, warn } = build({
      limit: 1,
      rows: [row("pc", { sessionId: PC }), row("phone", { sessionId: PHONE, nodeId: "node-2", protocol: "OPENVPN" })],
    });

    for (let i = 0; i < 4; i++) {
      await tick(service, {
        "node-1": [{ ext: "ext-pc", bytes: 500 }],
        "node-2": [{ ext: "ext-phone", sources: 1, protocol: "OPENVPN" }],
      });
    }

    expect(shadowLines(warn)).toHaveLength(1);
  });

  /** WireGuard counts a peer for three minutes after its last handshake,
   * so its session count read a switch as two devices for three minutes.
   * Its keepalive bytes are used instead. */
  it("ignores WireGuard's session count and goes by its bytes", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: [row("pc", { sessionId: PC, protocol: "WIREGUARD" }), row("phone", { sessionId: PHONE, nodeId: "node-2" })],
    });

    // The PC left; its peer is still "counted" by the handshake tail.
    for (let i = 0; i < 6; i++) {
      await tick(service, {
        "node-1": [{ ext: "ext-pc", sources: 1, protocol: "WIREGUARD" }],
        "node-2": [{ ext: "ext-phone", bytes: 500 }],
      });
    }

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("ignores credentials already switched off, ids it does not know, and empty deltas", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: [row("pc", { sessionId: PC }), row("phone", { sessionId: PHONE, status: "DISABLED" })],
    });

    for (let i = 0; i < 6; i++) {
      await tick(service, {
        "node-1": [
          { ext: "ext-pc", bytes: 10 },
          { ext: "ext-phone", bytes: 10 },
          { ext: "route:uplink", bytes: 10 },
          { ext: "ext-nobody", bytes: 0 },
        ],
      });
    }

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("treats an unset limit as unlimited, not as zero", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({ limit: null, rows: twoDevices() });

    for (let i = 0; i < 6; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  // The coordinator's decision: watch first. A misjudgement here
  // disconnects a paying customer, and this has never run against a node.
  it("in shadow mode -- the default -- logs which device it would hold and sends nothing", async () => {
    delete process.env.CONCURRENCY_CUT;
    const { service, agentGateway, prisma, warn } = build({ limit: 1, rows: twoDevices() });

    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }] });
    for (let i = 0; i < 4; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    expect(prisma.protocolUser.updateMany).not.toHaveBeenCalled();
    const lines = shadowLines(warn);
    expect(lines).toHaveLength(1);
    // The phone came second, so it is the one that would be held.
    expect(lines[0]).toContain(`would hold device ${PHONE}`);
  });

  it("in shadow mode logs a subscription persistently over its limit only now and then", async () => {
    const { service, warn } = build({ limit: 1, rows: twoDevices() });

    for (let i = 0; i < 20; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(shadowLines(warn)).toHaveLength(1);
  });

  /** The owner's rule: the device already in use keeps working. The cut
   * this replaces disconnected every credential of the subscription. */
  it("when enforcing, holds only the newest device, on its own inbound, and leaves the first one alone", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const rows = twoDevices();
    rows[1].protocolConfig = { transport: "WS", inboundTag: "vless-ws-in-fr" };
    const { service, agentGateway } = build({ limit: 1, rows });

    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }] });
    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(commands(agentGateway, "DISABLE_USER").map((c) => [c[0], c[2]])).toEqual([
      ["node-2", { protocol: "XRAY_VLESS_REALITY", transport: "WS", inboundTag: "vless-ws-in-fr", externalUserId: "ext-phone" }],
    ]);
    expect(rows[1].heldUntil).toBeInstanceOf(Date);
    expect(rows[0].heldUntil).toBeNull();
  });

  /** Shared credentials cannot be told why, and are the likeliest copy. */
  it("when enforcing, holds the shared credentials before a signed-in device", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    // The phone holds its own confirmed credential on the shared row's
    // route, so the shared traffic cannot be the phone's (resolveDevices).
    const rows = [row("shared"), row("phone", { sessionId: PHONE, nodeId: "node-2", routeId: "route-shared" })];
    const { service, agentGateway } = build({ limit: 1, rows });

    // The phone is the newer one here; the shared copy is still first.
    await tick(service, { "node-1": [{ ext: "ext-shared", bytes: 1 }] });
    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-shared", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(commands(agentGateway, "DISABLE_USER").map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
      "ext-shared",
    ]);
  });

  /** The hold is a lease, not a timer: kept while the other device leaves
   * no room, lapsing by itself once it does -- and then the re-assert,
   * which reads the rows as they are at that moment, brings the device
   * back. Nothing here ever replays a captured list. */
  it("keeps a hold while the device in use fills the limit, and lets it lapse when that device goes quiet", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const rows = twoDevices();
    const { service, agentGateway } = build({ limit: 1, rows });

    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }] });
    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });
    expect(rows[1].heldUntil).not.toBeNull();

    // Five minutes of the PC in use: the hold is renewed throughout.
    for (let i = 0; i < 10; i++) {
      await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }] });
      expect(rows[1].heldUntil!.getTime()).toBeGreaterThan(Date.now());
    }

    // The PC goes quiet; nothing renews the hold and it lapses.
    await jest.advanceTimersByTimeAsync(HOLD_LEASE_MS + 1_000);
    expect(rows[1].heldUntil!.getTime()).toBeLessThan(Date.now());
    expect(commands(agentGateway, "ENABLE_USER")).toHaveLength(0);
    expect(commands(agentGateway, "DISABLE_USER")).toHaveLength(1);
  });

  /** A device holding a slot asked first and was let in. Node-side
   * miscounting must never cut it -- or a single-device customer, or a
   * pair taking turns through the app. */
  it("never holds a device that holds a slot, even when it is the newer one", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: twoDevices(),
      slots: { holders: new Set([`s:${PHONE}` as const]) },
    });

    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }] });
    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(commands(agentGateway, "DISABLE_USER").map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
      "ext-pc",
    ]);
  });

  it("holds nobody when every device over the limit holds a slot", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: twoDevices(),
      slots: { holders: new Set([`s:${PC}` as const, `s:${PHONE}` as const]) },
    });

    for (let i = 0; i < 6; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  /** The phone took the slot over. The PC learns it on its next renewal
   * and disconnects by itself; it gets that long before it is held. */
  it("gives a device whose slot was taken over a grace period, then holds it first", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const displacedAt = Date.now();
    const { service, agentGateway } = build({
      limit: 1,
      rows: twoDevices(),
      slots: {
        holders: new Set([`s:${PHONE}` as const]),
        displaced: new Map([[`s:${PC}` as const, { at: displacedAt, noGrace: false }]]),
      },
    });

    // Three readings in, still inside the 90 s grace: nothing yet.
    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();

    // Still going after the grace: held.
    await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });
    expect(commands(agentGateway, "DISABLE_USER").map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
      "ext-pc",
    ]);
  });

  // Two devices taking the slot back and forth to ride the grace periods.
  it("gives no grace to a device that had itself just taken the slot over", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const { service, agentGateway } = build({
      limit: 1,
      rows: twoDevices(),
      slots: {
        holders: new Set([`s:${PHONE}` as const]),
        displaced: new Map([[`s:${PC}` as const, { at: Date.now(), noGrace: true }]]),
      },
    });

    for (let i = 0; i < 3; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(commands(agentGateway, "DISABLE_USER")).toHaveLength(1);
  });

  /** A device connecting with a shared credential (its own not yet
   * confirmed by the node) names it in its claim; that credential's
   * traffic is then that device's, not folded into the other device. */
  it("counts a shared credential a slot holder named as that holder's device", async () => {
    process.env.CONCURRENCY_CUT = "enforce";
    const rows = [row("pc", { sessionId: PC }), row("shared", { nodeId: "node-2" })];
    const { service, agentGateway } = build({
      limit: 1,
      rows,
      slots: { holders: new Set([`s:${PHONE}` as const]), credit: new Map([["shared", `s:${PHONE}` as const]]) },
    });

    for (let i = 0; i < 4; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-shared", bytes: 1 }] });

    expect(commands(agentGateway, "DISABLE_USER").map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
      "ext-pc",
    ]);
  });

  it("counts a subscription across nodes, not one node at a time", async () => {
    const { service, warn } = build({ limit: 1, rows: twoDevices() });

    for (let i = 0; i < 4; i++) await tick(service, { "node-1": [{ ext: "ext-pc", bytes: 1 }], "node-2": [{ ext: "ext-phone", bytes: 1 }] });

    expect(shadowLines(warn)).toHaveLength(1);
  });

  // Several nodes answering in the same cycle are one reading, not three.
  it("counts one polling cycle once however many nodes report it", async () => {
    const { service, warn } = build({
      limit: 1,
      rows: [
        row("pc", { sessionId: PC }),
        row("phone", { sessionId: PHONE }),
      ],
    });

    for (const node of ["node-1", "node-1", "node-1", "node-1"]) {
      await cycle(service, node, [{ ext: "ext-pc", bytes: 1 }, { ext: "ext-phone", bytes: 1 }]);
    }

    expect(shadowLines(warn)).toHaveLength(0);
  });

  // It runs inside the agent's stream handler, where a throw closes the
  // node's control stream.
  it("never throws, whatever fails underneath", async () => {
    const { service, prisma } = build({ limit: 1, rows: twoDevices() });
    prisma.protocolUser.findMany.mockRejectedValue(new Error("database went away"));

    await expect(
      service.handleReport("node-1", { deltas: [{ externalUserId: "ext-pc", protocol: "X", bytesUp: "1", bytesDown: "0" }] }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveDevices", () => {
  const entry = (protocolUserId: string, deviceKey: PresenceEntry["deviceKey"], firstSeen = 0): PresenceEntry => ({
    protocolUserId,
    deviceKey,
    nodeId: "node-1",
    firstSeen,
    lastSeen: firstSeen + 1,
  });

  it("counts a device's credentials as one device", () => {
    const devices = resolveDevices(
      [entry("a", `s:${PC}`), entry("b", `s:${PC}`, 5)],
      [
        { id: "a", routeId: "r1", sessionId: PC, provisionedAt: new Date() },
        { id: "b", routeId: "r2", sessionId: PC, provisionedAt: new Date() },
      ],
    );
    expect([...devices.keys()]).toEqual([`s:${PC}`]);
    expect(devices.get(`s:${PC}`)).toEqual({ firstSeen: 0, lastSeen: 6 });
  });

  /** A device is handed the shared credential on a route where its own is
   * not confirmed yet, so in the transition one PC can be on its own
   * credential for one route and the shared one for another at once. */
  it("folds shared traffic into a device that would have been handed it", () => {
    const devices = resolveDevices(
      [entry("own-r1", `s:${PC}`), entry("shared-r2", "shared")],
      [
        { id: "own-r1", routeId: "r1", sessionId: PC, provisionedAt: new Date() },
        { id: "own-r2", routeId: "r2", sessionId: PC, provisionedAt: null },
        { id: "shared-r2", routeId: "r2", sessionId: null, provisionedAt: null },
      ],
    );
    expect([...devices.keys()]).toEqual([`s:${PC}`]);
  });

  it("keeps shared traffic as a device of its own when every active device has its own credential there", () => {
    const devices = resolveDevices(
      [entry("own-r1", `s:${PC}`), entry("shared-r1", "shared")],
      [
        { id: "own-r1", routeId: "r1", sessionId: PC, provisionedAt: new Date() },
        { id: "shared-r1", routeId: "r1", sessionId: null, provisionedAt: null },
      ],
    );
    expect([...devices.keys()].sort()).toEqual([`s:${PC}`, "shared"].sort());
  });
});

describe("DevicePresence", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps when a run of activity began across reports, and restarts it after a long gap", async () => {
    const presence = new DevicePresence(DeviceStateStore.inMemory());
    const start = Date.now();
    const seen = [{ protocolUserId: "a", deviceKey: `s:${PC}` as const, nodeId: "node-1" }];

    await presence.record("sub-1", seen, start);
    await presence.record("sub-1", seen, start + 30_000);
    expect((await presence.entries("sub-1", 45_000, start + 30_000))[0].firstSeen).toBe(start);

    await presence.record("sub-1", seen, start + 30_000 + 6 * 60_000);
    expect((await presence.entries("sub-1", 45_000, start + 30_000 + 6 * 60_000))[0].firstSeen).toBe(
      start + 30_000 + 6 * 60_000,
    );
  });

  it("returns only what was seen within the window asked for", async () => {
    const presence = new DevicePresence(DeviceStateStore.inMemory());
    const now = Date.now();
    await presence.record("sub-1", [{ protocolUserId: "old", deviceKey: "shared", nodeId: "n" }], now - 60_000);
    await presence.record("sub-1", [{ protocolUserId: "new", deviceKey: "shared", nodeId: "n" }], now);

    expect((await presence.entries("sub-1", 45_000, now)).map((e) => e.protocolUserId)).toEqual(["new"]);
  });

  // Counted forever is the failure to avoid: one bad write would hold a
  // customer over their limit permanently.
  it("forgets a malformed entry instead of counting it", async () => {
    const store = DeviceStateStore.inMemory();
    await store.hset("presence:sub-1", { broken: "not-an-entry" }, 60_000);
    const presence = new DevicePresence(store);

    expect(await presence.entries("sub-1", 45_000)).toEqual([]);
    expect(await store.hgetall("presence:sub-1")).toEqual({});
  });
});
