import { describe, expect, it } from "vitest";
import { appName, isEffective } from "./split-tunnel";

describe("isEffective", () => {
  it("is false when the toggle is on but nothing is chosen", () => {
    // The state a customer reaches by flipping the switch and getting
    // distracted. It must read as "doing nothing", because the
    // alternative reading -- tunnel everything -- is the opposite of
    // what the toggle promises, and it decides whether the UI warns.
    expect(isEffective({ enabled: true, apps: [] })).toBe(false);
  });

  it("is false when apps are chosen but the toggle is off", () => {
    // The list survives the toggle so a customer can turn Custom mode
    // off and back on without re-picking their games.
    expect(isEffective({ enabled: false, apps: [String.raw`C:\Games\game.exe`] })).toBe(false);
  });

  it("is true only when both are set", () => {
    expect(isEffective({ enabled: true, apps: [String.raw`C:\Games\game.exe`] })).toBe(true);
  });
});

describe("appName", () => {
  it("shows the executable rather than the whole path", () => {
    expect(appName(String.raw`C:\Riot Games\VALORANT\live\VALORANT.exe`)).toBe("VALORANT.exe");
  });

  it("handles forward slashes, which Windows also accepts", () => {
    expect(appName("C:/Games/game.exe")).toBe("game.exe");
  });

  it("falls back to the whole string rather than rendering nothing", () => {
    // A bare name or an odd value should still show something. An empty
    // list row would look like a bug in the picker.
    expect(appName("game.exe")).toBe("game.exe");
    expect(appName("")).toBe("");
  });
});
