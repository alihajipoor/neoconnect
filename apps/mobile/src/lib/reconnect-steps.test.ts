import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { droppedWhileAway, reconnectPreflight, type ReconnectPreflight } from "./reconnect-steps";

function deps(over: Partial<ReconnectPreflight> = {}): ReconnectPreflight & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    exclusion: () => null,
    vpnGone: async () => {
      asked.push("vpnGone");
      return true;
    },
    access: async () => {
      asked.push("access");
      return { granted: true };
    },
    live: () => true,
    ...over,
  };
}

describe("before a phone's reconnect may dial", () => {
  it("goes ahead when nothing stands in the way", async () => {
    const d = deps();
    expect(await reconnectPreflight(d)).toEqual({ kind: "clear", ikev2: true });
    expect(d.asked).toEqual(["vpnGone", "access"]);
  });

  it("stops on what the screen rules out, asking the platform nothing", async () => {
    const d = deps({ exclusion: () => "refused" });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "refused" });
    expect(d.asked).toEqual([]);
  });

  it("stops when another VPN holds the device -- before the permission is asked about", async () => {
    // On Android asking is `VpnService.prepare`, which can move the VPN
    // back to this app: the other app's tunnel would be taken from it.
    const asked: string[] = [];
    const d = deps({
      vpnGone: async () => {
        asked.push("vpnGone");
        return false;
      },
      access: async () => {
        asked.push("access");
        return { granted: true };
      },
    });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "otherVpn" });
    expect(asked).toEqual(["vpnGone"]);
  });

  it("stops on an iPhone where another VPN configuration has been chosen over ours", async () => {
    // iOS shows an app none of another app's VPN, so the wait above finds
    // the device out of every VPN while another app's is connected. The
    // permission's answer carries the one sign iOS gives: none of ours is
    // the enabled configuration. Dialling would enable ours again, and
    // switch the device off the other app's VPN.
    const d = deps({ access: async () => ({ granted: true, ikev2: true, chosenElsewhere: true }) });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "otherVpn" });
    // One of ours still the enabled one: an ordinary drop.
    expect(
      await reconnectPreflight(deps({ access: async () => ({ granted: true, ikev2: true, chosenElsewhere: false }) })),
    ).toEqual({ kind: "clear", ikev2: true });
  });

  it("stops when the permission is no longer this app's, and never asks for it", async () => {
    // `access` is the read-only question; the dialog is only ever raised
    // by a connect the customer pressed.
    const d = deps({ access: async () => ({ granted: false }) });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "permission" });
    // Said as the permission, too, on an iPhone whose tunnel configuration
    // is gone while IKEv2's, not the enabled one, is left.
    expect(
      await reconnectPreflight(deps({ access: async () => ({ granted: false, ikev2: true, chosenElsewhere: true }) })),
    ).toEqual({ kind: "stop", why: "permission" });
  });

  it("clears an iPhone's pass without IKEv2 while IKEv2's own configuration is not installed", async () => {
    // A sign-out removes it, and somebody who has only landed on Xray or
    // WireGuard never had it. Dialling IKEv2 installs it, which raises
    // iOS's "Add VPN Configurations" prompt -- not for an attempt nobody
    // pressed. The rest of the ladder is still dialled.
    expect(await reconnectPreflight(deps({ access: async () => ({ granted: true, ikev2: false }) }))).toEqual({
      kind: "clear",
      ikev2: false,
    });
    expect(await reconnectPreflight(deps({ access: async () => ({ granted: true, ikev2: true }) }))).toEqual({
      kind: "clear",
      ikev2: true,
    });
    // Android says nothing of IKEv2, and is not held back from it.
    expect(await reconnectPreflight(deps({ access: async () => ({ granted: true }) }))).toEqual({
      kind: "clear",
      ikev2: true,
    });
  });

  it("dials nothing for an attempt a press ended while the platform was being asked", async () => {
    // "Stop reconnecting", a Connect, a sign-out or the device limit,
    // landing while the device was still being waited out of a VPN: the
    // pass used to dial as soon as the answers came back.
    let live = true;
    const during = deps({
      live: () => live,
      vpnGone: async () => {
        during.asked.push("vpnGone");
        live = false;
        return true;
      },
    });
    const answer = await reconnectPreflight(during);
    expect(answer).not.toBeNull();
    expect(answer).toEqual({ kind: "stop", why: "customer" });
    // Not even the next question.
    expect(during.asked).toEqual(["vpnGone"]);

    // Ended during the last question, the permission's.
    live = true;
    const last = deps({
      live: () => live,
      access: async () => {
        live = false;
        return { granted: true };
      },
    });
    expect(await reconnectPreflight(last)).toEqual({ kind: "stop", why: "customer" });

    // And one already over asks the platform nothing.
    const over = deps({ live: () => false });
    expect(await reconnectPreflight(over)).toEqual({ kind: "stop", why: "customer" });
    expect(over.asked).toEqual([]);
  });

  it("counts a check that could not be made as a failed attempt, not a reason to stop", async () => {
    expect(await reconnectPreflight(deps({ vpnGone: () => Promise.reject(new Error("x")) }))).toEqual({
      kind: "failed",
    });
    expect(await reconnectPreflight(deps({ access: () => Promise.reject(new Error("x")) }))).toEqual({
      kind: "failed",
    });
  });
});

