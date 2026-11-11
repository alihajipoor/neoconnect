/**
 * The relay hop as text transforms (lib/hop.mjs).
 *
 * The relay box's nftables file is never loaded, only edited by line, so
 * the edit itself is the whole safety: it must change hop lines and
 * leave every other byte alone. Addresses are documentation ranges:
 * 198.51.100.x for the relay and the hop servers, 203.0.113.x for exits.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chainAdd, chainFromRelayRules, chainRemove, countHopRules, hopRuleIs, parseChainFw, parseHopRules, relayFileAdd,
  relayFileRemove, relayFileRepoint, relayRuleText, renderChainFw, ruleForExit,
} from "../lib/hop.mjs";

const RELAY = "198.51.100.20";
const HOP = "198.51.100.50";
const HOP2 = "198.51.100.60";

const FILE = `#!/usr/sbin/nft -f
flush ruleset

table inet neoxify_relay_fw {
  set tcp_open {
    type inet_service
    elements = { 22, 443, 8443 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport @tcp_open accept
  }
}

table ip neoxify_relay_chain {
  chain output {
    type nat hook output priority -100; policy accept;
    ip daddr 203.0.113.10 tcp dport 443 counter dnat to ${HOP}:47131 comment "turkey-1 via germany-3"
    ip daddr 203.0.113.20 tcp dport 443 counter dnat to ${HOP}:47132 comment "netherlands-1 via germany-3"
  }
}

table inet neoxify_signin_relay {
  chain input {
    type filter hook input priority 10; policy accept;
    tcp dport 4433 counter accept comment "sign-in relay"
  }
}
`;

const LIVE = `table ip neoxify_relay_chain {
\tchain output { # handle 1
\t\ttype nat hook output priority -100; policy accept;
\t\tip daddr 203.0.113.10 tcp dport 443 counter packets 912 bytes 54720 dnat to ${HOP}:47131 comment "turkey-1 via germany-3" # handle 2
\t\tip daddr 203.0.113.20 tcp dport 443 counter packets 14 bytes 840 dnat to ${HOP}:47132 comment "netherlands-1 via germany-3" # handle 3
\t}
}
`;

const notHop = (text) => text.split("\n").filter((l) => !/dnat to/.test(l)).join("\n");

describe("parseHopRules", () => {
  it("reads the live listing, with handles and counters", () => {
    assert.deepEqual(parseHopRules(LIVE), [
      { exitIp: "203.0.113.10", hopIp: HOP, hopPort: 47131, comment: "turkey-1 via germany-3", exitName: "turkey-1", hopName: "germany-3", handle: 2 },
      { exitIp: "203.0.113.20", hopIp: HOP, hopPort: 47132, comment: "netherlands-1 via germany-3", exitName: "netherlands-1", hopName: "germany-3", handle: 3 },
    ]);
  });
  it("reads the persisted file, where there are no handles", () => {
    const rules = parseHopRules(FILE);
    assert.equal(rules.length, 2);
    assert.ok(rules.every((r) => r.handle === null));
  });
  it("ignores every line that is not a hop rule", () => {
    assert.deepEqual(parseHopRules("tcp dport 4433 counter accept\nip daddr 203.0.113.9 accept\n"), []);
  });
});

describe("ruleForExit", () => {
  it("finds the one rule for an exit", () => {
    assert.equal(ruleForExit(parseHopRules(LIVE), "203.0.113.20").handle, 3);
    assert.equal(ruleForExit(parseHopRules(LIVE), "203.0.113.99"), null);
  });
  it("does not match an address that only starts the same", () => {
    assert.equal(ruleForExit(parseHopRules(LIVE), "203.0.113.1"), null);
  });
  it("refuses two rules for one exit", () => {
    const twice = LIVE.replace("203.0.113.20", "203.0.113.10");
    assert.throws(() => ruleForExit(parseHopRules(twice), "203.0.113.10"), /more than one/);
  });
});

describe("relayRuleText", () => {
  it("is the same text for the live rule and for the file", () => {
    const text = relayRuleText({ exitIp: "203.0.113.30", hopIp: HOP, hopPort: 47133, exitName: "india-2", hopName: "germany-3" });
    assert.equal(text, `ip daddr 203.0.113.30 tcp dport 443 counter dnat to ${HOP}:47133 comment "india-2 via germany-3"`);
    assert.equal(parseHopRules(text).length, 1, "and it parses back");
  });
  it("refuses names, ports and addresses that could break out of the rule", () => {
    const ok = { exitIp: "203.0.113.30", hopIp: HOP, hopPort: 47133, exitName: "india-2", hopName: "germany-3" };
    assert.throws(() => relayRuleText({ ...ok, exitName: 'x" accept comment "y' }));
    assert.throws(() => relayRuleText({ ...ok, hopName: "germany 3; flush ruleset" }));
    assert.throws(() => relayRuleText({ ...ok, hopPort: 22 }));
    assert.throws(() => relayRuleText({ ...ok, exitIp: "203.0.113.0/24" }));
  });
});

describe("relayFileRemove", () => {
  it("drops the exit's line and nothing else", () => {
    const next = relayFileRemove(FILE, "203.0.113.20");
    assert.equal(parseHopRules(next).length, 1);
    assert.equal(parseHopRules(next)[0].exitName, "turkey-1");
    assert.equal(notHop(next), notHop(FILE));
    assert.ok(next.startsWith("#!/usr/sbin/nft -f\nflush ruleset\n"));
  });
  it("refuses when there is no line, or more than one, for the exit", () => {
    assert.throws(() => relayFileRemove(FILE, "203.0.113.99"), /found 0/);
    assert.throws(() => relayFileRemove(FILE.replace("203.0.113.20", "203.0.113.10"), "203.0.113.10"), /found 2/);
  });
});

describe("relayFileRepoint", () => {
  it("moves every line through the old hop to the new one, ports and exits unchanged", () => {
    const { text, changed } = relayFileRepoint(FILE, { oldHopIp: HOP, newHopIp: HOP2, newHopName: "germany-4" });
    assert.equal(changed, 2);
    assert.deepEqual(
      parseHopRules(text).map((r) => [r.exitIp, r.hopIp, r.hopPort, r.comment]),
      [
        ["203.0.113.10", HOP2, 47131, "turkey-1 via germany-4"],
        ["203.0.113.20", HOP2, 47132, "netherlands-1 via germany-4"],
      ],
    );
    assert.equal(notHop(text), notHop(FILE));
    assert.ok(!text.includes(HOP + ":"), "nothing still points at the old hop");
  });
  it("leaves lines through another hop alone", () => {
    const mixed = FILE.replace(`${HOP}:47132`, "198.51.100.70:47132");
    const { text, changed } = relayFileRepoint(mixed, { oldHopIp: HOP, newHopIp: HOP2, newHopName: "germany-4" });
    assert.equal(changed, 1);
    assert.ok(text.includes("198.51.100.70:47132"));
  });
  it("refuses when nothing goes through the old hop", () => {
    assert.throws(() => relayFileRepoint(FILE, { oldHopIp: "198.51.100.99", newHopIp: HOP2, newHopName: "germany-4" }), /no hop line/);
  });
  it("keeps the indentation and the line endings it found", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const { text } = relayFileRepoint(crlf, { oldHopIp: HOP, newHopIp: HOP2, newHopName: "germany-4" });
    assert.ok(text.includes(`\r\n    ip daddr 203.0.113.10 tcp dport 443 counter dnat to ${HOP2}:47131`));
    assert.ok(!/[^\r]\n/.test(text));
  });
});

describe("relayFileAdd", () => {
  const rule = { exitIp: "203.0.113.30", hopIp: HOP, hopPort: 47133, exitName: "india-2", hopName: "germany-3" };
  it("adds the line right after the last hop line, with its indentation", () => {
    const next = relayFileAdd(FILE, rule);
    const lines = next.split("\n");
    const at = lines.findIndex((l) => l.includes("india-2 via germany-3"));
    assert.ok(lines[at - 1].includes("netherlands-1 via germany-3"));
    assert.ok(lines[at].startsWith("    ip daddr 203.0.113.30 "));
    assert.equal(lines[at + 1], "  }");
    assert.equal(notHop(next), notHop(FILE));
  });
  it("refuses a second line for an exit that has one", () => {
    assert.throws(() => relayFileAdd(FILE, { ...rule, exitIp: "203.0.113.10" }), /already/);
  });
  it("refuses to guess where the first hop line belongs", () => {
    assert.throws(() => relayFileAdd(notHop(FILE), rule), /by hand/);
  });
  it("undoes cleanly: add then remove gives the file back", () => {
    assert.equal(relayFileRemove(relayFileAdd(FILE, rule), rule.exitIp), FILE);
  });
});

describe("the hop server's table", () => {
  const model = {
    relays: [RELAY],
    hops: [
      { port: 47131, ip: "203.0.113.10", name: "turkey-1" },
      { port: 47132, ip: "203.0.113.20", name: "netherlands-1" },
    ],
  };

  it("renders a file that holds its own table only and reloads atomically", () => {
    const text = renderChainFw(model);
    assert.ok(text.includes("table ip neoxify_chain\ndelete table ip neoxify_chain\ntable ip neoxify_chain {"));
    assert.ok(!text.includes("flush ruleset"));
    assert.equal((text.match(/^table /gm) || []).length, 2);
    assert.ok(text.includes(`elements = { ${RELAY} }`));
    assert.ok(text.includes('ip saddr @relays tcp dport 47132 counter dnat to 203.0.113.20:443 comment "netherlands-1"'));
    assert.ok(text.includes("ip saddr @relays ip daddr { 203.0.113.10, 203.0.113.20 } tcp dport 443 counter masquerade"));
  });
  it("parses back to the model it was rendered from", () => {
    assert.deepEqual(parseChainFw(renderChainFw(model)), model);
  });
  it("gives a new exit the lowest free port", () => {
    const { model: next, port } = chainAdd(model, { ip: "203.0.113.30", name: "india-2" });
    assert.equal(port, 47133);
    assert.equal(next.hops.length, 3);
    const gap = chainAdd({ relays: [RELAY], hops: [model.hops[1]] }, { ip: "203.0.113.30", name: "india-2" });
    assert.equal(gap.port, 47131, "a freed port is used again");
  });
  it("refuses an exit twice, and refuses to remove one that is not there", () => {
    assert.throws(() => chainAdd(model, { ip: "203.0.113.10", name: "turkey-1" }), /already/);
    assert.throws(() => chainRemove(model, "203.0.113.99"), /no hop port/);
  });
  it("removes an exit from the forward rule and from the masquerade set", () => {
    const text = renderChainFw(chainRemove(model, "203.0.113.20"));
    assert.ok(!text.includes("203.0.113.20"));
    assert.ok(text.includes("ip daddr { 203.0.113.10 }"));
  });
  it("renders an empty table without a masquerade rule for nobody", () => {
    const text = renderChainFw({ relays: [RELAY], hops: [] });
    assert.ok(!text.includes("counter masquerade"));
  });
  it("refuses a table with no relay, a repeated port, or a name that could break the file", () => {
    assert.throws(() => renderChainFw({ relays: [], hops: [] }), /no relay/);
    assert.throws(() => renderChainFw({ relays: [RELAY], hops: [model.hops[0], { ...model.hops[1], port: 47131 }] }), /twice/);
    assert.throws(() => renderChainFw({ relays: [RELAY], hops: [{ port: 47131, ip: "203.0.113.10", name: 'x"; flush ruleset' }] }));
  });
  it("is rebuilt from the relay's own rules when the old hop server is gone", () => {
    const rebuilt = chainFromRelayRules(parseHopRules(LIVE), [RELAY], HOP);
    assert.deepEqual(rebuilt, model);
    assert.throws(() => chainFromRelayRules(parseHopRules(LIVE), [RELAY], "198.51.100.99"), /no rule through that hop/);
    assert.throws(() => chainFromRelayRules(parseHopRules(LIVE), [RELAY], []), /IPv4/);
  });
});

// A hop move repoints the relay's rules one by one, over SSH, to a box
// inside the watched country. It can stop after any of them, and then
// the step is run again.
describe("a hop move that stopped halfway and is run again", () => {
  // The first pass moved turkey-1 to the new hop and stopped.
  const HALF = LIVE.replace(`${HOP}:47131 comment "turkey-1 via germany-3"`, `${HOP2}:47131 comment "turkey-1 via germany-4"`);
  const DONE = HALF.replace(`${HOP}:47132 comment "netherlands-1 via germany-3"`, `${HOP2}:47132 comment "netherlands-1 via germany-4"`);

  it("the new server's table holds the exits already moved as well as the ones still to move", () => {
    const second = chainFromRelayRules(parseHopRules(HALF), [RELAY], [HOP, HOP2]);
    assert.deepEqual(second.hops, [
      { port: 47131, ip: "203.0.113.10", name: "turkey-1" },
      { port: 47132, ip: "203.0.113.20", name: "netherlands-1" },
    ]);
    // What the second pass used to load over the new server's table:
    // the rules still through the old hop only, so turkey-1 lost its port.
    const oldWay = chainFromRelayRules(parseHopRules(HALF), [RELAY], HOP);
    assert.deepEqual(oldWay.hops.map((h) => h.name), ["netherlands-1"]);
  });
  it("is the same table on the first pass, on the second, and when everything has moved", () => {
    const first = renderChainFw(chainFromRelayRules(parseHopRules(LIVE), [RELAY], [HOP, HOP2]));
    assert.equal(renderChainFw(chainFromRelayRules(parseHopRules(HALF), [RELAY], [HOP, HOP2])), first);
    assert.equal(renderChainFw(chainFromRelayRules(parseHopRules(DONE), [RELAY], [HOP, HOP2])), first);
  });
  it("counts what is left on the old hop and what is on the new one, in the live rules and in the file", () => {
    assert.equal(countHopRules(parseHopRules(HALF), "hop", HOP), 1);
    assert.equal(countHopRules(parseHopRules(HALF), "hop", HOP2), 1);
    assert.equal(countHopRules(parseHopRules(DONE), "hop", HOP), 0);
    // Live rules moved, file not yet edited: the file is what the relay
    // loads at its next boot, so "nothing left" has to look at both.
    assert.equal(countHopRules(parseHopRules(FILE), "hop", HOP), 2);
    assert.equal(countHopRules(parseHopRules(FILE), "exit", "203.0.113.20"), 1);
    assert.equal(countHopRules(parseHopRules(FILE), "exit", "203.0.113.2"), 0, "an address that only starts the same");
    assert.throws(() => countHopRules(parseHopRules(FILE), "name", HOP), /by exit or by hop/);
    assert.throws(() => countHopRules(parseHopRules(FILE), "hop", "germany-3"), /IPv4/);
  });
  it("repointing the file a second time is refused, not done twice", () => {
    const { text } = relayFileRepoint(FILE, { oldHopIp: HOP, newHopIp: HOP2, newHopName: "germany-4" });
    assert.equal(countHopRules(parseHopRules(text), "hop", HOP), 0);
    assert.equal(countHopRules(parseHopRules(text), "hop", HOP2), 2);
    assert.throws(() => relayFileRepoint(text, { oldHopIp: HOP, newHopIp: HOP2, newHopName: "germany-4" }), /no hop line/);
  });
});

describe("hopRuleIs: is the exit's rule already there, and already right?", () => {
  const rules = parseHopRules(LIVE);
  it("says none, yes or no", () => {
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.30", hopIp: HOP, hopPort: 47133 }), "none");
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: HOP, hopPort: 47132 }), "yes");
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: HOP, hopPort: 47133 }), "no", "another port");
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: HOP2, hopPort: 47132 }), "no", "another hop");
  });
  it("compares the hop alone when no port has been chosen yet", () => {
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: HOP }), "yes");
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: HOP2 }), "no");
    assert.equal(hopRuleIs(rules, { exitIp: "203.0.113.30", hopIp: HOP2 }), "none");
    assert.throws(() => hopRuleIs(rules, { exitIp: "203.0.113.20", hopIp: "germany-3" }), /IPv4/);
  });
  it("reads the file the same way, and refuses two rules for one exit", () => {
    assert.equal(hopRuleIs(parseHopRules(FILE), { exitIp: "203.0.113.10", hopIp: HOP, hopPort: 47131 }), "yes");
    const twice = LIVE.replace("203.0.113.20", "203.0.113.10");
    assert.throws(() => hopRuleIs(parseHopRules(twice), { exitIp: "203.0.113.10", hopIp: HOP, hopPort: 47131 }), /more than one/);
  });
});

describe("tool.mjs, as the checklists call it", () => {
  const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "tool.mjs");
  let dir;
  const tool = (...args) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-tool-"));
    writeFileSync(join(dir, "live.txt"), LIVE.replace(`${HOP}:47131 comment "turkey-1 via germany-3"`, `${HOP2}:47131 comment "turkey-1 via germany-4"`));
    writeFileSync(join(dir, "file.conf"), FILE);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("hop-count and hop-is print a bare answer and never an address", () => {
    assert.deepEqual(tool("hop-count", join(dir, "live.txt"), "hop", HOP), { code: 0, out: "1", err: "" });
    assert.deepEqual(tool("hop-count", join(dir, "file.conf"), "hop", HOP), { code: 0, out: "2", err: "" });
    assert.deepEqual(tool("hop-is", join(dir, "live.txt"), "203.0.113.10", HOP2, "47131"), { code: 0, out: "yes", err: "" });
    assert.deepEqual(tool("hop-is", join(dir, "file.conf"), "203.0.113.10", HOP2, "47131"), { code: 0, out: "no", err: "" });
    assert.deepEqual(tool("hop-is", join(dir, "live.txt"), "203.0.113.99", HOP2, "47131"), { code: 0, out: "none", err: "" });
  });
  it("chain-from-relay takes the old hop and the new one", () => {
    const one = tool("chain-from-relay", join(dir, "live.txt"), join(dir, "one.nft"), RELAY, HOP);
    assert.deepEqual(one, { code: 0, out: "1", err: "" });
    const both = tool("chain-from-relay", join(dir, "live.txt"), join(dir, "both.nft"), RELAY, HOP, HOP2);
    assert.deepEqual(both, { code: 0, out: "2", err: "" });
    assert.equal(parseChainFw(readFileSync(join(dir, "both.nft"), "utf8")).hops.length, 2);
    assert.equal(tool("chain-port", join(dir, "both.nft"), "203.0.113.10").out, "47131");
    assert.equal(tool("chain-port", join(dir, "both.nft"), "203.0.113.99").out, "none");
  });
  it("hop-through writes exit addresses to files only for rules that have a handle", () => {
    mkdirSync(join(dir, "x"));
    assert.equal(tool("hop-through", join(dir, "live.txt"), HOP, join(dir, "x")).out, "3|netherlands-1|47132");
    assert.equal(readFileSync(join(dir, "x", "3.exit"), "utf8"), "203.0.113.20");
    mkdirSync(join(dir, "y"));
    assert.equal(tool("hop-through", join(dir, "file.conf"), HOP, join(dir, "y")).out.split("\n").length, 2);
    assert.deepEqual(readdirSync(join(dir, "y")), [], "the file has no handles: nothing is written under a made-up name");
  });
});
