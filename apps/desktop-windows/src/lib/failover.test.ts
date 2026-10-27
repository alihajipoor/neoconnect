import { describe, expect, it } from "vitest";
import { recordAttempt, type ConnectHistory } from "./connect-history";
import { reachabilityKey, type ReachabilityMap } from "./reachability";
import { orderCandidates, lastGoodFor, rememberLastGood } from "./failover";
import type { Protocol, ProtocolUser } from "./types";

function user(routeId: string, protocol: Protocol): ProtocolUser {
  return { routeId, protocol } as ProtocolUser;
}

const ALL = [
  user("r-openvpn", "OPENVPN"),
  user("r-trojan", "XRAY_TROJAN"),
  user("r-wg", "WIREGUARD"),
  user("r-tls", "XRAY_VLESS_TLS"),
  user("r-reality", "XRAY_VLESS_REALITY"),
];

const ids = (users: ProtocolUser[]) => users.map((u) => u.routeId);

describe("orderCandidates", () => {
  it("tries the fastest protocol first and the most recognisable last", () => {
    // Speed first is the point: on an ordinary network the first attempt
    // wins and failover costs nothing at all.
    expect(ids(orderCandidates(ALL))).toEqual([
      "r-wg",
      "r-reality",
      "r-tls",
      "r-trojan",
      "r-openvpn",
    ]);
  });

  it("leads with what actually worked on this network last time", () => {
    // Evidence beats the default order -- this is what stops a customer
    // behind a filter re-walking the whole list on every connect.
    expect(ids(orderCandidates(ALL, { lastGoodRouteId: "r-trojan" }))[0]).toBe("r-trojan");
  });

  it("falls back to the plan's preferred route when nothing has worked yet", () => {
    expect(ids(orderCandidates(ALL, { preferredRouteId: "r-tls" }))[0]).toBe("r-tls");
  });

  it("prefers proven over merely configured", () => {
    const order = ids(orderCandidates(ALL, { lastGoodRouteId: "r-trojan", preferredRouteId: "r-tls" }));
    expect(order[0]).toBe("r-trojan");
    expect(order[1]).toBe("r-tls");
  });

  it("puts the customer's chosen server first", () => {
    expect(ids(orderCandidates(ALL, { pinnedRouteId: "r-openvpn" }))[0]).toBe("r-openvpn");
  });

  /** The regression this exists to prevent, found in live testing.
   *
   * Choosing a server used to make it the *only* candidate, so the most
   * ordinary action in the app -- picking from the server list --
   * silently disabled failover, and the run then reported "every
   * protocol was tried" after trying exactly one. A choice means "start
   * here", not "give up if this fails". */
  it("still offers the others after the chosen one, so failover is not silently disabled", () => {
    const order = ids(orderCandidates(ALL, { pinnedRouteId: "r-openvpn" }));
    expect(order).toHaveLength(ALL.length);
    expect(order.slice(1)).toEqual(["r-wg", "r-reality", "r-tls", "r-trojan"]);
  });

  it("ignores a choice for a route the customer no longer has", () => {
    // A stale preference must never leave someone with nothing to try.
    expect(ids(orderCandidates(ALL, { pinnedRouteId: "r-deleted" }))).toHaveLength(ALL.length);
  });

  it("lets the customer's choice outrank what merely worked last time", () => {
    const order = ids(orderCandidates(ALL, { pinnedRouteId: "r-openvpn", lastGoodRouteId: "r-trojan" }));
    expect(order[0]).toBe("r-openvpn");
    expect(order[1]).toBe("r-trojan");
  });

  it("keeps a stable order between runs so a failure can be reproduced", () => {
    const tie = [user("r-b", "XRAY_TROJAN"), user("r-a", "XRAY_TROJAN")];
    expect(ids(orderCandidates(tie))).toEqual(["r-a", "r-b"]);
  });

  it("puts a protocol this build does not know last rather than first", () => {
    const withUnknown = [...ALL, user("r-future", "SOMETHING_NEW" as Protocol)];
    const ordered = ids(orderCandidates(withUnknown));
    expect(ordered[ordered.length - 1]).toBe("r-future");
  });

  it("returns every credential, so failover can reach the last one", () => {
    expect(orderCandidates(ALL)).toHaveLength(ALL.length);
  });
});

