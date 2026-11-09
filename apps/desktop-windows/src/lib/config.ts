import seedEnvelope from "./seed-bundle.json";

/** Where the control plane lives, best first.
 *
 * A list rather than one address, because one address was a single point
 * of failure for the entire product and it failed: connect.neoxify.com's
 * IP was filtered in Iran and every customer there lost sign-in,
 * purchase, support and updates at once, on nodes that were not blocked.
 *
 * Named separately from the dev override below so the capability-scope
 * test can assert against the list that actually ships. Reading
 * API_BASE_URLS there would check localhost -- vitest sets DEV -- and
 * pass while the production URLs went unchecked, which is the same shape
 * as the hole that let an unpermitted endpoint reach customers.
 */
/** The addresses baked in at build time, from the published bundle.
 *
 * The literals below sit on a domain that is DNS-poisoned and SNI-blocked
 * in Iran -- unreachable by exactly the customers a last-resort list
 * exists for. They stay as the floor for a build made without network;
 * the release workflows set NEOXIFY_REQUIRE_SEED so a shipped build never
 * takes that path, and the seed's own panel entries go in front of them.
 *
 * Derived rather than committed, for the reason in
 * docs/node-address-hygiene.md: the replacement names are worth something
 * only while nobody holds a list of them, and a public repo is a list.
 */
function seedPanelBases(): string[] {
  try {
    const payload = (seedEnvelope as { payload?: unknown }).payload;
    if (typeof payload !== "string" || payload === "") return [];
    // atob only. This file is typechecked by the mobile app too, which
    // has no node types, and every context it runs in -- both webviews
    // and the test runner -- provides atob.
    const raw = atob(payload);
    const endpoints = (JSON.parse(raw) as { endpoints?: unknown }).endpoints;
    if (!Array.isArray(endpoints)) return [];
    return endpoints
      .filter(
        (e): e is { kind: string; url: string } =>
          typeof e === "object" &&
          e !== null &&
          (e as { kind?: unknown }).kind === "panel" &&
          typeof (e as { url?: unknown }).url === "string",
      )
      .map((e) => e.url);
  } catch {
    // A malformed seed must never stop the app starting; the literals
    // below still work everywhere the block does not reach.
    return [];
  }
}

const LEGACY_API_BASE_URLS: readonly string[] = [

  // A separate domain on a CDN, deliberately sharing nothing with the
  // marketing site: a block aimed at one cannot take the other with it,
  // which is the entire reason it is a second domain rather than a
  // second subdomain. Measured from Iran: seven of seven probes reach
  // this, including two that cannot reach the origin below.
  "https://connect.neoxify.site/api",

  // The .com origin used to sit here, as a direct path that skipped the
  // CDN. It has been removed deliberately: the whole point of the second
  // domain is that losing one registrable name cannot take the product
  // down, and a fallback on a domain we might not keep is a dependency
  // wearing the costume of a safety net.

  // Two node mirrors followed here, on fi1 and fr1 under .site, for the
  // first install that has no cached credentials to derive mirrors from.
  // Both servers are gone (2026-11-06), so the names were dead addresses
  // to time out on. A first install now gets its node mirrors from the
  // signed bundle it ships with (the same seed, read by
  // endpoint-bundle-store.ts), and a returning customer also from mirrors
  // derived from cached credentials at runtime.
];

/** Dev talks to the local backend port; a real build talks to the public
 * /api path nginx proxies to it (see
 * installer/assets/nginx-panel.conf.template). */
const SEED_PANEL_BASES = seedPanelBases();

export const PRODUCTION_API_BASE_URLS: readonly string[] = [
  ...SEED_PANEL_BASES,
  ...LEGACY_API_BASE_URLS.filter((u) => !SEED_PANEL_BASES.includes(u)),
];

export const API_BASE_URLS: readonly string[] = import.meta.env.DEV
  ? ["http://localhost:4000"]
  : PRODUCTION_API_BASE_URLS;


/** The first choice, for the few places that need a single address
 * rather than the ordered list. */
export const API_BASE_URL = API_BASE_URLS[0];
