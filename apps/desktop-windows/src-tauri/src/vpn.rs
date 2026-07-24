// WireGuard tunnel lifecycle -- bundles the real, official
// wireguard.exe (same one wireguard.com ships, BSD-licensed) rather
// than reimplementing the protocol, same philosophy the server-side
// agent was built on (see agent/internal/protocols/wireguard). This
// module only manages the .conf file + the Windows tunnel service
// wireguard.exe itself creates and drives; it never touches
// cryptography or packet handling directly.
use runas::Command as ElevatedCommand;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const TUNNEL_NAME: &str = "neoconnect";

// Field names match exactly what
// apps/backend/src/modules/protocol-users/generate-credentials.ts
// returns for Protocol.WIREGUARD -- already a complete, directly-usable
// WireGuard peer config (M4's deliberate design), no server-side lookup
// needed beyond what's already in the customer's own credentials.
#[derive(Debug, Deserialize)]
pub struct WireGuardCredentials {
    #[serde(rename = "privateKey")]
    private_key: String,
    address: String,
    dns: Option<String>,
    #[serde(rename = "allowedIPs")]
    allowed_ips: String,
    #[serde(rename = "serverPublicKey")]
    server_public_key: String,
    endpoint: String,
}

fn wireguard_exe_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/wireguard.exe", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not resolve wireguard.exe path: {e}"))
}

fn tunnel_conf_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app config directory: {e}"))?;
    Ok(dir.join(format!("{TUNNEL_NAME}.conf")))
}

fn build_conf(creds: &WireGuardCredentials) -> String {
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = {}\nDNS = {}\n\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\nEndpoint = {}\nPersistentKeepalive = 25\n",
        creds.private_key,
        creds.address,
        creds.dns.as_deref().unwrap_or("1.1.1.1"),
        creds.server_public_key,
        creds.allowed_ips,
        creds.endpoint,
    )
}

// `wireguard.exe /installtunnelservice <conf>` is the real, official
// mechanism (the same one the official WireGuard for Windows client
// uses under the hood) -- it registers and starts a Windows service for
// this tunnel, auto-installing the WireGuardNT driver on first use.
//
// Installing/removing a Windows service requires administrator rights.
// Rather than forcing the whole app to run elevated (worse UX -- a UAC
// prompt on every launch, even to just view subscription status), only
// this specific subprocess is elevated via ShellExecute's "runas" verb
// (the `runas` crate), so the UAC prompt appears only on Connect/Disconnect.
#[tauri::command]
pub async fn connect_wireguard(app: tauri::AppHandle, credentials: WireGuardCredentials) -> Result<(), String> {
    let conf_path = tunnel_conf_path(&app)?;
    fs::write(&conf_path, build_conf(&credentials)).map_err(|e| format!("could not write tunnel config: {e}"))?;

    let exe = wireguard_exe_path(&app)?;
    let status = ElevatedCommand::new(&exe)
        .arg("/installtunnelservice")
        .arg(&conf_path)
        .status()
        .map_err(|e| format!("could not run wireguard.exe elevated (looked for it at {exe:?}): {e}"))?;

    if !status.success() {
        return Err(format!("wireguard.exe /installtunnelservice exited with {status}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn disconnect_wireguard(app: tauri::AppHandle) -> Result<(), String> {
    let exe = wireguard_exe_path(&app)?;
    let status = ElevatedCommand::new(&exe)
        .arg("/uninstalltunnelservice")
        .arg(TUNNEL_NAME)
        .status()
        .map_err(|e| format!("could not run wireguard.exe elevated (looked for it at {exe:?}): {e}"))?;

    if !status.success() {
        return Err(format!("wireguard.exe /uninstalltunnelservice exited with {status}"));
    }
    Ok(())
}
