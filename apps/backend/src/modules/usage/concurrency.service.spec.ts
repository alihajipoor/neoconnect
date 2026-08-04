import { ConcurrencyService } from "./concurrency.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { ConcurrencyStore, sumFresh } from "./concurrency-store";
import { encryptCredentials } from "../protocol-users/credentials-crypto";

/** Enforcement disconnects paying customers, so the conditions under
 * which it fires are worth pinning down precisely. The expensive mistake
 * here is a false positive: someone moving from wifi to mobile data
 * briefly looks identical to two people sharing an account. */
describe("ConcurrencyService", () => {
  /** A subscription holding one credential per protocol on one node --
   * which is what every subscription looks like now that provisioning
   * covers every route the plan allows. */
  function credentials(protocols: string[]) {
    return protocols.map((protocol, i) => ({
      id: `pu-${i}`,
      nodeId: "node-1",
      protocol,
      externalUserId: `ext-${i}`,
      status: "ACTIVE",
      subscriptionId: "sub-1",
      credentialsJson: encryptCredentials({ uuid: `ext-${i}` }),
    }));
  }

  function build(
    opts: { limit: number | null; status?: string; protocols?: string[] } = { limit: 2 },
  ) {
    const users = credentials(opts.protocols ?? ["XRAY_VLESS_REALITY"]).map((u) => ({
      ...u,
      status: opts.status ?? "ACTIVE",
    }));

    const prisma = {
      protocolUser: {
        findFirst: jest.fn(({ where }: { where: { externalUserId: string } }) =>
          Promise.resolve(users.find((u) => u.externalUserId === where.externalUserId) ?? null),
        ),
        findMany: jest.fn().mockResolvedValue(users.filter((u) => u.status === "ACTIVE")),
      },
      subscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "sub-1", plan: { maxConcurrentConnections: opts.limit } }),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue({}) };

    // Mirrors the real store's semantics -- latest count per node, summed
    // while fresh -- without a Redis. The freshness rule itself is tested
    // directly against sumFresh at the bottom of this file.
    const perNode = new Map<string, Map<string, { count: number; at: number }>>();
    const store = {
      // eslint-disable-next-line @typescript-eslint/require-await -- matches the real store's async signature
      recordAndTotal: jest.fn(async (subscriptionId: string, nodeId: string, count: number) => {
        const nodes = perNode.get(subscriptionId) ?? new Map();
        nodes.set(nodeId, { count, at: Date.now() });
        perNode.set(subscriptionId, nodes);
        let total = 0;
        for (const [node, entry] of nodes) {
          if (Date.now() - entry.at > 90_000) nodes.delete(node);
          else total += entry.count;
        }
        return total;
      }),
      // eslint-disable-next-line @typescript-eslint/require-await -- as above
      clear: jest.fn(async (subscriptionId: string) => {
        perNode.delete(subscriptionId);
      }),
    };

    const service = new ConcurrencyService(
      prisma as unknown as PrismaService,
      agentGateway as unknown as AgentGatewayService,
      store as unknown as ConcurrencyStore,
    );
    return { service, prisma, agentGateway, store };
  }

  /** One polling cycle.
   *
   * The clock has to move between cycles, and not only for realism: a
   * strike is deliberately capped at one per ~20 seconds, because several
   * nodes now report the same subscription and three of them answering at
   * once would otherwise burn the whole debounce on a single reading.
   * Reports really are about 30 seconds apart. */
  async function poll(
    service: ConcurrencyService,
    nodeId: string,
    counts: { externalUserId: string; protocol: string; distinctSources: number }[],
  ) {
    await service.handleSessionCounts(nodeId, counts);
    await jest.advanceTimersByTimeAsync(30_000);
  }

  /** One credential reporting `n` sources. */
  const over = (n: number) => [
    { externalUserId: "ext-0", protocol: "XRAY_VLESS_REALITY", distinctSources: n },
  ];

  const disables = (mock: jest.Mock) => mock.mock.calls.filter((c) => c[1] === "DISABLE_USER");

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("does nothing while a user is within their limit", async () => {
    const { service, agentGateway } = build({ limit: 2 });
    for (let i = 0; i < 5; i++) await poll(service, "node-1", over(2));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("tolerates a single over-limit reading", async () => {
    // A laptop waking on a new network shows two addresses for one poll.
    // Acting on that would disconnect people constantly.
    const { service, agentGateway } = build({ limit: 1 });
    await poll(service, "node-1", over(2));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("disconnects only after the excess persists", async () => {
    const { service, agentGateway } = build({ limit: 1 });

    await poll(service, "node-1", over(3));
    await poll(service, "node-1", over(3));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();

    await poll(service, "node-1", over(3));
    expect(agentGateway.enqueueCommand).toHaveBeenCalledWith("node-1", "DISABLE_USER", {
      protocol: "XRAY_VLESS_REALITY",
      externalUserId: "ext-0",
    });
  });

  it("forgets earlier strikes once a user is back within the limit", async () => {
    // Otherwise two isolated blips hours apart would eventually add up to
    // a disconnect for someone who never shared anything.
    const { service, agentGateway } = build({ limit: 1 });

    await poll(service, "node-1", over(2));
    await poll(service, "node-1", over(2));
    await poll(service, "node-1", over(1));
    await poll(service, "node-1", over(2));

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("restores the user after the cooldown rather than leaving them cut off", async () => {
    const { service, agentGateway } = build({ limit: 1 });

    for (let i = 0; i < 3; i++) await poll(service, "node-1", over(4));
    expect(disables(agentGateway.enqueueCommand)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(61_000);

    const restore = agentGateway.enqueueCommand.mock.calls.find((c) => c[1] === "ENABLE_USER");
    expect(restore).toBeDefined();
    // Re-enabling needs the real credentials, not an empty object.
    expect((restore?.[2] as { credentials: Record<string, string> }).credentials).toEqual({
      uuid: "ext-0",
    });
  });

  it("treats an unset limit as unlimited, not as zero", async () => {
    // Plans created before this feature have no value set. Reading that
    // as "zero allowed" would disconnect every customer on them.
    const { service, agentGateway } = build({ limit: null });
    for (let i = 0; i < 5; i++) await poll(service, "node-1", over(99));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("leaves already-disabled users alone", async () => {
    const { service, agentGateway } = build({ limit: 1, status: "DISABLED" });
    for (let i = 0; i < 5; i++) await poll(service, "node-1", over(9));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("ignores counts for a user this node doesn't know", async () => {
    const { service, prisma, agentGateway } = build({ limit: 1 });
    prisma.protocolUser.findFirst.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) await poll(service, "node-1", over(9));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  /** The hole that provisioning-every-route opened.
   *
   * Each credential on its own is inside the limit, so judging them
   * separately -- as this did before -- saw nothing wrong and let one
   * customer run the limit once per protocol.
   */
  it("adds up sources across a subscription's credentials rather than judging each alone", async () => {
    const { service, agentGateway } = build({
      limit: 2,
      protocols: ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_TROJAN"],
    });

    const spreadOut = [
      { externalUserId: "ext-0", protocol: "XRAY_VLESS_REALITY", distinctSources: 2 },
      { externalUserId: "ext-1", protocol: "XRAY_VLESS_TLS", distinctSources: 2 },
      { externalUserId: "ext-2", protocol: "XRAY_TROJAN", distinctSources: 2 },
    ];

    for (let i = 0; i < 3; i++) await poll(service, "node-1", spreadOut);

    // 6 sources against a limit of 2.
    expect(disables(agentGateway.enqueueCommand).length).toBeGreaterThan(0);
  });

  /** Dropping only the credential that reported over the limit would
   * move the sharer onto the next protocol they already hold, which is
   * the same hole one step along. */
  it("drops every credential the subscription holds, not just the reporting one", async () => {
    const { service, agentGateway } = build({
      limit: 1,
      protocols: ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_TROJAN"],
    });

    for (let i = 0; i < 3; i++) await poll(service, "node-1", over(5));

    const dropped = disables(agentGateway.enqueueCommand).map((c) => (c[2] as { externalUserId: string }).externalUserId);
    expect(dropped.sort()).toEqual(["ext-0", "ext-1", "ext-2"]);
  });

  /** The hole that having a credential on every route opened next.
   *
   * Each node sees a count inside the limit, so per-node judging -- which
   * is what this did before -- saw nothing wrong. A sharer only had to
   * tell each friend to pick a different location, and a limit of two
   * across five nodes quietly permitted ten.
   */
  it("counts a subscription across nodes, not one node at a time", async () => {
    const { service, agentGateway } = build({ limit: 2 });

    // Two devices in Finland and two in France. Neither node is over.
    for (let i = 0; i < 3; i++) {
      await poll(service, "node-1", over(2));
      await poll(service, "node-2", over(2));
    }

    expect(disables(agentGateway.enqueueCommand).length).toBeGreaterThan(0);
  });

  /** The debounce is meant to require the excess to *persist*. Several
   * nodes answering within the same cycle is one reading, not three, and
   * counting it as three would disconnect people mid location-switch --
   * hitting hardest the customers who use the most locations. */
  it("counts one polling cycle once however many nodes report it", async () => {
    const { service, agentGateway } = build({ limit: 1 });

    // Five nodes, one cycle, comfortably over the limit.
    for (const node of ["n1", "n2", "n3", "n4", "n5"]) {
      await service.handleSessionCounts(node, over(2));
    }

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  /** Otherwise the counts from before the drop survive it, and the
   * customer's legitimate devices trip the limit again the moment they
   * reconnect -- a disconnect loop rather than a warning. */
  it("forgets the stored counts after disconnecting someone", async () => {
    const { service, store } = build({ limit: 1 });

    for (let i = 0; i < 3; i++) await poll(service, "node-1", over(4));

    expect(store.clear).toHaveBeenCalledWith("sub-1");
  });
});

/** The freshness rule, which is where the real judgement in the store
 * lives. Tested directly so it needs no Redis. */
describe("sumFresh", () => {
  const now = 1_000_000;

  it("adds up every node that reported recently", () => {
    expect(
      sumFresh({ "node-1": `2:${now - 1_000}`, "node-2": `3:${now - 2_000}` }, now),
    ).toEqual({ total: 5, stale: [] });
  });

  /** A node that has gone quiet has no live sessions. Absence is the only
   * "they disconnected" signal there is -- nodes report the users they
   * see, never the ones they don't -- so a stale entry must drop out
   * rather than pin someone at a count they no longer have. */
  it("drops a node that has stopped reporting", () => {
    const result = sumFresh({ "node-1": `2:${now - 1_000}`, "node-2": `9:${now - 200_000}` }, now);
    expect(result.total).toBe(2);
    expect(result.stale).toEqual(["node-2"]);
  });

  /** Counted-forever is the failure mode worth avoiding: a single bad
   * write would otherwise hold a customer over their limit permanently. */
  it("treats a malformed entry as stale rather than as a number", () => {
    const result = sumFresh({ "node-1": "not-a-count", "node-2": `1:${now}` }, now);
    expect(result.total).toBe(1);
    expect(result.stale).toEqual(["node-1"]);
  });
});
