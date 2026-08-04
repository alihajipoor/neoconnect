import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authenticates a machine caller by shared secret, presented as
 * `X-Service-Token`. Used by the Discord bot, which needs to read a handful
 * of facts about the deployment and must never hold an admin login to do it:
 * an admin JWT would carry the whole panel's authority into a process that
 * only ever needs to answer "how many nodes are up".
 *
 * Fails closed. When INTEGRATIONS_SERVICE_TOKEN is unset the guarded routes
 * reject everything rather than falling open -- an unconfigured integration
 * should be unreachable, not public.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("integrations.serviceToken");
    if (!expected) {
      throw new UnauthorizedException("Service integrations are not configured");
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers["x-service-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented) {
      throw new UnauthorizedException("Missing service token");
    }

    // Compared as fixed-width digests so the comparison cannot leak the
    // secret's length, which a raw timingSafeEqual on the strings would --
    // it throws outright when the buffers differ in size.
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Invalid service token");
    }

    return true;
  }
}
