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
