import type { Protocol } from "./types";

/** The inbound tag the installer's templates write for each protocol.
 *
 * Mirrors `defaultInboundTagFor` in the backend's protocol-configs
 * module. It is here so the edit dialog can *show* what "leave it empty"
 * resolves to -- an operator staring at a blank box has no way to tell
 * whether the default is sensible, and the whole risk of this field is
 * naming a listener the node does not have.
 *
 * Nothing routes on this copy; the backend decides. If the two ever
 * disagree the panel shows a wrong hint, which is bad but visible, and
 * the backend still refuses the wrong tag.
 */
export function defaultInboundTag(protocol: Protocol, transport?: string | null): string | null {
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
      // WireGuard, OpenVPN, IKEv2 and VMess have no Xray inbound the
      // installer templates name, so there is nothing to fall back to
      // and the field does not apply.
      return null;
  }
}

/** Whether this protocol is served out of the node's Xray process at
 * all. Only these have inbounds, so only these can carry a tag. */
export function hasXrayInbound(protocol: Protocol): boolean {
  return defaultInboundTag(protocol, "TCP") !== null;
}
