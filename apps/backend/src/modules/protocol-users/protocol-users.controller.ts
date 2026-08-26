import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ProtocolUsersService } from "./protocol-users.service";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { SetEnabledDto } from "./dto/set-enabled.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { listWindow, sendPage } from "../../common/pagination";

@ApiTags("protocol-users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("protocol-users")
export class ProtocolUsersController {
  constructor(private readonly protocolUsersService: ProtocolUsersService) {}

  /** Paged per common/pagination.ts, and this is the route the
   * convention was most needed on: without `?nodeId` it used to read
   * every ProtocolUser in the system and decrypt each one's credentials
   * into a single response. The body is still a bare array and the true
   * row count is in `X-Total-Count`.
   *
   * 100 by default rather than more because each row costs a decrypt,
   * so the page size is a bound on work as well as on bytes. */
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("nodeId") nodeId?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.protocolUsersService.list(nodeId, window));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.protocolUsersService.get(id);
  }

  @Post()
  create(@Body() dto: CreateProtocolUserDto) {
    return this.protocolUsersService.create(dto);
  }

  @Patch(":id/enabled")
  setEnabled(@Param("id") id: string, @Body() dto: SetEnabledDto) {
    return this.protocolUsersService.setEnabled(id, dto.enabled);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.protocolUsersService.remove(id);
  }
}
