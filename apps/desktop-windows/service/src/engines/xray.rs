//! Xray VLESS+REALITY via the official xray.exe.
//!
//! Full-tunnel on Windows uses xray-core's own `tun` inbound (a
//! first-party inbound, not tun2socks or another external tool), which
//! creates a Wintun adapter and feeds raw packets into Xray's routing
//! engine. Two upstream requirements drive the details below:
//!
//! * `wintun.dll` for the right architecture must sit next to
//!   xray.exe -- it is loaded at runtime, so a missing DLL fails only
//!   once a tunnel is actually attempted. This checks for it up front to
//!   turn that into a clear message instead of an opaque engine exit.
//! * Routing `0.0.0.0/0` into the TUN naively causes an infinite loop,
//!   because Xray's own outbound to the node has to reach the internet
//!   like anything else. `autoSystemRoutingTable` installs the system
//!   routes and `autoOutboundsInterface` pins outbound traffic to the
//!   real physical interface, which is upstream's own answer to that
//!   loop rather than something improvised here.

use std::ffi::OsStr;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::process::Child;

use neoconnect_ipc::XrayProfile;
use serde_json::json;

use super::routing::{self, InstalledRoutes};
use super::{confirm_started, spawn_hidden, write_config, Engines};
use crate::adapters;

const CONFIG_FILE: &str = "xray-client.json";
const LOG_FILE: &str = "xray.log";
const ADAPTER_NAME: &str = "neoconnect0";

/// How long to wait for the TUN adapter to show up after Xray starts.
///
/// Creating a Wintun adapter involves the driver and Windows' network
/// stack, so it is not instant and not fixed -- polling until it appears
/// is more reliable than picking a single sleep long enough to "usually"
/// work.
const ADAPTER_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Address for the TUN adapter itself, from the RFC 2544 benchmarking
/// range. That range is reserved, never routed on the public internet,
/// and effectively never used on a home or office LAN, so claiming it
/// can't collide with a customer's own network the way an RFC1918 pick
/// might.
///
/// This was originally a link-local 169.254.x address, chosen for the
/// same anti-collision reason -- but that range is Windows' APIPA
/// space, and Windows would not route through it. The adapter came up,
/// self-assigned an APIPA address, and only link-local chatter (NetBIOS
/// broadcasts and the like) ever entered the tunnel while real traffic
/// went out the physical interface. The tunnel looked connected and
/// changed nothing.
const TUN_GATEWAY: &str = "198.18.0.1/30";

fn build_config(p: &XrayProfile) -> String {
    // Built through serde_json rather than string formatting so every
    // value is escaped by construction -- config injection through a
    // credential field isn't possible here even before validation.
    let config = json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "tun-in",
            "protocol": "tun",
            "settings": {
                "name": "neoconnect0",
                "desc": "Wintun",
                "mtu": 1500,
                "gateway": [TUN_GATEWAY],
                "autoSystemRoutingTable": true,
                "autoOutboundsInterface": true
            }
        }],
        "outbounds": [{
            "tag": "proxy",
            "protocol": "vless",
            "settings": {
                "vnext": [{
                    "address": p.host,
                    "port": p.port,
                    "users": [{
                        "id": p.uuid,
                        "encryption": "none",
                        "flow": p.flow
                    }]
                }]
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "serverName": p.server_name,
                    "fingerprint": "chrome",
                    "publicKey": p.reality_public_key,
                    "shortId": p.short_id
                }
            }
        }]
    });
    config.to_string()
}

/// Waits for Xray's TUN adapter to appear and returns its interface index.
fn wait_for_adapter() -> Result<u32, String> {
    let deadline = std::time::Instant::now() + ADAPTER_WAIT;
    loop {
        match adapters::find_by_name(ADAPTER_NAME) {
            Ok(Some(a)) => return Ok(a.index),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Ok(None) => {
                return Err(format!(
                    "Xray started but its network adapter ({ADAPTER_NAME}) never appeared"
                ))
            }
            Err(e) => return Err(format!("could not enumerate network adapters: {e}")),
        }
    }
}

