import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReconnectAttempt } from "@shared/lib/auto-reconnect";
import { LADDER_MAX_MS, ladderPass } from "@shared/lib/ladder-pass";
import {
  beginPass,
  passInFlight,
  reconnectPassInFlight,
  resetPhonePass,
  stopPassInFlight,
  type PhonePass,
} from "./phone-pass";

/* ------------------------------------------------------------------ *
 * The phone's ladder used to belong to the dashboard that started it:
 * a stop flag per screen and no guard at all, while the automatic
 * reconnect's episode is one per app. A pass outlives its screen
 * whenever Settings is opened mid-pass, so "Stop reconnecting" on the
 * screen mounted on return could not reach it, Connect there started a
 * second ladder beside it, and a pass that landed did so unseen.
 * ------------------------------------------------------------------ */

afterEach(() => {
  resetPhonePass();
  vi.useRealTimers();
});

function attempt(live: () => boolean = () => true, progress: () => void = () => undefined): ReconnectAttempt {
  return { attempt: 1, maxAttempts: 6, resumeRouteId: null, live, progress };
}

function taken(result: PhonePass | "declined" | "cancelled"): PhonePass {
  expect(typeof result).toBe("object");
  return result as PhonePass;
}

describe("the phone's pass, one per app", () => {
  it("lets one pass run at a time, whichever screen starts the second", () => {
    const first = taken(beginPass());
    expect(passInFlight()).toBe(true);
    // A Connect on the screen mounted on return, or an automatic attempt.
    expect(beginPass()).toBe("declined");
    expect(beginPass(attempt())).toBe("declined");
    first.end();
    expect(passInFlight()).toBe(false);
    taken(beginPass());
  });

  it("hears a stop from whichever screen presses it", () => {
    const pass = taken(beginPass(attempt()));
    expect(pass.stopped()).toBe(false);
    // `stopPass` on the dashboard mounted after Settings: the app's one
    // flag, which this pass reads.
    ladderPass.cancel.current = true;
    expect(pass.stopped()).toBe(true);
  });

  it("starts a new pass with the stop clear, but never clears it for an attempt already ended", () => {
    // "Stop reconnecting" pressed while the attempt was still asking the
    // platform its questions: the episode has ended the attempt, and the
    // stop it set stands. The ladder used to clear it as it began, and
    // dialled.
    ladderPass.cancel.current = true;
    expect(beginPass(attempt(() => false))).toBe("cancelled");
    expect(ladderPass.cancel.current).toBe(true);
    expect(passInFlight()).toBe(false);
    // A pass nobody has stopped yet starts clear: an old stop is not one
    // for it.
    const next = taken(beginPass(attempt()));
    expect(ladderPass.cancel.current).toBe(false);
    expect(next.stopped()).toBe(false);
  });

  it("stops an automatic pass the moment its episode ends, without a press reaching the flag", () => {
    // A new location chosen, the attempt's ceiling, a session that ended
    // where no screen saw it.
    let live = true;
    const pass = taken(beginPass(attempt(() => live)));
    expect(pass.stopped()).toBe(false);
    live = false;
    expect(pass.stopped()).toBe(true);
    expect(ladderPass.cancel.current).toBe(false);
  });

  it("does not hold the customer's own pass to an episode", () => {
    const pass = taken(beginPass());
    expect(pass.stopped()).toBe(false);
    expect(reconnectPassInFlight()).toBe(false);
  });

  it("says when the pass running is an automatic reconnect's", () => {
    const pass = taken(beginPass(attempt()));
    expect(reconnectPassInFlight()).toBe(true);
    pass.end();
    expect(reconnectPassInFlight()).toBe(false);
  });

  it("keeps the guard for a pass that keeps stepping forward, and lets a wedged one go", () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    vi.setSystemTime(start);
    const pass = taken(beginPass());
    for (let i = 1; i <= 7; i++) {
      vi.setSystemTime(start + i * 30_000);
      pass.progress();
    }
    expect(passInFlight(start + 7 * 30_000 + LADDER_MAX_MS - 1)).toBe(true);
    expect(passInFlight(start + 7 * 30_000 + LADDER_MAX_MS)).toBe(false);
  });

  it("renews an automatic pass's attempt at every rung, as it renews the guard", () => {
    // The attempt's ceiling is measured from the last rung, like the
    // guard's. Renewed only by the guard, it gave up on a long ladder at
    // three minutes while the pass was still dialling.
    let renewed = 0;
    const pass = taken(beginPass(attempt(undefined, () => (renewed += 1))));
    pass.progress();
    pass.progress();
    expect(renewed).toBe(2);
    // A press's own pass has no attempt to renew.
    pass.end();
    taken(beginPass()).progress();
    expect(renewed).toBe(2);
  });

  it("stops a pass a newer one replaced, which then touches neither the guard nor the screens", () => {
    const start = 1_000_000;
    const old = taken(beginPass(undefined, start));
    const ended: number[] = [];
    ladderPass.onEnd(() => ended.push(ladderPass.generation.current));
    // Wedged past its guard; a press starts a new pass.
    const fresh = taken(beginPass(undefined, start + LADDER_MAX_MS));
    expect(old.stopped()).toBe(true);
    expect(old.owns()).toBe(false);
    // Waking at last, the old pass neither frees the new one's guard nor
    // tells a screen to read the platform under it.
    old.end();
    expect(ladderPass.running.current).toBe(true);
    expect(ended).toEqual([]);
    expect(fresh.stopped()).toBe(false);
    fresh.end();
    expect(ended).toEqual([fresh.generation]);
  });

  it("tells every screen listening when a pass ends", () => {
    const heard: string[] = [];
    ladderPass.onEnd(() => heard.push("mounted now"));
    const pass = taken(beginPass(attempt()));
    pass.end();
    expect(heard).toEqual(["mounted now"]);
  });
});

