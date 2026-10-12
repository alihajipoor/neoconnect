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
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{FWP_E_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FwpmEngineClose0, FwpmFilterAdd0, FwpmProviderAdd0, FwpmSubLayerAdd0, FwpmTransactionAbort0,
    FwpmTransactionBegin0, FwpmTransactionCommit0, FWPM_ACTION0, FWPM_CONDITION_ALE_APP_ID, FWPM_CONDITION_FLAGS,
    FWPM_CONDITION_IP_LOCAL_INTERFACE, FWPM_CONDITION_IP_LOCAL_PORT, FWPM_CONDITION_IP_PROTOCOL,
    FWPM_CONDITION_IP_REMOTE_ADDRESS, FWPM_CONDITION_IP_REMOTE_PORT, FWPM_FILTER0, FWPM_FILTER_CONDITION0,
    FWPM_FILTER_FLAG_NONE, FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, FWPM_PROVIDER0, FWPM_SUBLAYER0,
    FWP_ACTION_BLOCK, FWP_ACTION_PERMIT, FWP_BYTE_BLOB_TYPE, FWP_CONDITION_FLAG_IS_LOOPBACK, FWP_CONDITION_VALUE0,
    FWP_CONDITION_VALUE0_0, FWP_MATCH_EQUAL, FWP_MATCH_FLAGS_ALL_SET, FWP_UINT16, FWP_UINT32, FWP_UINT64, FWP_UINT8,
    FWP_V4_ADDR_AND_MASK, FWP_V4_ADDR_MASK, FWP_V6_ADDR_AND_MASK, FWP_V6_ADDR_MASK, FWP_VALUE0, FWP_VALUE0_0,
};

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

    #[cfg(test)]
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
    #[cfg_attr(not(test), allow(dead_code))]
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

/// Whether a session of this profile is confined at all -- the question
/// [`plan_for`] answers first, asked on its own so a connect gathers what a
/// plan needs (the tunnel's LUID, the LAN) only for a session that has one.
pub fn applies_to(profile: &ConnectProfile, passive: bool) -> bool {
    applies(profile, passive, IKEV2_CONFINED)
}

fn applies(profile: &ConnectProfile, passive: bool, ikev2: bool) -> bool {
    use ConnectProfile as P;
    !passive
        && match profile {
            P::Wireguard(_) => false,
            P::Ikev2(_) => ikev2,
            P::XrayVlessReality(_) | P::XrayVlessTls(_) | P::XrayTrojan(_) | P::Shadowsocks(_) | P::Openvpn(_) => true,
        }
}

fn plan_with(profile: &ConnectProfile, passive: bool, inputs: Inputs, ikev2: bool) -> Option<Result<Plan, String>> {
    use ConnectProfile as P;
    if !applies(profile, passive, ikev2) {
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

/// Why a confinement is let go of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Release {
    /// The session is ending: Disconnect, a connect clearing the decks, a
    /// dead engine's teardown, the hard stop.
    Teardown,
    /// The engine watch reported the engine gone -- definitive or not. Put
    /// back if the engine turns out to be alive (K2).
    Dropped,
    /// The engine was refused by the plan (K5): let go of for the rest of
    /// the session, with the reason.
    PlanError(String),
}

/// An installed confinement: the dynamic WFP session that holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installed {
    /// The engine handle, as an integer -- see `Ipv6Block::engine`.
    pub engine: isize,
    pub filters: usize,
}

/// What closes an installed confinement's session.
pub type Closer = std::sync::Arc<dyn Fn(isize) -> u32 + Send + Sync>;

/// A session's confinement, shared with everything that may have to let go
/// of it: the owning thread, the engine watch's thread (K2: a busy owning
/// thread must never keep a dead tunnel's block), and the plan-error valve.
///
/// One mutex over the whole state, and the engine handle taken out under
/// it, so whichever of them gets there first closes the WFP session and
/// every other finds nothing to close: exactly one close, whatever races.
/// The close itself is one `FwpmEngineClose0`, milliseconds.
pub struct Hold {
    state: std::sync::Mutex<HoldState>,
    close: Closer,
    /// `confinement.log`, for the lines that say what was let go of and
    /// why. `None` in tests.
    log: Option<PathBuf>,
}

#[derive(Default)]
struct HoldState {
    engine: isize,
    filters: usize,
    /// A plan was made for this session: the status poll answers
    /// `Some(_)` from here on, and `None` -- "not a confined session, do
    /// not warn" -- before.
    wanted: bool,
    /// Why it is not installed, while it is not.
    problem: Option<String>,
    /// A drop report let it go (or came before it was put). Cleared by
    /// [`Hold::rearm`] when the engine turns out to be alive.
    dropped: bool,
    /// The plan-error valve let it go. For good, this session.
    tripped: bool,
}

/// The reason given for a confinement let go of on a drop report.
const DROPPED: &str = "the tunnel engine was reported gone, so the filters were let go of until it is shown to be running";

impl Hold {
    /// A hold whose sessions are closed with `FwpmEngineClose0`, logging to
    /// `confinement.log` in `log_dir`.
    pub fn new(log_dir: &std::path::Path) -> std::sync::Arc<Self> {
        let close: Closer = std::sync::Arc::new(|engine| {
            // SAFETY: `engine` is a handle `install` opened, taken out of
            // the hold under its lock, so it is closed once.
            unsafe { FwpmEngineClose0(engine as HANDLE) }
        });
        std::sync::Arc::new(Self { state: Default::default(), close, log: Some(log_dir.join(LOG_FILE)) })
    }

    /// The same with a closer of the caller's -- for tests.
    #[cfg(test)]
    pub fn with_closer(close: Closer) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { state: Default::default(), close, log: None })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HoldState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn note(&self, line: &str) {
        if let Some(log) = &self.log {
            super::ipv6_block::note(log, line);
        }
    }

    /// Holds an installed confinement. Returns whether it is now held:
    /// after a drop report or a tripped valve it is closed at once instead,
    /// and one held already is closed and replaced.
    pub fn put(&self, installed: Installed) -> bool {
        let mut state = self.lock();
        state.wanted = true;
        if state.dropped || state.tripped {
            (self.close)(installed.engine);
            drop(state);
            self.note(&format!(
                "let go of at once: {} filters installed after the tunnel was reported gone or the plan was refused",
                installed.filters
            ));
            return false;
        }
        let earlier = std::mem::replace(&mut state.engine, installed.engine);
        state.filters = installed.filters;
        state.problem = None;
        if earlier != 0 {
            (self.close)(earlier);
        }
        true
    }

    /// Records that this session should be confined and is not, and why.
    pub fn refuse(&self, why: String) {
        let mut state = self.lock();
        state.wanted = true;
        state.problem = Some(why);
    }

    /// Lets go of the confinement, if one is held. Returns whether this
    /// call closed it. Safe from any thread, any number of times.
    pub fn release(&self, why: Release) -> bool {
        let mut state = self.lock();
        let engine = std::mem::take(&mut state.engine);
        let filters = state.filters;
        let reason = match &why {
            Release::Teardown => "the session ended".to_string(),
            Release::Dropped => {
                state.dropped = true;
                if state.wanted {
                    state.problem = Some(DROPPED.to_string());
                }
                "the tunnel engine was reported gone".to_string()
            }
            Release::PlanError(problem) => {
                state.tripped = true;
                state.wanted = true;
                state.problem = Some(problem.clone());
                problem.clone()
            }
        };
        if engine == 0 {
            return false;
        }
        let err = (self.close)(engine);
        drop(state);
        if err == 0 {
            self.note(&format!("removed: {filters} filters, IPv4 restored ({reason})"));
        } else {
            self.note(&format!("removal reported {err:#010x} ({reason}); the session ends with the process"));
        }
        true
    }

    /// The engine a drop report named turned out to be alive: a
    /// confinement may be put back. A tripped valve stays tripped.
    pub fn rearm(&self) {
        self.lock().dropped = false;
    }

    /// What the status poll reports as `ipv4_confined`: `None` for a
    /// session that was never to be confined, else whether it is now.
    pub fn confined(&self) -> Option<bool> {
        let state = self.lock();
        state.wanted.then_some(state.engine != 0)
    }

    /// Why it is not confined, while it should be and is not.
    pub fn problem(&self) -> Option<String> {
        let state = self.lock();
        if state.engine != 0 {
            return None;
        }
        state.problem.clone()
    }

    /// Let go of on a drop report, and not since put back or tripped: a
    /// confinement is owed if the engine is alive after all.
    pub fn owed_after_drop(&self) -> bool {
        let state = self.lock();
        state.wanted && state.dropped && !state.tripped && state.engine == 0
    }
}

