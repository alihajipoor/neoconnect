import { invoke } from "@tauri-apps/api/core";
import type { ProtocolUser, RouteOption } from "./types";

/** Whether a tunnel whose address check passed is any use: a timed
 * download and upload through it, before the app says "Connected".
 *
 * The address check (`verifyEgress`) proves traffic leaves from the
 * server. In October 2026 that stopped being enough: Iran began holding
 * the client-to-server direction of whole server addresses to about
 * 0.1 Mbps after the first 63-95 KB of each connection. A `/health/ip`
 * request fits inside that first burst, so every such server passed,
 * showed "Connected", and loaded almost nothing -- a typical day on one
 * moved 1 MB, against 350 MB on a server that was not held. Customers
 * settled on it because the app had.
 *
 * So the rung also moves `DOWN_BYTES` down and `UP_BYTES` up, through
 * the endpoint that has just answered the address check through this
 * tunnel (`data_check_v4` in the Rust side, `/health/bulk` in the API).
 * The upload is the half that catches the hold: well past its free first
 * burst, it takes about thirteen seconds on a held server and under two
 * on a usable one. Each leg gets `LEG_MS`, which puts the line at about
 * a quarter of a megabit.
 *
 * Unverified: where that line should sit for home and mobile networks.
 * The hold was measured only from data centres inside Iran.
 *
 * And it cannot yet be moved for one network from what the check itself
 * measures there. An upload that runs out its leg comes back with no
 * answer and no byte count (the request is one POST, and it timed out),
 * so a rung under the line has no upload figure at all -- "220 kbps on a
 * line that never did better than 330" and "held at 130" are the same
 * reading. Telling them apart needs a longer upload leg on that network,
 * not a different judgement of this one. */

export const DOWN_BYTES = 128 * 1024;
export const UP_BYTES = 256 * 1024;
export const LEG_MS = 8_000;

/** What one direction measured (`DataLeg` in health_ip.rs). `status` is
 * null when no answer came back at all. */
export type DataLeg = { status: number | null; bytes: number; ms: number };
export type DataCheck = { down: DataLeg; up: DataLeg; peer: string | null };

export type DataVerdict =
  /** Both directions finished in time. */
  | { state: "moves"; downKbps: number; upKbps: number }
  /** A direction did not finish in time, or carried nothing. */
  | { state: "slow"; downKbps: number; upKbps: number }
  /** Nothing of ours took part -- busy, an error page, a backend without
   * the endpoint, a build without the command -- so nothing is known
   * about the tunnel either way, and the rung is judged as before. */
  | { state: "unmeasured" };

/** Kilobits a second; a leg that finished in no time is not a speed. */
function kbps(leg: DataLeg): number {
  return leg.ms > 0 ? Math.round((leg.bytes * 8) / leg.ms) : 0;
}

export function judgeDataCheck(
  check: DataCheck | null,
  asked: { down: number; up: number } = { down: DOWN_BYTES, up: UP_BYTES },
): DataVerdict {
  if (check === null) return { state: "unmeasured" };
  const { down, up } = check;
  // An answer, and not ours: the endpoint, not the tunnel.
  const notOurs = (leg: DataLeg) => leg.status !== null && leg.status !== 200;
  if (notOurs(down) || notOurs(up)) return { state: "unmeasured" };
  const downDone = down.status === 200 && down.bytes >= asked.down;
  const upDone = up.status === 200 && up.bytes >= asked.up;
  const speeds = { downKbps: downDone ? kbps(down) : 0, upKbps: upDone ? kbps(up) : 0 };
  return downDone && upDone ? { state: "moves", ...speeds } : { state: "slow", ...speeds };
}

/** Runs the check through `base`. Never throws: a check that could not
 * be run is `unmeasured`, never `slow`. */
export async function checkDataMoves(base: string | undefined): Promise<DataVerdict> {
  if (!base) return { state: "unmeasured" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The command has its own timeouts; this only guards against an IPC
  // reply that never comes.
  const stalled = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 2 * LEG_MS + 2_000);
  });
  try {
    const check = await Promise.race([
      invoke<DataCheck>("data_check_v4", { base, downBytes: DOWN_BYTES, upBytes: UP_BYTES, timeoutMs: LEG_MS }),
      stalled,
    ]);
    return judgeDataCheck(check);
  } catch {
    return { state: "unmeasured" };
  } finally {
    clearTimeout(timer);
  }
}

