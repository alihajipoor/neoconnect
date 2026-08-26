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
use std::path::PathBuf;
use std::process::Child;

use neoconnect_ipc::{ShadowsocksProfile, TrojanProfile, VlessTlsProfile, XrayProfile};
use serde_json::json;

use super::routing::{self, InstalledRoutes};
use super::{confirm_started, run_hidden, spawn_hidden, write_config, Engines};
use crate::adapters;

const CONFIG_FILE: &str = "xray-client.json";
const LOG_FILE: &str = "xray.log";
pub const ADAPTER_NAME: &str = "neoconnect0";

/// How long to wait for the TUN adapter to show up after Xray starts.
///
/// Creating a Wintun adapter involves the driver and Windows' network
/// stack, so it is not instant and not fixed -- polling until it appears
/// is more reliable than picking a single sleep long enough to "usually"
/// work.
///
/// Ten seconds was the number, and the rig's 0825 run failed on it:
/// "Xray started but its network adapter (neoconnect0) never appeared".
/// It had not failed to appear, it was still being made. The poll was
/// already the right shape -- what was wrong was a ceiling set to how
/// long this takes on a healthy machine rather than to how long it is
/// worth waiting before giving up.
///
/// Sixty seconds is chosen against what the ceiling is *for*. It is not
/// a latency: a tunnel whose adapter arrives in 900ms still returns in
/// 900ms, and on a healthy machine that is what happens. It is the point
/// at which "the driver did not create the adapter" becomes the better
/// explanation than "the driver is still creating the adapter", and
/// nothing about a Wintun creation that has been running a full minute
/// suggests it is about to finish. It also stays under the ceiling that
/// really binds -- see [`ADAPTER_ADDRESSED_WAIT`].
///
/// The customer is not left staring at it for a minute in the ordinary
/// failure either. The poll below reads `abandoned()`, so pressing
/// Disconnect ends the wait rather than queueing behind it.
const ADAPTER_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// How long the adapter then gets to actually hold the address that was
/// just set on it.
///
/// A second, shorter wait on a different condition, and the difference
/// matters. `wait_for_adapter` answers "does this adapter exist"; the
/// routes installed straight afterwards need something stronger, because
/// they name [`TUN_GATEWAY`] as their next hop and -- as the note on
/// `install_routes` already says -- a route to a next hop that is not on
/// the interface silently goes nowhere. `netsh ... set address`
/// returning success is not that: it means the request was accepted, not
/// that the stack has finished plumbing it.
///
/// This is the same condition `split_tunnel::wait_for_addressed_adapter`
/// waits for before pinning a socket, arrived at from the other
/// direction. On a healthy machine it is satisfied on the first poll.
///
/// Fifteen seconds rather than sixty: by this point the adapter
/// demonstrably exists, so this is waiting on the IP stack rather than
/// on a driver install, and something that has not taken an address
/// fifteen seconds after being told to is not going to.
const ADAPTER_ADDRESSED_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

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

/// Resolver handed to the tunnel adapter. The physical link's resolvers
/// are usually LAN or ISP addresses that stop being reachable once the
/// default route moves, so the tunnel needs one that works from
/// anywhere.
const TUN_DNS: &str = "1.1.1.1";

