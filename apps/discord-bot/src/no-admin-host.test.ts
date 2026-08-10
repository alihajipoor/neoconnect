import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The operator panel's hostname must never reach a member-facing surface.
 *
 * `connect.neoxify.com` serves apps/panel -- the admin dashboard, with
 * customers, invoices, nodes and settings on it. There is no customer portal
 * there. An earlier version of this bot carried it as `panelUrl` and printed
 * it into a public Discord channel labelled "Your account".
 *
 * This scans the source rather than any one embed, because the mistake was
 * not in a single string: it was the value being available to every file
 * that wanted a URL. Anything that reintroduces it fails here.
 */
// Tests execute from dist-test/, so reach back to the actual sources rather
// than scanning the compiled copy of them.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ADMIN_HOST = "connect.neoxify.com";

/** config.ts documents why the host is absent, so it is allowed to name it. */
const ALLOWED = new Set(["config.ts", "no-admin-host.test.ts"]);

function sourceFiles(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith(".ts") && !ALLOWED.has(f));
}

describe("the operator panel host", () => {
  it("appears in no bot source file", () => {
    const offenders = sourceFiles().filter((f) =>
      readFileSync(join(SRC, f), "utf8").includes(ADMIN_HOST),
    );
    assert.deepEqual(offenders, [], `${ADMIN_HOST} must not appear in: ${offenders.join(", ")}`);
  });

  /** Removing the field is what makes the rule hold by construction: a value
   *  the process never loads cannot be pasted into an embed later. */
  it("is not a configurable value at all", () => {
    const config = readFileSync(join(SRC, "config.ts"), "utf8");
    assert.doesNotMatch(config, /panelUrl\s*[:?]/, "BotConfig still has a panelUrl field");
    assert.doesNotMatch(config, /NEOXIFY_PANEL_URL/, "the panel URL is still read from the environment");
  });
});
