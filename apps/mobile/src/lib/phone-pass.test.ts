import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoReconnect, vouching, type ReconnectAttempt } from "@shared/lib/auto-reconnect";
import { LADDER_MAX_MS, ladderPass } from "@shared/lib/ladder-pass";
import {
  beginPass,
  connectPending,
  connectPressed,
  followPass,
  onConnectSettled,
  passAwayChanged,
  passInFlight,
  passSaid,
  pressOverPass,
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

  it("says whether a press is what stopped it, so only a press is filed as the customer's", () => {
    // Stopped because its attempt was over -- the ceiling, half an hour
    // away, a session ended out of sight -- an automatic pass was filed as
    // "cancelled by the customer" about somebody who had pressed nothing.
    let live = true;
    const pass = taken(beginPass(attempt(() => live)));
    live = false;
    expect(pass.stopped()).toBe(true);
    expect(pass.pressed()).toBe(false);
    // The orb, "Stop reconnecting", a Connect taking over: the app's flag.
    ladderPass.cancel.current = true;
    expect(pass.pressed()).toBe(true);
    // A newer pass clears the flag as it begins, and a stop pressed for it
    // is not one for this.
    const start = 1_000_000;
    resetPhonePass();
    const old = taken(beginPass(undefined, start));
    taken(beginPass(undefined, start + LADDER_MAX_MS));
    expect(old.stopped()).toBe(true);
    expect(old.pressed()).toBe(false);
    ladderPass.cancel.current = true;
    expect(old.pressed()).toBe(false);
  });
});

describe("what a press of Connect does about a pass already running", () => {
  it("dials when none is", () => {
    expect(pressOverPass()).toBe("none");
    expect(pressOverPass({ takeover: true })).toBe("none");
  });

  it("follows the customer's own connect, still wanted: never a second ladder", () => {
    taken(beginPass());
    expect(pressOverPass()).toBe("follow");
  });

  it("takes over from an automatic reconnect's", () => {
    taken(beginPass(attempt()));
    expect(pressOverPass()).toBe("takeOver");
  });

  it("takes over from the customer's own connect once it has been stopped, still unwinding", () => {
    // Stopped during its claim or its baseline walk -- twelve seconds, with
    // no way to cut it short -- the pass still held the guard when Connect
    // was pressed again. Followed, that press did nothing at all: the orb
    // read Connect, the stopped pass ended cancelled, nothing was dialled
    // and nothing was said.
    taken(beginPass());
    ladderPass.cancel.current = true;
    expect(pressOverPass()).toBe("takeOver");
  });

  it("takes over from any pass for 'Use on this device instead', which no pass running asked for", () => {
    // Tapped while the customer's own refused pass was still reading the
    // platform on its way out, it was followed, and lost.
    taken(beginPass());
    expect(pressOverPass({ takeover: true })).toBe("takeOver");
  });
});

