import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../components/ConnectOrb";
import {
  concludeIntent,
  declareIntent,
  IDLE_INTENT,
  isCurrent,
  movesTunnel,
  phaseFor,
  pressFor,
  type Intent,
} from "./connect-intent";

/** The behaviour these tests exist to prevent coming back.
 *
 * Reported against desktop 0.9.28: "sometimes when I click the connect
 * button, instead of showing me the connecting state it shows me the
 * DISCONNECTING state, and it stops after 1-2 seconds. I need to click
 * connect 3-4 times until it actually shows connecting and then
 * connects."
 *
 * Written with a control for every claim. This repo has shipped tests
 * that could not come back negative, so each block below first
 * reproduces the defect against the pre-fix rule -- spelled out here as
 * `publishedBefore`, which is exactly what Dashboard.tsx used to do --
 * and only then asserts the fix. A test that passes against both is
 * measuring nothing.
 */

/** What the dashboard did before this module existed: whatever came back
 * went straight on screen, worded as the service worded it, whether or
 * not the customer had asked for it and whether or not a press had
 * overtaken it. */
function publishedBefore(_intent: Intent, observed: ConnectionState): ConnectionState {
  return observed;
}

describe("a connect never narrates its own teardown", () => {
  // Both of these are real teardowns that happen inside a connect, and
  // neither one is anything the customer asked for:
  //
  //   - the ladder clears whatever is up before it dials, or a dead
  //     protocol's routes black-hole every probe for the next one
  //     (Dashboard.tsx, runLadder)
  //   - the service does it again for itself: connect_inner opens with
  //     `self.disconnect()?` (service/src/engines/mod.rs)
  //
  // Plus the cleanup a failed pass does before it reports. That last one
  // is the one the customer saw.
  const insideAConnect: ConnectionState[] = ["disconnected", "disconnecting"];

  it.each(insideAConnect)("shows %s as connecting while a connect is in flight", (observed) => {
    // Control: the old rule put the teardown on screen verbatim. For
    // "disconnecting" that is the reported bug, word for word.
    expect(publishedBefore("connect", observed)).toBe(observed);

    expect(phaseFor("connect", observed)).toBe("connecting");
  });

  it("reproduces the report end to end, and shows it no longer happens", () => {
    // The customer presses Connect on an idle app. The pass fails --
    // which it does, intermittently, on a censored network -- and tears
    // down before reporting.
    const observedDuringTheAttempt: ConnectionState[] = [
      "disconnected", // the ladder's pre-dial teardown
      "disconnecting", // the failed pass cleaning up before it reports
      "disconnected", // settled, outcome known
    ];

    const before = observedDuringTheAttempt.map((o) => publishedBefore("connect", o));
    expect(before).toContain("disconnecting");

    // Only the last observation is published with the operation over --
    // see runLadder, which lifts the intent before asking for the
    // settled answer, or the spinner would never end.
    const after = [
      phaseFor("connect", observedDuringTheAttempt[0]!),
      phaseFor("connect", observedDuringTheAttempt[1]!),
      phaseFor("idle", observedDuringTheAttempt[2]!),
    ];
    expect(after).toEqual(["connecting", "connecting", "disconnected"]);
  });

  it("still says it cannot tell, rather than assuming the connect is going well", () => {
    // The one thing a connect in flight must not be allowed to do is
    // paper over an unreachable service with optimism. "Can't tell right
    // now" outranks the wording rule.
    expect(phaseFor("connect", "unknown")).toBe("unknown");
  });

  it("shows a teardown the customer did ask for as a teardown", () => {
    expect(phaseFor("disconnect", "disconnecting")).toBe("disconnecting");
    expect(phaseFor("disconnect", "connected")).toBe("connected");
    expect(phaseFor("idle", "disconnecting")).toBe("disconnecting");
  });
});

describe("an answer that was already in flight cannot decide what the next press does", () => {
  it("drops a poll taken before the press that overtook it", () => {
    // The health poll starts while the tunnel is up. Its callback then
    // waits -- a status call has a six-second budget and the egress
    // probe below it has its own -- and the only guard it had was
    // checked before all of that waiting, not after.
    let intent = IDLE_INTENT;
    const pollGeneration = intent.generation;

    // Meanwhile the customer presses Connect.
    intent = declareIntent(intent, "connect");

    // The poll's verdict finally arrives. It is about a tunnel that has
    // since been asked to be replaced.
    expect(isCurrent(intent, pollGeneration)).toBe(false);
  });

  it("is what stopped the button meaning the opposite of its label", () => {
    let intent = IDLE_INTENT;
    const pollGeneration = intent.generation;
    intent = declareIntent(intent, "connect");

    // Control: published unconditionally, a stale "connected" lands on a
    // screen in the middle of a connect...
    const phaseBefore = publishedBefore(intent.intent, "connected");
    expect(phaseBefore).toBe("connected");
    // ...and the very next press therefore dispatches a teardown, on an
    // app the customer just asked to connect.
    expect(pressFor(phaseBefore).action).toBe("disconnect");

    // With the stamp checked, the answer never reaches the screen, so
    // the phase is still the one the press set.
    const publish = isCurrent(intent, pollGeneration) ? phaseFor(intent.intent, "connected") : null;
    expect(publish).toBeNull();
    expect(pressFor("connecting").action).not.toBe("disconnect");
  });

  it("counts two consecutive presses as two operations", () => {
    // Pressing Connect twice is two attempts, and an answer owed to the
    // first must not be allowed to describe the second.
    const first = declareIntent(IDLE_INTENT, "connect");
    const second = declareIntent(first, "connect");
    expect(isCurrent(second, first.generation)).toBe(false);
  });

  it("lets an operation finish without invalidating what it learned", () => {
    // Ending is not being superseded. An observation taken during the
    // operation is still the newest thing anyone knows.
    const running = declareIntent(IDLE_INTENT, "connect");
    const done = concludeIntent(running, running.generation);
    expect(done.intent).toBe("idle");
    expect(isCurrent(done, running.generation)).toBe(true);
  });

  it("does not let a superseded operation declare the app idle", () => {
    const stalled = declareIntent(IDLE_INTENT, "connect");
    const live = declareIntent(stalled, "disconnect");
    // The stalled pass finally wakes up and tries to finish.
    expect(concludeIntent(live, stalled.generation)).toEqual(live);
  });
});

