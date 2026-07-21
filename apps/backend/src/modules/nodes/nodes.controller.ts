import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { NodesService } from "./nodes.service";
import { CreateNodeDto } from "./dto/create-node.dto";
import { EnrollmentService } from "../enrollment/enrollment.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentAdmin } from "../../common/decorators/current-admin.decorator";
import { AuthenticatedAdmin } from "../../modules/auth/types";

@ApiTags("nodes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("nodes")
export class NodesController {
  constructor(
    private readonly nodesService: NodesService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  @Get()
  list() {
    return this.nodesService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.nodesService.get(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  create(@Body() dto: CreateNodeDto) {
    return this.nodesService.create(dto);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.nodesService.remove(id);
  }

  @Post(":id/enrollment-tokens")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  issueEnrollmentToken(@Param("id") id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.enrollmentService.issueToken(id, admin.sub);
  }
}
