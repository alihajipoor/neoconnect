import { combineEvidence, type PlaceEvidence } from "./map-lights";
import { CUSTOMER_PROTOCOL_LABELS, PROTOCOL_LABELS, customerProtocolLabel } from "./protocol-labels";
import { countryCode, countryName, placeKey, routePlace } from "./route-place";
import type { RouteOption } from "./types";

/** The server list as the redesign draws it (design-system.md 4.8): one row
 * per country, Automatic first, then the routes through Iran, each country
 * opening to every protocol it has. Pure, so what is shown for a search or a
 * filter -- and that nothing is ever dropped -- can be pinned without a
 * screen.
 *
 * Order is the server's: places in the order each first appears, routes in
 * order within a place. Nothing is sorted by latency or by tags, so no row
 * moves under the customer's finger as either arrives. */

export type ListFilter = "all" | "worked" | "relay";

export interface ListPlace {
  /** One row per country: a direct route by its country, a relay by its
   * entry and exit ("r:ir>de"). */
  key: string;
  relay: boolean;
  /** Every route to this place, in list order. */
  routes: RouteOption[];
  /** The routes shown under it for this search and filter. */
  shown: RouteOption[];
  /** Matched by a protocol's name and not by the place's: opened, showing
   * only the protocols that matched. */
  open: boolean;
}

export interface ListModel {
  /** Whether the Automatic row is in the list. */
  automatic: boolean;
  countries: ListPlace[];
  relays: ListPlace[];
}

/** What the list knows about what worked on this network: the same inputs
 * as the map's lights (`lib/map-lights.ts`). */
export interface WorkedInputs {
  /** When this route last carried traffic from this device on this
   * network, or null (`ownWorkedAt`). */
  ownAt: (route: RouteOption) => number | null;
  /** Whether the route list's per-network tags describe the network the
   * device is on now. */
  tags: boolean;
}

/** Whether this route is a way in that worked here lately -- the "Worked
 * here" filter's test, protocol by protocol. The same rule as
 * `placeEvidence`'s "live": a route the control plane reports up, with this
 * device's own verified connect or other people's report from this network.
 * A latency number is no part of it. */
export function routeWorked(route: RouteOption, ev: WorkedInputs): boolean {
  if (route.nodeStatus !== "ONLINE") return false;
  if (ev.ownAt(route) !== null) return true;
  return ev.tags && route.ispTag?.code === "worksOnYourIsp";
}

/** The list's row key for a route's place. Countries by their ISO code
 * where the region slug has one, so two slugs in one country are one row. */
export function listKey(route: Pick<RouteOption, "isRelay" | "location" | "exitLocation">): string {
  const { entry, exit } = routePlace(route);
  const at = (region: string) => countryCode(region) ?? region.trim().toLowerCase();
  return route.isRelay ? `r:${at(entry)}>${exit ? at(exit) : ""}` : `c:${at(entry)}`;
}

/** Lower case, Persian letters in one form, no joiners: what a search
 * compares. */
export function searchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[‌‍‎‏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words a place answers to, in both languages whatever the screen is
 * in: someone typing "ایران" into an English screen means Iran. */
function placeTerms(route: RouteOption): string[] {
  const { entry, exit } = routePlace(route);
  const out = [entry, countryName(entry, "en"), countryName(entry, "fa")];
  if (exit) out.push(exit, countryName(exit, "en"), countryName(exit, "fa"));
  if (route.isRelay) out.push("relay", "via iran", "از ایران", "iran", "ایران");
  return out.map(searchText);
}

function protocolTerms(route: RouteOption): string[] {
  return [
    customerProtocolLabel(route.protocol, route.transport),
    CUSTOMER_PROTOCOL_LABELS[route.protocol] ?? "",
    PROTOCOL_LABELS[route.protocol] ?? "",
  ].map(searchText);
}

/** The list for a search and a filter. Client-side only: it never dials.
 *
 * - With a search, a place whose name matches shows all its protocols; one
 *   that matches only by a protocol's name opens and shows only those.
 * - "Worked here" keeps the protocols that worked on this network
 *   (`routeWorked`), and the places that have one: exactly the places whose
 *   light twinkles. "Via Iran" keeps the routes through Iran.
 * - Automatic is offered on "All" only, and to a search for its name.
 * - A filter that leaves nothing leaves nothing: the screen says so, and
 *   how to see everything again. It never quietly shows another list. */
export function buildList(
  routes: readonly RouteOption[],
  {
    query,
    filter,
    worked,
    automaticTerms,
  }: { query: string; filter: ListFilter; worked: (route: RouteOption) => boolean; automaticTerms: readonly string[] },
): ListModel {
  const q = searchText(query);
  const hit = (terms: readonly string[]) => terms.some((term) => term.includes(q));
  const automatic = filter === "all" && (q === "" || hit(automaticTerms.map(searchText)));

  const places = new Map<string, ListPlace>();
  for (const route of routes) {
    const key = listKey(route);
    const place = places.get(key);
    if (place) place.routes.push(route);
    else places.set(key, { key, relay: route.isRelay, routes: [route], shown: [], open: false });
  }

  const countries: ListPlace[] = [];
  const relays: ListPlace[] = [];
  for (const place of places.values()) {
    if (filter === "relay" && !place.relay) continue;
    const candidates = filter === "worked" ? place.routes.filter(worked) : place.routes;
    let shown = candidates;
    let open = false;
    if (q !== "" && !place.routes.some((route) => hit(placeTerms(route)))) {
      shown = candidates.filter((route) => hit(protocolTerms(route)));
      open = true;
    }
    if (shown.length === 0) continue;
    (place.relay ? relays : countries).push({ ...place, shown, open });
  }
  return { automatic, countries, relays };
}

/** Whether the list shows nothing at all. */
export function listEmpty(model: ListModel): boolean {
  return !model.automatic && model.countries.length === 0 && model.relays.length === 0;
}

/** What a place's row says about it: what its light on the map says, from
 * the same evidence (`placesEvidence`, keyed by `placeKey`). A country with
 * two region slugs combines them as its light does. */
export function rowEvidence(place: Pick<ListPlace, "routes">, evidence: ReadonlyMap<string, PlaceEvidence>): PlaceEvidence {
  const keys = [...new Set(place.routes.map((route) => placeKey(route)))];
  return combineEvidence(keys.map((key) => evidence.get(key)).filter((e): e is PlaceEvidence => e !== undefined));
}

/** The protocols the timing test can reach only with a ping: a TCP connect
 * cannot complete against a UDP port (`measure_latency`, src-tauri/src/vpn.rs). */
export function udpOnly(route: Pick<RouteOption, "protocol" | "transport">): boolean {
  if (route.protocol === "WIREGUARD" || route.protocol === "IKEV2") return true;
  return route.protocol === "OPENVPN" && route.transport?.toUpperCase() !== "TCP";
}

/** The best figure the timing test got for a place, or null: the entry's
 * connect time, never the whole path. */
export function bestLatency(place: Pick<ListPlace, "routes">, latencies: Readonly<Record<string, number | null>>): number | null {
  let best: number | null = null;
  for (const route of place.routes) {
    const ms = latencies[route.id];
    if (typeof ms === "number" && (best === null || ms < best)) best = ms;
  }
  return best;
}
