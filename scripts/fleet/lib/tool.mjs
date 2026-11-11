#!/usr/bin/env node
/**
 * The pure helpers of `fleet`, as commands the bash side can call. The
 * operator's PC has node but neither jq nor python, so anything that is
 * JSON or a careful text edit happens here.
 *
 * Files in, files out for anything that may hold an address: nothing
 * address-like is ever printed by this script.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { namesOutsideZones, randomLabel } from "./dns.mjs";
import {
  chainAdd, chainFromRelayRules, chainRemove, parseChainFw, parseHopRules,
  relayFileAdd, relayFileRemove, relayFileRepoint, relayRuleText, renderChainFw, ruleForExit,
} from "./hop.mjs";
import { planGuard, planSteps } from "./planlist.mjs";

const [cmd, ...a] = process.argv.slice(2);
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const out = (s) => process.stdout.write(s + "\n");

const commands = {
  // label -> one random six-character DNS label
  label: () => out(randomLabel(randomBytes(6))),

  // plan-steps <plans.json> <incoming.json> <outgoing.json> [fallback.json]
  //   -> one line per plan to edit, smallest first: id|name|addJson|delJson|default|nextJson
  "plan-steps": () => {
    const steps = planSteps(json(a[0]), json(a[1]), json(a[2]), a[3] ? json(a[3]) : {});
    for (const s of steps) {
      out([s.id, s.name, JSON.stringify(s.add), JSON.stringify(s.del), s.def, JSON.stringify(s.next)].join("|"));
    }
  },

  // plan-next <old.json> '<add json>' '<del json>' [default] -> the guarded new list, as JSON
  "plan-next": () => out(JSON.stringify(planGuard({ old: json(a[0]), add: JSON.parse(a[1]), del: JSON.parse(a[2]), def: a[3] ?? "" }))),

  // hop-rules <listing-file> -> handle|exitName|hopName|hopPort per rule (names only)
  "hop-rules": () => {
    for (const r of parseHopRules(read(a[0]))) out([r.handle ?? "-", r.exitName, r.hopName, r.hopPort].join("|"));
  },
  // hop-handle <listing-file> <exitIp> -> the live rule's handle, or "none"
  "hop-handle": () => {
    const r = ruleForExit(parseHopRules(read(a[0])), a[1]);
    out(r && r.handle !== null ? String(r.handle) : "none");
  },
  // hop-through <listing-file> <hopIp> -> handle|exitName|hopPort for each rule through that hop
  //   (the exit address goes to <out-dir>/<handle>.exit, never to the screen)
  "hop-through": () => {
    for (const r of parseHopRules(read(a[0])).filter((x) => x.hopIp === a[1])) {
      if (a[2]) writeFileSync(`${a[2]}/${r.handle}.exit`, r.exitIp);
      out([r.handle ?? "-", r.exitName, r.hopPort].join("|"));
    }
  },
  // hop-rule <exitIp> <hopIp> <hopPort> <exitName> <hopName> <out-file>
  "hop-rule": () => writeFileSync(a[5], relayRuleText({ exitIp: a[0], hopIp: a[1], hopPort: Number(a[2]), exitName: a[3], hopName: a[4] })),
  // hop-file-remove <in> <out> <exitIp>
  "hop-file-remove": () => writeFileSync(a[1], relayFileRemove(read(a[0]), a[2])),
  // hop-file-repoint <in> <out> <oldHopIp> <newHopIp> <newHopName> -> number of lines changed
  "hop-file-repoint": () => {
    const r = relayFileRepoint(read(a[0]), { oldHopIp: a[2], newHopIp: a[3], newHopName: a[4] });
    writeFileSync(a[1], r.text);
    out(String(r.changed));
  },
  // hop-file-add <in> <out> <exitIp> <hopIp> <hopPort> <exitName> <hopName>
  "hop-file-add": () => writeFileSync(a[1], relayFileAdd(read(a[0]), { exitIp: a[2], hopIp: a[3], hopPort: Number(a[4]), exitName: a[5], hopName: a[6] })),

  // chain-from-relay <listing-file> <out> <relayIp> <oldHopIp> -> number of exits
  "chain-from-relay": () => {
    const m = chainFromRelayRules(parseHopRules(read(a[0])), [a[2]], a[3]);
    writeFileSync(a[1], renderChainFw(m));
    out(String(m.hops.length));
  },
  // chain-add <in> <out> <exitIp> <exitName> [base] -> the port given to the exit
  "chain-add": () => {
    const r = chainAdd(parseChainFw(read(a[0])), { ip: a[2], name: a[3] }, a[4] ? Number(a[4]) : 47131);
    writeFileSync(a[1], renderChainFw(r.model));
    out(String(r.port));
  },
  // chain-remove <in> <out> <exitIp>
  "chain-remove": () => writeFileSync(a[1], renderChainFw(chainRemove(parseChainFw(read(a[0])), a[2]))),
  // chain-port <in> <exitIp> -> that exit's hop port, or "none"
  "chain-port": () => out(String(parseChainFw(read(a[0])).hops.find((h) => h.ip === a[1])?.port ?? "none")),

  // names-outside <names-file> <zone> [zone...] -> names in none of the zones
  "names-outside": () => {
    for (const n of namesOutsideZones(read(a[0]).split(/\s+/), a.slice(1))) out(n);
  },
};

if (!commands[cmd]) {
  console.error("usage: tool.mjs " + Object.keys(commands).join("|") + " ...");
  process.exit(2);
}
try {
  commands[cmd]();
} catch (e) {
  console.error("refused: " + e.message);
  process.exit(1);
}
