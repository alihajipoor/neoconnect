#!/usr/bin/env node
/**
 * Copies the signed endpoint lists into a public GitHub repository, which
 * jsDelivr mirrors.
 *
 * A signed list is as good as the original wherever it is fetched from
 * (endpoint-bundle.ts), so it can sit on hosts that are not ours. This
 * fetches the two lists the panel serves today -- /endpoints/bundle,
 * signed offline, and /endpoints/bundle2, signed by the server under a
 * compiled-in key's statement -- checks each with `bundle.mjs verify`
 * against the keys compiled into the apps, and writes it into a checkout
 * of the copies repository exactly as served, byte for byte. A copy is
 * replaced only by a higher version, since that is all a client takes;
 * anything else is reported and left alone.
 *
 * The copies repository holds those two files and nothing else -- no
 * README, licence or workflow -- so a checkout with any other file in it
 * is refused. Its name is not written in this repository: pass --github,
 * or let it be read off the checkout's origin.
 *
 * Usage:
 *   node scripts/endpoints/publish-copies.mjs --dry-run [--repo <checkout>] [--github <owner>/<repo>]
 *   node scripts/endpoints/publish-copies.mjs --repo <checkout> [--push [--no-purge]]
 *     --api <base>   the panel API (default https://connect.neoxify.site/api)
 *     --dry-run      fetch and verify, say what would change, write nothing
 *     --push         push the commit, then ask jsDelivr to drop its cached
 *                    copies (unless --no-purge)
 *
 * Exit 0 when every published list is copied or already current; 1 when
 * anything was refused or failed. A list that verified is copied either
 * way.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_TOOL = join(here, "bundle.mjs");
/** Where the apps' compiled-in keys are written down; bundle_scope.rs
 * carries the same two, and a test holds them equal. */
const KEYS_SOURCE = join(here, "..", "..", "apps", "desktop-windows", "src", "lib", "endpoint-bundle.ts");
const DEFAULT_API = "https://connect.neoxify.site/api";
// Overridable only so the test can answer the purge itself.
const PURGE_BASE = process.env.NEOXIFY_PURGE_BASE ?? "https://purge.jsdelivr.net";

/** The two lists, under the file names they keep in the copies repository. */
const SLOTS = [
  { file: "bundle.json", path: "/endpoints/bundle", server: false },
  { file: "bundle2.json", path: "/endpoints/bundle2", server: true },
];
/** The compiled-in key ids, as bundle.mjs and the apps name them. */
const COMPILED_IN = new Set(["primary", "backup"]);
/** `SERVER_SIGNED_FIRST_VERSION` in the backend's endpoints.service.ts. */
const SERVER_FIRST_VERSION = 100;
/** Warn this long before a server key's statement runs out. */
const STATEMENT_WARN_DAYS = 30;

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const OPTIONS = new Set(["repo", "api", "github"]);
const FLAGS = new Set(["dry-run", "push", "no-purge"]);

function parseArgs(argv) {
  const opts = { api: DEFAULT_API, dryRun: false, push: false, purge: true };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || (!OPTIONS.has(name) && !FLAGS.has(name))) die(`unknown argument ${argv[i]}`);
    if (FLAGS.has(name)) {
      if (name === "dry-run") opts.dryRun = true;
      if (name === "push") opts.push = true;
      if (name === "no-purge") opts.purge = false;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) die(`--${name} needs a value`);
    opts[name] = value;
    i += 1;
  }
  if (!/^https?:\/\/[^/]/.test(opts.api)) die("--api must be an http(s) URL");
  opts.api = opts.api.replace(/\/+$/, "");
  if (opts.github !== undefined && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(opts.github)) {
    die("--github must be <owner>/<repo>");
  }
  if (!opts.dryRun && opts.repo === undefined) die("pass --repo <checkout of the copies repository>, or --dry-run");
  if (opts.push && opts.repo === undefined) die("--push needs --repo");
  return opts;
}

/** The apps' compiled-in public keys, by id, read from their source so
 * there is no third copy of them to drift. */
