/** Reconnecting by itself after a tunnel drops that nobody asked to end.
 *
 * Owner decision 2026-10-07: when the tunnel ends on its own -- an engine
 * that crashed, a WireGuard tunnel service that stopped, a RAS hang-up,
 * Android's :xray process dying, an iOS extension stopping -- the app
 * reconnects instead of waiting for the customer to press Connect. Until
 * then it said "VPN connection lost" within a second or two and waited.
 *
 * What does not change, and is the reason this file is shaped the way it
 * is:
 *
 *  - **Fail open.** Nothing here blocks traffic while the tunnel is
 *    down. The screen says so instead: "Reconnecting..." with a hint that
 *    traffic is going out without Neoxify until it is back.
 *  - **No claim without evidence.** A reconnect is an ordinary ladder
 *    pass, judged by the same egress check as a press of Connect. This
 *    module never says "connected"; it only learns from the pass that one
 *    landed.
 *  - **The customer outranks it.** Any press -- Connect, Disconnect, the
 *    stop line, a change of mode or server -- ends an episode at once and
 *    the press does what it says.
 *
 * Pure apart from what it is given (`ReconnectDeps`), so the whole
 * sequence -- a drop, the backoff, a network that goes away and comes
 * back, a pass that lands, an engine that keeps dying the moment it
 * starts -- is tested without a tunnel, a timer or a screen. Both
 * dashboards use the one instance at the bottom, the mobile one through
 * its `@shared` alias; each binds the pass it knows how to run.
 *
 * One per app rather than per screen, like `ladderPass`: the dashboard
 * unmounts whenever Settings opens, and an episode under way must not be
 * forgotten -- or, worse, started twice -- by the screen mounted on
 * return.
 */

import { reportAttempt, type AttemptReport } from "./attempts";
import { sessionGeneration } from "./session-end";

/** How long to wait before each attempt, by attempt number.
 *
 * The first is immediate: most drops are an engine that ended, on a
 * network that is fine, and every second spent waiting is a second of
 * traffic going out in the clear. After that the gaps widen, so a
 * network that is genuinely refusing every protocol is not hammered --
 * each attempt is a whole ladder pass, which on a filtered network can
 * be tens of seconds of dialling on its own. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

/** At most this many passes per drop: one per entry above. */
export const RECONNECT_MAX_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

/** No new attempt is started once this much time has gone on the
 * episode -- the backoff waited plus the passes themselves. A pass
 * already running is never interrupted for it; the budget only decides
 * whether another one starts.
 *
 * Time spent waiting for a network, or (on a phone) for the app to come
 * back to the front, does not count. Those waits burn nothing, and a
 * reconnect is most useful exactly when a network that went away comes
 * back. They have their own ceiling: `BLOCKED_WAIT_MAX_MS`. */
export const RECONNECT_BUDGET_MS = 120_000;

/** A tunnel that ends within this long of coming up died "right after
 * starting". */
export const QUICK_DEATH_MS = 60_000;

/** Consecutive quick deaths after which the app stops reconnecting.
 *
 * Without it an engine that crashes a few seconds into every session --
 * a bad config, a node rejecting the credential mid-handshake -- would be
 * rebuilt in a loop for as long as the app is open, each one a fresh
 * claim of "Reconnecting..." that nothing is going to make true. Three
 * running is past coincidence. */
export const QUICK_DEATHS_TO_STOP = 3;

/** The longest an episode waits for a network, or for a phone app to be
 * in front of the customer, before giving up.
 *
 * Long, because coming back after the network does is the point. Not
 * for ever: a drop the customer has been away from for half an hour is
 * not a blip any more -- they may have turned the VPN off in the
 * system's own settings meanwhile, which this app cannot see -- and the
 * honest answer then is "VPN connection lost" and a Connect button, not
 * a tunnel coming back on its own long after. */
export const BLOCKED_WAIT_MAX_MS = 30 * 60_000;

