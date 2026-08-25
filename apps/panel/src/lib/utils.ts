import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Formats a byte count (as a decimal string, since it may exceed
 * Number.MAX_SAFE_INTEGER for large plans) into a human-readable size. */
export function formatBytes(value: string | number): string {
  let bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let unitIndex = 0;
  while (bytes >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    bytes /= 1024;
    unitIndex += 1;
  }
  return `${bytes % 1 === 0 ? bytes : bytes.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/** Parses a human size like "10GB" or "512 MB" back into a byte count
 * string, for form input -> API payload conversion. */
export function parseBytesInput(input: string): string | null {
  const match = input.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return null;
  const [, numStr, unitStr] = match;
  const num = Number(numStr);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (unitStr ?? "GB").toUpperCase();
  const exponent = BYTE_UNITS.indexOf(unit as (typeof BYTE_UNITS)[number]);
  if (exponent < 0) return null;
  return Math.round(num * 1024 ** exponent).toString();
}

// ------------------------------------------------------------- validation

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** True for something that could plausibly be a DNS name, and false for
 * anything that is an address instead.
 *
 * The IP rejection is the point, not a nicety. A gaming profile's
 * hostnames are matched by a resolver and by an SNI proxy, and both of
 * those only ever see names -- an address typed into that list is
 * accepted by every layer, matches nothing at runtime, and looks
 * configured in the panel forever. */
export function isPlausibleHostname(input: string): boolean {
  const host = input.trim().toLowerCase();
  if (!host || host.length > 253) return false;
  // Rules out IPv6 literals and anything with a port glued on.
  if (host.includes(":") || host.includes("/")) return false;
  if (IPV4.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length > 63 || !DNS_LABEL.test(label))) return false;
  // A trailing all-numeric label would mean this was an address after all.
  return /^[a-z]{2,}$/.test(labels[labels.length - 1]);
}

/** True for a literal IPv4 or IPv6 address. */
export function isIpAddress(input: string): boolean {
  const value = input.trim();
  const v4 = value.match(IPV4);
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
  if (!value.includes(":")) return false;
  // Deliberately loose on IPv6: enough to catch a hostname or a typo'd
  // v4 address in an address field, without reimplementing RFC 4291.
  return /^[0-9a-f:]+$/i.test(value) && (value.match(/:/g)?.length ?? 0) >= 2;
}

/** True for an IPv4 or IPv6 network in CIDR form, prefix length included.
 * A bare address is false: these lists are matched as prefixes, and
 * "1.2.3.4" without a /32 is a different thing to whatever reads them. */
export function isCidr(input: string): boolean {
  const parts = input.trim().split("/");
  if (parts.length !== 2) return false;
  const [addr, prefix] = parts;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (addr.includes(":")) return isIpAddress(addr) && bits <= 128;
  return IPV4.test(addr) && isIpAddress(addr) && bits <= 32;
}
