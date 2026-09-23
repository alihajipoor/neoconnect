import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCTION_API_BASE_URLS } from "./config";
import { describeEndpoint, httpAllowList, matchesCapabilityGlob } from "./capability-glob";

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
  const capability = JSON.parse(
    readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  );
  const allowed = httpAllowList(capability);

  it("declares an http:default allow list at all", () => {
    expect(allowed, "no http:default permission -- every request would be denied").toBeTruthy();
  });

  /** By index, never by address. A case title and a failure message both
   * reach a public CI log -- see describeEndpoint. */
  it.each([...PRODUCTION_API_BASE_URLS].map((base, i) => [describeEndpoint(base, i), base]))(
    "permits compiled-in %s",
    (label, base) => {
      const probe = base + "/customer/me";
      expect(
        (allowed ?? []).some((entry) => matchesCapabilityGlob(entry.url, probe)),
        label + " is not covered by any entry in capabilities/default.json",
      ).toBe(true);
    },
  );

  /** The glob must not be so loose that it would permit somebody else's
   * domain -- a wildcard matching anything would make this test pass
   * while removing the protection it is checking for. */
  it("does not permit an unrelated host", () => {
    const probe = "https://example.com/customer/me";
    expect((allowed ?? []).some((entry) => matchesCapabilityGlob(entry.url, probe))).toBe(false);
  });

  /** The compiled-in list is no longer the list that matters.
   *
   * The check above was written after a CDN domain shipped in config.ts
   * without a matching capability glob. It then failed to catch the same
   * fault a second time, because by then the addresses customers
   * actually use arrive in the signed bundle, and the bundle's endpoints
   * are not in PRODUCTION_API_BASE_URLS for it to look at. Every one of
   * them was refused locally, the app fell back to a domain blocked in
   * Iran, and a new customer there could not register -- the identical
   * symptom, from the identical gap, with a test in place looking
   * elsewhere.
   */
  it("permits every endpoint the shipped bundle carries", () => {
    const seed = JSON.parse(
      readFileSync(new URL("./seed-bundle.json", import.meta.url), "utf8"),
    ) as { payload?: string };
    // A placeholder seed ships no endpoints, so there is nothing to permit.
    if (!seed.payload) return;
    const bundle = JSON.parse(Buffer.from(seed.payload, "base64").toString("utf8")) as {
      endpoints: { url: string }[];
    };
    expect(bundle.endpoints.length).toBeGreaterThan(0);
    bundle.endpoints.forEach((endpoint, index) => {
      const probe = endpoint.url + "/customer/me";
      expect(
        (allowed ?? []).some((entry) => matchesCapabilityGlob(entry.url, probe)),
        describeEndpoint(endpoint.url, index) +
          " is not covered by any entry in capabilities/default.json",
      ).toBe(true);
    });
  });
});
