import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { apiEndpoints } from "./api-endpoints";
import { isKnownBlockPage } from "./endpoint-bundle-store";
import { clearDemotion, demotedLast, isDemoted, isNameDemoted } from "./endpoint-demotion";
import { rememberNetwork } from "./network-identity";
import { isAddressLiteral, resolveIpv4, RESOLVE_TIMEOUT_MS } from "./tunnel-server";

/** Proving a tunnel actually carries traffic, rather than merely existing.
 *
 * The obvious check -- "can I reach 8.8.8.8 / google.com after
 * connecting?" -- looks right and is not sufficient. It proves the
 * internet works, not that it works *through the VPN*. A tunnel that
 * came up but is carrying nothing leaves the normal route intact, so the
 * probe succeeds and the app reports success: precisely the false
 * "Connected" this exists to catch.
 *
 * Comparing the public IP before and after closes that hole. If the
 * world sees a different address afterwards, the packets provably left
 * via somewhere else. If it sees the same one, traffic is bypassing the
 * tunnel no matter how healthy the interface looks.
 *
 * That argument holds only while both readings came from the same
 * endpoint, which this file did not used to check. `/health/ip` reports
 * the last untrusted hop before the backend, and the node mirrors in the
 * fallback list report a different one from the CDN -- so two readings
 * taken through different endpoints can differ with nothing having
 * changed about the route. See `IpReading` and `verifyEgress`.
 *
 * It closes that hole for **IPv4 and nothing else**, which this file
 * used to claim was no hole at all. A machine leaking IPv6 alongside a
 * perfectly good IPv4 tunnel reads as "throughTunnel". That combination
 * was measured, on three of the four protocols tested. The IPv6 check at
 * the bottom of this file exists because of it.
 *
 * And the comparison is only IPv4 at all where something makes it so.
 * This file used to assume `/health/ip` was always reached over IPv4,
 * which holds for a reading taken through a node -- every node is
 * IPv4-only, and a full tunnel blocks IPv6 machine-wide -- and not for
 * the baseline: on a machine with native IPv6, an endpoint with an AAAA
 * record is reached over IPv6 first, so the baseline was the customer's
 * IPv6 address. Against that, any IPv4 reading differs, and the check
 * said "throughTunnel" whatever IPv4 was doing -- including going round
 * the tunnel in the clear. Two things now stop that: both clients ask
 * over IPv4 only (`setHealthIpTransport`, `health-ip-v4.ts`), and a pair
 * of different families is never compared (`verifyEgress`). The phones
 * got the first later than Windows, and the second alone was not enough
 * there: it turned the false "throughTunnel" into an "indeterminate" on
 * every rung of a dual-stack phone's connect, which the ladder rejects.
 *
 * And it holds only for a reading that went through the tunnel at all.
 * Where the client routes the tunnel's own server address around the
 * tunnel -- the host route that lets the tunnel reach its server -- a
 * node mirror on that address is asked over the customer's own line, and
 * answers with their home address through a tunnel that works. Measured
 * on 2026-10-06 on Windows, Stealth to finland1: every endpoint answered
 * the node's address except finland1's own mirror, which answered the
 * VM's home address. Not every engine does that; see `TunnelServer`.
 */

/** Short: this runs while the customer is watching a spinner, and a
 * server that will not answer quickly has already failed the check. */
export const EGRESS_TIMEOUT_MS = 6000;

/** One answer to "what address does the world see", together with who
 * gave it.
 *
 * The `from` half is not bookkeeping. `/health/ip` does not report the
 * caller's egress address; it reports **the last untrusted hop before
 * the backend**, and which hop that is depends on which endpoint
 * answered. Some nodes run an API mirror that proxies to the
 * Cloudflare-fronted panel, and Cloudflare then overwrites
 * `cf-connecting-ip` with the *node's* address -- so those mirrors
 * return the node's own IP, which is exactly what a working tunnel looks
 * like (HANDOVER-2026-08-22 §6 item 4; measured, turkey-1 answering
 * its own address -- shown here as `203.0.113.20`, an RFC 5737 stand-in;
 * node addresses are not committed, see docs/node-address-hygiene.md --
 * where finland1 answered the real client address).
 *
 * `publicIp` used to discard this, and the comparison at the heart of
 * the whole file was therefore between two numbers that were not
 * necessarily measuring the same thing. A baseline taken via the CDN and
 * an after-reading taken via a node mirror differ with no routing change
 * whatsoever -- a fabricated "throughTunnel" out of two honest answers
 * to two different questions.
 *
 * `peer` is the address the request actually connected to, where the
 * transport can say (the IPv4 transport both apps install does; the
 * plugin's fetch cannot). It is how an endpoint on the tunnel's own
 * server is recognised -- see `TunnelServer`.
 */
type IpReading = { ip: string; from: string; peer?: string };

