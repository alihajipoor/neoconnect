import { ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedCustomer } from "../../modules/customer-auth/types";

export const ALLOW_UNVERIFIED = "neoxify:allow-unverified";

/** Marks a customer route an account with an unconfirmed address may
 * use. Everything not marked is refused to such an account
 * (docs/relay-last-resort.md, R3.3). */
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
 * whose address is unconfirmed.
 *
 * Normal sign-in refuses an unverified account, so until the relay of
 * last resort no such account held a session. Now one can -- a relay
 * sign-up (R3), or an unverified account signing in over the relay from
 * Iran (R4.2) -- and what it may do is a short list: sign out, read its
 * account, subscriptions, routes and credentials, redeem a single-use
 * Ultimate voucher, change its address or password, and manage its
 * recovery code (I3). That list is the routes marked @AllowUnverified,
 * and this guard refuses every other route with 403 VERIFY_EMAIL.
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
    // Recorded for the handlers that narrow what an unconfirmed account
    // may do inside a route it may use (vouchers).
    user.emailVerified = await this.isVerified(user.sub);
    if (user.emailVerified) return true;

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

  private async isVerified(customerId: string): Promise<boolean> {
    const now = Date.now();
    const until = verified.get(customerId);
    if (until && until > now) return true;
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { emailVerifiedAt: true },
    });
    if (!customer) throw new UnauthorizedException("This account no longer exists");
    if (!customer.emailVerifiedAt) return false;
    if (verified.size >= VERIFIED_MAX) verified.clear();
    verified.set(customerId, now + VERIFIED_TTL_MS);
    return true;
  }
}
