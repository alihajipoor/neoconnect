import { ConflictException, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { AdminsService } from "./admins.service";

function buildAdmin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "admin-1",
    email: "admin@example.com",
    passwordHash: "hashed",
    role: "SUPPORT",
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("AdminsService", () => {
  let service: AdminsService;
  let prisma: { adminUser: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  beforeEach(() => {
    prisma = {
      adminUser: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new AdminsService(prisma as any);
  });

  describe("list", () => {
    it("delegates to prisma with a safe select and stable ordering", async () => {
      const admin = buildAdmin();
      prisma.adminUser.findMany.mockResolvedValue([admin]);
      const result = await service.list();
      expect(result).toEqual([admin]);
      expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: "asc" } }),
      );
      // passwordHash must never be selected back out to a caller.
      const call = prisma.adminUser.findMany.mock.calls[0][0];
      expect(call.select.passwordHash).toBeUndefined();
    });
  });

  describe("get", () => {
    it("throws NotFoundException when the admin doesn't exist", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.get("missing")).rejects.toThrow(NotFoundException);
    });

    it("returns the admin when found", async () => {
      const admin = buildAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      await expect(service.get("admin-1")).resolves.toEqual(admin);
    });
  });

  describe("create", () => {
    it("throws ConflictException when the email is already taken", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin());
      await expect(
        service.create({ email: "admin@example.com", password: "password123", role: "SUPPORT" as any }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.adminUser.create).not.toHaveBeenCalled();
    });

    it("hashes the password before persisting", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      prisma.adminUser.create.mockResolvedValue(buildAdmin());

      await service.create({ email: "new@example.com", password: "password123", role: "SUPPORT" as any });

      const createArgs = prisma.adminUser.create.mock.calls[0][0];
      expect(createArgs.data.passwordHash).not.toBe("password123");
      await expect(argon2.verify(createArgs.data.passwordHash, "password123")).resolves.toBe(true);
    });
  });

  describe("update", () => {
    it("throws NotFoundException when the admin doesn't exist", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.update("missing", {})).rejects.toThrow(NotFoundException);
    });

    it("rotates tokenVersion when the password changes", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin());
      prisma.adminUser.update.mockResolvedValue(buildAdmin());

      await service.update("admin-1", { password: "new-password-123" });

      const updateArgs = prisma.adminUser.update.mock.calls[0][0];
      expect(updateArgs.data.tokenVersion).toEqual({ increment: 1 });
      expect(updateArgs.data.passwordHash).toBeDefined();
    });

    it("does not touch tokenVersion or passwordHash for a role-only update", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin());
      prisma.adminUser.update.mockResolvedValue(buildAdmin());

      await service.update("admin-1", { role: "SUPERADMIN" as any });

      const updateArgs = prisma.adminUser.update.mock.calls[0][0];
      expect(updateArgs.data.tokenVersion).toBeUndefined();
      expect(updateArgs.data.passwordHash).toBeUndefined();
      expect(updateArgs.data.role).toBe("SUPERADMIN");
    });
  });

  describe("remove", () => {
    it("throws NotFoundException when the admin doesn't exist", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.remove("missing")).rejects.toThrow(NotFoundException);
      expect(prisma.adminUser.delete).not.toHaveBeenCalled();
    });

    it("deletes the admin when it exists", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin());
      await service.remove("admin-1");
      expect(prisma.adminUser.delete).toHaveBeenCalledWith({ where: { id: "admin-1" } });
    });
  });
});
