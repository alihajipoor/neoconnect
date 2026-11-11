/**
 * What real servers printed on the tool's first read-only run, and what
 * the tool made of it.
 *
 * Everything else under test/ was written from what a command was
 * expected to print. The first run against the fleet (status, the
 * guards, verify, the parity check, the hop and plan parsers; nothing
 * that writes) found three places where the real thing is shaped
 * otherwise, and each read a healthy server wrongly:
 *
 *   - `xray api lsrules` prints a route rule as two lines, "ruleTag" and
 *     "tag", both with the route's tag. Counted by line, 28 rules were
 *     reported as 56;
 *   - ip6tables prints and saves a rule's owner as a number. Looked for
 *     by name, the two rules that keep Xray off IPv6 were "missing" on
 *     every server that has them, live and in the saved file;
 *   - the API mirror sites were compared byte for byte with a rendering
 *     whose header lines stand in another order than on every server,
 *     and without the comment line a person wrote above each site.
 *
 * The fixtures here are those outputs and files as they were, with
 * addresses and names of ours replaced by documentation ones. The
 * shapes that were read right the first time are kept too (the user
 * count, the hop server's hand-edited table), so they stay read right.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chainAdd, chainRemove, parseChainFw, parseHopRules, renderChainFw } from "../lib/hop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASH = process.env.FLEET_BASH || "bash";
const fwd = (p) => p.replace(/\\/g, "/");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

// `xray api lsrules` on the relay box, Xray 26.3.27: the two fixed
// rules, the IPv6 block, then one object per relay route.
const LSRULES = `{
    "rules": [
        {
            "tag": "api"
        },
        {
            "tag": "block"
        },
        {
            "ruleTag": "block-ipv6-egress",
            "tag": "block"
        },
        {
            "ruleTag": "route-${ID1}-out",
            "tag": "route-${ID1}-out"
        },
        {
            "ruleTag": "route-${ID2}-out",
            "tag": "route-${ID2}-out"
        }
    ]
}
`;
// `xray api lso`: the tag once per outbound, among its settings.
const LSO = `{
    "outbounds": [
        {
            "proxySettings": {
                "_TypedMessage_": "xray.proxy.freedom.Config"
            },
            "tag": "direct"
        },
        {
            "tag": "block"
        },
        {
            "proxySettings": {
                "_TypedMessage_": "xray.proxy.vless.outbound.Config"
            },
            "tag": "route-${ID1}-out"
        },
        {
            "proxySettings": {
                "_TypedMessage_": "xray.proxy.vless.outbound.Config"
            },
            "tag": "route-${ID2}-out"
        }
    ]
}
`;

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-real-"));
  const sh = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  // Xray's API client as it answered: three lines for a count, an error
  // and a non-zero exit for a tag it does not have.
  sh("xray", `
verb="$2"
for a in "$@"; do last="$a"; done
case "$verb" in
  lsrules) cat "$T_LSRULES" ;;
  lso) cat "$T_LSO" ;;
  inboundusercount)
    case "$last" in
      nosuch-in) echo "failed to get inbound user count: rpc error: code = Unknown desc = app/proxyman/command: failed to get handler: nosuch-in > app/proxyman/inbound: handler not found: nosuch-in" >&2; exit 1 ;;
      zero-in) printf '{\\n    "count": 0\\n}\\n\\n' ;;
      empty-in) printf '{\\n}\\n\\n' ;;
      *) printf '{\\n    "count": 74\\n}\\n\\n' ;;
    esac ;;
esac`);
  // list-unit-files as a server with chrony printed it, with the pause
  // between its lines that lets a `grep -q` on the far side leave first.
  sh("systemctl", `
case "$*" in
  *MainPID*) echo 74478 ;;
  *NRestarts*) echo 0 ;;
  *is-active*) echo active ;;
  *list-unit-files*)
    printf 'UNIT FILE      STATE   PRESET\\nchrony.service enabled enabled\\n'
    sleep 1
    printf '\\n1 unit files listed.\\n' ;;
esac`);
  sh("nginx", 'echo "nginx version: nginx/${T_NGINX:-1.30.4} (Ubuntu)" >&2');
});
after(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name, text) => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return fwd(f);
};
const relay = (args, env = {}) => {
  const r = spawnSync(BASH, [fwd(join(ROOT, "remote", "relay", "relay.sh")), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: dir + delimiter + process.env.PATH,
      NX_XRAY: fwd(join(dir, "xray")),
      T_LSRULES: fixture("lsrules", LSRULES),
      T_LSO: fixture("lso", LSO),
      ...env,
    },
  });
  return r.stdout + r.stderr;
};

describe("the relay box's Xray, as its API really prints", () => {
  it("a route rule is one rule, though it is printed as two lines that carry its tag", () => {
    const out = relay(["state", ID1, GONE]);
    assert.match(out, /^xray pid 74478, restarts 0$/m);
    assert.match(out, /^route rules 2, route outbounds 2$/m);
    assert.match(out, new RegExp(`^${ID1} rules=1 outbounds=1$`, "m"));
  });
  it("a deleted route reads as gone, and one that is still there never does", () => {
    const out = relay(["state", ID1, GONE]);
    assert.match(out, new RegExp(`^${GONE} rules=0 outbounds=0$`, "m"));
    // What retire.relay-routes looks for before it calls a route gone.
    assert.match(out, /rules=[1-9]|outbounds=[1-9]/);
    assert.doesNotMatch(relay(["state", GONE]), /rules=[1-9]|outbounds=[1-9]/);
  });
  it("a listing with no ruleTag line at all still shows a rule that is there", () => {
    const old = fixture("lsrules-old", LSRULES.replace(/^\s*"ruleTag": .*\n/gm, ""));
    const out = relay(["state", ID1, GONE], { T_LSRULES: old });
    assert.match(out, new RegExp(`^${ID1} rules=1 outbounds=1$`, "m"));
    assert.match(out, new RegExp(`^${GONE} rules=0 outbounds=0$`, "m"));
  });
  it("users per inbound: the count, zero either way it can be printed, and ? when the call failed", () => {
    const out = relay(["usercount", "vless-fr-in", "zero-in", "empty-in", "nosuch-in"]);
    assert.deepEqual(out.trim().split("\n"), ["vless-fr-in=74", "zero-in=0", "empty-in=0", "nosuch-in=?"]);
  });
  it("the same count line is what the checklist reads on an exit", () => {
    // xray_counts in lib/checklist-add.sh sends this to the box; it is
    // run here against the stand-in, quotes and all.
    const add = read("lib", "checklist-add.sh");
    const m = /rsh "\$role" "(for t in \$\*; do if o=[^\n]*tr '\\n' ' ')"\n/.exec(add);
    assert.ok(m, "could not find the count loop in xray_counts");
    const cmd = m[1].replace(/\\(["$\\])/g, "$1").replace("$*", "vless-in nosuch-in").replaceAll("/usr/local/bin/xray", fwd(join(dir, "xray")));
    const r = spawnSync(BASH, ["-c", cmd], { encoding: "utf8" });
    assert.equal(r.stdout, "vless-in=74 nosuch-in=? ");
  });
});

// `ip6tables -S OUTPUT` on a server of the fleet, and the same two rules
// in its /etc/iptables/rules.v6. They were added with --uid-owner nobody.
const V6_LIVE = [
  "-P OUTPUT ACCEPT",
  "-A OUTPUT -o enp1s0 -p tcp -m owner --uid-owner 65534 -j REJECT --reject-with tcp-reset",
  "-A OUTPUT -o enp1s0 -m owner --uid-owner 65534 -j REJECT --reject-with icmp6-port-unreachable",
  "",
].join("\n");
const V6_SAVED = [
  "*filter",
  ":INPUT ACCEPT [0:0]",
  ":FORWARD ACCEPT [0:0]",
  ":OUTPUT ACCEPT [0:0]",
  "-A OUTPUT -o enp1s0 -p tcp -m owner --uid-owner 65534 -j REJECT --reject-with tcp-reset",
  "-A OUTPUT -o enp1s0 -m owner --uid-owner 65534 -j REJECT --reject-with icmp6-port-unreachable",
  "COMMIT",
  "",
].join("\n");

describe("the IPv6 rules for Xray, as ip6tables really prints them", () => {
  const fnOf = (file) => {
    const m = /^v6_owner_rules\(\) \{[^\n]*\n[\s\S]*?^\}$/m.exec(read("remote", "node", file));
    assert.ok(m, `${file} has no v6_owner_rules`);
    return m[0];
  };
  const count = (file, text) => {
    const r = spawnSync(BASH, ["-c", `${fnOf(file)}\nv6_owner_rules`], { encoding: "utf8", input: text });
    return r.stdout.trim();
  };
  it("verify.sh and parity.sh count them the same way", () => {
    assert.equal(fnOf("verify.sh"), fnOf("parity.sh"));
  });
  for (const file of ["verify.sh", "parity.sh"]) {
    it(`${file}: two rules by number are the two rules (they used to read as none)`, () => {
      assert.equal(count(file, V6_LIVE), "2");
      assert.equal(count(file, V6_LIVE.replaceAll("65534", "nobody")), "2");
    });
    it(`${file}: another user's rules, or one rule of the two, are not it`, () => {
      assert.equal(count(file, V6_LIVE.replaceAll("65534", "655340")), "0");
      assert.equal(count(file, V6_LIVE.replaceAll("65534", "0")), "0");
      assert.equal(count(file, V6_LIVE.split("\n").slice(0, 2).join("\n") + "\n"), "1");
      assert.equal(count(file, "-P OUTPUT ACCEPT\n"), "0");
    });
  }
  it("neither script looks for the name alone any more", () => {
    for (const file of ["verify.sh", "parity.sh"]) {
      assert.doesNotMatch(read("remote", "node", file), /grep[^\n|]*'--uid-owner nobody'/, file);
    }
  });
  it("parity.sh: the saved file counts when it holds both rules, by number", () => {
    const src = read("remote", "node", "parity.sh");
    const fns = src.slice(src.indexOf("v6_owner_rules() {"), src.indexOf("# same_site <rendered>"));
    const saved = (text) => {
      const env = { ...process.env };
      if (text !== null) env.RULES6 = fixture("rules.v6", text);
      else env.RULES6 = fwd(join(dir, "no-such-file"));
      return spawnSync(BASH, ["-c", `${fns}\nv6_saved`], { encoding: "utf8", env }).status;
    };
    assert.equal(saved(V6_SAVED), 0);
    assert.equal(saved(V6_SAVED.split("\n").filter((l) => !l.includes("tcp-reset")).join("\n")), 1);
    assert.equal(saved("*filter\nCOMMIT\n"), 1);
    assert.equal(saved(null), 1);
  });
});

describe("a match is a match, though the command on the left is still writing", () => {
  // Under pipefail, `command | grep -q x` fails with x found when grep
  // leaves on its first match and the command is killed writing its next
  // line. On a real server that runs chrony, verify.sh took that for "no
  // chrony" 16 times out of 40 and failed systemd-timesyncd as a unit.
  it("verify.sh picks the time unit the server has", () => {
    const m = /^units_listed=.*\ntimeunit=chrony\ngrep -q chrony .*$/m.exec(read("remote", "node", "verify.sh"));
    assert.ok(m, "could not find the time unit lines in verify.sh");
    const r = spawnSync(BASH, ["-c", `set -uo pipefail\n${m[0]}\necho "$timeunit"`], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH },
    });
    assert.equal(r.stdout.trim(), "chrony", r.stderr);
  });
  it("no script that gives a verdict pipes a command into grep -q", () => {
    for (const f of [["node", "verify.sh"], ["node", "hop-server.sh"], ["node", "parity.sh"], ["relay", "relay.sh"], ["inside", "inside.sh"], ["panel", "nx-node-outside.sh"]]) {
      read("remote", ...f).split("\n").forEach((l, i) => {
        if (/^\s*#/.test(l)) return;
        assert.doesNotMatch(l, /\|\s*grep -q/, `${f.join("/")}:${i + 1} pipes into grep -q under pipefail: capture first`);
      });
    }
  });
});

describe("the API mirror sites, as they stand on the fleet's servers", () => {
  // api_block, http2_new and render_sites, as parity.sh has them.
  const src = read("remote", "node", "parity.sh");
  const render = src.slice(src.indexOf("api_block() {"), src.indexOf("p_nginx() {"));
  const sameSite = src.slice(src.indexOf("same_site() {"), src.indexOf("# Both certificates have to exist"));
  const run = (script, env = {}) =>
    spawnSync(BASH, ["-c", `${render}\n${sameSite}\n${script}`, fwd(dir)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        PADDR: "203.0.113.5",
        PNAME: "origin.example.net",
        L2: "def456.example.org",
        ...env,
      },
    });
  const real = (f) => fwd(join(HERE, "real", f));

  it("what the tool renders is what a server of the fleet has, the person's comment line aside", () => {
    const r = run(
      `render_sites "$0" && same_site "$0/neoxify-fallback" "${real("site-fallback.conf")}" && same_site "$0/neoxify-mirror-direct" "${real("site-mirror-direct.conf")}" && echo same`,
    );
    assert.equal(r.stdout.trim(), "same", r.stderr);
  });
  it("byte for byte they differ, which is what called every server drift", () => {
    const r = run(`render_sites "$0"; cmp -s "$0/neoxify-fallback" "${real("site-fallback.conf")}"; echo "cmp=$?"`);
    assert.equal(r.stdout.trim(), "cmp=1");
  });
  it("a real difference is still a difference", () => {
    const off = fixture("site-off", readFileSync(join(HERE, "real", "site-fallback.conf"), "utf8").replace("proxy_ssl_verify on;", "proxy_ssl_verify off;"));
    assert.equal(run(`render_sites "$0"; same_site "$0/neoxify-fallback" "${off}"; echo "rc=$?"`).stdout.trim(), "rc=1");
    assert.equal(run(`render_sites "$0"; same_site "$0/neoxify-fallback" "$0/no-such-site"; echo "rc=$?"`).stdout.trim(), "rc=1");
    // Another panel address is drift, not a comment.
    assert.equal(run(`render_sites "$0"; same_site "$0/neoxify-fallback" "${real("site-fallback.conf")}"; echo "rc=$?"`, { PADDR: "203.0.113.6" }).stdout.trim(), "rc=1");
  });
  it("an older nginx gets the older spelling of HTTP/2, and that is not the fleet's newer form", () => {
    const r = run(`render_sites "$0"; grep -c 'http2 on;' "$0/neoxify-fallback"; grep -c 'listen 127.0.0.1:8081 http2 proxy_protocol;' "$0/neoxify-fallback"`, { T_NGINX: "1.24.0" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["0", "1"]);
  });
});

describe("the hop server's table, as a person left it", () => {
  // Hand-edited the day before: lines of history at the top, and a second
  // masquerade rule for the exit that was added last. The tool renders
  // one rule with a set, and has to read this all the same.
  const text = readFileSync(join(HERE, "real", "chain-fw.nft"), "utf8");
  it("is read as it is: one relay, three exits, each on its port", () => {
    const m = parseChainFw(text);
    assert.deepEqual(m.relays, ["198.51.100.20"]);
    assert.deepEqual(m.hops, [
      { port: 47131, ip: "203.0.113.10", name: "turkey-1" },
      { port: 47132, ip: "203.0.113.20", name: "netherlands-1" },
      { port: 47133, ip: "203.0.113.30", name: "uk-1" },
    ]);
  });
  it("taking the last exit out, or adding one, renders a table that says the same about the others", () => {
    const less = parseChainFw(renderChainFw(chainRemove(parseChainFw(text), "203.0.113.30")));
    assert.deepEqual(less.hops.map((h) => h.name), ["turkey-1", "netherlands-1"]);
    const more = chainAdd(parseChainFw(text), { ip: "203.0.113.40", name: "france-2" });
    assert.equal(more.port, 47134);
    const out = renderChainFw(more.model);
    assert.equal((out.match(/masquerade/g) || []).filter(Boolean).length, 2); // the header's word, and one rule
    assert.match(out, /ip daddr \{ 203\.0\.113\.10, 203\.0\.113\.20, 203\.0\.113\.30, 203\.0\.113\.40 \} tcp dport 443 counter masquerade/);
  });
  it("the relay's live rules for those exits, tabs, counters and handles as nft prints them", () => {
    const live = [
      "table ip neoxify_relay_chain {",
      "\tchain output { # handle 1",
      "\t\ttype nat hook output priority -100; policy accept;",
      '\t\tip daddr 203.0.113.10 tcp dport 443 counter packets 66 bytes 3960 dnat to 198.51.100.40:47131 comment "turkey-1 via germany-3" # handle 2',
      '\t\tip daddr 203.0.113.20 tcp dport 443 counter packets 66 bytes 3960 dnat to 198.51.100.40:47132 comment "netherlands-1 via germany-3" # handle 3',
      '\t\tip daddr 203.0.113.30 tcp dport 443 counter packets 54 bytes 3240 dnat to 198.51.100.40:47133 comment "uk-1 via germany-3" # handle 7',
      "\t}",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(
      parseHopRules(live).map((r) => [r.handle, r.exitName, r.hopName, r.hopPort]),
      [[2, "turkey-1", "germany-3", 47131], [3, "netherlands-1", "germany-3", 47132], [7, "uk-1", "germany-3", 47133]],
    );
  });
});
