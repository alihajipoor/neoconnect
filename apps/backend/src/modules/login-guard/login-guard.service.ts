import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mint, verify, type Challenge, type Solution } from "./proof-of-work";

/**
 * Which login surface a challenge belongs to. Kept separate so a
 * customer's failures never raise the bar for an admin, or vice versa.
 * RESELLER signs in through the admin panel (M25) and is listed here so
 * it is not forgotten when that role lands.
 */
export type LoginScope = "admin" | "customer" | "reseller";

/**
 * Difficulty in leading zero bits, by how much recent failure the
 * account or address has accumulated.
 *
 * Roughly: each bit doubles the work. 12 bits is ~4k hashes, which a
 * browser does in a few milliseconds and a customer never perceives.
 * 21 bits is ~2M hashes -- a second or two once, which is a fair price
 * after twenty failures, and ruinous for anyone trying passwords in
 * bulk.
 *
 * The floor is deliberately not zero. A challenge is required on the
 * very first attempt, because the alternative is a free first guess per
 * source, and a distributed attacker with many addresses would take
 * exactly that.
 */
const DIFFICULTY_STEPS: Array<{ atFailures: number; bits: number }> = [
  { atFailures: 0, bits: 12 },
  { atFailures: 3, bits: 15 },
  { atFailures: 6, bits: 17 },
  { atFailures: 10, bits: 19 },
  { atFailures: 20, bits: 21 },
];

/** Failures are forgotten this long after the last one. */
const FAILURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Failures before a challenge stops being optional.
 *
 * This threshold exists entirely for the clients already installed on
 * customers' machines. Below it an attempt with no challenge is allowed
 * through; at or above it, a solution is mandatory and a client that
 * cannot produce one is refused.
 *
 * Five sits well above human mistyping and well below anything worth
 * calling an attack, and the window is only 30 minutes. The cost of it
 * is real and worth stating plainly: an attacker gets five free guesses
 * per account and five per source address per window.
 *
 * SET `LOGIN_CHALLENGE_GRACE_FAILURES=0` TO CLOSE IT. That is the whole
 * removal -- no code change, no redeploy of anything but the variable.
 *
 * It is not zero by default today because zero locks out every live
 * beta customer, which was checked rather than assumed on 2026-08-14:
 * `git cat-file -e desktop-v0.9.4:apps/desktop-windows/src/lib/pow.ts`
 * fails, and so does the android-v0.2.9 equivalent. pow.ts landed on
 * 2026-08-12; the newest tag of either client is 2026-08-11. So NO
 * released build can solve a challenge, and flipping this to 0 would
 * refuse the very first sign-in attempt from every one of them -- not
 * only attempts after a failure. Already-signed-in apps keep working on
 * their refresh tokens; anyone who signs out, reinstalls, or adds a
 * device is locked out until a new release.
 *
 * Flip it the day a desktop and an Android build carrying pow.ts are
 * released and the beta testers are on them.
 */
const CHALLENGE_GRACE_DEFAULT_FAILURES = 5;

/** How often expired bookkeeping is swept out. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface FailureRecord {
  count: number;
  expiresAt: number;
}

/**
 * Rate-limiting that IP throttling cannot do on its own.
 *
 * The existing @Throttle decorators cap requests per address. That is
 * necessary and now actually works (trust proxy was fixed on
 * 2026-08-12, before which every caller shared one bucket), but it is
 * blind in both directions:
 *
 *   - An attacker spread across many addresses gets a full budget from
 *     each one, all aimed at a SINGLE account. Per-address limits never
 *     see that pattern; per-account tracking is the only thing that
 *     does.
 *   - Carrier-grade NAT puts a great many legitimate users behind one
 *     address. That is routine on Iranian mobile networks, which is a
 *     large share of this product's customers. Tightening the per-IP
 *     limit enough to stop a real attack would start rejecting real
 *     people sharing an address with them.
 *
 * So this tracks the account as well as the source, and responds by
 * making attempts EXPENSIVE rather than by blocking them.
 *
 * WHY NOT ACCOUNT LOCKOUT. Locking an account after N failures hands
 * anyone who knows a customer's email address a reliable way to deny
 * them their own account -- they simply fail login a few times, on
 * purpose, whenever the victim might want to sign in. The protection
 * becomes the attack. Escalating proof of work has the property lockout
 * is reaching for (each additional guess costs more than the last)
 * without the property that makes lockout dangerous (a legitimate
 * customer with the right password always gets in; they just wait a
 * moment longer).
 */
@Injectable()
export class LoginGuardService {
  private readonly logger = new Logger(LoginGuardService.name);

  /** Recent failures keyed by scope + hashed account identifier. */
  private readonly accountFailures = new Map<string, FailureRecord>();
  /** Recent failures keyed by scope + source address. */
  private readonly sourceFailures = new Map<string, FailureRecord>();
  /** Challenge ids already redeemed, so a solution cannot be replayed. */
  private readonly spentChallenges = new Map<string, number>();

  /** Recent failures tolerated before a solution becomes mandatory. */
  private readonly graceFailures: number;

  constructor(@Optional() config?: ConfigService) {
    const configured = config?.get<number>("loginGuard.challengeGraceFailures");
    this.graceFailures =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 0
        ? configured
        : CHALLENGE_GRACE_DEFAULT_FAILURES;

    if (this.graceFailures === 0) {
      this.logger.log("Proof of work is required on every sign-in attempt (no grace).");
    }

    // Bookkeeping is process-local and intentionally so: it holds
    // minutes of counters, not durable records, and a restart merely
    // returns everyone to baseline difficulty. Worth knowing if the
    // backend is ever scaled past one instance -- counters would then
    // be per-instance and an attacker could round-robin between them.
    // There is one instance today (infra/docker-compose.prod.yml).
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
  }

