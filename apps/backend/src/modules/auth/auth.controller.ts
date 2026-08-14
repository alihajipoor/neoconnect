import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, UseGuards } from "@nestjs/common";
import { LoginGuardService } from "../login-guard/login-guard.service";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { MfaDisableDto } from "./dto/mfa-disable.dto";
import { MfaEnableDto } from "./dto/mfa-enable.dto";
import { MfaVerifyDto } from "./dto/mfa-verify.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { ALL_ADMIN_ROLES, Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import { AuthenticatedAdmin } from "./types";
import { AdminsService } from "../admins/admins.service";

/**
 * Sign-in, and the account-security settings an admin manages for
 * themselves.
 *
 * The authenticated routes below all carry @Roles(...ALL_ADMIN_ROLES).
 * That is not decoration: JwtAuthGuard denies outsider roles (RESELLER)
 * on any admin endpoint that declares no roles at all, so without this a
 * reseller could sign in and then be unable to read their own account,
 * enable MFA, or sign out. These are the endpoints where "every role,
 * including the outsiders" is the right answer, and they now say so.
 */
@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminsService: AdminsService,
    private readonly loginGuard: LoginGuardService,
  ) {}

  // Open to every role, unlike AdminsController's GET /admins/:id --
  // every admin needs to see and manage their OWN security settings
  // (MFA status), not just SUPERADMINs managing other admins' accounts.
  // Returns the caller's own record only: the id comes from the token.
  @Get("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.adminsService.get(admin.sub);
  }

  // Tighter than the global default -- this is the one endpoint on the
  // whole API where an attacker gets to guess a secret (a password)
  // rather than needing to already have one, so it's the one place
  // brute-force resistance actually matters.
  //
  // The @Throttle above caps attempts per address. It is necessary and
  // not sufficient: it cannot see a distributed attack aimed at one
  // account, and it cannot be tightened much without hurting the many
  // legitimate users who share an address behind carrier-grade NAT. The
  // LoginGuardService covers both by tracking the ACCOUNT as well, and
  // by making each successive attempt cost more CPU rather than by
  // locking anyone out.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Ip() ip: string) {
    this.loginGuard.enforce("admin", dto.challenge, dto.email, ip);
    try {
      const result = await this.authService.login(dto.email, dto.password);
      // Reached on a correct password even when MFA is still outstanding
      // -- the secret being guessed here is the password, and it was not
      // guessed wrong.
      this.loginGuard.recordSuccess("admin", dto.email);
      return result;
    } catch (err) {
      this.loginGuard.recordFailure("admin", dto.email, ip);
      throw err;
    }
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async logout(@CurrentAdmin() admin: AuthenticatedAdmin) {
    await this.authService.revokeAllSessions(admin.sub);
  }

  @Post("mfa/setup")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  setupMfa(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.authService.setupMfa(admin.sub);
  }

  @Post("mfa/enable")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async enableMfa(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: MfaEnableDto) {
    await this.authService.enableMfa(admin.sub, dto.code);
  }

  @Post("mfa/disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async disableMfa(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: MfaDisableDto) {
    await this.authService.disableMfa(admin.sub, dto.password);
  }
}
