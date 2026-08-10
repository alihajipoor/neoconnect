import { Controller, Get, Ip, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { PrismaService } from "../../prisma/prisma.service";
import { clientIpOf } from "../../common/client-ip";

/** The caller's country, as a two-letter code, when the CDN told us.
 *
 * Cloudflare adds this to every proxied request, so it costs nothing --
 * no GeoIP database to ship, license or keep current. It is only used to
 * pick a first-run language, which is why a wrong or missing answer is
 * harmless: the customer sees English and the language switch is right
 * there in Settings.
 *
 * Absent whenever the request did not come through the CDN -- a node's
 * API mirror, or the origin dialled directly -- and callers must treat
 * that as "unknown" rather than as anywhere in particular.
 *
 * "XX" is Cloudflare's own value for an address it cannot place, and "T1"
 * is what it reports for Tor. Both are noise here, so both are dropped
 * rather than passed on as if they meant something.
 */
function countryOf(req: Request): string | undefined {
  const raw = req.headers["cf-ipcountry"];
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  if (!code || code === "XX" || code === "T1") return undefined;
  return code;
}

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
    return { ip: clientIpOf(req) || ip, country: countryOf(req) };
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
