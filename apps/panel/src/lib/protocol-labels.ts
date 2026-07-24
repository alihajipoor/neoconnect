import type { Protocol } from "./types";

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
};

// Conventional default listen port per protocol -- matches what the
// installer itself already defaults to (install_wireguard prompts
// "[51820]", install_openvpn's example config uses 1194). The Xray
// variants all default to 443 since blending in as ordinary HTTPS is
// the whole point (most true for REALITY/Trojan, but VMess is
// conventionally deployed the same way in this project).
export const DEFAULT_PROTOCOL_PORT: Record<Protocol, number> = {
  XRAY_VLESS_REALITY: 443,
  XRAY_VMESS: 443,
  XRAY_TROJAN: 443,
  WIREGUARD: 51820,
  OPENVPN: 1194,
};
