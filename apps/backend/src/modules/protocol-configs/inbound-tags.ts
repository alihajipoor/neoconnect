import { BadRequestException } from "@nestjs/common";

/** Everything the backend can check about an inbound tag, and an honest
 * account of what it cannot.
 *
 * ## What cannot be checked, and why it matters
 *
 * **The backend cannot ask a node which inbounds it actually has.** The
 * agent's gRPC surface (`packages/proto/agent.proto`) has no message for
 * it: `Hello` carries a version, `Heartbeat` carries CPU, memory and a
 * connection count, and the command set is user and route management.
 * The agent does not even know the answer itself -- it is started with
 * one tag per protocol as a command-line flag
 * (`--xray-inbound-tag` and friends, `agent/cmd/agentd/main.go`) and
 * never reads Xray's config.
 *
 * So a tag naming an inbound that does not exist on the node is
 * accepted here and fails on the node, silently, at the moment a
 * customer tries to connect -- as "invalid request user id", which
 * points at the credential rather than at the config that caused it.
 *
 * That is a real gap and it is stated rather than papered over. What is
 * below narrows it as far as it can be narrowed without the node:
 *
 * 1. **Shape.** Enforced by the DTO's `@Matches`. Xray tags are
 *    lowercase names; anything else is certainly wrong.
 * 2. **Reserved tags.** A handful of tags exist on relay nodes for the
 *    machinery rather than for customers. Pointing a customer config at
 *    one is never right.
 * 3. **Protocol agreement.** The installer's templates give each
 *    protocol a fixed default tag. A Trojan config tagged `vless-in`
 *    would provision Trojan accounts onto the VLESS listener, which
 *    rejects them.
 * 4. **Uniqueness on the node.** Two configs resolving to the same tag
 *    is the failure that cost a day: a relayed route's routing rule
 *    matches on the entry inbound tag *and nothing else*, so the second
 *    config's traffic leaves through the first one's exit. It is
 *    created, provisioned, and listed in the customer's picker while
 *    egressing from the wrong country, and nothing -- not the route
 *    rows, not the command acks, not the agent logs -- says so. Measured
 *    2026-08-13: a credential issued on `ir1 -> france-1` exited at
 *    204.168.161.100, which is finland1.
 *
 * None of that proves the inbound exists. It rules out every way of
 * getting it wrong that is visible from here.
 */

/** Tags that belong to the relay machinery, not to customers.
 *
 * `relay-tun-in` is the dormant tun inbound in a relay node's Xray
 * config (see `installer/assets/xray-relay-config.json.template`); it is
 * what a WireGuard or OpenVPN relay entry's subnet is bridged into, and
 * it is the agent's `--relay-tun-inbound-tag` default. A customer config
 * pointed at it would put that customer's account on the bridge rather
 * than on a listener they can dial.
 */
export const RESERVED_INBOUND_TAGS = new Set(["relay-tun-in", "api", "direct", "blocked"]);

/** Which protocols are served out of the node's Xray process.
 *
 * Not "starts with XRAY_" -- Shadowsocks is one of them. Mirrors the set
 * in RoutesService and AgentGatewayService.
 */
export const XRAY_SERVED_PROTOCOLS = new Set([
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_VMESS",
  "XRAY_TROJAN",
  "SHADOWSOCKS",
]);

export interface ConfigTagView {
  id: string;
  protocol: string;
  transport: string | null;
  inboundTag: string | null;
}

/** The tag the installer's templates write for a given protocol.
 *
 * Transport is part of the key for VLESS+TLS specifically: its TCP and
 * WebSocket forms are deliberately two inbounds sharing one port and one
 * certificate, which is the same reason the CREATE_USER payload has to
 * carry transport.
 *
 * This table exists in two other places -- `entryInboundTag` in
 * RoutesService and `defaultInboundTag` in AgentGatewayService. Copying
 * it a third time is not good, and it is the smaller evil right now:
 * both of those files are being worked on concurrently for a live relay
 * outage, and a shared-module refactor across them is exactly the kind
 * of change that merges cleanly and fails at runtime. `defaults match
 * the installer templates` in the spec pins this copy so a divergence
 * shows up as a red test rather than as a wrong route.
 */
