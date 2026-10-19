import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import { AdminAuditService } from "./admin-audit.service";

/** The methods that change something. Reads are not logged: they are
 * most of the traffic and none of the risk this log is for. */
const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ADMIN_ROLES = new Set<string>(Object.values(AdminRole));

interface AdminUser {
  sub: string;
  email: string;
  role: AdminRole;
}

/** Whether the request was authenticated as an admin -- by JwtAuthGuard,
 * which sets `{ sub, email, role }`. A customer's token carries no role,
 * and an unauthenticated request no user. */
function adminOf(user: unknown): AdminUser | null {
  if (typeof user !== "object" || user === null) return null;
  const { sub, email, role } = user as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string" || typeof role !== "string") return null;
  return ADMIN_ROLES.has(role) ? { sub, email, role: role as AdminRole } : null;
}

/** Records every change an authenticated admin makes, once the answer has
 * gone out, with the status it got -- a refusal is worth knowing about
 * too. Guards run before interceptors, so a request no admin
 * authenticated never reaches here; signing in is told to the owner by
 * AdminSignInAlertsService instead.
 *
 * The status is read when the response finishes, not when the handler
 * returns: @HttpCode and exception filters set it after this sees the
 * handler's value. Bodies are never read. */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: unknown }>();
    const admin = CHANGES.has(req.method) ? adminOf(req.user) : null;
    if (admin) {
      const res = http.getResponse<Response>();
      res.once("finish", () => {
        void this.audit.record({
          adminId: admin.sub,
          email: admin.email,
          role: admin.role,
          method: req.method,
          path: (req.originalUrl ?? req.url).split("?")[0],
          status: res.statusCode,
          ip: req.ip,
        });
      });
    }
    return next.handle();
  }
}
