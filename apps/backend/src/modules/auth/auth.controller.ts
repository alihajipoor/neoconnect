import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { MfaDisableDto } from "./dto/mfa-disable.dto";
import { MfaEnableDto } from "./dto/mfa-enable.dto";
import { MfaVerifyDto } from "./dto/mfa-verify.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import { AuthenticatedAdmin } from "./types";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Tighter than the global default -- this is the one endpoint on the
  // whole API where an attacker gets to guess a secret (a password)
  // rather than needing to already have one, so it's the one place
  // brute-force resistance actually matters.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // Same brute-force reasoning as login above -- this is the endpoint that
  // consumes a 6-digit TOTP code, so it gets the same tight limit.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  verifyMfa(@Body() dto: MfaVerifyDto) {
    return this.authService.verifyMfaAndLogin(dto.mfaToken, dto.code);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentAdmin() admin: AuthenticatedAdmin) {
    await this.authService.revokeAllSessions(admin.sub);
  }

  @Post("mfa/setup")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  setupMfa(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.authService.setupMfa(admin.sub);
  }

  @Post("mfa/enable")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async enableMfa(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: MfaEnableDto) {
    await this.authService.enableMfa(admin.sub, dto.code);
  }

  @Post("mfa/disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async disableMfa(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: MfaDisableDto) {
    await this.authService.disableMfa(admin.sub, dto.password);
  }
}
