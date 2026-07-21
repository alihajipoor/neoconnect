import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RoutesService } from "./routes.service";
import { CreateRouteDto } from "./dto/create-route.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

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

  @Post()
  create(@Body() dto: CreateRouteDto) {
    return this.routesService.create(dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.routesService.remove(id);
  }
}
