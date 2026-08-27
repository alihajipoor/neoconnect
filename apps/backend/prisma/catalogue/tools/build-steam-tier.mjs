#!/usr/bin/env node
/**
 * Regenerates `catalogue/steam-tier.json` -- the breadth half of the game
 * catalogue -- from Valve's own application metadata.
 *
 * WHY THIS SOURCE AND NOT A COMPETITOR'S LIST
 *
 * A catalogue entry is only useful if its `processNames` are the names the
 * game's binaries actually report to Windows. Guessing those, or copying them
 * out of somebody else's product, produces entries that look like support and
 * do nothing.
 *
 * Steam's `appinfo` carries `config.launch[].executable` -- the literal path
 * the Steam client execs when you press Play. It is not a description of the
 * game, it is the instruction Valve's own client follows, which makes it
 * first-party and checkable: anyone can re-run this script and diff it.
 *
 * WHICH GAMES GET ASKED ABOUT
 *
 * Three ranking sources are unioned, because the first one tried on its own
 * had holes big enough to lose Dota 2, Rainbow Six Siege and Marvel Rivals:
 *
 *   * `api.steampowered.com/ISteamChartsService/GetMostPlayedGames` --
 *     Valve's own most-played chart, by concurrent players. First-party, and
 *     the only one of the three that reflects what people are playing THIS
 *     week rather than what they have ever bought. Ranked first for exactly
 *     that reason: a catalogue ordered by lifetime owners opens on Half-Life
 *     and Counter-Strike 1.6.
 *   * `steamspy.com/api.php?request=top100in2weeks` -- recent activity.
 *   * `steamspy.com/api.php?request=all&page=N` -- owner estimates, for
 *     breadth below the charts.
 *
 * No SteamSpy field is published in the catalogue. They are used only to
 * decide which appids are worth looking up.
 *
 * WHAT IS DELIBERATELY DROPPED, because a wrong name is worse than a missing
 * game:
 *
 *   * Anything whose `common.type` is not `game` -- DLC, demos, videos,
 *     soundtracks, tools and applications.
 *   * Launch entries for other operating systems. `oslist` is checked rather
 *     than the extension, because a macOS entry can still end in `.exe` and a
 *     Windows entry can omit `oslist` entirely.
 *   * Launch entries gated behind `ownsdlc` -- level editors, workshop tools,
 *     benchmark harnesses. Separate products that ship in the same depot.
 *   * Names on GENERIC_NAMES below. See the comment there; this one is a
 *     correctness rule, not tidiness.
 *   * Names on SHIM_NAMES below -- anti-cheat bootstrappers that are not the
 *     process the game actually runs under.
 *
 * Beta branches (`betakey`) are KEPT. They are real builds of the same game
 * that a player may genuinely be running -- CS2's `csgo.exe` legacy branch is
 * the obvious case -- and the client resolves names against running
 * processes, so a branch nobody has installed simply never matches.
 *
 * Usage:
 *   node prisma/catalogue/tools/build-steam-tier.mjs [--pages 3] [--limit 1500]
 *
 * Responses are cached under `.appinfo-cache/` (gitignored) so a re-run after
 * a filter change costs no network at all.
 *
 * The output is committed. This is not run at build time or at seed time: it
 * reaches the network, and a seed that depends on a third-party endpoint
 * being up is a seed that fails in the one place it must not.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "steam-tier.json");
const CURATED = join(HERE, "..", "curated.json");
const CACHE = join(HERE, ".appinfo-cache");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const PAGES = argOf("--pages", 3);
const LIMIT = argOf("--limit", 1500);
const CONCURRENCY = argOf("--concurrency", 10);

/** Executable names too generic to identify a game.
 *
 * This is a correctness rule and it is worth being precise about why. The
 * desktop client resolves a catalogue name against EVERY running process and
 * adds the full path of whatever matched. `launcher.exe` appears in 52 of the
 * titles this script found and in an unknown number of programs that are not
 * games at all, so shipping it would route whichever unrelated
 * `launcher.exe` the customer happened to have open. That is a surprise the
 * customer never asked for, and on a censored network an unexpected program
 * on the tunnel is not a harmless surprise.
 *
 * Names that are shared but still specific stay: `hl2.exe` covers the Source
 * games and is genuinely the process each of them runs under, which is the
 * opposite case. */
