import { describe, expect, it } from "vitest";
import { inScope, parentDomain, scopeGlobs } from "./capability-scope-globs.mjs";
import { matchesCapabilityGlob } from "../src/lib/capability-glob";

/* Documentation names only (RFC 2606 / RFC 5737): which hosts the real
 * bundle carries is what docs/node-address-hygiene.md keeps out of the
 * repository, and a test needs only the shapes. */

const SEEDED = ["panel.example.com", "n1.mirrors.example.net", "n2.mirrors.example.net", "203.0.113.7"];

const allowed = (globs, url) => globs.some((glob) => matchesCapabilityGlob(glob, url));

describe("the HTTP scope a seed bundle grants", () => {
  it("covers every seeded host, bare and on a port, as before", () => {
    const globs = scopeGlobs(SEEDED);
    for (const host of SEEDED) {
      expect(allowed(globs, `https://${host}/api/customer/me`), host).toBe(true);
      expect(allowed(globs, `https://${host}:2053/api/customer/me`), host).toBe(true);
    }
  });

  it("covers a node added later on a domain the seed already uses for mirrors", () => {
    // The routine case: a new node's mirror host, published in the next
    // bundle. Exact-host globs refused it on every installed client.
    const globs = scopeGlobs(SEEDED);
    expect(allowed(globs, "https://n9.mirrors.example.net:2053/api/health/ip")).toBe(true);
    expect(inScope("n9.mirrors.example.net", SEEDED)).toBe(true);
  });

  it("does not widen past what the seed shows we operate", () => {
    const globs = scopeGlobs(SEEDED);
    // One host on a domain is not evidence the domain is ours to
    // wildcard.
    expect(allowed(globs, "https://other.example.com/api")).toBe(false);
    // Nor a new domain, nor a new address: those still need a release.
    expect(allowed(globs, "https://n1.mirrors.example.org/api")).toBe(false);
    expect(allowed(globs, "https://203.0.113.8/api")).toBe(false);
    expect(inScope("n1.mirrors.example.org", SEEDED)).toBe(false);
    // And never somebody else's domain through a near miss.
    expect(allowed(globs, "https://evilmirrors.example.net/api")).toBe(false);
  });

  it("never wildcards a registry or an address", () => {
    expect(parentDomain("a.example.co.uk")).toBe("example.co.uk");
    expect(parentDomain("example.co.uk")).toBeNull();
    expect(parentDomain("example.com")).toBeNull();
    expect(parentDomain("203.0.113.7")).toBeNull();
    expect(parentDomain("[2001:db8::1]")).toBeNull();
    const globs = scopeGlobs(["one.co.uk", "two.co.uk"]);
    expect(globs.some((g) => g.includes("*.co.uk"))).toBe(false);
  });
});
