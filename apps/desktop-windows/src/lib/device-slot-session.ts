import {
  CLAIM_BUDGET_MS,
  claimSlot,
  DEFAULT_RENEW_EVERY_SEC,
  DEFAULT_STALE_AFTER_SEC,
  LATE_CLAIM_BUDGET_MS,
  releaseSlot,
  RENEW_BUDGET_MS,
  renewSlot,
  refusalReport,
  STANDING_CHECK_BUDGET_MS,
  type ClaimOutcome,
  type ClaimRequest,
  type DeviceLimitRefusal,
  type RenewOutcome,
  type SlotDevice,
  type SlotGrant,
} from "./device-slots";
import type { AttemptReport } from "./attempts";
import type { SlotNotice } from "./device-slot-notice";
import type { SubscriptionStatus } from "./subscription-state";

/** This device's slot, from Connect to Disconnect.
 *
 * Everything a dashboard has to remember about the plan's device limit,
 * and every decision about it, so the screens only wire it up. Both
 * clients use it: the Windows dashboard directly, the mobile one through
 * its `@shared` alias. Pure apart from the three calls it is given, so
 * the whole sequence -- claim, renew, displaced, release, and the claim
 * that could not be made before dialling -- is tested without a tunnel.
 *
 * The contract is docs/device-slots.md. In short:
 *
 *  - `beforeDial` claims a slot. Only a definite refusal stops the dial;
 *    no answer within three seconds means dial anyway.
 *  - `afterConnected` claims again through the tunnel when the first
 *    claim went unanswered, or moves the slot to the credential the
 *    ladder actually landed on.
 *  - `onPoll` renews on the poll the dashboard already runs, every
 *    `renewEverySec`, and reports `displaced` when another device has
 *    the slot. The app then disconnects and does NOT run its ladder.
 *  - `checkStanding` is for an automatic reconnect of a device whose slot
 *    is not confirmed: a degraded tunnel may be the plan's limit rather
 *    than the network (obligation 9).
 *  - `release` on Disconnect, fire and forget.
 */

/** Where this device stands. */
export type SlotStanding =
  /** Nothing claimed: before the first connect, after Disconnect. */
  | "none"
  /** The server granted a slot and is counting it. */
  | "held"
  /** Granted, and nothing is counted: the plan is unlimited. */
  | "unenforced"
  /** Granted, and nothing counted, although the plan has a limit: slots
   * switched off on the server, or a token from before sessions. Either
   * can change while connected -- the switch turned back on, the token
   * refreshed onto a session -- so it is claimed again on the renewal
   * clock until a grant is counted. */
  | "uncounted"
  /** Dialled without an answer to the claim. Asked again through the
   * tunnel, and on every renewal until it is answered. */
  | "unclaimed"
  /** Another device has the slot. */
  | "displaced";

/** What to do about a connect, decided before anything is dialled. */
export type PreDial =
  | { kind: "dial" }
  /** Every slot is in use. Do not dial; show where. */
  | { kind: "refused"; refusal: DeviceLimitRefusal }
  /** Do not dial; show the plan-ended state. */
  | { kind: "inactive"; subscriptionStatus: string | null }
  /** Too many takeovers this hour. Do not dial; say so; do not retry. */
  | { kind: "takeoverLimited"; retryAfterSec: number | null }
  /** The session has ended and the app already knows. Do not dial. */
  | { kind: "signedOut" };

/** What a slot call made while connected says should happen. Anything
 * but `keep` means: disconnect, say why, and do not run the ladder. */
export type SlotEvent =
  | { kind: "keep" }
  | { kind: "displaced"; by: SlotDevice | null; at: string | null }
  /** A claim made after dialling, through the tunnel, was refused: the
   * slots were in use all along. Shown like a refusal before dialling. */
  | { kind: "refused"; refusal: DeviceLimitRefusal }
  | { kind: "inactive"; subscriptionStatus: string | null }
  /** The takeover the customer asked for reached the server only through
   * the tunnel, and was refused there: too many this hour. This device is
   * connected without a slot, so it stops, as it would have before
   * dialling had the claim arrived then. */
  | { kind: "takeoverLimited"; retryAfterSec: number | null }
  | { kind: "signedOut" };

