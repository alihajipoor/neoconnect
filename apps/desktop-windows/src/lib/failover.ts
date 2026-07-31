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
 * 1. `pinnedRouteId` — the customer chose this one in the picker. A
 *    deliberate choice is not something to quietly override, so when it
 *    is set it is the only candidate.
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

  if (pinnedRouteId) {
    const pinned = users.filter((u) => u.routeId === pinnedRouteId);
    // Falls through to the normal order if the pin refers to a route the
    // customer no longer has -- a stale preference must not leave them
    // with nothing to connect to.
    if (pinned.length > 0) return pinned;
  }

  const priority = (u: ProtocolUser): number => {
    if (lastGoodRouteId && u.routeId === lastGoodRouteId) return -2;
    if (preferredRouteId && u.routeId === preferredRouteId) return -1;
    return 0;
  };

  return [...users].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      rank(a.protocol) - rank(b.protocol) ||
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