const GENERIC_NAMES = new Set(
  JSON.parse(readFileSync(join(HERE, "..", "generic-names.json"), "utf8")).names.map((n) =>
    n.toLowerCase(),
  ),
);

/** Anti-cheat bootstrappers, which are not the process the game runs under.
 *
 * `start_protected_game.exe` is Easy Anti-Cheat's shim: Steam execs it, it
 * starts the real binary, and the real binary is what holds the game's
 * sockets. Routing the shim would route a process that has already exited.
 *
 * This is the mistake the competitor research records WTFast making -- it
 * keys on "the process running while the game is active, which is not
 * necessarily the process you run to start the game", and reviewers found
 * that picking the launcher optimised patch downloads instead of play. An
 * entry left with nothing but a shim is reported in `needsCuration` rather
 * than shipped, so somebody can add the real name from a publisher source. */
const SHIM_NAMES = new Set(["start_protected_game.exe", "eosbootstrapper.exe"]);
// (also present in generic-names.json; kept here so `shimmed` can be reported)

/** The provenance stamped on every row this script writes.
 *
 * Every generated row's names come from ONE place -- the launch config of
 * one Steam app -- and that single fact is what made the Jagex bug
 * invisible. `old-school-runescape` shipped `oslaunch.exe` / `osclient.exe`
 * straight out of Valve's config for app 1343370, and on 2026-08-26 a real
 * standalone Jagex install on the Windows test rig was found to contain
 * neither: it ships `JagexLauncher.exe` under
 * `%USERPROFILE%\jagexcache\jagexlauncher\bin\`. The row resolved nothing,
 * and nothing in the data said it might.
 *
 * Two properties, in the row itself rather than in a file header, because
 * the row is what a person reads when a customer reports a game doing
 * nothing, and because it is what reaches the database through
 * `toSeedRow`'s operator-facing `notes`:
 *
 *   1. these names describe the STEAM build, so a standalone or
 *      storefront-exclusive install is a known-possible mismatch;
 *   2. they were never observed on disk. Valve's config is first-party
 *      about how Steam starts the app; it is not a report of what a
 *      customer's machine has.
 *
 * The same field name the curated tier uses, on purpose: one concept, one
 * key, so a reader auditing a suspect row does not have to know which tier
 * it came from to know where to look. Held constant across rows -- the
 * appid that would make it specific is already in the row next door as
 * `steamAppId`, and repeating it here would only make the file harder to
 * diff after a rebuild. */
const GENERATED_SOURCE =
  "Valve appinfo config.launch[].executable -- Steam build only, not observed on disk";

/** Steam category ids that mean "this game talks to other people".
 * 1 = Multi-player, 20 = MMO, 36 = Online PvP, 38 = Online Co-op, 49 = PvP.
 * Used for ordering only: routing a strictly offline game through a relay
 * buys the customer nothing, so those sort below the online titles. */
const ONLINE_CATEGORIES = new Set(["1", "20", "36", "38", "49"]);

async function getJson(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "neoxify-catalogue-builder/1.0 (+contact via repo)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 5_000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === tries) throw err;
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  return null;
}

async function appInfo(appid) {
  const path = join(CACHE, `${appid}.json`);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* fall through and refetch */
    }
  }
  const body = await getJson(`https://api.steamcmd.net/v1/info/${appid}`);
  const app = body?.data?.[appid] ?? null;
  writeFileSync(path, JSON.stringify(app), "utf8");
  return app;
}

/** Turn a launch `executable` into the bare filename Windows will report, or
 * null if it is not something the split tunnel could ever match.
 *
 * Spaces are legal and common -- `Among Us.exe`, `Star Trek Online.exe` --
 * so only the characters Windows actually forbids in a filename are
 * rejected, plus control characters. */
const FORBIDDEN_IN_NAME = new RegExp("[<>:\"|?*\u0000-\u001f]");

function execName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.split(/[\\/]/).pop();
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed || !/\.exe$/i.test(trimmed)) return null;
  if (FORBIDDEN_IN_NAME.test(trimmed)) return null;
  return trimmed;
}

