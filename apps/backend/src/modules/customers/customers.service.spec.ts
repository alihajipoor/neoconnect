import { ConflictException, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { CustomersService } from "./customers.service";
import { encryptCredentials } from "../protocol-users/credentials-crypto";
import { KeyedLock } from "../protocol-users/keyed-lock";
import { deviceSlotsStub } from "../../../test/device-slots-stub";

/** A credential row as account deletion reads it. */
function credentialRow(id: string) {
  return {
    id,
    nodeId: "node-1",
    protocol: "XRAY_VLESS_REALITY",
    externalUserId: `ext-${id}`,
    credentialsJson: encryptCredentials({ uuid: `ext-${id}` }),
    protocolConfig: { transport: "TCP", inboundTag: null },
  };
}

/** A device's first fetch, as far as deletion can see it: it holds the
 * customer lock while it creates its own rows. */
function deviceFetchHolding(lock: KeyedLock, rows: unknown[], id: string) {
  return lock.run("customer-1", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    rows.push(credentialRow(id));
  });
}

function buildCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "customer-1",
    email: "customer@example.com",
    passwordHash: "hashed",
    telegramId: null,
    referralCode: "abcd1234",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("CustomersService", () => {
  let service: CustomersService;
  let prisma: {
    customer: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    paymentTransaction: { count: jest.Mock; deleteMany: jest.Mock };
    invoice: { deleteMany: jest.Mock };
    protocolUser: { findMany: jest.Mock; deleteMany: jest.Mock };
    subscription: { deleteMany: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
    supportTicket: { deleteMany: jest.Mock };
    voucherRedemption: { deleteMany: jest.Mock };
    referralReward: { deleteMany: jest.Mock };
    referralCredit: { deleteMany: jest.Mock };
    usageRecord: { deleteMany: jest.Mock };
    customerSession: { updateMany: jest.Mock };
    customerIdentity: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let agentGateway: { enqueueCommand: jest.Mock };
  let protocolUsers: {
    endSessions: jest.Mock;
    withCustomerLock: jest.Mock;
    switchOffCustomer: jest.Mock;
    provisionAll: jest.Mock;
  };
  let lock: KeyedLock;
  let deviceSlots: ReturnType<typeof deviceSlotsStub>;

  beforeEach(() => {
    prisma = {
      customer: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      paymentTransaction: { count: jest.fn().mockResolvedValue(0), deleteMany: jest.fn() },
      invoice: { deleteMany: jest.fn() },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      // updateMany as well as deleteMany: self-deletion cancels
      // subscriptions rather than removing them, because the surviving
      // invoices point at them.
      subscription: { deleteMany: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      // What refused an admin delete on a foreign key: all four point at
      // the customer with no ON DELETE.
      supportTicket: { deleteMany: jest.fn() },
      voucherRedemption: { deleteMany: jest.fn() },
      referralReward: { deleteMany: jest.fn() },
      referralCredit: { deleteMany: jest.fn() },
      usageRecord: { deleteMany: jest.fn() },
      customerSession: { updateMany: jest.fn() },
      customerIdentity: { deleteMany: jest.fn() },
      // The real $transaction takes an array of prepared operations; the
      // mocked members above are plain jest.fn()s, so simply resolving is
      // enough to assert which ones were queued.
      $transaction: jest.fn().mockResolvedValue([]),
    };
    agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    // The real lock, so a test can hold it the way a device fetch does.
    lock = new KeyedLock();
    deviceSlots = deviceSlotsStub();
    protocolUsers = {
      endSessions: jest.fn().mockResolvedValue({ sessions: 0, revoked: 0 }),
      withCustomerLock: jest.fn((id: string, work: () => Promise<unknown>) => lock.run(id, work)),
      switchOffCustomer: jest.fn().mockResolvedValue({ switchedOff: 0, failed: 0 }),
      provisionAll: jest.fn().mockResolvedValue({ created: [], revoked: [], failed: [] }),
    };
    service = new CustomersService(prisma as any, agentGateway as any, protocolUsers as any, deviceSlots as any);
  });

  describe("get", () => {
    it("throws NotFoundException when the customer doesn't exist", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.get("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("create", () => {
    it("throws ConflictException when the email is already taken", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      await expect(service.create({ email: "customer@example.com", password: "password123" })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("hashes the password and generates a referral code", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      prisma.customer.create.mockResolvedValue(buildCustomer());

      await service.create({ email: "new@example.com", password: "password123" });

      const createArgs = prisma.customer.create.mock.calls[0][0];
      expect(createArgs.data.passwordHash).not.toBe("password123");
      await expect(argon2.verify(createArgs.data.passwordHash, "password123")).resolves.toBe(true);
      // 4 random bytes hex-encoded -> 8 hex chars.
      expect(createArgs.data.referralCode).toMatch(/^[0-9a-f]{8}$/);
    });

    it("generates a different referral code on each call", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      prisma.customer.create.mockResolvedValue(buildCustomer());

      await service.create({ email: "a@example.com", password: "password123" });
      await service.create({ email: "b@example.com", password: "password123" });

      const codes = (prisma.customer.create.mock.calls as { data: { referralCode: string } }[][]).map(
        (call) => call[0].data.referralCode,
      );
      expect(codes[0]).not.toEqual(codes[1]);
    });
  });

  describe("update", () => {
    it("throws NotFoundException when the customer doesn't exist", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.update("missing", {})).rejects.toThrow(NotFoundException);
    });

    it("updates fields for an existing customer", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ status: "SUSPENDED" }));

      const result = await service.update("customer-1", { status: "SUSPENDED" as any });

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "customer-1" }, data: { status: "SUSPENDED" } }),
      );
      expect(result.status).toBe("SUSPENDED");
      // Not a password change, so no device is signed out.
      expect(protocolUsers.endSessions).not.toHaveBeenCalled();
    });

    // An admin setting a password is usually answering "someone else is in
    // my account": the refresh tokens stop with tokenVersion, and the VPN
    // credentials issued to those devices have to stop too.
    it("ends every device session, credentials included, when it sets a password", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer());

      await service.update("customer-1", { password: "a-new-password" } as any);

      expect(protocolUsers.endSessions).toHaveBeenCalledWith("customer-1");
    });

    /** Without this a device the admin had just signed out went on showing
     * as "in use" to the customer's next device -- a refusal naming a PC
     * that could no longer connect. Every device's slot goes: the admin's
     * request is none of them. */
    it("frees every device's slot when it sets a password, and not otherwise", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer());

      await service.update("customer-1", { status: "SUSPENDED" as any });
      expect(deviceSlots.releaseOtherSessions).not.toHaveBeenCalled();

      await service.update("customer-1", { password: "a-new-password" } as any);
      expect(deviceSlots.releaseOtherSessions).toHaveBeenCalledWith("customer-1");
    });

    // Written with the password, so a failure taking the credentials back
    // cannot leave the sessions live as well.
    it("revokes the sessions in the same transaction as the password, and survives the credential step failing", async () => {
      const saved = buildCustomer();
      prisma.customer.findUnique.mockResolvedValue(saved);
      prisma.$transaction.mockResolvedValue([saved, { count: 2 }]);
      protocolUsers.endSessions.mockRejectedValue(new Error("database went away"));

      await expect(service.update("customer-1", { password: "a-new-password" } as any)).resolves.toBe(saved);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  /** DISABLED is what the panel's Status control sets and what remove()
   * tells an operator to use to cut someone off. It used to write the
   * column and nothing else: the app kept refreshing, kept its
   * credentials, and every one stayed on its node until the subscription
   * ran out. */
  describe("update to DISABLED", () => {
    it("revokes every session and bumps tokenVersion with the status, in one transaction", async () => {
      const saved = buildCustomer({ status: "DISABLED" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.$transaction.mockResolvedValue([saved, { count: 2 }]);

      await expect(service.update("customer-1", { status: "DISABLED" as any })).resolves.toBe(saved);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.customer.update.mock.calls[0][0].data).toEqual({
        status: "DISABLED",
        tokenVersion: { increment: 1 },
      });
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("takes the device credentials back, switches the rest off on their nodes, and frees the slots", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.update("customer-1", { status: "DISABLED" as any });

      expect(protocolUsers.endSessions).toHaveBeenCalledWith("customer-1");
      expect(protocolUsers.switchOffCustomer).toHaveBeenCalledWith("customer-1");
      expect(deviceSlots.releaseCustomer).toHaveBeenCalledWith("customer-1");
    });

    it("still disables when the nodes cannot be told yet", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.$transaction.mockResolvedValue([buildCustomer({ status: "DISABLED" }), { count: 0 }]);
      protocolUsers.endSessions.mockRejectedValue(new Error("database went away"));
      protocolUsers.switchOffCustomer.mockRejectedValue(new Error("database went away"));
      jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);

      await expect(service.update("customer-1", { status: "DISABLED" as any })).resolves.toMatchObject({
        status: "DISABLED",
      });
      expect(deviceSlots.releaseCustomer).toHaveBeenCalled();
    });

    /** An account disabled before disabling revoked anything still has
     * its credentials on the nodes; saving it as DISABLED again is what
     * takes them off. Before, this did nothing. */
    it("switches an already-disabled account off again when it is saved as DISABLED", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ status: "DISABLED" }));

      await service.update("customer-1", { status: "DISABLED" as any });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(protocolUsers.switchOffCustomer).toHaveBeenCalledWith("customer-1");
      expect(protocolUsers.endSessions).toHaveBeenCalledWith("customer-1");
      expect(deviceSlots.releaseCustomer).toHaveBeenCalledWith("customer-1");
    });

    it("switches nothing off for an edit that does not set the status", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ status: "DISABLED" }));
      prisma.customer.update.mockResolvedValue(buildCustomer({ status: "DISABLED" }));

      await service.update("customer-1", { telegramId: "12345" } as any);

      expect(protocolUsers.switchOffCustomer).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    /** Its credentials come back with the re-assert; the routes added
     * while it was off are provisioned now. */
    it("provisions an account made ACTIVE again, and switches nothing off", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ status: "DISABLED" }));
      prisma.customer.update.mockResolvedValue(buildCustomer());
      prisma.subscription.findMany.mockResolvedValue([{ id: "sub-1" }]);

      await service.update("customer-1", { status: "ACTIVE" as any });

      expect(prisma.subscription.findMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", status: "ACTIVE" },
        select: { id: true },
      });
      expect(protocolUsers.provisionAll).toHaveBeenCalledWith("sub-1");
      expect(protocolUsers.switchOffCustomer).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("throws NotFoundException when the customer doesn't exist", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.remove("missing")).rejects.toThrow(NotFoundException);
      expect(prisma.customer.delete).not.toHaveBeenCalled();
    });

    it("deletes the customer when it exists", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      await service.remove("customer-1");
      expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: "customer-1" } });
    });

    it("clears the subscriptions and credentials that blocked the delete", async () => {
      // A bare customer.delete() hit a foreign key violation for any
      // customer who had ever had a subscription -- i.e. every real one --
      // and surfaced as a raw 500 in the panel.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.remove("customer-1");

      expect(prisma.usageRecord.deleteMany).toHaveBeenCalled();
      expect(prisma.protocolUser.deleteMany).toHaveBeenCalled();
      expect(prisma.subscription.deleteMany).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("tells the node to drop each credential before deleting it", async () => {
      // Removing only the database rows would leave the credential
      // working on the engine while the panel shows the customer gone.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.protocolUser.findMany.mockResolvedValue([
        {
          id: "pu-1",
          nodeId: "node-1",
          protocol: "WIREGUARD",
          externalUserId: "peer-key",
          credentialsJson: encryptCredentials({ privateKey: "secret", address: "10.66.0.9/32" }),
          protocolConfig: { transport: "TCP", inboundTag: null },
        },
      ]);

      await service.remove("customer-1");

      // The address travels so the node can clear the peer's speed cap;
      // the private key never does.
      expect(agentGateway.enqueueCommand).toHaveBeenCalledWith("node-1", "DELETE_USER", {
        protocol: "WIREGUARD",
        transport: "TCP",
        externalUserId: "peer-key",
        credentials: { address: "10.66.0.9/32" },
      });
    });

    // Untargeted, a delete for a WebSocket or relay customer landed on the
    // node's default inbound, was acked, and left the credential working.
    it("aims each delete at the customer's own inbound", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.protocolUser.findMany.mockResolvedValue([
        {
          id: "pu-ws",
          nodeId: "node-1",
          protocol: "XRAY_VLESS_TLS",
          externalUserId: "uuid-ws",
          credentialsJson: encryptCredentials({ uuid: "uuid-ws" }),
          protocolConfig: { transport: "WS", inboundTag: null },
        },
        {
          id: "pu-relay",
          nodeId: "ir-1",
          protocol: "XRAY_VLESS_REALITY",
          externalUserId: "uuid-relay",
          credentialsJson: encryptCredentials({ uuid: "uuid-relay" }),
          protocolConfig: { transport: "TCP", inboundTag: "vless-in-fr" },
        },
      ]);

      await service.remove("customer-1");

      expect(agentGateway.enqueueCommand.mock.calls.map((c) => c[2])).toEqual([
        { protocol: "XRAY_VLESS_TLS", transport: "WS", externalUserId: "uuid-ws" },
        { protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: "vless-in-fr", externalUserId: "uuid-relay" },
      ]);
    });

    /** Each of these points at the customer with no ON DELETE, so any
     * customer who had opened a ticket, redeemed a code or taken part in a
     * referral could never be deleted: the transaction failed on a foreign
     * key and the panel showed a raw 500. */
    it("removes the support tickets, voucher redemptions and referral rows that refused the delete", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.supportTicket.deleteMany.mockReturnValue("tickets-op");
      prisma.voucherRedemption.deleteMany.mockReturnValue("redemptions-op");
      prisma.referralReward.deleteMany.mockReturnValue("rewards-op");
      prisma.referralCredit.deleteMany.mockReturnValue("credits-op");
      prisma.customer.delete.mockReturnValue("customer-op");

      await service.remove("customer-1");

      expect(prisma.supportTicket.deleteMany).toHaveBeenCalledWith({ where: { customerId: "customer-1" } });
      expect(prisma.voucherRedemption.deleteMany).toHaveBeenCalledWith({ where: { customerId: "customer-1" } });
      expect(prisma.referralReward.deleteMany).toHaveBeenCalledWith({ where: { referrerId: "customer-1" } });
      expect(prisma.referralCredit.deleteMany).toHaveBeenCalledWith({ where: { referredCustomerId: "customer-1" } });
      // In the one transaction, and before the customer row itself.
      const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
      for (const op of ["tickets-op", "redemptions-op", "rewards-op", "credits-op"]) {
        expect(ops.indexOf(op)).toBeGreaterThanOrEqual(0);
        expect(ops.indexOf(op)).toBeLessThan(ops.indexOf("customer-op"));
      }
    });

    /** The slots used to be wiped before a transaction that could fail,
     * leaving a customer who still existed with every device's slot gone. */
    it("frees the device slots only once the delete has committed", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.subscription.findMany.mockResolvedValue([{ id: "sub-1" }, { id: "sub-2" }]);
      prisma.$transaction.mockRejectedValueOnce(new Error("database went away"));

      await expect(service.remove("customer-1")).rejects.toThrow(/database went away/);
      expect(deviceSlots.releaseSubscription).not.toHaveBeenCalled();
      expect(deviceSlots.releaseCustomer).not.toHaveBeenCalled();

      await service.remove("customer-1");
      expect(deviceSlots.releaseSubscription.mock.calls.map((c) => c[0])).toEqual(["sub-1", "sub-2"]);
    });

    it("refuses to delete a customer who has completed payments", async () => {
      // Financial records must survive, and deletion must not become a
      // way to erase an audit trail.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.paymentTransaction.count.mockResolvedValue(3);

      await expect(service.remove("customer-1")).rejects.toThrow(/completed payment/i);
      expect(prisma.customer.delete).not.toHaveBeenCalled();
      expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    });

    it("counts only settled payments, so an abandoned checkout is still deletable", async () => {
      // Reported from real use: pressing a payment button and not
      // finishing left a PENDING row that made the account permanently
      // undeletable. Nothing financial happened, so nothing needs
      // preserving.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.paymentTransaction.count.mockResolvedValue(0);

      await service.remove("customer-1");

      const where = prisma.paymentTransaction.count.mock.calls[0][0].where;
      expect(where.status.in).toEqual(["CONFIRMED", "REFUNDED"]);
      expect(prisma.customer.delete).toHaveBeenCalled();
    });
  });

  describe("deleteOwnAccount", () => {
    it("revokes the credential on every node, not just the first", async () => {
      // The security-critical property. Since failover began giving each
      // customer a credential on every eligible route, one account holds
      // several spread across nodes -- and any this misses keeps working
      // indefinitely, with nothing to report it.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      const target = { transport: "TCP", inboundTag: null };
      prisma.protocolUser.findMany.mockResolvedValue([
        { nodeId: "node-a", protocol: "WIREGUARD", externalUserId: "wg-1", credentialsJson: encryptCredentials({ address: "10.66.0.2/32" }), protocolConfig: target },
        { nodeId: "node-b", protocol: "XRAY_VLESS_TLS", externalUserId: "xr-1", credentialsJson: encryptCredentials({ uuid: "xr-1" }), protocolConfig: { transport: "WS", inboundTag: null } },
        { nodeId: "node-c", protocol: "IKEV2", externalUserId: "ike-1", credentialsJson: encryptCredentials({ username: "ike-1" }), protocolConfig: target },
      ]);

      const result = await service.deleteOwnAccount("customer-1");

      expect(agentGateway.enqueueCommand).toHaveBeenCalledTimes(3);
      expect(agentGateway.enqueueCommand.mock.calls.map((c) => c[0])).toEqual(["node-a", "node-b", "node-c"]);
      // Each on the customer's own inbound: the WebSocket one included.
      expect(agentGateway.enqueueCommand.mock.calls[1][2]).toEqual({
        protocol: "XRAY_VLESS_TLS",
        transport: "WS",
        externalUserId: "xr-1",
      });
      expect(result.credentialsRevoked).toBe(3);
    });

    it("succeeds for a customer with settled payments, unlike the admin delete", async () => {
      // Both stores require deletion to be available. "You have paid us,
      // so you may not leave" is not an answer we are allowed to give,
      // even though remove() rightly refuses it for an operator purge.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.paymentTransaction.count.mockResolvedValue(4);

      await expect(service.deleteOwnAccount("customer-1")).resolves.toEqual(
        expect.objectContaining({ deleted: true }),
      );
    });

    it("anonymises rather than deleting, so financial records survive", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      expect(prisma.customer.delete).not.toHaveBeenCalled();
      expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
      expect(prisma.paymentTransaction.deleteMany).not.toHaveBeenCalled();

      const data = prisma.customer.update.mock.calls[0][0].data;
      expect(data.email).toMatch(/^deleted-.*@deleted\.invalid$/);
      expect(data.telegramId).toBeNull();
      expect(data.status).toBe("DISABLED");
    });

    it("bumps tokenVersion, so existing sessions die immediately", async () => {
      // Without this the app keeps working until the access token
      // expires -- a deleted account still carrying traffic.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      expect(prisma.customer.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
    });

    it("leaves a password that argon2 can reject rather than choke on", async () => {
      // A sentinel string would make argon2.verify throw, turning a
      // login attempt against a deleted account into a 500 instead of a
      // clean rejection.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      const hash = prisma.customer.update.mock.calls[0][0].data.passwordHash;
      await expect(argon2.verify(hash, "whatever the customer used to type")).resolves.toBe(false);
    });

    it("throws NotFoundException for an account that is already gone", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.deleteOwnAccount("missing")).rejects.toThrow(NotFoundException);
      expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    });

    /** Device credentials are minted on a plain GET. One landing between
     * deletion's read and its transaction used to be deleted from the
     * database with no DELETE_USER -- live on its node, with no row. */
    it("waits for a device fetch in flight, so the credential it mints is taken off the node too", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      const rows: unknown[] = [credentialRow("shared")];
      prisma.protocolUser.findMany.mockImplementation(() => Promise.resolve([...rows]));

      const fetch = deviceFetchHolding(lock, rows, "device");
      const deletion = service.deleteOwnAccount("customer-1");
      await Promise.all([fetch, deletion]);

      expect(agentGateway.enqueueCommand.mock.calls.map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
        "ext-shared",
        "ext-device",
      ]);
      await expect(deletion).resolves.toEqual({ deleted: true, credentialsRevoked: 2 });
    });

    it("frees every device slot of the deleted account", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      expect(deviceSlots.releaseCustomer).toHaveBeenCalledWith("customer-1");
    });

    // An access token lives fifteen minutes past tokenVersion; with the
    // session revoked it can neither fetch nor mint anything.
    it("revokes every signed-in device in the same transaction", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    /** The provider links held the subject and the real address the
     * provider gave, kept past a deletion that promises to remove them --
     * and every later "Continue with Google" by the same person found the
     * disabled account by subject and was refused for good. */
    it("removes the Google, Apple and Facebook links in the same transaction", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customerIdentity.deleteMany.mockReturnValue("identity-delete-op");

      await service.deleteOwnAccount("customer-1");

      expect(prisma.customerIdentity.deleteMany).toHaveBeenCalledWith({ where: { customerId: "customer-1" } });
      expect(prisma.$transaction.mock.calls[0][0]).toContain("identity-delete-op");
    });

    it("clears what every device called itself, signed out earlier or now", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await service.deleteOwnAccount("customer-1");

      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1" },
        data: { label: null, platform: null },
      });
    });
  });

  describe("remove, with devices fetching", () => {
    it("waits for a device fetch in flight, so the credential it mints is taken off the node too", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      const rows: unknown[] = [credentialRow("shared")];
      prisma.protocolUser.findMany.mockImplementation(() => Promise.resolve([...rows]));

      const fetch = deviceFetchHolding(lock, rows, "device");
      const removal = service.remove("customer-1");
      await Promise.all([fetch, removal]);

      expect(agentGateway.enqueueCommand.mock.calls.map((c) => (c[2] as { externalUserId: string }).externalUserId)).toEqual([
        "ext-shared",
        "ext-device",
      ]);
    });
  });
});
