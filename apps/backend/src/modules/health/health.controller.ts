import { Controller, Get, Ip, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import { PrismaService } from "../../prisma/prisma.service";
import { clientIpOf } from "../../common/client-ip";
import { NetworkIdentityService } from "../network-identity/network-identity.service";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: NetworkIdentityService,
  ) {}

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
  async ip(@Ip() ip: string, @Req() req: Request) {
    const address = clientIpOf(req) || ip;
    return { ip: address, country: countryOf(req), ...(await this.networkOf(address)) };
  }

  /** Which network the caller is on, and a signed note saying so.
   *
   * Added for the per-ISP tags in the location picker. The pre-connect
   * baseline is the one request in a connect where the server sees the
   * customer's own address -- everything afterwards goes through the
   * tunnel -- so it is where the network is read, and the client keeps
   * `network` (an opaque attestation, see network-attestation.ts) to
   * hand back with its reports and route-list requests.
   *
   * The network only: the autonomous system's number and registered
   * name, from an offline table. No city, no coordinates -- the comment
   * on `countryOf` explains why this file avoided a GeoIP database, and
   * an ASN table is not one: it says "Irancell", which the customer
   * already knows, and nothing about where they are.
   *
   * Omitted entirely when the address is one of our own nodes -- the
   * after-connect reading, or a node mirror answering the baseline --
   * because then it would name a data centre, not the customer's ISP.
   * Also omitted while the table has not loaded. Never throws: this
   * endpoint is what the egress check depends on, and a lookup problem
   * must cost the tags, not the connection. */
  private async networkOf(address: string | undefined) {
    try {
      const info = await this.identity.identify(address);
      if (!info) return {};
      return { asn: info.asn, asnOrg: info.org || undefined, network: this.identity.attest(info.asn) ?? undefined };
    } catch {
      return {};
    }
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
