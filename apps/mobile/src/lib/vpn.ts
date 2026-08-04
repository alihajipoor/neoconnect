import { invoke } from "@tauri-apps/api/core";

/** The Android side of the tunnel.
 *
 * Nothing here resembles the Windows client's engine layer, and it is
 * not a port of it. Android permits exactly one active VpnService and
 * hands it a single TUN file descriptor, so there is no per-protocol
 * adapter to create, no route table to edit, and no socket to pin to an
 * interface -- the three things the Windows implementation is built
 * around. Whichever protocol is active is handed that one descriptor.
 *
 * These commands are the boundary to the Kotlin plugin that owns the
 * VpnService. They are declared now, ahead of it, so the UI can be
 * built and shipped against a real interface rather than being
 * rewritten once the plugin lands.
 */

export interface VpnStatus {
  connected: boolean;
  protocol: string | null;
  /** Bytes since the tunnel came up, straight from the engine. */
  rxBytes: number;
  txBytes: number;
  /** Seconds since the last WireGuard handshake, or null when the
   * active protocol has no equivalent. The same evidence the Windows
   * client uses to tell "engine running" from "traffic flowing", which
   * is the distinction that stopped it lying about being connected. */
  lastHandshakeAgeSecs: number | null;
}

/** What the tunnel needs. The field names are the ones the backend
 * already emits (see generate-credentials.ts's WIREGUARD case) rather
 * than a re-spelling of them -- including `allowedIPs`, whose casing is
 * inherited from wg-quick. Renaming it here would mean a mapping layer
 * whose only job is to be got wrong once. */
export interface WireGuardProfile {
  privateKey: string;
  address: string;
  dns: string;
  serverPublicKey: string;
  endpoint: string;
  allowedIPs: string;
  /** Package names to route, or empty for the whole device. Android's
   * own `VpnService.Builder.addAllowedApplication` does per-app routing
   * natively -- none of the WinDivert machinery the Windows client needed
   * exists here, because the platform provides it. */
  allowedApps: string[];
}

/** Whether the customer has granted VPN permission.
 *
 * Android shows a system consent dialog the first time any app asks to
 * create a VpnService, and it cannot be pre-granted or bypassed. The UI
 * has to expect a connect attempt to pause here on first use. */
export const hasVpnPermission = () => invoke<{ granted: boolean }>("vpn_has_permission").then((r) => r.granted);

/** Raises the system consent dialog. Resolves once the customer has
 * answered -- true if they allowed it. */
export const requestVpnPermission = () => invoke<{ granted: boolean }>("vpn_request_permission").then((r) => r.granted);

export const connectWireGuard = (profile: WireGuardProfile) =>
  invoke<void>("vpn_connect_wireguard", { profile });

/** What the Xray engine needs.
 *
 * The config crosses as a finished JSON string rather than as fields:
 * the shape of a REALITY or Trojan outbound is protocol knowledge, it
 * already lives in xray-config.ts beside the credential types, and
 * rebuilding it on the Kotlin side would mean two places to keep in
 * step with the server. */
export interface XrayProfile {
  config: string;
  /** Reported back by `status`, so the UI can name what it landed on. */
  protocol: string;
  dns: string;
  mtu: number;
  allowedApps: string[];
}

export const connectXray = (profile: XrayProfile) =>
  invoke<void>("vpn_connect_xray", { profile });

export const disconnect = () => invoke<void>("vpn_disconnect");

export const vpnStatus = () => invoke<VpnStatus>("vpn_status");
