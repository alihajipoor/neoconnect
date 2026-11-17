//! The Xray family -- VLESS REALITY, VLESS TLS, Trojan, Shadowsocks --
//! through the bundled `xray` and its own tun inbound.
//!
//! The config is the Windows service's (`service/src/engines/xray.rs`),
//! ported as it is: the same outbounds, the same DNS outbound carrying the
//! tunnel's lookups over TCP through the proxy, the same loopback SOCKS5
//! inbound per extra exit. What differs is around it. The tun inbound
//! names its interface `neoconnect0` as on Windows; the helper, not
//! Xray, addresses it, routes into it and points DNS at it, so the config
//! carries none of `autoSystemRoutingTable`, `autoOutboundsInterface`,
//! `gateway` or `dns` on the inbound -- read by v26.6.27, each would have
//! Xray do one of those itself beside us.
//!
//! What keeps Xray's own connection to its server out of its own tunnel
//! is the /32 host route to that server through the uplink, put in before
//! the engine starts (`routes`). The server is written into the config by
//! the address that route names, so Xray never looks it up again through
//! a DNS that by then points into the tunnel.

use std::net::Ipv4Addr;
use std::process::Child;
use std::time::Duration;

use neoconnect_ipc::{ConnectProfile, ExitProfile, ShadowsocksProfile, TrojanProfile, VlessTlsProfile, XrayProfile};
use serde_json::json;

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::split::{self, Custom, Engine, Plan};
use crate::{dns, link, process, routes};
use crate::{Dirs, Limits, Problem, Proto, Shape, SplitState, Transport, Tunnel, TunnelHealth, Up};

/// The engine's file name in `Dirs::bin`.
pub const PROGRAM: &str = "xray";
/// The config's file name in `Dirs::run`. It holds credentials.
pub const CONFIG_FILE: &str = "xray-client.json";
pub const LOG_FILE: &str = "xray.log";
pub const ADAPTER_NAME: &str = link::XRAY_LINK;

/// The tun interface's address, from the RFC 2544 benchmarking range:
/// reserved, never routed on the internet and effectively never used on a
/// home or office network, so it cannot collide with the customer's own
/// as an RFC 1918 pick might. As on Windows.
pub const TUN_GATEWAY: &str = "198.18.0.1/30";

/// Where the engine's own resolver sends the tunnel's lookups: over TCP,
/// through the proxy. A second, so one that stops answering is not the
/// end of DNS.
const TUNNEL_RESOLVERS: [&str; 2] = ["tcp://1.1.1.1", "tcp://8.8.8.8"];

/// The DNS outbound every lookup the tun carries -- port 53, UDP or TCP --
/// is routed to. Plain UDP dies on a network that blocks it, common in
/// Iran, so lookups ride TCP inside the tunnel on every protocol: A and
/// AAAA from Xray's own resolver over TCP, anything else passed on as it
/// is, rewritten to TCP, through the proxy.
const DNS_OUT_TAG: &str = "dns-out";

/// How long the tun interface gets to appear after the engine starts.
/// Xray makes it as it starts its inbounds, in well under a second on a
/// healthy machine; this is the point at which "it did not make it" is
/// the better explanation than "it is still making it".
const LINK_WAIT: Duration = Duration::from_secs(15);

