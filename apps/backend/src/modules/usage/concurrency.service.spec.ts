import { ConcurrencyService } from "./concurrency.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
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
    const service = new ConcurrencyService(
      prisma as unknown as PrismaService,
      agentGateway as unknown as AgentGatewayService,
    );
    return { service, prisma, agentGateway };
  }

  /** One credential reporting `n` sources. */
  const over = (n: number) => [
    { externalUserId: "ext-0", protocol: "XRAY_VLESS_REALITY", distinctSources: n },
  ];

  const disables = (mock: jest.Mock) => mock.mock.calls.filter((c) => c[1] === "DISABLE_USER");

  afterEach(() => jest.useRealTimers());

  it("does nothing while a user is within their limit", async () => {
    const { service, agentGateway } = build({ limit: 2 });
    for (let i = 0; i < 5; i++) await service.handleSessionCounts("node-1", over(2));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("tolerates a single over-limit reading", async () => {
    // A laptop waking on a new network shows two addresses for one poll.
    // Acting on that would disconnect people constantly.
    const { service, agentGateway } = build({ limit: 1 });
    await service.handleSessionCounts("node-1", over(2));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("disconnects only after the excess persists", async () => {
    const { service, agentGateway } = build({ limit: 1 });

    await service.handleSessionCounts("node-1", over(3));
    await service.handleSessionCounts("node-1", over(3));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();

    await service.handleSessionCounts("node-1", over(3));
    expect(agentGateway.enqueueCommand).toHaveBeenCalledWith("node-1", "DISABLE_USER", {
      protocol: "XRAY_VLESS_REALITY",
      externalUserId: "ext-0",
    });
  });

  it("forgets earlier strikes once a user is back within the limit", async () => {
    // Otherwise two isolated blips hours apart would eventually add up to
    // a disconnect for someone who never shared anything.
    const { service, agentGateway } = build({ limit: 1 });

    await service.handleSessionCounts("node-1", over(2));
    await service.handleSessionCounts("node-1", over(2));
    await service.handleSessionCounts("node-1", over(1));
    await service.handleSessionCounts("node-1", over(2));

    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("restores the user after the cooldown rather than leaving them cut off", async () => {
    jest.useFakeTimers();
    const { service, agentGateway } = build({ limit: 1 });

    for (let i = 0; i < 3; i++) await service.handleSessionCounts("node-1", over(4));
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
    for (let i = 0; i < 5; i++) await service.handleSessionCounts("node-1", over(99));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("leaves already-disabled users alone", async () => {
    const { service, agentGateway } = build({ limit: 1, status: "DISABLED" });
    for (let i = 0; i < 5; i++) await service.handleSessionCounts("node-1", over(9));
    expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
  });

  it("ignores counts for a user this node doesn't know", async () => {
    const { service, prisma, agentGateway } = build({ limit: 1 });
    prisma.protocolUser.findFirst.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) await service.handleSessionCounts("node-1", over(9));
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

    for (let i = 0; i < 3; i++) await service.handleSessionCounts("node-1", spreadOut);

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

    for (let i = 0; i < 3; i++) await service.handleSessionCounts("node-1", over(5));

    const dropped = disables(agentGateway.enqueueCommand).map((c) => (c[2] as { externalUserId: string }).externalUserId);
    expect(dropped.sort()).toEqual(["ext-0", "ext-1", "ext-2"]);
  });
});
