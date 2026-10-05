import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AsnTable, ipv6High64, ipv4ToInt, normaliseIp } from "./asn-table";
import { loadGzippedTsv } from "./asn-lookup.service";

/** Rows in iptoasn.com's format, on documentation ranges only (RFC 5737
 * and RFC 3849). Deliberately out of order, with a header-ish line, a
 * "not routed" AS 0 row and garbage, because the real file has the first
 * two and a corrupt download has the last. */
const ROWS = [
  "range_start\trange_end\tAS_number\tcountry_code\tAS_description",
  "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-HOST Example Hosting",
  "192.0.2.0\t192.0.2.127\t64500\tIR\tEXAMPLE-ISP Example Carrier",
  "192.0.2.128\t192.0.2.255\t0\tNone\tNot routed",
  "2001:db8::\t2001:db8:ffff:ffff:ffff:ffff:ffff:ffff\t64502\tIR\tEXAMPLE-V6 Example Mobile",
  "this is not a row",
];

describe("AsnTable", () => {
  const table = AsnTable.fromLines(ROWS);

  it("finds the network an IPv4 address is announced in", () => {
    expect(table.lookup("192.0.2.1")).toEqual({ asn: 64500, org: "EXAMPLE-ISP Example Carrier" });
    expect(table.lookup("203.0.113.255")).toEqual({ asn: 64501, org: "EXAMPLE-HOST Example Hosting" });
  });

  /** AS 0 is the dataset saying "nobody announces this". Reporting it as
   * a network would group every unrouted address into one fake ISP. */
  it("treats unrouted space and gaps as no network", () => {
    expect(table.lookup("192.0.2.200")).toBeNull();
    expect(table.lookup("198.51.100.1")).toBeNull();
  });

  it("finds IPv6, which a good share of Iranian mobile traffic is", () => {
    expect(table.lookup("2001:db8:1234::1")?.asn).toBe(64502);
    expect(table.lookup("2001:db9::1")).toBeNull();
  });

  /** How a dual-stack socket reports an IPv4 peer. Looked up as IPv6 it
   * would land in a block that belongs to nobody. */
  it("unwraps an IPv4-mapped address", () => {
    expect(normaliseIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(table.lookup("::ffff:192.0.2.1")?.asn).toBe(64500);
  });

  it("answers null for things that are not addresses", () => {
    expect(table.lookup("")).toBeNull();
    expect(table.lookup("not-an-ip")).toBeNull();
  });

  it("keeps each network's name", () => {
    expect(table.orgOf(64502)).toBe("EXAMPLE-V6 Example Mobile");
    expect(table.orgOf(1)).toBeNull();
    expect(table.size).toBe(3);
  });
});

describe("address parsing", () => {
  it("reads a dotted quad as an unsigned 32-bit value", () => {
    expect(ipv4ToInt("255.255.255.255")).toBe(0xffffffff);
    expect(ipv4ToInt("192.0.2.1")).toBe(0xc0000201);
  });

  it("reads the routing half of an IPv6 address in every spelling", () => {
    const full = ipv6High64("2001:0db8:0000:0001:0000:0000:0000:0001");
    expect(ipv6High64("2001:db8:0:1::1")).toBe(full);
    expect(ipv6High64("2001:db8:0:1::")).toBe(full);
    expect(ipv6High64("::")).toBe(0n);
    expect(ipv6High64("::ffff:192.0.2.1")).toBe(0n);
  });
});

/** The loader reads the real download format: gzipped TSV, streamed. */
describe("loadGzippedTsv", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "asn-test-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a gzipped file, Windows line endings and all", async () => {
    const path = join(dir, "ok.tsv.gz");
    writeFileSync(path, gzipSync(ROWS.join("\r\n")));
    const table = await loadGzippedTsv(path);
    expect(table.lookup("192.0.2.1")?.asn).toBe(64500);
    expect(table.lookup("2001:db8::1")?.asn).toBe(64502);
  });

  /** A truncated or corrupt download must reject, not raise an unhandled
   * stream error that takes the API down over an optional feature. */
  it("rejects a corrupt file rather than crashing", async () => {
    const path = join(dir, "bad.tsv.gz");
    writeFileSync(path, gzipSync(ROWS.join("\n")).subarray(0, 20));
    await expect(loadGzippedTsv(path)).rejects.toThrow();
  });
});