describe("a press of Connect that follows the customer's own pass", () => {
  /** The shared controller on a still clock: only stamps and arming
   * matter here. */
  function controller() {
    return new AutoReconnect({
      now: () => 1_000_000,
      elapsed: () => 0,
      setTimer: () => 0,
      clearTimer: () => undefined,
      online: () => true,
      foreground: () => true,
      session: () => 1,
      report: () => undefined,
      slotIdle: () => undefined,
    });
  }

  it("arms that pass's landing, which its own stamp, taken before the press, could not", () => {
    // Connect pressed, stopped, pressed again: the second press waits for
    // the first pass to let go, and the customer opens Settings meanwhile.
    // The screen back from Settings shows Connect over the second pass,
    // and a press there follows it -- after its own `cancel`, which counts
    // as an overrule whatever it finds. The landing then quoted the stamp
    // the pass took as it began, was refused, and "You're protected" stood
    // over a tunnel whose drop reconnected nothing.
    const rc = controller();
    const pass = taken(beginPass());
    const own = rc.stamp();
    // The press: `handleConnectToggle` and `connectNow` each cancel.
    rc.cancel("customer");
    rc.cancel("customer");
    expect(pressOverPass()).toBe("follow");
    expect(followPass(rc.stamp())).toBe(true);
    rc.tunnelUp({ routeId: "r", fresh: true, stamp: pass.landing(own) });
    expect(vouching(rc.current(), 1)).toBe(true);

    // Control: not followed, the same landing arms nothing.
    resetPhonePass();
    const c = controller();
    const unfollowed = taken(beginPass());
    const before = c.stamp();
    c.cancel("customer");
    c.tunnelUp({ routeId: "r", fresh: true, stamp: unfollowed.landing(before) });
    expect(vouching(c.current(), 1)).toBe(false);
  });

  it("is overruled by a later press as the pass's own stamp would be", () => {
    const rc = controller();
    const pass = taken(beginPass());
    const own = rc.stamp();
    rc.cancel("customer");
    followPass(rc.stamp());
    // A stop pressed after it: the landing arms nothing.
    rc.cancel("customer");
    rc.tunnelUp({ routeId: "r", fresh: true, stamp: pass.landing(own) });
    expect(vouching(rc.current(), 1)).toBe(false);
  });

  it("re-stamps only the customer's own pass, still wanted, and only that pass", () => {
    const rc = controller();
    // An automatic reconnect's is taken over, never followed.
    const automatic = taken(beginPass(attempt()));
    const stamp = rc.stamp();
    expect(followPass({ overrules: 99, session: 1 })).toBe(false);
    expect(automatic.landing(stamp)).toBe(stamp);
    automatic.end();
    // Nor one already stopped, still unwinding.
    const stopped = taken(beginPass());
    ladderPass.cancel.current = true;
    expect(followPass({ overrules: 99, session: 1 })).toBe(false);
    expect(stopped.landing(stamp)).toBe(stamp);
    stopped.end();
    // Nothing running, nothing to follow.
    expect(followPass({ overrules: 99, session: 1 })).toBe(false);
    // Followed, and then a newer pass: that one keeps its own.
    const first = taken(beginPass());
    const followed = { overrules: 7, session: 1 };
    expect(followPass(followed)).toBe(true);
    expect(first.landing(stamp)).toBe(followed);
    first.end();
    const next = taken(beginPass());
    expect(next.landing(stamp)).toBe(stamp);
  });
});

