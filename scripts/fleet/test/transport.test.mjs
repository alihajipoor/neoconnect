/**
 * The run's transport (lib/ssh-hub.mjs, lib/ssh-call.mjs and the wrappers
 * in lib/remote.sh), for real against a loopback SSH server
 * (ssh-test-server.mjs) that runs each command with bash.
 *
 * Every call goes through the real rsh, rpipe, rput, rget, rscript and q
 * (transport-harness.sh). Where it can, a case runs twice, once over the
 * helper and once over plain ssh (one connection per call, as every run
 * before 2026-11-17), and asserts the two give the same exit status and
 * the same bytes on both streams. The plain ssh run is the reference:
 * that is the path proven on real servers.
 *
 * Needs the SSH library (npm ci --prefix scripts/fleet) and an OpenSSH
 * client; without the library the cases are skipped, and say so.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = join(HERE, "..");
const HARNESS = join(HERE, "transport-harness.sh");
const BASH = process.env.FLEET_BASH || "bash";
const HAVE_LIB = existsSync(join(FLEET, "node_modules", "ssh2", "package.json"));
const skip = HAVE_LIB ? false : "the SSH library is not installed (npm ci --prefix scripts/fleet)";

const fwd = (p) => p.replace(/\\/g, "/");
// The test server is not OpenSSH: plain ssh warns on every connection
// that it offers no post-quantum key exchange. Real servers do.
const noPq = (s) => s.replace(/\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\r\n\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\r\n\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\r\n/g, "");

let srv;
let dir;
let hostKey;
let otherKey;
let n = 0;

function knownHosts(key, port = srv.port) {
  const f = join(dir, `kh-${++n}`);
  writeFileSync(f, key ? `[127.0.0.1]:${port} ${key.public.split(" ").slice(0, 2).join(" ")}\n` : "");
  return fwd(f);
}

// One harness run: { code, out (Buffer), err (string), run (its run dir) }.
function harness(transport, code, env = {}) {
  const run = fwd(join(dir, `run-${++n}`));
  mkdirSync(run, { recursive: true });
  return new Promise((resolve) => {
    const p = spawn(BASH, [HARNESS, code], {
      env: {
        ...process.env,
        FLEET_SSH: transport,
        T_RUN: run,
        T_KEY: fwd(join(dir, "id")),
        T_KH: env.T_KH || knownHosts(hostKey),
        T_PORT: String(srv.port),
        T_REMOTE: fwd(join(dir, "remote")),
        ...env,
      },
    });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => resolve({ code: c, out: Buffer.concat(out), err, run }));
  });
}

const both = async (code, env) => [await harness("hub", code, env), await harness("ssh", code, env)];
const transportOf = (r) => readFileSync(join(r.run, "transport"), "utf8").trim();
const conns = async (f) => {
  const before = srv.stats.connections;
  const r = await f();
  return [r, srv.stats.connections - before];
};
const refused = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
  });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

describe("the run's SSH transport", { skip, timeout: 600000 }, () => {
  before(async () => {
    const require = createRequire(join(FLEET, "package.json"));
    const { utils } = require("ssh2");
    const { startServer } = await import("./ssh-test-server.mjs");
    dir = mkdtempSync(join(tmpdir(), "fleet-transport-"));
    hostKey = utils.generateKeyPairSync("ed25519");
    otherKey = utils.generateKeyPairSync("ed25519");
    const client = utils.generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "id"), client.private, { mode: 0o600 });
    mkdirSync(join(dir, "remote"));
    // A psql that shows what it was given: its arguments, then its input.
    writeFileSync(join(dir, "remote", "psql.sh"), '#!/bin/bash\necho "ARGS $*"\ncat\n', { mode: 0o755 });
    // A checkout of scripts for rscript: one that tells what it got.
    mkdirSync(join(dir, "fleet", "remote", "t"), { recursive: true });
    mkdirSync(join(dir, "fleet", "remote", "common"), { recursive: true });
    mkdirSync(join(dir, "fleet", "sql"), { recursive: true });
    copyFileSync(join(FLEET, "sql", "fleet.sql"), join(dir, "fleet", "sql", "fleet.sql"));
    writeFileSync(join(dir, "fleet", "remote", "common", "shared.sh"), "#!/bin/bash\necho shared\n");
    writeFileSync(
      join(dir, "fleet", "remote", "t", "probe.sh"),
      '#!/bin/bash\necho "args:$#:$1|$2"\necho "env:${NX_X:-unset}"\necho "stdin:$(cat | wc -c | tr -d " ")"\necho to-err >&2\nexit 4\n',
    );
    srv = await startServer({ hostKey: hostKey.private, clientPublic: client.public, bash: BASH });
  });
  after(async () => {
    if (srv) await srv.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps exit status and both streams, as plain ssh, over one connection", async () => {
    const code = 'rsh panel "echo out; echo err >&2; exit 3"; echo "rc=$?"; for i in 1 2 3 4 5; do rsh panel "echo call-$i"; done; rsh_to panel "printf pipe-%s x y" panel "cat; echo"; rsh panel "__SIGNAL__"; echo "killed=$?"';
    const [[hub, ssh], c] = await conns(() => both(code));
    assert.equal(transportOf(hub), "TRANSPORT=hub");
    assert.equal(transportOf(ssh), "TRANSPORT=ssh");
    assert.equal(hub.code, 0);
    assert.equal(hub.out.toString(), ssh.out.toString());
    assert.match(hub.out.toString(), /^out\nrc=3\ncall-1\n.*call-5\npipe-xpipe-y\nkilled=255\n$/s);
    assert.equal(hub.err, noPq(ssh.err));
    assert.equal(hub.err, "err\n");
    // 9 calls: one connection over the helper, nine over plain ssh.
    assert.equal(c, 1 + 9);
    const log = readFileSync(join(hub.run, "run.log"), "utf8");
    assert.match(log, /TRANSPORT hub: one SSH connection per host/);
    assert.match(log, /TRANSPORT-END hub: 9 remote calls over 1 new connections/);
    assert.match(readFileSync(join(ssh.run, "run.log"), "utf8"), /TRANSPORT ssh: one SSH connection per remote call \(FLEET_SSH=ssh\)/);
  });

  it("moves binary data byte for byte: rput, rget, a command reading its input", async () => {
    const blob = randomBytes(300000);
    blob[10] = 0x0d;
    blob[11] = 0x0a;
    blob[12] = 0x1a;
    const src = join(dir, "blob.bin");
    writeFileSync(src, blob);
    const code = `rput panel "${fwd(src)}" "$REMOTE_DIR/up/blob.bin" 600; echo "put=$?"; rget panel "$REMOTE_DIR/up/blob.bin" "$RUN_DIR/back.bin"; echo "get=$?"; rpipe panel "cat" <"${fwd(src)}" >"$RUN_DIR/piped.bin"; echo "pipe=$?"; printf 'one\\ntwo\\n' | rpipe panel 'read a; read b; echo "got:$a+$b"'`;
    for (const r of await both(code)) {
      assert.equal(r.out.toString(), "put=0\nget=0\npipe=0\ngot:one+two\n", r.err);
      assert.ok(readFileSync(join(r.run, "back.bin")).equals(blob), "rget brought back the same bytes");
      assert.ok(readFileSync(join(r.run, "piped.bin")).equals(blob), "standard input to standard output, unchanged");
    }
  });

  it("rscript is one call: unpacks, runs with empty input and the usual umask, keeps its status", async () => {
    const code = `RENV="NX_X=set " rscript panel t/probe.sh "a b" 'c$d'; echo "rc=$?"; rsh panel "cat $REMOTE_DIR/shared.sh | tail -1"; rsh panel "umask"`;
    const [[hub, ssh], c] = await conns(() => both(code, { T_FLEET_DIR: fwd(join(dir, "fleet")) }));
    assert.equal(hub.out.toString(), ssh.out.toString());
    assert.match(hub.out.toString(), /^args:2:a b\|c\$d\nenv:set\nstdin:0\nrc=4\necho shared\n0022\n$/);
    assert.equal(hub.err, "to-err\n");
    assert.equal(c, 1 + 3, "three calls: one connection over the helper, three over ssh (rscript is one)");
  });

  it("q is one call: the query on psql's input, read-only unless written, and no write without a dump", async () => {
    const code = `q online-names; echo "rc=$?"; q heartbeats >/dev/null; ( q retire-keys name=x ) 2>&1; echo "refused=$?"; wc -l <"$RUN_DIR/ssh-calls"`;
    const [[hub, ssh], c] = await conns(() => both(code, { T_FLEET_DIR: fwd(join(dir, "fleet")) }));
    for (const r of [hub, ssh]) {
      const out = r.out.toString();
      // The fake psql prints its input: the read query, inside a
      // read-only transaction.
      assert.match(out, /^ARGS \nBEGIN READ ONLY;\nSELECT .* FROM nodes WHERE status = 'ONLINE';\nCOMMIT;\nrc=0\n/);
      assert.match(out, /refused=1\n/);
      assert.match(out, /this run has no database dump yet/);
      assert.match(out, /\n2\n$/, "two calls, none for the refused write");
    }
    assert.equal(c, 1 + 2);
  });

  it("a host key that does not match is refused, by ssh itself, with ssh's message; nothing runs", async () => {
    const kh = knownHosts(otherKey);
    const before = srv.stats.execs;
    const [hub, ssh] = await both('rsh panel "echo ran"; echo "rc=$?"', { T_KH: kh });
    assert.equal(hub.out.toString(), "rc=255\n");
    assert.equal(hub.out.toString(), ssh.out.toString());
    assert.match(hub.err, /REMOTE HOST IDENTIFICATION HAS CHANGED/);
    assert.match(hub.err, /Host key verification failed/);
    assert.equal(noPq(hub.err), noPq(ssh.err));
    assert.equal(srv.stats.execs, before, "the command never ran");
  });

  it("a host never seen is taken on by ssh (accept-new); the next call uses the helper", async () => {
    const kh = knownHosts(null);
    const [r, c] = await conns(() => harness("hub", 'rsh panel "echo first"; rsh panel "echo second"; rsh panel "echo third"', { T_KH: kh }));
    assert.equal(r.out.toString(), "first\nsecond\nthird\n");
    assert.match(r.err, /Permanently added/);
    assert.match(readFileSync(kh, "utf8"), /ssh-ed25519/);
    assert.equal(c, 2, "the first contact over ssh, then one helper connection for the rest");
  });

  it("an unreachable host: the same message and status as ssh, no hang", async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const [hub, ssh] = await both('rsh panel "echo ran"; echo "rc=$?"', { T_PORT: String(port) });
    assert.equal(hub.out.toString(), "rc=255\n");
    assert.equal(hub.err, ssh.err);
    assert.match(hub.err, /^ssh: connect to host 127\.0\.0\.1 port \d+: Connection (refused|timed out)\r\n$/);
  });

  it("the connect timeout holds, with ssh's words", async () => {
    // A documentation-range address nobody answers: the connect waits for
    // ConnectTimeout (or the network says at once that there is no route).
    const t0 = Date.now();
    const [hub, ssh] = await both('rsh new "echo ran"; echo "rc=$?"', { T_NEW_IP: "192.0.2.1", T_PORT: "22", T_CONNECT_TIMEOUT: "2" });
    // Two runs of 2 s each plus their start-up; without the timeout a
    // connect to nowhere waits over a minute. 20 s was missed by 0.9 s
    // while the whole suite ran beside it.
    assert.ok(Date.now() - t0 < 40000);
    assert.equal(hub.out.toString(), "rc=255\n");
    assert.equal(hub.err, ssh.err);
  });

  it("a connection that goes silent is given up after the keepalives, as ssh does", async () => {
    const [hub, ssh] = await both('rsh panel "__FREEZE__"; echo "rc=$?"; rsh panel "echo after"', { T_ALIVE: "1" });
    for (const r of [hub, ssh]) assert.equal(r.out.toString(), "rc=255\nafter\n", r.err);
    assert.equal(hub.err, noPq(ssh.err));
    assert.match(hub.err, /^Timeout, server 127\.0\.0\.1 not responding\.\r\n$/);
  });

  it("a connection the server drops is reported as ssh reports it, and made again for the next call", async () => {
    const [[hub, ssh]] = await conns(() => both('rsh panel "__DROP__"; echo "rc=$?"; rsh panel "echo again"; echo "rc=$?"'));
    for (const r of [hub, ssh]) assert.equal(r.out.toString(), "rc=255\nagain\nrc=0\n", r.err);
    assert.equal(hub.err, noPq(ssh.err));
    assert.match(hub.err, /Connection to 127\.0\.0\.1 closed by remote host\./);
  });

  it("a connection that died without a word (a reboot) is found by a keepalive that runs nothing, and the call made on a new one", async () => {
    const before = srv.stats.execs;
    const [r, c] = await conns(() =>
      harness("hub", 'rsh panel "__FREEZE_NEXT__"; sleep 1; rsh panel "echo after"; echo "rc=$?"', { FLEET_HUB_PING_IDLE_MS: "500", FLEET_HUB_PING_TIMEOUT_MS: "1000" }),
    );
    assert.equal(r.out.toString(), "frozen\nafter\nrc=0\n", r.err);
    assert.equal(r.err, "");
    assert.equal(c, 2);
    assert.equal(srv.stats.execs, before + 2, "each command sent once");
  });

  // Review finding: the exec request has gone out, the host runs the
  // command, and its answer is slow (a lossy path into the country). The
  // helper used to give up after 10 s, end the connection and send the
  // command again on a new one: it ran twice, and with the plain-ssh
  // fallback three times.
  it("a command whose start is answered slowly runs once, and the call waits for it", async () => {
    const file = fwd(join(dir, `slow-${++n}`));
    const r = await harness("hub", `rsh panel "__SLOWREPLY__ 2500 ${file}"; echo "rc=$?"`, { FLEET_HUB_OPEN_TIMEOUT_MS: "1000" });
    assert.equal(r.out.toString(), "slow-ok\nrc=0\n", r.err);
    assert.equal(readFileSync(file, "utf8"), "ran\n", "run exactly once");
  });

  // Review finding: one call's slow answer made the helper end the shared
  // connection, which cut every other call on it (a long dial hold).
  it("a slow call never cuts another call on the same connection", async () => {
    const file = fwd(join(dir, `slow-${++n}`));
    const code = `rsh panel "sleep 4; echo long-done" & rsh panel "__SLOWREPLY__ 2500 ${file}"; echo "slow-rc=$?"; wait $!; echo "long-rc=$?"`;
    const r = await harness("hub", code, { FLEET_HUB_OPEN_TIMEOUT_MS: "1000" });
    const out = r.out.toString();
    assert.match(out, /slow-ok\nslow-rc=0\n/, r.err);
    assert.match(out, /long-done\nlong-rc=0\n/, r.err);
    assert.equal(readFileSync(file, "utf8"), "ran\n");
  });

  // Review finding: the helper dies while the host is already running the
  // command, before its answer. The caller used to take that for "nothing
  // ran" and run it again with plain ssh.
  it("a helper that dies once the command may have gone out is a lost connection (255), never a second run", async () => {
    const file = fwd(join(dir, `slow-${++n}`));
    const kill = 'if command -v taskkill >/dev/null 2>&1; then taskkill //F //PID "$FLEET_HUB_WINPID" >/dev/null 2>&1; else kill -9 "$FLEET_HUB_WINPID"; fi';
    const code = `rsh panel true; rsh panel "__SLOWREPLY__ 3000 ${file}" & sleep 1.5; ${kill}; wait $!; echo "rc=$?"; rsh panel "echo after"`;
    const r = await harness("hub", code);
    assert.equal(r.out.toString(), "rc=255\nafter\n", r.err);
    assert.match(r.err, /the run's SSH helper went away during this call/);
    await settle(2000);
    assert.equal(readFileSync(file, "utf8"), "ran\n", "run exactly once");
  });

  // Review finding: once the helper is gone, any local account may take
  // its loopback port. The caller used to send it the token and the whole
  // command line, take its input, and believe its answer.
  it("a stranger on the helper's port gets no token, no command and no input, and cannot answer for the host", async () => {
    const seen = [];
    const fake = net.createServer((s) => {
      s.on("data", (d) => {
        seen.push(d);
        // What the helper's old protocol would have answered: R, an
        // output, exit 0.
        const f = (t, b) => {
          const body = Buffer.from(b);
          const h = Buffer.alloc(5);
          h[0] = t.charCodeAt(0);
          h.writeUInt32BE(body.length, 1);
          return Buffer.concat([h, body]);
        };
        s.write(Buffer.concat([f("R", ""), f("O", "forged\n"), f("S", "0")]));
      });
      s.on("error", () => {});
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const silent = net.createServer((s) => s.on("error", () => {}));
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    try {
      const code = `rsh panel true; echo "secret-input" | FLEET_HUB_PORT=${fake.address().port} rpipe panel "echo ran-for-real; cat"; echo "rc=$?"; FLEET_HUB_PORT=${silent.address().port} FLEET_CALL_HELLO_MS=500 rsh panel "echo silent-fallback"; echo "rc=$?"; printf %s "$FLEET_HUB_TOKEN" >"$RUN_DIR/token"`;
      const r = await harness("hub", code);
      assert.equal(r.out.toString(), "ran-for-real\nsecret-input\nrc=0\nsilent-fallback\nrc=0\n", r.err);
      const got = Buffer.concat(seen).toString("latin1");
      const token = readFileSync(join(r.run, "token"), "utf8");
      assert.ok(token.length >= 32);
      assert.ok(!got.includes(token), "the token never crossed the socket");
      assert.ok(!got.includes("ran-for-real") && !got.includes("secret-input"), "neither the command nor its input reached the stranger");
    } finally {
      fake.close();
      silent.close();
    }
  });

  it("a plain-ssh fallback is run by bash itself with the same input, and a remote 254 stays the command's", async () => {
    const code = 'printf "a b\\n*.sh\\n" | rpipe panel "cat"; echo "rc=$?"; rsh panel "exit 254"; echo "rc=$?"';
    // No known key: the helper hands every call to plain ssh.
    const r = await harness("hub", code, { T_KH: knownHosts(null) });
    assert.equal(r.out.toString(), "a b\n*.sh\nrc=0\nrc=254\n", r.err);
  });

  it("the end of standard error is never cut off by the exit status", async () => {
    // A slow reader of standard error, so the helper has to hold some of
    // it back while standard output ends.
    const code = 'rsh panel "head -c 1500000 /dev/zero | tr \'\\\\0\' e >&2; echo out" 2> >(sleep 2; wc -c | tr -d " " >"$RUN_DIR/errsize"); echo "rc=$?"; sleep 4';
    const r = await harness("hub", code);
    assert.equal(r.out.toString(), "out\nrc=0\n", r.err);
    assert.equal(readFileSync(join(r.run, "errsize"), "utf8").trim(), "1500000");
  });

  it("the inside boxes go over plain ssh unless FLEET_HUB_INSIDE=1", async () => {
    const code = 'rsh relay true; rsh signin true; rsh relay true; wc -l <"$RUN_DIR/ssh-conns"';
    const [plain, onHub] = [await harness("hub", code), await harness("hub", code, { FLEET_HUB_INSIDE: "1" })];
    assert.equal(plain.out.toString().trim(), "3", plain.err);
    assert.equal(onHub.out.toString().trim(), "1", onHub.err);
  });

  it("a host that takes the connection and then says nothing: ssh's status, once, within ConnectTimeout", async () => {
    const mute = net.createServer((s) => s.on("error", () => {}));
    await new Promise((r) => mute.listen(0, "127.0.0.1", r));
    try {
      const t0 = Date.now();
      const kh = fwd(join(dir, `kh-${++n}`));
      writeFileSync(kh, `[127.0.0.1]:${mute.address().port} ${hostKey.public.split(" ").slice(0, 2).join(" ")}\n`);
      const r = await harness("hub", 'rsh panel "echo ran"; echo "rc=$?"', { T_PORT: String(mute.address().port), T_KH: kh, T_CONNECT_TIMEOUT: "2" });
      assert.equal(r.out.toString(), "rc=255\n", r.err);
      assert.match(r.err, /timed out/);
      assert.equal((r.err.match(/banner exchange/g) || []).length, 1, "said once: plain ssh did not try it again");
      // The first version waited 30 s here, then plain ssh waited 2 s more.
      assert.ok(Date.now() - t0 < 15000, "within ConnectTimeout, not 30 s and again");
    } finally {
      mute.close();
    }
  });

  it("rdrop closes the connection to that host: the next call dials again", async () => {
    const [r, c] = await conns(() => harness("hub", 'rsh new "echo one"; rdrop new; rsh new "echo two"'));
    assert.equal(r.out.toString(), "one\ntwo\n");
    assert.equal(c, 2);
  });

  it("ends clean after a failure: helper gone, nothing listening, connections closed", async () => {
    // Connections frozen by earlier cases stay open on the server: count
    // from here.
    const open0 = srv.stats.open;
    const r = await harness("hub", 'rsh panel "echo x" >/dev/null; cp "$RUN_DIR/ssh-hub.port" "$RUN_DIR/port.kept"; die "stopped on purpose"');
    assert.equal(r.code, 1);
    const port = Number(readFileSync(join(r.run, "port.kept"), "utf8").split("\n")[0]);
    assert.ok(!existsSync(join(r.run, "ssh-hub.port")), "the helper removed its port file");
    assert.ok(await refused(port), "nothing listens on its port");
    await settle(300);
    assert.equal(srv.stats.open, open0, "no connection left open on the server");
  });

  it("ends when the run is killed outright: its input pipe closes", async () => {
    const open0 = srv.stats.open;
    const r = await harness("hub", 'rsh panel "echo x" >/dev/null; cp "$RUN_DIR/ssh-hub.port" "$RUN_DIR/port.kept"; kill -9 $$');
    const port = Number(readFileSync(join(r.run, "port.kept"), "utf8").split("\n")[0]);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = await refused(port);
      if (!gone) await settle(100);
    }
    assert.ok(gone, "the helper stopped within 4 s of the run's death");
    await settle(300);
    assert.equal(srv.stats.open, open0);
  });

  it("refuses a caller without the run's token", async () => {
    // Two strangers: one sends a header straight away (with a guessed
    // token, as the first version took), one answers the helper's nonce
    // with a made-up proof. Neither gets a command run.
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      `import net from "node:net";
const f = (t, b) => { const body = Buffer.from(b); const h = Buffer.alloc(5); h[0] = t.charCodeAt(0); h.writeUInt32BE(body.length, 1); return Buffer.concat([h, body]); };
const header = JSON.stringify({ token: "x".repeat(64), mac: "00".repeat(32), body: JSON.stringify({ argv: ["-i", "k", "root@127.0.0.1", "echo stolen"], op: "exec" }) });
const s = net.connect(+process.env.FLEET_HUB_PORT, "127.0.0.1", () => s.write(process.argv[2] === "bare" ? f("H", header) : f("N", Buffer.alloc(32, 7))));
let got = [];
s.on("data", (d) => { got.push(d[0]); if (process.argv[2] !== "bare" && got.length === 1) s.write(f("H", header)); });
s.on("close", () => console.log(got.filter((t) => t !== 65).length ? "answered" : "closed-unanswered"));
s.on("error", () => {});
`,
    );
    const before = srv.stats.execs;
    const r = await harness("hub", `rsh panel true; node "${fwd(probe)}" bare; node "${fwd(probe)}" nonce`);
    assert.equal(r.out.toString(), "closed-unanswered\nclosed-unanswered\n", r.err);
    assert.equal(srv.stats.execs, before + 1, "only the run's own call ran");
    assert.match(readFileSync(join(r.run, "ssh-hub.log"), "utf8"), /refused a caller without the run's token/);
  });

  it("falls back to plain ssh when the helper dies mid-run, and when it cannot start", async () => {
    const r = await harness("hub", 'rsh panel "echo one"; kill "$FLEET_HUB_PID"; sleep 1; rsh panel "echo two"; echo "rc=$?"');
    assert.equal(r.out.toString(), "one\ntwo\nrc=0\n", r.err);
    // No node on PATH: the run says why, and goes over ssh.
    const nodeDirs = (process.env.PATH || "").split(delimiter).filter((p) => existsSync(join(p, "node")) || existsSync(join(p, "node.exe")));
    const bashDir = nodeDirs.filter((p) => existsSync(join(p, "bash")) || existsSync(join(p, "bash.exe")));
    if (bashDir.length === 0) {
      const path = (process.env.PATH || "").split(delimiter).filter((p) => !nodeDirs.includes(p)).join(delimiter);
      const s = await harness("hub", 'rsh panel "echo plain"', { PATH: path });
      assert.equal(s.out.toString(), "plain\n", s.err);
      assert.equal(transportOf(s), "TRANSPORT=ssh");
      assert.match(readFileSync(join(s.run, "run.log"), "utf8"), /TRANSPORT ssh: one SSH connection per remote call \(node is not on PATH\)/);
    }
  });

  it("each step's remote calls and new connections go into the run log", async () => {
    const code = 'CURRENT_STEP=t.x; transport_step_begin; rsh panel true; rsh panel true; rsh panel true; transport_step_end t.x; echo "note:$TRANSPORT_NOTE"';
    const [hub, ssh] = await both(code);
    assert.equal(hub.out.toString(), "note: (3 remote calls, 1 new SSH connection)\n");
    assert.equal(ssh.out.toString(), "note: (3 remote calls, 3 new SSH connections)\n");
    assert.match(readFileSync(join(hub.run, "run.log"), "utf8"), /CALLS t\.x hub: 3 remote calls, 1 new connection\n/);
  });
});
