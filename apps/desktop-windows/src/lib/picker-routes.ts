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
 * it. So a list the dashboard offers later is taken, for as long as the
 * picker's own request has not answered. Never over its own answer, which
 * is newer than anything the dashboard holds -- an empty one included,
 * which says the plan has no servers now.
 *
 * Over rows it is showing, though. Until its own request answers, every
 * row it shows is a list the dashboard offered earlier, and the newer
 * offer knows more: a load that has since learned the plan changed puts
 * the new plan's list there, or takes the old plan's away with an empty
 * one (`standInRoutes` in credential-cache.ts). Kept, the old plan's rows
 * stayed in an open picker after the dashboard had withdrawn them, and a
 * pick asked the server for a route the new plan does not have. The same
 * list offered again changes nothing. */
export function routesToAdopt(
  shown: readonly RouteOption[],
  ownAnswered: boolean,
  offered: readonly RouteOption[] | undefined,
): RouteOption[] | null {
  if (ownAnswered || offered === undefined) return null;
  if (shown.length === offered.length && shown.every((route, i) => route.id === offered[i].id)) return null;
  return [...offered];
}
