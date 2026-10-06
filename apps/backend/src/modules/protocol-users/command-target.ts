import { decryptCredentials } from "./credentials-crypto";

/** The listener a command about an existing user is aimed at: the
 * config's transport, and its inbound tag when it has one.
 *
 * Every command that names a user already on a node needs both, not
 * only CREATE_USER. The protocol alone stopped identifying an inbound
 * once one node could serve VLESS+TLS as a raw TCP stream and inside a
 * WebSocket at once, and once a relay ran one inbound per exit. The
 * agent reads an absent transport as TCP and an absent tag as "the
 * inbound you were started with", so a DELETE_USER or DISABLE_USER sent
 * without them lands on the default inbound -- where Xray answers "not
 * found" with success -- while the credential keeps working on the one
 * the customer actually dials. For a quota suspension, an account
 * deletion or a concurrency hold that means nobody is cut off, and the
 * command is recorded as ACKED.
 *
 * One helper so the paths cannot drift apart again: deletion,
 * suspension and the concurrency cut each built their own payload, and
 * each had left these out.
 *
 * The tag is omitted entirely when null, so the payload stays
 * byte-identical to what every non-relay node has always received. */
export function commandTarget(protocolConfig: { transport: string | null; inboundTag: string | null }): {
  transport: string | null;
  inboundTag?: string;
} {
  return {
    transport: protocolConfig.transport,
    ...(protocolConfig.inboundTag ? { inboundTag: protocolConfig.inboundTag } : {}),
  };
}

/** The DELETE_USER payload for one provisioned user.
 *
 * A WireGuard user also carries its tunnel address -- the address only,
 * never the private key. The agent clears a speed cap by address
 * (clearRateLimit reads `credentials.address`), and WireGuard is not one
 * of the protocols whose addresses it discovers by itself, so a delete
 * without it left the `tc` rule in place. The allocator hands out the
 * lowest free address, so the next peer created on that config took the
 * address straight away and inherited the old customer's cap. Per-device
 * credentials made that delete-then-reuse cycle routine: every sign-out
 * frees addresses.
 *
 * A row whose credentials cannot be decrypted still gets its delete --
 * a stale cap is a far smaller problem than a credential left live. */
export function deleteUserPayload(
  user: { protocol: string; externalUserId: string; credentialsJson: string },
  protocolConfig: { transport: string | null; inboundTag: string | null },
): Record<string, unknown> {
  let address: string | undefined;
  if (user.protocol === "WIREGUARD") {
    try {
      address = decryptCredentials(user.credentialsJson).address;
    } catch {
      address = undefined;
    }
  }
  return {
    protocol: user.protocol,
    ...commandTarget(protocolConfig),
    externalUserId: user.externalUserId,
    ...(address ? { credentials: { address } } : {}),
  };
}