/// The last holder letting go closes it too. Every teardown path releases
/// it explicitly, at the moment it chooses; this is for the path nobody
/// wrote -- an early return, a panic -- as `Ipv6Block`'s `Drop` is. And
/// the process ending closes the session whatever happens here.
impl Drop for Hold {
    fn drop(&mut self) {
        self.release(Release::Teardown);
    }
}

/// What a connect and a retraction need of the machine to confine a
/// session: the tunnel adapter's LUID, an install, and an empty hold. The
/// machine's, except in tests.
pub trait ConfinementOps: Send + Sync {
    /// The interface LUID of the adapter Windows shows by this name, read
    /// now -- a RAS interface can come back with a new one (K2).
    fn luid(&self, adapter: &str) -> Result<u64, String>;
    fn install(&self, plan: &Plan) -> Result<Installed, String>;
    fn hold(&self) -> std::sync::Arc<Hold>;
    /// One pass of the reset at connect: established IPv4 TCP outside the
    /// tunnel, closed (`split_tunnel::OutsideTunnel` has the rules).
    fn reset(&self, rules: &crate::split_tunnel::OutsideTunnel) -> crate::split_tunnel::ResetOutcome;
}

/// The machine.
pub struct System {
    pub log_dir: PathBuf,
}

impl ConfinementOps for System {
    fn luid(&self, adapter: &str) -> Result<u64, String> {
        use windows_sys::Win32::NetworkManagement::IpHelper::ConvertInterfaceIndexToLuid;
        use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
        let found = crate::adapters::find_by_name(adapter)
            .map_err(|e| format!("could not list adapters: {e}"))?
            .ok_or_else(|| format!("the tunnel adapter {adapter} was not found"))?;
        let mut luid = NET_LUID_LH { Value: 0 };
        // SAFETY: `luid` is a valid out-parameter for the call.
        let err = unsafe { ConvertInterfaceIndexToLuid(found.index, &mut luid) };
        if err != 0 {
            return Err(format!("could not read the tunnel adapter's LUID (interface {}, {err})", found.index));
        }
        // SAFETY: just written by the call above.
        Ok(unsafe { luid.Value })
    }

    fn install(&self, plan: &Plan) -> Result<Installed, String> {
        install(plan, &self.log_dir)
    }

    fn hold(&self) -> std::sync::Arc<Hold> {
        Hold::new(&self.log_dir)
    }

    fn reset(&self, rules: &crate::split_tunnel::OutsideTunnel) -> crate::split_tunnel::ResetOutcome {
        crate::split_tunnel::reset_outside_the_tunnel(rules)
    }
}

/// Writes a line to `confinement.log`: what the reset at connect closed is
/// recorded there, beside what the confinement installed and let go of,
/// so a packet capture can be checked against one file.
pub fn note(log_dir: &std::path::Path, line: &str) {
    super::ipv6_block::note(&log_dir.join(LOG_FILE), line);
}

/// The LAN a plan leaves reachable, as (address, prefix length): its
/// on-link prefixes and the LAN's own plumbing. Empty when the LAN is
/// refused. What the reset at connect leaves alone as the LAN.
pub fn lan_reachable(lan: &Lan) -> Vec<(Ipv4Addr, u8)> {
    match lan {
        Lan::Allowed(prefixes) => prefixes.iter().copied().chain(lan_plumbing()).map(|p| (p.addr, p.len)).collect(),
        Lan::Refused => Vec::new(),
    }
}

// ---------------------------------------------------------------------
// The plan-error valve (K5).
// ---------------------------------------------------------------------

/// How long after an install the engine's log is watched.
pub const VALVE_FOR: std::time::Duration = std::time::Duration::from_secs(10);

/// How often it is read meanwhile.
const VALVE_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

/// What each engine writes when a socket of its own is refused on this PC
/// (WSAEACCES, 10013) -- which, with this plan installed, is the plan
/// refusing the engine's link to its server.
///
/// PROVISIONAL: read from what the engines are known to print, not
/// captured from a refused engine. xray.exe is Go, whose error text asks
/// Windows for the English message ("...forbidden by its access
/// permissions.") and falls back to "winapi error #10013"; openvpn.exe 2.6
/// prints "Permission denied (WSAEACCES)" and the code. The VM's P3 step 8
/// is to capture the real lines and replace the fixtures in the tests.
fn refusal_marks(transport: &Transport) -> &'static [&'static str] {
    match transport {
        Transport::Xray { .. } => &["forbidden by its access permissions", "winapi error #10013"],
        Transport::Openvpn { .. } => &["(WSAEACCES)", "code=10013"],
        // Windows' IKE service writes no log of ours; RAS state would be
        // the witness. Not built: IKEv2 is not confined (IKEV2_CONFINED).
        Transport::Ikev2 { .. } => &[],
    }
}

/// The plan error in a stretch of an engine's log, if there is one: a
/// line where the engine's own connection was refused on this PC.
/// Timeouts, resets and unreachable networks are the network's and stay
/// the ladder's to judge.
pub fn plan_error_in(text: &str, transport: &Transport) -> Option<String> {
    let marks = refusal_marks(transport);
    let line = text.lines().find(|line| marks.iter().any(|mark| line.contains(mark)))?;
    let line: String = line.trim().chars().take(300).collect();
    Some(format!("the tunnel engine's own connection was refused by the IPv4 confinement, so it was let go of: {line}"))
}

/// The valve: reads what the engine writes to its log after the install
/// (from byte `from` on), for `window`, and lets go of the confinement at
/// the first plan error (K5) -- for the rest of the session, with the
/// reason. A wrong permit -- an address the engine dials that the plan did
/// not name, a byte-order slip -- otherwise looks exactly like censorship,
/// and the ladder would drop the protocol for it on every attempt, which
/// this project does not do.
///
/// A refusal that writes no log line is not caught; no engine here is
/// known to give one. Returns when the window ends, at the first plan
/// error, or when `stop` is set (the session ended).
pub fn run_valve(
    log: &std::path::Path,
    from: u64,
    transport: &Transport,
    hold: &Hold,
    stop: &std::sync::atomic::AtomicBool,
    window: std::time::Duration,
) {
    use std::io::{Read, Seek, SeekFrom};
    let deadline = std::time::Instant::now() + window;
    let mut at = from;
    let mut pending = String::new();
    loop {
        if let Ok(mut file) = std::fs::File::open(log) {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            // A log written afresh (a restarted engine truncates it) is
            // read from its start.
            if len < at {
                at = 0;
                pending.clear();
            }
            if len > at && file.seek(SeekFrom::Start(at)).is_ok() {
                let mut bytes = Vec::new();
                if file.take(len - at).read_to_end(&mut bytes).is_ok() {
                    at += bytes.len() as u64;
                    pending.push_str(&String::from_utf8_lossy(&bytes));
                    if let Some(why) = plan_error_in(&pending, transport) {
                        hold.release(Release::PlanError(why.clone()));
                        crate::cleanup_log::note("let go of the IPv4 confinement: the plan refused the engine", &why);
                        return;
                    }
                    // Keep only a partial last line for the next read.
                    if let Some(cut) = pending.rfind('\n') {
                        pending.drain(..=cut);
                    }
                }
            }
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return;
        }
        let step = VALVE_EVERY.min(deadline - now);
        if !crate::split_tunnel::worker::sleep_unless_stopped(stop, step) {
            return;
        }
    }
}

