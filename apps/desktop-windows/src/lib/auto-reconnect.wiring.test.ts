import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Windows dashboard's half of the automatic reconnect, which the
 * pure tests in auto-reconnect.test.ts cannot reach.
 *
 * Source assertions, like the liveness wiring in
 * connection-evidence.test.ts and for the same reason: the dashboard
 * needs a Tauri runtime, the helper service and a network, so nothing in
 * this suite can watch what it does. What can be pinned is that each
 * decision goes through the tested rule rather than around it. Every
 * assertion here fails against the dashboard as it was before the
 * reconnect existed. */

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const repair = readFileSync(new URL("../components/RepairNetwork.tsx", import.meta.url), "utf8");

/** The body of a function, from its signature to the first line that
 * closes it at the indentation it was declared at. */
function body(signature: string, indent = "  "): string {
  const start = dashboard.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  return dashboard.slice(start, dashboard.indexOf(`\n${indent}}\n`, start));
}

describe("where an episode begins", () => {
  const publishDrop = body("function publishDrop(generation: number): boolean {");

  it("notices a drop that happened while the screen was away in Settings", () => {
    // Both polls unmount with the screen. The one mounted on return asks
    // the service, and a tunnel the app was vouching for that is now
    // verifiably gone is a drop -- through the same rule as the polls.
    const adopt = body("async function adoptServiceState(sub: Subscription | null): Promise<ConnectionState | null> {");
    const vouched = adopt.indexOf("const vouched = vouching(autoReconnect.current(), sessionGeneration());");
    const mark = adopt.indexOf("const mark = statusDisturbances.mark();");
    const asked = adopt.indexOf("const adopted = await syncFromService();");
    expect(vouched).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(0);
    expect(asked).toBeGreaterThan(Math.max(vouched, mark));
    expect(adopt).toContain(
      "droppedUnseen(vouched, intentRef.current.intent, lastStatusRef.current, statusDisturbances.since(mark))",
    );
    expect(adopt.indexOf("publishDrop(generation);")).toBeGreaterThan(asked);
  });

  it("forgets a tunnel the app ended itself, or that ended where it could not see", () => {
    const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
    // The mid-session failover's teardown is the app's own: a pass that
    // landed nothing forgets the armed tunnel -- before it announces its
    // end, so no adopting screen can take it for a drop.
    const forget = ladder.indexOf("if (!landed && !options.reconnect) autoReconnect.forget();");
    expect(forget).toBeGreaterThan(0);
    expect(forget).toBeLessThan(ladder.indexOf("ladderPass.ended();"));
    // "Nothing is running", found by a recheck, was not a drop either.
    expect(dashboard).toContain('if (settled === "disconnected") autoReconnect.forget();');
    expect(dashboard).toContain('if ((await syncFromService()) === "disconnected") autoReconnect.forget();');
  });

  it("begins only at the screen's own drop, after the rule has agreed it is one", () => {
    expect(publishDrop).toContain("autoReconnect.dropped({ exclusion: reconnectExclusion() })");
    // After the drop is on screen and every answer in flight is old news,
    // never before.
    expect(publishDrop.indexOf("autoReconnect.dropped(")).toBeGreaterThan(
      publishDrop.indexOf("intentRef.current = supersedeAnswers(intentRef.current);"),
    );
    // And nowhere else: no other path can start reconnecting.
    expect(dashboard.split("autoReconnect.dropped(").length).toBe(2);
  });

  it("gives the slot back only when nothing is coming back", () => {
    expect(publishDrop).toContain('=== "lost") void deviceSlot.release();');
  });

  it("rules out the device limit, a plan that stopped, and gaming mode", () => {
    const exclusion = body("function reconnectExclusion(): ReconnectStop | null {");
    expect(exclusion).toContain('if (slotLostRef.current || slotTeardown.owed()) return "refused";');
    expect(exclusion).toContain('return "notEntitled";');
    expect(exclusion).toContain('if (appModeRef.current === "gaming") return "excluded";');
  });
});

