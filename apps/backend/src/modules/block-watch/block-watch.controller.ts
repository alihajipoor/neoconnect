import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import type { AuthenticatedAdmin } from "../auth/types";
import { BlockWatchService } from "./block-watch.service";
import { BlockActionDto } from "./dto/act.dto";

@ApiTags("block-watch")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("block-watch")
export class BlockWatchController {
  constructor(private readonly blockWatch: BlockWatchService) {}

  /** What looks blocked now, and what closed lately. Any staff role, as
   * the reachability page. */
  @Get()
  overview() {
    return this.blockWatch.overview();
  }

  /** Evaluate now rather than at the next sweep. Reads our own tables and
   * opens at most one TCP connection per suspect server. */
  @Post("run")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  run() {
    return this.blockWatch.runCycle();
  }

  /** The owner's answer: replaced, retired, keep or snooze. Recorded
   * only; no server is touched. */
  @Post("incidents/:id/action")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  act(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: BlockActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.blockWatch.act(id, dto.action, admin.email, { hours: dto.hours, note: dto.note });
  }
}
