import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import { AuthService } from "./auth.service";

// Password hashing is real argon2, not mocked -- this is the one place in
// the app that decides whether a login attempt succeeds, so a mock would
// test nothing meaningful. Computed once since argon2 is deliberately
// slow.
const PASSWORD = "correct-password";
let PASSWORD_HASH: string;

function buildAdmin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "admin-1",
    email: "admin@example.com",
    passwordHash: PASSWORD_HASH,
    role: "SUPERADMIN",
    mfaSecret: null as string | null,
    mfaEnabled: false,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("AuthService", () => {
  let service: AuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; update: jest.Mock; findUniqueOrThrow: jest.Mock; updateMany: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };

  beforeAll(async () => {
    PASSWORD_HASH = await argon2.hash(PASSWORD);
  });

  beforeEach(() => {
    prisma = {
      adminUser: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        // How a TOTP step is used up: conditionally, once.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    jwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
    config = { get: jest.fn((key: string) => `config:${key}`) };

    service = new AuthService(prisma as any, jwt as unknown as JwtService, config as unknown as ConfigService);
  });

  describe("validateCredentials", () => {
    it("throws when no admin exists for the email", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.validateCredentials("nobody@example.com", PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("throws when the password is wrong", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin());
      await expect(service.validateCredentials("admin@example.com", "wrong-password")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns the admin row when credentials are correct", async () => {
      const admin = buildAdmin();
      prisma.adminUser.findUnique.mockResolvedValue(admin);
      await expect(service.validateCredentials("admin@example.com", PASSWORD)).resolves.toEqual(admin);
    });
  });

  describe("login", () => {
    it("returns a real token pair when MFA is not enabled", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: false }));
      jwt.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token");

      const result = await service.login("admin@example.com", PASSWORD);

      expect(result).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
      expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    });

    it("returns an mfaToken challenge instead of tokens when MFA is enabled", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: "SECRET" }));
      jwt.signAsync.mockResolvedValue("mfa-challenge-token");

      const result = await service.login("admin@example.com", PASSWORD);

      expect(result).toEqual({ mfaRequired: true, mfaToken: "mfa-challenge-token" });
      // Only the mfa-challenge token should be signed -- real tokens must
      // not be issued before the second factor is verified.
      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: "admin-1", purpose: "mfa" },
        expect.objectContaining({ expiresIn: "5m" }),
      );
    });

    it("still throws on bad credentials even when MFA is enabled", async () => {
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true }));
      await expect(service.login("admin@example.com", "wrong-password")).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("verifyMfaAndLogin", () => {
    const secret = authenticator.generateSecret();

    it("rejects an mfaToken that fails JWT verification", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("bad signature"));
      await expect(service.verifyMfaAndLogin("garbage", "123456")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a token whose purpose isn't 'mfa'", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "not-mfa" });
      await expect(service.verifyMfaAndLogin("token", "123456")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects when the admin no longer has MFA enabled", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "mfa" });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: false, mfaSecret: null }));
      await expect(service.verifyMfaAndLogin("token", "123456")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an incorrect TOTP code", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "mfa" });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: secret }));
      await expect(service.verifyMfaAndLogin("token", "000000")).rejects.toThrow(UnauthorizedException);
    });

    it("issues real tokens for a correct TOTP code", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "mfa" });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: secret }));
      jwt.signAsync.mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token");

      const code = authenticator.generate(secret);
      const result = await service.verifyMfaAndLogin("token", code);

      expect(result).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
    });

    /** RFC 6238 5.2: a code is accepted once. Nothing recorded the step a
     * code was used for, so one seen over a shoulder worked again for the
     * rest of its ~90 s window with the attacker's own mfaToken. */
    it("accepts a code's time-step only once, in one conditional write", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "mfa" });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: secret }));
      jwt.signAsync.mockResolvedValue("token");
      const code = authenticator.generate(secret);

      await service.verifyMfaAndLogin("token", code);
      const { where, data } = prisma.adminUser.updateMany.mock.calls[0][0];
      expect(where).toEqual({
        id: "admin-1",
        OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: data.mfaLastStep } }],
      });
      // This step (or the one before, should the clock have ticked over).
      expect(Math.floor(Date.now() / 30_000) - data.mfaLastStep).toBeLessThanOrEqual(1);

      // The same code again: the step is no longer newer than the last one.
      prisma.adminUser.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.verifyMfaAndLogin("token", code)).rejects.toThrow("Invalid MFA code");
    });

    describe("per-admin limit", () => {
      beforeEach(() => {
        jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", purpose: "mfa" });
        prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: secret }));
        jwt.signAsync.mockResolvedValue("token");
        jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
      });

      /** Only the per-IP throttle stood here: two hundred addresses made a
       * thousand guesses a minute, and a correct password (which the
       * attacker at this step has) hands out a fresh mfaToken each time. */
      it("refuses everything after five wrong codes, the right one included", async () => {
        for (let i = 0; i < 5; i += 1) {
          await expect(service.verifyMfaAndLogin("token", "000000")).rejects.toThrow("Invalid MFA code");
        }

        await expect(service.verifyMfaAndLogin("token", authenticator.generate(secret))).rejects.toThrow(
          /Too many wrong codes/,
        );
        expect(jwt.signAsync).not.toHaveBeenCalled();
      });

      it("compares no more than five of a parallel burst", async () => {
        prisma.adminUser.findUnique.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return buildAdmin({ mfaEnabled: true, mfaSecret: secret });
        });

        await Promise.all(
          Array.from({ length: 40 }, () => service.verifyMfaAndLogin("token", "000000").catch(() => undefined)),
        );

        expect(prisma.adminUser.findUnique).toHaveBeenCalledTimes(5);
      });

      it("is not reset by a new password sign-in", async () => {
        for (let i = 0; i < 5; i += 1) await service.verifyMfaAndLogin("token", "000000").catch(() => undefined);
        prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: secret }));
        jwt.signAsync.mockResolvedValue("fresh-mfa-token");
        await service.login("admin@example.com", PASSWORD);

        await expect(service.verifyMfaAndLogin("fresh-mfa-token", authenticator.generate(secret))).rejects.toThrow(
          /Too many wrong codes/,
        );
      });

      it("starts over after a right code", async () => {
        for (let i = 0; i < 4; i += 1) await service.verifyMfaAndLogin("token", "000000").catch(() => undefined);
        await service.verifyMfaAndLogin("token", authenticator.generate(secret));

        for (let i = 0; i < 4; i += 1) {
          await expect(service.verifyMfaAndLogin("token", "000000")).rejects.toThrow("Invalid MFA code");
        }
      });
    });
  });

  describe("refresh", () => {
    it("rejects an invalid refresh token", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("expired"));
      await expect(service.refresh("garbage")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a refresh token whose tokenVersion has been revoked", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", tokenVersion: 0 });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ tokenVersion: 1 }));
      await expect(service.refresh("token")).rejects.toThrow(UnauthorizedException);
    });

    it("issues a fresh token pair for a valid, unrevoked refresh token", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "admin-1", tokenVersion: 0 });
      prisma.adminUser.findUnique.mockResolvedValue(buildAdmin({ tokenVersion: 0 }));
      jwt.signAsync.mockResolvedValueOnce("access-token-2").mockResolvedValueOnce("refresh-token-2");

      const result = await service.refresh("token");
      expect(result).toEqual({ accessToken: "access-token-2", refreshToken: "refresh-token-2" });
    });
  });

  describe("MFA setup / enable / disable", () => {
    it("setupMfa generates a secret and does not enable MFA yet", async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin());
      prisma.adminUser.update.mockResolvedValue(undefined);

      const result = await service.setupMfa("admin-1");

      expect(result.secret).toHaveLength(16);
      expect(result.otpauthUrl).toContain("otpauth://totp/");
      expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: { mfaSecret: result.secret, mfaEnabled: false, mfaLastStep: null },
      });
    });

    // An access token alone used to be enough to switch MFA off this way
    // (setup wrote mfaEnabled: false), or to bind it to the caller's own
    // authenticator -- what disableMfa asks for the password to prevent.
    it("setupMfa refuses while MFA is on, and changes nothing", async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: "SECRET" }));

      await expect(service.setupMfa("admin-1")).rejects.toThrow(BadRequestException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it("enableMfa rejects if setupMfa was never called", async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaSecret: null }));
      await expect(service.enableMfa("admin-1", "123456")).rejects.toThrow(BadRequestException);
    });

    it("enableMfa rejects an incorrect code", async () => {
      const secret = authenticator.generateSecret();
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaSecret: secret }));
      await expect(service.enableMfa("admin-1", "000000")).rejects.toThrow(UnauthorizedException);
    });

    it("enableMfa uses up the code's time-step, so it cannot sign in a second time", async () => {
      const secret = authenticator.generateSecret();
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaSecret: secret }));

      await service.enableMfa("admin-1", authenticator.generate(secret));

      expect(prisma.adminUser.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mfaLastStep: expect.any(Number) } }),
      );
    });

    it("enableMfa flips mfaEnabled to true for a correct code", async () => {
      const secret = authenticator.generateSecret();
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaSecret: secret }));
      const code = authenticator.generate(secret);

      await service.enableMfa("admin-1", code);

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: { mfaEnabled: true },
      });
    });

    it("disableMfa rejects the wrong password", async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: "SECRET" }));
      await expect(service.disableMfa("admin-1", "wrong-password")).rejects.toThrow(UnauthorizedException);
    });

    it("disableMfa clears the secret and flag for the correct password", async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(buildAdmin({ mfaEnabled: true, mfaSecret: "SECRET" }));

      await service.disableMfa("admin-1", PASSWORD);

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: { mfaSecret: null, mfaEnabled: false, mfaLastStep: null },
      });
    });
  });

  describe("revokeAllSessions", () => {
    it("increments tokenVersion for the given admin", async () => {
      await service.revokeAllSessions("admin-1");
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: "admin-1" },
        data: { tokenVersion: { increment: 1 } },
      });
    });
  });
});
