import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordAttempt, recordDead } from "./connect-history";
import { ispHintsOf, ispTagsOf, orderCandidates, type IspRouteHint } from "./failover";
import { reachabilityKey } from "./reachability";
import type { IspHint, IspTag, Protocol, ProtocolUser } from "./types";

/** The automatic order where this device has nothing of its own to go
 * on: by what other people on the same network got through on, as the
 * server counts it -- per route where enough of them tried that route
 * (the tag), else per server and per protocol (the hint) -- and only
 * then by the fixed list. The server's side is isp-order.ts in the
 * backend. */

const user = (routeId: string, protocol: Protocol) => ({ routeId, protocol }) as ProtocolUser;
const ids = (users: ProtocolUser[]) => users.map((u) => u.routeId);

/** Four servers with the same protocols on each, as the fleet has. The
 * ids sort in the order written, so where nothing else decides, the
 * expected order can be read off. */
const SERVERS = ["s1", "s2", "s3", "s4"] as const;
const PROTOCOLS: Array<[string, Protocol]> = [
  ["wg", "WIREGUARD"],
  ["reality", "XRAY_VLESS_REALITY"],
  ["trojan", "XRAY_TROJAN"],
  ["ss", "SHADOWSOCKS"],
];
const LADDER = SERVERS.flatMap((server) => PROTOCOLS.map(([name, protocol]) => user(`${server}-${name}`, protocol)));

/** A network where two servers carry data, one is held, and nobody has
 * said anything of the fourth; where one protocol and another land, one
 * does not, and too few have tried the last to say. */
function hintsFor(ladder: ProtocolUser[]): Record<string, IspRouteHint> {
  const servers: Record<string, IspRouteHint["server"]> = { s1: "works", s2: "works", s3: "fails" };
  const protocols: Partial<Record<Protocol, IspRouteHint["protocol"]>> = {
    XRAY_VLESS_REALITY: "lands",
    SHADOWSOCKS: "lands",
    WIREGUARD: "fails",
  };
  const hints: Record<string, IspRouteHint> = {};
  for (const u of ladder) {
    const server = servers[u.routeId.split("-")[0]];
    const protocol = protocols[u.protocol];
    if (server || protocol) hints[u.routeId] = { ...(server ? { server } : {}), ...(protocol ? { protocol } : {}) };
  }
  return hints;
}
const HINTS = hintsFor(LADDER);

describe("the order on a network this device has never used", () => {
  it("is exactly the fixed order when the server says nothing", () => {
    const fixed = ids(orderCandidates(LADDER, { network: "new" }));
    expect(fixed.slice(0, 4)).toEqual(["s1-wg", "s2-wg", "s3-wg", "s4-wg"]);
    expect(ids(orderCandidates(LADDER, { network: "new", ispHints: {} }))).toEqual(fixed);
    expect(ids(orderCandidates(LADDER, { network: "new", ispHints: undefined, ispTags: {} }))).toEqual(fixed);
    // A list from a server that sends no hints at all.
    const routes = LADDER.map((u) => ({ id: u.routeId, ispTag: null }));
    expect(
      ids(orderCandidates(LADDER, { network: "new", ispHints: ispHintsOf(routes, 64500), ispTags: ispTagsOf(routes, 64500) })),
    ).toEqual(fixed);
  });

  it("starts on the servers that carry data here, with the protocols that land here", () => {
    const order = ids(orderCandidates(LADDER, { network: "new", ispHints: HINTS }));
    expect(order).toEqual([
      // Servers others got through on: what lands first, then what
      // nobody could say of.
      "s1-reality",
      "s2-reality",
      "s1-ss",
      "s2-ss",
      "s1-trojan",
      "s2-trojan",
      // A server nobody has said anything of, the same way.
      "s4-reality",
      "s4-ss",
      "s4-trojan",
      // Shown not to carry here, last: the protocol that does not land,
      // on a working server first and an unknown one next...
      "s1-wg",
      "s2-wg",
      "s4-wg",
      // ...and the server that carries nothing, whatever the protocol.
      "s3-reality",
      "s3-ss",
      "s3-trojan",
      "s3-wg",
    ]);
  });

  /** A rung there comes up and carries nothing, at 25-30 s each on a
   * phone: it is dialled after the ones that work. */
  it("puts a held server after a working one", () => {
    const pair = [user("s3-reality", "XRAY_VLESS_REALITY"), user("s1-reality", "XRAY_VLESS_REALITY")];
    const hints = { "s3-reality": { server: "fails" }, "s1-reality": { server: "works" } } as const;
    expect(ids(orderCandidates(pair, { network: "new", ispHints: hints }))).toEqual(["s1-reality", "s3-reality"]);
    // And after one nobody has said anything of.
    expect(
      ids(orderCandidates([...pair, user("s0-reality", "XRAY_VLESS_REALITY")], { network: "new", ispHints: hints })),
    ).toEqual(["s1-reality", "s0-reality", "s3-reality"]);
    // Never dropped.
    expect(orderCandidates(LADDER, { network: "new", ispHints: HINTS })).toHaveLength(LADDER.length);
  });

  it("puts a protocol that never lands on working servers after the ones that do", () => {
    const one = [user("s1-wg", "WIREGUARD"), user("s1-ss", "SHADOWSOCKS"), user("s1-reality", "XRAY_VLESS_REALITY")];
    const hints = hintsFor(one);
    expect(ids(orderCandidates(one, { network: "new" }))).toEqual(["s1-wg", "s1-reality", "s1-ss"]);
    expect(ids(orderCandidates(one, { network: "new", ispHints: hints }))).toEqual(["s1-reality", "s1-ss", "s1-wg"]);
  });

  /** Too few people tried them to say: they keep the place the fixed
   * order gives them among themselves, after what is proven to land and
   * before what is proven not to. */
  it("keeps protocols nobody can speak for in the fixed order, between the proven", () => {
    const one: ProtocolUser[] = [
      user("a-openvpn", "OPENVPN"),
      user("a-ikev2", "IKEV2"),
      user("a-tls", "XRAY_VLESS_TLS"),
      user("a-wg", "WIREGUARD"),
      user("a-trojan", "XRAY_TROJAN"),
      user("a-ss", "SHADOWSOCKS"),
    ];
    const hints = { "a-openvpn": { protocol: "lands" }, "a-ss": { protocol: "lands" }, "a-wg": { protocol: "fails" } } as const;
    expect(ids(orderCandidates(one, { network: "new", ispHints: hints }))).toEqual([
      "a-ss",
      "a-openvpn",
      "a-tls",
      "a-trojan",
      "a-ikev2",
      "a-wg",
    ]);
  });

  it("leaves a protocol this build does not know last, whatever is said of it", () => {
    const pair = [user("a-new", "SOMETHING_NEW" as Protocol), user("a-wg", "WIREGUARD")];
    const hints = { "a-new": { protocol: "lands" } } as const;
    expect(ids(orderCandidates(pair, { ispHints: hints }))).toEqual(["a-wg", "a-new"]);
  });

  /** The finest evidence there is of a route is of that very route. */
  it("takes a route's own tag over what is said of its server", () => {
    const pair = [user("s1-reality", "XRAY_VLESS_REALITY"), user("s3-reality", "XRAY_VLESS_REALITY")];
    const hints = { "s1-reality": { server: "works" }, "s3-reality": { server: "fails" } } as const;
    const tags = { "s3-reality": "worksOnYourIsp", "s1-reality": "failingOnYourIsp" } as const;
    expect(ids(orderCandidates(pair, { ispHints: hints, ispTags: tags }))).toEqual(["s3-reality", "s1-reality"]);
  });
});

