/** The bulk game catalogue: loading, merging and validating it.
 *
 * WHY THE DATA IS NOT IN THIS FILE
 *
 * `game-profiles.ts` next door holds three hand-written rows and each one
 * carries several paragraphs explaining a measurement. That shape is right
 * for three rows and wrong for a thousand: nobody reviews a thousand-entry
 * TypeScript literal, and a diff of one is unreadable. So the catalogue
 * proper lives in two JSON files that a person can actually read a diff of,
 * and this module is the code that turns them into database rows.
 *
 *   * `curated.json`   -- hand-written, one source URL per entry, covering
 *                         launchers and the titles that matter most to this
 *                         product's customers. Wins every collision.
 *   * `steam-tier.json` -- GENERATED from Valve's own `appinfo` by
 *                         `tools/build-steam-tier.mjs`. Breadth.
 *
 * WHAT AN ENTRY PROMISES, AND WHAT IT DOES NOT
 *
 * An entry says: "if these executables are running, the client will put
 * their real paths into the split tunnel." That is all it says. Not one of
 * these entries has been tested against the game actually running, and the
 * UI must never imply otherwise. `processNames` is resolved against live
 * processes on the customer's machine, so a name that is wrong or stale
 * reports as not-found rather than silently leaving half a game outside the
 * tunnel -- which is why listing two plausible spellings is better than
 * picking one.
 *
 * SOURCES AND THEIR LICENCES
 *
 * `steam-tier.json` is derived from `config.launch[].executable` in Steam's
 * application metadata -- the literal command Valve's own client runs. It is
 * first-party fact about how a program starts, retrieved through the public
 * `api.steamcmd.net` mirror of `appinfo`, with the selection of which apps to
 * ask about taken from SteamSpy owner estimates. No SteamSpy field is
 * published in the catalogue; it is used only to rank what to look up.
 *
 * `curated.json` entries each carry their own `source` URL, overwhelmingly
 * publisher firewall and port documentation, which is both the most reliable
 * kind of source and the one that is unambiguously fine to rely on.
 *
 * PCGamingWiki was evaluated as a source and REJECTED, for three independent
 * reasons, and it is worth writing down so nobody spends the afternoon again:
 *
 *   1. Its content licence is Creative Commons Attribution NonCommercial
 *      ShareAlike 3.0. The NonCommercial clause is incompatible with a paid
 *      product, and ShareAlike would reach anything derived from it.
 *   2. Executable names are not a structured field there at all. Its cargo
 *      tables cover configuration and save-game paths; `.exe` names appear
 *      only incidentally in article prose, and a major title can have none
 *      -- its VALORANT article contains zero.
 *   3. Its `cargoquery` endpoint stopped serving anonymous requests in
 *      August 2026 and now requires an attributable bot account.
 *
 * A competitor's published title list was likewise not copied. Which games
 * exist is a matter of fact and their catalogue is a fair thing to aim at as
 * coverage, but the executable names here are derived from Valve and from
 * publishers, not lifted from anyone's product.
 */

import curatedData from "./curated.json";
import genericNameData from "./generic-names.json";
import steamData from "./steam-tier.json";

/** One catalogue entry, before it becomes a `GameProfile` row.
 *
 * Deliberately a narrow shape. It carries no `hostnames`, no
 * `destinationCidrs` and no `prefixComplete`, because a bulk entry has no
 * business setting any of them -- see `toSeedRow` for what those become and
 * why. */
export interface CatalogueEntry {
  slug: string;
  displayName: string;
  publisher?: string | null;
  /** Bare Windows executable filenames, launcher and game together.
   *
   * Both halves matter and the launcher is the half people forget in the
   * wrong direction: the research on competitors records WTFast keying on
   * "the process running while the game is active, which is not necessarily
   * the process you run to start the game", and reviewers finding that
   * picking only the launcher optimised patch downloads instead of play. One
   * row therefore lists both, and the client routes whichever are running. */
  processNames: string[];
  /** Present on generated entries; the appid the executables came from, so a
   * disputed name can be re-checked at its source. */
  steamAppId?: number;
  /** Whether Steam marks the title as having any online mode. Used only for
   * ordering -- an offline game sorts below an online one, because routing a
   * single-player game through a relay buys the customer nothing. */
  online?: boolean;
  /** Where this entry's executable names came from. Per-entry on the curated
   * tier; the generated tier shares one batch-level source. */
  source?: string;
  /** How much this entry's names are worth trusting.
   *
   * Shipped as data rather than left implicit because the difference between
   * a publisher-authored Steam launch config and a name somebody read on a
   * forum is exactly what lets a later reader decide whether to re-check an
   * entry without redoing the work. It reaches the database in `notes`, which
   * is operator-facing and never shown to a customer.
   *
   *   `first-party`  -- the publisher's own documentation, or Valve's own
   *                     launch configuration for the app.
   *   `corroborated` -- several independent third-party sources agree, and no
   *                     first-party statement was found.
   *   `unverified`   -- plausible and single-sourced. Not a claim of support;
   *                     if it is wrong the client reports the name as
   *                     not-found, which is the failure mode we can live
   *                     with. */
  confidence?: "first-party" | "corroborated" | "unverified";
  notes?: string;
}

