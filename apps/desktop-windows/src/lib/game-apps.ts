import type { GameProfileSummary } from "./customer";
import type { AppExit, RunningApp } from "./split-tunnel";

/** Turning the server's curated executable list into a Custom-mode
 * selection.
 *
 * The gap this closes: the catalogue names a game's executables
 * (`VALORANT.exe`, `RiotClientServices.exe`, ...) but the split tunnel
 * matches on **full lowercased paths** and its wire validation rejects
 * anything that is not an absolute path ending in `.exe`. A bare
 * filename cannot be pushed at all -- and a config with one bad entry
 * is rejected whole, not partially, so an unfiltered push would take
 * the customer's existing selection down with it.
 *
 * Full paths are the stronger design and are worth keeping. ExitLag
 * matches on filename alone, which is why a DPS meter can get itself
 * proxied by copying its own binary to `LOSTARK.exe`; a path match
 * cannot be fooled that way. So rather than weaken the match, this
 * resolves each curated name against the processes actually running on
 * this machine and takes the real path from there.
 *
 * The cost of that choice, stated plainly because the UI has to state
 * it too: **a program that is not running cannot be resolved.** There
 * is no filesystem access on this side to go looking for it. So the
 * answer is always "these were found, these were not", never a claim
 * that a game is fully covered.
 */

/** One curated executable name and where it was actually found. */
export interface GameAppMatch {
  /** The name as the catalogue gave it, for display. */
  name: string;
  /** Absolute paths of running processes with that filename.
   *
   * Plural: a game can legitimately have the same executable name in
   * two places (a live and a PBE install), and routing one while
   * leaving the other direct is the half-product failure this whole
   * feature exists to stop. */
  paths: string[];
}

export interface GameAppResolution {
  /** Curated names that matched something running, with their paths. */
  found: GameAppMatch[];
  /** Curated names with nothing running to match. Named, not counted:
   * the customer can start them or find them with Browse, but only if
   * they are told which ones. */
  missing: string[];
  /** Every found path, deduplicated, ready to hand to the split
   * tunnel. Already filtered to what the wire format accepts. */
  paths: string[];
}

export const EMPTY_RESOLUTION: GameAppResolution = { found: [], missing: [], paths: [] };

/** Whether the split tunnel will accept this path.
 *
 * A deliberate mirror of `SplitTunnelConfig::validate` in the ipc
 * crate. It has to be mirrored rather than trusted because that
 * validation rejects the **entire** `SetSplitTunnel` request on one bad
 * entry: pushing a single malformed path from the catalogue would drop
 * every app the customer had already chosen. Keep the two in step.
 *
 * The rules there: no control characters, at most 32767 characters, an
 * absolute path (`C:\...` or a UNC `\\server\...`), ending in `.exe`
 * case-insensitively.
 */
export function isSelectableAppPath(path: string): boolean {
  if (!path || path.length > 32_767) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const absolute = path.charAt(1) === ":" || path.startsWith("\\\\");
  if (!absolute) return false;
  return path.toLowerCase().endsWith(".exe");
}

/** The filename part of a path, lowercased.
 *
 * Handles both separators because a path can arrive from either side:
 * Windows reports backslashes, and a catalogue entry written by hand
 * may not. */
function baseName(value: string): string {
  const parts = value.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").trim().toLowerCase();
}

/** Every path a running-app entry knows about.
 *
 * `paths` is the whole product group and `path` is the one the picker
 * displays; the group normally contains the displayed one, but taking
 * both costs nothing and a missing sibling here is a silently
 * half-routed game. */
function pathsOf(app: RunningApp): string[] {
  return [app.path, ...(app.paths ?? [])];
}

/** Match a game's curated executable names against what is running.
 *
 * Case-insensitive on the filename, because Windows is and because the
 * catalogue's spelling of `VALORANT.exe` need not match what the
 * process reports.
 */