/** The longest one attempt is waited for before it is counted as failed.
 *
 * A ladder pass is bounded rung by rung, and its guard expires after
 * `LADDER_MAX_MS` without progress -- but a pass wedged on a call that
 * never returns never resolves its promise either, and an episode waiting
 * on it would say "Reconnecting..." for as long as the app stayed open.
 * Past this, the attempt is a failure like any other (and by then the
 * budget is spent, so the episode ends and says the connection was
 * lost); whatever the wedged pass reports afterwards is ignored. Longer
 * than a pass's own guard, so no live pass is given up on. */
export const ATTEMPT_MAX_MS = 180_000;

/** Why an episode ended without a tunnel -- or never started. */
export type ReconnectStop =
  /** A press that takes over: Connect, Disconnect, stopping a pass, a
   * change of mode or server. What the customer asked for happens
   * instead, so nothing is said about the episode on screen. */
  | "customer"
  /** The customer pressed "Stop reconnecting". */
  | "stopped"
  /** The session ended: sign-out, account deletion, a refused refresh. */
  | "signedOut"
  /** Every attempt was used. */
  | "attempts"
  /** The time budget was used. */
  | "budget"
  /** The tunnel died right after coming up, `QUICK_DEATHS_TO_STOP` times
   * running. */
  | "quickDeaths"
  /** The plan's device limit refused this device, or another device took
   * the slot over. Its card says where. */
  | "refused"
  /** The plan stopped: subscription inactive, quota used up. */
  | "notEntitled"
  /** A phone's VPN permission is gone: the system, or another VPN app,
   * holds it now. Not taken back without asking. */
  | "permission"
  /** A phone is still routed through a VPN that is not ours. */
  | "otherVpn"
  /** No network, or the app in the background, for longer than
   * `BLOCKED_WAIT_MAX_MS`. */
  | "waitedTooLong"
  /** Something about the moment rules a reconnect out: gaming mode, a
   * teardown of the app's own, nothing usable to dial. */
  | "excluded";

/** One drop, from the moment it was seen to the moment it ends. */
export interface Episode {
  /** The route the tunnel was on, which the first pass leads with. Null
   * when the tunnel was adopted rather than brought up here. */
  readonly routeId: string | null;
  /** Consecutive quick deaths, this drop included. */
  readonly quickDeaths: number;
  /** The customer session the tunnel belonged to. */
  readonly session: number;
  readonly droppedAt: number;
  /** Backoff waited and passes run so far, for `RECONNECT_BUDGET_MS`. */
  readonly spentMs: number;
}

export type ReconnectPhase =
  /** Nothing to reconnect. `lost` asks the screen to say "VPN connection
   * lost" while nothing is up: an episode ended without a tunnel and the
   * customer has not pressed anything since. */
  | { readonly kind: "idle"; readonly lost: boolean; readonly stopped: ReconnectStop | null }
  /** A tunnel the screen vouches for, which would be reconnected if it
   * dropped. */
  | {
      readonly kind: "armed";
      readonly since: number;
      readonly routeId: string | null;
      readonly quickDeaths: number;
      readonly session: number;
    }
  /** Between attempts. `blockedBy` is set while there is no network, or a
   * phone app is in the background: the attempt runs as soon as that
   * changes, and the wait costs no attempt and no budget. */
  | {
      readonly kind: "waiting";
      /** Zero-based: the attempt that runs next. */
      readonly attempt: number;
      readonly dueAt: number;
      /** The backoff this wait stands for, counted towards the budget
       * when the attempt starts. Zero once a blocked wait paused it. */
      readonly delayMs: number;
      readonly blockedBy: "network" | "foreground" | null;
      readonly blockedSince: number | null;
      readonly episode: Episode;
    }
  /** A pass is running. */
  | { readonly kind: "attempting"; readonly attempt: number; readonly startedAt: number; readonly episode: Episode };

/** What a screen is told about an attempt it is asked to run. */
export interface ReconnectAttempt {
  /** One-based, for people. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The route to lead with: the one the tunnel was on. */
  readonly resumeRouteId: string | null;
}

