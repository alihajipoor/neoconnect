import { scoreFor, type ConnectHistory } from "./connect-history";
import { reachabilityOf, type ReachabilityMap } from "./reachability";
import type { IspTag, Protocol, ProtocolUser } from "./types";

export type IspTagCode = IspTag["code"];

/** The route list's tags, in the shape `orderCandidates` takes. */
export function ispTagsOf(routes: ReadonlyArray<{ id: string; ispTag?: IspTag | null }>): Record<string, IspTagCode> {
  const tags: Record<string, IspTagCode> = {};
  for (const route of routes) if (route.ispTag) tags[route.id] = route.ispTag.code;
  return tags;
}

/** Order to try protocols in when nothing better is known.
 *
 * Speed first, evasion last, confirmed as the product decision: the
 * audience is general-purpose rather than only censored networks, so the
 * common case should cost nothing. On an ordinary connection the first
 * attempt wins immediately. Someone behind a filter pays a few seconds
 * walking the list, once -- after which the per-network memory means
 * they never pay it again on that network.
 *
 * REALITY sits ahead of the certificate-presenting transports because it
 * borrows a real third party's certificate and so has none of ours to
 * fingerprint. OpenVPN is last: it is the most recognisable on the wire
 * and the slowest to negotiate.
 */
const PROTOCOL_ORDER: Protocol[] = [
  "WIREGUARD",
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_TROJAN",
  "XRAY_VMESS",
  // After the certificate-presenting transports, before OpenVPN. It is
  // fast and has no TLS handshake to fingerprint, but equally nothing to
  // hide behind: a censor who finds the port blocks it outright, where a
  // TLS-shaped transport has to be distinguished from real web traffic
  // first. So it is the answer when the disguises have failed, not
  // before they have been tried.
  "SHADOWSOCKS",
  "OPENVPN",
  // Last, despite being the fastest to establish of any of these. Its
  // ports are fixed at UDP 500 and 4500 -- it cannot be moved to a port
  // nobody is watching the way the others can -- which makes it the
  // first thing a filtering network drops, and a blocked attempt costs
  // a full timeout because Windows dials it rather than us. It exists
  // for the customers whose device or network will carry nothing else,
  // and those customers pin it in the server list, which is tried ahead
  // of this order entirely.
  "IKEV2",
];

function rank(protocol: Protocol): number {
  const i = PROTOCOL_ORDER.indexOf(protocol);
  // Anything unrecognised goes last rather than first: an unknown
  // protocol is one this build cannot connect with anyway.
  return i === -1 ? PROTOCOL_ORDER.length : i;
}

/** The order to attempt the credentials this subscription holds.
 *
 * Three inputs, in descending authority:
 *
 * 1. `chosenRouteId` — the customer picked this one in the server list,
 *    so it is tried first. It is deliberately not the *only* candidate:
 *    see the note in the body.
 * 2. `lastGoodRouteId` — what actually worked on this network last time.
 *    Evidence beats a guess, so it leads.
 * 3. `preferredRouteId` — the plan's default, as set by the operator.
 *
 * Everything else follows in PROTOCOL_ORDER. Ties break on routeId so
 * the order is stable between runs; an order that reshuffles itself
 * makes a failure impossible to reproduce.
 */
