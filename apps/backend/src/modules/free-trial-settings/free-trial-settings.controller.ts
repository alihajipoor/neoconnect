import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { FreeTrialSettingsService } from "./free-trial-settings.service";
import { UpdateFreeTrialSettingsDto } from "./dto/update-free-trial-settings.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// SUPERADMIN-only, same gating as AdminsController -- this is
// business-sensitive config (it controls whether new signups get a free
// VPN subscription with no payment info), not routine admin work.
@ApiTags("free-trial-settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("free-trial-settings")
export class FreeTrialSettingsController {
  constructor(private readonly freeTrialSettingsService: FreeTrialSettingsService) {}

  @Get()
  get() {
    return this.freeTrialSettingsService.get();
  }

  @Patch()
  update(@Body() dto: UpdateFreeTrialSettingsDto) {
    return this.freeTrialSettingsService.update(dto);
  }
}
