import type { ConnectionState } from "../components/ConnectOrb";

/** Which route the SERVER tile should name.
 *
 * Split out of the dashboards because both clients had the identical
 * decision written inline and identically wrong, and because the bug it
 * fixes is not reproducible on demand: it needs a ladder that walks past
 * its first pick, which means a genuinely unreachable server.
 *
 * The rule is that the tile names whatever a customer would be right to
 * infer from it, and that changes with the connection state:
 *
 *   - While nothing is up, it is a promise about the next connect. The
 *     pinned choice leads, because that is what the ladder will try
 *     first; the provisioned route fills in when nothing is pinned.
 *
 *   - Once an engine is up, it is a claim about where traffic is going
 *     right now, and the only honest source for that is the candidate
 *     the ladder settled on.
 *
 * Conflating the two is what shipped in 0.2.18. On a real iPhone the
 * tile read de-germany while the exit address geolocated to Singapore:
 * the pin was Germany, Germany would not carry the connection, the
 * ladder moved on, and the tile went on naming the pin. The app named
 * one country and used another, which is the same shape of lie as a
 * false "Connected" and lands on the same people -- someone choosing an
 * exit country is usually choosing it for a reason.
 */

/** The states in which an engine is running, so the tile is describing
 * the present rather than the next attempt.
 *
 * `unverified` and `degraded` are in deliberately. Both mean a tunnel
 * exists, so both are cases where the settled route is the true answer;
 * whether traffic is *confirmed* to flow is the orb's job to say, and
 * duplicating that judgement here would let the two disagree. */
const TUNNEL_UP: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "connected",
  "verifying",
  "unverified",
  "degraded",
]);

export interface RouteLike {
  id: string;
}

export function displayedRouteId(
  connectionState: ConnectionState,
  /** The route the ladder settled on, from the connected ProtocolUser. */
  settledRouteId: string | null | undefined,
  /** What the customer pinned on this device, if anything. */
  pinnedRouteId: string | null | undefined,
  /** What the backend has provisioned, used when nothing is pinned. */
  provisionedRouteId: string | null | undefined,
): string | null {
  if (TUNNEL_UP.has(connectionState) && settledRouteId) return settledRouteId;
  return pinnedRouteId ?? provisionedRouteId ?? null;
}

/** The same decision, resolved against the route list the screen holds.
 *
 * Falls through rather than returning null when the settled route is not
 * in the list: a route can be withdrawn from the catalogue while a
 * customer is still connected through it, and blanking the tile mid-
 * session tells them less than naming their pin does. */
export function displayedRoute<T extends RouteLike>(
  routes: readonly T[],
  connectionState: ConnectionState,
  settledRouteId: string | null | undefined,
  pinnedRouteId: string | null | undefined,
  provisionedRouteId: string | null | undefined,
): T | null {
  const wanted = displayedRouteId(connectionState, settledRouteId, pinnedRouteId, provisionedRouteId);
  return (
    (wanted ? routes.find((r) => r.id === wanted) : undefined) ??
    routes.find((r) => r.id === pinnedRouteId) ??
    routes.find((r) => r.id === provisionedRouteId) ??
    null
  );
}

/** Whether the SERVER and PROTOCOL tiles should say "Automatic" rather
 * than name a route.
 *
 * With nothing pinned, the route a connect will use is not decided until
 * the ladder has walked to one that carries traffic -- so naming the
 * provisioned route beforehand (what the tiles used to do) promised a
 * server the app might never dial, which is the 0.2.18 lie in a new
 * place. And while the ladder is still walking, the candidate it is on
 * may be abandoned a second later.
 *
 * So: "Automatic" until a tunnel has settled, then the settled route.
 * `connected` is the verified case. `unverified` and `degraded` name the
 * route too, because a tunnel *is* up on it and where traffic is going
 * is a fact the customer is owed; whether it is confirmed to flow is the
 * orb's to say, as `TUNNEL_UP` explains. `verifying` does not: the
 * ladder may still move on from it.
 *
 * A pin is always named -- it is the customer's own choice, and the rule
 * above already handles it. */
export function showsAutomatic(connectionState: ConnectionState, pinnedRouteId: string | null | undefined): boolean {
  if (pinnedRouteId) return false;
  return !SETTLED.has(connectionState);
}

const SETTLED: ReadonlySet<ConnectionState> = new Set<ConnectionState>(["connected", "unverified", "degraded"]);
