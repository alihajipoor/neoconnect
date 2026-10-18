mod latency;

/// Which stage a failed control-plane request failed at, per address.
///
/// The Windows app's file, compiled here by path -- the same arrangement
/// as the UI, which this app takes from the Windows one through the
/// `@shared` alias -- so the two apps cannot classify the same failure
/// differently. Its tests run with either crate's.
#[path = "../../../desktop-windows/src-tauri/src/control_plane_probe.rs"]
mod control_plane_probe;

/// `/health/ip` over IPv4 only, for the egress check -- the Windows app's
/// file, compiled here by path like the probe above.
///
/// Through tauri-plugin-http the system picks the family. On a dual-stack
/// network the baseline, taken with no tunnel up, came back over IPv6;
/// every reading through the tunnel is IPv4 -- Android's VpnService
/// claims no IPv6 and blocks it for the apps inside, and iOS claims it
/// so it cannot leave beside the tunnel, but no node carries it.
/// `verifyEgress` will not compare two families, so
/// every rung read "indeterminate": each one but the last was torn down
/// as not carrying, and the one that landed was "not confirmed" for the
/// whole session. With both readings over IPv4 the comparison means
/// something again. Installed from `src/main.tsx`.
#[path = "../../../desktop-windows/src-tauri/src/health_ip.rs"]
mod health_ip;

/// The relay of last resort -- the Windows app's file, compiled here by
/// path like the two above, so both apps hold the one list of calls a
/// relay may carry and check its pins the same way.
///
/// For a customer on a network where every ordinary route to the API is
/// blocked: an allowed call, sent to a box in Iran by IPv4 address with
/// no SNI and accepted by SPKI pin. Phones are most of those customers.
#[path = "../../../desktop-windows/src-tauri/src/relay_http.rs"]
mod relay_http;

/// The HTTP scope for the hosts a signed endpoint bundle names -- the
/// Windows app's file again. The scope written at build time knows only
/// the seed bundle's hosts; this grants a newer bundle's once its
/// signature checks out, so moving customers to a new domain or a bare
/// address needs no release.
#[path = "../../../desktop-windows/src-tauri/src/bundle_scope.rs"]
mod bundle_scope;

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
            build_platform,
            control_plane_probe::probe_control_plane,
            // And its stop, for when a connect starts while it runs.
            control_plane_probe::cancel_control_plane_probe,
            // The egress check's transport; see `mod health_ip` above.
            // Absent here, every reading would reject as "no answer" and
            // no connect could ever be proven.
            health_ip::health_ip_v4,
            // A tunnel server's name as the engines resolve it, for the
            // same check. Absent, a server named by hostname (IKEv2's)
            // would go unrecognised in `health_ip_v4`'s peer address.
            health_ip::resolve_ipv4,
            // The relay of last resort; see `mod relay_http` above.
            relay_http::relay_request,
            // A signed bundle's hosts into the HTTP scope; see
            // `mod bundle_scope` above.
            bundle_scope::grant_bundle_scope
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod bundle_scope_runtime {
    use std::collections::BTreeSet;

    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindowBuilder};

    /// The HTTP plugin's `fetch`, which checks the scope before it builds
    /// a request: an error naming the scope, or a request id.
    fn fetch(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, url: &str) -> Result<String, String> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: "plugin:http|fetch".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({
                    "clientConfig": { "method": "GET", "url": url, "headers": [], "data": null }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| format!("{:?}", body))
        .map_err(|err| format!("{:?}", err))
    }

    /// With this app's own generated ACL -- the one a release carries --
    /// a host outside the build-time scope is refused, then reached once
    /// granted, and nothing panics on the way: add_capability unwraps its
    /// resolution, so a capability it could not resolve would take the
    /// app down at the first bundle it read.
    #[test]
    fn a_granted_host_passes_the_http_scope() {
        let app = mock_builder()
            .plugin(tauri_plugin_http::init())
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let webview = match app.get_webview_window("main") {
            Some(webview) => webview,
            None => WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("window"),
        };
        let url = "https://198.51.100.250:2096/api/health";

        let before = fetch(&webview, url);
        assert!(before.as_ref().is_err_and(|e| e.contains("not allowed")), "before: {before:?}");

        let host: BTreeSet<String> = ["198.51.100.250".to_owned()].into();
        assert_eq!(crate::bundle_scope::grant_hosts(app.handle(), host.clone()), Ok(vec!["198.51.100.250".to_owned()]));
        // Granted once: asking again adds nothing.
        assert_eq!(crate::bundle_scope::grant_hosts(app.handle(), host), Ok(vec![]));

        let after = fetch(&webview, url);
        assert!(after.is_ok(), "after: {after:?}");
        // And only that host.
        let other = fetch(&webview, "https://198.51.100.251:2096/api/health");
        assert!(other.as_ref().is_err_and(|e| e.contains("not allowed")), "other: {other:?}");
    }
}
