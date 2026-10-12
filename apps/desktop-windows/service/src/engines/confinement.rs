//! IPv4 confined to the tunnel while a full tunnel is up.
//!
//! # What this closes
//!
//! On Xray (the five Stealth protocols and Shadowsocks) and OpenVPN
//! (Compatible), the only IPv4 filter this service installed was DNS's
//! (`ipv6_block::DnsConfinement`). Everything else IPv4 was governed by
//! routes alone, and routes govern only what follows them. Measured on
//! 0.9.48 in the VM (P0, journal 2026-10-11): an IPv4 TLS connection opened
//! before Connect went on leaving by the guest's own adapter, from the
//! host's public address, for the whole Stealth and Compatible sessions. A
//! socket bound to the physical adapter ignores routes the same way, and a
//! connection opened in the seconds between two rungs of the ladder stays
//! on the adapter it was opened on.
//!
//! WireGuard (Fast) looked clean in the same captures because wireguard.exe
//! installs a WFP block of its own while it is up -- a filter, not a better
//! driver. This module is that filter for the engines that bring none, so
//! that Xray's capture can be held to WireGuard's (the falsifiable claim
//! the VM's P3 gate makes: if Wintun were the cause, this would not fix it).
//!
//! # What the owner decided (2026-10-12)
//!
//! * (a) The LAN stays reachable: the private on-link prefixes of the
//!   machine's up, non-tunnel adapters, link-local, multicast, the limited
//!   broadcast and DHCP -- never `10/8` or `100.64/10` wholesale, which on
//!   Iranian carrier-grade NAT is the ISP's network. The router's DNS stays
//!   refused: DNS goes through the tunnel (the IPv6 block's sublayer refuses
//!   port 53 off the tunnel, and a block in any sublayer wins).
//! * (b) While connected, other VPNs and overlays and inbound connections
//!   from the internet stop working. Custom mode is untouched: no
//!   confinement there, in either variant.
//! * (c) Connections already open outside the tunnel are reset once at
//!   connect (`connections`), so they come back through it.
//! * (d) A confinement that will not install leaves the tunnel up, and the
//!   status poll says `ipv4_confined: false` with the reason; the app says
//!   so in words and never claims full protection meanwhile.
//! * (e) The node's own address keeps its host route around the tunnel for
//!   now; only the engine may use it.
//!
//! # Fail open, still
//!
//! "While the tunnel is down nothing is blocked" (journal, log.md, the
//! 2026-10-07 entry) holds. The filters live in a dynamic WFP session of
//! their own, so the kernel removes them when the service dies, and they
//! are released the moment the engine stops -- before DNS and phonebook
//! tidying (K1) -- and on any report that the engine went (K2), not only a
//! definitive one. A plan the engine itself trips over is released within
//! seconds and reported, never left to look like censorship (K5).
//!
//! # This file
//!
//! The plan is pure, so it can be tested where WFP cannot be: [`plan_for`]
//! decides whether a session is confined and with what, [`specs`] turns
//! that into filters, and [`lan_prefixes`] decides what "the LAN" is.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;

use neoconnect_ipc::ConnectProfile;

/// Whether IKEv2 sessions are confined.
///
/// Off, and a constant on purpose. IKEv2's plan is written and tested --
/// IKE permitted by its local ports, ESP by protocol to the server (K3) --
/// but nothing about how Windows' IKE service is classified at ALE has
/// been measured: its local ports, NAT-T, raw ESP, a MOBIKE move changing
/// the interface. It ships when its own VM gate (Phase 3b) passes, in the
/// commit that records the gate. IKEv2 keeps working meanwhile, unconfined
/// as before; no protocol is dropped for want of this.
pub const IKEV2_CONFINED: bool = false;

/// The concurrent exits a session can carry, past the primary. The same
/// ceiling the connect applies; a plan built from a longer list keeps the
/// first ones.
const MAX_NODES: usize = 1 + neoconnect_ipc::MAX_CONCURRENT_EXITS;

/// On-link prefixes wider than this are narrowed to the /24 around the
/// adapter's own address. A home or office LAN is a /24 or so; a /8 on a
/// mobile modem is the carrier's network, not the customer's.
const WIDEST_LAN: u8 = 16;

/// An IPv4 prefix, held normalised: no bits set past its length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Prefix {
    pub addr: Ipv4Addr,
    pub len: u8,
}

fn mask(len: u8) -> u32 {
    match len.min(32) {
        0 => 0,
        len => u32::MAX << (32 - u32::from(len)),
    }
}

impl Prefix {
    pub fn new(addr: Ipv4Addr, len: u8) -> Self {
        let len = len.min(32);
        Self { addr: Ipv4Addr::from(u32::from(addr) & mask(len)), len }
    }

    pub fn host(addr: Ipv4Addr) -> Self {
        Self::new(addr, 32)
    }

    pub fn contains(&self, addr: Ipv4Addr) -> bool {
        u32::from(addr) & mask(self.len) == u32::from(self.addr)
    }

    /// The address and mask WFP takes in `FWP_V4_ADDR_AND_MASK`: host
    /// order, as `u32::from(Ipv4Addr)` gives it -- not the octets in
    /// memory order, which is what a socket address holds.
    pub fn wfp(&self) -> (u32, u32) {
        (u32::from(self.addr), mask(self.len))
    }

    /// The same prefix as IPv4-mapped IPv6: `::ffff:a.b.c.d`, 96 bits
    /// longer.
    pub fn mapped(&self) -> (Ipv6Addr, u8) {
        (self.addr.to_ipv6_mapped(), 96 + self.len)
    }
}