export function defaultInboundTagFor(protocol: string, transport: string | null): string | null {
  switch (protocol) {
    case "XRAY_VLESS_REALITY":
      return "vless-in";
    case "XRAY_VLESS_TLS":
      return transport === "WS" ? "vless-ws-in" : "vless-tls-in";
    case "XRAY_TROJAN":
      return "trojan-in";
    case "SHADOWSOCKS":
      return "shadowsocks-in";
    default:
      return null;
  }
}

/** Which inbound this config will actually be served on: its own tag
 * when it has one, otherwise the node default. Null means "this protocol
 * has no Xray inbound", which is true of WireGuard, OpenVPN and IKEv2.
 */
export function effectiveInboundTag(config: ConfigTagView): string | null {
  return config.inboundTag ?? defaultInboundTagFor(config.protocol, config.transport);
}

/** Every default tag, with the protocol it belongs to. Built from the
 * function above rather than written out again, so the two cannot
 * disagree. */
const DEFAULT_TAG_OWNERS: Array<{ tag: string; protocol: string; transport: string | null }> = [
  { protocol: "XRAY_VLESS_REALITY", transport: null },
  { protocol: "XRAY_VLESS_TLS", transport: "TCP" },
  { protocol: "XRAY_VLESS_TLS", transport: "WS" },
  { protocol: "XRAY_TROJAN", transport: null },
  { protocol: "SHADOWSOCKS", transport: null },
].map((entry) => ({ ...entry, tag: defaultInboundTagFor(entry.protocol, entry.transport)! }));

/** Refuses a tag that is wrong in a way the backend can see.
 *
 * `siblings` is every *other* protocol config on the same node. It has
 * to be every one of them and not only the Xray ones, because the
 * question being asked is "does anything else on this node already
 * answer to this tag".
 */
export function assertInboundTagUsable(
  target: { id?: string; protocol: string; transport: string | null; inboundTag: string },
  siblings: ConfigTagView[],
): void {
  const tag = target.inboundTag;

  if (!XRAY_SERVED_PROTOCOLS.has(target.protocol)) {
    throw new BadRequestException(
      `inboundTag means nothing for ${target.protocol} -- only protocols served out of the node's Xray process ` +
        `(${[...XRAY_SERVED_PROTOCOLS].join(", ")}) have inbounds. Leave it unset, or send null to clear it.`,
    );
  }

  if (RESERVED_INBOUND_TAGS.has(tag)) {
    throw new BadRequestException(
      `"${tag}" is reserved for the node's own machinery, not for customer traffic. ` +
        "On a relay, relay-tun-in is the dormant tun inbound the entry protocol's subnet is bridged into; " +
        "a customer provisioned onto it has no listener to dial.",
    );
  }

  const owner = DEFAULT_TAG_OWNERS.find((entry) => entry.tag === tag);
  const ownsItself =
    owner && owner.protocol === target.protocol && (owner.transport === null || owner.transport === (target.transport ?? "TCP"));
  if (owner && !ownsItself) {
    throw new BadRequestException(
      `"${tag}" is the node's default inbound for ${owner.protocol}${owner.transport ? ` over ${owner.transport}` : ""}, ` +
        `not for ${target.protocol}. Provisioning a ${target.protocol} account onto it would be refused by Xray at connect time. ` +
        "A second listener for this protocol needs its own tag in the node's Xray config -- and that tag has to exist there before this is set.",
    );
  }

  const clash = siblings.find((sibling) => sibling.id !== target.id && effectiveInboundTag(sibling) === tag);
  if (clash) {
    throw new BadRequestException(
      `Another config on this node (id ${clash.id}, ${clash.protocol}) is already served on inbound "${tag}"` +
        `${clash.inboundTag ? "" : " -- it is that protocol's node default, which it uses because it has no explicit tag"}. ` +
        "Two configs on one inbound is not a duplicate that fails loudly: a relayed route's rule matches on the entry inbound tag " +
        "and nothing else, so the second one's traffic silently egresses through the first one's exit. Give this one its own " +
        "listener and tag on the node.",
    );
  }
}
