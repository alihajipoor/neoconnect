import { HALF_LIFE_MS, latestAttempt, type ConnectHistory } from "./connect-history";
import type { ShownTone } from "./hero-model";
import geo from "./map-geo.json";
import { countryCode, placeKey, routePlace } from "./route-place";
import type { Protocol, RouteOption } from "./types";

/** What each light on the main page's world map may say (design-system.md
 * section 5.3; owner decision, 2026-10-19: "blinking only when there is a
 * real reason to say that location works").
 *
 * Everything is judged on the network the device is on now, from evidence
 * the app really holds:
 *
 *  - this device's own attempts (`connect-history`), where `ok` means the
 *    ladder's verdict was "connected" -- traffic verified. Only the
 *    successes are evidence here. The desktop records a rung only when it
 *    lands, so its `ok: false` is a tunnel that came up and could not be
 *    confirmed -- Custom mode, an egress check the network filters -- and
 *    that proves nothing either way: it may well have been carrying
 *    traffic. It is a failure for the ladder's ordering, which needs a
 *    reason to try something else first; it is never a reason to draw a
 *    place as failing;
 *  - the per-network tags the server sends with the route list
 *    (`worksOnYourIsp`, `failingOnYourIsp`), about at least five other
 *    people on this device's network;
 *  - the control plane's `nodeStatus`.
 *
 * A latency number never lights anything, either way. An answer proves
 * only that an entry host completed a handshake or answered a ping: from
 * Iran on 2026-10-15, two exits completed handshakes while every upload to
 * them was blackholed, so a latency-lit light would have said "working"
 * for exactly the routes that were not. And a test with no answer is not
 * "down": networks drop pings, and UDP ports can only be pinged.
 *
 * Pure, so the rules can be pinned without a screen. */

/** Evidence older than this lights nothing: two half-lives of the connect
 * history, so a day-old success no longer describes this network. */
export const LAMP_FRESH_MS = 2 * HALF_LIFE_MS;

/** At most this many lights move at once; the rest hold still. */
export const LAMP_MAX_ANIM = 10;

/** `live` twinkles: a way into this place carried traffic here lately.
 * `down` is a hollow ring: the control plane reports it offline, or it has
 * been failing for most people on this network lately.
 * `idle` is a steady dim dot: listed, nothing known either way. */
export type LampLook = "live" | "down" | "idle";

/** Whose evidence: this device's (`own`), other people's on this network
 * (`isp`, `ispFail`), the control plane's (`offline`), or none. */
export type LampWhy = "own" | "isp" | "ispFail" | "offline" | "none";

export interface PlaceEvidence {
  look: LampLook;
  why: LampWhy;
  /** The protocol the evidence is about, for the words beside it. */
  protocol?: Protocol;
  /** When this device's verified connect was, for `own`. */
  at?: number;
}

type EvidenceRoute = Pick<RouteOption, "id" | "protocol" | "nodeStatus" | "ispTag">;

export interface EvidenceContext {
  history: ConnectHistory;
  /** This network's id; `null` when it is not known, and then this
   * device's own history is not read at all -- its shared "unknown"
   * bucket may describe another network. */
  network: string | null;
  now: number;
}

const NOTHING: PlaceEvidence = { look: "idle", why: "none" };

function fresh(at: number, now: number): boolean {
  // A future stamp (a clock that moved) is as fresh as now, no fresher.
  return Math.max(0, now - at) < LAMP_FRESH_MS;
}

/** When this route last carried traffic from this device on this network:
 * its newest attempt, if that is fresh and verified. Null for no attempt,
 * an old one, an unknown network, or a newest attempt that proved nothing
 * -- the newest decides, so a success followed by an unconfirmed landing
 * is no longer a success to show, and no failure either. */
export function ownWorkedAt(route: Pick<RouteOption, "id" | "protocol">, { history, network, now }: EvidenceContext): number | null {
  if (network === null) return null;
  const attempt = latestAttempt(history, network, route.id, route.protocol);
  if (!attempt || !attempt.ok || !fresh(attempt.at, now)) return null;
  return attempt.at;
}

/** What one place in the list -- every route to it -- can truthfully claim.
 *
 * Precedence: offline first; then this device's own verified connects;
 * then other people's reports, where any "worked" wins over any "failed",
 * because it says a way in exists. This device's unconfirmed landings
 * count for nothing either way (see above). */
