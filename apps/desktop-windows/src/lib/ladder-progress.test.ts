import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, ReconnectPhase } from "./auto-reconnect";
import { RECONNECT_MAX_ATTEMPTS } from "./auto-reconnect";
import { ladderProgress, showsProgress, type LadderRung } from "./ladder-progress";
import { countdownLine } from "./reconnect-countdown";

const rung = (pass: number, index: number, total = 8): LadderRung => ({
  pass,
  index,
  total,
  routeId: `r${index}`,
  protocol: "XRAY_VLESS_REALITY",
});

beforeEach(() => ladderProgress.resetForTests());

describe("the ladder's rung, for the line under the state", () => {
  it("follows the pass rung by rung and goes when it ends", () => {
    const heard = vi.fn();
    ladderProgress.subscribe(heard);
    ladderProgress.rung(rung(3, 0));
    ladderProgress.rung(rung(3, 1));
    expect(ladderProgress.current()).toMatchObject({ pass: 3, index: 1, total: 8 });
    ladderProgress.ended(3);
    expect(ladderProgress.current()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("is not written by a pass a newer one replaced", () => {
    ladderProgress.rung(rung(5, 2));
    ladderProgress.rung(rung(4, 6));
    expect(ladderProgress.current()).toMatchObject({ pass: 5, index: 2 });
    // Nor cleared by it.
    ladderProgress.ended(4);
    expect(ladderProgress.current()).toMatchObject({ pass: 5 });
  });

  it("is shown only with somewhere else to go: 1 of 1 says nothing", () => {
    expect(showsProgress(rung(1, 0, 1))).toBe(false);
    expect(showsProgress(rung(1, 0, 2))).toBe(true);
    expect(showsProgress(null)).toBe(false);
  });
});

describe("the reconnect's attempt and countdown", () => {
  const episode = { session: 1 } as unknown as Episode;
  const waiting = (attempt: number, delayMs: number, blockedBy: "network" | "foreground" | null = null): ReconnectPhase => ({
    kind: "waiting",
    attempt,
    delayMs,
    blockedBy,
    blockedSince: blockedBy ? 0 : null,
    episode,
  });

  it("counts down to the next try on the monotonic clock, from when the wait was seen", () => {
    expect(countdownLine(waiting(1, 5_000), 100, 100)).toEqual({ kind: "next", attempt: 2, max: RECONNECT_MAX_ATTEMPTS, seconds: 5 });
    expect(countdownLine(waiting(1, 5_000), 100, 2_200)).toEqual({ kind: "next", attempt: 2, max: RECONNECT_MAX_ATTEMPTS, seconds: 3 });
  });

  it("never counts below one second: at zero the try is starting", () => {
    expect(countdownLine(waiting(1, 5_000), 100, 5_200)).toEqual({ kind: "now", attempt: 2, max: RECONNECT_MAX_ATTEMPTS });
    expect(countdownLine(waiting(0, 0), 100, 100)).toEqual({ kind: "now", attempt: 1, max: RECONNECT_MAX_ATTEMPTS });
  });

  it("names the attempt while it runs", () => {
    const attempting: ReconnectPhase = { kind: "attempting", attempt: 2, startedAt: 0, episode };
    expect(countdownLine(attempting, null, 0)).toEqual({ kind: "attempt", attempt: 3, max: RECONNECT_MAX_ATTEMPTS });
  });

  it("says nothing while it waits for a network: the headline says that, and there is no time to count", () => {
    expect(countdownLine(waiting(1, 0, "network"), 100, 100)).toBeNull();
    const offline: ReconnectPhase = { kind: "attempting", attempt: 1, startedAt: 0, episode, offline: true };
    expect(countdownLine(offline, null, 0)).toBeNull();
  });

  it("says nothing with no episode", () => {
    expect(countdownLine({ kind: "idle", lost: false, stopped: null, session: null }, null, 0)).toBeNull();
  });
});