/** The answer to `checkStanding`. */
export type StandingCheck =
  /** The slot is this device's (or there was room and it is now): the
   * degraded tunnel is the network's doing. Run the ladder. */
  | { kind: "clear" }
  /** The API could not be asked. Say so honestly, then run the ladder. */
  | { kind: "unanswered" }
  | Exclude<SlotEvent, { kind: "keep" }>;

/** What a claim's answer comes to. `unanswered` is kept apart from `keep`
 * only for `checkStanding`, which has to say which it was. */
type ClaimSettled =
  | { kind: "keep" }
  | { kind: "unanswered" }
  | Exclude<SlotEvent, { kind: "keep" } | { kind: "displaced" }>;

export interface DeviceSlotDeps {
  claim: typeof claimSlot;
  renew: typeof renewSlot;
  release: typeof releaseSlot;
  now: () => number;
}

/** A renewal may run this much early. The dashboard's poll is every
 * fifteen seconds and its timer drifts; without the slack a renewal due
 * at sixty seconds could wait for the poll at seventy-five. */
const RENEW_SLACK_MS = 3_000;

export interface DeviceSlotSession {
  standing(): SlotStanding;
  /** The plan's limit as last told by the server, if it has said. */
  limit(): number | null;
  beforeDial(request: {
    subscriptionId: string | null | undefined;
    protocolUserId?: string | null;
    takeover?: string[];
    /** `deviceLimit` from `GET /customer/subscriptions`. Explicitly null
     * means unlimited, and the claim is skipped; undefined (an older
     * backend, or not loaded) is not the same and still claims. */
    deviceLimit?: number | null;
  }): Promise<PreDial>;
  afterConnected(request: { protocolUserId?: string | null }): Promise<SlotEvent>;
  onPoll(): Promise<SlotEvent>;
  /** Picks up a tunnel this app did not bring up -- one the service kept
   * while the window was closed. Nothing about its slot is known, so it
   * is claimed on the next poll. */
  adopt(request: { subscriptionId: string | null | undefined; protocolUserId?: string | null; deviceLimit?: number | null }): void;
  /** True when an automatic reconnect should ask first. */
  needsStandingCheck(): boolean;
  checkStanding(): Promise<StandingCheck>;
  /** On Disconnect. Fire and forget; resolves within the release budget. */
  release(): Promise<void>;
  /** Forgets the slot without telling the server -- sign-out releases it
   * there by itself. */
  reset(): void;
}

/** The grant an answer that settled after a release may have left this
 * device holding on the server, by handle.
 *
 * A counted grant names its own. A request that got no answer in time
 * may have arrived all the same; what it left is unknowable, so the
 * best that can be named is the last grant this device was told of --
 * `known` -- which frees the slot if that grant is still the one it is
 * under, and nothing if not. Null: nothing to give back, or nothing that
 * can be named. */
function heldBy(answer: ClaimOutcome | RenewOutcome, known: string | null): string | null {
  switch (answer.kind) {
    case "granted":
    case "held":
      return answer.grant.enforced ? answer.grant.handle : null;
    case "unanswered":
      return answer.retryable ? known : null;
    default:
      return null;
  }
}