function compiledInKeys() {
  const override = process.env.NEOXIFY_TEST_BUNDLE_KEYS;
  if (override) {
    console.error("warning: trusting NEOXIFY_TEST_BUNDLE_KEYS instead of the apps' keys (tests only)");
    return JSON.parse(override);
  }
  const source = readFileSync(KEYS_SOURCE, "utf8");
  const block = /export const BUNDLE_KEYS[^=]*=\s*\{([\s\S]*?)\};/.exec(source)?.[1] ?? "";
  const keys = Object.fromEntries([...block.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const id of COMPILED_IN) {
    if (Buffer.from(keys[id] ?? "", "base64").length !== 32) die(`no 32-byte ${id} key in ${KEYS_SOURCE}`);
  }
  return keys;
}

/** As strict as the apps (`fromBase64` in endpoint-bundle.ts): a list any
 * copy spells differently is one they refuse. */
function canonicalBase64(value) {
  return (
    typeof value === "string" &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function decodeJson(base64) {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

/** The compiled-in key that answers for `envelope` in `slot`, or a throw
 * saying why the envelope does not belong there. The offline list is
 * signed by a compiled-in key itself (clients from before statements
 * read it and refuse a `cert`); the server list carries the statement
 * of one. */
function signerFor(envelope, slot) {
  if (typeof envelope !== "object" || envelope === null) throw new Error("not a signed envelope");
  if (!canonicalBase64(envelope.payload) || !canonicalBase64(envelope.sig)) {
    throw new Error("payload or sig is not canonical base64");
  }
  if (typeof envelope.key !== "string") throw new Error("names no key");
  if (!slot.server) {
    if (!COMPILED_IN.has(envelope.key) || envelope.cert !== undefined) {
      throw new Error("is not signed by a compiled-in key itself, as the offline list must be");
    }
    return envelope.key;
  }
  const cert = envelope.cert;
  if (COMPILED_IN.has(envelope.key) || typeof cert !== "object" || cert === null) {
    throw new Error("is not signed under a statement, as a server list must be");
  }
  if (!canonicalBase64(cert.payload) || !canonicalBase64(cert.sig) || !COMPILED_IN.has(cert.key)) {
    throw new Error("carries a statement that is not a compiled-in key's");
  }
  return cert.key;
}

/** `bundle.mjs verify`, the check the apps make, on the exact bytes. */
function verifyWithTool(raw, publicKey) {
  const dir = mkdtempSync(join(tmpdir(), "list-copy-"));
  try {
    const file = join(dir, "list.json");
    writeFileSync(file, raw);
    const result = spawnSync(process.execPath, [BUNDLE_TOOL, "verify", "--in", file, "--pub", publicKey], {
      encoding: "utf8",
    });
    const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).pop() ?? "";
    return { ok: result.status === 0 && /^signature: OK\b/m.test(result.stdout ?? ""), said };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The list inside a verified envelope, or a throw if no client would
 * use it (`verifyBundle` in endpoint-bundle.ts). */
function usableList(envelope, slot) {
  const list = decodeJson(envelope.payload);
  if (typeof list?.v !== "number" || !Number.isFinite(list.v)) throw new Error("has no numeric version");
  if (typeof list.issuedAt !== "string") throw new Error("has no issuedAt");
  const reachable = Array.isArray(list.endpoints)
    ? list.endpoints.filter(
        (e) => (e?.kind === "panel" || e?.kind === "mirror") && typeof e.url === "string" && e.url.startsWith("https://"),
      )
    : [];
  if (reachable.length === 0) throw new Error("lists no endpoint a client would use");
  if (slot.server && list.v < SERVER_FIRST_VERSION) {
    throw new Error(`is v${list.v}; a server list is v${SERVER_FIRST_VERSION} or higher`);
  }
  return list;
}

async function fetchList(api, slot) {
  let res;
  try {
    res = await fetch(`${api}${slot.path}`, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { error: `could not fetch ${slot.path}: ${err?.cause?.code ?? err?.message ?? err}` };
  }
  // The panel's answer for "none published yet" (endpoints.service.ts).
  if (res.status === 404) return { missing: true };
  if (!res.ok) return { error: `${slot.path} answered HTTP ${res.status}` };
  return { raw: Buffer.from(await res.arrayBuffer()) };
}

function git(repo, args, { buffer = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: buffer ? "buffer" : "utf8" });
  if (result.error) die(`git: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = buffer ? result.stderr.toString("utf8") : result.stderr;
    const error = new Error(`git ${args.join(" ")}: ${stderr.trim()}`);
    error.gitFailed = true;
    throw error;
  }
  return result.stdout;
}

/** git, with a failure ending the run. */
function mustGit(repo, args, options) {
  try {
    return git(repo, args, options);
  } catch (err) {
    return die(err.message);
  }
}

/** `<owner>/<repo>` from a GitHub remote URL, or null. */
function githubSlug(remoteUrl) {
  const match = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** What the checkout is, after refusing one that holds anything but the
 * lists or has changes of its own. */
function openCheckout(repo) {
  let prefix;
  try {
    prefix = git(repo, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    die(`${repo} is not a git checkout`);
  }
  if (prefix !== "") die(`${repo} is inside a checkout, not the top of one`);
  const allowed = new Set(SLOTS.map((s) => s.file));
  const tracked = mustGit(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const others = tracked.filter((file) => !allowed.has(file));
  if (others.length > 0) {
    die(
      `the copies repository may hold only ${[...allowed].join(" and ")}; it also has ` +
        `${others.slice(0, 5).join(", ")}${others.length > 5 ? ", ..." : ""}. Create it empty.`,
    );
  }
  const dirty = mustGit(repo, ["status", "--porcelain", "--untracked-files=all"]).trim();
  if (dirty !== "") die(`${repo} has changes of its own; commit or discard them first:\n${dirty}`);
  let branch = "main";
  try {
    branch = git(repo, ["symbolic-ref", "--short", "HEAD"]).trim();
  } catch {
    die(`${repo} is not on a branch`);
  }
  let upstream = null;
  try {
    upstream = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
  } catch {
    upstream = null;
  }
  let origin = null;
  try {
    origin = git(repo, ["remote", "get-url", "origin"]).trim();
  } catch {
    origin = null;
  }
  return { repo, branch, upstream, origin };
}

/** The version of the copy already in the checkout: null when there is
 * none, NaN when it cannot be read. */
function copyVersion(path) {
  if (!existsSync(path)) return { raw: null, v: null };
  const raw = readFileSync(path);
  try {
    const v = decodeJson(JSON.parse(raw.toString("utf8")).payload).v;
    return { raw, v: typeof v === "number" && Number.isFinite(v) ? v : Number.NaN };
  } catch {
    return { raw, v: Number.NaN };
  }
}

/** Fetches, verifies and compares one list. Returns what to do with it. */
async function examine(slot, opts, keys, checkout) {
  const label = slot.file.padEnd(13);
  const fetched = await fetchList(opts.api, slot);
  if (fetched.missing) {
    console.log(`${label} none published (${slot.path} answered 404); nothing to copy`);
    return { ok: true };
  }
  if (fetched.error) {
    console.log(`${label} FAILED: ${fetched.error}`);
    return { ok: false };
  }
  const { raw } = fetched;
  let envelope;
  let signer;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
    signer = signerFor(envelope, slot);
  } catch (err) {
    console.log(`${label} REFUSED: ${slot.path} ${err instanceof SyntaxError ? "is not JSON" : err.message}`);
    return { ok: false };
  }
  if (!Object.prototype.hasOwnProperty.call(keys, signer)) {
    console.log(`${label} REFUSED: no compiled-in key named ${signer}`);
    return { ok: false };
  }
  const verdict = verifyWithTool(raw, keys[signer]);
  if (!verdict.ok) {
    console.log(`${label} REFUSED: does not verify against the apps' keys (${verdict.said})`);
    return { ok: false };
  }
  let list;
  try {
    list = usableList(envelope, slot);
  } catch (err) {
    console.log(`${label} REFUSED: verifies, but ${err.message}`);
    return { ok: false };
  }

  let signedBy = `key=${signer}`;
  let ok = true;
  if (slot.server) {
    const statement = decodeJson(envelope.cert.payload);
    const daysLeft = Math.floor((statement.expires * 1000 - Date.now()) / 86_400_000);
    signedBy = `key=${envelope.key} via ${signer}, statement ends ${new Date(statement.expires * 1000).toISOString().slice(0, 10)}`;
    if (daysLeft < STATEMENT_WARN_DAYS) {
      console.error(
        `warning: the statement behind ${slot.file} runs out in ${daysLeft} day(s); vouch again with the offline key`,
      );
    }
  }
  const summary = `${label} v${list.v}  verified (${signedBy}), ${list.endpoints.length} entries`;

  if (!checkout) {
    console.log(`${summary} -> would copy`);
    return { ok, write: false };
  }
  const path = join(checkout.repo, slot.file);
  const copy = copyVersion(path);
  if (copy.v === null) {
    console.log(`${summary} -> ${opts.dryRun ? "would copy" : "copy"} (none there yet)`);
    return { ok, write: true, raw, path, file: slot.file, v: list.v };
  }
  if (Number.isNaN(copy.v)) {
    console.log(`${summary} -> ${opts.dryRun ? "would replace" : "replace"} an unreadable copy`);
    return { ok, write: true, raw, path, file: slot.file, v: list.v };
  }
  if (list.v > copy.v) {
    console.log(`${summary} -> ${opts.dryRun ? "would copy" : "copy"} (replaces v${copy.v})`);
    return { ok, write: true, raw, path, file: slot.file, v: list.v };
  }
  if (list.v === copy.v && raw.equals(copy.raw)) {
    console.log(`${summary} -> unchanged`);
    return { ok, write: false };
  }
  // The panel refuses to publish a version that is not higher, so either
  // of these means its state went backwards or someone edited the copy.
  // Clients holding the copy's version would not take this one anyway.
  ok = false;
  if (list.v === copy.v) {
    console.log(`${summary} -> KEPT the copy: same version, different bytes`);
  } else {
    console.log(`${summary} -> KEPT the copy: it is v${copy.v}, newer than the panel's`);
  }
  return { ok, write: false };
}

async function purge(slug, branch, files) {
  for (const file of files) {
    const url = `${PURGE_BASE}/gh/${slug}@${branch}/${file}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      console.log(`purge ${file}: HTTP ${res.status}`);
    } catch (err) {
      // Not a failure of the copy: the CDN refreshes on its own, later.
      console.log(`purge ${file}: failed (${err?.cause?.code ?? err?.message ?? err}); the CDN refreshes on its own`);
    }
  }
}

function printUrls(slug, branch) {
  const name = slug ?? "<owner>/<repo>";
  console.log("\nURLs the apps would read:");
  for (const { file } of SLOTS) {
    console.log(`  https://raw.githubusercontent.com/${name}/${branch}/${file}`);
    console.log(`  https://cdn.jsdelivr.net/gh/${name}@${branch}/${file}`);
  }
  if (!slug) console.log("  (pass --github <owner>/<repo>, or use a checkout whose origin is on GitHub)");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const keys = compiledInKeys();
  let checkout = opts.repo === undefined ? null : openCheckout(opts.repo);

  // Compare against what is already published, so a copy pushed from
  // another machine is not taken for missing -- and check again what the
  // pull brought in.
  if (checkout && opts.push && checkout.upstream && !opts.dryRun) {
    mustGit(checkout.repo, ["pull", "-q", "--ff-only"]);
    checkout = openCheckout(opts.repo);
  }

  const results = [];
  for (const slot of SLOTS) results.push(await examine(slot, opts, keys, checkout));
  const ok = results.every((r) => r.ok);
  const writes = results.filter((r) => r.write);

  if (checkout && writes.length > 0 && opts.dryRun) {
    console.log(`\ndry run: would commit ${writes.map((w) => `${w.file} v${w.v}`).join(", ")}`);
  }
  let committed = false;
  if (checkout && writes.length > 0 && !opts.dryRun) {
    const files = writes.map((w) => w.file);
    for (const w of writes) writeFileSync(w.path, w.raw);
    mustGit(checkout.repo, ["add", "--", ...files]);
    // What gets committed is what was served: a line-ending or filter
    // setting that rewrites the bytes on the way in is caught here,
    // before it publishes a list nobody can verify.
    for (const [i, w] of writes.entries()) {
      const staged = mustGit(checkout.repo, ["cat-file", "blob", `:${files[i]}`], { buffer: true });
      if (!Buffer.from(staged).equals(w.raw)) {
        die(`git changed ${files[i]} as it staged it (line endings or a filter); nothing committed`);
      }
    }
    const message = `update ${writes.map((w, i) => `${files[i]} to v${w.v}`).join(", ")}`;
    mustGit(checkout.repo, ["commit", "-q", "-m", message]);
    committed = true;
    console.log(`\ncommitted ${mustGit(checkout.repo, ["rev-parse", "--short", "HEAD"]).trim()}: ${message}`);
  }

  const slug = opts.github ?? (checkout?.origin ? githubSlug(checkout.origin) : null);
  const branch = checkout?.branch ?? "main";

  if (checkout && opts.push && !opts.dryRun) {
    // Pushed when this run committed, and also when an earlier run's push
    // never happened, so a rerun finishes the job.
    const hasHead = (() => {
      try {
        git(checkout.repo, ["rev-parse", "-q", "--verify", "HEAD"]);
        return true;
      } catch {
        return false;
      }
    })();
    const ahead = checkout.upstream
      ? Number(mustGit(checkout.repo, ["rev-list", "--count", "@{u}..HEAD"]).trim())
      : hasHead
        ? 1
        : 0;
    if (ahead > 0 || committed) {
      if (!checkout.origin && !checkout.upstream) die("--push: the checkout has no origin remote");
      mustGit(checkout.repo, checkout.upstream ? ["push", "-q"] : ["push", "-q", "-u", "origin", "HEAD"]);
      console.log(`pushed ${branch}`);
      if (opts.purge) {
        if (slug) await purge(slug, branch, SLOTS.map((s) => s.file).filter((f) => existsSync(join(checkout.repo, f))));
        else console.log("purge skipped: the GitHub name is unknown (pass --github)");
      }
    } else {
      console.log("nothing to push");
    }
  }

  printUrls(slug, branch);
  process.exitCode = ok ? 0 : 1;
}

await main();
