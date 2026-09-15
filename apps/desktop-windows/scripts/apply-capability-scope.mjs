#!/usr/bin/env node
/** Lets the app actually call the endpoints the bundle gives it.
 *
 * Tauri's HTTP plugin refuses any URL outside the capability allowlist,
 * before the request leaves the device. The allowlist named one domain;
 * the signed bundle hands the app endpoints on several others. So every
 * address the bundle exists to provide was rejected locally, the app
 * fell through to the compiled-in list -- blocked in Iran, which is
 * precisely who the bundle is for -- and a new customer with no cached
 * mirrors could not register at all.
 *
 * This is the second time that exact gap has shipped. The first is
 * written up in api-endpoints.scope.test.ts, which was added to catch
 * it and did not, because it only checked the compiled-in list and the
 * bundle's endpoints are not in it.
 *
 * Generated at build time rather than committed, for the reason in
 * docs/node-address-hygiene.md: a capability file naming every
 * replacement domain is the enumeration the domains exist to avoid.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "src", "lib", "seed-bundle.json");
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: apply-capability-scope.mjs <capabilities.json> [...]");
  process.exit(2);
}

const fail = (why) => {
  if (process.env.NEOXIFY_REQUIRE_SEED === "1") {
    console.error(`capability-scope: REQUIRED but unavailable (${why})`);
    process.exit(1);
  }
  console.log(`capability-scope: left as committed (${why})`);
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

// One pair of globs per registrable host in the bundle: bare and with a
// port, because the mirrors are on a non-default port and Tauri treats
// those as different origins.
const hosts = new Set();
for (const e of bundle.endpoints ?? []) {
  if (typeof e?.url !== "string") continue;
  try { hosts.add(new URL(e.url).hostname); } catch { /* skip a malformed entry */ }
}
if (hosts.size === 0) fail("bundle names no hosts");

for (const file of targets) {
  const cap = JSON.parse(readFileSync(file, "utf8"));
  const http = (cap.permissions ?? []).find(
    (p) => typeof p === "object" && p !== null && p.identifier === "http:default",
  );
  if (!http) fail(`no http:default permission in ${file}`);
  const existing = new Set((http.allow ?? []).map((a) => a.url));
  let added = 0;
  for (const h of hosts) {
    for (const url of [`https://${h}/*`, `https://${h}:*/*`]) {
      if (!existing.has(url)) { http.allow.push({ url }); existing.add(url); added++; }
    }
  }
  writeFileSync(file, JSON.stringify(cap, null, 2) + "\n");
  console.log(`capability-scope: ${file.split("/").slice(-3).join("/")} +${added} glob(s) for ${hosts.size} host(s)`);
}
