import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The seed step runs twice per release: once in the workflow with
 * NEOXIFY_REQUIRE_SEED set, then again from `pnpm build`'s prebuild hook
 * without it. A failed second fetch used to overwrite the first one's
 * seed with the placeholder, and the build shipped with none.
 *
 * Run as the real script, against a file in a temporary directory, with
 * a bundle URL that cannot be fetched -- it fails before any network. */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "ensure-seed-bundle.mjs");
const placeholder = readFileSync(join(here, "..", "src", "lib", "seed-bundle.placeholder.json"), "utf8");

/** A signed-envelope-shaped seed. RFC 2606 name; never a real endpoint. */
const seed = JSON.stringify({
  payload: Buffer.from(
    JSON.stringify({ v: 7, issuedAt: 1, endpoints: [{ kind: "panel", url: "https://connect.example.net/api" }] }),
  ).toString("base64"),
  sig: "c2ln",
});

let dir: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seed-test-"));
  out = join(dir, "seed-bundle.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.NEOXIFY_REQUIRE_SEED;
  delete base.NEOXIFY_SKIP_SEED;
  return spawnSync(process.execPath, [script], {
    env: { ...base, NEOXIFY_SEED_PATH: out, NEOXIFY_BUNDLE_URL: "not-a-url", ...env },
    encoding: "utf8",
  });
}

describe("ensure-seed-bundle when the fetch fails", () => {
  it("keeps a seed that is already on disk", () => {
    writeFileSync(out, seed);
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(seed);
    expect(result.stdout).toContain("kept existing v7, 1 endpoints");
  });

  /** The release case: the required step already fetched it. */
  it("keeps it when a seed is required, too", () => {
    writeFileSync(out, seed);
    const result = run({ NEOXIFY_REQUIRE_SEED: "1" });
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(seed);
  });

  /** A seed left by some earlier build -- the Mac that builds iOS
   * releases keeps one for weeks -- must not quietly stand in for a
   * required one. */
  it("does not let an old seed satisfy a required build", () => {
    writeFileSync(out, seed);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    utimesSync(out, weekAgo, weekAgo);
    expect(run({ NEOXIFY_REQUIRE_SEED: "1" }).status).toBe(1);
    // Without the requirement it is still better than the placeholder.
    expect(run().status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(seed);
  });

  it("still fails a required build that has no seed at all", () => {
    const result = run({ NEOXIFY_REQUIRE_SEED: "1" });
    expect(result.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  /** The placeholder is not a seed, and must not satisfy the requirement. */
  it("does not count the placeholder as a seed", () => {
    writeFileSync(out, placeholder);
    expect(run({ NEOXIFY_REQUIRE_SEED: "1" }).status).toBe(1);
  });

  /** Unchanged for a build that does not require one: no network, no
   * seed, a working app without it. */
  it("falls back to the placeholder when nothing better exists", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(placeholder);
  });
});
