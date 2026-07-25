import { ConcurrencyService } from "./concurrency.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";

/** Enforcement disconnects paying customers, so the conditions under
 * which it fires are worth pinning down precisely. The expensive mistake
 * here is a false positive: someone moving from wifi to mobile data
 * briefly looks identical to two people sharing an account. */
describe("ConcurrencyService", () => {
  function build(opts: { limit: number | null; status?: string } = { limit: 2 }) {
    const prisma = {
      protocolUser: {
        findFirst: jest.fn().mockResolvedValue({
          id: "pu-1",
          nodeId: "node-1",
          protocol: "XRAY_VLESS_REALITY",
          externalUserId: "uuid-1",
          status: opts.status ?? "ACTIVE",
          credentialsJson: encryptCredentials({ uuid: "uuid-1" }),
          subscription: { plan: { maxConcurrentConnections: opts.limit } },
        }),
      },
    };
    const agentGateway = { enqueueCommand: jest.fn().mockResolvedValue({}) };
    const service = new ConcurrencyService(
      prisma as unknown as PrismaService,
      agentGateway as unknown as AgentGatewayService,
    );
    return { service, prisma, agentGateway };
  }

  const over = (n: number) => [{ externalUserId: "uuid-1", protocol: "XRAY_VLESS_REALITY", distinctSources: n }];

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
      externalUserId: "uuid-1",
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
    expect(agentGateway.enqueueCommand).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(61_000);

    const restore = agentGateway.enqueueCommand.mock.calls.find((c) => c[1] === "ENABLE_USER");
    expect(restore).toBeDefined();
    // Re-enabling needs the real credentials, not an empty object.
    expect((restore?.[2] as { credentials: Record<string, string> }).credentials).toEqual({ uuid: "uuid-1" });
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
});
