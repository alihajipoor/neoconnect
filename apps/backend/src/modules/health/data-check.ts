import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

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
 * and one upload, one after the other, per rung; beyond this the answer
 * is 503 at once, which the apps read as "could not measure" -- never as
 * a slow tunnel. */
export const BULK_IN_FLIGHT = 8;

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
