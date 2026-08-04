import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";

/** How long one node's report stays part of the total.
 *
 * Nodes report roughly every 30 seconds, so this tolerates a missed
 * batch without dropping a live customer off the count.
 *
 * It is deliberately not longer. The window is also how long a customer
 * who moves between locations is counted on both -- their old node has
 * no way to say "they left", it simply stops mentioning them -- so every
 * extra second here is a second in which one person can look like two.
 */
const FRESH_MS = 90_000;

/** When a subscription with no reports at all is forgotten.
 *
 * Only housekeeping: stale fields are already ignored by the read. This
 * stops Redis accumulating a key per subscription that ever connected.
 */
const KEY_TTL_MS = 10 * 60_000;

const key = (subscriptionId: string) => `concurrency:${subscriptionId}`;

/** How one node's count is stored, so the reader can tell a live count
 * from one left behind by a node that has gone quiet. */
export function encodeEntry(count: number, at: number): string {
  return `${count}:${at}`;
}

/** Splits stored counts into a live total and the nodes to forget.
 *
 * Pulled out as a pure function so the part with the actual reasoning in
 * it -- what counts as fresh, and what a malformed entry does -- can be
 * tested without standing up Redis. Everything around it is just
 * hash reads and writes.
 */
export function sumFresh(
  entries: Record<string, string>,
  now: number,
  freshMs: number = FRESH_MS,
): { total: number; stale: string[] } {
  let total = 0;
  const stale: string[] = [];

  for (const [node, raw] of Object.entries(entries)) {
    const [value, at] = raw.split(":");
    const seenAt = Number(at);
    const count = Number(value);
    // A node that has gone quiet has no live sessions to contribute.
    // Absence is the only "they disconnected" signal available: nodes
    // report the users they see, never the ones they don't.
    //
    // A malformed entry is treated as stale rather than as zero, so a
    // bad write is forgotten instead of being counted forever.
    if (!Number.isFinite(seenAt) || !Number.isFinite(count) || now - seenAt > freshMs) {
      stale.push(node);
      continue;
    }
    total += count;
  }

  return { total, stale };
}

/** Holds each node's latest connection count for a subscription, so the
 * limit can be judged across the whole fleet rather than one node at a
 * time.
 *
 * This exists because of what provisioning-everywhere made possible: a
 * subscription now holds a credential on every route its plan allows, so
 * somebody sharing an account can simply tell each friend to pick a
 * different location. Judged per node, five nodes and a limit of two
 * silently permits ten simultaneous users -- which is the exact scenario
 * the limit is meant to prevent.
 *
 * Redis rather than memory because the backend is a single process today
 * but need not stay one, and because a restart should not hand every
 * sharer a clean slate.
 *
 * Counts, not addresses, because counts are all the nodes report. That
 * loses one thing worth naming: the same device seen by two nodes during
 * a location switch counts twice for up to FRESH_MS. The strike debounce
 * in ConcurrencyService is what keeps that from acting on anyone.
 */
@Injectable()
export class ConcurrencyStore implements OnModuleDestroy {
  private readonly logger = new Logger(ConcurrencyStore.name);
  private readonly redis: IORedis;
  /** Logged once rather than per report -- a Redis outage would
   * otherwise produce a line every thirty seconds per subscription. */
  private warned = false;

  constructor(config: ConfigService) {
    this.redis = new IORedis(config.get<string>("redis.url")!, {
      // Unlike BullMQ's connection, this one issues only short
      // request/response commands, so the default retry behaviour is
      // right. Kept separate from BullMQ's for exactly that reason.
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    this.redis.on("error", (err) => {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn(`Redis unavailable, concurrency falls back to per-node counts: ${err.message}`);
    });
    void this.redis.connect().catch(() => undefined);
  }

  /** Records one node's count and returns the fleet-wide total.
   *
   * Falls back to the caller's own number if Redis cannot be reached.
   * That is the honest degradation: enforcement narrows back to one node
   * -- which is what it was before this existed -- rather than a shared
   * account going completely unchecked, or a Redis blip disconnecting a
   * paying customer.
   */
  async recordAndTotal(subscriptionId: string, nodeId: string, count: number): Promise<number> {
    const now = Date.now();
    try {
      const k = key(subscriptionId);
      await this.redis
        .multi()
        .hset(k, nodeId, encodeEntry(count, now))
        .pexpire(k, KEY_TTL_MS)
        .exec();

      const { total, stale } = sumFresh(await this.redis.hgetall(k), now);

      // Opportunistic, and only for fields already excluded above, so a
      // failure here changes no verdict.
      if (stale.length > 0) {
        await this.redis.hdel(k, ...stale).catch(() => undefined);
      }

      return total;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Concurrency falls back to per-node counts: ${(err as Error).message}`,
        );
      }
      return count;
    }
  }

  /** Forgets a subscription's counts.
   *
   * Called after a disconnect: the credentials are gone from every node,
   * so every stored count is about sessions that no longer exist.
   * Without this the totals from before the drop would linger for
   * FRESH_MS and immediately re-trip the limit on the next report.
   */
  async clear(subscriptionId: string): Promise<void> {
    await this.redis.del(key(subscriptionId)).catch(() => undefined);
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
