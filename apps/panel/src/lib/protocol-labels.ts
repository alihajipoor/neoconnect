import type { Protocol } from "./types";

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VLESS_TLS: "Xray VLESS+TLS",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  SHADOWSOCKS: "Shadowsocks 2022",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
  // Named for what it is, not what customers see. The clients label it
  // "Built-in", because to a customer the salient fact is that it needs
  // no engine shipped with the app; to an operator picking a protocol
  // for a node, that would be meaningless.
  IKEV2: "IKEv2/IPsec",
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
  // No conventional port on purpose: 8388 is the documented default
  // and therefore the first thing a scanner tries. An unremarkable high
  // port is most of this protocol's defence, since it has no handshake
  // to hide behind.
  SHADOWSOCKS: 23456,
  WIREGUARD: 51820,
  OPENVPN: 1194,
  // IKEv2 actually needs both UDP 500 and 4500 -- 4500 is where the
  // traffic goes once NAT traversal kicks in, which on a real customer
  // network is always. `listenPort` holds one number, so it holds 500,
  // matching what the installer registers (installer/lib/agent.sh).
  // Changing it here without changing the installer would produce a
  // config that disagrees with the node it describes.
  IKEV2: 500,
};