/** How an attempt went. */
export type ReconnectOutcome =
  /** A pass landed, judged exactly as a press of Connect is. */
  | { readonly kind: "connected"; readonly routeId: string | null }
  /** The pass ran and nothing carried; the next attempt may. */
  | { readonly kind: "failed" }
  /** Nothing more to try; see `ReconnectStop`. */
  | { readonly kind: "stop"; readonly why: ReconnectStop };

export type ReconnectRunner = (attempt: ReconnectAttempt) => Promise<ReconnectOutcome>;

export interface ReconnectDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Whether the device has a network at all. */
  online(): boolean;
  /** Whether the app is in front of the customer. */
  foreground(): boolean;
  /** The customer session in force -- `sessionGeneration`. */
  session(): number;
  /** Telemetry, fire and forget. */
  report(report: AttemptReport): void;
}

const IDLE: ReconnectPhase = { kind: "idle", lost: false, stopped: null };

/** Whether an episode that ended this way leaves "VPN connection lost"
 * to be said. A press that took over has its own outcome to show, and a
 * session that ended has no screen. */
export function lostAfter(why: ReconnectStop): boolean {
  return why !== "customer" && why !== "signedOut";
}

/** Plain words for the telemetry, so a row reads without this file. */
const STOP_WORDS: Record<ReconnectStop, string> = {
  customer: "the customer pressed something, which took over",
  stopped: "the customer pressed Stop reconnecting",
  signedOut: "the session ended",
  attempts: `every attempt was used (${RECONNECT_MAX_ATTEMPTS})`,
  budget: `the time budget was used (${RECONNECT_BUDGET_MS / 1000}s)`,
  quickDeaths: `the tunnel died within ${QUICK_DEATH_MS / 1000}s of coming up ${QUICK_DEATHS_TO_STOP} times running`,
  refused: "the plan's device limit refused this device",
  notEntitled: "the plan does not allow a connection now",
  permission: "the VPN permission is no longer this app's",
  otherVpn: "another VPN holds the device",
  waitedTooLong: `no network, or the app in the background, for over ${BLOCKED_WAIT_MAX_MS / 60_000} minutes`,
  excluded: "a reconnect was ruled out at the moment of the drop",
};

/** The start of every reconnect report's `reason`.
 *
 * The backend's DTO is fixed -- `kind` and `outcome` are enums a current
 * server refuses to extend -- so an automatic reconnect cannot have a
 * kind of its own without a backend release first. It is told apart by
 * this prefix instead, which is always at the start of `reason` and so
 * survives the 500-character cut. */
export const RECONNECT_REASON_PREFIX = "auto-reconnect";

/** A ladder pass's report, marked as an automatic reconnect.
 *
 * A pass that landed stays SUCCESS -- it is one, and the per-ISP data
 * reads only its rungs -- with the reason saying it was automatic, so it
 * is not counted as somebody pressing Connect. A pass that did not land
 * becomes OTHER, with what it would have been kept in the reason: an
 * automatic retry on a network that is down is not a customer's failed
 * connect, and up to six of them per drop would swamp the numbers the
 * panel filters on. The rungs go as they are; the backend keeps each
 * customer's latest dial per route, so retries add no weight. */
export function asReconnectReport(report: AttemptReport, attempt: ReconnectAttempt | undefined): AttemptReport {
  if (!attempt) return report;
  const tag = `${RECONNECT_REASON_PREFIX} attempt ${attempt.attempt} of at most ${attempt.maxAttempts} after the tunnel dropped`;
  if (report.outcome === "SUCCESS") {
    return { ...report, reason: report.reason ? `${tag}; ${report.reason}` : tag };
  }
  return {
    ...report,
    outcome: "OTHER",
    reason: `${tag}: did not connect (${report.outcome})${report.reason ? `; ${report.reason}` : ""}`,
  };
}

/** Error kinds that mean the plan, not the network, said no -- see the
 * dashboard's `NOT_THE_NETWORK`. Retrying cannot change them. */
const NOT_ENTITLED_KINDS = new Set(["concurrentLimit", "quotaExhausted", "subscriptionInactive"]);