describe("a press of Connect over an automatic pass", () => {
  it("tells it to stop, and goes on once it has let go", async () => {
    vi.useFakeTimers();
    const pass = taken(beginPass(attempt()));
    let letGo: boolean | null = null;
    void stopPassInFlight(20_000).then((r) => (letGo = r));
    expect(pass.stopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(letGo).toBeNull();
    pass.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(letGo).toBe(true);
  });

  it("does not wait for ever on one that will not let go, and never says it did", async () => {
    vi.useFakeTimers();
    taken(beginPass(attempt()));
    let letGo: boolean | null = null;
    void stopPassInFlight(20_000).then((r) => (letGo = r));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(letGo).toBe(false);
    expect(passInFlight()).toBe(true);
  });

  it("goes on once a wedged pass's guard has lapsed, which never says it ended", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    taken(beginPass(attempt()));
    vi.setSystemTime(1_000_000 + LADDER_MAX_MS - 1_000);
    let letGo: boolean | null = null;
    void stopPassInFlight(20_000).then((r) => (letGo = r));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(letGo).toBe(true);
  });

  it("goes on at once when nothing is running", async () => {
    expect(await stopPassInFlight(20_000)).toBe(true);
  });
});

/** Source assertions, for the reason device-slot-steps.test.ts gives: the
 * dashboard needs a phone, a tunnel and a network. Each fails against
 * the dashboard as it was, with a stop flag per screen and no guard. */
