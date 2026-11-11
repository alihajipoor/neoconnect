/**
 * The relay's NAT hop, as pure text transforms.
 *
 * Some exits cannot be reached from the relay box directly: uploads to
 * their address range are held. The relay then sends that exit's
 * REALITY connection to one server it can reach (the hop), on a port in
 * the 4713x range, and the hop forwards it to the exit's 443.
 *
 * Two files hold this, on two boxes, and they are edited differently:
 *
 *  - the RELAY box: one `dnat` line per exit in its own nftables file,
 *    plus the same rule live. That file starts with `flush ruleset`, so
 *    it is NEVER loaded: live rules are changed one by one by handle,
 *    and the file is edited by line and only checked (`nft -c -f`).
 *    Everything here that touches it changes hop lines and nothing else.
 *
 *  - the HOP server: a small file holding only its own table, which is
 *    atomic and safe to load. It is rendered whole from a model.
 */

import { isV4 } from "./dns.mjs";

const HOP_LINE =
  /^(\s*)ip daddr (\d{1,3}(?:\.\d{1,3}){3}) tcp dport 443 counter(?: packets \d+ bytes \d+)? dnat to (\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5}) comment "([^"]*)"(?:\s*# handle (\d+))?\s*$/;

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

function checkName(n, what) {
  if (!NAME.test(n || "")) throw new Error(`bad ${what} name`);
}

/** The rule text, the same for `nft add/replace rule` and for the file. */
export function relayRuleText({ exitIp, hopIp, hopPort, exitName, hopName }) {
  if (!isV4(exitIp) || !isV4(hopIp)) throw new Error("exit and hop must be IPv4 addresses");
  if (!Number.isInteger(hopPort) || hopPort < 1024 || hopPort > 65535) throw new Error("bad hop port");
  checkName(exitName, "exit");
  checkName(hopName, "hop");
  return `ip daddr ${exitIp} tcp dport 443 counter dnat to ${hopIp}:${hopPort} comment "${exitName} via ${hopName}"`;
}

/**
 * Hop rules out of `nft -a list chain ...` (with handles) or out of the
 * persisted file (without). Lines that are not hop rules are ignored.
 */
export function parseHopRules(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HOP_LINE.exec(line);
    if (!m) continue;
    out.push({
      exitIp: m[2],
      hopIp: m[3],
      hopPort: Number(m[4]),
      comment: m[5],
      exitName: m[5].split(" via ")[0],
      hopName: m[5].includes(" via ") ? m[5].split(" via ")[1] : "",
      handle: m[6] ? Number(m[6]) : null,
    });
  }
  return out;
}

/** The one live rule for an exit, or null. Two rules for one exit is a state nobody made on purpose. */
export function ruleForExit(rules, exitIp) {
  const hits = rules.filter((r) => r.exitIp === exitIp);
  if (hits.length > 1) throw new Error("more than one hop rule for that exit: fix by hand");
  return hits[0] ?? null;
}

function mapLines(text, fn) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out = [];
  let changed = 0;
  for (const line of lines) {
    const res = fn(line, HOP_LINE.exec(line));
    if (res === undefined) {
      out.push(line);
    } else {
      changed++;
      if (res !== null) out.push(...[].concat(res));
    }
  }
  return { text: out.join(eol), changed };
}

/** Drop the exit's hop line from the relay's file. Exactly one, or nothing is returned. */
export function relayFileRemove(text, exitIp) {
  if (!isV4(exitIp)) throw new Error("not an IPv4 address");
  const res = mapLines(text, (line, m) => (m && m[2] === exitIp ? null : undefined));
  if (res.changed !== 1) throw new Error(`expected one hop line for that exit in the file, found ${res.changed}`);
  return res.text;
}

/** Point every hop line that goes through the old hop at the new one. */
export function relayFileRepoint(text, { oldHopIp, newHopIp, newHopName }) {
  if (!isV4(oldHopIp) || !isV4(newHopIp)) throw new Error("hop addresses must be IPv4");
  checkName(newHopName, "hop");
  const res = mapLines(text, (line, m) => {
    if (!m || m[3] !== oldHopIp) return undefined;
    const exitName = m[5].split(" via ")[0];
    return `${m[1]}ip daddr ${m[2]} tcp dport 443 counter dnat to ${newHopIp}:${m[4]} comment "${exitName} via ${newHopName}"`;
  });
  if (res.changed === 0) throw new Error("no hop line in the file goes through the old hop");
  return { text: res.text, changed: res.changed };
}

/**
 * Add a hop line for a new exit, right after the last existing one and
 * with its indentation. With no existing line there is nothing to anchor
 * on, and guessing where a rule belongs in a firewall file is not this
 * tool's job.
 */
export function relayFileAdd(text, rule) {
  const line = relayRuleText(rule);
  if (parseHopRules(text).some((r) => r.exitIp === rule.exitIp)) {
    throw new Error("the file already has a hop line for that exit");
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let last = -1;
  let indent = "";
  lines.forEach((l, i) => {
    const m = HOP_LINE.exec(l);
    if (m) {
      last = i;
      indent = m[1];
    }
  });
  if (last < 0) throw new Error("the file has no hop line to add after: add the first one by hand");
  lines.splice(last + 1, 0, indent + line);
  return lines.join(eol);
}

// ---------------------------------------------------------------- hop server

const CHAIN_DNAT =
  /^\s*ip saddr @relays tcp dport (\d{2,5}) counter(?: packets \d+ bytes \d+)? dnat to (\d{1,3}(?:\.\d{1,3}){3}):443 comment "([^"]*)"\s*$/;

