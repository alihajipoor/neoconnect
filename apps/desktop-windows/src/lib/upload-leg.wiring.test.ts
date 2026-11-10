import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Both ladders give the data check's upload leg the time this network's
 * own passing uploads call for (`uploadLegMs` in data-check.ts,
 * `typicalUploadKbps` in connect-history.ts), and remember the upload of
 * each rung whose check passed. data-check.test.ts and
 * connect-history.test.ts pin the rules; this pins that each screen's
 * pass asks them where it has to -- a pass that forgot would run the
 * check as it always did, with nothing failing. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const LOOP = "for (let index = 0; index < candidates.length || queueSlowFallback(); index += 1) {";

const windows = source("../screens/Dashboard.tsx");
const windowsPass = windows.slice(windows.indexOf("async function runLadder("));
const phone = source("../../../mobile/src/screens/Dashboard.tsx");
const phonePass = phone.slice(phone.indexOf("async function walkLadder("));

for (const [name, pass, check, remembered] of [
  [
    "the Windows ladder",
    windowsPass,
    "const moved = await checkDataMoves(egress.from, upLegMs);",
    "const up = passedUploadKbps(measured);\n              if (up !== null) recorded = recordUpload(recorded, networkId, candidate.routeId, candidate.protocol, up);",
  ],
  [
    "the phone's ladder",
    phonePass,
    "const moved = await checkDataMoves(verdict.from, upLegMs);",
    "rememberUpload(candidate.routeId, candidate.protocol, passedUploadKbps(measured));",
  ],
] as const) {
  describe(`${name}, timing the upload`, () => {
    const budget = "const upLegMs = uploadLegMs(typicalUploadKbps(history, networkId));";

    it("takes the upload leg's time from this network's memory, once, before the first rung", () => {
      expect(pass.indexOf(LOOP)).toBeGreaterThan(0);
      expect(pass.split(budget).length - 1).toBe(1);
      expect(pass.indexOf(budget)).toBeLessThan(pass.indexOf(LOOP));
    });

    it("gives every rung's check that time, and runs no check without it", () => {
      expect(pass).toContain(check);
      expect(pass.split("checkDataMoves(").length - 1).toBe(1);
    });

    it("remembers the upload of the rung that landed, where its check passed", () => {
      const loop = pass.slice(pass.indexOf(LOOP));
      expect(loop.split(remembered).length - 1).toBe(1);
      // With the landing's own record, not on a rung the pass moved on from.
      const landed = loop.indexOf("rememberedKbps(measured)");
      expect(landed).toBeGreaterThan(0);
      expect(loop.indexOf(remembered)).toBeGreaterThan(landed);
      expect(loop.indexOf(remembered) - landed).toBeLessThan(700);
    });
  });
}

describe("the phone's ladder, remembering an upload", () => {
  it("stamps it on the rung just recorded, in this network's memory, and saves it", () => {
    const helper = phonePass.slice(phonePass.indexOf("const rememberUpload = "));
    const body = helper.slice(0, helper.indexOf("};"));
    expect(body).toContain("if (upKbps === null) return;");
    expect(body).toContain("historyNow = recordUpload(historyNow, networkId, routeId, protocol, upKbps);");
    expect(body).toContain("void saveConnectHistory(historyNow);");
  });
});
