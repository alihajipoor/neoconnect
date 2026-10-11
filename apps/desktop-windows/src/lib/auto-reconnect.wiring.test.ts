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
    // end, so no adopting screen can take it for a drop. Only while it is
    // still the current pass: one a newer pass replaced forgot the tunnel
    // that pass had landed and armed.
    const forget = ladder.indexOf(
      "if (!landed && !options.reconnect && ladderGenerationRef.current === generation) autoReconnect.forget();",
    );
    expect(forget).toBeGreaterThan(0);
    expect(forget).toBeLessThan(ladder.indexOf("ladderPass.ended();"));
    expect(ladder.split("autoReconnect.forget();").length - 1).toBe(1);
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

  it("and the episode gives it back when it ends before a claim, or waits for the app", () => {
    // The app's one controller, wired to the app's one slot: an episode
    // ended by the phone's own checks, a plan no longer active or nothing
    // to dial released nothing, and a phone's episode waiting for the app
    // to be opened kept the slot from the customer's other device.
    const controller = readFileSync(new URL("./auto-reconnect.ts", import.meta.url), "utf8");
    expect(controller).toContain(
      'slotIdle: (how) => void (how === "ended" ? deviceSlot.release() : deviceSlot.setAside()),',
    );
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

  it("renews the attempt at every rung, beside the guard", () => {
    // Its ceiling runs from the last sign of life, as the guard's does;
    // renewed by nothing, it gave up on a long ladder still dialling.
    expect(ladder).toContain("ladderPass.progress(generation);\n        options.reconnect?.progress();");
    expect(ladder.split("options.reconnect?.progress();").length - 1).toBe(1);
  });

  it("is reported as automatic, whether it lands or not", () => {
    expect(ladder.split("asReconnectReport(").length - 1).toBe(2);
    expect(ladder.split("options.reconnect,\n").length - 1).toBe(2);
  });

  it("reports a stop by the slot as the reconnect's own, and ends the episode on what stopped it", () => {
    // Sent as it was, a refusal of the reconnect's claim read as the
    // customer pressing Connect and being refused; and a subscription that
    // had ended was filed as the device limit refusing the device.
    const show = body("function showSlotStop(stop: SlotStop, reconnect?: ReconnectAttempt) {");
    expect(show).toContain("if (stop.report) void reportAttempt(asReconnectReport(stop.report, reconnect));");
    expect(dashboard.split("void reportAttempt(stop.report)").length - 1).toBe(0);
    const start = ladder.indexOf("if (stoppedBySlot !== null) {");
    expect(start).toBeGreaterThan(0);
    const stopped = ladder.slice(start, ladder.indexOf('return "refused";', start));
    expect(stopped).toContain('const stop = slotStop(stoppedBySlot, "beforeDial");');
    expect(stopped).toContain("passResultRef.current = { routeId: null, errorKind: stop.errorKind };");
    expect(stopped).toContain("showSlotStop(stop, options.reconnect);");
    // Before anything is awaited: the runner reads it as soon as the
    // pass returns, and every return below follows an await.
    expect(stopped.indexOf("passResultRef.current")).toBeLessThan(stopped.indexOf("await "));
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
  const check = landing.indexOf("if (stopped() || ladderGenerationRef.current !== generation) break;");

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
    expect(effect).toMatch(
      /^useEffect\(\(\) => \{\n\s+if \(loading \|\| !routeMemoryLoaded \|\| !routeListLoaded\) return;\n\s+return autoReconnect\.bind\(async \(attempt\) => \{/,
    );
    expect(dashboard.slice(dashboard.indexOf("\n  }, [", start), dashboard.indexOf("\n  }, [", start) + 60)).toContain(
      "}, [loading, routeMemoryLoaded, routeListLoaded]);",
    );
  });

  it("and has the route list, which the pass reads for the extra exits and the split tunnel's egress", () => {
    // Bound before it had arrived -- `loading` ends, and the route memory is
    // read in milliseconds, ahead of the list's request -- a held attempt
    // ran on a `runLadder` with no routes: `concurrentExitsFor` found no
    // extra exit and `exitOfRoute` no egress, so it landed without concurrent
    // exits and with every game's placement Unknown until the next connect.
    const load = body("async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {");
    // Online: once the list has been asked for, answered or not.
    const asked = load.indexOf('const routesResult = await getAvailableRoutes(sub.id, routeList.trace("routes"));');
    const said = load.indexOf("} finally {\n      setRouteListLoaded(true);\n    }");
    expect(asked).toBeGreaterThan(0);
    expect(said).toBeGreaterThan(asked);
    expect(load.indexOf("setRoutes(currentRoutes);")).toBeLessThan(said);
    // Cached: with the cached list on screen, whichever way the load came
    // to it (`showCached`). And with nothing to dial, at once, as the route
    // memory is.
    const shown = body("async function showCached(");
    const cached = shown.indexOf("setRoutes(cached.routes);");
    expect(cached).toBeGreaterThan(0);
    expect(shown.indexOf("setRouteListLoaded(true);")).toBeGreaterThan(cached);
    expect(load).toContain("await showCached(cached, preferRouteId, load, reason);");
    expect(load.split("setRouteListLoaded(true);").length - 1).toBe(2);
    expect(dashboard.split("setRouteListLoaded(true)").length - 1).toBe(3);
  });

  it("and has this network's route memory, which the pass orders by and its landing writes back whole", () => {
    // Bound as loading ended, a held attempt ran with the empty
    // placeholders: led by protocols already refused here, and its landing
    // saved its one entry over every network's remembered route and history.
    const memory = body("function loadRouteMemory(): void {");
    expect(memory).toContain('invoke<string | null>("network_fingerprint")');
    expect(memory).toContain("loadLastGood().then(setLastGood),");
    expect(memory).toContain("loadConnectHistory().then(setHistory),");
    expect(memory).toContain(".finally(() => setRouteMemoryLoaded(true));");
    expect(dashboard.split("setRouteMemoryLoaded(true)").length - 1).toBe(1);
    // Read nowhere else, and on every way a load ends but a sign-out --
    // the screen with nothing to dial included, or a held attempt waited
    // on it for good.
    expect(dashboard.split("loadLastGood()").length - 1).toBe(1);
    expect(dashboard.split("loadConnectHistory()").length - 1).toBe(1);
    const load = body("async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {");
    // The screen with nothing to dial, and the online one -- once, not
    // again when the snapshot went up first while it waited.
    expect(load.split("loadRouteMemory();").length - 1).toBe(2);
    expect(load).toContain("if (!shownWhileWaiting) loadRouteMemory();");
    // And the cached one, whichever way the load came to it.
    expect(body("async function showCached(").split("loadRouteMemory();").length - 1).toBe(1);
  });

  it("on a screen that loaded nothing to dial, ends the episode rather than spending its attempts", () => {
    // Ended as an attempt that dialled nothing, not as one "ruled out at
    // the moment of the drop" -- counted among the attempts made.
    const check = runner.indexOf('if (protocolUserRef.current === null) return { kind: "stop", why: "nothingToDial" };');
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
    expect(picker.split("chooseLocation(").length - 1).toBe(2);
    expect(repair).toContain('autoReconnect.cancel("customer");');
  });

  it("Stop reconnecting stops it, and leaves 'connection lost' to be said", () => {
    const stop = body("async function stopReconnecting() {");
    expect(stop).toContain('autoReconnect.cancel("stopped");');
    expect(dashboard).toContain("onClick={() => void stopReconnecting()}");
  });

  it("a sign-out and the device limit end it too", () => {
    expect(body("async function handleLogout() {")).toContain('autoReconnect.cancel("signedOut");');
    expect(body("async function endForSlot(event: SlotStopReason) {")).toContain("autoReconnect.cancel(slotStopWhy(stop.errorKind));");
  });
});

describe("a press that ends the episode also stops the pass it was dialling", () => {
  // A repair, a new location and a change of mode ended the episode but
  // never set the stop flag, the only thing the ladder asked: the pass went
  // on dialling the old order behind them, and its tunnel came up after the
  // repair or on the old server.
  const ladder = body("async function runLadder(");

  it("the ladder asks the attempt as well as the flag, everywhere it used to ask the flag", () => {
    expect(ladder).toContain("const stopped = () => passStopped(cancelRef.current, options.reconnect);");
    // The flag is read nowhere else in the ladder: cleared as it begins,
    // and asked only through `stopped`.
    const reads = ladder.split("cancelRef.current").length - 1;
    expect(reads).toBe(2);
    expect(ladder).toContain("cancelRef.current = false;");
    for (const check of [
      "const stillWanted = !stopped() && sessionGeneration() === sessionAtStart;",
      "if (stopped() || sessionGeneration() !== sessionAtStart) break;",
      "if (stopped()) break;",
      "if (stopped() || ladderGenerationRef.current !== generation) break;",
      "setConnectionError(stopped() ? null : lastError);",
      "if (!stopped()) {",
    ]) {
      expect(ladder, check).toContain(check);
    }
  });

  it("a pass stopped while its engine came up puts nothing of that rung on screen", () => {
    const connected = ladder.indexOf('await invoke("vpn_connect", {');
    const check = ladder.indexOf("if (stopped()) break;", connected);
    expect(check).toBeGreaterThan(connected);
    // Before the rung's route is named or its clock started -- a location
    // chosen meanwhile has named its own.
    expect(check).toBeLessThan(ladder.indexOf("setProtocolUser(candidate);", connected));
    expect(check).toBeLessThan(ladder.indexOf("setConnectedAt(Date.now());", connected));
    expect(check).toBeLessThan(ladder.indexOf('publishObserved(intent, "verifying");', connected));
  });

  it("a pass stopped while it settled, or looked up its server, dials nothing more", () => {
    // Heard only after the rung's connect, a stop in those seventeen
    // seconds dialled the old route once more; a repair's Disconnect had
    // nothing to cancel then, so the connect queued behind the repair's
    // teardown, the pass outlasted the repair's wait for it, and its own
    // teardown cancelled the repair mid-step.
    const rung = ladder.slice(ladder.indexOf("for (const [index, candidate] of candidates.entries()) {"));
    const settled = rung.indexOf("baselineIpRef.current = await settleAndCaptureBaseline(");
    const named = rung.indexOf('const tunnelServer = await tunnelServerOf(candidate, "windows");');
    const ipv6 = rung.indexOf("ipv6BaselineRef.current = await captureIpv6Baseline();");
    const check = rung.indexOf(
      "if (stopped() || sessionGeneration() !== sessionAtStart || ladderGenerationRef.current !== generation) break;",
    );
    const connect = rung.indexOf('await invoke("vpn_connect", {');
    expect(Math.min(settled, named, ipv6)).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(Math.max(settled, named, ipv6));
    expect(connect).toBeGreaterThan(check);
    // Nothing awaited between the check and the connect.
    expect(rung.slice(check, connect)).not.toContain("await ");
  });

  it("a failover note compares against the server the tile showed, not the credential the screen holds", () => {
    // A location chosen over a tunnel that stays up leaves the credential
    // on the tunnel's route; once that tunnel is gone, the tile names the
    // choice. The next Connect, landing on the chosen server, was told it
    // had moved off the old one.
    expect(ladder).toContain(
      "const shownRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId);",
    );
    expect(ladder).not.toContain("const shownRouteId = protocolUser?.routeId ?? null;");
    // The tile's own rule, with the same arguments.
    expect(dashboard).toContain(
      "displayedRoute(routes, connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId)",
    );
  });

  it("a location chosen during an attempt stops its pass as Stop reconnecting does; over a tunnel, keeps it", () => {
    const choose = body("function chooseLocation(routeId: string | null): string | null {");
    // Kept up only over a tunnel the screen shows: armed beneath a screen
    // saying "disconnected", the choice's reload took the tunnel's absence
    // for a drop it had missed, and redialled the old route.
    expect(choose).toContain(
      'const choice = autoReconnect.chose({ tunnelShown: connectionStateRef.current !== "disconnected" });',
    );
    expect(dashboard).toContain("connectionStateRef.current = connectionState;");
    expect(choose).toContain('if (choice === "stopPass") void stopPass();');
    // Over a tunnel that stays up the screen goes on naming its route, read
    // as it is now rather than as it was when the list was pressed.
    expect(choose).toContain('choice === "keepTunnel" ? (protocolUserRef.current?.routeId ?? routeId) : routeId');
    const picker = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    expect(picker).toContain("const shown = chooseLocation(routeId ?? null);");
    expect(picker).toContain("void loadAll(shown ?? undefined);");
    expect(picker).toContain("chooseLocation(null);");
    // Nothing in the list ends the episode any other way.
    expect(picker).not.toContain("autoReconnect.cancel(");
  });

  it("a repair has any pass stopped and gone before the service is asked to repair", () => {
    const run = repair.slice(repair.indexOf("const run = useCallback(async () => {"));
    const cancel = run.indexOf('autoReconnect.cancel("customer");');
    const stop = run.indexOf("await stopPassBeforeRepair();");
    const repaired = run.indexOf("await repairNetwork();");
    expect(cancel).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(cancel);
    expect(repaired).toBeGreaterThan(stop);
  });

  it("no automatic pass starts while a repair runs, and the health poll stands aside", () => {
    // Stopping the pass in flight left nothing to keep a new one from
    // starting: after a failed pass shown as "degraded", the poll's strikes
    // -- read off the repair at work -- began the failover's pass, whose
    // opening Disconnect cancelled the repair mid-step on the service, and
    // whose connect came up behind it.
    const run = repair.slice(repair.indexOf("const run = useCallback(async () => {"));
    const marked = run.indexOf("await duringRepair(async () => {");
    expect(marked).toBeGreaterThan(run.indexOf('autoReconnect.cancel("customer");'));
    // The stop and the repair both inside it.
    expect(run.indexOf("await stopPassBeforeRepair();")).toBeGreaterThan(marked);
    expect(run.indexOf("await repairNetwork();")).toBeGreaterThan(marked);
    expect(run.indexOf("await repairNetwork();")).toBeLessThan(run.indexOf("});", marked));
    // The ladder turns an automatic pass away while it runs -- the failover
    // and a reconnect's attempt alike -- before anything is said or sent.
    const ladder = body("async function runLadder(");
    const declined = ladder.indexOf('if (options.automatic && repairUnderWay()) return "declined";');
    expect(declined).toBeGreaterThan(0);
    expect(ladder.slice(0, declined)).not.toContain("await ");
    expect(declined).toBeLessThan(ladder.indexOf("const generation = ++ladderGenerationRef.current;"));
    expect(declined).toBeLessThan(ladder.indexOf("await serviceDisconnect()"));
    // The poll's measurement reads nothing while it runs, so it counts no
    // strike off the repair's own disturbance.
    expect(dashboard).toContain("if (ladderInFlight() || repairUnderWay()) return false;");
  });

  it("a server picked in the list ends a reconnect under way as it is picked, not when the switch answers", () => {
    // The switch request can take seconds; told only with its answer, an
    // attempt that began or landed meanwhile dialled the old route after
    // the press. The picker is shared, so this is both clients'.
    const picker = readFileSync(new URL("../components/LocationPicker.tsx", import.meta.url), "utf8");
    const pick = picker.slice(picker.indexOf("async function handlePick(route: RouteOption) {"));
    const told = pick.indexOf("onPicking?.(route.id);");
    expect(told).toBeGreaterThan(0);
    expect(told).toBeLessThan(pick.indexOf('await switchRoute(subscriptionId, route.id, requests.trace("switch"));'));
    // Automatic too, before its own handler.
    const automatic = picker.slice(picker.indexOf("if (automatic || switchingId) return;"));
    expect(automatic.indexOf("onPicking?.(null);")).toBeGreaterThan(0);
    expect(automatic.indexOf("onPicking?.(null);")).toBeLessThan(automatic.indexOf("onChooseAutomatic();"));
    const picking = body("function pickingLocation(routeId: string | null) {");
    expect(picking).toContain(
      'const choice = autoReconnect.choosing({ routeId, tunnelShown: connectionStateRef.current !== "disconnected" });',
    );
    expect(picking).toContain('if (choice === "stopPass") void stopPass();');
    expect(dashboard.slice(dashboard.indexOf("<LocationPicker"))).toContain("onPicking={pickingLocation}");
  });

  it("a server picked over a tunnel kept up is what its reconnect leads with, until a switch that fails puts it back", () => {
    // Told only once the switch answered, a drop in between reconnected to
    // the server the customer had just picked to leave, and an answer that
    // came during that attempt stopped it. The picker names the pick as it
    // is made, and says when the switch fails.
    const picker = readFileSync(new URL("../components/LocationPicker.tsx", import.meta.url), "utf8");
    const pick = picker.slice(picker.indexOf("async function handlePick(route: RouteOption) {"));
    const failed = pick.slice(pick.indexOf("} else {") + "} else {".length);
    expect(failed.slice(0, failed.indexOf("}"))).toContain("onPickFailed?.();");
    expect(pick.indexOf("onPickFailed?.();")).toBeGreaterThan(pick.indexOf("if (result.ok) {"));
    const listed = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    const onFailed = listed.slice(listed.indexOf("onPickFailed={() => {"));
    expect(onFailed.slice(0, onFailed.indexOf("}}"))).toContain("autoReconnect.pickFailed();");
  });

  it("the inline repair is not offered while an automatic pass dials: the last pass's error is cleared as the next begins", () => {
    // Every automatic pass, in the ladder: the reconnect's runner cleared
    // it and the mid-session failover did not, so after a failed pass shown
    // "degraded" the inline repair stayed under "Connecting..." -- run from
    // there, it stopped the failover's pass, whose end cleared the line and
    // unmounted the panel running the repair: its report, or the elevated
    // command, never shown.
    const ladder = body("async function runLadder(");
    const cleared = ladder.indexOf("if (options.automatic) setConnectionError(null);");
    expect(cleared).toBeGreaterThan(0);
    // After the declines -- one turned away while a repair runs leaves that
    // repair's panel where it is -- and before anything is awaited.
    expect(cleared).toBeGreaterThan(ladder.indexOf('if (options.automatic && repairUnderWay()) return "declined";'));
    expect(cleared).toBeGreaterThan(ladder.indexOf('if (!protocolUser || ladderInFlight()) return "declined";'));
    expect(ladder.slice(0, cleared)).not.toContain("await ");
    // The failover's pass is one: it reaches the ladder as automatic.
    expect(dashboard).toContain("if (failover) await runLadder({ automatic: true });");
    expect(boundRunner()).toContain("runLadderRef.current({ automatic: true, reconnect: attempt })");
    // The inline repair is drawn only under an error.
    const error = dashboard.indexOf("{connectionError ? (");
    expect(error).toBeGreaterThan(0);
    expect(dashboard.indexOf('<RepairNetwork variant="inline" />')).toBeGreaterThan(error);
  });
});

describe("what the screen says", () => {
  it("takes the words from the table, episode included", () => {
    expect(dashboard).toContain(
      "headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect, sessionGeneration()), customMode: splitTunnelActive, reconnecting })",
    );
    expect(dashboard).toContain("pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true })");
    // Only for an episode of the session in force: one a sign-out left
    // behind said "Reconnecting..." to the next sign-in until its screen
    // had loaded.
    expect(dashboard).toContain("const reconnecting = reconnectingView(reconnect, sessionGeneration());");
  });
});
