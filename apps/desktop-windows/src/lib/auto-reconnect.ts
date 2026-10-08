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
 *    stop line, a change of mode or server, a repair -- ends an episode at
 *    once, a pass it was dialling included, and the press does what it
 *    says.
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
 * back. They have their own ceiling: `BLOCKED_WAIT_MAX_MS`. Nor does the
 * time a phone app spends in the background while a pass runs: the OS
 * freezes the pass meanwhile, so that time is the customer's, not the
 * pass's (see `awayChanged`). */
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
 * a tunnel coming back on its own long after. The same for a pass the
 * phone app was away from that long (`awayChanged`). */
export const BLOCKED_WAIT_MAX_MS = 30 * 60_000;

/** The longest one attempt is waited for without a sign of life before it
 * is counted as failed.
 *
 * A ladder pass is bounded rung by rung, and its guard expires after
 * `LADDER_MAX_MS` without progress -- but a pass wedged on a call that
 * never returns never resolves its promise either, and an episode waiting
 * on it would say "Reconnecting..." for as long as the app stayed open.
 * Past this, the attempt is a failure like any other (and by then the
 * budget is spent, so the episode ends and says the connection was
 * lost); whatever the wedged pass reports afterwards is ignored.
 *
 * Measured the way the guard is, from the pass's last sign of life
 * (`ReconnectAttempt.progress`, at every rung), and not from its start.
 * From the start it caught live passes too: the number of rungs is not
 * capped, and on a filtered network a pass with eight or so credentials
 * is still dialling at three minutes. The episode was ended on the budget
 * beneath it, "Stop reconnecting" went from the screen, and when the pass
 * landed its tunnel was armed by nothing -- a reconnect's pass leaves that
 * to the episode -- so its next drop said "VPN connection lost" and
 * reconnected nothing. Longer than the guard, so no pass the guard still
 * counts as live is given up on here. Held while a phone app is in the
 * background: see `awayChanged`. */
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
  /** A phone is still routed through a VPN that is not ours -- or, on an
   * iPhone, which cannot see another app's VPN, another VPN configuration
   * has been chosen over every one of ours. */
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
   * changes, and the wait costs no attempt and no budget.
   *
   * Unblocked, the attempt is due when its backoff timer has fired, and
   * not by any reading of the clock. The phase used to carry a `dueAt`
   * from `Date.now()`, checked against `Date.now()` again when the timer
   * fired -- two clocks, the timer's monotonic and the wall clock that
   * steps. A wall clock set back during the wait (a time sync, a phone's
   * network time, the customer correcting it) made the timer's firing
   * read as early: nothing was started and nothing rescheduled, and the
   * screen said "Reconnecting..." for good with nothing dialling. */
  | {
      readonly kind: "waiting";
      /** Zero-based: the attempt that runs next. */
      readonly attempt: number;
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
  /** Whether this attempt is still the episode's current one, for the
   * session it began under. False from the moment anything ends or moves
   * the episode on -- a press, a sign-out, the device limit, the
   * attempt's own ceiling -- and never true again.
   *
   * The episode ignores what a superseded attempt reports, but that alone
   * cannot stop it dialling: a pass that awaits anything before it dials
   * (the phone asks the platform two questions first) would otherwise
   * bring a tunnel up after the customer said stop. So a pass asks this
   * after every await, and stops when it is false. */
  readonly live: () => boolean;
  /** The pass is still alive and moving: called as it begins each rung,
   * beside `ladderPass.progress`. The attempt's ceiling (`ATTEMPT_MAX_MS`)
   * starts again from here, so a long ladder on a filtered network is
   * waited for while a step that never returns is still given up on.
   * Nothing once the attempt is over. */
  readonly progress: () => void;
}

/** Whether a ladder pass has been told to stop: the stop flag a press
 * sets (`ladderPass.cancel`), or -- for a pass an automatic reconnect
 * started -- its attempt no longer live.
 *
 * Both, because they are reached by different things. The flag is set by
 * what stops a pass directly -- the orb, "Stop reconnecting", a new
 * location or a repair during an attempt, a sign-out, the device limit.
 * The attempt ends with anything that ends its episode or moves it on --
 * those, and a change of mode, an expired session, the attempt's own
 * ceiling. The Windows pass asked only the flag, which a repair and a new
 * location did not set then: it went on dialling the old order behind
 * them, and brought a tunnel up after the repair or on the old server. */
export function passStopped(cancelled: boolean, attempt: ReconnectAttempt | undefined): boolean {
  return cancelled || (attempt !== undefined && !attempt.live());
}