describe("what this device knows, against what others saw", () => {
  it("leads with its own working rung on a server others call failing", () => {
    const history = recordAttempt({}, "home", "s3-reality", "XRAY_VLESS_REALITY", true, 0);
    const order = ids(orderCandidates(LADDER, { network: "home", history, now: 0, ispHints: HINTS }));
    expect(order[0]).toBe("s3-reality");
    // Its other rungs there are still unproven for this device, and
    // stay where others' results put them.
    expect(order.slice(-3)).toEqual(["s3-ss", "s3-trojan", "s3-wg"]);
  });

  it("puts its own failed rung after the untried, on a server others call working", () => {
    const history = recordAttempt({}, "home", "s1-reality", "XRAY_VLESS_REALITY", false, 0);
    const order = ids(orderCandidates(LADDER, { network: "home", history, now: 0, ispHints: HINTS }));
    expect(order[0]).toBe("s2-reality");
    expect(order[order.length - 1]).toBe("s1-reality");
  });

  it("keeps a rung marked dead here behind everything, whatever others saw of it", () => {
    const history = recordDead({}, "home", "s1-reality", "XRAY_VLESS_REALITY", 0);
    const order = ids(orderCandidates(LADDER, { network: "home", history, now: 0, ispHints: HINTS }));
    expect(order[order.length - 1]).toBe("s1-reality");
  });

  /** The change from all-or-nothing: knowing one rung here used to send
   * every other rung back to the fixed order. */
  it("still orders the rungs it has not tried by what others saw, on a network it knows", () => {
    const history = recordAttempt({}, "home", "s1-reality", "XRAY_VLESS_REALITY", true, 0);
    const order = ids(orderCandidates(LADDER, { network: "home", history, now: 0, lastGoodRouteId: "s1-reality", ispHints: HINTS }));
    expect(order.slice(0, 3)).toEqual(["s1-reality", "s2-reality", "s1-ss"]);
    expect(order.indexOf("s3-reality")).toBeGreaterThan(order.indexOf("s4-wg"));
  });

  it("does not carry one network's own results onto another", () => {
    const history = recordAttempt({}, "home", "s3-reality", "XRAY_VLESS_REALITY", true, 0);
    const order = ids(orderCandidates(LADDER, { network: "cafe", history, now: 0, ispHints: HINTS }));
    expect(order[0]).toBe("s1-reality");
  });

  it("never moves ahead of the customer's pin, the last-good route or the live probe", () => {
    expect(ids(orderCandidates(LADDER, { ispHints: HINTS, pinnedRouteId: "s3-wg" }))[0]).toBe("s3-wg");
    expect(ids(orderCandidates(LADDER, { ispHints: HINTS, lastGoodRouteId: "s3-wg" }))[0]).toBe("s3-wg");
    const reachability = {
      [reachabilityKey("s1-reality", "XRAY_VLESS_REALITY")]: "unreachable",
      [reachabilityKey("s3-trojan", "XRAY_TROJAN")]: "reachable",
    } as const;
    const order = ids(orderCandidates(LADDER, { ispHints: HINTS, reachability }));
    expect(order[0]).toBe("s3-trojan");
    expect(order[order.length - 1]).toBe("s1-reality");
  });
});

