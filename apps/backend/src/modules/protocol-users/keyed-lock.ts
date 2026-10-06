/** Runs work one at a time per key, in arrival order.
 *
 * In-process, which is enough because there is one backend instance
 * (infra/docker-compose.prod.yml) -- the same assumption LoginGuardService
 * and the reset-code counters already make. If the API is ever scaled
 * out this has to become a database lock (pg_advisory_xact_lock).
 *
 * Not re-entrant: work running under a key must not take the same key
 * again, or it waits on itself.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // Every tail resolves and never rejects, so one failed piece of work
    // cannot wedge the key for everyone after it.
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      // Only the last holder clears the entry, so the map holds keys
      // that are busy rather than every key ever used.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** For tests: how many keys currently have work queued or running. */
  get size(): number {
    return this.tails.size;
  }
}
