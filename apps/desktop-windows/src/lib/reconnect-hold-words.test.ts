import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    calls.push(cmd);
    return Promise.resolve(cmd === "vpn_status" ? { connected: false } : undefined);
  },
}));

import { notifyStep, type NotifyMemory } from "./connection-notify";
import { DICTIONARIES } from "./i18n";
import {
  DIALLING_READ_EVERY_MS,
  gapTraffic,
  gapWord,
  holdHint,
  holdNote,
  holdStore,
  readWhileDialling,
  releaseAwaited,
  switchBody,
} from "./reconnect-hold";
import { serviceGone } from "./service-call";

/** The VM's third round of the hold proof (2026-10-26): where the screen and
 * the notifications said something other than what the service was doing.
 * Each block is one of its findings. */

beforeEach(() => {
  calls.length = 0;
  holdStore.resetForTests();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// F1, F4: a connect the hold does not cover -- IKEv2, Custom mode -- let go
// of it inside the connect, which answers only after it has dialled.
// "Blocked" stood 7.7 s over traffic leaving, then "the service isn't
// answering" 6 s more while it dialled, and the plain "lost" toast came
// 13.8 s late.
describe("a connect the hold does not cover", () => {
  const LOST_HELD: NotifyMemory = { up: true, lostSaid: true, heldSaid: true };

  const lossSaid = (hold: ReturnType<typeof holdStore.current>) =>
    notifyStep(LOST_HELD, {
      tone: "warn",
      reconnecting: true,
      gap: gapWord(gapTraffic(hold, true), true),
      letGo: hold?.state === "notHeld",
      focused: false,
      gaming: false,
    }).say;

  // Round 4: that connect waited 1.7 s and more behind the previous rung's
  // thorough pass while the service still held, and one abandoned,
  // cancelled or refused never let go at all -- under "goes out without
  // Neoxify" and the plain "lost" toast, said by the app before it was sent.
  it("drops 'blocked' before it is sent for a word that says neither, and says the let-go only on the service's", () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    holdStore.lettingGo();
    let hold = holdStore.current();
    expect(hold).toEqual({ state: "lettingGo" });
    expect(gapTraffic(hold, true)).toBe("unconfirmed");
    expect(holdNote(hold, { inGap: true, setting: true })).toBeNull();
    // Nothing in the hint's room within the grace, "checking" after it --
    // never the headline's "going out without Neoxify".
    expect(holdHint(hold, { reconnecting: true, dropped: false, setting: true, wordLate: false })).toBe("pending");
    expect(holdHint(hold, { reconnecting: true, dropped: false, setting: true })).toBe("hold.unconfirmed");
    expect(lossSaid(hold)).toBeNull();
    // The service's own word: let go of, and why -- with the plain "lost".
    holdStore.observeRead(holdStore.decisionMark(), { state: "notHeld", problem: "notCovered" });
    hold = holdStore.current();
    expect(hold).toEqual({ state: "notHeld", problem: "notCovered" });
    expect(gapTraffic(hold, true)).toBe("open");
    expect(holdNote(hold, { inGap: true, setting: true })).toBe("hold.notCovered");
    expect(lossSaid(hold)).toBe("lost");
  });

  it("is not said over a tunnel the service only armed: that connect disarms it, holding nothing", () => {
    holdStore.observe({ state: "armed" });
    holdStore.lettingGo();
    expect(holdStore.current()).toEqual({ state: "armed" });
    holdStore.resetForTests();
    holdStore.lettingGo();
    expect(holdStore.current()).toBeNull();
  });

  it("is not taken back by a read answered before that connect reached the service", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    const before = holdStore.decisionMark();
    holdStore.lettingGo();
    let answer!: () => void;
    const dial = holdStore.dialling(new Promise<void>((resolve) => (answer = resolve)));
    // Sent before the let-go: older than it.
    holdStore.observeRead(before, { state: "holding", held_secs: 31 });
    expect(holdStore.current()?.state).toBe("lettingGo");
    // Sent after it, but answered before the connect ran -- queued behind a
    // teardown's thorough pass: still neither, and never "let go".
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 32 });
    expect(holdStore.current()?.state).toBe("lettingGo");
    expect(lossSaid(holdStore.current())).toBeNull();
    // What the service says once it has let go stands.
    holdStore.observeRead(holdStore.decisionMark(), { state: "notHeld", problem: "notCovered" });
    expect(holdStore.current()).toEqual({ state: "notHeld", problem: "notCovered" });
    answer();
    await dial;
    // Answered: a read is the service's word again, whatever it says.
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 1 });
    expect(holdStore.current()?.state).toBe("holding");
  });

  it("is never said as let go of when that connect never lets go: abandoned, cancelled, refused", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    holdStore.lettingGo();
    let refuse!: (err: Error) => void;
    const dial = holdStore.dialling(new Promise<void>((_, reject) => (refuse = reject)));
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 31 });
    expect(lossSaid(holdStore.current())).toBeNull();
    refuse(new Error("Gaming mode is on, and a VPN connection cannot run alongside it."));
    await dial.catch(() => undefined);
    // The service still holds, and says so: blocked again, never "lost".
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 33 });
    expect(gapTraffic(holdStore.current(), true)).toBe("blocked");
    expect(lossSaid(holdStore.current())).toBeNull();
  });

  it("never says the service is not answering while a connect it is dialling holds its thread", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    let answer!: () => void;
    const dial = holdStore.dialling(new Promise<void>((resolve) => (answer = resolve)));
    holdStore.unanswered();
    expect(holdStore.current()?.state).toBe("holding");
    // Unless it is not there at all: its pipe gone, it holds nothing.
    holdStore.unanswered(true);
    expect(holdStore.current()?.state).toBe("unanswered");
    answer();
    await dial;
    holdStore.observe({ state: "holding", held_secs: 1 });
    holdStore.unanswered();
    expect(holdStore.current()?.state).toBe("unanswered");
  });

  it("tells a service that is not there from one that is slow", () => {
    expect(
      serviceGone(
        "Could not reach the Neoxify background service (The system cannot find the file specified. (os error 2)). Try restarting the app.",
      ),
    ).toBe(true);
    expect(serviceGone("the service is shutting down")).toBe(true);
    expect(serviceGone(new Error("vpn_status did not answer in time (6000ms)"))).toBe(false);
    expect(serviceGone("no network connection with a gateway was found")).toBe(false);
  });

  it("drops 'blocked' on the answer of a teardown the service is not there for", async () => {
    // A restart: the reconnect's teardown finds no pipe. Nothing the
    // service held outlives its process.
    const { holdService } = await import("./reconnect-hold");
    const core = await import("@tauri-apps/api/core");
    const spy = vi.spyOn(core, "invoke").mockImplementation(() =>
      Promise.reject(new Error("Could not reach the Neoxify background service (os error 2)")),
    );
    holdStore.observe({ state: "holding", held_secs: 3 });
    let dial!: () => void;
    const busy = holdStore.dialling(new Promise<void>((resolve) => (dial = resolve)));
    await expect(holdService.disconnectKeepingHold()).rejects.toThrow();
    expect(holdStore.current()?.state).toBe("unanswered");
    dial();
    await busy;
    spy.mockRestore();
  });
});

