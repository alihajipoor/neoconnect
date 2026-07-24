import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { AnnouncementsService } from "./announcements.service";
import { SendAnnouncementDto } from "./dto/send-announcement.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// SUPERADMIN-only, same gating as EmailSettingsController -- sending mass
// email to the whole customer base is business-sensitive, not routine
// admin/support work.
@ApiTags("announcements")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("announcements")
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Post("send")
  send(@Body() dto: SendAnnouncementDto) {
    return this.announcementsService.send(dto);
  }
}
