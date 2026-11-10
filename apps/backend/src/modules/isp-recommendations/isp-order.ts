import { FAILING_SHARE, WINDOW_HOURS, WORKS_SHARE } from "./isp-signal";

/** What people on one network have recently got through on, reduced to
 * two coarse signals the apps' automatic connect order may read: which
 * SERVERS carry traffic there, and which PROTOCOLS land there.
 *
 * # Why this exists beside the tags
 *
 * The tag (isp-signal.ts) is a claim shown to a customer about one route
 * -- one server and one protocol -- and it takes five people on one ISP
 * in two days to make it. With a few dozen customers spread over many
 * ISPs and several dozen routes, almost no route gets there, so on a
 * network a device has never used the apps fell back to one fixed
 * protocol order for the whole world. On filtered networks that order is
 * wrong, and it is wrong in two separable ways (seven days of connect
 * reports to 2026-11-10):
 *
 * * **which server works depends on the network and the server's
 *   address**, not on the protocol: two servers carried data on almost
 *   every such ISP, the others on one or two and nothing on the rest;
 * * **which protocol lands depends on the network's filtering**, on any
 *   server that works there at all: of dials on such servers, one
 *   protocol landed 161 times in 180 and another once in 14 -- and the
 *   second is first in the fixed order.
 *
 * A route is one of each, and far more people try a server or a protocol
 * than try any one route. So the two are counted apart, each from every
 * dial that says something about it, and a route is placed by what is
 * known of its server and of its protocol.
 *
 * # Telling the two apart
 *
 * A dial that carried traffic proves both its server and its protocol. A
 * dial that did not is ambiguous: the address may be blocked, or the
 * protocol. So a failed dial is counted
 *
 * * against its **server** only when its protocol carried traffic
 *   somewhere on the same network -- a protocol the network drops
 *   everywhere says nothing about any one server;
 * * against its **protocol** only when its server carried traffic for
 *   somebody on the same network -- a blocked server does not drag every
 *   protocol down.
 *
 * "The same network" is the dialler's own ISP in both, also when the
 * counts are then added up over a country.
 *
 * # Levels
 *
 * Each server and each protocol is decided at the finest level that has
 * enough people behind it: the caller's ISP first, and where that says
 * nothing, every ISP registered in the same country -- unless the ISP's
 * own evidence, however thin, points the other way (`decide`). Filtering
 * is largely national with per-ISP differences, so the country is a
 * better guess than a constant and a worse one than the ISP.
 *
 * A country's verdict is a claim about ISPs nobody has tried the server
 * on, so it has to rest on several of them, not on several customers of
 * one (`MIN_COUNTRY_NETWORKS`).
 *
 * # Where everything gets through
 *
 * On a network with no filtering every server that three customers have
 * used "works", which tells it from the other servers by nothing but who
 * happened to use it. The apps dial what works ahead of what nobody can
 * speak for, and stop at the first rung that carries: so every new
 * device there would start on the servers earlier customers used -- a
 * far one somebody picked on purpose included -- and a nearer or a newly
 * added server would never be dialled automatically, and so never
 * collect the three customers to compete. Spreading new devices across
 * servers is what the apps do when told nothing.
 *
 * So a server is called working only on a network where something -- a
 * server or a protocol, at the ISP or across its country -- is shown NOT
 * to get through; elsewhere nothing is said of servers at all. That is
 * read off the whole window, not off the failing verdicts still fresh:
 * those lapse within two days of everyone having learnt to avoid what
 * fails, which is exactly when the working servers' lead is doing its
 * job. Once the window holds no such failures either, new devices are
 * spread again, and the ones that meet a blocked server bring it back.
 *
 * What lands is said everywhere: it picks no server, and among
 * protocols that land the apps' fixed order still decides.
 *
 * # What it is not
 *
 * Not shown to anyone, and never about fewer than
 * `MIN_ORDER_CUSTOMERS` distinct customers. Order only: the apps still
 * dial everything, and a device's own results on a network always
 * outrank this (failover.ts in the desktop client).
 */

/** How far back these signals reach. Seven days where the tag has two:
 * they are coarser and nobody is shown them, and what they need most is
 * enough people -- the figures above took a week of reports to collect.
 * Inside the reports' fourteen-day retention. Each customer counts by
 * their LATEST dial of each route, so a change shows as soon as people
 * dial again, not when the window has turned over. */
export const ORDER_WINDOW_HOURS = 7 * 24;

