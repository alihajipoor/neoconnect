/**
 * What a provider's image brings along, and the two builds of November
 * 2026 that met all of it at once.
 *
 * Those boxes arrived on a release the installer refused, with ufw
 * active on DROP policies, a hostname taken from the dashboard label, a
 * swap file of the provider's own size and an interface that is not
 * called eth0. Each was repaired by hand. The repairs are the
 * installer's now (installer/lib/image.sh), and this holds still the
 * parts of them that can be run without a server:
 *
 *   - the OS matrix: 26.10 is accepted, a release nobody built on is not;
 *   - ufw's chains are taken out policies-first, and nothing that is not
 *     ufw's is touched. The order is what keeps SSH open, so it is
 *     asserted from the calls a stand-in iptables received;
 *   - an ACTIVE ufw is not torn down by "save the firewall rules";
 *   - /etc/hosts and /etc/fstab are rewritten as text, on fixtures;
 *   - nothing in the installer, the fleet tool or the agent names a
 *     network interface: the proof that nothing assumes eth0;
 *   - the installer asks two different questions about a disguise site,
 *     and the checklist's prepared "yes" can only land on one of them.
 *
 * None of this is a server. iptables, ip6tables and ufw are stand-ins.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const IMAGE = join(REPO, "installer", "lib", "image.sh");
const OS_DETECT = join(REPO, "installer", "lib", "os-detect.sh");
const BASH = process.env.FLEET_BASH || "bash";
const fwd = (p) => p.replace(/\\/g, "/");

let dir;
let log;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-image-"));
  log = fwd(join(dir, "calls"));
  // -S answers from a fixture file; every other call is written down.
  for (const [tool, rules] of [["iptables", "T_RULES4"], ["ip6tables", "T_RULES6"]]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\nif [ "$1" = "-S" ]; then cat "$${rules}" 2>/dev/null; exit 0; fi\necho "${tool} $*" >> "$T_LOG"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  writeFileSync(join(dir, "ufw"), '#!/bin/sh\nif [ "$1" = status ]; then echo "Status: ${T_UFW:-inactive}"; exit 0; fi\necho "ufw $*" >> "$T_LOG"\n');
  chmodSync(join(dir, "ufw"), 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name, text) => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return fwd(f);
};
// One function of image.sh, run for real, with the stand-ins first on PATH.
const image = (fn, args = [], env = {}) => {
  if (existsSync(log)) rmSync(log);
  const r = spawnSync(BASH, ["-c", 'source "$0"; "$@"', fwd(IMAGE), fn, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: dir + delimiter + process.env.PATH,
      T_LOG: log,
      T_RULES4: fixture("empty4", "-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n"),
      T_RULES6: fixture("empty6", "-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n"),
      IMAGE_UFW_CONF: fwd(join(dir, "no-ufw.conf")),
      ...env,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
};

// What `iptables -S` shows on a box where ufw was removed while active:
// DROP policies, the jumps, ufw's own chains, and two rules that are not
// ufw's and must still be there afterwards.
const UFW_LEFT = [
  "-P INPUT DROP",
  "-P FORWARD DROP",
  "-P OUTPUT ACCEPT",
  "-N ufw-before-input",
  "-N ufw-user-input",
  "-N ufw-before-forward",
  "-N ufw-track-output",
  "-A INPUT -j ufw-before-input",
  "-A INPUT -j ufw-user-input",
  "-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT",
  "-A FORWARD -j ufw-before-forward",
  "-A FORWARD -s 10.66.0.0/24 -j ACCEPT",
  "-A OUTPUT -j ufw-track-output",
  "-A ufw-before-input -j ufw-user-input",
  "-A ufw-user-input -p tcp -m tcp --dport 22 -j ACCEPT",
  "",
].join("\n");

describe("the installer's OS matrix", () => {
  const detect = (id, version) => {
    const f = fixture(`os-${id}-${version}`, `ID=${id}\nVERSION_ID="${version}"\nPRETTY_NAME="test"\n`);
    return spawnSync(BASH, ["-c", 'source "$0"; detect_os; echo "detected $OS_ID $OS_VERSION"', fwd(OS_DETECT)], {
      encoding: "utf8",
      env: { ...process.env, NEOXIFY_OS_RELEASE: f },
    });
  };
  it("accepts every release a node has been built on, Ubuntu 26.10 included", () => {
    for (const v of ["20.04", "22.04", "24.04", "26.04", "26.10"]) {
      const r = detect("ubuntu", v);
      assert.equal(r.status, 0, `Ubuntu ${v}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`detected ubuntu ${v.replace(".", "\\.")}`));
    }
    assert.equal(detect("debian", "12").status, 0);
  });
  it("still refuses a release nobody has built on, and says which ones it takes", () => {
    for (const [id, v] of [["ubuntu", "25.10"], ["ubuntu", "27.04"], ["debian", "13"], ["fedora", "42"]]) {
      const r = detect(id, v);
      assert.equal(r.status, 1, `${id} ${v} was accepted`);
    }
    assert.match(detect("ubuntu", "25.10").stderr, /26\.04, 26\.10/);
  });
});

describe("ufw on a provider's image", () => {
  it("is found three ways: active, gone with its chains left, and not at all", () => {
    const active = image("image_ufw_state", [], { T_UFW: "active", T_RULES4: fixture("r4a", UFW_LEFT) });
    assert.equal(active.code, 1);
    assert.match(active.out, /ufw: ACTIVE \(policy INPUT DROP FORWARD DROP\)/);

    const left = image("image_ufw_state", [], { T_RULES4: fixture("r4b", UFW_LEFT) });
    assert.equal(left.code, 1);
    assert.match(left.out, /its chains are still loaded/);

    const left6 = image("image_ufw_state", [], { T_RULES6: fixture("r6", "-P INPUT ACCEPT\n-N ufw6-before-input\n") });
    assert.equal(left6.code, 1, "chains left only in the IPv6 tables count too");

    const clean = image("image_ufw_state");
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /not active, none of its chains loaded/);
  });

  it("a DROP policy that is not ufw's is reported and left for a person", () => {
    const r = image("image_ufw_state", [], { T_RULES4: fixture("r4c", "-P INPUT DROP\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT\n") });
    assert.equal(r.code, 2);
    assert.match(r.out, /not ufw's\. Left as it is/);
    const fix = image("drop_ufw_leftovers", [], { T_RULES4: fixture("r4d", "-P INPUT DROP\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n") });
    assert.deepEqual(fix.calls, [], "somebody's own firewall was changed");
  });

  it("its chains are taken out policies first, then jumps, then emptied, then deleted", () => {
    const r = image("image_drop_ufw_chains", [], { T_RULES4: fixture("r4e", UFW_LEFT) });
    assert.equal(r.code, 0, r.out);
    const c = r.calls;
    assert.deepEqual(c.slice(0, 3), ["iptables -P INPUT ACCEPT", "iptables -P FORWARD ACCEPT", "iptables -P OUTPUT ACCEPT"],
      "the policies go back to ACCEPT before anything is deleted: the rule that lets SSH in lives in a ufw chain");
    const at = (line) => {
      const i = c.indexOf(line);
      assert.ok(i >= 0, `not called: ${line}\n${c.join("\n")}`);
      return i;
    };
    for (const jump of ["iptables -D INPUT -j ufw-before-input", "iptables -D INPUT -j ufw-user-input", "iptables -D FORWARD -j ufw-before-forward", "iptables -D OUTPUT -j ufw-track-output"]) {
      assert.ok(at(jump) > 2);
    }
    const chains = ["ufw-before-input", "ufw-user-input", "ufw-before-forward", "ufw-track-output"];
    const lastFlush = Math.max(...chains.map((n) => at(`iptables -F ${n}`)));
    const firstDelete = Math.min(...chains.map((n) => at(`iptables -X ${n}`)));
    assert.ok(lastFlush < firstDelete, "every ufw chain is emptied before any is deleted: they jump to one another");
    assert.ok(at("iptables -D OUTPUT -j ufw-track-output") < Math.min(...chains.map((n) => at(`iptables -F ${n}`))));
    assert.ok(!c.some((l) => /--dport 22|10\.66\.0\.0/.test(l) && !/ufw-/.test(l)), "a rule that is not ufw's was touched");
    assert.ok(!c.some((l) => l.startsWith("ip6tables ")), "the IPv6 tables had no ufw chain and were changed all the same");
  });

  it("nothing is called on a box that has no ufw chain", () => {
    assert.deepEqual(image("image_drop_ufw_chains").calls, []);
    assert.deepEqual(image("drop_ufw_leftovers").calls, []);
  });

  it("before the rules are saved: leftovers go, an ACTIVE ufw is somebody's decision and stays", () => {
    const left = image("drop_ufw_leftovers", [], { T_RULES4: fixture("r4f", UFW_LEFT) });
    assert.equal(left.code, 0, left.out);
    assert.ok(left.calls.includes("iptables -X ufw-user-input"));
    assert.match(left.out, /leftover chains removed before the firewall rules are saved/);

    const active = image("drop_ufw_leftovers", [], { T_UFW: "active", T_RULES4: fixture("r4g", UFW_LEFT) });
    assert.equal(active.code, 0);
    assert.deepEqual(active.calls, [], "an active ufw was torn down as a side effect of saving rules");
    assert.match(active.out, /WARNING: ufw is active on this node/);
  });

  it("every place the installer saves the firewall rules clears ufw's leftovers first", () => {
    const agent = readFileSync(join(REPO, "installer", "lib", "agent.sh"), "utf8").split("\n");
    const saves = agent.map((l, i) => [l, i]).filter(([l]) => /^\s*netfilter-persistent save/.test(l));
    assert.ok(saves.length >= 2, "no `netfilter-persistent save` found in the installer");
    for (const [, i] of saves) {
      const before = agent.slice(Math.max(0, i - 6), i).join("\n");
      assert.match(before, /drop_ufw_leftovers/, `agent.sh line ${i + 1} saves the rules without clearing ufw's chains`);
    }
    const install = readFileSync(join(REPO, "installer", "install.sh"), "utf8");
    assert.ok(install.indexOf("lib/image.sh") > 0 && install.indexOf("lib/image.sh") < install.indexOf('. "$SCRIPT_DIR/lib/agent.sh"'), "install.sh loads image.sh before agent.sh");
    const fresh = agent.join("\n");
    assert.ok(fresh.indexOf("  prepare_provider_image\n") < fresh.indexOf("  install_base_deps\n  raise_conntrack_max"), "the image is repaired before any package is installed");
  });
});

describe("a hostname that carries the brand", () => {
  it("/etc/hosts loses every spelling of it, and nothing else changes", () => {
    const hosts = fixture("hosts", [
      "127.0.0.1 localhost",
      "127.0.1.1 Neox-Label9 Neox-Label9",
      "# The following lines are desirable for IPv6 capable hosts (my-vpn-box)",
      "::1 localhost ip6-localhost ip6-loopback",
      "203.0.113.9\tneox-label9.example.net neox-label9 keep-me",
      "",
    ].join("\n"));
    const r = image("image_hosts_generic", [hosts, "ubuntu"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.out.split("\n"), [
      "127.0.0.1 localhost",
      "127.0.1.1 ubuntu",
      "# The following lines are desirable for IPv6 capable hosts (my-vpn-box)",
      "::1 localhost ip6-localhost ip6-loopback",
      "203.0.113.9 ubuntu keep-me",
      "",
    ]);
  });
  it("the pin names the box, because preserve_hostname alone did not hold over a reboot", () => {
    const text = readFileSync(IMAGE, "utf8");
    const pin = /cat >"\$IMAGE_HOSTNAME_PIN" <<EOF\n([\s\S]*?)\nEOF/.exec(text);
    assert.ok(pin, "no pin file in image.sh");
    for (const line of ["preserve_hostname: true", "manage_etc_hosts: false", "hostname: $new", "fqdn: $new", "prefer_fqdn_over_hostname: false"]) {
      assert.ok(pin[1].split("\n").includes(line), `the pin lacks '${line}'`);
    }
    assert.ok(text.indexOf('cat >"$IMAGE_HOSTNAME_PIN"') < text.indexOf("hostnamectl set-hostname"), "the pin is written before the box is renamed");
  });
});

describe("the provider's swap file", () => {
  it("/etc/fstab ends with exactly one line for it, the fleet's, however often it is rewritten", () => {
    const fstab = fixture("fstab", "UUID=0000-0000 / ext4 defaults 0 1\n/swapfile swap swap defaults 0 0\n# a comment\n");
    const once = image("image_fstab_fleet", [fstab]);
    assert.equal(once.out, "UUID=0000-0000 / ext4 defaults 0 1\n# a comment\n/swapfile none swap sw 0 0\n");
    const twice = image("image_fstab_fleet", [fixture("fstab2", once.out)]);
    assert.equal(twice.out, once.out);
  });
});

describe("nothing assumes an interface name", () => {
  // The boxes this was written for call their interface enp1s0. Every
  // rule has to name whatever the routing table says, so a literal name
  // in code (not in a comment, which is where the history is told) fails.
  const literal = /\b(eth|ens|enp|eno|enx|enX|venet)[0-9][a-z0-9]*\b/;
  const walk = (d, keep, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "test") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, keep, out);
      else if (keep(e.name)) out.push(p);
    }
    return out;
  };
  const check = (files, comment) => {
    assert.ok(files.length > 0);
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((l, i) => {
        if (comment.test(l)) return;
        assert.doesNotMatch(l, literal, `${f}:${i + 1} names a network interface`);
      });
    }
  };
  it("in the installer and the fleet tool", () => {
    check(walk(join(REPO, "installer"), () => true), /^\s*(#|"\/\/")/);
    check(walk(join(REPO, "scripts", "fleet"), () => true), /^\s*(#|\/\/|\*|--)/);
  });
  it("in the agent", () => {
    check(walk(join(REPO, "agent"), (n) => n.endsWith(".go") && !n.endsWith("_test.go")), /^\s*\/\//);
  });
  it("and a built server is checked for it: NAT must leave by the default route's interface", () => {
    const verify = readFileSync(join(HERE, "..", "remote", "node", "verify.sh"), "utf8");
    assert.match(verify, /NAT leaves by the interface the default route uses/);
    assert.match(verify, /provider-image\.sh/);
  });
});

describe("the installer's two questions about a disguise site", () => {
  const agent = readFileSync(join(REPO, "installer", "lib", "agent.sh"), "utf8");
  const prompts = [...agent.matchAll(/read -r -p "([^"]*)"/g)].map((m) => m[1]);
  const add = readFileSync(join(HERE, "..", "lib", "checklist-add.sh"), "utf8");
  // The answers table, as install_answers writes it: <regex><TAB><answer>.
  const rows = /cat <<EOF\n(Choose[\s\S]*?)\nEOF/.exec(add)[1].split("\n").map((l) => l.split("\t"));
  const rowFor = (prompt) => rows.find(([rx]) => new RegExp(rx.replace(/\\\\/g, "\\")).test(prompt));

  it("a weak disguise and a dest that cannot work are asked about in different words", () => {
    const weak = prompts.filter((p) => /Use it anyway\?/.test(p));
    const dead = prompts.filter((p) => /although REALITY will not work/.test(p));
    assert.equal(weak.length, 1);
    assert.equal(dead.length, 1);
    assert.notEqual(weak[0], dead[0]);
  });
  it("--accept-weak-dest can answer the first, and nothing prepared answers the second", () => {
    const weak = prompts.find((p) => /Use it anyway\?/.test(p));
    const dead = prompts.find((p) => /although REALITY will not work/.test(p));
    assert.equal(rowFor(weak)[1], "$weak");
    assert.equal(rowFor(dead)[1], "@STOP", "a prepared answer could build a server on a dest REALITY cannot use");
  });
  it("a failed X25519-only handshake is in the list of what makes a dest unusable", () => {
    const probe = agent.slice(agent.indexOf("probe_reality_dest() {"), agent.indexOf("XRAY_BIN="));
    assert.match(probe, /if ! reality_x25519_only "\$ip" "\$port" "\$host"; then\n\s+bad\+=/);
    assert.doesNotMatch(probe, /note\+=\("does not negotiate X25519"\)/, "X25519 is advisory again");
  });
});
