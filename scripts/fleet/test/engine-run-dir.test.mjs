/**
 * A new run never gets a directory that is already there.
 *
 * A run's directory is named to the second. A run started in the same
 * second as one that had just finished was handed that run's directory,
 * with every step in it marked done: the new run "completed" without
 * doing anything. By hand that takes luck. In CI it took none: the
 * engine's own tests run their passes a tenth of a second apart, and
 * failed on main the first time five of them fell inside one second.
 *
 * Here the clock is a stand-in that always says the same second, so the
 * case is met every time and not one time in three.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "engine-harness.sh");
const BASH = process.env.FLEET_BASH || "bash";

let home;
let bin;
const run = (env = {}) => {
  const r = spawnSync(BASH, [HARNESS], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, FLEET_HOME: home, FLEET_NO_TTY: "1", ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};
const runDirs = () => readdirSync(join(home, "runs")).sort();

describe("two runs started in the same second", () => {
  before(() => {
    home = mkdtempSync(join(tmpdir(), "fleet-rundir-"));
    bin = mkdtempSync(join(tmpdir(), "fleet-rundir-bin-"));
    // Only the stamp a run directory is named with stands still; every
    // other question goes to the real clock.
    writeFileSync(join(bin, "date"), '#!/bin/sh\ncase "$*" in\n  *%Y%m%dT%H%M%SZ*) echo 20260101T000000Z ;;\n  *) exec /usr/bin/date "$@" ;;\nesac\n');
    chmodSync(join(bin, "date"), 0o755);
    writeFileSync(join(home, "allow-two"), "");
    writeFileSync(join(home, "owner-did-it"), "");
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it("the first run finishes in its own directory", () => {
    assert.equal(run().code, 1, "it waits for the owner first");
    const r = run({ T_DONE: "t.owner" });
    assert.match(r.out, /CHECKLIST-COMPLETE/);
    assert.deepEqual(runDirs(), ["toy-subject-20260101T000000Z"]);
    assert.ok(readdirSync(join(home, "runs", runDirs()[0])).includes("finished"));
  });

  it("the next one, in that same second, gets a directory of its own and does its own work", () => {
    const r = run();
    assert.match(r.out, /New run/);
    assert.doesNotMatch(r.out, /done in an earlier pass/, "a finished run was handed to the new one");
    assert.deepEqual(runDirs(), ["toy-subject-20260101T000000Z", "toy-subject-20260101T000000Z-2"]);
    const fresh = join(home, "runs", "toy-subject-20260101T000000Z-2");
    assert.match(readFileSync(join(fresh, "state"), "utf8"), /^one=1$/m);
    assert.ok(!readdirSync(fresh).includes("finished"), "it is waiting for the owner, not finished");
  });

  it("and it is that one the same command resumes, not the finished one", () => {
    const r = run({ T_DONE: "t.owner" });
    assert.match(r.out, /Resuming run: .*toy-subject-20260101T000000Z-2/);
    assert.match(r.out, /CHECKLIST-COMPLETE/);
  });

  it("a third run in that second counts on", () => {
    assert.match(run().out, /New run/);
    assert.equal(runDirs().at(-1), "toy-subject-20260101T000000Z-3");
  });
});
