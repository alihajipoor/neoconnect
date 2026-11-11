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
 *   - nothing address-like from the fixture reaches the output.
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

describe("fleet --dry-run", { concurrency: true, timeout: 600_000 }, () => {
  for (const [name, args] of Object.entries(RUNS)) {
    it(`${name}: the full ordered checklist, and nothing touched`, async () => {
      const { code, out } = await fleet(args);
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

  it("the step list `fleet steps` prints is the one that runs", async () => {
    for (const name of Object.keys(RUNS)) {
      const listed = await new Promise((resolve) =>
        execFile(BASH, [FLEET, "steps", name], (e, stdout) => resolve(stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]))),
      );
      assert.deepEqual(listed, EXPECTED[name]);
    }
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
