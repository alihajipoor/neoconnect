import { isIPv4, isIPv6 } from "node:net";

/** Which network an address belongs to: the autonomous system that
 * announces it, and the name that system registered.
 *
 * Deliberately nothing finer. An ASN is "Irancell" or "TCI" -- the
 * carrier, the thing whose filtering a customer shares with everyone
 * else on it. City, coordinates and the address itself are what a GeoIP
 * database would add, and none of them says anything more about which
 * protocols get through; they would only make the data worth more to
 * somebody who should not have it. */
export interface AsnInfo {
  asn: number;
  org: string;
}

/** An org name long enough to recognise and short enough to never be the
 * largest thing in a response. Registry descriptions run to a paragraph
 * for some networks. */
const MAX_ORG_LENGTH = 100;

/** Parses a dotted quad to its 32-bit value, or null. */
export function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** The top 64 bits of an IPv6 address, or null.
 *
 * Only the top half, because routing never goes finer than that: the
 * longest prefix anyone announces in BGP is a /48, and a /64 is a single
 * subnet. Two addresses that agree on their first 64 bits are on the
 * same network by construction, so comparing the full 128 would cost a
 * BigInt per bit of nothing.
 *
 * Handles `::` compression and an embedded dotted quad
 * (`::ffff:192.0.2.1`), which is how a dual-stack socket reports an IPv4
 * peer -- the caller is expected to have unwrapped that case already
 * (see `normaliseIp`), but a parser that silently misreads it would be a
 * trap for the next one. */
export function ipv6High64(ip: string): bigint | null {
  if (!isIPv6(ip)) return null;
  let text = ip.split("%")[0];
  // An embedded IPv4 tail becomes the two hex groups it stands for.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4ToInt(tail[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = rest === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups.slice(0, 4)) value = (value << 16n) | BigInt(Number.parseInt(group || "0", 16));
  return value;
}

/** An IPv4 peer as seen through a dual-stack socket, unwrapped.
 *
 * Node reports one as `::ffff:192.0.2.1`. Looked up as IPv6 it lands in
 * the `::ffff:0:0/96` block, which belongs to nobody, so every such
 * caller would read as "no network" without this. */
export function normaliseIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : trimmed;
}

/** Collects rows of an ip2asn TSV into a table.
 *
 * The format is iptoasn.com's, one range per line:
 * `range_start TAB range_end TAB AS_number TAB country TAB description`.
 * Both families can arrive in one file (the "combined" download), and
 * rows can be added a line at a time so the loader can stream a file of
 * half a million lines without holding the text.
 */
export class AsnTableBuilder {
  private readonly v4: Array<[number, number, number]> = [];
  private readonly v6: Array<[bigint, bigint, number]> = [];
  private readonly orgs = new Map<number, string>();

  /** Adds one line. Returns false for anything it could not use --
   * headers, blanks, malformed rows, and AS 0, which is the dataset's
   * own marker for "not routed" and therefore for no network at all. */
  addLine(line: string): boolean {
    const [start, end, asText, , description] = line.split("\t");
    if (!start || !end || !asText) return false;
    const asn = Number.parseInt(asText, 10);
    if (!Number.isInteger(asn) || asn <= 0) return false;

    const v4Start = ipv4ToInt(start);
    if (v4Start !== null) {
      const v4End = ipv4ToInt(end);
      if (v4End === null || v4End < v4Start) return false;
      this.v4.push([v4Start, v4End, asn]);
    } else {
      const v6Start = ipv6High64(start);
      const v6End = ipv6High64(end);
      if (v6Start === null || v6End === null || v6End < v6Start) return false;
      this.v6.push([v6Start, v6End, asn]);
    }
    if (!this.orgs.has(asn)) this.orgs.set(asn, (description ?? "").trim().slice(0, MAX_ORG_LENGTH));
    return true;
  }

  build(): AsnTable {
    // The published files are already sorted by range start, so this is
    // normally a no-op pass. It is done anyway because the lookup is a
    // binary search, and a binary search over unsorted ranges does not
    // fail -- it quietly answers with the wrong network.
    this.v4.sort((a, b) => a[0] - b[0]);
    this.v6.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return new AsnTable(
      Uint32Array.from(this.v4, (r) => r[0]),
      Uint32Array.from(this.v4, (r) => r[1]),
      Uint32Array.from(this.v4, (r) => r[2]),
      BigUint64Array.from(this.v6, (r) => r[0]),
      BigUint64Array.from(this.v6, (r) => r[1]),
      Uint32Array.from(this.v6, (r) => r[2]),
      new Map(this.orgs),
    );
  }
}

/** An in-memory IP-to-ASN table, answered by binary search.
 *
 * Typed arrays rather than objects: the full dataset is around half a
 * million ranges, which as objects is a few hundred megabytes of heap
 * and as three parallel typed arrays is a few. */
export class AsnTable {
  constructor(
    private readonly v4Start: Uint32Array,
    private readonly v4End: Uint32Array,
    private readonly v4Asn: Uint32Array,
    private readonly v6Start: BigUint64Array,
    private readonly v6End: BigUint64Array,
    private readonly v6Asn: Uint32Array,
    private readonly orgs: Map<number, string>,
  ) {}

  static fromLines(lines: Iterable<string>): AsnTable {
    const builder = new AsnTableBuilder();
    for (const line of lines) builder.addLine(line);
    return builder.build();
  }

  get size(): number {
    return this.v4Start.length + this.v6Start.length;
  }

  /** The registered name of an ASN, if the dataset has one. */
  orgOf(asn: number): string | null {
    return this.orgs.get(asn) || null;
  }

  lookup(rawIp: string): AsnInfo | null {
    const ip = normaliseIp(rawIp);
    const v4 = ipv4ToInt(ip);
    const asn =
      v4 !== null
        ? search(this.v4Start, this.v4End, this.v4Asn, v4)
        : (() => {
            const v6 = ipv6High64(ip);
            return v6 === null ? null : search(this.v6Start, this.v6End, this.v6Asn, v6);
          })();
    if (asn === null) return null;
    return { asn, org: this.orgs.get(asn) ?? "" };
  }
}

/** The last range starting at or before `key`, if `key` is inside it.
 *
 * Ranges in the dataset do not overlap, so "the last one that starts no
 * later than this address" is the only candidate, and an address in a
 * gap between ranges correctly finds nothing. */
function search<T extends number | bigint>(
  starts: ArrayLike<T>,
  ends: ArrayLike<T>,
  asns: Uint32Array,
  key: T,
): number | null {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= key) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0 || ends[found] < key) return null;
  return asns[found];
}
