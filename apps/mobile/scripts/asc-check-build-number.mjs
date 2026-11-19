#!/usr/bin/env node
/** Refuses an iOS build number App Store Connect would refuse.
 *
 * An upload whose CFBundleVersion is not above every build already sent
 * is rejected -- but only after a macOS runner has spent most of an hour
 * building, signing and uploading it. So release-ios.yml asks first, on a
 * Linux runner, with the same API key the upload uses.
 *
 * Stricter than Apple on purpose: Apple wants the number above the others
 * in the same version train, this wants it above every build of the app,
 * which is the rule build-ios.sh already states for a Mac upload.
 *
 * Reads ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8 (the .p8
 * file's text, never a path) and WANT_BUILD from the environment. Node
 * built-ins only, so the job running it needs no install. Prints nothing
 * derived from the key.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message) => {
  console.error(`asc-check-build-number: ${message}`);
  process.exit(1);
};

const keyId = process.env.ASC_API_KEY_ID;
const issuer = process.env.ASC_API_ISSUER_ID;
const p8 = (process.env.ASC_API_KEY_P8 || "").replace(/\r/g, "");
const want = process.env.WANT_BUILD || "";
if (!keyId || !issuer || !p8) fail("ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8 are all needed");
if (!/^\d+(\.\d+){0,2}$/.test(want)) fail(`build number "${want}" is not 1-3 period-separated integers`);

const here = dirname(fileURLToPath(import.meta.url));
const bundleId = JSON.parse(
  readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"),
).identifier;

let key;
try {
  key = createPrivateKey(p8);
} catch {
  fail("ASC_API_KEY_P8 is not a readable private key -- paste the whole .p8 file, BEGIN and END lines included");
}

// App Store Connect's token: ES256, at most 20 minutes, this audience.
const b64url = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned =
  b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })) +
  "." +
  b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
const token = `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))}`;

const get = async (path) => {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    // Apple's error body names the problem (a revoked key, a missing
    // role) and carries nothing secret.
    fail(`${path.split("?")[0]} answered HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.json();
};

// Numbers compared as numbers, part by part: 9 < 10, and 25 < 25.1.
const compare = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

// filter[bundleId] also matches longer ids, so the exact one is picked.
const apps = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId`);
const app = apps.data.find((a) => a.attributes.bundleId === bundleId);
if (!app) fail(`no app with bundle id ${bundleId} is visible to this key`);

// The 200 most recent uploads. The highest number is always among them,
// because every upload has had to be higher than the ones before it.
const builds = await get(
  `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200&fields[builds]=version,uploadedDate`,
);
const versions = builds.data.map((b) => b.attributes.version).filter((v) => /^\d+(\.\d+){0,2}$/.test(v));
const highest = versions.reduce((max, v) => (max === null || compare(v, max) > 0 ? v : max), null);

if (highest === null) {
  console.log(`App Store Connect has no builds of ${bundleId}; ${want} is free.`);
} else if (compare(want, highest) <= 0) {
  fail(`build number ${want} is not above ${highest}, the highest already uploaded. Use ${Number(highest.split(".")[0]) + 1} or more.`);
} else {
  console.log(`build number ${want} is above ${highest}, the highest of ${versions.length} uploaded builds.`);
}
