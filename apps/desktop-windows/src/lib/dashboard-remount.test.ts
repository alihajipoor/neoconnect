import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LADDER_MAX_MS, ladderPass } from "./ladder-pass";

/* ------------------------------------------------------------------ *
 * The Dashboard unmounts whenever Settings or Plans is opened, and a
 * mount starts at "disconnected". Two things went wrong on the way back:
 *
 *  - a mount that could not reach our API returned before asking the
 *    service, so a live tunnel showed "You're not protected" and a
 *    Connect button indefinitely -- no poll revisits "disconnected";
 *  - a connect pass outlived the screen that started it, and the new
 *    screen's guard, generation and cancel flag were fresh `useRef`s, so
 *    it read the service mid-pass and a press started a second ladder.
 *
 * The store is tested directly. The screen needs a Tauri runtime, a
 * helper service and a network, so its wiring is pinned by source
 * assertions, as in connection-evidence.test.ts.
 * ------------------------------------------------------------------ */

afterEach(() => {
  ladderPass.reset();
  vi.useRealTimers();
});

describe("the ladder's guard, outside the screen", () => {
  it("is held for as long as a pass could still be alive, and no longer", () => {
    const start = 1_000_000;
    ladderPass.running.current = true;
    ladderPass.startedAt.current = start;
    expect(ladderPass.inFlight(start + 1)).toBe(true);
    expect(ladderPass.inFlight(start + LADDER_MAX_MS - 1)).toBe(true);
    expect(ladderPass.inFlight(start + LADDER_MAX_MS)).toBe(false);
    ladderPass.running.current = false;
    expect(ladderPass.inFlight(start + 1)).toBe(false);
  });

  it("stays held for a pass that keeps stepping forward, however long the ladder", () => {
    // Seven rejected rungs on a filtered network, each a settle of up to
    // twelve seconds plus a start and a verify: past LADDER_MAX_MS from
    // the start, with the pass alive throughout. Measured from the start,
    // the guard expired under it and a press started a second ladder.
    const start = 1_000_000;
    ladderPass.running.current = true;
    ladderPass.generation.current = 3;
    ladderPass.startedAt.current = start;
    const rung = 25_000;
    for (let i = 1; i <= 7; i++) ladderPass.progress(3, start + i * rung);
    expect(ladderPass.inFlight(start + 7 * rung + 1)).toBe(true);
    expect(ladderPass.inFlight(start + 7 * rung + LADDER_MAX_MS - 1)).toBe(true);
    // A step that hangs still loses the guard.
    expect(ladderPass.inFlight(start + 7 * rung + LADDER_MAX_MS)).toBe(false);
  });

  it("lets only the pass holding the guard renew it", () => {
    const start = 1_000_000;
    ladderPass.running.current = true;
    ladderPass.generation.current = 4;
    ladderPass.startedAt.current = start;
    // A pass that outlived its guard and was replaced (generation 3).
    ladderPass.progress(3, start + 100_000);
    expect(ladderPass.startedAt.current).toBe(start);
    // Nor once no pass is running.
    ladderPass.running.current = false;
    ladderPass.progress(4, start + 100_000);
    expect(ladderPass.startedAt.current).toBe(start);
  });

  it("keeps the pass's baseline for whichever screen is mounted, until reset", () => {
    expect(ladderPass.baseline.current).toBeNull();
    ladderPass.baseline.current = { ip: "192.0.2.228", from: "https://connect.neoxify.site/api" };
    expect(ladderPass.baseline.current).toEqual({ ip: "192.0.2.228", from: "https://connect.neoxify.site/api" });
    ladderPass.reset();
    expect(ladderPass.baseline.current).toBeNull();
  });

  it("keeps the tunnel's server beside it, for the health poll of whichever screen is mounted", () => {
    // Without it a remounted screen's poll could not pass over the
    // connected node's own mirror, which answers from around the tunnel.
    expect(ladderPass.tunnelServer.current).toBeNull();
    const server = { addresses: new Set(["203.0.113.41"]), reachedAround: true };
    ladderPass.tunnelServer.current = server;
    expect(ladderPass.tunnelServer.current).toBe(server);
    ladderPass.reset();
    expect(ladderPass.tunnelServer.current).toBeNull();
  });

  it("tells a screen that adopted a pass when it ends, until it stops listening", () => {
    const heard: string[] = [];
    const stop = ladderPass.onEnd(() => heard.push("first"));
    ladderPass.onEnd(() => {
      throw new Error("one screen's trouble");
    });
    ladderPass.onEnd(() => heard.push("second"));
    ladderPass.ended();
    expect(heard).toEqual(["first", "second"]);
    stop();
    ladderPass.ended();
    expect(heard).toEqual(["first", "second", "second"]);
  });
});