describe("the phone dashboard's wiring", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  /** The body of a function, from its signature to the first line that
   * closes it at the indentation it was declared at. */
  function body(signature: string, indent = "  "): string {
    const start = dashboard.indexOf(signature);
    expect(start, signature).toBeGreaterThan(0);
    return dashboard.slice(start, dashboard.indexOf(`\n${indent}}\n`, start));
  }

  it("keeps the stop flag, the count of presses, and what the pass measured, with the app", () => {
    expect(dashboard).toContain("const cancelRef = ladderPass.cancel;");
    expect(dashboard).not.toMatch(/const cancelRef = useRef\(/);
    // A Connect left waiting on a screen that unmounted never heard the
    // stop pressed on the one mounted on return, and dialled after it.
    expect(dashboard).toContain("const pressRef = presses;");
    expect(dashboard).not.toMatch(/const pressRef = useRef\(/);
    expect(dashboard).toContain("const tunnelServerRef = ladderPass.tunnelServer;");
    expect(dashboard).not.toMatch(/const tunnelServerRef = useRef/);
    const keep = body("function keepBaseline(baseline: BaselineIp | null) {");
    expect(keep).toContain("ladderPass.baseline.current = baseline;");
    // Every baseline the pass takes goes there.
    expect(dashboard).toContain("keepBaseline(pendingBaseline);");
    expect(dashboard).toContain("keepBaseline(baseline);");
  });

  it("takes the app's one guard before anything moves, and lets it go however the pass ends", () => {
    const run = body("async function runLadder(options: LadderOptions = {}): Promise<LadderOutcome> {");
    const begin = run.indexOf("const pass = beginPass(options.reconnect);");
    expect(begin).toBeGreaterThan(0);
    expect(run).toContain('if (pass === "declined" || pass === "cancelled") return pass;');
    // Nothing awaited before the guard is taken.
    expect(run.slice(0, begin)).not.toContain("await ");
    expect(run).toMatch(/try \{\n\s+return await walkLadder\(pass, options\);\n\s+\} finally \{[^}]*pass\.end\(\);/);
    // The walk no longer clears a stop as it begins.
    expect(dashboard).not.toContain("cancelRef.current = false;");
  });

  it("asks the pass, not a flag of its own, whether to stop -- after every await and right before dialling", () => {
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const standDown = walk.indexOf("const standDown = async (engineUp: boolean) => {");
    expect(standDown).toBeGreaterThan(0);
    const afterStandDown = walk.slice(walk.indexOf("\n    };\n", standDown));
    // Only `standDown` reads the flag itself, to know whether a press
    // owns the screen.
    expect(afterStandDown).not.toContain("cancelRef.current");
    expect(walk).toContain("cancelled: pass.stopped,");
    // Between the rung's baseline and its dial.
    const rung = walk.indexOf("keepBaseline(baseline);");
    const dial = walk.indexOf("await connectIkev2({", rung);
    const between = walk.slice(rung, dial);
    expect(between).toContain("if (pass.stopped()) {");
    expect(between).toContain('if (sessionGeneration() !== sessionAtStart) return "failed";');
    // With an engine possibly up, it is taken down by the pass itself.
    expect(walk.split("await standDown(true);").length - 1).toBe(2);
    expect(walk).toContain("pass.progress();");
  });

  it("stands down, when no press owns the screen, by taking down, giving back and saying what is left", () => {
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const start = walk.indexOf("const standDown = async (engineUp: boolean) => {");
    const standDown = walk.slice(start, walk.indexOf("\n    };\n", start));
    expect(standDown).toContain("if (!pass.owns()) return;");
    expect(standDown.indexOf("await disconnect()")).toBeLessThan(standDown.indexOf("cancelRef.current"));
    expect(standDown).toContain("void deviceSlot.release();");
    expect(standDown).toContain("await settleUndialled();");
  });

  it("stands down only once its engine is gone, and only while it is still the pass", () => {
    // Back from a stop, `disconnect` had returned with Android's :xray still
    // on its way down: a screen reading the platform as the pass ended took
    // it for a tunnel. And a pass replaced during those waits -- a press
    // began a newer one, clearing the flag -- gave back the newer pass's
    // slot.
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const start = walk.indexOf("const standDown = async (engineUp: boolean) => {");
    const standDown = walk.slice(start, walk.indexOf("\n    };\n", start));
    const down = standDown.indexOf("await disconnect().catch(() => undefined);");
    const gone = standDown.indexOf("await waitForTeardown();");
    const pressed = standDown.indexOf("if (cancelRef.current || sessionGeneration() !== sessionAtStart) return;");
    expect(down).toBeGreaterThan(0);
    // Waited for whoever stopped it: before the check for a press.
    expect(gone).toBeGreaterThan(down);
    expect(gone).toBeLessThan(pressed);
    // Ownership asked again after the waits, before anything is touched.
    const owned = standDown.lastIndexOf("if (!pass.owns()) return;");
    expect(owned).toBeGreaterThan(gone);
    expect(owned).toBeLessThan(standDown.indexOf("void deviceSlot.release();"));
  });

  it("ends a pass that failed only once its last engine is gone, and only while it is still the pass", () => {
    // The screen mounted since the pass began reads the platform the moment
    // it ends; a failed Xray rung still coming down read as "Connected, not
    // confirmed", and armed the reconnect over nothing.
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const loopEnd = walk.lastIndexOf("await disconnect().catch(() => undefined);\n    }\n");
    expect(loopEnd).toBeGreaterThan(0);
    const tail = walk.slice(loopEnd);
    const gone = tail.indexOf("if (dialled) await waitForTeardown();");
    const owned = tail.indexOf('if (!pass.owns() || sessionGeneration() !== sessionAtStart) return "failed";');
    expect(gone).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(gone);
    // Before the screen, the slot or the report hears anything of it.
    for (const said of ["setConnectionError(lastError);", "void deviceSlot.release();", "void reportAttempt("]) {
      expect(tail.indexOf(said), said).toBeGreaterThan(owned);
    }
    // Set only where a rung is about to be dialled.
    expect(walk.split("dialled = true;").length - 1).toBe(1);
    expect(walk.indexOf("dialled = true;")).toBeLessThan(walk.indexOf("await connectIkev2({"));
  });

  it("reads what a pass it did not start left, when it ends", () => {
    expect(dashboard).toMatch(
      /ladderPass\.onEnd\(\(\) => \{\n\s+if \(ladderPass\.generation\.current === followedPassRef\.current\) return;\n\s+void adoptPlatformRef\.current\(/,
    );
    expect(body("async function runLadder(options: LadderOptions = {}): Promise<LadderOutcome> {")).toContain(
      "followedPassRef.current = pass.generation;",
    );
  });

  it("shows a pass under way as one, on mounting and on loading, and never reads the platform under it", () => {
    expect(dashboard).toMatch(/useState<ConnectionState>\(\(\) =>\s+passInFlight\(\) \? "connecting" : "disconnected",?\s+\)/);
    const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
    const inFlight = adopt.indexOf("if (passInFlight()) {");
    expect(inFlight).toBeGreaterThan(0);
    expect(inFlight).toBeLessThan(adopt.indexOf("await withTimeout(vpnStatus()"));
    expect(adopt.slice(inFlight, adopt.indexOf("}", inFlight))).toContain('setConnectionState("connecting")');
    // An answer overtaken while it was asked is not written.
    expect(adopt.split("if (overtaken()) return;").length - 1).toBe(3);
    // The adopted tunnel keeps the pass's baseline, so it can be proven.
    expect(adopt).toContain("setBaselineIp(ladderPass.baseline.current);");
    expect(body("async function loadScreen(preferRouteId: string | undefined, ready: () => void) {")).toContain(
      "await adoptPlatform(sessionAtStart, usersResult.data, sub, ready);",
    );
  });

  it("lets Connect outrank an automatic pass, never dialling beside it", () => {
    const connect = body("async function connectNow(takeover?: string[]) {");
    const check = connect.indexOf("if (passInFlight()) {");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(connect.indexOf("await runLadder({ takeover })"));
    expect(connect).toContain("const letGo = await stopPassInFlight();");
    // A later press wins over this one, still waiting -- after every await
    // before the ladder.
    expect(connect).toContain("if (pressRef.current !== press) return;");
    const checks: number[] = [];
    for (let at = connect.indexOf("if (pressRef.current !== press) return;"); at >= 0; ) {
      checks.push(at);
      at = connect.indexOf("if (pressRef.current !== press) return;", at + 1);
    }
    expect(checks).toHaveLength(3);
    expect(checks[0]).toBeGreaterThan(connect.indexOf("const letGo = await stopPassInFlight();"));
    expect(checks[1]).toBeGreaterThan(connect.indexOf("settleTeardown(result);"));
    expect(checks[2]).toBeGreaterThan(connect.indexOf("await requestVpnPermission()"));
    expect(checks[2]).toBeLessThan(connect.indexOf("await runLadder({ takeover })"));
    // One that does not let go in time: said, and not dialled.
    expect(connect).toMatch(/if \(!letGo\) \{[^]*?messageKey: "err\.connectBusy"[^]*?return;\n\s+\}/);
    // The customer's own connect already running is followed, not doubled.
    expect(connect).toMatch(/if \(!reconnectPassInFlight\(\)\) \{[^}]*return;\n\s+\}/);
  });
});