/// Which proxy the generated config dials out through.
///
/// Everything else about the client -- the TUN inbound, the adapter
/// address, the routes -- is identical between protocols, so only the
/// outbound varies.
pub enum Outbound<'a> {
    VlessReality(&'a XrayProfile),
    /// VLESS over an ordinary certificate rather than a borrowed one.
    VlessTls(&'a VlessTlsProfile),
    /// Trojan over ordinary TLS. No borrowed certificate, so the client
    /// simply verifies the name it was told to expect.
    Trojan(&'a TrojanProfile),
    /// Shadowsocks 2022. Alone among these in having no streamSettings
    /// at all -- there is no TLS to configure because the protocol
    /// carries its own encryption and shows no handshake.
    Shadowsocks(&'a ShadowsocksProfile),
}

impl Outbound<'_> {
    fn host(&self) -> &str {
        match self {
            Outbound::VlessReality(p) => &p.host,
            Outbound::VlessTls(p) => &p.host,
            Outbound::Trojan(p) => &p.host,
            Outbound::Shadowsocks(p) => &p.host,
        }
    }

    fn port(&self) -> u16 {
        match self {
            Outbound::VlessReality(p) => p.port,
            Outbound::VlessTls(p) => p.port,
            Outbound::Trojan(p) => p.port,
            Outbound::Shadowsocks(p) => p.port,
        }
    }

    /// The outbound block. Built through serde_json rather than string
    /// formatting so every value is escaped by construction.
    fn to_json(&self) -> serde_json::Value {
        match self {
            Outbound::VlessReality(p) => json!({
                "tag": "proxy",
                "protocol": "vless",
                "settings": {
                    "vnext": [{
                        "address": p.host,
                        "port": p.port,
                        "users": [{ "id": p.uuid, "encryption": "none", "flow": p.flow }]
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
            }),
            // Same vnext/users block as the REALITY variant -- only the
            // wrapping differs, which is the entire distinction between
            // the two.
            Outbound::VlessTls(p) => {
                // Two shapes, one credential. Everything but the stream
                // is identical, so only the wrapper branches.
                let mut stream = json!({
                    "network": if p.ws_path.is_some() { "ws" } else { "tcp" },
                    "security": "tls",
                    "tlsSettings": {
                        // Verified normally, and with no allowInsecure
                        // escape hatch, for the same reason as Trojan
                        // below: a client that accepts any certificate
                        // hands its traffic to whoever is on the path.
                        "serverName": p.server_name,
                        "fingerprint": "chrome",
                        "alpn": ["h2", "http/1.1"]
                    }
                });
                if let Some(path) = &p.ws_path {
                    stream["wsSettings"] = json!({
                        "path": path,
                        // Sent as the Host header. An upgrade with no
                        // Host, or one disagreeing with the SNI, is a
                        // mismatch no browser produces -- which is
                        // exactly what a censor looks for.
                        "host": p.server_name
                    });
                }
                json!({
                    "tag": "proxy",
                    "protocol": "vless",
                    "settings": {
                        "vnext": [{
                            "address": p.host,
                            "port": p.port,
                            // Empty over WebSocket: XTLS Vision needs a
                            // TLS record stream to splice into, and a
                            // WebSocket has none. The server clears it
                            // at generation, so this passes through
                            // whatever was issued.
                            "users": [{ "id": p.uuid, "encryption": "none", "flow": p.flow }]
                        }]
                    },
                    "streamSettings": stream
                })
            }
            Outbound::Trojan(p) => json!({
                "tag": "proxy",
                "protocol": "trojan",
                "settings": {
                    "servers": [{
                        "address": p.host,
                        "port": p.port,
                        "password": p.password
                    }]
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": "tls",
                    "tlsSettings": {
                        // The certificate is a real one for a real
                        // domain, so it is verified normally -- there is
                        // deliberately no allowInsecure escape hatch. A
                        // client that accepts any certificate is a client
                        // whose traffic can be read by whoever is on the
                        // path, which is the opposite of the point.
                        "serverName": p.server_name,
                        // Presenting Chrome's TLS fingerprint matters as
                        // much as the certificate: a handshake that looks
                        // like no browser on earth is itself the signal a
                        // censor looks for.
                        "fingerprint": "chrome",
                        "alpn": ["h2", "http/1.1"]
                    }
                }
            }),
            // No streamSettings, and that absence is the design rather
            // than an omission: Shadowsocks 2022 encrypts from the first
            // byte and presents no handshake, so there is no TLS to
            // configure and no fingerprint to borrow. Nothing to detect,
            // and equally nothing to hide behind once the port is found.
            Outbound::Shadowsocks(p) => json!({
                "tag": "proxy",
                "protocol": "shadowsocks",
                "settings": {
                    "servers": [{
                        "address": p.host,
                        "port": p.port,
                        "method": p.method,
                        // Already "serverKey:userKey" -- joined by the
                        // caller, since only it holds both halves.
                        "password": p.password,
                        // UDP over TCP. The tunnel carries a TUN
                        // adapter's traffic, which includes DNS and
                        // games; without this their UDP is silently
                        // dropped and the customer sees a connection
                        // that works for web pages and nothing else.
                        "uot": true
                    }]
                }
            }),
        }
    }
}

/// `passive` is Custom mode: the adapter comes up but nothing is routed
/// into it, so only the applications the customer selected reach it --
/// via sockets the split tunnel pins to it by hand.
///
/// That makes `autoSystemRoutingTable` the one setting that must differ.
/// Left on, Xray installs system routes of its own and takes the default
/// route, which is precisely the behaviour Custom mode exists to avoid;
/// the customer would ask for one game and get their whole machine
/// tunnelled.
///
/// `autoOutboundsInterface` stays on either way. It pins Xray's own
/// connection to the node onto the physical link, which is what stops
/// the engine's uplink being carried through the tunnel it is creating.
fn build_config_for(outbound: &Outbound, passive: bool) -> String {
    let config = json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "tun-in",
            "protocol": "tun",
            "settings": {
                "name": ADAPTER_NAME,
                "desc": "Wintun",
                "mtu": 1500,
                "gateway": [TUN_GATEWAY],
                "autoSystemRoutingTable": !passive,
                "autoOutboundsInterface": true
            }
        }],
        "outbounds": [outbound.to_json()]
    });
    config.to_string()
}


/// Assigns the TUN adapter its address and DNS.
///
/// Xray's `gateway` setting does not take effect on Windows -- the
/// adapter comes up and Windows self-assigns an APIPA address instead,
/// which was visible in the engine's own log as every packet arriving
/// from a 169.254.x source. That left the next hop in our routes
/// (198.18.0.1) not actually present on the interface, so traffic could
/// reach the tunnel but had no way back.
///
/// DNS is set here too. With the default route captured by the tunnel,
/// the resolvers the physical link advertises are no longer reachable,
/// so leaving them in place means every lookup fails even once packets
/// flow -- which reads to a user as "the internet is down".
fn configure_adapter(tun_ip: Ipv4Addr) -> Result<(), String> {
    let netsh = PathBuf::from(r"C:\Windows\System32\netsh.exe");
    let name_arg = format!("name={ADAPTER_NAME}");

    let status = run_hidden(
        &netsh,
        &[
            OsStr::new("interface"),
            OsStr::new("ipv4"),
            OsStr::new("set"),
            OsStr::new("address"),
            OsStr::new(&name_arg),
            OsStr::new("static"),
            OsStr::new(&tun_ip.to_string()),
            // /30, matching TUN_GATEWAY.
            OsStr::new("255.255.255.252"),
        ],
    )
    .map_err(|e| format!("could not configure the tunnel adapter: {e}"))?;
    if !status.success() {
        return Err(format!("assigning the tunnel adapter's address failed ({status})"));
    }

    let status = run_hidden(
        &netsh,
        &[
            OsStr::new("interface"),
            OsStr::new("ipv4"),
            OsStr::new("set"),
            OsStr::new("dnsservers"),
            OsStr::new(&name_arg),
            OsStr::new("static"),
            OsStr::new(TUN_DNS),
            OsStr::new("primary"),
        ],
    )
    .map_err(|e| format!("could not set the tunnel's DNS: {e}"))?;
    if !status.success() {
        return Err(format!("setting the tunnel's DNS failed ({status})"));
    }

    // The adapter's own resolver is only a preference; this is what makes
    // it the only answer. See apply_tunnel_dns.
    super::dns::apply(TUN_DNS)?;

    Ok(())
}

/// Waits for Xray's TUN adapter to appear and returns its interface index.
///
/// Reads `abandoned()` on every pass: with a ceiling this long, a
/// customer who has given up and pressed Disconnect must not queue
/// behind the rest of it.
fn wait_for_adapter() -> Result<u32, String> {
    let deadline = std::time::Instant::now() + ADAPTER_WAIT;
    loop {
        match adapters::find_by_name(ADAPTER_NAME) {
            Ok(Some(a)) => return Ok(a.index),
            Ok(None) if super::abandoned() => return Err(super::ABANDONED.to_string()),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Ok(None) => {
                return Err(format!(
                    "Xray started but its network adapter ({ADAPTER_NAME}) never appeared \
                     within {}s",
                    ADAPTER_WAIT.as_secs()
                ))
            }
            Err(e) => return Err(format!("could not enumerate network adapters: {e}")),
        }
    }
}

/// Waits until the adapter is actually carrying `expected`.
///
/// Called after `configure_adapter`, and the only reason it exists is
/// that the thing which follows -- installing routes whose next hop is
/// that address -- fails *silently* if it runs too early. See
/// [`ADAPTER_ADDRESSED_WAIT`].
fn wait_for_address(expected: Ipv4Addr) -> Result<(), String> {
    let deadline = std::time::Instant::now() + ADAPTER_ADDRESSED_WAIT;
    loop {
        let found = adapters::find_by_name(ADAPTER_NAME)
            .map_err(|e| format!("could not enumerate network adapters: {e}"))?;
        let held = found.and_then(|a| a.ipv4);
        let expired = std::time::Instant::now() >= deadline;

        // The address that was asked for, which is the answer wanted.
        if held == Some(expected) {
            return Ok(());
        }
        // Any other address, once the deadline has passed. Deliberately
        // not a failure, and the same concession
        // `split_tunnel::wait_for_addressed_adapter` makes: `Adapter`
        // reports the *first* usable IPv4 on the interface, and Windows
        // can self-assign an APIPA 169.254.x that sorts ahead of the one
        // netsh just set -- the very thing that once made this adapter
        // look connected while carrying nothing. Refusing the connect
        // because the wrong one of two real addresses was reported first
        // would be this wait inventing a failure.
        if expired {
            return match held {
                Some(_) => Ok(()),
                None => Err(format!(
                    "the tunnel adapter ({ADAPTER_NAME}) took no address within {}s, so the \
                     tunnel's routes would have had no next hop",
                    ADAPTER_ADDRESSED_WAIT.as_secs()
                )),
            };
        }
        if super::abandoned() {
            return Err(super::ABANDONED.to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
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
pub fn install_routes(outbound: &Outbound) -> Result<InstalledRoutes, String> {
    let server_ip = resolve_server(outbound.host(), outbound.port())?;

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

    // Before the routes: they name this address as their next hop, and a
    // route to a next hop that isn't on the interface silently goes
    // nowhere. `configure_adapter` asks for the address; `wait_for_address`
    // is what establishes that the stack finished giving it.
    configure_adapter(tun_gateway)?;
    wait_for_address(tun_gateway)?;

    routing::install_full_tunnel(tun_gateway, tun_index, server_ip, gateway, uplink.index)
}

/// Everything `install_routes` does except install the routes.
///
/// Custom mode needs the adapter to exist and to hold an address --
/// otherwise a socket pinned to it has no source to use -- but must not
/// have anything routed into it, because the whole point is that the
/// machine's ordinary traffic carries on as before. The one route it
/// does need is added by the split-tunnel controller, at a metric
/// nothing prefers.
///
/// Returns the node's address, which the redirect filter excludes so the
/// tunnel is never carried through itself.
pub fn prepare_passive(outbound: &Outbound) -> Result<Ipv4Addr, String> {
    let server_ip = resolve_server(outbound.host(), outbound.port())?;
    wait_for_adapter()?;

    let tun_gateway: Ipv4Addr = TUN_GATEWAY
        .split('/')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "internal error: bad TUN gateway".to_string())?;
    configure_adapter(tun_gateway)?;
    // Custom mode installs no routes, so the silent-next-hop failure
    // does not apply here -- but `split_tunnel::start` runs immediately
    // after this returns and waits ten seconds for this adapter to hold
    // an address before it will pin anything to it. Establishing that
    // here means the engine hands back something that is ready, rather
    // than handing back early and leaving the split tunnel to discover
    // it was not.
    wait_for_address(tun_gateway)?;

    Ok(server_ip)
}

pub fn connect(
    engines: &Engines,
    outbound: &Outbound,
    passive: bool,
) -> Result<Child, String> {
    let exe = engines.engine_path("xray.exe")?;
    // Checked explicitly because xray.exe starts fine without it and
    // only fails when the TUN adapter is created, which would surface to
    // the user as "connected, then nothing works".
    engines.engine_path("wintun.dll")?;

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_config_for(outbound, passive))?;

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
        let parsed: serde_json::Value = serde_json::from_str(&build_config_for(&Outbound::VlessReality(&profile()), false)).unwrap();
        let outbound = &parsed["outbounds"][0];
        assert_eq!(outbound["protocol"], "vless");
        assert_eq!(outbound["settings"]["vnext"][0]["address"], "203.0.113.5");
        assert_eq!(outbound["settings"]["vnext"][0]["port"], 443);
        assert_eq!(outbound["streamSettings"]["security"], "reality");
        assert_eq!(outbound["streamSettings"]["realitySettings"]["serverName"], "example.com");
    }

    fn trojan_profile() -> TrojanProfile {
        TrojanProfile {
            password: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRg".into(),
            host: "203.0.113.5".into(),
            port: 8443,
            server_name: "fi1.example.com".into(),
        }
    }

    #[test]
    fn builds_a_trojan_config_xray_can_parse() {
        let parsed: serde_json::Value =
            serde_json::from_str(&build_config_for(&Outbound::Trojan(&trojan_profile()), false)).unwrap();
        let outbound = &parsed["outbounds"][0];
        assert_eq!(outbound["protocol"], "trojan");
        assert_eq!(outbound["settings"]["servers"][0]["address"], "203.0.113.5");
        assert_eq!(outbound["settings"]["servers"][0]["port"], 8443);
        assert_eq!(outbound["streamSettings"]["security"], "tls");
        assert_eq!(outbound["streamSettings"]["tlsSettings"]["serverName"], "fi1.example.com");
    }

    /// A client that accepts any certificate can be read by whoever is on
    /// the path. The absence of this setting is the security property, so
    /// it is worth a test rather than a comment.
    #[test]
    fn trojan_never_disables_certificate_verification() {
        let json = build_config_for(&Outbound::Trojan(&trojan_profile()), false);
        assert!(!json.contains("allowInsecure"));
    }

    #[test]
    fn tun_inbound_enables_the_anti_loop_helpers() {
        // Without these two, routing 0.0.0.0/0 into the TUN loops
        // forever -- see this module's doc comment.
        let parsed: serde_json::Value = serde_json::from_str(&build_config_for(&Outbound::VlessReality(&profile()), false)).unwrap();
        let settings = &parsed["inbounds"][0]["settings"];
        assert_eq!(settings["autoSystemRoutingTable"], true);
        assert_eq!(settings["autoOutboundsInterface"], true);
    }
}
