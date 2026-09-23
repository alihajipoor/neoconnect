//! The bridge between the UI and Android's VpnService.
//!
//! Almost nothing happens here. The tunnel is Kotlin's -- Android will
//! only let a `VpnService` subclass hold the TUN descriptor, and the
//! WireGuard library that drives it is a Java one -- so this crate's job
//! is to hand calls across and hand answers back.
//!
//! It is a plugin crate rather than a module in the app because Tauri
//! only wires Kotlin into the Gradle build from a plugin's `android/`
//! directory. But only the *setup* is a plugin: the commands below are
//! registered on the app itself, which means they need no capability
//! entries. Writing a permission set for an in-process bridge would be
//! ceremony protecting nothing -- there is no third-party code in this
//! webview to protect it from.

mod commands;

pub use commands::*;

/// Answer to `vpn_tunnel_gone`: false while the device is still routed
/// through any VPN, ours or otherwise.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelGone {
    pub gone: bool,
}

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::Runtime;
// Both mobile platforms call app.manage(); neither desktop build does,
// and an unconditional import is an unused-import warning there.
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

/// Must match the `namespace` in android/build.gradle.kts.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.neoxify.vpn";

/// What the customer's credentials become on the wire.
///
/// The field names are the backend's, not a re-spelling of them -- see
/// `generate-credentials.ts`'s WIREGUARD case. `allowedIPs` keeps its
/// wg-quick casing for the same reason: a mapping layer whose only job
/// is to rename things is a layer that eventually renames one wrong.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireGuardProfile {
    pub private_key: String,
    pub address: String,
    pub dns: String,
    pub server_public_key: String,
    pub endpoint: String,
    #[serde(rename = "allowedIPs")]
    pub allowed_ips: String,
    /// Package names to route, or empty for the whole device.
    #[serde(default)]
    pub allowed_apps: Vec<String>,
}

/// The Xray engines' equivalent of WireGuardProfile.
///
/// `config` arrives already built. See the note on the TypeScript side:
/// protocol knowledge belongs next to the credential types, not spread
/// across three languages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XrayProfile {
    pub config: String,
    pub protocol: String,
    pub dns: String,
    pub mtu: u32,
    #[serde(default)]
    pub allowed_apps: Vec<String>,
}

/// IKEv2's, which is barely a profile at all.
///
/// No config to build and no allowed-apps list: Android's platform VPN
/// profile has no equivalent of `IncludedApplications`, so per-app
/// routing is simply not available on this protocol and the caller
/// refuses the combination rather than silently tunnelling everything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ikev2Profile {
    /// The node's hostname. Never its address -- Android checks the
    /// server's certificate against what was dialled.
    pub server: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatus {
    pub connected: bool,
    pub protocol: Option<String>,
    /// Bytes carried, or null where the platform will not say.
    ///
    /// Optional for the same reason `last_handshake_age_secs` below is,
    /// and the argument there applies unchanged: null is the honest
    /// answer for "no evidence". iOS has no counters to read -- the
    /// tunnel runs in a separate extension process and NEVPNConnection
    /// exposes no byte totals to the app -- so the alternative was a
    /// zero, which reads as "nothing was carried" rather than "not
    /// known".
    ///
    /// They were required, and the iOS plugin sends neither, so every
    /// single `vpn_status` call on iOS failed to deserialise with
    /// "missing field `rxBytes`". Nothing in either client reads these
    /// values, which is why a permanently failing status call went
    /// unnoticed.
    pub rx_bytes: Option<i64>,
    pub tx_bytes: Option<i64>,
    /// Seconds since the last handshake, or null when there has not been
    /// one. Null is the honest answer for "no evidence", and the UI
    /// treats it differently from a stale number -- so it must never be
    /// filled in with a zero to keep the type simple.
    pub last_handshake_age_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub package_name: String,
    pub label: String,
    pub icon: Option<String>,
}

/// Tauri's Android bridge resolves a call with a JSObject, so every
/// answer needs a field to live in -- a bare boolean or array has
/// nowhere to go.
#[derive(Debug, Serialize, Deserialize)]
pub struct Granted {
    pub granted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Apps {
    pub apps: Vec<InstalledApp>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Empty {}

// Tauri's own macro rather than a hand-written extern: it emits the
// binding with the signature register_ios_plugin expects, and
// tauri::ios is private so the type cannot be named from here anyway.
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_neoxify_vpn);

pub struct Vpn<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("neoxify-vpn")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "NeoxifyVpnPlugin")?;
                _app.manage(Vpn(handle));
            }
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_neoxify_vpn)?;
                _app.manage(Vpn(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod status_contract_tests {
    use super::VpnStatus;

    /// Exactly what the iOS plugin sends back from `status`.
    ///
    /// It carries no counters and no handshake age, because iOS offers
    /// the app neither, and an extra `state` key that nothing reads.
    /// This failed for as long as iOS has had a status call.
    #[test]
    fn the_ios_status_payload_deserialises() {
        let payload = r#"{"connected":true,"state":"connected"}"#;
        let parsed = serde_json::from_str::<VpnStatus>(payload);
        assert!(parsed.is_ok(), "iOS status rejected: {:?}", parsed.err());
        let status = parsed.unwrap();
        assert!(status.connected);
        // Null, not zero. A zero here would be read as "nothing was
        // carried" by anything that later starts displaying these.
        assert_eq!(status.rx_bytes, None);
        assert_eq!(status.tx_bytes, None);
        assert_eq!(status.last_handshake_age_secs, None);
    }

    /// Android still sends numbers, and they must still arrive as
    /// numbers rather than being widened away.
    #[test]
    fn the_android_status_payload_still_carries_its_counters() {
        let payload = r#"{"connected":true,"protocol":"WIREGUARD","rxBytes":1024,
                          "txBytes":2048,"lastHandshakeAgeSecs":3}"#;
        let status = serde_json::from_str::<VpnStatus>(payload).expect("android status rejected");
        assert_eq!(status.rx_bytes, Some(1024));
        assert_eq!(status.tx_bytes, Some(2048));
        assert_eq!(status.last_handshake_age_secs, Some(3));
        assert_eq!(status.protocol.as_deref(), Some("WIREGUARD"));
    }
}
