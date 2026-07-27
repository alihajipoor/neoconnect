// Mirrors apps/panel/src/lib/protocol-labels.ts -- kept in sync by hand,
// same reasoning as globals.css/types.ts (no shared package yet).
import type { Protocol } from "./types";

/** What an operator sees. Names the machinery, because someone choosing
 * what to run on a node needs to know exactly which engine and handshake
 * they are configuring. */
export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
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
  XRAY_VMESS: "Stealth (legacy)",
  XRAY_TROJAN: "Stealth Lite",
  WIREGUARD: "Fast",
  OPENVPN: "Compatible",
};

/** The one line of "when would I pick this" that belongs next to the
 * name. Without it the labels are just different jargon. */
export const CUSTOMER_PROTOCOL_HINTS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Hardest to block. Best on restricted networks.",
  XRAY_VMESS: "Older stealth option, kept for compatibility.",
  XRAY_TROJAN: "Looks like ordinary web traffic.",
  WIREGUARD: "Fastest. Best when nothing is blocking you.",
  OPENVPN: "Slower, but works almost everywhere.",
};