/** filename -> real paths seen running.
 *
 * Built once rather than scanned per name: a machine can have several
 * hundred processes and a game several executables. Shared by
 * `resolveGameApps` and `rescanGameGroups` so the two can never disagree
 * about what counts as a running match -- they are the add-time and the
 * after-the-fact halves of one question. */
function runningByName(running: readonly RunningApp[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const app of running) {
    for (const path of pathsOf(app)) {
      if (!isSelectableAppPath(path)) continue;
      const key = baseName(path);
      if (!key) continue;
      const slot = byName.get(key);
      if (!slot) {
        byName.set(key, [path]);
      } else if (!slot.some((p) => p.toLowerCase() === path.toLowerCase())) {
        slot.push(path);
      }
    }
  }
  return byName;
}

export function resolveGameApps(
  profile: Pick<GameProfileSummary, "processNames">,
  running: RunningApp[],
): GameAppResolution {
  const wanted = curatedNames(profile);
  if (wanted.length === 0) return EMPTY_RESOLUTION;

  const byName = runningByName(running);

  const found: GameAppMatch[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const name of wanted) {
    const hits = byName.get(baseName(name)) ?? [];
    if (hits.length === 0) {
      missing.push(name);
      continue;
    }
    found.push({ name, paths: hits });
    for (const path of hits) {
      const key = path.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(path);
      }
    }
  }

  return { found, missing, paths };
}

/** The catalogue's executable names, cleaned up.
 *
 * Defensive about shape rather than trusting the server: this list is
 * edited by hand in the panel, and a stray path separator or a
 * duplicate spelling must not become two rows saying the same thing in
 * the customer's face. Optional on the wire, because a client can be
 * newer than the server it is talking to -- an older server simply has
 * nothing to offer here, which is not an error. */
export function curatedNames(profile: Pick<GameProfileSummary, "processNames">): string[] {
  const names = profile.processNames;
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    // Displayed as a filename even if somebody typed a whole path into
    // the panel, so the row reads the same either way.
    const name = baseName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(raw.split(/[\\/]/).pop()!.trim());
  }
  return out;
}

/** Whether this profile has anything to offer Custom mode at all.
 *
 * False for every profile that has not been researched, and the picker
 * must say so rather than offer a row that would add nothing. */
export function hasCuratedApps(profile: Pick<GameProfileSummary, "processNames">): boolean {
  return curatedNames(profile).length > 0;
}

/** Whether this profile's address list may be used to route by
 * destination.
 *
 * This is now load-bearing rather than advisory. The split tunnel does
 * route by destination, so a `true` here is what puts a game's prefix
 * list on the wire and narrows what is carried; a `false` sends no
 * scope at all and the game's programs are carried in full, exactly as
 * they were before any of this existed.
 *
 * It is still false for every seeded profile, because no catalogue
 * entry has a finished prefix list yet. That is the data being the
 * gate, which is where the gate belongs.
 *
 * A **partial** prefix list is worse than none. A game that holds two
 * connections at once (World of Warcraft keeps Home and World open
 * together) would get one of them routed and the other not, which
 * presents one account from two source addresses at the same instant.
 * That is the account-sharing signature. So an incomplete list is
 * refused rather than approximated, and `prefixComplete` is the
 * server's own statement about whether its list is whole.
 */
export function canRouteByDestination(
  profile: Pick<GameProfileSummary, "destinationCidrs" | "prefixComplete">,
): boolean {
  return profile.prefixComplete === true && (profile.destinationCidrs?.length ?? 0) > 0;
}

/** The scopes to attach to a game's programs, which is usually none.
 *
 * The single place this client decides to narrow anything, extracted
 * from the screen that calls it so the rule above can be proven by a
 * test rather than by reading a component. That is not tidiness: the
 * cost of `canRouteByDestination` being bypassed is not a broken
 * screen, it is a customer's game account presenting from two source
 * addresses at once, and a rule that important should not live
 * somewhere only an end-to-end test can reach.
 *
 * Returns `[]` for every profile whose prefix list the server will not
 * vouch for as complete -- which today is every profile there is -- and
 * an empty list means the programs are carried in full, exactly as they
 * were before scoping existed. */
