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
pub(super) const TUN_DNS: &str = "1.1.1.1";

/// Which proxy the generated config dials out through.
///
/// Everything else about the client -- the TUN inbound, the adapter
/// address, the routes -- is identical between protocols, so only the
/// outbound varies.
///
/// `Copy` because every variant is a shared reference to a profile the
/// caller already owns. Concurrent exits need to name several of these
/// in one config, and copying a borrow is the whole cost of that.
#[derive(Clone, Copy)]
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
    build_multi_exit_config(outbound, &[], passive)
}

/// One additional exit, carried by the same Xray process as the primary
/// one and reached through a loopback SOCKS5 inbound of its own.
///
/// # Why a second inbound rather than a second engine
///
/// `docs/design/per-game-exits.md` §2.3 lists what a second *engine*
/// would need: `session::Slot` holds one `Active` and has no setter
/// that empties it, so ending either engine stops interception for
/// both -- a shape built on purpose after a field incident. Under that
/// sit fixed adapter and service names, one `PASSIVE_METRIC`, a
/// process-global DNS mutex, a machine-wide IPv6 WFP block, one
/// WinDivert loop pinned to one `(interface, address)`, and a janitor
/// that kills by image name. Every one of those is a singleton that a
/// second engine would collide with.
///
/// None of them is touched by a second *inbound*. There is still one
/// process, one adapter, one route, one metric, one janitor. What
/// changes is only what xray-core itself does with a connection after
/// it arrives, which is the thing xray-core's routing table is for --
/// and it is the mechanism already proven on the node side, where
/// `ProtocolConfig.inboundTag` gives each inbound its own outbound.
pub struct ExitInbound<'a> {
    /// The opaque identifier the client uses for this exit, matched by
    /// equality against `AppExit::exit`. Never resolved to an address
    /// here; it exists so the split tunnel can find the port below.
    pub exit: &'a str,
    /// The node this exit's traffic leaves from.
    pub outbound: Outbound<'a>,
    /// The loopback port its SOCKS5 inbound listens on.
    pub port: u16,
}

/// The routing tag of the *n*th extra exit's inbound and outbound.
///
/// Two names from one index so the pair can never be written out of
/// step with each other, which is the one way a rule silently sends a
/// game somewhere it did not ask for.
fn exit_tags(index: usize) -> (String, String) {
    (format!("exit-{index}-in"), format!("exit-{index}-out"))
}

