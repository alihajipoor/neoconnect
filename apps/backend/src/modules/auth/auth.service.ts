import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessTokenPayload, RefreshTokenPayload } from "./types";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

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

  async login(email: string, password: string): Promise<TokenPair> {
    const admin = await this.validateCredentials(email, password);
    return this.issueTokenPair(admin);
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
