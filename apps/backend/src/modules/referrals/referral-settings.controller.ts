import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { ReferralSettingsService } from "./referral-settings.service";
import { UpdateReferralSettingsDto } from "./dto/update-referral-settings.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// SUPERADMIN-only, same gating as the free-trial settings: this decides
// how much free service the business gives away and on what terms, which
// is not routine admin work.
@ApiTags("referral-settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("referral-settings")
export class ReferralSettingsController {
  constructor(private readonly settingsService: ReferralSettingsService) {}

  @Get()
  get() {
    return this.settingsService.get();
  }

  @Patch()
  update(@Body() dto: UpdateReferralSettingsDto) {
    return this.settingsService.update(dto);
  }
}