describe("an automatic reconnect's order", () => {
  // Every signal that can lead a customer's own connect, all pointing
  // somewhere other than the route the tunnel was on when it dropped.
  const everythingElse = {
    pinnedRouteId: "r-openvpn",
    lastGoodRouteId: "r-trojan",
    preferredRouteId: "r-tls",
    reachability: { [reachabilityKey("r-reality", "XRAY_VLESS_REALITY")]: "unreachable" } as ReachabilityMap,
  };

  it("leads with the route that was up, ahead of the pin and everything else", () => {
    const order = ids(orderCandidates(ALL, { ...everythingElse, resumeRouteId: "r-reality" }));
    expect(order[0]).toBe("r-reality");
    // Then the ladder's normal order, unchanged.
    expect(order.slice(1)).toEqual(ids(orderCandidates(ALL, everythingElse)).filter((id) => id !== "r-reality"));
  });

  it("is the ordinary order when nothing dropped", () => {
    // Control: without the resume route the same inputs lead with the pin.
    expect(ids(orderCandidates(ALL, everythingElse))[0]).toBe("r-openvpn");
    expect(ids(orderCandidates(ALL, { ...everythingElse, resumeRouteId: null }))[0]).toBe("r-openvpn");
  });

  it("keeps every candidate, so the reconnect can fall back", () => {
    expect(orderCandidates(ALL, { resumeRouteId: "r-wg" })).toHaveLength(ALL.length);
  });
});

describe("per-network memory", () => {
  it("remembers a different answer for each network", () => {
    // The whole reason it is keyed by network: what works at home and
    // what works behind a filter are different answers.
    let map = rememberLastGood({}, "aa:bb:cc:dd:ee:ff", "r-wg");
    map = rememberLastGood(map, "11:22:33:44:55:66", "r-trojan");

    expect(lastGoodFor(map, "aa:bb:cc:dd:ee:ff")).toBe("r-wg");
    expect(lastGoodFor(map, "11:22:33:44:55:66")).toBe("r-trojan");
  });

  it("treats an unidentifiable network as one shared bucket", () => {
    const map = rememberLastGood({}, null, "r-tls");
    expect(lastGoodFor(map, null)).toBe("r-tls");
  });

  it("has no opinion about a network it has not seen", () => {
    expect(lastGoodFor({}, "aa:bb:cc:dd:ee:ff")).toBeNull();
  });
});

describe("ordering by what this device has seen", () => {
  const NOW = 1_700_000_000_000;
  const mins = (n: number) => n * 60 * 1000;

  /** The reason this exists.
   *
   * `PROTOCOL_ORDER` puts WireGuard first for everybody. On a filtered
   * network where WireGuard is blocked and Trojan is not, that order is
   * wrong for this customer -- and it is wrong the same way every time
   * they press Connect, because nothing in it learns.
   */
  it("puts what worked recently ahead of the fixed order", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "cell", "de-1", "WIREGUARD", false, NOW - mins(10));
    h = recordAttempt(h, "cell", "de-1", "XRAY_TROJAN", true, NOW - mins(5));

    const ordered = orderCandidates([user("de-1", "WIREGUARD"), user("de-1", "XRAY_TROJAN")], {
      history: h,
      network: "cell",
      now: NOW,
    });
    expect(ordered[0].protocol).toBe("XRAY_TROJAN");
  });

  /** Evidence is per network, because the filtering is. */
  it("does not carry one network's evidence onto another", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "cell", "de-1", "XRAY_TROJAN", true, NOW - mins(5));
    h = recordAttempt(h, "cell", "de-1", "WIREGUARD", false, NOW - mins(5));

    const ordered = orderCandidates([user("de-1", "WIREGUARD"), user("de-1", "XRAY_TROJAN")], {
      history: h,
      network: "home-wifi",
      now: NOW,
    });
    // Nothing known here, so the fixed order decides again.
    expect(ordered[0].protocol).toBe("WIREGUARD");
  });

  /** An untried protocol must not outrank one that is working. */
  it("ranks a working protocol above an untried one", () => {
    const h = recordAttempt({}, "cell", "de-1", "XRAY_TROJAN", true, NOW - mins(2));
    const ordered = orderCandidates(
      [user("de-1", "WIREGUARD"), user("de-1", "XRAY_TROJAN"), user("de-1", "OPENVPN")],
      { history: h, network: "cell", now: NOW },
    );
    expect(ordered[0].protocol).toBe("XRAY_TROJAN");
  });

  /** And a failing one must sink below the untried. */
  it("ranks a failing protocol below an untried one", () => {
    const h = recordAttempt({}, "cell", "de-1", "WIREGUARD", false, NOW - mins(2));
    const ordered = orderCandidates([user("de-1", "WIREGUARD"), user("de-1", "OPENVPN")], {
      history: h,
      network: "cell",
      now: NOW,
    });
    expect(ordered[0].protocol).toBe("OPENVPN");
  });

  /** The customer's own choice still leads. Evidence orders what comes
   * after it; it does not overrule the person. */
  it("never moves ahead of a route the customer picked", () => {
    const h = recordAttempt({}, "cell", "de-1", "XRAY_TROJAN", true, NOW - mins(2));
    const ordered = orderCandidates([user("de-1", "XRAY_TROJAN"), user("nl-9", "OPENVPN")], {
      pinnedRouteId: "nl-9",
      history: h,
      network: "cell",
      now: NOW,
    });
    expect(ordered[0].routeId).toBe("nl-9");
  });

  /** With no history at all the order is exactly what it was, which is
   * what makes this safe to add. */
  it("changes nothing when there is no evidence", () => {
    const users = [user("de-1", "OPENVPN"), user("de-1", "WIREGUARD")];
    expect(orderCandidates(users, { history: {}, network: "cell", now: NOW })).toEqual(
      orderCandidates(users),
    );
  });
});