/** The fewest distinct customers behind a verdict -- on the side it
 * claims: three it carried for, or three it failed for.
 *
 * Fewer than the tag's five because nothing here is shown to a customer
 * and the apps only order by it; more than one because one person must
 * not be able to make a signal, and more than two so that neither can
 * one person with a second account. */
export const MIN_ORDER_CUSTOMERS = 3;

/** The fewest networks a verdict for a whole country has to rest on --
 * again on the side it claims: customers it carried for on three
 * networks, or failed for on three.
 *
 * Which server works goes by the ISP: of the servers measured, two
 * carried data on almost every filtered ISP and the others on one or two
 * and nothing on the rest. So customers on one network say what that
 * network does, and three of them on one ISP must not make a verdict for
 * every other ISP in the country nobody has tried the server on -- a
 * server that carries on one would be dialled first on all of them, and
 * an office or campus that blocks one would send it last for a country.
 * Three because "one or two" is exactly what has to be ruled out. It
 * also means three accounts on one network cannot set a country's order;
 * the reports are the apps' own word. */
export const MIN_COUNTRY_NETWORKS = 3;

/** How recent the newest failure behind a "fails" verdict has to be.
 *
 * A negative verdict sends a server or protocol to the back of the
 * order, where few will dial it again -- so left alone it would keep
 * itself alive for the whole window on evidence nobody is renewing, and
 * a block that was lifted would not be found. It has to be re-earned:
 * once no failure is newer than this, the verdict lapses, devices with
 * nothing better to go on try it again in its ordinary place, and it
 * comes back only if it fails for them too. The tag's window, for the
 * tag's reason: about two days is how long filtering can be assumed to
 * stand still. A "works" verdict needs no such rule -- it sends people
 * to the server, and their failures end it. */
export const FAILS_FRESH_HOURS = WINDOW_HOURS;

export type ServerVerdict = "works" | "fails";
export type ProtocolVerdict = "lands" | "fails";

/** What the route list carries for one route (`ispHint`). */
export interface IspHint {
  /** The network all of this describes: the caller's, as the server read
   * it. An app holds the list across a change of network, and uses the
   * hints only while it is still on this one. */
  asn: number;
  /** How the route's server has done for customers on that network.
   * Absent when too few tried it to say -- and "works" is absent on a
   * network where nothing is shown to fail. */
  server?: ServerVerdict;
  /** Whether the route's protocol lands there, on servers that work
   * there. Absent when too few tried it to say. */
  protocol?: ProtocolVerdict;
}

/** One customer's latest dial of one route on one network
 * (latestDialsSql). */
export interface OrderDial {
  customerId: string;
  asn: number;
  routeId: string;
  carried: boolean;
  /** When it happened, epoch ms. */
  at: number;
}

/** What a route dials. */
export interface RouteKind {
  /** The node the app dials. */
  nodeId: string;
  /** Where a relayed route's traffic leaves from; null on a direct one. */
  exitNodeId: string | null;
  protocol: string;
  transport: string | null;
}

/** The server a route's dials are evidence about. For a relay the exit is
 * part of it, as it is in the apps (`serverKey` in data-check.ts): one
 * entry box can carry an exit that is held and another that is not. */
export function serverKey(kind: RouteKind): string {
  return kind.exitNodeId === null ? kind.nodeId : `${kind.nodeId}>${kind.exitNodeId}`;
}

/** The protocol a route's dials are evidence about: how it is carried is
 * part of it (the WebSocket and TCP variants of one protocol are told
 * apart on the wire, and land differently), and so is whether it enters
 * at a relay -- a protocol reaching a relay inside the country says
 * nothing about the same protocol crossing the border. */
export function protocolKey(kind: RouteKind): string {
  return `${kind.protocol}/${kind.transport ?? ""}/${kind.exitNodeId === null ? "direct" : "relay"}`;
}

/** One customer's standing on one server or protocol. */
interface Side {
  /** The networks a counted dial of theirs carried traffic on. Any at
   * all, and it carried for them. */
  carriedOn: Set<number>;
  /** The networks a counted dial of theirs failed on. */
  failedOn: Set<number>;
  /** Their newest counted failure, epoch ms; 0 for none. */
  failedAt: number;
}

/** Customers by server or protocol key. */
type Tally = Map<string, Map<string, Side>>;

interface Evidence {
  servers: Tally;
  protocols: Tally;
}

