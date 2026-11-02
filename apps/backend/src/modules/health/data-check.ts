import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { Response } from "express";

/** What `/health/bulk` serves and accepts: the apps' check that a tunnel
 * moves data, not just a few hundred bytes of `/health/ip`.
 *
 * Why the address check was not enough: in October 2026 Iran started
 * holding the client-to-server direction of whole server addresses to
 * about 0.1 Mbps after the first 63-95 KB of each connection. A request
 * for `/health/ip` fits in that first burst, so every rung on such a
 * server passed, the app said "Connected", and the customer had a tunnel
 * that loaded nothing -- a typical day on one of those servers moved
 * 1 MB, against 350 MB on one that was not held. Uploading and
 * downloading a few hundred KB through the tunnel, timed, is what tells
 * the two apart (docs/reachability.md).
 *
 * Bounded both ways, and in how many run at once: it is unauthenticated,
 * like `/health/ip`, because a tunnel is checked before anything is
 * signed in through it, and it must not become a way to make this host
 * send or read without limit. */

/** The most one request may ask for or send. The apps ask for 256 KB. */
export const BULK_MAX_BYTES = 512 * 1024;

/** How many transfers may run at once. Each connect runs one download
 * and one upload, one after the other, per rung, and then one timed
 * sample once it has landed; beyond this the answer is 503 at once,
 * which the apps read as "could not measure" -- never as a slow tunnel.
 *
 * It was 8, for the whole fleet: a dozen customers connecting in the
 * same minute -- an evening in Iran -- had the rest land unmeasured, so
 * the apps learnt nothing about the speed of the servers they settled
 * on. What a transfer holds is small: an upload keeps nothing of what it
 * reads, a sized download is one buffer shared by all of them, and a
 * timed one has at most a chunk in the socket at a time. Forty-eight is
 * well within what the 4 GB panel host has, and still a bound. */
export const BULK_IN_FLIGHT = 48;

/** The bounds of a timed download (`ms`). The apps ask for 1.5 s once a
 * tunnel has landed: long enough to get past TCP's first round trips,
 * short enough that the customer is not paying for a measurement. Asked
 * for less or more, the window is clamped rather than refused, so the
 * apps need not know this file's numbers. */
export const BULK_WINDOW_MIN_MS = 250;
export const BULK_WINDOW_MAX_MS = 2_000;

/** The most a timed download sends however long the window: 4 MiB over
 * the apps' second and a half is 22 Mbps, which few customers' tunnels
 * reach -- a faster one gets a shorter sample that is still a rate, since
 * the app counts over the time the body took -- and a bound on what one
 * unauthenticated request can make this host send.
 *
 * It was 16 MiB, and the whole of it went out on every landed connect
 * through a node API mirror: the mirror's nginx buffered, so it pulled
 * the stream from here at datacentre speed into a temp file while the
 * customer took a few tens of KB. The installer now turns that buffering
 * off (`proxy_buffering off` in the mirror, and the panel's nginx passing
 * `X-Accel-Buffering` on); until a node has re-run it, this is what each
 * sample there costs. */
export const BULK_TIMED_MAX_BYTES = 4 * 1024 * 1024;

/** How much a timed download writes at a time -- the unit the deadline
 * and the byte cap are checked at. */
export const BULK_CHUNK_BYTES = 64 * 1024;

/** How long a timed download's response may take to finish once it has
 * been ended, before it is cut. A legitimate app has stopped reading at
 * its own deadline by then -- the same window, started when the headers
 * arrived -- and a cut body is read by it as the end of the leg. Without
 * a bound, a client that opens the request and never reads holds its
 * in-flight slot until nginx gives up on it (`send_timeout`, a minute
 * by default): the end of the response waits on the socket draining,
 * which is in the client's hands once nothing in front buffers. */
export const BULK_END_GRACE_MS = 1_000;

/** One buffer of random bytes, made once. Random so nothing on the path
 * can compress it into a faster-looking transfer; reused because what
 * matters is that it is incompressible, not that it is fresh. */
