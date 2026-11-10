import {
  FAILS_FRESH_HOURS,
  hintFor,
  MIN_ORDER_CUSTOMERS,
  networkOrder,
  ORDER_WINDOW_HOURS,
  protocolKey,
  serverKey,
  type OrderDial,
  type RouteKind,
} from "./isp-order";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const ISP = 64500;
const OTHER_ISP = 64501;

const kind = (nodeId: string, protocol: string, transport = "TCP", exitNodeId: string | null = null): RouteKind => ({
  nodeId,
  exitNodeId,
  protocol,
  transport,
});

/** Three servers, each with the same three protocols -- which is the
 * fleet's shape, and the reason "which server" and "which protocol" can
 * be told apart at all. */
const ROUTES = new Map<string, RouteKind>([
  ["s1-reality", kind("s1", "XRAY_VLESS_REALITY")],
  ["s1-wg", kind("s1", "WIREGUARD")],
  ["s1-ss", kind("s1", "SHADOWSOCKS")],
  ["s2-reality", kind("s2", "XRAY_VLESS_REALITY")],
  ["s2-wg", kind("s2", "WIREGUARD")],
  ["s3-reality", kind("s3", "XRAY_VLESS_REALITY")],
  ["s3-wg", kind("s3", "WIREGUARD")],
]);
const REALITY = protocolKey(kind("s1", "XRAY_VLESS_REALITY"));
const WIREGUARD = protocolKey(kind("s1", "WIREGUARD"));

const dial = (customerId: string, routeId: string, carried: boolean, asn = ISP, hoursAgo = 1): OrderDial => ({
  customerId,
  asn,
  routeId,
  carried,
  at: NOW - hoursAgo * HOUR,
});
/** The same dials by each of `n` customers. */
const each = (n: number, dials: (customer: string) => OrderDial[], prefix = "c"): OrderDial[] =>
  Array.from({ length: n }, (_, i) => dials(`${prefix}${i}`)).flat();