/// The client config, with the primary exit plus one loopback SOCKS5
/// inbound per additional exit.
///
/// # The shape, and why the default path is byte-identical
///
/// xray-core sends a connection to the **first** outbound unless a
/// routing rule says otherwise. The primary outbound is therefore still
/// `outbounds[0]` and still tagged `proxy`, and there is deliberately
/// no rule matching `tun-in`. So everything that was carried before --
/// the TUN adapter's traffic, DNS, every application with no preference
/// -- takes exactly the path it took when this function could only
/// write one outbound. `extra` being empty reproduces the old config
/// exactly, which is what lets [`build_config_for`] delegate here
/// rather than the two drifting apart.
///
/// An extra exit adds three things that only ever address each other:
/// an inbound tagged `exit-N-in` listening on loopback, an outbound
/// tagged `exit-N-out` dialling that exit's node, and one rule joining
/// them. Nothing else in the config can reach either.
///
/// # Why the inbounds are loopback and SOCKS5
///
/// Loopback because the split tunnel's WinDivert filter ends in `not
/// loopback` (see `split_tunnel::redirect::filter_for`), so the relay's
/// hop into Xray is invisible to the loop that would otherwise capture
/// it and feed it back to itself.
///
/// SOCKS5 because it is the one inbound xray-core offers that carries
/// both TCP and UDP and lets the *caller* name the destination per
/// connection. A second TUN inbound would need a second adapter, a
/// second address range and a second route at a second metric, which is
/// the singleton problem again; a dokodemo-door inbound has one fixed
/// destination and cannot carry a game to the several addresses it
/// talks to.
///
/// `udp: true` is not optional. Games are predominantly UDP, and an
/// inbound without it accepts the TCP handshake and silently drops
/// every datagram -- which presents as a game that connects, shows a
/// server list and then never updates.
fn build_multi_exit_config(primary: &Outbound, extra: &[ExitInbound], passive: bool) -> String {
    let mut inbounds = vec![json!({
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
    })];
    let mut outbounds = vec![primary.to_json()];
    let mut rules = Vec::new();

    for (index, exit) in extra.iter().enumerate() {
        let (inbound_tag, outbound_tag) = exit_tags(index);
        inbounds.push(json!({
            "tag": inbound_tag,
            "protocol": "socks",
            // Loopback only. A SOCKS5 inbound with no authentication
            // reachable from the network would let anything on the LAN
            // egress through this customer's node.
            "listen": "127.0.0.1",
            "port": exit.port,
            "settings": {
                // The relay is a local process talking to a local port
                // that only it knows about, so a credential here would
                // be a secret shared between two halves of one program.
                // The listen address is what limits reach.
                "auth": "noauth",
                "udp": true,
                // Where xray-core tells the client to send datagrams
                // after UDP ASSOCIATE. It must be an address the relay
                // can actually reach, which for a loopback inbound is
                // loopback.
                "ip": "127.0.0.1"
            },
            // Off deliberately. Sniffing rewrites a connection's
            // destination to the name found in the handshake, and this
            // inbound exists precisely to send a *game* to the address
            // it asked for. Nothing here routes by domain, so sniffing
            // could only change an answer, never inform one.
            "sniffing": { "enabled": false }
        }));
        let mut tagged = exit.outbound.to_json();
        tagged["tag"] = json!(outbound_tag);
        outbounds.push(tagged);
        rules.push(json!({
            "type": "field",
            "inboundTag": [inbound_tag],
            "outboundTag": outbound_tag
        }));
    }

    let mut config = json!({
        "log": { "loglevel": "warning" },
        "inbounds": inbounds,
        "outbounds": outbounds
    });
    // Absent entirely when there are no extra exits, so the generated
    // config is byte-identical to the one this engine produced before
    // concurrent exits existed. An empty `routing.rules` would be
    // harmless and would still be a difference nobody could rule out
    // when reading a config off a customer's machine.
    if !rules.is_empty() {
        config["routing"] = json!({ "domainStrategy": "AsIs", "rules": rules });
    }
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
///
/// `passive` reaches here only to be handed to
/// `dns::machine_wide_rule_wanted`. The answer is currently the same in
/// both modes, so threading it changes no behaviour -- it is threaded so
/// that the two engines ask the same named question in the same shape,
/// which is what stopped being true the last time one of them was
/// edited alone.
fn configure_adapter(tun_ip: Ipv4Addr, passive: bool) -> Result<(), String> {
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
    //
    // Not `?`, and it no longer can be: `dns::force` returns no error.
    // This used to fail the whole connect, and the rig watched it do
    // exactly that -- `could not force tunnel DNS: powershell did not
    // finish within 15s`, on a tunnel Xray's own log shows was already
    // carrying traffic. IKEv2 took the opposite view for the same call
    // and neither comment acknowledged the other. The tunnel comes up
    // now and the complaint is carried in `status`; `dns::TunnelDns`
    // has the argument, which is about poisoned answers in Iran rather
    // than about tidiness.
    //
    // Unconditional, including in Custom mode, and that is deliberate
    // rather than an oversight -- which is what it looked like, because
    // this call is reached from `prepare_passive` as well as
    // `install_routes` while IKEv2 gated the same call on `!passive`.
    // Xray was the one that had it right: in Custom mode the redirect
    // only carries lookups it can see, and `filter_for` excludes every
    // RFC1918 address, so without this rule a router-supplied resolver
    // is never redirected. IKEv2 matches this now.
    //
    // The condition is named rather than written out, so the two
    // engines cannot drift apart again the way they just did.
    // `dns::machine_wide_rule_wanted` carries the whole argument.
    if super::dns::machine_wide_rule_wanted(passive) {
        super::dns::force(TUN_DNS);
    }

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
    // `false`: this function *is* the full-tunnel branch -- `mod.rs`
    // picks between it and `prepare_passive` on the same flag.
    configure_adapter(tun_gateway, false)?;
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
    // `true`: this function is the Custom-mode branch. The DNS rule is
    // still installed -- see `dns::machine_wide_rule_wanted`.
    configure_adapter(tun_gateway, true)?;
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
    connect_with_exits(engines, outbound, &[], passive)
}

/// Picks a free loopback port for an exit inbound.
///
/// Bound and released, so the port is one nothing else held a moment
/// ago rather than one this code hoped was free. There is a race in
/// that -- something could take it between the release and Xray's own
/// bind -- and it is the same race every "ask the OS for a free port
/// and hand it to a child process" has. It is bounded and it is loud:
/// Xray refuses to start on a port it cannot bind, and `confirm_started`
/// turns that into a failed connect rather than a session that comes up
/// carrying nothing.
///
/// Deliberately not a fixed port range. A hardcoded port that something
/// else already holds fails on a customer's machine with no way to pick
/// another -- the same reasoning `proxy::start` gives for binding its
/// relay ports at zero.
fn free_loopback_port() -> Result<u16, String> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("could not reserve a local port for an exit: {e}"))
}