function sideOf(tally: Tally, key: string, customerId: string): Side {
  let customers = tally.get(key);
  if (!customers) tally.set(key, (customers = new Map<string, Side>()));
  let side = customers.get(customerId);
  if (!side) customers.set(customerId, (side = { carriedOn: new Set(), failedOn: new Set(), failedAt: 0 }));
  return side;
}

function note(tally: Tally, key: string, dial: OrderDial): void {
  const side = sideOf(tally, key, dial.customerId);
  if (dial.carried) {
    side.carriedOn.add(dial.asn);
  } else {
    side.failedOn.add(dial.asn);
    side.failedAt = Math.max(side.failedAt, dial.at);
  }
}

/** One network's dials as evidence about servers and protocols, by the
 * rules at the top of this file. */
function evidenceOn(dials: Array<OrderDial & { kind: RouteKind }>): Evidence {
  const carriedOn = new Set<string>();
  const carriedBy = new Set<string>();
  for (const dial of dials) {
    if (!dial.carried) continue;
    carriedOn.add(serverKey(dial.kind));
    carriedBy.add(protocolKey(dial.kind));
  }
  const evidence: Evidence = { servers: new Map(), protocols: new Map() };
  for (const dial of dials) {
    const server = serverKey(dial.kind);
    const protocol = protocolKey(dial.kind);
    if (dial.carried || carriedBy.has(protocol)) note(evidence.servers, server, dial);
    if (dial.carried || carriedOn.has(server)) note(evidence.protocols, protocol, dial);
  }
  return evidence;
}

/** Adds one network's tally into a wider one. A customer seen on two
 * networks is still one customer: carried anywhere is carried. Which
 * networks each was seen on is kept (`MIN_COUNTRY_NETWORKS`). */
function merge(into: Tally, from: Tally): void {
  for (const [key, customers] of from) {
    for (const [customerId, side] of customers) {
      const held = sideOf(into, key, customerId);
      for (const asn of side.carriedOn) held.carriedOn.add(asn);
      for (const asn of side.failedOn) held.failedOn.add(asn);
      held.failedAt = Math.max(held.failedAt, side.failedAt);
    }
  }
}

interface Count {
  /** Distinct customers with a counted dial. */
  tried: number;
  /** Of those, the ones it carried traffic for. */
  carried: number;
  /** The newest failure among the ones it did not, epoch ms; 0 for none. */
  lastFailedAt: number;
  /** How many networks it carried on, for those it carried for. */
  carriedNetworks: number;
  /** How many networks it failed on, for those it never carried for. */
  failedNetworks: number;
}

const NOBODY: Count = { tried: 0, carried: 0, lastFailedAt: 0, carriedNetworks: 0, failedNetworks: 0 };

function count(customers: Map<string, Side> | undefined): Count {
  if (!customers) return NOBODY;
  let carried = 0;
  let lastFailedAt = 0;
  const carriedOn = new Set<number>();
  const failedOn = new Set<number>();
  for (const side of customers.values()) {
    if (side.carriedOn.size > 0) {
      carried += 1;
      for (const asn of side.carriedOn) carriedOn.add(asn);
    } else {
      lastFailedAt = Math.max(lastFailedAt, side.failedAt);
      for (const asn of side.failedOn) failedOn.add(asn);
    }
  }
  return {
    tried: customers.size,
    carried,
    lastFailedAt,
    carriedNetworks: carriedOn.size,
    failedNetworks: failedOn.size,
  };
}

/** What one level's count shows, however old its failures: the tag's own
 * shares, over fewer people, on at least `networks` networks -- one for
 * an ISP, which is one, and `MIN_COUNTRY_NETWORKS` for a country. */
function shownBy(c: Count, networks: number): "good" | "bad" | null {
  if (c.carried >= MIN_ORDER_CUSTOMERS && c.carriedNetworks >= networks && c.carried >= WORKS_SHARE * c.tried) {
    return "good";
  }
  const failed = c.tried - c.carried;
  if (failed >= MIN_ORDER_CUSTOMERS && c.failedNetworks >= networks && c.carried <= FAILING_SHARE * c.tried) {
    return "bad";
  }
  return null;
}

/** What one level's count says by itself, if anything: what it shows,
 * less a failing verdict nobody has renewed (`FAILS_FRESH_HOURS`). */