/// IP protocol numbers, as WFP's `FWPM_CONDITION_IP_PROTOCOL` takes them.
pub mod protocol {
    pub const TCP: u8 = 6;
    pub const UDP: u8 = 17;
    pub const ESP: u8 = 50;
}

/// The engine's own way to its server: the one thing outside the tunnel a
/// session's plan lets through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    /// xray.exe to each of its servers -- the primary and every concurrent
    /// exit -- on any port and protocol. Its config has proxy outbounds
    /// only (`xray::build_multi_exit_config`), so there is nothing else
    /// xray.exe sends that needs a way around the tunnel.
    Xray { exe: PathBuf, nodes: Vec<Ipv4Addr> },
    /// openvpn.exe to its server, on the server's port and protocol. Its
    /// own socket, because OpenVPN runs on Wintun here, not DCO (whose
    /// socket is the kernel's and has no application to name).
    Openvpn { exe: PathBuf, node: Ipv4Addr, port: u16, protocol: u8 },
    /// Windows' IKE service by its local ports 500 and 4500, whoever it
    /// talks to, and ESP to the server's addresses (K3). Not shipped; see
    /// [`IKEV2_CONFINED`].
    Ikev2 { nodes: Vec<Ipv4Addr> },
}

/// Whether the LAN stays reachable while confined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lan {
    /// Reachable: these on-link prefixes (from [`lan_prefixes`]), plus
    /// link-local, multicast and the limited broadcast. The product's
    /// setting, by the owner's decision (a).
    Allowed(Vec<Prefix>),
    /// Not reachable. Kept so the plan can say it, and so a test can show
    /// what the LAN permits are by their absence; nothing ships it.
    Refused,
}

/// What a plan is built from, gathered at connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inputs {
    /// The tunnel adapter's interface LUID; zero when it could not be read.
    pub tunnel_luid: u64,
    /// The engine's executable, for the engines that have one.
    pub engine_exe: Option<PathBuf>,
    /// The server's address and, for Xray, each concurrent exit's.
    pub nodes: Vec<Ipv4Addr>,
    pub lan: Lan,
}

/// One session's confinement, as decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub tunnel_luid: u64,
    pub transport: Transport,
    pub lan: Lan,
}

/// Whether a session is confined, and with what.
///
/// `None`: not this session's -- Custom mode (`passive`, both variants),
/// WireGuard (its own kill switch, K8), IKEv2 while [`IKEV2_CONFINED`] is
/// off. `Some(Err)`: it should be, and cannot be, because what the
/// engine's permit needs is missing; installing the rest would block the
/// engine's own connection, which is a protocol killed by a filter (K5).
/// The caller reports that as not confined, and keeps the tunnel.
pub fn plan_for(profile: &ConnectProfile, passive: bool, inputs: Inputs) -> Option<Result<Plan, String>> {
    plan_with(profile, passive, inputs, IKEV2_CONFINED)
}

fn plan_with(profile: &ConnectProfile, passive: bool, inputs: Inputs, ikev2: bool) -> Option<Result<Plan, String>> {
    use ConnectProfile as P;
    if passive {
        return None;
    }
    let mut nodes: Vec<Ipv4Addr> = Vec::new();
    for node in inputs.nodes {
        if !nodes.contains(&node) && nodes.len() < MAX_NODES {
            nodes.push(node);
        }
    }
    let transport = match profile {
        P::Wireguard(_) => return None,
        P::Ikev2(_) if !ikev2 => return None,
        P::Ikev2(_) => {
            if nodes.is_empty() {
                return Some(Err("the IKEv2 server's address is not known".into()));
            }
            Transport::Ikev2 { nodes }
        }
        P::XrayVlessReality(_) | P::XrayVlessTls(_) | P::XrayTrojan(_) | P::Shadowsocks(_) => {
            let Some(exe) = inputs.engine_exe else {
                return Some(Err("xray.exe could not be named to the filtering platform".into()));
            };
            if nodes.is_empty() {
                return Some(Err("the server's address is not known".into()));
            }
            Transport::Xray { exe, nodes }
        }
        P::Openvpn(p) => {
            let Some(exe) = inputs.engine_exe else {
                return Some(Err("openvpn.exe could not be named to the filtering platform".into()));
            };
            let Some(&node) = nodes.first() else {
                return Some(Err("the server's address is not known".into()));
            };
            let Some(port) = p.endpoint.rsplit_once(':').and_then(|(_, port)| port.parse::<u16>().ok()) else {
                return Some(Err(format!("the server's port could not be read from {:?}", p.endpoint)));
            };
            let protocol = match p.proto.as_str() {
                "udp" => protocol::UDP,
                "tcp" => protocol::TCP,
                other => return Some(Err(format!("OpenVPN over {other:?} has no permit"))),
            };
            Transport::Openvpn { exe, node, port, protocol }
        }
    };
    if inputs.tunnel_luid == 0 {
        return Some(Err("the tunnel adapter's interface could not be read".into()));
    }
    Some(Ok(Plan { tunnel_luid: inputs.tunnel_luid, transport, lan: inputs.lan }))
}

/// A WFP layer this sublayer has filters at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Layer {
    ConnectV4,
    RecvAcceptV4,
    ConnectV6,
    RecvAcceptV6,
}

impl Layer {
    pub fn is_v6(self) -> bool {
        matches!(self, Layer::ConnectV6 | Layer::RecvAcceptV6)
    }