describe("reading the hints off the route list", () => {
  const tag: IspTag = { code: "worksOnYourIsp", customers: 6, outOf: 7, windowHours: 48 };
  const hint = (over: Partial<IspHint> = {}): IspHint => ({ asn: 64500, ...over });
  const routes = [
    { id: "a", ispTag: tag, ispHint: hint({ server: "works", protocol: "lands" }) },
    { id: "b", ispTag: null, ispHint: hint({ protocol: "fails" }) },
    // Names the network and has nothing to say.
    { id: "c", ispHint: hint() },
    { id: "d", ispHint: null },
    { id: "e" },
  ];

  it("keeps what there is to say, per route, without the network's name", () => {
    expect(ispHintsOf(routes)).toEqual({ a: { server: "works", protocol: "lands" }, b: { protocol: "fails" } });
    expect(ispHintsOf(routes, 64500)).toEqual(ispHintsOf(routes));
  });

  /** The list is held across a change of network, and the phone reads
   * its network again before every connect. */
  it("reads nothing from a list that describes another network than the device is on", () => {
    expect(ispHintsOf(routes, 64999)).toEqual({});
    expect(ispTagsOf(routes, 64999)).toEqual({});
  });

  /** A device the server could not place just now is not known to have
   * moved. */
  it("reads the list as it is when the device's network is not known", () => {
    expect(ispHintsOf(routes, null)).toEqual(ispHintsOf(routes));
    expect(ispTagsOf(routes, null)).toEqual({ a: "worksOnYourIsp" });
  });

  /** An older server names no network on anything: its tags are read as
   * they always were. */
  it("reads an older server's tags whatever network the device is on", () => {
    const old = [{ id: "a", ispTag: tag }, { id: "b", ispTag: null }];
    expect(ispTagsOf(old, 64999)).toEqual({ a: "worksOnYourIsp" });
    expect(ispHintsOf(old, 64999)).toEqual({});
  });

  it("passes over values it does not know", () => {
    const odd = [
      { id: "a", ispHint: { asn: 64500, server: "splendid", protocol: "lands" } as unknown as IspHint },
      { id: "b", ispHint: "works" as unknown as IspHint },
    ];
    expect(ispHintsOf(odd)).toEqual({ a: { protocol: "lands" } });
  });
});

/** Each screen's pass has to hand the list's hints to the order, read
 * against the network the device is on. */
describe("both ladders", () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const windows = source("../screens/Dashboard.tsx");
  const phone = source("../../../mobile/src/screens/Dashboard.tsx");

  it("order by the hints, for the network the device was last placed on", () => {
    const windowsOrder = windows.slice(windows.indexOf("let candidates = orderCandidates(dialable, {"));
    expect(windowsOrder.slice(0, 2500)).toContain("ispHints: movedSince ? {} : ispHintsOf(routes, placed?.asn ?? null),");
    expect(windowsOrder.slice(0, 2500)).toContain("ispTags: ispTagsOf(routes, placed?.asn ?? null),");

    const phoneOrder = phone.slice(phone.indexOf("const candidates = orderCandidates(usable, {"));
    expect(phoneOrder.slice(0, 2500)).toContain("ispHints: ispHintsOf(routes, currentNetwork()?.asn ?? null),");
    expect(phoneOrder.slice(0, 2500)).toContain("ispTags: ispTagsOf(routes, currentNetwork()?.asn ?? null),");
  });

  /** The phone's network is read at the baseline that opens the pass, so
   * the order has to come after it. */
  it("on the phone, read the network before ordering", () => {
    const pass = phone.slice(phone.indexOf("async function walkLadder("));
    const baseline = pass.indexOf("await takeBaseline({ nodeAddresses })");
    expect(baseline).toBeGreaterThan(0);
    expect(pass.indexOf("const candidates = orderCandidates(usable, {")).toBeGreaterThan(baseline);
  });

  /** Windows orders before its first baseline, on the last reading it
   * has: after the way out has changed with no reading since, the list
   * in hand may be another network's. */
  it("on Windows, read no hints after a roam until the network has been read again", () => {
    expect(windows).toContain(
      "const movedSince = netFresh.roamedAt !== null && (placed === null || placed.at < netFresh.roamedAt);",
    );
  });
});
