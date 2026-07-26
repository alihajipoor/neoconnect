import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole } from "@prisma/client";
import { PaymentSettingsService } from "./payment-settings.service";
import { UpdatePaymentSettingsDto } from "./dto/update-payment-settings.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

// SUPERADMIN-only, same gating as email settings. These keys move real
// money, so they are the most sensitive configuration in the product --
// stored encrypted, and never returned by GET.
@ApiTags("payment-settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
@Controller("payment-settings")
export class PaymentSettingsController {
  constructor(private readonly paymentSettingsService: PaymentSettingsService) {}

  @Get()
  get() {
    return this.paymentSettingsService.get();
  }

  @Patch()
  update(@Body() dto: UpdatePaymentSettingsDto) {
    return this.paymentSettingsService.update(dto);
  }
}
