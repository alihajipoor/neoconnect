import type { Request } from "express";

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
 * without passing a proxy, so a caller can lie here. For /health/ip that
 * is harmless -- the value is only echoed back to whoever asked. For the
 * attempt log it means an address is *reported*, not proven, which is
 * the right standard for beta diagnostics and the wrong one for anything
 * that authorises, bills or bans.
 *
 * Shared rather than duplicated because there are now two callers and
 * the precedence is the whole substance of it -- a second copy is a
 * second chance to get the order wrong, and the last time that happened
 * it took a live measurement to notice.
 */
export function clientIpOf(req: Request): string | undefined {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

  return (
    first(req.headers["cf-connecting-ip"]) ||
    first(req.headers["x-forwarded-for"]) ||
    first(req.headers["x-real-ip"])
  );
}
