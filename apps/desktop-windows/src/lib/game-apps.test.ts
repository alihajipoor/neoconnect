import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canRouteByDestination,
  scopesForGame,
  curatedNames,
  hasCuratedApps,
  isSelectableAppPath,
  resolveGameApps,
  GAME_PAGE_SIZE,
  rankGames,
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