export function placeEvidence(routes: readonly EvidenceRoute[], ctx: EvidenceContext): PlaceEvidence {
  if (routes.length === 0) return NOTHING;
  // The control plane says no route here is up. A route it reports down is
  // no way in now, whatever it did earlier.
  const online = routes.filter((route) => route.nodeStatus === "ONLINE");
  if (online.length === 0) return { look: "down", why: "offline" };

  let ownOk: { protocol: Protocol; at: number } | null = null;
  for (const route of online) {
    const at = ownWorkedAt(route, ctx);
    if (at !== null && (!ownOk || at > ownOk.at)) ownOk = { protocol: route.protocol, at };
  }
  if (ownOk) return { look: "live", why: "own", protocol: ownOk.protocol, at: ownOk.at };

  // Other people's reports from this network.
  let ispOk: Protocol | null = null;
  let ispFail: Protocol | null = null;
  for (const route of online) {
    const code = route.ispTag?.code;
    if (code === "worksOnYourIsp" && ispOk === null) ispOk = route.protocol;
    else if (code === "failingOnYourIsp" && ispFail === null) ispFail = route.protocol;
  }
  if (ispOk !== null) return { look: "live", why: "isp", protocol: ispOk };
  if (ispFail !== null) return { look: "down", why: "ispFail", protocol: ispFail };
  return NOTHING;
}

/** Whether the screen wears the verified look: the only tones under which
 * the connected place is drawn. `hl` -- "Connected, not confirmed" -- is
 * not one of them. */
export function verifiedTone(tone: ShownTone): boolean {
  return tone === "ok" || tone === "caution";
}

type Placed = Pick<RouteOption, "isRelay" | "location" | "exitLocation">;

export interface MapLight extends PlaceEvidence {
  /** The country the light stands on (a display city, never a node). */
  cc: string;
  /** In the list. False only for a relay's exit country drawn for the
   * connected light alone. */
  listed: boolean;
  /** Where the verified tunnel leaves: the large light with a halo. */
  exit: boolean;
  /** Within the budget of lights that move. */
  anim: boolean;
}

export interface MapArc {
  from: string;
  to: string;
  /** Solid once the tunnel on it is verified; dashed while it is only
   * picked, or up and not yet verified. */
  solid: boolean;
}

export interface MapScene {
  lights: MapLight[];
  arc: MapArc | null;
}

export interface MapLightsInput extends EvidenceContext {
  routes: readonly RouteOption[];
  /** The route the tunnel was on when traffic was last verified, in this
   * session; null when there is none, and in gaming mode. Drawn only while
   * `tone` is the verified look, so it holds through a brief gap exactly
   * as the status chip's colour does, and never for an unconfirmed one.
   * The caller passes null once the tunnel has settled on another route. */
  verified: Placed | null;
  /** The calm tone the screen wears (`data-shown`), never the raw state. */
  tone: ShownTone;
  /** The route the screen names: the pin while nothing is up, the route
   * the tunnel settled on once one is. For the dashed relay arc. */
  shown: Placed | null;
  /** The route a tunnel is up on now, verified or not; null when none is.
   * Its place is never drawn hollow: the customer is on it, and a hollow
   * ring there would read as "your connection failed". */
  up?: Placed | null;
  /** Countries the map can draw; by default the generated anchors. */
  drawable?: (cc: string) => boolean;
}

const ANCHORS: Record<string, { x: number; y: number }> = geo.anchors;
const anchored = (cc: string) => Object.prototype.hasOwnProperty.call(ANCHORS, cc);

/** The country a place's light stands on. Direct places light their own
 * country; every relay lights its entry, Iran -- "Iran → Germany worked"
 * says nothing about Germany's direct routes, which are a different place. */
function lightCountry(route: Placed): string | null {
  return countryCode(route.location.region);
}

/** Where a route's traffic leaves: the relay's exit country, or a direct
 * route's own. Null for a relay whose exit the backend does not name: its
 * traffic does not leave from Iran, and where it does is not known. */
function exitCountry(route: Placed): string | null {
  const { entry, exit } = routePlace(route);
  if (route.isRelay) return exit ? countryCode(exit) : null;
  return countryCode(entry);
}

/** One country's light from its places' evidence: twinkling when any place
 * there worked (this device's own word first), hollow only when every
 * place there is offline or failing -- one place down says nothing about
 * the others, which may simply be untried -- and otherwise a steady dot. */
function countryLight(cc: string, evidence: readonly PlaceEvidence[]): MapLight {
  return { cc, listed: true, exit: false, anim: false, ...combineEvidence(evidence) };
}

