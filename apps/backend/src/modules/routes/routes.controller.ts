import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoutesService } from "./routes.service";
import { CreateRouteDto } from "./dto/create-route.dto";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

@ApiTags("routes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("routes")
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Get()
  list() {
    return this.routesService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.routesService.get(id);
  }

  // SUPERADMIN only, as nodes and protocol configs are. The panel hid
  // these from every other role but the API did not: one DELETE from a
  // SUPPORT or BILLING login sent DELETE_USER for every customer on the
  // route.
  @Post()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  create(@Body() dto: CreateRouteDto) {
    return this.routesService.create(dto);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.routesService.remove(id);
  }
}