/** Where a tunnel is dialled, and whether this client reaches that
 * address around the tunnel or through it: the connected route's
 * server, or -- for a baseline -- the server of the route about to be
 * dialled. `addresses` are literals; `tunnel-server.ts` builds one from
 * a credential, resolving any name the way the engines do, and decides
 * `reachedAround` per platform and engine.
 *
 * **Around** (`reachedAround: true`): the client installs a host route
 * for the server so the tunnel's own packets reach it without looping
 * back into the tunnel. A `/health/ip` request to an endpoint on that
 * address -- that node's own API mirror -- then never enters the tunnel,
 * and the mirror sees the customer's real address. Measured on
 * 2026-10-06 on Windows, through a working Stealth tunnel to finland1:
 * every endpoint answered finland1's address except finland1's own
 * mirror, which answered the VM's home address.
 *
 * Such an answer is no evidence about the tunnel at all, and both ways
 * it was used went wrong. Compared with a baseline from the same mirror
 * -- the last endpoint that worked leads the list, and in Iran, where
 * the panel hosts are blocked, that is often a mirror -- the home
 * address came back unchanged: `bypassingTunnel`, "Your traffic is NOT
 * protected" over a tunnel that works, a strike, and in time the
 * automatic ladder tearing it down. With the baseline from that mirror
 * and the reading from any other endpoint, it was `indeterminate`:
 * "Connected, not confirmed" where 0.9.44 said "You're protected".
 *
 * So an answer from such an address is passed over, as if the endpoint
 * had not answered, and the next one is asked: for a baseline (after
 * connecting, that endpoint can only be asked around the tunnel, so a
 * baseline from it can never be compared with anything), and for every
 * reading taken while connected.
 *
 * **Through** (`reachedAround: false`): the engine keeps only its own
 * sockets off the tunnel -- Android's VpnService `protect`, iOS's packet
 * tunnel, wireguard.exe binding its socket to the physical interface --
 * and everything else this app sends, to the server's address included,
 * goes into the tunnel. From reading the source, NOT measured; see
 * `tunnel-server.ts` for which engines are taken to be which. There the
 * server's own mirror is as good a witness as any other endpoint, and a
 * better one in Iran, where it may be the only one answering on the
 * bare line: before connecting it reports the home address, through a
 * direct tunnel the request reaches the node from inside it and the
 * node hands it on from its own address, and through a relay the exit's
 * address. Nothing is passed over. The one adjustment is to the
 * self-report rule in `readFrom`: an answer naming the very address it
 * was fetched from is normally a mirror describing itself, but from the
 * baseline's own endpoint on this server -- one whose baseline answer
 * named the caller, not itself -- it is the node relaying our request
 * from inside the tunnel, which is exactly the proof asked for.
 *
 * Which way is right matters in both directions. Passing over an
 * endpoint reached through the tunnel throws away the only proof some
 * customers have; trusting one reached around it accuses a working
 * tunnel. So where a platform's routing is not known, `tunnel-server.ts`
 * says "around": its cost is "not confirmed", never an accusation. */
export type TunnelServer = {
  readonly addresses: ReadonlySet<string> | readonly string[];
  readonly reachedAround: boolean;
};

/** Whether, with this server's tunnel up, the endpoint that gave this
 * reading is asked around the tunnel -- so a reading from it now says
 * nothing, and a baseline from it can never be compared with one. False
 * when either is not known (a reading whose transport could not say
 * where it connected, or no server given), and always for a server
 * reached through the tunnel. */
export function askedAroundTunnel(reading: IpReading | null, tunnelServer: TunnelServer | null | undefined): boolean {
  if (reading?.peer === undefined || !tunnelServer?.reachedAround) return false;
  return addressSet(tunnelServer.addresses).has(comparable(reading.peer));
}

/** The addresses answers are passed over from: the server's, where it is
 * reached around the tunnel, and none otherwise. */
function aroundSet(tunnelServer: TunnelServer | undefined): Set<string> | undefined {
  return tunnelServer?.reachedAround ? addressSet(tunnelServer.addresses) : undefined;
}

/** Which self-naming answer is the tunnel's own server relaying our
 * request rather than a mirror describing itself -- see `TunnelServer`,
 * "Through". Only from the baseline's own endpoint, only on a server
 * reached through the tunnel, and only when that endpoint's baseline
 * answer was verifiably the caller's address (its peer known, and not
 * what it named): a baseline with no peer could itself have been a
 * self-report, and this would then compare it with the same self-report
 * and call a working tunnel a leak. */
function relayedByServer(
  baseline: BaselineIp | null,
  tunnelServer: TunnelServer | undefined,
): ((base: string, peer: string) => boolean) | undefined {
  if (baseline === null || tunnelServer === undefined || tunnelServer.reachedAround) return undefined;
  if (baseline.peer === undefined || comparable(baseline.ip) === comparable(baseline.peer)) return undefined;
  const server = addressSet(tunnelServer.addresses);
  if (!server.has(comparable(baseline.peer))) return undefined;
  return (base, peer) => base === baseline.from && server.has(comparable(peer));
}

/** A set of addresses, each as compared. */
function addressSet(addresses: Iterable<string>): Set<string> {
  return new Set([...addresses].map((ip) => comparable(ip)));
}

async function publicIp(
  onBody: (body: Record<string, unknown>) => void,
  { only, deadline, nodeAddresses, tunnelServer, hedgeMs }: BaselineOptions,
): Promise<IpReading | null> {
  // The same endpoint list the rest of the app uses, and for a sharper
  // reason here: this check decides whether the customer is told they
  // are protected. Pinned to one address, a blocked control plane would
  // report a perfectly working tunnel as carrying nothing -- turning a
  // reachability problem into a false accusation against the VPN.
  //
  // In the order the API's own requests use on this network: the
  // addresses that have not lately failed here first, those that have
  // last (`demotedLast`). See `BARE_WALK`.
  const bases = only !== undefined ? [only] : demotedLast(await apiEndpoints()).ordered;
  const nodes = nodeAddresses === undefined ? null : addressSet(nodeAddresses);
  const skip = nodes === null ? undefined : (ip: string) => nodes.has(comparable(ip));
  const around = aroundSet(tunnelServer);
  const walk: WalkOptions = { onBody, deadline, skip, around, ...BARE_WALK };
  const read =
    hedgeMs === undefined
      ? readFrom(bases, EGRESS_TIMEOUT_MS, walk)
      : readHedged(bases, EGRESS_TIMEOUT_MS, hedgeMs, walk);
  return (await read).reading;
}

/** How long a baseline gives an address that has lately failed on this
 * network (`isDemoted`): one that timed out, or whose name led to the
 * block page.
 *
 * Such an address is asked last, never not at all, as the API's own
 * requests ask it; but not for the whole `EGRESS_TIMEOUT_MS`. One that has
 * come back answers well inside two seconds -- three round trips to
 * Europe, under a second from Iran (`BASELINE_HEDGE_MS`) -- and one that
 * has not would otherwise hold the connect for six. */