/// Which proxy the config dials out through. Everything else about the
/// client is the same between protocols.
#[derive(Clone, Copy)]
pub enum Outbound<'a> {
    VlessReality(&'a XrayProfile),
    /// VLESS over an ordinary certificate rather than a borrowed one.
    VlessTls(&'a VlessTlsProfile),
    /// Trojan over ordinary TLS.
    Trojan(&'a TrojanProfile),
    /// Shadowsocks 2022: no stream settings, it shows no handshake.
    Shadowsocks(&'a ShadowsocksProfile),
}

impl<'a> Outbound<'a> {
    /// The outbound for a profile, or `None` for a protocol Xray does not
    /// carry.
    pub fn of(profile: &'a ConnectProfile) -> Option<Self> {
        match profile {
            ConnectProfile::XrayVlessReality(p) => Some(Outbound::VlessReality(p)),
            ConnectProfile::XrayVlessTls(p) => Some(Outbound::VlessTls(p)),
            ConnectProfile::XrayTrojan(p) => Some(Outbound::Trojan(p)),
            ConnectProfile::Shadowsocks(p) => Some(Outbound::Shadowsocks(p)),
            _ => None,
        }
    }

    pub fn host(&self) -> &str {
        match self {
            Outbound::VlessReality(p) => &p.host,
            Outbound::VlessTls(p) => &p.host,
            Outbound::Trojan(p) => &p.host,
            Outbound::Shadowsocks(p) => &p.host,
        }
    }

    pub fn port(&self) -> u16 {
        match self {
            Outbound::VlessReality(p) => p.port,
            Outbound::VlessTls(p) => p.port,
            Outbound::Trojan(p) => p.port,
            Outbound::Shadowsocks(p) => p.port,
        }
    }

    /// What the engine dials outside the tunnel to reach this server.
    /// Shadowsocks carries its UDP inside TCP (the mux below), but its
    /// UDP to the server is let through as well: the server is the one
    /// place such a packet can go, so allowing it widens nothing, and a
    /// mux that falls back to plain UDP must not be silently cut.
    fn transports(&self, ip: Ipv4Addr) -> Vec<Transport> {
        let tcp = Transport { ip, port: self.port(), proto: Proto::Tcp };
        match self {
            Outbound::Shadowsocks(_) => vec![tcp, Transport { proto: Proto::Udp, ..tcp }],
            _ => vec![tcp],
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
            Outbound::VlessTls(p) => {
                let mut stream = json!({
                    "network": if p.ws_path.is_some() { "ws" } else { "tcp" },
                    "security": "tls",
                    "tlsSettings": {
                        // Verified normally, with no allowInsecure: a
                        // client that accepts any certificate hands its
                        // traffic to whoever is on the path.
                        "serverName": p.server_name,
                        "fingerprint": "chrome",
                        "alpn": ["h2", "http/1.1"]
                    }
                });
                if let Some(path) = &p.ws_path {
                    stream["wsSettings"] = json!({
                        "path": path,
                        // Sent as the Host header. One disagreeing with the
                        // SNI is a mismatch no browser makes.
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
                        "serverName": p.server_name,
                        "fingerprint": "chrome",
                        "alpn": ["h2", "http/1.1"]
                    }
                }
            }),
            // UDP inside TCP through Xray's mux (XUDP): v26.6.27 dropped
            // Shadowsocks' UDP-over-TCP, and plain UDP to the node dies
            // where UDP is blocked. TCP stays one connection each.
            Outbound::Shadowsocks(p) => json!({
                "tag": "proxy",
                "protocol": "shadowsocks",
                "settings": {
                    "servers": [{
                        "address": p.host,
                        "port": p.port,
                        "method": p.method,
                        "password": p.password
                    }]
                },
                "mux": {
                    "enabled": true,
                    "concurrency": -1,
                    "xudpConcurrency": 16,
                    "xudpProxyUDP443": "allow"
                }
            }),
        }
    }
}

/// One extra exit, carried by the same Xray process as the main one and
/// reached through a loopback SOCKS5 inbound of its own -- a second
/// inbound rather than a second engine, as on Windows.
pub struct ExitInbound<'a> {
    /// The app's name for the exit. Unread until per-app routing comes to
    /// Linux, which finds an exit's port by it; kept so the shape matches
    /// Windows'.
    #[allow(dead_code)]
    pub exit: &'a str,
    pub outbound: Outbound<'a>,
    pub port: u16,
}

/// The routing tags of the *n*th extra exit's inbound and outbound, from
/// one index so the pair can never be written out of step.
fn exit_tags(index: usize) -> (String, String) {
    (format!("exit-{index}-in"), format!("exit-{index}-out"))
}

/// The client config: the tun inbound, the main outbound first (Xray
/// sends anything no rule matches to `outbounds[0]`), one loopback SOCKS5
/// inbound, outbound and rule per extra exit, and the DNS outbound last.
pub fn build_config(primary: &Outbound, extra: &[ExitInbound]) -> String {
    // Name and MTU only: the address, the resolver, the routes and the
    // engine's way out are the helper's.
    let mut inbounds = vec![json!({
        "tag": "tun-in",
        "protocol": "tun",
        "settings": {
            "name": ADAPTER_NAME,
            "mtu": 1500
        }
    })];
    let mut outbounds = vec![primary.to_json()];
    let mut rules = Vec::new();

    for (index, exit) in extra.iter().enumerate() {
        let (inbound_tag, outbound_tag) = exit_tags(index);
        inbounds.push(json!({
            "tag": inbound_tag,
            "protocol": "socks",
            // Loopback only: an unauthenticated SOCKS5 inbound reachable
            // from the network would let the LAN egress through this
            // customer's node.
            "listen": "127.0.0.1",
            "port": exit.port,
            "settings": {
                "auth": "noauth",
                // Games are mostly UDP; without this every datagram is
                // dropped after a TCP handshake that worked.
                "udp": true,
                "ip": "127.0.0.1"
            },
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

    // The tunnel's lookups, over TCP through the proxy. The rule names
    // `tun-in`: the resolver's own connections carry its tag instead, and
    // one that matched here would loop back into this outbound.
    outbounds.push(json!({
        "tag": DNS_OUT_TAG,
        "protocol": "dns",
        "settings": {
            "network": "tcp",
            "rules": [
                { "action": "hijack", "qType": "1,28" },
                { "action": "direct" }
            ]
        },
        "proxySettings": { "tag": "proxy" }
    }));
    rules.push(json!({
        "type": "field",
        "inboundTag": ["tun-in"],
        "port": "53",
        "outboundTag": DNS_OUT_TAG
    }));

    json!({
        "log": { "loglevel": "warning" },
        "dns": { "servers": TUNNEL_RESOLVERS },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": { "domainStrategy": "AsIs", "rules": rules }
    })
    .to_string()
}

/// The same profile with its server named by `ip`.
fn at_address(profile: &ConnectProfile, ip: Ipv4Addr) -> ConnectProfile {
    let mut profile = profile.clone();
    let host = ip.to_string();
    match &mut profile {
        ConnectProfile::XrayVlessReality(p) => p.host = host,
        ConnectProfile::XrayVlessTls(p) => p.host = host,
        ConnectProfile::XrayTrojan(p) => p.host = host,
        ConnectProfile::Shadowsocks(p) => p.host = host,
        _ => {}
    }
    profile
}

/// A free loopback port for an exit inbound: bound and released, so it
/// is one nothing held a moment ago. If something takes it before Xray
/// binds, Xray refuses to start and `confirm_started` says so.
fn free_loopback_port() -> Result<u16, Problem> {
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| Problem::Failed(format!("could not reserve a local port for an exit: {e}")))
}

/// An Xray tunnel, up or part way up. Everything it changed is held here
/// and owed in the ledger, so dropping it at any point undoes exactly that.
pub(crate) struct XrayTunnel {
    up: Up,
    child: Option<Child>,
    ledger: Ledger,
    /// The routes it added, in the order added.
    routes: Vec<RouteSpec>,
    dns: Option<Owed>,
    link_owed: Option<Owed>,
    config_owed: Option<Owed>,
    baseline: Option<(u64, u64)>,
    /// The main server, whose route `health` watches.
    server: Ipv4Addr,
    /// Custom mode: the shape, and the sorting when there is one.
    custom: Custom,
}

/// How long a teardown step may take; `ip` answers in milliseconds.
fn teardown() -> Budget {
    Budget::quick(cmd::TEARDOWN_CAP)
}

pub(crate) fn connect(
    profile: &ConnectProfile,
    exits: &[ExitProfile],
    known_nodes: &[String],
    shape: &Shape,
    dirs: &Dirs,
    limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    let Some(main) = Outbound::of(profile) else {
        return Err(Problem::Failed(format!("{} is not an Xray protocol", profile.protocol_name())));
    };
    let exe = dirs.bin.join(PROGRAM);
    if !exe.is_file() {
        return Err(Problem::EngineMissing(PROGRAM.to_string()));
    }
    // The whole connect, bounded by the caller's deadline.
    let budget = Budget::within(limits, Duration::from_secs(120));

    // Leftovers that would stand in the way: an interface by our name
    // (the engine could not make its own) and stale host routes to the
    // servers the app knows.
    let _ = link::delete(ADAPTER_NAME, &budget);
    routes::purge_stale(known_nodes, &budget);

    // Every server's address and way out, asked before anything of ours
    // is routed: afterwards the best route to a server would be the
    // tunnel itself.
    let main_ip = routes::resolve_ipv4(main.host(), main.port(), &budget)?;
    let main_profile = at_address(profile, main_ip);
    let mut servers = vec![main_ip];
    let mut exit_profiles = Vec::new();
    for exit in exits {
        let Some(outbound) = Outbound::of(&exit.profile) else { continue };
        let ip = routes::resolve_ipv4(outbound.host(), outbound.port(), &budget)?;
        exit_profiles.push((exit.exit.clone(), at_address(&exit.profile, ip), ip));
        if !servers.contains(&ip) {
            servers.push(ip);
        }
    }
    let mut uplinks = Vec::new();
    for server in &servers {
        uplinks.push((*server, routes::uplink_for(*server, &budget)?));
    }

    let mut transports = Outbound::of(&main_profile).map(|o| o.transports(main_ip)).unwrap_or_default();
    for (_, p, ip) in &exit_profiles {
        for t in Outbound::of(p).map(|o| o.transports(*ip)).unwrap_or_default() {
            if !transports.contains(&t) {
                transports.push(t);
            }
        }
    }

    let ledger = Ledger::in_dir(&dirs.state);
    let plan = Plan {
        tunnel: ADAPTER_NAME.to_string(),
        uplink: uplinks[0].1.clone(),
        servers: servers.clone(),
        engine_mark: None,
    };
    let custom = Custom::new(shape, plan, &ledger, &dirs.run, true);
    let mut tunnel = XrayTunnel {
        up: Up {
            protocol: profile.protocol_name().to_string(),
            ifaces: vec![ADAPTER_NAME.to_string()],
            transports,
            fwmark: None,
            dns_protected: false,
        },
        child: None,
        ledger,
        routes: Vec::new(),
        dns: None,
        link_owed: None,
        config_owed: None,
        baseline: None,
        server: main_ip,
        custom,
    };
    // From here, an early return drops `tunnel`, which undoes what it did.
    tunnel.bring_up(&exe, &main_profile, &exit_profiles, &uplinks, dirs, &budget)?;
    Ok(Box::new(tunnel))
}

impl XrayTunnel {
    fn bring_up(
        &mut self,
        exe: &std::path::Path,
        main: &ConnectProfile,
        exits: &[(String, ConnectProfile, Ipv4Addr)],
        uplinks: &[(Ipv4Addr, routes::Uplink)],
        dirs: &Dirs,
        budget: &Budget,
    ) -> Result<(), Problem> {
        // The host routes first. Harmless before the engine runs -- they
        // send the server's traffic the way it goes already -- and in
        // place before anything is routed into the tunnel.
        for (server, uplink) in uplinks {
            let spec = RouteSpec::host(*server, uplink);
            routes::add(&spec, true, &self.ledger, budget)
                .map_err(|e| e.problem(&format!("add the host route to the server through {}", uplink.dev)))?;
            self.routes.push(spec);
        }

        // The config, root-only: it holds the credentials.
        let primary = Outbound::of(main).ok_or_else(|| Problem::Failed("not an Xray protocol".into()))?;
        let mut inbounds = Vec::new();
        for (exit, profile, _) in exits {
            let Some(outbound) = Outbound::of(profile) else { continue };
            inbounds.push(ExitInbound { exit, outbound, port: free_loopback_port()? });
        }
        let config = dirs.run.join(CONFIG_FILE);
        let owed = Owed::File { path: config.clone() };
        self.ledger.owe(owed.clone());
        self.config_owed = Some(owed);
        let _ = std::fs::create_dir_all(&dirs.run);
        crate::files::write_private(&config, build_config(&primary, &inbounds).as_bytes())
            .map_err(|e| Problem::Failed(format!("could not write the Xray config: {e}")))?;

        // The engine, and the interface it makes.
        let owed = Owed::Link { name: ADAPTER_NAME.to_string() };
        self.ledger.owe(owed.clone());
        self.link_owed = Some(owed);
        let log = dirs.run.join(LOG_FILE);
        let config_arg = config.to_string_lossy().into_owned();
        let child = process::spawn(exe, &["run", "-c", &config_arg], &log)
            .map_err(|e| Problem::Failed(format!("could not start Xray: {e}")))?;
        let child = self.child.insert(child);
        process::confirm_started(child, "Xray", &log, budget)?;

        if let Err(problem) = wait_for_link(budget, child) {
            if matches!(problem, Problem::Failed(_)) {
                process::log_last_words("Xray", &log);
            }
            return Err(problem);
        }

        // The address, which the routes into the interface need as a
        // source, then up. Read back: `ip` answering is not the address
        // being there.
        link::address_and_up(ADAPTER_NAME, TUN_GATEWAY, budget)
            .map_err(|e| e.problem(&format!("address the tunnel interface ({ADAPTER_NAME})")))?;
        if !link::ipv4_addresses(ADAPTER_NAME, budget).iter().any(|a| a == TUN_GATEWAY) {
            return Err(Problem::Failed(format!(
                "the tunnel interface ({ADAPTER_NAME}) did not take its address {TUN_GATEWAY}"
            )));
        }
        self.baseline = link::counters(ADAPTER_NAME);

        // Everything else into the tunnel, unless only the chosen apps
        // are to use it; then the sorting, before DNS is pointed at it.
        if split::takes_everything(&self.custom.shape) {
            self.take_everything(budget)?;
        }
        self.custom.install(budget)?;

        // DNS once a route leads into the tunnel, and not before: pointed
        // at 1.1.1.1 earlier, lookups would leave in clear text by the
        // physical network (what Windows saw at the NIC, G8).
        self.dns = dns::point_at(ADAPTER_NAME, &dirs.state, &self.ledger, budget);
        self.up.dns_protected = self.dns.is_some();
        Ok(())
    }
}

/// Waits for the engine's tun interface, and gives up early if the
/// engine dies meanwhile.
fn wait_for_link(budget: &Budget, child: &mut Child) -> Result<(), Problem> {
    let capped = Budget::quick(LINK_WAIT);
    let mut died = None;
    let result = loop {
        if link::exists(ADAPTER_NAME) {
            break Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            died = Some(status);
            break Ok(());
        }
        // Local, like the engine starting: never worded as a timeout,
        // which the app would file against the server.
        if let Err(stop) = budget.check() {
            break Err(match stop {
                cmd::Stop::Cancelled => Problem::Cancelled,
                cmd::Stop::TimedOut => {
                    Problem::Failed(format!("the tunnel interface ({ADAPTER_NAME}) did not appear in time"))
                }
            });
        }
        if capped.expired() {
            break Err(Problem::Failed(format!(
                "Xray started but its tunnel interface ({ADAPTER_NAME}) never appeared within {}s",
                LINK_WAIT.as_secs()
            )));
        }
        budget.nap();
    };
    match died {
        Some(status) => Err(Problem::Failed(format!("Xray exited while making its tunnel interface ({status})"))),
        None => result,
    }
}

impl Engine for XrayTunnel {
    /// The two half-defaults into the tunnel.
    fn take_everything(&mut self, budget: &Budget) -> Result<(), Problem> {
        for half in routes::HALF_DEFAULTS {
            let spec = RouteSpec::into_link(half, ADAPTER_NAME);
            if self.routes.contains(&spec) {
                continue;
            }
            routes::add(&spec, false, &self.ledger, budget)
                .map_err(|e| e.problem(&format!("route {half} into the tunnel")))?;
            self.routes.push(spec);
        }
        Ok(())
    }

    fn release_everything(&mut self, budget: &Budget) {
        let (into_tunnel, hosts): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.routes).into_iter().partition(|spec| spec.dev == ADAPTER_NAME);
        self.routes = hosts;
        for spec in into_tunnel {
            if routes::remove(&spec, &self.ledger, budget).is_err() {
                self.routes.push(spec);
            }
        }
    }

    fn custom(&mut self) -> &mut Custom {
        &mut self.custom
    }
}

impl Tunnel for XrayTunnel {
    fn up(&self) -> &Up {
        &self.up
    }

    fn shape(&self) -> Shape {
        self.custom.shape.clone()
    }

    fn reshape(&mut self, shape: &Shape, limits: &Limits) -> Result<(), Problem> {
        split::reshape(self, shape, limits)
    }

    fn split(&self) -> Option<SplitState> {
        self.custom.state()
    }

    fn probe(&self, limits: &Limits) -> Result<(), String> {
        split::probe(ADAPTER_NAME, limits)
    }

    /// `Down` only on proof: the engine has exited, or its interface is
    /// gone. Otherwise `Unknown`, as the Windows service reports a live
    /// Xray -- a running engine is not evidence that the server answers.
    fn health(&mut self) -> TunnelHealth {
        match self.child.as_mut().map(|c| c.try_wait()) {
            None | Some(Ok(Some(_))) => return TunnelHealth::Down,
            Some(Err(_)) => return TunnelHealth::Unknown,
            Some(Ok(None)) => {}
        }
        if std::path::Path::new("/sys/class/net").is_dir() && !link::exists(ADAPTER_NAME) {
            return TunnelHealth::Down;
        }
        // The host route to the server is added once, on the uplink of the
        // moment. A network change or a suspend takes that device down and
        // the kernel flushes the route with it; Xray's own connection then
        // follows the half-defaults into its own tunnel and loops, with the
        // engine alive and the link up. Down, so the tunnel is taken away
        // and the machine is back on its own network, rather than offline
        // under a tunnel the app calls connected.
        if routes::leads_into(self.server, ADAPTER_NAME) {
            eprintln!("neoxify-helper: Xray's server is now routed into its own tunnel (its way out went away)");
            return TunnelHealth::Down;
        }
        TunnelHealth::Unknown
    }

    fn dns_protected(&self) -> bool {
        self.dns.as_ref().is_some_and(dns::still_in_force)
    }

    fn counters(&self) -> Option<(u64, u64)> {
        let (rx, tx) = link::counters(ADAPTER_NAME)?;
        let (rx0, tx0) = self.baseline.unwrap_or((0, 0));
        Some((rx.saturating_sub(rx0), tx.saturating_sub(tx0)))
    }

    /// The engine killed first: its interface is a non-persistent tun,
    /// which the kernel removes as the process dies, and the routes into
    /// it go with it -- traffic is back on the machine's own route within
    /// a system call. The routes into the tunnel are then deleted anyway
    /// (in case the interface lingers), then the host routes. No waiting
    /// on anything but `ip`, a few milliseconds each.
    fn hard_stop(&mut self) {
        let budget = teardown();
        self.custom.hard_stop();
        if let Some(child) = self.child.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
        }
        let mut kept = Vec::new();
        let (into_tunnel, hosts): (Vec<_>, Vec<_>) =
            self.routes.drain(..).partition(|spec| spec.dev == ADAPTER_NAME);
        for spec in into_tunnel {
            if routes::remove(&spec, &self.ledger, &budget).is_err() {
                kept.push(spec);
            }
        }
        for spec in hosts {
            if routes::remove(&spec, &self.ledger, &budget).is_err() {
                kept.push(spec);
            }
        }
        // Whatever would not go stays owed, for finish_stop and the sweep.
        self.routes = kept;
    }

    fn finish_stop(&mut self) {
        let budget = teardown();
        self.custom.finish_stop();
        if let Some(mut child) = self.child.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        for spec in std::mem::take(&mut self.routes) {
            if routes::remove(&spec, &self.ledger, &budget).is_err() {
                self.routes.push(spec);
            }
        }
        if let Some(owed) = self.dns.take() {
            match dns::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => self.dns = Some(owed),
            }
        }
        if let Some(owed) = self.link_owed.take() {
            // The kernel removes the engine's interface when the engine
            // exits; this is for one it left.
            match link::delete(ADAPTER_NAME, &budget) {
                Ok(()) => self.ledger.settle(&owed),
                Err(_) => self.link_owed = Some(owed),
            }
        }
        if let Some(owed) = self.config_owed.take() {
            if let Owed::File { path } = &owed {
                // The engine's log sits beside its config and, like it,
                // names the server; neither outlives the tunnel.
                let _ = std::fs::remove_file(path.with_file_name(LOG_FILE));
                match std::fs::remove_file(path) {
                    Ok(()) => self.ledger.settle(&owed),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.ledger.settle(&owed),
                    Err(_) => self.config_owed = Some(owed),
                }
            }
        }
    }
}

impl Drop for XrayTunnel {
    fn drop(&mut self) {
        self.hard_stop();
        self.finish_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn trojan_profile() -> TrojanProfile {
        TrojanProfile {
            password: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRg".into(),
            host: "203.0.113.5".into(),
            port: 8443,
            server_name: "fi1.example.com".into(),
        }
    }

    fn tls_profile() -> VlessTlsProfile {
        VlessTlsProfile {
            uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301".into(),
            flow: String::new(),
            host: "203.0.113.5".into(),
            port: 443,
            server_name: "cdn.example.com".into(),
            ws_path: Some("/ws".into()),
        }
    }

    fn shadowsocks_profile() -> ShadowsocksProfile {
        ShadowsocksProfile {
            host: "203.0.113.5".into(),
            port: 8388,
            method: "2022-blake3-aes-256-gcm".into(),
            password: "c2VydmVyS2V5c2VydmVyS2V5c2VydmVyS2V5MTIzNDU=:dXNlcktleXVzZXJLZXl1c2VyS2V5dXNlcktleTEyMzQ=".into(),
        }
    }

    /// `profile()` with a public key the engine will take: 32 bytes, base64url.
    fn engine_reality_profile() -> XrayProfile {
        XrayProfile { reality_public_key: "CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY".into(), ..profile() }
    }

    fn parse(config: &str) -> serde_json::Value {
        serde_json::from_str(config).unwrap()
    }

    #[test]
    fn builds_config_xray_can_parse() {
        let parsed = parse(&build_config(&Outbound::VlessReality(&profile()), &[]));
        let outbound = &parsed["outbounds"][0];
        assert_eq!(outbound["protocol"], "vless");
        assert_eq!(outbound["settings"]["vnext"][0]["address"], "203.0.113.5");
        assert_eq!(outbound["settings"]["vnext"][0]["port"], 443);
        assert_eq!(outbound["streamSettings"]["security"], "reality");
        assert_eq!(outbound["streamSettings"]["realitySettings"]["serverName"], "example.com");
    }

    #[test]
    fn builds_a_trojan_config_xray_can_parse() {
        let parsed = parse(&build_config(&Outbound::Trojan(&trojan_profile()), &[]));
        let outbound = &parsed["outbounds"][0];
        assert_eq!(outbound["protocol"], "trojan");
        assert_eq!(outbound["settings"]["servers"][0]["port"], 8443);
        assert_eq!(outbound["streamSettings"]["security"], "tls");
        assert_eq!(outbound["streamSettings"]["tlsSettings"]["serverName"], "fi1.example.com");
    }

    /// A client that accepts any certificate can be read by whoever is on
    /// the path. The absence of the setting is the security property.
    #[test]
    fn never_disables_certificate_verification() {
        for (name, config) in every_config() {
            assert!(!config.to_string().contains("allowInsecure"), "{name}");
        }
    }

    /// The routes, the interface's address and its DNS are the helper's.
    /// Read by v26.6.27, each of these would have Xray do one of them
    /// itself, beside the helper.
    #[test]
    fn tun_inbound_leaves_routes_address_and_dns_to_the_helper() {
        let parsed = parse(&build_config(&Outbound::VlessReality(&profile()), &[]));
        let settings = parsed["inbounds"][0]["settings"].as_object().expect("the tun inbound's settings");
        for key in ["autoSystemRoutingTable", "autoOutboundsInterface", "gateway", "dns"] {
            assert!(!settings.contains_key(key), "{key} hands Xray what the helper does");
        }
        assert_eq!(settings["name"], ADAPTER_NAME);
        assert_eq!(ADAPTER_NAME, "neoconnect0", "the name the shared interface and netguard expect");
    }

    #[test]
    fn no_extra_exits_means_one_rule_and_no_socks() {
        let config = build_config(&Outbound::VlessReality(&profile()), &[]);
        let parsed = parse(&config);
        let rules = parsed["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 1, "{rules:?}");
        assert_eq!(rules[0]["outboundTag"], DNS_OUT_TAG);
        assert!(!config.contains("socks"));
    }

    #[test]
    fn each_extra_exit_gets_its_own_inbound_outbound_and_rule() {
        let a = profile();
        let b = second_profile();
        let parsed = parse(&build_config(
            &Outbound::VlessReality(&a),
            &[
                ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 },
                ExitInbound { exit: "turkey-1", outbound: Outbound::VlessReality(&b), port: 41081 },
            ],
        ));
        assert_eq!(parsed["inbounds"][0]["tag"], "tun-in");
        assert_eq!(parsed["inbounds"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["outbounds"][0]["tag"], "proxy");
        for (index, (port, host)) in [(41080u16, "203.0.113.5"), (41081, "198.51.100.9")].into_iter().enumerate() {
            let inbound = &parsed["inbounds"][index + 1];
            assert_eq!(inbound["tag"], format!("exit-{index}-in"));
            assert_eq!(inbound["protocol"], "socks");
            assert_eq!(inbound["listen"], "127.0.0.1");
            assert_eq!(inbound["port"], port);
            assert_eq!(inbound["settings"]["udp"], true);
            let outbound = &parsed["outbounds"][index + 1];
            assert_eq!(outbound["tag"], format!("exit-{index}-out"));
            assert_eq!(outbound["settings"]["vnext"][0]["address"], host);
            let rule = &parsed["routing"]["rules"][index];
            assert_eq!(rule["inboundTag"][0], format!("exit-{index}-in"));
            assert_eq!(rule["outboundTag"], format!("exit-{index}-out"));
        }
        assert_ne!(
            parsed["outbounds"][1]["settings"]["vnext"][0]["users"][0]["id"],
            parsed["outbounds"][2]["settings"]["vnext"][0]["users"][0]["id"]
        );
    }

    #[test]
    fn exit_inbounds_never_listen_off_loopback() {
        let a = profile();
        let config = build_config(
            &Outbound::VlessReality(&a),
            &[ExitInbound { exit: "germany-1", outbound: Outbound::VlessReality(&a), port: 41080 }],
        );
        for inbound in parse(&config)["inbounds"].as_array().unwrap() {
            if inbound["protocol"] == "socks" {
                assert_eq!(inbound["listen"], "127.0.0.1");
            }
        }
        assert!(!config.contains("0.0.0.0"));
    }

    #[test]
    fn inbound_and_outbound_tags_are_derived_together() {
        assert_eq!(exit_tags(2), ("exit-2-in".to_string(), "exit-2-out".to_string()));
    }

    fn every_config() -> Vec<(String, serde_json::Value)> {
        let (reality, tls, trojan, ss) = (engine_reality_profile(), tls_profile(), trojan_profile(), shadowsocks_profile());
        let mut out = Vec::new();
        for (name, outbound) in [
            ("vless-reality", Outbound::VlessReality(&reality)),
            ("vless-tls-ws", Outbound::VlessTls(&tls)),
            ("trojan", Outbound::Trojan(&trojan)),
            ("shadowsocks", Outbound::Shadowsocks(&ss)),
        ] {
            out.push((name.to_string(), parse(&build_config(&outbound, &[]))));
        }
        let multi = build_config(
            &Outbound::VlessReality(&reality),
            &[
                ExitInbound { exit: "finland-1", outbound: Outbound::Shadowsocks(&ss), port: 41080 },
                ExitInbound { exit: "turkey-1", outbound: Outbound::Trojan(&trojan), port: 41081 },
            ],
        );
        out.push(("multi-exit".to_string(), parse(&multi)));
        out
    }

    #[test]
    fn the_tunnels_lookups_ride_tcp_through_the_proxy_on_every_protocol() {
        for (name, config) in every_config() {
            let rules = config["routing"]["rules"].as_array().unwrap();
            let to_dns: Vec<_> = rules.iter().filter(|r| r["outboundTag"] == DNS_OUT_TAG).collect();
            assert_eq!(to_dns.len(), 1, "{name}");
            assert_eq!(to_dns[0]["inboundTag"], json!(["tun-in"]), "{name}");
            assert_eq!(to_dns[0]["port"], "53", "{name}");
            let outbounds = config["outbounds"].as_array().unwrap();
            let dns_out = outbounds.iter().find(|o| o["tag"] == DNS_OUT_TAG).unwrap();
            assert_eq!(dns_out["settings"]["network"], "tcp", "{name}");
            assert_eq!(
                dns_out["settings"]["rules"],
                json!([{ "action": "hijack", "qType": "1,28" }, { "action": "direct" }]),
                "{name}"
            );
            assert_eq!(dns_out["proxySettings"]["tag"], "proxy", "{name}");
            let servers = config["dns"]["servers"].as_array().unwrap();
            assert!(servers.contains(&json!(format!("tcp://{}", dns::TUN_DNS))), "{name}");
            assert!(servers.iter().all(|s| s.as_str().is_some_and(|s| s.starts_with("tcp://"))), "{name}");
            assert_eq!(outbounds[0]["tag"], "proxy", "{name}");
            for rule in rules {
                for tag in rule["inboundTag"].as_array().unwrap() {
                    if tag == "tun-in" {
                        assert_eq!(rule["outboundTag"], DNS_OUT_TAG, "{name}: tun-in routed elsewhere");
                    }
                }
            }
        }
    }

    #[test]
    fn shadowsocks_carries_its_udp_inside_tcp() {
        let ss = shadowsocks_profile();
        let parsed = parse(&build_config(&Outbound::Shadowsocks(&ss), &[]));
        assert_eq!(
            parsed["outbounds"][0]["mux"],
            json!({ "enabled": true, "concurrency": -1, "xudpConcurrency": 16, "xudpProxyUDP443": "allow" })
        );
        assert!(parsed["outbounds"][0]["settings"]["servers"][0].get("uot").is_none());
        for (name, config) in every_config() {
            for outbound in config["outbounds"].as_array().unwrap() {
                assert_eq!(outbound.get("mux").is_some(), outbound["protocol"] == "shadowsocks", "{name}");
            }
        }
    }

    #[test]
    fn transports_name_what_the_engine_dials() {
        let ip = Ipv4Addr::new(203, 0, 113, 5);
        let reality = profile();
        assert_eq!(Outbound::VlessReality(&reality).transports(ip), vec![Transport { ip, port: 443, proto: Proto::Tcp }]);
        let ss = shadowsocks_profile();
        let both = Outbound::Shadowsocks(&ss).transports(ip);
        assert!(both.contains(&Transport { ip, port: 8388, proto: Proto::Tcp }));
        assert!(both.contains(&Transport { ip, port: 8388, proto: Proto::Udp }));
    }

    #[test]
    fn the_server_is_written_by_the_address_its_host_route_names() {
        let named = ConnectProfile::XrayTrojan(TrojanProfile { host: "node.example.com".into(), ..trojan_profile() });
        let moved = at_address(&named, Ipv4Addr::new(192, 0, 2, 7));
        let outbound = Outbound::of(&moved).unwrap();
        assert_eq!(outbound.host(), "192.0.2.7");
        let ConnectProfile::XrayTrojan(p) = &moved else { panic!() };
        assert_eq!(p.server_name, "fi1.example.com", "the certificate name is untouched");
    }

    /// The engine itself reads every config. `xray run -test` builds the
    /// config and exits before starting anything, so it needs no root and
    /// makes no interface. Run where `NEOXIFY_TEST_XRAY` names an engine.
    #[test]
    fn the_engine_accepts_every_config() {
        let Some(exe) = std::env::var_os("NEOXIFY_TEST_XRAY") else {
            eprintln!("skipped: NEOXIFY_TEST_XRAY is not set");
            return;
        };
        let dir = std::env::temp_dir().join(format!("neoxify-xray-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (index, (name, config)) in every_config().into_iter().enumerate() {
            let path = dir.join(format!("config-{index}.json"));
            std::fs::write(&path, config.to_string()).unwrap();
            let out = std::process::Command::new(&exe).arg("run").arg("-test").arg("-c").arg(&path).output().unwrap();
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(
                out.status.success() && stdout.contains("Configuration OK."),
                "{name}: xray refused the config ({})\n{stdout}\n{}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
