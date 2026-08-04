//! The commands the UI calls.
//!
//! Their own module rather than the crate root, and not by taste:
//! `#[tauri::command]` emits a macro plus a `pub use` of it, and in the
//! root of a library crate those two collide with each other. Official
//! Tauri plugins put their commands in a submodule for the same reason.

use crate::{Apps, Empty, Granted, VpnStatus, WireGuardProfile};
#[cfg(target_os = "android")]
use crate::Vpn;
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;

/// Why a call cannot be served off Android.
///
/// This app has no desktop target; the fallbacks below exist so a
/// `cargo check` on the dev machine compiles and fails with a sentence
/// rather than panicking inside Tauri's state extractor.
#[allow(dead_code)]
fn unavailable() -> String {
    "The VPN engine is only available on Android".to_string()
}

/// The Kotlin handle, looked up rather than taken as a `State` argument
/// so the miss is a returned error instead of an extractor panic.
#[cfg(target_os = "android")]
fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Vpn<R>>, String> {
    app.try_state::<Vpn<R>>().ok_or_else(unavailable)
}

// Six commands, each a single forwarding call. Written out rather than
// generated: `#[tauri::command]` emits a macro named after the function,
// and expanding that from inside a `macro_rules!` collides with itself.

#[tauri::command]
pub async fn vpn_has_permission<R: Runtime>(app: AppHandle<R>) -> Result<Granted, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Granted>("hasPermission", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_request_permission<R: Runtime>(app: AppHandle<R>) -> Result<Granted, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Granted>("requestPermission", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_connect_wireguard<R: Runtime>(
    app: AppHandle<R>,
    profile: WireGuardProfile,
) -> Result<Empty, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("connectWireguard", profile)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, profile);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_disconnect<R: Runtime>(app: AppHandle<R>) -> Result<Empty, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("disconnect", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_status<R: Runtime>(app: AppHandle<R>) -> Result<VpnStatus, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<VpnStatus>("status", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_list_apps<R: Runtime>(app: AppHandle<R>) -> Result<Apps, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Apps>("listApps", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}
