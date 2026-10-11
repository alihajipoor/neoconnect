import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The memory of which control-plane addresses failed recently, and on
 * which network: what it keeps, for how long, and where; and the look at
 * a name's DNS answer that finds Iran's block page. How a race uses them
 * is in staged-race.test.ts. Names are RFC 2606 stand-ins, addresses RFC
 * 5737 ones, and `resolve_ipv4` is stood in for. */

/** What the system resolver answers for each name, as `resolve_ipv4`
 * would hand it back; a name not here fails to resolve. */
const { resolver, lookedUp, askedFor } = vi.hoisted(() => ({
  resolver: new Map<string, string[] | "hangs" | Promise<string[]>>(),
  lookedUp: [] as string[],
  askedFor: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { host: string }) => {
    if (command !== "resolve_ipv4") return Promise.reject(new Error(`unexpected ${command}`));
    lookedUp.push(args.host);
    askedFor.push(args);
    const answer = resolver.get(args.host);
    if (answer === "hangs") return new Promise(() => undefined);
    if (answer instanceof Promise) return answer;
    return answer === undefined ? Promise.reject("could not resolve") : Promise.resolve(answer);
  },
}));

const {
  DEMOTED_FOR_MS,
  clearDemotion,
  demotedLast,
  demoteEndpoint,
  demoteName,
  isDemoted,
  resetDemotionsForTests,
  resolvesToBlockPage,
} = await import("./endpoint-demotion");
const { rememberNetwork, resetNetworkForTests } = await import("./network-identity");

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const D = "https://d.example";
const LIST = [A, B, C, D];

/** The webview's storage, stood in for: Node has none. */
let saved: Map<string, string>;
function stubStorage(): void {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
}

/** A baseline's answer naming the carrier, which is what keys the memory. */
const onCarrier = (asn: number, at: number) => rememberNetwork({ ip: "192.0.2.1", asn, network: `n.${asn}` }, at);

beforeEach(() => {
  resetDemotionsForTests();
  resetNetworkForTests();
  resolver.clear();
  lookedUp.length = 0;
  askedFor.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the order", () => {
  it("moves a demoted address to the end and keeps every other where it was", () => {
    demoteEndpoint(A, 1_000);
    demoteEndpoint(C, 1_000);
    expect(demotedLast(LIST, 2_000)).toEqual({ ordered: [B, D, A, C], healthy: 2 });
  });

  it("leaves a list with nothing demoted as it was", () => {
    expect(demotedLast(LIST, 2_000)).toEqual({ ordered: LIST, healthy: 4 });
  });

  /** Nothing has answered here lately. Putting some of the dead ahead of
   * the others would be a guess dressed up as knowledge. */
  it("singles nothing out when every address is demoted", () => {
    for (const base of LIST) demoteEndpoint(base, 1_000);
    expect(demotedLast(LIST, 2_000)).toEqual({ ordered: LIST, healthy: 4 });
  });

  it("ignores a demotion of an address the list does not have", () => {
    demoteEndpoint("https://gone.example", 1_000);
    expect(demotedLast(LIST, 2_000)).toEqual({ ordered: LIST, healthy: 4 });
  });
});

describe("how long a demotion lasts", () => {
  it("lapses half an hour after the failure", () => {
    demoteEndpoint(A, 1_000);
    expect(demotedLast(LIST, 1_000 + DEMOTED_FOR_MS - 1).ordered[3]).toBe(A);
    expect(demotedLast(LIST, 1_000 + DEMOTED_FOR_MS).ordered).toEqual(LIST);
  });

  /** A clock set back is not a recent failure. */
  it("does not stand on a clock set back past it", () => {
    demoteEndpoint(A, 10_000);
    expect(demotedLast(LIST, 5_000).ordered).toEqual(LIST);
  });

  it("is renewed by a second failure", () => {
    demoteEndpoint(A, 1_000);
    demoteEndpoint(A, 1_000 + DEMOTED_FOR_MS / 2);
    expect(demotedLast(LIST, 1_000 + DEMOTED_FOR_MS).ordered[3]).toBe(A);
  });

  /** An answer of any kind: the network let a request through. */
  it("is lifted by an answer from the address", () => {
    demoteEndpoint(A, 1_000);
    clearDemotion(A, 2_000);
    expect(demotedLast(LIST, 3_000).ordered).toEqual(LIST);
  });
});