describe("ordering by what answers right now", () => {
  const NOW = 1_700_000_000_000;
  const reach = (entries: Array<[string, string, "reachable" | "unreachable"]>): ReachabilityMap =>
    Object.fromEntries(entries.map(([r, p, v]) => [reachabilityKey(r, p as never), v]));

  it("leads with what answered a handshake", () => {
    const ordered = orderCandidates([user("de-1", "WIREGUARD"), user("de-1", "XRAY_TROJAN")], {
      reachability: reach([["de-1", "XRAY_TROJAN", "reachable"]]),
    });
    expect(ordered[0].protocol).toBe("XRAY_TROJAN");
  });

  it("sinks what refused one", () => {
    const ordered = orderCandidates([user("de-1", "XRAY_TROJAN"), user("de-1", "XRAY_VLESS_TLS")], {
      reachability: reach([["de-1", "XRAY_TROJAN", "unreachable"]]),
    });
    expect(ordered[0].protocol).toBe("XRAY_VLESS_TLS");
  });

  /** The one that would quietly ruin this.
   *
   * WireGuard is UDP and cannot be probed at all, so it is never asked.
   * "Not asked" has to order like "unknown" -- above something that
   * actively refused. Treating silence as failure would bury the
   * protocol that is some customers' only working option.
   */
  it("does not punish a protocol that could not be probed", () => {
    const ordered = orderCandidates([user("de-1", "XRAY_TROJAN"), user("de-1", "WIREGUARD")], {
      reachability: reach([["de-1", "XRAY_TROJAN", "unreachable"]]),
    });
    expect(ordered[0].protocol).toBe("WIREGUARD");
  });

  /** Live evidence outranks remembered evidence, because the network
   * can have changed since this morning. */
  it("prefers a live answer over an older success", () => {
    const h: ConnectHistory = recordAttempt({}, "cell", "de-1", "XRAY_TROJAN", true, NOW - 60_000);
    const ordered = orderCandidates([user("de-1", "XRAY_TROJAN"), user("de-1", "XRAY_VLESS_TLS")], {
      history: h,
      network: "cell",
      now: NOW,
      reachability: reach([
        ["de-1", "XRAY_TROJAN", "unreachable"],
        ["de-1", "XRAY_VLESS_TLS", "reachable"],
      ]),
    });
    expect(ordered[0].protocol).toBe("XRAY_VLESS_TLS");
  });

  it("still never moves ahead of the customer's own choice", () => {
    const ordered = orderCandidates([user("de-1", "XRAY_TROJAN"), user("nl-9", "OPENVPN")], {
      pinnedRouteId: "nl-9",
      reachability: reach([["de-1", "XRAY_TROJAN", "reachable"]]),
    });
    expect(ordered[0].routeId).toBe("nl-9");
  });
});

