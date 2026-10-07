import { type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";

/** Metadata naming a route whose body carries a customer refresh token,
 * so its bucket can follow the session in that token. See
 * ClientThrottlerGuard. */
export const THROTTLE_BY_REFRESH_TOKEN = "neoxify:throttle-by-refresh-token";

/** Count this route per signed-in session (taken from `body.refreshToken`)
 * rather than per address, once that token verifies. */
export const ThrottleByRefreshToken = () => SetMetadata(THROTTLE_BY_REFRESH_TOKEN, true);

/** The key @nestjs/throttler stores a route's own `@Throttle` limit under,
 * per named throttler. Not exported by the package; its spec pins it, so
 * a library upgrade that renames it fails a test instead of quietly
 * moving every guess-limited route onto session keys. */
const THROTTLER_LIMIT = "THROTTLER:LIMIT";

/** The app's rate limit, counted per signed-in session where there is one.
 *
 * The stock guard counts every request against `req.ip`. Behind a node's
 * API mirror (the usual way in when the panel's domain is filtered in
 * Iran) and through a live tunnel, `req.ip` is the node's address, so
 * every customer on that node shares one bucket per route: a hundred
 * junk refreshes a minute from anyone -- no account needed, the mirrors
 * are public -- and every other customer on the node is refused a token
 * refresh, and from then on every authenticated call. Carrier-grade NAT
 * does the same to customers on one mobile network.
 *
 * So a request that carries a token which VERIFIES is counted against
 * the session in it:
 *
 * - `Authorization: Bearer` with a customer or admin access token;
 * - `body.refreshToken` on a route marked @ThrottleByRefreshToken().
 *
 * Verified, not merely hashed (as device slots do). A key taken from an
 * unverified header hands a fresh bucket to every forged value, and an
 * unbounded number of keys to the in-memory store. A token that does not
 * verify is counted against the address exactly as before -- and is
 * refused by the route's own guard anyway.
 *
 * Only on routes that use the global default limit. A route that sets
 * its own `@Throttle` is limiting guesses (change-password's current
 * password, a purchase being redeemed, a sign-in), and there the
 * address stays the key: a session is something an attacker with one
 * account can mint more of.
 *
 * What this does not fix, and why. The unauthenticated routes --
 * sign-in, sign-up, password reset, the sign-in challenge -- and
 * LoginGuard's per-source counters still count per address, so customers
 * behind one node still share those. The node's nginx does put the real
 * client into X-Forwarded-For, but trusting that entry when the request
 * comes from a node's address cannot be done safely: a customer's own
 * tunnel traffic also arrives from that address, carrying whatever
 * X-Forwarded-For the customer chose, and the two are indistinguishable
 * here. Telling them apart needs the mirror to authenticate its hop to
 * the panel (a per-node secret header, or a client certificate), which
 * is a node-side change.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  private readonly jwt = new JwtService({});

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  // The library calls this as getTracker(req, context); its declaration
  // names only the first.
  protected override async getTracker(req: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    const address = await super.getTracker(req);
    if (!context || this.routeSetsItsOwnLimit(context)) return address;
    return this.sessionOf(req, context) ?? address;
  }

  private routeSetsItsOwnLimit(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    return this.throttlers.some(
      (throttler) => this.reflector.getAllAndOverride<unknown>(THROTTLER_LIMIT + throttler.name, targets) !== undefined,
    );
  }

  private sessionOf(req: Record<string, unknown>, context: ExecutionContext): string | undefined {
    const headers = (req.headers ?? {}) as Record<string, unknown>;
    const auth = headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const token = auth.slice(7);
      const customer = this.verified(token, "customerJwt.accessSecret");
      if (customer) return `customer:${customer.sub}:${customer.sid ?? ""}`;
      const admin = this.verified(token, "jwt.accessSecret");
      if (admin) return `admin:${admin.sub}`;
    }

    if (this.reflector.getAllAndOverride<boolean>(THROTTLE_BY_REFRESH_TOKEN, [context.getHandler(), context.getClass()])) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.refreshToken === "string") {
        const customer = this.verified(body.refreshToken, "customerJwt.refreshSecret");
        if (customer) return `customer:${customer.sub}:${customer.sid ?? ""}`;
      }
    }
    return undefined;
  }

  /** The token's subject and session, when it was signed with that secret
   * and is current. A single-purpose token (an emailed verification or
   * reset link, an admin's half-finished MFA sign-in) is not a session
   * and is not counted as one. */
  private verified(token: string, secretKey: string): { sub: string; sid?: string } | undefined {
    const secret = this.config.get<string>(secretKey);
    if (!secret) return undefined;
    try {
      const payload = this.jwt.verify<{ sub?: unknown; sid?: unknown; purpose?: unknown }>(token, { secret });
      if (typeof payload.sub !== "string" || payload.purpose !== undefined) return undefined;
      return { sub: payload.sub, sid: typeof payload.sid === "string" ? payload.sid : undefined };
    } catch {
      return undefined;
    }
  }
}