export const DEMOTED_BASELINE_MS = 2_000;

/** What a baseline walk does that a reading through a tunnel does not.
 * A baseline is taken on the bare network, before connecting, where the
 * API's own requests have been learning which addresses this network
 * blocks (endpoint-demotion.ts), and it used to ignore all of it.
 *
 * On the test VM, with the panel hosts refused and every mirror's name
 * sent to the block page, the baseline before a connect waited up to six
 * seconds on each mirror and spent 12.7 s of a 20 s connect before the
 * engine was even started -- for no baseline at the end of it, and the
 * honest "Connected, not confirmed" it then had to settle for.
 *
 * So, as the API's race does (`blockPageLook` in api.ts): each address's
 * name is looked at beside the request, and one on the block page counts
 * as no answer at once; a name this network has already sent there is
 * looked at before anything is sent, and sent nothing if it still is
 * (`baselineBlockPage`). An address that failed here lately gets
 * `DEMOTED_BASELINE_MS`. An address that answers has its demotion lifted,
 * as an answer to any of the API's requests lifts it. Nothing here
 * demotes anything, by a timeout or by the block page: what the API's
 * requests are sent to is theirs to learn, with their own deadlines and
 * their own look -- which, unlike this one, has to ask about a proxy. */
const BARE_WALK: Pick<WalkOptions, "look" | "timeoutFor" | "answered"> = {
  look: (base) => {
    const found = baselineBlockPage(base);
    return { found, beforeSending: isNameDemoted(base) ? found : Promise.resolve(false) };
  },
  timeoutFor: (base, timeoutMs) => (isDemoted(base) ? Math.min(timeoutMs, DEMOTED_BASELINE_MS) : timeoutMs),
  answered: (base) => clearDemotion(base),
};

/** Whether `base`'s name resolves to Iran's block page and nothing else,
 * for the one request a baseline makes to it.
 *
 * IPv4 only, through this machine's own resolver, and with no question
 * about a proxy -- because that is how `/health/ip` is asked: over IPv4
 * only (`health_ip_v4`), and never through a proxy (`.no_proxy()` in
 * health_ip.rs; a proxy's exit is not this machine's address). So this is
 * exactly the answer the baseline's request will meet. The API's own look
 * (`resolvesToBlockPage`) is different on purpose: its requests do go
 * through Psiphon's, v2rayN's or Clash's system proxy, which resolves the
 * name at its own end, so where one is set it finds nothing (fbe5cc5).
 * This one is never written into the network's memory for that reason --
 * a verdict found here says nothing about a request that goes through the
 * proxy -- and is only ever used to stop waiting on a request of its own
 * that cannot be answered.
 *
 * Never rejects: false for an address literal, a name that does not
 * resolve in time, or a build without the command. */
function baselineBlockPage(base: string): Promise<boolean> {
  let name: string;
  try {
    name = new URL(base).hostname;
  } catch {
    return Promise.resolve(false);
  }
  if (name === "" || isAddressLiteral(name)) return Promise.resolve(false);
  return resolveIpv4(name, RESOLVE_TIMEOUT_MS).then(
    (addresses) => addresses.length > 0 && addresses.every((address) => isKnownBlockPage(address)),
    () => false,
  );
}

/** How long a baseline walk with `hedgeMs` waits on one endpoint before
 * asking the next one beside it. Longer than a healthy endpoint takes
 * to answer from Iran (three round trips to Europe, under a second), so
 * on a network where the first endpoint works this asks it alone. */
export const BASELINE_HEDGE_MS = 1_000;

/** How a baseline is taken, when the caller has reason to narrow it. */
export type BaselineOptions = {
  /** Ask this one endpoint and no other -- one that already answered on
   * this network, so the per-candidate settle does not walk the whole
   * list again for every protocol. */
  only?: string;
  /** Absolute time (epoch ms) after which no further endpoint is asked,
   * and no request outlives. Without one, each endpoint gets its own
   * full timeout and the list can take many of them. */
  deadline?: number;
  /** Our own nodes' public addresses, as far as the caller knows them.
   *
   * A baseline is taken with no tunnel up, so it should be this device's
   * own address -- and one of our nodes' addresses never is. Two things
   * produce one: a node mirror whose nginx proxies through the CDN rather
   * than to the origin, which then answers `/health/ip` with the node's
   * address to everyone who asks (five of six mirrors were in that state
   * on 2026-08-31, and the installer still builds one that way without
   * NEOXIFY_PANEL_ORIGIN); and a tunnel not yet gone. Kept as the
   * "before", either one turned a working tunnel into a leak: asked again
   * through that mirror the same address comes back, which reads as
   * `bypassingTunnel` -- held against the route, and on a health poll
   * "Your traffic is NOT protected".
   *
   * Such a reading is passed over and the next endpoint asked, so a
   * mirror that does report the caller can still supply the baseline.
   * None at all, and there is no baseline, which the caller already
   * handles as "nothing can be proven". */
  nodeAddresses?: Iterable<string>;
  /** The server of the route about to be dialled. Where it is reached
   * around the tunnel, an endpoint on it is passed over and the next one
   * asked: once that tunnel is up, the endpoint is reached around it, so
   * a baseline from it could only be compared with an answer that never
   * went through the tunnel. Reached through the tunnel, it changes
   * nothing. See `TunnelServer`. */
  tunnelServer?: TunnelServer;
  /** Walk the list hedged rather than strictly in turn: an endpoint that
   * has not answered within this many ms gets the next one asked beside
   * it, and the first acceptable answer to arrive is the baseline. See
   * `readHedged`.
   *
   * For the walks that have to find *some* endpoint answering on the
   * bare network, fast, on a network that blocks the first few: the
   * Windows settle and the phones' baselines. In Iran the panel hosts
   * lead the list and are filtered, and a strict walk spent its whole
   * ceiling timing them out -- six seconds each -- before it reached a
   * mirror that would have answered at once. Which endpoint supplies the
   * baseline does not matter so long as the comparison asks it again;
   * see `VerifyOptions.baselineFirst`. */
  hedgeMs?: number;
};

