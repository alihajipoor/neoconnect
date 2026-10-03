//! The macOS half of the command surface the shared UI invokes.
//!
//! Nothing here carries traffic yet. The tunnel itself is Swift --
//! `NEPacketTunnelProvider`, reused from the iOS plugin, which needs no
//! port because NetworkExtension is the same framework on both -- and it
//! runs in a System Extension rather than in this process. This module
//! is the Rust side of the bridge to it.
//!
//! Every command that cannot yet be honoured returns an error saying so,
//! rather than a plausible-looking default. That is deliberate and it is
//! the whole reason this file exists in this shape: a `vpn_connect` that
//! quietly resolved, or a `vpn_status` that invented
//! `connected: true`, would show a customer a connected interface over
//! no tunnel at all. On a VPN that is not a cosmetic bug -- it is the
//! user believing their traffic is protected while it is in the clear.
//! An honest failure is worth more than a convincing stub.

use serde::Serialize;

/// Mirrors the `VpnStatus` the shared UI reads in
/// `lib/connection-evidence.ts`. Only the fields that type requires are
/// here; the optional ones describe Windows split-tunnelling and
/// IPv6-blocking machinery that has no macOS equivalent yet, and
/// omitting them is how the UI is told so.
#[derive(Serialize)]
pub struct VpnStatus {
    pub connected: bool,
    pub protocol: Option<String>,
}

/// What the UI gets for anything the macOS build cannot do yet.
///
/// One message, used everywhere, and phrased for whoever reads it in a
/// log rather than for a customer -- no customer should ever see it,
/// because the build that ships to them will have the tunnel.
fn not_yet(what: &str) -> String {
    format!("{what} is not implemented in the macOS build yet")
}

#[tauri::command]
pub fn vpn_status() -> VpnStatus {
    // Honest, and the only command here that can answer truthfully
    // without a tunnel: there is no tunnel, so nothing is connected.
    VpnStatus { connected: false, protocol: None }
}

#[tauri::command]
pub fn vpn_connect() -> Result<(), String> {
    Err(not_yet("Connecting"))
}

#[tauri::command]
pub fn vpn_disconnect() -> Result<(), String> {
    // Not an error even though there is nothing to disconnect: the UI
    // calls this defensively on startup and when switching accounts, and
    // failing there would surface an error for a state that is correct.
    Ok(())
}

#[tauri::command]
pub fn vpn_diagnostics() -> Result<String, String> {
    Err(not_yet("Diagnostics"))
}

#[tauri::command]
pub fn vpn_exit_placements() -> Result<Vec<String>, String> {
    Err(not_yet("Exit placements"))
}

#[tauri::command]
pub fn measure_latency(_host: String, _port: u16) -> Result<u64, String> {
    Err(not_yet("Latency measurement"))
}

#[tauri::command]
pub fn vpn_repair() -> Result<(), String> {
    Err(not_yet("Repair"))
}

/// Split tunnelling is Windows-only today and may stay that way.
///
/// The Windows implementation is built on WinDivert, which has no macOS
/// counterpart; the Apple equivalent is a content-filter provider, a
/// different design rather than a port. Reported as unsupported rather
/// than unimplemented, because the UI should be able to tell "not yet"
/// from "not here".
#[tauri::command]
pub fn vpn_probe_split_tunnel() -> Result<bool, String> {
    Err("Split tunnelling is not available on macOS".into())
}

#[tauri::command]
pub fn vpn_set_split_tunnel(_enabled: bool) -> Result<(), String> {
    Err("Split tunnelling is not available on macOS".into())
}

#[tauri::command]
pub fn vpn_list_running_apps() -> Result<Vec<String>, String> {
    Err("Split tunnelling is not available on macOS".into())
}
