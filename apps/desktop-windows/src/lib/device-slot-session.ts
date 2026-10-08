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
import { isTunnelUp } from "./connection-evidence";
import type { SlotNotice } from "./device-slot-notice";
import type { SubscriptionStatus } from "./subscription-state";
import type { ConnectionState } from "../components/ConnectOrb";

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
 *  - `release` on Disconnect, fire and forget. `setAside` gives the slot
 *    back the same way while a phone's reconnect waits for the app to be
 *    opened, and leaves that reconnect to ask first.
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
   * tunnel, and on every renewal until it is answered. Also a slot given
   * back while a reconnect waits (`setAside`): nothing is held, and
   * whether one is to be had is asked before anything is dialled. */
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
  /** No verdict on the slot. Say so honestly, then run the ladder.
   * `noAnswer`: nothing came back at all, so Neoxify may be said to have
   * been out of reach. Otherwise it answered -- a 5xx, a 404, a 429, a
   * 200 this app cannot read -- and only did not confirm this device's
   * slot; "could not reach" would be untrue then. */
  | { kind: "unanswered"; noAnswer: boolean }
  | Exclude<SlotEvent, { kind: "keep" }>;

/** What a claim's answer comes to. `unanswered` is kept apart from `keep`
 * only for `checkStanding`, which has to say which it was. */
