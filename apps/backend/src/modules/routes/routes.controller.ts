import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoutesService } from "./routes.service";
import { CreateRouteDto } from "./dto/create-route.dto";
import { AdminRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

export function withoutUplinkCredentials<T extends { uplinkCredentialsJson?: unknown }>(
  route: T,
): Omit<T, "uplinkCredentialsJson"> {
  const { uplinkCredentialsJson: _secret, ...rest } = route;
  void _secret;
  return rest;
}

@ApiTags("routes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("routes")
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  // Never with the relay's uplink credential: a working client on the exit
  // node that no customer owns and no plan meters. The agent gateway reads
  // it from the database; nothing reads it from here, and this list went
  // to every staff role's panel page.
  @Get()
  async list() {
    return (await this.routesService.list()).map(withoutUplinkCredentials);
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return withoutUplinkCredentials(await this.routesService.get(id));
  }

  // SUPERADMIN only, as nodes and protocol configs are. The panel hid
  // these from every other role but the API did not: one DELETE from a
  // SUPPORT or BILLING login sent DELETE_USER for every customer on the
  // route.
  @Post()
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  async create(@Body() dto: CreateRouteDto) {
    // The installer reads only `.id` from this.
    return withoutUplinkCredentials(await this.routesService.create(dto));
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.routesService.remove(id);
  }
}
