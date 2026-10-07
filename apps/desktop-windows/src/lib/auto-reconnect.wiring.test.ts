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
    const vouched = adopt.indexOf("const vouched = vouching(autoReconnect.current());");
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

describe("what an attempt is", () => {
  const start = dashboard.indexOf("autoReconnect.bind(async (attempt) => {");
  const runner = dashboard.slice(start, dashboard.indexOf("}),", start));
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
      "if (!options.reconnect) autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true });",
    );
  });

  it("arms a tunnel adopted from the service", () => {
    const adopt = body("async function adoptServiceState(sub: Subscription | null): Promise<ConnectionState | null> {");
    expect(adopt).toContain("autoReconnect.tunnelUp({ routeId: null });");
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
