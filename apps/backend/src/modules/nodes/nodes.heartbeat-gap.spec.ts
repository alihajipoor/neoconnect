import { HEARTBEAT_GAP_COOLDOWN_MS, heartbeatGapPageMinutes, NodesService } from "./nodes.service";

/** A node that stops heartbeating reaches a person -- when the owner has
 * turned that on -- once per gap, and once more when it is back. Blips
 * under the threshold and gaps older than the horizon (a node long gone)
 * are left to the webhook-only alerts. */
describe("NodesService heartbeat-gap paging", () => {
  const MIN = 60_000;
  const NOW = Date.parse("2026-10-19T12:00:00Z");

  type Node = { id: string; name: string; lastHeartbeatAt?: Date; heartbeatGapPagedAt?: Date | null };

  function build(opts: { minutes?: string; offline?: Node[]; back?: Node[]; delivered?: boolean } = {}) {
    const pages: { subject: string; text: string; webhook?: string }[] = [];
    const updates: { where: { id: { in: string[] } }; data: Record<string, unknown> }[] = [];
    const prisma = {
      node: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
          Promise.resolve(where.status === "OFFLINE" ? (opts.offline ?? []) : (opts.back ?? [])),
        ),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockImplementation((args: (typeof updates)[number]) => {
          updates.push(args);
          return Promise.resolve({ count: args.where.id.in.length });
        }),
      },
    };
    const alerting = { send: jest.fn().mockResolvedValue(undefined) };
    const pager = {
      page: jest.fn().mockImplementation((p: { subject: string; text: string }) => {
        pages.push(p);
        const delivered = opts.delivered ?? true;
        return Promise.resolve({ delivered, error: delivered ? null : "no webhook took it and no mail was sent" });
      }),
    };
    const config = { get: jest.fn().mockReturnValue(opts.minutes ?? "10") };
    const service = new NodesService(prisma as never, alerting as never, pager as never, config as never);
    return { service, prisma, pages, updates, pager };
  }

  const gapQuery = (prisma: ReturnType<typeof build>["prisma"]) =>
    prisma.node.findMany.mock.calls.map((c: [{ where: Record<string, any> }]) => c[0].where).find((w) => w.status === "OFFLINE")!;

  it("is off unless the owner turns it on: blank, 0 and anything unreadable", () => {
    for (const raw of [undefined, "", "  ", "0", "ten", "-5", "1.5"]) expect(heartbeatGapPageMinutes(raw)).toBe(0);
    expect(heartbeatGapPageMinutes("10")).toBe(10);
    expect(heartbeatGapPageMinutes(15)).toBe(15);
  });

  it("does nothing at all when off", async () => {
    for (const minutes of ["", "0"]) {
      const { service, prisma } = build({ minutes });
      await service.pageHeartbeatGaps(NOW);
      expect(prisma.node.findMany).not.toHaveBeenCalled();
    }
  });

  it("asks only for fresh gaps past the threshold, not yet paged, outside the cooldown", async () => {
    const { service, prisma } = build();
    await service.pageHeartbeatGaps(NOW);
    const where = gapQuery(prisma);
    expect(where.heartbeatGapPagedAt).toBeNull();
    expect(where.lastHeartbeatAt.lte).toEqual(new Date(NOW - 10 * MIN));
    expect(where.lastHeartbeatAt.gt).toEqual(new Date(NOW - 24 * 60 * MIN));
    expect(where.OR).toEqual([
      { heartbeatBackPagedAt: null },
      { heartbeatBackPagedAt: { lte: new Date(NOW - HEARTBEAT_GAP_COOLDOWN_MS) } },
    ]);
  });

  it("pages a quiet node once and records it", async () => {
    const { service, pages, updates } = build({
      offline: [{ id: "n1", name: "germany-1", lastHeartbeatAt: new Date(NOW - 12 * MIN) }],
    });
    await service.pageHeartbeatGaps(NOW);
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toContain("germany-1 has stopped heartbeating");
    expect(pages[0].text).toContain("12 minutes");
    expect(pages[0].text).toContain("not a block");
    expect(updates).toEqual([{ where: { id: { in: ["n1"] } }, data: { heartbeatGapPagedAt: new Date(NOW) } }]);
  });

  it("tells every node that went quiet in one sweep in one message", async () => {
    const offline = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      name: `node-${i}`,
      lastHeartbeatAt: new Date(NOW - 15 * MIN),
    }));
    const { service, pages, updates } = build({ offline });
    await service.pageHeartbeatGaps(NOW);
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] 6 nodes have stopped heartbeating");
    expect(pages[0].text).toContain("node-5: 15 minutes");
    expect(updates[0].where.id.in).toHaveLength(6);
  });

  it("does not mark a gap whose page reached nobody, and gives up after a few tries", async () => {
    const offline = [{ id: "n1", name: "germany-1", lastHeartbeatAt: new Date(NOW - 12 * MIN) }];
    const { service, pages, updates } = build({ offline, delivered: false });
    for (let i = 0; i < 5; i += 1) await service.pageHeartbeatGaps(NOW + i * MIN);
    expect(updates).toHaveLength(0);
    expect(pages).toHaveLength(3);
  });

  it("says the node is back from the sweep, once for all, and starts the cooldown", async () => {
    const { service, pages, updates } = build({
      back: [
        { id: "n1", name: "germany-1", heartbeatGapPagedAt: new Date(NOW - 30 * MIN) },
        { id: "n2", name: "finland-1", heartbeatGapPagedAt: new Date(NOW - 30 * MIN) },
      ],
    });
    await service.pageHeartbeatGaps(NOW);
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toBe("[Neoxify] 2 nodes are heartbeating again");
    expect(updates).toEqual([
      { where: { id: { in: ["n1", "n2"] } }, data: { heartbeatGapPagedAt: null, heartbeatBackPagedAt: new Date(NOW) } },
    ]);
  });

  it("pages nothing from an agent's Hello, even when its gap was paged", async () => {
    const { service, prisma, pager } = build();
    prisma.node.findUnique.mockResolvedValue({ status: "OFFLINE", name: "germany-1" });
    await service.setStatus("n1", "ONLINE");
    expect(pager.page).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const { service, prisma } = build();
    prisma.node.findMany.mockRejectedValue(new Error("db down"));
    await expect(service.pageHeartbeatGaps(NOW)).resolves.toBeUndefined();
  });
});
