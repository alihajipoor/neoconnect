import "server-only";
import { BlockList, isIP } from "node:net";
import { headers } from "next/headers";

/**
 * The browser's address, for the few backend calls the panel makes on
 * behalf of someone who is not signed in yet: the sign-in challenge,
 * the password step and the code step.
 *
 * Those calls go from this server straight to http://backend:4000, so
 * without help the backend sees one address -- this container's -- for
 * every operator. Its per-address limits (the 5-a-minute @Throttle and
 * LoginGuard's per-source failure counter) then became one bucket for the
 * whole panel: five wrong passwords from anybody, typed into the public
 * login page, refused every admin's correct password for 30 minutes, and
 * refreshing that cost the stranger five more tries.
 *
 * The backend runs with `trust proxy 1`, so the last X-Forwarded-For entry
 * this server sends becomes its req.ip. The value must therefore be one
 * the browser could not have chosen. nginx writes it: the panel listens
 * on 127.0.0.1:3000 only, and installer/assets/nginx-panel.conf.template
 * sets X-Real-IP to $remote_addr (replacing whatever the caller sent) and
 * appends $remote_addr to X-Forwarded-For. Both are required and must
 * agree. A caller can put anything in either header, but not make the one
 * nginx replaces equal the one nginx appends to unless it tells the
 * truth; and Next fills X-Forwarded-For with the socket peer only when it
 * is absent. If nginx sets neither, both are the caller's -- that is the
 * one configuration this cannot detect, and the template sets both.
 *
 * When the peer nginx saw is a Cloudflare edge (the panel's domain is
 * proxied by Cloudflare), the client is in CF-Connecting-IP, which
 * Cloudflare overwrites on every request. Anywhere else that header is the
 * caller's own and is ignored -- the same rule as the backend's
 * verifiedClientIpOf (apps/backend/src/common/client-ip.ts).
 *
 * Undefined when there is nothing trustworthy to send. The call then goes
 * without the header and the backend counts this container, as it did
 * before: one shared bucket, never a forged fresh one.
 */
export function clientAddressFrom(h: Pick<Headers, "get">): string | undefined {
  const realIp = normalise(h.get("x-real-ip"));
  const lastHop = normalise(h.get("x-forwarded-for")?.split(",").at(-1));
  if (!realIp || !lastHop || realIp !== lastHop) return undefined;
  if (isCloudflareAddress(realIp)) return normalise(h.get("cf-connecting-ip")) ?? realIp;
  return realIp;
}

/** The header to add to an unauthenticated sign-in call to the backend,
 * or none. See clientAddressFrom. */
export async function forwardedClientHeaders(): Promise<Record<string, string>> {
  const address = clientAddressFrom(await headers());
  if (address) return { "X-Forwarded-For": address };
  warnOnce();
  return {};
}

let warned = false;
function warnOnce() {
  if (warned || process.env.NODE_ENV !== "production") return;
  warned = true;
  console.warn(
    "panel: no trustworthy client address on a sign-in request (nginx must set X-Real-IP to $remote_addr and " +
      "append it to X-Forwarded-For, as installer/assets/nginx-panel.conf.template does). Every panel sign-in " +
      "now shares this server's rate-limit and failure counters.",
  );
}

function normalise(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const address = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? trimmed;
  return isIP(address) ? address : undefined;
}

/** Cloudflare's published edge ranges. A copy of the backend's list in
 * apps/backend/src/common/cloudflare.ts -- the panel image does not carry
 * the backend's source -- and client-address.test.ts fails if the two
 * differ. */
export const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
export const CLOUDFLARE_V6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const edges = new BlockList();
for (const cidr of CLOUDFLARE_V4) {
  const [address, prefix] = cidr.split("/");
  edges.addSubnet(address, Number(prefix), "ipv4");
}
for (const cidr of CLOUDFLARE_V6) {
  const [address, prefix] = cidr.split("/");
  edges.addSubnet(address, Number(prefix), "ipv6");
}

function isCloudflareAddress(address: string): boolean {
  return edges.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}
