import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole, SupportTicketStatus } from "@prisma/client";
import type { Response } from "express";
import { SupportService } from "./support.service";
import { ReplyTicketDto } from "./dto/reply-ticket.dto";
import { SetTicketStatusDto } from "./dto/set-ticket-status.dto";
import { UpdateSupportSettingsDto } from "./dto/update-support-settings.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { listWindow, sendPage } from "../../common/pagination";

/** The operator's side of the conversation.
 *
 * Answering is open to SUPPORT as well as SUPERADMIN -- that role has
 * existed since M0 for exactly this and has never had anything to do.
 * The availability switch is SUPERADMIN-only: deciding the product is
 * closed for the evening is not routine support work.
 */
@ApiTags("support")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("support")
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get("settings")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  settings() {
    return this.supportService.settings();
  }

  @Patch("settings")
  @Roles(AdminRole.SUPERADMIN)
  updateSettings(@Body() dto: UpdateSupportSettingsDto) {
    return this.supportService.updateSettings(dto);
  }

  /** Paged per common/pagination.ts.
   *
   * The default is 200 rather than the convention's usual 100 because
   * this route already served 200 through a hardcoded `take`, and a page
   * load that suddenly showed half the inbox would read as conversations
   * having disappeared. What changes is that the rest are now reachable:
   * `skip` pages past the ceiling and `X-Total-Count` says how many
   * there are.
   *
   * The rail also filters and counts client-side over whatever it was
   * given, so its "needs reply" tally is a tally of the page. Passing
   * `?status=OPEN` is what makes that figure true of the inbox. */
  @Get("tickets")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("status") status?: SupportTicketStatus,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 200, maxTake: 500 });
    return sendPage(
      res,
      await this.supportService.listTickets(
        status && Object.values(SupportTicketStatus).includes(status) ? status : undefined,
        window,
      ),
    );
  }

  @Get("tickets/:id")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  ticket(@Param("id") id: string) {
    return this.supportService.ticket(id);
  }

  @Post("tickets/:id/reply")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  reply(@Param("id") id: string, @Body() dto: ReplyTicketDto) {
    return this.supportService.replyAsAdmin(id, dto.body);
  }

  @Patch("tickets/:id")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  setStatus(@Param("id") id: string, @Body() dto: SetTicketStatusDto) {
    return this.supportService.setStatus(id, dto.status);
  }
}
