import { describe, expect, it } from "vitest";
import {
  exitsForGames,
  gameExitGroup,
  groupMembers,
  isWholeGroup,
  rescanGameGroups,
  unresolvedNames,
  type GameExitGroup,
} from "./game-apps";
import type { RunningApp } from "./split-tunnel";

/** The re-scan.
 *
 * `resolveGameApps` runs once, against running processes, at the moment
 * a game is added. Nothing looked again. The two consequences seen on
 * the rig are the first two tests here: a game added at its launcher
 * stage never picks up the client that starts moments later, and a
 * partly resolved group gets no per-game exit at all -- correctly, since
 * a partial group must never be placed, but it means the customer's
 * choice silently does nothing.
 */

function running(...paths: string[]): RunningApp[] {
  return paths.map((path) => ({ path, name: path.split("\\").pop() ?? path }));
}

const RUST = "Rust";
function rustGroup(exit: string | null = null): GameExitGroup {
  return gameExitGroup(
    { slug: "rust", displayName: RUST, processNames: ["RustClient.exe", "EasyAntiCheat.exe"] },
    exit,
  );
}

const LAUNCHER = "C:\\Games\\Rust\\EasyAntiCheat.exe";
const CLIENT = "C:\\Games\\Rust\\RustClient.exe";

describe("re-scanning for a game's missing binaries", () => {
  it("finds the client that started after the launcher was added", () => {
    const group = rustGroup();
    const apps = [LAUNCHER];
    expect(isWholeGroup(group, apps)).toBe(false);

    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);

    expect(found.paths).toEqual([CLIENT]);
    expect(found.completed.map((c) => c.slug)).toEqual(["rust"]);
    expect(found.completed[0]?.names).toEqual(["RustClient.exe"]);
    expect(isWholeGroup(group, [...apps, ...found.paths])).toBe(true);
  });

  it("adds nothing for a program that is in no game the customer added", () => {
    // The policy this whole feature stands on. Discord and a browser are
    // running; neither is named by any added game, so neither is
    // visible to the re-scan. It completes a choice already made and
    // introduces nothing new.
    const group = rustGroup();
    const found = rescanGameGroups(
      [group],
      [LAUNCHER],
      running(LAUNCHER, "C:\\Users\\a\\Discord.exe", "C:\\Program Files\\Firefox\\firefox.exe"),
      64,
    );
    expect(found.paths).toEqual([]);
    expect(found.completed).toEqual([]);
  });

  it("does not call a group whole while one of its binaries is still missing", () => {
    const group = gameExitGroup({
      slug: "wow",
      displayName: "World of Warcraft",
      processNames: ["Wow.exe", "Battle.net.exe", "Agent.exe"],
    });
    const apps = ["C:\\Games\\Battle.net.exe"];

    const found = rescanGameGroups([group], apps, running(...apps, "C:\\Games\\Wow.exe"), 64);

    // It moved -- Wow.exe was picked up -- but Agent.exe is still not
    // running, so nothing is announced as complete.
    expect(found.paths).toEqual(["C:\\Games\\Wow.exe"]);
    expect(found.completed).toEqual([]);
    expect(unresolvedNames(group, [...apps, ...found.paths])).toEqual(["Agent.exe"]);
  });

  it("puts every found binary in its own group and never loose", () => {
    // Structural, not a convention: a path is only ever looked up
    // because a group named it, so it is a member the moment it lands.
    const group = rustGroup();
    const apps = [LAUNCHER];
    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    const after = [...apps, ...found.paths];

    for (const path of found.paths) {
      expect(groupMembers(group, after)).toContain(path);
    }
  });

  it("skips a group that is already whole", () => {
    const group = rustGroup();
    const apps = [LAUNCHER, CLIENT];
    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    expect(found).toEqual({ paths: [], completed: [], withheldAtCap: [] });
  });

  it("never re-adds a path that is already selected", () => {
    const group = rustGroup();
    // Same binary, different casing -- Windows paths are case
    // insensitive and the picker's casing does not always match what a
    // process reports.
    const apps = [LAUNCHER, "c:\\games\\rust\\rustclient.exe"];
    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    expect(found.paths).toEqual([]);
  });
});