describe("which network a demotion belongs to", () => {
  /** What is blocked on mobile data says nothing about home broadband. */
  it("applies on the network it was recorded on and no other", () => {
    onCarrier(64500, 1_000);
    demoteEndpoint(A, 2_000);
    onCarrier(64501, 3_000);
    expect(demotedLast(LIST, 4_000).ordered).toEqual(LIST);
    onCarrier(64500, 5_000);
    expect(demotedLast(LIST, 6_000).ordered).toEqual([B, C, D, A]);
  });

  /** An answer on one network lifts nothing on another. */
  it("is lifted only on the network the answer came on", () => {
    onCarrier(64500, 1_000);
    demoteEndpoint(A, 2_000);
    onCarrier(64501, 3_000);
    demoteEndpoint(A, 3_000);
    clearDemotion(A, 4_000);
    expect(demotedLast(LIST, 5_000).ordered).toEqual(LIST);
    onCarrier(64500, 6_000);
    expect(demotedLast(LIST, 7_000).ordered).toEqual([B, C, D, A]);
  });

  /** No baseline yet, as on a fresh install: one shared bucket, which is
   * what the app's other per-network memories do with an unknown network. */
  it("files a failure on an unknown network under one shared key", () => {
    demoteEndpoint(B, 1_000);
    expect(demotedLast(LIST, 2_000).ordered).toEqual([A, C, D, B]);
  });
});

describe("a name on the block page", () => {
  const MIRROR = "https://m.example:2053/api";
  const MIRROR_TOO = "https://m.example:8443/api";
  const CDN = "https://cdn.example/api";

  /** The resolver's answer is for the name, so every address under it
   * goes, whatever the port. */
  it("demotes every address under the name", () => {
    demoteName("m.example", 1_000);
    expect(demotedLast([MIRROR, CDN, MIRROR_TOO], 2_000)).toEqual({ ordered: [CDN, MIRROR, MIRROR_TOO], healthy: 1 });
  });

  it("lapses half an hour after it was found", () => {
    demoteName("m.example", 1_000);
    expect(demotedLast([MIRROR, CDN], 1_000 + DEMOTED_FOR_MS).ordered).toEqual([MIRROR, CDN]);
  });

  /** An answer through TLS came from a server holding a certificate for
   * the name, which the block page does not: the name resolves somewhere
   * real here now. */
  it("is lifted by an answer from any address under the name", () => {
    demoteName("m.example", 1_000);
    clearDemotion(MIRROR_TOO, 2_000);
    expect(demotedLast([MIRROR, CDN], 3_000).ordered).toEqual([MIRROR, CDN]);
  });

  /** On one tester's network the CDN names resolved there too; on the
   * others they did not. */
  it("applies on the network it was found on and no other", () => {
    onCarrier(64500, 1_000);
    demoteName("cdn.example", 2_000);
    expect(demotedLast([CDN, MIRROR], 3_000).ordered).toEqual([MIRROR, CDN]);
    onCarrier(64501, 4_000);
    expect(demotedLast([CDN, MIRROR], 5_000).ordered).toEqual([CDN, MIRROR]);
  });
});