/** How long the sample after landing runs. The check above asks whether
 * a tunnel moves at all, in sizes chosen so a held line fails them; it
 * cannot say how fast a tunnel that passed is, since 128 KB is over in a
 * few round trips on a good one. A second and a half of download is long
 * enough to get past those and short enough that the customer, already
 * connected, is not paying for a measurement. */
export const SAMPLE_MS = 1_500;

/** What an API from before `ms` serves for the sample: the most the
 * endpoint allows, so that too is a reading of some length. */
const SAMPLE_FALLBACK_BYTES = 512 * 1024;

/** The sample's whole request: a connection through the tunnel, the
 * answer, and the window. */
const SAMPLE_TIMEOUT_MS = SAMPLE_MS + 4_000;

/** What the sample measured. `bytes` over `ms` is the rate. */
export type SpeedSample = { downKbps: number; bytes: number; ms: number };

/** The sample's reading, or null when nothing of ours answered with
 * data: busy, an error page, a backend without the endpoint. */
export function judgeSample(check: DataCheck | null): SpeedSample | null {
  if (check === null || check.down.status !== 200 || check.down.bytes <= 0 || check.down.ms <= 0) return null;
  return { downKbps: kbps(check.down), bytes: check.down.bytes, ms: check.down.ms };
}

/** One timed download through `base`, once a rung has landed: the speed
 * the customer actually gets, against the endpoint the check used.
 * Never throws, and decides nothing -- the rung has landed whatever this
 * finds; what it finds goes into the speed memory (`recordSpeed`) and
 * out with the report (`rungSpeeds`). */