type ClaimSettled =
  | { kind: "keep" }
  | { kind: "unanswered"; noAnswer: boolean }
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
  /** Gives the slot back while nothing is going to renew it -- a phone's
   * reconnect waiting for the app to be opened -- without forgetting that
   * the pass which eventually dials has to ask where this device stands
   * first (`needsStandingCheck`). Nothing when nothing is held. */
  setAside(): Promise<void>;
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
  /** Whether an unanswered claim is worth repeating as a claim. A 404
   * from a backend that has no slots is not, nor a 400, a 403 or a 409
   * without a code. The question is still asked on the renewal clock --
   * as a renewal, which is what the contract asks for after any claim
   * answer that is not a verdict (obligation 11) -- it is only the claim
   * itself that is not sent again. */
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
        return { kind: "unanswered", noAnswer: outcome.noAnswer };
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

  /** `release`, as a function the session's own `setAside` can call. */
  async function giveBack(): Promise<void> {
    const target = subscriptionId;
    // Nothing to give back, and nothing to start over: every request that
    // could still be out was orphaned by whatever emptied the slot. A
    // second release -- the press's own after the episode's, say -- that
    // started over anyway would end the first one's watch over answers
    // still on the wire, and a grant one of them left would then be kept.
    if (target === null) return;
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

  async function renewNow(budgetMs: number): Promise<SlotEvent | { kind: "unanswered"; noAnswer: boolean }> {
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
        // and not counted as a confirmation of anything. Whether anything
        // came back at all is kept for `checkStanding`, which words its
        // note by it.
        lastAskedAt = now();
        return { kind: "unanswered", noAnswer: outcome.noAnswer };
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
        // tunnel it may reach the API by another way. After that, see
        // `onPoll`: the renewal clock goes on either way.
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
        if (standing === "unclaimed" || standing === "uncounted") {
          if (retryClaim || pendingTakeover.length > 0) {
            // Claimed rather than renewed: the claim names the device and
            // the credential, and carries a takeover still owed -- which a
            // renewal cannot, and without which the server would only
            // name the device the customer chose to replace.
            return whileConnected(await claimNow(dialledProtocolUserId, LATE_CLAIM_BUDGET_MS));
          }
          // The claim was answered with something no repeat of it is
          // expected to change: a 400, a 403, a 404, a 409 without a
          // code. That is no verdict either, and the contract's answer
          // to one is to keep the tunnel and renew at the next interval
          // (obligation 11) -- not to stop asking for the rest of the
          // session. A renewal from a device holding no slot is granted
          // one if there is room, and answered `displaced` if not; any
          // other answer to it changes nothing, as for every renewal.
          const event = await renewNow(RENEW_BUDGET_MS);
          return event.kind === "unanswered" ? { kind: "keep" } : event;
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
      // A release still on its way goes first, as before a claim: a slot
      // set aside a moment ago (`setAside`) and asked about straight after
      // would otherwise be renewed under the handle the release names, and
      // freed by it as soon as it landed.
      if (releasing) await releasing;
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

    release: giveBack,

    async setAside() {
      const target = subscriptionId;
      // Only a slot the server may be counting is worth giving back: one
      // held, or claimed without an answer. Nothing else is recorded, and
      // nothing else has a standing to ask about later that a claim before
      // dialling would not ask anyway.
      if (target === null || (standing !== "held" && standing !== "unclaimed")) return;
      // Kept through the release: the customer's own choice of this device
      // over another, which the standing check's claim still has to carry,
      // and the credential that claim names.
      const takeover = pendingTakeover;
      const dialled = dialledProtocolUserId;
      const released = giveBack();
      // Given back, but not forgotten. By the time the app is opened the
      // slot may be another device's -- given back here, or taken over
      // while the phone was in a pocket, when this release frees nothing --
      // and a claim before dialling that went unanswered would dial as if
      // nothing had happened. As `unclaimed` the reconnect's pass asks
      // first, and says so when it cannot tell (obligation 9). Not a new
      // epoch: the release's watch over answers still on the wire goes on.
      subscriptionId = target;
      standing = "unclaimed";
      retryClaim = true;
      pendingTakeover = takeover;
      dialledProtocolUserId = dialled;
      await released;
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

/** Where the teardown the device limit asked for stands. */
export type SlotTeardownState =
  /** Nothing owed: no slot stop, or its tunnel has been confirmed down. */
  | "none"
  /** The device limit ended the session and the first attempt to take
   * the tunnel down is running. */
  | "tearingDown"
  /** An attempt ended without the tunnel confirmed down. Still owed, and
   * tried again on the poll until it is. */
  | "stuck";

export type SlotTeardownResult = "down" | "stuck";

/** The teardown a slot stop owes, from the stop until the tunnel is
 * confirmed down.
 *
 * Obligation 11: never leave the tunnel up over a refusal, and never
 * show the refusal's card over a tunnel still carrying traffic. The card
 * waits for "down" by design (`slotNoticeShown`), so a teardown that did
 * not finish used to leave the screen showing a working tunnel, no card,
 * no error -- and nothing tried again. While one is owed the dashboards
 * show it as not finished (`slotTeardownShown`, and the stuck line), and
 * ask again on their poll: once per poll at most, never two at once, each
 * attempt bounded by the teardown's own deadline, until one confirms the
 * tunnel down. The card shows then.
 *
 * Kept beside the slot rather than in a screen, for the same reason the
 * card is: the dashboard unmounts while Settings is open, and the tunnel
 * it is taking down does not wait for it. Forgotten on sign-out, whose own
 * teardown takes the tunnel down, and on the customer's own connect,
 * which is theirs to start once nothing is left up. */
export interface SlotTeardown {
  state(): SlotTeardownState;
  /** True from a slot stop until the tunnel is confirmed down. */
  owed(): boolean;
  /** The attempt running now, if one is. */
  running(): Promise<SlotTeardownResult> | null;
  /** The device limit just ended the session: the teardown is owed from
   * now on, and tried at once -- or the attempt already running is
   * joined. `tearDown` resolves true only on the platform's or the
   * service's own word that the tunnel is down. */
  begin(tearDown: () => Promise<boolean>): Promise<SlotTeardownResult>;
  /** On the poll, or a press: tries again when one is owed, joining an
   * attempt already running rather than starting a second. Null when
   * nothing is owed. */
  retry(tearDown: () => Promise<boolean>): Promise<SlotTeardownResult | null>;
  /** The service or the platform said the tunnel is down, outside an
   * attempt -- a remount reading the service, a recheck the customer
   * pressed, the health poll. That is the same word an attempt waits
   * for, so nothing is owed any more. Without it a teardown confirmed
   * between retries stayed "stuck", and the line saying the tunnel had
   * not been confirmed closed stood beside "You're not protected" for
   * as long as nothing else asked. Does nothing when nothing is owed. */
  confirmDown(): void;
  /** Nothing is owed any more: a sign-out, or the customer's own connect
   * after the tunnel came down. An attempt still running is forgotten. */
  clear(): void;
  /** For `useSyncExternalStore`. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createSlotTeardown(): SlotTeardown {
  let state: SlotTeardownState = "none";
  let running: Promise<SlotTeardownResult> | null = null;
  /** Bumped by `clear`, so an attempt that settles afterwards cannot put
   * back a teardown nobody owes any more. */
  let epoch = 0;
  const listeners = new Set<() => void>();

  const move = (next: SlotTeardownState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  function attempt(tearDown: () => Promise<boolean>): Promise<SlotTeardownResult> {
    if (running) return running;
    const startedIn = epoch;
    const sent: Promise<SlotTeardownResult> = (async () => {
      let down = false;
      try {
        down = await tearDown();
      } catch {
        // Not answered is not down.
        down = false;
      }
      const result: SlotTeardownResult = down ? "down" : "stuck";
      if (startedIn === epoch) move(down ? "none" : "stuck");
      return result;
    })().finally(() => {
      if (running === sent) running = null;
    });
    running = sent;
    return sent;
  }

  return {
    state: () => state,
    owed: () => state !== "none",
    running: () => running,
    begin(tearDown) {
      if (state === "none") move("tearingDown");
      return attempt(tearDown);
    },
    retry(tearDown) {
      return state === "none" ? Promise.resolve(null) : attempt(tearDown);
    },
    confirmDown() {
      // Not an epoch bump: an attempt still running reads the same
      // service, and if it comes back with the tunnel up after this, that
      // is the newer word.
      move("none");
    },
    clear() {
      epoch += 1;
      running = null;
      move("none");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const slotTeardown: SlotTeardown = createSlotTeardown();

/** What the screen shows of an observed tunnel state while a slot stop's
 * teardown is owed.
 *
 * A tunnel still up then is one this device has been told to give up:
 * "You're protected" over it would be a working tunnel after a refusal,
 * and "Not carrying traffic" a claim about the server nobody measured.
 * What is true is that it is still being disconnected, and that is what
 * is shown. Anything that is not a tunnel up -- down, or not known --
 * is shown as it is. */
export function slotTeardownShown(owed: boolean, observed: ConnectionState): ConnectionState {
  return owed && isTunnelUp(observed) ? "disconnecting" : observed;
}

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
  /** The attempt report, when a connect was stopped before it dialled --
   * REJECTED with no ladder, so it records no dial, marks no route as
   * failing and teaches nothing about this network's best route.
   *
   * Null for anything that ends a session while connected: a takeover,
   * the plan ending, and a claim refused after connecting (obligation
   * 11). That connect was reported when it happened, as what it was -- a
   * dial that worked -- and the plan's refusal of the device is not a
   * second attempt, nor anything about the network. */
  report: AttemptReport | null;
  /** A status to show the plan-ended state for, when the subscription
   * has stopped. Null when the server named none this app knows. */
  subscriptionStatus: SubscriptionStatus | null;
  /** Whether the subscription has stopped, named or not. */
  inactive: boolean;
  /** What the stop is as an error, the class its report is counted in:
   * `subscriptionInactive` when the plan has ended, `concurrentLimit` for
   * the device limit, null for a sign-out. An automatic reconnect ends on
   * it (`slotStopWhy`), so the episode names the plan, not the device
   * limit, when it was the plan that stopped it. */
  errorKind: "concurrentLimit" | "subscriptionInactive" | null;
}

const STATUSES: readonly SubscriptionStatus[] = ["ACTIVE", "SUSPENDED", "EXPIRED", "PENDING", "CANCELLED"];

export function slotStop(reason: SlotStopReason, when: "beforeDial" | "whileConnected"): SlotStop {
  const none = { notice: null, report: null, subscriptionStatus: null, inactive: false, errorKind: null };
  const limited = { ...none, errorKind: "concurrentLimit" as const };
  const beforeDial = when === "beforeDial";
  switch (reason.kind) {
    case "refused":
      // After connecting, handled like a takeover: the same card as before
      // dialling, over a tunnel the dashboard takes down, with no ladder
      // and nothing recorded.
      return {
        ...limited,
        notice: { kind: "refused", refusal: reason.refusal },
        report: beforeDial ? refusalReport("DEVICE_LIMIT") : null,
      };
    case "takeoverLimited":
      return {
        ...limited,
        notice: { kind: "takeoverLimited", retryAfterSec: reason.retryAfterSec },
        report: beforeDial ? refusalReport("TAKEOVER_LIMIT") : null,
      };
    case "displaced":
      return { ...limited, notice: { kind: "displaced", by: reason.by, at: reason.at } };
    case "inactive":
      return {
        ...none,
        report: beforeDial ? refusalReport("SUBSCRIPTION_INACTIVE") : null,
        subscriptionStatus: STATUSES.find((s) => s === reason.subscriptionStatus && s !== "ACTIVE") ?? null,
        inactive: true,
        errorKind: "subscriptionInactive",
      };
    case "signedOut":
      return none;
  }
}
