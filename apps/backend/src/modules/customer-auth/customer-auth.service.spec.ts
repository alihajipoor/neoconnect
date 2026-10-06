import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { CustomerAuthService } from "./customer-auth.service";
import { deviceSlotsStub } from "../../../test/device-slots-stub";

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
  let prisma: {
    customer: { findUnique: jest.Mock; update: jest.Mock };
    // The trial grant now refuses anyone who already has a subscription,
    // which is what makes it safe to retry after a failure.
    subscription: { count: jest.Mock };
    // One row per signed-in device; see CustomerSession.
    customerSession: { create: jest.Mock; deleteMany: jest.Mock; updateMany: jest.Mock };
    // Password changes write the password and the session revocation
    // together.
    $transaction: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let customersService: { create: jest.Mock };
  let subscriptionsService: { create: jest.Mock };
  let protocolUsersService: {
    create: jest.Mock;
    provisionAll: jest.Mock;
    revokeSessionCredentials: jest.Mock;
    endSessions: jest.Mock;
  };
  let freeTrialSettingsService: { get: jest.Mock };
  let referralsService: { resolveReferralCode: jest.Mock; notifyReferrerOfActivation: jest.Mock };
  let emailService: { sendMail: jest.Mock };
  let deviceSlots: ReturnType<typeof deviceSlotsStub>;

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), update: jest.fn() },
      subscription: { count: jest.fn().mockResolvedValue(0) },
      customerSession: {
        create: jest.fn().mockResolvedValue({ id: "session-1" }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // The array form: each operation is one of the mocks above, already
      // called, so resolving them together is what the real one returns.
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn((key: string) => `config:${key}`) };
    customersService = { create: jest.fn() };
    subscriptionsService = { create: jest.fn() };
    protocolUsersService = {
      create: jest.fn(),
      provisionAll: jest.fn().mockResolvedValue({ created: [], revoked: [] }),
      revokeSessionCredentials: jest.fn().mockResolvedValue({ revoked: 0, failed: 0 }),
      endSessions: jest.fn().mockResolvedValue({ sessions: 0, revoked: 0 }),
    };
    freeTrialSettingsService = { get: jest.fn() };
    // Resolves to "no referrer" by default, which is what the existing
    // cases here describe. A test that cares supplies its own.
    referralsService = {
      resolveReferralCode: jest.fn().mockResolvedValue(null),
      notifyReferrerOfActivation: jest.fn().mockResolvedValue(undefined),
    };
    emailService = { sendMail: jest.fn().mockResolvedValue(true) };
    deviceSlots = deviceSlotsStub();

    service = new CustomerAuthService(
      prisma as any,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      customersService as any,
      subscriptionsService as any,
      protocolUsersService as any,
      freeTrialSettingsService as any,
      referralsService as any,
      emailService as any,
      deviceSlots as any,
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
      protocolUsersService.provisionAll.mockResolvedValue({
        created: [
          { id: "pu-2", routeId: "route-2", credentials: { uuid: "y" } },
          { id: "pu-1", routeId: "route-1", credentials: { uuid: "x" } },
        ],
        revoked: [],
      });

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
      protocolUsersService.provisionAll.mockResolvedValue({ created: [{ id: "pu-1", routeId: "route-1" }], revoked: [] });

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

    /**
     * A six-digit code guarded only by a per-IP throttle is guessable by
     * anyone with a few hundred addresses: 5/minute each, across the
     * code's thirty-minute life, is six figures of attempts aimed at one
     * chosen account. Counting misses against the ACCOUNT is what sees
     * that; the per-IP limit never can.
     */
    describe("guess budget", () => {
      const wrongGuess = () =>
        service
          .resetPasswordByCode("customer@example.com", "000000", "new-password")
          .catch(() => undefined);

      it("burns the code after five wrong guesses, whatever address they come from", async () => {
        prisma.customer.findUnique.mockResolvedValue(withCode());

        for (let i = 0; i < 4; i += 1) await wrongGuess();
        expect(prisma.customer.update).not.toHaveBeenCalled();

        await wrongGuess();
        expect(prisma.customer.update).toHaveBeenCalledWith({
          where: { id: "customer-1" },
          data: { passwordResetCode: null, passwordResetCodeExpiresAt: null },
        });
      });

      it("says nothing different on the guess that burns it", async () => {
        // An attacker who could tell "wrong" from "wrong, and spent"
        // would know exactly when to ask for a fresh window.
        prisma.customer.findUnique.mockResolvedValue(withCode());
        const messages: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          messages.push(
            await service
              .resetPasswordByCode("customer@example.com", "000000", "new-password")
              .then(() => "resolved")
              .catch((e: Error) => e.message),
          );
        }
        expect(new Set(messages).size).toBe(1);
      });

      it("gives a newly requested code a fresh budget", async () => {
        // Otherwise a customer who fumbled five times would find the
        // replacement burned on its first typo, which is a lockout by
        // another name.
        prisma.customer.findUnique.mockResolvedValue(withCode());
        for (let i = 0; i < 4; i += 1) await wrongGuess();

        await service.forgotPassword("customer@example.com");
        prisma.customer.update.mockClear();

        for (let i = 0; i < 4; i += 1) await wrongGuess();
        expect(prisma.customer.update).not.toHaveBeenCalled();
      });

      it("does not count misses for an address with no live code", async () => {
        // The map would otherwise be growable by anyone naming strangers.
        prisma.customer.findUnique.mockResolvedValue(null);
        for (let i = 0; i < 10; i += 1) {
          await service
            .resetPasswordByCode("nobody@example.com", "000000", "x")
            .catch(() => undefined);
        }
        expect(prisma.customer.update).not.toHaveBeenCalled();
      });
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

  describe("per-device sessions", () => {
    it("puts a new session in both tokens on sign-in", async () => {
      jwt.signAsync.mockResolvedValue("signed");
      await service.issueTokenPair({ id: "customer-1", email: "a@b.c", tokenVersion: 0 });

      expect(prisma.customerSession.create).toHaveBeenCalledWith({
        data: { customerId: "customer-1" },
        select: { id: true },
      });
      const [access, refresh] = jwt.signAsync.mock.calls.map((c) => c[0]);
      expect(access).toMatchObject({ sub: "customer-1", sid: "session-1" });
      expect(refresh).toMatchObject({ sub: "customer-1", tokenVersion: 0, sid: "session-1" });
    });

    it("keeps a device's session across a refresh instead of opening another", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0, sid: "session-7" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 0 }));
      jwt.signAsync.mockResolvedValue("signed");

      await service.refresh("token");

      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "session-7", customerId: "customer-1", revokedAt: null } }),
      );
      expect(prisma.customerSession.create).not.toHaveBeenCalled();
      expect(jwt.signAsync.mock.calls[1][0]).toMatchObject({ sid: "session-7" });
    });

    it("refuses to refresh a session that has been signed out", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0, sid: "session-7" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 0 }));
      prisma.customerSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("moves a token from before sessions onto a session of its own", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0 });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 0 }));
      jwt.signAsync.mockResolvedValue("signed");

      await service.refresh("token");
      expect(prisma.customerSession.create).toHaveBeenCalled();
    });

    // The owner's requirement, pinned: signing out on one device must not
    // sign out any other. The old logout bumped tokenVersion, which ends
    // every device's refresh token.
    it("signs out only this device, never the others", async () => {
      await service.revokeSession("customer-1", "session-7");

      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { id: "session-7", customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("revokes nothing server-side for a token from before sessions", async () => {
      await service.revokeSession("customer-1", undefined);

      expect(prisma.customerSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(protocolUsersService.revokeSessionCredentials).not.toHaveBeenCalled();
    });

    // The point of per-device credentials: signing out takes this
    // device's VPN credentials off the nodes, and only this device's.
    it("takes this device's VPN credentials back on sign-out, after revoking the session", async () => {
      const order: string[] = [];
      prisma.customerSession.updateMany.mockImplementation(() => {
        order.push("session");
        return Promise.resolve({ count: 1 });
      });
      protocolUsersService.revokeSessionCredentials.mockImplementation(() => {
        order.push("credentials");
        return Promise.resolve({ revoked: 3, failed: 0 });
      });

      await service.revokeSession("customer-1", "session-7");

      expect(protocolUsersService.revokeSessionCredentials).toHaveBeenCalledWith("customer-1", "session-7");
      expect(protocolUsersService.endSessions).not.toHaveBeenCalled();
      // Session first: if the node commands fail, the session already
      // cannot mint a new set.
      expect(order).toEqual(["session", "credentials"]);
    });

    it("still signs out when the credentials cannot be revoked yet", async () => {
      protocolUsersService.revokeSessionCredentials.mockRejectedValue(new Error("database went away"));

      await expect(service.revokeSession("customer-1", "session-7")).resolves.toBeUndefined();
      expect(prisma.customerSession.updateMany).toHaveBeenCalled();
    });

    // What "Neoxify is in use on Windows PC" on the customer's other
    // devices is read from.
    it("names a new session after the device that signed in", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      jwt.signAsync.mockResolvedValue("signed");

      await service.login("customer@example.com", PASSWORD, { label: "Windows PC", platform: "windows" });

      expect(prisma.customerSession.create).toHaveBeenCalledWith({
        data: { customerId: "customer-1", label: "Windows PC", platform: "windows" },
        select: { id: true },
      });
    });

    // The browser sign-in flow opens its session where no headers can be
    // sent; its first refresh names it. A refresh that sends nothing must
    // not erase a name.
    it("names a session on refresh when the app says what it is, and leaves the name alone when it does not", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", tokenVersion: 0, sid: "session-7" });
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ tokenVersion: 0 }));
      jwt.signAsync.mockResolvedValue("signed");

      await service.refresh("token", { label: "Android phone", platform: "android" });
      await service.refresh("token", { label: null, platform: null });

      expect(prisma.customerSession.updateMany.mock.calls[0][0].data).toEqual({
        lastUsedAt: expect.any(Date),
        label: "Android phone",
        platform: "android",
      });
      expect(prisma.customerSession.updateMany.mock.calls[1][0].data).toEqual({ lastUsedAt: expect.any(Date) });
    });

    // A signed-out device is not using the VPN; its plan slot is free.
    it("gives a signed-out device's slot back", async () => {
      await service.revokeSession("customer-1", "session-7");

      expect(deviceSlots.releaseSession).toHaveBeenCalledWith("customer-1", "session-7");
    });

    it("gives the ended devices' slots back on a password change, keeping the caller's", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      jwt.signAsync.mockResolvedValue("signed");

      await service.changePassword(
        "customer-1",
        { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
        "session-7",
      );

      expect(deviceSlots.releaseOtherSessions).toHaveBeenCalledWith("customer-1", "session-7");
    });

    // A session still holding credentials has to give them back on the
    // nodes first, which the sweep does. Deleting it here would be refused
    // by the foreign key -- and fail the sign-in.
    it("never prunes a session that still holds device credentials on sign-in", async () => {
      jwt.signAsync.mockResolvedValue("signed");
      await service.issueTokenPair({ id: "customer-1", email: "a@b.c", tokenVersion: 0 });

      expect(prisma.customerSession.deleteMany.mock.calls[0][0].where).toMatchObject({
        customerId: "customer-1",
        protocolUsers: { none: {} },
      });
    });
  });

  describe("password changes end other devices' credentials", () => {
    it("a reset ends every session, credentials included", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "password-reset" });

      await service.resetPassword("token", "a-brand-new-password");

      expect(protocolUsersService.endSessions).toHaveBeenCalledWith("customer-1", undefined);
    });

    it("a change keeps the caller's session and its tunnel, and ends the others", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      prisma.customerSession.updateMany.mockResolvedValue({ count: 1 });
      jwt.signAsync.mockResolvedValue("signed");

      await service.changePassword(
        "customer-1",
        { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
        "session-7",
      );

      expect(protocolUsersService.endSessions).toHaveBeenCalledWith("customer-1", "session-7");
      // The caller's own session carries on rather than a new one opening,
      // which would orphan the credentials its tunnel is running on.
      expect(prisma.customerSession.create).not.toHaveBeenCalled();
      expect(jwt.signAsync.mock.calls[0][0]).toMatchObject({ sid: "session-7" });
    });

    /** The revocation used to be the first statement of the best-effort
     * endSessions: a database error there was logged and swallowed, the
     * reset went through, and the devices it was meant to lock out kept
     * their sessions -- and their credentials, for as long as they used
     * them. */
    it("a reset revokes every session in the same transaction as the password", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "customer-1", purpose: "password-reset" });
      protocolUsersService.endSessions.mockRejectedValue(new Error("database went away"));

      await expect(service.resetPassword("token", "a-brand-new-password")).resolves.toBeUndefined();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("a change revokes every other session in the same transaction as the password", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      prisma.customerSession.updateMany.mockResolvedValue({ count: 1 });
      jwt.signAsync.mockResolvedValue("signed");

      await service.changePassword(
        "customer-1",
        { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
        "session-7",
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null, id: { not: "session-7" } },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("a change from a signed-out or pre-session token opens a new session and ends all others", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      prisma.customer.update.mockResolvedValue(buildCustomer({ tokenVersion: 1 }));
      prisma.customerSession.updateMany.mockResolvedValue({ count: 0 });
      jwt.signAsync.mockResolvedValue("signed");

      await service.changePassword(
        "customer-1",
        { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
        "session-7",
      );

      expect(protocolUsersService.endSessions).toHaveBeenCalledWith("customer-1", undefined);
      expect(prisma.customerSession.create).toHaveBeenCalled();
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