/** An address as compared against a set of them. */
function comparable(ip: string): string {
  return plainAddress(ip.trim()).toLowerCase();
}

/** What asking the list produced: a reading, and -- whether or not there
 * was one -- whether anything answered at all.
 *
 * The second half is the difference between "our API is having a bad
 * day" and "nothing gets through this tunnel", and the two used to be
 * the same `null`. Every base is https, so an HTTP status of any kind --
 * the 502 every mirror and the CDN return while the backend container is
 * being rebuilt, say -- can only have come from our own CDN, mirror or
 * panel, after a TLS handshake with one of our names. A censor cannot
 * forge one, and packets that made that round trip were not black-holed.
 */
type ReadResult = { reading: IpReading | null; answered: boolean };

/** What one `/health/ip` request came back with: the HTTP status, the
 * parsed body when there was a JSON one, and -- where the transport can
 * say -- the address the request actually connected to. */
export type HealthIpAnswer = { status: number; body: unknown; peer?: string | null };

/** How one `/health/ip` request is made. Resolves with whatever HTTP
 * answer came back, of any status; rejects only when none did -- that
 * difference is `ReadResult.answered`. */
export type HealthIpTransport = (base: string, timeoutMs: number) => Promise<HealthIpAnswer>;

/** The default: tauri-plugin-http's fetch, which lets the system choose
 * the address family. Neither app uses it once started -- both install
 * the IPv4-only transport from their `main.tsx` -- so it is what runs
 * before that, and in tests that install nothing. */
