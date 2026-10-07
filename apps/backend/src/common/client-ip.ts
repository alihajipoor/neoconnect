import type { Request } from "express";
import { isCloudflareAddress } from "./cloudflare";

/** The address the *caller* came from, across however many proxies.
 *
 * The order matters and got this wrong once, in a way that would have
 * broken every connection in the product. X-Real-IP is set by nginx to
 * its immediate peer, so preferring it -- as this did -- returns the
 * last hop rather than the client: Cloudflare's address for anything
 * arriving through the CDN, and a VPN node's own address for anything
 * arriving through a node's API mirror.
 *
 * Since the client compares this before and after connecting to prove
 * its traffic really moved, a constant proxy address on both sides reads
 * as "the tunnel is carrying nothing" -- reporting every working
 * connection as unprotected. Measured, not theorised: through Cloudflare
 * this returned 162.158.41.5 while the caller was 50.47.175.127.
 *
 * So: Cloudflare's own header first where present, then the *leftmost*
 * X-Forwarded-For entry, which is the original client -- every proxy in
 * this path appends rather than replaces. X-Real-IP and the socket
 * address remain as last resorts for a direct connection with no
 * forwarding at all.
 *
 * These headers are client-supplied to anyone who reaches the backend
 * without passing a proxy -- and the origin answers directly on 443 --
 * so a caller can lie here. For the address /health/ip echoes that is
 * harmless: it goes back only to whoever asked. For the attempt log it
 * means an address is *reported*, not proven, which is the right
 * standard for beta diagnostics and the wrong one for anything that
 * authorises, bills, bans or is signed. The network /health/ip signs is
 * read from verifiedClientIpOf instead.
 *
 * Shared rather than duplicated because there are now two callers and
 * the precedence is the whole substance of it -- a second copy is a
 * second chance to get the order wrong, and the last time that happened
 * it took a live measurement to notice.
 */
export function clientIpOf(req: Request): string | undefined {
  return (
    first(req.headers["cf-connecting-ip"]) ||
    first(req.headers["x-forwarded-for"]) ||
    first(req.headers["x-real-ip"])
  );
}

/** The caller's address as far as the server can vouch for it, or
 * undefined.
 *
 * `peer` is req.ip: with `trust proxy 1` that is the address nginx saw,
 * which the caller cannot choose. When that peer is a Cloudflare edge,
 * the request came through the CDN and Cloudflare's own header -- which
 * Cloudflare overwrites, whatever the caller sent -- is the client.
 * Otherwise the peer itself is the answer, and no header is believed.
 *
 * Narrower than clientIpOf on purpose. Through a node's API mirror the
 * peer is the node, so this returns the node's address -- which
 * NetworkIdentityService then refuses to name -- although the real
 * client is one entry to the left: tunnel traffic leaves from that same
 * node address with an X-Forwarded-For the customer wrote, and the two
 * cannot be told apart here. */
export function verifiedClientIpOf(req: Request, peer: string | undefined): string | undefined {
  if (isCloudflareAddress(peer)) return first(req.headers["cf-connecting-ip"]) || undefined;
  return peer || undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
}
