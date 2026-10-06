import { BadRequestException } from "@nestjs/common";

/** Picks the next free host address in `cidr` that isn't in `used` and
 * isn't the network/broadcast address or the first host (`.1` is always
 * the WireGuard server's own address -- see installer/lib/agent.sh's
 * install_wireguard). IPv4 only -- Phase 1 doesn't need IPv6 peer pools. */
export function allocateWireGuardAddress(cidr: string, used: string[]): string {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!base || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new BadRequestException(`Invalid WireGuard subnetCidr: ${cidr}`);
  }

  const baseInt = ipToInt(base);
  const size = 2 ** (32 - prefix);
  const network = baseInt - (baseInt % size);
  const broadcast = network + size - 1;

  const usedInts = new Set(used.map((addr) => ipToInt(addr.split("/")[0])));

  // network+1 is reserved for the WireGuard server's own address.
  for (let candidate = network + 2; candidate < broadcast; candidate++) {
    if (!usedInts.has(candidate)) {
      return intToIp(candidate);
    }
  }
  throw new BadRequestException(`No free addresses left in WireGuard subnet ${cidr}`);
}

/** How many peers a WireGuard subnet can hold: every address except the
 * network, the server's own `.1` and the broadcast -- exactly the
 * addresses allocateWireGuardAddress can hand out. 253 for the /24 the
 * installer configures. Null for a CIDR it could not parse. */
export function wireGuardPoolSize(cidr: string): number | null {
  const prefix = Number(cidr.split("/")[1]);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 30) return null;
  return 2 ** (32 - prefix) - 3;
}

/** Addresses only a subscription's shared credential may take.
 *
 * A device credential that cannot get an address falls back to its
 * subscription's shared one -- nothing is lost. A shared credential has
 * nothing to fall back to: it is what a paying customer, a renewal or a
 * new trial is provisioned with. Device credentials share the pool with
 * them (one customer can hold up to the device cap of them per config,
 * kept for up to 30 days idle), so without a reserve a pool filled by
 * devices would refuse the next paying customer. A quarter of the pool,
 * never less than 16: 63 of the 253 in a /24. */
export function sharedWireGuardReserve(poolSize: number): number {
  return Math.max(16, Math.floor(poolSize / 4));
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new BadRequestException(`Invalid IPv4 address: ${ip}`);
  }
  return parts[0] * 2 ** 24 + parts[1] * 2 ** 16 + parts[2] * 2 ** 8 + parts[3];
}

function intToIp(n: number): string {
  return [
    Math.floor(n / 2 ** 24) % 256,
    Math.floor(n / 2 ** 16) % 256,
    Math.floor(n / 2 ** 8) % 256,
    n % 256,
  ].join(".");
}
