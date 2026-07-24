// Mirrors apps/panel/src/lib/protocol-labels.ts -- kept in sync by hand,
// same reasoning as globals.css/types.ts (no shared package yet).
import type { Protocol } from "./types";

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  XRAY_VLESS_REALITY: "Xray VLESS+REALITY",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  WIREGUARD: "WireGuard",
  OPENVPN: "OpenVPN",
};
