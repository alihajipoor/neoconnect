/** How many guesses one account's codes may take, in total, over a fixed
 * window -- however many codes are issued in it and however many
 * addresses the guesses come from. Used for the customer's emailed codes
 * (reset and verification) and for the admin TOTP step.
 *
 * Six digits is a million values, and the per-IP throttle in front of the
 * code routes is exactly the limit a distributed attacker walks around.
 * The first per-account counter this replaced belonged to each code, and
 * that was two holes:
 *
 * * Asking for a new code (forgot-password, unauthenticated) reset it. A
 *   fresh code is exactly as guessable as the old one, so an attacker
 *   asked for one every five guesses and guessed at the uncapped rate.
 * * Misses were counted after the database read. A burst of parallel
 *   guesses all read the live code before the burning write landed, and
 *   a correct one among them still worked.
 *
 * So the allowance belongs to the account and the window, not the code,
 * and a guess is taken from it synchronously, before anything is awaited:
 * past the limit, a request is refused without its code ever being
 * compared. Nothing but the window's end gives the allowance back -- a new
 * code does not, and neither does a burn. A success clears it.
 *
 * The cost is stated openly: whoever spends an account's allowance stops
 * the owner using a code for the rest of the window. That is inherent to
 * any limit counted per account, and an hour's wait is the better trade
 * than an account taken over.
 *
 * Process-local, like LoginGuardService's counters, and for the same
 * reasons: minutes of bookkeeping, one backend instance
 * (infra/docker-compose.prod.yml). A restart forgets the allowance, not
 * what a spent one did -- the burn of a code is a database write.
 */
export class GuessBudget {
  private readonly entries = new Map<string, { used: number; windowStart: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Takes one guess from `key`'s allowance. False when it is spent: the
   * caller must then refuse without comparing anything. */
  take(key: string, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { used: 1, windowStart: now });
      return true;
    }
    if (entry.used >= this.max) return false;
    entry.used += 1;
    return true;
  }

  /** Whether `key` has no guesses left in its window. */
  spent(key: string, now = Date.now()): boolean {
    const entry = this.entries.get(key);
    return !!entry && now - entry.windowStart < this.windowMs && entry.used >= this.max;
  }

  /** Gives back a guess that turned out not to be one: there was no live
   * code to compare it with. Without this, naming addresses that have no
   * code -- or do not exist -- would fill the map, and would spend real
   * customers' allowances for nothing. */
  refund(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.used -= 1;
    if (entry.used <= 0) this.entries.delete(key);
  }

  /** A correct code: the allowance starts over. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Housekeeping, so the map holds accounts guessed at this window
   * rather than every account since the process started. */
  private prune(now: number): void {
    if (this.entries.size <= 1000) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}

/** The key both budgets use: the address as typed, lowercased and
 * trimmed, so case variants of one address share one allowance. */
export function guessKey(email: string): string {
  return email.trim().toLowerCase();
}
