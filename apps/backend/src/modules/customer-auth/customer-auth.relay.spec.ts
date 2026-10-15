/* eslint-disable @typescript-eslint/no-unsafe-call -- the Prisma stand-in is
   a loose object, as the eslint config allows for spec mocks. */
import { BadRequestException, ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { CustomerAuthService } from "./customer-auth.service";
import { hashRecoveryCode, recoveryCodeMatches } from "./recovery-code";
import { deviceSlotsStub } from "../../../test/device-slots-stub";

/** Sign-up and sign-in through the Iranian relay of last resort, and the
 * recovery paths that go with them (docs/relay-last-resort.md R3, R4).
 * Real argon2, as in customer-auth.service.spec.ts. */

const PASSWORD = "correct-password";
let PASSWORD_HASH: string;
const MINUTE = 60_000;

function buildCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "customer-1",
    email: "customer@example.com",
    passwordHash: PASSWORD_HASH,
    referralCode: "abcd1234",
    status: "ACTIVE",
    tokenVersion: 0,
    emailVerifiedAt: null as Date | null,
    emailVerificationCode: null,
    emailVerificationCodeExpiresAt: null,
    passwordResetCode: null,
    passwordResetCodeExpiresAt: null,
    relayUnverifiedSince: null as Date | null,
    recoveryCodeHash: null as string | null,
    relayMailAt: null,
    locale: "en",
    ...overrides,
  };
}

