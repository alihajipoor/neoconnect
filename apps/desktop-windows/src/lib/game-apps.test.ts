import { describe, expect, it } from "vitest";
import {
  canRouteByDestination,
  scopesForGame,
  curatedNames,
  hasCuratedApps,
  isSelectableAppPath,
  resolveGameApps,
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

const VALORANT_PROFILE = {
  processNames: [
    "VALORANT.exe",
    "VALORANT-Win64-Shipping.exe",
    "UnrealCEFSubProcess.exe",
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
    expect(resolved.missing).toEqual(["UnrealCEFSubProcess.exe", "vgc.exe", "vgm.exe"]);
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