// The VM, round 3: every connect and reconnect first dialled a credential
// the node refused ("rejected proxy/vless/encoding", 586 times in a day, one
// id). The account's expired plan was still listed beside the one bought
// after it, its credentials switched off on the nodes, for the very same
// routes -- and the API's order put the expired plan's first.
describe("a credential the server has switched off, or another plan's", () => {
  const credential = (id: string, subscriptionId: string, routeId: string, status: "ACTIVE" | "DISABLED", protocol: Protocol = "XRAY_VLESS_REALITY") =>
    ({ id, subscriptionId, routeId, protocol, status }) as ProtocolUser;
  const EXPIRED = credential("old", "sub-expired", "r-de-reality", "DISABLED");
  const IN_USE = credential("new", "sub-active", "r-de-reality", "ACTIVE");

  it("comes after the plan in use's, on the route the reconnect resumes and the customer pinned", () => {
    const listed = [EXPIRED, IN_USE];
    expect(orderCandidates(listed, { resumeRouteId: "r-de-reality", pinnedRouteId: "r-de-reality" }).map((u) => u.id)).toEqual(["new", "old"]);
    expect(orderCandidates(listed, { subscriptionId: "sub-active" }).map((u) => u.id)).toEqual(["new", "old"]);
  });

  it("comes after every credential the server has not switched off, and is never dropped", () => {
    const listed = [EXPIRED, credential("ovpn", "sub-active", "r-ovpn", "ACTIVE", "OPENVPN"), IN_USE];
    const ordered = orderCandidates(listed, { pinnedRouteId: "r-de-reality", subscriptionId: "sub-active" }).map((u) => u.id);
    expect(ordered).toEqual(["new", "ovpn", "old"]);
  });

  it("puts another subscription's after the one in use, and an older backend's, with no status, where it always was", () => {
    const other = credential("other", "sub-other", "r-de-reality", "ACTIVE");
    expect(orderCandidates([other, IN_USE], { subscriptionId: "sub-active" }).map((u) => u.id)).toEqual(["new", "other"]);
    const bare = [user("r-tls", "XRAY_VLESS_TLS"), user("r-wg", "WIREGUARD")];
    expect(ids(orderCandidates(bare, { subscriptionId: "sub-active" }))).toEqual(["r-wg", "r-tls"]);
  });
});

/** October 2026: on any network a device had no history for, the
 * alphabetical tie-break put the UK first for every customer, a pinned
 * France fell through to the UK, and a remembered server that had since
 * been cut off still led every connect. */
describe("ties, pins and a remembered server that stopped answering", () => {
  const SERVERS = ["uk", "de", "tr", "fr", "fi", "sg"].map((routeId) => user(routeId, "XRAY_VLESS_REALITY"));

  it("orders servers nothing else separates by this install's seed, the same every time", () => {
    const first = ids(orderCandidates(SERVERS, { seed: "install-a" }));
    expect(ids(orderCandidates(SERVERS, { seed: "install-a" }))).toEqual(first);
    // Different installs start in different places; over a handful of
    // installs, not all on one server.
    const leaders = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => orderCandidates(SERVERS, { seed })[0].routeId),
    );
    expect(leaders.size).toBeGreaterThan(1);
    // Without a seed it is the old order.
    expect(ids(orderCandidates(SERVERS))[0]).toBe("de");
  });

  it("puts a server that answered much later than the quickest after the ones that answered about as fast", () => {
    const replyMs = Object.fromEntries(
      SERVERS.map((u) => [reachabilityKey(u.routeId, u.protocol), u.routeId === "fi" ? 120 : 900]),
    );
    replyMs[reachabilityKey("de", "XRAY_VLESS_REALITY")] = 140;
    const order = ids(orderCandidates(SERVERS, { replyMs, seed: "install-a" }));
    expect(new Set(order.slice(0, 2))).toEqual(new Set(["fi", "de"]));
  });

  it("does not let a few milliseconds decide", () => {
    const replyMs = Object.fromEntries(
      SERVERS.map((u, i) => [reachabilityKey(u.routeId, u.protocol), 100 + i * 10]),
    );
    expect(ids(orderCandidates(SERVERS, { replyMs, seed: "install-a" }))).toEqual(
      ids(orderCandidates(SERVERS, { seed: "install-a" })),
    );
  });

  it("tries the pinned country's other routes right after the pin", () => {
    const relayToFrance = user("relay-fr", "XRAY_VLESS_REALITY");
    const order = ids(
      orderCandidates([...SERVERS, relayToFrance], {
        pinnedRouteId: "fr",
        pinnedCountryRouteIds: ["relay-fr"],
        lastGoodRouteId: "uk",
        seed: "install-a",
      }),
    );
    expect(order.slice(0, 3)).toEqual(["fr", "relay-fr", "uk"]);
  });

  it("drops a remembered server from the lead once every probe of it is refused", () => {
    const reachability: ReachabilityMap = { [reachabilityKey("uk", "XRAY_VLESS_REALITY")]: "unreachable" };
    expect(ids(orderCandidates(SERVERS, { lastGoodRouteId: "uk", reachability }))[0]).not.toBe("uk");
    // Not when nothing about it could be probed: UDP is never asked.
    const wg = [user("uk", "WIREGUARD"), user("de", "WIREGUARD")];
    expect(ids(orderCandidates(wg, { lastGoodRouteId: "uk", reachability: {} }))[0]).toBe("uk");
  });
});
