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
 *    ladder's verdict was "connected" -- traffic verified. An "unverified"
 *    landing is recorded as a failure, because it proved nothing;
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
 * `down` is a hollow ring: offline, or the fresh evidence failed.
 * `idle` is a steady dim dot: listed, nothing known either way. */
export type LampLook = "live" | "down" | "idle";

/** Whose evidence: this device's (`own`, `failed`), other people's on this
 * network (`isp`, `ispFail`), the control plane's (`offline`), or none. */
export type LampWhy = "own" | "isp" | "failed" | "ispFail" | "offline" | "none";

export interface PlaceEvidence {
  look: LampLook;
  why: LampWhy;
  /** The protocol the evidence is about, for the words beside it. */
  protocol?: Protocol;
  /** When this device's attempt was, for `own` and `failed`. */
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

/** What one place in the list -- every route to it -- can truthfully claim.
 *
 * Precedence: offline first; then this device's own evidence, which beats
 * other people's for the same protocol; and any "worked" wins over any
 * "failed", because it says a way in exists. */
export function placeEvidence(routes: readonly EvidenceRoute[], { history, network, now }: EvidenceContext): PlaceEvidence {
  if (routes.length === 0) return NOTHING;
  // The control plane says no route here is up. A route it reports down is
  // no way in now, whatever it did earlier.
  const online = routes.filter((route) => route.nodeStatus === "ONLINE");
  if (online.length === 0) return { look: "down", why: "offline" };

  let ownOk: { protocol: Protocol; at: number } | null = null;
  let ownFail: { protocol: Protocol; at: number } | null = null;
  const ownProtocols = new Set<Protocol>();
  if (network !== null) {
    for (const route of online) {
      const attempt = latestAttempt(history, network, route.id, route.protocol);
      if (!attempt || !fresh(attempt.at, now)) continue;
      ownProtocols.add(route.protocol);
      if (attempt.ok) {
        if (!ownOk || attempt.at > ownOk.at) ownOk = { protocol: route.protocol, at: attempt.at };
      } else if (!ownFail || attempt.at > ownFail.at) {
        ownFail = { protocol: route.protocol, at: attempt.at };
      }
    }
  }
  if (ownOk) return { look: "live", why: "own", protocol: ownOk.protocol, at: ownOk.at };

  // Other people's reports, only for a protocol this device has no fresh
  // word of its own about.
  let ispOk: Protocol | null = null;
  let ispFail: Protocol | null = null;
  for (const route of online) {
    if (ownProtocols.has(route.protocol)) continue;
    const code = route.ispTag?.code;
    if (code === "worksOnYourIsp" && ispOk === null) ispOk = route.protocol;
    else if (code === "failingOnYourIsp" && ispFail === null) ispFail = route.protocol;
  }
  if (ispOk !== null) return { look: "live", why: "isp", protocol: ispOk };
  if (ownFail) return { look: "down", why: "failed", protocol: ownFail.protocol, at: ownFail.at };
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
   * as the status chip's colour does, and never for an unconfirmed one. */
  verified: Placed | null;
  /** The calm tone the screen wears (`data-shown`), never the raw state. */
  tone: ShownTone;
  /** The route the screen names: the pin while nothing is up, the route
   * the tunnel settled on once one is. For the dashed relay arc. */
  shown: Placed | null;
  /** Countries the map can draw; by default the generated anchors. */
  drawable?: (cc: string) => boolean;
}

const ANCHORS: Record<string, { x: number; y: number }> = geo.anchors;
const anchored = (cc: string) => Object.prototype.hasOwnProperty.call(ANCHORS, cc);

const RANK: Record<LampLook, number> = { live: 3, down: 2, idle: 1 };
const isOwn = (why: LampWhy) => why === "own" || why === "failed";

/** The country a place's light stands on. Direct places light their own
 * country; every relay lights its entry, Iran -- "Iran → Germany worked"
 * says nothing about Germany's direct routes, which are a different place. */
function lightCountry(route: Placed): string | null {
  return countryCode(route.location.region);
}

/** Where a route's traffic leaves: the relay's exit country, or the
 * route's own. */
function exitCountry(route: Placed): string | null {
  const { entry, exit } = routePlace(route);
  return countryCode(exit ?? entry);
}

/** One light per country, the connected light, and the relay arc. */
export function mapLights(input: MapLightsInput): MapScene {
  const drawable = input.drawable ?? anchored;
  const ctx: EvidenceContext = { history: input.history, network: input.network, now: input.now };

  // Routes to one place together, by the same key the list groups on.
  const places = new Map<string, RouteOption[]>();
  for (const route of input.routes) {
    const key = placeKey(route);
    const group = places.get(key);
    if (group) group.push(route);
    else places.set(key, [route]);
  }

  // One light per country: its best place -- twinkling over hollow over
  // steady, and this device's own evidence over other people's.
  const byCountry = new Map<string, MapLight>();
  for (const group of places.values()) {
    const cc = lightCountry(group[0]);
    if (!cc || !drawable(cc)) continue;
    const evidence = placeEvidence(group, ctx);
    const current = byCountry.get(cc);
    const better =
      !current ||
      RANK[evidence.look] > RANK[current.look] ||
      (evidence.look === current.look && isOwn(evidence.why) && !isOwn(current.why));
    if (better) byCountry.set(cc, { cc, ...evidence, listed: true, exit: false, anim: false });
  }

  // The connected light: only under the verified look.
  let arc: MapArc | null = null;
  const verified = verifiedTone(input.tone) ? input.verified : null;
  const exitCc = verified ? exitCountry(verified) : null;
  if (verified && exitCc && drawable(exitCc)) {
    const light = byCountry.get(exitCc);
    if (light) light.exit = true;
    else byCountry.set(exitCc, { cc: exitCc, look: "idle", why: "none", listed: false, exit: true, anim: false });
    const entry = verified.isRelay ? lightCountry(verified) : null;
    if (entry && entry !== exitCc && drawable(entry)) arc = { from: entry, to: exitCc, solid: true };
  }
  // A relay picked, or up and not yet verified: a quiet dashed arc.
  if (!arc && input.shown?.isRelay) {
    const entry = lightCountry(input.shown);
    const to = exitCountry(input.shown);
    if (entry && to && entry !== to && drawable(entry) && drawable(to)) arc = { from: entry, to, solid: false };
  }

  const lights = [...byCountry.values()];
  // The budget of moving lights goes to the most reliable evidence first:
  // the connected place, then this device's own, then others' reports.
  const priority = (light: MapLight) => (light.exit ? 0 : light.why === "own" ? 1 : 2);
  const movers = lights.filter((light) => light.exit || light.look === "live").sort((a, b) => priority(a) - priority(b));
  for (const light of movers.slice(0, LAMP_MAX_ANIM)) light.anim = true;
  return { lights, arc };
}
