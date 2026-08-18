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
#[cfg(target_os = "android")]
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
    pub rx_bytes: i64,
    pub tx_bytes: i64,
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

pub struct Vpn<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("neoxify-vpn")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "NeoxifyVpnPlugin")?;
                _app.manage(Vpn(handle));
            }
            Ok(())
        })
        .build()
}
