// Mirrors apps/panel/src/lib/protocol-labels.ts -- kept in sync by hand,
// same reasoning as globals.css/types.ts (no shared package yet).
import type { Protocol } from "./types";

/** What an operator sees. Names the machinery, because someone choosing
 * what to run on a node needs to know exactly which engine and handshake
 * they are configuring. */
export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VLESS_TLS: "Xray VLESS+TLS",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  SHADOWSOCKS: "Shadowsocks 2022",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
  IKEV2: "IKEv2/IPsec",
};

/** What a customer sees.
 *
 * "Xray VLESS+REALITY" tells a buyer nothing -- it reads like an internal
 * identifier leaking into the product, which is exactly what it was.
 * These name the trade-off instead, since that is the only thing a
 * customer is really choosing between: speed, or getting through.
 */
export const CUSTOMER_PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Stealth",
  XRAY_VLESS_TLS: "Stealth HTTPS",
  XRAY_VMESS: "Stealth (legacy)",
  XRAY_TROJAN: "Stealth Lite",
  SHADOWSOCKS: "Shadowsocks",
  WIREGUARD: "Fast",
  OPENVPN: "Compatible",
  IKEV2: "Built-in",
};

/** What a customer sees for a credential, once its transport is known.
 *
 * VLESS+TLS is sold as two different things depending on how it is
 * carried, and it has to be: the whole point of the WebSocket variant is
 * that it can sit behind a CDN, which is a materially different answer
 * to "will this get through". Showing both as "Stealth HTTPS" would also
 * make the failover notice ambiguous -- "switched to Stealth HTTPS" when
 * you were already on Stealth HTTPS reads as a bug.
 *
 * Everything else ignores transport, because for everything else there
 * is only one. */
export function customerProtocolLabel(
  protocol: Protocol,
  transport?: string,
): string {
  if (protocol === "XRAY_VLESS_TLS" && transport === "WS") return "Stealth Web";
  return CUSTOMER_PROTOCOL_LABELS[protocol] ?? protocol;
}

/** The one line of "when would I pick this" that belongs next to the
 * name. Without it the labels are just different jargon. */
export const CUSTOMER_PROTOCOL_HINTS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Hardest to block. Best on restricted networks.",
  XRAY_VLESS_TLS: "Looks exactly like a normal HTTPS website.",
  XRAY_VMESS: "Older stealth option, kept for compatibility.",
  XRAY_TROJAN: "Also looks like a website. Older method than Stealth HTTPS.",
  SHADOWSOCKS: "No handshake to detect. Good when stealth ports are blocked.",
  WIREGUARD: "Fastest. Best when nothing is blocking you.",
  OPENVPN: "Slower, but works almost everywhere.",
  IKEV2: "Uses your device's own VPN. Fast, but easy to block.",
};

/** The WebSocket variant's own hint. Not in the record above because
 * that is keyed by Protocol, and this is the same Protocol carried
 * differently. */
export const STEALTH_WEB_HINT = "Looks like ordinary web traffic. Best when everything else is blocked.";