export function createDeviceSlotSession(deps: Partial<DeviceSlotDeps> = {}): DeviceSlotSession {
  const claim = deps.claim ?? claimSlot;
  const renew = deps.renew ?? renewSlot;
  const release = deps.release ?? releaseSlot;
  const now = deps.now ?? Date.now;

  let standing: SlotStanding = "none";
  let subscriptionId: string | null = null;
  /** The credential the server was last told about, and the one this
   * device is dialling or has dialled. They differ when the ladder lands
   * somewhere other than where the claim pointed. */
  let claimedProtocolUserId: string | null = null;
  let dialledProtocolUserId: string | null = null;
  let renewEveryMs = DEFAULT_RENEW_EVERY_SEC * 1000;
  let staleAfterMs = DEFAULT_STALE_AFTER_SEC * 1000;
  let limit: number | null = null;
  /** When a claim or renewal last settled, answered or not: the renewal
   * clock, which paces every repeat. */
  let lastAskedAt = 0;
  /** When the server last said this device has its slot. Only a grant or
   * a `held` renewal moves it. An unanswered renewal paces the next one
   * but confirms nothing, and a slot unconfirmed for `staleAfterSec` may
   * already be another device's. */
  let lastConfirmedAt = 0;
  /** The devices the customer chose to take the slot over from ("Use on
   * this device instead"), kept until a claim naming them is answered.
   *
   * On a network where the API answers only through the tunnel, the
   * claim before dialling never arrives. The one sent through the tunnel
   * afterwards has to carry the takeover too, or the server refuses it
   * again in favour of the very device the customer chose to replace --
   * and every press of the button would end the same way. */
  let pendingTakeover: string[] = [];
  /** Whether an unanswered claim is worth repeating. A 404 from a backend
   * that has no slots is not. */
  let retryClaim = true;
  /** Bumped by anything that starts over -- a new connect, a release, a
   * reset -- so an answer still in flight from before cannot land on
   * the slot that replaced it. */
  let epoch = 0;
  /** One call at a time from the poll; a second poll while one is still
   * waiting has nothing to add. */
  let pollInFlight = false;
  /** Claims and renewals still on the wire. See `release`. */
  const inFlight = new Set<Promise<ClaimOutcome | RenewOutcome>>();
  /** The release on the wire, if one is. See `beforeDial`. */
  let releasing: Promise<void> | null = null;
  /** The handle of the latest counted grant the server gave this device,
   * and the subscription it is on. What a release names.
   *
   * Every claim -- even one made while holding the slot -- answers with
   * a new handle, and so does a renewal that gives a lapsed slot back;
   * the server frees a slot on release only when the handle named is
   * the one it is held under now. So a release that lands after the next
   * Connect's claim frees nothing, as it must.
   *
   * Kept across a Disconnect and a new connect, until sign-out: if the
   * release never arrived and the next claim goes unanswered, this grant
   * may still be the one the slot is under, and naming it is the only
   * way to give it back. Naming a grant that has since been replaced
   * frees nothing, so keeping it costs nothing. */
  let lastGrant: { subscriptionId: string; handle: string } | null = null;

  /** The handle a release of `target` names, or null when no grant of
   * this device's on it is known -- and then no release is sent: one
   * naming no grant frees whatever is held, a newer connect's slot
   * included. */
  function knownHandle(target: string): string | null {
    return lastGrant !== null && lastGrant.subscriptionId === target ? lastGrant.handle : null;
  }

  function due(): boolean {
    return now() - lastAskedAt + RENEW_SLACK_MS >= renewEveryMs;
  }

  /** Whether the server confirmed this device's slot within `ms`. */
  function confirmedWithin(ms: number): boolean {
    return lastConfirmedAt > 0 && now() - lastConfirmedAt + RENEW_SLACK_MS < ms;
  }

  function track<T extends ClaimOutcome | RenewOutcome>(request: Promise<T>): Promise<T> {
    inFlight.add(request);
    void request.then(
      () => inFlight.delete(request),
      () => inFlight.delete(request),
    );
    return request;
  }

  /** Releases each grant named, one after another. Several only when
   * answers that settled after a Disconnect named more than one; each
   * frees the slot only if it is still held under that grant. */
  function sendRelease(target: string, handles: string[]): Promise<void> {
    const sent: Promise<void> = (async () => {
      for (const handle of handles) {
        await release({ subscriptionId: target, handle }).catch(() => undefined);
      }
    })().finally(() => {
      if (releasing === sent) releasing = null;
    });
    releasing = sent;
    return sent;
  }

  /** A grant, from a claim or a renewal. */
  function applyGrant(grant: SlotGrant): void {
    const at = now();
    lastAskedAt = at;
    lastConfirmedAt = at;
    if (grant.enforced && grant.handle !== null && subscriptionId !== null) {
      lastGrant = { subscriptionId, handle: grant.handle };
    }
    // Unlimited is the one case nothing will ever count. A limit with
    // nothing counted is a server that may start counting -- see
    // `uncounted`.
    standing = grant.enforced ? "held" : grant.limit === null ? "unenforced" : "uncounted";
    renewEveryMs = grant.renewEverySec * 1000;
    staleAfterMs = grant.staleAfterSec * 1000;
    retryClaim = true;
    // Answered: whatever the takeover was for has happened, or was not
    // needed.
    pendingTakeover = [];
  }

  /** Applies a claim's answer and says what it means. */
  function settleClaim(outcome: ClaimOutcome, protocolUserId: string | null): ClaimSettled {
    lastAskedAt = now();
    switch (outcome.kind) {
      case "granted":
        applyGrant(outcome.grant);
        limit = outcome.grant.limit;
        claimedProtocolUserId = protocolUserId;
        return { kind: "keep" };
      case "unanswered":
        // A claim that was never answered changes nothing about the
        // tunnel; it is asked again on the renewal clock, with the same
        // takeover if it named one.
        if (standing !== "held" && standing !== "unenforced" && standing !== "uncounted") standing = "unclaimed";
        retryClaim = outcome.retryable;
        return { kind: "unanswered" };
      case "refused":
        standing = "none";
        pendingTakeover = [];
        limit = outcome.refusal.limit ?? limit;
        return { kind: "refused", refusal: outcome.refusal };
      case "inactive":
        standing = "none";
        pendingTakeover = [];
        return { kind: "inactive", subscriptionStatus: outcome.subscriptionStatus };
      case "signedOut":
        standing = "none";
        pendingTakeover = [];
        return { kind: "signedOut" };
      case "takeoverLimited":
        // Only a claim naming a takeover gets this. Before dialling it
        // stops the connect; through the tunnel afterwards it means this
        // device is using the VPN without a slot, and stops it the same
        // way.
        standing = "none";
        pendingTakeover = [];
        return { kind: "takeoverLimited", retryAfterSec: outcome.retryAfterSec };
    }
  }

  async function claimNow(protocolUserId: string | null, budgetMs: number): Promise<ClaimSettled> {
    if (subscriptionId === null) return { kind: "keep" };
    const startedIn = epoch;
    const request: ClaimRequest = { subscriptionId, protocolUserId };
    if (pendingTakeover.length > 0) request.takeover = [...pendingTakeover];
    const outcome = await track(claim(request, budgetMs));
    if (startedIn !== epoch) return { kind: "keep" };
    return settleClaim(outcome, protocolUserId);
  }

  /** What a claim made while connected means for the tunnel: an
   * unanswered one changes nothing. */
  function whileConnected(settled: ClaimSettled): SlotEvent {
    return settled.kind === "unanswered" ? { kind: "keep" } : settled;
  }

  async function renewNow(budgetMs: number): Promise<SlotEvent | { kind: "unanswered" }> {
    if (subscriptionId === null) return { kind: "keep" };
    const startedIn = epoch;
    const outcome = await track(renew(subscriptionId, budgetMs));
    if (startedIn !== epoch) return { kind: "keep" };
    switch (outcome.kind) {
      case "held":
        applyGrant(outcome.grant);
        limit = outcome.grant.limit ?? limit;
        return { kind: "keep" };
      case "displaced":
        lastAskedAt = now();
        standing = "displaced";
        pendingTakeover = [];
        return { kind: "displaced", by: outcome.by, at: outcome.at };
      case "inactive":
        standing = "none";
        pendingTakeover = [];
        return { kind: "inactive", subscriptionStatus: outcome.subscriptionStatus };
      case "signedOut":
        standing = "none";
        pendingTakeover = [];
        return { kind: "signedOut" };
      case "unanswered":
        // "A renewal that cannot reach the API changes nothing -- keep
        // the tunnel." Asked again on the next due poll, not sooner --
        // and not counted as a confirmation of anything.
        lastAskedAt = now();
        return { kind: "unanswered" };
    }
  }

  return {
    standing: () => standing,
    limit: () => limit,

    async beforeDial(request) {
      const target = request.subscriptionId ?? null;
      const takeover = request.takeover ?? [];
      const sameSlot = target !== null && target === subscriptionId;

      // Already holding it, and confirmed within a renewal -- a reconnect
      // from the health poll. Claiming again would only keep the slot
      // under a new handle, and would be a request through a tunnel
      // that has just been judged not to carry traffic, which is three
      // seconds of nothing.
      // The next renewal says if it was lost.
      //
      // Only while it is fresh: confirmed by the server, not merely
      // asked about. A slot whose renewals have gone unanswered may have
      // gone stale and been given to another device since, and finding
      // that out by renewal after dialling is exactly the late
      // enforcement claiming first exists to avoid.
      const fresh = standing === "unenforced" || (standing === "held" && confirmedWithin(renewEveryMs));
      if (sameSlot && takeover.length === 0 && fresh) {
        return { kind: "dial" };
      }

      epoch += 1;
      const startedIn = epoch;
      subscriptionId = target;
      standing = "none";
      claimedProtocolUserId = null;
      dialledProtocolUserId = request.protocolUserId ?? null;
      retryClaim = true;
      lastConfirmedAt = 0;
      pendingTakeover = [...takeover];
      if (target === null) {
        // Nothing to claim on. The ladder has nothing to dial either, and
        // it is not this file's place to say so.
        standing = "none";
        pendingTakeover = [];
        return { kind: "dial" };
      }
      if (request.deviceLimit === null && takeover.length === 0) {
        // Unlimited, by the subscription's own word: claiming would be
        // granted unenforced, and on a filtered network it would cost up
        // to three seconds to learn that.
        standing = "unenforced";
        limit = null;
        return { kind: "dial" };
      }
      if (typeof request.deviceLimit === "number") limit = request.deviceLimit;

      // A release still on its way -- Disconnect pressed a moment ago --
      // goes first. Overtaken by it, this claim's slot would be dropped
      // by the server as soon as it was granted. At most the release's
      // own second and a half, and only straight after a Disconnect.
      if (releasing) await releasing;
      if (startedIn !== epoch) return { kind: "dial" };

      const protocolUserId = request.protocolUserId ?? null;
      const outcome = await track(claim({ subscriptionId: target, protocolUserId, takeover }, CLAIM_BUDGET_MS));
      if (startedIn !== epoch) return { kind: "dial" };

      const settled = settleClaim(outcome, protocolUserId);
      return settled.kind === "keep" || settled.kind === "unanswered" ? { kind: "dial" } : settled;
    },

    async afterConnected(request) {
      const protocolUserId = request.protocolUserId ?? dialledProtocolUserId;
      dialledProtocolUserId = protocolUserId;
      if (standing === "unclaimed") {
        // The claim before dialling went unanswered. With the tunnel up,
        // it may get through now -- and on a filtered network the tunnel
        // is the likeliest way to reach the API at all. It carries the
        // customer's takeover, if they chose one.
        //
        // Once even after an answer no repeat was expected to change (a
        // 404, a 409 with no code): the contract asks for this claim
        // whatever the first one got (obligation 2), and through the
        // tunnel it may reach the API by another way. Only repeats on the
        // renewal clock wait for an answer that could change.
        return whileConnected(await claimNow(protocolUserId, LATE_CLAIM_BUDGET_MS));
      }
      if (standing === "held" && protocolUserId !== null && protocolUserId !== claimedProtocolUserId) {
        // The ladder landed on a different credential from the one the
        // claim named. Claiming again keeps the slot (under a new handle,
        // which the grant records) and moves the attribution, so a shared
        // credential's traffic counts as this device's.
        return whileConnected(await claimNow(protocolUserId, LATE_CLAIM_BUDGET_MS));
      }
      return { kind: "keep" };
    },

    async onPoll() {
      if (pollInFlight || !due()) return { kind: "keep" };
      pollInFlight = true;
      try {
        if (standing === "held") {
          const event = await renewNow(RENEW_BUDGET_MS);
          return event.kind === "unanswered" ? { kind: "keep" } : event;
        }
        if ((standing === "unclaimed" || standing === "uncounted") && retryClaim) {
          // Claimed rather than renewed: the claim names the device and
          // the credential, and carries a takeover still owed.
          return whileConnected(await claimNow(dialledProtocolUserId, LATE_CLAIM_BUDGET_MS));
        }
        // `unenforced` is renewed by nobody: harmless and pointless, per
        // the contract, and every request counts on a censored link.
        return { kind: "keep" };
      } finally {
        pollInFlight = false;
      }
    },

    adopt(request) {
      const target = request.subscriptionId ?? null;
      // The same tunnel seen again -- the dashboard remounting after a
      // trip to Settings. What is already known about its slot stands;
      // except `displaced`, which with a tunnel still up means the
      // teardown did not take, and is asked again so it is acted on.
      if (target !== null && target === subscriptionId && standing !== "none" && standing !== "displaced") {
        dialledProtocolUserId ??= request.protocolUserId ?? null;
        return;
      }
      epoch += 1;
      subscriptionId = target;
      claimedProtocolUserId = null;
      dialledProtocolUserId = request.protocolUserId ?? null;
      retryClaim = true;
      lastAskedAt = 0;
      lastConfirmedAt = 0;
      pendingTakeover = [];
      if (subscriptionId === null) {
        standing = "none";
      } else if (request.deviceLimit === null) {
        standing = "unenforced";
      } else {
        // Claimed rather than renewed: the claim names the device and the
        // credential, and a slot that lapsed while the window was closed
        // is granted back if there is room.
        standing = "unclaimed";
      }
    },

    needsStandingCheck() {
      if (subscriptionId === null) return false;
      switch (standing) {
        // Never confirmed, or confirmed as not counted on a plan with a
        // limit. Not for a backend that answered the claim with something
        // no repeat will change (a 404 from one without slots): it has
        // no slot to have lost, and asking would only cost four seconds.
        case "unclaimed":
        case "uncounted":
          return retryClaim;
        // Held, but not confirmed for as long as the server keeps a slot
        // nobody renews: it may be another device's by now.
        case "held":
          return !confirmedWithin(staleAfterMs);
        default:
          return false;
      }
    },

    async checkStanding() {
      if (subscriptionId === null) return { kind: "clear" };
      if (pendingTakeover.length > 0) {
        // The customer chose this device, and the claim saying so has not
        // arrived. Asking who has the slot would only name the device
        // they chose to replace; the claim with the takeover is the
        // question whose answer settles it.
        const settled = await claimNow(dialledProtocolUserId, STANDING_CHECK_BUDGET_MS);
        return settled.kind === "keep" ? { kind: "clear" } : settled;
      }
      // `renew`, as the contract asks: for a device without a slot it
      // answers `displaced` naming who has it, or grants one if there is
      // room -- the same question a claim asks, minus the refusal card.
      const event = await renewNow(STANDING_CHECK_BUDGET_MS);
      return event.kind === "keep" ? { kind: "clear" } : event;
    },

    async release() {
      const target = subscriptionId;
      // `unclaimed` too: the claim may have arrived even though its answer
      // did not. Nothing for `unenforced` or `uncounted` (nothing was
      // recorded) or `displaced` (the slot is already someone else's).
      const held = standing === "held" || standing === "unclaimed";
      epoch += 1;
      const releasedIn = epoch;
      standing = "none";
      subscriptionId = null;
      claimedProtocolUserId = null;
      dialledProtocolUserId = null;
      lastAskedAt = 0;
      lastConfirmedAt = 0;
      pendingTakeover = [];
      if (target === null) return;

      // A claim or renewal still out when Disconnect is pressed can be
      // processed after this release -- slow through a filtered tunnel,
      // or sent again after a token refresh -- and a renewal that finds
      // no slot gives one back when there is room. The server would then
      // count a device that is off, and the customer's phone would be
      // told "in use on Windows PC" for the ninety seconds that takes to
      // go stale. So once whatever was out has settled, the slot is
      // released again, naming the grant the answer left: a counted
      // grant's own handle, or, when no answer came and the request may
      // have arrived anyway, the last one known. Never when anything has
      // started since -- that slot is a new connect's.
      const outstanding = [...inFlight];
      if (outstanding.length > 0) {
        void Promise.all(outstanding).then(
          (answers) => {
            if (epoch !== releasedIn) return;
            const known = knownHandle(target);
            const handles = [
              ...new Set(answers.map((a) => heldBy(a, known)).filter((h): h is string => h !== null)),
            ];
            if (handles.length > 0) void sendRelease(target, handles);
          },
          () => undefined,
        );
      }
      // By the latest grant's handle, and only by it. With none known --
      // a claim that was sent and never answered -- nothing is sent: if
      // that claim arrived, its slot goes stale ninety seconds after the
      // tunnel stops carrying traffic, which "Use on this device instead"
      // covers on the other device; a release naming no grant could free
      // the slot of a Connect pressed in the meantime instead.
      const handle = knownHandle(target);
      if (held && handle !== null) await sendRelease(target, [handle]);
    },

    reset() {
      epoch += 1;
      lastGrant = null;
      standing = "none";
      subscriptionId = null;
      claimedProtocolUserId = null;
      dialledProtocolUserId = null;
      lastAskedAt = 0;
      lastConfirmedAt = 0;
      pendingTakeover = [];
      limit = null;
    },
  };
}

