import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import { AuthenticatedAdmin } from "../auth/types";
import { listWindow, sendPage } from "../../common/pagination";
import { ResellersService } from "./resellers.service";
import { GenerateVoucherDto, ResendVoucherDto, SetBalanceDto } from "./dto/reseller.dto";

/**
 * What a reseller can do, and nothing else.
 *
 * Every method scopes on the CALLER'S id from the token -- never an id
 * from the request -- so one reseller cannot read or revoke another's
 * codes even by guessing. SUPERADMIN is allowed in alongside RESELLER
 * only so the operator can see the same screens while supporting
 * someone; they get their own view of everyone through the admin
 * controller below.
 */
@ApiTags("reseller")
@ApiBearerAuth()
@Controller("reseller")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.RESELLER, AdminRole.SUPERADMIN)
export class ResellerController {
  constructor(private readonly resellers: ResellersService) {}

  @Get("balances")
  @ApiOperation({ summary: "How many vouchers of each plan I can still mint" })
  balances(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.resellers.myBalances(admin.sub);
  }

  /** Paged per common/pagination.ts. Still a bare array, still scoped to
   * the caller's own codes; `X-Total-Count` says how many of those there
   * are, which is the figure a reseller's "codes issued" tally needs and
   * the one a page length cannot give. */
  @Get("vouchers")
  @ApiOperation({ summary: "Codes I have issued, newest first" })
  async vouchers(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Res({ passthrough: true }) res: Response,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.resellers.myVouchers(admin.sub, window));
  }

  @Post("vouchers")
  @ApiOperation({ summary: "Mint a code, spending one token of that plan" })
  generate(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: GenerateVoucherDto) {
    return this.resellers.generate(admin.sub, dto.planId, dto.recipientEmail);
  }

  @Post("vouchers/:id/resend")
  @ApiOperation({ summary: "Email an existing code again" })
  resend(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id") id: string,
    @Body() dto: ResendVoucherDto,
  ) {
    return this.resellers.resend(admin.sub, id, dto.email);
  }

  @Delete("vouchers/:id")
  @ApiOperation({ summary: "Delete an unredeemed code and get the token back" })
  revoke(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.resellers.revoke(admin.sub, id);
  }
}

/**
 * The operator's side: who the resellers are and what they hold.
 *
 * SUPERADMIN only. Granting capacity is granting money's worth -- a
 * balance is subscriptions somebody can hand out for free -- so it sits
 * with the same role that manages admins, not with SUPPORT or BILLING.
 */
@ApiTags("reseller")
@ApiBearerAuth()
@Controller("resellers")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
export class ResellersAdminController {
  constructor(private readonly resellers: ResellersService) {}

  @Get()
  @ApiOperation({ summary: "Every reseller, their balances and how much they have issued" })
  list() {
    return this.resellers.listResellers();
  }

  @Post(":id/balance")
  @ApiOperation({ summary: "Set a reseller's remaining tokens for one plan" })
  setBalance(@Param("id") id: string, @Body() dto: SetBalanceDto) {
    return this.resellers.setBalance(id, dto.planId, dto.balance);
  }
}
