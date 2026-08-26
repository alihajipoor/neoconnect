import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canPlaceAnotherGame,
  canRouteByDestination,
  exitsForGames,
  MAX_CONCURRENT_EXITS,
  gameExitGroup,
  groupMembers,
  isWholeGroup,
  scopesForGame,
  unresolvedNames,
  curatedNames,
  hasCuratedApps,
  isSelectableAppPath,
  resolveGameApps,
  GAME_PAGE_SIZE,
  rankGames,
  type GameExitGroup,
  type SearchableGame,
} from "./game-apps";
import type { RunningApp } from "./split-tunnel";

/** What these tests are for.
 *
 * The catalogue's executable names have to become full paths the split
 * tunnel will accept, and there are exactly two ways that goes wrong in
 * a way nobody notices:
 *
 * * A path the wire format rejects. `SplitTunnelConfig::validate` fails
 *   the **whole** `SetSplitTunnel` request on one bad entry, so a single
 *   malformed catalogue path would silently drop every app the customer
 *   had already chosen.
 * * A name that matched nothing and was not reported. Adding three of a
 *   game's six programs and saying "added" is the half-routed product
 *   this feature exists to stop.
 */

function app(path: string, extra: Partial<RunningApp> = {}): RunningApp {
  return { path, name: path.split("\\").pop() ?? path, ...extra };
}

const RIOT: RunningApp[] = [
  app("C:\\Riot Games\\Riot Client\\RiotClientServices.exe", {
    name: "Riot Client",
    paths: [
      "C:\\Riot Games\\Riot Client\\RiotClientServices.exe",
      "C:\\Riot Games\\Riot Client\\UX\\RiotClientUx.exe",
    ],
  }),
  app("C:\\Riot Games\\VALORANT\\live\\VALORANT.exe", {
    name: "VALORANT",
    paths: [
      "C:\\Riot Games\\VALORANT\\live\\VALORANT.exe",
      "C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe",
    ],
  }),
];

/** Mirrors the seeded `valorant` row. `UnrealCEFSubProcess.exe` was in it
 * until 2026-08-25 and was dropped as a generic Unreal Engine name; this
 * fixture follows the row so the "missing" expectation below keeps
 * describing what the product actually does. */
const VALORANT_PROFILE = {
  processNames: [
    "VALORANT.exe",
    "VALORANT-Win64-Shipping.exe",
    "RiotClientServices.exe",
    "vgc.exe",
    "vgm.exe",
  ],
};

describe("isSelectableAppPath", () => {
  it("accepts what the wire format accepts", () => {
    expect(isSelectableAppPath("C:\\Riot Games\\VALORANT\\live\\VALORANT.exe")).toBe(true);
    expect(isSelectableAppPath("\\\\fileserver\\games\\VALORANT.exe")).toBe(true);
    // Case is irrelevant: the service lowercases once at construction.
    expect(isSelectableAppPath("D:\\GAMES\\WOW.EXE")).toBe(true);
  });

  it("rejects a bare filename, which is what the catalogue actually carries", () => {
    // The whole reason a resolution step exists. Pushing this would
    // fail validation and take the customer's existing list with it.
    expect(isSelectableAppPath("VALORANT.exe")).toBe(false);
    expect(isSelectableAppPath("Riot Games\\VALORANT.exe")).toBe(false);
  });

  it("rejects anything that is not an executable", () => {
    // vgk.sys is Vanguard's kernel driver. It has no image path a
    // process could report and nothing in the split tunnel can match
    // it, so it must never reach the wire.
    expect(isSelectableAppPath("C:\\Program Files\\Riot Vanguard\\vgk.sys")).toBe(false);
    expect(isSelectableAppPath("C:\\Riot Games\\")).toBe(false);
  });

  it("rejects control characters and empty strings", () => {
    expect(isSelectableAppPath("")).toBe(false);
    expect(isSelectableAppPath("C:\\games\\bad\u0000name.exe")).toBe(false);
  });

  it("accepts a non-ASCII path, which is a real customer case", () => {
    expect(isSelectableAppPath("C:\\بازی‌ها\\VALORANT.exe")).toBe(true);
  });
});

describe("curatedNames", () => {
  it("survives a server that has never heard of the field", () => {
    // A client can be newer than its server. An absent list means the
    // server has nothing to offer, which is not an error.
    expect(curatedNames({} as { processNames?: string[] })).toEqual([]);
    expect(curatedNames({ processNames: undefined })).toEqual([]);
  });

  it("reduces a path typed into the panel to its filename", () => {
    expect(curatedNames({ processNames: ["C:\\Riot Games\\VALORANT.exe"] })).toEqual([
      "VALORANT.exe",
    ]);
  });

  it("drops duplicate spellings so one program is one row", () => {
    expect(curatedNames({ processNames: ["vgc.exe", "VGC.exe", "vgc.exe"] })).toEqual(["vgc.exe"]);
  });

  it("hasCuratedApps is false for a profile that has not been researched", () => {
    expect(hasCuratedApps({ processNames: [] })).toBe(false);
    expect(hasCuratedApps(VALORANT_PROFILE)).toBe(true);
  });
});

