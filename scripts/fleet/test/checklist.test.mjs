/**
 * The checklists themselves, run for real under --dry-run against a
 * fixture address file.
 *
 * What this holds still:
 *   - the ordered list of step ids of every command. A step that
 *     disappears, or moves, fails here: the whole point of the tool is
 *     that nothing gets forgotten, so forgetting a step has to be loud.
 *     When a step is added or moved on purpose, update
 *     expected-steps.json in the same commit.
 *   - a dry run touches nothing: ssh, scp, curl and tar are replaced by
 *     stand-ins that record being called, and none may be.
 *   - every step shows a VERIFY.
 *   - nothing address-like from the fixture reaches the output;
 *   - the order of a few commands INSIDE a step, where the order is the
 *     safety (the relay's agent is asked for before a relay route is
 *     deleted), and that the checklists never switch off the guard
 *     against restarting an engine under customers.
 *
 *   node --test scripts/fleet/test/*.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = join(HERE, "..", "fleet");
const ENV = join(HERE, "fixture.env");
const EXPECTED = JSON.parse(readFileSync(join(HERE, "expected-steps.json"), "utf8"));
const BASH = process.env.FLEET_BASH || "bash";

let stubs;
let marker;

before(() => {
  stubs = mkdtempSync(join(tmpdir(), "fleet-stubs-"));
  marker = join(stubs, "called");
  for (const tool of ["ssh", "scp", "curl", "tar"]) {
    const f = join(stubs, tool);
    writeFileSync(f, `#!/bin/sh\necho "${tool} $*" >> "${marker.replace(/\\/g, "/")}"\nexit 97\n`);
    chmodSync(f, 0o755);
  }
});
after(() => rmSync(stubs, { recursive: true, force: true }));

function fleet(args) {
  return new Promise((resolve) => {
    execFile(
      BASH,
      [FLEET, ...args, "--dry-run", "--env", ENV],
      {
        env: { ...process.env, PATH: stubs + delimiter + process.env.PATH, FLEET_HOME: join(stubs, "home") },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }),
    );
  });
}

const stepIds = (out) => [...out.matchAll(/^\[\s*\d+\/\d+\] (\S+)  /gm)].map((m) => m[1]);

const RUNS = {
  precheck: ["precheck", "203.0.113.10"],
  add: ["add", "germany-9", "203.0.113.10", "--region", "de-germany", "--dest", "www.example.org:443"],
  retire: ["retire", "germany-3"],
  replace: ["replace", "germany-3", "203.0.113.10"],
};

// Each checklist is run once (a dry run of `replace` takes a minute or
// two on Windows); every test that reads its output shares that run.
const started = new Map();
const dryRun = (name) => {
  if (!started.has(name)) started.set(name, fleet(RUNS[name]));
  return started.get(name);
};
// One step of a dry run: from its "[n/m] id" line to the next one.
const stepBlock = (out, id) => {
  const blocks = out.split(/^(?=\[\s*\d+\/\d+\] )/m);
  const block = blocks.find((b) => new RegExp("^\\[\\s*\\d+/\\d+\\] " + id.replace(/\./g, "\\.") + "  ").test(b));
  assert.ok(block, `no step ${id} in the output`);
  return block;
};
const inOrder = (text, first, second) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second, a < 0 ? 0 : a);
  assert.ok(a >= 0, `'${first}' is not in the step`);
  assert.ok(b >= 0, `'${second}' does not come after '${first}' in the step`);
};

describe("fleet --dry-run", { concurrency: true, timeout: 900_000 }, () => {
  for (const name of Object.keys(RUNS)) {
    it(`${name}: the full ordered checklist, and nothing touched`, async () => {
      const { code, out } = await dryRun(name);
      assert.equal(code, 0, out.slice(-2000));

      assert.deepEqual(stepIds(out), EXPECTED[name], "the checklist changed: a step is missing, new, or moved");

      const blocks = out.split(/^\[\s*\d+\/\d+\] /m).slice(1);
      assert.equal(blocks.length, EXPECTED[name].length);
      for (const b of blocks) assert.match(b, /VERIFY:/, "a step without a verify: " + b.split("\n")[0]);

      assert.ok(!existsSync(marker), "a dry run reached out: " + (existsSync(marker) ? readFileSync(marker, "utf8") : ""));

      for (const leak of ["203.0.113.", "198.51.100.", "example.org", "example.net", "example.info", "@example.com"]) {
        assert.ok(!out.includes(leak), `unmasked '${leak}' in the output`);
      }
      assert.doesNotMatch(out, /unbound variable|command not found|syntax error|bad variable/);
    });
  }

  it("a relay route is made or deleted only after the relay box's agent was asked for", async () => {
    const retire = stepBlock((await dryRun("retire")).out, "retire.relay-routes");
    inOrder(retire, "node-row name=relay-1", "nx-api.sh route-delete");
    inOrder(retire, "relay.sh control-name", "nx-api.sh route-delete");
    const add = stepBlock((await dryRun("add")).out, "add.relay-routes");
    inOrder(add, "node-row name=relay-1", "nx-relay-add.sh");
    inOrder(add, "relay.sh control-name", "nx-relay-add.sh");
  });

  it("the hop server's own side is checked wherever its table is loaded, and the other exits are dialled again", async () => {
    const add = stepBlock((await dryRun("add")).out, "add.hop");
    inOrder(add, "hop-server.sh apply", "hop-server.sh check - has <new>");
    inOrder(add, "hop-server.sh check - has <new>", "relay.sh hop-add");
    assert.match(add.split("VERIFY:")[1], /hop-server\.sh check - has <new>/);
    assert.match(add.split("VERIFY:")[1], /after the hop table was reloaded/);
    const retire = stepBlock((await dryRun("retire")).out, "retire.hop");
    assert.match(retire.split("VERIFY:")[1], /hop-server\.sh check - lacks /);
    assert.match(retire.split("VERIFY:")[1], /after the hop table was reloaded/);
    const move = stepBlock((await dryRun("replace")).out, "move.hop");
    inOrder(move, "hop-server.sh apply", "hop-server.sh check");
    inOrder(move, "hop-server.sh check", "relay.sh hop-set");
    assert.match(move.split("VERIFY:")[1], /hop-server\.sh check/);
    assert.match(move.split("VERIFY:")[1], /nftables\.conf/, "the verify reads the relay's file, not only its live rules");
    assert.match(move.split("VERIFY:")[1], /through the moved hop/);
  });

  it("temporary test users are counted before they go in and after they come out, on the server and on the relay", async () => {
    const { out } = await dryRun("add");
    inOrder(stepBlock(out, "add.e2e-direct"), "inboundusercount", "xray api adu");
    const off = stepBlock(out, "add.temp-off");
    inOrder(off, "xray api rmu", "inboundusercount");
    inOrder(off, "inboundusercount", "nx-e2e-temp.sh shred");
    const relay = stepBlock(out, "add.e2e-relay");
    inOrder(relay, "relay.sh usercount", "relay.sh adu");
    inOrder(relay, "relay.sh adu", "relay.sh rmu");
    inOrder(relay, "relay.sh rmu", "relay.sh usercount");
    inOrder(relay, "relay.sh rmu", "nx-e2e-temp.sh shred");
    assert.match(relay.split("VERIFY:")[1], /relay\.sh usercount/);
  });

  it("nothing in a checklist switches off the guard against restarting an engine under customers", async () => {
    for (const name of ["add", "replace"]) {
      const { out } = await dryRun(name);
      assert.doesNotMatch(out, /\$ (\S+=\S+ )*NX_ALLOW_RESTART=1 \//, `${name} passes NX_ALLOW_RESTART to a script on a host`);
    }
    for (const f of ["checklist-add.sh", "checklist-replace.sh", "checklist-retire.sh", "remote.sh"]) {
      const code = readFileSync(join(HERE, "..", "lib", f), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
      assert.doesNotMatch(code, /RENV="[^"]*NX_ALLOW_RESTART/, `${f} sets NX_ALLOW_RESTART for a script on a host`);
    }
    const add = (await dryRun("add")).out;
    inOrder(stepBlock(add, "add.postfix"), "provision name=", "postinstall.sh fix");
    inOrder(stepBlock(add, "add.parity"), "provision name=", "parity.sh apply");
  });

  it("the maintenance audit runs block-private-egress dry, like the other three", async () => {
    const audit = stepBlock((await dryRun("add")).out, "add.maintenance-audit");
    for (const script of ["isolate-tunnel-clients.sh", "xray-ipv4-only.sh", "no-self-loop.sh", "block-private-egress.sh"]) {
      assert.ok(audit.includes(script), `${script} is not run by the audit`);
    }
    assert.doesNotMatch(audit, /--apply/, "a maintenance script is given --apply");
  });

  it("the step list `fleet steps` prints is the one that runs", async () => {
    for (const name of Object.keys(RUNS)) {
      const listed = await new Promise((resolve) =>
        execFile(BASH, [FLEET, "steps", name], (e, stdout) => resolve(stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]))),
      );
      assert.deepEqual(listed, EXPECTED[name]);
    }
  });
});

describe("fleet dns", { timeout: 120_000 }, () => {
  it("--dry-run asks Cloudflare nothing, and --delete reaches the sweep", async () => {
    const { code, out } = await fleet(["dns", "sweep", "203.0.113.77", "-", "example.org", "--delete"]);
    assert.equal(code, 0, out);
    assert.match(out, /^cloudflare sweep <ip> - \{zone\} --delete$/m, "what would be asked, masked");
    assert.doesNotMatch(out, /refused|ENOENT|203\.0\.113\./, "the helper ran: the fixture's token file does not exist");
    assert.ok(!existsSync(marker));
    const create = await fleet(["dns", "create-a", "example.org", "abc123.example.org", "203.0.113.77"]);
    assert.equal(create.code, 0, create.out);
    assert.match(create.out, /^cloudflare create-a \{zone\} \{name-in-zone\} <ip>$/m);
  });

  it("--delete belongs to dns only", async () => {
    const { code, out } = await fleet(["retire", "germany-3", "--delete"]);
    assert.equal(code, 2);
    assert.match(out, /unknown option --delete/);
  });

  it("the undo line add.dns prints is a command the tool accepts", () => {
    const add = readFileSync(join(HERE, "..", "lib", "checklist-add.sh"), "utf8");
    const undo = /undo "fleet dns sweep <the new address> (\S+) \$NODE_DNS_ZONE --delete/.exec(add);
    assert.ok(undo, "add.dns has no undo line of the expected shape");
    assert.equal(undo[1], "-", "no names file: /dev/null is not a path on the operator's PC");
  });
});

describe("the checklist's own rules", () => {
  const all = Object.values(EXPECTED).flat();

  it("replace is precheck, add and retire, with the hop moved before the old server goes", () => {
    const r = EXPECTED.replace;
    for (const id of EXPECTED.add) assert.ok(r.includes(id), `replace lost the add step ${id}`);
    for (const id of EXPECTED.retire.filter((x) => x !== "retire.params")) assert.ok(r.includes(id), `replace lost the retire step ${id}`);
    assert.ok(r.indexOf("pre.verdict") < r.indexOf("add.install"), "the bare-box verdict comes before the build");
    assert.ok(r.indexOf("move.hop") < r.indexOf("retire.guard-hop"), "the hop moves before the old server is checked for it");
    assert.ok(r.indexOf("add.e2e-direct") < r.indexOf("add.plans"), "tunnels are proven before customers get the server");
    assert.ok(r.indexOf("add.plans") < r.indexOf("retire.plans"));
  });

  it("an old server that is already gone loses its names before anything is built", () => {
    const r = EXPECTED.replace;
    assert.deepEqual(r.slice(0, 3), ["replace.params", "retire.reach", "retire.dns-now"]);
    assert.ok(r.indexOf("retire.dns-now") < r.indexOf("pre.sink"), "before the bare-box test, which is before the build");
    assert.equal(r.filter((id) => id === "retire.reach" || id === "retire.dns-now").length, 2, "and each is there once");
    const t = EXPECTED.retire;
    assert.ok(t.indexOf("retire.reach") < t.indexOf("retire.dns-now"));
    assert.ok(t.indexOf("retire.dns-now") < t.indexOf("retire.guard-hop"), "a refusal by a guard must not leave a gone server's names standing");
  });

  it("add proves before it gives: reboot, inside probe and tunnels all come before the plans", () => {
    const a = EXPECTED.add;
    for (const id of ["pre.verdict", "add.reboot", "add.inside-probe", "add.e2e-direct", "add.e2e-relay"]) {
      assert.ok(a.indexOf(id) >= 0 && a.indexOf(id) < a.indexOf("add.plans"), `${id} must come before add.plans`);
    }
    assert.ok(a.indexOf("add.dump-node") < a.indexOf("add.install"), "a database dump comes before the server is created");
    assert.ok(a.indexOf("add.token") + 1 === a.indexOf("add.install"), "the installer starts right after the 15-minute token");
  });

  it("retire takes customers off first and deletes the VPS last", () => {
    const r = EXPECTED.retire;
    const order = ["retire.guard-hop", "retire.dump", "retire.plans", "retire.relay-routes", "retire.incident",
      "retire.agent-stop", "retire.offline", "retire.disable", "retire.keys", "retire.dns", "retire.hop",
      "retire.alerts", "retire.leftovers", "retire.delete-vps"];
    for (let i = 1; i < order.length; i++) {
      assert.ok(r.indexOf(order[i - 1]) >= 0 && r.indexOf(order[i - 1]) < r.indexOf(order[i]), `${order[i - 1]} must come before ${order[i]}`);
    }
    assert.equal(r.at(-1), "retire.delete-vps");
  });

  it("no checklist has a step that deletes a server row", () => {
    assert.ok(!all.some((id) => /delete-node|node-delete/.test(id)));
    for (const f of ["nx-api.sh", "nx-plan-edit.sh", "nx-relay-add.sh"]) {
      const text = readFileSync(join(HERE, "..", "remote", "panel", f), "utf8");
      assert.doesNotMatch(text, /-X DELETE[^\n]*\/nodes\//, `${f} can delete a server`);
    }
  });

  it("nothing that runs on the relay box restarts Xray, loads its nftables file, or touches sshd", () => {
    const relay = readFileSync(join(HERE, "..", "remote", "relay", "relay.sh"), "utf8")
      + readFileSync(join(HERE, "..", "remote", "inside", "inside.sh"), "utf8");
    const code = relay.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /systemctl\s+(re)?start\s+xray|systemctl\s+reload\s+xray|neoxify-xray-restart/);
    assert.doesNotMatch(code, /nft\s+(-[a-z]+\s+)*-f\s+(?!")\S/, "nft -f without -c");
    assert.doesNotMatch(code, /flush ruleset|sshd_config|systemctl\s+\S+\s+ssh/);
    assert.match(code, /nft -c -f "\$NEW"/, "the file is checked, never loaded");
  });
});
