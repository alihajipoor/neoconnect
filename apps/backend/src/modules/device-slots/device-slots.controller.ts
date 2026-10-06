import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { deviceInfoFrom } from "../../common/device-info";
import type { AuthenticatedCustomer } from "../customer-auth/types";
import { DeviceSlotsService } from "./device-slots.service";
import { ClaimSlotDto, ReleaseSlotDto, RenewSlotDto } from "./dto/slot.dto";

/** Device slots -- the HTTP contract is docs/device-slots.md, and that
 * document, not this file, is what the apps are built against. Change
 * the two together. */
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Controller("customer/vpn")
export class DeviceSlotsController {
  constructor(private readonly slots: DeviceSlotsService) {}

  /** Before dialling. 200 granted; 409 DEVICE_LIMIT with where Neoxify is
   * in use; 409 SUBSCRIPTION_INACTIVE; 429 TAKEOVER_LIMIT. */
  @Post("claim")
  @HttpCode(HttpStatus.OK)
  claim(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ClaimSlotDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.slots.claim({ customerId: customer.sub, sessionId: customer.sid }, dto, deviceInfoFrom(headers));
  }

  /** While connected, every renewEverySec. Always 200 with a `status`. */
  @Post("renew")
  @HttpCode(HttpStatus.OK)
  renew(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: RenewSlotDto) {
    return this.slots.renew({ customerId: customer.sub, sessionId: customer.sid }, dto);
  }

  /** On Disconnect, fire-and-forget. */
  @Post("release")
  @HttpCode(HttpStatus.NO_CONTENT)
  async release(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: ReleaseSlotDto) {
    await this.slots.release({ customerId: customer.sub, sessionId: customer.sid }, dto);
  }
}
