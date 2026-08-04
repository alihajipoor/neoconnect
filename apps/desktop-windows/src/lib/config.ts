/** Where the control plane lives, best first.
 *
 * A list rather than one address, because one address was a single point
 * of failure for the entire product and it failed: connect.neoxify.com's
 * IP was filtered in Iran and every customer there lost sign-in,
 * purchase, support and updates at once, on nodes that were not blocked.
 *
 * These are only the addresses known at build time. The app also derives
 * mirrors from the nodes the customer is already provisioned on -- see
 * api-endpoints.ts, which is what makes the list grow without a release.
 *
 * Dev talks to the local backend port; a real build talks to the public
 * /api path nginx proxies to it (see installer/assets/nginx-panel.conf.template).
 */
export const API_BASE_URLS: readonly string[] = import.meta.env.DEV
  ? ["http://localhost:4000"]
  : [
      // A separate domain on a CDN, deliberately sharing nothing with
      // the marketing site: a block aimed at one cannot take the other
      // with it, which is the entire reason it is a second domain rather
      // than a second subdomain.
      "https://connect.neoxify.site/api",
      // The origin. Still tried, because a CDN is one more party that
      // can be unavailable, and on an unfiltered network this is the
      // shortest path.
      "https://connect.neoxify.com/api",
    ];

/** The first choice, for the few places that need a single address
 * rather than the ordered list. */
export const API_BASE_URL = API_BASE_URLS[0];
