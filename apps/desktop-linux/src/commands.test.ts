import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every command the shared interface invokes is registered by this app.
 *
 * A command Tauri does not know fails only when it is called, inside
 * whichever screen calls it first, so a build and a type check both pass
 * over the gap. This reads the interface's `invoke("...")` calls and the
 * Rust handler list and compares them, so the gap shows here instead. */

const here = fileURLToPath(new URL(".", import.meta.url));
const sharedSrc = join(here, "..", "..", "desktop-windows", "src");
const libRs = join(here, "..", "src-tauri", "src", "lib.rs");

/** Commands only the phone app registers. The shared library calls them
 * behind its own platform checks; no desktop registers them. */
const PHONE_ONLY = new Set([
  "vpn_iap_finish",
  "vpn_iap_products",
  "vpn_iap_purchase",
  "vpn_iap_unfinished",
  "vpn_open_auth_session",
  "vpn_sign_in_with_apple",
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // The dev preview fakes `invoke` for screenshots; it is not the app.
      if (name !== "preview" && name !== "node_modules") out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function invokedCommands(): Set<string> {
  const found = new Set<string>();
  const pattern = /invoke(?:<[^(]*>)?\(\s*["']([a-z_0-9]+)["']/g;
  // Dashboard picks between two names with a ternary; both are invoked.
  const ternary = /invoke\(\s*[a-zA-Z_]+\s*\?\s*["']([a-z_0-9]+)["']\s*:\s*["']([a-z_0-9]+)["']/g;
  for (const file of sources(sharedSrc)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) found.add(m[1]);
    for (const m of text.matchAll(ternary)) {
      found.add(m[1]);
      found.add(m[2]);
    }
  }
  return found;
}

function registeredCommands(): Set<string> {
  const text = readFileSync(libRs, "utf8");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(text);
  if (!block) throw new Error("no generate_handler! in lib.rs");
  const names = new Set<string>();
  for (const line of block[1].split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    // `vpn::vpn_status` registers `vpn_status`: the last segment is the name.
    for (const m of code.matchAll(/(?:[a-z_0-9]+::)*([a-z_0-9]+)/g)) names.add(m[1]);
  }
  return names;
}

describe("the Linux app's command list", () => {
  it("finds the interface's commands at all", () => {
    // A pattern that stopped matching would pass the next test vacuously.
    expect(invokedCommands().size).toBeGreaterThan(30);
  });

  it("registers every command the shared interface invokes", () => {
    const registered = registeredCommands();
    const missing = [...invokedCommands()].filter((c) => !PHONE_ONLY.has(c) && !registered.has(c)).sort();
    expect(missing).toEqual([]);
  });
});