// F2: a WireGuard server the service could not name let go of the hold
// inside a covered connect, and "blocked" stood 1.5 to 2.5 s over traffic
// leaving, until the next poll.
describe("a connect sent over a hold", () => {
  it("reads the service's word at once and after each answer, one read at a time, until it answers", async () => {
    const pending: (() => void)[] = [];
    let reads = 0;
    let answer!: () => void;
    const dial = new Promise<void>((resolve) => (answer = resolve));
    const work = readWhileDialling(dial, {
      read: async () => {
        reads += 1;
      },
      later: (fn, ms) => {
        expect(ms).toBe(DIALLING_READ_EVERY_MS);
        pending.push(fn);
      },
    });
    expect(work).toBe(dial);
    expect(reads).toBe(1);
    await tick();
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(reads).toBe(2);
    await tick();
    answer();
    await dial;
    // Answered: nothing more is asked.
    pending.shift()?.();
    await tick();
    expect(reads).toBe(2);
    expect(pending).toHaveLength(0);
  });

  it("keeps reading when a read fails", async () => {
    const pending: (() => void)[] = [];
    let reads = 0;
    void readWhileDialling(new Promise<void>(() => undefined), {
      read: async () => {
        reads += 1;
        throw new Error("vpn_status did not answer in time (6000ms)");
      },
      later: (fn) => pending.push(fn),
    });
    await tick();
    pending.shift()!();
    await tick();
    expect(reads).toBe(2);
    expect(pending).toHaveLength(1);
  });

  it("hears a let-go said while it dials", async () => {
    holdStore.observe({ state: "holding", held_secs: 5 });
    const dial = holdStore.dialling(
      readWhileDialling(new Promise<void>(() => undefined), {
        read: async () => holdStore.observeRead(holdStore.decisionMark(), { state: "notHeld", problem: "tunnelNotPermitted" }),
        later: () => undefined,
      }),
    );
    await tick();
    expect(holdStore.current()).toEqual({ state: "notHeld", problem: "tunnelNotPermitted" });
    void dial;
  });
});

