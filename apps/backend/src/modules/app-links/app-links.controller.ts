import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { AppLinksService } from "./app-links.service";
import { UpdateAppLinksDto } from "./dto/update-app-links.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

@ApiTags("app-links")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("app-links")
export class AppLinksController {
  constructor(private readonly appLinksService: AppLinksService) {}

  @Get()
  get() {
    return this.appLinksService.get();
  }

  @Patch()
  update(@Body() dto: UpdateAppLinksDto) {
    return this.appLinksService.update(dto);
  }
}
