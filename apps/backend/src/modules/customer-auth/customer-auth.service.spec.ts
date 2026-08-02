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
    emailVerificationCode: null,
    emailVerificationCodeExpiresAt: null,
    passwordResetCode: null,
    passwordResetCodeExpiresAt: null,
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
  let protocolUsersService: { create: jest.Mock; provisionAll: jest.Mock };
  let freeTrialSettingsService: { get: jest.Mock };
  let emailService: { sendMail: jest.Mock };

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), update: jest.fn() },
    };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn((key: string) => `config:${key}`) };
    customersService = { create: jest.fn() };
    subscriptionsService = { create: jest.fn() };
    protocolUsersService = { create: jest.fn(), provisionAll: jest.fn().mockResolvedValue([]) };
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
    it("creates the customer, sends exactly one email, and never issues a session", async () => {
      // One, not two. Signup used to also send a standalone welcome whose
      // whole content was "a separate verification email is on its way" --
      // no action for the customer, and twice as much mail for a spam
      // filter to judge. The welcome now lives inside this one.
      customersService.create.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("verify-token");

      const dto = { email: "customer@example.com", password: PASSWORD };
      const result = await service.register(dto as any);

      expect(customersService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ requiresVerification: true, email: "customer@example.com" });
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail.mock.calls[0][0]).toMatchObject({ to: "customer@example.com" });
    });

    it("stores a 6-digit verification code alongside the token", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("verify-token");

      await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: {
          emailVerificationCode: expect.stringMatching(/^\d{6}$/),
          emailVerificationCodeExpiresAt: expect.any(Date),
        },
      });
    });

    it("never grants a trial or contacts free-trial settings at registration time", async () => {
      customersService.create.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("token");

      await service.register({ email: "a@example.com", password: PASSWORD } as any);

      expect(freeTrialSettingsService.get).not.toHaveBeenCalled();
      expect(subscriptionsService.create).not.toHaveBeenCalled();
      expect(protocolUsersService.create).not.toHaveBeenCalled();
      expect(protocolUsersService.provisionAll).not.toHaveBeenCalled();
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

    it("marks the customer verified, clears the code, and returns trial: null when trial mode is disabled", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "verify-email" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));
      freeTrialSettingsService.get.mockResolvedValue({ enabled: false, trialPlanId: null, trialRouteId: null });

      const result = await service.verifyEmail("token");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: { emailVerifiedAt: expect.any(Date), emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
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
      // Every route the plan allows, so the client can fail over without
      // asking us. The operator's chosen trial route must still come
      // first in the response.
      protocolUsersService.provisionAll.mockResolvedValue([
        { id: "pu-2", routeId: "route-2", credentials: { uuid: "y" } },
        { id: "pu-1", routeId: "route-1", credentials: { uuid: "x" } },
      ]);

      const result = await service.verifyEmail("token");

      expect(subscriptionsService.create).toHaveBeenCalledWith({ customerId: "customer-1", planId: "plan-1" });
      expect(protocolUsersService.provisionAll).toHaveBeenCalledWith("sub-1");
      expect(result.trial).toEqual({
        subscription: { id: "sub-1" },
        protocolUsers: [
          { id: "pu-1", routeId: "route-1", credentials: { uuid: "x" } },
          { id: "pu-2", routeId: "route-2", credentials: { uuid: "y" } },
        ],
        protocolUser: { id: "pu-1", routeId: "route-1", credentials: { uuid: "x" } },
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

  describe("verifyEmailByCode", () => {
    it("rejects when no customer matches the email", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.verifyEmailByCode("nobody@example.com", "123456")).rejects.toThrow(BadRequestException);
    });

    it("rejects a wrong code", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({ emailVerificationCode: "111111", emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000) }),
      );
      await expect(service.verifyEmailByCode("customer@example.com", "222222")).rejects.toThrow(BadRequestException);
    });

    it("rejects an expired code", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({ emailVerificationCode: "111111", emailVerificationCodeExpiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.verifyEmailByCode("customer@example.com", "111111")).rejects.toThrow(BadRequestException);
    });

    // Reported from real use: verified by clicking the emailed link on a
    // phone, then typed the code into the app and was told it had
    // expired -- because verifying clears the code. The account was fine;
    // only the message was wrong, and it sent the customer chasing codes
    // that could never work.
    it("reports an already-verified account as verified, not as an expired code", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({
          emailVerifiedAt: new Date(),
          // Cleared by the earlier verification, which is exactly why the
          // code check alone reported failure.
          emailVerificationCode: null,
          emailVerificationCodeExpiresAt: null,
        }),
      );

      const result = await service.verifyEmailByCode("customer@example.com", "111111");

      expect(result.alreadyVerified).toBe(true);
      // No second trial for an account that already got one.
      expect(result.trial).toBeNull();
    });

    it("marks the customer verified and grants a trial on a correct, unexpired code", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({
          emailVerifiedAt: null,
          emailVerificationCode: "111111",
          emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
        }),
      );
      freeTrialSettingsService.get.mockResolvedValue({
        enabled: true,
        trialPlanId: "plan-1",
        trialRouteId: "route-1",
      });
      subscriptionsService.create.mockResolvedValue({ id: "sub-1" });
      protocolUsersService.provisionAll.mockResolvedValue([{ id: "pu-1", routeId: "route-1" }]);

      const result = await service.verifyEmailByCode("customer@example.com", "111111");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: { emailVerifiedAt: expect.any(Date), emailVerificationCode: null, emailVerificationCodeExpiresAt: null },
      });
      expect(result.trial).toEqual({
        subscription: { id: "sub-1" },
        protocolUsers: [{ id: "pu-1", routeId: "route-1" }],
        protocolUser: { id: "pu-1", routeId: "route-1" },
      });
    });
  });

  describe("resendVerification", () => {
    it("does nothing (no enumeration) when no customer matches the email", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await service.resendVerification("nobody@example.com");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("does nothing when the customer is already verified", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      await service.resendVerification("customer@example.com");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends a fresh verification email + code when unverified", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));
      jwt.signAsync.mockResolvedValue("verify-token");

      await service.resendVerification("customer@example.com");

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

    /** The code is looked up server-side, so unlike the self-verifying
     * token it only works if it was actually stored. */
    it("stores a six-digit code the customer can type", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      jwt.signAsync.mockResolvedValue("reset-token");

      await service.forgotPassword("customer@example.com");

      const { data } = prisma.customer.update.mock.calls[0][0] as {
        data: { passwordResetCode: string; passwordResetCodeExpiresAt: Date };
      };
      expect(data.passwordResetCode).toMatch(/^\d{6}$/);
      expect(data.passwordResetCodeExpiresAt.getTime()).toBeGreaterThan(Date.now());
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
        data: {
          passwordHash: expect.any(String),
          tokenVersion: { increment: 1 },
          // Cleared here too: a used code that still works is a second
          // key left under the mat for the rest of its lifetime.
          passwordResetCode: null,
          passwordResetCodeExpiresAt: null,
        },
      });
    });
  });

  /** The route the desktop app uses.
   *
   * It exists because the token route cannot reach a desktop client
   * reliably -- the token only ever arrived in a link, and webmail
   * strips the custom URI scheme those links used. Without this a
   * customer who forgot their password had no way back in at all.
   */
  describe("resetPasswordByCode", () => {
    const withCode = (overrides = {}) =>
      buildCustomer({
        passwordResetCode: "123456",
        passwordResetCodeExpiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      });

    it("resets the password when the code matches and is current", async () => {
      prisma.customer.findUnique.mockResolvedValue(withCode());

      await service.resetPasswordByCode("customer@example.com", "123456", "new-password");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: {
          passwordHash: expect.any(String),
          tokenVersion: { increment: 1 },
          passwordResetCode: null,
          passwordResetCodeExpiresAt: null,
        },
      });
    });

    it("rejects the wrong code", async () => {
      prisma.customer.findUnique.mockResolvedValue(withCode());
      await expect(
        service.resetPasswordByCode("customer@example.com", "000000", "new-password"),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("rejects a code that has expired", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        withCode({ passwordResetCodeExpiresAt: new Date(Date.now() - 1) }),
      );
      await expect(
        service.resetPasswordByCode("customer@example.com", "123456", "new-password"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when no reset was ever requested", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      await expect(
        service.resetPasswordByCode("customer@example.com", "123456", "new-password"),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a disabled account even with the right code", async () => {
      prisma.customer.findUnique.mockResolvedValue(withCode({ status: "DISABLED" }));
      await expect(
        service.resetPasswordByCode("customer@example.com", "123456", "new-password"),
      ).rejects.toThrow(BadRequestException);
    });

    /** Every failure has to look the same. A distinct "no such account"
     * would turn this endpoint into the account-enumeration oracle that
     * forgotPassword() goes to lengths to avoid being. */
    it("says the same thing whether the account exists or the code is wrong", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      const missing = await service
        .resetPasswordByCode("nobody@example.com", "123456", "new-password")
        .catch((e: Error) => e.message);

      prisma.customer.findUnique.mockResolvedValue(withCode());
      const wrong = await service
        .resetPasswordByCode("customer@example.com", "999999", "new-password")
        .catch((e: Error) => e.message);

      expect(missing).toBe(wrong);
    });
  });

  describe("changePassword", () => {
    it("refuses when the current password is wrong", async () => {
      // The caller is already authenticated, which is exactly why this
      // check exists: a borrowed or stolen session must not be enough to
      // lock the real owner out of their own account.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());

      await expect(
        service.changePassword("customer-1", {
          currentPassword: "not-the-right-one",
          newPassword: "a-brand-new-password",
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("stores a new hash and revokes every existing session", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));

      await service.changePassword("customer-1", {
        currentPassword: PASSWORD,
        newPassword: "a-brand-new-password",
      });

      const { data } = prisma.customer.update.mock.calls[0][0];
      expect(data.tokenVersion).toEqual({ increment: 1 });
      // The raw password must never reach the database.
      expect(data.passwordHash).not.toBe("a-brand-new-password");
      expect(data.passwordHash).toEqual(expect.stringContaining("$argon2"));
    });

    it("returns fresh tokens, since the change signs the caller out too", async () => {
      // Without these the app would log itself out on its very next
      // request -- the tokenVersion bump kills the caller's own session
      // along with everyone else's.
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      jwt.signAsync.mockResolvedValue("fresh-token");

      const result = await service.changePassword("customer-1", {
        currentPassword: PASSWORD,
        newPassword: "a-brand-new-password",
      });

      expect(result).toEqual({ accessToken: "fresh-token", refreshToken: "fresh-token" });
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
    it("returns requiresVerification instead of tokens for an unverified account (2026-07-24 decision)", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: null }));

      const result = await service.login("customer@example.com", PASSWORD);

      expect(result).toEqual({ requiresVerification: true, email: "customer@example.com" });
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it("returns a token pair for valid credentials on a verified account", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
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