  /**
   * Email addresses are hashed before being used as a map key.
   *
   * The counters would otherwise be an in-memory list of addresses that
   * recently failed to sign in -- which is customer data, and would end
   * up in any heap dump or debugger session for no benefit. A hash
   * counts just as well.
   */
  private accountKey(scope: LoginScope, email: string): string {
    const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("base64url");
    return `${scope}:${digest}`;
  }

  private countFor(map: Map<string, FailureRecord>, key: string): number {
    const record = map.get(key);
    if (!record) return 0;
    if (Date.now() > record.expiresAt) {
      map.delete(key);
      return 0;
    }
    return record.count;
  }

  private bump(map: Map<string, FailureRecord>, key: string): void {
    const existing = map.get(key);
    const expiresAt = Date.now() + FAILURE_WINDOW_MS;
    if (!existing || Date.now() > existing.expiresAt) {
      map.set(key, { count: 1, expiresAt });
      return;
    }
    existing.count += 1;
    // Slide the window forward, so sustained pressure keeps the
    // difficulty raised instead of decaying under a steady trickle.
    existing.expiresAt = expiresAt;
  }

  private difficultyFor(failures: number): number {
    let bits = DIFFICULTY_STEPS[0].bits;
    for (const step of DIFFICULTY_STEPS) {
      if (failures >= step.atFailures) bits = step.bits;
    }
    return bits;
  }

  /**
   * Mint a challenge for a login attempt.
   *
   * Difficulty follows whichever is worse -- the account's recent
   * failures or the source's. An attacker gets no relief by rotating
   * addresses (the account counter follows the target) or by switching
   * targets (the source counter follows them).
   *
   * The email is optional and the response never varies by whether it
   * names a real account: this endpoint is unauthenticated, so any
   * difference in what it returns would turn it into an oracle for
   * which addresses are registered.
   */
  issue(scope: LoginScope, email: string | undefined, ip: string): Challenge {
    const byAccount = email ? this.countFor(this.accountFailures, this.accountKey(scope, email)) : 0;
    const bySource = this.countFor(this.sourceFailures, `${scope}:${ip}`);
    return mint(this.difficultyFor(Math.max(byAccount, bySource)));
  }

  /**
   * Check a submitted solution, or reject the attempt.
   *
   * Throws BadRequest rather than Unauthorized so a missing or stale
   * challenge reads as "retry this request", not "your password is
   * wrong" -- the client can transparently fetch a new challenge and
   * resubmit without telling the customer anything happened.
   */
  enforce(scope: LoginScope, solution: Solution | undefined, email: string | undefined, ip: string): void {
    const failures = Math.max(
      email ? this.countFor(this.accountFailures, this.accountKey(scope, email)) : 0,
      this.countFor(this.sourceFailures, `${scope}:${ip}`),
    );

    if (!solution) {
      // Let it through while nothing suspicious has happened, so the
      // clients already in customers' hands keep working. Zero grace
      // means every attempt must carry a solution. See
      // CHALLENGE_GRACE_DEFAULT_FAILURES.
      if (failures < this.graceFailures) return;
      throw new BadRequestException(
        "Too many recent sign-in attempts. Please sign in at neoxify.net, or wait 30 minutes and try again.",
      );
    }

    const result = verify(solution);
    if (!result.ok) {
      throw new BadRequestException(result.reason);
    }

    // Single use. Without this a challenge solved once could be
    // replayed for every guess until it expired, which would reduce the
    // whole mechanism to a two-minute speed bump.
    if (this.spentChallenges.has(solution.id)) {
      throw new BadRequestException("This security check was already used. Please try again.");
    }
    this.spentChallenges.set(solution.id, solution.expiresAt);

    // Reject a solution that was minted easier than this attempt now
    // warrants. Challenges are handed out before the attempt, so one
    // obtained while the counters were low must not still be spendable
    // after failures have raised the bar -- otherwise an attacker would
    // simply stockpile cheap challenges before starting.
    if (solution.difficulty < this.difficultyFor(failures)) {
      throw new BadRequestException("This security check is out of date. Please try again.");
    }
  }

  /** Record a failed sign-in, raising the cost of the next attempt. */
  recordFailure(scope: LoginScope, email: string, ip: string): void {
    this.bump(this.accountFailures, this.accountKey(scope, email));
    this.bump(this.sourceFailures, `${scope}:${ip}`);

    const failures = this.countFor(this.accountFailures, this.accountKey(scope, email));
    // Logged without the address -- the point is to notice an account
    // under sustained attack, which the hash serves equally well.
    if (failures === 10 || failures === 25 || failures === 50) {
      this.logger.warn(
        `${failures} failed ${scope} sign-ins for one account within the window (source ${ip})`,
      );
    }
  }

  /** Clear an account's counter after a genuine sign-in. */
  recordSuccess(scope: LoginScope, email: string): void {
    this.accountFailures.delete(this.accountKey(scope, email));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.accountFailures) {
      if (now > record.expiresAt) this.accountFailures.delete(key);
    }
    for (const [key, record] of this.sourceFailures) {
      if (now > record.expiresAt) this.sourceFailures.delete(key);
    }
    for (const [id, expiresAt] of this.spentChallenges) {
      if (now > expiresAt) this.spentChallenges.delete(id);
    }
  }
}
