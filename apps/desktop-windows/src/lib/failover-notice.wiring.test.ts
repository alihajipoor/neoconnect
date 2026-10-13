import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Windows dashboard's half of the failover line, which the pure
 * tests in failover-notice.test.ts cannot reach: the dashboard needs a
 * Tauri runtime, the helper service and a network. What can be pinned is
 * that the ladder records what each failed rung did with its route, and
 * that the line on screen is chosen by the tested rule rather than around
 * it. Each assertion fails against the dashboard that said "Couldn't reach
 * fi-finland" about a server there was no network to dial. */

const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("));

describe("the failover line", () => {
  it("is decided from what each failed rung did, not from the ladder reaching a route", () => {
    expect(dashboard).not.toContain("triedShownRoute");
    expect(dashboard).not.toContain("intendedWasTried");

    const classified = ladder.indexOf("const classified = classifyConnectionError(err);");
    const fate = ladder.indexOf("failedRungs.push({ routeId: candidate.routeId, fate: rungFate(classified.kind) });");
    expect(classified).toBeGreaterThan(0);
    expect(fate).toBeGreaterThan(classified);

    // A tunnel that came up and was rejected was dialled.
    const upBut = ladder.indexOf("attempts.push(`${label}: up but ${reason}`);");
    const dialled = ladder.indexOf('failedRungs.push({ routeId: candidate.routeId, fate: "dialled" });');
    expect(upBut).toBeGreaterThan(0);
    expect(dialled).toBeGreaterThan(upBut);
    expect(dialled).toBeLessThan(classified);

    expect(ladder).toMatch(/setFailedOverTo\(\s*failoverNotice\(\{[\s\S]*?failed: failedRungs,/);
  });

  it("is worded by the tested rule", () => {
    expect(dashboard).toContain("const said = failoverText(failedOverTo);");
    expect(dashboard).not.toMatch(/t\(\s*"dash\.switchedServer"/);
    expect(dashboard).not.toMatch(/\?\s*"dash\.switchedServer"/);
  });
});
