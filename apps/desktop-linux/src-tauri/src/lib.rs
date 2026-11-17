//! The Linux app: the Windows app's interface in a WebKitGTK window, and
//! the commands that interface invokes.
//!
//! The modules with no Windows in them are the Windows app's own files,
//! pulled in by path and not edited, so a fix to either client is a fix to
//! both. The rest are this app's: vpn.rs (the helper over a Unix socket and
//! the network tables from /proc), linux_requests.rs (the helper requests
//! only Linux has), update.rs (downloading an update and relaunching),
//! apps.rs (Custom mode's picker, from desktop entries), activation.rs
//! (raising the window for a second launch on Wayland), autostart.rs (an
//! XDG autostart entry) and notify.rs (D-Bus notifications).

#[path = "../../../desktop-windows/src-tauri/src/bundle_scope.rs"]
mod bundle_scope;
#[path = "../../../desktop-windows/src-tauri/src/control_plane_probe.rs"]
mod control_plane_probe;
#[path = "../../../desktop-windows/src-tauri/src/door_http.rs"]
mod door_http;
#[path = "../../../desktop-windows/src-tauri/src/health_ip.rs"]
mod health_ip;
#[path = "../../../desktop-windows/src-tauri/src/relay_http.rs"]
mod relay_http;
#[path = "../../../desktop-windows/src-tauri/src/window_fit.rs"]
mod window_fit;

mod activation;
mod apps;
mod autostart;
mod linux_requests;
mod notify;
mod opener_scope;
mod update;
mod vpn;

use tauri::{Emitter, Manager};

/// The neoconnect:// URL this instance was launched with, read from argv
/// as the Windows app does: the desktop entry runs `neoxify %u`, and argv
/// is a surer source for a cold launch than the plugin's own capture.
struct LaunchDeepLink(Option<String>);

/// The WebKitGTK version, read at start, for Support's diagnostics.
struct WebviewVersion(Option<String>);

/// How often to tell the helper this app is still running: comfortably
/// inside a minute, and from Rust so a throttled webview cannot miss it.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

#[tauri::command]
fn get_launch_deep_link(state: tauri::State<LaunchDeepLink>) -> Option<String> {
    state.0.clone()
}

/// The OS this binary was compiled for: "linux". From the compile target,
/// never the user agent, which once reported iOS builds as Windows.
#[tauri::command]
fn build_platform() -> &'static str {
    std::env::consts::OS
}

/// The real WebKitGTK version. There is no "too old" floor on Linux: Tauri
/// v2 needs WebKitGTK 4.1, and every distribution that ships it draws the
/// interface.
#[tauri::command]
fn webview_version(state: tauri::State<WebviewVersion>) -> Option<String> {
    state.0.clone()
}

pub fn run() {
    // First, while this is the only thread: it changes PATH, so that what
    // the app opens is not let through the reconnect hold with it.
    opener_scope::install();
    let launch_url = std::env::args().find(|a| a.starts_with("neoconnect://"));
    let webview = tauri::webview_version().ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

    // The main window is made by `setup()`, at its remembered size and
    // place, rather than from the config before it (window_fit.rs).
    let mut context = tauri::generate_context!();
    window_fit::defer_main_window(&mut context.config_mut().app.windows);

    // Before the single-instance plugin, which ends a second instance
    // without passing its environment on (activation.rs).
    activation::leave_for_running_instance();

    tauri::Builder::default()
        // First, so a second launch is turned away before anything else
        // starts. Two instances would drive the one helper and could tear
        // down each other's tunnel. The running one is shown instead, and a
        // link the second was opened with is handed to it.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // The token must reach GTK before the window is presented,
                // and GTK only on the main thread; the plugin's callback
                // may not be on it.
                let token = activation::take();
                let target = window.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(token) = token {
                        activation::apply(&target, &token);
                    }
                    let _ = target.unminimize();
                    let _ = target.show();
                    let _ = target.set_focus();
                });
            }
            if let Some(url) = argv.iter().find(|a| a.starts_with("neoconnect://")) {
                let _ = app.emit("deep-link-received", url.clone());
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        // The scheme is registered by the package's desktop entry
        // (MimeType=x-scheme-handler/neoconnect), not at runtime: a runtime
        // registration would write a per-user entry pointing at whichever
        // binary ran last, a development build included.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .manage(LaunchDeepLink(launch_url))
        .manage(WebviewVersion(webview))
        .manage(update::Downloaded::default())
        .setup(|app| {
            // Only the first instance gets here; a token in the channel is
            // its own launch's, already used by GTK, or a stale one.
            activation::forget();
            window_fit::create_main_window(app, None)?;
            // Tells the helper the app is still here, so a helper that
            // tears down an abandoned tunnel can tell a crash from a quiet
            // window. A failure means the helper is not there, which is
            // its own problem and not one to solve by stopping.
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(HEARTBEAT_INTERVAL).await;
                    let _ = vpn::vpn_status().await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_disconnect_for_reconnect,
            vpn::vpn_release_reconnect_hold,
            vpn::vpn_set_reconnect_hold,
            vpn::vpn_set_split_tunnel,
            vpn::vpn_exit_placements,
            vpn::vpn_probe_split_tunnel,
            vpn::vpn_list_running_apps,
            vpn::vpn_status,
            vpn::vpn_repair,
            vpn::vpn_diagnostics,
            vpn::repair_command_line,
            linux_requests::vpn_linux_diagnostics,
            linux_requests::linux_update_support,
            linux_requests::linux_update_install,
            linux_requests::linux_update_outcome,
            update::linux_update_download,
            update::linux_relaunch,
            vpn::gaming_arm,
            vpn::gaming_disarm,
            vpn::gaming_status,
            vpn::probe_ipv6_egress,
            vpn::probe_ipv4_egress,
            health_ip::health_ip_v4,
            health_ip::resolve_ipv4,
            health_ip::data_check_v4,
            vpn::measure_latency,
            vpn::probe_tcp,
            vpn::network_fingerprint,
            vpn::network_way_out,
            vpn::network_uplinks,
            get_launch_deep_link,
            build_platform,
            webview_version,
            control_plane_probe::probe_control_plane,
            control_plane_probe::cancel_control_plane_probe,
            relay_http::relay_request,
            door_http::door_request,
            bundle_scope::grant_bundle_scope,
            autostart::autostart_state,
            autostart::set_autostart,
            notify::notify_show,
            notify::notify_setting
        ])
        // Closing the window is an instruction to disconnect, acted on
        // before the process exits rather than left to the helper to infer
        // a minute later: somebody who closed the app must not stay
        // tunnelled with nothing on screen to say so.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window_fit::remember_size(window);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = tauri::async_runtime::block_on(vpn::vpn_disconnect());
            }
        })
        .run(context)
        .expect("error while running tauri application");
}
