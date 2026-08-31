import { NodesService } from "./nodes.service";

/** finland1 served nothing over REALITY for weeks while the panel called
 * it ONLINE, because its dest was unreachable from that node and nothing
 * measured it. These pin down the reporting side of the fix -- in
 * particular that "did not measure" and "unreachable" stay different
 * answers. See docs/journal/log.md, 2026-08-31. */
describe("NodesService REALITY dest health", () => {
  function build(previous: { name: string; realityDest: string | null; realityDestReachable: boolean | null } | null) {
    const sent: { message: string; context?: Record<string, unknown> }[] = [];
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue(previous),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return Promise.resolve({});
        }),
      },
    };
    const alerting = {
      send: jest.fn().mockImplementation((message: string, context?: Record<string, unknown>) => {
        sent.push({ message, context });
        return Promise.resolve();
      }),
    };
    return { service: new NodesService(prisma as never, alerting as never), sent, updates, prisma };
  }

  it("records the dest and stamps when it was checked", async () => {
    const { service, updates } = build({ name: "finland1", realityDest: null, realityDestReachable: null });

    await service.recordRealityDestHealth("n1", "www.helsinki.fi:443", true);

    expect(updates).toHaveLength(1);
    expect(updates[0].realityDest).toBe("www.helsinki.fi:443");
    expect(updates[0].realityDestReachable).toBe(true);
    expect(updates[0].realityDestCheckedAt).toBeInstanceOf(Date);
  });

  it("alerts the first time a dest is reported unreachable", async () => {
    const { service, sent } = build({ name: "finland1", realityDest: null, realityDestReachable: null });

    await service.recordRealityDestHealth("n1", "www.shatel.ir:443", false);

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("cannot reach its REALITY dest");
    expect(sent[0].message).toContain("www.shatel.ir:443");
    expect(sent[0].context?.event).toBe("reality_dest_unreachable");
  });

  it("does not re-alert while the answer is unchanged", async () => {
    const { service, sent } = build({
      name: "finland1",
      realityDest: "www.shatel.ir:443",
      realityDestReachable: false,
    });

    await service.recordRealityDestHealth("n1", "www.shatel.ir:443", false);
    await service.recordRealityDestHealth("n1", "www.shatel.ir:443", false);

    expect(sent).toHaveLength(0);
  });

  it("says so when a dest starts working again", async () => {
    const { service, sent } = build({
      name: "finland1",
      realityDest: "www.helsinki.fi:443",
      realityDestReachable: false,
    });

    await service.recordRealityDestHealth("n1", "www.helsinki.fi:443", true);

    expect(sent).toHaveLength(1);
    expect(sent[0].context?.event).toBe("reality_dest_recovered");
  });

  it("alerts when the dest changes to a broken one", async () => {
    const { service, sent } = build({
      name: "france-1",
      realityDest: "www.free.fr:443",
      realityDestReachable: true,
    });

    await service.recordRealityDestHealth("n1", "cloudflare.com:443", false);

    expect(sent).toHaveLength(1);
    expect(sent[0].context?.event).toBe("reality_dest_unreachable");
  });

  // The one that keeps this from paging for the whole fleet on the day it
  // ships: an agent that reports no dest has not said anything, and an
  // absent answer is not a bad one.
  it("ignores a node that did not measure, without writing or alerting", async () => {
    const { service, sent, updates, prisma } = build({
      name: "turkey-1",
      realityDest: null,
      realityDestReachable: null,
    });

    await service.recordRealityDestHealth("n1", "", false);

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(prisma.node.findUnique).not.toHaveBeenCalled();
  });
});
