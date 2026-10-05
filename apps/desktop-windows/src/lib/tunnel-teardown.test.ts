import { describe, expect, it } from "vitest";
import { tearDownForSignOut, type TeardownDeps } from "./tunnel-teardown";

/** What a sign-out is allowed to claim about the tunnel.
 *
 * The bug: signing out drew the sign-in screen over a tunnel that was
 * still up. The fix only helps if the answer it produces is honest --
 * "down" exactly when the platform said nothing is connected, and never
 * on the strength of a disconnect that merely returned, or a status that
 * could not be read. Those two shortcuts are how this codebase has
 * produced false "disconnected" claims before.
 *
 * Driven on a virtual clock so the budget is exercised without waiting
 * it out.
 */

type Script = {
  /** Answers to successive status reads; the last one repeats. */
  statuses: (boolean | "throws")[];
  disconnectThrows?: boolean;
  gamingThrows?: boolean;
};

function fake(script: Script) {
  let clock = 0;
  let reads = 0;
  const log: string[] = [];
  const deps: TeardownDeps = {
    disconnect: async () => {
      log.push(`disconnect@${clock}`);
      if (script.disconnectThrows) throw new Error("vpn_disconnect did not answer in time");
    },
    disarmGaming: async () => {
      log.push("disarmGaming");
      if (script.gamingThrows) throw new Error("command gaming_disarm not found");
    },
    connected: async () => {
      const answer = script.statuses[Math.min(reads, script.statuses.length - 1)];
      reads += 1;
      log.push(`status=${String(answer)}`);
      if (answer === "throws") throw new Error("vpn_status did not answer in time");
      return answer;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, log, elapsed: () => clock };
}

describe("taking the tunnel down for a sign-out", () => {
  it("is down once the platform says nothing is connected", async () => {
    const { deps, log } = fake({ statuses: [true, true, false] });
    expect(await tearDownForSignOut(deps, 10_000)).toBe("down");
    // Disconnect first, and only then asked: the verdict is about the
    // state after the teardown, not before it.
    expect(log[0]).toBe("disconnect@0");
  });

  it("does not take a returned disconnect as proof", async () => {
    // The disconnect resolves at once, and the tunnel is still up for
    // the whole budget. "Down" here would be exactly the claim this
    // project keeps catching itself making.
    const { deps } = fake({ statuses: [true] });
    expect(await tearDownForSignOut(deps, 10_000)).toBe("unconfirmed");
  });

  it("does not take an unreadable status as down", async () => {
    // A service that never answers. Not knowing is not the same as the
    // tunnel being gone.
    const { deps } = fake({ statuses: ["throws"] });
    expect(await tearDownForSignOut(deps, 10_000)).toBe("unconfirmed");
  });

  it("gives up inside its budget rather than holding the sign-out", async () => {
    const { deps, elapsed } = fake({ statuses: [true] });
    await tearDownForSignOut(deps, 10_000);
    expect(elapsed()).toBeLessThanOrEqual(10_000);
  });

  it("sends the disconnect again while the tunnel stays up", async () => {
    // A connect still in flight when the first disconnect landed can
    // finish after it. Repeating the teardown is safe, and is what takes
    // that late tunnel down.
    const { deps, log } = fake({ statuses: [true] });
    await tearDownForSignOut(deps, 10_000);
    expect(log.filter((l) => l.startsWith("disconnect@")).length).toBeGreaterThan(1);
  });

  it("still asks when the disconnect itself failed", async () => {
    // A disconnect that timed out may well have worked; the status is
    // what says so.
    const { deps } = fake({ statuses: [false], disconnectThrows: true });
    expect(await tearDownForSignOut(deps, 10_000)).toBe("down");
  });

  it("is not stopped by a build without gaming mode", async () => {
    // macOS registers no gaming_disarm, and the shared UI runs there.
    const { deps, log } = fake({ statuses: [false], gamingThrows: true });
    expect(await tearDownForSignOut(deps, 10_000)).toBe("down");
    expect(log).toContain("disarmGaming");
  });
});
