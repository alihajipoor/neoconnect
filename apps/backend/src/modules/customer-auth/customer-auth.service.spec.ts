import { BadRequestException, UnauthorizedException } from "@nestjs/common";
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
    emailVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("CustomerAuthService", () => {
  let service: CustomerAuthService;
  let prisma: { customer: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let customersService: { create: jest.Mock };
  let subscriptionsService: { create: jest.Mock };
  let protocolUsersService: { create: jest.Mock };
  let freeTrialSettingsService: { get: jest.Mock };
  let emailService: { sendMail: jest.Mock };

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn((key: string) => `config:${key}`) };
    customersService = { create: jest.fn() };
    subscriptionsService = { create: jest.fn() };
    protocolUsersService = { create: jest.fn() };
    freeTrialSettingsService = { get: jest.fn() };
    emailService = { sendMail: jest.fn().mockResolvedValue(true) };

    service = new CustomerAuthService(
      prisma as any,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      customersService as any,
      subscriptionsService as any,
      protocolUsersService as any,
      freeTrialSettingsService as any,
      emailService as any,
    );
  });

  describe("register", () => {
    it("creates the customer, issues tokens, and sends welcome + verification emails", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token").mockResolvedValue(
        "verify-token",
      );

      const dto = { email: "customer@example.com", password: PASSWORD };
      const result = await service.register(dto as any);

      expect(customersService.create).toHaveBeenCalledWith(dto);
      expect(result.accessToken).toBe("access-token");
      expect(result.refreshToken).toBe("refresh-token");
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
      expect(emailService.sendMail.mock.calls[1][0]).toMatchObject({ to: "customer@example.com" });
    });

    it("never grants a trial at registration time, even when trial mode is enabled", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("token");

      const result = await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(result.trial).toBeNull();
      expect(freeTrialSettingsService.get).not.toHaveBeenCalled();
      expect(subscriptionsService.create).not.toHaveBeenCalled();
      expect(protocolUsersService.create).not.toHaveBeenCalled();
    });
  });

  describe("verifyEmail", () => {
    it("rejects an invalid/expired token", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("expired"));
      await expect(service.verifyEmail("garbage")).rejects.toThrow(BadRequestException);
    });

    it("rejects a token whose purpose isn't verify-email", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "password-reset" });
      await expect(service.verifyEmail("token")).rejects.toThrow(BadRequestException);
    });

    it("marks the customer verified and returns trial: null when trial mode is disabled", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "verify-email" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));
      freeTrialSettingsService.get.mockResolvedValue({ enabled: false, trialPlanId: null, trialRouteId: null });

      const result = await service.verifyEmail("token");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: { emailVerifiedAt: expect.any(Date) },
      });
      expect(result.alreadyVerified).toBe(false);
      expect(result.trial).toBeNull();
    });

    it("grants a trial subscription + protocol user when verifying with trial mode enabled and configured", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "verify-email" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));
      freeTrialSettingsService.get.mockResolvedValue({
        enabled: true,
        trialPlanId: "plan-1",
        trialRouteId: "route-1",
      });
      subscriptionsService.create.mockResolvedValue({ id: "sub-1" });
      protocolUsersService.create.mockResolvedValue({ id: "pu-1", credentials: { uuid: "x" } });

      const result = await service.verifyEmail("token");

      expect(subscriptionsService.create).toHaveBeenCalledWith({ customerId: "customer-1", planId: "plan-1" });
      expect(protocolUsersService.create).toHaveBeenCalledWith({ subscriptionId: "sub-1", routeId: "route-1" });
      expect(result.trial).toEqual({
        subscription: { id: "sub-1" },
        protocolUser: { id: "pu-1", credentials: { uuid: "x" } },
      });
    });

    it("is idempotent -- verifying an already-verified customer doesn't grant a second trial", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "verify-email" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));

      const result = await service.verifyEmail("token");

      expect(result.alreadyVerified).toBe(true);
      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(subscriptionsService.create).not.toHaveBeenCalled();
    });
  });

  describe("resendVerification", () => {
    it("throws when the customer is already verified", async () => {
      prisma.customer.findUniqueOrThrow.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      await expect(service.resendVerification("customer-1")).rejects.toThrow(BadRequestException);
    });

    it("sends a fresh verification email when unverified", async () => {
      prisma.customer.findUniqueOrThrow.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));
      jwt.signAsync.mockResolvedValue("verify-token");

      await service.resendVerification("customer-1");

      expect(emailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "customer@example.com" }));
    });
  });

  describe("forgotPassword", () => {
    it("sends nothing when no customer matches the email (no enumeration)", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await service.forgotPassword("nobody@example.com");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends a reset email when a matching active customer exists", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("reset-token");

      await service.forgotPassword("customer@example.com");

      expect(emailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "customer@example.com" }));
    });
  });

  describe("resetPassword", () => {
    it("rejects an invalid/expired token", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("expired"));
      await expect(service.resetPassword("garbage", "new-password")).rejects.toThrow(BadRequestException);
    });

    it("rejects a token whose purpose isn't password-reset", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "verify-email" });
      await expect(service.resetPassword("token", "new-password")).rejects.toThrow(BadRequestException);
    });

    it("updates the password hash and bumps tokenVersion", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "password-reset" });

      await service.resetPassword("token", "new-password");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: { passwordHash: expect.any(String), tokenVersion: { increment: 1 } },
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
