import type { GameProfileSummary } from "./customer";
import type { RunningApp } from "./split-tunnel";

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
export function resolveGameApps(
  profile: Pick<GameProfileSummary, "processNames">,
  running: RunningApp[],
): GameAppResolution {
  const wanted = curatedNames(profile);
  if (wanted.length === 0) return EMPTY_RESOLUTION;

  // filename -> real paths seen running. Built once rather than
  // scanned per name: a machine can have several hundred processes and
  // a game several executables.
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
 *   1. a word in the name starts with it -- so "strike" finds
 *      Counter-Strike and "legends" finds Apex Legends
 *   2. the name contains it anywhere
 *   3. the name contains it once spaces are removed on both sides, which
 *      is how "counterstrike" and "deadbydaylight" find their games
 *   4. the publisher contains it, so "blizzard" lists Blizzard's catalogue
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

  games.forEach((game, index) => {
    const name = normaliseForSearch(game.displayName);
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(" ").some((word) => word.startsWith(needle))) score = 1;
    else if (name.includes(needle)) score = 2;
    else if (name.replace(/ /g, "").includes(squashedNeedle)) score = 3;
    else if (normaliseForSearch(game.publisher ?? "").includes(needle)) score = 4;
    else return;
    scored.push({ game, score, index });
  });

  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.game);
}
