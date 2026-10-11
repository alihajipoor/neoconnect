import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceSlotSession,
  createSlotNoticeStore,
  createSlotTeardown,
  slotStop,
  slotTeardownShown,
} from "./device-slot-session";
import { RELEASE_BUDGET_MS, type ClaimOutcome, type RenewOutcome } from "./device-slots";

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
const UNANSWERED: ClaimOutcome & RenewOutcome = { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true };
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
  const release = vi.fn(
    async (_request: { subscriptionId: string; handle: string }, _budget?: number, _how?: { afterTeardown?: boolean }): Promise<boolean> =>
      false,
  );
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
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }]);
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
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });

    expect(await h.session.afterConnected({ protocolUserId: "cred-b" })).toEqual({ kind: "keep" });

    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.claim.mock.calls[1][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-b" });
    expect(h.session.standing()).toBe("held");
  });

  /** Enforcement arriving late: the slots were in use all along. */
  it("reports a late refusal so the dashboard can disconnect and show it", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.afterConnected({})).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.session.standing()).toBe("none");
  });

  it("keeps the tunnel when the late claim is unanswered too", async () => {
    const h = harness([
      { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true },
      { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });
    expect(h.session.standing()).toBe("unclaimed");
  });

  /** Obligation 2: any answer but the three verdicts means dial, and
   * claim again once the tunnel is up -- a 404 or a codeless 409
   * included, since through the tunnel the API may be reached another
   * way. Past that one claim the claim is not repeated; obligation 11
   * asks for a renewal at the next interval instead. */
  it("claims once through the tunnel after an answer that was no verdict, then renews on the renewal clock", async () => {
    const notSlots: ClaimOutcome = { kind: "unanswered", reason: "404", retryable: false, noAnswer: false };
    const h = harness([notSlots, notSlots], [{ kind: "unanswered", reason: "404", retryable: false, noAnswer: false }]);
    expect(await h.session.beforeDial({ subscriptionId: SUB })).toEqual({ kind: "dial" });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });
    expect(h.claim).toHaveBeenCalledTimes(2);
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledWith(SUB, 5_000);
  });

  it("takes a grant from that claim through the tunnel like any other", async () => {
    const h = harness([{ kind: "unanswered", reason: "409 without a code", retryable: false, noAnswer: false }, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.afterConnected({});
    expect(h.session.standing()).toBe("held");
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
    const h = harness([GRANT], [{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }]);
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
      { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true },
      { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true },
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

    const unclaimed = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }]);
    await unclaimed.session.beforeDial({ subscriptionId: SUB });
    expect(unclaimed.session.needsStandingCheck()).toBe(true);
  });

  it("renews with four seconds, and reads displaced as displaced", async () => {
    const by = { handle: "phone", label: null, platform: "android" };
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }], [
      { kind: "displaced", by, at: null },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "displaced", by, at: null });
    expect(h.renew).toHaveBeenCalledWith(SUB, 4_000);
  });

  it("says when it could not ask", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }], [
      { kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true },
    ]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered", noAnswer: true });
  });

  /** Neoxify answered -- a 5xx, a 404, a throttle, a 200 with a status
   * this app does not know -- and confirmed nothing. Still no verdict,
   * and the ladder still runs; but it was reached, and the note must not
   * say otherwise. */
  it("says when it asked and was answered without a verdict", async () => {
    const answered: RenewOutcome = { kind: "unanswered", reason: "Request failed (503)", retryable: true, noAnswer: false };
    const h = harness([UNANSWERED], [answered]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered", noAnswer: false });
  });

  it("clears the way when there was room after all", async () => {
    const h = harness([{ kind: "unanswered", reason: "timeout", retryable: true, noAnswer: true }], [HELD]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });
    expect(h.session.standing()).toBe("held");
  });
});