let payload: Buffer | null = null;

export function bulkPayload(bytes: number): Buffer {
  payload ??= randomBytes(BULK_MAX_BYTES);
  return payload.subarray(0, bytes);
}

/** The size asked for, or null when it is not a whole number of bytes
 * from 1 to `BULK_MAX_BYTES`. */
export function bulkSize(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,7}$/.test(raw)) return null;
  const bytes = Number(raw);
  return bytes >= 1 && bytes <= BULK_MAX_BYTES ? bytes : null;
}

/** The window asked for, in milliseconds, clamped to its bounds;
 * undefined when none was asked for, null when what was asked for is
 * not a whole number. */
export function bulkWindow(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  return Math.min(Math.max(Number(raw), BULK_WINDOW_MIN_MS), BULK_WINDOW_MAX_MS);
}

/** Writes random bytes to `res` until `deadline` (a `now()` reading),
 * `maxBytes`, or the response closing under it, whichever is first, and
 * ends the response. Resolves with how much was written.
 *
 * Paced by the socket: a chunk that does not fit waits for the drain,
 * so a slow tunnel is sent what it can take in the window and no more,
 * rather than having two seconds of a fast host's output queued behind
 * it. A response closed mid-stream -- the app stopped reading at its own
 * deadline -- ends the wait, since its drain never comes.
 *
 * Bounded in time, not by the client's reading: once ended, a response
 * still not finished after `endGraceMs` is destroyed (`BULK_END_GRACE_MS`),
 * so the slot it holds (`InFlight`, released on `close`) is free within
 * the window and the grace whatever the client does with the socket. */
export async function streamBulk(
  res: Response,
  deadline: number,
  options: { maxBytes?: number; endGraceMs?: number; now?: () => number } = {},
): Promise<number> {
  const { maxBytes = BULK_TIMED_MAX_BYTES, endGraceMs = BULK_END_GRACE_MS, now = Date.now } = options;
  const chunk = bulkPayload(BULK_CHUNK_BYTES);
  let sent = 0;
  while (now() < deadline && sent + chunk.length <= maxBytes && !res.destroyed && !res.writableEnded) {
    sent += chunk.length;
    if (!res.write(chunk) && !(await drained(res, deadline - now()))) break;
  }
  if (!res.destroyed && !res.writableEnded) {
    res.end();
    cutUnlessFinished(res, endGraceMs);
  }
  return sent;
}

/** Destroys `res` if it has not finished within `ms` of being ended --
 * its last chunk still waiting on a socket nobody reads. Nothing happens
 * to one that finishes or closes first. */
function cutUnlessFinished(res: Response, ms: number): void {
  if (res.writableFinished || res.destroyed) return;
  const timer = setTimeout(() => {
    if (!res.writableFinished && !res.destroyed) res.destroy();
  }, ms);
  const settled = () => clearTimeout(timer);
  res.once("finish", settled);
  res.once("close", settled);
}

/** Resolves true once `res` can take more, false when it closed or `ms`
 * ran out first. */
function drained(res: Response, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (ok: boolean) => () => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
      resolve(ok);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    const timer = setTimeout(onClose, Math.max(ms, 0));
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

/** Reads a request body to its end, counting it and keeping none of it.
 * Resolves with the count, or null once it passes `max` -- the stream is
 * then left unread and the caller answers 413. */
export function drainCounting(body: Readable, max: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const onData = (chunk: Buffer) => {
      count += chunk.length;
      if (count > max) {
        body.off("data", onData);
        body.pause();
        resolve(null);
      }
    };
    body.on("data", onData);
    body.once("end", () => resolve(count));
    body.once("error", reject);
  });
}

/** Counts transfers in flight, so a burst beyond `BULK_IN_FLIGHT` is
 * turned away rather than queued. */
export class InFlight {
  private running = 0;

  constructor(private readonly limit: number) {}

  /** A release function, or null when the limit is reached. */
  enter(): (() => void) | null {
    if (this.running >= this.limit) return null;
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
    };
  }
}