describe("resolveGameApps", () => {
  it("finds a game's programs by name and returns their real full paths", () => {
    const resolved = resolveGameApps(VALORANT_PROFILE, RIOT);

    expect(resolved.paths).toEqual([
      "C:\\Riot Games\\VALORANT\\live\\VALORANT.exe",
      "C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe",
      "C:\\Riot Games\\Riot Client\\RiotClientServices.exe",
    ]);
    // Every path it produces must be pushable, or the push fails whole.
    expect(resolved.paths.every(isSelectableAppPath)).toBe(true);
  });

  it("names what it could not find rather than quietly adding a fraction", () => {
    const resolved = resolveGameApps(VALORANT_PROFILE, RIOT);

    // Vanguard runs as a service with no window, so the running-app
    // list does not carry it. That is a real gap and the customer is
    // told which programs it is, not just how many.
    expect(resolved.missing).toEqual(["vgc.exe", "vgm.exe"]);
    expect(resolved.found.map((f) => f.name)).toEqual([
      "VALORANT.exe",
      "VALORANT-Win64-Shipping.exe",
      "RiotClientServices.exe",
    ]);
  });

  it("reads the whole product group, not only the process on display", () => {
    // `VALORANT-Win64-Shipping.exe` is only ever in `paths`. Missing it
    // routes the launcher and leaves the game itself direct, which is
    // indistinguishable from the feature not working.
    const shipping = resolveGameApps({ processNames: ["VALORANT-Win64-Shipping.exe"] }, RIOT);
    expect(shipping.paths).toHaveLength(1);
    expect(shipping.missing).toEqual([]);
  });

  it("matches case-insensitively, because Windows does", () => {
    const resolved = resolveGameApps({ processNames: ["valorant.EXE"] }, RIOT);
    expect(resolved.paths).toEqual(["C:\\Riot Games\\VALORANT\\live\\VALORANT.exe"]);
  });

  it("keeps two installs of the same executable rather than picking one", () => {
    // A live and a PBE install both called League of Legends.exe.
    // Routing one and leaving the other direct is the half-product
    // failure again, one level down.
    const two: RunningApp[] = [
      app("C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe"),
      app("D:\\Riot Games\\PBE\\Game\\League of Legends.exe"),
    ];
    const resolved = resolveGameApps({ processNames: ["League of Legends.exe"] }, two);
    expect(resolved.paths).toHaveLength(2);
    expect(resolved.found[0]?.paths).toHaveLength(2);
  });

  it("never emits a path the wire format would reject", () => {
    // A running-app entry with a junk path must not poison the push.
    const junk: RunningApp[] = [
      app("VALORANT.exe"),
      app("C:\\Program Files\\Riot Vanguard\\vgk.sys"),
    ];
    const resolved = resolveGameApps({ processNames: ["VALORANT.exe", "vgk.sys"] }, junk);
    expect(resolved.paths).toEqual([]);
    expect(resolved.missing).toEqual(["VALORANT.exe", "vgk.sys"]);
  });

  it("returns nothing for a profile with no curated list", () => {
    expect(resolveGameApps({ processNames: [] }, RIOT).paths).toEqual([]);
  });
});

describe("canRouteByDestination", () => {
  /** The rule from the schema, restated here because this is the only
   * place a client could break it: a partial prefix list splits a
   * game's simultaneous connections across two source addresses, which
   * is the account-sharing signature. Refused, never approximated. */
  it("refuses a prefix list the server has not called complete", () => {
    expect(
      canRouteByDestination({ destinationCidrs: ["104.160.128.0/19"], prefixComplete: false }),
    ).toBe(false);
  });

  it("refuses an empty list even when it is called complete", () => {
    expect(canRouteByDestination({ destinationCidrs: [], prefixComplete: true })).toBe(false);
  });

  it("refuses when the server never sent the flag at all", () => {
    // An older server omits both. Absent must not read as permission.
    expect(canRouteByDestination({})).toBe(false);
    expect(canRouteByDestination({ destinationCidrs: ["104.160.128.0/19"] })).toBe(false);
  });

  it("allows only a complete, non-empty list", () => {
    expect(
      canRouteByDestination({ destinationCidrs: ["137.221.64.0/24"], prefixComplete: true }),
    ).toBe(true);
  });
});

describe("scopesForGame", () => {
  const PATHS = [String.raw`C:\Games\game.exe`, String.raw`C:\Games\launcher.exe`];

  /** The same rule as above, at the point where it actually decides
   * what goes on the wire. `canRouteByDestination` being right is worth
   * nothing if the one caller forgets to ask it, and that caller used
   * to be a branch inside a React component where no test could see it. */
  it("sends no scope for an incomplete prefix list", () => {
    // The common case, and the case every seeded profile is in today.
    // No scope means the game's programs are carried in full, exactly
    // as they were before destination scoping existed.
    expect(
      scopesForGame({ destinationCidrs: ["104.160.128.0/19"], prefixComplete: false }, PATHS),
    ).toEqual([]);
  });

  it("sends no scope when the server said nothing about completeness", () => {
    expect(scopesForGame({ destinationCidrs: ["104.160.128.0/19"] }, PATHS)).toEqual([]);
    expect(scopesForGame({}, PATHS)).toEqual([]);
  });

  it("sends no scope for an empty list called complete", () => {
    expect(scopesForGame({ destinationCidrs: [], prefixComplete: true }, PATHS)).toEqual([]);
  });

  it("narrows every program of the game when the list is complete", () => {
    // All of them, not just the executable that happens to be first. A
    // launcher left carrying everything while the game is scoped is
    // the same product talking from two addresses, which is the thing
    // the rule exists to stop.
    const destinations = ["137.221.64.0/24", "137.221.104.0/22"];
    expect(scopesForGame({ destinationCidrs: destinations, prefixComplete: true }, PATHS)).toEqual([
      { app: PATHS[0], destinations },
      { app: PATHS[1], destinations },
    ]);
  });

  it("has nothing to narrow when no program was resolved", () => {
    expect(
      scopesForGame({ destinationCidrs: ["137.221.64.0/24"], prefixComplete: true }, []),
    ).toEqual([]);
  });
});

