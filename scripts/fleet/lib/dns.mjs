/**
 * DNS record matching for `fleet`: which records belong to a server,
 * which names are free, and what may be shown.
 *
 * A released address goes to a stranger, who can then get a valid
 * certificate for any name still pointing at it and receive our clients'
 * API calls, bearer tokens included. So "which records point at this
 * address" has to be exact, and has to look in every zone.
 */

export const isV4 = (s) =>
  typeof s === "string" &&
  /^\d{1,3}(\.\d{1,3}){3}$/.test(s) &&
  s.split(".").every((p) => Number(p) <= 255);

/** a.b.x.x, so a log line never carries a whole node address. */
export const maskV4 = (s) => (isV4(s) ? s.split(".").slice(0, 2).join(".") + ".x.x" : s);

/**
 * Records whose content IS the address. Equality, never a prefix or a
 * substring: 203.0.113.1 must not match 203.0.113.10.
 */
export function recordsPointingAt(records, ip) {
  if (!isV4(ip)) throw new Error("not an IPv4 address");
  return records.filter((r) => r.type === "A" && r.content === ip);
}

export function recordsNamed(records, fqdn) {
  const want = fqdn.toLowerCase().replace(/\.$/, "");
  return records.filter((r) => String(r.name).toLowerCase().replace(/\.$/, "") === want);
}

/** True for the zone itself and for anything under it, never for a look-alike suffix. */
export function underZone(name, zone) {
  const n = name.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  return n === z || n.endsWith("." + z);
}

/** Names that sit in none of the zones the tool can edit: the owner's to delete by hand. */
export function namesOutsideZones(names, zones) {
  return [...new Set(names.filter(Boolean))].filter((n) => !isV4(n) && !zones.some((z) => underZone(n, z)));
}

/**
 * A six-character label: a letter, then letters and digits. Random, so
 * the name says nothing about the server behind it (no country code, no
 * number, no brand).
 */
export function randomLabel(bytes) {
  if (!bytes || bytes.length < 6) throw new Error("need six random bytes");
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = c[bytes[0] % 26];
  for (let i = 1; i < 6; i++) s += c[bytes[i] % 36];
  return s;
}

/** One output line for a record, address masked. */
export const recordLine = (r) =>
  [r.type, r.name, "proxied=" + r.proxied, maskV4(r.content), "ttl=" + r.ttl, r.id].join("\t");

/** The body for a node name: DNS-only, never proxied, no AAAA. */
export function aRecordBody(name, ip, zone) {
  if (!isV4(ip)) throw new Error("not an IPv4 address");
  if (!underZone(name, zone) || name === zone) throw new Error("name is not under the zone");
  return { type: "A", name, content: ip, ttl: 1, proxied: false };
}

/**
 * A DNS-over-HTTPS JSON answer, read three ways:
 *  - "gone":    NXDOMAIN (Status 3), which is what a deleted name must give;
 *  - "is <ip>": exactly one A answer equal to the address;
 *  - "other":   anything else, returned as-is for the caller to refuse.
 */
export function dohVerdict(json, ip = "") {
  if (json && json.Status === 3) return "gone";
  const a = (json?.Answer ?? []).filter((x) => x.type === 1).map((x) => x.data);
  if (json?.Status === 0 && a.length === 0) return "empty";
  if (ip && a.length === 1 && a[0] === ip) return "match";
  return "other";
}
