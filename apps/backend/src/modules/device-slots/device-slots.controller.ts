import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { deviceInfoFrom } from "../../common/device-info";
import type { AuthenticatedCustomer } from "../customer-auth/types";
import { DeviceSlotsService } from "./device-slots.service";
import { ClaimSlotDto, ReleaseSlotDto, RenewSlotDto } from "./dto/slot.dto";

/** Requests a minute one device may make to these endpoints. A device
 * renews once a minute and claims a few times per connect; this is
 * room for a client stuck in a loop, not a budget anyone legitimate
 * gets near. */
export const SLOT_REQUESTS_PER_MINUTE = 60;

/** Whose bucket a request counts against: the device's access token,
 * hashed -- never the address.
 *
 * The app's global limit is per address (req.ip), and here that is the
 * wrong key. Requests that come through a node's API mirror (the usual
 * path when the panel's domain is filtered in Iran) all carry the
 * mirror's address, and requests sent through the tunnel carry the
 * node's egress address, so hundreds of customers share one bucket; so
 * do customers behind one carrier-grade NAT. After a network blip more
 * than a hundred of them pressing Connect within a minute would have
 * had the 101st claim refused with a bare 429 -- blocked by the control
 * plane, not by their plan.
 *
 * The token rather than the session in it: this runs before the JWT
 * guard, so nothing in the token has been verified yet, and keying on
 * an unverified `sid` would let anyone empty a victim's bucket by
 * forging one. A token nobody holds buys only a 401. */
export function slotRequestTracker(req: Record<string, unknown>): string {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.length > 0) {
    return `token:${createHash("sha256").update(auth).digest("hex")}`;
  }
  return `ip:${String(req.ip)}`;
}

/** Device slots -- the HTTP contract is docs/device-slots.md, and that
 * document, not this file, is what the apps are built against. Change
 * the two together. */
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Throttle({ default: { limit: SLOT_REQUESTS_PER_MINUTE, ttl: 60_000, getTracker: slotRequestTracker } })
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

  /** While connected, every renewEverySec. 200 with a `status`, never 409;
   * anything else (the request limit's 429 included) the app ignores. */
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
