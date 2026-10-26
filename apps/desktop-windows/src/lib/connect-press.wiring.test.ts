import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** A Connect press shows itself at once (the VM, round 3, O2: a press that
 * showed nothing for two minutes). The ladder says "connecting" before it
 * awaits anything, and nothing is awaited before the ladder but a device
 * limit's teardown still owed -- whose own words are on screen meanwhile.
 * The claim before dialling, and the release still on its way that it
 * gives a moment to (`RELEASE_WAIT_MS`), are awaited only after that. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("a Connect press", () => {
  const dash = source("../screens/Dashboard.tsx");

  it("reaches the ladder with nothing awaited but a teardown the device limit still owes", () => {
    const press = dash.slice(dash.indexOf("async function connectNow(takeover?: string[]) {"));
    const body = press.slice(0, press.indexOf("\n  }\n"));
    const ladder = body.indexOf("const outcome = await runLadder({ takeover });");
    expect(ladder).toBeGreaterThan(-1);
    const before = body.slice(0, ladder);
    expect(before.match(/await /g)).toEqual(["await "]);
    expect(before).toContain("if ((await slotTeardown.retry(tearDownForSlotOnce)) === \"stuck\") return;");
  });

  it("is said as connecting before the ladder awaits anything, the slot's claim and any release in front of it included", () => {
    const ladder = dash.slice(dash.indexOf("async function runLadder("));
    const shown = ladder.indexOf('publishObserved(intent, "connecting");');
    expect(shown).toBeGreaterThan(-1);
    expect(ladder.indexOf("await ")).toBeGreaterThan(shown);
    expect(ladder.indexOf("const decision = await slotDecision;")).toBeGreaterThan(shown);
  });

  it("never waits on a release by itself", () => {
    const slot = source("./device-slot-session.ts");
    expect(slot).not.toMatch(/if \(releasing\) await releasing;/);
    expect(slot.match(/await releaseOutOfTheWay\(\);/g)).toHaveLength(2);
  });
});
