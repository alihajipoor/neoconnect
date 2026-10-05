import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { resolve4, resolve6 } from "node:dns/promises";
import { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "./asn-lookup.service";
import { normaliseIp, type AsnInfo } from "./asn-table";
import { networkAttestor, type NetworkAttestor } from "./network-attestation";

/** How long the list of our own addresses is trusted before re-reading.
 * Nodes are added by hand a few times a month; five minutes is "soon
 * enough" for a new one and costs one small query. */
const OWN_ADDRESSES_TTL_MS = 5 * 60_000;

/** Which network a caller is on, when that can be said honestly.
 *
 * The one rule this exists to enforce: **an address that is one of our
 * own is never anybody's network.** Two ordinary paths deliver one:
 *
 * * a client asking `/health/ip` through a live tunnel, whose request
 *   leaves from the node -- the after-connect egress check does exactly
 *   this, every time;
 * * a client whose first working API endpoint is a node's mirror, which
 *   proxies to the CDN, which then reports the *node's* address as the
 *   caller (`apps/desktop-windows/src/lib/egress.ts`, `IpReading`).
 *
 * Either one, believed, would file a customer's experience under the
 * hosting provider of whichever node they happened to be using -- and,
 * worse, would attribute every success *through* a node to that node's
 * own data centre, which then "works well" by construction.
 *
 * Exact addresses only, deliberately not "any address in the same ASN as
 * a node". Some nodes sit in Iranian networks that are also consumer
 * ISPs, and excluding a node's whole ASN would silently remove a real
 * carrier's customers from the data. The cost of exact-match is that a
 * node egressing from an address it does not advertise (a second IPv4,
 * an IPv6 the panel does not know) is not caught; see the journal entry
 * of 2026-10-05.
 */
@Injectable()
export class NetworkIdentityService {
  private readonly logger = new Logger(NetworkIdentityService.name);
  private readonly attestor: NetworkAttestor;
  private ownAddresses: Set<string> = new Set();
  private ownAddressesAt = 0;
  private ownAddressesLoaded = false;
  private ownAddressesLoading: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly asn: AsnLookupService,
    config: ConfigService,
  ) {
    // The same secret the exit handles are minted from, under a
    // different derivation label. See network-attestation.ts.
    this.attestor = networkAttestor(config.get<string>("security.exitHandleSecret"));
  }

  /** The network of `ip`, or null when it is unknown or one of ours. */
  async identify(ip: string | undefined | null): Promise<AsnInfo | null> {
    if (!ip) return null;
    const info = this.asn.lookup(ip);
    if (!info) return null;
    if (await this.isOwnAddress(ip)) return null;
    return info;
  }

  /** A token for `asn` that the client can hand back with its reports. */
  attest(asn: number): string | null {
    return this.attestor.issue(asn);
  }

  /** The ASN a client-supplied token vouches for, or null. */
  verify(token: string | undefined | null): number | null {
    return this.attestor.verify(token);
  }

  orgOf(asn: number): string | null {
    return this.asn.orgOf(asn);
  }

  /** Whether `ip` is one of ours -- or might be.
   *
   * Fails closed: until the node list has been read successfully once,
   * every address answers true, so the caller treats it as unknown. Not
   * knowing which addresses are ours is not a reason to believe none
   * are. */
  async isOwnAddress(ip: string): Promise<boolean> {
    if (Date.now() - this.ownAddressesAt > OWN_ADDRESSES_TTL_MS) {
      this.ownAddressesLoading ??= this.loadOwnAddresses().finally(() => {
        this.ownAddressesLoading = null;
      });
      await this.ownAddressesLoading;
    }
    if (!this.ownAddressesLoaded) return true;
    return this.ownAddresses.has(normaliseIp(ip).toLowerCase());
  }

  /** Every node's advertised address, plus whatever its mirror hostname
   * resolves to.
   *
   * The mirror lookup is belt and braces -- a mirror normally lives on
   * its node's own address -- and is allowed to fail: a name that does
   * not resolve right now adds nothing, and must not block the rest.
   *
   * On a database error the previous set is kept rather than emptied.
   * An empty set would wave every node address through as a customer
   * network, which is the one outcome this class exists to prevent. */
  private async loadOwnAddresses(): Promise<void> {
    try {
      const nodes = await this.prisma.node.findMany({ select: { publicIp: true, mirrorHost: true } });
      const next = new Set<string>();
      for (const node of nodes) {
        if (node.publicIp) next.add(normaliseIp(node.publicIp).toLowerCase());
      }
      const mirrors = [...new Set(nodes.map((n) => n.mirrorHost).filter((h): h is string => Boolean(h)))];
      await Promise.all(
        mirrors.map(async (host) => {
          const [v4, v6] = await Promise.all([
            resolve4(host).catch(() => [] as string[]),
            resolve6(host).catch(() => [] as string[]),
          ]);
          for (const address of [...v4, ...v6]) next.add(normaliseIp(address).toLowerCase());
        }),
      );
      this.ownAddresses = next;
      this.ownAddressesAt = Date.now();
      this.ownAddressesLoaded = true;
    } catch (err) {
      this.logger.warn(`Could not refresh node addresses: ${(err as Error).message}`);
      // Try again on the next call rather than hammering a failing
      // database on every request in between.
      this.ownAddressesAt = Date.now() - OWN_ADDRESSES_TTL_MS + 30_000;
    }
  }
}
