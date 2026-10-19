import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { ThrottleVolumePerSession } from "../../common/guards/client-throttler.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import type { AuthenticatedCustomer } from "../customer-auth/types";
import { AccountDevicesService } from "./account-devices.service";
import { DailyUsageService } from "./daily-usage.service";
import { DailyUsageQueryDto } from "./dto/daily-usage-query.dto";

/** The Activity screen's account data: the devices signed in to the
 * account, and data use per day. The contract is
 * docs/account-activity.md.
 *
 * Scoped to the calling customer by the token alone. Not open to an
 * account the relay let in unverified (none is marked @AllowUnverified),
 * and not on the relay allowlist: neither is needed to connect, and the
 * relay carries only what is.
 *
 * Each route caps its own volume per signed-in session -- there is
 * nothing to guess: a device id is scoped to the account asking, and a
 * subscription that is not the caller's is a 404. */
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Controller("customer")
export class AccountActivityController {
  constructor(
    private readonly devices: AccountDevicesService,
    private readonly usage: DailyUsageService,
  ) {}

  /** The devices signed in to this account, this one marked, and which of
   * them hold a device slot now. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ThrottleVolumePerSession()
  @Get("devices")
  list(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.devices.list({ customerId: customer.sub, sessionId: customer.sid });
  }

  /** Signs another of this account's devices out. 204; 404 for an id that
   * is not one of this account's signed-in devices; 400 THIS_DEVICE for
   * the caller's own (that is POST /customer-auth/logout). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ThrottleVolumePerSession()
  @Delete("devices/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@CurrentCustomer() customer: AuthenticatedCustomer, @Param("id") id: string) {
    await this.devices.signOut({ customerId: customer.sub, sessionId: customer.sid }, id);
  }

  /** Data used per day on the whole account -- every subscription it has
   * had, every device -- in the caller's time zone. What the Activity
   * card shows: a purchase is a new subscription, so a history per
   * subscription would start again at each one. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ThrottleVolumePerSession()
  @Get("usage")
  accountUsage(@CurrentCustomer() customer: AuthenticatedCustomer, @Query() query: DailyUsageQueryDto) {
    return this.usage.forCustomer(customer.sub, { days: query.days, timeZone: query.tz });
  }

  /** Data used per day on one of this customer's subscriptions, every
   * device together, in the caller's time zone. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ThrottleVolumePerSession()
  @Get("subscriptions/:id/usage")
  dailyUsage(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param("id") id: string,
    @Query() query: DailyUsageQueryDto,
  ) {
    return this.usage.forSubscription(customer.sub, id, { days: query.days, timeZone: query.tz });
  }
}
