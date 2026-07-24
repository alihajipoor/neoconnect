import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PlansService } from "./plans.service";

function buildPlan(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "plan-1",
    name: "Basic",
    dataCapBytes: 100n,
    durationDays: 30,
    priceUsd: 5,
    maxConcurrentConnections: 3,
    protocolsAllowed: ["XRAY_VLESS_REALITY"],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const baseDto = {
  name: "Basic",
  dataCapBytes: "100",
  durationDays: 30,
  priceUsd: 5,
  protocolsAllowed: ["XRAY_VLESS_REALITY"] as any,
};

describe("PlansService", () => {
  let service: PlansService;
  let prisma: {
    subscriptionPlan: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    subscription: { count: jest.Mock };
    freeTrialSettings: { findFirst: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      subscriptionPlan: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      subscription: { count: jest.fn() },
      freeTrialSettings: { findFirst: jest.fn() },
    };
    service = new PlansService(prisma as any);
  });

  describe("list", () => {
    it("orders by price ascending", async () => {
      prisma.subscriptionPlan.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith({ orderBy: { priceUsd: "asc" } });
    });
  });

  describe("get", () => {
    it("throws NotFoundException when the plan doesn't exist", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
      await expect(service.get("missing")).rejects.toThrow(NotFoundException);
    });

    it("returns the plan when found", async () => {
      const plan = buildPlan();
      prisma.subscriptionPlan.findUnique.mockResolvedValue(plan);
      await expect(service.get("plan-1")).resolves.toEqual(plan);
    });
  });

  describe("create", () => {
    it("converts dataCapBytes from a decimal string to a BigInt", async () => {
      prisma.subscriptionPlan.create.mockResolvedValue(buildPlan());
      await service.create(baseDto);
      const createArgs = prisma.subscriptionPlan.create.mock.calls[0][0];
      expect(createArgs.data.dataCapBytes).toBe(100n);
      expect(typeof createArgs.data.dataCapBytes).toBe("bigint");
    });

    it("defaults isActive to true when omitted", async () => {
      prisma.subscriptionPlan.create.mockResolvedValue(buildPlan());
      await service.create(baseDto);
      expect(prisma.subscriptionPlan.create.mock.calls[0][0].data.isActive).toBe(true);
    });

    it("respects an explicit isActive: false", async () => {
      prisma.subscriptionPlan.create.mockResolvedValue(buildPlan({ isActive: false }));
      await service.create({ ...baseDto, isActive: false });
      expect(prisma.subscriptionPlan.create.mock.calls[0][0].data.isActive).toBe(false);
    });
  });

  describe("update", () => {
    it("throws NotFoundException when the plan doesn't exist", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
      await expect(service.update("missing", {})).rejects.toThrow(NotFoundException);
    });

    it("converts dataCapBytes when provided", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(buildPlan());
      prisma.subscriptionPlan.update.mockResolvedValue(buildPlan());
      await service.update("plan-1", { dataCapBytes: "200" });
      expect(prisma.subscriptionPlan.update.mock.calls[0][0].data.dataCapBytes).toBe(200n);
    });

    it("leaves dataCapBytes undefined (not touched) when omitted", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(buildPlan());
      prisma.subscriptionPlan.update.mockResolvedValue(buildPlan());
      await service.update("plan-1", { name: "Renamed" });
      expect(prisma.subscriptionPlan.update.mock.calls[0][0].data.dataCapBytes).toBeUndefined();
      expect(prisma.subscriptionPlan.update.mock.calls[0][0].data.name).toBe("Renamed");
    });
  });

  describe("remove", () => {
    it("throws NotFoundException when the plan doesn't exist", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);
      await expect(service.remove("missing")).rejects.toThrow(NotFoundException);
      expect(prisma.subscriptionPlan.delete).not.toHaveBeenCalled();
    });

    it("deletes the plan when no subscriptions reference it and it's not the trial plan", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(buildPlan());
      prisma.subscription.count.mockResolvedValue(0);
      prisma.freeTrialSettings.findFirst.mockResolvedValue(null);
      await service.remove("plan-1");
      expect(prisma.subscriptionPlan.delete).toHaveBeenCalledWith({ where: { id: "plan-1" } });
    });

    it("throws BadRequestException and does not delete when subscriptions still reference it", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(buildPlan());
      prisma.subscription.count.mockResolvedValue(2);
      prisma.freeTrialSettings.findFirst.mockResolvedValue(null);
      await expect(service.remove("plan-1")).rejects.toThrow(BadRequestException);
      expect(prisma.subscriptionPlan.delete).not.toHaveBeenCalled();
    });

    it("throws BadRequestException and does not delete when it's the configured trial plan", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(buildPlan());
      prisma.subscription.count.mockResolvedValue(0);
      prisma.freeTrialSettings.findFirst.mockResolvedValue({ id: "settings-1", trialPlanId: "plan-1" });
      await expect(service.remove("plan-1")).rejects.toThrow(BadRequestException);
      expect(prisma.subscriptionPlan.delete).not.toHaveBeenCalled();
    });
  });
});
