mod latency;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Registers the Kotlin side and stashes its handle. Only the
        // setup hook is a plugin; the commands below are the app's own,
        // so they need no capability entries.
        .plugin(tauri_plugin_neoxify_vpn::init())
        .invoke_handler(tauri::generate_handler![
            tauri_plugin_neoxify_vpn::vpn_has_permission,
            tauri_plugin_neoxify_vpn::vpn_request_permission,
            tauri_plugin_neoxify_vpn::vpn_connect_wireguard,
            tauri_plugin_neoxify_vpn::vpn_connect_xray,
            tauri_plugin_neoxify_vpn::vpn_disconnect,
            tauri_plugin_neoxify_vpn::vpn_status,
            tauri_plugin_neoxify_vpn::vpn_list_apps,
            // The location picker calls this for every route. Absent
            // here, every call rejected and every server showed "--"
            // where its latency should be -- for the whole life of the
            // Android client, because the command was only ever added
            // to the Windows one.
            latency::measure_latency
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
