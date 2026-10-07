import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { ProtocolConfigsService, readableBy } from "./protocol-configs.service";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import type { AuthenticatedAdmin } from "../auth/types";
import { CreateProtocolConfigDto } from "./dto/create-protocol-config.dto";
import { UpdateProtocolConfigDto } from "./dto/update-protocol-config.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

@ApiTags("protocol-configs")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("protocol-configs")
export class ProtocolConfigsController {
  constructor(private readonly protocolConfigsService: ProtocolConfigsService) {}

  // Every staff role reads these; only SUPERADMIN gets the server key
  // back, and nobody the CA key. See readableBy.
  @Get()
  async list(@CurrentAdmin() admin: AuthenticatedAdmin, @Query("nodeId") nodeId?: string) {
    return (await this.protocolConfigsService.list(nodeId)).map((config) => readableBy(config, admin.role));
  }

  @Get(":id")
  async get(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return readableBy(await this.protocolConfigsService.get(id), admin.role);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  create(@Body() dto: CreateProtocolConfigDto) {
    return this.protocolConfigsService.create(dto);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  async update(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string, @Body() dto: UpdateProtocolConfigDto) {
    return readableBy(await this.protocolConfigsService.update(id, dto), admin.role);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.protocolConfigsService.remove(id);
  }
}
