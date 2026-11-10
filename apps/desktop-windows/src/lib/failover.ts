import { failedLately, scoreFor, speedFor, type ConnectHistory } from "./connect-history";
import { reachabilityKey, reachabilityOf, type ReachabilityMap } from "./reachability";
import type { IspHint, IspTag, Protocol, ProtocolUser } from "./types";

export type IspTagCode = IspTag["code"];

/** What the server says of a route's server and protocol on a network,
 * per route (`RouteOption.ispHint`), without the network's name. */
export type IspRouteHint = Pick<IspHint, "server" | "protocol">;

type TaggedRoute = { id: string; ispTag?: IspTag | null; ispHint?: IspHint | null };

/** Whether a route list's word on other people's experience may be read
 * on the network this device is on.
 *
 * The list is asked for when the screen loads and held from then on; the
 * network is read again before each connect on the phone, and may by
 * then be another. A list from a server that names the network it
 * describes (`ispHint.asn`) is not read on a network known to be a
 * different one. Where either side cannot say -- an older server, or a
 * device the server could not place -- it is read, as it always was. */
function describesThisNetwork(routes: ReadonlyArray<TaggedRoute>, asn: number | null | undefined): boolean {
  if (asn === null || asn === undefined) return true;
  return routes.every((route) => typeof route.ispHint?.asn !== "number" || route.ispHint.asn === asn);
}

/** The route list's tags, in the shape `orderCandidates` takes. With
 * `asn` -- the network this device is on, where it knows -- none from a
 * list that describes another network. */
export function ispTagsOf(routes: ReadonlyArray<TaggedRoute>, asn?: number | null): Record<string, IspTagCode> {
  const tags: Record<string, IspTagCode> = {};
  if (!describesThisNetwork(routes, asn)) return tags;
  for (const route of routes) if (route.ispTag) tags[route.id] = route.ispTag.code;
  return tags;
}

/** The route list's hints, in the shape `orderCandidates` takes: only
 * the routes there is something to say about, and none from a list that
 * describes another network than `asn`. Empty from a server that sends
 * none, and the order is then what it was before they existed. */
export function ispHintsOf(routes: ReadonlyArray<TaggedRoute>, asn?: number | null): Record<string, IspRouteHint> {
  const hints: Record<string, IspRouteHint> = {};
  if (!describesThisNetwork(routes, asn)) return hints;
  for (const route of routes) {
    const hint = route.ispHint;
    if (!hint || typeof hint !== "object") continue;
    const server = hint.server === "works" || hint.server === "fails" ? hint.server : undefined;
    const protocol = hint.protocol === "lands" || hint.protocol === "fails" ? hint.protocol : undefined;
    if (server || protocol) hints[route.id] = { ...(server ? { server } : {}), ...(protocol ? { protocol } : {}) };
  }
  return hints;
}