describe("a drop nobody saw", () => {
  const base = { vouching: true, answered: true, connected: false, tearingDown: false };

  it("is one when the app was vouching for a tunnel the platform says is gone", () => {
    expect(droppedWhileAway(base)).toBe(true);
  });

  it("is not one for anything less", () => {
    expect(droppedWhileAway({ ...base, vouching: false })).toBe(false);
    expect(droppedWhileAway({ ...base, answered: false })).toBe(false);
    expect(droppedWhileAway({ ...base, connected: true })).toBe(false);
    expect(droppedWhileAway({ ...base, tearingDown: true })).toBe(false);
  });
});

/** Source assertions, for the reason device-slot-steps.test.ts gives: the
 * dashboard needs a phone, a tunnel and a network. Each fails against
 * the dashboard as it was before the reconnect existed. */
describe("the phone dashboard's wiring", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("waits for the app to be in front before an attempt", () => {
    expect(app).toContain("autoReconnect.setRequiresForeground(true);");
  });

  it("begins at the health poll's drop, and gives the slot back only when nothing is coming back", () => {
    const start = dashboard.indexOf("function reportDrop() {");
    expect(start).toBeGreaterThan(0);
    const drop = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(drop).toContain("setTunnelDropped(true);");
    expect(drop).toContain(
      'if (autoReconnect.dropped({ exclusion: reconnectExclusion() }) === "lost") void deviceSlot.release();',
    );
    // The poll's "nothing is running" goes there, and releases nothing
    // itself any more.
    const poll = dashboard.slice(dashboard.indexOf('if (fromStatus === "disconnected") {'));
    const branch = poll.slice(0, poll.indexOf("return;"));
    expect(branch).toContain("reportDrop();");
    expect(branch).not.toContain("deviceSlot.release()");
    // And no other path starts reconnecting.
    expect(dashboard.split("autoReconnect.dropped(").length).toBe(2);
  });

  it("checks the tunnel as the app comes to the front, not only on the interval", () => {
    expect(dashboard).toContain("const stopWatching = whenForegrounded(() => void check());");
    expect(dashboard).toContain("const id = setInterval(() => void check(), HEALTH_POLL_MS);");
  });

  it("asks the exclusions of a teardown owed and a plan that stopped", () => {
    const start = dashboard.indexOf("function reconnectExclusion(): ReconnectStop | null {");
    const exclusion = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(exclusion).toContain('if (slotTeardown.owed()) return "refused";');
    expect(exclusion).toContain('if (customerTeardown.owed()) return "customer";');
    expect(exclusion).toContain('return "notEntitled";');
  });

  it("notices a drop on a screen that was away, through the tested rule", () => {
    expect(dashboard).toContain("droppedWhileAway({");
    expect(dashboard).toContain("const vouched = vouching(autoReconnect.current(), sessionAtStart);");
  });

  const bindAt = dashboard.indexOf("autoReconnect.bind(async (attempt) => {");
  /** The runner the dashboard binds, to the line that closes it. */
  const runner = dashboard.slice(bindAt, dashboard.indexOf("\n    });\n", bindAt));

  it("asks the phone's questions, then runs an ordinary pass", () => {
    expect(bindAt).toBeGreaterThan(0);
    expect(runner).toContain("await reconnectPreflight({");
    expect(runner).toContain("vpnGone: waitForTeardown,");
    // The whole answer, iOS's two extra words with it -- not the bare
    // `granted` a press of Connect reads.
    expect(runner).toContain("access: vpnAccess,");
    expect(runner).not.toContain("hasVpnPermission");
    // Asked after every answer, so a press meanwhile is not dialled over.
    expect(runner).toContain("live: attempt.live,");
    // Never the dialog.
    expect(runner).not.toContain("requestVpnPermission");
    expect(runner).toContain('if (cleared.kind !== "clear") return cleared;');
    expect(runner).toContain("runLadderRef.current({ reconnect: attempt, skipIkev2: !cleared.ikev2 })");
    expect(runner).toContain("reconnectOutcomeOf(outcome, passResultRef.current)");
    expect(runner).not.toContain("setConnectionState(");
  });

  it("binds the runner only once loadAll has the screen ready", () => {
    // An attempt that fell due while Settings was open runs the moment a
    // screen binds. Bound at mount, the screen had no credential yet: the
    // pass set "connecting", threw, and was spent -- and on the cached
    // path "Checking connection..." stayed up with nothing running.
    const effect = dashboard.slice(dashboard.lastIndexOf("useEffect(", bindAt), dashboard.indexOf("\n  }, [", bindAt));
    expect(effect).toMatch(/^useEffect\(\(\) => \{\n\s+if \(!loaded\) return;\n\s+return autoReconnect\.bind\(async \(attempt\) => \{/);
    expect(dashboard.slice(dashboard.indexOf("\n  }, [", bindAt)).startsWith("\n  }, [loaded]);")).toBe(true);
    // Not `loading`, which ends before the route list and the platform's
    // state: ready once those are in, or the load is over whichever way it
    // ended, and never by a load a newer one replaced.
    const load = dashboard.slice(
      dashboard.indexOf("async function loadAll(preferRouteId?: string) {"),
      dashboard.indexOf("async function loadScreen(preferRouteId: string | undefined, ready: () => void) {"),
    );
    expect(load).toContain("const load = ++loadRef.current;");
    expect(load.indexOf("setLoaded(false);")).toBeLessThan(load.indexOf("await loadScreen(preferRouteId, ready);"));
    expect(load).toMatch(/const ready = \(\) => \{\n\s+if \(loadRef\.current === load\) setLoaded\(true\);\n\s+\};/);
    expect(load).toMatch(/\} finally \{\n\s+ready\(\);/);
    expect(dashboard.split("setLoaded(true)").length - 1).toBe(1);
  });

  it("is ready once the platform's state is on screen, not after the baseline walk, and that state is asked within a bound", () => {
    // Held for the walk too, a drop found on return from Settings waited up
    // to twelve more seconds of traffic in the clear before its attempt;
    // and a status call that never answered held it -- "Reconnecting...",
    // nothing dialling -- for good.
    const start = dashboard.indexOf("async function adoptPlatform(");
    const adopt = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    const read = adopt.indexOf('adopted = stateFromStatus(await withTimeout(vpnStatus(), "vpn_status"));');
    const ready = adopt.indexOf("ready();");
    const walk = adopt.indexOf("await takeBaseline(");
    expect(read).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(read);
    // After the drop is reported and the tunnel armed, so the attempt runs
    // on what the platform said.
    expect(ready).toBeGreaterThan(adopt.indexOf("reportDrop();"));
    expect(ready).toBeGreaterThan(adopt.indexOf("autoReconnect.tunnelUp({ routeId: null });"));
    expect(walk).toBeGreaterThan(ready);
    // The walk stands aside for a pass begun meanwhile.
    expect(adopt.slice(walk)).toContain("if (overtaken()) return;");
    expect(dashboard).toContain("await adoptPlatform(sessionAtStart, usersResult.data, sub, ready);");
  });

  it("does not say every protocol was tried when one was passed over that a press would dial", () => {
    // An iPhone's automatic pass without IKEv2's configuration passes IKEv2
    // over; "Tried every available protocol" then told the customer there
    // was nothing left, when a press of Connect would try it.
    const walk = dashboard.slice(dashboard.indexOf("async function walkLadder("));
    const skip = walk.indexOf('if (candidate.protocol === "IKEV2" && options.skipIkev2) {');
    expect(walk.slice(skip, walk.indexOf("continue;", skip))).toContain("passedOver = true;");
    const said = walk.indexOf(
      'if (passedOver && lastError?.messageKey === "err.allProtocolsFailed") {\n      lastError = { ...lastError, messageKey: "err.someProtocolsNotTried" };',
    );
    expect(said).toBeGreaterThan(0);
    expect(said).toBeLessThan(walk.indexOf("setConnectionError(lastError);"));
  });

  it("asks an iPhone whether another configuration was chosen over ours one kind at a time", () => {
    // iOS keeps one enabled configuration per kind: tunnel providers, and
    // NEVPNManager profiles such as our IKEv2. Asked across both, an iPhone
    // that had ever landed on IKEv2 kept that profile enabled when another
    // app's tunnel took the tunnel kind, and its reconnect switched the
    // device off that app's VPN. The Swift is not compiled here; this pins
    // what it asks.
    const swift = readFileSync(
      new URL("../../plugins/vpn/ios/Sources/NeoxifyVpnPlugin/NeoxifyVpnPlugin.swift", import.meta.url),
      "utf8",
    );
    expect(swift).toContain(
      "let tunnelChosenElsewhere = !managers.isEmpty && !managers.contains(where: { $0.isEnabled })",
    );
    expect(swift).toContain("let ikev2ChosenElsewhere = ikev2.map { !$0.isEnabled } ?? false");
    expect(swift).toContain('"chosenElsewhere": tunnelChosenElsewhere || ikev2ChosenElsewhere,');
    expect(swift).not.toContain("!enabled.contains(true)");
  });

  it("turns a pass away before anything on screen moves when there is nothing to dial", () => {
    const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
    const guard = ladder.indexOf('if (!protocolUser) return "unusable";');
    expect(guard).toBeGreaterThan(0);
    // Before the first state the pass touches -- "connecting" above all.
    expect(guard).toBeLessThan(ladder.indexOf("setFailedOverTo(null);"));
    expect(guard).toBeLessThan(ladder.indexOf('setConnectionState("connecting");'));
    expect(guard).toBeLessThan(ladder.indexOf("const pass = beginPass(options.reconnect);"));
  });

  it("passes over IKEv2 on the pass a clearance holds it back from, before anything is dialled", () => {
    const walk = dashboard.slice(dashboard.indexOf("async function walkLadder("));
    // Counted out of "the last rung", so the rung before it is judged as
    // the last one dialled.
    expect(walk).toContain(
      'const willDial = (c: ProtocolUser) =>\n      !(c.protocol === "IKEV2" && (allowedApps.length > 0 || options.skipIkev2 === true));',
    );
    const skip = walk.indexOf('if (candidate.protocol === "IKEV2" && options.skipIkev2) {');
    expect(skip).toBeGreaterThan(walk.indexOf("for (const [index, candidate] of candidates.entries()) {"));
    const block = walk.slice(skip, walk.indexOf("\n      }\n", skip));
    expect(block).toContain("dials.push(null);");
    expect(block).toContain("continue;");
    // Ahead of everything the rung does: its baseline, and the dial that
    // would install the configuration.
    expect(skip).toBeLessThan(walk.indexOf("keepBaseline(baseline);"));
    expect(skip).toBeLessThan(walk.indexOf("await connectIkev2({"));
    // Only the automatic pass sets it; no press does.
    expect(dashboard.split("skipIkev2:").length - 1).toBe(1);
  });

  it("leads with the route that was up, and reports the pass as automatic", () => {
    const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
    expect(ladder).toContain("resumeRouteId: options.reconnect?.resumeRouteId ?? null,");
    // Landed, failed, cancelled and nothing usable: all four reports.
    expect(ladder.split("asReconnectReport(").length - 1).toBe(4);
    expect(ladder).toContain(
      "if (!options.reconnect) {\n            autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true, stamp: reconnectStamp });",
    );
  });

  it("asks where the phone stands before a reconnect dials, and says so when it cannot tell", () => {
    // Obligation 9, as the Windows client keeps it: a phone that renews
    // only in the foreground redialled an unconfirmed slot with no word
    // about the plan's limit.
    const walk = dashboard.slice(dashboard.indexOf("async function walkLadder("));
    const ask = walk.indexOf("const { refreshed, stop, note } = await claimWhileRefreshing(");
    expect(ask).toBeGreaterThan(0);
    expect(walk.slice(ask, walk.indexOf("    );\n", ask))).toContain("automatic: options.reconnect !== undefined,");
    // Said once nothing stopped the pass, before the ladder runs.
    const said = walk.indexOf("if (note) setSlotNotice(note);");
    expect(said).toBeGreaterThan(walk.indexOf("if (stop) {"));
    expect(said).toBeLessThan(walk.indexOf("const usable = all.filter("));
    // And answered by a landing, as on Windows: not left over a tunnel
    // the pass has just proven.
    const landing = walk.slice(walk.indexOf("passResultRef.current = { routeId: candidate.routeId, errorKind: null };"));
    expect(landing.slice(0, landing.indexOf('return "connected";'))).toContain("setSlotNotice(null);");
  });

  it("reports a stop by the slot as the reconnect's own, and ends the episode on what stopped it", () => {
    // Sent as it was, a refusal of the reconnect's claim read as the
    // customer pressing Connect and being refused; and a subscription that
    // had ended was filed as the device limit refusing the device.
    const start = dashboard.indexOf("function showSlotStop(stop: SlotStop, reconnect?: ReconnectAttempt) {");
    expect(start).toBeGreaterThan(0);
    const show = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(show).toContain("if (stop.report) void reportAttempt(asReconnectReport(stop.report, reconnect));");
    expect(dashboard.split("void reportAttempt(stop.report)").length - 1).toBe(0);
    const walk = dashboard.slice(dashboard.indexOf("async function walkLadder("));
    const stopped = walk.slice(walk.indexOf("if (stop) {"), walk.indexOf('return "refused";'));
    expect(stopped).toContain("passResultRef.current = { routeId: null, errorKind: stop.errorKind };");
    expect(stopped).toContain("showSlotStop(stop, options.reconnect);");
  });

  it("arms a landing only on the stamp its pass took as it began", () => {
    // A pass the customer, a sign-out or the device limit overruled -- or
    // whose session ended where no press reached it -- arms nothing when
    // it lands anyway. Taken before the walk awaits anything, so no press
    // can slip in between the one that began it and the stamp.
    const walk = dashboard.slice(dashboard.indexOf("async function walkLadder("));
    const taken = walk.indexOf("const reconnectStamp = autoReconnect.stamp();");
    expect(taken).toBeGreaterThan(0);
    expect(walk.slice(0, taken)).not.toContain("await ");
    const run = dashboard.slice(dashboard.indexOf("async function runLadder("), dashboard.indexOf("async function walkLadder("));
    expect(run.split("await ").length - 1).toBe(1);
    expect(run).toContain("return await walkLadder(pass, options);");
    expect(dashboard.split("autoReconnect.tunnelUp(").length - 1).toBe(2);
  });

  it("lets every press take over", () => {
    const toggle = dashboard.slice(dashboard.indexOf("async function handleConnectToggle()"));
    expect(toggle.slice(0, 400)).toContain('autoReconnect.cancel("customer");');
    const connect = dashboard.slice(dashboard.indexOf("async function connectNow("));
    expect(connect.slice(0, 400)).toContain('autoReconnect.cancel("customer");');
    expect(dashboard).toContain('autoReconnect.cancel("signedOut");');
    expect(dashboard).toContain("autoReconnect.cancel(slotStopWhy(stop.errorKind));");
    expect(dashboard).toContain('autoReconnect.cancel("stopped");');
    const picker = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    expect(picker.split("chooseLocation(").length - 1).toBe(2);
  });

  it("a location chosen during an attempt stops its pass at once; over a tunnel that came back, keeps it armed", () => {
    // Taken as a press that takes over, a choice over a tunnel that landed
    // beneath the open list disarmed it, and its next drop said "VPN
    // connection lost"; and the pass of an attempt it ended went on to the
    // end of its step, "Connecting..." over a choice already made.
    const start = dashboard.indexOf("function chooseLocation(routeId: string | null): string | null {");
    expect(start).toBeGreaterThan(0);
    const choose = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(choose).toContain("pressRef.current += 1;");
    // Kept up only over a tunnel the screen shows: armed beneath a screen
    // saying "disconnected" -- the platform unasked, or the cached load --
    // the choice's reload took the tunnel's absence for a drop it had
    // missed, and redialled the old route.
    expect(choose).toContain(
      'const choice = autoReconnect.chose({ tunnelShown: connectionStateRef.current !== "disconnected" });',
    );
    expect(dashboard).toContain("connectionStateRef.current = connectionState;");
    expect(choose).toContain('if (choice === "stopPass") void stopPass();');
    expect(choose).toContain('choice === "keepTunnel" ? (protocolUserRef.current?.routeId ?? routeId) : routeId');
    expect(dashboard).toContain("protocolUserRef.current = protocolUser;");
    const picker = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    expect(picker).toContain("const shown = chooseLocation(routeId ?? null);");
    expect(picker).toContain("void loadAll(shown ?? undefined);");
    expect(picker).not.toContain("autoReconnect.cancel(");
  });

  it("takes its words from the shared tables", () => {
    expect(dashboard).toContain(
      "headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect, sessionGeneration()), customMode: false, reconnecting })",
    );
    expect(dashboard).toContain("pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true })");
    // The old chains are gone, so the two cannot disagree.
    expect(dashboard).not.toContain('t("dash.protected")');
  });
});
