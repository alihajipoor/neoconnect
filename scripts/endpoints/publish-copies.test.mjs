/**
 * publish-copies.mjs, run as the real script against a stand-in panel
 * (a local HTTP server answering /api/endpoints/bundle and bundle2, and
 * jsDelivr's purge) and throwaway git checkouts.
 *
 * The lists are signed here with keys made for the test, and the script
 * is told to trust them through NEOXIFY_TEST_BUNDLE_KEYS -- except in the
 * one test that leaves it out, which shows the script holds lists to the
 * apps' real keys. Every endpoint is an RFC 2606 name.
 *
 *   node --test scripts/endpoints/publish-copies.test.mjs
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "publish-copies.mjs");

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  return { privateKey, pub };
}
const primary = keypair();
const backup = keypair();
const serverKey = keypair();
const stranger = keypair();
const TRUSTED = JSON.stringify({ primary: primary.pub, backup: backup.pub });

const list = (v) => ({
  v,
  issuedAt: "2026-10-19T00:00:00.000Z",
  endpoints: [
    { kind: "panel", url: "https://panel.example.net/api" },
    { kind: "mirror", url: "https://mirror.example.org:8443/api", region: "de" },
  ],
});

function envelope(content, privateKey, key, cert) {
  const payload = Buffer.from(JSON.stringify(content), "utf8");
  const out = { payload: payload.toString("base64"), sig: sign(null, payload, privateKey).toString("base64"), key };
  if (cert) out.cert = cert;
  return JSON.stringify(out);
}

/** A compiled-in key's statement that the server key may sign lists. */
function statement({ by = primary, expires = Math.floor(Date.now() / 1000) + 365 * 86_400 } = {}) {
  const payload = Buffer.from(
    JSON.stringify({ kind: "neoxify-bundle-key", id: "server-1", publicKey: serverKey.pub, expires }),
    "utf8",
  );
  return { payload: payload.toString("base64"), sig: sign(null, payload, by.privateKey).toString("base64"), key: "primary" };
}

const offlineList = (v, signer = primary) => envelope(list(v), signer.privateKey, "primary");
const serverList = (v, cert = statement()) => envelope(list(v), serverKey.privateKey, "server-1", cert);

// The stand-in panel and purge endpoint.
let routes = {};
let requests = [];
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, { "Content-Type": "application/json" }).end(route.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let dirs = [];
beforeEach(() => {
  requests = [];
  routes = {
    "/api/endpoints/bundle": { body: offlineList(7) },
    "/api/endpoints/bundle2": { body: serverList(100) },
  };
});
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "copies-test-"));
  dirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A throwaway checkout with an identity of its own, so commits work on a
 * machine (or CI runner) with none. */
function identity(dir) {
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
}
function checkout() {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  identity(dir);
  return dir;
}

function run(args, { trusted = true } = {}) {
  const env = { ...process.env, NEOXIFY_PURGE_BASE: base };
  delete env.NEOXIFY_TEST_BUNDLE_KEYS;
  if (trusted) env.NEOXIFY_TEST_BUNDLE_KEYS = TRUSTED;
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, "--api", `${base}/api`, ...args], { env }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, out: `${stdout}${stderr}` });
    });
  });
}

const commits = (dir) => {
  const result = spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.trim()) : 0;
};
const read = (dir, file) => readFileSync(join(dir, file), "utf8");

