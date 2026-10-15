import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { RelayAuthService } from "./relay-auth.service";
import { RelayAccountsService } from "./relay-accounts.service";
import { UpdateRelayAuthDto } from "./dto/update-relay-auth.dto";
import { MoveAddressDto } from "./dto/move-address.dto";

/** What the apps may know about relay sign-up. Public, and on the relay
 * allowlist: an app reaching only the relay needs it before it has a
 * session. */
@ApiTags("relay")
@Controller("relay")
export class RelayStatusController {
  constructor(private readonly relay: RelayAuthService) {}

  @Get("status")
  status() {
    return this.relay.publicStatus();
  }
}

/** The owner's switch and the numbers behind it (docs/relay-last-resort.md). */
@ApiTags("relay-auth")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("relay-auth")
export class RelayAuthController {
  constructor(
    private readonly relay: RelayAuthService,
    private readonly accounts: RelayAccountsService,
  ) {}

  @Get()
  status() {
    return this.relay.adminStatus();
  }

  @Patch()
  async update(@Body() dto: UpdateRelayAuthDto) {
    await this.relay.update(dto);
    return this.relay.adminStatus();
  }

  /** Moves an account to a new address on its recovery code alone (R3.9),
   * and hands back a new recovery code: the old one has been read out to
   * support, so it is spent. */
  @Post("customers/:id/move-address")
  @HttpCode(HttpStatus.OK)
  moveAddress(@Param("id", ParseUUIDPipe) id: string, @Body() dto: MoveAddressDto) {
    return this.accounts.moveAddress(id, dto.recoveryCode, dto.email);
  }
}
