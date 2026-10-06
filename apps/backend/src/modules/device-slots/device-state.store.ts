import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis from "ioredis";

/** Short-lived per-subscription state -- which devices are carrying
 * traffic, which hold a slot -- as Redis hashes.
 *
 * Redis rather than memory so a backend restart (every deploy) does not
 * forget which device holds a customer's slot, or hand a sharer a clean
 * slate. Every key expires on its own; nothing here is a record.
 *
 * Falls back to process memory for any call Redis cannot answer, with
 * the same semantics, and says so once. That is the honest degradation
 * for a single backend instance (infra/docker-compose.prod.yml, the same
 * assumption KeyedLock makes): device limits keep working across nodes
 * instead of narrowing to one node at a time, and nobody is refused or
 * cut off because Redis blinked. What is lost is only continuity across
 * a restart during the outage.
 */
@Injectable()
export class DeviceStateStore implements OnModuleDestroy {
  private readonly logger = new Logger(DeviceStateStore.name);
  private readonly redis: IORedis | null;
  private readonly memory = new Map<string, { fields: Map<string, string>; expiresAt: number }>();
  /** Logged once per outage rather than per call. */
  private warned = false;

  constructor(@Optional() config?: ConfigService) {
    const url = config?.get<string>("redis.url");
    if (!url) {
      this.redis = null;
      return;
    }
    this.redis = new IORedis(url, {
      // Short request/response commands only, like the concurrency store
      // this replaces: fail fast to the memory fallback rather than queue.
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    this.redis.on("error", (err: Error) => this.degraded(err));
    this.redis.on("ready", () => {
      this.warned = false;
    });
    void this.redis.connect().catch(() => undefined);
  }

  /** A store that never touches Redis -- for tests, and for a backend run
   * without one. */
  static inMemory(): DeviceStateStore {
    return new DeviceStateStore();
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (this.redis) {
      try {
        return await this.redis.hgetall(key);
      } catch (err) {
        this.degraded(err as Error);
      }
    }
    const entry = this.live(key);
    return entry ? Object.fromEntries(entry.fields) : {};
  }

  /** Writes fields and (re)sets the key's expiry. */
  async hset(key: string, fields: Record<string, string>, ttlMs: number): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    if (this.redis) {
      try {
        await this.redis.multi().hset(key, fields).pexpire(key, ttlMs).exec();
        return;
      } catch (err) {
        this.degraded(err as Error);
      }
    }
    const entry = this.live(key) ?? { fields: new Map<string, string>(), expiresAt: 0 };
    for (const [field, value] of Object.entries(fields)) entry.fields.set(field, value);
    entry.expiresAt = Date.now() + ttlMs;
    this.memory.set(key, entry);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    if (fields.length === 0) return;
    if (this.redis) {
      try {
        await this.redis.hdel(key, ...fields);
        return;
      } catch (err) {
        this.degraded(err as Error);
      }
    }
    const entry = this.live(key);
    if (!entry) return;
    for (const field of fields) entry.fields.delete(field);
    if (entry.fields.size === 0) this.memory.delete(key);
  }

  async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
        return;
      } catch (err) {
        this.degraded(err as Error);
      }
    }
    this.memory.delete(key);
  }

  private live(key: string) {
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return undefined;
    }
    return entry;
  }

  private degraded(err: Error) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(`Redis unavailable; device presence and slots fall back to this process's memory: ${err.message}`);
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