/// Resolves the server's address to an IPv4 address for the bypass route.
///
/// Nodes are registered by IP today, but a hostname is resolved rather
/// than rejected so a DNS-named node doesn't silently produce a tunnel
/// with no escape route for its own uplink.
fn resolve_server(host: &str, port: u16) -> Result<Ipv4Addr, String> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {host}: {e}"))?
        .find_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("{host} has no IPv4 address to route around the tunnel"))
}

/// Brings up the routes that actually put traffic through the tunnel.
///
/// Split out from `connect` so a routing failure can tear down the engine
/// it belongs to -- a running Xray with no routes is the exact state that
/// previously looked connected while changing nothing.
pub fn install_routes(profile: &XrayProfile) -> Result<InstalledRoutes, String> {
    let server_ip = resolve_server(&profile.host, profile.port)?;

    // Captured before the tunnel takes over: afterwards the best route to
    // the server would be the tunnel itself, and the bypass would point
    // into the loop it exists to prevent.
    let uplink = adapters::physical_uplink(&[ADAPTER_NAME])
        .map_err(|e| format!("could not enumerate network adapters: {e}"))?
        .ok_or_else(|| "no network connection with a gateway was found".to_string())?;
    let gateway = uplink
        .gateway
        .ok_or_else(|| "the active network connection has no gateway".to_string())?;

    let tun_index = wait_for_adapter()?;
    let tun_gateway: Ipv4Addr = TUN_GATEWAY
        .split('/')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "internal error: bad TUN gateway".to_string())?;

    routing::install_full_tunnel(tun_gateway, tun_index, server_ip, gateway, uplink.index)
}

pub fn connect(engines: &Engines, profile: &XrayProfile) -> Result<Child, String> {
    let exe = engines.engine_path("xray.exe")?;
    // Checked explicitly because xray.exe starts fine without it and
    // only fails when the TUN adapter is created, which would surface to
    // the user as "connected, then nothing works".
    engines.engine_path("wintun.dll")?;

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_config(profile))?;

    let exe_dir = exe
        .parent()
        .ok_or_else(|| "could not resolve the engine directory".to_string())?;

    // Working directory is the engine directory so xray.exe finds
    // wintun.dll beside itself.
    let log_path = engines.config_path(LOG_FILE);
    let child = spawn_hidden(
        &exe,
        &[OsStr::new("run"), OsStr::new("-c"), config_path.as_os_str()],
        exe_dir,
        &log_path,
    )
    .map_err(|e| format!("could not start xray.exe: {e}"))?;

    confirm_started(child, "Xray", &log_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> XrayProfile {
        XrayProfile {
            uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301".into(),
            flow: "xtls-rprx-vision".into(),
            host: "203.0.113.5".into(),
            port: 443,
            reality_public_key: "3Qc9mFkJz8xN2pQrStUvWxYz0123456789abcdefgh".into(),
            short_id: "0123abcd".into(),
            server_name: "example.com".into(),
        }
    }

    #[test]
    fn builds_config_xray_can_parse() {
        let parsed: serde_json::Value = serde_json::from_str(&build_config(&profile())).unwrap();
        let outbound = &parsed["outbounds"][0];
        assert_eq!(outbound["protocol"], "vless");
        assert_eq!(outbound["settings"]["vnext"][0]["address"], "203.0.113.5");
        assert_eq!(outbound["settings"]["vnext"][0]["port"], 443);
        assert_eq!(outbound["streamSettings"]["security"], "reality");
        assert_eq!(outbound["streamSettings"]["realitySettings"]["serverName"], "example.com");
    }

    #[test]
    fn tun_inbound_enables_the_anti_loop_helpers() {
        // Without these two, routing 0.0.0.0/0 into the TUN loops
        // forever -- see this module's doc comment.
        let parsed: serde_json::Value = serde_json::from_str(&build_config(&profile())).unwrap();
        let settings = &parsed["inbounds"][0]["settings"];
        assert_eq!(settings["autoSystemRoutingTable"], true);
        assert_eq!(settings["autoOutboundsInterface"], true);
    }
}
