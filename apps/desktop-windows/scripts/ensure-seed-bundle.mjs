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
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "lib", "seed-bundle.json");
const placeholder = join(here, "..", "src", "lib", "seed-bundle.placeholder.json");
const url =
  process.env.NEOXIFY_BUNDLE_URL ?? "https://connect.neoxify.site/api/endpoints/bundle";

const fallback = (why) => {
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
  const parsed = JSON.parse(raw);
  // Shape-checked, not signature-checked: verification is the client's
  // job and happens on every read anyway. This only refuses to bake in
  // something that plainly is not a bundle.
  if (typeof parsed?.payload !== "string" || typeof parsed?.sig !== "string") {
    throw new Error("not a signed envelope");
  }
  const decoded = JSON.parse(Buffer.from(parsed.payload, "base64").toString("utf8"));
  if (!Array.isArray(decoded?.endpoints) || decoded.endpoints.length === 0) {
    throw new Error("bundle carries no endpoints");
  }
  writeFileSync(out, JSON.stringify(parsed));
  console.log(`seed-bundle: v${decoded.v}, ${decoded.endpoints.length} endpoints`);
} catch (err) {
  fallback(err instanceof Error ? err.message : String(err));
}
