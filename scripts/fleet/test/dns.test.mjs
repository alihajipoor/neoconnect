/**
 * DNS record matching (lib/dns.mjs). Addresses are from the
 * documentation ranges and names are RFC 2606: nothing here is real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aRecordBody, dohVerdict, isV4, maskV4, namesOutsideZones, randomLabel, recordLine, recordsNamed,
  recordsPointingAt, underZone,
} from "../lib/dns.mjs";

const rec = (name, content, type = "A", extra = {}) => ({ id: "a".repeat(32), name, content, type, proxied: false, ttl: 1, ...extra });

describe("recordsPointingAt", () => {
  const records = [
    rec("abc123.example.org", "203.0.113.10"),
    rec("def456.example.org", "203.0.113.10"),
    rec("other.example.org", "203.0.113.1"),
    rec("longer.example.org", "203.0.113.100"),
    rec("txt.example.org", "203.0.113.10", "TXT"),
    rec("alias.example.org", "abc123.example.org", "CNAME"),
  ];
  it("matches the address exactly, never a prefix of it", () => {
    assert.deepEqual(recordsPointingAt(records, "203.0.113.10").map((r) => r.name), ["abc123.example.org", "def456.example.org"]);
    assert.deepEqual(recordsPointingAt(records, "203.0.113.1").map((r) => r.name), ["other.example.org"]);
  });
  it("takes A records only", () => {
    assert.ok(recordsPointingAt(records, "203.0.113.10").every((r) => r.type === "A"));
  });
  it("refuses something that is not an address", () => {
    assert.throws(() => recordsPointingAt(records, "abc123.example.org"));
    assert.throws(() => recordsPointingAt(records, "203.0.113"));
    assert.throws(() => recordsPointingAt(records, "203.0.113.999"));
  });
});

describe("recordsNamed / underZone", () => {
  it("compares names without case and without a trailing dot", () => {
    assert.equal(recordsNamed([rec("ABC.example.org.", "203.0.113.10")], "abc.example.org").length, 1);
  });
  it("does not take a look-alike suffix for the zone", () => {
    assert.equal(underZone("a.example.org", "example.org"), true);
    assert.equal(underZone("example.org", "example.org"), true);
    assert.equal(underZone("a.notexample.invalid", "example.invalid"), false);
    assert.equal(underZone("example.invalid.evil.test", "example.invalid"), false);
  });
});

describe("namesOutsideZones", () => {
  it("leaves the names the tool cannot delete, once each, and drops addresses", () => {
    const names = ["a.example.org", "b.example.info", "b.example.info", "203.0.113.10", "", "c.example.net"];
    assert.deepEqual(namesOutsideZones(names, ["example.org", "example.net"]), ["b.example.info"]);
  });
});

describe("randomLabel", () => {
  it("is six characters, starts with a letter, and says nothing about the server", () => {
    for (let i = 0; i < 300; i++) {
      const bytes = Uint8Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
      const label = randomLabel(bytes);
      assert.match(label, /^[a-z][a-z0-9]{5}$/);
    }
  });
  it("needs six bytes", () => {
    assert.throws(() => randomLabel(new Uint8Array(3)));
  });
});

describe("aRecordBody", () => {
  it("is DNS-only: never proxied, automatic TTL", () => {
    assert.deepEqual(aRecordBody("abc123.example.org", "203.0.113.10", "example.org"), {
      type: "A", name: "abc123.example.org", content: "203.0.113.10", ttl: 1, proxied: false,
    });
  });
  it("refuses a name outside the zone, the zone itself, and a non-address", () => {
    assert.throws(() => aRecordBody("abc.example.net", "203.0.113.10", "example.org"));
    assert.throws(() => aRecordBody("example.org", "203.0.113.10", "example.org"));
    assert.throws(() => aRecordBody("abc.example.org", "not-an-ip", "example.org"));
  });
});

describe("masking", () => {
  it("never shows a whole address", () => {
    assert.equal(isV4("203.0.113.10"), true);
    assert.equal(maskV4("203.0.113.10"), "<ip>", "no octet of a node address survives the mask");
    assert.equal(maskV4("abc.example.org"), "abc.example.org");
    assert.ok(!recordLine(rec("abc.example.org", "203.0.113.10")).includes("203.0.113.10"));
  });
});

describe("dohVerdict", () => {
  it("reads NXDOMAIN as gone", () => {
    assert.equal(dohVerdict({ Status: 3 }), "gone");
  });
  it("reads exactly one matching A answer as a match", () => {
    assert.equal(dohVerdict({ Status: 0, Answer: [{ type: 1, data: "203.0.113.10" }] }, "203.0.113.10"), "match");
  });
  it("reads anything else as not what was asked for", () => {
    assert.equal(dohVerdict({ Status: 0, Answer: [{ type: 1, data: "203.0.113.11" }] }, "203.0.113.10"), "other");
    assert.equal(dohVerdict({ Status: 0, Answer: [{ type: 1, data: "203.0.113.10" }, { type: 1, data: "203.0.113.11" }] }, "203.0.113.10"), "other");
    assert.equal(dohVerdict({ Status: 0 }), "empty");
    assert.equal(dohVerdict({ Status: 0, Answer: [{ type: 1, data: "203.0.113.10" }] }), "other", "a name that still resolves is not gone");
  });
});
