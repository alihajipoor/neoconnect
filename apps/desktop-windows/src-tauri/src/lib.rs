mod vpn;

use tauri_plugin_deep_link::DeepLinkExt;

// Holds the neoconnect:// URL this instance was launched with, if any --
// read directly from the process's own argv rather than trusting the
// deep-link plugin's `getCurrent()` JS API for the cold-launch case.
// Real bug found live: launching the release build via a genuine
// `neoconnect://...` link (confirmed via the process's own command line
// containing the URL) still left `getCurrent()` returning nothing to the
// frontend -- the app opened straight to a plain, unnotified Login
// screen instead of processing the token. Since the URL is unambiguously
// present in argv (this is exactly what the registered
// `"...\neoconnect-desktop.exe" "%1"` command line hands us), reading it
// ourselves and exposing it via a plain command is a strictly more
// reliable fallback than depending on the plugin's own capture path.
struct LaunchDeepLink(Option<String>);

#[tauri::command]
fn get_launch_deep_link(state: tauri::State<LaunchDeepLink>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_url = std::env::args().find(|a| a.starts_with("neoconnect://"));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(LaunchDeepLink(launch_url))
        .setup(|app| {
            // Static scheme registration in tauri.conf.json alone doesn't
            // actually take effect with the NSIS installer target this
            // project uses (a documented Tauri bug -- MSI is unaffected,
            // NSIS is not) -- confirmed via Tauri's own issue tracker
            // before writing this, not assumed. Registering at runtime
            // instead sidesteps it entirely: every launch re-writes the
            // registry association, so this self-heals even for an
            // already-installed app, no reinstall required. Desktop-only
            // (Windows/Linux); macOS has no runtime API and must rely on
            // static config there instead, which isn't a concern yet --
            // this app is Windows-only for now.
            #[cfg(desktop)]
            app.deep_link().register("neoconnect")?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn::connect_wireguard,
            vpn::disconnect_wireguard,
            get_launch_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
