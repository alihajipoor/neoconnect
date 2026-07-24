import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { CustomerAuthService } from "./customer-auth.service";

// Password hashing is real argon2, not mocked -- same reasoning as
// auth.service.spec.ts: this is the logic that decides whether a login
// attempt succeeds, so mocking it would test nothing meaningful.
const PASSWORD = "correct-password";
let PASSWORD_HASH: string;

function buildCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "customer-1",
    email: "customer@example.com",
    passwordHash: PASSWORD_HASH,
    telegramId: null,
    referralCode: "abcd1234",
    status: "ACTIVE",
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("CustomerAuthService", () => {
  let service: CustomerAuthService;
  let prisma: { customer: { findUnique: jest.Mock; update: jest.Mock } };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let customersService: { create: jest.Mock };
  let subscriptionsService: { create: jest.Mock };
  let protocolUsersService: { create: jest.Mock };
  let freeTrialSettingsService: { get: jest.Mock };

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = { customer: { findUnique: jest.fn(), update: jest.fn() } };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn((key: string) => `config:${key}`) };
    customersService = { create: jest.fn() };
    subscriptionsService = { create: jest.fn() };
    protocolUsersService = { create: jest.fn() };
    freeTrialSettingsService = { get: jest.fn() };

    service = new CustomerAuthService(
      prisma as any,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      customersService as any,
      subscriptionsService as any,
      protocolUsersService as any,
      freeTrialSettingsService as any,
    );
  });

  describe("register", () => {
    it("creates the customer via CustomersService and issues tokens", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      freeTrialSettingsService.get.mockResolvedValue({ enabled: false, trialPlanId: null, trialRouteId: null });
      jwt.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token");

      const dto = { email: "customer@example.com", password: PASSWORD };
      const result = await service.register(dto as any);

      expect(customersService.create).toHaveBeenCalledWith(dto);
      expect(result.accessToken).toBe("access-token");
      expect(result.refreshToken).toBe("refresh-token");
    });

    it("returns trial: null when free trial mode is disabled", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      freeTrialSettingsService.get.mockResolvedValue({ enabled: false, trialPlanId: null, trialRouteId: null });
      jwt.signAsync.mockResolvedValue("token");

      const result = await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(result.trial).toBeNull();
      expect(subscriptionsService.create).not.toHaveBeenCalled();
      expect(protocolUsersService.create).not.toHaveBeenCalled();
    });

    it("returns trial: null when enabled but plan/route aren't configured", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      freeTrialSettingsService.get.mockResolvedValue({ enabled: true, trialPlanId: null, trialRouteId: null });
      jwt.signAsync.mockResolvedValue("token");

      const result = await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(result.trial).toBeNull();
    });

    it("grants a trial subscription + protocol user when enabled and configured", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      freeTrialSettingsService.get.mockResolvedValue({
        enabled: true,
        trialPlanId: "plan-1",
        trialRouteId: "route-1",
      });
      subscriptionsService.create.mockResolvedValue({ id: "sub-1" });
      protocolUsersService.create.mockResolvedValue({ id: "pu-1", credentials: { uuid: "x" } });
      jwt.signAsync.mockResolvedValue("token");

      const result = await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(subscriptionsService.create).toHaveBeenCalledWith({ customerId: "customer-1", planId: "plan-1" });
      expect(protocolUsersService.create).toHaveBeenCalledWith({ subscriptionId: "sub-1", routeId: "route-1" });
      expect(result.trial).toEqual({
        subscription: { id: "sub-1" },
        protocolUser: { id: "pu-1", credentials: { uuid: "x" } },
      });
    });
  });

  describe("validateCredentials", () => {
    it("throws when no customer exists for the email", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.validateCredentials("nobody@example.com", PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("throws when the password is wrong", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      await expect(service.validateCredentials("customer@example.com", "wrong-password")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("throws when the customer account is disabled", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ status: "DISABLED" }));
      await expect(service.validateCredentials("customer@example.com", PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns the customer row when credentials are correct and active", async () => {
      const customer = buildCustomer();
      prisma.customer.findUnique.mockResolvedValue(customer);
      await expect(service.validateCredentials("customer@example.com", PASSWORD)).resolves.toEqual(customer);
    });
  });

  describe("login", () => {
    it("returns a token pair for valid credentials", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token");

      const result = await service.login("customer@example.com", PASSWORD);

      expect(result).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
    });
  });

  describe("refresh", () => {
    it("rejects an invalid refresh token", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("expired"));
      await expect(service.refresh("garbage")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a refresh token whose tokenVersion has been revoked", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0 });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      await expect(service.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("issues a fresh token pair for a valid, unrevoked refresh token", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0 });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 0 }));
      jwt.signAsync.mockResolvedValueOnce("access-token-2").mockResolvedValueOnce("refresh-token-2");

      const result = await service.refresh("token");
      expect(result).toEqual({ accessToken: "access-token-2", refreshToken: "refresh-token-2" });
    });
  });

  describe("revokeAllSessions", () => {
    it("increments tokenVersion for the given customer", async () => {
      await service.revokeAllSessions("customer-1");
      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: { tokenVersion: { increment: 1 } },
      });
    });
  });
});
