import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { PrismaService } from "../../prisma/prisma.service";
import { GuessBudget } from "../../common/guess-budget";
import { AccessTokenPayload, MfaTokenPayload, RefreshTokenPayload } from "./types";

// One time-step of drift tolerance either side (±30s) -- standard practice
// for TOTP so a slightly-off device clock or the few seconds a user takes
// to type the code doesn't cause spurious rejections, without meaningfully
// widening the guessable window (still only 3 valid codes at any instant
// instead of 1).
authenticator.options = { window: 1 };
/** otplib's default step, which nothing here changes. */
const TOTP_STEP_SECONDS = 30;

const MFA_TOKEN_TTL = "5m";

/** Wrong TOTP codes one admin may send per window before the step refuses
 * everything, a right code included, until the window is over. Three
 * codes are valid at any moment, so five guesses every fifteen minutes is
 * about one chance in seven hundred a day for someone who already has the
 * password -- against near-certainty within a day from a couple of hundred
 * addresses before. */
const MFA_GUESSES_PER_WINDOW = 5;
const MFA_GUESS_WINDOW_MS = 15 * 60 * 1000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type LoginResult = TokenPair | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Guesses at the TOTP step, per admin. Process-local, one backend
   * instance, as LoginGuardService's counters. */
  private readonly mfaBudget = new GuessBudget(MFA_GUESSES_PER_WINDOW, MFA_GUESS_WINDOW_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async validateCredentials(email: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!admin) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const valid = await argon2.verify(admin.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return admin;
  }

  async issueTokenPair(admin: { id: string; email: string; role: string; tokenVersion: number }): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role as AccessTokenPayload["role"],
    };
    const refreshPayload: RefreshTokenPayload = {
      sub: admin.id,
      tokenVersion: admin.tokenVersion,
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get<string>("jwt.accessSecret"),
      expiresIn: this.config.get<string>("jwt.accessTtl"),
    });
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get<string>("jwt.refreshSecret"),
      expiresIn: this.config.get<string>("jwt.refreshTtl"),
    });

    return { accessToken, refreshToken };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const admin = await this.validateCredentials(email, password);

    if (admin.mfaEnabled) {
      const mfaPayload: MfaTokenPayload = { sub: admin.id, purpose: "mfa" };
      const mfaToken = await this.jwt.signAsync(mfaPayload, {
        secret: this.config.get<string>("jwt.accessSecret"),
        expiresIn: MFA_TOKEN_TTL,
      });
      return { mfaRequired: true, mfaToken };
    }

    return this.issueTokenPair(admin);
  }

  /** Second step of a login that returned `mfaRequired: true` -- exchanges
   * the short-lived mfaToken + a fresh TOTP code for real tokens. */
  async verifyMfaAndLogin(mfaToken: string, code: string): Promise<TokenPair> {
    let payload: MfaTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<MfaTokenPayload>(mfaToken, {
        secret: this.config.get<string>("jwt.accessSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired MFA challenge");
    }
    if (payload.purpose !== "mfa") {
      throw new UnauthorizedException("Invalid or expired MFA challenge");
    }

    // Taken before anything is awaited, so a burst of parallel guesses is
    // counted before any of them is compared -- see GuessBudget. Keyed on
    // the admin, not the address: the per-IP throttle alone let 200
    // addresses make a thousand guesses a minute, and a correct password
    // (which the attacker at this step already has) hands out a fresh
    // mfaToken every time without ever touching the login guard. Nothing
    // but the window ending, or a right code, gives the allowance back --
    // not a new password sign-in. Locking this step out denies nobody but
    // someone who already holds the password.
    if (!this.mfaBudget.take(payload.sub)) {
      this.logger.warn(`MFA refused for admin ${payload.sub}: too many wrong codes in the last 15 minutes`);
      throw new UnauthorizedException("Too many wrong codes. Try again in 15 minutes.");
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.mfaEnabled || !admin.mfaSecret) {
      throw new UnauthorizedException("Invalid or expired MFA challenge");
    }
    if (!(await this.acceptTotp(admin.id, admin.mfaSecret, code))) {
      if (this.mfaBudget.spent(admin.id)) {
        this.logger.warn(`MFA locked for admin ${admin.id} after ${MFA_GUESSES_PER_WINDOW} wrong codes`);
      }
      throw new UnauthorizedException("Invalid MFA code");
    }

    this.mfaBudget.clear(admin.id);
    return this.issueTokenPair(admin);
  }

  /** Whether `code` is a valid TOTP code for `secret` that has not been
   * accepted before.
   *
   * With a window of one step either side, a code stays valid for about
   * ninety seconds, and nothing recorded which time-step had been used:
   * a code seen over a shoulder or phished could be replayed with the
   * attacker's own mfaToken. RFC 6238 §5.2 says a verifier must not
   * accept a code a second time. The step is consumed in one conditional
   * write, so two requests racing with the same code cannot both pass. */
  private async acceptTotp(adminId: string, secret: string, code: string): Promise<boolean> {
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + delta;
    const { count } = await this.prisma.adminUser.updateMany({
      where: { id: adminId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return count === 1;
  }

  /** Generates a new candidate TOTP secret and stores it (mfaEnabled stays
   * false until confirmed via enableMfa) -- calling this again before
   * confirming just overwrites the previous candidate, which is fine, it
   * was never active.
   *
   * Refused while MFA is on. It used to write `mfaEnabled: false` with a
   * new secret whatever the state, so an access token alone -- the exact
   * threat disableMfa asks for the password against -- could switch the
   * second factor off, or bind it to the caller's own authenticator and
   * lock the real admin out at their next sign-in. A stale panel tab
   * offering "Enable" did the first half by accident. Changing
   * authenticators now goes through disableMfa, and so needs the
   * password. */
  async setupMfa(adminId: string): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (admin.mfaEnabled) {
      throw new BadRequestException(
        "Two-factor authentication is already on. Turn it off with your password before setting it up again.",
      );
    }
    const secret = authenticator.generateSecret();
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { mfaSecret: secret, mfaEnabled: false, mfaLastStep: null },
    });

    const otpauthUrl = authenticator.keyuri(admin.email, "Neoxify", secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { secret, otpauthUrl, qrCodeDataUrl };
  }

  /** Confirms a candidate secret from setupMfa() actually works before
   * enforcing it at login -- proves the admin's authenticator app is
   * correctly configured, not just that a secret was generated. */
  async enableMfa(adminId: string, code: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!admin.mfaSecret) {
      throw new BadRequestException("Call POST /auth/mfa/setup first");
    }
    // Through acceptTotp, so the code that switched MFA on cannot be used
    // again to sign in.
    if (!(await this.acceptTotp(adminId, admin.mfaSecret, code))) {
      throw new UnauthorizedException("Invalid MFA code");
    }
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { mfaEnabled: true } });
  }

  /** Requires the account password (not a TOTP code) so a stolen/replayed
   * access token alone can't turn MFA off -- same reasoning as why
   * password changes are gated by the current password elsewhere. */
  async disableMfa(adminId: string, password: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const valid = await argon2.verify(admin.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException("Incorrect password");
    }
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { mfaSecret: null, mfaEnabled: false, mfaLastStep: null },
    });
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get<string>("jwt.refreshSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }

    return this.issueTokenPair(admin);
  }

  /** Invalidates all outstanding refresh tokens for this admin. */
  async revokeAllSessions(adminId: string): Promise<void> {
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
    });
  }
}