describe("the guard while the app is away", () => {
  it("is held, so a pass the OS froze for minutes is still the pass when the app comes back", () => {
    // iOS freezes the pass in the background. Counted against the guard,
    // three minutes away read as a lapsed guard on return until the pass's
    // next rung: a screen mounted then offered Connect, and Connect began a
    // second ladder beside the first.
    const start = 1_000_000;
    taken(beginPass(undefined, start));
    passAwayChanged(true, start + 10_000);
    expect(passInFlight(start + 10_000 + 200_000)).toBe(true);
    passAwayChanged(false, start + 10_000 + 200_000);
    const back = start + 210_000;
    expect(passInFlight(back + 1)).toBe(true);
    expect(pressOverPass({}, back + 1)).toBe("follow");
    // Its time in front still runs out: 10 s before, and the rest after.
    expect(passInFlight(back + LADDER_MAX_MS - 10_000 - 1)).toBe(true);
    expect(passInFlight(back + LADDER_MAX_MS - 10_000)).toBe(false);

    // Control: not held, the same stretch away lapses it.
    resetPhonePass();
    taken(beginPass(undefined, start));
    expect(passInFlight(start + 210_001)).toBe(false);
  });

  it("is held from where it was, not renewed: a wedged pass still loses it to a customer who keeps coming back", () => {
    const start = 1_000_000;
    taken(beginPass(undefined, start));
    let now = start;
    // A minute in front, ten seconds away, again and again.
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      passAwayChanged(true, now);
      now += 10_000;
      passAwayChanged(false, now);
    }
    // 180 s in front by now: past the guard.
    expect(passInFlight(now)).toBe(false);
  });

  it("goes on counting a pass that steps forward while away, as Android's can", () => {
    const start = 1_000_000;
    const pass = taken(beginPass(undefined, start));
    passAwayChanged(true, start + 100_000);
    ladderPass.progress(pass.generation, start + 150_000);
    passAwayChanged(false, start + 400_000);
    // The step forward was the last sign of life; nothing since was in front.
    expect(passInFlight(start + 400_000 + LADDER_MAX_MS - 1)).toBe(true);
    expect(passInFlight(start + 400_000 + LADDER_MAX_MS)).toBe(false);
  });

  it("is told by the app's visibility, registered once for the life of the app", async () => {
    vi.resetModules();
    const listeners: (() => void)[] = [];
    const doc = {
      visibilityState: "visible" as "visible" | "hidden",
      addEventListener: (type: string, fn: () => void) => {
        if (type === "visibilitychange") listeners.push(fn);
      },
    };
    vi.stubGlobal("document", doc);
    try {
      const fresh = await import("./phone-pass");
      const shared = await import("@shared/lib/ladder-pass");
      expect(listeners).toHaveLength(1);
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      taken(fresh.beginPass());
      vi.setSystemTime(1_010_000);
      doc.visibilityState = "hidden";
      listeners[0]!();
      vi.setSystemTime(1_310_000);
      doc.visibilityState = "visible";
      listeners[0]!();
      expect(shared.ladderPass.inFlight()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
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

describe("a press of Connect on its way to its pass", () => {
  // A Connect pressed over an automatic pass waits up to twenty seconds for
  // it to let go, then for its teardown and the consent dialog, before its
  // own pass begins. Settings opened and closed meanwhile, the screen
  // mounted on return read the platform as the automatic pass ended, said
  // "You're not protected" with Connect on the orb, and went on saying so
  // while the press, on the screen now gone, began its pass and dialled.

  it("is shown as connecting from whichever screen, while it is the press in force", () => {
    let live = true;
    const press = connectPressed(() => live);
    expect(connectPending()).toBe(true);
    // The screen it was made on shows it itself.
    expect(connectPending(press)).toBe(false);
    // A later press -- a stop, a pick -- or a sign-out owns the screen.
    live = false;
    expect(connectPending()).toBe(false);
    live = true;
    press.settle();
    expect(connectPending()).toBe(false);
  });

  it("tells the screens listening once it settles, with what it said on its own screen", () => {
    const heard: unknown[] = [];
    const stop = onConnectSettled((press, said) => heard.push({ press, said }));
    const press = connectPressed(() => true);
    const line = { kind: "serviceUnavailable", messageKey: "err.connectBusy", detail: "still running" } as const;
    press.settle({ line });
    press.settle({});
    expect(heard).toEqual([{ press, said: { line } }]);
    stop();
    connectPressed(() => true).settle();
    expect(heard).toHaveLength(1);
  });

  it("tells nobody once a later press owns the screen, which says what is on it itself", () => {
    const heard: unknown[] = [];
    onConnectSettled((press) => heard.push(press));
    // Overtaken by a stop, or by the end of the session.
    let live = true;
    const stopped = connectPressed(() => live);
    live = false;
    stopped.settle();
    // Overtaken by a newer Connect, still on its way.
    const first = connectPressed(() => true);
    const second = connectPressed(() => true);
    first.settle();
    expect(heard).toHaveLength(0);
    expect(connectPending()).toBe(true);
    second.settle();
    expect(heard).toEqual([second]);
  });
});

describe("the line a pass ended on", () => {
  it("is kept for a screen that reads its end without having run it", () => {
    // Set on the screen the pass began on, which was gone: a connect that
    // failed said nothing on the screen in front of the customer.
    const pass = taken(beginPass());
    expect(passSaid(pass.generation)).toBeUndefined();
    const line = { kind: "serverUnreachable", messageKey: "err.allProtocolsFailed", detail: "tried 3 of 3" } as const;
    pass.say(line);
    pass.end();
    expect(passSaid(pass.generation)).toEqual(line);
    // Only that pass's: a later one has said nothing yet.
    const next = taken(beginPass());
    expect(passSaid(next.generation)).toBeUndefined();
    next.say(null);
    expect(passSaid(next.generation)).toBeNull();
    expect(passSaid(pass.generation)).toBeUndefined();
  });

  it("is not a replaced pass's to say", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const old = taken(beginPass());
    vi.setSystemTime(1_000_000 + LADDER_MAX_MS + 1);
    const newer = taken(beginPass());
    old.say({ kind: "serverUnreachable", messageKey: "err.allProtocolsFailed", detail: "" });
    expect(passSaid(old.generation)).toBeUndefined();
    expect(passSaid(newer.generation)).toBeUndefined();
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
    const gone = standDown.indexOf("await engineGone();");
    expect(walk).toContain(
      "const engineGone = async () => {\n      if ((await waitForTeardown()) && pass.owns()) passTunnel.current = null;\n    };",
    );
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
    const gone = tail.indexOf("if (dialled) await engineGone();");
    const owned = tail.indexOf('if (!pass.owns() || sessionGeneration() !== sessionAtStart) return "failed";');
    expect(gone).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(gone);
    // A stop pressed during that wait -- up to eight seconds, the orb still
    // on "Checking connection..." -- owns the screen: the pass's error
    // line, "disconnected", a second release and a failed connect's record
    // used to follow it.
    const stopped = tail.indexOf("if (pass.stopped()) {\n      await standDown(false);\n      return reportCancelled();\n    }");
    expect(stopped).toBeGreaterThan(owned);
    // Before the screen, the slot or the report hears anything of it.
    for (const said of ["setConnectionError(heldBack !== null ? null : lastError);", "void deviceSlot.release();", "void reportAttempt("]) {
      expect(tail.indexOf(said), said).toBeGreaterThan(stopped);
    }
    // Set only where a rung is about to be dialled.
    expect(walk.split("dialled = true;").length - 1).toBe(1);
    expect(walk.indexOf("dialled = true;")).toBeLessThan(walk.indexOf("await connectIkev2({"));
  });

  it("reads what a pass it did not start left, when it ends", () => {
    expect(dashboard).toMatch(
      /ladderPass\.onEnd\(\(\) => \{\n\s+if \(ladderPass\.generation\.current === followedPassRef\.current\) return;\n\s+const said = passSaid\(ladderPass\.generation\.current\);\n\s+if \(said !== undefined\) setConnectionError\(said\);\n\s+if \(!loadedRef\.current\) return;\n\s+void adoptPlatformRef\.current\(/,
    );
    expect(body("async function runLadder(options: LadderOptions = {}): Promise<LadderOutcome> {")).toContain(
      "followedPassRef.current = pass.generation;",
    );
  });

  it("leaves a pass's end to a screen still loading, which reads the platform once it has the subscription", () => {
    // Read before the load had its subscription and credentials, the end of
    // a pass told the slot this phone had none: the slot's standing was
    // wiped, the landing's claim through the tunnel -- on such a network
    // the only one that reaches the API -- had its answer thrown away, and
    // on the cached path nothing ever adopted again, so the slot was never
    // claimed or renewed for the rest of the session.
    const load = dashboard.slice(
      dashboard.indexOf("async function loadAll(preferRouteId?: string) {"),
      dashboard.indexOf("async function loadScreen(preferRouteId: string | undefined, ready: () => void, retry: OfflineRetryTrigger | null = null): Promise<boolean> {"),
    );
    // Set as it is said, not as it is next rendered.
    expect(load.indexOf("loadedRef.current = false;")).toBeLessThan(load.indexOf("await loadScreen(preferRouteId, ready);"));
    expect(load).toMatch(/const ready = \(\) => \{\n\s+if \(loadRef\.current !== load\) return;\n\s+loadedRef\.current = true;\n\s+setLoaded\(true\);\n\s+\};/);
    // Both ways a load ends with something to dial read the platform with
    // what they loaded -- the cached one too, which never did.
    const screen = body("async function loadScreen(preferRouteId: string | undefined, ready: () => void, retry: OfflineRetryTrigger | null = null): Promise<boolean> {");
    // The cached one whichever way the load comes to it: failed, or still
    // waiting past eight seconds (`showCached`).
    const cached = screen.slice(screen.indexOf("if (cached) {"), screen.indexOf("setError(!meResult.ok"));
    expect(cached).toContain("await showCached(cached, preferRouteId, load, reason, sessionAtStart, ready);");
    const shown = body("async function showCached(");
    expect(shown).toContain("await adoptPlatform(sessionAtStart, cached.protocolUsers, cached.subscription, ready);");
    expect(screen).toContain("await adoptPlatform(sessionAtStart, usersResult.data, sub, ready);");
    // And over a pass under way, said at once, so a pass that ends between
    // that and the load's end is still read by the listener.
    const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
    const inFlight = adopt.slice(
      adopt.indexOf("if (passInFlight() || pressElsewhere) {"),
      adopt.indexOf("return;", adopt.indexOf("if (passInFlight() || pressElsewhere) {")),
    );
    expect(inFlight).toContain("ready();");
  });

  it("names, credits and proves an adopted tunnel only as the pass that landed it, and never adopts one it rejected", () => {
    // The platform cannot say which credential is up, nor whether the pass
    // proved it. A failed rung's engine outliving the pass's wait read as
    // "You're protected" and armed the episode over it, ending its
    // remaining attempts; and a tunnel landed on another route than the
    // screen's had its sustained success credited to the screen's route.
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const dial = walk.indexOf('passTunnel.current = "unproven";');
    expect(dial).toBeGreaterThan(walk.indexOf("dialled = true;"));
    expect(dial).toBeLessThan(walk.indexOf("await connectIkev2({"));
    const landed = walk.indexOf("passTunnel.current = candidate;");
    expect(landed).toBeGreaterThan(walk.indexOf('if (outcome !== "notCarrying") {'));
    expect(landed).toBeLessThan(walk.indexOf('return "connected";'));
    const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
    expect(adopt).toContain(
      'leftOver = adopted !== "disconnected" && !tearingDown && passTunnel.current === "unproven";',
    );
    expect(adopt).toContain('setConnectionState(leftOver ? "disconnected" : slotTeardownShown(tearingDown, adopted));');
    expect(adopt).toContain('if (adopted !== "disconnected" && !tearingDown && !leftOver) {');
    expect(adopt).toContain("if (on !== null) setProtocolUser(on);");
    expect(adopt).toContain("setBaselineIp(on !== null ? ladderPass.baseline.current : null);");
    // Armed on the stamp taken before the platform was asked.
    expect(adopt.indexOf("const reconnectStamp = autoReconnect.stamp();")).toBeLessThan(
      adopt.indexOf("await withTimeout(vpnStatus()"),
    );
    expect(adopt).toContain("autoReconnect.tunnelUp({ routeId: null, stamp: reconnectStamp });");
  });

  it("shows a teardown the device limit began on a screen now gone", () => {
    // A late refusal of a landed pass's claim reached the screen the pass
    // began on, gone since Settings was opened and closed. The teardown and
    // the card went ahead; this screen said "You're protected" beside them,
    // and over no tunnel at all afterwards.
    const start = dashboard.indexOf("const slotTeardownSeenRef = useRef(slotTeardownState);");
    expect(start).toBeGreaterThan(0);
    const effect = dashboard.slice(start, dashboard.indexOf("}, [slotTeardownState]);", start));
    expect(effect).toContain('setConnectionState((shown) => (tunnelUp(shown) ? "disconnecting" : shown));');
    expect(effect).toContain('if (was !== "none" && !customerTeardown.owed()) {');
    expect(effect).toContain('setConnectionState((shown) => (shown === "disconnecting" ? "disconnected" : shown));');
  });

  it("files a stopped pass as the customer's only when a press stopped it", () => {
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const report = walk.slice(walk.indexOf("const reportCancelled = (): LadderOutcome => {"));
    expect(report).toMatch(/^const reportCancelled = \(\): LadderOutcome => \{\n\s+if \(!pass\.pressed\(\)\) return "cancelled";\n\s+void reportAttempt\(/);
    // Signed out during the egress check: taken down silently, as after
    // the connect -- nothing filed for a session that is over.
    const checked = walk.indexOf("const verdict = await confirmEgress(baseline, {");
    const session = walk.indexOf("if (sessionGeneration() !== sessionAtStart) {", checked);
    expect(session).toBeGreaterThan(checked);
    expect(session).toBeLessThan(walk.indexOf("if (verdict === null || pass.stopped()) {"));
    expect(walk.slice(session, walk.indexOf('return "failed";', session))).toContain(
      "await forgetProfiles().catch(() => disconnect()).catch(() => undefined);",
    );
  });

  it("shows a pass under way as one, on mounting and on loading, and never reads the platform under it", () => {
    expect(dashboard).toMatch(
      /useState<ConnectionState>\(\(\) =>\s+passInFlight\(\) \|\| connectPending\(\) \? "connecting" : "disconnected",?\s+\)/,
    );
    const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
    const inFlight = adopt.indexOf("if (passInFlight() || pressElsewhere) {");
    expect(inFlight).toBeGreaterThan(0);
    expect(inFlight).toBeLessThan(adopt.indexOf("await withTimeout(vpnStatus()"));
    expect(adopt.slice(inFlight, adopt.indexOf("}", inFlight))).toContain('setConnectionState("connecting")');
    // An answer overtaken while it was asked is not written.
    expect(adopt.split("if (overtaken()) return;").length - 1).toBe(3);
    // The adopted tunnel keeps the pass's baseline, so it can be proven.
    expect(adopt).toContain("setBaselineIp(on !== null ? ladderPass.baseline.current : null);");
    expect(body("async function loadScreen(preferRouteId: string | undefined, ready: () => void, retry: OfflineRetryTrigger | null = null): Promise<boolean> {")).toContain(
      "await adoptPlatform(sessionAtStart, usersResult.data, sub, ready);",
    );
  });

  it("lets Connect outrank an automatic pass, never dialling beside it", () => {
    const connect = body("async function connectNow(takeover?: string[]) {");
    const check = connect.indexOf("const over = pressOverPass({ takeover: takeover !== undefined });");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(connect.indexOf("await runLadder({ takeover })"));
    expect(connect).toContain("const letGo = await stopPassInFlight();");
    // A later press, or the end of the session, wins over this one still
    // waiting -- after every await before the ladder. A sign-out from
    // Settings reaches no press count: through the twenty-second wait for
    // a pass to let go, a press dialled the old account's credential
    // behind the sign-in screen.
    expect(connect).toContain(
      "const superseded = () => pressRef.current !== press || sessionGeneration() !== sessionAtPress;",
    );
    expect(connect.indexOf("const sessionAtPress = sessionGeneration();")).toBeLessThan(
      connect.indexOf("const letGo = await stopPassInFlight();"),
    );
    expect(connect).not.toContain("if (pressRef.current !== press) return;");
    const checks: number[] = [];
    for (let at = connect.indexOf("if (superseded()) return;"); at >= 0; ) {
      checks.push(at);
      at = connect.indexOf("if (superseded()) return;", at + 1);
    }
    expect(checks).toHaveLength(3);
    expect(checks[0]).toBeGreaterThan(connect.indexOf("const letGo = await stopPassInFlight();"));
    expect(checks[1]).toBeGreaterThan(connect.indexOf("settleTeardown(result);"));
    expect(checks[2]).toBeGreaterThan(connect.indexOf("await requestVpnPermission()"));
    expect(checks[2]).toBeLessThan(connect.indexOf("await runLadder({ takeover })"));
    // One that does not let go in time: said, and not dialled.
    expect(connect).toMatch(/if \(!letGo\) \{[^]*?messageKey: "err\.connectBusy"[^]*?return;\n\s+\}/);
    // The customer's own connect already running, and still wanted, is
    // followed, not doubled; anything else is taken over (`pressOverPass`).
    expect(connect).toMatch(/if \(over === "follow"\) \{[^}]*return;\n\s+\}/);
    expect(connect).toContain('if (over === "takeOver") {');
  });

  it("arms the landing of a pass a press followed, on that press's stamp", () => {
    // The press's own `cancel` overrules the stamp the pass took as it
    // began, and the landing of the very connect it chose to follow went
    // unarmed: "You're protected", and its drop reconnected nothing.
    const connect = body("async function connectNow(takeover?: string[]) {");
    const follow = connect.slice(connect.indexOf('if (over === "follow") {'));
    expect(follow.slice(0, follow.indexOf("return;"))).toContain("followPass(autoReconnect.stamp());");
    expect(connect.indexOf('autoReconnect.cancel("customer");')).toBeLessThan(connect.indexOf('if (over === "follow") {'));
    // So does the press another pass beat to the guard, which it follows too.
    const declined = connect.slice(connect.indexOf('if ((await runLadder({ takeover })) === "declined") {'));
    expect(declined.slice(0, declined.indexOf("\n    }\n"))).toContain("followPass(autoReconnect.stamp());");
    // And the landing quotes whichever is the latest.
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    expect(walk).toContain(
      "autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true, stamp: pass.landing(reconnectStamp) });",
    );
    expect(walk).not.toContain("fresh: true, stamp: reconnectStamp });");
  });

  it("waits for the last rung's engine before letting go, at every stop in the walk", () => {
    // The previous rung's engine is told to stop at the end of its rung and
    // not waited for. A pass stopped by no press -- its attempt over by its
    // ceiling -- then told the screen what the platform had up: that
    // engine on its way down, shown as "Connected, not confirmed", or
    // "You're protected" over a fresh WireGuard handshake.
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const loop = walk.slice(walk.indexOf("for (const [index, candidate] of candidates.entries()) {"));
    const top = loop.slice(0, loop.indexOf("pass.progress();"));
    expect(top).toContain("await standDown(dialled);");
    const dial = loop.indexOf("dialled = true;");
    const beforeDial = loop.slice(loop.lastIndexOf("if (pass.stopped()) {", dial), dial);
    expect(beforeDial).toContain("await standDown(dialled);");
    expect(loop.slice(0, dial)).not.toContain("await standDown(false);");
  });

  it("shows an engine a pass dialled and never proved as nothing up, whoever ends the pass", () => {
    // Its engine can outlive the wait for it; read raw, the screen said
    // "Connected, not confirmed" over a rung the pass rejected, beside the
    // episode's "VPN connection lost", and the health poll started over it.
    const settle = body("async function settleUndialled() {");
    expect(settle).toContain(
      'const leftOver = state !== "disconnected" && !tearingDown && passTunnel.current === "unproven";',
    );
    expect(settle).toContain('setConnectionState(leftOver ? "disconnected" : state);');
    expect(settle).toContain("const tearingDown = slotTeardown.owed() || customerTeardown.owed();");
    expect(settle).not.toContain("setConnectionState(state);");
  });

  it("shows a Connect pressed on a screen since gone as connecting until it settles, then what it said", () => {
    // Waiting on a screen that unmounted, the press began its pass behind a
    // screen saying "You're not protected" with Connect on the orb, and a
    // pass that failed said so on the screen that was gone.
    const connect = body("async function connectNow(takeover?: string[]) {");
    const pressed = connect.indexOf("const underWay = connectPressed(() => !superseded());");
    expect(pressed).toBeGreaterThan(connect.indexOf("const superseded = () =>"));
    expect(pressed).toBeLessThan(connect.indexOf('autoReconnect.cancel("customer");'));
    expect(connect).toContain("pressedHereRef.current = underWay;");
    // However it ends: after its pass, or before one.
    expect(connect).toMatch(/\} finally \{\n\s+underWay\.settle\(said\);\n\s+\}\n?$/);
    expect(connect.indexOf("try {")).toBeLessThan(connect.indexOf('autoReconnect.cancel("customer");'));
    // What it says on its own screen goes with it.
    expect(connect).toMatch(/if \(!letGo\) \{[^]*?say\(\{[^]*?messageKey: "err\.connectBusy"/);
    expect(connect).toContain("said.permissionDenied = true;");
    expect(connect).toContain("say(classifyConnectionError(err));");
    expect(connect).not.toContain("setConnectionError(classifyConnectionError(err));");
    // A screen mounted meanwhile shows it as connecting, and does not read
    // the platform under it -- unless the press is its own.
    const adopt = body("async function adoptPlatform(\n    sessionAtStart: number,");
    expect(adopt).toContain("const pressElsewhere = connectPending(pressedHereRef.current);");
    expect(adopt.indexOf("if (passInFlight() || pressElsewhere) {")).toBeLessThan(
      adopt.indexOf("await withTimeout(vpnStatus()"),
    );
    // And reads it once the press settles, with its words.
    expect(dashboard).toMatch(
      /onConnectSettled\(\(press, said: PressSaid\) => \{\n\s+if \(press === pressedHereRef\.current\) return;\n\s+if \(said\.line !== undefined\) setConnectionError\(said\.line\);\n\s+if \(said\.permissionDenied === true\) setPermissionDenied\(true\);\n\s+if \(!loadedRef\.current\) return;\n\s+void adoptPlatformRef\.current\(/,
    );
  });

  it("keeps the line a pass ends on with the pass, for a screen mounted since", () => {
    const walk = body("async function walkLadder(pass: PhonePass, options: LadderOptions): Promise<LadderOutcome> {");
    const shown = walk.indexOf("setConnectionError(heldBack !== null ? null : lastError);");
    expect(walk.indexOf("pass.say(heldBack !== null ? null : lastError);")).toBeGreaterThan(shown);
    expect(walk).toContain("setConnectionError(none);");
    expect(walk.indexOf("pass.say(none);")).toBeGreaterThan(walk.indexOf("setConnectionError(none);"));
    // Refused by the plan: the card is the app's already, the line is kept.
    expect(walk).toContain("pass.say(showSlotStop(stop, options.reconnect));");
    expect(dashboard).toContain(
      "function showSlotStop(stop: SlotStop, reconnect?: ReconnectAttempt): ClassifiedError | null {",
    );
  });
});
