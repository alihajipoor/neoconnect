import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessTokenPayload, MfaTokenPayload, RefreshTokenPayload } from "./types";

// One time-step of drift tolerance either side (±30s) -- standard practice
// for TOTP so a slightly-off device clock or the few seconds a user takes
// to type the code doesn't cause spurious rejections, without meaningfully
// widening the guessable window (still only 3 valid codes at any instant
// instead of 1).
authenticator.options = { window: 1 };

const MFA_TOKEN_TTL = "5m";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type LoginResult = TokenPair | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
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

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.mfaEnabled || !admin.mfaSecret) {
      throw new UnauthorizedException("Invalid or expired MFA challenge");
    }
    if (!authenticator.verify({ token: code, secret: admin.mfaSecret })) {
      throw new UnauthorizedException("Invalid MFA code");
    }

    return this.issueTokenPair(admin);
  }

  /** Generates a new candidate TOTP secret and stores it (mfaEnabled stays
   * false until confirmed via enableMfa) -- calling this again before
   * confirming just overwrites the previous candidate, which is fine, it
   * was never active. */
  async setupMfa(adminId: string): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const secret = authenticator.generateSecret();
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { mfaSecret: secret, mfaEnabled: false } });

    const otpauthUrl = authenticator.keyuri(admin.email, "NeoConnect", secret);
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
    if (!authenticator.verify({ token: code, secret: admin.mfaSecret })) {
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
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { mfaSecret: null, mfaEnabled: false } });
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