function windowsExecutables(app) {
  const launch = app?.config?.launch;
  if (!launch || typeof launch !== "object") return { names: [], shimmed: false };

  const entries = Object.values(launch).filter((entry) => {
    const cfg = entry?.config ?? {};
    const oslist = typeof cfg.oslist === "string" ? cfg.oslist : "";
    // An empty oslist means "every platform", which on a Windows-only
    // catalogue is a Windows entry.
    return !oslist || oslist.split(",").includes("windows");
  });

  // `ownsdlc` means two different things and the difference matters.
  //
  // Usually it gates a level editor or a workshop tool -- a separate product
  // in the same depot, which should not be catalogued as the game. But some
  // titles gate EVERY launch entry behind an edition DLC: Rainbow Six Siege
  // has eight, one per edition, all of them `RainbowSix.exe`. Dropping
  // ownsdlc entries unconditionally lost that game entirely, and it is not a
  // small one.
  //
  // So the rule is relative, not absolute: if the app has any ungated launch
  // entry, the gated ones are extras and are dropped. If it has none, the
  // gated ones are all there is and they are the game.
  const ungated = entries.filter((entry) => !(entry?.config ?? {}).ownsdlc);
  const usable = ungated.length > 0 ? ungated : entries;

  const names = [];
  const seen = new Set();
  let shimmed = false;
  for (const entry of usable) {
    const name = execName(entry?.executable);
    if (!name) continue;
    const key = name.toLowerCase();
    if (SHIM_NAMES.has(key)) {
      shimmed = true;
      continue;
    }
    if (GENERIC_NAMES.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return { names, shimmed };
}

const NON_ASCII = new RegExp("[^\u0020-\u007e]", "g");

/** ASCII kebab slug. Non-ASCII is stripped after NFKD rather than
 * transliterated: a title that reduces to nothing falls back to its appid,
 * which is stable and unique, instead of to a guess at romanisation. */
function slugify(name, appid) {
  const base = name
    .normalize("NFKD")
    .replace(NON_ASCII, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base || `steam-app-${appid}`;
}

async function rankedAppIds() {
  const order = [];
  const seen = new Set();
  const push = (appid, name) => {
    const id = String(appid);
    if (!id || seen.has(id)) return;
    seen.add(id);
    order.push({ appid: id, name });
  };

  // Valve's own chart first. This is the source that decides what the picker
  // opens on, so it should be what people are actually playing.
  try {
    const chart = await getJson(
      "https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/",
    );
    for (const row of chart?.response?.ranks ?? []) push(row.appid, null);
    console.log(`  valve most-played: ${order.length}`);
  } catch (err) {
    console.warn(`  valve most-played unavailable: ${err.message}`);
  }

  try {
    const recent = await getJson("https://steamspy.com/api.php?request=top100in2weeks");
    const before = order.length;
    for (const row of Object.values(recent ?? {})) push(row.appid, row.name);
    console.log(`  steamspy 2-week: +${order.length - before}`);
  } catch (err) {
    console.warn(`  steamspy 2-week unavailable: ${err.message}`);
  }

  for (let page = 0; page < PAGES; page += 1) {
    // SteamSpy asks for a minute between `all` pages. Honour it.
    if (page > 0) await new Promise((r) => setTimeout(r, 61_000));
    const before = order.length;
    const data = await getJson(`https://steamspy.com/api.php?request=all&page=${page}`);
    for (const row of Object.values(data ?? {})) push(row.appid, row.name);
    console.log(`  steamspy owners page ${page}: +${order.length - before}`);
  }

  return order;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });

  // Slugs and appids the hand-curated tier already owns. A curated entry is
  // built from first-party publisher documentation and covers the launcher
  // and the anti-cheat helper as well as the game, so it must win.
  let curatedSlugs = new Set();
  let curatedApps = new Set();
  try {
    const curated = JSON.parse(readFileSync(CURATED, "utf8"));
    curatedSlugs = new Set(curated.games.map((g) => g.slug));
    curatedApps = new Set(curated.games.flatMap((g) => (g.steamAppIds ?? []).map(String)));
    console.log(`curated tier owns ${curatedSlugs.size} slugs, ${curatedApps.size} appids`);
  } catch {
    console.warn("no curated.json yet -- proceeding without collision guard");
  }

  console.log("ranking:");
  const ranked = await rankedAppIds();
  console.log(`ranked ${ranked.length} apps; querying appinfo for top ${LIMIT}`);

  const targets = ranked.slice(0, LIMIT);
  const rank = new Map(ranked.map((r, i) => [r.appid, i]));
  const results = [];
  const needsCuration = [];
  const stats = { noInfo: 0, notGame: 0, noWindowsExe: 0, curatedSkip: 0 };
  const queue = [...targets];
  let done = 0;

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      done += 1;
      if (done % 200 === 0) console.log(`  ${done}/${targets.length}`);
      if (curatedApps.has(item.appid)) {
        stats.curatedSkip += 1;
        continue;
      }
      let app;
      try {
        app = await appInfo(item.appid);
      } catch {
        stats.noInfo += 1;
        continue;
      }
      if (!app) {
        stats.noInfo += 1;
        continue;
      }
      const common = app.common ?? {};
      const displayName = String(common.name ?? item.name ?? "").trim();
      if (common.type && String(common.type).toLowerCase() !== "game") {
        stats.notGame += 1;
        continue;
      }
      if (!displayName) {
        stats.notGame += 1;
        continue;
      }
      const { names, shimmed } = windowsExecutables(app);
      if (names.length === 0) {
        stats.noWindowsExe += 1;
        // Worth naming rather than silently dropping: an entry whose only
        // launch target was an anti-cheat shim or a generic `launcher.exe`
        // is a game we could support with one line of publisher
        // documentation, and this is the list of them.
        if (shimmed || app?.config?.launch) {
          needsCuration.push({
            appid: Number(item.appid),
            name: displayName,
            reason: shimmed ? "anti-cheat shim only" : "no specific windows executable",
          });
        }
        continue;
      }
      const categories = Object.keys(common.category ?? {}).map((k) =>
        k.replace("category_", ""),
      );
      const publisher =
        Object.values(common.associations ?? {})
          .filter((a) => a?.type === "publisher")
          .map((a) => a?.name)
          .filter(Boolean)[0] ?? null;
      results.push({
        slug: slugify(displayName, item.appid),
        displayName,
        publisher,
        processNames: names,
        steamAppId: Number(item.appid),
        source: GENERATED_SOURCE,
        online: categories.some((c) => ONLINE_CATEGORIES.has(c)),
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Steam carries several apps with the same display name (regional SKUs,
  // re-releases). Keep the better-ranked one at the clean slug and suffix the
  // rest with their appid rather than dropping them, since two apps with one
  // name are still two games.
  results.sort((a, b) => (rank.get(String(a.steamAppId)) ?? 1e9) - (rank.get(String(b.steamAppId)) ?? 1e9));
  const taken = new Set();
  const out = [];
  for (const row of results) {
    if (curatedSlugs.has(row.slug)) {
      stats.curatedSkip += 1;
      continue;
    }
    let slug = row.slug;
    if (taken.has(slug)) slug = `${slug}-${row.steamAppId}`;
    if (taken.has(slug)) continue;
    taken.add(slug);
    out.push({ ...row, slug });
  }

  // Online titles first, then by rank within each group.
  out.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (rank.get(String(a.steamAppId)) ?? 1e9) - (rank.get(String(b.steamAppId)) ?? 1e9);
  });

  const payload = {
    $comment:
      "GENERATED FILE -- do not hand-edit. Rebuild with " +
      "`node prisma/catalogue/tools/build-steam-tier.mjs`. " +
      "processNames come from Valve's own appinfo config.launch[].executable, " +
      "i.e. the command the Steam client runs. Hand-curated overrides belong " +
      "in curated.json, which wins on slug collision. needsCuration lists " +
      "titles whose only launch target was an anti-cheat shim or a name too " +
      "generic to match safely -- they are NOT shipped.",
    generatedAt: new Date().toISOString().slice(0, 10),
    source:
      "Valve appinfo via api.steamcmd.net; ranking from Valve GetMostPlayedGames plus steamspy",
    games: out,
    needsCuration: needsCuration.sort((a, b) => (rank.get(String(a.appid)) ?? 1e9) - (rank.get(String(b.appid)) ?? 1e9)),
  };
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `wrote ${out.length} entries to ${OUT}\n` +
      `  skipped: ${stats.notGame} not-a-game, ${stats.noWindowsExe} no usable windows exe, ` +
      `${stats.noInfo} no appinfo, ${stats.curatedSkip} owned by curated tier\n` +
      `  online: ${out.filter((g) => g.online).length}, offline: ${out.filter((g) => !g.online).length}\n` +
      `  needsCuration: ${needsCuration.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
