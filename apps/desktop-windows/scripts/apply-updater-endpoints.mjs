#!/usr/bin/env node
/** Points the auto-updater at the endpoints from the published bundle.
 *
 * The updater carries its own endpoint list, separate from the API bases,
 * and it was left entirely on the censored domain -- all three entries.
 * So a customer behind that block is never offered an update: the client
 * is fine, the release is published, and the one channel that would carry
 * the fix is the one channel that cannot be reached. The seed bundle does
 * not help here; Tauri reads this list from its own config.
 *
 * Written at build time rather than committed for the reason in
 * docs/node-address-hygiene.md: these names are only worth anything while
 * nobody has a list of them, and a public repo is a list.
 *
 * The committed config keeps the old endpoints as the last resort. They
 * still work everywhere the block does not reach, and a build without
 * network then degrades to exactly today's behaviour rather than to none.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "src", "lib", "seed-bundle.json");
const confPath = join(here, "..", "src-tauri", "tauri.conf.json");
const SUFFIX = "/updates/{{target}}/{{arch}}/{{current_version}}";

const fail = (why) => {
  if (process.env.NEOXIFY_REQUIRE_SEED === "1") {
    console.error(`updater-endpoints: REQUIRED but unavailable (${why})`);
    process.exit(1);
  }
  console.log(`updater-endpoints: left as committed (${why})`);
  process.exit(0);
};

let bundle;
try {
  const env = JSON.parse(readFileSync(seedPath, "utf8"));
  if (typeof env?.payload !== "string" || env.payload === "") fail("seed is the placeholder");
  bundle = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// Panel entries only. A node mirror can serve the manifest, but the
// installer it points at is a GitHub redirect either way, and keeping the
// updater on the panel keeps this list short and the fleet out of it.
const bases = (bundle.endpoints ?? [])
  .filter((e) => e.kind === "panel" && typeof e.url === "string")
  .map((e) => e.url.replace(/\/+$/, "") + SUFFIX);

if (bases.length === 0) fail("bundle carries no panel endpoints");

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const updater = conf.plugins?.updater;
if (!updater) fail("no updater plugin in tauri.conf.json");

const existing = Array.isArray(updater.endpoints) ? updater.endpoints : [];
// New first: the committed ones are unreachable for exactly the customers
// this exists for, so they must not be tried first.
const merged = [...bases, ...existing.filter((e) => !bases.includes(e))];
updater.endpoints = merged;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
console.log(`updater-endpoints: ${bases.length} from bundle + ${merged.length - bases.length} committed`);