    fn direction(self) -> &'static str {
        match self {
            Layer::ConnectV4 | Layer::ConnectV6 => "outbound",
            Layer::RecvAcceptV4 | Layer::RecvAcceptV6 => "inbound",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Permit,
    Block,
}

/// One condition. Different kinds on one filter must all hold (WFP ANDs
/// different fields); no filter here repeats a kind, which WFP would OR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cond {
    /// Traffic Windows has marked as loopback, whatever its address.
    Loopback,
    RemoteV4(Prefix),
    RemoteV6(Ipv6Addr, u8),
    /// The interface the flow uses, by LUID.
    LocalInterface(u64),
    /// One executable, resolved to WFP's app id at install.
    App(PathBuf),
    RemotePort(u16),
    LocalPort(u16),
    Protocol(u8),
}

/// One filter, as planned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterSpec {
    /// What `netsh wfp show filters` prints; every one begins "Neoxify".
    pub name: String,
    pub layer: Layer,
    pub action: Action,
    pub weight: u8,
    pub conds: Vec<Cond>,
}

/// Filter weights inside this sublayer, `FWP_UINT8`: the highest-weight
/// matching filter decides. The order is the policy.
pub const WEIGHT_LOOPBACK: u8 = 15;
pub const WEIGHT_TUNNEL: u8 = 14;
pub const WEIGHT_TRANSPORT: u8 = 13;
pub const WEIGHT_DHCP: u8 = 12;
pub const WEIGHT_LAN: u8 = 11;
pub const WEIGHT_BLOCK: u8 = 0;

/// Link-local (APIPA), multicast and the limited broadcast: the LAN's
/// own plumbing, whatever its prefix.
fn lan_plumbing() -> [Prefix; 3] {
    [
        Prefix::new(Ipv4Addr::new(169, 254, 0, 0), 16),
        Prefix::new(Ipv4Addr::new(224, 0, 0, 0), 4),
        Prefix::host(Ipv4Addr::BROADCAST),
    ]
}

/// The filters for a plan, in the order they go in.
///
/// At each V4 layer, both directions: loopback, the tunnel, the engine,
/// DHCP, the LAN, then a block of everything. At the matching V6 layer,
/// the same permits with their addresses IPv4-mapped, then a block of
/// `::ffff:0:0/96` only (K4) -- native IPv6 is the IPv6 block's, in its own
/// sublayer. P0-B measured Windows judging a dual-mode socket's IPv4 at the
/// V4 layers, so the mapped filters are expected never to match; they keep
/// the V6 block from refusing anything the V4 rules permit should some
/// path classify that traffic at V6.
pub fn specs(plan: &Plan) -> Vec<FilterSpec> {
    let mut v4: Vec<(u8, String, Vec<Cond>)> = vec![
        (WEIGHT_LOOPBACK, "permit loopback".into(), vec![Cond::Loopback]),
        (
            WEIGHT_LOOPBACK,
            "permit 127.0.0.0/8".into(),
            vec![Cond::RemoteV4(Prefix::new(Ipv4Addr::new(127, 0, 0, 0), 8))],
        ),
        (WEIGHT_TUNNEL, "permit the tunnel".into(), vec![Cond::LocalInterface(plan.tunnel_luid)]),
    ];
    match &plan.transport {
        Transport::Xray { exe, nodes } => {
            for node in nodes {
                v4.push((
                    WEIGHT_TRANSPORT,
                    format!("permit xray.exe to its server {node}"),
                    vec![Cond::App(exe.clone()), Cond::RemoteV4(Prefix::host(*node))],
                ));
            }
        }
        Transport::Openvpn { exe, node, port, protocol } => v4.push((
            WEIGHT_TRANSPORT,
            format!("permit openvpn.exe to its server {node}:{port}"),
            vec![
                Cond::App(exe.clone()),
                Cond::RemoteV4(Prefix::host(*node)),
                Cond::RemotePort(*port),
                Cond::Protocol(*protocol),
            ],
        )),
        Transport::Ikev2 { nodes } => {
            for port in [500, 4500] {
                v4.push((
                    WEIGHT_TRANSPORT,
                    format!("permit IKE from local UDP {port}"),
                    vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(port)],
                ));
            }
            for node in nodes {
                v4.push((
                    WEIGHT_TRANSPORT,
                    format!("permit ESP to its server {node}"),
                    vec![Cond::Protocol(protocol::ESP), Cond::RemoteV4(Prefix::host(*node))],
                ));
            }
        }
    }
    v4.push((
        WEIGHT_DHCP,
        "permit DHCP".into(),
        vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(68), Cond::RemotePort(67)],
    ));
    if let Lan::Allowed(prefixes) = &plan.lan {
        let mut lan: Vec<Prefix> = Vec::new();
        for prefix in prefixes.iter().copied().chain(lan_plumbing()) {
            if !lan.contains(&prefix) {
                lan.push(prefix);
            }
        }
        for prefix in lan {
            v4.push((WEIGHT_LAN, format!("permit the LAN {}/{}", prefix.addr, prefix.len), vec![Cond::RemoteV4(prefix)]));
        }
    }

    let mut specs = Vec::new();
    for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
        for (weight, name, conds) in &v4 {
            specs.push(FilterSpec {
                name: format!("Neoxify: {name} ({})", layer.direction()),
                layer,
                action: Action::Permit,
                weight: *weight,
                conds: conds.clone(),
            });
        }
        specs.push(FilterSpec {
            name: format!("Neoxify: block all {} IPv4 outside the tunnel", layer.direction()),
            layer,
            action: Action::Block,
            weight: WEIGHT_BLOCK,
            conds: Vec::new(),
        });
    }
    for layer in [Layer::ConnectV6, Layer::RecvAcceptV6] {
        for (weight, name, conds) in &v4 {
            specs.push(FilterSpec {
                name: format!("Neoxify: {name}, IPv4-mapped ({})", layer.direction()),
                layer,
                action: Action::Permit,
                weight: *weight,
                conds: conds.iter().map(mapped).collect(),
            });
        }
        specs.push(FilterSpec {
            name: format!("Neoxify: block all {} IPv4-mapped outside the tunnel", layer.direction()),
            layer,
            action: Action::Block,
            weight: WEIGHT_BLOCK,
            conds: vec![Cond::RemoteV6(Ipv4Addr::UNSPECIFIED.to_ipv6_mapped(), 96)],
        });
    }
    specs
}

