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
 * Server-signed lists (2026-10-18). Waiting for the owner on every list
 * meant the list never followed the servers. A compiled-in key may now
 * vouch for a server key until a date (`vouch`): the server signs lists
 * itself under that statement, served at /endpoints/bundle2, and clients
 * from this change on check the statement before the list
 * (`ServerKeyStatement` in apps/desktop-windows/src/lib/endpoint-bundle.ts).
 * The compiled-in keys never leave this machine; a stolen server key is
 * worth what a stolen list is, until the statement expires.
 *
 * Usage:
 *   node scripts/endpoints/bundle.mjs keygen --out ./keys
 *   node scripts/endpoints/bundle.mjs sign  --in bundle.json \
 *        --key ./keys/primary.key --key-id primary --out endpoints.signed.json \
 *        [--previous last.signed.json]   (warns about hosts clients will refuse)
 *   node scripts/endpoints/bundle.mjs verify --in endpoints.signed.json --pub <base64>
 *
 *   node scripts/endpoints/bundle.mjs server-key --id server-1 --out ./server-keys
 *   node scripts/endpoints/bundle.mjs vouch --key ./keys/primary.key --key-id primary \
 *        --id server-1 --server-pub <base64> --days 365 --out server-1.statement.json
 *   node scripts/endpoints/bundle.mjs sign --in bundle.json --key ./server-keys/server-1.key \
 *        --key-id server-1 --cert server-1.statement.json --out bundle2.signed.json
 *   (verify takes the compiled-in key's --pub for a server-signed list too)
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

/** `ServerKeyStatement` in endpoint-bundle.ts and bundle_scope.rs. */
const STATEMENT_KIND = "neoxify-bundle-key";
const COMPILED_IN = new Set(["primary", "backup"]);

/** A statement's fields, read off a `vouch` output, or a death. */
function readStatement(cert) {
  if (typeof cert?.payload !== "string" || typeof cert?.sig !== "string" || !COMPILED_IN.has(cert?.key)) {
    die("--cert is not a statement by a compiled-in key (run `vouch`)");
  }
  return JSON.parse(Buffer.from(cert.payload, "base64").toString("utf8"));
}

function cmdServerKey() {
  const id = arg("id");
  const out = arg("out", "./server-keys");
  if (COMPILED_IN.has(id) || !/^[a-z0-9-]{1,32}$/.test(id)) die("--id must be a short lower-case name, not primary or backup");
  mkdirSync(out, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const path = join(out, `${id}.key`);
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  console.error(`wrote ${path} (mode 600)`);
  console.log(rawPublic(publicKey).toString("base64"));
}

/** A compiled-in key's statement that `--id` (public half `--server-pub`)
 * may sign lists for `--days`. Signed with the offline key; the output is
 * public, published inside every list the server signs. */
function cmdVouch() {
  const keyPath = arg("key");
  const keyId = arg("key-id", "primary");
  const id = arg("id");
  const serverPub = Buffer.from(arg("server-pub"), "base64");
  const days = Number(arg("days", "365"));
  const outPath = arg("out");
  if (!COMPILED_IN.has(keyId)) die("--key-id must be a compiled-in key: primary or backup");
  if (COMPILED_IN.has(id)) die("--id may not be a compiled-in key's name");
  if (serverPub.length !== 32) die("--server-pub must be a 32-byte Ed25519 public key, base64");
  if (!Number.isFinite(days) || days <= 0 || days > 730) die("--days must be 1 to 730");
  const statement = {
    kind: STATEMENT_KIND,
    id,
    publicKey: serverPub.toString("base64"),
    expires: Math.floor(Date.now() / 1000) + Math.round(days * 86_400),
  };
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  const signature = sign(null, payload, privateKey);
  if (!verify(null, payload, createPublicKey(privateKey), signature)) die("self-check failed; not writing");
  writeFileSync(outPath, JSON.stringify({ payload: payload.toString("base64"), sig: signature.toString("base64"), key: keyId }));
  console.error(`${keyId} vouches for ${id} until ${new Date(statement.expires * 1000).toISOString()} -> ${outPath}`);
}

function cmdSign() {
  const inPath = arg("in");
  const keyPath = arg("key");
  const keyId = arg("key-id", "primary");
  const outPath = arg("out", "");
  const certPath = arg("cert", "");

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

  // Verified before it leaves, against the public half of the key just
  // used. Publishing a bundle nobody can verify is an outage delivered
  // to every client at once.
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, payload, publicKey, signature)) die("self-check failed; not writing");

  // A server key's list carries the statement that lets clients trust it,
  // and is refused here when clients would refuse it: another key's
  // statement, or one that has run out.
  if (certPath) {
    const cert = JSON.parse(readFileSync(certPath, "utf8"));
    const statement = readStatement(cert);
    if (statement.kind !== STATEMENT_KIND || statement.id !== keyId) die(`--cert is not a statement for ${keyId}`);
    if (statement.publicKey !== rawPublic(publicKey).toString("base64")) die("--cert vouches for another key than --key");
    if (Date.now() >= statement.expires * 1000) die("--cert has expired; vouch again with the offline key");
    envelope.cert = { payload: cert.payload, sig: cert.sig, key: cert.key };
  } else if (!COMPILED_IN.has(keyId)) {
    die(`${keyId} is not a compiled-in key: pass the --cert that vouches for it`);
  }
  const text = JSON.stringify(envelope);

  if (outPath) {
    writeFileSync(outPath, text);
    console.error(`signed v${bundle.v} (${bundle.endpoints.length} endpoints) -> ${outPath}`);
    console.error(`public key: ${rawPublic(publicKey).toString("base64")}`);
  } else {
    process.stdout.write(text);
  }
}