describe("the control cannot promise one thing and do another", () => {
  /** What each label says to the customer, in the shipped English copy,
   * written out here rather than read back out of `PRESS` -- a table
   * compared against itself proves nothing. */
  const PROMISE: Record<ConnectionState, { label: string; expects: "up" | "down" | "neither" }> = {
    disconnected: { label: "Connect", expects: "up" },
    unknown: { label: "Check status", expects: "neither" },
    connecting: { label: "Connecting...", expects: "down" },
    verifying: { label: "Checking connection...", expects: "down" },
    connected: { label: "Connected", expects: "down" },
    // A tunnel is up, so the press takes it down exactly as it does from
    // "connected". The label is what has to differ: the word "Connected"
    // on this button would make the claim the state exists to withhold.
    unverified: { label: "Not confirmed", expects: "down" },
    degraded: { label: "Not carrying traffic", expects: "down" },
    disconnecting: { label: "Disconnecting...", expects: "down" },
  };

  const every = Object.keys(PROMISE) as ConnectionState[];

  it.each(every)("a press from %s moves the tunnel the way its label implies", (state) => {
    expect(movesTunnel(pressFor(state).action)).toBe(PROMISE[state]!.expects);
  });

  it("covers every phase, with no fallback to guess with", () => {
    // The old label chain ended in `: t("dash.connect")`, so a phase
    // nobody had thought about rendered as a promise to connect while
    // the press branched on its own separate chain elsewhere.
    for (const state of every) {
      expect(pressFor(state)).toBeDefined();
      expect(pressFor(state).labelKey).toBeTypeOf("string");
    }
  });

  it("keys the label off the same table the action comes from", () => {
    const labels = new Map(every.map((s) => [s, pressFor(s).labelKey]));
    expect(labels.get("disconnected")).toBe("dash.connect");
    expect(labels.get("unknown")).toBe("dash.recheck");
    expect(labels.get("connecting")).toBe("dash.connecting");
  });
});

describe("the wiring the pure functions cannot check", () => {
  // Deliberately a source assertion. The dashboard needs a Tauri
  // runtime, a helper service and a real network to exercise, so nothing
  // in this suite can observe what it actually publishes. What can be
  // pinned is the one line the customer saw: the ladder is not allowed
  // to word its own cleanup as a teardown. This assertion fails against
  // the code as it shipped in 0.9.28.
  const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const ladder = source.slice(source.indexOf("async function runLadder"));

  it("does not set a disconnecting phase anywhere inside a connect", () => {
    expect(ladder).not.toContain('setConnectionState("disconnecting")');
  });

  it("declares a connect intent before it starts dialling", () => {
    expect(ladder).toContain('beginIntent("connect")');
  });

  it("lets the transient recheck retire the intent of a pass that stalled", () => {
    // The other way round from the reported bug, and introduced by
    // fixing it: `phaseFor` rewords a "disconnected" into "connecting"
    // for as long as a connect is declared in flight, so a pass that
    // stalls past its own deadline would hold the spinner for ever. The
    // recheck that exists to end stuck transient states has to be able
    // to end the intent behind them too.
    const end = source.indexOf("}, recheckMs);");
    expect(end).toBeGreaterThan(0);
    const recheck = source.slice(source.lastIndexOf("const id = setInterval", end), end);

    expect(recheck).toContain("endIntent(intentRef.current.generation)");
  });

  it("makes the health poll quote a stamp instead of writing the phase directly", () => {
    // The poll's callback runs for seconds -- a status call has a
    // six-second budget and the egress probe below it has its own -- and
    // its only guard was checked before all of that waiting. Every write
    // it makes has to go through `publishObserved`, which is where the
    // "has this been overtaken" question is asked, or a press that
    // landed mid-callback gets overwritten by an answer older than
    // itself.
    // The callback is now a named `check`, invoked both on a leading
    // edge and on the interval, so the slice is taken from its
    // declaration rather than from an inline `setInterval`.
    const start = source.indexOf("const check = async () => {");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("const id = setInterval(() => void check(), HEALTH_POLL_MS);", start);
    expect(end).toBeGreaterThan(start);
    const poll = source.slice(start, end);

    expect(poll).toContain("const generation = intentRef.current.generation;");
    expect(poll).not.toContain("setConnectionState(");
  });
});