export async function sampleDownload(base: string | undefined): Promise<SpeedSample | null> {
  if (!base) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAMPLE_TIMEOUT_MS + 2_000);
  });
  try {
    const check = await Promise.race([
      invoke<DataCheck>("data_check_v4", {
        base,
        downBytes: SAMPLE_FALLBACK_BYTES,
        upBytes: 1,
        timeoutMs: SAMPLE_TIMEOUT_MS,
        sampleMs: SAMPLE_MS,
      }),
      stalled,
    ]);
    return judgeSample(check);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The fastest a rung may claim in a report: the server's own bound
 * (`RUNG_KBPS_MAX` in report-attempt.dto.ts). */
const RUNG_KBPS_MAX = 10_000_000;

/** What the landed rung reports it moved (`AttemptRung.downKbps` and
 * `upKbps`): the sample's download where one was taken, else the check's,
 * and the check's upload -- each only where that leg finished, since a
 * leg that ran out of time has no speed, only a "too slow". Empty when
 * nothing was measured. */
export type RungSpeeds = { downKbps?: number; upKbps?: number };

export function rungSpeeds(verdict: DataVerdict | null, sample: SpeedSample | null): RungSpeeds {
  const bound = (kbps: number) => Math.min(Math.max(Math.round(kbps), 0), RUNG_KBPS_MAX);
  const measured = verdict !== null && verdict.state !== "unmeasured" ? verdict : null;
  const speeds: RungSpeeds = {};
  const down = sample?.downKbps ?? (measured && measured.downKbps > 0 ? measured.downKbps : undefined);
  if (down !== undefined) speeds.downKbps = bound(down);
  if (measured && measured.upKbps > 0) speeds.upKbps = bound(measured.upKbps);
  return speeds;
}

/** Which server a candidate is, for passing over: the address it is
 * dialled at, and the machine its traffic leaves from.
 *
 * Not the route. A route here is one server and one protocol --
 * "germany-1 / VLESS+TLS" -- so a slow route said nothing about the next
 * protocol on germany-1, and on the test VM the ladder dialled germany-1
 * four times over, each a full check, before it got anywhere. The hold
 * sits on the address (the same rate on every port, in two rounds of
 * measurement), so every protocol at that address is as slow. The exit is
 * part of it for a relay: the same entry box can carry one exit that is
 * held and another that is not. */
export function serverKey(candidate: ProtocolUser, routes: ReadonlyArray<Pick<RouteOption, "id" | "exit">>): string {
  const host = candidate.connection?.host;
  if (!host) return `route:${candidate.routeId}`;
  const exit = routes.find((route) => route.id === candidate.routeId)?.exit ?? "";
  return `${host}|${exit}`;
}

/** Whether a candidate shows one of our own server names on the wire:
 * its TLS handshake names the server it is dialling, with our certificate
 * behind it. Stealth HTTPS, Stealth Web and Stealth Lite do (the engine
 * sets `serverName` from the credential's own, xray-config.ts); Stealth
 * borrows another site's name, which is REALITY's whole design; and
 * Shadowsocks, Fast, Compatible and Built-in present no name at all.
 * Stealth (legacy) does when it is carried over TLS.
 *
 * What it is for: a slow rung's evidence is about what the network could
 * see of it. A hold on an address slows every protocol there alike (two
 * rounds of measurement, `serverKey`), but Iran also throttles by name,
 * and a Stealth HTTPS rung held that way says nothing about Stealth or
 * Shadowsocks on the same box -- which are exactly the rungs built to
 * get past that, and which the ladder was skipping on its strength. */
export function presentsOwnName(candidate: Pick<ProtocolUser, "protocol" | "connection">): boolean {
  switch (candidate.protocol) {
    case "XRAY_VLESS_TLS":
    case "XRAY_TROJAN":
      return true;
    case "XRAY_VMESS":
      return candidate.connection?.security === "TLS";
    default:
      return false;
  }
}

/** What the ladder keeps of rungs that came up and were too slow: which
 * servers (`serverKey`) to pass over for the rest of the pass, and the
 * best of them to dial again, and keep, if nothing better turns up. A
 * held server's other protocols would only be slow again, each costing a
 * full check to find out.
 *
 * In two sets, by what the slow rung showed the network (`presentsOwnName`).
 * A rung that showed our name may have been held for the name, so it is
 * evidence against the other rungs on that server that show it, and
 * those alone (`names`); one that showed no name of ours, or a borrowed
 * one, was held for its address, and is evidence against everything
 * there (`servers`). */
export type SlowRungs = {
  keyOf: (candidate: ProtocolUser) => string;
  /** The servers (`keyOf`) this network's memory has seen pass this check
   * lately (`movedLately` in connect-history.ts): the only ones a pass
   * stops looking early for the sake of (`noteSlow`). */
  moved: Set<string>;
  servers: Set<string>;
  names: Set<string>;
  best: { candidate: ProtocolUser; verdict: Extract<DataVerdict, { state: "slow" }> } | null;
  /** The fallback's credential once it has been put back on the ladder;
   * its check then decides nothing. */
  redialling: string | null;
  /** The search for something better, from the first slow rung that
   * moved data on a server this network has seen move (`moved`): when it
   * was measured, which rungs have been dialled since, the best such rung
   * -- the one to go back to -- whether it has been put back early
   * (`endSearch`), and whether the fallback has since been put back again
   * at the end of the ladder (`slowFallback`). Null until there is one. */
  search: {
    since: number;
    dialled: Set<string>;
    ended: boolean;
    again: boolean;
    best: { candidate: ProtocolUser; verdict: Extract<DataVerdict, { state: "slow" }> };
  } | null;
};

/** `movedLately` is what this network's memory holds as the pass begins:
 * the rungs that passed this check here in the last day (`movedLately`
 * in connect-history.ts). None, on a network nothing is known of. */
export function noSlowRungs(
  keyOf: (candidate: ProtocolUser) => string = (u) => `route:${u.routeId}`,
  movedLately: ReadonlyArray<ProtocolUser> = [],
): SlowRungs {
  return {
    keyOf,
    moved: new Set(movedLately.map(keyOf)),
    servers: new Set(),
    names: new Set(),
    best: null,
    redialling: null,
    search: null,
  };
}

/** How far a pass looks for something better once a rung has come up and
 * measured slow on a server this network has seen move: this many further
 * rungs dialled, or this long, whichever comes first. Then it goes back
 * to the best such rung and keeps it (`endSearch`).
 *
 * A slow rung that moved data is one that works. The ladder used to walk
 * on from it to its very end before going back, and on a network where
 * most servers carry nothing that end is minutes away: in November 2026
 * a customer whose one usual server measured just under the line half
 * the time waited through rungs at 25-30 s each, of 49, and cancelled --
 * the fallback that would have connected him was never reached.
 *
 * Only for a server this network's memory has seen pass the check in the
 * last day (`SlowRungs.moved`), because a server whose upload is held
 * reads exactly as a line that is merely slow does (see the note at the
 * top): download done, upload out of time. Stopping early for any slow
 * rung settled the pass on a held server while a clean one sat further
 * down than the search went -- the thing this check was built to stop.
 * A held server never passes the check, so it is never in that memory;
 * the customer's usual server on a slow line passes it about as often as
 * not, and is. On a network nothing is known of, and for a slow rung on a
 * server never seen moving here, the pass walks on to the end of the
 * ladder as it always did.
 *
 * What is left of that cost: a server that moved here within the day and
 * has been held since reads as the usual server having a slow moment,
 * until that memory is a day old, and a pass may settle on it while a
 * clean one sits further down. It is said on screen as slow, and recorded
 * as a failure with its speed, not as what worked here; and the rungs the
 * search found dead go last next time (`failedLately`), so each pass
 * looks at different ones.
 *
 * Three, because what is tried first is what this network has seen move
 * (`searchOrder`): if those do not, the untried rest is a long shot.
 * Forty seconds, so the wait is bounded on a phone as well, where one
 * dead rung can use most of it. The clock decides only whether another
 * rung is begun: one in flight runs to its end. */
export const SLOW_SEARCH_MAX_DIALS = 3;
export const SLOW_SEARCH_MAX_MS = 40_000;

/** The speed a rung is remembered by (`recordSpeed`): its slower
 * direction, which is what the customer feels. Null when nothing was
 * measured. */
export function rememberedKbps(verdict: DataVerdict | null): number | null {
  if (verdict === null || verdict.state === "unmeasured") return null;
  return Math.min(verdict.downKbps, verdict.upKbps);
}

/** The speed a landed rung is remembered by once its sample is in
 * (`sampleDownload`), in place of `rememberedKbps`: still the slower
 * direction, with the sample's download standing in for the check's.
 *
 * Not the sample alone. It measures the download, and the hold is on
 * the upload: a held server that landed as the slow fallback was
 * remembered at its upload's 0 kbps, and the download alone would have
 * overwritten that with a figure that ranked it first on the next
 * connect here (`bySpeed` in failover.ts) -- the pass over it is what
 * the memory is for. Null when there is no sample, or the check measured
 * nothing: nothing was remembered then, and a download alone says
 * nothing about the direction that is held. */
export function rememberedKbpsWith(verdict: DataVerdict | null, sample: SpeedSample | null): number | null {
  if (sample === null || verdict === null || verdict.state === "unmeasured") return null;
  return Math.min(sample.downKbps, verdict.upKbps);
}

/** Upload first -- the direction that is held -- then download. */
function faster(a: { downKbps: number; upKbps: number }, b: { downKbps: number; upKbps: number }): boolean {
  return a.upKbps !== b.upKbps ? a.upKbps > b.upKbps : a.downKbps > b.downKbps;
}

export function noteSlow(
  slow: SlowRungs,
  candidate: ProtocolUser,
  verdict: Extract<DataVerdict, { state: "slow" }>,
  now: number = Date.now(),
): void {
  (presentsOwnName(candidate) ? slow.names : slow.servers).add(slow.keyOf(candidate));
  if (slow.best === null || faster(verdict, slow.best.verdict)) slow.best = { candidate, verdict };
  // The first slow rung that moved data, on a server this network has
  // seen move, starts the search's clock; a later one does not start it
  // again, and is what the pass goes back to if it is the faster. Two
  // kinds start none and are never gone back to early -- the end of the
  // ladder still puts the best slow rung back, as it always did. One the
  // check got nothing through in either direction: it is not known to
  // work. And one on a server never seen moving here: slow is all a held
  // server ever reads, so the pass keeps looking for a clean one
  // (`SLOW_SEARCH_MAX_DIALS`).
  if ((verdict.downKbps > 0 || verdict.upKbps > 0) && slow.moved.has(slow.keyOf(candidate))) {
    if (slow.search === null) {
      slow.search = { since: now, dialled: new Set(), ended: false, again: false, best: { candidate, verdict } };
    } else if (faster(verdict, slow.search.best.verdict)) {
      slow.search.best = { candidate, verdict };
    }
  }
}

/** Whether the pass is on its short search (`endSearch`): begun, and not
 * yet over. Only then is what is left of the ladder put in the search's
 * order (`searchOrder`); a pass that walks on from a slow rung with no
 * search keeps the order it had. */
export function searching(slow: SlowRungs): boolean {
  return slow.search !== null && !slow.search.ended;
}

/** A rung is about to be dialled: counted against the search, if one is
 * on. By credential, so a rung dialled twice -- after a wait for a
 * network -- is one. */
export function noteDial(slow: SlowRungs, candidate: ProtocolUser): void {
  if (slow.search !== null && !slow.search.ended) slow.search.dialled.add(candidate.id);
}

/** The search's budget afresh, for a pass that has just waited for a
 * network: that wait was not spent looking. */
export function restartSearch(slow: SlowRungs, now: number = Date.now()): void {
  if (slow.search !== null && !slow.search.ended) slow.search = { ...slow.search, since: now, dialled: new Set() };
}

/** What `endSearch` hands back: the rung to dial again, and what the
 * search came to. */
export type SearchEnd = { candidate: ProtocolUser; dials: number; ms: number };

/** Asked before a rung is dialled: whether the search for something
 * better than a slow rung has used its budget (`SLOW_SEARCH_MAX_DIALS`,
 * `SLOW_SEARCH_MAX_MS`). If it has, the best slow rung on a server this
 * network has seen move -- not a faster-reading one on a server it has
 * not, which may be held -- to be dialled next, ahead of the rungs still
 * on the ladder, and kept whatever its check says (`keepsSlow`), as at
 * the end of the ladder. Once.
 *
 * Put back in front of the rest, not instead of it: if it does not come
 * up this time the pass goes on down the ladder as it always did, so no
 * rung is left undialled by a pass that then fails. Null while there is
 * budget left, when no search was begun (`noteSlow`), and once the
 * fallback has been put back either way. */
export function endSearch(slow: SlowRungs, now: number = Date.now()): SearchEnd | null {
  const { search } = slow;
  if (search === null || search.ended || slow.redialling !== null) return null;
  const ms = Math.max(0, now - search.since);
  if (search.dialled.size < SLOW_SEARCH_MAX_DIALS && ms < SLOW_SEARCH_MAX_MS) return null;
  search.ended = true;
  slow.redialling = search.best.candidate.id;
  return { candidate: search.best.candidate, dials: search.dialled.size, ms };
}

/** The line in the technical details where a pass goes back to a slow
 * rung early. `left` is how many rungs were still on the ladder: not
 * dialled, and said so -- nothing is claimed about servers nobody tried. */
export function describeSearchEnd(end: SearchEnd, left: number): string {
  return `going back to it -- slow, but it works; ${end.dials} more dialled in ${Math.round(end.ms / 1000)} s found nothing better, ${left} further not dialled yet`;
}

/** What is left of the ladder once a rung has measured slow, in the order
 * to search it: the rungs this network has seen carry traffic lately
 * (`moved`, from the connect history) ahead of the rest, each group in
 * the order it had. The search is short, so it is spent first on what is
 * likeliest to move. `chosen` rungs -- the location the customer picked
 * -- keep their lead over both. */
export function searchOrder(
  rest: ReadonlyArray<ProtocolUser>,
  moved: (candidate: ProtocolUser) => boolean,
  chosen: (candidate: ProtocolUser) => boolean = () => false,
): ProtocolUser[] {
  const tier = (candidate: ProtocolUser) => (chosen(candidate) ? 0 : moved(candidate) ? 1 : 2);
  return [...rest].sort((a, b) => tier(a) - tier(b));
}

/** Whether to pass over `candidate` without dialling it: its server was
 * too slow on another protocol this pass -- on any protocol, or, for a
 * rung that shows our name, on another that shows it. Never the fallback
 * itself. */
export function passOverSlow(slow: SlowRungs, candidate: ProtocolUser): boolean {
  const key = slow.keyOf(candidate);
  const held = slow.servers.has(key) || (presentsOwnName(candidate) && slow.names.has(key));
  return held && slow.redialling !== candidate.id;
}

/** At the end of the ladder with nothing landed: the best slow rung, put
 * back once, to be kept whatever its check says this time. A slow tunnel
 * beats none, and the customer is told it is slow. Null when there is
 * none, or it has already been put back.
 *
 * Where `endSearch` put one back early and it did not land, the best
 * slow rung of the whole pass is put back here once more: the pass went
 * on through every other rung after it, and this is the last one, with
 * the last rung's patience. */
export function slowFallback(slow: SlowRungs): ProtocolUser | null {
  if (slow.best === null) return null;
  if (slow.redialling !== null) {
    if (slow.search === null || !slow.search.ended || slow.search.again) return null;
    slow.search.again = true;
  }
  slow.redialling = slow.best.candidate.id;
  return slow.best.candidate;
}

/** Whether a rung's slow check is the fallback's, which lands anyway. */
export function keepsSlow(slow: SlowRungs, candidate: ProtocolUser): boolean {
  return slow.redialling === candidate.id;
}

/** The line in the technical details for a rung passed over as slow. */
export function describeSlow(verdict: Extract<DataVerdict, { state: "slow" }>): string {
  return `too slow (${verdict.downKbps} kbps down, ${verdict.upKbps} kbps up)`;
}
