import type { RouteOption } from "./types";

/** Whether any route carries a "worked on your network" tag -- the
 * condition for offering the filter at all. */
export function hasRecommended(routes: ReadonlyArray<Pick<RouteOption, "ispTag">>): boolean {
  return routes.some((r) => r.ispTag?.code === "worksOnYourIsp");
}

/** The rows the picker shows, in the order the server sent them.
 *
 * Filtering narrows; it never reorders. Re-sorting the list by tag
 * would move rows under the customer's finger as tags arrive with a
 * background refresh, and would quietly turn other people's experience
 * into a ranking -- which is the ladder's business, under rules of its
 * own (see `orderCandidates`), not the picker's.
 *
 * If the filter would leave nothing, the full list is shown instead: an
 * empty picker reads as "nothing works here", and an absence of evidence
 * means no such thing. */
export function pickerRows<T extends Pick<RouteOption, "ispTag">>(routes: readonly T[], recommendedOnly: boolean): T[] {
  if (!recommendedOnly) return [...routes];
  const recommended = routes.filter((r) => r.ispTag?.code === "worksOnYourIsp");
  return recommended.length > 0 ? recommended : [...routes];
}