export function scopesForGame(
  profile: Pick<GameProfileSummary, "destinationCidrs" | "prefixComplete">,
  paths: string[],
): { app: string; destinations: string[] }[] {
  if (!canRouteByDestination(profile)) return [];
  const destinations = profile.destinationCidrs ?? [];
  return paths.map((app) => ({ app, destinations }));
}

// ---------------------------------------------------------------------------
// Exit groups: a game's binaries go to one exit, or to none
// ---------------------------------------------------------------------------

/** One catalogue game the customer added, kept as a group.
 *
 * # Why this exists at all
 *
 * `docs/design/ban-safety.md` mechanism 4 is the one failure Neoxify
 * could *manufacture* rather than merely fail to prevent: a game's
 * connections arriving from two different source addresses at the same
 * instant is the account-sharing signature publishers look for. The
 * `prefixComplete` gate stops that arriving by destination prefix. This
 * stops the same thing arriving by exit selection.
 *
 * A game is routinely several binaries and the split is systematic --
 * an anti-cheat wrapper or a launcher starts, then spawns the game.
 * Rust is `Rust.exe` (the EAC wrapper Steam launches) plus
 * `RustClient.exe`; Sea of Thieves is `SeaOfThieves.exe` plus
 * `SoTGame.exe`; VALORANT is the Riot client, the game and Vanguard's
 * `vgc.exe`/`vgm.exe`. Per-game exit *preferences* are keyed on the
 * executable, so without a group nothing at all guarantees a game's
 * binaries name the same exit.
 *
 * # Why no new catalogue field
 *
 * A `GameProfile` already **is** the group: `processNames` is one
 * game's binaries and the catalogue's own note says so ("One row
 * therefore lists both, and the client routes whichever are running").
 * The information was never missing from the catalogue -- it was
 * discarded here, by a game's resolved paths being flattened into one
 * undifferentiated `apps` list. So this records the grouping the
 * catalogue already stated rather than inventing a second one.
 *
 * # What it stores, and what it deliberately does not
 *
 * `names` is the catalogue's list, not the resolved paths. Membership
 * and completeness are then *derived* against the live `apps`
 * selection rather than remembered from the moment the game was added.
 * That matters in both directions: a customer who later starts the
 * missing binary and re-adds the game gets a whole group without any
 * stale record having to be corrected, and a customer who removes one
 * binary by hand loses the preference for the whole game rather than
 * keeping a record that says the group is whole when it is not.
 */
export interface GameExitGroup {
  /** The catalogue slug. The group's identity, and what travels to the
   * service as `AppExit.group`. Opaque there. */
  slug: string;
  /** For copy. Kept locally because the catalogue needs the network and
   * a customer in Iran may not have it when this screen renders. */
  displayName: string;
  /** Every executable name the catalogue lists for this game. */
  names: string[];
  /** The exit identifier the customer chose for this game, or `null`
   * for "no preference", which is what every application had before
   * this existed.
   *
   * On the group and **never on an application**. That is the
   * structural half of the safety argument: there is no field anywhere
   * in this client's state that can hold a per-executable exit, so a
   * customer cannot put `Rust.exe` and `RustClient.exe` on two exits by
   * hand, whatever a future screen offers them. */
  exit: string | null;
}

/** Build a group from a catalogue profile.
 *
 * The only constructor, so a group's `names` can only ever be the
 * catalogue's own list for one slug. */
export function gameExitGroup(
  profile: Pick<GameProfileSummary, "slug" | "displayName" | "processNames">,
  exit: string | null = null,
): GameExitGroup {
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    names: curatedNames(profile),
    exit,
  };
}

/** The selected paths that belong to this group.
 *
 * Matched on the filename, because that is all the catalogue has and
 * the full path is what the selection is made of. Note this is *not*
 * the weak matching `resolveGameApps` refuses: nothing here decides
 * what to route. The paths were already selected; this only asks which
 * game they came from. */
