import { ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedCustomer } from "../../modules/customer-auth/types";

export const ALLOW_UNVERIFIED = "neoxify:allow-unverified";

/** Marks a customer route an account the relay let in with an
 * unconfirmed address may use. Everything not marked is refused to such
 * an account (docs/relay-last-resort.md, R3.3). */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);

/** Accounts known to be verified, and until when that answer is reused.
 * Verification only ever goes one way except when support moves an
 * account to a new address, which calls forgetVerified. */
const verified = new Map<string, number>();
const VERIFIED_TTL_MS = 10 * 60_000;
const VERIFIED_MAX = 50_000;

export function forgetVerified(customerId: string): void {
  verified.delete(customerId);
}

/** The customer session guard, and the default-deny rule for accounts
 * the relay let in with an unconfirmed address.
 *
 * Such an account holds a session without having proven its mailbox -- a
 * relay sign-up (R3), an unverified account signing in over the relay
 * from Iran (R4.2), or one support moved to a new address (R3.9), all of
 * which set relayUnverifiedSince -- and what it may do is a short list:
 * sign out, read its account, subscriptions, routes and credentials,
 * redeem a single-use Ultimate voucher, change its address or password,
 * and manage its recovery code (I3). That list is the routes marked
 * @AllowUnverified, and this guard refuses every other route with 403
 * VERIFY_EMAIL.
 *
 * Only those. An account older than verification (2026-07-24, added with
 * no backfill) can have an unconfirmed address and a session that has
 * refreshed ever since -- refresh never asked about verification -- and
 * such a session keeps everything it had before the relay existed. Normal
 * sign-in still refuses an unverified account, so no new session of that
 * kind is made.
 *
 * Here rather than in a guard of its own because every customer route
 * already names this one: a second guard is a second thing a new route
 * could forget, and then the default would be "allow".
 */
@Injectable()
export class CustomerJwtAuthGuard extends AuthGuard("customer-jwt") {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedCustomer }>().user;
    if (!user?.sub) throw new UnauthorizedException();
    // Recorded for the handlers that narrow what a limited account may do
    // inside a route it may use (vouchers).
    user.limited = await this.isLimited(user.sub);
    if (!user.limited) return true;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_UNVERIFIED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: "VERIFY_EMAIL",
      message: "Confirm your email to unlock all plans and payments. Your current plan is not affected.",
    });
  }

  /** Only a verified answer is remembered: an unverified account that is
   * not limited becomes limited the moment it signs in over the relay. */
  private async isLimited(customerId: string): Promise<boolean> {
    const now = Date.now();
    const until = verified.get(customerId);
    if (until && until > now) return false;
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { emailVerifiedAt: true, relayUnverifiedSince: true },
    });
    if (!customer) throw new UnauthorizedException("This account no longer exists");
    if (!customer.emailVerifiedAt) return customer.relayUnverifiedSince != null;
    if (verified.size >= VERIFIED_MAX) verified.clear();
    verified.set(customerId, now + VERIFIED_TTL_MS);
    return false;
  }
}
