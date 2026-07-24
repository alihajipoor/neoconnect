import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { EmailSettingsService } from "./email-settings.service";
import { UpdateEmailSettingsDto } from "./dto/update-email-settings.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// SUPERADMIN-only, same gating as FreeTrialSettingsController -- this
// holds real SMTP credentials (encrypted at rest, never returned by GET).
@ApiTags("email-settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("email-settings")
export class EmailSettingsController {
  constructor(private readonly emailSettingsService: EmailSettingsService) {}

  @Get()
  get() {
    return this.emailSettingsService.get();
  }

  @Patch()
  update(@Body() dto: UpdateEmailSettingsDto) {
    return this.emailSettingsService.update(dto);
  }
}