// ---------------------------------------------------------------------
// Installing a plan: a dynamic WFP session of its own.
// ---------------------------------------------------------------------

/// Ours: a provider separate from the IPv6 block's, so the two dynamic
/// sessions never share a provider object whose deletion order between
/// them is undefined. `pub(super)` so `repair` can sweep by it; nothing
/// outside this file creates objects under it.
pub(super) const CAPTURE_PROVIDER_KEY: GUID = GUID::from_u128(0x5e0f3a71_9c42_4d8b_a6e1_7b3c2f9d0a14);

/// The sublayer the plan's filters arbitrate in. Separate from the IPv6
/// block's, so it can be released first (K1) and so its weights decide
/// only among themselves.
pub(super) const CAPTURE_SUBLAYER_KEY: GUID = GUID::from_u128(0x6f1a4b82_ad53_4e9c_b7f2_8c4d3e0a1b25);

/// Next to the IPv6 block's 0xFFFF. The order sublayers are consulted in,
/// not whether a block wins -- a block in any sublayer does.
const SUBLAYER_WEIGHT: u16 = 0xFFFE;

const PROVIDER_NAME: &str = "Neoxify capture";
const SUBLAYER_NAME: &str = "Neoxify IPv4 confinement";
const LOG_FILE: &str = "confinement.log";

/// Installs a plan in a dynamic WFP session of its own, in one transaction:
/// all of it or none of it. Returns the session, for a [`Hold`].
///
/// Every application the plan names is resolved to WFP's app id first; one
/// that cannot be is a permit that cannot be written, and the plan is not
/// installed without it -- that would block the engine (K5).
pub fn install(plan: &Plan, log_dir: &std::path::Path) -> Result<Installed, String> {
    let log = log_dir.join(LOG_FILE);
    let specs = specs(plan);
    let result = install_specs(&specs);
    match &result {
        Ok(installed) => super::ipv6_block::note(
            &log,
            &format!(
                "installed: {} filters in a dynamic session, provider {PROVIDER_NAME}, sublayer {SUBLAYER_NAME}; {}",
                installed.filters,
                describe(plan)
            ),
        ),
        Err(e) => super::ipv6_block::note(&log, &format!("install failed: {e}")),
    }
    result
}

/// One line for the log: what the plan lets past, without the addresses
/// of the customer's own network.
fn describe(plan: &Plan) -> String {
    let transport = match &plan.transport {
        Transport::Xray { nodes, .. } => format!("xray.exe to {} server(s)", nodes.len()),
        Transport::Openvpn { port, protocol, .. } => {
            format!("openvpn.exe to its server on {} {port}", if *protocol == protocol::TCP { "TCP" } else { "UDP" })
        }
        Transport::Ikev2 { nodes } => format!("IKE by local port, ESP to {} server address(es)", nodes.len()),
    };
    let lan = match &plan.lan {
        Lan::Allowed(prefixes) => format!("LAN allowed ({} on-link prefix(es))", prefixes.len()),
        Lan::Refused => "LAN refused".to_string(),
    };
    format!("{transport}; {lan}")
}

fn install_specs(specs: &[FilterSpec]) -> Result<Installed, String> {
    use super::ipv6_block::AppId;
    // Resolved before the session opens, and held until it has committed:
    // the filters point into these blobs.
    let mut apps: Vec<(PathBuf, AppId)> = Vec::new();
    for spec in specs {
        for cond in &spec.conds {
            if let Cond::App(path) = cond {
                if apps.iter().any(|(p, _)| p == path) {
                    continue;
                }
                let id = AppId::resolve(&path.to_string_lossy())
                    .map_err(|e| format!("the engine could not be named to the filtering platform: {e}"))?;
                apps.push((path.clone(), id));
            }
        }
    }
    let engine = super::ipv6_block::open_dynamic_session_named(
        SUBLAYER_NAME,
        "Confines IPv4 to a Neoxify full tunnel; removed when it ends",
    )?;
    // SAFETY: `engine` is live, and every blob in `apps` outlives the call.
    match unsafe { build(engine, specs, &apps) } {
        Ok(filters) => Ok(Installed { engine: engine as isize, filters }),
        Err(e) => {
            // Closing the handle ends the session, which undoes whatever
            // a failed transaction left.
            // SAFETY: opened above and not shared.
            unsafe { FwpmEngineClose0(engine) };
            Err(e)
        }
    }
}

/// # Safety
/// `engine` must be live, and the blobs in `apps` must outlive the call.
unsafe fn build(engine: HANDLE, specs: &[FilterSpec], apps: &[(PathBuf, super::ipv6_block::AppId)]) -> Result<usize, String> {
    let err = FwpmTransactionBegin0(engine, 0);
    if err != 0 {
        return Err(format!("could not begin a filtering transaction ({err:#010x})"));
    }
    match add_everything(engine, specs, apps) {
        Ok(filters) => {
            let err = FwpmTransactionCommit0(engine);
            if err != 0 {
                FwpmTransactionAbort0(engine);
                return Err(format!("the IPv4 confinement could not be committed ({err:#010x})"));
            }
            Ok(filters)
        }
        Err(e) => {
            FwpmTransactionAbort0(engine);
            Err(e)
        }
    }
}

/// # Safety
/// Inside an open transaction; blobs alive for the duration.
unsafe fn add_everything(
    engine: HANDLE,
    specs: &[FilterSpec],
    apps: &[(PathBuf, super::ipv6_block::AppId)],
) -> Result<usize, String> {
    add_provider(engine)?;
    add_sublayer(engine)?;
    for spec in specs {
        add_spec(engine, spec, apps)?;
    }
    Ok(specs.len())
}

/// # Safety
/// Inside an open transaction.
unsafe fn add_provider(engine: HANDLE) -> Result<(), String> {
    let mut name = super::ipv6_block::wide(PROVIDER_NAME);
    let mut description = super::ipv6_block::wide("Neoxify VPN: IPv4 confined to a full tunnel");
    let mut provider: FWPM_PROVIDER0 = std::mem::zeroed();
    provider.providerKey = CAPTURE_PROVIDER_KEY;
    provider.displayData.name = name.as_mut_ptr();
    provider.displayData.description = description.as_mut_ptr();
    // Not persistent: it belongs to the dynamic session.
    provider.flags = 0;
    let err = FwpmProviderAdd0(engine, &provider, std::ptr::null_mut());
    if err == 0 || err == FWP_E_ALREADY_EXISTS as u32 {
        return Ok(());
    }
    Err(format!("could not register the {PROVIDER_NAME} filtering provider ({err:#010x})"))
}

