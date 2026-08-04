import type { Protocol, ProtocolUser } from "./types";

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
  "OPENVPN",
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
  opts: { pinnedRouteId?: string | null; lastGoodRouteId?: string | null; preferredRouteId?: string | null } = {},
): ProtocolUser[] {
  const { pinnedRouteId, lastGoodRouteId, preferredRouteId } = opts;

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

  return [...users].sort(
    (a, b) =>
      priority(a) - priority(b) ||
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
