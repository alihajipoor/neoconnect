import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { ProtocolConfigsService } from "./protocol-configs.service";
import { CreateProtocolConfigDto } from "./dto/create-protocol-config.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

@ApiTags("protocol-configs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("protocol-configs")
export class ProtocolConfigsController {
  constructor(private readonly protocolConfigsService: ProtocolConfigsService) {}

  @Get()
  list(@Query("nodeId") nodeId?: string) {
    return this.protocolConfigsService.list(nodeId);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.protocolConfigsService.get(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  create(@Body() dto: CreateProtocolConfigDto) {
    return this.protocolConfigsService.create(dto);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.protocolConfigsService.remove(id);
  }
}
