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

/// How often to tell the service this app is still running.
///
/// Comfortably inside the service's sixty-second idle grace, and
/// deliberately not derived from it: the two live in different crates,
/// and a heartbeat that is merely equal to the timeout it is meant to
/// beat is the bug this exists to remove.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

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

            // Tells the service this app is still here.
            //
            // The service tears a tunnel down when it has heard nothing
            // from us for a while -- that is what stops a tunnel
            // outliving the app that started it. But the only thing that
            // was speaking to it was the dashboard's status poll, and
            // that runs in the webview, where Windows throttles timers
            // in a minimized window to roughly one a minute. The grace
            // period is sixty seconds, so a customer who minimized the
            // app was relying on two numbers that are the same size.
            //
            // A beat from here does not depend on the webview being
            // awake, or even on a window existing. When this process
            // ends it stops on its own, which is exactly the condition
            // the service is trying to detect.
            tauri::async_runtime::spawn(async {
                loop {
                    tokio::time::sleep(HEARTBEAT_INTERVAL).await;
                    // The reply is not interesting; being asked is. A
                    // failure means the service is not there, which is
                    // its own problem and not one to solve by stopping.
                    let _ = vpn::vpn_status().await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_set_split_tunnel,
            vpn::vpn_probe_split_tunnel,
            vpn::vpn_list_running_apps,
            vpn::vpn_status,
            // "Repair my network", and the two things that go with it:
            // the snapshot Support pastes, and the elevated command to
            // print when the service cannot be reached at all -- which
            // is exactly the case the button cannot serve.
            vpn::vpn_repair,
            vpn::vpn_diagnostics,
            vpn::repair_command_line,
            vpn::gaming_arm,
            vpn::gaming_disarm,
            vpn::gaming_status,
            // Asked from a socket rather than the frontend's fetch: the
            // app's HTTP permission is scoped to *.neoxify.site, so a
            // probe address would be refused by the ACL and the check
            // would always answer "no IPv6". See vpn::probe_ipv6_egress.
            vpn::probe_ipv6_egress,
            vpn::measure_latency,
            vpn::network_fingerprint,
            get_launch_deep_link
        ])
        // Closing the window is an instruction, and it has to be acted
        // on rather than inferred.
        //
        // The service tears a tunnel down once the app has been silent
        // for a minute, which is right for a crash and wrong for this:
        // somebody who closes the app is still tunnelled for up to
        // sixty seconds afterwards, with nothing on screen to say so
        // and nothing left to press. Reported exactly that way -- "even
        // now that I closed the vpn app the vpn connection is still
        // going on" -- and it is the same failure as leaving a tunnel
        // up after the app forgets it, only slower.
        //
        // Blocking on purpose: the process is about to exit, and a
        // disconnect that races the exit is no disconnect at all.
        //
        // Gaming mode goes the same way, and for a sharper version of
        // the same reason. Its NRPT rules point every one of the game's
        // lookups at a loopback stub that only exists while the service
        // holds it, and the service's idle watchdog is a minute behind
        // -- so closing the app would leave a window where the game
        // simply will not resolve, with nothing on screen to explain
        // it. Rules must not outlive the app.
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = tauri::async_runtime::block_on(vpn::vpn_disconnect());
                let _ = tauri::async_runtime::block_on(vpn::gaming_disarm());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
