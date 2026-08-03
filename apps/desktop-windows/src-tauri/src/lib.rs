mod vpn;

use tauri::{Emitter, Manager};
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
        // Must be registered first, so a duplicate launch is turned away
        // before it initialises anything else.
        //
        // A second window is not merely untidy here: each instance polls
        // the same subscription and drives the same helper service, which
        // owns exactly one tunnel. Two of them disagreeing about whether
        // to connect means one silently tears down the other's tunnel.
        // Reported after a customer found they could open the app as many
        // times as they liked.
        //
        // The existing instance is focused instead, and any deep link the
        // duplicate was launched with is forwarded to it -- otherwise
        // clicking a verification link while the app was already open
        // would do nothing at all.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(url) = argv.iter().find(|a| a.starts_with("neoconnect://")) {
                let _ = app.emit("deep-link-received", url.clone());
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // The native file picker, used only to choose which executables
        // Custom mode routes. `dialog:allow-open` is the single
        // permission granted for it -- notably not save or message, so a
        // compromised webview cannot write files or raise dialogs of its
        // own.
        .plugin(tauri_plugin_dialog::init())
        // Copying a referral code. Write-only in the capability below:
        // the app has no reason to read whatever the customer last
        // copied, and asking for it would be the kind of permission a
        // VPN client should never hold.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_set_split_tunnel,
            vpn::vpn_probe_split_tunnel,
            vpn::vpn_status,
            vpn::measure_latency,
            vpn::network_fingerprint,
            get_launch_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
