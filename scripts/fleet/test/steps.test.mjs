/**
 * What the steps DECIDE, with the hosts replaced by stand-ins
 * (steps-harness.sh).
 *
 * The dry-run test holds the list of steps still, and shows the commands
 * a step would send. It cannot show what a step does once the hosts have
 * answered, and that is where a coverage review against the real server
 * changes of November 2026 found the tool wrong:
 *
 *   - a hop move that stopped halfway was finished wrongly by running it
 *     again (the exits already moved lost their port), and a third run
 *     said "nothing to move" with the relay's boot-time file still
 *     pointing at the server about to go;
 *   - one failed SSH connection made a live server "gone", and its names
 *     were deleted;
 *   - the proof with panel-issued credentials passed with one credential;
 *   - an exit the relay reaches only through the hop could not pass the
 *     straight-from-inside tunnels, and the run stopped for good.
 *
 * Each case here is one of those, run for real against fixture files.
 * Addresses are documentation ranges. None of this is a server.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChainFw, parseHopRules } from "../lib/hop.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "steps-harness.sh");
const BASH = process.env.FLEET_BASH || "bash";

const RELAY = "198.51.100.20";
const OLD_HOP = "198.51.100.50"; // germany-3, the server being replaced
const NEW_HOP = "198.51.100.60"; // germany-4, the new server
const OTHER_HOP = "198.51.100.70";
const TR = "203.0.113.10";
const NL = "203.0.113.20";
const IN = "203.0.113.30";

const liveRules = (rules) =>
  `table ip neoxify_relay_chain {\n\tchain output { # handle 1\n\t\ttype nat hook output priority -100; policy accept;\n${rules
    .map(([exit, hop, port, comment, handle]) => `\t\tip daddr ${exit} tcp dport 443 counter packets 9 bytes 540 dnat to ${hop}:${port} comment "${comment}" # handle ${handle}`)
    .join("\n")}\n\t}\n}\n`;
const fileRules = (rules) =>
  `#!/usr/sbin/nft -f\nflush ruleset\n\ntable inet neoxify_relay_fw {\n  chain input {\n    type filter hook input priority 0; policy drop;\n    tcp dport 22 accept\n  }\n}\n\ntable ip neoxify_relay_chain {\n  chain output {\n    type nat hook output priority -100; policy accept;\n${rules
    .map(([exit, hop, port, comment]) => `    ip daddr ${exit} tcp dport 443 counter dnat to ${hop}:${port} comment "${comment}"`)
    .join("\n")}\n  }\n}\n`;
const chainFw = (hops) =>
  `table ip neoxify_chain\ndelete table ip neoxify_chain\ntable ip neoxify_chain {\n  set relays {\n    type ipv4_addr\n    elements = { ${RELAY} }\n  }\n  chain prerouting {\n    type nat hook prerouting priority dstnat; policy accept;\n${hops
    .map(([port, ip, name]) => `    ip saddr @relays tcp dport ${port} counter dnat to ${ip}:443 comment "${name}"`)
    .join("\n")}\n  }\n  chain postrouting {\n    type nat hook postrouting priority srcnat; policy accept;\n    ip saddr @relays ip daddr { ${hops.map((h) => h[1]).join(", ")} } tcp dport 443 counter masquerade\n  }\n}\n`;

const viaOld = [[TR, OLD_HOP, 47131, "turkey-1 via germany-3", 2], [NL, OLD_HOP, 47132, "netherlands-1 via germany-3", 3]];
const viaNew = [[TR, NEW_HOP, 47131, "turkey-1 via germany-4", 2], [NL, NEW_HOP, 47132, "netherlands-1 via germany-4", 3]];
const half = [viaNew[0], viaOld[1]]; // the first pass moved turkey-1 and stopped

// dir is the run directory the step works in; fix holds what the hosts
// would answer with. They are kept apart: a step deletes its own working
// copies when it is done.
let dir;
let fix;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-steps-"));
  fix = join(dir, "fix");
  mkdirSync(fix);
  writeFileSync(join(fix, "addresses"), `germany-3=${OLD_HOP}\ngermany-4=${NEW_HOP}\nturkey-1=${TR}\nnetherlands-1=${NL}\nindia-1=${IN}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fixtures = ({ live, file, chain }) => {
  if (live) writeFileSync(join(fix, "hop-live.txt"), liveRules(live));
  if (file) writeFileSync(join(fix, "nftables.conf"), fileRules(file));
  if (chain) writeFileSync(join(fix, "chain-fw.nft"), chainFw(chain));
};
const state = (pairs) => writeFileSync(join(dir, "state"), Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
const run = (fn, env = {}) => {
  const r = spawnSync(BASH, [HARNESS, fn], { encoding: "utf8", env: { ...process.env, T_RUN: dir, T_FIX: fix, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const stateOf = (key) => {
  const m = existsSync(join(dir, "state")) ? new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(join(dir, "state"), "utf8")) : null;
  return m ? m[1] : undefined;
};
const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
const sent = (name) => (existsSync(join(dir, `put-${name}`)) ? readFileSync(join(dir, `put-${name}`), "utf8") : null);
const tableSent = () => parseChainFw(sent("chain-fw.nft.new")).hops.map((h) => h.name);

describe("move.hop, run once and run again", () => {
  it("first pass: the table for both exits, both live rules repointed, both file lines", () => {
    fixtures({ live: viaOld, file: viaOld });
    state({ pre_relay_443: "PASS" });
    const r = run("do_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(tableSent(), ["turkey-1", "netherlands-1"]);
    assert.match(calls(), /relay\.sh hop-set 2\n[\s\S]*relay\.sh hop-set 3\n/);
    const file = parseHopRules(sent("nftables.conf.new"));
    assert.deepEqual(file.map((x) => [x.exitIp, x.hopIp, x.comment]), [[TR, NEW_HOP, "turkey-1 via germany-4"], [NL, NEW_HOP, "netherlands-1 via germany-4"]]);
    assert.equal(stateOf("move_hop"), "2");
    assert.equal(stateOf("move_hop_exits").trim(), "turkey-1 netherlands-1");
  });

  it("second pass, after the first moved one exit and stopped: the table still holds the exit already moved", () => {
    fixtures({ live: half, file: viaOld });
    state({ pre_relay_443: "PASS" });
    const r = run("do_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(tableSent().sort(), ["netherlands-1", "turkey-1"], "loading a table without turkey-1 would cut its relay routes");
    assert.doesNotMatch(calls(), /hop-set 2\n/, "the rule already moved is left alone");
    assert.match(calls(), /hop-set 3\n/);
    assert.equal(parseHopRules(sent("nftables.conf.new")).filter((x) => x.hopIp === NEW_HOP).length, 2);
    assert.equal(stateOf("move_hop"), "2", "both exits are on record as behind the moved hop, so both are dialled by the verify");
  });

  it("live rules all moved but the relay's file not yet: that is not 'nothing to move'", () => {
    fixtures({ live: viaNew, file: viaOld });
    state({ pre_relay_443: "PASS" });
    const r = run("do_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /nothing to move/);
    assert.doesNotMatch(calls(), /hop-set/);
    assert.match(calls(), /relay\.sh hop-file-swap/);
    assert.equal(parseHopRules(sent("nftables.conf.new")).filter((x) => x.hopIp === OLD_HOP).length, 0);
    assert.equal(stateOf("move_hop"), "2");
  });

  it("everything already moved: nothing on the relay is changed, and the move is still on record", () => {
    fixtures({ live: viaNew, file: viaNew });
    state({ pre_relay_443: "PASS" });
    const r = run("do_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(calls(), /hop-set|hop-file-swap/);
    assert.equal(sent("nftables.conf.new"), null);
    assert.equal(stateOf("move_hop"), "2");
  });

  it("an old server that never carried the hop: nothing to move, and nothing is loaded anywhere", () => {
    const elsewhere = [[TR, OTHER_HOP, 47131, "turkey-1 via finland-3", 2]];
    fixtures({ live: elsewhere, file: elsewhere });
    const r = run("do_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing to move/);
    assert.equal(stateOf("move_hop"), "none");
    assert.doesNotMatch(calls(), /hop-server\.sh apply|hop-set|hop-file-swap/);
  });

  it("no live rule through either server but file lines through the old one: stops, records nothing", () => {
    fixtures({ live: [[TR, OTHER_HOP, 47131, "turkey-1 via finland-3", 2]], file: viaOld });
    const r = run("do_move_hop");
    assert.equal(r.code, 1);
    assert.match(r.out, /still has 2 line\(s\) through germany-3/);
    assert.equal(stateOf("move_hop"), undefined);
  });

  it("refuses to make a hop of a server the relay cannot reach", () => {
    fixtures({ live: viaOld, file: viaOld });
    state({ pre_relay_443: "HELD" });
    const r = run("do_move_hop");
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED: germany-3 carries the hop for 2 exit/);
    assert.doesNotMatch(calls(), /hop-server\.sh apply|hop-set/);
  });
});

describe("move.hop's verify reads the relay again, whatever the run recorded", () => {
  it("passes when live rules and file agree with what was moved", () => {
    fixtures({ live: viaNew, file: viaNew });
    state({ move_hop: "2", move_hop_exits: "turkey-1 netherlands-1 " });
    const r = run("ok_move_hop");
    assert.equal(r.code, 0, r.out);
    assert.match(calls(), /rscript new node\/hop-server\.sh check 2/);
    assert.match(calls(), /dial through the moved hop turkey-1 netherlands-1/);
  });
  it("fails while the relay's file still names the old server", () => {
    fixtures({ live: viaNew, file: viaOld });
    state({ move_hop: "2", move_hop_exits: "turkey-1 netherlands-1 " });
    const r = run("ok_move_hop");
    assert.equal(r.code, 1);
    assert.match(r.out, /file still has a line through germany-3/);
  });
  it("fails on 'nothing was moved' when rules go through the new server", () => {
    fixtures({ live: half, file: viaOld });
    state({ move_hop: "none" });
    const r = run("ok_move_hop");
    assert.equal(r.code, 1);
    assert.match(r.out, /a live rule on the relay still goes through germany-3/);
    assert.match(r.out, /no record of a finished move/);
  });
  it("fails when a dial through the moved hop fails, or the hop server's own check does", () => {
    fixtures({ live: viaNew, file: viaNew });
    state({ move_hop: "2", move_hop_exits: "turkey-1 netherlands-1 " });
    assert.equal(run("ok_move_hop", { T_DIAL_RC: "1" }).code, 1);
  });
  it("passes for a server that never carried the hop", () => {
    const elsewhere = [[TR, OTHER_HOP, 47131, "turkey-1 via finland-3", 2]];
    fixtures({ live: elsewhere, file: elsewhere });
    state({ move_hop: "none" });
    assert.equal(run("ok_move_hop").code, 0);
  });
});

describe("retire: the hop", () => {
  it("the guard also refuses when only the relay's file still goes through the server", () => {
    fixtures({ live: viaNew, file: viaOld });
    run("do_retire_guard_hop");
    assert.equal(stateOf("hop_through"), "0");
    assert.equal(stateOf("hop_through_file"), "2");
    const r = run("ok_retire_guard_hop");
    assert.equal(r.code, 1);
    assert.match(r.out, /would load them at its next boot/);
  });

  // india-1 reached the relay through germany-3's hop on 47133.
  const others = [[TR, OLD_HOP, 47131, "turkey-1 via germany-3", 2], [NL, OLD_HOP, 47132, "netherlands-1 via germany-3", 3]];
  const withIndia = [...others, [IN, OLD_HOP, 47133, "india-1 via germany-3", 5]];
  const chainAll = [[47131, TR, "turkey-1"], [47132, NL, "netherlands-1"], [47133, IN, "india-1"]];

  it("removes the exit in all three places", () => {
    fixtures({ live: withIndia, file: withIndia, chain: chainAll });
    const r = run("do_retire_hop", { T_OLD: "india-1" });
    assert.equal(r.code, 0, r.out);
    assert.match(calls(), new RegExp(`relay\\.sh hop-del 5 ${IN.replace(/\./g, "\\.")}`));
    assert.equal(parseHopRules(sent("nftables.conf.new")).some((x) => x.exitIp === IN), false);
    assert.deepEqual(tableSent(), ["turkey-1", "netherlands-1"]);
    assert.equal(stateOf("retire_hop_changed"), "1");
    assert.equal(stateOf("retire_hop_servers").trim(), "germany-3");
  });

  it("run again after it stopped behind the relay's part: the port on the hop server is still removed", () => {
    // The relay's rule and file line are gone; the hop server still forwards 47133.
    fixtures({ live: others, file: others, chain: chainAll });
    state({ retire_hop_servers: "germany-3 ", retire_hop_changed: "1" });
    const r = run("do_retire_hop", { T_OLD: "india-1" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(calls(), /hop-del|hop-file-swap/);
    assert.deepEqual(tableSent(), ["turkey-1", "netherlands-1"], "it used to stop at 'no hop entry' and leave the port open");
    assert.match(calls(), /node\/hop-server\.sh apply/);
  });

  it("an exit that never used the hop changes nothing, and nothing is dialled again", () => {
    fixtures({ live: others, file: others, chain: [[47131, TR, "turkey-1"], [47132, NL, "netherlands-1"]] });
    const r = run("do_retire_hop", { T_OLD: "india-1" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(calls(), /hop-del|hop-file-swap|hop-server\.sh apply/);
    assert.equal(stateOf("retire_hop_changed"), "0");
    const ok = run("ok_retire_hop", { T_OLD: "india-1" });
    assert.equal(ok.code, 0, ok.out);
    assert.match(calls(), /hop-server\.sh check - lacks/);
    assert.doesNotMatch(calls(), /^dial /m);
  });

  it("the verify dials every exit still behind the hop after its table was reloaded", () => {
    fixtures({ live: others, file: others });
    state({ retire_hop_servers: "germany-3 ", retire_hop_changed: "1" });
    const ok = run("ok_retire_hop", { T_OLD: "india-1" });
    assert.equal(ok.code, 0, ok.out);
    assert.match(calls(), /dial after the hop table was reloaded turkey-1 netherlands-1/);
    assert.equal(run("ok_retire_hop", { T_OLD: "india-1", T_DIAL_RC: "1" }).code, 1);
  });

  it("the verify fails while the relay's file still has the exit's line", () => {
    fixtures({ live: others, file: withIndia });
    state({ retire_hop_servers: "germany-3 ", retire_hop_changed: "1" });
    const ok = run("ok_retire_hop", { T_OLD: "india-1" });
    assert.equal(ok.code, 1);
    assert.match(ok.out, /file still has a line for india-1/);
  });
});

describe("add.hop, run again after it stopped halfway", () => {
  const before = [[TR, OLD_HOP, 47131, "turkey-1 via germany-3", 2]];
  const env = { T_NAME: "india-2", T_NEW_IP: IN, T_OLD: "" };

  it("first pass: a port on the hop server, a live rule, a file line", () => {
    fixtures({ live: before, file: before, chain: [[47131, TR, "turkey-1"]] });
    state({ pre_relay_443: "HELD", dest: "www.example.org:443" });
    const r = run("do_add_hop", env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(tableSent(), ["turkey-1", "india-2"]);
    assert.match(calls(), /relay\.sh hop-add/);
    assert.equal(sent("hop-rule.txt"), `ip daddr ${IN} tcp dport 443 counter dnat to ${OLD_HOP}:47132 comment "india-2 via germany-3"`);
    assert.equal(parseHopRules(sent("nftables.conf.new")).length, 2);
    assert.equal(stateOf("hop"), "47132");
    assert.equal(stateOf("hop_server"), "germany-3");
  });

  it("the hop server already has the port (the first pass stopped at the relay): it is kept, the rest is done", () => {
    fixtures({ live: before, file: before, chain: [[47131, TR, "turkey-1"], [47132, IN, "india-2"]] });
    state({ pre_relay_443: "HELD", dest: "www.example.org:443" });
    const r = run("do_add_hop", env);
    assert.equal(r.code, 0, r.out);
    assert.equal(sent("chain-fw.nft.new"), null, "it used to be refused here: 'that exit already has a hop port'");
    assert.doesNotMatch(calls(), /hop-server\.sh apply/);
    assert.match(calls(), /relay\.sh hop-add/);
    assert.match(calls(), /relay\.sh hop-file-swap/);
    assert.equal(stateOf("hop"), "47132");
  });

  it("everything is already there: nothing is changed", () => {
    const done = [...before, [IN, OLD_HOP, 47132, "india-2 via germany-3", 4]];
    fixtures({ live: done, file: done, chain: [[47131, TR, "turkey-1"], [47132, IN, "india-2"]] });
    state({ pre_relay_443: "HELD", dest: "www.example.org:443" });
    const r = run("do_add_hop", env);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(calls(), /hop-server\.sh apply|relay\.sh hop-add|hop-file-swap/);
    assert.equal(stateOf("hop"), "47132");
  });

  it("a rule for the exit that goes somewhere else is nobody's to overwrite", () => {
    const wrong = [...before, [IN, OTHER_HOP, 47139, "india-2 via finland-3", 4]];
    fixtures({ live: wrong, file: before, chain: [[47131, TR, "turkey-1"]] });
    state({ pre_relay_443: "HELD", dest: "www.example.org:443" });
    const r = run("do_add_hop", env);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED: the relay already has a hop rule for this exit that goes somewhere else than germany-3/);
    assert.doesNotMatch(calls(), /hop-server\.sh apply|relay\.sh hop-add|hop-file-swap/, "refused before anything is changed anywhere");
    assert.equal(sent("chain-fw.nft.new"), null);
    assert.equal(stateOf("hop"), undefined);
  });

  it("no hop when the relay reaches the exit directly", () => {
    state({ pre_relay_443: "PASS", dest: "www.example.org:443" });
    const r = run("do_add_hop", env);
    assert.equal(r.code, 0, r.out);
    assert.equal(stateOf("hop"), "none");
    assert.equal(calls(), "");
  });
});

describe("retire.reach: when is a server gone?", () => {
  const row = (status, age) => `id-1|STANDALONE|de-germany|${status}|${age}|v1|t|www.example.org:443|t|t`;
  beforeEach(() => fixtures({}));

  it("it answers: yes", () => {
    run("retire_reach_now", { T_NODE_ROW: row("ONLINE", 4) });
    assert.equal(stateOf("reach"), "yes");
    assert.equal(run("ok_retire_reach").code, 0);
  });
  it("no answer and OFFLINE in the panel: gone", () => {
    const r = run("retire_reach_now", { T_SSH: "fail", T_NODE_ROW: row("OFFLINE", 5400) });
    assert.match(r.out, /treated as gone/);
    assert.equal(stateOf("reach"), "no");
    assert.equal(run("ok_retire_reach").code, 0);
    assert.equal((calls().match(/^rsh ip:\S+ true$/gm) || []).length, 3, "three tries before a box is called gone");
  });
  it("no answer but ONLINE in the panel: not gone. The run stops and the names are not touched", () => {
    run("retire_reach_now", { T_SSH: "fail", T_NODE_ROW: row("ONLINE", 7) });
    assert.equal(stateOf("reach"), "alive");
    const ok = run("ok_retire_reach");
    assert.equal(ok.code, 1);
    assert.match(ok.out, /is ONLINE in the panel and does not accept this PC's key/);
    const dns = run("do_retire_dns_now");
    assert.equal(dns.code, 0);
    assert.match(dns.out, /the names go after its customers are off it/);
    const stop = run("do_retire_agent_stop", { T_SSH: "fail", T_NODE_ROW: row("ONLINE", 7) });
    assert.equal(stop.code, 1, "and its agent is not silently skipped");
  });
  it("a step later in the run asks again, and does not take an old 'yes' for it", () => {
    state({ reach: "yes" });
    const stop = run("do_retire_agent_stop", { T_SSH: "fail", T_NODE_ROW: row("OFFLINE", 900) });
    assert.equal(stop.code, 0, stop.out);
    assert.match(stop.out, /there is no agent to stop/);
    assert.equal(stateOf("reach"), "no");
  });
});

describe("add.e2e-issued: every protocol, or it is not a pass", () => {
  const all = (kind, protos) => Object.fromEntries(protos.map((p) => [`e2e_issued_${kind}_${p}`, "pass"]));
  const direct = all("direct", ["REALITY", "TLS", "WS", "TROJAN", "SS"]);
  const relay = all("relay", ["REALITY", "TLS", "TROJAN", "SS"]);

  it("passes with five direct and four relay", () => {
    state({ ...direct, ...relay, relay_set: "de" });
    assert.equal(run("ok_add_e2e_issued").code, 0);
  });
  it("fails when the relay test account held nothing (it used to pass on one credential)", () => {
    state({ ...direct, e2e_issued_relay_REALITY: "none", relay_set: "de" });
    const r = run("ok_add_e2e_issued");
    assert.equal(r.code, 1);
    assert.match(r.out, /relay REALITY: NOT DIALLED/);
    assert.match(r.out, /relay SS: NOT DIALLED/);
    assert.match(r.out, /--waive add\.e2e-issued/);
  });
  it("fails when one direct protocol is missing or failed", () => {
    state({ ...direct, ...relay, e2e_issued_direct_WS: "none", relay_set: "de" });
    assert.match(run("ok_add_e2e_issued").out, /direct WS: NOT DIALLED/);
    state({ ...direct, ...relay, e2e_issued_direct_TROJAN: "fail", relay_set: "de" });
    const r = run("ok_add_e2e_issued");
    assert.equal(r.code, 1);
    assert.match(r.out, /direct TROJAN: did not pass/);
  });
  it("does not ask for the relay half of a server with no relay routes", () => {
    state({ ...direct, relay_set: "none" });
    assert.equal(run("ok_add_e2e_issued").code, 0);
    state({ ...direct, relay_set: "de" });
    assert.equal(run("ok_add_e2e_issued", { T_NO_RELAY: "1" }).code, 0);
  });
});

describe("add.e2e-inside: an exit the relay only reaches through the hop", () => {
  const none = { e2e_inside_REALITY: "fail", e2e_inside_TLS: "fail", e2e_inside_WS: "fail", e2e_inside_TROJAN: "fail", e2e_inside_SS: "fail" };

  it("reports and passes, and names the step that is the proof from inside", () => {
    state({ ...none, pre_relay_443: "HELD", zone_inside: "clean" });
    const r = run("ok_add_e2e_inside");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /a reading, not a requirement/);
    assert.match(r.out, /add\.e2e-relay/);
  });
  it("says UNVERIFIED FROM INSIDE when there will be no relay tunnels either", () => {
    state({ ...none, pre_relay_443: "HELD" });
    const r = run("ok_add_e2e_inside", { T_NO_RELAY: "1" });
    assert.equal(r.code, 0);
    assert.match(r.out, /UNVERIFIED FROM INSIDE/);
  });
  it("still demands REALITY and Shadowsocks when the relay reaches the exit directly", () => {
    state({ ...none, pre_relay_443: "PASS", zone_inside: "rewritten" });
    const r = run("ok_add_e2e_inside");
    assert.equal(r.code, 1);
    assert.match(r.out, /REALITY did not pass from inside/);
    state({ ...none, e2e_inside_REALITY: "pass", e2e_inside_SS: "pass", pre_relay_443: "PASS", zone_inside: "rewritten" });
    assert.equal(run("ok_add_e2e_inside").code, 0);
  });
  it("--hop no is the owner saying the relay reaches it: then it has to", () => {
    state({ ...none, pre_relay_443: "HELD" });
    assert.equal(run("ok_add_e2e_inside", { T_HOP: "no" }).code, 1);
  });
});

describe("temporary test users: counting from strays would hide them", () => {
  const run2 = (counts, env = {}) => {
    const r = spawnSync(BASH, [HARNESS, "no_strays", "new", counts], { encoding: "utf8", env: { ...process.env, T_RUN: dir, T_FIX: fix, T_NAME: "germany-4", ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  it("an empty server is fine, with or without the Shadowsocks seed", () => {
    assert.equal(run2("vless-in=0 vless-tls-in=0 vless-ws-in=0 trojan-in=0 shadowsocks-in=1").code, 0);
    assert.equal(run2("vless-in=0 trojan-in=0 shadowsocks-in=0").code, 0);
  });
  it("users on a server no plan holds are strays: refused", () => {
    const r = run2("vless-in=1 vless-tls-in=1 vless-ws-in=1 trojan-in=1 shadowsocks-in=2");
    assert.equal(r.code, 1);
    assert.match(r.out, /test users an earlier pass left behind/);
  });
  it("users on a server that is in the plans, or has relay routes, are people", () => {
    assert.equal(run2("vless-in=52 trojan-in=48 shadowsocks-in=49", { T_PLAN_HOLDS: "Pro|8|f|56" }).code, 0);
    assert.equal(run2("vless-in=4 trojan-in=0 shadowsocks-in=1", { T_ROUTE_IDS: "00000000-0000-4000-8000-000000000001" }).code, 0);
  });
});

describe("add.postfix and add.parity on a server that already has customers", () => {
  it("customers_on_it: a plan holding a route, or a shared credential, is enough", () => {
    const ask = (env) => run("customers_on_it", env).out.trim();
    assert.equal(ask({}), "no");
    assert.equal(ask({ T_PLAN_HOLDS: "Pro|8|f|56\nTrial|0|f|48" }), "yes");
    assert.equal(ask({ T_HAVE: "376" }), "yes");
  });
});

// A server was built on a site that refuses X25519. REALITY carried
// nothing, and the first test tunnel found it with the site already in
// the server's config, the panel's REALITY config and the server row.
// add.dest settles the site before the dump, the token and the installer.
describe("add.dest: the disguise site, before anything is built on it", () => {
  const site = { dest: "www.example.org:443" };
  const inOrder = (text, lines) => {
    let at = -1;
    for (const l of lines) {
      const i = text.indexOf(l, at + 1);
      assert.ok(i > at, `'${l}' is missing, or out of order:\n${text}`);
      at = i;
    }
  };

  it("audit OK and REALITY completed from outside: passes, and the trial inbound is stopped", () => {
    state(site);
    const r = run("do_add_dest");
    assert.equal(r.code, 0, r.out);
    assert.equal(stateOf("dest_audit"), "OK");
    assert.equal(stateOf("dest_proof"), "pass");
    inOrder(calls(), [
      "reality-dest-audit.sh www.example.org",
      "rscript new node/reality-trial.sh start www.example.org 443 v0.0.0",
      "pscript nx-xray-get.sh v0.0.0",
      "reality-trial.sh params 198.51.100.60",
      "nx-e2e-pipe.sh",
      "reality-trial.sh stop",
    ]);
    assert.match(r.out, /EXIT-MATCH/);
    assert.equal(run("ok_add_dest").code, 0);
  });

  it("a site the audit calls BAD (it refuses X25519): stops before any trial, and says how to go on", () => {
    state(site);
    const r = run("do_add_dest", { T_AUDIT: "BAD   www.example.org            refuses a TLS 1.3 handshake that offers X25519 alone" });
    assert.equal(r.code, 1);
    assert.equal(stateOf("dest_audit"), "BAD");
    assert.doesNotMatch(calls(), /reality-trial\.sh start|nx-e2e-pipe/);
    assert.match(r.out, /refuses a TLS 1\.3 handshake that offers X25519 alone/);
    assert.match(r.out, /Nothing has been built on it/);
    assert.match(r.out, /--dest <another site>:443/);
    assert.equal(run("ok_add_dest").code, 1);
  });

  it("no verdict at all (the audit did not run) is not a pass", () => {
    state(site);
    const r = run("do_add_dest", { T_AUDIT: "bash: reality-dest-audit.sh: No such file or directory" });
    assert.equal(r.code, 1);
    assert.equal(stateOf("dest_audit"), "none");
    assert.doesNotMatch(calls(), /reality-trial\.sh start/);
  });

  it("the audit passes but REALITY does not complete from outside: fails, and the trial inbound is still stopped", () => {
    state(site);
    const r = run("do_add_dest", { T_TRIAL: "fail" });
    assert.equal(r.code, 0, "the step records, its verify decides");
    assert.equal(stateOf("dest_proof"), "fail");
    inOrder(calls(), ["nx-e2e-pipe.sh", "reality-trial.sh log", "reality-trial.sh stop"]);
    const v = run("ok_add_dest");
    assert.equal(v.code, 1);
    assert.match(v.out, /REALITY did NOT complete from outside/);
    assert.match(v.out, /Nothing has been built/);
  });

  it("a weak disguise is the owner's decision first: not dialled without --accept-weak-dest, dialled with it", () => {
    const weak = { T_AUDIT: "WEAK  www.example.org            is announced by AS64500 (EXAMPLE-CDN), whose ranges are published" };
    state(site);
    const r = run("do_add_dest", weak);
    assert.equal(r.code, 0);
    assert.doesNotMatch(calls(), /reality-trial\.sh start/);
    const v = run("ok_add_dest", weak);
    assert.equal(v.code, 1);
    assert.match(v.out, /--accept-weak-dest/);

    rmSync(join(dir, "calls"), { force: true });
    const yes = { ...weak, T_ACCEPT_DEST: "1" };
    assert.equal(run("do_add_dest", yes).code, 0);
    assert.match(calls(), /reality-trial\.sh start/);
    assert.equal(stateOf("dest_proof"), "pass");
    assert.equal(run("ok_add_dest", yes).code, 0);
  });

  it("--accept-weak-dest is not a way past a site REALITY cannot use", () => {
    state(site);
    const env = { T_AUDIT: "BAD   www.example.org            negotiated TLSv1.2, and REALITY requires TLS 1.3", T_ACCEPT_DEST: "1" };
    assert.equal(run("do_add_dest", env).code, 1);
    assert.equal(run("ok_add_dest", env).code, 1);
  });

  it("the trial inbound did not start (port taken): nothing is dialled", () => {
    state(site);
    const r = run("do_add_dest", { T_TRIAL_START: "FAIL port 443 is already taken on this box, so no trial inbound can listen there" });
    assert.equal(r.code, 1);
    assert.match(r.out, /port 443 is already taken/);
    assert.doesNotMatch(calls(), /nx-e2e-pipe/);
  });

  it("a box that is already a server gets no trial inbound, and its tunnels are the proof", () => {
    state(site);
    const r = run("do_add_dest", { T_TRIAL_START: "TRIAL-ENROLLED" });
    assert.equal(r.code, 0, r.out);
    assert.equal(stateOf("dest_proof"), "enrolled");
    assert.doesNotMatch(calls(), /nx-e2e-pipe|reality-trial\.sh stop/);
    assert.match(r.out, /add\.e2e-direct/);
    assert.equal(run("ok_add_dest").code, 0);
  });

  it("the verify fails while the trial inbound or its files are still on the box", () => {
    state({ ...site, dest_audit: "OK", dest_proof: "pass" });
    assert.equal(run("ok_add_dest").code, 0);
    assert.equal(run("ok_add_dest", { T_TRIAL_STATUS: "up" }).code, 1);
    assert.equal(run("ok_add_dest", { T_TRIAL_STATUS: "down\nfiles-left" }).code, 1);
  });

  it("--dest on a later pass replaces the site, but only while nothing is built on the old one", () => {
    state(site);
    const r = run("do_add_dest", { T_DEST: "www.example.net:443", T_AUDIT: "OK    www.example.net            AS64500 EXAMPLE in ZZ" });
    assert.equal(r.code, 0, r.out);
    assert.equal(stateOf("dest"), "www.example.net:443");
    assert.match(calls(), /reality-dest-audit\.sh www\.example\.net/);
    assert.match(calls(), /reality-trial\.sh start www\.example\.net 443/);

    for (const built of [{ state: { ...site, node_id: "00000000-0000-4000-8000-000000000001" }, env: {} }, { state: site, env: { T_ENROLLED: "enrolled" } }]) {
      rmSync(join(dir, "calls"), { force: true });
      state(built.state);
      const no = run("do_add_dest", { T_DEST: "www.example.net:443", ...built.env });
      assert.equal(no.code, 1);
      assert.match(no.out, /already built on www\.example\.org/);
      assert.equal(stateOf("dest"), "www.example.org:443");
      assert.doesNotMatch(calls(), /reality-dest-audit|reality-trial/);
    }
  });
});

describe("add.image: what the provider's image brought along", () => {
  const clean = "ok      ufw: not active, none of its chains loaded\nok      hostname: generic, and pinned against cloud-init\nok      swap: 2048 MB /swapfile, in /etc/fstab";

  it("the repair is the installer's own, asked for once with --apply", () => {
    assert.equal(run("do_add_image").code, 0);
    assert.match(calls(), /rsh new bash \/root\/neoxify-installer\/maintenance\/provider-image\.sh --apply/);
  });
  it("passes when no REPAIR line is left", () => {
    assert.equal(run("ok_add_image", { T_IMAGE: clean }).code, 0);
    assert.doesNotMatch(calls(), /--apply/, "the verify only looks");
  });
  it("fails while one stands, whichever it is", () => {
    for (const left of ["REPAIR  hostname: a brand word in /etc/hosts", "REPAIR  ufw: not running, but its chains are still loaded", "REPAIR  fwupd: fwupd-refresh.timer is enabled on a virtual machine"]) {
      const r = run("ok_add_image", { T_IMAGE: `${clean}\n${left}` });
      assert.equal(r.code, 1, left);
      assert.match(r.out, /still there/);
    }
  });
  it("a LOOK line is said out loud and left to a person", () => {
    const r = run("ok_add_image", { T_IMAGE: `${clean}\nLOOK    firewall: policy INPUT DROP, and it is not ufw's. Left as it is` });
    assert.equal(r.code, 0);
    assert.match(r.out, /a person's to judge/);
  });
  it("fails when the check never ran on the box", () => {
    const r = run("ok_add_image", { T_IMAGE: "bash: /root/neoxify-installer/maintenance/provider-image.sh: No such file or directory" });
    assert.equal(r.code, 1);
    assert.match(r.out, /did not run/);
  });
});
