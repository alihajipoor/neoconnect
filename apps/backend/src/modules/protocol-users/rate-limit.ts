import { Protocol } from "@prisma/client";

export interface RateLimit {
  downloadMbps?: number;
  uploadMbps?: number;
}

/** Protocols whose per-user speed cap can actually be enforced on the node.
 *
 * WireGuard and OpenVPN both give each user their own address inside the
 * tunnel, so the node can shape that address with `tc` and affect exactly
 * one customer.
 *
 * Xray-based protocols cannot, and this is a real limitation rather than
 * something not built yet: every VLESS/VMess/Trojan user is multiplexed
 * through a single xray process sharing one outbound, so there is no
 * per-user address to match on. Xray's policy levels control buffer sizes,
 * not bandwidth. Shaping what is available would throttle every customer
 * on the node at once, which is worse than not shaping at all -- so these
 * are reported as unenforceable instead, and the panel says so rather than
 * showing a cap that silently does nothing.
 */
const SHAPEABLE: readonly Protocol[] = [Protocol.WIREGUARD, Protocol.OPENVPN];

export function isShapeable(protocol: Protocol): boolean {
  return SHAPEABLE.includes(protocol);
}

/** Which of a plan's protocols can have its caps enforced, and which can't.
 * Used by the panel to warn an admin before they set a cap that would only
 * apply to some of the protocols their plan offers. */
export function splitByShapeability(protocols: Protocol[]): {
  shapeable: Protocol[];
  unenforceable: Protocol[];
} {
  return {
    shapeable: protocols.filter(isShapeable),
    unenforceable: protocols.filter((p) => !isShapeable(p)),
  };
}

/** The rate-limit fields to attach to a CREATE_USER command, if any.
 *
 * Returns nothing at all -- rather than zeroes or nulls -- when the plan is
 * uncapped or the protocol can't be shaped, so an agent reading the payload
 * cannot mistake "no limit" for "limit of 0" and cut the user off entirely.
 */
export function rateLimitFor(
  plan: { maxDownloadMbps: number | null; maxUploadMbps: number | null } | null | undefined,
  protocol: Protocol,
): RateLimit {
  if (!plan || !isShapeable(protocol)) return {};

  const limit: RateLimit = {};
  if (plan.maxDownloadMbps) limit.downloadMbps = plan.maxDownloadMbps;
  if (plan.maxUploadMbps) limit.uploadMbps = plan.maxUploadMbps;
  return limit;
}