describe("the Dashboard's wiring", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const loadStart = dashboard.indexOf("  async function loadAll(preferRouteId?: string) {");
  const loadEnd = dashboard.indexOf("\n  }\n", loadStart);
  const loadAll = dashboard.slice(loadStart, loadEnd);

  it("keeps the guard, generation and cancel flag in the shared store", () => {
    expect(dashboard).toContain("const ladderRunningRef = ladderPass.running;");
    expect(dashboard).toContain("const ladderStartedAtRef = ladderPass.startedAt;");
    expect(dashboard).toContain("const ladderGenerationRef = ladderPass.generation;");
    expect(dashboard).toContain("const cancelRef = ladderPass.cancel;");
    expect(dashboard).not.toMatch(/const (ladderRunningRef|ladderGenerationRef|cancelRef) = useRef\(/);
    expect(dashboard).toContain("return ladderPass.inFlight();");
  });

  it("keeps the egress baseline in the shared store, so an adopted pass brings it along", () => {
    expect(dashboard).toContain("const baselineIpRef = ladderPass.baseline;");
    expect(dashboard).not.toMatch(/const baselineIpRef = useRef/);
  });

  it("runs a new state's first health check once the one in flight ends, instead of dropping it", () => {
    const start = dashboard.indexOf("const check = async ({ catchUp = false } = {}) => {");
    expect(start).toBeGreaterThan(0);
    const check = dashboard.slice(start, dashboard.indexOf("\n    };\n", start));
    // Busy: only the effect's own first check waits; an interval tick is
    // still dropped, which is what keeps measurements from stacking.
    expect(check).toContain("if (catchUp) healthCheckWantedRef.current = () => check();");
    // Released before the waiting one runs, and it runs only if this one
    // did not hand the tunnel to the ladder.
    const released = check.indexOf("healthCheckInFlightRef.current = false;");
    const taken = check.indexOf("const wanted = healthCheckWantedRef.current;");
    expect(released).toBeGreaterThan(0);
    expect(taken).toBeGreaterThan(released);
    expect(check).toContain("if (failover) await runLadder({ automatic: true });\n      else if (wanted) void wanted();");
    // A run that has ended runs nothing, queued or not.
    expect(check).toContain("if (!live) return;");

    const effect = dashboard.slice(start);
    expect(effect).toContain("void check({ catchUp: true });");
    expect(effect).toContain("const id = setInterval(() => void check(), HEALTH_POLL_MS);");
    expect(effect.slice(effect.indexOf("return () => {"))).toMatch(/^return \(\) => \{\s+live = false;/);
  });

  it("renews the guard at every rung, right after checking it is still the current pass", () => {
    const loop = dashboard.indexOf("for (const [index, candidate] of candidates.entries()) {");
    expect(loop).toBeGreaterThan(0);
    const checked = dashboard.indexOf("if (ladderGenerationRef.current !== generation) break;", loop);
    const renewed = dashboard.indexOf("ladderPass.progress(generation);", loop);
    const settled = dashboard.indexOf("await settleAndCaptureBaseline(", loop);
    expect(checked).toBeGreaterThan(loop);
    expect(renewed).toBeGreaterThan(checked);
    expect(renewed).toBeLessThan(settled);
  });

  it("asks the service before leaving the loading state when our API is unreachable", () => {
    const offlineStart = loadAll.indexOf("if (cached) {");
    const offlineEnd = loadAll.indexOf("return;", offlineStart);
    const offline = loadAll.slice(offlineStart, offlineEnd);
    expect(offlineStart).toBeGreaterThan(0);
    const asked = offline.indexOf("await adoptServiceState(cached.subscription)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(offline.indexOf("setLoading(false)"));
  });

  it("asks the service before drawing the online screen, not after the route list", () => {
    const online = loadAll.slice(loadAll.indexOf("setOfflineSince(null);"));
    const asked = online.indexOf("await adoptServiceState(sub)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(online.indexOf("setLoading(false)"));
    expect(asked).toBeLessThan(online.indexOf("await getAvailableRoutes("));
  });

  it("adopts a pass it did not start, and asks the service when that pass ends", () => {
    const start = dashboard.indexOf("async function adoptServiceState(");
    const adopt = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(adopt).toContain("ladderGenerationRef.current !== ownPassRef.current");
    expect(adopt).toContain('beginIntent("connect")');
    expect(adopt).toContain('publishObserved(intent, "connecting")');
    expect(dashboard).toContain("ownPassRef.current = generation;");
    expect(dashboard).toContain("ladderPass.onEnd(() => {");
    expect(dashboard).toContain("if (ladderGenerationRef.current === generation) ladderPass.ended();");
  });

  it("does not let a slow baseline land over a connect started meanwhile", () => {
    const start = dashboard.indexOf("async function captureBaselinesWhileDown(");
    expect(start).toBeGreaterThan(-1);
    const capture = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    // Within a ceiling, and never one of our nodes' addresses (see
    // `settleAndCaptureBaseline`).
    expect(capture).toMatch(
      /captureBaselineIp\(\{\s*deadline: Date\.now\(\) \+ 2 \* EGRESS_TIMEOUT_MS,\s*nodeAddresses: nodeAddressesOf\(users\),\s*\}\)/,
    );
    expect(capture).toContain("if (ladderGenerationRef.current !== passAtStart || ladderInFlight()) return;");
  });
});