/// Brings up one Xray process carrying `outbound` plus one extra exit
/// per entry in `exits`.
///
/// Returns the child and the `(exit identifier, loopback port)` table
/// the split tunnel needs to reach each one. The table is the caller's
/// half of the contract: without it the inbounds are listening and
/// nothing dials them, which is a session that behaves exactly as it
/// did before concurrent exits existed.
pub fn connect_with_exits(
    engines: &Engines,
    outbound: &Outbound,
    exits: &[(String, Outbound)],
    passive: bool,
) -> Result<Child, String> {
    connect_returning_exits(engines, outbound, exits, passive).map(|(child, _)| child)
}

pub fn connect_returning_exits(
    engines: &Engines,
    outbound: &Outbound,
    exits: &[(String, Outbound)],
    passive: bool,
) -> Result<(Child, Vec<(String, u16)>), String> {
    let exe = engines.engine_path("xray.exe")?;
    // Checked explicitly because xray.exe starts fine without it and
    // only fails when the TUN adapter is created, which would surface to
    // the user as "connected, then nothing works".
    engines.engine_path("wintun.dll")?;

    let mut inbounds = Vec::with_capacity(exits.len());
    let mut table = Vec::with_capacity(exits.len());
    for (exit, exit_outbound) in exits {
        let port = free_loopback_port()?;
        inbounds.push(ExitInbound { exit, outbound: *exit_outbound, port });
        table.push((exit.clone(), port));
    }

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_multi_exit_config(outbound, &inbounds, passive))?;

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

    confirm_started(child, "Xray", &log_path).map(|child| (child, table))
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

    // ---------------------------------------------------------------
    // Concurrent exits.
    // ---------------------------------------------------------------

    fn second_profile() -> XrayProfile {
        XrayProfile {
            uuid: "9b2e4c11-77aa-4d2e-8f31-11bb22cc33dd".into(),
            flow: "xtls-rprx-vision".into(),
            host: "198.51.100.9".into(),
            port: 8443,
            reality_public_key: "7Kd2nGlLm4wQ8rTuVxYz0123456789abcdefghij".into(),
            short_id: "beef1234".into(),
            server_name: "example.net".into(),
        }
    }

    /// The whole safety argument for adding inbounds rather than
    /// engines: with no extra exits, the config is not merely
    /// equivalent to the old one, it is the same bytes.
    #[test]
    fn no_extra_exits_leaves_the_config_exactly_as_it_was() {
        let primary = Outbound::VlessReality(&profile());
        for passive in [true, false] {
            let one = build_config_for(&primary, passive);
            let none = build_multi_exit_config(&primary, &[], passive);
            assert_eq!(one, none, "delegation must not change a byte");
            assert!(!one.contains("routing"), "no rules means no routing block at all");
            assert!(!one.contains("socks"), "no extra exits means no extra inbound");
        }
    }

    #[test]
    fn each_extra_exit_gets_its_own_inbound_outbound_and_rule() {
        let a = profile();
        let b = second_profile();
        let config = build_multi_exit_config(
            &Outbound::VlessReality(&a),
            &[
                ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 },
                ExitInbound { exit: "turkey-1", outbound: Outbound::VlessReality(&b), port: 41081 },
            ],
            true,
        );
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();

        // The TUN inbound stays first and stays alone in its kind.
        assert_eq!(parsed["inbounds"][0]["tag"], "tun-in");
        assert_eq!(parsed["inbounds"][0]["protocol"], "tun");
        assert_eq!(parsed["inbounds"].as_array().unwrap().len(), 3);

        // The primary outbound stays first, because xray-core sends
        // anything no rule matches to `outbounds[0]`.
        assert_eq!(parsed["outbounds"][0]["tag"], "proxy");
        assert_eq!(parsed["outbounds"][0]["settings"]["vnext"][0]["address"], "203.0.113.5");

        for (index, (port, host)) in
            [(41080u16, "203.0.113.5"), (41081, "198.51.100.9")].into_iter().enumerate()
        {
            let inbound = &parsed["inbounds"][index + 1];
            assert_eq!(inbound["tag"], format!("exit-{index}-in"));
            assert_eq!(inbound["protocol"], "socks");
            assert_eq!(inbound["listen"], "127.0.0.1");
            assert_eq!(inbound["port"], port);

            let outbound = &parsed["outbounds"][index + 1];
            assert_eq!(outbound["tag"], format!("exit-{index}-out"));
            assert_eq!(outbound["settings"]["vnext"][0]["address"], host);

            let rule = &parsed["routing"]["rules"][index];
            assert_eq!(rule["inboundTag"][0], format!("exit-{index}-in"));
            assert_eq!(rule["outboundTag"], format!("exit-{index}-out"));
        }
    }

    /// Two exits on two nodes is the entire point, so it is worth an
    /// assertion that the second outbound is not a copy of the first.
    /// A retag that reused one `Outbound` would pass every structural
    /// check above and send both games to the same node.
    #[test]
    fn two_exits_dial_two_different_nodes() {
        let a = profile();
        let b = second_profile();
        let parsed: serde_json::Value = serde_json::from_str(&build_multi_exit_config(
            &Outbound::VlessReality(&a),
            &[
                ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 },
                ExitInbound { exit: "turkey-1", outbound: Outbound::VlessReality(&b), port: 41081 },
            ],
            true,
        ))
        .unwrap();
        let first = &parsed["outbounds"][1]["settings"]["vnext"][0];
        let second = &parsed["outbounds"][2]["settings"]["vnext"][0];
        assert_ne!(first["address"], second["address"]);
        assert_ne!(first["users"][0]["id"], second["users"][0]["id"]);
    }

    /// Games are predominantly UDP. An inbound without this accepts the
    /// TCP handshake and silently drops every datagram, which presents
    /// as a game that connects and then never updates.
    #[test]
    fn every_exit_inbound_carries_udp() {
        let a = profile();
        let parsed: serde_json::Value = serde_json::from_str(&build_multi_exit_config(
            &Outbound::VlessReality(&a),
            &[ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 }],
            true,
        ))
        .unwrap();
        assert_eq!(parsed["inbounds"][1]["settings"]["udp"], true);
        assert_eq!(parsed["inbounds"][1]["settings"]["ip"], "127.0.0.1");
    }

    /// A SOCKS5 inbound with no authentication listening on anything
    /// but loopback lets the rest of the network egress through this
    /// customer's node -- and be billed, rate-limited and banned as
    /// them.
    #[test]
    fn exit_inbounds_never_listen_off_loopback() {
        let a = profile();
        let config = build_multi_exit_config(
            &Outbound::VlessReality(&a),
            &[
                ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 },
                ExitInbound { exit: "turkey-1", outbound: Outbound::VlessReality(&a), port: 41081 },
            ],
            true,
        );
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        for inbound in parsed["inbounds"].as_array().unwrap() {
            if inbound["protocol"] == "socks" {
                assert_eq!(inbound["listen"], "127.0.0.1");
            }
        }
        assert!(!config.contains("0.0.0.0"));
    }

    /// Nothing may route `tun-in` anywhere. Everything with no
    /// preference -- and all DNS -- has to keep landing on the primary
    /// outbound, which it does only by there being no rule about it.
    #[test]
    fn no_rule_ever_matches_the_tun_inbound() {
        let a = profile();
        let parsed: serde_json::Value = serde_json::from_str(&build_multi_exit_config(
            &Outbound::VlessReality(&a),
            &[ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 }],
            true,
        ))
        .unwrap();
        for rule in parsed["routing"]["rules"].as_array().unwrap() {
            for tag in rule["inboundTag"].as_array().unwrap() {
                assert_ne!(tag, "tun-in");
            }
        }
    }

    /// The pairing is the one thing that silently sends a game
    /// somewhere it did not ask for, so it is derived from one index
    /// rather than written twice.
    #[test]
    fn inbound_and_outbound_tags_are_derived_together() {
        assert_eq!(exit_tags(0), ("exit-0-in".to_string(), "exit-0-out".to_string()));
        assert_eq!(exit_tags(2), ("exit-2-in".to_string(), "exit-2-out".to_string()));
    }
}