describe("rankGames", () => {
  const games = [
    { displayName: "Counter-Strike 2", publisher: "Valve" },
    { displayName: "Dota 2", publisher: "Valve" },
    { displayName: "Docs and Screenshots", publisher: "Nobody" },
    { displayName: "Apex Legends", publisher: "Electronic Arts" },
    { displayName: "Dead by Daylight", publisher: "Behaviour Interactive" },
    { displayName: "Among Us", publisher: "Innersloth" },
  ];

  it("returns the catalogue untouched for an empty query", () => {
    expect(rankGames(games, "").map((g) => g.displayName)).toEqual(
      games.map((g) => g.displayName),
    );
    expect(rankGames(games, "   ").map((g) => g.displayName)).toEqual(
      games.map((g) => g.displayName),
    );
  });

  it("puts a name that starts with the query first", () => {
    // The whole reason this is ranked rather than filtered: "do" appears in
    // "Dota 2" and in "Docs and Screenshots", and a plain filter would order
    // them by accident of catalogue position.
    expect(rankGames(games, "dota")[0].displayName).toBe("Dota 2");
  });

  it("matches a word inside the name ahead of a bare substring", () => {
    // "strike" is the second word of Counter-Strike, not its start.
    expect(rankGames(games, "strike")[0].displayName).toBe("Counter-Strike 2");
    expect(rankGames(games, "legends")[0].displayName).toBe("Apex Legends");
  });

  it("ignores punctuation and case", () => {
    expect(rankGames(games, "COUNTER STRIKE")[0].displayName).toBe("Counter-Strike 2");
    expect(rankGames(games, "counter-strike")[0].displayName).toBe("Counter-Strike 2");
  });

  it("finds a game when the spaces are left out", () => {
    // People type names the way they say them, not the way a publisher
    // styles them.
    expect(rankGames(games, "counterstrike")[0].displayName).toBe("Counter-Strike 2");
    expect(rankGames(games, "deadbydaylight")[0].displayName).toBe("Dead by Daylight");
  });

  it("matches on publisher, but below every name match", () => {
    const valve = rankGames(games, "valve").map((g) => g.displayName);
    expect(valve).toEqual(["Counter-Strike 2", "Dota 2"]);
  });

  it("drops entries that match nothing", () => {
    expect(rankGames(games, "zzzznotagame")).toEqual([]);
  });

  it("keeps catalogue order inside one score band", () => {
    // Ties must not reshuffle: the server orders curated entries and online
    // titles first, and that ordering is the product decision.
    const two = rankGames(games, "2").map((g) => g.displayName);
    expect(two).toEqual(["Counter-Strike 2", "Dota 2"]);
  });

  it("stays responsive on a catalogue of realistic size", () => {
    // The picker mounts GAME_PAGE_SIZE rows, but it ranks all of them on
    // every keystroke. Guard the thing that would actually regress: ranking
    // a full catalogue must stay far below a frame.
    const big = Array.from({ length: 2_000 }, (_, i) => ({
      displayName: `Game Number ${i}`,
      publisher: `Publisher ${i % 50}`,
    }));
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) rankGames(big, "game numb");
    expect(performance.now() - started).toBeLessThan(500);
    expect(rankGames(big, "game number 1999")).toHaveLength(1);
  });

  it("mounts a bounded number of rows", () => {
    expect(GAME_PAGE_SIZE).toBeGreaterThan(20);
    expect(GAME_PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});

/** Ranking against the catalogue that actually ships.
 *
 * Separate from the fixture tests above, and worth the awkwardness of
 * reaching across the workspace to read the backend's data files, because
 * the fixtures did not catch the bug that mattered. A six-game fixture
 * cannot tell you that typing "cs" returns nothing at all -- for that you
 * need the real thousand-and-a-half names, with their sequels, their
 * regional duplicates and their punctuation.
 *
 * These assert customer intent rather than exact positions: that the game
 * somebody meant is on the first page they can see, not that it is at any
 * particular index. Pinning indices would fail on every catalogue
 * regeneration and teach the next reader to delete the test. */
describe("rankGames over the shipped catalogue", () => {
  const root = join(__dirname, "../../../backend/prisma/catalogue");
  const read = (file: string) =>
    (JSON.parse(readFileSync(join(root, file), "utf8")) as { games: SearchableGame[] }).games;

  // Curated first, then the Steam tier -- the order `catalogueEntries()`
  // produces, because ties keep the server's order and that ordering is a
  // product decision.
  const catalogue = [...read("curated.json"), ...read("steam-tier.json")];

  it("is the size the picker was built for", () => {
    expect(catalogue.length).toBeGreaterThan(1_400);
  });

  /** Where a title lands among what the picker would actually mount. */
  const rankOf = (query: string, name: string) =>
    rankGames(catalogue, query)
      .slice(0, GAME_PAGE_SIZE)
      .findIndex((g) => g.displayName === name);

  it.each([
    ["cs", "Counter-Strike 2"],
    ["cod", "Call of Duty"],
    ["gta", "Grand Theft Auto V (Legacy)"],
  ])("finds %s -> %s on the first page", (query, name) => {
    // Every one of these returned the game far down the list or, for "cs",
    // not at all, before the acronym band existed.
    expect(rankOf(query, name)).toBeGreaterThanOrEqual(0);
  });

  it("still prefers a name that genuinely starts with the query", () => {
    // CS2D is a real game and a real prefix hit. The acronym band must not
    // demote it to promote the more famous title.
    const top = rankGames(catalogue, "cs").map((g) => g.displayName);
    expect(top[0]).toBe("CS2D");
    expect(top.indexOf("Counter-Strike 2")).toBeLessThan(GAME_PAGE_SIZE);
  });

  it("puts the exact title first when one is typed in full", () => {
    for (const name of ["Counter-Strike 2", "Dota 2", "Fortnite", "Rocket League"]) {
      expect(rankGames(catalogue, name)[0]?.displayName).toBe(name);
    }
  });

  it("does not flood the first page from a single letter", () => {
    // A one-character query is a keystroke on the way to a real one. It must
    // stay cheap and must not be treated as an acronym.
    expect(rankGames(catalogue, "c").length).toBeLessThan(catalogue.length);
  });

  it("ranks the whole catalogue faster than a frame", () => {
    const started = performance.now();
    for (const q of ["c", "co", "cou", "coun", "count"]) rankGames(catalogue, q);
    // Five keystrokes over the real catalogue, generously bounded -- the
    // point is to catch an accidental O(n^2), not to benchmark the machine.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Exit groups
// ---------------------------------------------------------------------------
//
// `docs/design/ban-safety.md` mechanism 4: a game's connections arriving
// from two different source addresses at the same instant is the
// account-sharing signature publishers look for, and it is the one
// mechanism in that document Neoxify could MANUFACTURE rather than
// merely fail to prevent. `prefixComplete` closes the destination-prefix
// route to it. These close the exit-selection route.
//
// The games below are the shipped catalogue's, not invented fixtures:
// `rust` really is `Rust.exe` (the EAC wrapper Steam launches) plus
// `RustClient.exe`, and `RiotClientServices.exe`, `vgc.exe` and
// `vgm.exe` really do belong to both `valorant` and
// `league-of-legends`.

const RUST = {
  slug: "rust",
  displayName: "Rust",
  processNames: ["Rust.exe", "RustClient.exe"],
};
const SOT = {
  slug: "sea-of-thieves",
  displayName: "Sea of Thieves",
  processNames: ["SeaOfThieves.exe", "SoTGame.exe"],
};
const RUST_WRAPPER = String.raw`C:\Steam\common\Rust\Rust.exe`;
const RUST_CLIENT = String.raw`C:\Steam\common\Rust\RustClient.exe`;
const SOT_SHIM = String.raw`C:\Games\SoT\SeaOfThieves.exe`;
const SOT_GAME = String.raw`C:\Games\SoT\SoTGame.exe`;

describe("gameExitGroup", () => {
  it("takes the group straight from the catalogue's own list", () => {
    // The whole design decision in one assertion: a GameProfile already
    // IS the group, so nothing new had to be added to the catalogue for
    // this feature. `processNames` is one game's binaries and the
    // catalogue says so in its own words.
    const group = gameExitGroup(RUST, "germany-1");
    expect(group.slug).toBe("rust");
    expect(group.names).toEqual(["Rust.exe", "RustClient.exe"]);
    expect(group.exit).toBe("germany-1");
  });

  it("defaults to no preference, which is what every game had before", () => {
    expect(gameExitGroup(RUST).exit).toBeNull();
  });
});

describe("exitsForGames", () => {
  it("puts every binary of a resolved game on one exit", () => {
    const { exits, withheld } = exitsForGames(
      [gameExitGroup(RUST, "germany-1")],
      [RUST_WRAPPER, RUST_CLIENT],
    );
    expect(withheld).toEqual([]);
    expect(exits).toEqual([
      { app: RUST_WRAPPER, exit: "germany-1", group: "rust" },
      { app: RUST_CLIENT, exit: "germany-1", group: "rust" },
    ]);
    // One exit across the whole group. Stated as a set rather than
    // read off the rows above, because the property that matters is
    // "one", not "these two rows in this order".
    expect(new Set(exits.map((e) => e.exit)).size).toBe(1);
  });

  it("withholds the exit entirely when only part of a game is selected", () => {
    // THE hard case. Names are resolved against RUNNING processes, so a
    // launcher can be up while the game is not -- which is the ordinary
    // state of a machine at the moment somebody adds a game. Placing
    // `Rust.exe` on Germany and letting `RustClient.exe` start later and
    // go wherever it goes is exactly the two-source-IP split, and it
    // does not need a second exit to happen: the unselected binary is
    // not carried at all, so it leaves from the customer's own address.
    const { exits, withheld } = exitsForGames(
      [gameExitGroup(RUST, "germany-1")],
      [RUST_WRAPPER],
    );
    expect(exits).toEqual([]);
    expect(withheld).toEqual([
      {
        slug: "rust",
        displayName: "Rust",
        reason: "partial",
        missing: ["RustClient.exe"],
      },
    ]);
  });

  it("does not let one partial game cost another game its exit", () => {
    // All-or-nothing is per game. Two games on two exits is the
    // feature, and ban-safety mechanism 5 is the argument for it: a
    // restriction on a shared address hits every customer on it.
    const { exits, withheld } = exitsForGames(
      [gameExitGroup(RUST, "germany-1"), gameExitGroup(SOT, "turkey-1")],
      [RUST_WRAPPER, SOT_SHIM, SOT_GAME],
    );
    expect(withheld.map((w) => w.slug)).toEqual(["rust"]);
    expect(exits).toEqual([
      { app: SOT_SHIM, exit: "turkey-1", group: "sea-of-thieves" },
      { app: SOT_GAME, exit: "turkey-1", group: "sea-of-thieves" },
    ]);
  });

  it("withholds both games when they share a binary and disagree", () => {
    // Real data, not a hypothetical: `RiotClientServices.exe`,
    // `vgc.exe` and `vgm.exe` are in both Riot profiles, and 61
    // executable names in the shipped catalogue appear in more than one
    // entry. Honouring VALORANT here would place the Riot client away
    // from League, which is the same split with a second account
    // attached -- so neither is honoured.
    const riotClient = String.raw`C:\Riot Games\Riot Client\RiotClientServices.exe`;
    const valorant = String.raw`C:\Riot Games\VALORANT\live\VALORANT.exe`;
    const league = String.raw`C:\Riot Games\League of Legends\LeagueClient.exe`;
    const { exits, withheld } = exitsForGames(
      [
        gameExitGroup(
          { slug: "valorant", displayName: "VALORANT", processNames: ["VALORANT.exe", "RiotClientServices.exe"] },
          "germany-1",
        ),
        gameExitGroup(
          { slug: "league-of-legends", displayName: "League of Legends", processNames: ["LeagueClient.exe", "RiotClientServices.exe"] },
          "turkey-1",
        ),
      ],
      [riotClient, valorant, league],
    );
    expect(exits).toEqual([]);
    expect(withheld.map((w) => w.slug).sort()).toEqual(["league-of-legends", "valorant"]);
    const first = withheld[0];
    expect(first.reason).toBe("conflict");
    if (first.reason === "conflict") {
      expect(first.withGames).toEqual(["League of Legends"]);
      expect(first.sharedApps).toEqual([riotClient]);
    }
  });

  it("places both games when they share a binary and agree", () => {
    // There is no split when there is nothing to split, and the shared
    // binary is named once rather than twice.
    const riotClient = String.raw`C:\Riot Games\Riot Client\RiotClientServices.exe`;
    const valorant = String.raw`C:\Riot Games\VALORANT\live\VALORANT.exe`;
    const league = String.raw`C:\Riot Games\League of Legends\LeagueClient.exe`;
    const { exits, withheld } = exitsForGames(
      [
        gameExitGroup(
          { slug: "valorant", displayName: "VALORANT", processNames: ["VALORANT.exe", "RiotClientServices.exe"] },
          "germany-1",
        ),
        gameExitGroup(
          { slug: "league-of-legends", displayName: "League of Legends", processNames: ["LeagueClient.exe", "RiotClientServices.exe"] },
          "germany-1",
        ),
      ],
      [riotClient, valorant, league],
    );
    expect(withheld).toEqual([]);
    expect(exits.filter((e) => e.app === riotClient)).toHaveLength(1);
    expect(exits.map((e) => e.app).sort()).toEqual([valorant, league, riotClient].sort());
    expect(new Set(exits.map((e) => e.exit)).size).toBe(1);
  });

  it("emits nothing for a game with no exit chosen", () => {
    const { exits, withheld } = exitsForGames(
      [gameExitGroup(RUST)],
      [RUST_WRAPPER, RUST_CLIENT],
    );
    expect(exits).toEqual([]);
    // Not withheld either: nothing was asked for, so there is nothing
    // to report not having got.
    expect(withheld).toEqual([]);
  });

  it("never gives an exit to an app that belongs to no game", () => {
    // Added by hand with Browse. Which game it is cannot be known, so
    // no group can be whole around it and no preference can attach.
    const byHand = String.raw`C:\Tools\thing.exe`;
    const { exits } = exitsForGames(
      [gameExitGroup(RUST, "germany-1")],
      [RUST_WRAPPER, RUST_CLIENT, byHand],
    );
    expect(exits.map((e) => e.app)).not.toContain(byHand);
  });

  it("carries every entry's group, so the service can hold the same rule", () => {
    // The group is what lets `SplitTunnelConfig::validate` refuse a
    // config that splits a game and lets `Selection::with_exits` drop a
    // group it cannot see whole. An entry without one claims nothing
    // about a game, and this client must never produce one.
    const { exits } = exitsForGames(
      [gameExitGroup(RUST, "germany-1"), gameExitGroup(SOT, "turkey-1")],
      [RUST_WRAPPER, RUST_CLIENT, SOT_SHIM, SOT_GAME],
    );
    expect(exits).toHaveLength(4);
    expect(exits.every((e) => typeof e.group === "string" && e.group.length > 0)).toBe(true);
  });

  it("matches case-insensitively, because Windows paths are", () => {
    const { exits, withheld } = exitsForGames(
      [gameExitGroup(RUST, "germany-1")],
      [String.raw`c:\steam\common\rust\RUST.EXE`, String.raw`c:\steam\common\rust\rustclient.exe`],
    );
    expect(withheld).toEqual([]);
    expect(exits).toHaveLength(2);
  });
});

describe("groupMembers / unresolvedNames / isWholeGroup", () => {
  it("derives completeness from the live selection, not from a stored flag", () => {
    // Why `GameExitGroup` stores the catalogue's NAMES rather than the
    // paths that resolved when the game was added: a customer who
    // starts the missing binary and adds the game again gets a whole
    // group with no stale record to correct, and a customer who removes
    // one binary by hand loses the preference for the whole game rather
    // than keeping a record claiming it is whole.
    const group = gameExitGroup(RUST, "germany-1");
    expect(isWholeGroup(group, [RUST_WRAPPER])).toBe(false);
    expect(unresolvedNames(group, [RUST_WRAPPER])).toEqual(["RustClient.exe"]);
    expect(isWholeGroup(group, [RUST_WRAPPER, RUST_CLIENT])).toBe(true);
    expect(unresolvedNames(group, [RUST_WRAPPER, RUST_CLIENT])).toEqual([]);
    expect(groupMembers(group, [RUST_WRAPPER, RUST_CLIENT, SOT_GAME])).toEqual([
      RUST_WRAPPER,
      RUST_CLIENT,
    ]);
  });
});

describe("the shipped catalogue's multi-binary games", () => {
  // The group rule is only worth anything if the catalogue actually
  // states the groups. These are the games whose launcher and client
  // are separate binaries with first-party evidence behind the pairing,
  // and a future edit that drops half of one would silently return that
  // game to being splittable.
  const catalogue = JSON.parse(
    readFileSync(join(__dirname, "../../../backend/prisma/catalogue/curated.json"), "utf8"),
  ) as { games: { slug: string; processNames: string[] }[] };
  const bySlug = new Map(catalogue.games.map((g) => [g.slug, g.processNames]));

  it.each([
    ["rust", ["Rust.exe", "RustClient.exe"]],
    ["sea-of-thieves", ["SeaOfThieves.exe", "SoTGame.exe"]],
    ["dead-by-daylight", ["DeadByDaylight.exe", "DeadByDaylight-Win64-Shipping.exe"]],
    ["ark-survival-evolved", ["ShooterGame_BE.exe", "ShooterGame.exe"]],
    ["ark-survival-ascended", ["ArkAscended_BE.exe", "ArkAscended.exe"]],
    ["lost-ark", ["LOSTARK.exe", "Launch_Game.exe", "LostArkLauncher.exe"]],
  ])("keeps %s's binaries in one row", (slug, expected) => {
    const names = bySlug.get(slug);
    expect(names, `${slug} is missing from the curated catalogue`).toBeDefined();
    for (const name of expected) expect(names).toContain(name);
  });

  it("groups a whole multi-binary game the client can then place", () => {
    // End to end against the shipped data rather than a fixture: take
    // the catalogue row, resolve it against processes named exactly as
    // it names them, and require one exit across the lot.
    const names = bySlug.get("dead-by-daylight")!;
    const paths = names.map((n) => [String.raw`C:\Games\DBD`, n].join("\\"));
    const group = gameExitGroup(
      { slug: "dead-by-daylight", displayName: "Dead by Daylight", processNames: names },
      "germany-1",
    );
    const { exits, withheld } = exitsForGames([group], paths);
    expect(withheld).toEqual([]);
    expect(exits).toHaveLength(names.length);
    expect(new Set(exits.map((e) => e.exit))).toEqual(new Set(["germany-1"]));
  });
});

/** The first test in this repo tied to a real install rather than a fixture.
 *
 * Everything above this point invents its own `RunningApp`s, which means
 * it proves the resolver is self-consistent and nothing about whether the
 * catalogue's names are TRUE. The catalogue header says so outright: "Not
 * one of these entries has been tested against the game actually
 * running."
 *
 * On 2026-08-26 one of them finally was. Steam was installed on the
 * `Neoxify-Test2` rig from Valve's own signed installer, launched, and
 * allowed to reach its login window; the list below is verbatim what the
 * SERVICE reported over `listRunningApps` -- the same call the picker
 * makes, answered by the elevated side that can actually read a process's
 * image path. The Steam rows are the interesting ones and the rest are
 * kept exactly as captured, because a resolver that only sees the answer
 * is not being asked a real question.
 *
 * What this pins, and why each part earns its place:
 *
 * * `steamwebhelper.exe` resolves, at a path nobody would have guessed
 *   (`bin\cef\cef.win64\`). Its catalogue note calls it "the weakest name
 *   here" -- Valve names the process in client update notes but never
 *   prints the string with a `.exe` suffix, and it is in no enumerable
 *   package. It is also where most of the client's traffic goes. It was
 *   right.
 * * `SteamService.exe` resolves from a DIFFERENT install root
 *   (`Common Files\Steam`), which is the case a basename match has to get
 *   right and a path guess would not.
 * * `steamchina.exe` and `streaming_client.exe` resolve to nothing, and
 *   that is correct rather than a defect: one is the Chinese client and
 *   the other only exists during Remote Play. They must land in `missing`
 *   and must not quietly vanish -- a name reported as not-found is the
 *   whole reason listing two plausible spellings is safe.
 */
describe("the steam-client row against a real Steam install (rig, 2026-08-26)", () => {
  // Verbatim from the service's own listRunningApps on the rig.
  const OBSERVED: RunningApp[] = [
    app("C:\\Program Files (x86)\\Steam\\steam.exe", { name: "Steam" }),
    app("C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe", {
      name: "Steam Client Service",
    }),
    app("C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win64\\steamwebhelper.exe", {
      name: "Steam Client WebHelper",
    }),
    app("C:\\Windows\\explorer.exe", { name: "Windows Explorer" }),
    app("C:\\Users\\neoxify\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe", {
      name: "Microsoft OneDrive",
    }),
    app(
      "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.26070.9-0\\MsMpEng.exe",
      { name: "Antimalware Service Executable" },
    ),
  ];

  /** The shipped row, read from the catalogue rather than retyped, so
   * that editing `curated.json` and forgetting this test fails here. */
  const steamRow = (() => {
    const raw = readFileSync(
      join(__dirname, "../../../backend/prisma/catalogue/curated.json"),
      "utf8",
    ) as string;
    const games = (JSON.parse(raw) as { games: { slug: string; processNames: string[] }[] }).games;
    const row = games.find((g) => g.slug === "steam-client");
    if (!row) throw new Error("curated.json no longer has a steam-client row");
    return row;
  })();

  it("still names the three executables that were observed running", () => {
    // Guards the direction that matters: dropping one of these from the
    // catalogue would silently stop routing part of a running Steam.
    const lower = steamRow.processNames.map((n) => n.toLowerCase());
    expect(lower).toContain("steam.exe");
    expect(lower).toContain("steamservice.exe");
    expect(lower).toContain("steamwebhelper.exe");
  });

  it("resolves each one to the real path it was observed at", () => {
    const resolved = resolveGameApps(steamRow, OBSERVED);
    expect(resolved.paths).toEqual(
      expect.arrayContaining([
        "C:\\Program Files (x86)\\Steam\\steam.exe",
        "C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe",
        "C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win64\\steamwebhelper.exe",
      ]),
    );
    expect(resolved.paths).toHaveLength(3);
  });

  it("reports the two that legitimately were not running, by name", () => {
    const resolved = resolveGameApps(steamRow, OBSERVED);
    const missing = resolved.missing.map((n) => n.toLowerCase());
    expect(missing).toContain("steamchina.exe");
    expect(missing).toContain("streaming_client.exe");
  });

  it("routes nothing that is not Steam", () => {
    // The half of Custom mode that costs a customer their privacy rather
    // than their game: selecting Steam must not put Defender, OneDrive or
    // Explorer on the tunnel.
    const resolved = resolveGameApps(steamRow, OBSERVED);
    for (const path of resolved.paths) {
      expect(path.toLowerCase()).toContain("steam");
    }
  });

  it("hands the split tunnel only paths its wire format accepts", () => {
    // The real reason this matters: one rejected path fails the whole
    // SetSplitTunnel request, taking the customer's existing selection
    // with it. Note `Program Files (x86)` has parentheses and spaces.
    for (const path of resolveGameApps(steamRow, OBSERVED).paths) {
      expect(isSelectableAppPath(path)).toBe(true);
    }
  });
});

describe("the three-game ceiling", () => {
  function game(slug: string, exit: string | null, names: string[]): GameExitGroup {
    return { slug, displayName: slug.toUpperCase(), names, exit };
  }

  const pathFor = (slug: string, name: string) => `C:\\Games\\${slug}\\${name}`;

  function placed(entries: [string, string, string[]][]) {
    const groups = entries.map(([slug, exit, names]) => game(slug, exit, names));
    const apps = entries.flatMap(([slug, , names]) => names.map((n) => pathFor(slug, n)));
    return { groups, apps };
  }

  it("carries three games on three exits", () => {
    const { groups, apps } = placed([
      ["a", "germany-1", ["a.exe"]],
      ["b", "turkey-1", ["b.exe"]],
      ["c", "finland-1", ["c.exe"]],
    ]);
    const { exits, withheld } = exitsForGames(groups, apps);
    expect(withheld).toEqual([]);
    expect(new Set(exits.map((e) => e.exit))).toEqual(
      new Set(["germany-1", "turkey-1", "finland-1"]),
    );
  });

  // The ceiling counts exits, not binaries. A game with a launcher, a
  // client and an anti-cheat service must not eat three of the three.
  it("counts a multi-binary game as one exit", () => {
    const { groups, apps } = placed([
      ["a", "germany-1", ["a-launcher.exe", "a-client.exe", "a-anticheat.exe"]],
      ["b", "turkey-1", ["b-launcher.exe", "b-client.exe"]],
      ["c", "finland-1", ["c-client.exe"]],
    ]);
    const { exits, withheld } = exitsForGames(groups, apps);
    expect(withheld).toEqual([]);
    expect(exits).toHaveLength(6);
  });

  // And it counts *distinct* exits, so four games sharing three exits
  // is three concurrent exits.
  it("lets four games share three exits", () => {
    const { groups, apps } = placed([
      ["a", "germany-1", ["a.exe"]],
      ["b", "turkey-1", ["b.exe"]],
      ["c", "finland-1", ["c.exe"]],
      ["d", "germany-1", ["d.exe"]],
    ]);
    const { exits, withheld } = exitsForGames(groups, apps);
    expect(withheld).toEqual([]);
    expect(exits).toHaveLength(4);
  });

  // Over the ceiling, every preference is withheld rather than the
  // fourth one. Trimming would mean choosing which games keep their
  // exit on the basis of the order the customer added them in, which
  // they were never told was load-bearing -- and the card would then
  // show one game placed and another not with nothing explaining which
  // rule chose. See `exitsForGames` rule 4.
  it("withholds every preference when a fourth exit is chosen", () => {
    const { groups, apps } = placed([
      ["a", "germany-1", ["a.exe"]],
      ["b", "turkey-1", ["b.exe"]],
      ["c", "finland-1", ["c.exe"]],
      ["d", "poland-1", ["d.exe"]],
    ]);
    const { exits, withheld } = exitsForGames(groups, apps);
    expect(exits).toEqual([]);
    expect(withheld).toHaveLength(4);
    for (const held of withheld) {
      expect(held.reason).toBe("overCeiling");
      if (held.reason === "overCeiling") expect(held.chosen).toBe(4);
    }
  });

  // A group already withheld for a conflict is not asking for an exit
  // any more, so it must not consume one of the three -- and it must
  // still be reported under the rule that actually applies to it, or
  // the customer is pointed at the wrong fix.
  it("does not let a conflicted game use up one of the three", () => {
    const shared = "C:\\Games\\shared\\anticheat.exe";
    const groups: GameExitGroup[] = [
      { slug: "x", displayName: "X", names: ["anticheat.exe"], exit: "poland-1" },
      { slug: "y", displayName: "Y", names: ["anticheat.exe"], exit: "spain-1" },
      { slug: "a", displayName: "A", names: ["a.exe"], exit: "germany-1" },
      { slug: "b", displayName: "B", names: ["b.exe"], exit: "turkey-1" },
      { slug: "c", displayName: "C", names: ["c.exe"], exit: "finland-1" },
    ];
    const apps = [
      shared,
      "C:\\Games\\a\\a.exe",
      "C:\\Games\\b\\b.exe",
      "C:\\Games\\c\\c.exe",
    ];
    const { exits, withheld } = exitsForGames(groups, apps);
    // Five exits were named, but two of them belong to a pair that
    // conflicts, so only three are actually being asked for.
    expect(new Set(exits.map((e) => e.exit))).toEqual(
      new Set(["germany-1", "turkey-1", "finland-1"]),
    );
    expect(withheld.map((h) => h.reason).sort()).toEqual(["conflict", "conflict"]);
  });

  // The picker's own question, and the reason the ceiling is almost
  // never met as an error: it is asked before an exit is offered.
  it("says whether another game can be placed, before it is", () => {
    const two = [
      { slug: "a", displayName: "A", names: ["a.exe"], exit: "germany-1" },
      { slug: "b", displayName: "B", names: ["b.exe"], exit: "turkey-1" },
    ];
    expect(canPlaceAnotherGame(two)).toBe(true);

    const three = [...two, { slug: "c", displayName: "C", names: ["c.exe"], exit: "finland-1" }];
    expect(canPlaceAnotherGame(three)).toBe(false);
    // But an exit already in use costs nothing, so it stays offerable.
    expect(canPlaceAnotherGame(three, "germany-1")).toBe(true);
    expect(canPlaceAnotherGame(three, "poland-1")).toBe(false);
  });

  it("does not count a game with no exit against the ceiling", () => {
    const groups = [
      { slug: "a", displayName: "A", names: ["a.exe"], exit: "germany-1" },
      { slug: "b", displayName: "B", names: ["b.exe"], exit: null },
      { slug: "c", displayName: "C", names: ["c.exe"], exit: null },
    ];
    expect(canPlaceAnotherGame(groups)).toBe(true);
  });

  // The two constants sit either side of a wire that carries no schema.
  // A mismatch surfaces as `SetSplitTunnel` being refused for a
  // selection the picker allowed, which is the shape of bug nothing
  // else here would catch.
  it("keeps the ceiling at the number the service enforces", () => {
    expect(MAX_CONCURRENT_EXITS).toBe(3);
  });
});