/** What a location chosen from the server list asks of the screen; see
 * `AutoReconnect.chose`. */
export type LocationChoice =
  /** An attempt was dialling: stop its pass, as a press of the orb does. */
  | "stopPass"
  /** A tunnel the app vouches for is up, and stays up and armed: go on
   * naming the route it is on. */
  | "keepTunnel"
  /** Nothing up and nothing dialling. */
  | null;

/** How an attempt went. */
export type ReconnectOutcome =
  /** A pass landed, judged exactly as a press of Connect is. */
  | { readonly kind: "connected"; readonly routeId: string | null }
  /** The pass ran and nothing carried; the next attempt may. */
  | { readonly kind: "failed" }
  /** Nothing more to try; see `ReconnectStop`. */
  | { readonly kind: "stop"; readonly why: ReconnectStop };

export type ReconnectRunner = (attempt: ReconnectAttempt) => Promise<ReconnectOutcome>;

/** When a pass began, or the service was asked what is up: how many
 * times the controller had been overruled (`cancel`) by then, and the
 * customer session in force. An answer hands it back to `tunnelUp` when
 * it comes. See `AutoReconnect.stamp`. */
export interface ReconnectStamp {
  readonly overrules: number;
  readonly session: number;
}

/** What `tunnelUp` is told. A tunnel this app has just brought up quotes
 * the stamp its pass took as it began, always: whether that pass has been
 * overruled since is the one thing the controller cannot work out for
 * itself, and a landing that does not say is one that cannot be told. */
export type TunnelUp =
  | { readonly routeId: string | null; readonly fresh: true; readonly stamp: ReconnectStamp }
  | { readonly routeId: string | null; readonly fresh?: false; readonly stamp?: ReconnectStamp };

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

/** What the controller keeps of the attempt running, for as long as it
 * runs: its ceiling, and the time a phone app has spent away from it. */
interface RunningAttempt {
  /** The controller's token while it is the current attempt. */
  readonly token: number;
  /** Counts the attempt as failed: its ceiling has run out. */
  giveUp: () => void;
  /** The ceiling's timer. Null while the app is away. */
  watchdog: unknown;
  /** When a phone app went to the background during the attempt, while
   * it is there. */
  awaySince: number | null;
  /** How long it had spent there before that, in all. */
  awayMs: number;
}

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
 * place of "what it was showing" -- see `droppedUnseen`.
 *
 * Only for the session in force. A session that ended by expiring, from
 * a screen that never got to say so, can leave a tunnel armed; signing in
 * again, the first screen would otherwise find it gone -- the sign-out
 * took it down -- and greet the customer with "VPN connection lost". */
export function vouching(phase: ReconnectPhase, session: number): boolean {
  return phase.kind === "armed" && phase.session === session;
}

export class AutoReconnect {
  private phase: ReconnectPhase = IDLE;
  private timer: unknown = null;
  private capTimer: unknown = null;
  private runner: ReconnectRunner | null = null;
  /** Bumped by every move out of `attempting`, so an outcome that comes
   * back after the episode was ended or superseded is ignored. */
  private token = 0;
  /** Bumped by every `cancel` -- a press that takes over, "Stop
   * reconnecting", a sign-out, the device limit -- so an answer asked for
   * before one can tell it has been overruled. See `stamp`. */
  private overrules = 0;
  /** The attempt running. Left behind by one a press ended while its pass
   * never answered, so it is the current attempt only while its token is
   * the controller's. */
  private running: RunningAttempt | null = null;
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

  /** The pass the mounted screen knows how to run, bound once the screen
   * can run one -- its load finished, not merely mounted. A due attempt
   * with no screen bound waits for one, unspent, and starts the moment one
   * binds, so a screen that bound before it had its credentials would have
   * that attempt at once and could only waste it. Returns the unbind. */
  bind(runner: ReconnectRunner): () => void {
    this.runner = runner;
    this.kick();
    return () => {
      if (this.runner === runner) this.runner = null;
    };
  }