function verdictOf(c: Count, now: number, networks: number): "good" | "bad" | null {
  const shown = shownBy(c, networks);
  return shown === "bad" && c.lastFailedAt < now - FAILS_FRESH_HOURS * 3_600_000 ? null : shown;
}

/** The ISP's own verdict where it has one; otherwise the country's,
 * unless what little the ISP has seen points the other way. A server
 * that works for most of a country and failed for the one customer who
 * tried it on this ISP is not known to work here, and the reverse. */
export function decide(isp: Count, country: Count | null, now: number): "good" | "bad" | null {
  const own = verdictOf(isp, now, 1);
  if (own !== null || country === null) return own;
  const wide = verdictOf(country, now, MIN_COUNTRY_NETWORKS);
  if (wide === "good") return isp.carried >= WORKS_SHARE * isp.tried ? "good" : null;
  if (wide === "bad") return isp.carried <= FAILING_SHARE * isp.tried ? "bad" : null;
  return null;
}

/** Whether anything at one level -- a server or a protocol -- is shown
 * not to get through, inside the window. Fresh or not: this is asked
 * about the network, not about that server or protocol (`networkOrder`). */
function showsFailing(evidence: Evidence, networks: number): boolean {
  for (const tally of [evidence.servers, evidence.protocols]) {
    for (const customers of tally.values()) if (shownBy(count(customers), networks) === "bad") return true;
  }
  return false;
}

export interface NetworkOrder {
  /** By `serverKey`. */
  servers: Map<string, ServerVerdict>;
  /** By `protocolKey`. */
  protocols: Map<string, ProtocolVerdict>;
}

/** The two signals for a caller on `asn`.
 *
 * `dials` are the latest dials on that network and, where the country is
 * known, on every other network registered in it (`sameCountry` true);
 * with the country unknown they are the caller's network's alone and
 * nothing wider is consulted. Dials of routes not in `routes` (deleted
 * since) say nothing and are passed over. */
export function networkOrder(
  dials: readonly OrderDial[],
  routes: ReadonlyMap<string, RouteKind>,
  asn: number,
  now: number,
  sameCountry = true,
): NetworkOrder {
  const since = now - ORDER_WINDOW_HOURS * 3_600_000;
  const byAsn = new Map<number, Array<OrderDial & { kind: RouteKind }>>();
  for (const dial of dials) {
    const kind = routes.get(dial.routeId);
    if (!kind || !dial.customerId || !(dial.at >= since)) continue;
    const list = byAsn.get(dial.asn) ?? [];
    list.push({ ...dial, kind });
    byAsn.set(dial.asn, list);
  }

  const isp: Evidence = evidenceOn(byAsn.get(asn) ?? []);
  let country: Evidence | null = null;
  if (sameCountry) {
    country = { servers: new Map(), protocols: new Map() };
    for (const list of byAsn.values()) {
      const evidence = evidenceOn(list);
      merge(country.servers, evidence.servers);
      merge(country.protocols, evidence.protocols);
    }
  }

  // A server is called working only where something is shown not to get
  // through: "Where everything gets through", at the top of this file.
  const filtered = showsFailing(isp, 1) || (country !== null && showsFailing(country, MIN_COUNTRY_NETWORKS));

  const servers = new Map<string, ServerVerdict>();
  for (const key of new Set([...isp.servers.keys(), ...(country?.servers.keys() ?? [])])) {
    const verdict = decide(count(isp.servers.get(key)), country && count(country.servers.get(key)), now);
    if (verdict === "bad") servers.set(key, "fails");
    else if (verdict === "good" && filtered) servers.set(key, "works");
  }
  const protocols = new Map<string, ProtocolVerdict>();
  for (const key of new Set([...isp.protocols.keys(), ...(country?.protocols.keys() ?? [])])) {
    const verdict = decide(count(isp.protocols.get(key)), country && count(country.protocols.get(key)), now);
    if (verdict) protocols.set(key, verdict === "good" ? "lands" : "fails");
  }
  return { servers, protocols };
}

/** The hint for one route on a network whose signals are `order`. Always
 * names the network, so the app can tell which one a list in its hands
 * describes even where there is nothing else to say. */
export function hintFor(asn: number, kind: RouteKind, order: NetworkOrder): IspHint {
  const hint: IspHint = { asn };
  const server = order.servers.get(serverKey(kind));
  const protocol = order.protocols.get(protocolKey(kind));
  if (server) hint.server = server;
  if (protocol) hint.protocol = protocol;
  return hint;
}