export function orderCandidates(
  users: ProtocolUser[],
  opts: {
    /** The route a tunnel was on when it dropped, for an automatic
     * reconnect (`auto-reconnect.ts`): tried first, ahead even of the
     * pin. It is where the last ladder pass -- which already honoured
     * the pin -- actually landed, so it is the best evidence there is of
     * what works here right now. Everything else follows in the order it
     * always would. */
    resumeRouteId?: string | null;
    pinnedRouteId?: string | null;
    lastGoodRouteId?: string | null;
    preferredRouteId?: string | null;
    /** What this device has seen work lately, if anything. */
    history?: ConnectHistory;
    network?: string | null;
    now?: number;
    /** What answered a handshake just now, for the ones that could be
     * asked. */
    reachability?: ReachabilityMap;
    /** What other people on this network recently saw, per route (the
     * route list's `ispTag` codes). Consulted only while this device
     * has no evidence of its own here -- see `fromOthers`. */
    ispTags?: Record<string, IspTagCode | undefined>;
  } = {},
): ProtocolUser[] {
  const {
    resumeRouteId,
    pinnedRouteId,
    lastGoodRouteId,
    preferredRouteId,
    history,
    network,
    now,
    reachability,
    ispTags,
  } = opts;

  // A chosen route leads; it does not exclude the others.
  //
  // This used to return only the pinned route, disabling failover
  // entirely. That was wrong in the way that matters: picking a server
  // from the list is the most ordinary thing a customer does, and it
  // silently switched off the feature that protects them -- then
  // reported "every protocol was tried" after trying one. Choosing a
  // server should mean "start here", not "and give up if it fails".
  //
  // Locking to a single protocol is a reasonable thing to want, but it
  // should be an explicit setting, not a side effect of browsing the
  // server list.
  const priority = (u: ProtocolUser): number => {
    if (resumeRouteId && u.routeId === resumeRouteId) return -4;
    if (pinnedRouteId && u.routeId === pinnedRouteId) return -3;
    if (lastGoodRouteId && u.routeId === lastGoodRouteId) return -2;
    if (preferredRouteId && u.routeId === preferredRouteId) return -1;
    return 0;
  };

  // A WebSocket-carried credential sorts after its TCP sibling: the
  // extra framing costs a little speed, and its advantage -- surviving a
  // CDN, looking like ordinary web traffic -- only matters once the
  // plainer variant has failed. Same protocol, so nothing above
  // separates them.
  const wsLast = (u: ProtocolUser) => (u.connection?.transport === "WS" ? 1 : 0);

  // Measured evidence, ahead of the fixed order and behind the
  // customer's own choice.
  //
  // `PROTOCOL_ORDER` is one list for everybody, and for Iran it cannot
  // be right: filtering differs between two subscribers on the same ISP
  // and changes from one day to the next, so an order derived from
  // anyone else's experience -- or from last week's -- is a guess. What
  // this device saw in the last few hours is not.
  //
  // Only combinations with evidence are moved. `scoreFor` returns null
  // when nothing is known, and those keep their place in the fixed
  // order rather than being sorted against a number they do not have;
  // an untried protocol must not outrank one that has been working.
  const evidence = (u: ProtocolUser): number | null =>
    history ? scoreFor(history, network ?? null, u.routeId, u.protocol, now) : null;

  const byEvidence = (a: ProtocolUser, b: ProtocolUser): number => {
    const [x, y] = [evidence(a), evidence(b)];
    if (x === null && y === null) return 0;
    // Something known to work leads something unknown; something known
    // to fail follows it. The midpoint is where "no idea" sits.
    const place = (v: number | null) => (v === null ? 0.5 : v);
    return place(y) - place(x);
  };

  // What answered a moment ago, ahead of what worked yesterday.
  //
  // Live beats remembered: a protocol that has just refused a handshake
  // is not going to carry a tunnel, however well it did this morning,
  // and filtering in Iran changes within a day. Only three states, and
  // the middle one is load-bearing -- a candidate that could not be
  // probed, because it is UDP, must sit exactly where an unknown sits
  // rather than below something that failed. Burying WireGuard for not
  // being TCP would take away the one option some customers have.
  const liveness = (u: ProtocolUser): number => {
    switch (reachabilityOf(reachability, u.routeId, u.protocol)) {
      case "reachable":
        return -1;
      case "unreachable":
        return 1;
      default:
        return 0;
    }
  };

  // Other people's experience, as a tie-break -- and only on a network
  // this device knows nothing about.
  //
  // ac56993 refused to order by anyone else's data, and on a network the
  // device has history for, that still holds without exception: filtering
  // differs between two people on one ISP and from day to day, so this
  // device's own results are the better guide, and they alone order the
  // ladder here.
  //
  // The case it left open is the one people quit over: a first run, or a
  // network never seen before, where there is no evidence at all and the
  // order falls to `PROTOCOL_ORDER` -- one list for the whole world. A
  // customer on a carrier where that list's first entries are blocked
  // waits through each of them, decides the app is broken, and leaves.
  // There, "most people on this network got through on X recently" is
  // strictly better than a global constant. So it ranks below everything
  // the device itself knows (a pin, a last-good, the live probe, its own
  // history) and above the fixed order. The moment the device has any
  // evidence on this network, this returns 0 for everyone and the order
  // is exactly what it was before tags existed.
  const deviceKnowsNetwork =
    Boolean(lastGoodRouteId && users.some((u) => u.routeId === lastGoodRouteId)) ||
    users.some((u) => evidence(u) !== null);
  const fromOthers = (u: ProtocolUser): number => {
    if (deviceKnowsNetwork || !ispTags) return 0;
    switch (ispTags[u.routeId]) {
      case "worksOnYourIsp":
        return -1;
      case "failingOnYourIsp":
        return 1;
      default:
        return 0;
    }
  };

  return [...users].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      liveness(a) - liveness(b) ||
      byEvidence(a, b) ||
      fromOthers(a) - fromOthers(b) ||
      rank(a.protocol) - rank(b.protocol) ||
      wsLast(a) - wsLast(b) ||
      a.routeId.localeCompare(b.routeId),
  );
}

/** Where the "what worked here last time" memory lives.
 *
 * Keyed by network so the answer can differ between a home connection
 * where everything works and a filtered one where only a disguised
 * transport does. An unknown network shares one bucket rather than
 * getting a fabricated identity, which would attach the memory to the
 * wrong place.
 */
const STORE_KEY = "failover.lastGood";

export type LastGoodMap = Record<string, string>;

export function lastGoodFor(map: LastGoodMap, network: string | null): string | null {
  return map[network ?? "unknown"] ?? null;
}

export function rememberLastGood(map: LastGoodMap, network: string | null, routeId: string): LastGoodMap {
  return { ...map, [network ?? "unknown"]: routeId };
}

export { STORE_KEY as LAST_GOOD_STORE_KEY };