describe("publish-copies", () => {
  it("dry run without a checkout verifies both lists and writes nothing", async () => {
    const result = await run(["--dry-run"]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /bundle\.json\s+v7\s+verified \(key=primary\)/);
    assert.match(result.stdout, /bundle2\.json\s+v100\s+verified \(key=server-1 via primary/);
    assert.match(result.stdout, /https:\/\/raw\.githubusercontent\.com\/<owner>\/<repo>\/main\/bundle\.json/);
    assert.match(result.stdout, /https:\/\/cdn\.jsdelivr\.net\/gh\/<owner>\/<repo>@main\/bundle2\.json/);
    // Counts only: the output never spells an endpoint.
    assert.doesNotMatch(result.out, /example\.(net|org)/);
  });

  it("copies both lists byte for byte, in one commit holding only them", async () => {
    const dir = checkout();
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 0, result.out);
    assert.equal(read(dir, "bundle.json"), routes["/api/endpoints/bundle"].body);
    assert.equal(read(dir, "bundle2.json"), routes["/api/endpoints/bundle2"].body);
    assert.equal(git(dir, "show", "HEAD:bundle.json"), routes["/api/endpoints/bundle"].body);
    assert.equal(commits(dir), 1);
    assert.deepEqual(git(dir, "ls-files").split("\n"), ["bundle.json", "bundle2.json"]);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "update bundle.json to v7, bundle2.json to v100");
  });

  it("commits nothing when the versions have not moved", async () => {
    const dir = checkout();
    assert.equal((await run(["--repo", dir])).status, 0);
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /bundle\.json .*-> unchanged/);
    assert.match(result.stdout, /bundle2\.json .*-> unchanged/);
    assert.equal(commits(dir), 1);
  });

  it("commits only the list whose version went up", async () => {
    const dir = checkout();
    await run(["--repo", dir]);
    const before = read(dir, "bundle.json");
    routes["/api/endpoints/bundle2"] = { body: serverList(101) };
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 0, result.out);
    assert.equal(commits(dir), 2);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "update bundle2.json to v101");
    assert.equal(read(dir, "bundle.json"), before);
    assert.equal(read(dir, "bundle2.json"), routes["/api/endpoints/bundle2"].body);
  });

  it("never walks a copy back to a lower version, or swaps it for another of the same", async () => {
    const dir = checkout();
    routes["/api/endpoints/bundle"] = { body: offlineList(8) };
    await run(["--repo", dir]);
    const held = read(dir, "bundle.json");

    routes["/api/endpoints/bundle"] = { body: offlineList(7) };
    let result = await run(["--repo", dir]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /KEPT the copy: it is v8/);

    // Ed25519 is deterministic, so a different list is needed for
    // different bytes under the same version.
    const other = { ...list(8), issuedAt: "2026-10-20T00:00:00.000Z" };
    routes["/api/endpoints/bundle"] = { body: envelope(other, primary.privateKey, "primary") };
    result = await run(["--repo", dir]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /KEPT the copy: same version, different bytes/);
    assert.equal(read(dir, "bundle.json"), held);
    assert.equal(commits(dir), 1);
  });

  it("refuses a forged list and still copies the good one", async () => {
    const dir = checkout();
    routes["/api/endpoints/bundle"] = { body: offlineList(7, stranger) };
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle\.json\s+REFUSED: does not verify against the apps' keys \(signature: BAD/);
    assert.equal(existsSync(join(dir, "bundle.json")), false);
    assert.equal(read(dir, "bundle2.json"), routes["/api/endpoints/bundle2"].body);
    assert.equal(commits(dir), 1);
  });

  it("holds lists to the apps' own keys when no test keys are given", async () => {
    const dir = checkout();
    const result = await run(["--repo", dir], { trusted: false });
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle\.json\s+REFUSED: does not verify/);
    assert.match(result.stdout, /bundle2\.json\s+REFUSED: does not verify/);
    assert.equal(commits(dir), 0);
  });

  it("refuses a server list under a statement that has run out, or one another server key signed", async () => {
    routes["/api/endpoints/bundle2"] = {
      body: serverList(101, statement({ expires: Math.floor(Date.now() / 1000) - 60 })),
    };
    let result = await run(["--dry-run"]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle2\.json\s+REFUSED: does not verify .*statement: REFUSED/);

    routes["/api/endpoints/bundle2"] = { body: serverList(101, statement({ by: stranger })) };
    result = await run(["--dry-run"]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /statement: BAD/);
  });

  it("keeps each list in its own place", async () => {
    // The offline file must be readable by clients that know no statement.
    routes["/api/endpoints/bundle"] = { body: serverList(101) };
    // A server list never shares numbers with the offline one.
    routes["/api/endpoints/bundle2"] = { body: serverList(99) };
    let result = await run(["--dry-run"]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle\.json\s+REFUSED: .*not signed by a compiled-in key itself/);
    assert.match(result.stdout, /bundle2\.json\s+REFUSED: verifies, but is v99/);

    routes["/api/endpoints/bundle2"] = { body: offlineList(101) };
    result = await run(["--dry-run"]);
    assert.match(result.stdout, /bundle2\.json\s+REFUSED: .*not signed under a statement/);
  });

  it("refuses a list no client would use, even signed", async () => {
    const empty = { v: 8, issuedAt: "2026-10-19T00:00:00.000Z", endpoints: [{ kind: "panel", url: "http://panel.example.net/api" }] };
    routes["/api/endpoints/bundle"] = { body: envelope(empty, primary.privateKey, "primary") };
    const result = await run(["--dry-run"]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle\.json\s+REFUSED: verifies, but lists no endpoint a client would use/);
  });

  it("copies the offline list alone when no server list is published", async () => {
    const dir = checkout();
    delete routes["/api/endpoints/bundle2"];
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /bundle2\.json\s+none published/);
    assert.deepEqual(git(dir, "ls-files").split("\n"), ["bundle.json"]);
  });

  it("fails loudly when the panel cannot be fetched", async () => {
    routes["/api/endpoints/bundle"] = { status: 502, body: "bad gateway" };
    const result = await run(["--dry-run"]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /bundle\.json\s+FAILED: \/endpoints\/bundle answered HTTP 502/);
  });

  it("refuses a checkout holding anything but the lists", async () => {
    const dir = checkout();
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "readme");
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stderr, /may hold only bundle\.json and bundle2\.json; it also has README\.md/);
    assert.equal(existsSync(join(dir, "bundle.json")), false);
  });

  it("refuses a checkout with changes of its own", async () => {
    const dir = checkout();
    writeFileSync(join(dir, "stray.txt"), "x");
    const result = await run(["--repo", dir]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stderr, /has changes of its own/);
    assert.equal(existsSync(join(dir, "bundle.json")), false);
  });

  it("dry run against a checkout says what it would commit and changes nothing", async () => {
    const dir = checkout();
    git(dir, "remote", "add", "origin", "https://github.com/acme/copies.git");
    const result = await run(["--dry-run", "--repo", dir]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /dry run: would commit bundle\.json v7, bundle2\.json v100/);
    assert.match(result.stdout, /https:\/\/raw\.githubusercontent\.com\/acme\/copies\/main\/bundle\.json/);
    assert.match(result.stdout, /https:\/\/cdn\.jsdelivr\.net\/gh\/acme\/copies@main\/bundle2\.json/);
    assert.equal(existsSync(join(dir, "bundle.json")), false);
    assert.equal(commits(dir), 0);
  });

  it("pushes to a new empty repository, then follows it, and asks the CDN to refetch", async () => {
    const origin = tempDir();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const parent = tempDir();
    const work = join(parent, "work");
    spawnSync("git", ["clone", "-q", origin, work], { encoding: "utf8" });
    identity(work);

    let result = await run(["--repo", work, "--push", "--github", "acme/copies"]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /pushed main/);
    assert.equal(git(origin, "show", "main:bundle2.json"), routes["/api/endpoints/bundle2"].body);
    assert.ok(requests.includes("/gh/acme/copies@main/bundle.json"), requests.join(" "));
    assert.ok(requests.includes("/gh/acme/copies@main/bundle2.json"), requests.join(" "));

    // A second machine's checkout, behind the first, publishes the next
    // version on top rather than beside it.
    const other = join(parent, "other");
    spawnSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
    identity(other);
    routes["/api/endpoints/bundle"] = { body: offlineList(8) };
    result = await run(["--repo", work, "--push", "--no-purge", "--github", "acme/copies"]);
    assert.equal(result.status, 0, result.out);
    routes["/api/endpoints/bundle2"] = { body: serverList(101) };
    requests = [];
    result = await run(["--repo", other, "--push", "--no-purge", "--github", "acme/copies"]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /bundle\.json .*-> unchanged/);
    assert.equal(commits(origin), 3);
    assert.equal(requests.filter((r) => r.startsWith("/gh/")).length, 0);
  });

  it("rejects arguments it does not know, and a write without a checkout", async () => {
    let result = await run(["--dryrun"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument --dryrun/);
    result = await run([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pass --repo/);
  });
});