/** The hop server's file as a model: which relays may use it, and which port goes to which exit. */
export function parseChainFw(text) {
  const relays = [];
  const hops = [];
  let inSet = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*set relays\s*\{/.test(line)) inSet = true;
    if (inSet) {
      const m = /elements\s*=\s*\{([^}]*)\}/.exec(line);
      if (m) {
        for (const ip of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!isV4(ip)) throw new Error("the relays set holds something that is not an address");
          relays.push(ip);
        }
        inSet = false;
      }
    }
    const d = CHAIN_DNAT.exec(line);
    if (d) hops.push({ port: Number(d[1]), ip: d[2], name: d[3] });
  }
  return { relays, hops };
}

function checkModel(model) {
  if (!model.relays.length) throw new Error("no relay address: the table would forward for nobody");
  if (!model.relays.every(isV4)) throw new Error("relay addresses must be IPv4");
  const ports = new Set();
  const ips = new Set();
  for (const h of model.hops) {
    if (!isV4(h.ip)) throw new Error("exit addresses must be IPv4");
    checkName(h.name, "exit");
    if (ports.has(h.port)) throw new Error(`port ${h.port} is used twice`);
    if (ips.has(h.ip)) throw new Error("one exit has two hop ports");
    ports.add(h.port);
    ips.add(h.ip);
  }
}

/** The whole file. Deleting the table first makes loading it atomic and repeatable. */
export function renderChainFw(model) {
  checkModel(model);
  const hops = [...model.hops].sort((a, b) => a.port - b.port);
  const lines = [
    "#!/usr/sbin/nft -f",
    "# Relay chaining NAT, written by scripts/fleet (do not edit by hand:",
    "# the next run renders it again from the relay's own rules).",
    "# The relay DNATs an exit's 443 to this server on a 4713x port; this",
    "# server forwards to the exit's 443 and masquerades. Only sources in",
    "# @relays are touched.",
    "table ip neoxify_chain",
    "delete table ip neoxify_chain",
    "table ip neoxify_chain {",
    "  set relays {",
    "    type ipv4_addr",
    `    elements = { ${model.relays.join(", ")} }`,
    "  }",
    "  chain prerouting {",
    "    type nat hook prerouting priority dstnat; policy accept;",
    ...hops.map((h) => `    ip saddr @relays tcp dport ${h.port} counter dnat to ${h.ip}:443 comment "${h.name}"`),
    "  }",
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    ...(hops.length
      ? [`    ip saddr @relays ip daddr { ${hops.map((h) => h.ip).join(", ")} } tcp dport 443 counter masquerade`]
      : []),
    "  }",
    "}",
    "",
  ];
  return lines.join("\n");
}

/** A new exit on the lowest free port at or above the base. */
export function chainAdd(model, { ip, name }, base = 47131) {
  if (model.hops.some((h) => h.ip === ip)) throw new Error("that exit already has a hop port");
  const used = new Set(model.hops.map((h) => h.port));
  let port = base;
  while (used.has(port)) port++;
  const next = { relays: [...model.relays], hops: [...model.hops, { port, ip, name }] };
  checkModel(next);
  return { model: next, port };
}

export function chainRemove(model, ip) {
  const hops = model.hops.filter((h) => h.ip !== ip);
  if (hops.length === model.hops.length) throw new Error("that exit has no hop port here");
  return { relays: [...model.relays], hops };
}

/**
 * The hop table rebuilt from the relay's own rules. This is how the hop
 * moves to a new server when the old one is already gone: the relay
 * still knows every exit and port it was using.
 *
 * `hopIps` is every server the rules may point at while the move is
 * under way: the old hop, and the new one. A move that stopped halfway
 * leaves some rules on each, and a table built from the old hop's rules
 * alone would, loaded over the new server's table, drop the exits that
 * had already moved.
 */
export function chainFromRelayRules(rules, relayIps, hopIps) {
  const through = [].concat(hopIps);
  if (!through.length || !through.every(isV4)) throw new Error("hop addresses must be IPv4");
  const mine = rules.filter((r) => through.includes(r.hopIp));
  if (!mine.length) throw new Error("the relay has no rule through that hop");
  const model = {
    relays: [...relayIps],
    hops: mine.map((r) => ({ port: r.hopPort, ip: r.exitIp, name: r.exitName })),
  };
  checkModel(model);
  return model;
}

/** How many hop rules, in a live listing or in the file, are for that exit / go through that hop. */
export function countHopRules(rules, by, ip) {
  if (!isV4(ip)) throw new Error("not an IPv4 address");
  if (by !== "exit" && by !== "hop") throw new Error("count by exit or by hop");
  return rules.filter((r) => (by === "exit" ? r.exitIp : r.hopIp) === ip).length;
}

/**
 * Is the exit's rule exactly "to that hop, on that port"? "none" when the
 * exit has no rule, "yes" or "no" otherwise. This is what lets a step
 * that stopped halfway run again: a rule that is already right is kept,
 * and one that points somewhere else is nobody's to overwrite. With no
 * port given, only the hop is compared (asked before a port is chosen).
 */
export function hopRuleIs(rules, { exitIp, hopIp, hopPort = null }) {
  if (!isV4(exitIp) || !isV4(hopIp)) throw new Error("exit and hop must be IPv4 addresses");
  const r = ruleForExit(rules, exitIp);
  if (!r) return "none";
  return r.hopIp === hopIp && (hopPort === null || r.hopPort === hopPort) ? "yes" : "no";
}