describe("networkOrder", () => {
  it("says nothing without dials", () => {
    const order = networkOrder([], ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    expect(order.protocols.size).toBe(0);
  });

  it("calls a server working where enough customers carried traffic on it, and its protocol landing", () => {
    const order = networkOrder(each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true)]), ROUTES, ISP, NOW);
    expect(order.servers.get("s1")).toBe("works");
    expect(order.protocols.get(REALITY)).toBe("lands");
  });

  /** One person must not be able to make a signal, nor one person with a
   * second account. */
  it("says nothing on fewer customers than the floor, however many dials", () => {
    const dials = each(MIN_ORDER_CUSTOMERS - 1, (c) => [
      dial(c, "s1-reality", true),
      dial(c, "s1-ss", true),
      dial(c, "s3-reality", false),
    ]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    expect(order.protocols.size).toBe(0);
  });

  /** The held server: tried by several, with a protocol that gets through
   * elsewhere on this network, and it never carried. */
  it("calls a server failing where a protocol that lands here never carried on it", () => {
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true), dial(c, "s3-reality", false)]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s1")).toBe("works");
    expect(order.servers.get("s3")).toBe("fails");
    // Its failures there are not held against the protocol: nothing
    // carried on that server for anyone.
    expect(order.protocols.get(REALITY)).toBe("lands");
  });

  /** A protocol the network drops everywhere fails on every server alike,
   * and that says nothing about any one of them. */
  it("does not hold a failed dial against its server when its protocol carried nowhere on the network", () => {
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [
      dial(c, "s1-reality", true),
      dial(c, "s2-wg", false),
      dial(c, "s3-wg", false),
    ]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s2")).toBeUndefined();
    expect(order.servers.get("s3")).toBeUndefined();
    // Nor is it yet known to fail as a protocol: it was only tried on
    // servers nobody carried anything on.
    expect(order.protocols.get(WIREGUARD)).toBeUndefined();
  });

  /** The protocol that does not land: tried on a server that carries the
   * others, and it never carried. */
  it("calls a protocol failing where it never carried on servers that work, and counts only those servers", () => {
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [
      dial(c, "s1-wg", false),
      dial(c, "s1-reality", true),
      dial(c, "s3-wg", false),
      dial(c, "s3-reality", false),
    ]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.protocols.get(WIREGUARD)).toBe("fails");
    expect(order.protocols.get(REALITY)).toBe("lands");
    expect(order.servers.get("s1")).toBe("works");
    expect(order.servers.get("s3")).toBe("fails");
  });

  it("counts a customer once, by whether anything of theirs carried", () => {
    // Two of three routes on the server failed for each of them; it still
    // carried for all three.
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [
      dial(c, "s1-reality", true),
      dial(c, "s1-ss", false),
      dial(c, "s1-wg", false),
    ]);
    expect(networkOrder(dials, ROUTES, ISP, NOW).servers.get("s1")).toBe("works");
  });

  it("says nothing of a server that works for about half", () => {
    const dials = [
      ...each(3, (c) => [dial(c, "s1-reality", true), dial(c, "s2-reality", true)], "ok"),
      ...each(3, (c) => [dial(c, "s1-reality", true), dial(c, "s2-reality", false)], "no"),
    ];
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s1")).toBe("works");
    expect(order.servers.get("s2")).toBeUndefined();
  });

  it("ignores dials older than the window and dials of routes that no longer exist", () => {
    const dials = [
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true, ISP, ORDER_WINDOW_HOURS + 1)]),
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "deleted-route", true)]),
    ];
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    expect(order.protocols.size).toBe(0);
  });

  /** A "fails" sends a server to the back, where few dial it again, so
   * it would keep itself alive on evidence nobody is renewing. */
  it("lets a failing verdict lapse once no failure behind it is recent, and keeps a working one", () => {
    const at = (hoursAgo: number) =>
      each(MIN_ORDER_CUSTOMERS, (c) => [
        dial(c, "s1-reality", true, ISP, hoursAgo),
        dial(c, "s3-reality", false, ISP, hoursAgo),
      ]);
    const fresh = networkOrder(at(FAILS_FRESH_HOURS - 1), ROUTES, ISP, NOW);
    expect(fresh.servers.get("s3")).toBe("fails");
    const stale = networkOrder(at(FAILS_FRESH_HOURS + 1), ROUTES, ISP, NOW);
    expect(stale.servers.get("s3")).toBeUndefined();
    expect(stale.servers.get("s1")).toBe("works");
  });

  describe("on a network with too few customers of its own", () => {
    /** Three customers on another ISP in the country, one on the caller's. */
    const country = [
      ...each(
        MIN_ORDER_CUSTOMERS,
        (c) => [dial(c, "s1-reality", true, OTHER_ISP), dial(c, "s1-wg", false, OTHER_ISP), dial(c, "s3-reality", false, OTHER_ISP)],
        "other",
      ),
      dial("mine", "s2-reality", true, ISP),
    ];

    it("falls back to the country", () => {
      const order = networkOrder(country, ROUTES, ISP, NOW);
      expect(order.servers.get("s1")).toBe("works");
      expect(order.servers.get("s3")).toBe("fails");
      expect(order.protocols.get(REALITY)).toBe("lands");
      expect(order.protocols.get(WIREGUARD)).toBe("fails");
      // One customer is not a signal at either level.
      expect(order.servers.get("s2")).toBeUndefined();
    });

    it("says nothing when the country is not known", () => {
      const mine = country.filter((d) => d.asn === ISP);
      const order = networkOrder(mine, ROUTES, ISP, NOW, false);
      expect(order.servers.size).toBe(0);
      expect(order.protocols.size).toBe(0);
    });

    /** A server blocked on one ISP is judged for that ISP's customers by
     * what failed for them, not as a failure of the protocol everywhere:
     * the other ISP's failures on s3 are counted against s3 only because
     * the protocol carried for them on s1. */
    it("judges each dial by its own network's servers and protocols", () => {
      // On the caller's ISP the protocol never carried on anything, so
      // its failure on s1 there says nothing about s1.
      const dials = [...country.filter((d) => d.asn === OTHER_ISP), dial("mine", "s1-wg", false, ISP)];
      expect(networkOrder(dials, ROUTES, ISP, NOW).servers.get("s1")).toBe("works");
    });

    /** Which server works depends on the ISP: one that failed for the
     * only customer here who tried it is not known to work here, whatever
     * it does for the rest of the country -- and the reverse. */
    it("does not take the country's word against what the ISP itself has seen", () => {
      const against = [
        ...country,
        // Carried on s2, so the protocol lands here, and failed on s1.
        dial("mine", "s1-reality", false, ISP),
        // Carried on s3, which fails for the rest of the country.
        dial("mine", "s3-reality", true, ISP),
      ];
      const order = networkOrder(against, ROUTES, ISP, NOW);
      expect(order.servers.get("s1")).toBeUndefined();
      expect(order.servers.get("s3")).toBeUndefined();
      // The other ISP's customers still get their own answer.
      const theirs = networkOrder(against, ROUTES, OTHER_ISP, NOW);
      expect(theirs.servers.get("s1")).toBe("works");
      expect(theirs.servers.get("s3")).toBe("fails");
    });
  });

  it("prefers the ISP's own verdict to the country's", () => {
    const dials = [
      // Fails for the rest of the country...
      ...each(
        4,
        (c) => [dial(c, "s1-reality", true, OTHER_ISP), dial(c, "s3-reality", false, OTHER_ISP)],
        "other",
      ),
      // ...and carries for enough customers on this ISP.
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s3-reality", true, ISP)], "mine"),
    ];
    expect(networkOrder(dials, ROUTES, ISP, NOW).servers.get("s3")).toBe("works");
    expect(networkOrder(dials, ROUTES, OTHER_ISP, NOW).servers.get("s3")).toBe("fails");
  });
});

