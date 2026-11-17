/**
 * The waits that were made to ask more often (2026-11-17) must still wait
 * as long as they did: same condition, same ceiling, only more questions.
 * A shorter ceiling would quietly turn a slow pass into a failure, or a
 * slow failure into a pass that was never waited for.
 *
 * Each case reads the function's own text: the tries and the sleep
 * between them, multiplied, against the ceiling it had before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const src = ["checklist-add.sh", "remote.sh"].map((f) => readFileSync(join(LIB, f), "utf8")).join("\n");
const body = (fn) => {
  const m = new RegExp(`^${fn}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(src);
  assert.ok(m, `${fn} not found`);
  return m[1];
};
const ceiling = (fn) => {
  const b = body(fn);
  const tries = /for try in \$\(seq 1 (\d+)\)/.exec(b);
  const sleep = /\n\s*sleep (\d+)\n/.exec(b);
  assert.ok(tries && sleep, `${fn}: no poll loop found`);
  return Number(tries[1]) * Number(sleep[1]);
};

describe("polls ask more often, and wait no less", () => {
  // [function, seconds of waiting before the change: tries x sleep]
  for (const [fn, before] of [
    ["ok_add_dns", 6 * 10],
    ["ok_add_relay_routes", 6 * 20],
    ["ok_add_canary_provision", 12 * 10],
    ["ok_add_provision", 8 * 15],
    ["heartbeats_fresh", 8 * 15],
  ]) {
    it(`${fn}: at least ${before} s`, () => assert.ok(ceiling(fn) >= before, `${fn} waits ${ceiling(fn)} s`));
  }
  it("do_add_install: fifteen minutes, over either transport", () => {
    assert.match(body("do_add_install"), /for _ in \$\(seq 1 \$\(\(900 \/ every\)\)\); do\n\s*sleep "\$every"/);
  });
  it("do_add_reboot: five minutes twenty for the new boot, as the 20 s sleep and 30 tries 10 s apart; its own three for the heartbeat", () => {
    const b = body("do_add_reboot");
    assert.match(b, /for i in \$\(seq 1 107\); do\n\s*sleep 3\n/);
    assert.match(b, /\(\(SECONDS - t0 > 320\)\) && break/);
    assert.match(b, /for tries in \$\(seq 1 60\)/);
    assert.match(b, /\(\(SECONDS - t0 > 180\)\) && break/);
    assert.doesNotMatch(b, /sleep 20/, "no fixed settle left: the new conditions replace it");
  });
});