// F3: a reconnect's teardown re-held a drop the backstop had let go of, and
// the screen said traffic was going out without Neoxify for 1.7 s more,
// until a read behind the teardown's thorough pass said it.
describe("a reconnect's teardown over an armed tunnel", () => {
  it("is said as held on its own answer", () => {
    holdStore.observe({ state: "armed" });
    const before = holdStore.decisionMark();
    holdStore.heldNow();
    expect(holdStore.current()).toEqual({ state: "holding", heldSecs: 0 });
    expect(gapTraffic(holdStore.current(), true)).toBe("blocked");
    // A read sent before the teardown answered still said armed: older.
    holdStore.observeRead(before, { state: "armed" });
    expect(holdStore.current()?.state).toBe("holding");
    // The read sent with the answer says the rest: held late, say.
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 0, standing_refused: true });
    expect(holdStore.current()).toEqual({ state: "holding", heldSecs: 0, standingRefused: true });
  });

  it("is not said where nothing was armed for it: no hold, or one let go of", () => {
    holdStore.heldNow();
    expect(holdStore.current()).toBeNull();
    holdStore.observe({ state: "notHeld", problem: "timedOut" });
    holdStore.heldNow();
    expect(holdStore.current()).toEqual({ state: "notHeld", problem: "timedOut" });
  });

  it("is said by the teardown that keeps the hold, before the read it sends", async () => {
    holdStore.observe({ state: "armed" });
    const { holdService } = await import("./reconnect-hold");
    const seen: (string | undefined)[] = [];
    const stop = holdStore.subscribe(() => seen.push(holdStore.current()?.state));
    await holdService.disconnectKeepingHold();
    stop();
    expect(calls).toEqual(["vpn_disconnect_for_reconnect", "vpn_status"]);
    expect(seen[0]).toBe("holding");
  });
});

// F5: a switch dialog left open across a drop said "your traffic is not
// protected" 0.5 to 1.0 s into a hold.
describe("the switch confirmation in a gap the service has not yet spoken of", () => {
  it("says neither blocked nor not protected", () => {
    for (const gap of ["unconfirmed", "unanswered"] as const) {
      expect(switchBody(gap, { covered: true, inGap: true })).toBe("sw.bodyHoldUnconfirmed");
      expect(switchBody(gap, { covered: false, inGap: true })).toBe("sw.bodyHoldUnconfirmed");
      // Outside a gap armed is a tunnel up, which the switch's own
      // Disconnect lets go of: the plain sentence is true.
      expect(switchBody(gap, { covered: true })).toBe("sw.body");
    }
    expect(switchBody("open", { covered: true, inGap: true })).toBe("sw.body");
    expect(switchBody("blocked", { covered: true, inGap: true })).toBe("sw.bodyHeld");
    for (const [language, notProtected, blocked] of [
      ["en", "not protected", "are blocked now"],
      ["fa", "محافظت نمی‌شود", "الان مسدود هستند"],
    ] as const) {
      const words = DICTIONARIES[language]["sw.bodyHoldUnconfirmed"];
      expect(words, language).toBeTruthy();
      expect(words, language).not.toContain(notProtected);
      expect(words, language).not.toContain(blocked);
    }
  });
});