describe("the cap", () => {
  it("withholds a whole game rather than adding the part that fits", () => {
    // Adding the binaries that fit is the one outcome that must not
    // happen: it is exactly how a game ends up half in the tunnel and
    // half out of it.
    const group = gameExitGroup({
      slug: "rust",
      displayName: RUST,
      processNames: ["RustClient.exe", "EasyAntiCheat.exe", "RustLauncher.exe"],
    });
    const filler = Array.from({ length: 62 }, (_, i) => `C:\\filler\\app${i}.exe`);
    const apps = [LAUNCHER, ...filler]; // 63 of 64 used

    const found = rescanGameGroups(
      [group],
      apps,
      running(LAUNCHER, CLIENT, "C:\\Games\\Rust\\RustLauncher.exe"),
      64,
    );

    // Two binaries found, one slot free. Neither is added.
    expect(found.paths).toEqual([]);
    expect(found.withheldAtCap.map((w) => w.slug)).toEqual(["rust"]);
    expect(found.withheldAtCap[0]?.paths).toHaveLength(2);
    expect(found.completed).toEqual([]);
  });

  it("still fits a later, smaller game after withholding a larger one", () => {
    const big = gameExitGroup({
      slug: "big",
      displayName: "Big",
      processNames: ["BigA.exe", "BigB.exe", "BigC.exe"],
    });
    const small = gameExitGroup({ slug: "small", displayName: "Small", processNames: ["Small.exe"] });
    const filler = Array.from({ length: 63 }, (_, i) => `C:\\filler\\app${i}.exe`);

    const found = rescanGameGroups(
      [big, small],
      filler, // 63 of 64 used, one slot free
      running("C:\\g\\BigA.exe", "C:\\g\\BigB.exe", "C:\\g\\Small.exe"),
      64,
    );

    expect(found.withheldAtCap.map((w) => w.slug)).toEqual(["big"]);
    expect(found.paths).toEqual(["C:\\g\\Small.exe"]);
    expect(found.completed.map((c) => c.slug)).toEqual(["small"]);
  });

  it("fills the last slot exactly rather than refusing at the boundary", () => {
    const group = rustGroup();
    const filler = Array.from({ length: 62 }, (_, i) => `C:\\filler\\app${i}.exe`);
    const apps = [LAUNCHER, ...filler]; // 63 of 64
    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    expect(found.paths).toEqual([CLIENT]);
    expect(apps.length + found.paths.length).toBe(64);
  });
});

describe("what completing a group unlocks", () => {
  it("turns a withheld exit into a placed one", () => {
    // The second rig consequence, end to end. A partial group is
    // refused an exit -- correctly -- so the customer's choice does
    // nothing at all until the group is whole. This is the test that
    // says the re-scan is worth having.
    const group = rustGroup("exit-fi");
    const apps = [LAUNCHER];

    const before = exitsForGames([group], apps);
    expect(before.exits).toEqual([]);
    expect(before.withheld.map((w) => w.reason)).toEqual(["partial"]);

    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    const after = exitsForGames([group], [...apps, ...found.paths]);

    expect(after.withheld).toEqual([]);
    // Both binaries, one exit, each naming its game.
    expect(after.exits).toHaveLength(2);
    expect(new Set(after.exits.map((e) => e.exit))).toEqual(new Set(["exit-fi"]));
    expect(after.exits.every((e) => e.group === "rust")).toBe(true);
    expect(new Set(after.exits.map((e) => e.app))).toEqual(new Set([LAUNCHER, CLIENT]));
  });

  it("leaves a withheld-at-cap game with no exit at all", () => {
    // The safe direction, stated as a test: withholding the whole
    // game's preference, never placing part of it.
    const group = gameExitGroup(
      { slug: "rust", displayName: RUST, processNames: ["RustClient.exe", "EasyAntiCheat.exe"] },
      "exit-fi",
    );
    const filler = Array.from({ length: 63 }, (_, i) => `C:\\filler\\app${i}.exe`);
    const apps = [...filler]; // 63 of 64, both Rust binaries missing

    const found = rescanGameGroups([group], apps, running(LAUNCHER, CLIENT), 64);
    expect(found.paths).toEqual([]);
    expect(found.withheldAtCap.map((w) => w.slug)).toEqual(["rust"]);

    const after = exitsForGames([group], [...apps, ...found.paths]);
    expect(after.exits).toEqual([]);
    expect(after.withheld.map((w) => w.reason)).toEqual(["partial"]);
  });
});
