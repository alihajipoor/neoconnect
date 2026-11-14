/**
 * One command, start to end, with nobody at the keyboard: what the
 * 2026-11-13/14 Finland runs needed a hand for, each pinned here.
 *
 *   - "--done" on a step that is not the owner's re-ran its action, and so
 *     took a second database dump: now --done runs the verify only;
 *   - every step took a fresh dump: now a run takes one and reuses it;
 *   - a stop said "run the same command again": now it prints the exact
 *     `fleet continue` line, with the gate's flag where it was a gate;
 *   - nothing said how long a step took: now each does, with a total;
 *   - the UDP-over-TCP test counted dig's error line as an answer;
 *   - a dead Xray and an IKEv2 loader never started passed the checks
 *     after the install: engines.sh looks at running AND listening;
 *   - the second operator key was silently skipped when unset;
 *   - the canary: no customer plan before every protocol is proven
 *     through "Internal test", whose flags come back exactly as they were.
 *
 * Stand-ins replace every host. None of this is a server: that a real
 * run goes through is shown only by a real run.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planSteps } from "../lib/planlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASH = process.env.FLEET_BASH || "bash";
const has = (cmd) => !spawnSync(cmd, ["--version"], { encoding: "utf8" }).error;
// FLEET_JQ=1: a jq the shell finds that node cannot start (a script stand-in).
const JQ = has("jq") || process.env.FLEET_JQ === "1";

// ------------------------------------------------------------- the engine

describe("engine: --done, the continue line, timings", () => {
  let home;
  const run = (env = {}) => {
    const r = spawnSync(BASH, [join(HERE, "engine-harness.sh")], { encoding: "utf8", env: { ...process.env, FLEET_HOME: home, FLEET_NO_TTY: "1", ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const runDir = () => join(home, "runs", readdirSync(join(home, "runs")).sort().at(-1));
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fleet-onerun-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("--done on a step that is not the owner's never runs its action, only its verify", () => {
    const r = run({ T_DONE: "t.one" });
    assert.match(r.out, /--done t\.one: its action is not run again; only its verify runs/);
    assert.doesNotMatch(r.out, /one ran against/, "t.one's action ran although --done named it");
    assert.ok(!/^one=/m.test(existsSync(join(runDir(), "state")) ? readFileSync(join(runDir(), "state"), "utf8") : ""));
    assert.match(readFileSync(join(runDir(), "done"), "utf8"), /^t\.one$/m, "the verify passed, so the step is done");
    assert.match(readFileSync(join(runDir(), "run.log"), "utf8"), /VERIFY-ONLY t\.one \(--done\)/);
  });

  it("--done whose verify fails is not done, and the next pass runs the action", () => {
    let r = run({ T_DONE: "t.two" });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /two ran/);
    assert.match(r.out, /VERIFY FAILED/);
    writeFileSync(join(home, "allow-two"), "");
    r = run();
    assert.match(r.out, /two ran/);
  });

  it("a stop prints the exact continue line, and the gate's flag when the step has one", () => {
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /scripts\/fleet\/fleet continue \S+toy-subject-\S+\n/);
    assert.match(r.out, /go on past this gate[^\n]*\n\s+scripts\/fleet\/fleet continue \S+ --accept-two/);
  });

  it("an owner's stop with no terminal prints the continue line with --done", () => {
    writeFileSync(join(home, "allow-two"), "");
    const r = run();
    assert.match(r.out, /scripts\/fleet\/fleet continue \S+ --done t\.owner/);
  });

  it("every step says how long it took; the pass ends with a table and a total, kept in timings.txt", () => {
    writeFileSync(join(home, "allow-two"), "");
    writeFileSync(join(home, "owner-did-it"), "");
    const r = run({ T_DONE: "t.owner" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /took \d+s/);
    assert.match(r.out, /Time per step, this pass:[\s\S]*TOTAL\s+\d+s/);
    const t = readFileSync(join(runDir(), "timings.txt"), "utf8");
    for (const id of ["t.one", "t.two", "t.owner", "t.three"]) assert.match(t, new RegExp("^" + id.replace(".", "\\.") + "\\s+\\d+ try", "m"));
    assert.match(t, /^TOTAL/m);
  });
});

// ------------------------------------------------------------- the steps

let dir;
let fix;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-onerun-steps-"));
  fix = join(dir, "fix");
  mkdirSync(fix);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const state = (pairs) => writeFileSync(join(dir, "state"), Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
const stateOf = (key) => {
  const m = existsSync(join(dir, "state")) ? new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(join(dir, "state"), "utf8")) : null;
  return m ? m[1] : undefined;
};
const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
const step = (fn, env = {}, ...args) => {
  const r = spawnSync(BASH, [join(HERE, "steps-harness.sh"), fn, ...args], { encoding: "utf8", env: { ...process.env, T_RUN: dir, T_FIX: fix, T_OLD: "", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("one database dump per run", () => {
  it("a later step reuses the run's dump, and says so; nothing is dumped", () => {
    state({ run_dump_file: "/root/db-backups/pre-germany-4-20261114T000000Z.sql.gz", run_dump_at: "2026-11-14T00:00:00Z" });
    const r = step("run_dump", {}, "pre-germany-4");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /reusing this run's dump \/root\/db-backups\/pre-germany-4-/);
    assert.doesNotMatch(calls(), /pg_dump/);
  });
  it("the first step that needs one takes it", () => {
    const r = step("run_dump", {}, "pre-germany-4");
    assert.match(calls(), /pg_dump/);
    assert.equal(r.code, 1, "the stand-in's empty answer is not a dump");
  });
  it("--fresh-dump takes a new one although the run has one", () => {
    state({ run_dump_file: "/root/db-backups/old.sql.gz" });
    const r = step("run_dump", { T_FRESH: "1" }, "pre-germany-4");
    assert.match(r.out, /--fresh-dump: a new dump/);
    assert.match(calls(), /pg_dump/);
  });
  it("no step calls panel_dump itself: every one goes through run_dump", () => {
    for (const f of ["checklist-add.sh", "checklist-retire.sh", "checklist-replace.sh", "checklist-precheck.sh"]) {
      const code = readFileSync(join(ROOT, "lib", f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
      assert.doesNotMatch(code, /\bpanel_dump\b/, `${f} takes a dump of its own`);
    }
  });
});

describe("the second operator key", () => {
  it("unset is a stop, not a silent pass", () => {
    const r = step("second_key_file", { T_EXTRA_KEY: "" });
    assert.equal(r.code, 1);
    assert.match(r.out, /EXTRA_AUTHORIZED_KEY_FILE is not set/);
  });
  it("'none' is a decision, and passes", () => {
    const r = step("second_key_file", { T_EXTRA_KEY: "none" });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), "none");
  });
  it("a file that is not one public key line is refused", () => {
    const f = join(dir, "k");
    writeFileSync(f, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    assert.equal(step("second_key_file", { T_EXTRA_KEY: f }).code, 1);
    writeFileSync(f, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample operator\n");
    assert.equal(step("second_key_file", { T_EXTRA_KEY: f }).code, 0);
  });
});

describe("the canary: no customer plan before every protocol is proven", () => {
  const ROW = "00000000-0000-4000-8000-0000000000aa|f|f|16|0|0";
  it("refuses a canary plan that is purchasable, or that a customer is on", () => {
    assert.equal(step("canary_refuse_customers", {}, ROW).code, 0);
    let r = step("canary_refuse_customers", {}, "00000000-0000-4000-8000-0000000000aa|f|t|16|0|0");
    assert.equal(r.code, 1);
    assert.match(r.out, /purchasable/);
    r = step("canary_refuse_customers", {}, "00000000-0000-4000-8000-0000000000aa|t|f|16|3|1");
    assert.equal(r.code, 1);
    assert.match(r.out, /1 subscription\(s\) of people other than the test accounts/);
    assert.equal(step("canary_refuse_customers", {}, "").code, 1, "no such plan");
  });

  it("WireGuard, OpenVPN and IKEv2 not dialled (no issued credential): the run stops before the customer plans, naming them and the line to continue", () => {
    const ports = "WIREGUARD/UDP|26200;OPENVPN/UDP|31205;IKEV2/UDP|500;XRAY_TROJAN/TCP|8443";
    let r = step("do_add_canary_other", { T_NODE_PORTS: ports });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /WIREGUARD: NOT DIALLED, the test account holds no panel-issued WIREGUARD credential on this server through 'Internal test'/);
    assert.equal(stateOf("canary_wireguard"), "fail");
    r = step("ok_add_canary_other");
    assert.equal(r.code, 1);
    assert.match(r.out, /NOT PROVEN on this server: wireguard openvpn ikev2/);
    assert.match(r.out, /customer plans are NOT touched/);
    assert.match(r.out, /fleet continue \S+ --proven-elsewhere wireguard,openvpn,ikev2/);
  });

  it("--proven-elsewhere puts each on the record, and only the named ones pass", () => {
    const ports = "WIREGUARD/UDP|26200;OPENVPN/UDP|31205;IKEV2/UDP|500";
    step("do_add_canary_other", { T_NODE_PORTS: ports, T_PROVEN: "wireguard,openvpn" });
    assert.equal(stateOf("canary_wireguard"), "elsewhere");
    assert.equal(stateOf("canary_ikev2"), "fail");
    const r = step("ok_add_canary_other");
    assert.equal(r.code, 1);
    assert.match(r.out, /NOT PROVEN on this server: ikev2/);
    assert.match(readFileSync(join(dir, "run.log"), "utf8"), /PROVEN-ELSEWHERE WIREGUARD/);
    step("do_add_canary_other", { T_NODE_PORTS: ports, T_PROVEN: "wireguard,openvpn,ikev2" });
    assert.equal(step("ok_add_canary_other").code, 0);
  });

  it("a protocol the server does not have is not asked for", () => {
    step("do_add_canary_other", { T_NODE_PORTS: "WIREGUARD/UDP|26200" , T_PROVEN: "wireguard" });
    assert.equal(stateOf("canary_other_have").trim(), "WIREGUARD");
    assert.equal(step("ok_add_canary_other").code, 0);
  });

  it("the canary is closed only when its flags are exactly what they were", () => {
    state({ canary_before: "f|f", canary_subs: "" });
    assert.equal(step("ok_add_canary_close", { T_CANARY_ROW: "id|f|f|24|0|0" }).code, 0);
    let r = step("ok_add_canary_close", { T_CANARY_ROW: "id|t|f|24|0|0" });
    assert.equal(r.code, 1, "left active");
    assert.match(r.out, /were f\|f before this run/);
    state({ canary_before: "f|f", canary_subs: "00000000-0000-4000-8000-000000000001," });
    assert.equal(step("ok_add_canary_close", { T_CANARY_ROW: "id|f|f|24|0|0" }).code, 1, "a test subscription is still there");
  });

  it("the panel helper never sends isPurchasable, and refuses any plan but the canary", () => {
    const code = readFileSync(join(ROOT, "remote/panel/nx-canary.sh"), "utf8");
    assert.doesNotMatch(code.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n"), /"isPurchasable"\s*:/);
    assert.match(code, /REFUSED: that plan is not named/);
    assert.match(code, /isPurchasable CHANGED/);
    assert.match(code, /ROUTE SET CHANGED/);
  });

  it("the canary plan takes direct AND relay routes; every other plan its own kind", () => {
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const plans = [
      { id: id(90), name: "Internal test", relayOnly: false, activeSubs: 0, routeIds: [id(1)], defaultRouteId: null },
      { id: id(91), name: "Starter", relayOnly: false, activeSubs: 9, routeIds: [id(1)], defaultRouteId: null },
      { id: id(92), name: "Ultimate", relayOnly: true, activeSubs: 1, routeIds: [id(2)], defaultRouteId: null },
    ];
    const incoming = { direct: [id(10), id(11)], relay: [id(20)], byShape: {} };
    const both = planSteps(plans, incoming, {}, {}, ["Internal test"]);
    assert.deepEqual(both.find((s) => s.name === "Internal test").add, [id(10), id(11), id(20)]);
    assert.deepEqual(both.find((s) => s.name === "Starter").add, [id(10), id(11)]);
    assert.deepEqual(both.find((s) => s.name === "Ultimate").add, [id(20)]);
    const plain = planSteps(plans, incoming, {}, {});
    assert.deepEqual(plain.find((s) => s.name === "Internal test").add, [id(10), id(11)]);
  });
});

// ------------------------------------------------------- scripts on the box

describe("uot-test.sh counts only real answers", () => {
  const count = (text) => {
    const r = spawnSync(BASH, [join(ROOT, "remote/node/uot-test.sh"), "--count-answers"], { input: text, encoding: "utf8" });
    return r.stdout.trim();
  };
  it("dig's 'connection timed out' line is not an answer (it made a dead Xray a PASS)", () => {
    assert.equal(count(";; connection timed out; no servers could be reached\n"), "0");
    assert.equal(count(""), "0");
  });
  it("addresses are", () => {
    assert.equal(count("192.0.2.14\n"), "1");
    assert.equal(count("www.example.com.\n192.0.2.14\n192.0.2.15\n"), "2");
  });
});

describe("engines.sh: running AND listening", { skip: JQ ? false : "jq is not installed here (CI has it)" }, () => {
  // Stand-ins for systemctl, ss, wg and swanctl. FAKE_DOWN names the units
  // that are not running; FAKE_LISTEN the ports that listen ("tcp:443").
  let bin;
  const setup = () => {
    bin = join(dir, "bin");
    mkdirSync(bin);
    const sh = (name, body) => { writeFileSync(join(bin, name), "#!/usr/bin/env bash\n" + body + "\n"); chmodSync(join(bin, name), 0o755); };
    sh("systemctl", `case "$1" in
  show) [[ "$3" == LoadState ]] && echo loaded || echo /etc/systemd/system/x ;;
  is-active) for u in $FAKE_DOWN; do [[ "$2" == "$u" ]] && { echo inactive; exit 3; }; done; echo active ;;
  start|restart) echo "$1 $2" >>"$FAKE_CALLS"; FAKE_DOWN="" ;;
esac`);
    sh("ss", `proto=tcp; [[ "$1" == -Hlun ]] && proto=udp; p=$(sed -n 's/.*sport = :\\([0-9]*\\).*/\\1/p' <<<"$2"); for l in $FAKE_LISTEN; do [[ "$l" == "$proto:$p" ]] && { echo "LISTEN 0 0 *:$p"; exit 0; }; done; exit 0`);
    sh("wg", `echo 26200`);
    sh("swanctl", `[[ -n "$FAKE_NO_CONNS" ]] || echo "ikev2-eap: IKEv2, no reauthentication, rekeying every 14400s"`);
    sh("sleep", "exit 0");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ inbounds: [{ tag: "api", port: 10085 }, { tag: "vless-in", port: 443 }, { tag: "trojan-in", port: 8443 }] }));
    writeFileSync(join(dir, "server.conf"), "port 31205\nproto udp\n");
  };
  const LISTEN = "tcp:10085 tcp:443 tcp:8443 tcp:80 udp:26200 udp:31205 udp:500 udp:4500";
  const engines = (mode, env) => {
    const r = spawnSync(BASH, [join(ROOT, "remote/node/engines.sh"), mode], {
      encoding: "utf8",
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, NX_XRAY_CONFIG: join(dir, "config.json"), NX_OVPN_CONF: join(dir, "server.conf"), FAKE_CALLS: join(dir, "calls"), FAKE_LISTEN: LISTEN, FAKE_DOWN: "", ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  it("everything up: ok", () => {
    setup();
    const r = engines("check");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ok engine xray listens on tcp 443/);
    assert.match(r.out, /ok engine ikev2 has its connections loaded/);
  });
  it("Xray dead: DOWN, and its ports are not listening", () => {
    setup();
    const r = engines("check", { FAKE_DOWN: "xray", FAKE_LISTEN: "tcp:80 udp:26200 udp:31205 udp:500 udp:4500" });
    assert.equal(r.code, 1);
    assert.match(r.out, /DOWN engine unit xray/);
    assert.match(r.out, /DOWN engine xray does not listen on tcp 443/);
  });
  it("the IKEv2 loader enabled and never started: DOWN; fix starts it and never restarts it", () => {
    setup();
    const r = engines("fix", { FAKE_DOWN: "neoxify-swanctl-load" });
    assert.match(r.out, /started neoxify-swanctl-load/);
    assert.match(readFileSync(join(dir, "calls"), "utf8"), /^start neoxify-swanctl-load$/m);
    assert.doesNotMatch(readFileSync(join(dir, "calls"), "utf8"), /restart neoxify-swanctl-load/);
  });
  it("IKEv2 up with nothing loaded is DOWN", () => {
    setup();
    const r = engines("check", { FAKE_NO_CONNS: "1" });
    assert.equal(r.code, 1);
    assert.match(r.out, /ikev2 has no connection loaded/);
  });
});

describe("fleet continue", () => {
  it("runs the command the run was started with, from its directory", () => {
    const run = join(dir, "add-example-1-20261114T000000Z");
    mkdirSync(run);
    writeFileSync(join(run, "argv"), "steps\nadd\n");
    const r = spawnSync(BASH, [join(ROOT, "fleet"), "continue", run], { encoding: "utf8" });
    assert.match(r.stdout, /^add\.canary-other\s+gate/m, r.stdout + r.stderr);
  });
  it("refuses a directory with no saved command line", () => {
    const run = join(dir, "old-run");
    mkdirSync(run);
    const r = spawnSync(BASH, [join(ROOT, "fleet"), "continue", run], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no saved command line/);
  });
});