const fetchTransport: HealthIpTransport = async (base, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health/ip`, { signal: controller.signal });
    const body: unknown = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

let transport: HealthIpTransport = fetchTransport;

/** Replaces how `/health/ip` is asked. Both clients install an IPv4-only
 * transport at startup (`health-ip-v4.ts`, from each app's `main.tsx`),
 * so the baseline and every later reading are the same family. */
export function setHealthIpTransport(next: HealthIpTransport): void {
  transport = next;
}

/** Which family an address reported by `/health/ip` belongs to. An
 * IPv4-mapped IPv6 literal is the IPv4 address it carries. */
function familyOf(ip: string): 4 | 6 {
  return plainAddress(ip).includes(":") ? 6 : 4;
}

/** An address as compared: an IPv4-mapped IPv6 literal is the IPv4
 * address it carries, so one server writing the same address two ways
 * cannot read as a change of route. */
function plainAddress(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** Below this much of a deadline, no further endpoint is asked: three
 * round trips (TCP, TLS 1.3, the request) do not fit in it off a LAN. */
const MIN_REQUEST_MS = 10;

/** How a walk of the list treats what comes back. */
type WalkOptions = {
  onBody?: (body: Record<string, unknown>) => void;
  /** Epoch ms. The walk stops there, and the request in flight is
   * given only what is left -- the list holds a dozen endpoints, and
   * through a tunnel that black-holes everything, a walk at six
   * seconds each was a minute before the health poll could say so. */
  deadline?: number;
  /** An address that is not an answer to the question asked; the
   * endpoint that gave it is passed over like one with no address.
   * See `BaselineOptions.nodeAddresses`. */
  skip?: (ip: string) => boolean;
  /** The tunnel's server, as compared, where it is reached around the
   * tunnel. An endpoint whose connection went to one of these was asked
   * around it; see `TunnelServer`. */
  around?: ReadonlySet<string>;
  /** Which self-naming answers are the tunnel's own server relaying the
   * request, not a mirror describing itself; see `relayedByServer`. */
  relayed?: (base: string, peer: string) => boolean;
  /** A look at `base`'s name for the block page: `found` ends the request
   * as unanswered when it says so, and `beforeSending` keeps it from being
   * sent at all. Baselines only; see `BARE_WALK`. */
  look?: (base: string) => { found: Promise<boolean>; beforeSending: Promise<boolean> };
  /** How long `base` gets, out of the walk's `timeoutMs`. */
  timeoutFor?: (base: string, timeoutMs: number) => number;
  /** Told of every endpoint that gave an HTTP answer. */
  answered?: (base: string) => void;
};

/** An endpoint that gave no answer. */
const NO_ANSWER: OneAnswer = { reading: null, answered: false };

/** What one endpoint came back with: a reading if it gave one, the body
 * that reading came in (for `onBody`, which only the reading the walk
 * keeps may reach), and whether it answered at all. */
type OneAnswer = { reading: IpReading | null; body?: Record<string, unknown>; answered: boolean };

/** Asks one endpoint, and judges its answer. Never throws.
 *
 * With a `look`, the name's block page ends the wait as no answer -- the
 * request itself is left to time out on its own, unread -- or, for a name
 * already found there, keeps it from being sent. */
async function askOne(base: string, budget: number, options: WalkOptions): Promise<OneAnswer> {
  const look = options.look?.(base);
  if (look === undefined) return await askAndJudge(base, budget, options);
  if (await look.beforeSending) return NO_ANSWER;
  const asked = askAndJudge(base, budget, options);
  return await Promise.race([asked, look.found.then((found) => (found ? NO_ANSWER : asked))]);
}

async function askAndJudge(
  base: string,
  budget: number,
  { skip, around, relayed, answered }: WalkOptions,
): Promise<OneAnswer> {
  try {
    const res = await transport(base, budget);
    answered?.(base);
    const peer = typeof res.peer === "string" && res.peer ? plainAddress(res.peer.trim()) : undefined;
    // The tunnel's own server, reached around the tunnel: not even "an
    // answer" in the sense below. Packets that never entered the tunnel
    // say nothing about whether it carries anything -- an error page from
    // there counted as one used to make a dead tunnel read as an outage
    // of ours wherever nothing else could be asked.
    if (peer !== undefined && around?.has(comparable(peer))) return { reading: null, answered: false };
    // An error page is still an answer, and it is the only thing that
    // tells an outage of ours apart from a tunnel carrying nothing.
    if (res.status < 200 || res.status >= 300) return { reading: null, answered: true };
    const body = res.body;
    if (body !== null && typeof body === "object" && typeof (body as { ip?: unknown }).ip === "string") {
      const ip = (body as { ip: string }).ip;
      // An endpoint reporting the very address it was reached at is
      // describing itself, not the caller: a node mirror that proxies
      // through the CDN, which then names the node (one installed
      // without NEOXIFY_PANEL_ORIGIN). Never this device's address,
      // with a tunnel up or not -- the same reasoning as
      // `nodeAddresses`, for a mirror whose node no credential here
      // names. Except where it is the tunnel's own server, reached
      // through the tunnel, handing on our request from its own address
      // (`relayed`).
      const selfReport =
        peer !== undefined && comparable(ip) === comparable(peer) && !relayed?.(base, peer);
      // Before `onBody`, too: what such an endpoint says about the
      // network is about the node's, not the customer's.
      if (ip && !selfReport && !skip?.(ip)) {
        return {
          reading: { ip, from: base, ...(peer !== undefined ? { peer } : {}) },
          body: body as Record<string, unknown>,
          answered: true,
        };
      }
    }
    return { reading: null, answered: true };
  } catch {
    // No answer. Exhausting the list returns no reading, which the
    // caller already treats as "no evidence" rather than as failure.
    return { reading: null, answered: false };
  }
}

/** What is left of `deadline` for one more request, or null when no
 * further endpoint may be asked. */
function budgetFor(timeoutMs: number, deadline: number | undefined): number | null {
  if (deadline === undefined) return timeoutMs;
  const left = deadline - Date.now();
  // Not `<= 0`. A timer can fire a millisecond before `Date.now()`
  // reaches the deadline it was set for, so the request that was
  // given the whole remainder could time out with a sliver still
  // "left" -- and the next endpoint was then asked with a budget no
  // TLS handshake could fit in. Caught as a flaky test, where the
  // stand-in for that next endpoint answers at once.
  if (left < MIN_REQUEST_MS) return null;
  return Math.min(timeoutMs, left);
}

/** The first answer from `bases`, tried in order.
 *
 * Each endpoint gets its own budget rather than sharing one. A first
 * address that is blocked burns the whole timeout doing nothing, and a
 * shared deadline would leave the working one no time to answer.
 */
async function readFrom(bases: string[], timeoutMs: number, options: WalkOptions = {}): Promise<ReadResult> {
  let answered = false;
  for (const base of bases) {
    const budget = budgetFor(options.timeoutFor?.(base, timeoutMs) ?? timeoutMs, options.deadline);
    if (budget === null) break;
    const one = await askOne(base, budget, options);
    if (one.answered) answered = true;
    if (one.reading !== null) {
      if (one.body !== undefined) options.onBody?.(one.body);
      return { reading: one.reading, answered };
    }
  }
  return { reading: null, answered };
}

/** `readFrom`, hedged: an endpoint that has neither answered nor failed
 * within `hedgeMs` gets the next one asked beside it, and one that fails
 * gets the next asked at once. The first acceptable answer to arrive
 * wins, whichever endpoint it came from; the requests still in flight
 * are left to finish and ignored.
 *
 * Only for baselines (`BaselineOptions.hedgeMs`). A strict walk on a
 * network that blocks the head of the list -- the panel hosts, in Iran
 * -- spends a whole endpoint timeout on each before it reaches one that
 * answers, and the settle's ceiling ran out on the second. Hedged, the
 * same walk reaches the first working mirror a second or two in.
 */
function readHedged(
  bases: string[],
  timeoutMs: number,
  hedgeMs: number,
  options: WalkOptions = {},
): Promise<ReadResult> {
  return new Promise((resolve) => {
    let next = 0;
    let inFlight = 0;
    let answered = false;
    let done = false;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const finish = (one: OneAnswer | null) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      if (one?.reading && one.body !== undefined) options.onBody?.(one.body);
      resolve({ reading: one?.reading ?? null, answered });
    };
    const launch = () => {
      clearTimeout(hedge);
      if (done) return;
      const budget =
        next < bases.length
          ? budgetFor(options.timeoutFor?.(bases[next], timeoutMs) ?? timeoutMs, options.deadline)
          : null;
      if (budget === null) {
        // Nothing more may be asked: the list is spent or the deadline
        // is. Whatever is still in flight may yet answer.
        next = bases.length;
        if (inFlight === 0) finish(null);
        return;
      }
      const base = bases[next++];
      inFlight += 1;
      void askOne(base, budget, options).then((one) => {
        inFlight -= 1;
        if (one.answered) answered = true;
        if (one.reading !== null) finish(one);
        // This one is done without a reading, so the next starts now
        // rather than when the hedge would have started it.
        else launch();
      });
      hedge = setTimeout(launch, hedgeMs);
    };
    launch();
  });
}

/** The address the world saw before connecting, and who reported it.
 *
 * Null means we could not establish a baseline. That is not a failure to
 * report to anyone -- it just means the after-check has nothing to
 * compare against and must not claim the tunnel is broken.
 */
export type BaselineIp = IpReading;

/** Takes the baseline, and keeps what the server said about the
 * network while it is at it.
 *
 * Only here, never in the after-connect check: a baseline is taken with
 * no tunnel up, so it is the one reading whose network is the customer's
 * own. See network-identity.ts. A baseline that could not be taken at
 * all leaves the held network alone -- no answer is not evidence of a
 * different network. */
export const captureBaselineIp = (options: BaselineOptions = {}): Promise<IpReading | null> =>
  publicIp((body) => rememberNetwork(body), options);

export type EgressVerdict =
  /** The exit address changed: traffic is provably leaving via the VPN. */
  | { state: "throughTunnel"; exitIp: string }
  /** Reachable, but from the same address as before -- the tunnel is not
   * carrying this traffic. The leak case. */
  | { state: "bypassingTunnel"; exitIp: string }
  /** Nothing answered. Either the tunnel is black-holing traffic or the
   * connection is genuinely down; both mean the customer is not working. */
  | { state: "unreachable" }
  /** No comparison was possible: either there is no baseline at all, the
   * two readings did not come from the same endpoint and so are not
   * measuring the same thing, or our API gave no address while traffic
   * is plainly getting out (an outage of ours, not of the tunnel).
   * Reported rather than guessed, so the UI can withhold a verdict
   * instead of inventing one in either direction. */
  | { state: "indeterminate"; exitIp: string | null };

export type VerifyOptions = {
  /** How long each endpoint gets. Defaults to the full
   * `EGRESS_TIMEOUT_MS`; the connect path passes what is left of its
   * budget when that is less. */
  attemptMs?: number;
  /** Ask only the baseline's endpoint, with no fallback.
   *
   * Any other endpoint can at best answer `indeterminate`, and while
   * another protocol is waiting to be tried that is rejected exactly as
   * "unreachable" is -- so the fallback can only spend time. Where
   * `indeterminate` does change the outcome (the ladder's last rung, the
   * health poll) the fallback stays.
   */
  sameEndpointOnly?: boolean;
  /** A ceiling on the whole walk, not just on each endpoint. The health
   * poll sets one: through a dead tunnel every endpoint times out, and
   * without it the first sign of that came a minute after the tunnel
   * died. */
  totalMs?: number;
  /** The connected route's server. Reached around the tunnel, its
   * endpoints' answers are passed over and the next endpoint asked;
   * reached through it, the baseline's own endpoint there may answer
   * with the server's address and still be believed. Every caller with a
   * tunnel up passes it where it knows it; without it, on Windows, the
   * connected node's own mirror can answer with the customer's home
   * address. See `TunnelServer`. */
  tunnelServer?: TunnelServer;
  /** Ask the baseline's endpoint before the rest of the list, rather than
   * walking the list in its fixed order. The rest is still asked if it
   * does not answer, so where `indeterminate` is an outcome worth having
   * (the ladder's last rung, the Windows health poll) it still is.
   *
   * Without it, the baseline's endpoint is only reached if every one
   * ahead of it is silent, and through a tunnel they mostly are not: on
   * a censored network the baseline comes from whatever answers on the
   * bare line -- a mirror, with the panel hosts filtered -- while through
   * the tunnel the panel host at the head of the list answers first.
   * Different endpoints, `indeterminate`, "Connected, not confirmed" on
   * every poll of a tunnel that works. See `verifyEgress` for why the
   * list order used to be kept anyway, and why that no longer holds. */
  baselineFirst?: boolean;
};

/** Compares the address the world sees now against the one it saw before
 * connecting.
 *
 * Two readings only mean something together when they were taken through
 * the same endpoint. `/health/ip` answers "what is the last untrusted hop
 * before the backend", and the node mirrors in the fallback list answer
 * it differently from the CDN -- see `IpReading`. A pair that straddles
 * two endpoints is therefore not a before-and-after at all, and the
 * difference between them says nothing about where packets went.
 *
 * That mismatch is reported as `indeterminate` rather than as either
 * verdict. Calling it `throughTunnel` was the false positive that made
 * this guard necessary; calling it `bypassingTunnel` would be a false
 * accusation built on the same non-comparison.
 *
 * In practice the endpoints match on essentially every check -- the list
 * is tried in a fixed order and the first entry answers -- so the guard
 * costs nothing until the fallback actually shifts, which is exactly the
 * moment the comparison stops being valid.
 *
 * With `sameEndpointOnly`, the baseline's endpoint is the only one asked.
 * It is the only one whose answer can prove anything, and its name was
 * resolved moments ago for the baseline, so it is also the one request
 * that does not have to wait on DNS. That second point was measured, not
 * assumed: in OpenVPN's first seconds -- the new adapter's address still
 * settling, every connection refused for about two seconds -- the first
 * endpoint failed at once, the second hung for the full six-second
 * timeout, and the third answered with the node's address from the
 * wrong endpoint. The tunnel had been carrying traffic for four of those
 * seconds and the ladder threw it away.
 *
 * Without either option the list keeps its fixed order. That order used
 * to be kept on purpose: a baseline could come from a mirror that
 * reports its own node's address to everyone; asked again it answers the
 * same, and comparing those two would accuse a working tunnel of leaking
 * where the list order lets the CDN answer and the guard above say,
 * correctly, that nothing was compared. Baselines no longer come from
 * such a mirror wherever the transport reports the address it connected
 * to -- the IPv4 transport both apps install always does -- because an
 * answer naming that very address is passed over (`readFrom`), and both
 * apps pass their nodes' addresses besides (`nodeAddresses`). So
 * `baselineFirst` may move the baseline's endpoint to the front, and the
 * callers whose readings otherwise straddle endpoints use it.
 *
 * Whatever the order, an endpoint on a `tunnelServer` reached around the
 * tunnel is passed over: its answer is the customer's own address
 * however well the tunnel works. That includes the baseline's own
 * endpoint, should it be one -- then `sameEndpointOnly` walks the list
 * instead, since the one endpoint it would ask cannot answer through the
 * tunnel, and silence from it would read as a dead tunnel wherever the
 * public-internet probe is not there to say otherwise.
 */
export async function verifyEgress(
  baseline: BaselineIp | null,
  options: VerifyOptions = {},
): Promise<EgressVerdict> {
  const {
    attemptMs = EGRESS_TIMEOUT_MS,
    sameEndpointOnly = false,
    totalMs,
    tunnelServer,
    baselineFirst = false,
  } = options;
  const deadline = totalMs === undefined ? undefined : Date.now() + totalMs;
  const around = aroundSet(tunnelServer);
  // The baseline's endpoint, where asking it can still mean something.
  const own = baseline !== null && !askedAroundTunnel(baseline, tunnelServer) ? baseline.from : null;
  let bases: string[];
  if (sameEndpointOnly && own !== null) {
    bases = [own];
  } else {
    const listed = await apiEndpoints();
    bases = baselineFirst && own !== null ? [own, ...listed.filter((base) => base !== own)] : listed;
  }
  const relayed = relayedByServer(baseline, tunnelServer);
  const { reading, answered } = await readFrom(bases, attemptMs, { deadline, around, relayed });

  // No address from any of ours. Two very different things look like
  // that from here: a tunnel black-holing everything, which is what this
  // check exists to catch, and an outage of ours under a tunnel that is
  // fine -- our panel host down, the CDN refusing the node's exit, or a
  // 502 from every mirror while the backend is being redeployed. Read as
  // the first, the second turned every connected customer "degraded" at
  // once, and two of those in a row ran the automatic ladder: a working
  // tunnel torn down, every protocol then rejected against the same
  // outage, the customer left disconnected and failing open.
  //
  // A second, independent instrument tells them apart where there is
  // one (the Windows client): a verified TLS handshake with a public
  // resolver. If that answers, traffic is getting out and the silence is
  // ours -- no verdict. If it does not, it is the tunnel, error pages or
  // not: the connected node's own mirror is on the node's address, which
  // the service routes around the tunnel for every engine but WireGuard,
  // so its 502 says nothing about whether the tunnel carries anything.
  //
  // Where there is no such instrument (the mobile app, which shares this
  // file), an error page from one of ours is the evidence there is: it
  // came back over TLS with one of our names, so packets made a round
  // trip, and that is "no verdict". Silence is still unreachable there.
  // Not one from the tunnel's own server where that is reached around
  // the tunnel, when the caller named it: that round trip never entered
  // the tunnel (`askOne`).
  if (reading === null) {
    const internet = await ipv4Reaches();
    const flowing = internet ?? answered;
    return flowing ? { state: "indeterminate", exitIp: null } : { state: "unreachable" };
  }
  if (baseline === null) return { state: "indeterminate", exitIp: reading.ip };
  if (reading.from !== baseline.from) return { state: "indeterminate", exitIp: reading.ip };
  // Two families are two different questions, like two endpoints. An
  // IPv6 baseline -- a dual-stack machine reaching an endpoint with an
  // AAAA record before connecting -- against the IPv4 reading every full
  // tunnel produces differs whatever IPv4 did, and called that
  // "throughTunnel" with the customer's own IPv4 address on screen as
  // the exit. Both clients now ask over IPv4 only, so this should not
  // fire; it is what keeps anything that ever skips that from reading a
  // non-comparison as proof. It is no substitute for the transport,
  // though: on the phones, before they had it, this fired on every
  // reading of a dual-stack connect, and each rung with another to try
  // was torn down for it.
  if (familyOf(reading.ip) !== familyOf(baseline.ip)) {
    return { state: "indeterminate", exitIp: reading.ip };
  }
  return plainAddress(reading.ip) === plainAddress(baseline.ip)
    ? { state: "bypassingTunnel", exitIp: reading.ip }
    : { state: "throughTunnel", exitIp: reading.ip };
}

/** Whether the public IPv4 internet answers from here, asked only when
 * none of our own endpoints gave an address. See `vpn::probe_ipv4_egress`:
 * a TLS handshake whose certificate verified, never a bare TCP one, which
 * Xray's tunnel answers locally whether or not the node is there.
 *
 * In the Rust side, for the reason `ipv6Reaches` gives: the HTTP
 * permission would refuse any address that is not ours.
 *
 * Never throws. Null when the command could not be asked -- the mobile
 * app, which shares this file and does not register it -- which is no
 * evidence either way, and the caller falls back to what it had. */
async function ipv4Reaches(): Promise<boolean | null> {
  try {
    return (await invoke<boolean>("probe_ipv4_egress")) === true;
  } catch {
    return null;
  }
}

/** How often a new attempt starts while a tunnel is being checked. */
export const VERIFY_INTERVAL_MS = 1_500;

/** Waits up to `budgetMs` for proof that traffic leaves through the
 * tunnel, rather than asking once.
 *
 * Retries even on a definite-looking "bypassing" answer, because early in
 * a connection it is not definite at all: OpenVPN's routes arrive from
 * the server partway through negotiation, so traffic genuinely does go
 * around the tunnel for a moment before it goes through it.
 *
 * Returns as soon as it has proof, so a fast protocol stays fast.
 * Otherwise it returns the most recent answer once the budget is spent.
 *
 * **Attempts overlap.** A new one starts every `intervalMs` whether or
 * not the previous one has finished, and none is cancelled for being
 * slow; each is bounded only by what is left of the budget. This is the
 * whole of the change from asking in sequence, and the reason was
 * measured on a Windows 11 guest. For two or three seconds after
 * OpenVPN's routes appear, the new adapter's address is still settling:
 * a request made then is refused outright or, worse, stalls -- its SYN
 * is lost, Windows retransmits at three seconds and next at nine, so it
 * sits there long after the tunnel has started carrying traffic. Asked
 * in sequence, that one stalled request was the whole six-second
 * failover check, and a working OpenVPN was rejected every time on a
 * first connect. Cutting it off sooner does not help either; a fresh
 * request made after the address settles is what succeeds, and starting
 * one every interval guarantees there is one.
 *
 * The cost is a few extra `/health/ip` requests during a connect, to our
 * own API.
 */
export function confirmEgressWithin(
  baseline: BaselineIp | null,
  budgetMs: number,
  options: {
    sameEndpointOnly?: boolean;
    intervalMs?: number;
    tunnelServer?: TunnelServer;
    baselineFirst?: boolean;
  } = {},
): Promise<EgressVerdict> {
  const { sameEndpointOnly = false, intervalMs = VERIFY_INTERVAL_MS, tunnelServer, baselineFirst } = options;
  const deadline = Date.now() + budgetMs;
  let last: EgressVerdict = { state: "unreachable" };

  return new Promise((resolve) => {
    let done = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    const finish = (verdict: EgressVerdict) => {
      if (done) return;
      done = true;
      clearTimeout(next);
      clearTimeout(cutoff);
      resolve(verdict);
    };
    const cutoff = setTimeout(() => finish(last), budgetMs);

    const attempt = () => {
      const remaining = deadline - Date.now();
      if (done || remaining <= 0) return;
      verifyEgress(baseline, {
        attemptMs: Math.min(EGRESS_TIMEOUT_MS, remaining),
        sameEndpointOnly,
        tunnelServer,
        baselineFirst,
      })
        .then((verdict) => {
          if (verdict.state === "throughTunnel") finish(verdict);
          // With no baseline there is no proof to wait for: the best any
          // later attempt can say is this. Waiting out the budget only
          // held a customer whose network will not let us take one --
          // our API down, or every address filtered -- on a spinner for
          // thirty seconds before the handshake was even asked.
          else if (baseline === null && verdict.state === "indeterminate") finish(verdict);
          else last = verdict;
        })
        // A rejection is no evidence either way; the next attempt is
        // already scheduled.
        .catch(() => undefined);
      next = setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

/* ------------------------------------------------------------------ *
 * IPv6, which everything above is blind to.
 *
 * The check at the top of this file compares one address against
 * another. That is a complete answer for IPv4 and no answer at all for
 * IPv6, because a machine can have both families and they can behave
 * differently: through a full tunnel `/health/ip` is reached over IPv4
 * (on Windows it is only ever asked over IPv4; see the note at the top),
 * returns the node's address, and the comparison says "throughTunnel" --
 * while the same machine's IPv6 walks out of the physical NIC in clear
 * text.
 *
 * That is not hypothetical. It is what was measured on client 0.9.25
 * with plain full tunnel and split tunnel off, on OpenVPN, IKEv2 and
 * Xray VLESS-REALITY, with a packet capture taken outside the guest. In
 * every case this file said the customer was protected.
 *
 * So the leak has its own instrument. The question it asks is not "does
 * the internet work" but the narrower one that can actually come back
 * negative: **can this machine still reach a public IPv6 address while
 * connected?** Every Neoxify node is IPv4-only, so a yes means those
 * packets did not go through the tunnel -- there is no tunnel for them
 * to have gone through. A yes is a leak.
 * ------------------------------------------------------------------ */

/** Whether a public IPv6 destination is reachable from here, right now.
 *
 * Answered by a socket in the Rust side rather than by `fetch` here, and
 * that is not a style choice. The app's HTTP permission is scoped to
 * `*.neoxify.site` (see `src-tauri/capabilities/default.json`), so a
 * request to any probe address would be refused by Tauri's own ACL
 * before a packet left -- producing a check that always answers "no
 * IPv6" and can therefore never report the leak it exists to find. This
 * project has shipped enough tests that could not fail.
 *
 * See `vpn::probe_ipv6_egress` for which addresses and why.
 *
 * Never throws: a command that could not be reached is reported as no
 * evidence, not as an accusation.
 */
async function ipv6Reaches(): Promise<boolean> {
  return invoke<boolean>("probe_ipv6_egress").catch(() => false);
}

/** Whether this machine has public IPv6 at all, taken before connecting.
 *
 * The reason to take a baseline rather than just probing once while
 * connected is the common case: **most Windows machines cannot reach
 * public IPv6 to begin with**. Without a baseline, "the probe failed" is
 * indistinguishable between a machine that has no IPv6 and a machine
 * whose IPv6 we successfully blocked, and reporting either as a finding
 * would be inventing evidence.
 *
 * Cheap enough to sit beside the IPv4 baseline: on a machine with no
 * IPv6 the connection fails at once with no route.
 */
export const captureIpv6Baseline = ipv6Reaches;

export type Ipv6Verdict =
  /** Public IPv6 is still getting out while connected. Every node is
   * IPv4-only, so this traffic is provably not in the tunnel. */
  | "escaping"
  /** This machine had IPv6 before connecting and does not now: the block
   * is doing its job, and the customer is told the gap exists. */
  | "blocked"
  /** No public IPv6 here either way. Nothing to report, and nothing to
   * alarm about -- this is what most machines look like. */
  | "absent";

/** Checks IPv6 against the baseline taken before the tunnel came up.
 *
 * `hadIpv6` null means no baseline was taken -- adopting a tunnel that
 * was already up when the app opened, for instance. That is treated as
 * "absent" rather than guessed at: a probe that succeeds with no
 * baseline still means IPv6 is reaching the internet outside an
 * IPv4-only tunnel, but a probe that fails proves nothing, and claiming
 * a block we did not observe would be the same lie in the other
 * direction.
 */
export async function checkIpv6(hadIpv6: boolean | null): Promise<Ipv6Verdict> {
  const reaches = await ipv6Reaches();
  if (reaches) return "escaping";
  return hadIpv6 === true ? "blocked" : "absent";
}
