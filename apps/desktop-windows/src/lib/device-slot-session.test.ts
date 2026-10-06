import { describe, expect, it, vi } from "vitest";
import { createDeviceSlotSession, slotStop } from "./device-slot-session";
import type { ClaimOutcome, RenewOutcome } from "./device-slots";

/** The slot's life from Connect to Disconnect, with the three calls stood
 * in for. The order of events is the thing under test: what is asked
 * when, and what each answer makes the dashboard do. */

const SUB = "sub-1";
const GRANT: ClaimOutcome = {
  kind: "granted",
  grant: { enforced: true, limit: 1, handle: "mine", renewEverySec: 60, staleAfterSec: 90 },
};
const HELD: RenewOutcome = {
  kind: "held",
  grant: { enforced: true, limit: 1, handle: "mine", renewEverySec: 60, staleAfterSec: 90 },
};
const UNANSWERED: ClaimOutcome & RenewOutcome = { kind: "unanswered", reason: "timeout", retryable: true };
/** Slots switched off on the server, or a token from before sessions: a
 * plan with a limit, and nothing counted. */
const UNCOUNTED: ClaimOutcome = {
  kind: "granted",
  grant: { enforced: false, limit: 1, handle: null, renewEverySec: 60, staleAfterSec: 90 },
};

