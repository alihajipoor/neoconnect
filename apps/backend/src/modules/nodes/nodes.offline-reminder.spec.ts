import { NodesService } from "./nodes.service";

/** The six-day outage this guards against produced no transitions after
 * its first minute: germany-1 and singapore-1 went OFFLINE, both
 * transition alerts fired, and then nothing said anything again while
 * the fleet ran at four of six nodes. So what is pinned here is the
 * behaviour on a state that *persists*, which is the case setStatus
 * cannot see. See docs/journal/log.md, 2026-08-30. */
describe("NodesService still-offline reminders", () => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  function build(offline: { id: string; name: string; hoursDown: number }[]) {
    const sent: { message: string; context?: Record<string, unknown> }[] = [];
    const prisma = {
      node: {
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve(
            offline.map((n) => ({
              id: n.id,
              name: n.name,
              lastHeartbeatAt: new Date(Date.now() - n.hoursDown * 3_600_000),
            })),
          ),
        ),
      },
    };
    const alerting = {
      send: jest.fn().mockImplementation((message: string, context?: Record<string, unknown>) => {
        sent.push({ message, context });
        return Promise.resolve();
      }),
    };
    const service = new NodesService(prisma as never, alerting as never);
    return { service, sent, prisma };
  }

  it("reports a node that is still offline, with how long it has been down", async () => {
    const { service, sent } = build([{ id: "n1", name: "germany-1", hoursDown: 150 }]);

    await service.remindAboutOfflineNodes();

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("germany-1");
    expect(sent[0].message).toContain("STILL OFFLINE");
    expect(sent[0].message).toContain("150h");
    expect(sent[0].context?.event).toBe("node_still_offline");
  });

  it("does not repeat inside the reminder window", async () => {
    const { service, sent } = build([{ id: "n1", name: "germany-1", hoursDown: 150 }]);

    await service.remindAboutOfflineNodes();
    await service.remindAboutOfflineNodes();
    await service.remindAboutOfflineNodes();

    expect(sent).toHaveLength(1);
  });

  it("repeats once the window has passed, so a long outage keeps saying so", async () => {
    const { service, sent } = build([{ id: "n1", name: "germany-1", hoursDown: 150 }]);

    await service.remindAboutOfflineNodes();
    const realNow = Date.now;
    Date.now = () => realNow() + SIX_HOURS + 1_000;
    try {
      await service.remindAboutOfflineNodes();
    } finally {
      Date.now = realNow;
    }

    expect(sent).toHaveLength(2);
  });

  it("suppressNextOfflineReminder holds the first repeat back", async () => {
    const { service, sent } = build([{ id: "n1", name: "germany-1", hoursDown: 1 }]);

    // What the sweep does immediately after setStatus has alerted on the
    // transition -- otherwise both messages arrive together.
    service.suppressNextOfflineReminder("n1");
    await service.remindAboutOfflineNodes();

    expect(sent).toHaveLength(0);
  });

  it("forgets a node that came back, so its next outage reports immediately", async () => {
    const { service, sent, prisma } = build([{ id: "n1", name: "germany-1", hoursDown: 150 }]);

    await service.remindAboutOfflineNodes();
    expect(sent).toHaveLength(1);

    // Node recovers: it is no longer in the OFFLINE set.
    prisma.node.findMany.mockResolvedValueOnce([]);
    await service.remindAboutOfflineNodes();
    expect(sent).toHaveLength(1);

    // It goes down again. Without pruning, the stale timestamp would
    // silence this for another six hours.
    await service.remindAboutOfflineNodes();
    expect(sent).toHaveLength(2);
  });

  it("says nothing when the whole fleet is up", async () => {
    const { service, sent } = build([]);
    await service.remindAboutOfflineNodes();
    expect(sent).toHaveLength(0);
  });
});
