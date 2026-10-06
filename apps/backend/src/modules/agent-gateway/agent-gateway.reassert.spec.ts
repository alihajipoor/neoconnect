import { cursoredFindMany } from "../../../test/cursored";
import { AgentGatewayService, agentTakesReassertedCaps } from "./agent-gateway.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";
import { liveCredentialWhere } from "../protocol-users/live-credentials";

/** liveCredentialWhere with its clock replaced by a matcher. */
const liveCredentialWhereAt = (now: unknown) => liveCredentialWhere(now as Date);

/** The reconnect path is the only thing standing between a node reboot
 * and every customer on that node silently losing service, so what it
 * sends is pinned down here rather than left to inspection.
 *
 * Reaches the private method deliberately: driving it through a real
 * gRPC Hello would need a signed handshake and a live stream, which
 * tests the transport rather than the reconciliation this exists for. */
describe("AgentGatewayService reconnect reconciliation", () => {
  function build(
    users: {
      protocol: string;
      externalUserId: string;
      credentials: Record<string, string>;
      transport?: string;
      agentVersion?: string;
      plan?: { maxDownloadMbps: number | null; maxUploadMbps: number | null };
    }[],
  ) {
    const prisma = {
      protocolUser: {
        // Cursor-aware: the re-assert reads in batches, so a mock that
        // returns the same page every time would not tell a working
        // cursor from a broken one. Ids are zero-padded because the
        // cursor compares strings.
        findMany: cursoredFindMany(
          users.map((u, i) => ({
            id: `pu-${String(i).padStart(3, "0")}`,
            nodeId: "node-1",
            protocol: u.protocol,
            externalUserId: u.externalUserId,
            status: "ACTIVE",
            credentialsJson: encryptCredentials(u.credentials),
            protocolConfig: { transport: u.transport ?? "TCP" },
            ...(u.agentVersion !== undefined ? { node: { agentVersion: u.agentVersion } } : {}),
            ...(u.plan ? { subscription: { plan: u.plan } } : {}),
          })),
        ),
      },
    };

    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const enqueue = jest.spyOn(service, "enqueueCommand").mockResolvedValue({} as never);
    return { service, prisma, enqueue };
  }

  /** Invokes the private reconciliation the same way handleHello does. */
  function reassert(service: AgentGatewayService, nodeId: string): Promise<void> {
    return (service as unknown as { reassertProvisionedUsers(id: string): Promise<void> }).reassertProvisionedUsers(
      nodeId,
    );
  }

  it("re-creates every active user when an agent reconnects", async () => {
    // The reboot case: the engines came up empty, and nothing else in
    // the system would notice.
    const { service, enqueue } = build([
      { protocol: "WIREGUARD", externalUserId: "peer-key-1", credentials: { privateKey: "a", address: "10.66.0.2/32" } },
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-2", credentials: { uuid: "uuid-2", flow: "vision" } },
    ]);

    await reassert(service, "node-1");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith("node-1", "CREATE_USER", {
      protocol: "WIREGUARD",
      transport: "TCP",
      externalUserId: "peer-key-1",
      credentials: { privateKey: "a", address: "10.66.0.2/32" },
    });
  });

  /** The protocol alone no longer says which inbound a user belongs on:
   * one node serves VLESS+TLS as a raw TCP stream and inside a WebSocket
   * at the same time, on one port and one certificate.
   *
   * Re-assert is the dangerous place to get this wrong. It runs when a
   * node comes back, for every customer at once, so dropping the
   * transport here would quietly rebuild every WebSocket customer on the
   * TCP inbound -- leaving them a credential that looks right and never
   * connects. */
  it("carries the transport, so a WebSocket user is not rebuilt on the TCP inbound", async () => {
    const { service, enqueue } = build([
      {
        protocol: "XRAY_VLESS_TLS",
        externalUserId: "uuid-ws",
        credentials: { uuid: "uuid-ws" },
        transport: "WS",
      },
    ]);

    await reassert(service, "node-1");

    expect(enqueue.mock.calls[0][2]).toMatchObject({ protocol: "XRAY_VLESS_TLS", transport: "WS" });
  });

  it("sends decrypted credentials, since the agent cannot use the stored form", async () => {
    const { service, enqueue } = build([
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-1", credentials: { uuid: "uuid-1", flow: "vision" } },
    ]);

    await reassert(service, "node-1");

    const payload = enqueue.mock.calls[0][2] as { credentials: Record<string, string> };
    expect(payload.credentials).toEqual({ uuid: "uuid-1", flow: "vision" });
  });

  it("only reasserts users belonging to the node that reconnected", async () => {
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    // The scoping is the point, asserted on its own rather than on the
    // whole argument: what else the query selects or includes is free to
    // change, but re-asserting another node's users onto this one never
    // is.
    const [args] = (prisma.protocolUser.findMany as jest.Mock).mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    // No `id` key on the first read: the cursor is absent until there
    // is a batch to continue from. The rest is which of the node's
    // credentials are live (liveCredentialWhere), tested on its own.
    expect(args.where).toEqual({ nodeId: "node-1", ...liveCredentialWhereAt(expect.any(Date)) });
    expect(args.where).not.toHaveProperty("id");
  });

  /** Caps used to arrive only at first provisioning and on a plan edit,
   * and the agent kept them in memory: after an agent restart or a
   * wg-quick restart, nobody provisioned earlier was shaped again. The
   * re-assert now carries them -- but only to an agent whose
   * applyRateLimit is idempotent; an older one would tear down and
   * rebuild every capped user's tc rules once a minute. */
  it("sends the plan's speed caps to an agent that can take them, and only to one", async () => {
    const plan = { maxDownloadMbps: 50, maxUploadMbps: 10 };
    const wg = { privateKey: "a", address: "10.66.0.2/32" };
    const { service, enqueue } = build([
      { protocol: "WIREGUARD", externalUserId: "new-agent", credentials: wg, agentVersion: "v0.2.10", plan },
      { protocol: "WIREGUARD", externalUserId: "old-agent", credentials: wg, agentVersion: "v0.2.9", plan },
      { protocol: "WIREGUARD", externalUserId: "dev-agent", credentials: wg, agentVersion: "dev", plan },
      // Unshapeable, so nothing however new the agent.
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "xray", credentials: { uuid: "x" }, agentVersion: "v0.3.0", plan },
      { protocol: "OPENVPN", externalUserId: "uncapped", credentials: {}, agentVersion: "v0.3.0", plan: { maxDownloadMbps: null, maxUploadMbps: null } },
    ]);

    await reassert(service, "node-1");

    const sent = new Map(enqueue.mock.calls.map((c) => [(c[2] as { externalUserId: string }).externalUserId, c[2]]));
    expect(sent.get("new-agent")).toMatchObject({ downloadMbps: 50, uploadMbps: 10 });
    for (const id of ["old-agent", "dev-agent", "xray", "uncapped"]) {
      expect(sent.get(id)).not.toHaveProperty("downloadMbps");
      expect(sent.get(id)).not.toHaveProperty("uploadMbps");
    }
  });

  it("compares agent versions numerically, and treats anything unparseable as too old", () => {
    expect(agentTakesReassertedCaps("v0.2.10")).toBe(true);
    expect(agentTakesReassertedCaps("0.2.10")).toBe(true);
    expect(agentTakesReassertedCaps("v0.2.11")).toBe(true);
    expect(agentTakesReassertedCaps("v0.3.0")).toBe(true);
    expect(agentTakesReassertedCaps("v1.0.0")).toBe(true);
    expect(agentTakesReassertedCaps("v0.2.9")).toBe(false);
    expect(agentTakesReassertedCaps("v0.1.99")).toBe(false);
    expect(agentTakesReassertedCaps("dev")).toBe(false);
    expect(agentTakesReassertedCaps("v0.2.10-rc1")).toBe(false);
    expect(agentTakesReassertedCaps(null)).toBe(false);
    expect(agentTakesReassertedCaps(undefined)).toBe(false);
  });

  it("sends nothing for a node with no provisioned users", async () => {
    const { service, enqueue } = build([]);

    await reassert(service, "node-1");

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("writes periodic re-asserts without storing a command for each", async () => {
    // The periodic sweep runs on every connected node every few minutes.
    // Persisting one row per user per sweep would accumulate thousands of
    // rows a day recording that nothing changed.
    const { service, enqueue } = build([
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-1", credentials: { uuid: "uuid-1" } },
    ]);
    const write = jest
      .spyOn(service as unknown as { writeCommand: () => boolean }, "writeCommand")
      .mockReturnValue(true);

    await (
      service as unknown as { reassertProvisionedUsers(id: string, o: { persist: boolean }): Promise<void> }
    ).reassertProvisionedUsers("node-1", { persist: false });

    expect(enqueue).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("skips users that are disabled rather than restoring their access", async () => {
    // Suspended and over-quota customers are DISABLED, not deleted. A
    // blanket re-create would hand them back working credentials as a
    // side effect of an unrelated reboot.
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    const where = prisma.protocolUser.findMany.mock.calls[0][0].where as { status: string };
    expect(where.status).toBe("ACTIVE");
  });

  /** A signed-out device's row is still ACTIVE between sign-out's
   * DELETE_USER and the row going -- and for an hour if the delete
   * failed. Re-asserting it put the credential straight back. Shared
   * credentials have no session and are always re-asserted. */
  it("skips a signed-out device's credentials, and only those", async () => {
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    const where = prisma.protocolUser.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      nodeId: "node-1",
      AND: expect.arrayContaining([{ OR: [{ sessionId: null }, { session: { is: { revokedAt: null } } }] }]),
    });
  });

  /** A hold lifted because its device was let in: the device dials as
   * soon as its grant arrives, so its credentials go back now rather than
   * at the next periodic re-assert -- and only rows that are still live. */
  it("re-asserts named credentials at once, live ones only, without storing a command", async () => {
    const { service, prisma, enqueue } = build([
      { protocol: "XRAY_VLESS_REALITY", externalUserId: "uuid-1", credentials: { uuid: "uuid-1" } },
    ]);
    const write = jest
      .spyOn(service as unknown as { writeCommand: () => boolean }, "writeCommand")
      .mockReturnValue(true);

    await service.reassertCredentials(["pu-000"]);

    const where = prisma.protocolUser.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ id: { in: ["pu-000"] }, ...liveCredentialWhereAt(expect.any(Date)) });
    expect(enqueue).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("node-1", expect.stringMatching(/^reassert/), "CREATE_USER", {
      protocol: "XRAY_VLESS_REALITY",
      transport: "TCP",
      externalUserId: "uuid-1",
      credentials: { uuid: "uuid-1" },
    });
  });

  it("never throws from an immediate re-assert", async () => {
    const { service, prisma } = build([]);
    prisma.protocolUser.findMany = jest.fn().mockRejectedValue(new Error("database went away")) as never;

    await expect(service.reassertCredentials(["pu-000"])).resolves.toBeUndefined();
  });

  /** The device-limit backstop's hold is only durable because this skips
   * it: re-asserting every ACTIVE row undid each cut within a minute. A
   * lapsed hold is included again, which is how the device comes back --
   * from the row as it is then, never a list captured at the cut. */
  it("skips a credential while the device-limit backstop holds it, and not after", async () => {
    const { service, prisma } = build([]);

    await reassert(service, "node-1");

    const where = prisma.protocolUser.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      AND: expect.arrayContaining([{ OR: [{ heldUntil: null }, { heldUntil: { lte: expect.any(Date) } }] }]),
    });
  });
});
