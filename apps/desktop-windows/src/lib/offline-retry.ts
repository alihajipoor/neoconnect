import { useEffect, useRef, useState } from "react";

/** Asking Neoxify again while a dashboard is running on its cached
 * snapshot.
 *
 * When the dashboard's load gets no answer, the screen falls back to the
 * credentials it saved last time, under a banner saying Neoxify cannot be
 * reached. Nothing used to ask again. On the test VM, with every block
 * lifted, the window in front made no request for two and a half minutes
 * and went on saying "Can't reach Neoxify right now"; a Connect whose
 * device-slot claim and queued reports Neoxify had just answered still
 * showed it above "You're protected", a minute later. Only leaving the
 * screen and coming back cleared it. A banner that says Neoxify is out of
 * reach while it is being reached is the same kind of untruth as a false
 * "protected", and the data under it stayed as old as the cache.
 *
 * So while the screen is on its snapshot, the load is made again in the
 * background: fifteen seconds after the fallback, then thirty, sixty, and
 * every two minutes from then on -- often enough that a block lifting is
 * noticed within a minute or two, rarely enough that a network where
 * Neoxify is blocked for hours is not asked a hundred times an hour. Never
 * two at once, and never beside a load of the screen's own (the mount's,
 * a server switch's): whichever is under way will answer the same
 * question. Not while the app is hidden either: a desktop window minimised
 * to the tray, or a phone's app in the background, asks nothing until it
 * is back in front -- the resume itself is then a reason to ask.
 *
 * And at once, rather than at the next step of the backoff, when there is
 * a reason to think the answer has changed: the network came back
 * (`online`), the app came back to the front (`resume`, at most once
 * every `RESUME_RETRY_GAP_MS`, since a window gets focus every time it is
 * clicked), a tunnel was verified (`tunnel`: the path to Neoxify is a
 * different one now), or Neoxify answered something else this app sent
 * (`answered`: a claim, a report, a renewal). Those are what an answer is
 * most likely to follow, and waiting two minutes after one is the stale
 * banner over again.
 *
 * A load that gets its answer ends the retrying; the screen leaves the
 * snapshot then. One that does not puts the next one at the next step of
 * the backoff, whatever started it. */

/** The waits before the first background loads, in order. */
export const OFFLINE_RETRY_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000];

/** The wait between background loads once the backoff has run out. */
export const OFFLINE_RETRY_EVERY_MS = 120_000;

/** How soon after a background load began the app coming back to the
 * front may start another. A window is focused every time it is clicked;
 * without this, clicking around a window on a blocked network would ask
 * Neoxify on every click. The other reasons to ask at once come from the
 * network, a tunnel or Neoxify itself, and are not held back. */
export const RESUME_RETRY_GAP_MS = 10_000;

/** What started a background load. */
export type OfflineRetryTrigger = "timer" | "online" | "resume" | "tunnel" | "answered";

/** The wait before the next background load, after `failures` of them
 * have gone unanswered. */
export function offlineRetryDelay(failures: number): number {
  return OFFLINE_RETRY_BACKOFF_MS[failures] ?? OFFLINE_RETRY_EVERY_MS;
}

