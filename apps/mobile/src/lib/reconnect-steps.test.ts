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
    hasPermission: async () => {
      asked.push("hasPermission");
      return true;
    },
    live: () => true,
    ...over,
  };
}

describe("before a phone's reconnect may dial", () => {
  it("goes ahead when nothing stands in the way", async () => {
    const d = deps();
    expect(await reconnectPreflight(d)).toBeNull();
    expect(d.asked).toEqual(["vpnGone", "hasPermission"]);
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
      hasPermission: async () => {
        asked.push("hasPermission");
        return true;
      },
    });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "otherVpn" });
    expect(asked).toEqual(["vpnGone"]);
  });

  it("stops when the permission is no longer this app's, and never asks for it", async () => {
    // `hasPermission` is the read-only question; the dialog is only ever
    // raised by a connect the customer pressed.
    const d = deps({ hasPermission: async () => false });
    expect(await reconnectPreflight(d)).toEqual({ kind: "stop", why: "permission" });
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
      hasPermission: async () => {
        live = false;
        return true;
      },
    });
    expect(await reconnectPreflight(last)).not.toBeNull();

    // And one already over asks the platform nothing.
    const over = deps({ live: () => false });
    expect(await reconnectPreflight(over)).not.toBeNull();
    expect(over.asked).toEqual([]);
  });

  it("counts a check that could not be made as a failed attempt, not a reason to stop", async () => {
    expect(await reconnectPreflight(deps({ vpnGone: () => Promise.reject(new Error("x")) }))).toEqual({
      kind: "failed",
    });
    expect(await reconnectPreflight(deps({ hasPermission: () => Promise.reject(new Error("x")) }))).toEqual({
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
    expect(runner).toContain("hasPermission: hasVpnPermission,");
    // Asked after every answer, so a press meanwhile is not dialled over.
    expect(runner).toContain("live: attempt.live,");
    // Never the dialog.
    expect(runner).not.toContain("requestVpnPermission");
    expect(runner).toContain("runLadderRef.current({ reconnect: attempt })");
    expect(runner).toContain("reconnectOutcomeOf(outcome, passResultRef.current)");
    expect(runner).not.toContain("setConnectionState(");
  });

  it("binds the runner only once loadAll has finished, every step of it", () => {
    // An attempt that fell due while Settings was open runs the moment a
    // screen binds. Bound at mount, the screen had no credential yet: the
    // pass set "connecting", threw, and was spent -- and on the cached
    // path "Checking connection..." stayed up with nothing running.
    const effect = dashboard.slice(dashboard.lastIndexOf("useEffect(", bindAt), dashboard.indexOf("\n  }, [", bindAt));
    expect(effect).toMatch(/^useEffect\(\(\) => \{\n\s+if \(!loaded\) return;\n\s+return autoReconnect\.bind\(async \(attempt\) => \{/);
    expect(dashboard.slice(dashboard.indexOf("\n  }, [", bindAt)).startsWith("\n  }, [loaded]);")).toBe(true);
    // Not `loading`, which ends before the route list, the platform's
    // state and the baseline: loaded only when the whole load is done,
    // whichever way it ended, and never by a load a newer one replaced.
    const load = dashboard.slice(
      dashboard.indexOf("async function loadAll(preferRouteId?: string) {"),
      dashboard.indexOf("async function loadScreen(preferRouteId?: string) {"),
    );
    expect(load).toContain("const load = ++loadRef.current;");
    expect(load.indexOf("setLoaded(false);")).toBeLessThan(load.indexOf("await loadScreen(preferRouteId);"));
    expect(load).toMatch(/\} finally \{\n\s+if \(loadRef\.current === load\) setLoaded\(true\);/);
    expect(dashboard.split("setLoaded(true)").length - 1).toBe(1);
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

  it("leads with the route that was up, and reports the pass as automatic", () => {
    const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));
    expect(ladder).toContain("resumeRouteId: options.reconnect?.resumeRouteId ?? null,");
    // Landed, failed, cancelled and nothing usable: all four reports.
    expect(ladder.split("asReconnectReport(").length - 1).toBe(4);
    expect(ladder).toContain(
      "if (!options.reconnect) {\n            autoReconnect.tunnelUp({ routeId: candidate.routeId, fresh: true, stamp: reconnectStamp });",
    );
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
    expect(dashboard).toContain('autoReconnect.cancel("refused");');
    expect(dashboard).toContain('autoReconnect.cancel("stopped");');
    const picker = dashboard.slice(dashboard.indexOf("<LocationPicker"));
    expect(picker.split('autoReconnect.cancel("customer");').length - 1).toBe(2);
  });

  it("takes its words from the shared tables", () => {
    expect(dashboard).toContain(
      "headlineFor(connectionState, { dropped: tunnelDropped || reconnectLost(reconnect), customMode: false, reconnecting })",
    );
    expect(dashboard).toContain("pressFor(connectionState, { reconnectWaiting: reconnecting?.waiting === true })");
    // The old chains are gone, so the two cannot disagree.
    expect(dashboard).not.toContain('t("dash.protected")');
  });
});