/// # Safety
/// Inside an open transaction.
unsafe fn add_sublayer(engine: HANDLE) -> Result<(), String> {
    let mut name = super::ipv6_block::wide(SUBLAYER_NAME);
    let mut description = super::ipv6_block::wide("IPv4 confined to a Neoxify full tunnel; removed when it ends");
    let mut provider_key = CAPTURE_PROVIDER_KEY;
    let mut sublayer: FWPM_SUBLAYER0 = std::mem::zeroed();
    sublayer.subLayerKey = CAPTURE_SUBLAYER_KEY;
    sublayer.displayData.name = name.as_mut_ptr();
    sublayer.displayData.description = description.as_mut_ptr();
    sublayer.flags = 0;
    sublayer.providerKey = &mut provider_key;
    sublayer.weight = SUBLAYER_WEIGHT;
    let err = FwpmSubLayerAdd0(engine, &sublayer, std::ptr::null_mut());
    if err == 0 || err == FWP_E_ALREADY_EXISTS as u32 {
        return Ok(());
    }
    Err(format!("could not create the {SUBLAYER_NAME} sublayer ({err:#010x})"))
}

fn layer_key(layer: Layer) -> GUID {
    match layer {
        Layer::ConnectV4 => FWPM_LAYER_ALE_AUTH_CONNECT_V4,
        Layer::RecvAcceptV4 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
        Layer::ConnectV6 => FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        Layer::RecvAcceptV6 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    }
}

