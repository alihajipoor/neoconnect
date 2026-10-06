#!/usr/bin/env node
/**
 * Offline signing for the endpoint bundle.
 *
 * The private key never goes near the panel, and that is the whole point
 * of the tool existing rather than the backend signing for itself. This
 * key is the root of trust for redirecting every client the product has:
 * anyone holding it can point the entire customer base at their own
 * servers, silently, and the clients would be right to believe them. The
 * panel is a rented box that a censor, a host, or a court can reach.
 * These two facts do not belong in the same place.
 *
 * So the panel only ever serves a blob it cannot forge, and the signing
 * happens on a machine the owner controls.
 *
 * Usage:
 *   node scripts/endpoints/bundle.mjs keygen --out ./keys
 *   node scripts/endpoints/bundle.mjs sign  --in bundle.json \
 *        --key ./keys/primary.key --key-id primary --out endpoints.signed.json \
 *        [--previous last.signed.json]   (warns about hosts clients will refuse)
 *   node scripts/endpoints/bundle.mjs verify --in endpoints.signed.json --pub <base64>
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleHosts, inScope } from "../../apps/desktop-windows/scripts/capability-scope-globs.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    die(`missing --${name}`);
  }
  return process.argv[i + 1];
}
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Raw 32 bytes, via JWK. Node's DER export carries a header that would
 * have to be stripped by offset, and an off-by-one there produces a key
 * that verifies nothing and looks like a signing bug. */
function rawPublic(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

function cmdKeygen() {
  const out = arg("out", "./keys");
  mkdirSync(out, { recursive: true });
  const printed = {};
  // Two, always. A client that knows one key cannot be rotated onto
  // another without a release, and a release cannot reach the censored
  // users who most need it. The spare is free today and unaddable later.
  for (const id of ["primary", "backup"]) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const path = join(out, `${id}.key`);
    writeFileSync(path, pem, { mode: 0o600 });
    printed[id] = rawPublic(publicKey).toString("base64");
    console.error(`wrote ${path} (mode 600)`);
  }
  console.error("\nCompile these into the client as BUNDLE_KEYS:\n");
  console.log(JSON.stringify(printed, null, 2));
  console.error(
    "\nBack the .key files up offline. They are not recoverable, and losing\n" +
      "both of them means every shipped client can never be redirected again.",
  );
}

/** Says, loudly, which hosts in this bundle installed clients will refuse.
 *
 * A client's HTTP permission is fixed when it is built, from the seed
 * bundle it shipped with (apps/desktop-windows/scripts/
 * capability-scope-globs.mjs), and nothing widens it at runtime. A host
 * outside that scope is refused on the device before a request is sent,
 * so a bundle that rotates customers onto one reaches nobody until they
 * update -- the opposite of what a bundle is for, and silent unless this
 * says so. Not a refusal to sign: adding a host for the next release is
 * legitimate, as long as nobody is relying on it to reach today's users.
 *
 * `--previous` is the last signed bundle, the closest stand-in for what
 * shipped builds carry. */
function warnOutsideShippedScope(bundle, previousPath) {
  if (!previousPath) {
    console.error(
      "note: pass --previous <last signed bundle> to check which hosts installed clients can call",
    );
    return;
  }
  const envelope = JSON.parse(readFileSync(previousPath, "utf8"));
  const previous = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const known = bundleHosts(previous);
  const fresh = [...bundleHosts(bundle)].filter((host) => !known.has(host));
  const outside = fresh.filter((host) => !inScope(host, known));
  if (outside.length > 0) {
    console.error(
      `\nWARNING: ${outside.length} host(s) in this bundle are outside the HTTP scope of ` +
        "clients built from the previous one.\nInstalled clients will refuse them locally " +
        "until they update; only builds made from a seed that includes them can use them:",
    );
    for (const host of outside) console.error(`  ${host}`);
    console.error("");
  }
  // Inside the domain wildcard, but only for builds that have one:
  // desktop 0.9.44 / mobile 0.2.23 and earlier scoped exact hosts only.
  const wildcardOnly = fresh.filter((host) => inScope(host, known));
  if (wildcardOnly.length > 0) {
    console.error(
      `note: ${wildcardOnly.length} new host(s) are reachable only by builds with the domain ` +
        "wildcard (after desktop 0.9.44 / mobile 0.2.23); older installs refuse them.",
    );
  }
}

function cmdSign() {
  const inPath = arg("in");
  const keyPath = arg("key");
  const keyId = arg("key-id", "primary");
  const outPath = arg("out", "");

  const bundle = JSON.parse(readFileSync(inPath, "utf8"));
  if (typeof bundle.v !== "number") die("bundle has no numeric `v`");
  if (!Array.isArray(bundle.endpoints) || bundle.endpoints.length === 0) {
    die("bundle has no endpoints -- signing this would strand every client that took it");
  }
  const http = bundle.endpoints.filter((e) => !String(e.url ?? "").startsWith("https://"));
  if (http.length) die(`refusing to sign ${http.length} non-https endpoint(s)`);
  warnOutsideShippedScope(bundle, arg("previous", ""));

  // Sign the exact bytes that will be published. Re-serialising on the
  // verifying side is where signature checks quietly become decorative.
  const payload = Buffer.from(JSON.stringify(bundle), "utf8");
  const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  const signature = sign(null, payload, privateKey);

  const envelope = {
    payload: payload.toString("base64"),
    sig: signature.toString("base64"),
    key: keyId,
  };
  const text = JSON.stringify(envelope);

  // Verified before it leaves, against the public half of the key just
  // used. Publishing a bundle nobody can verify is an outage delivered
  // to every client at once.
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, payload, publicKey, signature)) die("self-check failed; not writing");

  if (outPath) {
    writeFileSync(outPath, text);
    console.error(`signed v${bundle.v} (${bundle.endpoints.length} endpoints) -> ${outPath}`);
    console.error(`public key: ${rawPublic(publicKey).toString("base64")}`);
  } else {
    process.stdout.write(text);
  }
}

function cmdVerify() {
  const envelope = JSON.parse(readFileSync(arg("in"), "utf8"));
  const pub = Buffer.from(arg("pub"), "base64");
  const payload = Buffer.from(envelope.payload, "base64");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") },
    format: "jwk",
  });
  const ok = verify(null, payload, key, Buffer.from(envelope.sig, "base64"));
  const bundle = JSON.parse(payload.toString("utf8"));
  console.log(`signature: ${ok ? "OK" : "BAD"}  key=${envelope.key}  v=${bundle.v}  endpoints=${bundle.endpoints.length}`);
  process.exit(ok ? 0 : 1);
}

const command = process.argv[2];
if (command === "keygen") cmdKeygen();
else if (command === "sign") cmdSign();
else if (command === "verify") cmdVerify();
else die("usage: bundle.mjs <keygen|sign|verify> [...]");
