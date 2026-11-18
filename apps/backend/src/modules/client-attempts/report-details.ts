import { BlockList, isIP } from "node:net";
import type { Prisma } from "@prisma/client";
import type { ReportDetailsDto } from "./dto/report-details.dto";
import { serviceCheckTargetFor } from "./service-check-targets";

/** The most a stored `details` object may weigh, serialized, in bytes.
 * Over it the details are dropped and the report kept: the report is the
 * part worth having, and a bundle this size is either a bug or abuse. */
export const DETAILS_MAX_BYTES = 8 * 1024;

export type DetailsVerdict =
  | { details: Prisma.InputJsonObject; dropped: null; servicesDropped: number }
  | { details: null; dropped: "empty" | "too-large"; servicesDropped: number; bytes?: number };

/** What kind of address a service target resolved to, stored beside the
 * address itself.
 *
 * The address is kept on purpose. It is the answer the customer's line or
 * tunnel gave for a name on OUR list, and it is the one fact that tells a
 * poisoned answer (which block-page address), a wrong region's edge or an
 * IPv6-only answer apart; the owner asked for it by name. It is not a
 * visited site: the app reports it only for the fixed targets, and the
 * key and host beside it are held to the server's list below. A modified
 * client can put some other address there, but only into its own report,
 * and that is the customer misreporting themselves, not this feature
 * recording where anybody went.
 *
 * The kind is worked out here so every reader agrees on it: a well-known
 * name resolving to a private or reserved address is what a poisoned
 * lookup looks like. */
export const ADDRESS_KINDS = ["public", "private", "loopback", "link-local", "reserved"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

function blockList(entries: [string, number, "ipv4" | "ipv6"][]): BlockList {
  const list = new BlockList();
  for (const [net, prefix, type] of entries) list.addSubnet(net, prefix, type);
  return list;
}

const PRIVATE = blockList([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["fc00::", 7, "ipv6"],
]);
const LOOPBACK = blockList([
  ["127.0.0.0", 8, "ipv4"],
  ["::1", 128, "ipv6"],
]);
const LINK_LOCAL = blockList([
  ["169.254.0.0", 16, "ipv4"],
  ["fe80::", 10, "ipv6"],
]);
const RESERVED = blockList([
  ["0.0.0.0", 8, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 3, "ipv4"],
  ["::", 128, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["ff00::", 8, "ipv6"],
]);

/** The kind of an IP literal, or null when it is not one. An IPv4-mapped
 * IPv6 address is judged as the IPv4 address it carries. */
export function addressKind(address: string): AddressKind | null {
  let value = address.trim();
  let family = isIP(value);
  if (family === 0) return null;
  const mapped = family === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value) : null;
  if (mapped) {
    value = mapped[1];
    family = 4;
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(value, type)) return "loopback";
  if (PRIVATE.check(value, type)) return "private";
  if (LINK_LOCAL.check(value, type)) return "link-local";
  if (RESERVED.check(value, type)) return "reserved";
  return "public";
}

/** What of a validated `details` object is stored.
 *
 * 1. Undefined and null keys go (a JSON round trip): `@IsOptional()` lets
 *    an explicit null through, and a null is "not reported", the same as
 *    leaving the key out -- stored as such, it would read as a value.
 * 2. THE BOUNDARY, enforced here and not in the client: a service result
 *    is kept only when its key and host together name one entry of the
 *    server's fixed list, current or previous. A modified client can send
 *    anything the DTO accepts; it cannot make this server keep a result
 *    for a site it did not choose, nor file one under a name it made up.
 *    The host stored is the list's own spelling. If no result is left the
 *    key goes.
 * 3. A result's `address` is kept only when it is an IP literal, in its
 *    trimmed form, with its kind (`addressKind`) stored beside it.
 * 4. Over DETAILS_MAX_BYTES the whole object is dropped.
 */
export function keepServiceResults(input: ReportDetailsDto | undefined | null): DetailsVerdict {
  if (!input) return { details: null, dropped: "empty", servicesDropped: 0 };
  const details = JSON.parse(JSON.stringify(input, (_key, value: unknown) => (value === null ? undefined : value))) as Record<
    string,
    unknown
  >;
  let servicesDropped = 0;
  if (Array.isArray(details.services)) {
    const kept: Record<string, unknown>[] = [];
    for (const s of details.services as unknown[]) {
      if (typeof s !== "object" || s === null) continue;
      const result = s as Record<string, unknown>;
      if (typeof result.key !== "string" || typeof result.host !== "string") continue;
      const target = serviceCheckTargetFor(result.key, result.host);
      if (!target) continue;
      const { address, ...rest } = result;
      const kind = typeof address === "string" ? addressKind(address) : null;
      kept.push({
        ...rest,
        host: target.host,
        ...(kind && typeof address === "string" ? { address: address.trim(), addressKind: kind } : {}),
      });
    }
    servicesDropped = details.services.length - kept.length;
    if (kept.length > 0) details.services = kept;
    else delete details.services;
  }
  if (Object.keys(details).length === 0) return { details: null, dropped: "empty", servicesDropped };
  const bytes = Buffer.byteLength(JSON.stringify(details), "utf8");
  if (bytes > DETAILS_MAX_BYTES) return { details: null, dropped: "too-large", servicesDropped, bytes };
  return { details: details as Prisma.InputJsonObject, dropped: null, servicesDropped };
}
