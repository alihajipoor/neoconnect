//! WireGuard via the official wireguard.exe.
//!
//! `/installtunnelservice` is the same mechanism the official WireGuard
//! for Windows client uses: it registers a Windows service for the
//! tunnel and auto-installs the WireGuardNT driver on first use. Because
//! this helper already runs as LocalSystem, that call needs no
//! elevation and produces no UAC prompt -- which is the entire reason
//! this service exists (the app used to shell out to it via `runas`,
//! prompting the user on every single Connect).

use std::ffi::OsStr;

use neoconnect_ipc::WireguardProfile;
use windows_service::service::ServiceAccess;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use super::{run_hidden, write_config, Engines};

const TUNNEL_NAME: &str = "neoconnect";
const CONF_FILE: &str = "neoconnect.conf";

/// wireguard.exe derives the tunnel's service name from the config file
/// name, so this is fixed by CONF_FILE above, not chosen independently.
const TUNNEL_SERVICE_NAME: &str = "WireGuardTunnel$neoconnect";

fn build_conf(p: &WireguardProfile) -> String {
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = {}\nDNS = {}\n\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\nEndpoint = {}\nPersistentKeepalive = 25\n",
        p.private_key,
        p.address,
        p.dns.as_deref().unwrap_or("1.1.1.1"),
        p.server_public_key,
        p.allowed_ips,
        p.endpoint,
    )
}

pub fn connect(engines: &Engines, profile: &WireguardProfile) -> Result<(), String> {
    let exe = engines.engine_path("wireguard.exe")?;
    let conf_path = engines.config_path(CONF_FILE);
    write_config(&conf_path, &build_conf(profile))?;

    let status = run_hidden(&exe, &[OsStr::new("/installtunnelservice"), conf_path.as_os_str()])
        .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /installtunnelservice exited with {status}"));
    }
    Ok(())
}

pub fn disconnect(engines: &Engines) -> Result<(), String> {
    let exe = engines.engine_path("wireguard.exe")?;
    let status = run_hidden(&exe, &[OsStr::new("/uninstalltunnelservice"), OsStr::new(TUNNEL_NAME)])
        .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /uninstalltunnelservice exited with {status}"));
    }
    Ok(())
}

/// Best-effort teardown for the case where this service has no record of
/// a tunnel but one may still exist -- e.g. the service was restarted
/// while connected. Failure is not reported: "there was nothing to
/// remove" is the expected outcome most of the time.
pub fn remove_tunnel_if_present(engines: &Engines) {
    if !tunnel_is_running() {
        return;
    }
    let _ = disconnect(engines);
}

/// Asks the service manager whether the tunnel service exists at all.
/// Opening it is enough -- a tunnel service that exists is one
/// wireguard.exe created and has not torn down.
pub fn tunnel_is_running() -> bool {
    let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
        return false;
    };
    manager.open_service(TUNNEL_SERVICE_NAME, ServiceAccess::QUERY_STATUS).is_ok()
}
