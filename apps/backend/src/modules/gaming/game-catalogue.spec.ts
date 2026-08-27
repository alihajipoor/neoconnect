import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESERVED_SLUGS,
  catalogueEntries,
  entangledSlugs,
  generatedEntries,
  sharedProcessNames,
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

/** A catalogue row is the group for per-game exit selection.
 *
 * `docs/design/ban-safety.md` mechanism 4: one game's connections arriving
 * from two source addresses at the same instant is the account-sharing
 * signature publishers look for, and it is the only mechanism in that
 * document Neoxify could MANUFACTURE rather than merely fail to prevent.
 * Per-game exit preferences are keyed on the executable, so what stops a
 * game's launcher and its client landing on two exits is that they are in
 * one row and the client places a row whole or not at all.
 *
 * That makes these rows load-bearing in a way they were not before. A future
 * edit that drops `RustClient.exe` from the Rust entry does not merely lose
 * coverage -- it silently returns Rust to being splittable, because the
 * client would then believe a group containing only the EAC wrapper is
 * complete. Nothing else in this repo would go red.
 *
 * The pairs below are the ones with first-party evidence behind them,
 * recorded in each entry's own `source` and `notes`. */
describe("exit groups", () => {
  const bulk = catalogueEntries();

  /** The three hand-written rows, read out of the seed's source.
   *
   * They have to be here. `catalogueEntries()` deliberately excludes the
   * reserved slugs and `catalogue/index.ts` deliberately has no import back
   * into the seed, so a collision analysis over the bulk tier alone cannot
   * see the sharpest real case there is: `RiotClientServices.exe`, `vgc.exe`
   * and `vgm.exe` are in both VALORANT and League of Legends, and both of
   * those live in `game-profiles.ts`. A customer's client receives all 1,483
   * rows in one payload and has no such split, so analysing only the bulk
   * tier would be measuring a set nothing actually uses.
   *
   * Parsed from source rather than seeded because seeding needs a database,
   * and the assertion is about what the file says. */
  function reservedProfiles(): CatalogueEntry[] {
    const source = readFileSync(join(__dirname, "../../../prisma/game-profiles.ts"), "utf8");
    const out: CatalogueEntry[] = [];
    for (const slug of RESERVED_SLUGS) {
      const at = source.indexOf(`slug: "${slug}"`);
      if (at < 0) throw new Error(`${slug} is no longer in game-profiles.ts`);
      const names = source.slice(at).match(/processNames:\s*\[([^\]]*)\]/);
      if (!names) throw new Error(`${slug} has no processNames in game-profiles.ts`);
      out.push({
        slug,
        displayName: slug,
        processNames: [...names[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
      });
    }
    return out;
  }

  const entries = [...bulk, ...reservedProfiles()];
  const bySlug = new Map(entries.map((e) => [e.slug, e.processNames.map((n) => n.toLowerCase())]));

  it("the seed parser found the hand-written rows it claims to", () => {
    // If this regex ever silently matches nothing, every collision
    // assertion below turns green by measuring a smaller catalogue.
    // Fail here instead, where the message says what happened.
    expect(bySlug.get("valorant")).toContain("vgc.exe");
    expect(bySlug.get("wow")).toContain("battle.net.exe");
    expect(entries.length).toBe(bulk.length + RESERVED_SLUGS.length);
  });

  describe("multi-binary games keep both halves in one row", () => {
    it.each([
      // Valve's launch config names only the EAC wrapper; RustClient.exe
      // is Facepunch's own name for the game without it.
      ["rust", ["rust.exe", "rustclient.exe"]],
      // SeaOfThieves.exe is a root shim; SoTGame.exe is the real binary.
      ["sea-of-thieves", ["seaofthieves.exe", "sotgame.exe"]],
      ["dead-by-daylight", ["deadbydaylight.exe", "deadbydaylight-win64-shipping.exe"]],
      // BattlEye's own FAQ confirms a [Game]_BE.exe makes its own
      // network connections, so it is not a mere shim to ignore.
      ["ark-survival-evolved", ["shootergame_be.exe", "shootergame.exe"]],
      ["ark-survival-ascended", ["arkascended_be.exe", "arkascended.exe"]],
      ["lost-ark", ["lostark.exe", "launch_game.exe", "lostarklauncher.exe"]],
      ["fortnite", ["fortniteclient-win64-shipping.exe", "fortnitelauncher.exe"]],
    ])("%s", (slug, expected) => {
      const names = bySlug.get(slug);
      // Named in the failure rather than left as `undefined is not
      // defined`, because the interesting case is a slug that was
      // renamed and the message is the only thing that would say so.
      if (!names) throw new Error(`${slug} is missing from the catalogue`);
      for (const name of expected) expect(names).toContain(name);
    });
  });

  describe("sharedProcessNames", () => {
    it("finds an executable two entries both claim", () => {
      const shared = sharedProcessNames([
        { slug: "a", displayName: "A", processNames: ["Shared.exe", "OnlyA.exe"] },
        { slug: "b", displayName: "B", processNames: ["shared.exe"] },
        { slug: "c", displayName: "C", processNames: ["OnlyC.exe"] },
      ]);
      expect(shared).toEqual([{ name: "shared.exe", slugs: ["a", "b"] }]);
    });

    it("reports the real entanglements the client has to resolve", () => {
      // Not a hypothetical. These three binaries genuinely belong to
      // both Riot titles, so a customer who activates VALORANT and
      // League with different exits is asking one process to leave from
      // two places. The client withholds the preference from both
      // rather than picking a winner, and this is the data that makes
      // that path reachable.
      const shared = new Map(sharedProcessNames(entries).map((s) => [s.name, s.slugs]));
      for (const name of ["riotclientservices.exe", "vgc.exe", "vgm.exe"]) {
        expect(shared.get(name)?.sort()).toEqual(["league-of-legends", "valorant"]);
      }
      // And a cross-tier one, which is the case somebody adding a
      // launcher entry would not think about: the Battle.net launcher is
      // a catalogue row in its own right AND a member of the World of
      // Warcraft group.
      expect(shared.get("battle.net.exe")?.sort()).toEqual(["battle-net", "wow"]);
      // Inside the generated tier too, so this is not a curated-data
      // quirk: eleven Source titles run under one `hl2.exe`.
      expect((shared.get("hl2.exe") ?? []).length).toBeGreaterThan(5);
    });

    it("is not rare enough to treat as an edge case", () => {
      // The number is not the assertion -- it will drift as the
      // generated tier is rebuilt. That it is dozens rather than a
      // handful is, because it is what makes the conflict rule worth
      // having code for at all.
      expect(sharedProcessNames(entries).length).toBeGreaterThan(20);
    });
  });

  describe("entangledSlugs", () => {
    it("names the games that cannot be given different exits", () => {
      const entangled = entangledSlugs(entries);
      expect(entangled.get("valorant")).toContain("league-of-legends");
      expect(entangled.get("league-of-legends")).toContain("valorant");
    });

    it("leaves an unentangled game free to differ", () => {
      // Most of the catalogue. 81% of entries are a single executable
      // and the great majority collide with nothing.
      const entangled = entangledSlugs(entries);
      expect(entangled.has("sea-of-thieves")).toBe(false);
    });

    it("is pairwise, not transitive", () => {
      // A shares with B and B shares with C, but no single process is
      // claimed by both A and C -- so A and C may still differ. The
      // rule is about one executable being asked to leave from two
      // places, which is a fact about a pair.
      const entangled = entangledSlugs([
        { slug: "a", displayName: "A", processNames: ["ab.exe"] },
        { slug: "b", displayName: "B", processNames: ["ab.exe", "bc.exe"] },
        { slug: "c", displayName: "C", processNames: ["bc.exe"] },
      ]);
      expect([...(entangled.get("a") ?? [])]).toEqual(["b"]);
      expect([...(entangled.get("c") ?? [])]).toEqual(["b"]);
    });
  });
});

/** Provenance, and the row that proved it was needed.
 *
 * Every row in the generated tier comes from one place: the launch config of
 * one Steam app. That is first-party about how STEAM starts a game and it is
 * not a report of what is on a customer's disk, and the difference is not
 * academic. `old-school-runescape` shipped `oslaunch.exe` and `osclient.exe`,
 * copied faithfully out of Valve's config for app 1343370. A real standalone
 * Jagex install on the Windows test rig on 2026-08-26 contained neither: that
 * installer ships `JagexLauncher.exe` under
 * `%USERPROFILE%\jagexcache\jagexlauncher\bin\`. The sibling `runescape` row
 * was dead the same way.
 *
 * Nothing could see it. The client resolves a name against running processes,
 * so a name that cannot exist and a game that is not running produce the same
 * observation -- no match -- and the customer gets a tunnel with nothing on
 * it and a UI that says it worked. 1,446 generated rows are exposed to that
 * same class of mismatch.
 *
 * So two assertions, and they are different in kind. The first pins the fix
 * for these two games. The second pins the thing that makes the next one
 * findable: a generated row that carries no provenance is a row nobody can
 * audit, and it must not be possible to add one. */
describe("catalogue provenance", () => {
  const merged = catalogueEntries();
  const bySlug = new Map(merged.map((e) => [e.slug, e]));

  describe("the Jagex rows resolve on a standalone install", () => {
    it.each([
      ["old-school-runescape", ["oslaunch.exe", "osclient.exe"]],
      ["runescape", ["runescape.exe"]],
    ])("%s lists the standalone launcher alongside the Steam names", (slug, steamNames) => {
      const entry = bySlug.get(slug);
      if (!entry) throw new Error(`${slug} is missing from the catalogue`);
      const names = entry.processNames.map((n) => n.toLowerCase());

      // The name a real install actually has. Without it this row resolves
      // nothing at all on a machine that got the game from Jagex.
      expect(names).toContain("jagexlauncher.exe");

      // And the Steam names stay. curated.json RULE 2 and RULE 5: where
      // sources disagree, ship BOTH. A name that is not on the machine
      // reports as not-found and costs nothing; dropping the one that is
      // there leaves the game unrouted with nothing said.
      for (const steam of steamNames) expect(names).toContain(steam);
    });

    it("is the curated row, not the generated one it displaced", () => {
      // The mechanism the fix depends on. `steam-tier.json` is regenerated
      // and must not be hand-edited, so the correction can only live in
      // curated.json -- and it is only worth anything if curated still wins
      // the slug collision. If that merge order ever inverts, both rows go
      // back to the Steam-only names and this is the assertion that says so.
      for (const slug of ["old-school-runescape", "runescape"]) {
        const entry = bySlug.get(slug);
        expect(entry?.source).toMatch(/observed/i);
        expect(entry?.source).toMatch(/2026-08-26/);
      }
      // The generated tier still holds its own version of both rows -- they
      // are not deleted from it, they are outranked -- and that version is
      // still Steam-only. This is what the customer would have had.
      const generatedBySlug = new Map(generatedEntries().map((e) => [e.slug, e]));
      for (const slug of ["old-school-runescape", "runescape"]) {
        const names = generatedBySlug.get(slug)?.processNames.map((n) => n.toLowerCase()) ?? [];
        expect(names.length).toBeGreaterThan(0);
        expect(names).not.toContain("jagexlauncher.exe");
      }
    });

    it("entangles the two Jagex games, which is the true reading", () => {
      // One launcher really does start both games, so `JagexLauncher.exe` is
      // in both rows and the two games cannot be given different exits: one
      // process cannot leave from two places. Recorded here rather than
      // avoided by putting the launcher in only one row, which would be
      // choosing a tidier catalogue over a true one.
      const entangled = entangledSlugs(merged);
      expect(entangled.get("old-school-runescape")).toContain("runescape");
      expect(entangled.get("runescape")).toContain("old-school-runescape");
    });
  });

  describe("the generated tier says where it came from", () => {
    const generated = generatedEntries();

    it("has rows to check at all", () => {
      // Guards every assertion below. If `generatedEntries()` ever returned
      // nothing, "all of them carry provenance" would be vacuously true and
      // this suite would go green while proving nothing.
      expect(generated.length).toBeGreaterThan(1_000);
    });

    it("carries a source on every single row", () => {
      // Not a count -- the slugs, because when a regenerated tier loses this
      // it will lose it on every row at once and the first few names tell
      // you which rebuild did it.
      const missing = generated.filter(
        (e) => typeof e.source !== "string" || e.source.trim().length === 0,
      );
      expect(missing.map((e) => e.slug)).toEqual([]);
    });

    it("says Steam, and says it was not observed", () => {
      // The two facts that would have made the Jagex row auditable. A
      // provenance string that only said "Valve" would record where the
      // name came from without recording what it does not cover.
      for (const entry of generated) {
        expect(entry.source).toMatch(/steam/i);
        expect(entry.source).toMatch(/not observed/i);
      }
    });

    it("reaches the operator-facing notes column", () => {
      // `notes` is where somebody looks when a customer reports a game
      // doing nothing, and `toSeedRow` is the only thing that puts anything
      // there. Provenance that stops at the JSON file helps nobody at the
      // moment it is needed.
      const row = toSeedRow(generated[0], 0);
      expect(row.notes).toContain(`source: ${generated[0].source}`);
    });

    it("holds the shipped file to it, not just the loader", () => {
      // Read off disk rather than through the import, because the import is
      // what the rest of this suite already trusts. A hand-edit to the
      // generated file -- which its own header forbids -- would show up
      // here.
      const raw = JSON.parse(
        readFileSync(join(__dirname, "../../../prisma/catalogue/steam-tier.json"), "utf8"),
      ) as { games: { slug: string; source?: string }[] };
      expect(raw.games.filter((g) => !g.source).map((g) => g.slug)).toEqual([]);
    });
  });

  describe("validateCatalogue on the source field", () => {
    const ok = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
      slug: "example-game",
      displayName: "Example Game",
      processNames: ["Example.exe"],
      ...over,
    });

    it("accepts a row that carries one", () => {
      expect(validateCatalogue([ok({ source: "Valve appinfo" })])).toEqual([]);
    });

    it("rejects a blank one", () => {
      // Blank satisfies "the field is there" while telling a reader
      // nothing, which is worse than absent: absent is legible.
      expect(validateCatalogue([ok({ source: "   " })])).toEqual([
        { slug: "example-game", problem: expect.stringMatching(/source is present but empty/) },
      ]);
    });
  });
});
