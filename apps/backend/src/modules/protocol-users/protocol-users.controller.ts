import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ProtocolUsersService } from "./protocol-users.service";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { SetEnabledDto } from "./dto/set-enabled.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

@ApiTags("protocol-users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("protocol-users")
export class ProtocolUsersController {
  constructor(private readonly protocolUsersService: ProtocolUsersService) {}

  @Get()
  list(@Query("nodeId") nodeId?: string) {
    return this.protocolUsersService.list(nodeId);
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