describe("what a route's dials are evidence about", () => {
  it("keeps a relay's exit in its server, and a relay's protocol apart from the direct one", () => {
    const direct = kind("s1", "XRAY_VLESS_REALITY");
    const relayed = kind("relay", "XRAY_VLESS_REALITY", "TCP", "s1");
    const elsewhere = kind("relay", "XRAY_VLESS_REALITY", "TCP", "s2");
    expect(serverKey(relayed)).not.toBe(serverKey(elsewhere));
    expect(serverKey(relayed)).not.toBe(serverKey(direct));
    expect(protocolKey(relayed)).not.toBe(protocolKey(direct));
  });

  it("tells a protocol's transports apart", () => {
    expect(protocolKey(kind("s1", "XRAY_VLESS_TLS", "WS"))).not.toBe(protocolKey(kind("s1", "XRAY_VLESS_TLS", "TCP")));
  });
});

describe("hintFor", () => {
  it("names the network, and says only what there is to say", () => {
    const order = networkOrder(
      each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true), dial(c, "s1-wg", false)]),
      ROUTES,
      ISP,
      NOW,
    );
    expect(hintFor(ISP, ROUTES.get("s1-reality")!, order)).toEqual({ asn: ISP, server: "works", protocol: "lands" });
    expect(hintFor(ISP, ROUTES.get("s2-wg")!, order)).toEqual({ asn: ISP, protocol: "fails" });
    expect(hintFor(ISP, ROUTES.get("s1-ss")!, order)).toEqual({ asn: ISP, server: "works" });
    expect(hintFor(ISP, ROUTES.get("s3-reality")!, order)).toEqual({ asn: ISP, protocol: "lands" });
    expect(hintFor(ISP, kind("s9", "OPENVPN"), order)).toEqual({ asn: ISP });
  });
});
