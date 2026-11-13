/* eslint-disable @typescript-eslint/require-await -- the in-memory Prisma
   stand-in answers asynchronously, like the real client. */
import { ProtocolUsersService, WG_RELEASE_PER_RUN, wgExpiredReleaseDays, wgExpiredReleaseMode } from "./protocol-users.service";
import { deviceSlotsStub } from "../../../test/device-slots-stub";
import { encryptCredentials } from "./credentials-crypto";

/** WG_EXPIRED_RELEASE (docs/device-slots.md): the WireGuard rows of
 * long-expired subscriptions are deleted so their addresses return to the
 * pool -- and nothing else is. What a later renewal then does is proven
 * against Postgres in expired-wireguard-release.db.spec.ts. */

const NOW = new Date("2026-11-13T12:00:00Z");
const DAY = 86_400_000;

interface Sub {
  id: string;
  status: string;
  expireAt: Date;
  autoRenew: boolean;
}
interface Row {
  id: string;
  subscriptionId: string;
  nodeId: string;
  protocol: string;
  sessionId: string | null;
}

function world(subs: Sub[], rows: Row[]) {
  const subOf = (id: string) => subs.find((s) => s.id === id)!;
  const matches = (row: Row, where: Record<string, any>) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.protocol !== undefined && row.protocol !== where.protocol) return false;
    if (where.node?.status?.not !== undefined && nodeStatus(row.nodeId) === where.node.status.not) return false;
    const s = where.subscription;
    if (s) {
      const sub = subOf(row.subscriptionId);
      if (s.status !== undefined && sub.status !== s.status) return false;
      if (s.autoRenew !== undefined && sub.autoRenew !== s.autoRenew) return false;
      if (s.expireAt?.lt && !(sub.expireAt.getTime() < (s.expireAt.lt as Date).getTime())) return false;
    }
    return true;
  };
  const nodeStatus = (id: string) => (id === "node-retired" ? "DISABLED" : "ONLINE");
  const nodeName = (id: string) => ({ "node-a": "alpha-1", "node-b": "beta-1" })[id] ?? id;
  const prisma = {
    protocolUser: {
      findMany: jest.fn(async ({ where, take }: { where: Record<string, any>; take?: number }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take ?? Infinity)
          .map((r) => ({
            ...r,
            externalUserId: `key-${r.id}`,
            credentialsJson: encryptCredentials({ address: "10.0.0.2/32" }),
            node: { name: nodeName(r.nodeId) },
            protocolConfig: { transport: null, inboundTag: null },
          })),
      ),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, any> }) => {
        const gone = rows.filter((r) => matches(r, where));
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return { count: gone.length };
      }),
    },
  };
  const commands: { nodeId: string; type: string; payload: Record<string, unknown> }[] = [];
  const agentGateway = {
    enqueueCommand: jest.fn(async (nodeId: string, type: string, payload: Record<string, unknown>) => {
      commands.push({ nodeId, type, payload });
    }),
  };
  const service = new ProtocolUsersService(prisma as never, agentGateway as never, deviceSlotsStub() as never);
  return { service, prisma, rows, subs, commands, agentGateway };
}

const sub = (id: string, status: string, expiredDaysAgo: number, autoRenew = false): Sub => ({
  id,
  status,
  expireAt: new Date(NOW.getTime() - expiredDaysAgo * DAY),
  autoRenew,
});
const row = (id: string, subscriptionId: string, protocol = "WIREGUARD", nodeId = "node-a", sessionId: string | null = null): Row => ({
  id,
  subscriptionId,
  nodeId,
  protocol,
  sessionId,
});

/** One of everything the rule must leave alone, and two rows it takes. */
function fleet() {
  return world(
    [
      sub("lapsed", "EXPIRED", 10),
      sub("recent", "EXPIRED", 3),
      sub("renewing", "EXPIRED", 10, true),
      sub("capped", "SUSPENDED", 30),
      sub("live", "ACTIVE", -20),
    ],
    [
      row("w-shared", "lapsed"),
      row("w-device", "lapsed", "WIREGUARD", "node-b", "session-1"),
      row("x-lapsed", "lapsed", "XRAY_VLESS_REALITY"),
      row("o-lapsed", "lapsed", "OPENVPN"),
      row("w-recent", "recent"),
      row("w-renewing", "renewing"),
      row("w-capped", "capped"),
      row("w-live", "live"),
    ],
  );
}

