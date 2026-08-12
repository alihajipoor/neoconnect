import { Controller, Get, Param } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags } from "@nestjs/swagger";
import { VouchersService } from "./vouchers.service";

/** Looking up a voucher without being signed in.
 *
 * Its own controller because the one beside it is guarded at class
 * level for admins, and this route has to be reachable by someone who
 * has no account at all -- which is the entire point of it.
 *
 * A voucher arrives as a link now, not just a code typed into the app,
 * because a customer who installed from Google Play or the App Store
 * cannot redeem one in-app: those builds ship without the field, since
 * a reseller's code is a purchase made outside the store and neither
 * the app nor a reviewer can tell it apart from a free giveaway. So the
 * link lands on the web, and the page there has to show what the code
 * is worth *before* asking anyone to create an account. Nobody should
 * have to sign up to find out whether a code they were given is real.
 *
 * Deliberately read-only. Redemption stays behind
 * POST /customer/vouchers/redeem, because it has to attach the plan to
 * somebody, and that somebody must be authenticated.
 */
@ApiTags("vouchers")
@Controller("vouchers")
export class PublicVouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  /* Rate limited because this answers "is this code real, and what is it
   * worth" to anyone who asks -- an oracle, and worth treating as one
   * even though the arithmetic is comfortable. A code is 12 characters
   * from a 32-symbol alphabet, so roughly 2^60 possibilities: guessing
   * is not a threat today. The limit is here for the day someone
   * shortens the code or narrows the alphabet for readability, which is
   * exactly the kind of well-meaning change that turns an unguarded
   * lookup into a way to harvest live vouchers.
   *
   * Five a minute matches the customer-auth endpoints. A real person
   * following a link from an email makes one request.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get(":code/preview")
  preview(@Param("code") code: string) {
    // Throws NotFoundException for a code that is unknown, spent,
    // expired or deactivated -- one answer for all four on purpose, so
    // this cannot be used to tell "never existed" from "already used",
    // which would let someone probe which codes had been issued.
    return this.vouchers.preview(code);
  }
}
