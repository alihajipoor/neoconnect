/** Which HTTP-capability globs a set of endpoint hosts needs.
 *
 * Shared by apply-capability-scope.mjs, which writes them into the
 * capability file at build time, and scripts/endpoints/bundle.mjs, which
 * warns when a bundle about to be signed names a host no shipped build
 * can call.
 *
 * The capability scope is fixed when the app is built, from the seed
 * bundle; nothing extends it at runtime. So a newer bundle -- the
 * mechanism that is meant to reach customers who cannot download a
 * release -- could only ever name hosts the build already knew. Every
 * node added since the build gets a mirror host in the next bundle
 * automatically, and every installed client refused it locally, before
 * a packet left (`scope` in the endpoint trace).
 *
 * Exact hosts alone left no room for that. So a domain the seed already
 * uses for two or more hosts -- a domain we evidently put mirrors on --
 * is also covered by a wildcard, and a node added on it later is in
 * scope for every build that shipped the domain. What this still cannot
 * cover, and only a release can: a new domain, and a bare IP address.
 * The generated file is not committed (docs/node-address-hygiene.md) and
 * the binary already embeds the seed's hosts, so the wildcard tells
 * nobody anything new.
 */

/** Second-level labels under a country code that are registries, not
 * registrants: `x.co.uk` has the parent `co.uk`, and `*.co.uk` would be
 * everybody's. Not a public-suffix list; the domain must also be shared
 * by two seed hosts before it gets a wildcard at all. */
const REGISTRY_SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne|go|ltd|plc|nom|sch)\.[a-z]{2}$/i;

/** The domain one label up from `host`, when a wildcard under it would
 * be ours alone; null for an IP literal or a name too short to have one. */
export function parentDomain(host) {
  if (typeof host !== "string" || host === "") return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  const labels = host.toLowerCase().split(".");
  if (labels.length < 3 || labels.some((l) => l === "")) return null;
  const parent = labels.slice(1).join(".");
  if (REGISTRY_SECOND_LEVEL.test(parent)) return null;
  return parent;
}

/** The globs, bare and with a port -- the mirrors are on a non-default
 * port, and Tauri treats those as different origins. */
export function scopeGlobs(hosts) {
  const unique = [...new Set([...hosts].map((h) => String(h).toLowerCase()))];
  const patterns = [];
  for (const h of unique) patterns.push(`https://${h}/*`, `https://${h}:*/*`);
  const shared = new Map();
  for (const h of unique) {
    const parent = parentDomain(h);
    if (parent) shared.set(parent, (shared.get(parent) ?? 0) + 1);
  }
  for (const [parent, count] of shared) {
    if (count >= 2) patterns.push(`https://*.${parent}/*`, `https://*.${parent}:*/*`);
  }
  return [...new Set(patterns)];
}

/** Whether `host` is inside the scope `scopeGlobs(knownHosts)` grants.
 * What bundle.mjs asks of a host before signing a bundle that names it. */
export function inScope(host, knownHosts) {
  const h = String(host).toLowerCase();
  const known = new Set([...knownHosts].map((k) => String(k).toLowerCase()));
  if (known.has(h)) return true;
  return scopeGlobs(known).some((glob) => {
    const m = /^https:\/\/\*\.([^/:]+)\/\*$/.exec(glob);
    return m !== null && h.endsWith(`.${m[1]}`);
  });
}

/** The hosts an endpoint bundle names, skipping anything malformed. */
export function bundleHosts(bundle) {
  const hosts = new Set();
  for (const e of bundle?.endpoints ?? []) {
    if (typeof e?.url !== "string") continue;
    try {
      hosts.add(new URL(e.url).hostname);
    } catch {
      // a malformed entry names nothing
    }
  }
  return hosts;
}