describe("release", () => {
  it("releases a held slot on Disconnect, naming its grant, and forgets it", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
    expect(h.session.standing()).toBe("none");
    // Nothing renewed after Disconnect.
    h.advance(600_000);
    await h.session.onPoll();
    expect(h.renew).not.toHaveBeenCalled();
  });

  /** A reconnect whose claim went unanswered: if it never arrived, the
   * slot is still under the grant before it, and naming that one gives
   * it back. If it did arrive, the old handle frees nothing. */
  it("releases an unclaimed slot too, by the last grant known -- the claim may not have arrived", async () => {
    const h = harness([GRANT, UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(5 * 60_000);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(h.session.standing()).toBe("unclaimed");
    await h.session.release();
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
  });

  /** A release naming no grant frees whatever this device holds -- and,
   * arriving late, that is the slot a Connect pressed since was just
   * granted. With no grant known there is nothing safe to send. */
  it("never sends a release that names no grant", async () => {
    const h = harness([UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(h.session.standing()).toBe("unclaimed");
    await h.session.release();
    expect(h.release).not.toHaveBeenCalled();
  });

  /** Every claim answers with a new handle, even one made while holding
   * the slot; the server frees the slot only under the one it is held
   * by now. */
  it("names the latest grant: a claim made while holding the slot gives a new handle", async () => {
    const h = harness([GRANT, { kind: "granted", grant: { ...HELD.grant, handle: "moved" } }]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    await h.session.afterConnected({ protocolUserId: "cred-b" });
    await h.session.release();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "moved" });
  });

  it("names the grant a renewal gave back after the slot lapsed", async () => {
    const h = harness([GRANT], [{ kind: "held", grant: { ...HELD.grant, handle: "regranted" } }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    await h.session.onPoll();
    await h.session.release();
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "regranted" });
  });

  /** Disconnect, Connect, Disconnect: each release names its own
   * connect's grant, so the first one, landing late, cannot free the
   * second connect's slot. */
  it("gives each connect's release that connect's grant", async () => {
    const h = harness([GRANT, { kind: "granted", grant: { ...HELD.grant, handle: "second" } }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release.mock.calls.map((c) => c[0])).toEqual([
      { subscriptionId: SUB, handle: "mine" },
      { subscriptionId: SUB, handle: "second" },
    ]);
  });

  it("forgets the grants it knew on sign-out, and never names one on another subscription", async () => {
    const h = harness([GRANT, UNANSWERED, UNANSWERED]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    h.release.mockClear();

    // Another subscription: the grant known is not on it.
    await h.session.beforeDial({ subscriptionId: "sub-2" });
    await h.session.release();
    expect(h.release).not.toHaveBeenCalled();

    // Signed out: the server released everything, and nothing is known.
    h.session.reset();
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release).not.toHaveBeenCalled();
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

/** The release on Disconnect and the teardown it is sent in front of.
 *
 * The test VM, four Disconnects out of four: the release went out through
 * the tunnel 40 ms after the teardown had begun, and never got an answer
 * -- cancelled at its budget, or failed with the tunnel. The panel host's
 * access log shows two of the four arriving and none from the run where
 * only the tunnel could reach Neoxify. The teardown is not made to wait
 * for it (docs/device-slots.md, 8); the release is sent again once the
 * teardown is over and the tunnel confirmed gone, on the bare line. */
describe("a release the teardown took with it", () => {
  /** A teardown the test ends by hand, saying whether the platform then
   * confirmed the tunnel gone. */
  function teardown() {
    let over: (gone?: boolean) => void = () => undefined;
    const tunnelGone = new Promise<boolean>((resolve) => (over = (gone = true) => resolve(gone)));
    return { tunnelGone, over };
  }

  const AFTER_TEARDOWN = [{ subscriptionId: SUB, handle: "mine" }, RELEASE_BUDGET_MS, { afterTeardown: true }] as const;

  it("goes out at once, ahead of the teardown, and does not wait for it", async () => {
    const h = harness([GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    void h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
  });

  it("is sent again, naming the same grant, once the teardown is over -- and not before", async () => {
    const h = harness([GRANT]);
    h.release.mockResolvedValue(false);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
    t.over();
    await released;
    expect(h.release).toHaveBeenCalledTimes(2);
    // As a release after a teardown: the address that answered last, by
    // the tunnel, is not where it goes first (`ReleaseHow`).
    expect(h.release).toHaveBeenLastCalledWith(...AFTER_TEARDOWN);
  });

  /** The first one's connection went down with the tunnel; waiting out its
   * second and a half pushed the second one, and a Connect pressed
   * meanwhile, that much later. */
  it("goes again the moment the teardown is over, without waiting out the first", async () => {
    const h = harness([GRANT]);
    // The first is never answered within the test.
    h.release.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    h.release.mockResolvedValue(true);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    t.over();
    await settle();
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenLastCalledWith(...AFTER_TEARDOWN);
    await released;
  });

  /** A teardown that gave up with the tunnel still reported up: a second
   * release would go the way the first went, through that tunnel, and not
   * on the bare line the doc and the code say it goes on. */
  it("is not sent again when the teardown could not confirm the tunnel gone", async () => {
    const h = harness([GRANT]);
    h.release.mockResolvedValue(false);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    t.over(false);
    await released;
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("is not sent again when the first one was answered before the teardown was over", async () => {
    const h = harness([GRANT]);
    h.release.mockResolvedValue(true);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    t.over();
    await released;
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  /** Disconnect, then Connect before the teardown is over: that connect's
   * claim gave the slot a new handle, and a release now is the old one's,
   * which would free nothing -- but it is not sent at all. */
  it("is not sent again once a new connect has started", async () => {
    const h = harness([GRANT, { ...GRANT, grant: { ...GRANT.grant, handle: "next" } } as ClaimOutcome]);
    h.release.mockResolvedValue(false);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    await h.session.beforeDial({ subscriptionId: SUB });
    t.over();
    await released;
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.session.standing()).toBe("held");
  });

  it("is not sent again after a sign-out", async () => {
    const h = harness([GRANT]);
    h.release.mockResolvedValue(false);
    await h.session.beforeDial({ subscriptionId: SUB });
    const t = teardown();
    const released = h.session.release({ tunnelGone: t.tunnelGone });
    await settle();
    h.session.reset();
    t.over();
    await released;
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("is sent once, as before, when there is no teardown to wait for", async () => {
    const h = harness([GRANT]);
    h.release.mockResolvedValue(false);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.release();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  /** Read from the source, for both clients: every Disconnect the customer
   * presses hands the release its teardown, and ends it whichever way the
   * teardown went -- saying whether the tunnel was then confirmed gone. */
  it("is what both clients' Disconnect and stop do", () => {
    for (const [path, confirmed] of [
      ["../screens/Dashboard.tsx", 'gone = (await confirmTornDown()) === "disconnected";'],
      ["../../../mobile/src/screens/Dashboard.tsx", 'gone = outcome === "down";'],
    ] as const) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      const sent = screen.split("void deviceSlot.release({ tunnelGone: teardown.over });").length - 1;
      expect(sent, path).toBe(2);
      expect(screen.split("const teardown = teardownSignal();").length - 1, path).toBe(2);
      expect(screen.split(/\} finally \{\s*teardown\.done\(gone\);\s*\}/).length - 1, path).toBe(2);
      // The release before the teardown, never after it, and the teardown's
      // own word on whether the tunnel went.
      for (const at of [...screen.matchAll(/void deviceSlot\.release\(\{ tunnelGone: teardown\.over \}\);/g)]) {
        const after = screen.slice(at.index);
        const down = Math.min(
          ...[after.indexOf("serviceDisconnect("), after.indexOf("customerTeardown.begin(")].filter((i) => i >= 0),
        );
        expect(down, path).toBeGreaterThan(0);
        const done = after.indexOf("teardown.done(gone);");
        expect(after.slice(0, done), path).toContain("let gone = false;");
        expect(after.slice(down, done), path).toContain(confirmed);
      }
    }
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
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered", noAnswer: true });
  });

  it("says when that check was answered without a verdict", async () => {
    const answered: ClaimOutcome = { kind: "unanswered", reason: "Request failed (502)", retryable: true, noAnswer: false };
    const h = harness([UNANSWERED, answered]);
    await h.session.beforeDial({ subscriptionId: SUB, takeover: ["pc"] });
    expect(await h.session.checkStanding()).toEqual({ kind: "unanswered", noAnswer: false });
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

  /** The renewal reached the server after the release, found no slot,
   * and gave one back under a new handle -- the one the second release
   * has to name. */
  it("is followed by a second release, naming the grant its answer left", async () => {
    const h = harness([GRANT]);
    const finish = pending<RenewOutcome>(h.renew);
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "mine" });

    finish({ kind: "held", grant: { ...HELD.grant, handle: "regranted" } });
    expect(await poll).toEqual({ kind: "keep" });
    await settle();

    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "regranted" });
    expect(h.session.standing()).toBe("none");
  });

  it("is followed by a second release when it got no answer -- by the last grant known", async () => {
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
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "mine" });
  });

  it("is not followed by one when no grant can be named", async () => {
    const h = harness([]);
    const finish = pending<ClaimOutcome>(h.claim);
    const decision = h.session.beforeDial({ subscriptionId: SUB });
    await settle();
    await h.session.release();
    finish(UNANSWERED);
    await decision;
    await settle();
    expect(h.release).not.toHaveBeenCalled();
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
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
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
    const finishRelease = pending<boolean>(h.release);
    await h.session.beforeDial({ subscriptionId: SUB });
    const released = h.session.release();

    const decision = h.session.beforeDial({ subscriptionId: SUB });
    await settle();
    expect(h.claim).toHaveBeenCalledTimes(1);

    finishRelease(true);
    await released;
    expect(await decision).toEqual({ kind: "dial" });
    expect(h.claim).toHaveBeenCalledTimes(2);
  });
});

/** Obligation 11, the commonest path in Iran: no answer before dialling,
 * so the device connects, and its claim through the tunnel is answered
 * with a verdict. The answer is final, as it would have been before
 * dialling. */
describe("a claim refused after connecting", () => {
  it("ends the session with the refusal, holds nothing, and asks nothing more", async () => {
    const h = harness([UNANSWERED, { kind: "refused", refusal: REFUSAL }]);
    expect(await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" })).toEqual({ kind: "dial" });

    const event = await h.session.afterConnected({ protocolUserId: "cred-a" });

    expect(event).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(h.session.standing()).toBe("none");
    // Not a failed dial and not a held slot: no ladder question, no
    // renewal, no claim on the poll, and nothing to release.
    expect(h.session.needsStandingCheck()).toBe(false);
    h.advance(10 * 60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    await h.session.release();
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("is taken over from by the card's button, which claims with the handles before dialling", async () => {
    const h = harness([UNANSWERED, { kind: "refused", refusal: REFUSAL }, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.afterConnected({});

    const takeover = REFUSAL.holders.map((holder) => holder.handle);
    expect(await h.session.beforeDial({ subscriptionId: SUB, takeover })).toEqual({ kind: "dial" });
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: null, takeover: ["pc"] });
    expect(h.session.standing()).toBe("held");
  });

  it("ends the session to the plan-ended state when the subscription has stopped", async () => {
    const h = harness([UNANSWERED, { kind: "inactive", subscriptionStatus: "SUSPENDED" }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    const event = await h.session.afterConnected({});
    expect(event).toEqual({ kind: "inactive", subscriptionStatus: "SUSPENDED" });
    expect(h.session.standing()).toBe("none");
    expect(slotStop({ kind: "inactive", subscriptionStatus: "SUSPENDED" }, "whileConnected")).toEqual({
      notice: null,
      report: null,
      subscriptionStatus: "SUSPENDED",
      inactive: true,
      errorKind: "subscriptionInactive",
    });
  });

  /** Anything else keeps the tunnel, and the claim is made again on the
   * renewal clock; a refusal arriving on that clock ends it then. */
  it("keeps the tunnel on anything but a verdict, and acts on one that comes on the renewal clock", async () => {
    const h = harness([UNANSWERED, UNANSWERED, { kind: "refused", refusal: REFUSAL }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });
    expect(h.session.standing()).toBe("unclaimed");
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "refused", refusal: REFUSAL });
  });
});

/** Obligation 11, "anything else": keep the tunnel and renew at the next
 * interval. A claim through the tunnel answered with something no repeat
 * of the claim is expected to change -- a 400, a 403, a 404, a 409 with
 * no code -- is one of those, and used to stop every further question
 * for the rest of the session. */
describe("a claim through the tunnel answered with something not worth claiming again", () => {
  const notWorthRepeating = (status: number): ClaimOutcome => ({
    kind: "unanswered",
    reason: `Request failed (${status})`,
    retryable: false,
    noAnswer: false,
  });

  it.each([
    ["a 400", notWorthRepeating(400)],
    ["a 403", notWorthRepeating(403)],
    ["a 404", notWorthRepeating(404)],
    ["a 409 with no code", notWorthRepeating(409)],
  ])("after %s, keeps the tunnel and renews at every interval, never sooner", async (_name, answer) => {
    const renewAnswered: RenewOutcome = { kind: "unanswered", reason: "Request failed (503)", retryable: true, noAnswer: false };
    const h = harness([UNANSWERED, answer], [renewAnswered, HELD]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });

    h.advance(30_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.renew).not.toHaveBeenCalled();

    // Due: renewed, and an answer that is no verdict keeps the tunnel.
    h.advance(30_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.session.standing()).toBe("unclaimed");

    // And again an interval later -- granted this time, since there was
    // room: a renewal from a device holding no slot gets one.
    h.advance(15_000);
    await h.session.onPoll();
    expect(h.renew).toHaveBeenCalledTimes(1);
    h.advance(45_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.renew).toHaveBeenCalledTimes(2);
    expect(h.session.standing()).toBe("held");
    // The claim itself is not sent again.
    expect(h.claim).toHaveBeenCalledTimes(2);
  });

  it("ends the session when the renewal finds the slot is another device's", async () => {
    const by = { handle: "pc", label: null, platform: "windows" };
    const h = harness([UNANSWERED, notWorthRepeating(403)], [{ kind: "displaced", by, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.afterConnected({});
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "displaced", by, at: null });
    expect(h.session.standing()).toBe("displaced");
  });

  /** A renewal cannot carry the takeover, and would only name the device
   * the customer chose to replace. While one is owed, the claim carrying
   * it is what is asked on the clock. */
  it("asks with the claim carrying the takeover while one is owed", async () => {
    const h = harness([UNANSWERED, notWorthRepeating(400), GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    expect(await h.session.afterConnected({})).toEqual({ kind: "keep" });
    h.advance(60_000);
    expect(await h.session.onPoll()).toEqual({ kind: "keep" });
    expect(h.claim).toHaveBeenCalledTimes(3);
    expect(h.claim.mock.calls[2][0]).toEqual({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.session.standing()).toBe("held");
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

/** A phone's reconnect waiting for the app to be opened: nothing claims
 * until then, so the slot is given back, and the pass that runs then
 * asks first where the device stands (obligation 9). */
describe("a slot set aside while a reconnect waits", () => {
  it("is given back, naming its grant, and asked about before the reconnect dials", async () => {
    const h = harness([GRANT], [{ kind: "displaced", by: null, at: null }]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a" });
    // Confirmed a moment ago: on its own, nothing would be asked first.
    expect(h.session.needsStandingCheck()).toBe(false);
    await h.session.setAside();
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
    expect(h.session.standing()).toBe("unclaimed");
    expect(h.session.needsStandingCheck()).toBe(true);
    // Taken over while the phone was in a pocket: said, not dialled over.
    expect(await h.session.checkStanding()).toEqual({ kind: "displaced", by: null, at: null });
    expect(h.renew).toHaveBeenCalledWith(SUB, 4_000);
  });

  it("is granted back when there is room, and the reconnect dials with it", async () => {
    const h = harness([GRANT], [{ kind: "held", grant: { ...HELD.grant, handle: "again" } }]);
    await h.session.beforeDial({ subscriptionId: SUB });
    await h.session.setAside();
    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });
    expect(h.session.standing()).toBe("held");
    // And Disconnect then names the grant it holds now.
    await h.session.release();
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "again" });
  });

  it("is asked about only once the release has gone", async () => {
    // Asked straight after, the renewal could reach the server first and
    // keep the slot under the handle the release names -- which then
    // freed it, under a reconnect that believed it held one.
    const h = harness([GRANT], [HELD]);
    let finish: () => void = () => undefined;
    h.release.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = () => resolve(true))));
    await h.session.beforeDial({ subscriptionId: SUB });
    const setAside = h.session.setAside();
    const check = h.session.checkStanding();
    await settle();
    expect(h.renew).not.toHaveBeenCalled();
    finish();
    await setAside;
    expect(await check).toEqual({ kind: "clear" });
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("stops watching what it gave up on once the reconnect asks for itself", async () => {
    // A renewal still out when the slot was set aside -- the phone sent to
    // the background just after a poll -- that times out once the
    // reconnect's own check has been granted the slot. Still watched, its
    // unanswered end had the slot released again, naming the grant the
    // check had just taken, under a reconnect about to dial on it.
    const h = harness([GRANT]);
    let finish: (value: RenewOutcome) => void = () => undefined;
    h.renew.mockImplementationOnce(() => new Promise<RenewOutcome>((resolve) => (finish = resolve)));
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.setAside();
    expect(h.release).toHaveBeenCalledWith({ subscriptionId: SUB, handle: "mine" });
    h.renew.mockImplementationOnce(async () => ({ kind: "held", grant: { ...HELD.grant, handle: "again" } }));
    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });
    expect(h.session.standing()).toBe("held");
    finish(UNANSWERED);
    await poll;
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.session.standing()).toBe("held");
    // And Disconnect still gives back the grant the check took.
    await h.session.release();
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "again" });
  });

  it("keeps the customer's own choice of this device for the claim that asks", async () => {
    // "Use on this device instead", whose claim never arrived: the check
    // has to carry it, or it would only name the device they replaced.
    const h = harness([UNANSWERED, GRANT]);
    await h.session.beforeDial({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] });
    await h.session.setAside();
    expect(await h.session.checkStanding()).toEqual({ kind: "clear" });
    expect(h.claim).toHaveBeenLastCalledWith({ subscriptionId: SUB, protocolUserId: "cred-a", takeover: ["pc"] }, 4_000);
  });

  it("does nothing for a slot nothing counts, or one already given back", async () => {
    const unlimited = harness([]);
    await unlimited.session.beforeDial({ subscriptionId: SUB, deviceLimit: null });
    await unlimited.session.setAside();
    expect(unlimited.session.standing()).toBe("unenforced");
    const released = harness([GRANT]);
    await released.session.beforeDial({ subscriptionId: SUB });
    await released.session.release();
    await released.session.setAside();
    expect(released.release).toHaveBeenCalledTimes(1);
    expect(released.session.needsStandingCheck()).toBe(false);
  });
});

describe("a second release", () => {
  /** The episode gives the slot back as it ends, and a press -- or the
   * pass that failed -- may give it back as well. The second has nothing
   * to release, and must not start over: that ended the first one's
   * watch over a renewal still on the wire, whose grant was then kept. */
  it("leaves the first one's watch over answers still out", async () => {
    const h = harness([GRANT]);
    let finish: (value: RenewOutcome) => void = () => undefined;
    h.renew.mockImplementationOnce(() => new Promise<RenewOutcome>((resolve) => (finish = resolve)));
    await h.session.beforeDial({ subscriptionId: SUB });
    h.advance(60_000);
    const poll = h.session.onPoll();
    await h.session.release();
    await h.session.release();
    expect(h.release).toHaveBeenCalledTimes(1);

    finish({ kind: "held", grant: { ...HELD.grant, handle: "regranted" } });
    await poll;
    await settle();
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenLastCalledWith({ subscriptionId: SUB, handle: "regranted" });
  });
});

/** The card lives beside the slot, so a refusal that lands while the
 * dashboard is away -- in Settings -- is still there when it comes back. */
/** Obligation 11: never leave the tunnel up over a refusal. A teardown
 * that did not finish used to leave the tunnel up with no card (it waits
 * for "down"), no error, and nothing trying again. */
describe("the teardown a slot stop owes", () => {
  /** An attempt the test settles by hand: true for "the service or the
   * platform says the tunnel is down". */
  function attempts() {
    const pending: ((down: boolean) => void)[] = [];
    const tearDown = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
    const settleNext = async (down: boolean) => {
      pending.shift()?.(down);
      await settle();
    };
    return { tearDown, settleNext };
  }

  it("is owed from the stop until an attempt confirms the tunnel down, and tried again until one does", async () => {
    const store = createSlotTeardown();
    const { tearDown, settleNext } = attempts();
    expect(store.owed()).toBe(false);

    const first = store.begin(tearDown);
    expect(store.state()).toBe("tearingDown");
    expect(store.owed()).toBe(true);
    await settleNext(false);
    expect(await first).toBe("stuck");
    // Still owed -- not forgotten because one attempt did not finish.
    expect(store.state()).toBe("stuck");

    const second = store.retry(tearDown);
    await settleNext(false);
    expect(await second).toBe("stuck");
    expect(store.state()).toBe("stuck");

    const third = store.retry(tearDown);
    await settleNext(true);
    expect(await third).toBe("down");
    expect(store.state()).toBe("none");
    expect(store.owed()).toBe(false);
    expect(tearDown).toHaveBeenCalledTimes(3);
  });

  it("is not tried when nothing is owed", async () => {
    const store = createSlotTeardown();
    const tearDown = vi.fn(async () => true);
    expect(await store.retry(tearDown)).toBeNull();
    expect(tearDown).not.toHaveBeenCalled();
  });

  /** Bounded: a poll that comes round while an attempt is still waiting
   * on the service joins it rather than starting a second. */
  it("runs one attempt at a time", async () => {
    const store = createSlotTeardown();
    const { tearDown, settleNext } = attempts();
    const first = store.begin(tearDown);
    const joined = store.retry(tearDown);
    const again = store.begin(tearDown);
    expect(tearDown).toHaveBeenCalledTimes(1);
    await settleNext(false);
    expect(await Promise.all([first, joined, again])).toEqual(["stuck", "stuck", "stuck"]);
    expect(store.running()).toBeNull();
  });

  it("counts an attempt that throws as not down", async () => {
    const store = createSlotTeardown();
    expect(await store.begin(() => Promise.reject(new Error("service did not answer")))).toBe("stuck");
    expect(store.owed()).toBe(true);
  });

  /** Sign-out, or the customer's own connect once nothing is up. */
  it("is forgotten on clear, and an attempt settling afterwards does not bring it back", async () => {
    const store = createSlotTeardown();
    const { tearDown, settleNext } = attempts();
    void store.begin(tearDown);
    store.clear();
    expect(store.owed()).toBe(false);
    expect(store.running()).toBeNull();
    await settleNext(false);
    expect(store.state()).toBe("none");
  });

  it("tells the screen that is listening", async () => {
    const store = createSlotTeardown();
    const listener = vi.fn();
    store.subscribe(listener);
    const { tearDown, settleNext } = attempts();
    void store.begin(tearDown);
    await settleNext(false);
    void store.retry(tearDown);
    await settleNext(true);
    // tearingDown, stuck, none.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  /** Confirmed between retries -- a remount reading the service, a
   * recheck, the health poll -- is confirmed. The retry stops once the
   * screen says "disconnected", so a teardown confirmed that way used to
   * stay "stuck", its line standing beside "You're not protected". */
  it("is done when the service says the tunnel is down outside an attempt", async () => {
    const store = createSlotTeardown();
    expect(await store.begin(async () => false)).toBe("stuck");
    const listener = vi.fn();
    store.subscribe(listener);

    store.confirmDown();
    expect(store.state()).toBe("none");
    expect(store.owed()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    // Nothing owed: nothing to tell, and nothing for the poll to try.
    store.confirmDown();
    expect(listener).toHaveBeenCalledTimes(1);
    const tearDown = vi.fn(async () => true);
    expect(await store.retry(tearDown)).toBeNull();
    expect(tearDown).not.toHaveBeenCalled();
  });

  /** What the screen shows meanwhile: a tunnel still up is still being
   * disconnected, never "You're protected" over a refusal. */
  it("shows a tunnel still up as still disconnecting, and anything else as it is", () => {
    for (const up of ["connected", "degraded", "unverified"] as const) {
      expect(slotTeardownShown(true, up)).toBe("disconnecting");
      expect(slotTeardownShown(false, up)).toBe(up);
    }
    for (const other of ["disconnected", "unknown", "disconnecting"] as const) {
      expect(slotTeardownShown(true, other)).toBe(other);
    }
  });
});

describe("the device limit's card", () => {
  it("outlives the screen that put it up", () => {
    const store = createSlotNoticeStore();
    const first = vi.fn();
    const unsubscribe = store.subscribe(first);
    unsubscribe();

    // Set while no screen is listening, as an answer arriving after the
    // dashboard unmounted would.
    store.set({ kind: "refused", refusal: REFUSAL });
    expect(first).not.toHaveBeenCalled();

    // The next dashboard reads it on mount.
    expect(store.current()).toEqual({ kind: "refused", refusal: REFUSAL });
  });

  it("tells the screen that is listening, and only when it changes", () => {
    const store = createSlotNoticeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const notice = { kind: "unchecked" as const, limit: 1, noAnswer: true };
    store.set(notice);
    store.set(notice);
    store.set(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.current()).toBeNull();
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

  /** Obligation 11: a claim answered through the tunnel, refused. The
   * dial worked and was reported as what it was; the plan's refusal is
   * not a second attempt, so nothing is reported -- but the card is the
   * refusal's, with "Use on this device instead". */
  it("shows a refusal after connecting with the refusal's card, and reports nothing", () => {
    const stop = slotStop({ kind: "refused", refusal: REFUSAL }, "whileConnected");
    expect(stop.notice).toEqual({ kind: "refused", refusal: REFUSAL });
    expect(stop.report).toBeNull();
    expect(stop.inactive).toBe(false);
    expect(slotStop({ kind: "takeoverLimited", retryAfterSec: 60 }, "whileConnected").report).toBeNull();
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
      errorKind: "subscriptionInactive",
    });
    const midSession = slotStop({ kind: "inactive", subscriptionStatus: "SOMETHING_NEW" }, "whileConnected");
    expect(midSession).toMatchObject({ report: null, subscriptionStatus: null, inactive: true });
  });

  it("says whether it was the plan or the device limit, for whoever counts it", () => {
    // An automatic reconnect ends on this (`slotStopWhy`): the plan when
    // the subscription has stopped, the device limit otherwise.
    for (const when of ["beforeDial", "whileConnected"] as const) {
      expect(slotStop({ kind: "inactive", subscriptionStatus: "EXPIRED" }, when).errorKind).toBe("subscriptionInactive");
      expect(slotStop({ kind: "refused", refusal: REFUSAL }, when).errorKind).toBe("concurrentLimit");
      expect(slotStop({ kind: "takeoverLimited", retryAfterSec: 60 }, when).errorKind).toBe("concurrentLimit");
      expect(slotStop({ kind: "displaced", by: null, at: null }, when).errorKind).toBe("concurrentLimit");
    }
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
      errorKind: null,
    });
  });
});

/** Source assertions, for the reason `connect-intent.test.ts` gives: the
 * dashboard needs a Tauri runtime, a helper service and a real network,
 * so nothing here can watch what it publishes. What can be pinned is
 * that its slot stops go through `slotTeardown`. */
describe("the wiring the pure functions cannot check", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  /** An automatic pass stopped by the device limit tore the tunnel down
   * once, outside `slotTeardown`: a tunnel that outlived the wait was
   * published raw, the health poll could turn it green over the refusal,
   * the card stayed hidden and nothing tried again. */
  it("hands an automatic pass's slot stop to the owed teardown", () => {
    const start = dashboard.indexOf("if (stoppedBySlot !== null) {");
    expect(start).toBeGreaterThan(0);
    const end = dashboard.indexOf("// Whatever is up comes down first", start);
    expect(end).toBeGreaterThan(start);
    const stop = dashboard.slice(start, end);

    expect(stop).toMatch(
      /if \(options\.automatic[^{]*\{[^}]*await slotTeardown\.begin\(tearDownForSlotOnce\);[^}]*return "refused";/,
    );
  });

  /** Every observation reaches the screen through `publishObserved`, so
   * that is where the service's "disconnected" settles an owed teardown
   * -- whoever asked, retry or not. */
  it("takes an observed disconnect as the teardown confirmed", () => {
    const start = dashboard.indexOf("function publishObserved(");
    expect(start).toBeGreaterThan(0);
    const end = dashboard.indexOf("async function readServiceState", start);
    expect(end).toBeGreaterThan(start);
    const publish = dashboard.slice(start, end);

    expect(publish).toContain('if (observed === "disconnected") slotTeardown.confirmDown();');
    // Only for an answer still current: one overtaken by a press says
    // nothing about the tunnel as it is now.
    expect(publish.indexOf("isCurrent(")).toBeLessThan(publish.indexOf("slotTeardown.confirmDown()"));
  });
});