/** The app's one slot.
 *
 * Module-level rather than per screen: the dashboard unmounts whenever
 * Settings is open, and the slot -- and the renewal clock -- belongs to
 * the tunnel, which outlives it. Sign-out forgets it (see
 * `endCustomerSession`); the server releases it there by itself. */
export const deviceSlot: DeviceSlotSession = createDeviceSlotSession();

/** The device limit's card, kept beside the slot rather than in a screen.
 *
 * For the same reason the slot is: the dashboard unmounts whenever
 * Settings is open, and the answers that put a card up do not wait for
 * it. A claim sent through the tunnel can be refused seconds after the
 * connect, and the tunnel comes down whether a screen is there or not.
 * Held in the screen's own state, that card was written to a screen that
 * no longer existed, and the customer came back to a Connect button and
 * no reason. A dashboard that mounts finds it here. Cleared on sign-out
 * with the slot. */
export interface SlotNoticeStore {
  current(): SlotNotice | null;
  set(notice: SlotNotice | null): void;
  /** For `useSyncExternalStore`. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createSlotNoticeStore(): SlotNoticeStore {
  let notice: SlotNotice | null = null;
  const listeners = new Set<() => void>();
  // Closures rather than methods on `this`, so a screen can hand `set`
  // around the way it would a state setter.
  const current = () => notice;
  const set = (next: SlotNotice | null) => {
    if (next === notice) return;
    notice = next;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { current, set, subscribe };
}

export const slotNoticeStore: SlotNoticeStore = createSlotNoticeStore();

/** Anything the slot can say that stops this device: a connect refused
 * before dialling, or a session ended while connected. */
export type SlotStopReason =
  | Exclude<PreDial, { kind: "dial" }>
  | Exclude<SlotEvent, { kind: "keep" }>
  | Exclude<StandingCheck, { kind: "clear" | "unanswered" }>;

/** What a dashboard does about a `SlotStopReason`, worked out once for
 * both clients. */
export interface SlotStop {
  /** The card to show, or null (a sign-out: the app is already on its
   * way to the sign-in screen, and there is nothing to add). */
  notice: SlotNotice | null;
  /** The attempt report, when a connect was stopped -- REJECTED with no
   * ladder, so it records no dial, marks no route as failing and teaches
   * nothing about this network's best route. Null for a session ended
   * while connected, whose connect was already reported as it happened.
   * A late refusal is reported: it is the answer the connect never got. */
  report: AttemptReport | null;
  /** A status to show the plan-ended state for, when the subscription
   * has stopped. Null when the server named none this app knows. */
  subscriptionStatus: SubscriptionStatus | null;
  /** Whether the subscription has stopped, named or not. */
  inactive: boolean;
}

const STATUSES: readonly SubscriptionStatus[] = ["ACTIVE", "SUSPENDED", "EXPIRED", "PENDING", "CANCELLED"];

export function slotStop(reason: SlotStopReason, when: "beforeDial" | "whileConnected"): SlotStop {
  const none = { notice: null, report: null, subscriptionStatus: null, inactive: false };
  switch (reason.kind) {
    case "refused":
      return { ...none, notice: { kind: "refused", refusal: reason.refusal }, report: refusalReport("DEVICE_LIMIT") };
    case "takeoverLimited":
      return {
        ...none,
        notice: { kind: "takeoverLimited", retryAfterSec: reason.retryAfterSec },
        report: refusalReport("TAKEOVER_LIMIT"),
      };
    case "displaced":
      return { ...none, notice: { kind: "displaced", by: reason.by, at: reason.at } };
    case "inactive":
      return {
        ...none,
        report: when === "beforeDial" ? refusalReport("SUBSCRIPTION_INACTIVE") : null,
        subscriptionStatus: STATUSES.find((s) => s === reason.subscriptionStatus && s !== "ACTIVE") ?? null,
        inactive: true,
      };
    case "signedOut":
      return none;
  }
}