describe("CustomerAuthService over the relay", () => {
  let service: CustomerAuthService;
  let prisma: any;
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let customersService: { create: jest.Mock };
  let subscriptionsService: { create: jest.Mock };
  let protocolUsersService: any;
  let freeTrialSettingsService: { get: jest.Mock };
  let referralsService: { resolveReferralCode: jest.Mock; notifyReferrerOfActivation: jest.Mock };
  let emailService: { sendMail: jest.Mock };
  let deviceSlots: ReturnType<typeof deviceSlotsStub>;
  let relay: { takeRelayMail: jest.Mock; holdsSessionsOf: jest.Mock };

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = {
      customer: {
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve(buildCustomer(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: { count: jest.fn().mockResolvedValue(0) },
      customerSession: {
        create: jest.fn().mockResolvedValue({ id: "session-new" }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ createdAt: new Date() }),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue("signed"), verifyAsync: jest.fn() };
    customersService = { create: jest.fn().mockResolvedValue(buildCustomer()) };
    subscriptionsService = { create: jest.fn() };
    protocolUsersService = {
      provisionAll: jest.fn().mockResolvedValue({ created: [] }),
      revokeSessionCredentials: jest.fn().mockResolvedValue({ revoked: 0, failed: 0 }),
      endSessions: jest.fn().mockResolvedValue({ sessions: 0, revoked: 0 }),
    };
    freeTrialSettingsService = { get: jest.fn().mockResolvedValue({ enabled: false, trialPlanId: null, trialRouteId: null }) };
    referralsService = {
      resolveReferralCode: jest.fn().mockResolvedValue("referrer-1"),
      notifyReferrerOfActivation: jest.fn().mockResolvedValue(undefined),
    };
    emailService = { sendMail: jest.fn().mockResolvedValue(true) };
    deviceSlots = deviceSlotsStub();
    relay = { takeRelayMail: jest.fn().mockResolvedValue(true), holdsSessionsOf: jest.fn().mockResolvedValue(false) };

    service = new CustomerAuthService(
      prisma,
      jwt as unknown as JwtService,
      { get: jest.fn((key: string) => `config:${key}`) } as unknown as ConfigService,
      customersService as any,
      subscriptionsService as any,
      protocolUsersService,
      freeTrialSettingsService as any,
      referralsService as any,
      emailService as any,
      deviceSlots as any,
      relay as any,
    );
  });

  const relayDto = (overrides = {}) => ({
    email: "new@example.com",
    emailConfirm: "new@example.com",
    password: PASSWORD,
    referralCode: "friend01",
    locale: "fa" as const,
    ...overrides,
  });

  describe("relay sign-up", () => {
    it("opens the account at once, unverified, with a recovery code and nothing else", async () => {
      customersService.create.mockResolvedValue(buildCustomer({ id: "c-new", email: "new@example.com" }));

      const result = await service.relayRegister(relayDto());

      expect(customersService.create).toHaveBeenCalledWith({ email: "new@example.com", password: PASSWORD });
      const update = prisma.customer.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: "c-new" });
      expect(update.data).toMatchObject({
        signupChannel: "RELAY",
        relayUnverifiedSince: expect.any(Date),
        locale: "fa",
        recoveryCodeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        recoveryCodeSetAt: expect.any(Date),
      });
      expect(update.data.emailVerifiedAt).toBeUndefined();
      expect(recoveryCodeMatches(result.recoveryCode, update.data.recoveryCodeHash)).toBe(true);
      expect(result).toMatchObject({ accessToken: "signed", refreshToken: "signed", relayUnverified: true });
      // The session is the relay's.
      expect(prisma.customerSession.create).toHaveBeenCalledWith({
        data: { customerId: "c-new", channel: "RELAY" },
        select: { id: true },
      });
      // No mail, no referral, no trial.
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(referralsService.resolveReferralCode).not.toHaveBeenCalled();
      expect(update.data.referredByCustomerId).toBeUndefined();
      expect(subscriptionsService.create).not.toHaveBeenCalled();
      expect(freeTrialSettingsService.get).not.toHaveBeenCalled();
    });

    it("wants the address typed twice", async () => {
      await expect(service.relayRegister(relayDto({ emailConfirm: "nwe@example.com" }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(customersService.create).not.toHaveBeenCalled();
    });

    it("refuses a throwaway address", async () => {
      const err = await service
        .relayRegister(relayDto({ email: "x@mailinator.com", emailConfirm: "x@mailinator.com" }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: "DISPOSABLE_EMAIL" });
      expect(customersService.create).not.toHaveBeenCalled();
    });

    it("refuses an address already in use with a 409, as normal sign-up does", async () => {
      customersService.create.mockRejectedValue(new ConflictException("A customer with this email already exists"));
      await expect(service.relayRegister(relayDto())).rejects.toBeInstanceOf(ConflictException);
    });

    it("leaves normal sign-up as it was, apart from saying which door it came in by", async () => {
      jwt.signAsync.mockResolvedValue("verify-token");
      const result = await service.register({ email: "customer@example.com", password: PASSWORD } as any);
      expect(result).toEqual({ requiresVerification: true, email: "customer@example.com" });
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(prisma.customer.update.mock.calls[0][0].data).toMatchObject({ signupChannel: "NORMAL" });
    });
  });

  describe("sign-in", () => {
    it("still asks an unverified account to verify on the normal routes (I1)", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      expect(await service.login("customer@example.com", PASSWORD)).toEqual({
        requiresVerification: true,
        email: "customer@example.com",
      });
      expect(prisma.customerSession.create).not.toHaveBeenCalled();
    });

    it("lets an unverified account in over the relay from Iran, and marks it relay-unverified (R4.2)", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer());
      const result = await service.login("customer@example.com", PASSWORD, undefined, {
        channel: "RELAY",
        allowUnverified: true,
      });
      expect(result).toEqual({ accessToken: "signed", refreshToken: "signed" });
      expect(prisma.customer.updateMany).toHaveBeenCalledWith({
        where: { id: "customer-1", relayUnverifiedSince: null },
        data: { relayUnverifiedSince: expect.any(Date) },
      });
      expect(prisma.customerSession.create).toHaveBeenCalledWith({
        data: { customerId: "customer-1", channel: "RELAY" },
        select: { id: true },
      });
      // No trial for an unverified account.
      expect(subscriptionsService.create).not.toHaveBeenCalled();
    });

    it("holds an unverified account to three sessions, signing out the least recently used", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ relayUnverifiedSince: new Date() }));
      prisma.customerSession.findMany.mockResolvedValue([
        { id: "s-recent" },
        { id: "s-middle" },
        { id: "s-oldest" },
      ]);
      await service.login("customer@example.com", PASSWORD, undefined, { channel: "RELAY", allowUnverified: true });

      expect(prisma.customerSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { lastUsedAt: "desc" } }),
      );
      expect(protocolUsersService.revokeSessionCredentials).toHaveBeenCalledTimes(1);
      expect(protocolUsersService.revokeSessionCredentials).toHaveBeenCalledWith("customer-1", "s-oldest");
      expect(prisma.customerSession.create).toHaveBeenCalled();
    });

    it("puts no cap on a verified account's sessions, and records the relay as the way in", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      prisma.customerSession.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
      await service.login("customer@example.com", PASSWORD, undefined, { channel: "RELAY", allowUnverified: false });
      expect(protocolUsersService.revokeSessionCredentials).not.toHaveBeenCalled();
      expect(prisma.customerSession.create).toHaveBeenCalledWith({
        data: { customerId: "customer-1", channel: "RELAY" },
        select: { id: true },
      });
    });

    it("keeps idle sessions during an intranet for a customer holding a relay plan (R4.5)", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      relay.holdsSessionsOf.mockResolvedValue(true);
      await service.login("customer@example.com", PASSWORD);
      expect(prisma.customerSession.deleteMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", OR: [{ revokedAt: { not: null } }], protocolUsers: { none: {} } },
      });
    });
  });

  describe("mail to relay-unverified accounts", () => {
    const relayAccount = () => buildCustomer({ relayUnverifiedSince: new Date() });

    it("sends a verification code only while the relay's mail allowance says so", async () => {
      prisma.customer.findUnique.mockResolvedValue(relayAccount());
      relay.takeRelayMail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await service.resendVerification("customer@example.com");
      await service.resendVerification("customer@example.com");
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it("sends a reset code only while the allowance says so", async () => {
      prisma.customer.findUnique.mockResolvedValue(relayAccount());
      relay.takeRelayMail.mockResolvedValue(false);
      await service.forgotPassword("customer@example.com");
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });
  });

  describe("reset by emailed code", () => {
    it("proves the mailbox: an unverified account becomes verified, and every session ends (R3.8)", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({
          relayUnverifiedSince: new Date(),
          passwordResetCode: "123456",
          passwordResetCodeExpiresAt: new Date(Date.now() + MINUTE),
        }),
      );
      await service.resetPasswordByCode("customer@example.com", "123456", "new-password");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "customer-1" },
        data: expect.objectContaining({ emailVerifiedAt: expect.any(Date), tokenVersion: { increment: 1 } }),
      });
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // What follows a first verification: the trial rule and the referrer.
      expect(freeTrialSettingsService.get).toHaveBeenCalled();
      expect(referralsService.notifyReferrerOfActivation).toHaveBeenCalledWith("customer-1");
    });

    it("leaves a verified account's verification date alone", async () => {
      const at = new Date(2026, 0, 1);
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({
          emailVerifiedAt: at,
          passwordResetCode: "123456",
          passwordResetCodeExpiresAt: new Date(Date.now() + MINUTE),
        }),
      );
      await service.resetPasswordByCode("customer@example.com", "123456", "new-password");
      expect(prisma.customer.update.mock.calls[0][0].data.emailVerifiedAt).toBeUndefined();
      expect(referralsService.notifyReferrerOfActivation).not.toHaveBeenCalled();
    });
  });

  describe("reset by recovery code (R4.3)", () => {
    const CODE = "ABCD-EFGH-IJKL-MNOP";

    it("resets the password, ends every session and hands out a new code", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({ email: "rc1@example.com", recoveryCodeHash: hashRecoveryCode(CODE) }),
      );
      const result = await service.resetPasswordByRecoveryCode("rc1@example.com", "abcd efgh ijkl mnop", "new-password");

      // The old code is spent in one conditional write...
      const spend = prisma.customer.updateMany.mock.calls[0][0];
      expect(spend.where).toEqual({ id: "customer-1", recoveryCodeHash: hashRecoveryCode(CODE) });
      expect(recoveryCodeMatches(result.recoveryCode, spend.data.recoveryCodeHash)).toBe(true);
      expect(recoveryCodeMatches(CODE, spend.data.recoveryCodeHash)).toBe(false);
      // ...and the password changes as any reset changes it.
      const data = prisma.customer.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ tokenVersion: { increment: 1 } });
      expect(await argon2.verify(data.passwordHash, "new-password")).toBe(true);
      // It proves the code, not the mailbox.
      expect(data.emailVerifiedAt).toBeUndefined();
      expect(prisma.customerSession.updateMany).toHaveBeenCalledWith({
        where: { customerId: "customer-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("says the same thing for a wrong code, a missing code and no account", async () => {
      const messages: string[] = [];
      for (const found of [
        buildCustomer({ email: "rc2@example.com", recoveryCodeHash: hashRecoveryCode(CODE) }),
        buildCustomer({ email: "rc2@example.com" }),
        null,
      ]) {
        prisma.customer.findUnique.mockResolvedValue(found);
        const err = await service
          .resetPasswordByRecoveryCode("rc2@example.com", "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "new-password")
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        messages.push((err as Error).message);
      }
      expect(new Set(messages).size).toBe(1);
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("shares the emailed reset code's guess budget", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        buildCustomer({
          email: "rc3@example.com",
          recoveryCodeHash: hashRecoveryCode(CODE),
          passwordResetCode: "123456",
          passwordResetCodeExpiresAt: new Date(Date.now() + MINUTE),
        }),
      );
      for (let i = 0; i < 10; i += 1) {
        await service.resetPasswordByRecoveryCode("rc3@example.com", "ZZZZ-ZZZZ-ZZZZ-ZZZZ", "x").catch(() => undefined);
      }
      // The right recovery code and the right emailed code are both refused now.
      await expect(service.resetPasswordByRecoveryCode("rc3@example.com", CODE, "new-password")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.resetPasswordByCode("rc3@example.com", "123456", "new-password")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("recovery code in Settings", () => {
    it("needs the current password, and stores only a hash", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      await expect(service.createRecoveryCode("customer-1", "session-1", "wrong-password")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const { recoveryCode } = await service.createRecoveryCode("customer-1", "session-1", PASSWORD);
      const data = prisma.customer.update.mock.calls[0][0].data;
      expect(recoveryCodeMatches(recoveryCode, data.recoveryCodeHash)).toBe(true);
      expect(JSON.stringify(data)).not.toContain(recoveryCode);
    });

    it("asks a social-only account for a fresh sign-in instead", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ passwordHash: null, emailVerifiedAt: new Date() }));
      prisma.customerSession.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 60 * MINUTE) });
      const err = await service.createRecoveryCode("customer-1", "session-1", undefined).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "REAUTH_REQUIRED" });

      prisma.customerSession.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - MINUTE) });
      await expect(service.createRecoveryCode("customer-1", "session-1", undefined)).resolves.toHaveProperty(
        "recoveryCode",
      );
    });
  });

  describe("set a password (social-only accounts)", () => {
    it("sets one where there was none, on a fresh sign-in", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ passwordHash: null, emailVerifiedAt: new Date() }));
      await service.setPassword("customer-1", "session-1", "brand-new-password");
      const data = prisma.customer.update.mock.calls[0][0].data;
      expect(await argon2.verify(data.passwordHash, "brand-new-password")).toBe(true);
    });

    it("refuses an account that already has one", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ emailVerifiedAt: new Date() }));
      await expect(service.setPassword("customer-1", "session-1", "brand-new-password")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("refuses a session that is not a fresh sign-in", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ passwordHash: null, emailVerifiedAt: new Date() }));
      prisma.customerSession.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 60 * MINUTE) });
      await expect(service.setPassword("customer-1", "session-1", "brand-new-password")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });
  });

  describe("changing an unverified address", () => {
    const body = (email = "fixed@example.com") => ({ email, emailConfirm: email, password: PASSWORD });

    it("moves the account, forgets the old address's codes, and keeps the session", async () => {
      prisma.customer.findUnique
        .mockResolvedValueOnce(buildCustomer({ id: "c-move-1", relayUnverifiedSince: new Date() }))
        .mockResolvedValueOnce(null);
      await service.changeUnverifiedEmail("c-move-1", "session-1", body());
      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "c-move-1" },
        data: {
          email: "fixed@example.com",
          emailVerificationCode: null,
          emailVerificationCodeExpiresAt: null,
          passwordResetCode: null,
          passwordResetCodeExpiresAt: null,
          relayMailAt: null,
        },
      });
      // No mail of its own: the customer asks for a code when ready.
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("is for unverified accounts only, and needs the password and the address twice", async () => {
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ id: "c-move-2", emailVerifiedAt: new Date() }));
      await expect(service.changeUnverifiedEmail("c-move-2", "s", body())).rejects.toBeInstanceOf(BadRequestException);
      prisma.customer.findUnique.mockResolvedValue(buildCustomer({ id: "c-move-2" }));
      await expect(
        service.changeUnverifiedEmail("c-move-2", "s", { ...body(), password: "wrong-password" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.changeUnverifiedEmail("c-move-2", "s", { ...body(), emailConfirm: "other@example.com" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("allows three a day", async () => {
      for (let i = 0; i < 3; i += 1) {
        prisma.customer.findUnique.mockResolvedValueOnce(buildCustomer({ id: "c-move-3" })).mockResolvedValueOnce(null);
        await service.changeUnverifiedEmail("c-move-3", "s", body(`n${i}@example.com`));
      }
      prisma.customer.findUnique.mockResolvedValueOnce(buildCustomer({ id: "c-move-3" })).mockResolvedValueOnce(null);
      const err = await service.changeUnverifiedEmail("c-move-3", "s", body("n4@example.com")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    });

    it("refuses an address someone else has", async () => {
      prisma.customer.findUnique
        .mockResolvedValueOnce(buildCustomer({ id: "c-move-4" }))
        .mockResolvedValueOnce({ id: "someone-else" });
      await expect(service.changeUnverifiedEmail("c-move-4", "s", body())).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