/** The VM's fourth round of the hold proof (2026-11-09). */
describe("the fourth round", () => {
  // gate5, fo and foall: an IKEv2 connect ran from +134.54 to +141.52; a read
  // sent at +135.75 timed out at +141.75, after it had answered, and "the
  // service isn't answering" stood 0.41 s over a service that had dialled.
  it("decides a read went unanswered by where connects were when it was sent, not when it timed out", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    let answer!: () => void;
    const dial = holdStore.dialling(new Promise<void>((resolve) => (answer = resolve)));
    const sentWhileDialling = holdStore.dialMark();
    expect(sentWhileDialling).toBeNull();
    answer();
    await dial;
    holdStore.unanswered(false, sentWhileDialling);
    expect(holdStore.current()?.state).toBe("holding");
    // Sent before a connect went on the wire, timed out after it came off.
    const sentBefore = holdStore.dialMark();
    let again!: () => void;
    const second = holdStore.dialling(new Promise<void>((resolve) => (again = resolve)));
    again();
    await second;
    holdStore.unanswered(false, sentBefore);
    expect(holdStore.current()?.state).toBe("holding");
    // The service stopped or killed, nothing dialling: not answering, at once
    // -- and its pipe gone says so whenever the read was sent.
    holdStore.unanswered(false, holdStore.dialMark());
    expect(holdStore.current()?.state).toBe("unanswered");
    holdStore.observe({ state: "holding", held_secs: 31 });
    holdStore.unanswered(true, sentWhileDialling);
    expect(holdStore.current()?.state).toBe("unanswered");
  });

  it("never says the service is not answering over its reason for holding nothing", () => {
    holdStore.observe({ state: "notHeld", problem: "notCovered" });
    holdStore.unanswered();
    holdStore.unanswered(true);
    expect(holdStore.current()).toEqual({ state: "notHeld", problem: "notCovered" });
  });

  // gate5, foerr: the failed failover's teardown is a plain Disconnect, which
  // the service lets go of the hold on receipt; the screen said "blocked"
  // 0.41 s after the let-go, until the reply.
  it("says a plain Disconnect over a hold as being let go of before it is sent, and takes no 'holding' read until the reply", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    const before = holdStore.decisionMark();
    const seen: (string | undefined)[] = [];
    const stop = holdStore.subscribe(() => seen.push(holdStore.current()?.state));
    let reply!: () => void;
    let sentAs: string | undefined;
    const sent = holdStore.disconnecting(() => {
      sentAs = holdStore.current()?.state;
      return new Promise<void>((resolve) => (reply = resolve));
    });
    expect(sentAs).toBe("lettingGo");
    const hold = holdStore.current();
    // Neither blocked nor open: no held sentence, no note, no "not protected".
    expect(gapTraffic(hold, true)).toBe("unconfirmed");
    expect(holdNote(hold, { inGap: true, setting: true })).toBeNull();
    expect(holdHint(hold, { reconnecting: false, dropped: false, checking: true, holdKept: true, setting: true })).toBeNull();
    // A read sent before it, and one answered before it got there: older.
    holdStore.observeRead(before, { state: "holding", held_secs: 31 });
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 31 });
    expect(holdStore.current()?.state).toBe("lettingGo");
    reply();
    await sent;
    holdStore.released();
    stop();
    expect(holdStore.current()).toBeNull();
    expect(seen).toEqual(["lettingGo", undefined]);
  });

  it("keeps the customer's Disconnect saying 'Disconnecting...' and nothing of the hold until the reply", () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    void holdStore.disconnecting(() => new Promise<void>(() => undefined));
    const hold = holdStore.current();
    expect(releaseAwaited(hold, true)).toBe(true);
    expect(holdHint(hold, { reconnecting: false, dropped: false, tunnelUp: false, disconnecting: true, setting: true })).toBeNull();
  });

  it("believes the service again once a Disconnect that failed has settled, and leaves an armed tunnel armed", async () => {
    holdStore.observe({ state: "holding", held_secs: 30 });
    await holdStore.disconnecting(() => Promise.reject(new Error("vpn_disconnect did not answer in time (6000ms)"))).catch(() => undefined);
    holdStore.observeRead(holdStore.decisionMark(), { state: "holding", held_secs: 37 });
    expect(holdStore.current()?.state).toBe("holding");
    holdStore.resetForTests();
    holdStore.observe({ state: "armed" });
    await holdStore.disconnecting(() => Promise.resolve());
    expect(holdStore.current()).toEqual({ state: "armed" });
  });
});
