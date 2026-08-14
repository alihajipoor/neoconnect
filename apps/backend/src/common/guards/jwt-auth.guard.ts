import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { AdminRole } from "@prisma/client";
import type { Request } from "express";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { AuthenticatedAdmin } from "../../modules/auth/types";

/**
 * Roles that are NOT operator staff, and therefore get nothing by
 * default.
 *
 * RESELLER is an outsider who happens to hold a panel login. Every other
 * admin role is someone the operator hired.
 */
const OUTSIDER_ROLES = new Set<AdminRole>([AdminRole.RESELLER]);

/**
 * Admin authentication, plus a default-deny for outsider roles.
 *
 * WHY THE SECOND HALF IS HERE. RolesGuard allows any authenticated admin
 * through a route that declares no @Roles(), which was safe while every
 * role was staff. Most admin controllers declare none -- `customers`,
 * `protocol-users`, `routes`, `protocol-configs`, `subscriptions` (GET),
 * `invoices` (GET), `nodes` (GET), `billing/payments`, `client-attempts`
 * -- and RESELLER was added to that world in M25 without changing it.
 *
 * The panel's sidebar was made an allowlist at the time and its comment
 * says "the backend gates each endpoint too -- this is the navigation,
 * not the security boundary". That was not so. A reseller who typed a
 * URL, or sent one request with their own token, could read every
 * customer's email (`GET /customers`), every customer's DECRYPTED VPN
 * credentials (`GET /protocol-users`), the OpenVPN CA private key
 * carried in `publicParamsJson` (`GET /protocol-configs`) and relay
 * uplink credentials (`GET /routes`) -- and could set any customer's
 * password (`PATCH /customers/:id` accepts one) or delete a route and
 * take the service down (`DELETE /routes/:id`).
 *
 * Putting it in the authentication guard rather than in RolesGuard is
 * deliberate: several of those controllers do not include RolesGuard in
 * their chain at all, so a change there would not have run. JwtAuthGuard
 * is what every admin endpoint has in common.
 *
 * The default is now the safe one: a new admin endpoint is closed to
 * outsiders until someone writes @Roles(AdminRole.RESELLER, ...) on it,
 * rather than open until someone notices.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) {
      return false;
    }

    // A route that states its own roles has already thought about this;
    // RolesGuard makes that call, including for the reseller's own
    // endpoints (@Roles(RESELLER, SUPERADMIN) on /reseller/*).
    const declared = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (declared && declared.length > 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedAdmin }>();
    const role = request.user?.role;
    if (role && OUTSIDER_ROLES.has(role)) {
      throw new ForbiddenException("This account does not have access to that area");
    }

    return true;
  }
}
