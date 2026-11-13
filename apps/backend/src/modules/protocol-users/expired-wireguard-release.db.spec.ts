import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { BillingService } from "../billing/billing.service";
import { deviceSlotsStub } from "../../../test/device-slots-stub";
import { decryptCredentials } from "./credentials-crypto";
import { ProtocolUsersService } from "./protocol-users.service";

/** The rule WG_EXPIRED_RELEASE is only safe with: a subscription whose
 * WireGuard rows were released, and which is then renewed, gets a fresh
 * WireGuard credential -- and its other protocols are the same rows as
 * before, switched back on. Real ProtocolUsersService and BillingService
 * against a migrated Postgres; only the agent gateway is a stand-in.
 *
 * Runs only with NEOXIFY_DB_SPECS=1, which CI sets for its own step after
 * `prisma migrate deploy`. Documentation addresses and made-up names. */
const enabled = process.env.NEOXIFY_DB_SPECS === "1" && !!process.env.DATABASE_URL;
const describeDb = enabled ? describe : describe.skip;
const DAY = 86_400_000;

describeDb("Released WireGuard addresses and a later renewal, against Postgres", () => {
  const prisma = new PrismaClient();
  const tag = randomUUID().slice(0, 8);
  const commands: { type: string; payload: Record<string, unknown> }[] = [];
  const agentGateway = {
    enqueueCommand: jest.fn(async (_nodeId: string, type: string, payload: Record<string, unknown>) => {
      commands.push({ type, payload });
      return Promise.resolve();
    }),
  };
  const users = new ProtocolUsersService(prisma as never, agentGateway as never, deviceSlotsStub() as never);
  const billing = new BillingService(
    prisma as never,
    users,
    {} as never,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const ids = { node: "", wgConfig: "", xrayConfig: "", wgRoute: "", xrayRoute: "", plan: "", customer: "", sub: "" };
  const saved = { mode: process.env.WG_EXPIRED_RELEASE, days: process.env.WG_EXPIRED_RELEASE_DAYS };

  beforeAll(async () => {
    const node = await prisma.node.create({
      data: { name: `wgr-${tag}`, region: "test", publicIp: "192.0.2.61", status: "ONLINE" },
    });
    ids.node = node.id;
    const wg = await prisma.protocolConfig.create({
      data: {
        nodeId: node.id,
        protocol: "WIREGUARD",
        listenPort: 51820,
        publicParamsJson: { serverPublicKey: "test-server-key", endpoint: "192.0.2.61:51820", subnetCidr: "10.250.7.0/24" },
      },
    });
    ids.wgConfig = wg.id;
    const xray = await prisma.protocolConfig.create({
      data: { nodeId: node.id, protocol: "XRAY_VLESS_REALITY", listenPort: 443, publicParamsJson: {} },
    });
    ids.xrayConfig = xray.id;
    ids.wgRoute = (await prisma.route.create({ data: { name: `wgr-${tag}-wg`, entryProtocolConfigId: wg.id } })).id;
    ids.xrayRoute = (await prisma.route.create({ data: { name: `wgr-${tag}-x`, entryProtocolConfigId: xray.id } })).id;
    ids.plan = (
      await prisma.subscriptionPlan.create({
        data: {
          name: `wgr-${tag}`,
          durationDays: 30,
          priceUsd: 1,
          protocolsAllowed: ["WIREGUARD", "XRAY_VLESS_REALITY"],
          allowedRoutes: { connect: [{ id: ids.wgRoute }, { id: ids.xrayRoute }] },
        },
      })
    ).id;
    ids.customer = (await prisma.customer.create({ data: { email: `wgr-${tag}@example.test` } })).id;
    ids.sub = (
      await prisma.subscription.create({
        data: { customerId: ids.customer, planId: ids.plan, status: "ACTIVE", expireAt: new Date(Date.now() + 5 * DAY) },
      })
    ).id;
  });

  afterAll(async () => {
    process.env.WG_EXPIRED_RELEASE = saved.mode;
    process.env.WG_EXPIRED_RELEASE_DAYS = saved.days;
    if (saved.mode === undefined) delete process.env.WG_EXPIRED_RELEASE;
    if (saved.days === undefined) delete process.env.WG_EXPIRED_RELEASE_DAYS;
    await prisma.protocolUser.deleteMany({ where: { subscriptionId: ids.sub } });
    await prisma.subscription.deleteMany({ where: { id: ids.sub } });
    await prisma.customer.deleteMany({ where: { id: ids.customer } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: ids.plan } });
    await prisma.route.deleteMany({ where: { id: { in: [ids.wgRoute, ids.xrayRoute] } } });
    await prisma.protocolConfig.deleteMany({ where: { nodeId: ids.node } });
    await prisma.node.deleteMany({ where: { id: ids.node } });
    await prisma.$disconnect();
  });

  it("releases the WireGuard row only, and a renewal provisions a fresh one with the other protocols untouched", async () => {
    // Provisioned while active, as a real subscription is.
    await users.provisionAll(ids.sub);
    const before = await prisma.protocolUser.findMany({
      where: { subscriptionId: ids.sub },
      select: { id: true, protocol: true, externalUserId: true, credentialsJson: true },
    });
    expect(before.map((u) => u.protocol).sort()).toEqual(["WIREGUARD", "XRAY_VLESS_REALITY"]);
    const oldWg = before.find((u) => u.protocol === "WIREGUARD")!;
    const xray = before.find((u) => u.protocol === "XRAY_VLESS_REALITY")!;

    // It lapses as the expiry sweep leaves it: EXPIRED, rows switched off.
    await prisma.subscription.update({
      where: { id: ids.sub },
      data: { status: "EXPIRED", expireAt: new Date(Date.now() - 10 * DAY) },
    });
    await prisma.protocolUser.updateMany({ where: { subscriptionId: ids.sub }, data: { status: "DISABLED" } });

    // Off: nothing. Dry: nothing. On: the WireGuard row goes.
    delete process.env.WG_EXPIRED_RELEASE;
    delete process.env.WG_EXPIRED_RELEASE_DAYS;
    await users.releaseExpiredWireGuard();
    process.env.WG_EXPIRED_RELEASE = "dry";
    await users.releaseExpiredWireGuard();
    expect(await prisma.protocolUser.count({ where: { subscriptionId: ids.sub } })).toBe(2);
    process.env.WG_EXPIRED_RELEASE = "on";
    commands.length = 0;
    await users.releaseExpiredWireGuard();
    const released = await prisma.protocolUser.findMany({ where: { subscriptionId: ids.sub }, select: { id: true } });
    expect(released.map((u) => u.id)).toEqual([xray.id]);
    expect(commands.filter((c) => c.payload.externalUserId === oldWg.externalUserId).map((c) => c.type)).toEqual([
      "DELETE_USER",
    ]);

    // The customer pays again.
    commands.length = 0;
    await (billing as unknown as { renewSubscription(s: string, t: string): Promise<void> }).renewSubscription(
      ids.sub,
      randomUUID(),
    );

    const after = await prisma.protocolUser.findMany({
      where: { subscriptionId: ids.sub },
      select: { id: true, protocol: true, status: true, externalUserId: true, credentialsJson: true, sessionId: true },
    });
    const newWg = after.find((u) => u.protocol === "WIREGUARD");
    expect(newWg).toBeDefined();
    expect(newWg!.status).toBe("ACTIVE");
    expect(newWg!.sessionId).toBeNull();
    expect(newWg!.externalUserId).not.toBe(oldWg.externalUserId);
    expect(decryptCredentials(newWg!.credentialsJson).address).toMatch(/^10\.250\.7\.\d+\/32$/);
    expect(commands.some((c) => c.type === "CREATE_USER" && c.payload.externalUserId === newWg!.externalUserId)).toBe(true);

    // The other protocol: the same row, the same credential, switched back on.
    const xrayAfter = after.find((u) => u.protocol === "XRAY_VLESS_REALITY")!;
    expect(xrayAfter.id).toBe(xray.id);
    expect(xrayAfter.externalUserId).toBe(xray.externalUserId);
    expect(xrayAfter.credentialsJson).toBe(xray.credentialsJson);
    expect(xrayAfter.status).toBe("ACTIVE");
    expect(after).toHaveLength(2);
  });
});