/// A V4 condition's twin at a V6 layer.
fn mapped(cond: &Cond) -> Cond {
    match cond {
        Cond::RemoteV4(prefix) => {
            let (addr, len) = prefix.mapped();
            Cond::RemoteV6(addr, len)
        }
        other => other.clone(),
    }
}

/// What [`lan_prefixes`] needs to know about an adapter.
#[derive(Debug, Clone, Copy)]
pub struct LanAdapter<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub is_up: bool,
    pub ipv4: Option<Ipv4Addr>,
    /// `OnLinkPrefixLength` of that address.
    pub prefix_len: Option<u8>,
}

/// Whether an address is private in the RFC 1918 sense. Carrier-grade NAT
/// (`100.64/10`) is not: it is the ISP's.
fn is_rfc1918(addr: Ipv4Addr) -> bool {
    let o = addr.octets();
    o[0] == 10 || (o[0] == 172 && (16..32).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// The LAN, as the machine's own adapters are on it: the private on-link
/// prefix of every up adapter that is neither ours (by name) nor another
/// VPN's (by driver), each once. Fixed at connect -- a network joined later
/// is refused until the next connect, a stated limitation.
///
/// Only RFC 1918 addresses name a LAN: a public on-link prefix is the
/// internet, and `100.64/10` is the carrier's network on the mobile lines
/// many of this product's customers use. An on-link prefix wider than
/// [`WIDEST_LAN`] is narrowed to the /24 around the adapter's address. An
/// APIPA address needs nothing here: link-local is permitted whole.
pub fn lan_prefixes(adapters: &[LanAdapter], ours: &[&str]) -> Vec<Prefix> {
    let mut lan = Vec::new();
    for adapter in adapters {
        if !adapter.is_up || ours.iter().any(|o| adapter.name.eq_ignore_ascii_case(o)) {
            continue;
        }
        if crate::adapters::looks_like_vpn(adapter.description) {
            continue;
        }
        let (Some(addr), Some(len)) = (adapter.ipv4, adapter.prefix_len) else { continue };
        if !is_rfc1918(addr) {
            continue;
        }
        let prefix = if len < WIDEST_LAN { Prefix::new(addr, 24) } else { Prefix::new(addr, len) };
        if !lan.contains(&prefix) {
            lan.push(prefix);
        }
    }
    lan
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::{
        Ikev2Profile, OpenvpnProfile, ShadowsocksProfile, TrojanProfile, VlessTlsProfile, WireguardProfile,
        XrayProfile,
    };

    const LUID: u64 = 0x0011_2233_4455_6677;

    fn node() -> Ipv4Addr {
        Ipv4Addr::new(203, 0, 113, 7)
    }

    fn exit_nodes() -> Vec<Ipv4Addr> {
        vec![Ipv4Addr::new(198, 51, 100, 1), Ipv4Addr::new(198, 51, 100, 2), Ipv4Addr::new(198, 51, 100, 3)]
    }

    fn xray_exe() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Neoxify\xray.exe")
    }

    fn openvpn_exe() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Neoxify\openvpn.exe")
    }

    fn home_lan() -> Lan {
        Lan::Allowed(vec![Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24)])
    }

    fn inputs(engine_exe: Option<PathBuf>, nodes: Vec<Ipv4Addr>) -> Inputs {
        Inputs { tunnel_luid: LUID, engine_exe, nodes, lan: home_lan() }
    }

    fn reality() -> ConnectProfile {
        ConnectProfile::XrayVlessReality(XrayProfile {
            uuid: String::new(),
            flow: String::new(),
            host: node().to_string(),
            port: 443,
            reality_public_key: String::new(),
            short_id: String::new(),
            server_name: "www.example.com".into(),
        })
    }

    fn the_xray_protocols() -> Vec<ConnectProfile> {
        vec![
            reality(),
            ConnectProfile::XrayVlessTls(VlessTlsProfile {
                uuid: String::new(),
                flow: String::new(),
                host: node().to_string(),
                port: 443,
                server_name: "www.example.com".into(),
                ws_path: None,
            }),
            ConnectProfile::XrayVlessTls(VlessTlsProfile {
                uuid: String::new(),
                flow: String::new(),
                host: node().to_string(),
                port: 443,
                server_name: "www.example.com".into(),
                ws_path: Some("/ws".into()),
            }),
            ConnectProfile::XrayTrojan(TrojanProfile {
                password: String::new(),
                host: node().to_string(),
                port: 443,
                server_name: "www.example.com".into(),
            }),
            ConnectProfile::Shadowsocks(ShadowsocksProfile {
                host: node().to_string(),
                port: 8388,
                method: "2022-blake3-aes-128-gcm".into(),
                password: String::new(),
            }),
        ]
    }

    fn openvpn(proto: &str, port: u16) -> ConnectProfile {
        ConnectProfile::Openvpn(OpenvpnProfile {
            cert_pem: String::new(),
            key_pem: String::new(),
            ca_cert_pem: String::new(),
            endpoint: format!("{}:{port}", node()),
            proto: proto.into(),
            tls_crypt_key: None,
        })
    }

    fn ikev2() -> ConnectProfile {
        ConnectProfile::Ikev2(Ikev2Profile {
            server: "node.example.com".into(),
            username: String::new(),
            password: String::new(),
        })
    }

    fn wireguard() -> ConnectProfile {
        ConnectProfile::Wireguard(WireguardProfile {
            private_key: String::new(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0, ::/0".into(),
            server_public_key: String::new(),
            endpoint: format!("{}:51820", node()),
        })
    }

    fn every_profile() -> Vec<ConnectProfile> {
        let mut all = the_xray_protocols();
        all.extend([openvpn("udp", 1194), openvpn("tcp", 443), ikev2(), wireguard()]);
        all
    }

    fn xray_plan() -> Plan {
        let mut nodes = vec![node()];
        nodes.extend(exit_nodes());
        plan_for(&reality(), false, inputs(Some(xray_exe()), nodes))
            .expect("a full Xray tunnel is confined")
            .expect("and has everything its plan needs")
    }

    fn at(specs: &[FilterSpec], layer: Layer, weight: u8) -> Vec<FilterSpec> {
        specs.iter().filter(|s| s.layer == layer && s.weight == weight).cloned().collect()
    }

    fn the_four_layers() -> [Layer; 4] {
        [Layer::ConnectV4, Layer::RecvAcceptV4, Layer::ConnectV6, Layer::RecvAcceptV6]
    }

    /// Custom mode is a passive tunnel in both its variants -- "only these
    /// apps" and "all except these" -- and gets no confinement in either:
    /// its redirect carries the chosen applications, and a machine-wide
    /// IPv4 block would take the rest of the machine's internet away
    /// (`ipv6_block::SelectedAppsIpv6Block` has the argument). The owner's
    /// decision (b) on 2026-10-12 keeps it that way.
    #[test]
    fn none_in_custom_mode_both_variants() {
        for profile in every_profile() {
            let exe = Some(xray_exe());
            assert_eq!(plan_for(&profile, true, inputs(exe.clone(), vec![node()])), None, "{profile:?}");
            assert_eq!(plan_with(&profile, true, inputs(exe, vec![node()]), true), None, "{profile:?}");
        }
    }

    /// The one thing outside the tunnel Xray needs is xray.exe's own
    /// connection to its servers: the primary and every concurrent exit,
    /// on whatever port each listens on. Nothing else xray.exe does needs
    /// a way around the tunnel -- its config has proxy outbounds only.
    #[test]
    fn xray_permits_app_and_every_exit_node() {
        for profile in the_xray_protocols() {
            let mut nodes = vec![node()];
            nodes.extend(exit_nodes());
            // A duplicate and one exit past the ceiling, both dropped.
            nodes.push(node());
            nodes.push(Ipv4Addr::new(198, 51, 100, 4));
            let plan = plan_for(&profile, false, inputs(Some(xray_exe()), nodes)).expect("planned").expect("built");
            let specs = specs(&plan);
            for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
                let permits = at(&specs, layer, WEIGHT_TRANSPORT);
                let mut expected: Vec<Vec<Cond>> = vec![vec![Cond::App(xray_exe()), Cond::RemoteV4(Prefix::host(node()))]];
                for exit in exit_nodes() {
                    expected.push(vec![Cond::App(xray_exe()), Cond::RemoteV4(Prefix::host(exit))]);
                }
                let got: Vec<Vec<Cond>> = permits.iter().map(|s| s.conds.clone()).collect();
                assert_eq!(got, expected, "{profile:?} at {layer:?}");
                assert!(permits.iter().all(|s| s.action == Action::Permit));
            }
        }
    }

    /// OpenVPN's permit is as narrow as its config: openvpn.exe, to the
    /// server, on the server's port and the protocol it was told to use.
    #[test]
    fn openvpn_permit_has_app_remote_port_and_protocol() {
        for (proto, port, number) in [("udp", 1194, protocol::UDP), ("tcp", 443, protocol::TCP)] {
            let plan = plan_for(&openvpn(proto, port), false, inputs(Some(openvpn_exe()), vec![node()]))
                .expect("a full OpenVPN tunnel is confined")
                .expect("built");
            let specs = specs(&plan);
            for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
                let permits = at(&specs, layer, WEIGHT_TRANSPORT);
                assert_eq!(permits.len(), 1, "{proto} at {layer:?}: {permits:?}");
                assert_eq!(
                    permits[0].conds,
                    vec![
                        Cond::App(openvpn_exe()),
                        Cond::RemoteV4(Prefix::host(node())),
                        Cond::RemotePort(port),
                        Cond::Protocol(number),
                    ],
                    "{proto} at {layer:?}"
                );
            }
        }
    }

    /// IKEv2 is dialled by Windows' own client, by the certificate's name,
    /// which RAS resolves for itself (K3): a permit keyed on the address
    /// we resolved would kill the tunnel the moment RAS's answer differed.
    /// So IKE is permitted by its *local* ports, whoever it talks to, and
    /// ESP by protocol to the addresses the server is known by. Planned,
    /// tested, and not installed: see `IKEV2_CONFINED`.
    #[test]
    fn ikev2_permits_ike_by_local_port_and_esp_to_node() {
        let plan = plan_with(&ikev2(), false, inputs(None, vec![node()]), true).expect("planned").expect("built");
        let specs = specs(&plan);
        for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
            let got: Vec<Vec<Cond>> = at(&specs, layer, WEIGHT_TRANSPORT).into_iter().map(|s| s.conds).collect();
            assert_eq!(
                got,
                vec![
                    vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(500)],
                    vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(4500)],
                    vec![Cond::Protocol(protocol::ESP), Cond::RemoteV4(Prefix::host(node()))],
                ],
                "at {layer:?}"
            );
        }
    }

    /// The flag that keeps IKEv2's plan out of the product until its own
    /// VM gate passes (Phase 3b): a constant, flipped in the commit that
    /// records the gate. IKEv2 keeps working meanwhile, unconfined as
    /// before -- no protocol is dropped for want of it.
    #[test]
    fn ikev2_plan_enabled_flag_default_off_until_proven() {
        assert!(!IKEV2_CONFINED, "IKEv2's confinement has not passed its VM gate");
        assert_eq!(plan_for(&ikev2(), false, inputs(None, vec![node()])), None);
    }

    /// wireguard.exe arms its own kill switch, and two providers' IPv4
    /// blocks over one tunnel is what `ipv6_block::needed_for` argues
    /// against (K8). WireGuard gets no plan of ours.
    #[test]
    fn wireguard_gets_no_plan() {
        assert_eq!(plan_for(&wireguard(), false, inputs(None, vec![node()])), None);
        assert_eq!(plan_with(&wireguard(), false, inputs(None, vec![node()]), true), None);
    }

    /// A plan that would block the engine's own connection is a protocol
    /// killed by a filter (K5). One that cannot name what the permit needs
    /// -- the server's address, the engine, the tunnel -- is refused with a
    /// reason, never built without the permit.
    #[test]
    fn a_full_tunnel_missing_what_its_permit_needs_is_refused_not_planned() {
        let refused = |profile: &ConnectProfile, inputs: Inputs| match plan_for(profile, false, inputs) {
            Some(Err(why)) => why,
            other => panic!("{profile:?} should have been refused, got {other:?}"),
        };
        assert!(!refused(&reality(), inputs(Some(xray_exe()), vec![])).is_empty());
        assert!(!refused(&reality(), inputs(None, vec![node()])).is_empty());
        assert!(!refused(&openvpn("udp", 1194), inputs(Some(openvpn_exe()), vec![])).is_empty());
        assert!(!refused(&openvpn("udp", 1194), inputs(None, vec![node()])).is_empty());
        let no_tunnel = Inputs { tunnel_luid: 0, ..inputs(Some(xray_exe()), vec![node()]) };
        assert!(!refused(&reality(), no_tunnel).is_empty());
    }

    fn weight_of(specs: &[FilterSpec], layer: Layer, matches: impl Fn(&FilterSpec) -> bool) -> u8 {
        let found: Vec<&FilterSpec> = specs.iter().filter(|s| s.layer == layer && matches(s)).collect();
        assert!(!found.is_empty(), "nothing at {layer:?} matched");
        let weight = found[0].weight;
        assert!(found.iter().all(|s| s.weight == weight), "one kind of permit at two weights: {found:?}");
        weight
    }

    /// Within a sublayer the highest-weight matching filter decides, so the
    /// order of the weights is the policy: loopback over the tunnel over
    /// the engine over DHCP over the LAN, and the block under everything.
    #[test]
    fn weights_loopback_gt_tunnel_gt_transport_gt_dhcp_gt_lan_gt_block() {
        let specs = specs(&xray_plan());
        let home = Ipv4Addr::new(192, 168, 1, 0);
        for layer in the_four_layers() {
            let loopback = weight_of(&specs, layer, |s| s.conds == [Cond::Loopback]);
            let tunnel = weight_of(&specs, layer, |s| s.conds == [Cond::LocalInterface(LUID)]);
            let transport = weight_of(&specs, layer, |s| s.conds.iter().any(|c| matches!(c, Cond::App(_))));
            let dhcp = weight_of(&specs, layer, |s| s.conds.contains(&Cond::LocalPort(68)));
            let lan = weight_of(&specs, layer, |s| {
                s.conds == [Cond::RemoteV4(Prefix::new(home, 24))]
                    || s.conds == [Cond::RemoteV6(home.to_ipv6_mapped(), 120)]
            });
            let block = weight_of(&specs, layer, |s| s.action == Action::Block);
            assert!(
                loopback > tunnel && tunnel > transport && transport > dhcp && dhcp > lan && lan > block,
                "at {layer:?}: loopback {loopback}, tunnel {tunnel}, transport {transport}, dhcp {dhcp}, lan {lan}, block {block}"
            );
            assert_eq!(block, WEIGHT_BLOCK);
            assert!(loopback <= 15, "FWP_UINT8 weights run 0-15");
        }
    }

    fn mapped_twin(cond: &Cond) -> Cond {
        match cond {
            Cond::RemoteV4(prefix) => {
                let (addr, len) = prefix.mapped();
                Cond::RemoteV6(addr, len)
            }
            other => other.clone(),
        }
    }

    /// Every IPv4 permit is repeated at the V6 layer it pairs with, its
    /// addresses IPv4-mapped. P0-B measured Windows judging a dual-mode
    /// socket's IPv4 at the V4 layers, so these are expected never to
    /// match; they are kept because the V6 block below them must not be
    /// able to refuse anything the V4 rules permit if some path does
    /// classify that traffic at V6 (K4).
    #[test]
    fn every_v4_permit_has_a_mapped_v6_twin() {
        let specs = specs(&xray_plan());
        for (v4, v6) in [(Layer::ConnectV4, Layer::ConnectV6), (Layer::RecvAcceptV4, Layer::RecvAcceptV6)] {
            let permits: Vec<&FilterSpec> =
                specs.iter().filter(|s| s.layer == v4 && s.action == Action::Permit).collect();
            assert!(!permits.is_empty());
            for permit in permits {
                let twin: Vec<Cond> = permit.conds.iter().map(mapped_twin).collect();
                assert!(
                    specs.iter().any(|s| s.layer == v6
                        && s.action == Action::Permit
                        && s.weight == permit.weight
                        && s.conds == twin),
                    "no {v6:?} twin of {permit:?}"
                );
            }
        }
    }

    /// The V6 block in this sublayer covers the IPv4-mapped range and
    /// nothing else (K4). Native IPv6 is the IPv6 block's job, in its own
    /// sublayer; a block-all here would duplicate it with a different
    /// lifetime. The V4 blocks are the unconditional ones.
    #[test]
    fn v6_block_in_this_sublayer_covers_only_ffff_0_0_96() {
        let specs = specs(&xray_plan());
        for layer in [Layer::ConnectV6, Layer::RecvAcceptV6] {
            let blocks: Vec<&FilterSpec> = specs.iter().filter(|s| s.layer == layer && s.action == Action::Block).collect();
            assert_eq!(blocks.len(), 1, "{layer:?}");
            assert_eq!(blocks[0].conds, vec![Cond::RemoteV6(Ipv4Addr::UNSPECIFIED.to_ipv6_mapped(), 96)], "{layer:?}");
            assert!(specs.iter().filter(|s| s.layer == layer).all(|s| !s.conds.is_empty()), "{layer:?}");
        }
        for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
            let blocks: Vec<&FilterSpec> = specs.iter().filter(|s| s.layer == layer && s.action == Action::Block).collect();
            assert_eq!(blocks.len(), 1, "{layer:?}");
            assert!(blocks[0].conds.is_empty(), "the IPv4 block is everything the permits did not claim");
        }
    }

    /// Nothing is let past the block on one condition that does not say
    /// where it goes, except loopback; and an application is never
    /// permitted anywhere, only to the servers its permit names.
    #[test]
    fn no_unconditional_permit_except_loopback() {
        let mut every = specs(&xray_plan());
        let openvpn_plan =
            plan_for(&openvpn("udp", 1194), false, inputs(Some(openvpn_exe()), vec![node()])).expect("planned").expect("built");
        every.extend(specs(&openvpn_plan));
        let ikev2_plan = plan_with(&ikev2(), false, inputs(None, vec![node()]), true).expect("planned").expect("built");
        every.extend(specs(&ikev2_plan));
        assert!(!every.is_empty());
        for spec in every.iter().filter(|s| s.action == Action::Permit) {
            assert!(!spec.conds.is_empty(), "unconditional permit: {spec:?}");
            let scoped = spec.conds.iter().any(|c| {
                matches!(c, Cond::RemoteV4(_) | Cond::RemoteV6(..) | Cond::LocalInterface(_) | Cond::LocalPort(_))
            });
            assert!(scoped || spec.conds == [Cond::Loopback], "a permit not scoped to anywhere: {spec:?}");
            if spec.conds.iter().any(|c| matches!(c, Cond::App(_))) {
                assert!(
                    spec.conds.iter().any(|c| matches!(c, Cond::RemoteV4(_) | Cond::RemoteV6(..))),
                    "an application permitted everywhere: {spec:?}"
                );
            }
            assert!(spec.name.starts_with("Neoxify"), "{spec:?}");
        }
    }

    /// The tunnel is permitted by its interface, and DHCP by its ports,
    /// in both directions.
    #[test]
    fn the_tunnel_and_dhcp_are_permitted_both_ways() {
        let specs = specs(&xray_plan());
        for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
            let tunnel: Vec<Vec<Cond>> = at(&specs, layer, WEIGHT_TUNNEL).into_iter().map(|s| s.conds).collect();
            assert_eq!(tunnel, vec![vec![Cond::LocalInterface(LUID)]], "{layer:?}");
            let dhcp: Vec<Vec<Cond>> = at(&specs, layer, WEIGHT_DHCP).into_iter().map(|s| s.conds).collect();
            assert_eq!(dhcp, vec![vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(68), Cond::RemotePort(67)]], "{layer:?}");
        }
    }

    /// With the LAN allowed (the owner's decision (a)): the on-link
    /// prefixes handed in, link-local, multicast and the limited
    /// broadcast. Never `10/8` or `100.64/10` wholesale. With it refused,
    /// no LAN permit at all -- DHCP and the rest stay.
    #[test]
    fn the_lan_is_its_own_prefixes_and_link_local_multicast_and_broadcast() {
        let specs = specs(&xray_plan());
        let lan: Vec<Prefix> = at(&specs, Layer::ConnectV4, WEIGHT_LAN)
            .into_iter()
            .map(|s| match s.conds.as_slice() {
                [Cond::RemoteV4(p)] => *p,
                other => panic!("a LAN permit is one remote prefix, got {other:?}"),
            })
            .collect();
        for wanted in [
            Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24),
            Prefix::new(Ipv4Addr::new(169, 254, 0, 0), 16),
            Prefix::new(Ipv4Addr::new(224, 0, 0, 0), 4),
            Prefix::host(Ipv4Addr::BROADCAST),
        ] {
            assert!(lan.contains(&wanted), "{wanted:?} missing from {lan:?}");
        }
        assert!(!lan.contains(&Prefix::new(Ipv4Addr::new(10, 0, 0, 0), 8)));
        assert!(!lan.contains(&Prefix::new(Ipv4Addr::new(100, 64, 0, 0), 10)));

        let refused = Plan { lan: Lan::Refused, ..xray_plan() };
        let specs = super::specs(&refused);
        for layer in the_four_layers() {
            assert!(at(&specs, layer, WEIGHT_LAN).is_empty(), "{layer:?}");
            assert!(!at(&specs, layer, WEIGHT_DHCP).is_empty(), "{layer:?}");
        }
    }

    fn adapter<'a>(name: &'a str, description: &'a str, ipv4: [u8; 4], prefix_len: u8) -> LanAdapter<'a> {
        LanAdapter { name, description, is_up: true, ipv4: Some(Ipv4Addr::from(ipv4)), prefix_len: Some(prefix_len) }
    }

    /// The LAN is what the machine's own up, non-tunnel adapters are on,
    /// and only the private part of it (K7, decision (a)). A carrier-grade
    /// NAT range is the ISP's network, not the customer's -- common on
    /// Iranian mobile lines -- and a public on-link prefix is the
    /// internet. An on-link prefix wider than /16 (a mobile line handing
    /// out 10.x/8) is narrowed to the /24 around the address rather than
    /// permitted wholesale.
    #[test]
    fn lan_prefixes_keep_private_on_link_drop_public_cgnat_and_ours() {
        let ours = ["neoconnect0", "Neoxify-OpenVPN", "Neoxify", "neoconnect"];
        let mut down = adapter("Wi-Fi", "Intel(R) Wi-Fi 6 AX201", [10, 0, 0, 5], 24);
        down.is_up = false;
        let adapters = [
            adapter("Ethernet", "Realtek PCIe GbE Family Controller", [192, 168, 1, 23], 24),
            down,
            adapter("Local Area Connection* 10", "Microsoft Wi-Fi Direct Virtual Adapter #2", [192, 168, 137, 1], 24),
            adapter("vEthernet (WSL)", "Hyper-V Virtual Ethernet Adapter", [172, 29, 80, 1], 20),
            adapter("neoconnect0", "Wintun Userspace Tunnel", [198, 18, 0, 1], 30),
            adapter("Neoxify-OpenVPN", "Wintun Userspace Tunnel", [10, 8, 0, 6], 24),
            adapter("Tailscale", "Tailscale Tunnel", [100, 101, 102, 103], 10),
            adapter("Cellular", "Generic Mobile Broadband Adapter", [100, 70, 1, 2], 10),
            adapter("Broadband Connection", "WAN Miniport (PPPOE)", [203, 0, 113, 9], 32),
            adapter("Ethernet 2", "USB 4G LTE Modem", [10, 20, 30, 40], 8),
            adapter("Ethernet 3", "TAP-Windows Adapter V9", [10, 9, 0, 2], 24),
            adapter("Ethernet 4", "Realtek USB GbE Family Controller", [169, 254, 10, 1], 16),
            // The same LAN twice -- Wi-Fi and Ethernet on one router.
            adapter("Ethernet 5", "Intel(R) Ethernet Connection", [192, 168, 1, 40], 24),
        ];
        let got = lan_prefixes(&adapters, &ours);
        assert_eq!(
            got,
            vec![
                Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24),
                Prefix::new(Ipv4Addr::new(192, 168, 137, 0), 24),
                Prefix::new(Ipv4Addr::new(172, 29, 80, 0), 20),
                Prefix::new(Ipv4Addr::new(10, 20, 30, 0), 24),
            ]
        );
        let no_prefix = LanAdapter { prefix_len: None, ..adapter("Ethernet", "Realtek", [192, 168, 1, 23], 24) };
        assert!(lan_prefixes(&[no_prefix], &ours).is_empty(), "an address whose prefix is not known names no LAN");
    }

    /// WFP takes IPv4 conditions in host order (`FWP_V4_ADDR_AND_MASK`).
    /// Handing it network order -- the octets as they sit in memory -- is a
    /// permit for a different address, and for the engine's permit that is
    /// a protocol killed by its own filter (risk 2).
    #[test]
    fn v4_prefix_encodes_host_order() {
        assert_eq!(Prefix::new(Ipv4Addr::new(10, 0, 2, 0), 24).wfp(), (0x0A00_0200, 0xFFFF_FF00));
        assert_eq!(Prefix::new(Ipv4Addr::new(10, 0, 2, 77), 24).wfp(), (0x0A00_0200, 0xFFFF_FF00));
        assert_eq!(Prefix::host(Ipv4Addr::new(203, 0, 113, 7)).wfp(), (0xCB00_7107, 0xFFFF_FFFF));
        assert_eq!(Prefix::new(Ipv4Addr::new(224, 0, 0, 0), 4).wfp(), (0xE000_0000, 0xF000_0000));
        assert_eq!(Prefix::new(Ipv4Addr::new(1, 2, 3, 4), 0).wfp(), (0, 0));
    }
}
