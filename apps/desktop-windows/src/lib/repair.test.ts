import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LADDER_MAX_MS, ladderPass } from "./ladder-pass";
import {
  anythingFixed,
  diagnosticsToText,
  failedSteps,
  indeterminateSteps,
  REPAIR_PASS_WAIT_MS,
  REPAIR_TIMEOUT_MS,
  stopPassBeforeRepair,
  unresolvedSteps,
  type Diagnostics,
  type RepairReport,
  type RepairStep,
} from "./repair";

function step(id: string, outcome: RepairStep["outcome"], detail?: string): RepairStep {
  return { id, label: id, outcome, detail };
}

const EMPTY: Diagnostics = {
  serviceVersion: "0.1.0",
  ourAdapters: [
    { name: "neoconnect0", present: false },
    { name: "Neoxify-OpenVPN", present: false },
  ],
  otherVpnsUp: [],
  ourRoutes: [],
  nrptRules: 0,
  splitTunnelFirewallRule: false,
  orphanedEngines: [],
  wireguardTunnelService: false,
  rasEntry: false,
  wfpFilters: 0,
  cleanupLogTail: [],
};

describe("how long the app waits for a repair", () => {
  /** Three numbers in a chain: what the service says its pass can cost
   * (`REPAIR_WORST_CASE`), the Rust command's deadline (`REPAIR_TIMEOUT`,
   * asserted against the first in vpn.rs), and this one. The middle one
   * moved from 195s to 750s and this stayed at 205s, so the app gave up
   * on a repair the service was still entitled to be running. */
  it("outlasts the Rust side's own deadline", () => {
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    const match = /const REPAIR_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/.exec(vpn);
    expect(match, "REPAIR_TIMEOUT is no longer declared where this looks").not.toBeNull();
    expect(REPAIR_TIMEOUT_MS).toBeGreaterThan(Number(match![1]) * 1000);
  });
});

describe("what counts as a repaired machine", () => {
  /** The product rule, on the app side of the wire.
   *
   * A step that could not be checked is not a step that found the
   * machine clean. Getting this backwards would show a green summary
   * over a machine whose DNS rule nobody managed to look at -- which is
   * the same claim-without-evidence this whole client is built to
   * refuse.
   */
  it("treats a step that could not be checked as unresolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("wfp", "unknown", "the filtering platform would not answer")],
    };
    expect(unresolvedSteps(report).map((s) => s.id)).toEqual(["wfp"]);
  });

  /** The false failure, on the app side of the wire.
   *
   * Rebuilt from the rig run of 2026-08-24: the WFP step removed three
   * leftover filters (independently confirmed by `netsh`, 5 -> 0), every
   * other step was clean, and the NRPT cmdlets timed out on a slow guest
   * holding no rules of ours. The old summary painted that whole result
   * in the destructive colour and told the customer some of it could not
   * be repaired -- a claim nothing in the run established.
   */
  it("does not call a repair failed because one check timed out", () => {
    const report: RepairReport = {
      steps: [
        step("tunnel", "alreadyClean"),
        step("dns", "unknown", "the DNS cmdlets did not confirm the removal"),
        step("wfp", "fixed", "removed 3 leftover filter(s)"),
      ],
    };
    expect(failedSteps(report)).toEqual([]);
    // Still surfaced, just not as a failure.
    expect(indeterminateSteps(report).map((s) => s.id)).toEqual(["dns"]);
    // And still not silently counted as a clean machine.
    expect(unresolvedSteps(report).map((s) => s.id)).toEqual(["dns"]);
  });

  /** The discriminator. Without it the split above is just "never
   * fail". */
  it("still calls a repair failed when a step checked and found residue", () => {
    const report: RepairReport = {
      steps: [
        step("dns", "failed", "1 rule(s) of ours are still in the registry"),
        step("wfp", "fixed", "removed 3 leftover filter(s)"),
      ],
    };
    expect(failedSteps(report).map((s) => s.id)).toEqual(["dns"]);
    expect(indeterminateSteps(report)).toEqual([]);
  });

  it("keeps the two kinds apart when both are present", () => {
    const report: RepairReport = {
      steps: [step("dns", "unknown", "timed out"), step("wfp", "failed", "still there")],
    };
    expect(failedSteps(report).map((s) => s.id)).toEqual(["wfp"]);
    expect(indeterminateSteps(report).map((s) => s.id)).toEqual(["dns"]);
    expect(unresolvedSteps(report)).toHaveLength(2);
  });

  // The controls, so none of the above passes on a helper that returned
  // a hardcoded answer.
  it("finds neither kind in a wholly successful repair", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("wfp", "fixed", "removed 3")],
    };
    expect(failedSteps(report)).toEqual([]);
    expect(indeterminateSteps(report)).toEqual([]);
  });

  it("treats a step that could not be fixed as unresolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("routes", "failed", "still present: 2 on neoconnect0")],
    };
    expect(unresolvedSteps(report).map((s) => s.id)).toEqual(["routes"]);
  });

  // The control. Without it every assertion above would pass on an
  // implementation that called everything unresolved.
  it("treats found-nothing and fixed as resolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("routes", "fixed", "removed 2 on neoconnect0")],
    };
    expect(unresolvedSteps(report)).toEqual([]);
  });

  /** The DNS cache flush always runs and always reports itself as done.
   *
   * Counting it would make every repair on a perfectly healthy machine
   * say "Repaired. Try connecting again." -- telling somebody their
   * machine had a problem it did not have, and sending them to reconnect
   * over a fault that was never here.
   */
  it("does not call a machine repaired when only the DNS cache was flushed", () => {
    const report: RepairReport = {
      steps: [
        step("dns", "alreadyClean"),
        step("routes", "alreadyClean"),
        step("dnsCache", "fixed", "flushed"),
      ],
    };
    expect(anythingFixed(report)).toBe(false);

    // And the control: a real removal alongside it does count.
    report.steps.push(step("dns", "fixed", "removed 1 rule(s)"));
    expect(anythingFixed(report)).toBe(true);
  });
});

