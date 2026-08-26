import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESERVED_SLUGS,
  catalogueEntries,
  toSeedRow,
  validateCatalogue,
  validateProcessNames,
  type CatalogueEntry,
} from "../../../prisma/catalogue";

/** Guards on the shipped game catalogue.
 *
 * This runs in CI on every push, which is the point: the catalogue is data,
 * and data is edited by people who are not reading this module. Most of these
 * assertions describe a mistake that would be invisible everywhere else --
 * a process name with a path in it, or a duplicate slug, produces a row that
 * looks fine in the panel, serialises fine over the API, and silently routes
 * nothing on the customer's machine.
 *
 * The suite deliberately asserts against the REAL catalogue as well as
 * against fixtures. A validator that only ever sees fixtures proves the
 * validator works; running it over the shipped data proves the shipped data
 * is good, and that is the thing that can regress. */
describe("game catalogue", () => {
  const entries = catalogueEntries();

  describe("the shipped catalogue", () => {
    it("passes validation with no problems", () => {
      // Reported as the actual list rather than a count, because when a
      // regenerated tier breaks it breaks systematically and the first
      // twenty lines tell you how.
      expect(validateCatalogue(entries)).toEqual([]);
    });

    it("is not empty", () => {
      expect(entries.length).toBeGreaterThan(100);
    });

    it("never claims a complete prefix list", () => {
      // The rule with teeth. An incomplete prefix list marked whole splits a
      // game's connections across two source addresses at once, which is the
      // account-sharing signature that gets customers penalised. Asserted on
      // the seed rows too, not just the entries, because `toSeedRow` is what
      // actually reaches the database.
      for (const entry of entries as unknown as Record<string, unknown>[]) {
        expect(entry.prefixComplete).toBeUndefined();
      }
      for (const row of entries.map((e, i) => toSeedRow(e, i))) {
        expect(row.prefixComplete).toBe(false);
        expect(row.destinationCidrs).toEqual([]);
      }
    });

    it("leaves DNS-mode fields alone", () => {
      // A hostname here would be a claim that the node's SNI proxy should
      // forward it, and the standard for that in this repo is a reachability
      // measurement from Iranian networks. No bulk entry has one.
      for (const row of entries.map((e, i) => toSeedRow(e, i))) {
        expect(row.hostnames).toEqual([]);
        expect(row.excludeHostnames).toEqual([]);
        expect(row.canaryHostname).toBeNull();
      }
    });

    it("does not displace the hand-written profiles", () => {
      const slugs = new Set(entries.map((e) => e.slug));
      for (const reserved of RESERVED_SLUGS) {
        expect(slugs.has(reserved)).toBe(false);
      }
    });

    it("gives every entry at least one executable", () => {
      const empty = entries.filter((e) => e.processNames.length === 0);
      expect(empty.map((e) => e.slug)).toEqual([]);
    });

    it("assigns distinct sort orders", () => {
      const rows = entries.map((e, i) => toSeedRow(e, 1000 + i));
      expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(rows.length);
    });
  });

  describe("validateCatalogue", () => {
    const ok = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
      slug: "example-game",
      displayName: "Example Game",
      processNames: ["Example.exe"],
      ...over,
    });

    const problemsFor = (entry: unknown) =>
      validateCatalogue([entry as CatalogueEntry]).map((p) => p.problem);

    it("accepts a well-formed entry", () => {
      expect(validateCatalogue([ok()])).toEqual([]);
    });

    it("rejects duplicate slugs", () => {
      const problems = validateCatalogue([ok(), ok()]);
      expect(problems).toHaveLength(1);
      expect(problems[0].problem).toMatch(/duplicate slug/);
    });

    it("rejects empty processNames", () => {
      expect(problemsFor(ok({ processNames: [] }))).toEqual([
        expect.stringMatching(/processNames is empty/),
      ]);
    });

    it("rejects a path where a bare filename belongs", () => {
      // Both separators, because the client takes the basename of whatever
      // it receives -- it would turn either of these into `Example.exe` and
      // hide the mistake rather than report it.
      expect(problemsFor(ok({ processNames: ["C:\\Games\\Example.exe"] }))).toEqual([
        expect.stringMatching(/is a path, not a bare filename/),
      ]);
      expect(problemsFor(ok({ processNames: ["Games/Example.exe"] }))).toEqual([
        expect.stringMatching(/is a path, not a bare filename/),
      ]);
    });

    it("rejects a name that is not an .exe", () => {
      expect(problemsFor(ok({ processNames: ["Example"] }))).toEqual([
        expect.stringMatching(/does not end in \.exe/),
      ]);
      // A kernel driver is the live case: VALORANT's `vgk.sys` is not a
      // process and nothing in the split tunnel can ever match it.
      expect(problemsFor(ok({ processNames: ["vgk.sys"] }))).toEqual([
        expect.stringMatching(/does not end in \.exe/),
      ]);
    });

    it("rejects a generic name shared with software that is not the game", () => {
      // The rule that exists because of a specific silent failure: the client
      // resolves a name against every running process and routes whatever it
      // finds. Catalogue Minecraft under javaw.exe and a customer who picks
      // Minecraft puts their employer's Java VPN client on the tunnel, with
      // the UI reporting success.
      for (const name of ["javaw.exe", "launcher.exe", "Update.exe", "Client.exe"]) {
        expect(problemsFor(ok({ processNames: [name] }))).toEqual([
          expect.stringMatching(/generic name shared with/),
        ]);
      }
    });

    it("rejects an un-renamed Unreal shipping binary", () => {
      // By pattern rather than by list, because the prefix set is open-ended.
      expect(problemsFor(ok({ processNames: ["Client-Win64-Shipping.exe"] }))).toEqual([
        expect.stringMatching(/generic name shared with/),
      ]);
      // But a renamed one is exactly what we want, and must still pass.
      expect(validateCatalogue([ok({ processNames: ["VALORANT-Win64-Shipping.exe"] })])).toEqual(
        [],
      );
    });

    it("accepts a filename containing a space", () => {
      // `Among Us.exe` and `League of Legends.exe` are real. A validator that
      // rejected a space would drop them, and it would pass review.
      expect(
        validateCatalogue([ok({ processNames: ["Among Us.exe", "Heroes of the Storm.exe"] })]),
      ).toEqual([]);
    });

    it("rejects prefixComplete: true", () => {
      expect(problemsFor({ ...ok(), prefixComplete: true })).toEqual([
        expect.stringMatching(/prefixComplete is true/),
      ]);
    });

    it("rejects a non-empty destinationCidrs", () => {
      expect(problemsFor({ ...ok(), destinationCidrs: ["1.2.3.0/24"] })).toEqual([
        expect.stringMatching(/must not route by destination/),
      ]);
    });

    it("rejects a reserved slug", () => {
      expect(problemsFor(ok({ slug: "valorant" }))).toEqual([
        expect.stringMatching(/reserved/),
      ]);
    });

    it("rejects a slug that is not lowercase-kebab", () => {
      expect(problemsFor(ok({ slug: "Example Game" }))).toEqual([
        expect.stringMatching(/not lowercase-kebab/),
      ]);
    });

    it("rejects an empty displayName", () => {
      expect(problemsFor(ok({ displayName: "   " }))).toEqual([
        expect.stringMatching(/displayName is missing or empty/),
      ]);
    });

    it("rejects a duplicated executable within one entry", () => {
      // Case-insensitively, because Windows is: two spellings of one file
      // would render as two identical rows in the customer's face.
      expect(problemsFor(ok({ processNames: ["Example.exe", "example.EXE"] }))).toEqual([
        expect.stringMatching(/twice/),
      ]);
    });

    it("reports every problem rather than stopping at the first", () => {
      const problems = validateCatalogue([
        ok({ slug: "bad slug", processNames: [] }),
        ok({ slug: "another", processNames: ["nope"] }),
      ]);
      expect(problems.length).toBeGreaterThanOrEqual(3);
    });
  });

  /** The two names that shipped anyway.
   *
   * `Agent.exe` and `UnrealCEFSubProcess.exe` were in the hand-written `wow`
   * and `valorant` rows, which predate `generic-names.json` and were never
   * run through it. They were removed on 2026-08-25 and added to the
   * denylist. This suite exists so that neither can return -- by hand, by a
   * regenerated tier, or by somebody path-qualifying one in the belief that
   * a full path makes it specific. It does not: the client strips a path
   * back to its basename before matching.
   *
   * `Agent.exe` is the one that mattered. It is the Blizzard Update Agent
   * and it is also the name a great deal of enterprise monitoring, backup
   * and MDM software runs under, so a customer picking World of Warcraft on
   * a work laptop would have put their employer's agent on the tunnel. */
  describe("the two generic names that predated the denylist", () => {
    const problemsFor = (name: string) => validateProcessNames([name]);

    it.each([
      ["Agent.exe", "wow"],
      ["UnrealCEFSubProcess.exe", "valorant"],
    ])("rejects %s, which used to ship in the %s row", (name) => {
      expect(problemsFor(name)).toEqual([expect.stringMatching(/generic name shared with/)]);
    });

    it("rejects them however they are cased", () => {
      for (const name of ["agent.exe", "AGENT.EXE", "unrealcefsubprocess.exe"]) {
        expect(problemsFor(name)).toEqual([expect.stringMatching(/generic name shared with/)]);
      }
    });

    it("does not let a full path smuggle one back in", () => {
      // Rejected as a path before the denylist is even consulted, which is
      // the right order: the client strips it to `agent.exe` anyway, so a
      // full path is not a way to make a generic name specific.
      expect(problemsFor(String.raw`C:\Battle.net\Agent.exe`)).toEqual([
        expect.stringMatching(/is a path, not a bare filename/),
      ]);
    });

    it("would reject them inside a whole entry too, not just on their own", () => {
      const problems = validateCatalogue([
        {
          slug: "example-game",
          displayName: "Example Game",
          processNames: ["Example.exe", "Agent.exe"],
        } as CatalogueEntry,
      ]);
      expect(problems).toEqual([
        { slug: "example-game", problem: expect.stringMatching(/generic name shared with/) },
      ]);
    });

    it("no longer appears anywhere in the shipped catalogue", () => {
      const shipped = entries.flatMap((e) => e.processNames.map((n) => n.toLowerCase()));
      expect(shipped).not.toContain("agent.exe");
      expect(shipped).not.toContain("unrealcefsubprocess.exe");
    });

    it("is gone from the hand-written rows too", () => {
      // Read as source rather than by seeding, because seeding needs a
      // database. The point is only that the strings are not in the file.
      const source = readFileSync(join(__dirname, "../../../prisma/game-profiles.ts"), "utf8");
      // Both names still appear in that file's prose, explaining why they
      // were removed -- so match the quoted form the seed array would use,
      // which is the only form that would actually ship.
      expect(source).not.toContain('"Agent.exe"');
      expect(source).not.toContain('"UnrealCEFSubProcess.exe"');
    });
  });
});
