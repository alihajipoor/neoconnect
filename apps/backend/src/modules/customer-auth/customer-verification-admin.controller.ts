import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { CustomerAuthService } from "./customer-auth.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

/** The admin side of email verification.
 *
 * Lives here rather than on CustomersController because the work belongs
 * to CustomerAuthService (the trial and the referral notice a verification
 * triggers), and the customers module cannot depend on this one: this one
 * already depends on it. */
@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("customers")
export class CustomerVerificationAdminController {
  constructor(private readonly customerAuthService: CustomerAuthService) {}

  @Post(":id/verify-email")
  @Roles(AdminRole.SUPERADMIN, AdminRole.SUPPORT)
  markVerified(@Param("id") id: string) {
    return this.customerAuthService.markVerifiedByAdmin(id);
  }
}
