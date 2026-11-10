import {
  FAILS_FRESH_HOURS,
  hintFor,
  MIN_COUNTRY_NETWORKS,
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
/** Other networks registered in the caller's country: as many as a
 * verdict for the whole country has to rest on. */
const ELSEWHERE = Array.from({ length: MIN_COUNTRY_NETWORKS }, (_, i) => OTHER_ISP + i);

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
/** The same dials by one customer on each of `asns`. */
const across = (asns: number[], dials: (customer: string, asn: number) => OrderDial[], prefix = "other"): OrderDial[] =>
  asns.flatMap((asn, i) => dials(`${prefix}${i}`, asn));

describe("networkOrder", () => {
  it("says nothing without dials", () => {
    const order = networkOrder([], ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    expect(order.protocols.size).toBe(0);
  });

  it("calls a server working where enough customers carried traffic on it, and its protocol landing", () => {
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true), dial(c, "s1-wg", false)]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
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
      ...each(3, (c) => [dial(c, "s1-reality", true), dial(c, "s2-reality", true), dial(c, "s3-reality", false)], "ok"),
      ...each(3, (c) => [dial(c, "s1-reality", true), dial(c, "s2-reality", false), dial(c, "s3-reality", false)], "no"),
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
    /** A customer on each of several other ISPs in the country, one on
     * the caller's. */
    const country = [
      ...across(ELSEWHERE, (c, asn) => [
        dial(c, "s1-reality", true, asn),
        dial(c, "s1-wg", false, asn),
        dial(c, "s3-reality", false, asn),
      ]),
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

    /** Which server works goes by the ISP. Customers on ONE other
     * network say what that network does, not what the country does: a
     * server that carries there alone would be called working on every
     * ISP nobody has tried it on, and three people on one campus that
     * blocks a server -- or three accounts made for the purpose -- would
     * call it failing for a country. */
    it("does not take one other network's word for the whole country", () => {
      const oneNetwork = each(
        MIN_ORDER_CUSTOMERS + 2,
        (c) => [dial(c, "s1-reality", true, OTHER_ISP), dial(c, "s1-wg", false, OTHER_ISP), dial(c, "s3-reality", false, OTHER_ISP)],
        "other",
      );
      const order = networkOrder(oneNetwork, ROUTES, ISP, NOW);
      expect(order.servers.size).toBe(0);
      expect(order.protocols.size).toBe(0);
      // That network's own customers are still told what they saw.
      const theirs = networkOrder(oneNetwork, ROUTES, OTHER_ISP, NOW);
      expect(theirs.servers.get("s1")).toBe("works");
      expect(theirs.servers.get("s3")).toBe("fails");
      expect(theirs.protocols.get(WIREGUARD)).toBe("fails");
    });

    it("nor the word of fewer networks than the floor, however many customers on them", () => {
      const few = ELSEWHERE.slice(0, MIN_COUNTRY_NETWORKS - 1).flatMap((asn) =>
        each(
          2,
          (c) => [dial(c, "s1-reality", true, asn), dial(c, "s1-wg", false, asn), dial(c, "s3-reality", false, asn)],
          `on${asn}-`,
        ),
      );
      const order = networkOrder(few, ROUTES, ISP, NOW);
      expect(order.servers.size).toBe(0);
      expect(order.protocols.size).toBe(0);
    });

    /** Each side is counted by the networks ITS customers were on: a
     * server that carries on one network is not working across the
     * country because the people it failed for were on others. */
    it("counts the networks behind the side a verdict claims, not everyone who tried", () => {
      const dials = [
        // Something is shown to fail in the country, on enough networks.
        ...across(ELSEWHERE, (c, asn) => [dial(c, "s1-reality", true, asn), dial(c, "s3-reality", false, asn)]),
        // s2 carries for four customers, all on one network...
        ...each(MIN_ORDER_CUSTOMERS + 1, (c) => [dial(c, "s2-reality", true, OTHER_ISP)], "carried"),
        // ...and failed for one on each of two others.
        dial("other1", "s2-reality", false, ELSEWHERE[1]),
        dial("other2", "s2-reality", false, ELSEWHERE[2]),
      ];
      const order = networkOrder(dials, ROUTES, ISP, NOW);
      expect(order.servers.get("s1")).toBe("works");
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
      const dials = [...country.filter((d) => d.asn !== ISP), dial("mine", "s1-wg", false, ISP)];
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
      // On the other ISPs it is still the country's answer.
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
      // ...and carries for enough customers on this ISP, where another
      // server does not.
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s3-reality", true, ISP), dial(c, "s2-reality", false, ISP)], "mine"),
    ];
    expect(networkOrder(dials, ROUTES, ISP, NOW).servers.get("s3")).toBe("works");
    expect(networkOrder(dials, ROUTES, OTHER_ISP, NOW).servers.get("s3")).toBe("fails");
  });
});

/** Where everything gets through, "works" tells one server from another
 * by nothing but who happened to use it -- and an app that started every
 * new device on those would keep the others from ever being used. */
describe("on a network where nothing is shown to fail", () => {
  const open = (asn = ISP, prefix = "c") =>
    each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true, asn), dial(c, "s1-wg", true, asn)], prefix);

  it("calls no server working, however many carried traffic on it", () => {
    const order = networkOrder(open(), ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    // What lands is still said: it picks no server.
    expect(order.protocols.get(REALITY)).toBe("lands");
    expect(order.protocols.get(WIREGUARD)).toBe("lands");
    expect(hintFor(ISP, ROUTES.get("s1-reality")!, order)).toEqual({ asn: ISP, protocol: "lands" });
  });

  it("nor from the country's word", () => {
    const dials = across(ELSEWHERE, (c, asn) => [dial(c, "s1-reality", true, asn)]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.size).toBe(0);
    expect(order.protocols.get(REALITY)).toBe("lands");
  });

  /** A failed dial or two is a bad evening, not filtering. */
  it("is not taken for a filtered one on fewer failures than make a verdict", () => {
    const dials = [...open(), ...each(MIN_ORDER_CUSTOMERS - 1, (c) => [dial(c, "s3-reality", false)], "unlucky")];
    expect(networkOrder(dials, ROUTES, ISP, NOW).servers.size).toBe(0);
  });

  it("calls servers working once a server there is shown to fail", () => {
    const dials = [...open(), ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s3-reality", false)])];
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s1")).toBe("works");
    expect(order.servers.get("s3")).toBe("fails");
  });

  it("or a protocol is, on a server that carries the others", () => {
    const dials = each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true), dial(c, "s1-wg", false)]);
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.protocols.get(WIREGUARD)).toBe("fails");
    expect(order.servers.get("s1")).toBe("works");
  });

  /** Filtering is largely national: an ISP whose own customers have had
   * nothing fail is still in a country where things do. */
  it("or the country around it shows one", () => {
    const dials = [
      ...open(),
      ...across(ELSEWHERE, (c, asn) => [dial(c, "s1-reality", true, asn), dial(c, "s3-reality", false, asn)]),
    ];
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s1")).toBe("works");
    expect(order.servers.get("s3")).toBe("fails");
  });

  /** One network's failures do not make a country a filtered one: an
   * office that blocks a server says nothing about the ISPs around it. */
  it("but not one other network in the country alone", () => {
    const dials = [
      ...open(),
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s1-reality", true, OTHER_ISP), dial(c, "s3-reality", false, OTHER_ISP)], "office"),
    ];
    expect(networkOrder(dials, ROUTES, ISP, NOW).servers.size).toBe(0);
  });

  /** A failing verdict lapses after two days so that a lifted block is
   * found again. What it showed of the network -- that not everything
   * gets through here -- stands for the window: otherwise the working
   * servers would lose their lead as soon as everyone had stopped
   * dialling the dead ones. */
  it("keeps calling servers working after the failures beside them have gone stale", () => {
    const dials = [
      ...open(),
      ...each(MIN_ORDER_CUSTOMERS, (c) => [dial(c, "s3-reality", false, ISP, FAILS_FRESH_HOURS + 1)]),
    ];
    const order = networkOrder(dials, ROUTES, ISP, NOW);
    expect(order.servers.get("s3")).toBeUndefined();
    expect(order.servers.get("s1")).toBe("works");
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