function ed25519(raw) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** `--pub` is the compiled-in key's public half; a server-signed list is
 * checked through its statement, as a client checks it. */
function cmdVerify() {
  const envelope = JSON.parse(readFileSync(arg("in"), "utf8"));
  let signer = ed25519(Buffer.from(arg("pub"), "base64"));
  let via = "";
  if (envelope.cert && !COMPILED_IN.has(envelope.key)) {
    const statementBytes = Buffer.from(envelope.cert.payload, "base64");
    if (!verify(null, statementBytes, signer, Buffer.from(envelope.cert.sig, "base64"))) {
      console.log(`statement: BAD  by=${envelope.cert.key}`);
      process.exit(1);
    }
    const statement = JSON.parse(statementBytes.toString("utf8"));
    const live = Date.now() < statement.expires * 1000;
    if (statement.kind !== STATEMENT_KIND || statement.id !== envelope.key || !live) {
      console.log(`statement: REFUSED  for=${statement.id} expires=${new Date(statement.expires * 1000).toISOString()}`);
      process.exit(1);
    }
    signer = ed25519(Buffer.from(statement.publicKey, "base64"));
    via = `  via=${envelope.cert.key} until ${new Date(statement.expires * 1000).toISOString()}`;
  }
  const payload = Buffer.from(envelope.payload, "base64");
  const ok = verify(null, payload, signer, Buffer.from(envelope.sig, "base64"));
  const bundle = JSON.parse(payload.toString("utf8"));
  console.log(`signature: ${ok ? "OK" : "BAD"}  key=${envelope.key}${via}  v=${bundle.v}  endpoints=${bundle.endpoints.length}`);
  process.exit(ok ? 0 : 1);
}

const command = process.argv[2];
if (command === "keygen") cmdKeygen();
else if (command === "server-key") cmdServerKey();
else if (command === "vouch") cmdVouch();
else if (command === "sign") cmdSign();
else if (command === "verify") cmdVerify();
else die("usage: bundle.mjs <keygen|server-key|vouch|sign|verify> [...]");