/** What a ladder pass came to, as an attempt's outcome.
 *
 *  - `declined`: another pass held the guard (the mid-session failover,
 *    or one a remounted screen adopted). Counted as a failed attempt, so
 *    an episode can never spin on it.
 *  - `cancelled`: the customer stopped the pass. The press itself has
 *    already ended the episode; this only makes sure it stays ended.
 *  - `unusable`: nothing this build can dial.
 */
export function reconnectOutcomeOf(
  ladder: "connected" | "failed" | "declined" | "refused" | "cancelled" | "unusable",
  { errorKind = null, routeId = null }: { errorKind?: string | null; routeId?: string | null } = {},
): ReconnectOutcome {
  switch (ladder) {
    case "connected":
      return { kind: "connected", routeId };
    case "refused":
      return { kind: "stop", why: "refused" };
    case "cancelled":
      return { kind: "stop", why: "customer" };
    case "unusable":
      return { kind: "stop", why: "excluded" };
    case "declined":
      return { kind: "failed" };
    case "failed":
      return errorKind !== null && NOT_ENTITLED_KINDS.has(errorKind)
        ? { kind: "stop", why: "notEntitled" }
        : { kind: "failed" };
  }
}

/** What the screen needs to word the episode. Null when there is none. */
export interface ReconnectingView {
  /** Waiting for a network, rather than for the next attempt. */
  readonly offline: boolean;
  /** Between attempts (as opposed to one running): the moment a press of
   * the orb means "reconnect now". */
  readonly waiting: boolean;
}

export function reconnectingView(phase: ReconnectPhase): ReconnectingView | null {
  switch (phase.kind) {
    case "waiting":
      return { offline: phase.blockedBy === "network", waiting: true };
    case "attempting":
      return { offline: false, waiting: false };
    default:
      return null;
  }
}

/** Whether the screen should say "VPN connection lost" on the
 * controller's word -- an episode that ended without a tunnel. */
export function reconnectLost(phase: ReconnectPhase): boolean {
  return phase.kind === "idle" && phase.lost;
}

/** Whether the app is vouching for a tunnel that, if it dropped, would be
 * reconnected: what a screen mounting with nothing on it yet uses in
 * place of "what it was showing" -- see `droppedUnseen`. */
export function vouching(phase: ReconnectPhase): boolean {
  return phase.kind === "armed";
}

export class AutoReconnect {
  private phase: ReconnectPhase = IDLE;
  private timer: unknown = null;
  private capTimer: unknown = null;
  private runner: ReconnectRunner | null = null;
  /** Bumped by every move out of `attempting`, so an outcome that comes
   * back after the episode was ended or superseded is ignored. */
  private token = 0;
  private readonly listeners = new Set<() => void>();
  private requiresForeground = false;

  constructor(private readonly deps: ReconnectDeps) {}

  // Arrow properties so they can be handed to useSyncExternalStore as
  // they are.
  readonly current = (): ReconnectPhase => this.phase;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether an attempt has to wait for the app to be in front. True on
   * the phones, where a pass started in the background is one the OS may
   * freeze half-way (iOS suspends the app within seconds) and where no
   * background work of this kind exists to do it. False on Windows,
   * where a minimised window is still a running app. */
  setRequiresForeground(requires: boolean): void {
    this.requiresForeground = requires;
  }

  /** The pass the mounted screen knows how to run. A due attempt with no
   * screen bound waits for one. Returns the unbind. */
  bind(runner: ReconnectRunner): () => void {
    this.runner = runner;
    this.kick();
    return () => {
      if (this.runner === runner) this.runner = null;
    };
  }

