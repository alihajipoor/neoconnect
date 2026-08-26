import type { RouteOption } from "./types";

/** The exits a customer can actually choose between, derived from the
 * routes their plan already reaches.
 *
 * # Why this is derived rather than fetched
 *
 * There is no exit list endpoint and there should not be one. An exit is
 * only meaningful to a customer as "somewhere my traffic can leave
 * from", and the routes they hold already say which those are. Deriving
 * it also means the picker works from the offline snapshot, which
 * matters here more than it usually would: the control plane is a
 * plausible thing to lose first on a filtered network, and a settings
 * screen that goes blank because the API is unreachable is a settings
 * screen that is broken in Iran.
 *
 * # Why grouping is the whole point
 *
 * `RouteOption.exit` is the only handle that answers "are these two the
 * same place". Two protocols on one node are two routes and one exit; a
 * relay through Iran and a direct German route can be two routes and one
 * exit. Presenting routes as if they were exits would let a customer put
 * two games on what they believe are two exits and land both on one
 * machine -- which is the concentration `docs/design/ban-safety.md`
 * mechanism 5 argues against, arrived at by a picker that lied.
 */
export interface ExitOption {
  /** The opaque handle, exactly as the backend spelled it. This is what
   * gets stored on a `GameExitGroup` and what travels to the service. */
  exit: string;
  /** Every route in the customer's own list that leaves from here.
   *
   * Kept whole rather than reduced to a count: the card names the routes
   * so a customer can see *how* they would reach this exit, and whether
   * the fast one and the stealthy one are the same place. */
  routes: RouteOption[];
  /** The node names of the routes that reach this exit **directly**.
   *
   * Only direct routes, and that restriction is the honest part. A
   * direct route is dialled at the machine it leaves from, so its node
   * name names this exit. A relay is dialled somewhere else entirely,
   * and its node name is the entry -- using it would tell a customer
   * their traffic appears from Iran when it appears from Germany.
   *
   * Deduplicated and sorted, so two protocols on one node read as one
   * place. */
  directNames: string[];
  /** The regions of the direct routes, same rule and same reason. */
  directRegions: string[];
  /** True when every route reaching this exit is relayed, so nothing in
   * the customer's list says where it is.
   *
   * The card must say so rather than borrowing the relay's location.
   * "Somewhere we do not name" is a smaller claim than a wrong one, and
   * it is the same claim `RouteOption` has always made. */
  hidden: boolean;
  /** Whether any route to this exit is currently reported up.
   *
   * Shown, never enforced. A preference for an exit that is down is not
   * an error -- it is the ordinary case the moment a node has a bad
   * hour, and refusing it would take a customer's whole selection down
   * over something that fixes itself. */
  online: boolean;
}

/** Group a route list by the machine each route leaves from.
 *
 * Routes with no handle are dropped: a backend that mints none gives
 * this client no exit vocabulary at all, and inventing one from route
 * ids would produce exactly the false `Fallback` this feature exists to
 * avoid. An empty list is the correct answer there, and the card reads
 * it as "no picker".
 *
 * Ordering is by the first route's name, so the list is stable between
 * renders and reads in the same order as the location picker.
 */
export function exitOptions(routes: readonly RouteOption[]): ExitOption[] {
  const byExit = new Map<string, ExitOption>();

  for (const route of routes) {
    const exit = route.exit;
    if (typeof exit !== "string" || exit.length === 0) continue;

    let option = byExit.get(exit);
    if (!option) {
      option = { exit, routes: [], directNames: [], directRegions: [], hidden: true, online: false };
      byExit.set(exit, option);
    }
    option.routes.push(route);
    if (!route.isRelay) {
      option.hidden = false;
      if (!option.directNames.includes(route.location.nodeName)) {
        option.directNames.push(route.location.nodeName);
      }
      if (!option.directRegions.includes(route.location.region)) {
        option.directRegions.push(route.location.region);
      }
    }
    if (route.nodeStatus === "ONLINE") option.online = true;
  }

  const out = [...byExit.values()];
  for (const option of out) {
    option.directNames.sort();
    option.directRegions.sort();
  }
  out.sort((a, b) => (a.routes[0]?.name ?? "").localeCompare(b.routes[0]?.name ?? ""));
  return out;
}

/** The exit a given route leaves from, or `null` when the backend named
 * none.
 *
 * The one place the connect path turns "which route did we land on" into
 * "which exit is this session leaving from". Deliberately a lookup
 * against the route list rather than anything derived from the tunnel:
 * the service can see which adapter is up and which address is on it,
 * and neither says which *node* the far end egresses from -- on a
 * relayed route they are different machines. The client dialled the
 * route and is the only side holding that fact.
 */
export function exitOfRoute(routes: readonly RouteOption[], routeId: string | null | undefined): string | null {
  if (!routeId) return null;
  const route = routes.find((r) => r.id === routeId);
  const exit = route?.exit;
  return typeof exit === "string" && exit.length > 0 ? exit : null;
}

/** Whether this route list can name an exit at all.
 *
 * What the card asks before offering a picker. False on an older
 * backend, on a deployment with no handle secret configured, and
 * offline before the first successful fetch -- all three of which are
 * the same answer to the customer: this build cannot honestly say where
 * anything leaves from, so it does not offer to choose.
 */
export function hasExitVocabulary(routes: readonly RouteOption[]): boolean {
  return routes.some((r) => typeof r.exit === "string" && r.exit.length > 0);
}