/** What several places say together -- a country's light, and the list's
 * row for that country: live when any of them worked (this device's own,
 * newest, first), down only when every one is down, otherwise nothing
 * either way. */
export function combineEvidence(evidence: readonly PlaceEvidence[]): PlaceEvidence {
  const live = evidence.filter((e) => e.look === "live");
  if (live.length > 0) {
    const own = live.filter((e) => e.why === "own").sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    return own ?? live[0];
  }
  if (evidence.length > 0 && evidence.every((e) => e.look === "down")) return evidence[0];
  return NOTHING;
}

/** One light per country, the connected light, and the relay arc. */
export function mapLights(input: MapLightsInput): MapScene {
  const drawable = input.drawable ?? anchored;
  const ctx: EvidenceContext = { history: input.history, network: input.network, now: input.now };
  const upKey = input.up ? placeKey(input.up) : null;

  // Each place's evidence, by the same key the list groups on, gathered by
  // the country its light stands on.
  const byCountry = new Map<string, PlaceEvidence[]>();
  const order: string[] = [];
  const firstOf = new Map<string, RouteOption>();
  for (const route of input.routes) {
    const key = placeKey(route);
    if (!firstOf.has(key)) firstOf.set(key, route);
  }
  for (const [key, evidence] of placesEvidence(input.routes, ctx)) {
    const cc = lightCountry(firstOf.get(key)!);
    if (!cc || !drawable(cc)) continue;
    const shown = key === upKey && evidence.look === "down" ? NOTHING : evidence;
    const list = byCountry.get(cc);
    if (list) list.push(shown);
    else {
      byCountry.set(cc, [shown]);
      order.push(cc);
    }
  }
  const lights = new Map<string, MapLight>();
  for (const cc of order) lights.set(cc, countryLight(cc, byCountry.get(cc)!));

  // The connected light: only under the verified look.
  let arc: MapArc | null = null;
  const verified = verifiedTone(input.tone) ? input.verified : null;
  const exitCc = verified ? exitCountry(verified) : null;
  if (verified && exitCc && drawable(exitCc)) {
    const light = lights.get(exitCc);
    if (light) light.exit = true;
    else lights.set(exitCc, { cc: exitCc, look: "idle", why: "none", listed: false, exit: true, anim: false });
    const entry = verified.isRelay ? lightCountry(verified) : null;
    if (entry && entry !== exitCc && drawable(entry)) arc = { from: entry, to: exitCc, solid: true };
  }
  // A relay picked, or up and not yet verified: a quiet dashed arc.
  if (!arc && input.shown?.isRelay) {
    const entry = lightCountry(input.shown);
    const to = exitCountry(input.shown);
    if (entry && to && entry !== to && drawable(entry) && drawable(to)) arc = { from: entry, to, solid: false };
  }

  const all = [...lights.values()];
  // The budget of moving lights goes to the most reliable evidence first:
  // the connected place, then this device's own, then others' reports.
  const priority = (light: MapLight) => (light.exit ? 0 : light.why === "own" ? 1 : 2);
  const movers = all.filter((light) => light.exit || light.look === "live").sort((a, b) => priority(a) - priority(b));
  for (const light of movers.slice(0, LAMP_MAX_ANIM)) light.anim = true;
  return { lights: all, arc };
}

/** Each place's evidence, keyed as the list groups places (`placeKey`):
 * what the map's lights are made of, and what the list's "Worked here"
 * filter reads, so the two cannot disagree. */
export function placesEvidence(routes: readonly RouteOption[], ctx: EvidenceContext): Map<string, PlaceEvidence> {
  const places = new Map<string, RouteOption[]>();
  for (const route of routes) {
    const key = placeKey(route);
    const group = places.get(key);
    if (group) group.push(route);
    else places.set(key, [route]);
  }
  const out = new Map<string, PlaceEvidence>();
  for (const [key, group] of places) out.set(key, placeEvidence(group, ctx));
  return out;
}

/** Every country this list can light or leave from, in list order: the
 * light's country of each place, and each relay's exit. The map fits its
 * box around these and keeps the ribbon clear of them, so the placement
 * follows the route list alone and nothing moves on a connect. */
export function mapCountries(routes: readonly Placed[], drawable: (cc: string) => boolean = anchored): string[] {
  const out = new Set<string>();
  for (const route of routes) {
    for (const cc of [lightCountry(route), exitCountry(route)]) if (cc && drawable(cc)) out.add(cc);
  }
  return [...out];
}