export interface OfflineRetryDeps {
  /** Makes one background load. Resolves true when it got its answer --
   * the screen has left the snapshot, or a newer load of its own will put
   * an answer on screen -- and false when it did not. */
  load(trigger: OfflineRetryTrigger): Promise<boolean>;
  /** Whether a load of the screen's own is under way: the mount's, still
   * waiting behind the snapshot, or a server switch's. */
  busy(): boolean;
  /** Whether the app is out of sight. */
  hidden(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The background loads of one dashboard. Pure apart from what it is
 * given, so the schedule is tested without a screen or a network. */
export class OfflineRetry {
  /** Whether the screen is still mounted. Once it has gone, nothing
   * starts: a load that ends after its screen unmounted -- a sign-out, or
   * Settings opened, while it waited -- would otherwise start retrying for
   * a screen that no longer exists, for as long as the app runs. */
  private attached = true;
  private active = false;
  private failures = 0;
  private timer: unknown = undefined;
  private running = false;
  /** When the last background load began, for `RESUME_RETRY_GAP_MS`. */
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  /** A load fell due while the app was hidden and was not made. The
   * resume makes it, whatever the gap. */
  private dueWhileHidden = false;

  constructor(private readonly deps: OfflineRetryDeps) {}

  /** Whether the screen is on its snapshot and asking again. */
  isActive(): boolean {
    return this.active;
  }

  /** The screen has fallen back to its snapshot. The first background
   * load is due after the first step of the backoff; a screen already
   * retrying keeps its place in it. */
  start(): void {
    if (this.active || !this.attached) return;
    this.active = true;
    this.failures = 0;
    this.dueWhileHidden = false;
    this.schedule();
  }

  /** The screen has its answer, or is going away. A load still under way
   * finishes, and nothing is scheduled after it. */
  stop(): void {
    this.active = false;
    this.dueWhileHidden = false;
    this.cancelTimer();
  }

  /** The screen is mounted (again: React may mount a screen's effects
   * twice). */
  attach(): void {
    this.attached = true;
  }

  /** The screen has unmounted: stopped, and nothing starts again until it
   * is attached. */
  detach(): void {
    this.attached = false;
    this.stop();
  }

  /** Something suggests the answer may have changed: ask now, unless a
   * load is already under way, the app is hidden, or it is only the app
   * coming back to the front again so soon after the last load. */
  trigger(why: Exclude<OfflineRetryTrigger, "timer">): void {
    if (!this.active || this.running || this.deps.busy() || this.deps.hidden()) return;
    if (why === "resume" && !this.dueWhileHidden && this.deps.now() - this.lastStartedAt < RESUME_RETRY_GAP_MS) {
      return;
    }
    this.run(why);
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.fire();
    }, offlineRetryDelay(this.failures));
  }

  private fire(): void {
    if (!this.active) return;
    // Out of sight: nothing is asked, and nothing is scheduled. The
    // resume asks (`trigger`), and the schedule goes on from its answer.
    if (this.deps.hidden()) {
      this.dueWhileHidden = true;
      return;
    }
    // A load of the screen's own is answering the same question. If it
    // fails, the screen is still on its snapshot and this comes round
    // again; if it succeeds, the screen stops this.
    if (this.running || this.deps.busy()) {
      this.schedule();
      return;
    }
    this.run("timer");
  }

  private run(why: OfflineRetryTrigger): void {
    this.cancelTimer();
    this.running = true;
    this.dueWhileHidden = false;
    this.lastStartedAt = this.deps.now();
    void this.deps
      .load(why)
      .catch(() => false)
      .then((answered) => {
        this.running = false;
        if (!this.active) return;
        if (answered) {
          this.stop();
          return;
        }
        this.failures += 1;
        this.schedule();
      });
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }
}

/** A dashboard's `OfflineRetry`, with the browser's own reasons to ask at
 * once wired in: the network coming back (`online`), and the app coming
 * back to the front (`visibilitychange` and `focus` -- a window restored
 * from the tray does not always change visibility). Stopped when the
 * screen unmounts.
 *
 * `load` and `busy` are read through a ref, so the screen can pass inline
 * closures over its current render. */
export function useOfflineRetry(deps: Pick<OfflineRetryDeps, "load" | "busy">): OfflineRetry {
  const latest = useRef(deps);
  latest.current = deps;
  const [retry] = useState(
    () =>
      new OfflineRetry({
        load: (why) => latest.current.load(why),
        busy: () => latest.current.busy(),
        hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }),
  );
  useEffect(() => {
    retry.attach();
    const onResume = () => {
      if (document.visibilityState !== "hidden") retry.trigger("resume");
    };
    const onOnline = () => retry.trigger("online");
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onOnline);
      retry.detach();
    };
  }, [retry]);
  return retry;
}
