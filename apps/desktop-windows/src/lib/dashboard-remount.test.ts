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
    const start = dashboard.indexOf("async function captureBaselinesWhileDown()");
    const capture = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(capture).toContain("captureBaselineIp({ deadline: Date.now() + 2 * EGRESS_TIMEOUT_MS })");
    expect(capture).toContain("if (ladderGenerationRef.current !== passAtStart || ladderInFlight()) return;");
  });
});
