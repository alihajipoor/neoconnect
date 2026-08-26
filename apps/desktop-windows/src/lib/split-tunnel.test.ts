import { describe, expect, it } from "vitest";
import { exitsForGames } from "./game-apps";
import { appName, gamesFor, isEffective, readGames, scopeOf, scopesFor } from "./split-tunnel";

describe("isEffective", () => {
  it("is false when the toggle is on but nothing is chosen", () => {
    // The state a customer reaches by flipping the switch and getting
    // distracted. It must read as "doing nothing", because the
    // alternative reading -- tunnel everything -- is the opposite of
    // what the toggle promises, and it decides whether the UI warns.
    expect(isEffective({ enabled: true, apps: [], mode: "onlySelected", scopes: [], games: [] })).toBe(false);
  });

  it("is false when apps are chosen but the toggle is off", () => {
    // The list survives the toggle so a customer can turn Custom mode
    // off and back on without re-picking their games.
    expect(isEffective({ enabled: false, apps: [String.raw`C:\Games\game.exe`], mode: "onlySelected", scopes: [], games: [] })).toBe(false);
  });

  it("is true only when both are set", () => {
    expect(isEffective({ enabled: true, apps: [String.raw`C:\Games\game.exe`], mode: "onlySelected", scopes: [], games: [] })).toBe(true);
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
    games: [],
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

describe("readGames", () => {
  // The all-or-nothing rule `readScopes` follows, applied to something
  // sharper. A scope that survives with half its prefixes splits one
  // game across two paths. A GROUP that survives with half its
  // executable names reads as COMPLETE -- and a complete group is
  // exactly what earns a per-game exit, so the names the truncated read
  // dropped would be carried somewhere else while the group reported
  // itself whole. Dropping the whole group returns that game to having
  // no exit preference, which is the state every game was in before
  // this existed.
  const whole = {
    slug: "rust",
    displayName: "Rust",
    names: ["Rust.exe", "RustClient.exe"],
    exit: "germany-1",
  };

  it("takes a well-formed group", () => {
    expect(readGames([whole])).toEqual([whole]);
  });

  it("keeps a group with no exit chosen, which is most of them", () => {
    expect(readGames([{ ...whole, exit: null }])).toEqual([{ ...whole, exit: null }]);
  });

  it("drops a group whose names did not survive the read", () => {
    expect(readGames([{ ...whole, names: ["Rust.exe", 7] }])).toEqual([]);
    expect(readGames([{ ...whole, names: [] }])).toEqual([]);
    expect(readGames([{ ...whole, names: "Rust.exe" }])).toEqual([]);
  });

  it("drops a group whose exit is neither a name nor null", () => {
    // Reading an unknown value as an exit identifier would name an exit
    // nobody chose.
    expect(readGames([{ ...whole, exit: 3 }])).toEqual([]);
    expect(readGames([{ ...whole, exit: "" }])).toEqual([]);
    expect(readGames([{ ...whole, exit: undefined }])).toEqual([]);
  });

  it("keeps one row per game", () => {
    // A duplicate slug puts one game in two groups, which is the split
    // this feature refuses, arriving through the store file.
    const twice = readGames([whole, { ...whole, exit: "turkey-1" }]);
    expect(twice).toHaveLength(1);
    expect(twice[0].exit).toBe("germany-1");
  });

  it("reads a file written before groups existed as no groups", () => {
    expect(readGames(undefined)).toEqual([]);
    expect(readGames("games")).toEqual([]);
  });
});

describe("gamesFor", () => {
  const RUST_WRAPPER = String.raw`C:\Rust\Rust.exe`;
  const RUST_CLIENT = String.raw`C:\Rust\RustClient.exe`;
  const rust = {
    slug: "rust",
    displayName: "Rust",
    names: ["Rust.exe", "RustClient.exe"],
    exit: "germany-1",
  };

  it("forgets a game whose every binary the customer removed", () => {
    // Left behind, the group would silently reapply its exit the day
    // they added one of those binaries back by hand.
    expect(gamesFor([], [rust])).toEqual([]);
  });

  it("keeps a game that lost only some of its binaries", () => {
    // Deliberately kept. It is now partial, and `exitsForGames`
    // withholds its exit for that reason and says so -- which is the
    // honest outcome, and better than quietly forgetting the customer
    // ever chose an exit for that game.
    expect(gamesFor([RUST_WRAPPER], [rust])).toEqual([rust]);
    expect(exitsForGames(gamesFor([RUST_WRAPPER], [rust]), [RUST_WRAPPER]).exits).toEqual([]);
  });

  it("keeps a whole game, which then places", () => {
    const apps = [RUST_WRAPPER, RUST_CLIENT];
    expect(gamesFor(apps, [rust])).toEqual([rust]);
    expect(exitsForGames(gamesFor(apps, [rust]), apps).exits).toHaveLength(2);
  });
});