export function groupMembers(group: GameExitGroup, apps: readonly string[]): string[] {
  const wanted = new Set(group.names.map((n) => baseName(n)));
  return apps.filter((app) => wanted.has(baseName(app)));
}

/** The group's executable names with nothing selected to match them.
 *
 * Non-empty means the group is **partial**, which is the hard case:
 * `resolveGameApps` resolves against *running* processes, so a launcher
 * may be running while the game is not, and Vanguard's `vgc.exe` runs
 * as a windowless service that `vpn_list_running_apps` filters out
 * entirely. A group is therefore routinely part-present. */
export function unresolvedNames(group: GameExitGroup, apps: readonly string[]): string[] {
  const have = new Set(apps.map((app) => baseName(app)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of group.names) {
    const key = baseName(name);
    if (!key || have.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Whether every one of this game's binaries is in the selection. */
export function isWholeGroup(group: GameExitGroup, apps: readonly string[]): boolean {
  return group.names.length > 0 && unresolvedNames(group, apps).length === 0;
}

/** One game's share of a re-scan: what was found for it, and for which
 * of its catalogue names. */
export interface GroupRescan {
  slug: string;
  displayName: string;
  /** Newly found paths. None of these is already selected. */
  paths: string[];
  /** The catalogue names those paths answer for, for the sentence shown
   * to the customer -- who was told which programs were missing and is
   * owed the same specificity when they stop being. */
  names: string[];
}

export interface RescanResult {
  /** Every path to add, deduped, in group order. */
  paths: string[];
  /** Groups that become whole once `paths` is applied. */
  completed: GroupRescan[];
  /** Groups whose newly found binaries were withheld *entirely* because
   * adding them would pass the cap. */
  withheldAtCap: GroupRescan[];
}

export const EMPTY_RESCAN: RescanResult = { paths: [], completed: [], withheldAtCap: [] };

/** Look again for the binaries a game was missing when it was added.
 *
 * # Why this has to exist
 *
 * `resolveGameApps` matches against *running* processes, and it runs
 * once, at the moment the customer clicks a game. Nothing ever looked
 * again. Two things follow, both seen on the rig:
 *
 *   - A game added while its launcher is up gets the launcher and not
 *     the client, which starts moments later. Before per-game exits
 *     existed that alone put one game's connections on two source
 *     addresses -- the ban signature -- with the tunnel behaving exactly
 *     as designed.
 *   - A partly resolved group gets no per-game exit at all, which is
 *     correct (`exitsForGames` refuses to place a partial group), but it
 *     means the exit the customer chose silently does nothing until
 *     somebody re-adds the game by hand.
 *
 * # The policy, which is the point
 *
 * This adds programs, so it has to be defensible about which. It looks
 * for **names already listed in a game the customer added, and nothing
 * else** -- `group.names` is the catalogue's own list for a slug the
 * customer picked. It cannot introduce a program they did not choose;
 * it finishes a choice they already made. Nothing here consults the
 * catalogue at large, and a name that is in no added game is invisible
 * to it.
 *
 * A found path always joins **its group**, never the selection loose.
 * That is structural rather than a rule to remember: membership is
 * derived by filename against `group.names` (see `groupMembers`), and
 * every path added here matched one of those names, so it is a member
 * the moment it lands. The group therefore either becomes whole -- and
 * its exit preference can finally apply -- or stays incomplete and
 * keeps getting no exit. There is no third outcome in which a binary is
 * carried without its game.
 *
 * # At the cap
 *
 * A game whose newly found binaries do not all fit is withheld whole,
 * and reported. Adding the ones that fit is the one outcome that must
 * not happen: it is how a game ends up half-selected, which is the split
 * this feature exists to prevent. Withholding the game's preference is
 * the same direction the code already takes for a partial group, and the
 * same one `addPaths` takes when a batch would overflow.
 *
 * A withheld game does not stop a later, smaller one from fitting. Both
 * outcomes are all-or-nothing per game, which is the property that
 * matters; making one game's bad luck block another buys nothing.
 */
export function rescanGameGroups(
  groups: readonly GameExitGroup[],
  apps: readonly string[],
  running: readonly RunningApp[],
  max: number,
): RescanResult {
  if (groups.length === 0) return EMPTY_RESCAN;

  const byName = runningByName(running);
  const selected = new Set(apps.map((app) => app.toLowerCase()));
  let budget = max - apps.length;

  const paths: string[] = [];
  const completed: GroupRescan[] = [];
  const withheldAtCap: GroupRescan[] = [];

  for (const group of groups) {
    // Only the names this group is still missing. A whole group is
    // skipped outright, which is what keeps the common case free.
    const missing = unresolvedNames(group, apps);
    if (missing.length === 0) continue;

    const foundPaths: string[] = [];
    const foundNames: string[] = [];
    let unresolvedStill = 0;

    for (const name of missing) {
      const hits = (byName.get(baseName(name)) ?? []).filter(
        (path) =>
          !selected.has(path.toLowerCase()) &&
          !foundPaths.some((f) => f.toLowerCase() === path.toLowerCase()),
      );
      if (hits.length === 0) {
        unresolvedStill += 1;
        continue;
      }
      foundNames.push(name);
      foundPaths.push(...hits);
    }

    if (foundPaths.length === 0) continue;

    const entry: GroupRescan = {
      slug: group.slug,
      displayName: group.displayName,
      paths: foundPaths,
      names: foundNames,
    };

    if (foundPaths.length > budget) {
      withheldAtCap.push(entry);
      continue;
    }

    for (const path of foundPaths) {
      selected.add(path.toLowerCase());
      paths.push(path);
    }
    budget -= foundPaths.length;
    // Whole only if nothing this group wanted is still unaccounted for.
    // A group that gained a binary and is still short of another has
    // moved, but it has not arrived, and saying so would be the lie
    // this app does not tell.
    if (unresolvedStill === 0) completed.push(entry);
  }

  return { paths, completed, withheldAtCap };
}

/** Why a game the customer chose an exit for did not get one.
 *
 * Reported rather than swallowed. The game still works -- it is carried
 * on the session's exit like everything else -- but a customer who
 * asked for something and silently did not get it has been told the
 * smaller half of what happened, and this is a screen about where their
 * traffic appears from. */
export type ExitWithheld =
  | {
      slug: string;
      displayName: string;
      /** Some of this game's binaries are not in the selection, so
       * where they will appear from is not ours to say. */
      reason: "partial";
      /** The names with nothing to match them, for the copy. */
      missing: string[];
    }
  | {
      slug: string;
      displayName: string;
      /** This game shares a binary with another chosen game and the two
       * name different exits. */
      reason: "conflict";
      /** The other games, by display name. */
      withGames: string[];
      /** The executables both games run. */
      sharedApps: string[];
    };

export interface ExitSelection {
  /** What goes on the wire. Every entry carries its group. */
  exits: AppExit[];
  /** The games that asked for an exit and did not get one, and why. */
  withheld: ExitWithheld[];
}

/** Turn the customer's per-game choices into per-application wire
 * entries -- all of a game's binaries, or none of them.
 *
 * **The only way this client produces an `AppExit`.** It takes the
 * whole group list and the whole selection, so there is no call shape
 * that can hand it a single executable, and it emits a group's members
 * by iterating that group's own membership. "Place the ones you found
 * and hope" is not a state this function can reach.
 *
 * Three rules, and every one of them fails toward *no preference*,
 * which is the safe behaviour: the game is carried on the session's
 * exit exactly as it was before any of this existed.
 *
 *  1. **No exit chosen, nothing emitted.** Unchanged behaviour.
 *
 *  2. **A partial group gets no preference at all.** If a binary is not
 *     in the selection, it is not carried, so when it starts it will
 *     appear from the customer's own address while its siblings appear
 *     from the exit -- which is the two-source-IP split arriving
 *     without any second exit being involved. Placing the launcher on
 *     an exit and hoping the game follows is exactly the failure this
 *     function exists to refuse.
 *
 *  3. **A binary claimed by two games that want different exits
 *     withholds both.** Not hypothetical and not rare: `vgc.exe`,
 *     `vgm.exe` and `RiotClientServices.exe` each belong to both
 *     VALORANT and League of Legends, `Battle.net.exe` to both the
 *     Battle.net entry and World of Warcraft, and 61 executable names
 *     in the shipped catalogue appear in more than one profile.
 *     Honouring one game would place the shared binary away from the
 *     other game it also runs, which is the same split with a second
 *     account attached. Withholding both is the only answer that splits
 *     neither.
 *
 * A binary two games share while they agree on the exit is fine and is
 * emitted once. There is no split when there is nothing to split.
 */
export function exitsForGames(
  groups: readonly GameExitGroup[],
  apps: readonly string[],
): ExitSelection {
  const withheld: ExitWithheld[] = [];

  // Rules 1 and 2, per group and in isolation.
  const wanted: { group: GameExitGroup; exit: string; members: string[] }[] = [];
  for (const group of groups) {
    const exit = group.exit;
    if (typeof exit !== "string" || exit.length === 0) continue;
    const missing = unresolvedNames(group, apps);
    const members = groupMembers(group, apps);
    if (missing.length > 0 || members.length === 0) {
      withheld.push({
        slug: group.slug,
        displayName: group.displayName,
        reason: "partial",
        missing,
      });
      continue;
    }
    wanted.push({ group, exit, members });
  }

  // Rule 3, which needs every group at once. Built as
  // path -> the groups claiming it, so a three-way disagreement drops
  // all three rather than resolving pairwise into an arbitrary winner.
  const claims = new Map<string, { slug: string; exit: string; path: string }[]>();
  for (const entry of wanted) {
    for (const member of entry.members) {
      const key = member.toLowerCase();
      const claim = { slug: entry.group.slug, exit: entry.exit, path: member };
      const slot = claims.get(key);
      if (slot) slot.push(claim);
      else claims.set(key, [claim]);
    }
  }

  /** slug -> the other slugs it disagrees with, and over which paths. */
  const conflicts = new Map<string, { others: Set<string>; paths: Set<string> }>();
  for (const claimants of claims.values()) {
    if (new Set(claimants.map((c) => c.exit)).size < 2) continue;
    for (const claimant of claimants) {
      let slot = conflicts.get(claimant.slug);
      if (!slot) {
        slot = { others: new Set<string>(), paths: new Set<string>() };
        conflicts.set(claimant.slug, slot);
      }
      slot.paths.add(claimant.path);
      for (const other of claimants) {
        if (other.slug !== claimant.slug) slot.others.add(other.slug);
      }
    }
  }

  const nameOf = new Map(groups.map((g) => [g.slug, g.displayName]));
  const exits: AppExit[] = [];
  const emitted = new Set<string>();
  for (const entry of wanted) {
    const clash = conflicts.get(entry.group.slug);
    if (clash) {
      withheld.push({
        slug: entry.group.slug,
        displayName: entry.group.displayName,
        reason: "conflict",
        withGames: [...clash.others].map((slug) => nameOf.get(slug) ?? slug),
        sharedApps: [...clash.paths],
      });
      continue;
    }
    for (const member of entry.members) {
      const key = member.toLowerCase();
      // Two games that agree may both claim one binary. Emitting it
      // twice would say the same thing twice; emitting it once under
      // either group says it once and means the same.
      if (emitted.has(key)) continue;
      emitted.add(key);
      exits.push({ app: member, exit: entry.exit, group: entry.group.slug });
    }
  }

  return { exits, withheld };
}

/** How many catalogue rows a picker mounts at once.
 *
 * Not a limit on what is searchable -- the whole catalogue is always
 * ranked, and the caller is expected to say how many matches were not
 * shown. It is a limit on DOM nodes. The catalogue runs to well over a
 * thousand entries, and mounting all of them inside a backdrop-blurred
 * card is what makes a picker feel broken on the low-end machines a lot
 * of these customers have.
 */
export const GAME_PAGE_SIZE = 60;

/** Lowercased, punctuation flattened to single spaces.
 *
 * So "counter-strike", "Counter Strike" and "COUNTER STRIKE" are one
 * search rather than three, and somebody typing a name the way they say
 * it finds the game whatever the publisher's styling is.
 */
function normaliseForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** What a game has to match on. */
export interface SearchableGame {
  displayName: string;
  publisher?: string | null;
}

/** Rank a catalogue against a search box.
 *
 * A plain `includes` filter was fine for three games and is actively
 * misleading for a thousand: typing "cs" puts every title that happens to
 * contain those two letters above Counter-Strike, and the customer
 * concludes their game is not supported. So matches are scored and the
 * best ones come first.
 *
 * The bands, strongest first:
 *
 *   0. the name starts with what was typed
 *   1. the initials of the name start with it -- the acronym band, so
 *      "cs" finds Counter-Strike, "cod" finds Call of Duty and "gta"
 *      finds Grand Theft Auto V
 *   2. a word in the name starts with it -- so "strike" finds
 *      Counter-Strike and "legends" finds Apex Legends
 *   3. the name contains it anywhere
 *   4. the name contains it once spaces are removed on both sides, which
 *      is how "counterstrike" and "deadbydaylight" find their games
 *   5. the publisher contains it, so "blizzard" lists Blizzard's catalogue
 *
 * Band 1 was added on 2026-08-25 after the ranking was run against the
 * real 1,480-entry catalogue rather than against a fixture, which is the
 * only way it showed up. Typing "cs" did not merely rank Counter-Strike
 * badly -- it did not return it **at all**, because "cs" is not a prefix
 * of "counter strike 2", is not a prefix of either of its words, and does
 * not appear in "counterstrike2" as a substring. The customer's
 * conclusion from an empty result is that their game is not supported,
 * which is the one thing this picker must never say by accident. "cod"
 * and "gta" failed the same way. An acronym is how people type a game
 * whose full name they know perfectly well.
 *
 * It sits below band 0 rather than above it because a name that really
 * does start with the query is the better answer: for "cs", CS2D is a
 * genuine hit and stays first, with Counter-Strike 2 immediately behind
 * it. Skipped for a query containing a space, where the letters are
 * words rather than initials.
 *
 * Ties keep the server's order, which puts the curated entries and the
 * online titles first. An empty query returns the catalogue untouched.
 *
 * Cheap enough to run on every keystroke -- a few thousand string
 * comparisons -- so no debounce is needed to keep the field responsive.
 */
export function rankGames<T extends SearchableGame>(games: readonly T[], query: string): T[] {
  const needle = normaliseForSearch(query);
  if (!needle) return [...games];

  const squashedNeedle = needle.replace(/ /g, "");
  const scored: { game: T; score: number; index: number }[] = [];

  // An acronym only means something when the query is a run of letters with
  // no spaces and more than one of them: "a" would match half the catalogue
  // and "call of duty" is words, not initials.
  const wantsAcronym = needle.length > 1 && !needle.includes(" ");

  games.forEach((game, index) => {
    const name = normaliseForSearch(game.displayName);
    const words = name.split(" ");
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (wantsAcronym && words.map((word) => word.charAt(0)).join("").startsWith(needle))
      score = 1;
    else if (words.some((word) => word.startsWith(needle))) score = 2;
    else if (name.includes(needle)) score = 3;
    else if (name.replace(/ /g, "").includes(squashedNeedle)) score = 4;
    else if (normaliseForSearch(game.publisher ?? "").includes(needle)) score = 5;
    else return;
    scored.push({ game, score, index });
  });

  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.game);
}
