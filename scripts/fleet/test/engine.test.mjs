/**
 * The checklist engine (lib/engine.sh), run for real on a toy checklist
 * with no host behind it (engine-harness.sh).
 *
 * This is the part of the tool's promise that can be proven without a
 * server: a failed verify stops the run, the same command resumes at
 * that step without repeating what passed, the owner's steps wait, and
 * every change leaves an undo line.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "engine-harness.sh");
const BASH = process.env.FLEET_BASH || "bash";

let home;
const run = (env = {}) => {
  const r = spawnSync(BASH, [HARNESS], { encoding: "utf8", env: { ...process.env, FLEET_HOME: home, FLEET_NO_TTY: "1", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const runDirs = () => readdirSync(join(home, "runs")).sort();
const file = (name) => readFileSync(join(home, "runs", runDirs().at(-1), name), "utf8");

describe("the checklist engine", () => {
  before(() => { home = mkdtempSync(join(tmpdir(), "fleet-engine-")); });
  after(() => rmSync(home, { recursive: true, force: true }));

  it("stops at a failed verify, and nothing after it runs", () => {
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /\[1\/4\] t\.one/);
    assert.match(r.out, /\[2\/4\] t\.two/);
    assert.match(r.out, /VERIFY FAILED/);
    assert.match(r.out, /Stopped at t\.two\. Nothing after it ran\./);
    assert.doesNotMatch(r.out, /t\.owner|three ran/);
    assert.equal(file("done").trim(), "t.one", "only the step that verified is marked done");
  });

  it("masks every address and every name of ours in what it prints and logs", () => {
    const log = file("run.log");
    assert.match(log, /one ran against <panel> for \{name-in-zone\} and <ip>/);
    for (const leak of ["203.0.113.5", "198.51.100.77", "example.org"]) assert.ok(!log.includes(leak), leak);
  });

  it("writes an undo line beside the change, in the run log", () => {
    assert.match(file("run.log"), /UNDO t\.one: take one back/);
  });

  it("resumes at the failed step without repeating what passed, then waits for the owner", () => {
    writeFileSync(join(home, "allow-two"), "");
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /Resuming run/);
    assert.match(r.out, /\[1\/4\] t\.one[^\n]*\n\s+done in an earlier pass/);
    assert.match(r.out, /two ran/);
    assert.match(r.out, /OWNER: do the thing/);
    assert.match(r.out, /--done t\.owner/);
    assert.doesNotMatch(r.out, /three ran/);
    assert.match(file("state"), /^one=1$/m, "the first step ran once, not twice");
    assert.equal(runDirs().length, 1, "the same run directory");
  });

  it("--done does not take the owner's word for it: the verify still has to pass", () => {
    const r = run({ T_DONE: "t.owner" });
    assert.equal(r.code, 1);
    assert.match(r.out, /the owner reports this done/);
    assert.match(r.out, /VERIFY FAILED/);
    assert.doesNotMatch(r.out, /three ran/);
  });

  it("finishes once the owner's step verifies, with state carried across runs", () => {
    writeFileSync(join(home, "owner-did-it"), "");
    const r = run({ T_DONE: "t.owner" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /three ran with one=1/);
    assert.match(r.out, /CHECKLIST-COMPLETE/);
    assert.equal(file("done").trim().split("\n").join(","), "t.one,t.two,t.owner,t.three");
    assert.ok(readdirSync(join(home, "runs", runDirs()[0])).includes("finished"));
  });

  it("a finished run is not reopened: the next one starts fresh", () => {
    const r = run();
    assert.match(r.out, /New run/);
    assert.equal(runDirs().length, 2);
    assert.match(file("state"), /^one=1$/m);
  });

  it("--only runs one step again, even when it is done", () => {
    const r = run({ T_ONLY: "t.one" });
    assert.equal(r.code, 0, r.out);
    assert.match(file("state"), /^one=2$/m);
    assert.doesNotMatch(r.out, /two ran/);
  });

  // In this run t.one and t.two passed and t.owner never did.
  it("--from is not a way past a step that never passed", () => {
    const r = run({ T_FROM: "t.three" });
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED: --from t\.three would skip steps that have not passed/);
    assert.match(r.out, /^\s+t\.owner$/m, "it names the step that never passed");
    assert.doesNotMatch(r.out, /^\s+t\.(one|two)$/m, "and only that one");
    assert.doesNotMatch(r.out, /three ran|CHECKLIST-COMPLETE/);
    assert.match(file("run.log"), /REFUSED --from t\.three \(unproven before it: t\.owner/);
  });

  it("--only does not run the customers' step on unproven work either", () => {
    const r = run({ T_ONLY: "t.three" });
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED: t\.three is where customers get the server/);
    assert.match(r.out, /^\s+t\.owner$/m);
    assert.doesNotMatch(r.out, /three ran/);
  });

  it("--from starts at that step once everything before it passed", () => {
    const two = run({ T_FROM: "t.two" });
    assert.match(two.out, /two ran/);
    assert.doesNotMatch(two.out, /one ran/);
    assert.match(file("state"), /^one=2$/m, "the step before --from was not run again");
  });

  it("--waive is the owner's way past, and it is on the record", () => {
    const r = run({ T_FROM: "t.three", T_WAIVE: "t.owner" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /three ran/);
    assert.match(file("run.log"), /WAIVED t\.owner The owner's \(--waive: the owner's decision to go on without it\)/);
    assert.match(r.out, /Checklist complete, EXCEPT these steps, which were waived and never passed: t\.owner/);
    assert.match(r.out, /UNVERIFIED/);
    assert.match(file("run.log"), /COMPLETE EXCEPT waived: t\.owner/);
    assert.ok(readdirSync(join(home, "runs", runDirs().at(-1))).includes("finished"));
    assert.doesNotMatch(file("done"), /t\.owner/, "a waived step is never marked as passed");
  });

  it("refuses a step that does not exist, for --from and for --waive", () => {
    const bad = run({ T_FROM: "t.nope" });
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /no step 't\.nope'/);
    const waive = run({ T_WAIVE: "t.nope" });
    assert.notEqual(waive.code, 0);
    assert.match(waive.out, /--waive: no step 't\.nope'/);
  });
});

describe("a waived step", () => {
  let own;
  const go = (env = {}) => {
    const r = spawnSync(BASH, [HARNESS], { encoding: "utf8", env: { ...process.env, FLEET_HOME: own, FLEET_NO_TTY: "1", ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const dir = () => join(own, "runs", readdirSync(join(own, "runs")).sort().at(-1));
  before(() => { own = mkdtempSync(join(tmpdir(), "fleet-waive-")); });
  after(() => rmSync(own, { recursive: true, force: true }));

  it("is passed over on the next pass, without being run and without being named again", () => {
    assert.equal(go().code, 1, "t.two fails its verify");
    const r = go({ T_WAIVE: "t.two" });
    assert.match(r.out, /Waived on the owner's say-so, and written to the run log: t\.two/);
    assert.match(r.out, /\[2\/4\] t\.two[^\n]*\n\s+WAIVED \(--waive, in the run log\): not run, not proven/);
    assert.doesNotMatch(r.out, /two ran/);
    assert.match(r.out, /OWNER: do the thing/, "the run goes on to the next step");

    // The waiver is in the run directory: the next pass does not need the flag.
    writeFileSync(join(own, "owner-did-it"), "");
    const end = go({ T_DONE: "t.owner" });
    assert.equal(end.code, 0, end.out);
    assert.doesNotMatch(end.out, /two ran/);
    assert.match(end.out, /three ran/, "the customers' step runs: what is before it passed or was waived");
    assert.match(end.out, /complete, EXCEPT these steps, which were waived and never passed: t\.two/);
    assert.equal(readFileSync(join(dir(), "done"), "utf8").trim().split("\n").join(","), "t.one,t.owner,t.three");
    assert.equal(readFileSync(join(dir(), "waived"), "utf8").trim(), "t.two");
  });
});
