import { ConflictException, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { CustomersService } from "./customers.service";

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
    paymentTransaction: { count: jest.Mock };
    protocolUser: { findMany: jest.Mock; deleteMany: jest.Mock };
    subscription: { deleteMany: jest.Mock };
    usageRecord: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let agentGateway: { enqueueCommand: jest.Mock };

  beforeEach(() => {
    prisma = {
      customer: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      paymentTransaction: { count: jest.fn().mockResolvedValue(0) },
      protocolUser: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      subscription: { deleteMany: jest.fn() },
      usageRecord: { deleteMany: jest.fn() },
      // The real $transaction takes an array of prepared operations; the
      // mocked members above are plain jest.fn()s, so simply resolving is
      // enough to assert which ones were queued.
      $transaction: jest.fn().mockResolvedValue([]),
    };
    agentGateway = { enqueueCommand: jest.fn().mockResolvedValue(undefined) };
    service = new CustomersService(prisma as any, agentGateway as any);
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
        { id: "pu-1", nodeId: "node-1", protocol: "WIREGUARD", externalUserId: "peer-key" },
      ]);

      await service.remove("customer-1");

      expect(agentGateway.enqueueCommand).toHaveBeenCalledWith("node-1", "DELETE_USER", {
        protocol: "WIREGUARD",
        externalUserId: "peer-key",
      });
    });

    it("refuses to delete a customer who has payment history", async () => {
      // Financial records must survive, and deletion must not become a
      // way to erase an audit trail.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.paymentTransaction.count.mockResolvedValue(3);

      await expect(service.remove("customer-1")).rejects.toThrow(/payment transaction/i);
      expect(prisma.customer.delete).not.toHaveBeenCalled();
      expect(agentGateway.enqueueCommand).not.toHaveBeenCalled();
    });
  });
});