describe("the diagnostics text a customer pastes", () => {
  /** It has to be readable before it is sent, which means it has to be
   * complete and it has to be text -- not JSON, and not a partial
   * summary with the interesting parts hidden. */
  it("names every field, with real values", () => {
    const text = diagnosticsToText(
      {
        ...EMPTY,
        ourAdapters: [
          { name: "neoconnect0", present: true },
          { name: "Neoxify-OpenVPN", present: false },
        ],
        otherVpnsUp: ["Kerio Virtual Network"],
        ourRoutes: ["neoconnect0: 0.0.0.0/1"],
        nrptRules: 2,
        splitTunnelFirewallRule: true,
        orphanedEngines: ["xray.exe (pid 4120)"],
        wireguardTunnelService: true,
        rasEntry: true,
        wfpFilters: 10,
        cleanupLogTail: ["2026-08-23 10:00:00 | repair | Tunnel DNS rule (NRPT): fixed -- removed 2 rule(s)"],
      },
      "0.9.28",
    );

    expect(text).toContain("app: 0.9.28");
    expect(text).toContain("service: 0.1.0");
    expect(text).toContain("neoconnect0=yes");
    expect(text).toContain("Neoxify-OpenVPN=no");
    expect(text).toContain("other VPNs up: Kerio Virtual Network");
    expect(text).toContain("routes on our adapters: neoconnect0: 0.0.0.0/1");
    expect(text).toContain("tunnel DNS rules present: 2");
    expect(text).toContain("split-tunnel firewall rule: yes");
    expect(text).toContain("orphaned engines: xray.exe (pid 4120)");
    expect(text).toContain("wireguard tunnel service: yes");
    expect(text).toContain("entry in Windows VPN list: yes");
    expect(text).toContain("our WFP filters: 10");
    expect(text).toContain("cleanup.log (most recent last):");
  });

  /** A healthy machine still produces something readable.
   *
   * The control for the test above, and a real case: an empty list has
   * to read as "none" rather than as a blank after a colon, which is
   * indistinguishable from a field that failed to render.
   */
  it("says none rather than nothing when there is nothing", () => {
    const text = diagnosticsToText(EMPTY, "0.9.28");
    expect(text).toContain("other VPNs up: none");
    expect(text).toContain("routes on our adapters: none");
    expect(text).toContain("orphaned engines: none");
    expect(text).toContain("tunnel DNS rules present: 0");
    expect(text).not.toContain("undefined");
    // Nothing to show means the log section is omitted entirely rather
    // than left as an empty heading.
    expect(text).not.toContain("cleanup.log");
  });

  /** The privacy boundary, asserted from the outside.
   *
   * The service composes this from named fields and never from a
   * profile, a config or a credential store -- but this is the text that
   * actually leaves the machine, so the check belongs here too. If a
   * future field ever carried one of these words, this is where it
   * surfaces before a customer pastes it into a ticket.
   */
  it("carries nothing that looks like a credential", () => {
    const text = diagnosticsToText(
      {
        ...EMPTY,
        cleanupLogTail: ["2026-08-23 10:00:00 | reap orphaned engines | ended C:\\Users\\<user>\\x\\xray.exe (pid 1)"],
      },
      "0.9.28",
    ).toLowerCase();

    for (const forbidden of ["privatekey", "private_key", "password", "secret", "token", "uuid", "begin "]) {
      expect(text).not.toContain(forbidden);
    }
    // And the control: the redaction the service applies survives into
    // the text unchanged, rather than being undone by the formatting.
    expect(text).toContain("c:\\users\\<user>\\");
  });
});

