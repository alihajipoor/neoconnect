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
  let prisma: { customer: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  beforeEach(() => {
    prisma = {
      customer: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new CustomersService(prisma as any);
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

      const codes = prisma.customer.create.mock.calls.map((call) => call[0].data.referralCode);
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
  });
});