/** Order to try protocols in when nothing better is known -- neither
 * from this device nor, for the network it is on, from anyone else
 * (`rank` in `orderCandidates`).
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
  // After the certificate-presenting transports, before OpenVPN. It is
  // fast and has no TLS handshake to fingerprint, but equally nothing to
  // hide behind: a censor who finds the port blocks it outright, where a
  // TLS-shaped transport has to be distinguished from real web traffic
  // first. So it is the answer when the disguises have failed, not
  // before they have been tried.
  "SHADOWSOCKS",
  "OPENVPN",
  // Last, despite being the fastest to establish of any of these. Its
  // ports are fixed at UDP 500 and 4500 -- it cannot be moved to a port
  // nobody is watching the way the others can -- which makes it the
  // first thing a filtering network drops, and a blocked attempt costs
  // a full timeout because Windows dials it rather than us. It exists
  // for the customers whose device or network will carry nothing else,
  // and those customers pin it in the server list, which is tried ahead
  // of this order entirely.
  "IKEV2",
];

/** A protocol's place in the fixed order. */
function fixedRank(protocol: Protocol): number {
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
 * Everything else follows by what is known of it, in three layers, each
 * read only where the one before says nothing: this device's own results
 * on this network; other people's on the same network, as the server
 * counts them (`ispTags` for a route, `ispHints` for its server and its
 * protocol); and PROTOCOL_ORDER. Among servers nothing above tells apart,
 * a slow answer to the probe goes later, and then each install's own
 * order (`seed`) decides.
 *
 * That last tie-break used to be the route's id, alphabetically -- the
 * same for everybody, and stable, which is all it was meant to be. But a
 * route's id is random, and on any network a device had no history for,
 * it put the UK first for every customer, because the UK's id happened to
 * sort first: 24 connects by 11 customers in October 2026 began there,
 * and on a network that holds the UK's upload to a trickle, settled
 * there. Per install it is still stable -- a failure reproduces on the
 * device it happened on -- and new customers are spread across servers
 * instead of all starting on one.
 */
export function orderCandidates(
  users: ProtocolUser[],
  opts: {
    /** The route a tunnel was on when it dropped, for an automatic
     * reconnect (`auto-reconnect.ts`): tried first, ahead even of the
     * pin. It is where the last ladder pass -- which already honoured
     * the pin -- actually landed, so it is the best evidence there is of
     * what works here right now. Everything else follows in the order it
     * always would. */
    resumeRouteId?: string | null;
    pinnedRouteId?: string | null;
    lastGoodRouteId?: string | null;
    preferredRouteId?: string | null;
    /** What this device has seen work lately, if anything. */
    history?: ConnectHistory;
    network?: string | null;
    now?: number;
    /** What answered a handshake just now, for the ones that could be
     * asked. */
    reachability?: ReachabilityMap;
    /** What other people on this network recently saw, per route (the
     * route list's `ispTag` codes). Consulted only for a route this
     * device has no evidence of its own for here -- see `fromOthers`. */
    ispTags?: Record<string, IspTagCode | undefined>;
    /** What other people on this network -- or, where too few of them,
     * in its country -- saw of each route's server and of its protocol
     * (`ispHintsOf`). Coarser than a tag and far more often there. See
     * `fromOthers` and `rank`. */
    ispHints?: Record<string, IspRouteHint | undefined>;
    /** The subscription in use: its credentials are dialled ahead of any
     * other subscription's the account still lists. */
    subscriptionId?: string | null;
    /** Other routes that leave from the pinned route's country, tried
     * right after it. To a customer a pin is a country: one who picked
     * France and whose France server failed went next to whatever sorted
     * first -- the UK -- while a backup route to France sat further down. */
    pinnedCountryRouteIds?: ReadonlyArray<string>;
    /** How long each probed candidate took to answer, keyed as
     * `reachability` is (`probeCandidates`). */
    replyMs?: Record<string, number>;
    /** This install's own order for servers nothing else tells apart
     * (`installSeed`). Absent, the route's id decides, as it used to. */
    seed?: string | null;
  } = {},
): ProtocolUser[] {
  const {
    subscriptionId,
    resumeRouteId,
    pinnedRouteId,
    lastGoodRouteId,
    preferredRouteId,
    history,
    network,
    now,
    reachability,
    ispTags,
    ispHints,
    pinnedCountryRouteIds,
    replyMs,
    seed,
  } = opts;

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
  // What the server says of the credential itself, ahead of everything
  // else: one it has switched off -- an expired or suspended plan's, which
  // the API still lists beside the plan bought after it, for the very same
  // routes -- after every one it has not, and another subscription's after
  // the one in use. Never dropped (a protocol is never taken off the
  // ladder), only last. On the VM the expired plan's credential for the
  // route on screen was listed first, dialled first and refused by the node
  // on every connect and reconnect: ten seconds each, and that route
  // recorded as failing on this network (round 3).
  const standing = (u: ProtocolUser): number =>
    (u.status === "DISABLED" ? 2 : 0) + (subscriptionId && u.subscriptionId !== subscriptionId ? 1 : 0);

  // Whether every probed protocol of a route refused the probe just now.
  // A route with nothing probed -- UDP only -- has not refused anything.
  const refused = (routeId: string): boolean => {
    const asked = users
      .filter((u) => u.routeId === routeId)
      .map((u) => reachabilityOf(reachability, u.routeId, u.protocol))
      .filter((answer) => answer !== "unknown");
    return asked.length > 0 && asked.every((answer) => answer === "unreachable");
  };
  // How fast each combination went the last time it was measured here
  // (`speedFor`), in bands a factor of two wide: one short check is a
  // rough figure, and finer bands would swap two servers back and forth
  // on noise.
  const speed = (u: ProtocolUser): number | null =>
    history ? speedFor(history, network ?? null, u.routeId, u.protocol, now) : null;
  const band = (kbps: number): number => Math.floor(Math.log2(Math.max(kbps, 1)));
  const bySpeed = (a: ProtocolUser, b: ProtocolUser): number => {
    const [x, y] = [speed(a), speed(b)];
    return x === null || y === null ? 0 : band(y) - band(x);
  };
  const fastestOn = (routeId: string): number | null => {
    const known = users
      .filter((u) => u.routeId === routeId)
      .map(speed)
      .filter((kbps): kbps is number => kbps !== null);
    return known.length > 0 ? Math.max(...known) : null;
  };

  // What worked here last time leads only while it still answers. A
  // server that has since been cut off kept leading every connect on that
  // network, each one paying for its failure before reaching anything
  // that worked. Nor once another server has been measured here at more
  // than twice its speed, and has been working: the customer asked for
  // the fastest that works, not the first that did.
  const lastGoodSpeed = lastGoodRouteId ? fastestOn(lastGoodRouteId) : null;
  const outpaced =
    lastGoodSpeed !== null &&
    users.some((u) => {
      if (u.routeId === lastGoodRouteId) return false;
      const kbps = speed(u);
      const score = history ? scoreFor(history, network ?? null, u.routeId, u.protocol, now) : null;
      return kbps !== null && kbps > 2 * lastGoodSpeed && score !== null && score >= 0.5;
    });
  const lastGoodLeads = Boolean(lastGoodRouteId) && !refused(lastGoodRouteId as string) && !outpaced;
  const pinnedCountry = new Set(pinnedRouteId ? (pinnedCountryRouteIds ?? []) : []);

  // In two steps, with `failedHere` between them: where a dropped tunnel
  // was and what the customer chose lead whatever is remembered of them;
  // what the app itself would lead with does not lead with a rung that
  // has only failed here lately.
  const chosen = (u: ProtocolUser): number => {
    if (resumeRouteId && u.routeId === resumeRouteId) return -3;
    if (pinnedRouteId && u.routeId === pinnedRouteId) return -2;
    if (pinnedCountry.has(u.routeId)) return -1;
    return 0;
  };
  const remembered = (u: ProtocolUser): number => {
    if (chosen(u) !== 0) return 0;
    if (lastGoodLeads && u.routeId === lastGoodRouteId) return -2;
    if (preferredRouteId && u.routeId === preferredRouteId) return -1;
    return 0;
  };

  // A rung that has only failed on this network in the last few hours --
  // came up and carried nothing, or did not connect -- after everything
  // else (`failedLately`). Order only: blocks change, so it is still
  // dialled, last. Never one that carried traffic here within the day: a
  // failure or two since does not send the customer's usual rung behind
  // the whole ladder, and it leads or not as it did before this.
  //
  // `byEvidence` below already put a failing rung after an untried one,
  // but only among rungs the probe and the last-good route had not
  // already told apart. The rungs that cost the most are the ones that
  // come up and carry nothing, and their port answers the probe: on a
  // home network in November 2026 where two servers of seven carried
  // data, a pass walked the other five's rungs at 25-30 s each, every
  // time. Behind the customer's own choice, as everything remembered is:
  // within the chosen location its failed rungs go after its others, and
  // the location still leads.
  const failedHere = (u: ProtocolUser): number =>
    history && failedLately(history, network ?? null, u.routeId, u.protocol, now) ? 1 : 0;

  // A WebSocket-carried credential sorts after its TCP sibling: the
  // extra framing costs a little speed, and its advantage -- surviving a
  // CDN, looking like ordinary web traffic -- only matters once the
  // plainer variant has failed. Same protocol, so nothing above
  // separates them.
  const wsLast = (u: ProtocolUser) => (u.connection?.transport === "WS" ? 1 : 0);

  // Measured evidence, ahead of the fixed order and behind the
  // customer's own choice.
  //
  // `PROTOCOL_ORDER` is one list for everybody, and for Iran it cannot
  // be right: filtering differs between two subscribers on the same ISP
  // and changes from one day to the next, so an order derived from
  // anyone else's experience -- or from last week's -- is a guess. What
  // this device saw in the last few hours is not.
  //
  // Only combinations with evidence are moved. `scoreFor` returns null
  // when nothing is known, and those keep their place in the fixed
  // order rather than being sorted against a number they do not have;
  // an untried protocol must not outrank one that has been working.
  const evidence = (u: ProtocolUser): number | null =>
    history ? scoreFor(history, network ?? null, u.routeId, u.protocol, now) : null;

  const byEvidence = (a: ProtocolUser, b: ProtocolUser): number => {
    const [x, y] = [evidence(a), evidence(b)];
    if (x === null && y === null) return 0;
    // Something known to work leads something unknown; something known
    // to fail follows it. The midpoint is where "no idea" sits.
    const place = (v: number | null) => (v === null ? 0.5 : v);
    return place(y) - place(x);
  };

  // What answered a moment ago, ahead of what worked yesterday.
  //
  // Live beats remembered: a protocol that has just refused a handshake
  // is not going to carry a tunnel, however well it did this morning,
  // and filtering in Iran changes within a day. Only three states, and
  // the middle one is load-bearing -- a candidate that could not be
  // probed, because it is UDP, must sit exactly where an unknown sits
  // rather than below something that failed. Burying WireGuard for not
  // being TCP would take away the one option some customers have.
  const liveness = (u: ProtocolUser): number => {
    switch (reachabilityOf(reachability, u.routeId, u.protocol)) {
      case "reachable":
        return -1;
      case "unreachable":
        return 1;
      default:
        return 0;
    }
  };

  // Other people's experience, for the rungs this device has none of its
  // own for.
  //
  // ac56993 refused to order by anyone else's data, and for a rung this
  // device has tried on this network that still holds without exception:
  // filtering differs between two people on one ISP and from day to day,
  // so its own results are the better guide, and for that rung they alone
  // decide (`byEvidence`, ahead of this; this returns 0 for it).
  //
  // What it left open is every rung the device has not tried -- all of
  // them on a first run or a new network, which is the case people quit
  // over, and most of them on any network: a pass stops at the first rung
  // that works, so a device that knows one working rung here knows
  // nothing of the others it will walk the day that one is cut off. Those
  // used to fall to `PROTOCOL_ORDER`, one list for the whole world, the
  // moment the device knew anything at all here. Now each is placed by
  // the finest thing other people on this network have shown of it:
  //
  // - the route itself, where enough of them tried that very route (the
  //   tag the server list shows);
  // - else its server, which far more of them tried on one protocol or
  //   another. Which server carries traffic on a network goes by the
  //   server's address and the network, not by the protocol: on a filtered
  //   network in November 2026 two servers of seven carried data, and a
  //   rung on any of the other five came up and carried nothing, at 25-30
  //   s each on a phone;
  // - and its protocol, where the network drops that protocol even on
  //   servers that work there (`rank` below orders by the same word).
  //
  // Shown to fail goes after everything not shown to, whichever of the
  // three said so: a rung on a server that carries nothing here will not
  // carry, and neither will a protocol the network drops, on any server.
  // Among those, a failing protocol on a working server is still the
  // likelier. Shown to work goes first, the route's own word ahead of its
  // server's. Order only, as everything here is: every rung is dialled.
  //
  // A working server's lead is ahead of how quickly it answered the probe
  // and of this install's own order (`late`, `shuffled`). Where some
  // servers carry nothing that is the point of it. Where they all carry
  // it would be wrong -- every new device would start on whichever
  // servers earlier customers happened to use, and the spread the seed
  // exists for would be gone -- so the server says "works" only on a
  // network where something is shown not to get through (isp-order.ts in
  // the backend). On any other it says nothing of servers, and this is 0
  // for all of them.
  //
  // Below everything the device itself knows (a pin, a last-good, the
  // live probe, its own history and speeds) and above the fixed order.
  // With nothing from the server -- an older one, or a network it could
  // not place -- this is 0 for everyone.
  const fromOthers = (u: ProtocolUser): number => {
    if (evidence(u) !== null) return 0;
    const tag = ispTags?.[u.routeId];
    if (tag === "worksOnYourIsp") return -2;
    if (tag === "failingOnYourIsp") return 3;
    const hint = ispHints?.[u.routeId];
    if (hint?.server === "fails") return 3;
    if (hint?.protocol === "fails") return hint.server === "works" ? 1 : 2;
    return hint?.server === "works" ? -1 : 0;
  };

  // The protocol order for this network, where other people's dials on
  // it say what it is, and the fixed one where they do not.
  //
  // `PROTOCOL_ORDER` is speed first, which is right where nothing is
  // filtered and wrong where something is: on filtered networks, of dials
  // on servers that worked there (seven days to 2026-11-10), its first
  // entry landed once in 14 and its second 161 times in 180. Which
  // protocols a network lets through is that network's own, and changes;
  // so it is not written down here. The server counts it, per network,
  // only on servers that work there -- so a blocked server does not drag
  // every protocol down -- and says of each protocol one of three things:
  // it lands, it does not, or too few people tried it to say. Proven to
  // land first, proven not to last, the unknown between them, and the
  // fixed order within each: among protocols that all get through, the
  // fastest is still the one to start with.
  const rank = (u: ProtocolUser): number => {
    const fixed = fixedRank(u.protocol);
    // One this build does not know stays last, whatever is said of it.
    if (fixed === PROTOCOL_ORDER.length) return 3 * PROTOCOL_ORDER.length;
    const verdict = ispHints?.[u.routeId]?.protocol;
    const tier = verdict === "lands" ? 0 : verdict === "fails" ? 2 : 1;
    return tier * PROTOCOL_ORDER.length + fixed;
  };

  // A server that took much longer than the quickest to answer the probe
  // goes after the ones that answered about as fast. Coarse on purpose: a
  // few milliseconds say nothing about which server will carry more, and
  // ordering by them would put every customer on the nearest server --
  // in Iran, often the one held to a trickle. Unprobed is not late.
  const replies = Object.values(replyMs ?? {});
  const quickest = replies.length > 0 ? Math.min(...replies) : null;
  const late = (u: ProtocolUser): number => {
    const ms = replyMs?.[reachabilityKey(u.routeId, u.protocol)];
    return quickest !== null && ms !== undefined && ms > quickest * 1.5 + 100 ? 1 : 0;
  };
  const shuffled = (routeId: string): number => (seed ? hash(`${seed}|${routeId}`) : 0);

  return [...users].sort(
    (a, b) =>
      standing(a) - standing(b) ||
      chosen(a) - chosen(b) ||
      failedHere(a) - failedHere(b) ||
      remembered(a) - remembered(b) ||
      liveness(a) - liveness(b) ||
      byEvidence(a, b) ||
      bySpeed(a, b) ||
      fromOthers(a) - fromOthers(b) ||
      rank(a) - rank(b) ||
      wsLast(a) - wsLast(b) ||
      late(a) - late(b) ||
      shuffled(a.routeId) - shuffled(b.routeId) ||
      a.routeId.localeCompare(b.routeId),
  );
}

/** FNV-1a, 32 bits: an order for routes that is the same every time for
 * one install and different between installs. Not for anything secret. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const SEED_KEY = "failover.seed";

/** This install's seed for `orderCandidates`, made once and kept. Null
 * where storage cannot be used, which leaves the old order. */
export function installSeed(): string | null {
  try {
    const kept = localStorage.getItem(SEED_KEY);
    if (kept) return kept;
    const made =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SEED_KEY, made);
    return made;
  } catch {
    return null;
  }
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