describe("a repair pressed while a connect is under way", () => {
  /** The service runs one job at a time, and a pass left dialling fought
   * the repair through it: its next connect brought a tunnel up straight
   * after the repair, and its teardown between rungs -- a Disconnect,
   * which cancels whatever the service is running -- could land in the
   * middle of the repair. Pressed from Settings, or on "Reconnecting...",
   * the repair now has the pass stopped and gone before it starts. */
  afterEach(() => {
    ladderPass.reset();
    vi.useRealTimers();
  });

  /** A pass holding the guard, as `runLadder` takes it. */
  function passInFlight(): number {
    const generation = ++ladderPass.generation.current;
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    ladderPass.cancel.current = false;
    return generation;
  }

  /** The pass on its way out, as `runLadder`'s `finally` lets go. */
  function passEnds(): void {
    ladderPass.running.current = false;
    ladderPass.ended();
  }

  it("stops the pass, cancels what it waits on, and goes on only once it has let go", async () => {
    vi.useFakeTimers();
    passInFlight();
    const order: string[] = [];
    let done: boolean | null = null;
    void stopPassBeforeRepair(async () => {
      // The pass is told to stop before the service is asked to cancel
      // the connect it waits on, so it unwinds rather than dialling on.
      order.push(ladderPass.cancel.current ? "disconnect after the stop" : "disconnect before the stop");
    }).then((letGo) => {
      order.push("repair");
      done = letGo;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(["disconnect after the stop"]);
    expect(done).toBeNull();
    // Its own teardown is done by the time it lets go, so nothing of it
    // reaches the service once the repair is running.
    passEnds();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["disconnect after the stop", "repair"]);
    expect(done).toBe(true);
  });

  it("does not wait for ever on one wedged on a service that will not answer", async () => {
    vi.useFakeTimers();
    passInFlight();
    let done: boolean | null = null;
    // Its disconnect times out as well, as the real one does after six
    // seconds.
    const unanswered = async () => {
      throw new Error("vpn_disconnect did not answer in time");
    };
    void stopPassBeforeRepair(unanswered, REPAIR_PASS_WAIT_MS).then((letGo) => (done = letGo));
    await vi.advanceTimersByTimeAsync(REPAIR_PASS_WAIT_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // Said, so a caller could tell -- and the repair runs regardless: the
    // machine with a wedged service is the one that needs it most.
    expect(done).toBe(false);
  });

  it("asks nothing of the service, and touches no stop, when nothing is dialling", async () => {
    let disconnects = 0;
    const done = await stopPassBeforeRepair(async () => {
      disconnects += 1;
    });
    expect(done).toBe(true);
    expect(disconnects).toBe(0);
    expect(ladderPass.cancel.current).toBe(false);
  });

  it("waits longer than a live pass can go without hearing its stop", () => {
    // The pass's teardown on its way out: the service's disconnect (6s) and
    // the settle that confirms it (6s).
    const teardown = 6_000 + 6_000;
    // After a rung's connect: the last rung's egress (30s) and
    // reachability (8s) checks.
    expect(REPAIR_PASS_WAIT_MS).toBeGreaterThan(30_000 + 8_000 + teardown);
    // Before it: the settle's walk (12s), the server's names (2s and a
    // 1s grace) and the IPv6 baseline (2.5s) -- with the stop asked again
    // right before the connect, which the dashboard's wiring test pins.
    expect(REPAIR_PASS_WAIT_MS).toBeGreaterThan(12_000 + 3_000 + 2_500 + teardown);
    // And no longer than the guard itself, past which no pass is in flight.
    expect(REPAIR_PASS_WAIT_MS).toBeLessThan(LADDER_MAX_MS);
  });
});