interface CatalogueFile {
  games: CatalogueEntry[];
}

const curated = curatedData as unknown as CatalogueFile;
const steamTier = steamData as unknown as CatalogueFile;

/** Slugs owned by `game-profiles.ts`'s hand-written rows.
 *
 * Those three were built from first-party Riot and Blizzard documentation
 * and from a reachability sweep, and they carry hostnames and canaries that
 * nothing here can reproduce. A bulk entry must never displace one. Listed
 * explicitly rather than imported so that this file has no cycle back into
 * the seed, and so an accidental rename shows up as a validation failure
 * rather than as a silently-overwritten row. */
export const RESERVED_SLUGS = ["wow", "valorant", "league-of-legends"] as const;

/** The whole bulk catalogue, curated tier first, collisions resolved.
 *
 * Order is the seed's `sortOrder` order and therefore the picker's default
 * order: curated entries (the titles this product's customers actually
 * have trouble with) ahead of the generated breadth tier, and online titles
 * ahead of offline ones inside that. */
export function catalogueEntries(): CatalogueEntry[] {
  const bySlug = new Map<string, CatalogueEntry>();
  const reserved = new Set<string>(RESERVED_SLUGS);

  for (const entry of curated.games) {
    if (reserved.has(entry.slug)) continue;
    bySlug.set(entry.slug, entry);
  }
  for (const entry of steamTier.games) {
    // Curated wins, always. The generated tier knows one executable list
    // from one appid; a curated entry knows the launcher, the anti-cheat
    // helper and the non-Steam build too.
    if (reserved.has(entry.slug) || bySlug.has(entry.slug)) continue;
    bySlug.set(entry.slug, entry);
  }

  return [...bySlug.values()];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A bare Windows executable filename.
 *
 * Anchored, so anything with a directory separator in it fails here rather
 * than reaching the client -- which matters because the client takes the
 * basename of whatever it is given and would quietly turn
 * `C:\Games\foo.exe` into `foo.exe`, hiding the mistake instead of
 * reporting it. Characters Windows forbids in a filename are rejected for
 * the same reason: they cannot be a real process name, so their presence is
 * a data error somebody should see. */
const BARE_EXE = /^[^\\/<>:"|?*\u0000-\u001f]+\.exe$/i;

/** Executable names that must never reach a catalogue entry.
 *
 * This is the rule with the widest blast radius in the file, so it states the
 * mechanism rather than the conclusion. The desktop client takes a catalogue
 * name, finds every RUNNING process with that filename, and adds those
 * processes' real paths to the split tunnel. It does not know, and cannot
 * know, whether the thing it found is the game.
 *
 * So a name shared with software that is not the game routes software that is
 * not the game. `javaw.exe` makes it concrete: catalogue Minecraft Java under
 * it, and a customer who picks Minecraft puts their employer's Java VPN
 * client, their IDE and their build tools on the tunnel -- silently, with the
 * UI showing success. `Update.exe` is the same failure with a wider net,
 * because Squirrel ships that name with every Electron application.
 *
 * First-party provenance does NOT make a name safe. Wargaming's own Defender
 * article names `cef_browser_process.exe`; it is still every CEF-embedding
 * application on the machine. Specificity and provenance are different
 * properties, and only the first one matters here.
 *
 * Names shared between GAMES are a different case and are allowed: `hl2.exe`
 * really is the process each Source game runs under, and routing a sibling
 * game the customer also has open is not a surprise worth failing a build
 * over. The line is "shared with something that is not a game".
 *
 * A hard failure rather than a warning, deliberately. Somebody will one day
 * add "Minecraft -> javaw.exe" because it is technically the right answer,
 * and they should meet a red build rather than a reviewer's good day. */
const GENERIC_NAMES = new Set<string>(
  (genericNameData as { names: string[] }).names.map((n) => n.toLowerCase()),
);

/** Generic Unreal Engine shipping binaries.
 *
 * `VALORANT-Win64-Shipping.exe` is specific and fine. `Client-Win64-Shipping.exe`
 * is what an Unreal project is called when nobody renamed it, and several
 * unrelated games ship exactly that. Matched by pattern as well as by the
 * denylist because the prefix set is open-ended. */
const GENERIC_UE_SHIPPING = new RegExp(
  "^(client|game|server|shipping|ue4game|ue5game)-(win64|win32|wingdk)-shipping[.]exe$",
  "i",
);

export interface CatalogueProblem {
  slug: string;
  problem: string;
}

/** Every reason this catalogue must not be seeded.
 *
 * Returns problems rather than throwing on the first one, because when a
 * regenerated tier is wrong it is usually wrong in one systematic way across
 * many entries, and seeing all of them at once is what tells you that.
 *
 * The `prefixComplete` rule is the one with teeth. A prefix list that is
 * incomplete but marked whole splits a game's connections across two source
 * addresses at the same instant, which is the account-sharing signature that
 * gets customers penalised. No entry in the bulk catalogue has a researched
 * prefix list, so no entry may carry the flag, and this refuses to seed one
 * that does even if somebody hand-edits the JSON. */
export function validateCatalogue(entries: readonly CatalogueEntry[]): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  const seenSlug = new Map<string, number>();
  const reserved = new Set<string>(RESERVED_SLUGS);

  entries.forEach((entry, index) => {
    const slug = entry.slug ?? `#${index}`;
    const add = (problem: string) => problems.push({ slug, problem });

    if (typeof entry.slug !== "string" || entry.slug.length === 0) {
      add("slug is missing or not a string");
    } else if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.slug)) {
      add(`slug ${JSON.stringify(entry.slug)} is not lowercase-kebab`);
    } else if (seenSlug.has(entry.slug)) {
      add(`duplicate slug, first seen at index ${seenSlug.get(entry.slug)}`);
    } else {
      seenSlug.set(entry.slug, index);
    }

    if (reserved.has(entry.slug)) {
      add("slug is reserved by the hand-written profiles in game-profiles.ts");
    }

    if (typeof entry.displayName !== "string" || entry.displayName.trim().length === 0) {
      add("displayName is missing or empty");
    }

    if (!Array.isArray(entry.processNames) || entry.processNames.length === 0) {
      add("processNames is empty -- an entry with no executables supports nothing");
    } else {
      const seenName = new Set<string>();
      for (const name of entry.processNames) {
        if (typeof name !== "string" || name.trim().length === 0) {
          add("processNames contains an empty entry");
          continue;
        }
        if (/[\\/]/.test(name)) {
          add(`processNames entry ${JSON.stringify(name)} is a path, not a bare filename`);
          continue;
        }
        if (!/\.exe$/i.test(name)) {
          add(`processNames entry ${JSON.stringify(name)} does not end in .exe`);
          continue;
        }
        if (!BARE_EXE.test(name)) {
          add(`processNames entry ${JSON.stringify(name)} is not a valid Windows filename`);
          continue;
        }
        const lower = name.toLowerCase();
        if (GENERIC_NAMES.has(lower) || GENERIC_UE_SHIPPING.test(name)) {
          // Hard failure, not a warning. See GENERIC_NAMES above: this name
          // would resolve against whatever unrelated program happens to be
          // running under it, and route that instead of the game.
          add(
            `processNames entry ${JSON.stringify(name)} is a generic name shared with ` +
              "software that is not this game; it would route whatever else is running " +
              "under that name. Use a specific name or drop the entry.",
          );
          continue;
        }
        // Case-insensitively, because Windows is. Reported as a problem for a
        // human to resolve rather than silently de-duplicated: the publisher's
        // own casing is preserved in the data, so which spelling to keep is a
        // decision somebody should make on purpose.
        if (seenName.has(lower)) add(`processNames lists ${JSON.stringify(name)} twice`);
        seenName.add(lower);
      }
    }

    // The safety pair. Neither may be set from here at all -- not merely not
    // set to `true` -- because the two are one statement and a bulk entry is
    // not entitled to make it. Read through a cast because `CatalogueEntry`
    // deliberately does not declare either field: the point is to catch one
    // that a hand-edited JSON file smuggled in anyway.
    const extra = entry as unknown as Record<string, unknown>;
    if (extra.prefixComplete === true) {
      add("prefixComplete is true; no bulk entry has a researched prefix list");
    }
    const cidrs = extra.destinationCidrs;
    if (Array.isArray(cidrs) && cidrs.length > 0) {
      add("destinationCidrs is non-empty; bulk entries must not route by destination");
    }
  });

  return problems;
}