/** Lets every answer already settled run its callbacks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const REFUSAL = {
  limit: 1,
  holders: [{ handle: "pc", label: "Windows PC", platform: "windows", since: "2026-10-06T10:32:04.120Z", lastSeen: null }],
};

function harness(claims: ClaimOutcome[], renewals: RenewOutcome[] = []) {
  let clock = 1_000_000;
  const claim = vi.fn(async (_request: unknown, _budget?: number) => claims.shift() ?? GRANT);
  const renew = vi.fn(async (_sub: string, _budget?: number) => renewals.shift() ?? HELD);
  const release = vi.fn(async (_sub?: string | null) => undefined);
  const session = createDeviceSlotSession({ claim, renew, release, now: () => clock });
  return {
    session,
    claim,
    renew,
    release,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("before dialling", () => {
  it("claims with the subscription and the credential, within three seconds, and dials on a grant", async () => {
    const h = harness([GRANT]);
    const decision = await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    expect(decision).toEqual({ kind: "dial" });
    expect(h.claim).toHaveBeenCalledWith({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: [] }, 3_000);
    expect(h.session.standing()).toBe("held");
  });

  it("does not dial on a refusal, and says where Neoxify is in use", async () => {
    const h = harness([{ kind: "refused", refusal: REFUSAL }]);
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.session.standing()).toBe("none");
  });

  it("does not dial on an inactive subscription, a takeover limit, or a sign-out", async () => {
    const h = harness([
      { kind: "inactive", subscriptionStatus: "EXPIRED" },
      { kind: "takeoverLimited", retryAfterSec: 1260 },
      { kind: "signedOut" },
    ]);
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "inactive", subscriptionStatus: "EXPIRED" });
    expect(await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc"] })).toEqual({
      kind: "takeoverLimited",
      retryAfterSec: 1260,
    });
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "signedOut" });
  });

  /** The rule that matters most: a customer in Iran who cannot reach the
   * API still connects. */
  it("dials when the claim goes unanswered, and remembers to ask again", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }]);
    expect(await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" })).toEqual({ kind: "dial" });
    expect(h.session.standing()).toBe("unclaimed");
  });

  it("passes the handles to take over", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc", "phone"] });
    expect(h.claim.mock.calls[0][0]).toEqual({ subscriptionId: SUB, protocolUserId: null, takeover: ["pc", "phone"] });
  });

  it("does not claim on a plan the server says is unlimited", async () => {
    const h = harness([]);
    expect(await h.session.beforeDial({ subscriptionId: SUB, deviceLimit: null })).toEqual({ kind: "dial" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.session.standing()).toBe("unenforced");
  });

  /** An older backend sends no `deviceLimit`. That is not "unlimited". */
  it("still claims when the limit is unknown", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, deviceLimit: undefined });
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("does not ask again for a slot it holds -- a reconnect from the health poll", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "dial" });
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("claims again a slot whose renewal is overdue -- the tunnel dropped on its own meanwhile", async () => {
    const h = harness([GRANT, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(5 * 60_000);
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it("dials with nothing to claim on", async () => {
    const h = harness([]);
    expect(await h.session.beforeDial({ subscriptionId: null })).toEqual({ kind: "dial" });
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe("once connected", () => {
  it("claims again through the tunnel when the first claim went unanswered", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });

    expect(await h.session.afterConnected({ protocolUserId: "cred-b" })).toEqual({ kind: "keep" });

    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim.mock.calls[1][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-b" });
    expect(h.session.standing()).toBe("held");
  });

  /** Enforcement arriving late: the slots were in use all along. */
  it("reports a late refusal so the dashboard can disconnect and show it", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.afterConnected({})).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.session.standing()).toBe("none");
  });

  it("keeps the tunnel when the late claim is unanswered too", async () => {
    const h = harness([
      { kind: "unanswered", reason: "timeout", retryable: true },
      { kind: "unanswered", reason: "timeout", retryable: true },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });
    expect(h.session.standing()).toBe("unclaimed");
  });

  it("does not keep asking a backend that has no slots", async () => {
    const h = harness([{ kind: "unanswered", reason: "404", retryable: false }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.afterConnected({});
    h.advance(120_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it("moves the slot to the credential the ladder landed on", async () => {
    const h = harness([GRANT, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    await h.session.afterConnected({ protocolUserId: "cred-a" });
    expect(h.claim).toHaveBeenCalledTimes(1);
    await h.session.afterConnected({ protocolUserId: "cred-b" });
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim.mock.calls[1][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-b" });
  });
});

describe("renewing", () => {
  it("renews every renewEverySec on the poll, not on every poll", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });

    for (let i = 0; i < 3; i++) {
      h.advance(15_000);
      expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    }
    expect(h.renew).not.toHaveBeenCalled();
    h.advance(15_000);
    await h.session.onPoll();
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledWith(SUB, 5_000);
  });

  it("uses the interval the server sent", async () => {
    const h = harness([
      { kind: "granted", grant: { enforced: true, limit: 1, handle: "mine", renewEverySec: 30, staleAfterSec: 90 } },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(30_000);
    await h.session.onPoll();
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("reports displaced, with who has the slot", async () => {
    const by = { handle: "phone", label: "Android phone (Pixel 7)", platform: "android" };
    const h = harness([GRANT], [{ kind: "displaced", by, at: "2026-10-06T11:02:13.551Z" }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "displaced", by, at: "2026-10-06T11:02:13.551Z" });
    expect(h.session.standing()).toBe("displaced");
    // And nothing more is asked about a slot that is somebody else's.
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("reports an inactive subscription", async () => {
    const h = harness([GRANT], [{ kind: "inactive", subscriptionStatus: "SUSPENDED" }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "inactive", subscriptionStatus: "SUSPENDED" });
  });

  /** "A renewal that cannot reach the API changes nothing -- keep the
   * tunnel." */
  it("keeps the tunnel when a renewal cannot reach the API, and asks again a renewal later", async () => {
    const h = harness([GRANT], [{ kind: "unanswered", reason: "timeout", retryable: true }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.session.standing()).toBe("held");
    h.advance(15_000);
    await h.session.onPoll();
    expect(h.renew).toHaveBeenCalledTimes(1);
    h.advance(45_000);
    await h.session.onPoll();
    expect(h.renew).toHaveBeenCalledTimes(2);
  });

  it("does not renew, or claim again, a slot nothing will count -- an unlimited plan", async () => {
    const h = harness([
      { kind: "granted", grant: { enforced: false, limit: null, handle: null, renewEverySec: 60, staleAfterSec: 90 } },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(h.session.standing()).toBe("unenforced");
    h.advance(600_000);
    await h.session.onPoll();
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.session.needsStandingCheck()).toBe(false);
  });

  it("keeps trying an unanswered claim on the renewal clock", async () => {
    const h = harness([
      { kind: "unanswered", reason: "timeout", retryable: true },
      { kind: "unanswered", reason: "timeout", retryable: true },
      GRANT,
    ]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    await h.session.afterConnected({ protocolUserId: "cred-a" });
    h.advance(30_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(2);
    h.advance(30_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(3);
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-a" });
    expect(h.session.standing()).toBe("held");
  });

  it("does not overlap two renewals", async () => {
    let finish: (value: RenewOutcome) => void = () => undefined;
    const h = harness([GRANT]);
    h.renew.mockImplementationOnce(() => new Promise<RenewOutcome>((resolve) => (finish = resolve)));
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const first = h.session.onPoll();
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    finish(HELD);
    await first;
    expect(h.renew).toHaveBeenCalledTimes(1);
  });
});

describe("a tunnel the app did not bring up", () => {
  it("is claimed on the first poll", async () => {
    const h = harness([GRANT]);
    h.session.adopt({ subscriptionId: SUB, protocolUserId: "cred-a" });
    expect(h.session.standing()).toBe("unclaimed");
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledWith({ subscriptionId: SUB, protocolUserId: "cred-a" }, 6_000);
    expect(h.session.standing()).toBe("held");
  });

  it("keeps what it knows when the dashboard comes back from Settings", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    h.session.adopt({ subscriptionId: SUB });
    expect(h.session.standing()).toBe("held");
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("asks again about a displaced slot whose tunnel is somehow still up", async () => {
    const h = harness([GRANT, { kind: "refused", refusal: REFUSAL }], [{ kind: "displaced", by: null, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    h.session.adopt({ subscriptionId: SUB });
    expect(await h.session.onPoll()).toEqual({ kind: "refused", refusal: REFUSAL });
  });

  it("is refused like any late claim when the slot went elsewhere meanwhile", async () => {
    const h = harness([{ kind: "refused", refusal: REFUSAL }]);
    h.session.adopt({ subscriptionId: SUB });
    expect(await h.session.onPoll()).toEqual({ kind: "refused", refusal: REFUSAL });
  });
});

describe("before an automatic reconnect (obligation 9)", () => {
  it("asks only for a device whose slot was never confirmed", async () => {
    const held = harness([GRANT]);
    await held.session.beforeDial({ subscriptionId: SUB });
    expect(held.session.needsStandingCheck()).toBe(false);

    const unclaimed = harness([{ kind: "unanswered", reason: "timeout", retryable: true }]);
    await unclaimed.session.beforeDial({ subscriptionId: SUB });
    expect(unclaimed.session.needsStandingCheck()).toBe(true);
  });

  it("renews with four seconds, and reads displaced as displaced", async () => {
    const by = { handle: "phone", label: null, platform: "android" };
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }], [
      { kind: "displaced", by, at: null },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "displaced", by, at: null });
    expect(h.renew).toHaveBeenCalledWith(SUB, 4_000);
  });

  it("says when it could not ask", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }], [
      { kind: "unanswered", reason: "timeout", retryable: true },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered" });
  });

  it("clears the way when there was room after all", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }], [HELD]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });
    expect(h.session.standing()).toBe("held");
  });
});

describe("release", () => {
  it("releases a held slot on Disconnect, and forgets it", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release).toHaveBeenCalledWith(SUB);
    expect(h.session.standing()).toBe("none");
    // Nothing renewed after Disconnect.
    h.advance(600_000);
    await h.session.onPoll();
    expect(h.renew).not.toHaveBeenCalled();
  });

  it("releases an unclaimed slot too -- the claim may have arrived", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release).toHaveBeenCalledWith(SUB);
  });

  it("sends nothing for a slot that is not this device's", async () => {
    const h = harness([GRANT], [{ kind: "displaced", by: null, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    await h.session.release();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after Disconnect", async () => {
    let finish: (value: RenewOutcome) => void = () => undefined;
    const h = harness([GRANT]);
    h.renew.mockImplementationOnce(() => new Promise<RenewOutcome>((resolve) => (finish = resolve)));
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const pending = h.session.onPoll();
    await h.session.release();
    finish({ kind: "displaced", by: null, at: null });
    // Displaced from a slot it has already given back is not news.
    expect(await pending).toEqual({ kind: "keep" });
    expect(h.session.standing()).toBe("none");
  });

  it("forgets without a request on sign-out, which the server handles", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.session.reset();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.session.standing()).toBe("none");
  });
});

/** "Use on this device instead" on a network where the API answers only
 * through the tunnel: the claim before dialling never arrives, so the
 * takeover has to travel with the claim that does. Without it the server
 * refuses again in favour of the device the customer chose to replace,
 * and every press ends the same way. */
describe("a takeover the claim before dialling could not deliver", () => {
  it("is carried by the claim made through the tunnel", async () => {
    const h = harness([UNANSWERED, GRANT]);
    expect(await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] })).toEqual({
      kind: "dial",
    });

    expect(await h.session.afterConnected({ protocolUserId: "cred-a" })).toEqual({ kind: "keep" });

    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim.mock.calls[1][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    expect(h.session.standing()).toBe("held");
  });

  it("is carried by the poll's retry when the claim through the tunnel goes unanswered too", async () => {
    const h = harness([UNANSWERED, UNANSWERED, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    await h.session.afterConnected({ protocolUserId: "cred-a" });
    h.advance(60_000);
    await h.session.onPoll();

    expect(h.claim).toHaveBeenCalledTimes(3);
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    expect(h.session.standing()).toBe("held");
  });

  it("is forgotten once a claim is answered", async () => {
    const h = harness([UNANSWERED, GRANT, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    await h.session.afterConnected({ protocolUserId: "cred-a" });
    // The ladder's next landing moves the slot; it takes nothing over.
    await h.session.afterConnected({ protocolUserId: "cred-b" });
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-b" });
  });

  it("is not added to a plain connect", async () => {
    const h = harness([UNANSWERED, UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc"] });
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.afterConnected({});
    expect(h.claim.mock.calls[1][0]).toEqual({ subscriptionId: SUB, protocolUserId: null, takeover: [] });
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: null });
  });

  /** Connected without a slot, and the server will not hand one over:
   * the same stop as before dialling, and the dashboard disconnects. */
  it("stops the session when the server refuses it for too many takeovers", async () => {
    const h = harness([UNANSWERED, { kind: "takeoverLimited", retryAfterSec: 1260 }]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc"] });
    expect(await h.session.afterConnected({})).toEqual({ kind: "takeoverLimited", retryAfterSec: 1260 });
    expect(h.session.standing()).toBe("none");
    expect(slotStop({ kind: "takeoverLimited", retryAfterSec: 1260 }, "whileConnected").notice).toEqual({
      kind: "takeoverLimited",
      retryAfterSec: 1260,
    });
  });

  it("is refused like any late claim when the device named has moved on", async () => {
    const h = harness([UNANSWERED, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["old-handle"] });
    expect(await h.session.afterConnected({})).toEqual({ kind: "refused", refusal: REFUSAL });
  });

  /** An automatic reconnect asks with the takeover: asking who has the
   * slot would only name the device the customer chose to replace. */
  it("is what the check before an automatic reconnect asks", async () => {
    const h = harness([UNANSWERED, UNANSWERED, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    await h.session.afterConnected({});
    expect(h.session.needsStandingCheck()).toBe(true);

    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });

    expect(h.renew).not.toHaveBeenCalled();
    expect(h.claim).toHaveBeenLastCalledWith({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] }, 4_000);
    expect(h.session.standing()).toBe("held");
  });

  it("says when that check could not ask", async () => {
    const h = harness([UNANSWERED, UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc"] });
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered" });
  });
});

/** A Disconnect that lands while a renewal or claim is still out. The
 * request may be processed after the release, and a renewal that finds
 * no slot gives one back when there is room -- so the server would count
 * a device that is off, and turn the customer's other device away. */
describe("a request still out at Disconnect", () => {
  function pending<T>(mock: { mockImplementationOnce: (fn: () => Promise<T>) => unknown }) {
    let finish: (value: T) => void = () => undefined;
    mock.mockImplementationOnce(() => new Promise<T>((resolve) => (finish = resolve)));
    return (value: T) => finish(value);
  }

  it("is followed by a second release when its answer says the slot was kept", async () => {
    const h = harness([GRANT]);
    const finish = pending<RenewOutcome>(h.renew);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    expect(h.release).toHaveBeenCalledTimes(1);

    finish(HELD);
    expect(await poll).toEqual({ kind: "keep" });
    await settle();

    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenLastCalledWith(SUB);
    expect(h.session.standing()).toBe("none");
  });

  it("is followed by a second release when it got no answer -- it may have arrived", async () => {
    const h = harness([GRANT]);
    const finish = pending<RenewOutcome>(h.renew);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    finish(UNANSWERED);
    await poll;
    await settle();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("is not followed by one when its answer says the slot is someone else's", async () => {
    const h = harness([GRANT]);
    const finish = pending<RenewOutcome>(h.renew);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    finish({ kind: "displaced", by: null, at: null });
    await poll;
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  /** Stop pressed while the claim before dialling is out. Nothing was
   * held when it was pressed, so nothing was released then; the grant
   * that arrives afterwards is given back. */
  it("gives back a claim granted after the connect was stopped", async () => {
    const h = harness([]);
    const finish = pending<ClaimOutcome>(h.claim);
    const decision = h.session.beforeDial({ subscriptionId: SUB });
    await settle();
    await h.session.release();
    expect(h.release).not.toHaveBeenCalled();

    finish(GRANT);
    await decision;
    await settle();

    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith(SUB);
    expect(h.session.standing()).toBe("none");
  });

  /** The second release must never land on a connect started since:
   * the server knows this device, not this connect, and would drop the
   * new slot. */
  it("is not released again once a new connect has started", async () => {
    const h = harness([GRANT, GRANT]);
    const finish = pending<RenewOutcome>(h.renew);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    await h.session.beforeDial({ subscriptionId: SUB });

    finish(HELD);
    await poll;
    await settle();

    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.session.standing()).toBe("held");
  });

  /** Connect pressed straight after Disconnect: the claim goes after the
   * release, or the release could overtake it and drop the new slot. */
  it("holds a new claim until the release before it has gone", async () => {
    const h = harness([GRANT, GRANT]);
    const finishRelease = pending<undefined>(h.release);
    await h.session.beforeDial({ subscriptionId: SUB });
    const released = h.session.release();

    const decision = h.session.beforeDial({ subscriptionId: SUB });
    await settle();
    expect(h.claim).toHaveBeenCalledTimes(1);

    finishRelease(undefined);
    await released;
    expect(await decision).toEqual({ kind: "dial" });
    expect(h.claim).toHaveBeenCalledTimes(2);
  });
});

/** A plan with a limit whose grant was not counted: slots switched off on
 * the server, or a token from before sessions. Either can change while
 * connected, and a device that never asks again would never take a slot
 * -- so another device would be granted the only one, and both would use
 * the VPN. */
describe("a grant nothing counted on a plan with a limit", () => {
  it("is claimed again on the renewal clock until a grant is counted", async () => {
    const h = harness([UNCOUNTED, UNCOUNTED, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    expect(h.session.standing()).toBe("uncounted");

    h.advance(30_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(1);

    h.advance(30_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim.mock.calls[1]).toEqual([{ subscriptionId: SUB, protocolUserId: "cred-a" }, 6_000]);
    expect(h.session.standing()).toBe("uncounted");

    h.advance(60_000);
    await h.session.onPoll();
    expect(h.claim).toHaveBeenCalledTimes(3);
    expect(h.session.standing()).toBe("held");
    expect(h.renew).not.toHaveBeenCalled();
  });

  it("ends the session when the slots turn out to be in use", async () => {
    const h = harness([UNCOUNTED, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "refused", refusal: REFUSAL });
  });

  it("is asked about before an automatic reconnect, and dialled again only with a claim", async () => {
    const h = harness([UNCOUNTED, GRANT], [{ kind: "displaced", by: null, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(h.session.needsStandingCheck()).toBe(true);
    expect(await h.session.checkStanding()).toEqual({ kind: "displaced", by: null, at: null });

    const again = harness([UNCOUNTED, GRANT]);
    await again.session.beforeDial({ subscriptionId: SUB });
    await again.session.beforeDial({ subscriptionId: SUB });
    expect(again.claim).toHaveBeenCalledTimes(2);
  });
});

/** "Fresh" means confirmed by the server, not merely asked about. */
describe("a held slot whose renewals go unanswered", () => {
  it("is claimed again by a reconnect a renewal after it was last confirmed", async () => {
    const h = harness([GRANT, { kind: "refused", refusal: REFUSAL }], [UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    h.advance(15_000);

    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it("is checked before an automatic reconnect once unconfirmed for as long as the server keeps it", async () => {
    const h = harness([GRANT], [UNANSWERED, { kind: "displaced", by: null, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    expect(h.session.needsStandingCheck()).toBe(false);

    h.advance(30_000);
    expect(h.session.standing()).toBe("held");
    expect(h.session.needsStandingCheck()).toBe(true);
    expect(await h.session.checkStanding()).toEqual({ kind: "displaced", by: null, at: null });
  });

  it("is not checked while its renewals are answered", async () => {
    const h = harness([GRANT], [HELD]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    h.advance(30_000);
    expect(h.session.needsStandingCheck()).toBe(false);
  });
});

describe("what a dashboard does when the slot stops it", () => {
  it("shows the refusal and reports it as a limit, with no ladder", () => {
    const stop = slotStop({ kind: "refused", refusal: REFUSAL }, "beforeDial");
    expect(stop.notice).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(stop.report).toEqual({ kind: "CONNECT", outcome: "REJECTED", reason: "DEVICE_LIMIT" });
    expect(stop.report?.attempts).toBeUndefined();
    expect(stop.inactive).toBe(false);
  });

  it("says who took the slot over, and reports nothing -- the connect was reported when it happened", () => {
    const by = { handle: "phone", label: "Android phone", platform: "android" };
    const stop = slotStop({ kind: "displaced", by, at: null }, "whileConnected");
    expect(stop.notice).toEqual({ kind: "displaced", by, at: null });
    expect(stop.report).toBeNull();
  });

  it("hands an ended subscription to the plan-ended state", () => {
    expect(slotStop({ kind: "inactive", subscriptionStatus: "EXPIRED" }, "beforeDial")).toEqual({
      notice: null,
      report: { kind: "CONNECT", outcome: "REJECTED", reason: "SUBSCRIPTION_INACTIVE" },
      subscriptionStatus: "EXPIRED",
      inactive: true,
    });
    const midSession = slotStop({ kind: "inactive", subscriptionStatus: "SOMETHING_NEW" }, "whileConnected");
    expect(midSession).toMatchObject({ report: null, subscriptionStatus: null, inactive: true });
  });

  it("says when a takeover has to wait, and adds nothing to a sign-out", () => {
    expect(slotStop({ kind: "takeoverLimited", retryAfterSec: 60 }, "beforeDial").notice).toEqual({
      kind: "takeoverLimited",
      retryAfterSec: 60,
    });
    expect(slotStop({ kind: "signedOut" }, "beforeDial")).toEqual({
      notice: null,
      report: null,
      subscriptionStatus: null,
      inactive: false,
    });
  });
});