  /** A tunnel the screen vouches for is up.
   *
   * `fresh` when this app has just brought it up -- a pass landed -- so
   * the quick-death clock starts now. Otherwise (a tunnel adopted from
   * the service) an armed tunnel keeps its clock, and an idle controller
   * arms -- unless the customer's own press is what left it idle. A
   * Disconnect whose teardown did not finish leaves a tunnel up that the
   * customer asked to be rid of; the screen re-reading it on return from
   * Settings must not make its later death something to reconnect.
   *
   * Ignored while an attempt runs: that attempt's own outcome is what
   * arms, carrying the quick-death count. While waiting, a tunnel that
   * is somehow up again ends the episode -- there is nothing left to
   * reconnect, and the next attempt would tear it down to redial. */
  tunnelUp({ routeId, fresh = false }: { routeId: string | null; fresh?: boolean }): void {
    const now = this.deps.now();
    switch (this.phase.kind) {
      case "attempting":
        return;
      case "armed":
        if (!fresh) {
          if (routeId !== null && routeId !== this.phase.routeId) this.set({ ...this.phase, routeId });
          return;
        }
        this.set({ kind: "armed", since: now, routeId, quickDeaths: 0, session: this.deps.session() });
        return;
      case "waiting":
        this.clearTimers();
        this.set({
          kind: "armed",
          since: now,
          routeId: routeId ?? this.phase.episode.routeId,
          quickDeaths: this.phase.episode.quickDeaths,
          session: this.phase.episode.session,
        });
        return;
      case "idle":
        if (!fresh && (this.phase.stopped === "customer" || this.phase.stopped === "stopped")) return;
        this.set({ kind: "armed", since: now, routeId, quickDeaths: 0, session: this.deps.session() });
        return;
    }
  }

  /** The tunnel the screen was vouching for has gone, and the screen's
   * own rule (`droppedFromPoll` on Windows) agrees nobody of ours asked.
   *
   * `exclusion` is anything the screen knows that rules a reconnect out
   * at this moment: the device limit having ended the session, a plan no
   * longer active, gaming mode, a sign-out under way.
   *
   * Returns whether an episode began. "lost" means the screen says "VPN
   * connection lost" and waits for the customer, as before. */
  dropped({ exclusion = null }: { exclusion?: ReconnectStop | null } = {}): "reconnecting" | "lost" {
    // An episode already under way: an engine a failed pass left running
    // (shown as "degraded") has died too. The episode goes on, and its
    // next pass tears down whatever is left anyway.
    if (this.phase.kind === "waiting" || this.phase.kind === "attempting") return "reconnecting";
    if (this.phase.kind !== "armed") return "lost";
    const armed = this.phase;
    const now = this.deps.now();
    if (this.deps.session() !== armed.session) {
      this.stop("signedOut", 0);
      return "lost";
    }
    if (exclusion !== null) {
      this.stop(exclusion, 0);
      return "lost";
    }
    const quickDeaths = now - armed.since < QUICK_DEATH_MS ? armed.quickDeaths + 1 : 0;
    if (quickDeaths >= QUICK_DEATHS_TO_STOP) {
      this.stop("quickDeaths", 0);
      return "lost";
    }
    this.schedule(0, { routeId: armed.routeId, quickDeaths, session: armed.session, droppedAt: now, spentMs: 0 });
    return "reconnecting";
  }

  /** Ends an episode -- or forgets an armed tunnel -- because of
   * something the customer, or the session, did.
   *
   * When idle there is no episode to end, and only one thing to do: a
   * press that takes over (`customer`, or a sign-out) retires a "VPN
   * connection lost" left by an earlier episode, since what the press
   * does next is the news now. Anything else leaves idle as it is, so a
   * second call cannot re-word how an episode already ended. */
  cancel(why: ReconnectStop): void {
    if (this.phase.kind === "idle") {
      if (this.phase.lost && !lostAfter(why)) this.set({ kind: "idle", lost: false, stopped: why });
      return;
    }
    if (this.phase.kind === "armed") {
      // Not an episode, so nothing is reported -- but remembered, so a
      // re-read of the same tunnel cannot arm it again (see `tunnelUp`).
      this.set({ kind: "idle", lost: false, stopped: why });
      return;
    }
    this.stop(why, this.attemptsMade());
  }

  /** The screen has stopped vouching for a tunnel without a drop: an
   * automatic pass of the app's own (the mid-session failover) ended
   * with nothing up, or a re-read found nothing where the screen could
   * not tell before ("Can't tell right now"). Neither is a drop by the
   * screen's rule, so an armed tunnel is simply forgotten -- left armed,
   * the next screen to mount would take the service's "nothing is
   * running" for a drop it had missed. Episodes are left alone. */
  forget(): void {
    if (this.phase.kind === "armed") this.set(IDLE);
  }