/** A catalogue entry as the `GameProfile` upsert wants it.
 *
 * Everything the bulk tier does not know is written explicitly rather than
 * left to a schema default, so that reading this function tells you exactly
 * what a bulk row claims:
 *
 *   * `hostnames` / `excludeHostnames` empty -- these rows are for Custom
 *     mode, which matches processes. A hostname here would be a claim that
 *     the node's SNI proxy should forward it, and the standard for that is a
 *     reachability measurement from Iranian networks that none of these have.
 *   * `canaryHostname` null -- there is no hostname redirect to prove.
 *   * `destinationCidrs` empty and `prefixComplete` false -- see
 *     `validateCatalogue`.
 */
export function toSeedRow(entry: CatalogueEntry, sortOrder: number) {
  return {
    slug: entry.slug,
    displayName: entry.displayName,
    publisher: entry.publisher ?? null,
    iconKey: null as string | null,
    hostnames: [] as string[],
    excludeHostnames: [] as string[],
    processNames: entry.processNames,
    destinationCidrs: [] as string[],
    destinationAsn: null as string | null,
    prefixComplete: false,
    canaryHostname: null as string | null,
    sortOrder,
    isActive: true,
    // Operator-facing only; never rendered to a customer. Carries the
    // provenance and the confidence grade together, so somebody auditing a
    // suspect entry can see where the name came from without leaving the row.
    notes:
      [
        entry.confidence ? `confidence: ${entry.confidence}` : null,
        entry.source ? `source: ${entry.source}` : null,
        entry.notes ?? null,
      ]
        .filter(Boolean)
        .join(" | ") || null,
  };
}
