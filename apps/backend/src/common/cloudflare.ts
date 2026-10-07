import { BlockList, isIP } from "node:net";

/** Cloudflare's edge ranges, as published at https://www.cloudflare.com/ips/
 * (fetched 2026-10-06; unchanged since 2021). A request whose TCP peer is
 * in one of these came through the CDN, and only then is Cloudflare's
 * own `CF-Connecting-IP` header something Cloudflare wrote rather than
 * something the caller did.
 *
 * Deliberately the published proxy list and not "anything in AS13335":
 * Cloudflare's WARP egress is in that AS too, and a WARP user dialling
 * the origin directly would otherwise be believed about the header. */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Cloudflare's own autonomous system. Never a customer's network: it is
 * either an edge this list has not caught up with, or WARP. */
export const CLOUDFLARE_ASN = 13335;

const edges = new BlockList();
for (const cidr of CLOUDFLARE_V4) {
  const [address, prefix] = cidr.split("/");
  edges.addSubnet(address, Number(prefix), "ipv4");
}
for (const cidr of CLOUDFLARE_V6) {
  const [address, prefix] = cidr.split("/");
  edges.addSubnet(address, Number(prefix), "ipv6");
}

export function isCloudflareAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  const address = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? trimmed;
  switch (isIP(address)) {
    case 4:
      return edges.check(address, "ipv4");
    case 6:
      return edges.check(address, "ipv6");
    default:
      return false;
  }
}
