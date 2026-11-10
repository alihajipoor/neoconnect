import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Both ladders, after a rung has come up and measured slow: a short
 * search for something better, then back to the slow rung (`endSearch`
 * in data-check.ts) -- and, on any pass, the rungs that came up and
 * carried nothing or did not connect remembered as that
 * (`recordDead`), for the next pass's order. data-check.test.ts,
 * connect-history.test.ts and failover.test.ts pin the rules; this pins
 * that each screen's pass asks them where it has to. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const LOOP = "for (let index = 0; index < candidates.length || queueSlowFallback(); index += 1) {";

const windows = source("../screens/Dashboard.tsx");
const windowsPass = windows.slice(windows.indexOf("async function runLadder("));
const phone = source("../../../mobile/src/screens/Dashboard.tsx");
const phonePass = phone.slice(phone.indexOf("async function walkLadder("));

for (const [name, pass, dial] of [
  ["the Windows ladder", windowsPass, 'const dial = invoke("vpn_connect", {'],
  ["the phone's ladder", phonePass, "await connectIkev2({"],
] as const) {
  describe(`${name}, after a slow rung`, () => {
    const loop = pass.slice(pass.indexOf(LOOP));
    const asked = loop.indexOf("const back = endSearch(slow);");
    const dialled = loop.indexOf(dial);

    it("asks whether it has looked far enough before a rung costs anything", () => {
      expect(pass.indexOf(LOOP)).toBeGreaterThan(0);
      expect(asked).toBeGreaterThan(0);
      // After the rung's own pass-over, which dials nothing and spends
      // nothing of the budget...
      expect(asked).toBeGreaterThan(loop.indexOf("if (passOverSlow(slow, candidate)) {"));
      // ...and before its baseline and its dial.
      const baseline = loop.search(/settleAndCaptureBaseline\(|await takeBaseline\(/);
      expect(baseline).toBeGreaterThan(asked);
      expect(dialled).toBeGreaterThan(asked);
    });

    it("goes back to the slow rung ahead of what is left, and says how many rungs it did not dial", () => {
      const block = loop.slice(asked, loop.indexOf("continue;", asked));
      expect(block).toContain("describeSearchEnd(back, candidates.length - index)");
      // A line that says nothing about the network: no dial is recorded for it.
      expect(block).toContain("dials.push(null);");
      // In front of the rest, so a pass that then fails has still dialled them.
      expect(block).toMatch(/candidates\.splice\(index, 0, back\.candidate\);|\[\.\.\.candidates\.slice\(0, index\), back\.candidate, \.\.\.candidates\.slice\(index\)\]/);
      expect(block).toContain("index -= 1;");
    });

    it("counts a rung against the search only where it is dialled", () => {
      expect(loop.split("noteDial(slow, candidate);").length - 1).toBe(1);
      const counted = loop.indexOf("noteDial(slow, candidate);");
      expect(counted).toBeGreaterThan(asked);
      expect(counted).toBeLessThan(dialled);
    });

    it("searches what is left in the order this network's memory gives, the chosen location still leading", () => {
      expect(pass).toContain("const chosenPlace = new Set(chosenRouteId ? [chosenRouteId, ...sameCountryRouteIds(routes, chosenRouteId)] : []);");
      expect(pass).toMatch(/searchOrder\(\s*candidates\.slice\(from\),\s*\(later\) => workedLately\(\w+, networkId, later\.routeId, later\.protocol\),\s*\(later\) => chosenPlace\.has\(later\.routeId\),\s*\)/);
      const noted = loop.indexOf("noteSlow(slow, candidate, moved);");
      expect(noted).toBeGreaterThan(0);
      // Only while the short search is on: a pass that walks on from a
      // slow rung with no search keeps the order it had.
      expect(loop.slice(noted, noted + 400)).toContain("if (searching(slow)) searchFrom(index + 1);");
      expect(loop.split("searchFrom(index + 1);").length - 1).toBe(1);
    });

    it("stops looking early only for a server this network's memory has seen pass the check", () => {
      // Without it every slow rung began the search, a held server's too.
      // `movedLately`, not `workedLately`: a landing whose check could not
      // be run does not vouch for a server.
      expect(pass).toMatch(
        /const slow = noSlowRungs\(\s*\(candidate\) => serverKey\(candidate, routes\),\s*candidates\.filter\(\(candidate\) => movedLately\(history, networkId, candidate\.routeId, candidate\.protocol\)\),\s*\);/,
      );
    });
  });
}

describe("the Windows ladder's memory of rungs that failed", () => {
  const loop = windowsPass.slice(windowsPass.indexOf(LOOP));

  it("remembers a rung that came up only where the address check measured it carrying nothing, and the pass had not been stopped", () => {
    // What the check came to, kept for the mark: null in Custom mode,
    // where there is none, and the last reading where it ran twice.
    expect(loop).toContain("let checked: EgressVerdict[\"state\"] | null = null;");
    const judged = loop.indexOf("reason = checkedAgain ?");
    expect(judged).toBeGreaterThan(0);
    expect(loop.slice(judged, judged + 200)).toContain("checked = egress.state;");
    expect(loop.split("checked = ").length - 1).toBe(1);
    expect(loop).toContain(
      "if (rungShownDead({ up: true, egress: checked }, stopped())) {\n            passHistory = recordDead(passHistory, networkId, candidate.routeId, candidate.protocol);",
    );
    // Nothing else marks one that came up: not every rung moved on from.
    expect(loop).not.toContain("if (!tooSlow) passHistory = recordDead(");
  });

  it("remembers a rung that did not connect only where the report counts it against the route, and the pass had not been stopped", () => {
    expect(loop).toContain(
      "if (rungShownDead({ up: false, dial: failedDial(candidate.routeId, classified.kind) }, stopped())) {\n            passHistory = recordDead(passHistory, networkId, candidate.routeId, candidate.protocol);",
    );
    expect(loop.split("passHistory = recordDead(").length - 1).toBe(2);
  });

  it("takes a rung back out of the memory wherever it takes it back out of the report", () => {
    const retaken = loop.slice(loop.indexOf("failedRungs.pop();"));
    expect(retaken.slice(0, 80)).toContain("passHistory = historyBeforeRung;");
    const restarted = loop.slice(loop.indexOf("dials.length = 0;"));
    expect(restarted.slice(0, 80)).toContain("passHistory = history;");
    expect(loop).toContain("const historyBeforeRung = passHistory;");
  });

  it("writes it with the landing, and when a pass fails or is stopped", () => {
    expect(windowsPass).toMatch(/let recorded = recordAttempt\(\s*passHistory,/);
    const over = windowsPass.slice(windowsPass.indexOf('if (ladderGenerationRef.current !== generation) return "failed";'));
    const written = over.indexOf("if (passHistory !== history && sessionGeneration() === sessionAtStart) {");
    expect(written).toBeGreaterThan(0);
    expect(over.slice(written, written + 160)).toContain("void saveConnectHistory(passHistory);");
    // Before the pass decides whether it was stopped: a stopped pass's too.
    expect(written).toBeLessThan(over.indexOf("setConnectionError(stopped() ? null : lastError);"));
  });

  it("does not count a wait for a network as time spent looking", () => {
    const waited = loop.slice(loop.indexOf('if (waited === "back" || waited === "retry") {'));
    expect(waited.slice(0, waited.indexOf("continue;"))).toContain("restartSearch(slow);");
  });
});

describe("the phone ladder's memory of rungs that failed", () => {
  it("marks the two kinds that carried nothing, and leaves a slow rung and an unconfirmed landing as they were", () => {
    expect(phonePass).toContain(
      "attempts.push(`${label}: up but not carrying traffic`);\n          dials.push({ routeId: candidate.routeId, carried: false });\n          rememberDead(candidate.routeId, candidate.protocol);",
    );
    // A dial that failed as the pass was being stopped is the stop's doing.
    expect(phonePass).toContain(
      "if (rungShownDead({ up: false, dial }, pass.stopped())) rememberDead(candidate.routeId, candidate.protocol);",
    );
    expect(phonePass.split("rememberDead(candidate.routeId, candidate.protocol);").length - 1).toBe(2);
    // One that came up is marked only on a measured negative, and a stop
    // during its check has ended the pass before that.
    const judged = phonePass.indexOf("} else if (rejectionIsEvidence(verdict)) {");
    expect(judged).toBeGreaterThan(phonePass.indexOf("if (verdict === null || pass.stopped()) {"));
    expect(phonePass).toContain("remember(candidate.routeId, candidate.protocol, false, rememberedKbps(tooSlow));");
    expect(phonePass).toContain("remember(candidate.routeId, candidate.protocol, proven && !keptSlow, rememberedKbps(measured));");
    expect(phonePass).toContain("historyNow = recordDead(historyNow, networkId, routeId, protocol);");
  });
});
