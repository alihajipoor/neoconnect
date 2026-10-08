import { invoke } from "@tauri-apps/api/core";
import { tearDownForSignOut, type TeardownDeps } from "@shared/lib/tunnel-teardown";

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
  /** Bytes since the tunnel came up, or null where the platform will
   * not say. Android reads them from the engine; iOS has none to read,
   * because the tunnel runs in a separate extension process and
   * NEVPNConnection exposes no totals to the app. Null rather than zero,
   * so nothing later reads "not known" as "nothing was carried". */
  rxBytes: number | null;
  txBytes: number | null;
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

/** What this app may start without asking, read without raising
 * anything -- the answer an automatic reconnect checks before it dials.
 *
 * `granted` is the one every platform gives. iOS adds two, because it
 * keeps two configurations where Android keeps one permission: */
export interface VpnAccess {
  /** Whether this app may start its VPN without the consent dialog --
   * Android's VpnService grant, iOS's saved packet-tunnel configuration
   * (which Xray and WireGuard share). */
  granted: boolean;
  /** iOS: whether IKEv2's own configuration is installed. Dialling IKEv2
   * without it installs it, and that raises the system's "Add VPN
   * Configurations" prompt. A sign-out removes it. Absent on Android,
   * where the VpnService grant is read from AOSP to cover the platform's
   * IKEv2 profile too (`Vpn.isVpnProfilePreConsented`; not observed on a
   * device). */
  ikev2?: boolean;
  /** iOS: whether another VPN configuration is the enabled one and none
   * of ours is -- another VPN app connected, or the customer picked one in
   * Settings. iOS shows an app no other app's VPN, so this is the only
   * sign of one. Absent on Android, where `tunnelGone` sees every VPN. */
  chosenElsewhere?: boolean;
}

export const vpnAccess = () => invoke<VpnAccess>("vpn_has_permission");

/** Whether the customer has granted VPN permission.
 *
 * Android shows a system consent dialog the first time any app asks to
 * create a VpnService, and it cannot be pre-granted or bypassed. The UI
 * has to expect a connect attempt to pause here on first use. */
export const hasVpnPermission = () => vpnAccess().then((r) => r.granted);

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

/** IKEv2's, which is barely a profile at all.
 *
 * No config and no `allowedApps`: Android's platform VPN profile has no
 * equivalent of `IncludedApplications`, so per-app routing is not
 * available on this protocol and the caller skips it rather than
 * quietly tunnelling the whole device. */
export interface Ikev2Profile {
  /** The node's hostname. Never its address -- Android checks the
   * server's certificate against what was dialled, and cannot be told a
   * remote identity separately. */
  server: string;
  username: string;
  password: string;
}

export const connectIkev2 = (profile: Ikev2Profile) =>
  invoke<void>("vpn_connect_ikev2", { profile });

export const disconnect = () => invoke<void>("vpn_disconnect");

/** Whether the device has stopped being routed through a VPN.
 *
 * Polled after a disconnect so the UI confirms the teardown instead of
 * announcing it. Kept out of `disconnect` itself because the connect
 * ladder disconnects between rungs and must not wait. */
export const tunnelGone = () =>
  invoke<{ gone: boolean }>("vpn_tunnel_gone").then((r) => r.gone);

export const vpnStatus = () => invoke<VpnStatus>("vpn_status");

/** Stops every engine and removes what the platform keeps in its own
 * VPN settings -- see `vpn_forget_profiles`. Sign-out only. */
export const forgetProfiles = () => invoke<void>("vpn_forget_profiles");

/** The phone's half of ending a session.
 *
 * The shared teardown, pointed at this platform: "disconnect" forgets
 * the stored profiles as well (falling back to a plain disconnect if the
 * command is missing, so an older native side still stops the tunnel),
 * and "still connected" is the same `tunnelGone` the dashboard trusts
 * for its own disconnects -- whether the device is routed through a VPN
 * at all, not whether our process thinks it started one.
 *
 * Registered with the shared session code at startup; see App.tsx.
 */
export const mobileTeardownDeps: TeardownDeps = {
  disconnect: () => forgetProfiles().catch(() => disconnect()),
  disarmGaming: () => Promise.resolve(),
  connected: () => tunnelGone().then((gone) => !gone),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const tearDownMobileForSignOut = () => tearDownForSignOut(mobileTeardownDeps);