describe("looking at a name's DNS answer", () => {
  const MIRROR = "https://m.example:2053/api";

  /** Iran's block page, as the field saw it on 2026-10-10: every name
   * under the mirror domain resolved there. */
  it("finds the block page, and demotes the name on this network", async () => {
    resolver.set("m.example", ["10.10.34.35"]);
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(true);
    expect(isDemoted("https://m.example/api")).toBe(true);
    expect(demotedLast([MIRROR, A]).ordered).toEqual([A, MIRROR]);
  });

  /** An answer from under the name says the look is out of date. */
  it("forgets what it found when an address under the name answers", async () => {
    resolver.set("m.example", ["10.10.34.35"]);
    await resolvesToBlockPage(MIRROR, 1_000);
    clearDemotion("https://m.example/api", 2_000);
    expect(demotedLast([MIRROR, A], 3_000).ordered).toEqual([MIRROR, A]);
  });

  /** The answer came first, the look later. Before: the look demoted the
   * name all the same, and the next race asked last the address that had
   * answered first -- the shape of a name whose IPv4 answer is the block
   * page and whose IPv6 answer is real, reached over IPv6. */
  it("finds nothing when an address under the name answered while it was under way", async () => {
    let land: (addresses: string[]) => void = () => undefined;
    resolver.set("m.example", new Promise<string[]>((resolve) => (land = resolve)));
    const look = resolvesToBlockPage(MIRROR, 1_000);
    clearDemotion("https://m.example:8443/api", 1_100);
    land(["10.10.34.35"]);
    expect(await look).toBe(false);
    expect(isDemoted(MIRROR)).toBe(false);
    expect(demotedLast([MIRROR, A]).ordered).toEqual([MIRROR, A]);
  });

  it("finds nothing in an ordinary answer", async () => {
    resolver.set("m.example", ["203.0.113.7"]);
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(false);
    expect(isDemoted(MIRROR)).toBe(false);
    expect(demotedLast([MIRROR, A]).ordered).toEqual([MIRROR, A]);
  });

  /** The HTTP plugin's own connection tries a name's IPv6 addresses too,
   * and the block page has none. Before, only IPv4 was asked for, and a
   * name whose A record was poisoned had its request stopped before it
   * could connect over IPv6. */
  it("asks for IPv6 too, and does not count a name with a real IPv6 address", async () => {
    resolver.set("m.example", ["10.10.34.34", "2001:db8::7"]);
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(false);
    expect(isDemoted(MIRROR)).toBe(false);
    expect(askedFor).toEqual([
      { host: "m.example", timeoutMs: expect.any(Number), withIpv6: true, unlessProxied: true },
    ]);
  });

  /** Asked on the requests' behalf (`unlessProxied`), so the command gives
   * up where the HTTP plugin's requests go through a proxy, which resolves
   * the name at its own end (`http_proxied` in health_ip.rs). That refusal
   * is nothing known: never the block page, and nothing demoted. Through
   * Psiphon or v2rayN in system-proxy mode, a name this machine's resolver
   * put on the block page used to be stopped and demoted, though the proxy
   * would have reached it (staged-race.test.ts). */
  it("finds nothing when the command says the requests go through a proxy", async () => {
    resolver.set("m.example", Promise.reject("proxied"));
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(false);
    expect(isDemoted(MIRROR)).toBe(false);
  });

  /** A request is stopped on this answer, so only a name with nowhere
   * else to go counts. The probe still files it (control-plane-probe.ts). */
  it("does not count a name that also resolves somewhere real", async () => {
    resolver.set("m.example", ["10.10.34.34", "203.0.113.7"]);
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(false);
  });

  /** Nothing known is not the block page: a failed or slow lookup, an
   * address literal, a build without the command. */
  it("finds nothing when the lookup fails, hangs, or there is no name", async () => {
    vi.useFakeTimers();
    try {
      expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(false);
      resolver.set("h.example", "hangs");
      const hung = resolvesToBlockPage("https://h.example/api");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await hung).toBe(false);
      expect(await resolvesToBlockPage("https://192.0.2.10:2053/api", 1_000)).toBe(false);
      expect(lookedUp).toEqual(["m.example", "h.example"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The dashboard's three reads at once: one lookup. */
  it("shares a look still under way between races on one network", async () => {
    resolver.set("m.example", ["10.10.34.34"]);
    await Promise.all([resolvesToBlockPage(MIRROR, 1_000), resolvesToBlockPage("https://m.example/api", 1_001)]);
    expect(lookedUp).toEqual(["m.example"]);

    // And another network looks for itself, even at the same moment.
    let land: (addresses: string[]) => void = () => undefined;
    resolver.set("m.example", new Promise<string[]>((resolve) => (land = resolve)));
    const here = resolvesToBlockPage(MIRROR, 2_000);
    onCarrier(64501, 2_000);
    const there = resolvesToBlockPage(MIRROR, 2_001);
    land(["203.0.113.7"]);
    await Promise.all([here, there]);
    expect(lookedUp).toEqual(["m.example", "m.example", "m.example"]);
  });

  /** A look that has landed is not trusted by the next race, however
   * soon: the path may have changed under it. Before a connect the
   * resolver gave the block page; through the tunnel, moments later, it
   * answers for real. A look kept for a minute kept every request in that
   * minute from being sent. */
  it("looks again for the next race, and sees a block that has lifted at once", async () => {
    resolver.set("m.example", ["10.10.34.34"]);
    expect(await resolvesToBlockPage(MIRROR, 1_000)).toBe(true);
    resolver.set("m.example", ["203.0.113.7"]);
    expect(await resolvesToBlockPage(MIRROR, 1_001)).toBe(false);
    expect(lookedUp).toEqual(["m.example", "m.example"]);
  });
});

describe("across a restart", () => {
  /** A restart is what people do when an app cannot reach its server;
   * it should not cost them every dead address again. */
  it("is kept in the webview's storage", () => {
    stubStorage();
    demoteEndpoint(A, 1_000);
    resetDemotionsForTests();
    expect(demotedLast(LIST, 2_000).ordered).toEqual([B, C, D, A]);
  });

  it("stores only what has not lapsed", () => {
    stubStorage();
    demoteEndpoint(A, 1_000);
    demoteEndpoint(B, 1_000 + DEMOTED_FOR_MS);
    expect(JSON.parse(saved.get("neoxify.endpointDemotions")!)).toEqual({
      unknown: { bases: { [B]: 1_000 + DEMOTED_FOR_MS }, names: {} },
    });
  });

  /** Unreadable is forgotten, not fatal: an address wrongly kept at the
   * back would cost more than one asked too early. */
  it("drops a stored memory it cannot read", () => {
    stubStorage();
    saved.set("neoxify.endpointDemotions", "{not json");
    expect(demotedLast(LIST, 1_000).ordered).toEqual(LIST);
    saved.set(
      "neoxify.endpointDemotions",
      JSON.stringify({ unknown: { bases: { [A]: "yesterday", [B]: 900 }, names: "c.example" }, other: 5 }),
    );
    resetDemotionsForTests();
    expect(demotedLast(LIST, 1_000).ordered).toEqual([A, C, D, B]);
  });

  it("still works where there is no storage at all", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    demoteEndpoint(A, 1_000);
    expect(demotedLast(LIST, 2_000).ordered).toEqual([B, C, D, A]);
  });
});
