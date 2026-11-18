import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { ThrottleVolumePerSession } from "../../common/guards/client-throttler.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import type { AuthenticatedCustomer } from "../customer-auth/types";
import { ClientAttemptsService } from "./client-attempts.service";
import { SendDiagnosticsDto } from "./dto/send-diagnostics.dto";
import { serviceCheckTargets } from "./service-check-targets";

/** Diagnostics a signed-in customer's app asks for or sends
 * (docs/client-diagnostics.md). The customer guard's default applies: an
 * account held to the unverified capability set may not use either, as
 * neither is on that list (docs/relay-last-resort.md, I3). */
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Controller("customer")
export class CustomerDiagnosticsController {
  constructor(private readonly attempts: ClientAttemptsService) {}

  /** The service check's fixed list. The app tests these and nothing
   * else, and the server keeps results for these and nothing else.
   * SERVICE_CHECKS=off answers enabled: false. */
  @Get("service-checks/targets")
  targets() {
    return serviceCheckTargets(process.env.SERVICE_CHECKS);
  }

  /** A bundle the customer chose to send, answered with the reference
   * they quote to support. Six an hour per signed-in session: a person
   * pressing a button, never a schedule. */
  @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  @ThrottleVolumePerSession()
  @HttpCode(HttpStatus.CREATED)
  @Post("diagnostics")
  send(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: SendDiagnosticsDto) {
    return this.attempts.recordDiagnostics(dto, { customerId: customer.sub, sessionId: customer.sid });
  }
}