/** The runner the dashboard binds, from `autoReconnect.bind(` to the line
 * that closes it. */
function boundRunner(): string {
  const start = dashboard.indexOf("autoReconnect.bind(async (attempt) => {");
  expect(start).toBeGreaterThan(0);
  const end = dashboard.indexOf("\n    });\n", start);
  expect(end).toBeGreaterThan(start);
  return dashboard.slice(start, end);
}

describe("what an attempt is", () => {
  const start = dashboard.indexOf("autoReconnect.bind(async (attempt) => {");
  const runner = boundRunner();
  const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));

  it("is an ordinary automatic ladder pass, judged by its own evidence", () => {
    expect(start).toBeGreaterThan(0);
    expect(runner).toContain("runLadderRef.current({ automatic: true, reconnect: attempt })");
    expect(runner).toContain("reconnectOutcomeOf(outcome, passResultRef.current)");
    // The runner claims nothing about the tunnel: only the pass's own
    // verdict reaches the screen.
    expect(runner).not.toContain("setConnectionState(");
    expect(runner).not.toContain("publishObserved(");
  });

  it("asks the exclusions again before every attempt", () => {
    expect(runner).toContain("const excluded = reconnectExclusion();");
  });

  it("leads with the route that was up", () => {
    expect(ladder).toContain("resumeRouteId: options.reconnect?.resumeRouteId ?? null,");
  });

  it("is reported as automatic, whether it lands or not", () => {
    expect(ladder.split("asReconnectReport(").length - 1).toBe(2);
    expect(ladder.split("options.reconnect,\n").length - 1).toBe(2);
  });

  it("arms the episode's clock only for a pass that is not itself a reconnect", () => {
    expect(ladder).toContain(
      "if (!options.reconnect) {\n              autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true, stamp: reconnectStamp });",
    );
  });

  it("quotes the stamp the pass took as it began, before anything it awaits", () => {
    // Taken after the press that began the pass, and before the first
    // await -- the window in which a later press could slip in unseen.
    const head = ladder.slice(0, ladder.indexOf("try {"));
    expect(head).toContain("const reconnectStamp = autoReconnect.stamp();");
    expect(head).not.toContain("await ");
    expect(ladder.split("autoReconnect.tunnelUp(").length - 1).toBe(1);
  });

  it("arms a tunnel adopted from the service, unless something overruled the answer while it was asked", () => {
    const adopt = body("async function adoptServiceState(sub: Subscription | null): Promise<ConnectionState | null> {");
    const taken = adopt.indexOf("const reconnectStamp = autoReconnect.stamp();");
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(adopt.indexOf("const adopted = await syncFromService();"));
    expect(adopt).toContain("autoReconnect.tunnelUp({ routeId: null, stamp: reconnectStamp });");
    // Nowhere else is a tunnel armed without a stamp.
    expect(dashboard.split("autoReconnect.tunnelUp(").length - 1).toBe(2);
  });
});

describe("a pass the customer stopped while it verified", () => {
  // Verifying takes seconds, and a stop pressed meanwhile cannot recall the
  // request in flight: a tunnel that carried it answers "connected" about
  // a connect the customer called off. Taken as a landing, the pass armed
  // the reconnect for the tunnel the stop was taking down, and the next
  // screen back from Settings said "VPN connection lost" and dialled.
  const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
  const landing = ladder.slice(ladder.indexOf('if (verdict === "connected" || verdict === "unverified") {'));
  const check = landing.indexOf("if (cancelRef.current || ladderGenerationRef.current !== generation) break;");

  it("is cancelled at the last moment it can hear the stop, not landed", () => {
    expect(check).toBeGreaterThan(0);
    // After the last await of the landing: the split-tunnel push...
    expect(check).toBeGreaterThan(landing.indexOf("exitOfRoute(routes, candidate.routeId),"));
    // ...with nothing awaited between it and the end of the landing.
    const rest = landing.slice(check, landing.indexOf('return "connected";'));
    expect(rest).not.toContain("await ");
    // And before anything that records a landing.
    for (const recorded of [
      "rememberLastGood(",
      "recordAttempt(",
      'outcome: "SUCCESS"',
      "autoReconnect.tunnelUp(",
      "deviceSlot.afterConnected(",
      "landed = true;",
    ]) {
      expect(landing.indexOf(recorded), recorded).toBeGreaterThan(check);
    }
  });

  it("and one whose session ended meanwhile takes its own tunnel down, as after the connect", () => {
    const signedOut = landing.indexOf("if (sessionGeneration() !== sessionAtStart) {");
    expect(signedOut).toBeGreaterThan(0);
    expect(signedOut).toBeLessThan(check);
    expect(landing.slice(signedOut, check)).toContain("await serviceDisconnect().catch(() => undefined);");
  });
});

