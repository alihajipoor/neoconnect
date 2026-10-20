import { NodesService } from "./nodes.service";

/** A node that stops heartbeating reaches a person, once per gap, and once
 * more when it is back. Blips under the threshold and gaps older than the
 * horizon (ir1, down for weeks) are left to the webhook-only alerts. */
describe("NodesService heartbeat-gap paging", () => {
  const MIN = 60_000;
  const NOW = Date.parse("2026-10-19T12:00:00Z");

  function build(opts: { minutes?: string; offline?: { id: string; name: string; lastHeartbeatAt: Date }[] } = {}) {
    const pages: { subject: string; text: string }[] = [];
    const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
    const prisma = {
      node: {
        findMany: jest.fn().mockResolvedValue(opts.offline ?? []),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          return Promise.resolve({});
        }),
      },
    };
    const alerting = { send: jest.fn().mockResolvedValue(undefined) };
    const pager = {
      page: jest.fn().mockImplementation((p: { subject: string; text: string }) => {
        pages.push(p);
        return Promise.resolve({ delivered: true, error: null });
      }),
    };
    const config = { get: jest.fn().mockReturnValue(opts.minutes ?? "10") };
    const service = new NodesService(prisma as never, alerting as never, pager as never, config as never);
    return { service, prisma, pages, updates };
  }

  it("asks only for fresh gaps past the threshold that have not been paged", async () => {
    const { service, prisma } = build();
    await service.pageHeartbeatGaps(NOW);
    const where = prisma.node.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("OFFLINE");
    expect(where.heartbeatGapPagedAt).toBeNull();
    expect(where.lastHeartbeatAt.lte).toEqual(new Date(NOW - 10 * MIN));
    expect(where.lastHeartbeatAt.gt).toEqual(new Date(NOW - 24 * 60 * MIN));
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
    expect(updates).toEqual([{ where: { id: "n1" }, data: { heartbeatGapPagedAt: new Date(NOW) } }]);
  });

  it("takes a blank setting as the default, as Compose passes an unset one", async () => {
    const { service, prisma } = build({ minutes: "" });
    await service.pageHeartbeatGaps(NOW);
    expect(prisma.node.findMany.mock.calls[0][0].where.lastHeartbeatAt.lte).toEqual(new Date(NOW - 10 * MIN));
  });

  it("is off at 0", async () => {
    const { service, prisma } = build({ minutes: "0" });
    await service.pageHeartbeatGaps(NOW);
    expect(prisma.node.findMany).not.toHaveBeenCalled();
  });

  it("pages at most four gaps an hour, so a fault of ours is not one mail per node", async () => {
    const offline = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      name: `node-${i}`,
      lastHeartbeatAt: new Date(NOW - 15 * MIN),
    }));
    const { service, pages, updates } = build({ offline });
    await service.pageHeartbeatGaps(NOW);
    expect(pages).toHaveLength(4);
    // The two left over are not marked, so they page when budget frees.
    expect(updates.map((u) => u.where.id)).toEqual(["n0", "n1", "n2", "n3"]);
  });

  it("never throws", async () => {
    const { service, prisma } = build();
    prisma.node.findMany.mockRejectedValue(new Error("db down"));
    await expect(service.pageHeartbeatGaps(NOW)).resolves.toBeUndefined();
  });

  it("says the node is back when its gap had been paged, and clears the mark", async () => {
    const { service, prisma, pages, updates } = build();
    prisma.node.findUnique.mockResolvedValue({
      status: "OFFLINE",
      name: "germany-1",
      heartbeatGapPagedAt: new Date(NOW - 5 * MIN),
      lastHeartbeatAt: new Date(Date.now() - 30 * MIN),
    });
    await service.setStatus("n1", "ONLINE");
    expect(pages).toHaveLength(1);
    expect(pages[0].subject).toContain("germany-1 is heartbeating again");
    expect(updates.some((u) => u.data.heartbeatGapPagedAt === null)).toBe(true);
  });

  it("says nothing on return when the gap was never paged", async () => {
    const { service, prisma, pages } = build();
    prisma.node.findUnique.mockResolvedValue({
      status: "OFFLINE",
      name: "turkey-1",
      heartbeatGapPagedAt: null,
      lastHeartbeatAt: new Date(Date.now() - 2 * MIN),
    });
    await service.setStatus("n1", "ONLINE");
    expect(pages).toHaveLength(0);
  });
});
