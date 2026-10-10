import type { RouteOption } from "./types";

/** The list an open server picker takes from the dashboard beneath it, or
 * null to keep what it has.
 *
 * The picker reads the dashboard's list once, as it opens
 * (`initialRoutes`), and refreshes for itself. Opened while the
 * dashboard's own route request was still waiting on a slow or blocked
 * address -- up to twenty seconds an address now -- it opened on nothing;
 * its refresh failed too, and it said Neoxify could not be reached, while
 * a moment later the dashboard put the cached servers on screen beneath
 * it. So a list the dashboard offers later is taken, while the picker has
 * nothing to show and its own request has not answered. Never over rows
 * it is showing, and never over its own answer, which is newer than
 * anything the dashboard holds -- an empty one included, which says the
 * plan has no servers now. */
export function routesToAdopt(
  shown: readonly RouteOption[],
  ownAnswered: boolean,
  offered: readonly RouteOption[] | undefined,
): RouteOption[] | null {
  if (ownAnswered || shown.length > 0 || offered === undefined || offered.length === 0) return null;
  return [...offered];
}
