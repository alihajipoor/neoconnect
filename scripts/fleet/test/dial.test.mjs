/**
 * WireGuard, OpenVPN and IKEv2 proven by the tool itself (2026-11-14):
 * before this, add.canary-other waited for a person to connect each in
 * the real app on a VM (26 minutes on finland-4).
 *
 *   - remote/node/session.sh reads the server's own view of one session
 *     (WireGuard's peer counters, OpenVPN's status file, IKEv2's SA list)
 *     and prints numbers only;
 *   - dial_set / dial_one decide: the client side must pass AND the
 *     server's own view must show this session moving 256 KB each way;
 *   - remote/panel/nx-dial.sh runs the real client in a container that
 *     cannot reach the host's network, and removes it on any exit.
 *
 * Stand-ins replace every host. That the clients really connect was
 * shown only by a real run (fleet prove finland-4); nothing here dials.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASH = process.env.FLEET_BASH || "bash";
const posix = (p) => p.replace(/\\/g, "/");

let dir;
let fix;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-dial-"));
  fix = join(dir, "fix");
  mkdirSync(fix);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------- the server's own view

// A stand-in command on PATH that prints a fixture.
const standIn = (name, text) => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, `${name}.out`), text);
  const f = join(bin, name);
  writeFileSync(f, `#!/bin/bash\ncat '${posix(join(dir, `${name}.out`))}'\n`);
  chmodSync(f, 0o755);
  return bin;
};
const session = (kind, id, env = {}) => {
  const r = spawnSync(BASH, [join(ROOT, "remote/node/session.sh"), kind, id], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};

describe("session.sh: the server's own view, numbers only", () => {
  const PUB = "c2VydmVyLXNpZGUtdmlldy1vZi1hLXB1YmxpYy1rZXk9";
  it("WireGuard: the peer's counters and handshake age, by its public key", () => {
    const now = Math.floor(Date.now() / 1000);
    const dump = [
      "wg0\tPRIVATEKEY-NEVER-PRINTED\tSERVERPUB\t26200\toff",
      `wg0\tOTHERPEER=\t(none)\t192.0.2.9:1111\t10.66.0.9/32\t${now - 5}\t1\t2\t0`,
      `wg0\t${PUB}\t(none)\t192.0.2.10:2222\t10.66.0.10/32\t${now - 12}\t300000\t310000\t0`,
    ].join("\n");
    const bin = standIn("wg", dump + "\n");
    const r = session("wireguard", PUB, { PATH: bin + delimiter + process.env.PATH });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^SESSION wireguard found rx=300000 tx=310000 age=1[0-9]$/);
    assert.doesNotMatch(r.out, /PRIVATEKEY|192\.0\.2/);
  });
  it("WireGuard: a peer that never shook hands, or no such peer, is absent", () => {
    const bin = standIn("wg", `wg0\t${PUB}\t(none)\t(none)\t10.66.0.10/32\t0\t0\t0\t0\n`);
    let r = session("wireguard", PUB, { PATH: bin + delimiter + process.env.PATH });
    assert.equal(r.code, 1);
    assert.match(r.out, /absent \(peer never shook hands\)/);
    r = session("wireguard", "nobody=", { PATH: bin + delimiter + process.env.PATH });
    assert.match(r.out, /absent \(no such peer\)/);
  });
  it("OpenVPN: status-version 2 (the systemd unit's) and version 1 (server.conf's)", () => {
    const cn = "4b1d2c3e-0000-4000-8000-00000000c0de";
    const v2 = join(dir, "status-server.log");
    writeFileSync(v2, [
      "TITLE,OpenVPN 2.6",
      "HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID,Data Channel Cipher",
      "CLIENT_LIST,someone-else,192.0.2.1:1,10.77.0.2,,5,6,x,1,UNDEF,0,0,AES-256-GCM",
      `CLIENT_LIST,${cn},192.0.2.2:2,10.77.0.3,,295000,306000,x,1,UNDEF,1,1,AES-256-GCM`,
      "END",
    ].join("\n") + "\n");
    let r = session("openvpn", cn, { NX_OVPN_STATUS: posix(v2) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^SESSION openvpn found rx=295000 tx=306000 age=\d+$/);
    assert.doesNotMatch(r.out, /192\.0\.2|10\.77/);
    const v1 = join(dir, "openvpn-status.log");
    writeFileSync(v1, ["OpenVPN CLIENT LIST", "Updated,2026-11-14 02:00:00", "Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since", `${cn},192.0.2.2:2,1000,2000,2026-11-14 01:59:00`, "ROUTING TABLE"].join("\n") + "\n");
    r = session("openvpn", cn, { NX_OVPN_STATUS: posix(v1) });
    assert.match(r.out, /^SESSION openvpn found rx=1000 tx=2000 age=\d+$/);
    r = session("openvpn", "not-connected", { NX_OVPN_STATUS: `${posix(v1)} ${posix(v2)}` });
    assert.equal(r.code, 1);
    assert.match(r.out, /absent \(not in any status file\)/);
  });
  it("IKEv2: the youngest SA of that EAP user (an old one a client left behind is not it)", () => {
    const sas = [
      "neoxify-ikev2: #3, ESTABLISHED, IKEv2, a_i b_r*",
      "  local  'host.example.org' @ 192.0.2.1[4500]",
      "  remote '10.0.0.2' @ 192.0.2.7[4500] EAP: 'nx-00ab' [10.68.0.2]",
      "  established 900s ago",
      "  neoxify-ikev2: #1, reqid 1, INSTALLED, TUNNEL-in-UDP, ESP:AES_GCM_16-256",
      "    in  c1a2b3c4, 999999 bytes,   500 packets,     1s ago",
      "    out c4b3a2c1, 999999 bytes,   450 packets,     1s ago",
      "neoxify-ikev2: #9, ESTABLISHED, IKEv2, c_i d_r*",
      "  remote '10.0.0.3' @ 192.0.2.7[4500] EAP: 'nx-00ab' [10.68.0.3]",
      "  established 7s ago",
      "  neoxify-ikev2: #5, reqid 1, INSTALLED, TUNNEL-in-UDP, ESP:AES_GCM_16-256",
      "    in  cdf8f71a, 285045 bytes,   327 packets,     6s ago",
      "    out d1a098e0, 295020 bytes,   305 packets,     6s ago",
      "neoxify-ikev2: #10, ESTABLISHED, IKEv2, e_i f_r*",
      "  remote '10.0.0.4' @ 192.0.2.8[4500] EAP: 'nx-other' [10.68.0.4]",
      "  established 1s ago",
    ].join("\n");
    const bin = standIn("swanctl", sas + "\n");
    let r = session("ikev2", "nx-00ab", { PATH: bin + delimiter + process.env.PATH });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, "SESSION ikev2 found rx=285045 tx=295020 age=7 sas=2");
    r = session("ikev2", "nx-gone", { PATH: bin + delimiter + process.env.PATH });
    assert.equal(r.code, 1);
    assert.match(r.out, /absent \(no SA for that user\)/);
  });
});

// ------------------------------------------------- what the step decides

const stateOf = (key) => {
  const m = existsSync(join(dir, "state")) ? new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(join(dir, "state"), "utf8")) : null;
  return m ? m[1] : undefined;
};
const state = (pairs) => writeFileSync(join(dir, "state"), Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
const step = (fn, env = {}, ...args) => {
  const r = spawnSync(BASH, [join(HERE, "steps-harness.sh"), fn, ...args], { encoding: "utf8", env: { ...process.env, T_RUN: dir, T_FIX: fix, T_OLD: "", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const PORTS = "WIREGUARD/UDP|26200;OPENVPN/UDP|31205;IKEV2/UDP|500;XRAY_TROJAN/TCP|8443";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CREDS = `IKEV2|${U(3)}|nx-00ab;OPENVPN|${U(2)}|${U(20)};WIREGUARD|${U(1)}|cHVibGljLWtleS1vZi10aGUtcGVlcg==`;

describe("add.canary-other: dialled by the tool, the server's own view agreeing", () => {
  it("all three dialled and confirmed by the server: proven, on the record, and the verify passes", () => {
    const r = step("do_add_canary_other", { T_NODE_PORTS: PORTS, T_DIAL_CREDS: CREDS });
    assert.equal(r.code, 0, r.out);
    for (const p of ["wireguard", "openvpn", "ikev2"]) assert.equal(stateOf(`canary_${p}`), "pass", r.out);
    assert.match(r.out, /WIREGUARD: the server's own view: this session received 292 KB and sent 292 KB/);
    assert.match(r.out, /IKEV2: PROVEN by the scripted dial/);
    assert.match(readFileSync(join(dir, "run.log"), "utf8"), /PROVEN OPENVPN on germany-4 \(scripted dial/);
    assert.equal(step("ok_add_canary_other").code, 0);
    // The canary account's credentials, through the canary plan; each dialled once.
    assert.equal((calls().match(/nx-dial\.sh /g) || []).length, 3);
    assert.match(calls(), new RegExp(`nx-dial\\.sh ${U(1)} 'germany-4 wireguard issued' 25`));
    assert.match(calls(), /nx-mint\.sh/);
    assert.match(calls(), /shred -u \/dev\/shm\/nxf\/admin-token/);
  });

  it("a client that does not connect stops the run before the customer plans", () => {
    const r = step("do_add_canary_other", { T_NODE_PORTS: PORTS, T_DIAL_CREDS: CREDS, T_DIAL: "openvpn=fail" });
    assert.match(r.out, /OPENVPN: the scripted dial did NOT pass/);
    assert.match(r.out, /no WireGuard handshake in 20 s/);
    assert.equal(stateOf("canary_openvpn"), "fail");
    assert.equal(stateOf("canary_wireguard"), "pass");
    const v = step("ok_add_canary_other");
    assert.equal(v.code, 1);
    assert.match(v.out, /NOT PROVEN on this server: openvpn\. The customer plans are NOT touched/);
    assert.match(v.out, /--proven-elsewhere openvpn/);
  });

  it("--proven-elsewhere counts only where the dial failed, and the log says both", () => {
    step("do_add_canary_other", { T_NODE_PORTS: PORTS, T_DIAL_CREDS: CREDS, T_DIAL: "ikev2=fail", T_PROVEN: "ikev2,wireguard" });
    assert.equal(stateOf("canary_ikev2"), "elsewhere");
    assert.equal(stateOf("canary_wireguard"), "pass", "dialled and passed: the flag is not what proved it");
    const log = readFileSync(join(dir, "run.log"), "utf8");
    assert.match(log, /PROVEN-ELSEWHERE IKEV2 on germany-4 \(--proven-elsewhere; the scripted dial did not pass\)/);
    assert.doesNotMatch(log, /PROVEN-ELSEWHERE WIREGUARD/);
    assert.equal(step("ok_add_canary_other").code, 0);
  });

  it("the client passing is not enough: the server must see the session", () => {
    const r = step("do_add_canary_other", { T_NODE_PORTS: PORTS, T_DIAL_CREDS: CREDS, T_SESSION_IKEV2: "SESSION ikev2 absent (no SA for that user)" });
    assert.match(r.out, /IKEV2: the tunnel passed from the client's side, but the server's own view did not confirm it: SESSION ikev2 absent/);
    assert.equal(stateOf("canary_ikev2"), "fail");
  });

  it("WireGuard counters that did not move by 256 KB each way are not this dial", () => {
    const r = step("do_add_canary_other", {
      T_NODE_PORTS: "WIREGUARD/UDP|26200", T_DIAL_CREDS: CREDS,
      T_SESSION_WIREGUARD_BEFORE: "SESSION wireguard found rx=100000 tx=100000 age=4000",
      T_SESSION_WIREGUARD: "SESSION wireguard found rx=300000 tx=500000 age=2",
    });
    assert.equal(stateOf("canary_wireguard"), "fail", r.out);
  });

  it("an OpenVPN status file older than the dial is not this session", () => {
    step("do_add_canary_other", { T_NODE_PORTS: "OPENVPN/UDP|31205", T_DIAL_CREDS: CREDS, T_SESSION_OPENVPN: "SESSION openvpn found rx=300000 tx=300000 age=999" });
    assert.equal(stateOf("canary_openvpn"), "fail");
  });

  it("no credential issued through the canary: NOT DIALLED, and nothing is dialled", () => {
    const r = step("do_add_canary_other", { T_NODE_PORTS: "IKEV2/UDP|500", T_DIAL_CREDS: `WIREGUARD|${U(1)}|k=` });
    assert.match(r.out, /IKEV2: NOT DIALLED, the test account holds no panel-issued IKEV2 credential on this server through 'Internal test'/);
    assert.doesNotMatch(calls(), /nx-dial\.sh/);
    assert.equal(stateOf("canary_ikev2"), "fail");
  });

  it("a protocol proven on an earlier pass is not dialled again", () => {
    state({ canary_wireguard: "pass" });
    const r = step("do_add_canary_other", { T_NODE_PORTS: PORTS, T_DIAL_CREDS: CREDS });
    assert.match(r.out, /WIREGUARD: proven by the scripted dial on an earlier pass/);
    assert.doesNotMatch(calls(), /wireguard issued/);
    assert.match(calls(), /openvpn issued/);
  });

  it("session_ok: 256 KB each way more than before, and fresh", () => {
    const ok = (...a) => step("session_ok", {}, ...a.map(String)).code;
    assert.equal(ok("wireguard", 0, 0, 262144, 262144, 30, 40), 0);
    assert.equal(ok("wireguard", 0, 0, 262143, 262144, 30, 40), 1);
    assert.equal(ok("wireguard", 0, 0, 300000, 300000, 181, 400), 1, "handshake too old");
    assert.equal(ok("openvpn", 0, 0, 300000, 300000, 41, 40), 1, "status file written before the dial");
    assert.equal(ok("ikev2", 0, 0, 300000, 300000, 10, 40), 0);
    assert.equal(ok("ikev2", 0, 0, 300000, 300000, 50, 40), 1, "an SA older than the dial");
    assert.equal(ok("shadowsocks", 0, 0, 300000, 300000, 0, 40), 1);
  });
});

// ------------------------------------------------- the container

describe("nx-dial.sh: a throwaway container that cannot touch the host", () => {
  const code = (f) => readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  it("its own network namespace, only the capabilities a client needs, limits, removed on any exit", () => {
    const c = code("remote/panel/nx-dial.sh");
    assert.doesNotMatch(c, /--privileged|--network[ =]host|--net[ =]host|--pid[ =]host|--userns[ =]host/);
    assert.match(c, /--network bridge --cap-drop ALL/);
    assert.match(c, /CAPS=\(--cap-add NET_ADMIN\)/);
    assert.doesNotMatch(c, /--cap-add (SYS_|ALL)/);
    for (const f of ["--read-only", "--security-opt no-new-privileges", "--memory 128m", "--cpus 0.5", "--pids-limit 64", "--rm", "--device /dev/net/tun"]) assert.ok(c.includes(f), f);
    assert.match(c, /trap cleanup EXIT/);
    assert.match(c, /docker rm -f "\$NAME"/);
    assert.match(c, /timeout -k 5 /);
    assert.match(c, /timeout -k 3 "\$LIMIT"/);
    // The credential lives in RAM and is shredded.
    assert.match(c, /mktemp -d \/dev\/shm\/nxf\/dial\./);
    assert.match(c, /shred -u/);
  });
  it("never prints a credential", () => {
    const c = code("remote/panel/nx-dial.sh");
    assert.doesNotMatch(c, /echo[^\n]*\$\(?(T|U)\b/);
    assert.doesNotMatch(c, /cat "\$D\/(u\.json|wg\.conf|client\.ovpn|swanctl\.conf)"/);
    assert.match(c, /PRIVATE KEY\|BEGIN CERT\|secret\|password\|PrivateKey\/Id/);
    const inner = code("remote/panel/nx-dial-inner.sh");
    assert.doesNotMatch(inner, /cat \/nx\/(wg\.conf|client\.ovpn|swanctl\.conf)/);
    assert.match(inner, /grep -viE "secret\|password\|key"/);
  });
  it("leaves the server the way a real client does (IKEv2 DELETE, OpenVPN exit notify)", () => {
    const inner = code("remote/panel/nx-dial-inner.sh");
    assert.match(inner, /swanctl --terminate --ike nx/);
    assert.match(inner, /trap teardown EXIT/);
    assert.match(code("remote/panel/nx-dial.sh"), /explicit-exit-notify 1/);
  });
  it("IKEv2 in userspace (kernel-libipsec): the host kernel's IPsec is not used", () => {
    assert.match(code("remote/panel/nx-dial-inner.sh"), /kernel-libipsec/);
    assert.match(code("remote/panel/nx-dial-image.sh"), /libcharon-extra-plugins/);
  });
});