/// One planned filter, as WFP takes it.
///
/// # Safety
/// Inside an open transaction; every app blob alive for the duration.
unsafe fn add_spec(engine: HANDLE, spec: &FilterSpec, apps: &[(PathBuf, super::ipv6_block::AppId)]) -> Result<(), String> {
    let mut display_name = super::ipv6_block::wide(&spec.name);
    let mut provider_key = CAPTURE_PROVIDER_KEY;
    // The values carried by pointer, in buffers reserved up front so that
    // pushing cannot move an earlier one out from under its condition.
    let n = spec.conds.len();
    let mut v4: Vec<FWP_V4_ADDR_AND_MASK> = Vec::with_capacity(n);
    let mut v6: Vec<FWP_V6_ADDR_AND_MASK> = Vec::with_capacity(n);
    let mut luids: Vec<u64> = Vec::with_capacity(n);
    let mut conditions: Vec<FWPM_FILTER_CONDITION0> = Vec::with_capacity(n);
    for cond in &spec.conds {
        let condition = match cond {
            Cond::Loopback => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_FLAGS,
                matchType: FWP_MATCH_FLAGS_ALL_SET,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT32,
                    Anonymous: FWP_CONDITION_VALUE0_0 { uint32: FWP_CONDITION_FLAG_IS_LOOPBACK },
                },
            },
            Cond::RemoteV4(prefix) => {
                let (addr, mask) = prefix.wfp();
                v4.push(FWP_V4_ADDR_AND_MASK { addr, mask });
                let value = v4.last_mut().expect("just pushed");
                FWPM_FILTER_CONDITION0 {
                    fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                    matchType: FWP_MATCH_EQUAL,
                    conditionValue: FWP_CONDITION_VALUE0 {
                        r#type: FWP_V4_ADDR_MASK,
                        Anonymous: FWP_CONDITION_VALUE0_0 { v4AddrMask: value },
                    },
                }
            }
            Cond::RemoteV6(addr, len) => {
                v6.push(FWP_V6_ADDR_AND_MASK { addr: addr.octets(), prefixLength: *len });
                let value = v6.last_mut().expect("just pushed");
                FWPM_FILTER_CONDITION0 {
                    fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                    matchType: FWP_MATCH_EQUAL,
                    conditionValue: FWP_CONDITION_VALUE0 {
                        r#type: FWP_V6_ADDR_MASK,
                        Anonymous: FWP_CONDITION_VALUE0_0 { v6AddrMask: value },
                    },
                }
            }
            Cond::LocalInterface(luid) => {
                luids.push(*luid);
                let value = luids.last_mut().expect("just pushed");
                FWPM_FILTER_CONDITION0 {
                    fieldKey: FWPM_CONDITION_IP_LOCAL_INTERFACE,
                    matchType: FWP_MATCH_EQUAL,
                    conditionValue: FWP_CONDITION_VALUE0 { r#type: FWP_UINT64, Anonymous: FWP_CONDITION_VALUE0_0 { uint64: value } },
                }
            }
            Cond::App(path) => {
                let Some((_, id)) = apps.iter().find(|(p, _)| p == path) else {
                    return Err(format!("{} was not resolved before the filters went in", path.display()));
                };
                FWPM_FILTER_CONDITION0 {
                    fieldKey: FWPM_CONDITION_ALE_APP_ID,
                    matchType: FWP_MATCH_EQUAL,
                    conditionValue: FWP_CONDITION_VALUE0 {
                        r#type: FWP_BYTE_BLOB_TYPE,
                        Anonymous: FWP_CONDITION_VALUE0_0 { byteBlob: id.blob },
                    },
                }
            }
            Cond::RemotePort(port) => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 { r#type: FWP_UINT16, Anonymous: FWP_CONDITION_VALUE0_0 { uint16: *port } },
            },
            Cond::LocalPort(port) => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_LOCAL_PORT,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 { r#type: FWP_UINT16, Anonymous: FWP_CONDITION_VALUE0_0 { uint16: *port } },
            },
            Cond::Protocol(number) => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_PROTOCOL,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 { r#type: FWP_UINT8, Anonymous: FWP_CONDITION_VALUE0_0 { uint8: *number } },
            },
        };
        conditions.push(condition);
    }

    let mut filter: FWPM_FILTER0 = std::mem::zeroed();
    filter.displayData.name = display_name.as_mut_ptr();
    filter.flags = FWPM_FILTER_FLAG_NONE;
    filter.providerKey = &mut provider_key;
    filter.layerKey = layer_key(spec.layer);
    filter.subLayerKey = CAPTURE_SUBLAYER_KEY;
    filter.weight = FWP_VALUE0 { r#type: FWP_UINT8, Anonymous: FWP_VALUE0_0 { uint8: spec.weight } };
    filter.numFilterConditions = conditions.len() as u32;
    filter.filterCondition = if conditions.is_empty() { std::ptr::null_mut() } else { conditions.as_mut_ptr() };
    let action = match spec.action {
        Action::Permit => FWP_ACTION_PERMIT,
        Action::Block => FWP_ACTION_BLOCK,
    };
    filter.action = FWPM_ACTION0 { r#type: action, Anonymous: std::mem::zeroed() };
    let err = FwpmFilterAdd0(engine, &filter, std::ptr::null_mut(), std::ptr::null_mut());
    if err != 0 {
        return Err(format!("could not add the filter \"{}\" ({err:#010x})", spec.name));
    }
    Ok(())
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

    /// The handle a session's confinement lives in, without WFP: the closer
    /// is a recorder.
    pub(super) mod hold {
        use super::*;
        use std::sync::{Arc, Barrier, Mutex};

        pub(in crate::engines) fn recording() -> (Closer, Arc<Mutex<Vec<isize>>>) {
            let closed = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&closed);
            let close: Closer = Arc::new(move |engine| {
                seen.lock().unwrap().push(engine);
                0
            });
            (close, closed)
        }

        fn installed(engine: isize) -> Installed {
            Installed { engine, filters: 42 }
        }

        /// What the status poll is told, through a session's life: nothing
        /// for a session that was never to be confined; false with the
        /// reason when it could not be; true while it is; false with the
        /// reason once a drop report or the plan-error valve let it go.
        #[test]
        fn a_hold_says_what_the_status_poll_reports() {
            let (close, closed) = recording();
            let hold = Hold::with_closer(close);
            assert_eq!(hold.confined(), None, "not a confined session: the app must not warn");
            assert_eq!(hold.problem(), None);

            hold.refuse("the server's address is not known".into());
            assert_eq!(hold.confined(), Some(false));
            assert!(hold.problem().is_some_and(|p| p.contains("address is not known")));

            assert!(hold.put(installed(7)));
            assert_eq!(hold.confined(), Some(true));
            assert_eq!(hold.problem(), None);

            assert!(hold.release(Release::Dropped));
            assert_eq!(*closed.lock().unwrap(), vec![7]);
            assert_eq!(hold.confined(), Some(false));
            assert!(hold.problem().is_some(), "a drop's release is said, not silent");
            assert!(hold.owed_after_drop(), "let go of on a drop report: put back if the engine is alive");

            hold.rearm();
            assert!(hold.put(installed(8)));
            assert_eq!(hold.confined(), Some(true));
            assert!(!hold.owed_after_drop());

            assert!(hold.release(Release::PlanError("xray.exe was refused by the plan".into())));
            assert_eq!(*closed.lock().unwrap(), vec![7, 8]);
            assert_eq!(hold.confined(), Some(false));
            assert!(hold.problem().is_some_and(|p| p.contains("refused by the plan")));
            hold.rearm();
            assert!(!hold.owed_after_drop(), "a plan the engine tripped over is never put back");

            assert!(!hold.release(Release::Teardown), "nothing installed, nothing closed");
            assert_eq!(closed.lock().unwrap().len(), 2);
        }

        /// The engine went while the confinement was being installed: the
        /// watch's release found nothing to close. The session it then puts
        /// in is let go of at once, rather than held for a dead tunnel until
        /// the owning thread's teardown gets round to it (K2).
        #[test]
        fn a_confinement_put_after_a_drop_is_let_go_of_at_once() {
            let (close, closed) = recording();
            let hold = Hold::with_closer(close);
            assert!(!hold.release(Release::Dropped));
            assert!(!hold.put(installed(9)), "put after a drop is refused");
            assert_eq!(*closed.lock().unwrap(), vec![9]);
            assert_eq!(hold.confined(), Some(false));
            // And after the valve the same: nothing goes back in.
            let (close, closed) = recording();
            let hold = Hold::with_closer(close);
            assert!(hold.put(installed(10)));
            assert!(hold.release(Release::PlanError("refused".into())));
            assert!(!hold.put(installed(11)));
            assert_eq!(*closed.lock().unwrap(), vec![10, 11]);
        }

        /// A second confinement over a first closes the first: a reinstall
        /// with a fresh LUID never leaves the old session behind.
        #[test]
        fn putting_one_over_another_closes_the_first() {
            let (close, closed) = recording();
            let hold = Hold::with_closer(close);
            assert!(hold.put(installed(1)));
            assert!(hold.put(installed(2)));
            assert_eq!(*closed.lock().unwrap(), vec![1]);
            assert!(hold.release(Release::Teardown));
            assert_eq!(*closed.lock().unwrap(), vec![1, 2]);
        }

        /// The engine watch's thread and the owning thread let go of the same
        /// confinement at the same moment -- a drop report racing a
        /// Disconnect -- for thirty-two sessions at once, and one hold with
        /// thirty-two threads on it. Each session's WFP session is closed
        /// exactly once, and exactly one of its releasers says it closed it.
        #[test]
        fn thirty_two_concurrent_releases_close_exactly_once() {
            let (close, closed) = recording();
            let holds: Vec<Arc<Hold>> = (0..32)
                .map(|i| {
                    let hold = Hold::with_closer(Arc::clone(&close));
                    assert!(hold.put(installed(100 + i)));
                    hold
                })
                .collect();
            let start = Arc::new(Barrier::new(64));
            let mut threads = Vec::new();
            for hold in &holds {
                for why in [Release::Dropped, Release::Teardown] {
                    let hold = Arc::clone(hold);
                    let start = Arc::clone(&start);
                    threads.push(std::thread::spawn(move || {
                        start.wait();
                        hold.release(why)
                    }));
                }
            }
            let closers = threads.into_iter().map(|t| t.join().unwrap()).filter(|closed| *closed).count();
            assert_eq!(closers, 32, "one releaser per session closed it");
            let mut closed = closed.lock().unwrap().clone();
            closed.sort_unstable();
            assert_eq!(closed, (100..132).collect::<Vec<isize>>());

            let (close, closed) = recording();
            let hold = Hold::with_closer(close);
            assert!(hold.put(installed(5)));
            let start = Arc::new(Barrier::new(32));
            let threads: Vec<_> = (0..32)
                .map(|i| {
                    let hold = Arc::clone(&hold);
                    let start = Arc::clone(&start);
                    std::thread::spawn(move || {
                        start.wait();
                        hold.release(if i % 2 == 0 { Release::Dropped } else { Release::Teardown })
                    })
                })
                .collect();
            let closers = threads.into_iter().map(|t| t.join().unwrap()).filter(|c| *c).count();
            assert_eq!(closers, 1);
            assert_eq!(*closed.lock().unwrap(), vec![5]);
        }
    }

    /// The plan-error valve (K5): the engine's own connection refused by
    /// the plan, recognised in its log and let go of.
    mod valve {
        use super::*;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        // PROVISIONAL fixtures. Written from what each engine is known to
        // print for WSAEACCES (10013) -- Go's error text, which asks Windows
        // for the English message first and falls back to "winapi error
        // #10013"; OpenVPN 2.6's strerror_win32 -- not captured from a
        // refused engine on a real machine. The VM's P3 step 8 (a debug
        // build with a deliberately wrong permit) is to capture the real
        // lines and replace these.
        const XRAY_REFUSED: &str = "2026/10/12 21:04:05.123456 [Warning] [3123123] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > common/retry: [dial tcp 203.0.113.7:443: connectex: An attempt was made to access a socket in a way forbidden by its access permissions.] > common/retry: all retry attempts failed";
        const XRAY_REFUSED_NO_ENGLISH: &str = "2026/10/12 21:04:05 [Warning] [42] proxy/trojan: failed to find an available destination > dial tcp 203.0.113.7:443: connectex: winapi error #10013";
        const OPENVPN_REFUSED_UDP: &str = "2026-10-12 21:04:05 write UDP: Permission denied (WSAEACCES) (fd=1d4,code=10013)";
        const OPENVPN_REFUSED_TCP: &str = "2026-10-12 21:04:05 TCP: connect to [AF_INET]203.0.113.7:443 failed: Permission denied (WSAEACCES) (code=10013)";

        fn xray() -> Transport {
            Transport::Xray { exe: xray_exe(), nodes: vec![node()] }
        }

        fn openvpn() -> Transport {
            Transport::Openvpn { exe: openvpn_exe(), node: node(), port: 1194, protocol: protocol::UDP }
        }

        #[test]
        fn the_engines_own_refusal_is_recognised_in_its_log() {
            for line in [XRAY_REFUSED, XRAY_REFUSED_NO_ENGLISH] {
                let why = plan_error_in(&format!("2026/10/12 21:04:01 [Warning] core: Xray 26.1.23 started\n{line}\n"), &xray());
                assert!(why.as_deref().is_some_and(|w| w.contains("refused")), "{line}: {why:?}");
            }
            for line in [OPENVPN_REFUSED_UDP, OPENVPN_REFUSED_TCP] {
                let why = plan_error_in(&format!("Initialization Sequence Completed\n{line}\n"), &openvpn());
                assert!(why.as_deref().is_some_and(|w| w.contains("refused")), "{line}: {why:?}");
            }
            // What a working tunnel and a censored line write: never a plan
            // error -- those are the network's, and stay the ladder's to
            // judge.
            for line in [
                "2026/10/12 21:04:05 [Warning] [1] app/proxyman/outbound: failed to process outbound traffic > read tcp 198.18.0.1:50211->203.0.113.7:443: wsarecv: An existing connection was forcibly closed by the remote host.",
                "2026/10/12 21:04:05 [Warning] [2] proxy/vless/outbound: failed to find an available destination > dial tcp 203.0.113.7:443: i/o timeout",
            ] {
                assert_eq!(plan_error_in(line, &xray()), None, "{line}");
            }
            for line in [
                "2026-10-12 21:04:05 Initialization Sequence Completed",
                "2026-10-12 21:04:05 TLS Error: TLS handshake failed",
                "2026-10-12 21:04:05 write UDP: Network is unreachable (WSAENETUNREACH) (fd=1d4,code=10051)",
            ] {
                assert_eq!(plan_error_in(line, &openvpn()), None, "{line}");
            }
        }

        fn held() -> (Arc<Hold>, Arc<std::sync::Mutex<Vec<isize>>>) {
            let (close, closed) = super::hold::recording();
            let hold = Hold::with_closer(close);
            assert!(hold.put(Installed { engine: 77, filters: 40 }));
            (hold, closed)
        }

        fn log_file(name: &str, contents: &str) -> std::path::PathBuf {
            let dir = std::env::temp_dir().join(format!("neoxify-valve-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("xray.log");
            std::fs::write(&path, contents).unwrap();
            path
        }

        /// The engine's refusal, written after the install, lets go of the
        /// confinement within the window and says why -- the tunnel's own
        /// connection is not left refused to look like censorship.
        #[test]
        fn a_refusal_written_after_the_install_lets_go_of_it() {
            let path = log_file("hit", "2026/10/12 21:04:01 [Warning] core: Xray 26.1.23 started\n");
            let from = std::fs::metadata(&path).unwrap().len();
            let (hold, closed) = held();
            let stop = Arc::new(AtomicBool::new(false));
            let watcher = {
                let (path, hold, stop) = (path.clone(), Arc::clone(&hold), Arc::clone(&stop));
                std::thread::spawn(move || run_valve(&path, from, &xray(), &hold, &stop, std::time::Duration::from_secs(5)))
            };
            std::thread::sleep(std::time::Duration::from_millis(150));
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "2026/10/12 21:04:02 [Info] something unrelated").unwrap();
            writeln!(file, "{XRAY_REFUSED}").unwrap();
            drop(file);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while hold.confined() == Some(true) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert_eq!(hold.confined(), Some(false), "the refusal was not acted on");
            assert_eq!(*closed.lock().unwrap(), vec![77]);
            assert!(hold.problem().is_some_and(|p| p.contains("refused")), "{:?}", hold.problem());
            assert!(!hold.owed_after_drop(), "a refused plan is not put back");
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            watcher.join().unwrap();
        }

        /// What the log held before the install -- an earlier session's
        /// refusal -- is not this plan's; and a log with no refusal in the
        /// window leaves the confinement alone.
        #[test]
        fn an_earlier_line_or_a_quiet_log_leaves_it_in_place() {
            let path = log_file("quiet", &format!("{XRAY_REFUSED}\n"));
            let from = std::fs::metadata(&path).unwrap().len();
            let (hold, closed) = held();
            let stop = AtomicBool::new(false);
            run_valve(&path, from, &xray(), &hold, &stop, std::time::Duration::from_millis(600));
            assert_eq!(hold.confined(), Some(true));
            assert!(closed.lock().unwrap().is_empty());
        }

        /// The window is a window: a session that ends stops it at once.
        #[test]
        fn a_stopped_valve_returns_at_once() {
            let path = log_file("stop", "");
            let (hold, _closed) = held();
            let stop = AtomicBool::new(true);
            let started = std::time::Instant::now();
            run_valve(&path, 0, &xray(), &hold, &stop, std::time::Duration::from_secs(10));
            assert!(started.elapsed() < std::time::Duration::from_secs(1));
        }
    }

    /// The plans against the real filtering engine.
    mod wfp {
        use super::*;
        use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
            FwpmFreeMemory0, FwpmProviderGetByKey0, FwpmSubLayerGetByKey0,
        };

        /// Interface 1's LUID -- loopback, which every machine has -- so
        /// nothing is fabricated.
        fn loopback_luid() -> Option<u64> {
            use windows_sys::Win32::NetworkManagement::IpHelper::ConvertInterfaceIndexToLuid;
            use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
            let mut luid = NET_LUID_LH { Value: 0 };
            // SAFETY: `luid` is a valid out-parameter.
            let err = unsafe { ConvertInterfaceIndexToLuid(1, &mut luid) };
            // SAFETY: just written.
            (err == 0).then(|| unsafe { luid.Value })
        }

        /// Every engine's plan, with this test binary standing in for the
        /// engine executables (an app id needs a file that exists).
        fn every_plan(luid: u64) -> Vec<Plan> {
            let exe = std::env::current_exe().expect("test binary path");
            let lan = Lan::Allowed(vec![
                Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24),
                Prefix::new(Ipv4Addr::new(10, 0, 2, 0), 24),
            ]);
            let mut nodes = vec![node()];
            nodes.extend(exit_nodes());
            let built = |profile: &ConnectProfile, nodes: Vec<Ipv4Addr>, ikev2: bool| {
                let inputs = Inputs { tunnel_luid: luid, engine_exe: Some(exe.clone()), nodes, lan: lan.clone() };
                plan_with(profile, false, inputs, ikev2).expect("planned").expect("built")
            };
            vec![
                built(&reality(), nodes, false),
                built(&openvpn("udp", 1194), vec![node()], false),
                built(&openvpn("tcp", 443), vec![node()], false),
                built(&ikev2(), vec![node()], true),
                Plan { lan: Lan::Refused, ..built(&reality(), vec![node()], false) },
            ]
        }

        /// Hands every plan to the real filtering engine inside a
        /// transaction, and throws it away -- the trade
        /// `ipv6_block`'s add-then-abort tests make. WFP validates each
        /// filter as it is added (layer, sublayer, weight type, every
        /// condition's field and value type, an IPv4 mask, a protocol, a
        /// local port, an app id at the receive layer), so a structure it
        /// rejects is found here instead of on a customer's connect, where
        /// it would read as "not confined". What it cannot show is that
        /// traffic stops: that is the VM's capture.
        ///
        /// Skipped where the engine will not open -- adding filters needs
        /// administrator rights. GitHub's Windows runners have them.
        #[test]
        fn wfp_accepts_every_engine_plan_then_aborts() {
            let Some(luid) = loopback_luid() else {
                eprintln!("skipped: no interface 1 to take a LUID from");
                return;
            };
            for plan in every_plan(luid) {
                let specs = specs(&plan);
                let mut apps = Vec::new();
                for spec in &specs {
                    for cond in &spec.conds {
                        if let Cond::App(path) = cond {
                            if !apps.iter().any(|(p, _): &(PathBuf, _)| p == path) {
                                let id = crate::engines::ipv6_block::AppId::resolve(&path.to_string_lossy())
                                    .expect("the test binary resolves to an app id");
                                apps.push((path.clone(), id));
                            }
                        }
                    }
                }
                let Ok(engine) = crate::engines::ipv6_block::open_dynamic_session_named(SUBLAYER_NAME, "test") else {
                    eprintln!("skipped: the filtering engine would not open (needs administrator)");
                    return;
                };
                let result = unsafe {
                    let begun = FwpmTransactionBegin0(engine, 0);
                    if begun != 0 {
                        FwpmEngineClose0(engine);
                        eprintln!("skipped: no filtering transaction ({begun:#010x})");
                        return;
                    }
                    let result = add_everything(engine, &specs, &apps);
                    // Before the assertion, so a failure cannot leave a
                    // transaction open; closing ends the session anyway.
                    FwpmTransactionAbort0(engine);
                    FwpmEngineClose0(engine);
                    result
                };
                match result {
                    Ok(filters) => assert_eq!(filters, specs.len(), "{}", describe(&plan)),
                    Err(e) => panic!("the Windows Filtering Platform rejected the plan ({}): {e}", describe(&plan)),
                }
            }
        }

        /// Whether this sublayer and provider exist on the machine now.
        fn registered() -> Option<(bool, bool)> {
            let engine = crate::engines::ipv6_block::open_dynamic_session_named("Neoxify test lookup", "test").ok()?;
            // SAFETY: `engine` is live; each object returned is freed.
            let found = unsafe {
                let mut sublayer: *mut FWPM_SUBLAYER0 = std::ptr::null_mut();
                let s = FwpmSubLayerGetByKey0(engine, &CAPTURE_SUBLAYER_KEY, &mut sublayer);
                if s == 0 {
                    FwpmFreeMemory0(&mut sublayer as *mut _ as *mut *mut std::ffi::c_void);
                }
                let mut provider: *mut FWPM_PROVIDER0 = std::ptr::null_mut();
                let p = FwpmProviderGetByKey0(engine, &CAPTURE_PROVIDER_KEY, &mut provider);
                if p == 0 {
                    FwpmFreeMemory0(&mut provider as *mut _ as *mut *mut std::ffi::c_void);
                }
                FwpmEngineClose0(engine);
                (s == 0, p == 0)
            };
            Some(found)
        }

        const CHILD: &str = "NEOXIFY_CONFINEMENT_TEST_CHILD";

        /// The whole crash-safety argument, run: a process installs a real
        /// confinement and is killed with TerminateProcess, and afterwards
        /// neither the sublayer nor the provider is on the machine -- so
        /// none of its filters can be.
        ///
        /// Ignored: it needs administrator rights, and for the second or two
        /// the child holds it, this machine's IPv4 is confined to loopback
        /// and the LAN. Run it in the VM guest, elevated:
        /// `neoconnect-service-<hash>.exe --exact
        /// engines::confinement::tests::wfp::confinement_dies_with_its_process
        /// --ignored --nocapture`.
        #[test]
        #[ignore = "elevated, and confines this machine's IPv4 for a moment: run in the VM guest"]
        fn confinement_dies_with_its_process() {
            let luid = loopback_luid().expect("interface 1");
            if std::env::var_os(CHILD).is_some() {
                let plan = every_plan(luid).remove(0);
                let installed = install(&plan, &std::env::temp_dir()).expect("installed in the child");
                println!("installed {} filters", installed.filters);
                use std::io::Write;
                let _ = std::io::stdout().flush();
                std::thread::sleep(std::time::Duration::from_secs(60));
                return;
            }
            assert_eq!(registered(), Some((false, false)), "nothing of ours before the child");
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "engines::confinement::tests::wfp::confinement_dies_with_its_process", "--ignored", "--nocapture"])
                .env(CHILD, "1")
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("the child starts");
            let stdout = child.stdout.take().unwrap();
            let mut lines = std::io::BufRead::lines(std::io::BufReader::new(stdout));
            let said = lines.find(|line| line.as_ref().is_ok_and(|l| l.starts_with("installed")));
            assert!(said.is_some(), "the child never installed");
            assert_eq!(registered(), Some((true, true)), "the child's sublayer and provider while it lives");
            child.kill().expect("TerminateProcess");
            let _ = child.wait();
            assert_eq!(registered(), Some((false, false)), "the kernel ended the child's dynamic session");
        }
    }

    /// A model of WFP's arbitration over the two sublayers a confined full
    /// tunnel has -- today's IPv6/DNS one (`ipv6_block`) and this one -- and
    /// what it says about the flows that decide whether the plan is right.
    ///
    /// **The model is not evidence of WFP behaviour.** It encodes two rules
    /// as documented and as `ipv6_block` relies on: within a sublayer the
    /// highest-weight matching filter decides; across sublayers a block in
    /// any of them wins over a permit that did not clear the action right
    /// (none here does). What it pins is the reasoning built on those rules
    /// -- above all that the LAN permit does not let the router's DNS out,
    /// because the other sublayer still blocks port 53 off the tunnel. What
    /// WFP actually does is for the elevated install test and the VM.
    mod arbitration {
        use super::*;
        use std::net::IpAddr;

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum Verdict {
            Permit,
            Block,
        }

        const PHYSICAL: u64 = 0x0099_0000_0000_0007;

        fn app() -> PathBuf {
            PathBuf::from(r"C:\Program Files\Neoxify\neoconnect-desktop.exe")
        }

        /// One flow as ALE classifies it.
        #[derive(Debug, Clone)]
        struct Flow {
            layer: Layer,
            remote: IpAddr,
            remote_port: u16,
            local_port: u16,
            protocol: u8,
            interface: u64,
            app: PathBuf,
            loopback: bool,
        }

        fn out(app: PathBuf, remote: IpAddr, remote_port: u16, protocol: u8, interface: u64) -> Flow {
            let layer = if remote.is_ipv4() { Layer::ConnectV4 } else { Layer::ConnectV6 };
            Flow { layer, remote, remote_port, local_port: 50_000, protocol, interface, app, loopback: false }
        }

        /// Sublayer A, as `ipv6_block` installs it for an Xray full tunnel:
        /// `add_ipv6_filters` at both V6 layers and `add_dns_filters` at
        /// ALE_AUTH_CONNECT_V4. Written out here, by hand, from that file;
        /// a change there has to be mirrored here for this model to mean
        /// anything.
        fn today_ipv6_and_dns(tunnel: u64, engine: PathBuf) -> Vec<FilterSpec> {
            let spec = |layer, action, weight, conds| FilterSpec {
                name: "Neoxify (IPv6 block)".into(),
                layer,
                action,
                weight,
                conds,
            };
            let mut a = Vec::new();
            for layer in [Layer::ConnectV6, Layer::RecvAcceptV6] {
                a.push(spec(layer, Action::Permit, 12, vec![Cond::Loopback]));
                a.push(spec(layer, Action::Permit, 12, vec![Cond::RemoteV6(Ipv6Addr::LOCALHOST, 128)]));
                a.push(spec(layer, Action::Permit, 12, vec![Cond::RemoteV6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10)]));
                a.push(spec(layer, Action::Permit, 12, vec![Cond::RemoteV6(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8)]));
                a.push(spec(layer, Action::Block, 0, vec![]));
            }
            let v4 = Layer::ConnectV4;
            a.push(spec(v4, Action::Permit, 12, vec![Cond::RemotePort(53), Cond::LocalInterface(tunnel)]));
            a.push(spec(v4, Action::Permit, 12, vec![Cond::RemotePort(53), Cond::Loopback]));
            a.push(spec(v4, Action::Permit, 12, vec![Cond::RemotePort(53), Cond::App(engine)]));
            a.push(spec(v4, Action::Block, 0, vec![Cond::RemotePort(53)]));
            a
        }

        fn v6_contains(prefix: Ipv6Addr, len: u8, addr: Ipv6Addr) -> bool {
            let bits = u128::from(len.min(128));
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            u128::from(addr) & mask == u128::from(prefix) & mask
        }

        fn holds(cond: &Cond, flow: &Flow) -> bool {
            match cond {
                Cond::Loopback => flow.loopback,
                Cond::RemoteV4(prefix) => matches!(flow.remote, IpAddr::V4(a) if prefix.contains(a)),
                Cond::RemoteV6(prefix, len) => matches!(flow.remote, IpAddr::V6(a) if v6_contains(*prefix, *len, a)),
                Cond::LocalInterface(luid) => flow.interface == *luid,
                Cond::App(path) => &flow.app == path,
                Cond::RemotePort(port) => flow.remote_port == *port,
                Cond::LocalPort(port) => flow.local_port == *port,
                Cond::Protocol(number) => flow.protocol == *number,
            }
        }

        /// WFP's arbitration, as modelled: in each sublayer the matching
        /// filter of highest weight gives that sublayer's answer (none
        /// matching is no opinion); a block from any sublayer wins.
        fn decide(sublayers: &[Vec<FilterSpec>], flow: &Flow) -> Verdict {
            let mut verdict = Verdict::Permit;
            for sublayer in sublayers {
                let winner = sublayer
                    .iter()
                    .filter(|f| f.layer == flow.layer && f.conds.iter().all(|c| holds(c, flow)))
                    .max_by_key(|f| f.weight);
                if winner.is_some_and(|f| f.action == Action::Block) {
                    verdict = Verdict::Block;
                }
            }
            verdict
        }

        fn sublayers() -> Vec<Vec<FilterSpec>> {
            vec![today_ipv6_and_dns(LUID, xray_exe()), specs(&xray_plan())]
        }

        fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
            IpAddr::V4(Ipv4Addr::new(a, b, c, d))
        }

        fn mapped(addr: IpAddr) -> IpAddr {
            match addr {
                IpAddr::V4(a) => IpAddr::V6(a.to_ipv6_mapped()),
                v6 => v6,
            }
        }

        /// The table from the design (3.2), and the reason for each row.
        #[test]
        fn the_flows_that_decide_the_plan() {
            let node = IpAddr::V4(node());
            let rows: Vec<(&str, Flow, Verdict)> = vec![
                (
                    "the router's DNS, on the physical adapter: the LAN permit lets it past this sublayer, the IPv6 block's port-53 block does not",
                    out(app(), v4(192, 168, 1, 1), 53, protocol::UDP, PHYSICAL),
                    Verdict::Block,
                ),
                ("a printer on the LAN", out(app(), v4(192, 168, 1, 20), 9100, protocol::TCP, PHYSICAL), Verdict::Permit),
                ("xray.exe to its server", out(xray_exe(), node, 443, protocol::TCP, PHYSICAL), Verdict::Permit),
                ("the app to the server's mirror, beside the tunnel", out(app(), node, 2053, protocol::TCP, PHYSICAL), Verdict::Block),
                ("the app to the internet through the tunnel", out(app(), v4(1, 1, 1, 1), 443, protocol::TCP, LUID), Verdict::Permit),
                ("DNS through the tunnel", out(app(), v4(1, 1, 1, 1), 53, protocol::UDP, LUID), Verdict::Permit),
                (
                    // Refused by the IPv6 block, which has no ::ffff permit
                    // (1.7 was not built: P0-B measured dual-mode IPv4 judged
                    // at the V4 layers, where it is permitted). Exactly as
                    // today; this sublayer permits it -- see the test below.
                    "IPv4-mapped through the tunnel, at V6",
                    out(app(), mapped(v4(1, 1, 1, 1)), 443, protocol::TCP, LUID),
                    Verdict::Block,
                ),
                (
                    "IPv4-mapped on the physical adapter, at V6",
                    out(app(), mapped(v4(1, 1, 1, 1)), 443, protocol::TCP, PHYSICAL),
                    Verdict::Block,
                ),
                ("a socket bound to the physical adapter", out(app(), v4(8, 8, 8, 8), 443, protocol::TCP, PHYSICAL), Verdict::Block),
                (
                    "a connection opened before Connect, re-examined",
                    out(app(), v4(93, 184, 216, 34), 443, protocol::TCP, PHYSICAL),
                    Verdict::Block,
                ),
                (
                    "DHCP",
                    Flow { local_port: 68, ..out(app(), v4(192, 168, 1, 1), 67, protocol::UDP, PHYSICAL) },
                    Verdict::Permit,
                ),
                (
                    "loopback",
                    Flow { loopback: true, ..out(app(), v4(127, 0, 0, 1), 8080, protocol::TCP, 1) },
                    Verdict::Permit,
                ),
                (
                    "native IPv6: the IPv6 block's, not this sublayer's",
                    out(app(), "2001:db8::1".parse().unwrap(), 443, protocol::TCP, PHYSICAL),
                    Verdict::Block,
                ),
                (
                    "an inbound connection from the internet",
                    Flow {
                        layer: Layer::RecvAcceptV4,
                        local_port: 3389,
                        ..out(app(), v4(198, 51, 100, 77), 51_000, protocol::TCP, PHYSICAL)
                    },
                    Verdict::Block,
                ),
                (
                    "an inbound connection from the LAN",
                    Flow { layer: Layer::RecvAcceptV4, local_port: 445, ..out(app(), v4(192, 168, 1, 30), 51_000, protocol::TCP, PHYSICAL) },
                    Verdict::Permit,
                ),
                (
                    "Windows' own multicast discovery",
                    out(app(), v4(239, 255, 255, 250), 1900, protocol::UDP, PHYSICAL),
                    Verdict::Permit,
                ),
                (
                    "the carrier's network beyond the gateway",
                    out(app(), v4(10, 200, 0, 1), 443, protocol::TCP, PHYSICAL),
                    Verdict::Block,
                ),
            ];
            let sublayers = sublayers();
            let mut wrong = Vec::new();
            for (why, flow, expected) in &rows {
                let got = decide(&sublayers, flow);
                if got != *expected {
                    wrong.push(format!("{why}: expected {expected:?}, got {got:?}"));
                }
            }
            assert!(wrong.is_empty(), "{}", wrong.join("\n"));
        }

        /// This sublayer on its own, for IPv4-mapped traffic at V6: through
        /// the tunnel it is permitted, and around it refused (K4). Whether
        /// such traffic is ever classified at V6 is P0-B's question, and it
        /// measured no; the IPv6 block refuses it there either way.
        #[test]
        fn this_sublayer_alone_permits_mapped_ipv4_through_the_tunnel_only() {
            let ours = vec![specs(&xray_plan())];
            let through = out(app(), mapped(v4(1, 1, 1, 1)), 443, protocol::TCP, LUID);
            let around = out(app(), mapped(v4(1, 1, 1, 1)), 443, protocol::TCP, PHYSICAL);
            let native = out(app(), "2001:db8::1".parse().unwrap(), 443, protocol::TCP, PHYSICAL);
            assert_eq!(decide(&ours, &through), Verdict::Permit);
            assert_eq!(decide(&ours, &around), Verdict::Block);
            assert_eq!(decide(&ours, &native), Verdict::Permit, "native IPv6 is not this sublayer's to refuse");
        }

        /// The control for the table: without this sublayer, the flows it
        /// exists to stop are let through -- so the rows above that say
        /// Block are this plan's doing, not the IPv6 block's.
        #[test]
        fn without_confinement_the_same_flows_go_out() {
            let today = vec![today_ipv6_and_dns(LUID, xray_exe())];
            let node = IpAddr::V4(node());
            for flow in [
                out(app(), node, 2053, protocol::TCP, PHYSICAL),
                out(app(), v4(8, 8, 8, 8), 443, protocol::TCP, PHYSICAL),
                out(app(), v4(10, 200, 0, 1), 443, protocol::TCP, PHYSICAL),
            ] {
                assert_eq!(decide(&today, &flow), Verdict::Permit, "{flow:?}");
            }
            // And the router's DNS was already refused by the IPv6 block's.
            assert_eq!(
                decide(&today, &out(app(), v4(192, 168, 1, 1), 53, protocol::UDP, PHYSICAL)),
                Verdict::Block
            );
        }
    }
}
