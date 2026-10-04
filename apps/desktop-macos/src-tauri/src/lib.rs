mod vpn;

/// Builds and runs the macOS app.
///
/// The plugin list deliberately mirrors the Windows app's, minus the
/// ones with no macOS meaning, so that the shared UI finds the same
/// capabilities under it on both desktops. A missing plugin here does
/// not fail at build time -- it fails at runtime, inside whichever
/// screen happens to call it first, which is a much worse place to find
/// out.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            vpn::vpn_status,
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_diagnostics,
            vpn::vpn_exit_placements,
            vpn::measure_latency,
            vpn::vpn_repair,
            vpn::vpn_probe_split_tunnel,
            vpn::vpn_set_split_tunnel,
            vpn::vpn_list_running_apps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
