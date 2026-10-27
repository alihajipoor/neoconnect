import { invoke } from "@tauri-apps/api/core";
import type { ProtocolUser } from "./types";

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
 * The hold was measured only from data centres inside Iran. */

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

/** What the ladder keeps of rungs that came up and were too slow: which
 * routes to pass over for the rest of the pass, and the best of them to
 * dial again, and keep, if nothing better turns up.
 *
 * Passed over by route because the hold sits on the server's address --
 * the same rate on every port, in two rounds of measurement -- so the
 * route's other protocols would only be slow again, each costing a full
 * check to find out. */
export type SlowRungs = {
  routes: Set<string>;
  best: { candidate: ProtocolUser; verdict: Extract<DataVerdict, { state: "slow" }> } | null;
  /** The fallback's credential once it has been put back on the ladder;
   * its check then decides nothing. */
  redialling: string | null;
};

export function noSlowRungs(): SlowRungs {
  return { routes: new Set(), best: null, redialling: null };
}

/** Upload first -- the direction that is held -- then download. */
function faster(a: { downKbps: number; upKbps: number }, b: { downKbps: number; upKbps: number }): boolean {
  return a.upKbps !== b.upKbps ? a.upKbps > b.upKbps : a.downKbps > b.downKbps;
}

export function noteSlow(
  slow: SlowRungs,
  candidate: ProtocolUser,
  verdict: Extract<DataVerdict, { state: "slow" }>,
): void {
  slow.routes.add(candidate.routeId);
  if (slow.best === null || faster(verdict, slow.best.verdict)) slow.best = { candidate, verdict };
}

/** Whether to pass over `candidate` without dialling it: its route was
 * too slow on another protocol this pass. Never the fallback itself. */
export function passOverSlow(slow: SlowRungs, candidate: ProtocolUser): boolean {
  return slow.routes.has(candidate.routeId) && slow.redialling !== candidate.id;
}

/** At the end of the ladder with nothing landed: the best slow rung, put
 * back once, to be kept whatever its check says this time. A slow tunnel
 * beats none, and the customer is told it is slow. Null when there is
 * none, or it has already been put back. */
export function slowFallback(slow: SlowRungs): ProtocolUser | null {
  if (slow.best === null || slow.redialling !== null) return null;
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
