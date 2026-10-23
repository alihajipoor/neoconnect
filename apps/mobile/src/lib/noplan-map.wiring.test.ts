import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 2026-10-23: on an account with no plan the phone's main page showed an
 * empty stage under "No active subscription". The map and the mark stay
 * for that note; a real problem still clears the stage. */
describe("the phone's map with no plan", () => {
  const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");

  it("stays for a plain no-plan note", () => {
    expect(source).toContain("const noPlanOnly = !subscription && !error && offlineSince === null && !endedState;");
    expect(source).toContain("const mapAlert = (bannerShowing && !noPlanOnly) || slotShowing || connectionError !== null || notesShowing;");
  });
});
