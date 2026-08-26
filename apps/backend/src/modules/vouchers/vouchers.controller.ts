import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import type { Response } from "express";
import { VouchersService } from "./vouchers.service";
import { CreateVoucherDto } from "./dto/create-voucher.dto";
import { UpdateVoucherDto } from "./dto/update-voucher.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { listWindow, sendPage } from "../../common/pagination";

// SUPERADMIN and BILLING only. A voucher grants a paid plan for nothing,
// so cutting one is a commercial act rather than routine support work --
// the same reasoning that gates the free-trial and referral settings.
@ApiTags("vouchers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
@Controller("vouchers")
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) {}

  /** Paged per the convention in common/pagination.ts. The body stays a
   * bare array and `X-Total-Count` carries the real number of codes, so
   * the screen can say "showing 100 of 4,200" rather than inferring a
   * total from the page it is holding. */
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.vouchersService.list(window));
  }

  @Post()
  create(@Body() dto: CreateVoucherDto) {
    return this.vouchersService.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateVoucherDto) {
    return this.vouchersService.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.vouchersService.remove(id);
  }
}