  /** Taken as a pass begins -- after the press that began it, if a press
   * did -- or as the service is asked what is up, and handed back to
   * `tunnelUp` with the answer.
   *
   * An answer can come back after the customer has overruled it. A pass
   * spends seconds verifying, and a stop pressed meanwhile cannot recall a
   * request already in flight through a tunnel that carries it. On Windows
   * such a pass landed anyway and armed the tunnel the stop was taking
   * down, and the next screen to mount -- back from Settings -- found it
   * gone, said "VPN connection lost" and dialled. Not everything that
   * overrules a pass can reach it, either: a session that expires ends
   * where no screen can tell it. The stamp is how any answer, from any
   * screen, finds out. */
  stamp(): ReconnectStamp {
    return { overrules: this.overrules, session: this.deps.session() };
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
   * Nothing at all for an answer overruled since its `stamp` was taken --
   * by a press, "Stop reconnecting", a sign-out or the device limit -- or
   * one asked for under a session that has since ended. Whatever overruled
   * it owns what is up now: a tunnel the customer was just told is going
   * away is not one to bring back, and one armed under the next sign-in's
   * session would greet it with "VPN connection lost".
   *
   * Ignored while an attempt runs: that attempt's own outcome is what
   * arms, carrying the quick-death count. While waiting, a tunnel that
   * is somehow up again ends the episode -- there is nothing left to
   * reconnect, and the next attempt would tear it down to redial. */
  tunnelUp(up: TunnelUp): void {
    const { routeId, stamp } = up;
    const fresh = up.fresh === true;
    if (stamp !== undefined && (stamp.overrules !== this.overrules || stamp.session !== this.deps.session())) return;
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
    // Whatever phase it finds: a pass the customer started, already
    // running when they pressed again, is as overruled as an episode.
    this.overrules += 1;
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

  /** A location, or Automatic, chosen from the server list.
   *
   * The list opens only while nothing is up, but nothing closes it when
   * the episode moves on beneath it: an attempt can start while the
   * customer is reading it, and land. So the choice can find any phase,
   * and what it means differs:
   *
   *  - Between attempts it ends the episode, whose next attempt would lead
   *    with the old route regardless. Connect dials the new choice.
   *  - During one it ends the episode, and the screen is to stop the pass
   *    as a press of the orb does. Ended here alone, the pass went on
   *    dialling the old order and landed on the old server.
   *  - Over a tunnel the app vouches for it changes nothing about that
   *    tunnel: the choice is for the next connect, the tunnel is still
   *    reconnected if it drops, and the screen goes on naming its route.
   *    Treated as a press that takes over, it disarmed the tunnel, and its
   *    next drop said "VPN connection lost" for the rest of its life.
   *  - Idle, as any press: an old "VPN connection lost" is retired. */
  chose(): LocationChoice {
    if (this.phase.kind === "armed") return "keepTunnel";
    const dialling = this.phase.kind === "attempting";
    this.cancel("customer");
    return dialling ? "stopPass" : null;
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
    if (this.phase.kind === "attempting") {
      this.awayChanged();
      return;
    }
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
    // Bumped rather than zeroed: nothing asked before the reset may arm.
    this.overrules += 1;
    this.phase = IDLE;
    this.runner = null;
    this.running = null;
    this.requiresForeground = false;
  }

  /** A phone app gone to the background, or back to the front, while a
   * pass runs.
   *
   * The OS freezes the pass meanwhile -- iOS within seconds -- so the time
   * is not the pass's, and charging it as such ended episodes that had
   * barely begun. A customer who looked away for two and a half minutes
   * came back to an attempt charged 150 s of a 120 s budget: "VPN
   * connection lost", five attempts unspent. Three minutes away, and the
   * attempt's ceiling fell due in the background, ending the episode
   * beneath a pass about to go on dialling, whose tunnel then came up
   * armed by nothing.
   *
   * So while the app is away the ceiling is held, and starts again in
   * full when it is back -- the pass has had no time to show a sign of
   * life -- and the budget is charged only for the time in front. Away for
   * `BLOCKED_WAIT_MAX_MS`, the attempt ends there as a blocked wait would,
   * its pass with it: a tunnel coming back on its own half an hour after
   * the customer last saw "Reconnecting..." is not a reconnect any more.
   *
   * Not on Windows, where a minimised window is still a running app and
   * its pass goes on dialling. */
  private awayChanged(): void {
    const running = this.running;
    if (!this.requiresForeground || running === null || running.token !== this.token) return;
    if (this.phase.kind !== "attempting") return;
    const now = this.deps.now();
    const away = !this.deps.foreground();
    if (away && running.awaySince === null) {
      running.awaySince = now;
      this.watch(running);
      if (this.capTimer !== null) this.deps.clearTimer(this.capTimer);
      this.capTimer = this.deps.setTimer(() => {
        this.capTimer = null;
        if (running.token === this.token && running.awaySince !== null && this.phase.kind === "attempting") {
          this.stop("waitedTooLong", this.attemptsMade());
        }
      }, BLOCKED_WAIT_MAX_MS);
      return;
    }
    if (!away && running.awaySince !== null) {
      const awayFor = Math.max(0, now - running.awaySince);
      // Checked here as well as by the timer above, which a frozen app
      // does not run until it is back -- possibly after this.
      if (awayFor >= BLOCKED_WAIT_MAX_MS) {
        this.stop("waitedTooLong", this.attemptsMade());
        return;
      }
      running.awayMs += awayFor;
      running.awaySince = null;
      if (this.capTimer !== null) {
        this.deps.clearTimer(this.capTimer);
        this.capTimer = null;
      }
      this.watch(running);
    }
  }

  /** Starts an attempt's ceiling again -- as it begins, at every sign of
   * life, and as a phone app comes back to the front -- or holds it while
   * the app is away. On the timer's clock alone, which only goes forward.
   *
   * Falling due while the app is away means its going there was never
   * heard (a phone can freeze the app first): that is taken as the moment
   * it went, rather than as a pass that gave no sign of life. */
  private watch(running: RunningAttempt): void {
    if (running.watchdog !== null) this.deps.clearTimer(running.watchdog);
    running.watchdog =
      running.awaySince !== null
        ? null
        : this.deps.setTimer(() => {
            running.watchdog = null;
            if (running.token === this.token && this.requiresForeground && !this.deps.foreground()) {
              this.awayChanged();
              return;
            }
            running.giveUp();
          }, ATTEMPT_MAX_MS);
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

  /** `awaySince`: when a phone app went to the background during the
   * attempt that just failed, if it is there still -- the wait that
   * follows has been blocked since then, for `BLOCKED_WAIT_MAX_MS`. */
  private schedule(attempt: number, episode: Episode, awaySince: number | null = null): void {
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
      this.block(attempt, episode, blocker, now, awaySince);
      return;
    }
    this.set({ kind: "waiting", attempt, delayMs: delay, blockedBy: null, blockedSince: null, episode });
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.kick();
    }, delay);
  }

