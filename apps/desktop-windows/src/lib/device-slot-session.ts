import {
  CLAIM_BUDGET_MS,
  claimSlot,
  DEFAULT_RENEW_EVERY_SEC,
  LATE_CLAIM_BUDGET_MS,
  releaseSlot,
  RENEW_BUDGET_MS,
  renewSlot,
  STANDING_CHECK_BUDGET_MS,
  type ClaimOutcome,
  type DeviceLimitRefusal,
  type SlotDevice,
} from "./device-slots";

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
 *    was never confirmed: a degraded tunnel may be the plan's limit
 *    rather than the network (obligation 9).
 *  - `release` on Disconnect, fire and forget.
 */

/** Where this device stands. */
export type SlotStanding =
  /** Nothing claimed: before the first connect, after Disconnect. */
  | "none"
  /** The server granted a slot and is counting it. */
  | "held"
  /** Granted, and nothing is counted: an unlimited plan, or slots off. */
  | "unenforced"
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
  | { kind: "signedOut" };

/** The answer to `checkStanding`. */
export type StandingCheck =
  /** The slot is this device's (or there was room and it is now): the
   * degraded tunnel is the network's doing. Run the ladder. */
  | { kind: "clear" }
  /** The API could not be asked. Say so honestly, then run the ladder. */
  | { kind: "unanswered" }
  | Exclude<SlotEvent, { kind: "keep" }>;

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
  let limit: number | null = null;
  /** When the server last answered for this slot, or when an unanswered
   * claim was last tried -- either way, when the next one is due from. */
  let lastAskedAt = 0;
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

  function due(): boolean {
    return now() - lastAskedAt + RENEW_SLACK_MS >= renewEveryMs;
  }

  /** Applies a claim's answer and says what it means once connected. */
  function settleClaim(outcome: ClaimOutcome, protocolUserId: string | null): SlotEvent {
    lastAskedAt = now();
    switch (outcome.kind) {
      case "granted":
        standing = outcome.grant.enforced ? "held" : "unenforced";
        renewEveryMs = outcome.grant.renewEverySec * 1000;
        limit = outcome.grant.limit;
        claimedProtocolUserId = protocolUserId;
        return { kind: "keep" };
      case "unanswered":
        // A claim that was never answered changes nothing about the
        // tunnel; it is asked again on the renewal clock.
        if (standing !== "held" && standing !== "unenforced") standing = "unclaimed";
        retryClaim = outcome.retryable;
        return { kind: "keep" };
      case "refused":
        standing = "none";
        limit = outcome.refusal.limit ?? limit;
        return { kind: "refused", refusal: outcome.refusal };
      case "inactive":
        standing = "none";
        return { kind: "inactive", subscriptionStatus: outcome.subscriptionStatus };
      case "signedOut":
        standing = "none";
        return { kind: "signedOut" };
      case "takeoverLimited":
        // Only a claim with `takeover` gets this, and these claims carry
        // none. Not a verdict on this device's slot.
        return { kind: "keep" };
    }
  }

  async function claimNow(protocolUserId: string | null, budgetMs: number): Promise<SlotEvent> {
    if (subscriptionId === null) return { kind: "keep" };
    const startedIn = epoch;
    const outcome = await claim({ subscriptionId, protocolUserId }, budgetMs);
    if (startedIn !== epoch) return { kind: "keep" };
    return settleClaim(outcome, protocolUserId);
  }

  async function renewNow(budgetMs: number): Promise<SlotEvent | { kind: "unanswered" }> {
    if (subscriptionId === null) return { kind: "keep" };
    const startedIn = epoch;
    const outcome = await renew(subscriptionId, budgetMs);
    if (startedIn !== epoch) return { kind: "keep" };
    switch (outcome.kind) {
      case "held":
        lastAskedAt = now();
        standing = outcome.grant.enforced ? "held" : "unenforced";
        renewEveryMs = outcome.grant.renewEverySec * 1000;
        limit = outcome.grant.limit ?? limit;
        return { kind: "keep" };
      case "displaced":
        lastAskedAt = now();
        standing = "displaced";
        return { kind: "displaced", by: outcome.by, at: outcome.at };
      case "inactive":
        standing = "none";
        return { kind: "inactive", subscriptionStatus: outcome.subscriptionStatus };
      case "signedOut":
        standing = "none";
        return { kind: "signedOut" };
      case "unanswered":
        // "A renewal that cannot reach the API changes nothing -- keep
        // the tunnel." Asked again on the next due poll, not sooner.
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

      // Already holding it -- a reconnect from the health poll. Claiming
      // again would be idempotent, and would also be a request through a
      // tunnel that has just been judged not to carry traffic, which is
      // three seconds of nothing. The next renewal says if it was lost.
      if (sameSlot && takeover.length === 0 && (standing === "held" || standing === "unenforced")) {
        return { kind: "dial" };
      }

      epoch += 1;
      subscriptionId = target;
      standing = "none";
      claimedProtocolUserId = null;
      dialledProtocolUserId = request.protocolUserId ?? null;
      retryClaim = true;
      if (target === null) {
        // Nothing to claim on. The ladder has nothing to dial either, and
        // it is not this file's place to say so.
        standing = "none";
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

      const protocolUserId = request.protocolUserId ?? null;
      const startedIn = epoch;
      const outcome = await claim({ subscriptionId: target, protocolUserId, takeover }, CLAIM_BUDGET_MS);
      if (startedIn !== epoch) return { kind: "dial" };

      switch (outcome.kind) {
        case "takeoverLimited":
          standing = "none";
          return { kind: "takeoverLimited", retryAfterSec: outcome.retryAfterSec };
        case "granted":
        case "unanswered": {
          settleClaim(outcome, protocolUserId);
          return { kind: "dial" };
        }
        default: {
          const event = settleClaim(outcome, protocolUserId);
          // settleClaim maps the three remaining kinds one to one.
          return event as Exclude<PreDial, { kind: "dial" } | { kind: "takeoverLimited" }>;
        }
      }
    },

    async afterConnected(request) {
      const protocolUserId = request.protocolUserId ?? dialledProtocolUserId;
      dialledProtocolUserId = protocolUserId;
      if (standing === "unclaimed" && retryClaim) {
        // The claim before dialling went unanswered. With the tunnel up,
        // it may get through now -- and on a filtered network the tunnel
        // is the likeliest way to reach the API at all.
        return await claimNow(protocolUserId, LATE_CLAIM_BUDGET_MS);
      }
      if (standing === "held" && protocolUserId !== null && protocolUserId !== claimedProtocolUserId) {
        // The ladder landed on a different credential from the one the
        // claim named. Claiming again is idempotent (same slot, same
        // handle) and moves the attribution, so a shared credential's
        // traffic counts as this device's.
        return await claimNow(protocolUserId, LATE_CLAIM_BUDGET_MS);
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
        if (standing === "unclaimed" && retryClaim) {
          return await claimNow(dialledProtocolUserId, LATE_CLAIM_BUDGET_MS);
        }
        // `unenforced` is renewed by nobody: harmless and pointless, per
        // the contract, and every request counts on a censored link.
        return { kind: "keep" };
      } finally {
        pollInFlight = false;
      }
    },

    adopt(request) {
      epoch += 1;
      subscriptionId = request.subscriptionId ?? null;
      claimedProtocolUserId = null;
      dialledProtocolUserId = request.protocolUserId ?? null;
      retryClaim = true;
      lastAskedAt = 0;
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
      // Not for a backend that answered the claim with something no
      // repeat will change (a 404 from one without slots): it has no
      // slot to have lost, and asking would only cost four seconds.
      return standing === "unclaimed" && retryClaim && subscriptionId !== null;
    },

    async checkStanding() {
      if (subscriptionId === null) return { kind: "clear" };
      // `renew`, as the contract asks: for a device without a slot it
      // answers `displaced` naming who has it, or grants one if there is
      // room -- the same question a claim asks, minus the refusal card.
      const event = await renewNow(STANDING_CHECK_BUDGET_MS);
      return event.kind === "keep" ? { kind: "clear" } : event;
    },

    async release() {
      const target = subscriptionId;
      const held = standing === "held" || standing === "unclaimed";
      epoch += 1;
      standing = "none";
      subscriptionId = null;
      claimedProtocolUserId = null;
      dialledProtocolUserId = null;
      lastAskedAt = 0;
      // `unclaimed` too: the claim may have arrived even though its answer
      // did not. Nothing for `unenforced` (nothing was recorded) or
      // `displaced` (the slot is already someone else's).
      if (held && target !== null) await release(target);
    },

    reset() {
      epoch += 1;
      standing = "none";
      subscriptionId = null;
      claimedProtocolUserId = null;
      dialledProtocolUserId = null;
      lastAskedAt = 0;
      limit = null;
    },
  };
}
