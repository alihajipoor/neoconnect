import type { Protocol } from "./types";

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VLESS_TLS: "Xray VLESS+TLS",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
};

// Conventional default listen port per protocol -- matches what the
// installer itself already defaults to (install_wireguard prompts
// "[51820]", install_openvpn's example config uses 1194).
//
// 443 is the port worth having, since it is the one a censor cannot
// block wholesale, but only one service can hold it per address.
// REALITY is the one that must: it intercepts the TLS handshake and
// proxies non-matching clients to the site it imitates, leaving no room
// behind it for another TLS service. The certificate-presenting variants
// can share a single listener, so they default to 8443 rather than
// pretending they can all have 443 on one node.
export const DEFAULT_PROTOCOL_PORT: Record<Protocol, number> = {
  XRAY_VLESS_REALITY: 443,
  XRAY_VLESS_TLS: 8443,
  XRAY_VMESS: 443,
  XRAY_TROJAN: 8443,
  WIREGUARD: 51820,
  OPENVPN: 1194,
};
