import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCTION_API_BASE_URLS } from "./config";

/** Every endpoint the app will try must be one Tauri lets it call.
 *
 * This exists because the gap between those two lists shipped. The CDN
 * domain was added as the *first* endpoint in config.ts and never added
 * to the HTTP capability, so the plugin refused every request to it
 * before it left the machine. The app fell through to the origin --
 * blocked, for exactly the people the CDN domain was added for -- and a
 * new customer, who has no cached node mirrors yet, could not register
 * at all. Reported from Iran within an hour of the release.
 *
 * Nothing in the type system connects a URL in config.ts to a glob in a
 * JSON capability file, so the connection has to be asserted.
 */
describe("API endpoints are within the HTTP capability scope", () => {
  type Entry = { url: string };
  type Permission = string | { identifier: string; allow?: Entry[] };

  const capability = JSON.parse(
    readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  ) as { permissions: Permission[] };

  const allowed = capability.permissions
    .filter((p): p is Exclude<Permission, string> => typeof p !== "string")
    .find((p) => p.identifier === "http:default")?.allow;

  /** Tauri's URL globs, close enough for this check.
   *
   * The two halves behave differently and the difference is the whole
   * point. In the authority, `*` must not cross a label boundary, or
   * `*.neoxify.com` would quietly cover somebody else's domain. In the
   * path it spans everything, which is how `https://*.neoxify.com/*`
   * reaches `/api/customer/me` in the live app today.
   */
  function matches(pattern: string, url: string): boolean {
    const escape = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
    const split = (value: string): [string, string] => {
      const at = value.indexOf("/", value.indexOf("://") + 3);
      return at === -1 ? [value, ""] : [value.slice(0, at), value.slice(at)];
    };

    const [patternHost, patternPath] = split(pattern);
    const source =
      "^" +
      patternHost.split("*").map(escape).join("[^/.]*") +
      patternPath.split("*").map(escape).join(".*") +
      "$";
    return new RegExp(source).test(url);
  }

  it("declares an http:default allow list at all", () => {
    expect(allowed, "no http:default permission -- every request would be denied").toBeTruthy();
  });

  it.each([...PRODUCTION_API_BASE_URLS])("permits %s", (base) => {
    const probe = base + "/customer/me";
    expect(
      (allowed ?? []).some((entry) => matches(entry.url, probe)),
      probe + " is not covered by any entry in capabilities/default.json",
    ).toBe(true);
  });

  /** The glob must not be so loose that it would permit somebody else's
   * domain -- a wildcard matching anything would make this test pass
   * while removing the protection it is checking for. */
  it("does not permit an unrelated host", () => {
    const probe = "https://example.com/customer/me";
    expect((allowed ?? []).some((entry) => matches(entry.url, probe))).toBe(false);
  });
});