describe("which screen runs an attempt", () => {
  // An attempt that fell due while Settings was open is held, unspent,
  // until a screen binds -- and `bind` starts it there and then (see
  // "holds an overdue attempt through a screen's load" in
  // auto-reconnect.test.ts). Bound at mount, the screen had no
  // credential yet, and the attempt was declined and counted as failed.
  const runner = boundRunner();
  const start = dashboard.indexOf("autoReconnect.bind(async (attempt) => {");
  const effect = dashboard.slice(dashboard.lastIndexOf("useEffect(", start), dashboard.indexOf("\n  }, [", start));

  it("is one that has loaded, bound again after every load", () => {
    expect(effect).toMatch(/^useEffect\(\(\) => \{\n\s+if \(loading\) return;\n\s+return autoReconnect\.bind\(async \(attempt\) => \{/);
    expect(dashboard.slice(dashboard.indexOf("\n  }, [", start), dashboard.indexOf("\n  }, [", start) + 20)).toContain(
      "}, [loading]);",
    );
  });

  it("on a screen that loaded nothing to dial, ends the episode rather than spending its attempts", () => {
    const check = runner.indexOf('if (protocolUserRef.current === null) return { kind: "stop", why: "excluded" };');
    expect(check).toBeGreaterThan(runner.indexOf("const excluded = reconnectExclusion();"));
    expect(check).toBeLessThan(runner.indexOf("runLadderRef.current("));
    // The credential the screen has now, not the one it had when bound.
    expect(dashboard).toContain("protocolUserRef.current = protocolUser;");
  });
});

describe("the customer outranks it", () => {
  it("every press but a recheck takes over", () => {
    const toggle = body("async function handleConnectToggle(action: PressAction) {");
    expect(toggle).toContain('if (action !== "recheck") autoReconnect.cancel("customer");');
    // Before the press does anything else.
    expect(toggle.indexOf('autoReconnect.cancel("customer")')).toBeLessThan(toggle.indexOf("switch (action)"));
  });

  it("so does a connect from the device-limit card", () => {
    expect(body("async function connectNow(takeover?: string[]) {")).toContain('autoReconnect.cancel("customer");');
  });

  it("and a change of mode, of server, or a repair", () => {
    expect(body("async function changeMode(next: AppMode) {")).toContain('autoReconnect.cancel("customer");');
    const picker = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    expect(picker.split('autoReconnect.cancel("customer");').length - 1).toBe(2);
    expect(repair).toContain('autoReconnect.cancel("customer");');
  });

  it("Stop reconnecting stops it, and leaves 'connection lost' to be said", () => {
    const stop = body("async function stopReconnecting() {");
    expect(stop).toContain('autoReconnect.cancel("stopped");');
    expect(dashboard).toContain("onClick={() => void stopReconnecting()}");
  });

  it("a sign-out and the device limit end it too", () => {
    expect(body("async function handleLogout() {")).toContain('autoReconnect.cancel("signedOut");');
    expect(body("async function endForSlot(event: SlotStopReason) {")).toContain('autoReconnect.cancel("refused");');
  });
});

describe("what the screen says", () => {
  it("takes the words from the table, episode included", () => {
    expect(dashboard).toContain(
      "headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect), customMode: splitTunnelActive, reconnecting })",
    );
    expect(dashboard).toContain("pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true })");
  });
});
