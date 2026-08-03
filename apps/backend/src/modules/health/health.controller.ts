import { Controller, Get, Ip, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** The public IP this request arrived from.
   *
   * The client calls this once before connecting and again after, and
   * compares. That comparison is the only check that cannot be fooled:
   * reaching 8.8.8.8 or any other host proves the internet works, not
   * that it works *through the tunnel* -- traffic leaking around a dead
   * tunnel answers a reachability probe perfectly well, which is exactly
   * the false "Connected" this is meant to catch. A changed source IP is
   * positive proof the packets went out somewhere else.
   *
   * Deliberately compared against the client's own earlier IP rather
   * than against the node's advertised address: on a relayed route the
   * traffic egresses at the exit node, not the relay the client dialled,
   * so "equals the host I connected to" would report a working relay as
   * broken.
   *
   * Unauthenticated because it returns only what the caller already
   * knows about itself, and because the pre-connect baseline is more
   * useful the fewer things it depends on. Throttling is skipped since
   * the client legitimately calls it twice in quick succession per
   * connection.
   */
  @SkipThrottle()
  @Get("ip")
  ip(@Ip() ip: string, @Req() req: Request) {
    // Behind nginx, @Ip() reflects the proxy unless trust proxy is set,
    // so prefer the forwarded header the panel's nginx config actually
    // sets (see installer/assets/nginx-panel.conf.template).
    const forwarded = req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    // X-Forwarded-For may be a chain; the client is the first entry.
    const client = raw?.split(",")[0]?.trim();
    return { ip: client || ip };
  }

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("database unreachable");
    }
    return { status: "ok", timestamp: new Date().toISOString() };
  }
}
