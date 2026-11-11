/**
 * The scripts that run on the hosts, as far as they can be exercised
 * without a host.
 *
 *   - every one parses (bash -n, sh -n);
 *   - the jq programs that build client configs and guard plan edits are
 *     run against fixture data. These need jq, which the operator's PC
 *     does not have and CI does: without jq they are skipped, and say so;
 *   - the byte sink and probe of the bare-box test are run against each
 *     other on loopback, when a python3 is there.
 *
 * None of this is a tunnel, a server or a plan edit: those are proven
 * only by a supervised run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASH = process.env.FLEET_BASH || "bash";
const has = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error && r.status === 0;
};
const JQ = has("jq");
const PY = ["python3", "python3.12", "python"].find((p) => has(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)"]));

const scripts = [];
for (const dir of ["lib", "remote/panel", "remote/common", "remote/node", "remote/inside", "remote/relay"]) {
  for (const f of readdirSync(join(ROOT, dir))) if (f.endsWith(".sh")) scripts.push(join(dir, f));
}

describe("every shell script parses", () => {
  for (const s of ["fleet", ...scripts]) {
    it(s, () => {
      const first = readFileSync(join(ROOT, s), "utf8").split("\n")[0];
      const shell = first.includes("/bin/sh") ? "sh" : BASH;
      const r = spawnSync(shell, ["-n", join(ROOT, s)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
  it("none carries a Windows line ending (they are copied to Linux hosts as they are)", () => {
    for (const s of ["fleet", ...scripts, "sql/fleet.sql", "remote/node/sink.py", "remote/inside/probe.py"]) {
      assert.ok(!readFileSync(join(ROOT, s), "utf8").includes("\r"), s);
    }
  });
});

describe("nothing address-like or ours is committed with the tool", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else files.push(join(d, e.name));
    }
  };
  walk(".");
  it("every IPv4 literal is loopback, a public resolver, a tunnel pool or a documentation range", () => {
    const ok = /^(127\.0\.0\.1|0\.0\.0\.0|1\.1\.1\.1|8\.8\.8\.8|10\.\d+\.\d+\.\d+|203\.0\.113\.\d+|198\.51\.100\.\d+|192\.0\.2\.\d+)$/;
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const m of text.matchAll(/(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])/g)) {
        assert.match(m[1], ok, `${f} holds the address ${m[1]}`);
      }
    }
  });
  it("every host name is somebody else's public site or an RFC 2606 example", () => {
    const allowed = /(^|\.)(example\.(org|net|com|info)|github\.com|cloudflare\.com|cloudflare-dns\.com|letsencrypt\.org|freedesktop\.org|udp-over-tcp\.arpa|bing\.com)$/;
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const m of text.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|site|online|shop|website|info|arpa|io|ir))\b/g)) {
        assert.match(m[1], allowed, `${f} names the host ${m[1]}`);
      }
    }
  });
});

describe("jq programs", { skip: JQ ? false : "jq is not installed here (CI has it)" }, () => {
  const client = join(ROOT, "remote", "panel", "nx-e2e-client.jq");
  const cfg = (over) => ({
    protocol: "XRAY_VLESS_TLS", transport: "TCP", port: 2053, host: "203.0.113.10", pbk: "PUBKEY", sid: "abcd",
    sni: "abc123.example.org", path: "/static/aa", method: "2022-blake3-aes-256-gcm", serverKey: "SRV", expect: "203.0.113.10", ...over,
  });
  const run = (c, credentials) => {
    const r = spawnSync("jq", ["-n", "--argjson", "c", JSON.stringify(c), "--argjson", "u", JSON.stringify({ credentials }), "-f", client], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  it("builds a REALITY client that expects the exit address", () => {
    const e = run(cfg({ protocol: "XRAY_VLESS_REALITY", port: 443, sni: "www.example.org" }), { uuid: "U", flow: "xtls-rprx-vision" });
    assert.equal(e.nxExpectIp, "203.0.113.10");
    const o = e.config.outbounds[0];
    assert.equal(o.protocol, "vless");
    assert.deepEqual(o.streamSettings.realitySettings, { serverName: "www.example.org", fingerprint: "chrome", publicKey: "PUBKEY", shortId: "abcd" });
    assert.equal(o.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
    assert.equal(e.config.inbounds.length, 1);
  });
  it("builds a WebSocket client with the path and http/1.1", () => {
    const o = run(cfg({ transport: "WS" }), { uuid: "U" }).config.outbounds[0];
    assert.equal(o.streamSettings.network, "ws");
    assert.equal(o.streamSettings.wsSettings.path, "/static/aa");
    assert.deepEqual(o.streamSettings.tlsSettings.alpn, ["http/1.1"]);
    assert.equal(o.settings.vnext[0].users[0].flow, "");
  });
  it("builds a Trojan client", () => {
    const o = run(cfg({ protocol: "XRAY_TROJAN", port: 8443 }), { password: "PW" }).config.outbounds[0];
    assert.equal(o.protocol, "trojan");
    assert.equal(o.settings.servers[0].password, "PW");
  });
  it("builds a Shadowsocks client with UDP-over-TCP on and a DNS inbound to test it", () => {
    const e = run(cfg({ protocol: "SHADOWSOCKS", port: 24000, expect: "203.0.113.99" }), { userKey: "USR" });
    const s = e.config.outbounds[0].settings.servers[0];
    assert.equal(s.password, "SRV:USR");
    assert.equal(s.uot, true);
    assert.equal(e.config.inbounds[1].protocol, "dokodemo-door");
    assert.equal(e.nxExpectIp, "203.0.113.99", "a relay route expects the EXIT's address, not the entry's");
  });

  // nx-e2e-temp.sh keeps its working files in RAM on the panel host. On
  // a Linux runner the same path exists, so its three read-side verbs
  // can be run against files made here (the verbs that ask the database
  // are not).
  it("temporary test users: the Xray API file, the removal list and the client config agree", { skip: existsSync("/dev/shm") ? false : "no /dev/shm here" }, () => {
    const key = "t-" + Math.random().toString(36).slice(2, 10);
    const dir = `/dev/shm/nxf/temp/${key}`;
    const temp = join(ROOT, "remote", "panel", "nx-e2e-temp.sh");
    const sh = (...args) => spawnSync(BASH, [temp, ...args], { encoding: "utf8" });
    mkdirSync(dir, { recursive: true });
    try {
      const rows = [
        cfg({ protocol: "XRAY_VLESS_REALITY", port: 443, tag: null, sni: "www.example.org" }),
        cfg({ protocol: "XRAY_VLESS_TLS", transport: "TCP", port: 2053, tag: null }),
        cfg({ protocol: "XRAY_VLESS_TLS", transport: "WS", port: 2053, tag: null }),
        cfg({ protocol: "XRAY_TROJAN", port: 8443, tag: null }),
        cfg({ protocol: "SHADOWSOCKS", port: 24000, tag: "shadowsocks-in" }),
      ];
      writeFileSync(join(dir, "cfg.json"), JSON.stringify(rows));
      writeFileSync(join(dir, "creds.json"), JSON.stringify({
        REALITY: { uuid: "U1", flow: "xtls-rprx-vision", email: "t-reality" },
        TLS: { uuid: "U2", flow: "xtls-rprx-vision", email: "t-tls" },
        WS: { uuid: "U3", flow: "", email: "t-ws" },
        TROJAN: { password: "PW", email: "t-trojan" },
        SS: { userKey: "USR", email: "t-ss" },
      }));
      writeFileSync(join(dir, "protos"), "REALITY TLS WS TROJAN SS\n");

      const adu = sh("adu", key);
      assert.equal(adu.status, 0, adu.stderr);
      const inbounds = JSON.parse(adu.stdout).inbounds;
      assert.deepEqual(inbounds.map((i) => i.tag), ["vless-in", "vless-tls-in", "vless-ws-in", "trojan-in", "shadowsocks-in"]);
      assert.equal(inbounds[2].port, 10086, "the WebSocket inbound sits on its own local port");
      assert.deepEqual(inbounds[0].settings.clients, [{ id: "U1", flow: "xtls-rprx-vision", email: "t-reality" }]);
      assert.deepEqual(inbounds[3].settings.clients, [{ password: "PW", email: "t-trojan" }]);
      assert.equal(inbounds[4].settings.password, "SRV");
      assert.deepEqual(inbounds[4].settings.clients, [{ password: "USR", email: "t-ss" }]);

      const rmu = sh("rmu", key);
      assert.equal(rmu.status, 0, rmu.stderr);
      assert.deepEqual(rmu.stdout.trim().split("\n"), [
        "vless-in t-reality", "vless-tls-in t-tls", "vless-ws-in t-ws", "trojan-in t-trojan", "shadowsocks-in t-ss",
      ]);

      const ws = sh("env", key, "WS");
      assert.equal(ws.status, 0, ws.stderr);
      const e = JSON.parse(ws.stdout);
      assert.equal(e.nxExpectIp, "203.0.113.10");
      assert.equal(e.config.outbounds[0].streamSettings.wsSettings.path, "/static/aa");
      assert.equal(e.config.outbounds[0].settings.vnext[0].users[0].id, "U3");
      assert.notEqual(sh("env", key, "NOPE").status, 0);
    } finally {
      sh("shred", key);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The guard nx-plan-edit.sh runs on the panel host, lifted out of the
  // script so it is tested as written there.
  const script = readFileSync(join(ROOT, "remote", "panel", "nx-plan-edit.sh"), "utf8");
  const guard = /jq -en --argjson n "\$new" --argjson o "\$old" --argjson a "\$ADD" --argjson d "\$DEL" --arg def "\$DEF" '([^']+)'/.exec(script)?.[1];
  const next = /new=\$\(jq -c --argjson a "\$ADD" --argjson d "\$DEL" '([^']+)'/.exec(script)?.[1];
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const jq = (prog, args, input) => spawnSync("jq", [...args, prog], { encoding: "utf8", input });
  const edit = (old, add, del, def = "") => {
    const n = jq(next, ["-c", "--argjson", "a", JSON.stringify(add), "--argjson", "d", JSON.stringify(del)], JSON.stringify(old));
    const g = jq(guard, ["-en", "--argjson", "n", n.stdout.trim(), "--argjson", "o", JSON.stringify(old), "--argjson", "a", JSON.stringify(add), "--argjson", "d", JSON.stringify(del), "--arg", "def", def]);
    return { next: JSON.parse(n.stdout), ok: g.status === 0 };
  };

  it("the plan guard on the panel host agrees with lib/planlist.mjs", async () => {
    const { planGuard } = await import("../lib/planlist.mjs");
    assert.ok(guard && next, "could not find the guard in nx-plan-edit.sh");
    const cases = [
      [[id(1), id(2), id(3)], [id(4)], [id(2)], ""],
      [[id(1), id(2)], [], [id(1), id(2)], ""],
      [[id(1), id(2)], [], [id(2)], id(2)],
      [[id(1)], [id(2)], [id(1)], id(2)],
      [[id(3), id(1)], [id(1)], [], ""],
    ];
    for (const [old, add, del, def] of cases) {
      const here = (() => { try { return planGuard({ old, add, del, def }); } catch { return null; } })();
      const there = edit(old, add, del, def);
      assert.equal(there.ok, here !== null, JSON.stringify({ old, add, del, def }));
      if (here) assert.deepEqual(there.next, here);
    }
  });
});

describe("bare-box test, sink against probe on loopback", { skip: PY ? false : "no python3 here" }, () => {
  const sink = join(ROOT, "remote", "node", "sink.py");
  const probe = join(ROOT, "remote", "inside", "probe.py");
  it("PASS when 256 KB moves both ways, CLOSED when nothing listens", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = spawn(PY, [sink, String(port), "20"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const ok = spawnSync(PY, [probe, "127.0.0.1", String(port)], { encoding: "utf8" });
      assert.match(ok.stdout, new RegExp(`^${port} PASS up 262144/262144 [\\d.]+s down 262144/262144 [\\d.]+s`));
      assert.ok(!ok.stdout.includes("127.0.0.1"), "the probe never prints the address");
    } finally {
      server.kill();
    }
    const closed = spawnSync(PY, [probe, "127.0.0.1", "9"], { encoding: "utf8" });
    assert.match(closed.stdout, /^9 CLOSED/);
  });
  it("HELD when the far side stops reading partway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-held-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    // A stand-in for a held path: accepts, reads 64 KB, then stalls.
    writeFileSync(join(dir, "stall.py"), [
      "import socket, sys, time",
      "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
      "s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)",
      "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(1)",
      "c, _ = s.accept(); got = 0",
      "while got < 65536: got += len(c.recv(4096))",
      "time.sleep(30)",
    ].join("\n"));
    const server = spawn(PY, [join(dir, "stall.py"), String(port)], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const held = spawnSync(PY, [probe, "127.0.0.1", String(port), String(8 * 1024 * 1024)], { encoding: "utf8", timeout: 40_000 });
      assert.match(held.stdout, new RegExp(`^${port} HELD up 0/8388608`), "what the far side acknowledged is what counts, not what the kernel buffered");
    } finally {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
