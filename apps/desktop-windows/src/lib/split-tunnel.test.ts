import { describe, expect, it } from "vitest";
import { appName, isEffective, scopeOf, scopesFor } from "./split-tunnel";

describe("isEffective", () => {
  it("is false when the toggle is on but nothing is chosen", () => {
    // The state a customer reaches by flipping the switch and getting
    // distracted. It must read as "doing nothing", because the
    // alternative reading -- tunnel everything -- is the opposite of
    // what the toggle promises, and it decides whether the UI warns.
    expect(isEffective({ enabled: true, apps: [], mode: "onlySelected", scopes: [] })).toBe(false);
  });

  it("is false when apps are chosen but the toggle is off", () => {
    // The list survives the toggle so a customer can turn Custom mode
    // off and back on without re-picking their games.
    expect(isEffective({ enabled: false, apps: [String.raw`C:\Games\game.exe`], mode: "onlySelected", scopes: [] })).toBe(false);
  });

  it("is true only when both are set", () => {
    expect(isEffective({ enabled: true, apps: [String.raw`C:\Games\game.exe`], mode: "onlySelected", scopes: [] })).toBe(true);
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

describe("scopesFor", () => {
  const GAME = String.raw`C:\Games\game.exe`;

  it("drops a scope whose app is no longer chosen", () => {
    // Removing an app has to remove its scope with it. Left behind, the
    // scope is inert -- the service ignores one naming an app it was
    // not given -- but it would come back to life the moment the
    // customer re-added that program by hand, silently narrowing a
    // selection they made expecting the ordinary behaviour.
    const scopes = [{ app: GAME, destinations: ["203.0.113.0/24"] }];
    expect(scopesFor([], scopes)).toEqual([]);
    expect(scopesFor([String.raw`C:\Chat\chat.exe`], scopes)).toEqual([]);
  });

  it("keeps a scope whose app is still chosen, whatever the casing", () => {
    // Windows paths are case-insensitive and the picker's spelling does
    // not always match what a process reports. A scope dropped over a
    // capital letter presents as the game being carried in full, which
    // is safe but indistinguishable from the feature not working.
    const scopes = [{ app: GAME, destinations: ["203.0.113.0/24"] }];
    expect(scopesFor([GAME], scopes)).toEqual(scopes);
    expect(scopesFor([String.raw`c:\games\GAME.EXE`], scopes)).toEqual(scopes);
  });
});

describe("scopeOf", () => {
  const GAME = String.raw`C:\Games\game.exe`;
  const settings = {
    enabled: true,
    apps: [GAME, String.raw`C:\Chat\chat.exe`],
    mode: "onlySelected" as const,
    scopes: [{ app: GAME, destinations: ["203.0.113.0/24"] }],
  };

  it("finds the scope for a narrowed app", () => {
    // This is what decides whether the row says "Game servers only".
    // Getting it wrong in the false direction tells a customer their
    // whole application is carried when only part of it is, which is
    // the larger of the two claims and the one that must not be made
    // loosely.
    expect(scopeOf(settings, GAME)?.destinations).toEqual(["203.0.113.0/24"]);
    expect(scopeOf(settings, String.raw`c:\games\game.exe`)).toBeDefined();
  });

  it("returns nothing for an app that is carried in full", () => {
    expect(scopeOf(settings, String.raw`C:\Chat\chat.exe`)).toBeUndefined();
  });
});
