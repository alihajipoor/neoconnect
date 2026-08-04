import { Controller, Get, Ip, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { PrismaService } from "../../prisma/prisma.service";

/** The address the *caller* came from, across however many proxies.
 *
 * The order matters and got this wrong once, in a way that would have
 * broken every connection in the product. X-Real-IP is set by nginx to
 * its immediate peer, so preferring it -- as this did -- returns the
 * last hop rather than the client: Cloudflare's address for anything
 * arriving through the CDN, and a VPN node's own address for anything
 * arriving through a node's API mirror.
 *
 * Since the client compares this before and after connecting to prove
 * its traffic really moved, a constant proxy address on both sides reads
 * as "the tunnel is carrying nothing" -- reporting every working
 * connection as unprotected. Measured, not theorised: through Cloudflare
 * this returned 162.158.41.5 while the caller was 50.47.175.127.
 *
 * So: Cloudflare's own header first where present, then the *leftmost*
 * X-Forwarded-For entry, which is the original client -- every proxy in
 * this path appends rather than replaces. X-Real-IP and the socket
 * address remain as last resorts for a direct connection with no
 * forwarding at all.
 *
 * These headers are client-supplied to anyone who reaches the backend
 * without passing a proxy, so a caller can lie here. That is harmless:
 * the value is only ever echoed back to whoever asked, and lying about
 * your own address only fools yourself. Nothing authorises, bills or
 * rate-limits on it -- the throttler is skipped on this route entirely.
 */
function clientIpOf(req: Request): string | undefined {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

  return (
    first(req.headers["cf-connecting-ip"]) ||
    first(req.headers["x-forwarded-for"]) ||
    first(req.headers["x-real-ip"])
  );
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
    return { ip: clientIpOf(req) || ip };
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