describe("ProtocolUsersService.releaseExpiredWireGuard", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("does nothing at all while off, the default", async () => {
    delete process.env.WG_EXPIRED_RELEASE;
    const { service, prisma, rows } = fleet();
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ mode: "off", released: 0 });
    expect(prisma.protocolUser.findMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(8);
  });

  it("in dry mode counts per server and deletes nothing", async () => {
    process.env.WG_EXPIRED_RELEASE = "dry";
    const { service, prisma, rows, commands } = fleet();
    const log = jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, "log");
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ mode: "dry", matched: 2, released: 0 });
    expect(prisma.protocolUser.deleteMany).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
    expect(rows).toHaveLength(8);
    expect(log.mock.calls[0][0]).toContain("alpha-1 1, beta-1 1");
  });

  it("when on, releases only the WireGuard rows, shared and device, of subscriptions expired past the window", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const { service, rows, commands } = fleet();
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ mode: "on", matched: 2, released: 2, failed: 0 });
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["o-lapsed", "w-capped", "w-live", "w-recent", "w-renewing", "x-lapsed"].sort(),
    );
    // The node is told, the same command any deletion sends, with the
    // address so the peer's slot is cleared too.
    expect(commands.map((c) => [c.nodeId, c.type, c.payload.externalUserId])).toEqual([
      ["node-b", "DELETE_USER", "key-w-device"],
      ["node-a", "DELETE_USER", "key-w-shared"],
    ]);
    expect(commands[0].payload).toMatchObject({ protocol: "WIREGUARD", credentials: { address: "10.0.0.2/32" } });
  });

  it("is idempotent: a second run finds nothing", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const { service, commands } = fleet();
    await service.releaseExpiredWireGuard(NOW);
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ matched: 0, released: 0 });
    expect(commands).toHaveLength(2);
  });

  it("follows WG_EXPIRED_RELEASE_DAYS", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    process.env.WG_EXPIRED_RELEASE_DAYS = "2";
    const { service, rows } = fleet();
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ released: 3 });
    expect(rows.find((r) => r.id === "w-recent")).toBeUndefined();
  });

  it("leaves a row whose subscription was renewed between the read and the delete, and tells no node", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const { service, prisma, rows, subs, commands } = fleet();
    const read = prisma.protocolUser.findMany.getMockImplementation()!;
    prisma.protocolUser.findMany.mockImplementationOnce(async (args) => {
      const found = await read(args);
      subs.find((s) => s.id === "lapsed")!.status = "ACTIVE";
      return found;
    });
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ matched: 2, released: 0 });
    expect(rows).toHaveLength(8);
    expect(commands).toHaveLength(0);
  });

  it("leaves rows on a retired server alone: its command queue is never read", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const { service, rows, commands } = world([sub("lapsed", "EXPIRED", 30)], [row("w-old", "lapsed", "WIREGUARD", "node-retired")]);
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ matched: 0, released: 0 });
    expect(rows).toHaveLength(1);
    expect(commands).toHaveLength(0);
  });

  it("releases at most WG_RELEASE_PER_RUN rows a run", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const many = Array.from({ length: WG_RELEASE_PER_RUN + 5 }, (_, i) => row(`w-${String(i).padStart(4, "0")}`, "lapsed"));
    const { service, rows } = world([sub("lapsed", "EXPIRED", 30)], many);
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ released: WG_RELEASE_PER_RUN });
    expect(rows).toHaveLength(5);
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ released: 5 });
  });

  it("keeps going past a node that cannot be told, and never throws", async () => {
    process.env.WG_EXPIRED_RELEASE = "on";
    const { service, agentGateway, rows } = fleet();
    agentGateway.enqueueCommand.mockRejectedValueOnce(new Error("node unreachable"));
    expect(await service.releaseExpiredWireGuard(NOW)).toMatchObject({ released: 2, failed: 1 });
    expect(rows).toHaveLength(6);
  });
});

describe("WG_EXPIRED_RELEASE settings", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    [undefined, "off"],
    ["", "off"],
    ["yes", "off"],
    [" DRY ", "dry"],
    ["on", "on"],
  ])("WG_EXPIRED_RELEASE=%j is %s", (raw, mode) => {
    if (raw === undefined) delete process.env.WG_EXPIRED_RELEASE;
    else process.env.WG_EXPIRED_RELEASE = raw;
    expect(wgExpiredReleaseMode()).toBe(mode);
  });

  it.each([
    [undefined, 7],
    ["", 7],
    ["0", 7],
    ["3", 3],
    ["1e3", 7],
    ["400", 7],
  ])("WG_EXPIRED_RELEASE_DAYS=%j is %d", (raw, days) => {
    if (raw === undefined) delete process.env.WG_EXPIRED_RELEASE_DAYS;
    else process.env.WG_EXPIRED_RELEASE_DAYS = raw;
    expect(wgExpiredReleaseDays()).toBe(days);
  });
});