  private block(
    attempt: number,
    episode: Episode,
    blocker: "network" | "foreground",
    now: number,
    awaySince: number | null = null,
  ): void {
    const since =
      awaySince ?? (this.phase.kind === "waiting" && this.phase.blockedSince !== null ? this.phase.blockedSince : now);
    // The scheduled delay is not owed once the wait was paused: the
    // attempt runs as soon as the network, or the app, is back.
    this.set({ kind: "waiting", attempt, delayMs: 0, blockedBy: blocker, blockedSince: since, episode });
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
      // The backoff is over when its timer has fired, whatever the wall
      // clock says (see `waiting`). Until then, nothing to do: a screen
      // binding mid-backoff waits for it like everyone else.
      if (this.timer !== null) return;
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
        this.set({ ...waiting, blockedBy: null, blockedSince: null });
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
    // Every move out of `attempting` bumps the token, so this is false for
    // good once anything has ended or replaced the attempt. The session
    // too: one that ended where no screen could tell the episode (an
    // expired session, from App) still ends what this attempt may do.
    const live = () =>
      token === this.token && this.phase.kind === "attempting" && this.deps.session() === episode.session;
    const running: RunningAttempt = { token, giveUp: () => undefined, watchdog: null, awaySince: null, awayMs: 0 };
    this.running = running;
    let outcome: ReconnectOutcome;
    try {
      outcome = await new Promise<ReconnectOutcome>((resolve, reject) => {
        running.giveUp = () => resolve({ kind: "failed" });
        // The ceiling, started now and again at every sign of life.
        this.watch(running);
        runner({
          attempt: attempt + 1,
          maxAttempts: RECONNECT_MAX_ATTEMPTS,
          resumeRouteId: episode.routeId,
          live,
          progress: () => {
            if (live()) this.watch(running);
          },
        }).then(resolve, reject);
      });
    } catch {
      outcome = { kind: "failed" };
    } finally {
      if (running.watchdog !== null) this.deps.clearTimer(running.watchdog);
      running.watchdog = null;
      if (this.running === running) this.running = null;
    }
    // Ended or superseded while it ran -- a press, a sign-out. Whatever
    // that did stands.
    if (token !== this.token || this.phase.kind !== "attempting") return;
    const now = this.deps.now();
    // Time a phone app spent in the background is the customer's, not the
    // pass's (`awayChanged`).
    const awayMs = running.awayMs + (running.awaySince !== null ? Math.max(0, now - running.awaySince) : 0);
    switch (outcome.kind) {
      case "connected":
        // The ceiling on a background stay, if the pass landed in one.
        this.clearTimers();
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
        this.schedule(
          attempt + 1,
          { ...episode, spentMs: episode.spentMs + Math.max(0, now - startedAt - awayMs) },
          running.awaySince,
        );
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
