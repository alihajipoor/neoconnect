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
export const PRODUCTION_API_BASE_URLS: readonly string[] = [
  // A separate domain on a CDN, deliberately sharing nothing with the
  // marketing site: a block aimed at one cannot take the other with it,
  // which is the entire reason it is a second domain rather than a
  // second subdomain. Measured from Iran: seven of seven probes reach
  // this, including two that cannot reach the origin below.
  "https://connect.neoxify.site/api",

  // The origin. Still tried, because a CDN is one more party that can be
  // unavailable, and on an unfiltered network this is the shortest path.
  "https://connect.neoxify.com/api",

  // The nodes, mirroring the API on the ports their VPN inbounds already
  // listen on.
  //
  // These are also derived from cached credentials at runtime, which
  // covers a returning customer. They are listed here as well because
  // the case that actually broke is the one derivation cannot help:
  // somebody installing for the first time has no cache and therefore no
  // mirrors, so a blocked panel left them with nothing at all -- exactly
  // when they most need another way in. Registering has to work before
  // there is anything to remember.
  //
  // Different addresses from the panel, so a block on its IP does not
  // touch them. Last, because a node is a detour and the direct paths
  // above are quicker when they work.
  //
  // On .site, and that is the whole point of moving them. While these
  // were .com subdomains the mirrors shared a registrable domain with
  // the panel origin, so a name-based block -- DNS poisoning or SNI
  // filtering on neoxify.com, neither of which cares about IP addresses
  // -- would have taken out the panel and every fallback together. That
  // is exactly the single point of failure the second domain exists to
  // remove, and the nodes had been left outside it.
  //
  // The certificates on both nodes were expanded to cover the .site name
  // alongside the .com one before this changed; a name the certificate
  // does not carry fails the handshake before any request is sent.
  "https://fi1.neoxify.site:2053/api",
  "https://fr1.neoxify.site:2053/api",
];

/** Dev talks to the local backend port; a real build talks to the public
 * /api path nginx proxies to it (see
 * installer/assets/nginx-panel.conf.template). */
export const API_BASE_URLS: readonly string[] = import.meta.env.DEV
  ? ["http://localhost:4000"]
  : PRODUCTION_API_BASE_URLS;

/** The first choice, for the few places that need a single address
 * rather than the ordered list. */
export const API_BASE_URL = API_BASE_URLS[0];
