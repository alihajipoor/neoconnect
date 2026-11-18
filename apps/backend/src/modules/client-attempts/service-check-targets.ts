/** The service check's fixed list (docs/client-diagnostics.md).
 *
 * The apps test exactly these and nothing else, and the server keeps a
 * result only when its host is on this list or the previous one
 * (`keepServiceResults`). That is how the boundary holds against a
 * modified client: the only sites this feature ever stores a result for
 * are ones the server chose. A constant, so a change is a backend deploy
 * and never an app release; bump the version with any change, and move
 * the outgoing list to PREVIOUS_SERVICE_CHECK_TARGETS so results already
 * in flight from apps holding it are not thrown away. */

export interface ServiceCheckTarget {
  /** Stable name the panel groups by. */
  key: string;
  /** What staff read. */
  label: string;
  host: string;
  /** The path the app requests over HTTPS. */
  path: string;
}

export const SERVICE_CHECK_TARGETS_VERSION = 1;

/** How often an app runs the check on its own, in hours. */
export const SERVICE_CHECK_EVERY_HOURS = 24;

export const SERVICE_CHECK_TARGETS: readonly ServiceCheckTarget[] = [
  { key: "instagram", label: "Instagram", host: "www.instagram.com", path: "/" },
  { key: "instagram_app", label: "Instagram app API", host: "i.instagram.com", path: "/" },
  { key: "whatsapp", label: "WhatsApp Web", host: "web.whatsapp.com", path: "/" },
  { key: "whatsapp_media", label: "WhatsApp media", host: "mmg.whatsapp.net", path: "/" },
  { key: "telegram", label: "Telegram Web", host: "web.telegram.org", path: "/" },
  { key: "google", label: "Google", host: "www.google.com", path: "/generate_204" },
  { key: "youtube", label: "YouTube", host: "www.youtube.com", path: "/generate_204" },
  { key: "x", label: "X", host: "x.com", path: "/" },
  { key: "control", label: "Control (Cloudflare)", host: "www.cloudflare.com", path: "/cdn-cgi/trace" },
];

/** The list before the current one. Empty until the first change. */
export const PREVIOUS_SERVICE_CHECK_TARGETS: readonly ServiceCheckTarget[] = [];

/** A host as compared: lower case, no trailing dot. */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

const ALLOWED_HOSTS = new Set(
  [...SERVICE_CHECK_TARGETS, ...PREVIOUS_SERVICE_CHECK_TARGETS].map((t) => normaliseHost(t.host)),
);

/** Whether a result for this host may be stored. */
export function isServiceCheckHost(host: string): boolean {
  return ALLOWED_HOSTS.has(normaliseHost(host));
}

/** The label staff read for a key, from the current list or the previous. */
export function serviceCheckLabel(key: string): string | null {
  return [...SERVICE_CHECK_TARGETS, ...PREVIOUS_SERVICE_CHECK_TARGETS].find((t) => t.key === key)?.label ?? null;
}

/** GET /customer/service-checks/targets. SERVICE_CHECKS=off turns the check
 * off in every app that asks, without a release. */
export function serviceCheckTargets(env: string | undefined) {
  return {
    enabled: (env ?? "").trim().toLowerCase() !== "off",
    version: SERVICE_CHECK_TARGETS_VERSION,
    everyHours: SERVICE_CHECK_EVERY_HOURS,
    targets: SERVICE_CHECK_TARGETS.map((t) => ({ ...t })),
  };
}
