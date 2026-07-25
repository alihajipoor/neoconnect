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
use std::process::Child;

use neoconnect_ipc::XrayProfile;
use serde_json::json;

use super::{confirm_started, spawn_hidden, write_config, Engines};

const CONFIG_FILE: &str = "xray-client.json";
const LOG_FILE: &str = "xray.log";

/// Link-local /30 for the TUN adapter itself. Deliberately not inside
/// any RFC1918 range a customer's LAN or another VPN might already be
/// using, so bringing the tunnel up can't collide with their network.
const TUN_GATEWAY: &str = "169.254.72.1/30";

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
