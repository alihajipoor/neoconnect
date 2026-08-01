import { describe, expect, it } from "vitest";
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
