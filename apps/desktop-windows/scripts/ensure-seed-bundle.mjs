#!/usr/bin/env node
/** Puts the published endpoint bundle into the binary at build time.
 *
 * The bundle only ever helped a client that had already reached us once,
 * because a fresh install has nothing cached and every compiled-in base
 * is on the censored domain. That is the exact customer the bundle was
 * written for, and they were the one customer it could not serve.
 *
 * Fetched at build rather than committed: the file names every node
 * mirror, and docs/node-address-hygiene.md keeps those out of the public
 * repo. Shipping them inside a binary is a different bargain -- a censor
 * has to obtain and unpack a build, instead of grepping GitHub.
 *
 * Falls back to an inert placeholder so a build without network still
 * produces a working app; it simply carries no seed.
 *
 * But never over a seed that is already there. This runs more than once
 * per release: the workflows fetch the seed in their own step with
 * NEOXIFY_REQUIRE_SEED set, and then `tauri build` runs `pnpm build`,
 * whose prebuild hook runs this again *without* it. A transient failure
 * on that second fetch used to copy the placeholder over the seed the
 * first one had just fetched -- and the build went on to ship with no
 * seed, which is the failure the required step exists to prevent,
 * reintroduced one step later. A failed refetch now keeps a valid seed
 * that is already on disk, and says so.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Overridable only so the test can point it somewhere disposable.
const out = process.env.NEOXIFY_SEED_PATH ?? join(here, "..", "src", "lib", "seed-bundle.json");
const placeholder = join(here, "..", "src", "lib", "seed-bundle.placeholder.json");
const url =
  process.env.NEOXIFY_BUNDLE_URL ?? "https://connect.neoxify.site/api/endpoints/bundle";

/** The decoded bundle in a signed envelope, or null if it is not one
 * that carries endpoints -- the placeholder included. */
const decodeSeed = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.payload !== "string" || parsed.payload === "" || typeof parsed?.sig !== "string") {
      return null;
    }
    const decoded = JSON.parse(Buffer.from(parsed.payload, "base64").toString("utf8"));
    return Array.isArray(decoded?.endpoints) && decoded.endpoints.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

const fallback = (why) => {
  // A seed already on disk beats no seed. It was fetched by this build's
  // own required step, or by an earlier run on this machine; either way
  // it is a real, signed list, and the placeholder is none at all.
  const existing = existsSync(out) ? decodeSeed(readFileSync(out, "utf8")) : null;
  if (existing) {
    console.log(
      `seed-bundle: kept existing v${existing.v}, ${existing.endpoints.length} endpoints (refetch failed: ${why})`,
    );
    return;
  }
  // A release build that quietly falls back ships exactly the bug this
  // file exists to fix, and nothing about the installer would look wrong.
  // CI sets NEOXIFY_REQUIRE_SEED so that failure is loud instead.
  if (process.env.NEOXIFY_REQUIRE_SEED === "1") {
    console.error(`seed-bundle: REQUIRED but unavailable (${why})`);
    process.exit(1);
  }
  copyFileSync(placeholder, out);
  console.log(`seed-bundle: placeholder (${why})`);
};

if (process.env.NEOXIFY_SKIP_SEED === "1") {
  if (!existsSync(out)) fallback("skipped by env");
  process.exit(0);
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const raw = await res.text();
  // Shape-checked, not signature-checked: verification is the client's
  // job and happens on every read anyway. This only refuses to bake in
  // something that plainly is not a bundle.
  const decoded = decodeSeed(raw);
  if (!decoded) throw new Error("not a signed envelope carrying endpoints");
  writeFileSync(out, JSON.stringify(JSON.parse(raw)));
  console.log(`seed-bundle: v${decoded.v}, ${decoded.endpoints.length} endpoints`);
} catch (err) {
  fallback(err instanceof Error ? err.message : String(err));
}