  /** The network or the app's visibility may have changed. */
  conditionsChanged(): void {
    if (this.phase.kind !== "waiting") return;
    const blocker = this.blocker();
    const waiting = this.phase;
    if (blocker !== null && waiting.blockedBy === null) {
      // Gone offline, or to the background, mid-backoff: the wait pauses
      // here rather than spending an attempt on a pass that cannot work.
      this.clearTimers();
      this.block(waiting.attempt, waiting.episode, blocker, this.deps.now());
      return;
    }
    if (blocker === null && waiting.blockedBy !== null) {
      this.kick();
      return;
    }
    if (blocker !== null && waiting.blockedBy !== null && blocker !== waiting.blockedBy) {
      this.set({ ...waiting, blockedBy: blocker });
    }
  }

  /** For tests: back to a fresh app. */
  reset(): void {
    this.clearTimers();
    this.token += 1;
    this.phase = IDLE;
    this.runner = null;
    this.requiresForeground = false;
  }

  private blocker(): "network" | "foreground" | null {
    if (!this.deps.online()) return "network";
    if (this.requiresForeground && !this.deps.foreground()) return "foreground";
    return null;
  }

  private attemptsMade(): number {
    if (this.phase.kind === "waiting") return this.phase.attempt;
    if (this.phase.kind === "attempting") return this.phase.attempt + 1;
    return 0;
  }

