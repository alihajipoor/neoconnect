mod latency;

/// The OS this binary was compiled for: "android" or "ios" here, as the
/// platform on attempt reports.
///
/// Up to 0.2.21 the shared attempts.ts guessed from the user agent and
/// said "windows" for anything that was not Android, so every iOS report
/// was filed as a Windows one. 0.2.22 improved the guess; this replaces
/// it. An iPad is "ios" whatever its webview claims to be, and nothing a
/// build script or a WebView update does can change the answer. The
/// Windows client registers the same command.
#[tauri::command]
fn build_platform() -> &'static str {
    std::env::consts::OS
}

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
            tauri_plugin_neoxify_vpn::vpn_connect_ikev2,
            tauri_plugin_neoxify_vpn::vpn_disconnect,
            tauri_plugin_neoxify_vpn::vpn_forget_profiles,
            tauri_plugin_neoxify_vpn::vpn_tunnel_gone,
            tauri_plugin_neoxify_vpn::vpn_status,
            tauri_plugin_neoxify_vpn::vpn_list_apps,
            tauri_plugin_neoxify_vpn::vpn_sign_in_with_apple,
            tauri_plugin_neoxify_vpn::vpn_open_auth_session,
            tauri_plugin_neoxify_vpn::vpn_iap_products,
            tauri_plugin_neoxify_vpn::vpn_iap_purchase,
            tauri_plugin_neoxify_vpn::vpn_iap_unfinished,
            tauri_plugin_neoxify_vpn::vpn_iap_finish,
            // The location picker calls this for every route. Absent
            // here, every call rejected and every server showed "--"
            // where its latency should be -- for the whole life of the
            // Android client, because the command was only ever added
            // to the Windows one.
            latency::measure_latency,
            // The connect ladder's pre-dial reachability probe, shared
            // with the Windows client. Same story as the line above: it
            // only existed there, so on the phones it always rejected.
            latency::probe_tcp,
            build_platform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
