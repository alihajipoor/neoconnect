import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUNDLE_KEYS, SERVER_KEY_STATEMENT_KIND } from "./endpoint-bundle";

/** src-tauri/src/bundle_scope.rs checks a bundle's signature itself before
 * it widens the HTTP scope, with its own copy of the compiled-in keys. A
 * key rotated here and not there would leave every new list verified in
 * the webview and refused in Rust -- adopted, and its hosts unreachable. */
describe("the scope command's keys", () => {
  const rust = readFileSync("src-tauri/src/bundle_scope.rs", "utf8");

  it("are the bundle's compiled-in keys, by the same ids", () => {
    const block = /const BUNDLE_KEYS: \[\(&str, &str\); \d+\] = \[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const pairs = [...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(([, id, key]) => [id, key]);
    expect(Object.fromEntries(pairs)).toEqual(BUNDLE_KEYS);
  });

  it("name the server-key statement the way the webview does", () => {
    expect(rust).toContain(`const STATEMENT_KIND: &str = "${SERVER_KEY_STATEMENT_KIND}";`);
  });
});