  private schedule(attempt: number, episode: Episode): void {
    this.clearTimers();
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      this.stop("attempts", attempt);
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[attempt] ?? 0;
    if (attempt > 0 && episode.spentMs + delay >= RECONNECT_BUDGET_MS) {
      this.stop("budget", attempt);
      return;
    }
    const now = this.deps.now();
    const blocker = this.blocker();
    if (blocker !== null) {
      this.block(attempt, episode, blocker, now);
      return;
    }
    this.set({ kind: "waiting", attempt, dueAt: now + delay, delayMs: delay, blockedBy: null, blockedSince: null, episode });
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.kick();
    }, delay);
  }

  private block(attempt: number, episode: Episode, blocker: "network" | "foreground", now: number): void {
    const since =
      this.phase.kind === "waiting" && this.phase.blockedSince !== null ? this.phase.blockedSince : now;
    // The scheduled delay is not owed once the wait was paused: the
    // attempt runs as soon as the network, or the app, is back.
    this.set({ kind: "waiting", attempt, dueAt: now, delayMs: 0, blockedBy: blocker, blockedSince: since, episode });
    const left = Math.max(0, BLOCKED_WAIT_MAX_MS - (now - since));
    this.capTimer = this.deps.setTimer(() => {
      this.capTimer = null;
      if (this.phase.kind === "waiting" && this.phase.blockedBy !== null) {
        this.stop("waitedTooLong", this.phase.attempt);
      }
    }, left);
  }

  /** Starts the due attempt, if one is due and everything it needs is
   * there. Called by the backoff timer, by a screen binding, and when
   * the network or the app comes back. */
  private kick(): void {
    if (this.phase.kind !== "waiting") return;
    const waiting = this.phase;
    const now = this.deps.now();
    if (this.deps.session() !== waiting.episode.session) {
      this.stop("signedOut", waiting.attempt);
      return;
    }
    if (waiting.blockedBy !== null) {
      if (waiting.blockedSince !== null && now - waiting.blockedSince >= BLOCKED_WAIT_MAX_MS) {
        this.stop("waitedTooLong", waiting.attempt);
        return;
      }
      const blocker = this.blocker();
      if (blocker !== null) {
        if (blocker !== waiting.blockedBy) this.set({ ...waiting, blockedBy: blocker });
        return;
      }
    } else {
      if (this.timer !== null || now < waiting.dueAt) return;
      const blocker = this.blocker();
      if (blocker !== null) {
        this.block(waiting.attempt, waiting.episode, blocker, now);
        return;
      }
    }
    const runner = this.runner;
    if (runner === null) {
      // No screen to run it. Unblocked and due, so the next bind starts
      // it at once.
      if (waiting.blockedBy !== null) {
        this.clearTimers();
        this.set({ ...waiting, blockedBy: null, blockedSince: null, dueAt: now });
      }
      return;
    }
    this.clearTimers();
    // The backoff counts towards the budget only when it was actually
    // waited out, not when a blocked wait was cut short by the network
    // coming back (`block` zeroes it).
    const episode = { ...waiting.episode, spentMs: waiting.episode.spentMs + waiting.delayMs };
    void this.run(runner, waiting.attempt, episode);
  }

  private async run(runner: ReconnectRunner, attempt: number, episode: Episode): Promise<void> {
    const token = ++this.token;
    const startedAt = this.deps.now();
    this.set({ kind: "attempting", attempt, startedAt, episode });
    let watchdog: unknown = null;
    let outcome: ReconnectOutcome;
    try {
      outcome = await Promise.race([
        runner({
          attempt: attempt + 1,
          maxAttempts: RECONNECT_MAX_ATTEMPTS,
          resumeRouteId: episode.routeId,
        }),
        new Promise<ReconnectOutcome>((resolve) => {
          watchdog = this.deps.setTimer(() => resolve({ kind: "failed" }), ATTEMPT_MAX_MS);
        }),
      ]);
    } catch {
      outcome = { kind: "failed" };
    } finally {
      if (watchdog !== null) this.deps.clearTimer(watchdog);
    }
    // Ended or superseded while it ran -- a press, a sign-out. Whatever
    // that did stands.
    if (token !== this.token || this.phase.kind !== "attempting") return;
    const now = this.deps.now();
    switch (outcome.kind) {
      case "connected":
        this.token += 1;
        this.set({
          kind: "armed",
          since: now,
          routeId: outcome.routeId ?? episode.routeId,
          quickDeaths: episode.quickDeaths,
          session: episode.session,
        });
        return;
      case "stop":
        this.stop(outcome.why, attempt + 1);
        return;
      case "failed":
        this.token += 1;
        this.schedule(attempt + 1, { ...episode, spentMs: episode.spentMs + Math.max(0, now - startedAt) });
        return;
    }
  }

  private stop(why: ReconnectStop, attemptsMade: number): void {
    this.clearTimers();
    this.token += 1;
    this.set({ kind: "idle", lost: lostAfter(why), stopped: why });
    // Every episode that does not end in a tunnel says so once, so a
    // drop is never invisible in the data: one that ended in a tunnel is
    // already there, as the SUCCESS of the pass that landed it. A
    // sign-out has nobody to attribute it to.
    if (why === "signedOut") return;
    this.deps.report({
      kind: "CONNECT",
      outcome: "OTHER",
      reason:
        attemptsMade === 0
          ? `${RECONNECT_REASON_PREFIX} not attempted after the tunnel dropped: ${STOP_WORDS[why]}`
          : `${RECONNECT_REASON_PREFIX} stopped after ${attemptsMade} attempt(s): ${STOP_WORDS[why]}`,
    });
  }

  private clearTimers(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.capTimer !== null) {
      this.deps.clearTimer(this.capTimer);
      this.capTimer = null;
    }
  }

  private set(next: ReconnectPhase): void {
    this.phase = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One screen's trouble is not the episode's.
      }
    }
  }
}

/** The app's one episode at a time, and its clock.
 *
 * `online()` is the browser's own `navigator.onLine`: false when the OS
 * reports no network at all, which is the case worth waiting out
 * (Wi-Fi gone, airplane mode, the cable out). It is true on a network
 * that is up but filtering everything, and that is right too -- there
 * the passes are the only way to find out. */
export const autoReconnect = new AutoReconnect({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  foreground: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  session: () => sessionGeneration(),
  report: (report) => void reportAttempt(report),
});

// The moments a blocked wait can end. Registered once, for the life of
// the app: the instance outlives every screen.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const changed = () => autoReconnect.conditionsChanged();
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", changed);
  }
}
