//! "Block the internet while reconnecting": the opt-in hold over the gap
//! between a tunnel dropping and a reconnect bringing one back.
//!
//! # What it changes, and only for whom
//!
//! Off by default, and off it changes nothing: "while the tunnel is down
//! nothing is blocked" (journal, 2026-10-07) is the product's default, and
//! the owner kept it so (2026-10-12, 2026-10-19). A customer who turns the
//! setting on asks for the opposite while their tunnel is being
//! reconnected: nothing leaves the PC in the clear meanwhile.
//!
//! On, a session of a full tunnel this covers ([`covers`]: WireGuard,
//! OpenVPN and the Xray protocols; not IKEv2, not Custom mode) is *armed*
//! when its connect returns: a [`Plan`] is made for it and kept. When that
//! session ends in a way that is not the customer's own Disconnect -- the
//! engine dying on its own (seen by the engine watch, on its own thread, or
//! by a status poll), or the app taking it down to reconnect
//! (`Request::DisconnectForReconnect`) -- the plan goes in *before* the
//! session's own filters are let go of, so there is no gap between them.
//! A connect while it holds keeps it: the ladder's rungs are dialled under
//! it, and the tunnel each brings up is put in its plan as soon as the
//! connect returns, so that tunnel carries.
//!
//! Whichever of the service's watchers sees the end first -- the engine
//! watch's report, the status poll finding the engine dead, the poll
//! finding the tunnel adapter gone -- installs the hold before it lets go
//! of anything of the session's own. The install is one WFP transaction,
//! made under the hold's lock: a second watcher waits for it and finds it
//! in. Only then does the session's confinement go.
//!
//! A WireGuard session's own protection is not the service's to hold:
//! wireguard.exe's kill switch lives in that process's WFP session and goes
//! the instant it dies, before any watch can see the death (measured on the
//! VM: traffic out 0.22 s after the kill, with the hold armed). So an armed
//! WireGuard session keeps the hold's filters *standing* in force for as
//! long as it is up ([`stands_while_up`]): they permit its tunnel, its
//! server and Neoxify's programs, so the tunnel carries as before, and when
//! wireguard.exe's filters go the hold's block is already there. Its drop
//! is then held with nothing to install. Letting go of a hold over a
//! WireGuard tunnel a reconnect brought up leaves them standing for that
//! tunnel; disarming -- the customer's Disconnect, the setting off, a
//! connect of theirs -- takes them out.
//!
//! # What it lets through
//!
//! Loopback; our tunnel adapters, by LUID; Neoxify's own programs anywhere
//! (the engines, the app, this service -- by app id, so a reconnect can
//! dial and the app can reach its API); anything to the servers the app
//! holds credentials for, by address (an engine whose socket WFP does not
//! attribute to its program -- WireGuard's kernel driver -- still reaches
//! its server); DHCP, as the confinement permits it; the LAN, as the
//! confinement permits it; and name lookups -- UDP and TCP port 53 to the
//! resolvers the machine's own adapters are configured with, because the
//! engines and the app find servers by name through Windows' resolver,
//! which no app id can single out. That last one is a stated gap: while
//! holding, the network can see which names the PC looks up, though
//! nothing can connect to them. When those resolvers cannot be read, port
//! 53 to anywhere is permitted instead, and the status says so
//! (`Report::Holding.dns_anywhere`) rather than claim the narrower rule.
//! Everything else, IPv4 and IPv6, both directions, is refused.
//!
//! The LAN, the DHCP servers and the resolvers are read again while it
//! holds (`Hold::tend`): a laptop that roams during the wait gets its new
//! network's LAN and resolvers, not the old one's.
//!
//! # What lets go of it
//!
//! The app, once it has proved a tunnel or given the reconnect up
//! (`Request::ReleaseReconnectHold`); the customer's Disconnect, a
//! sign-out, any teardown that is not a reconnect's; the setting turned
//! off; a connect it does not cover (IKEv2, Custom mode), before that one
//! dials; the app going away or going silent; the service stopping or
//! being uninstalled; Repair; a drop that no reconnect follows within
//! [`NO_FOLLOW_UP`] -- no Connect, no `DisconnectForReconnect`, no word
//! from the app that it is reconnecting -- so an app that has decided not
//! to reconnect, or has lost track, cannot leave the machine held; and
//! [`HOLD_LONGEST`] without a tunnel, so a machine is never left offline
//! by a reconnect that will not end. The
//! filters live in a dynamic WFP session of their own, so the kernel takes
//! them away with the process -- a crash, a kill, a reboot -- and the sweep
//! at the next start looks for them all the same.
//!
//! Fail open, as the confinement does: a hold that will not go in, or a
//! tunnel it cannot name, is let go of and said (`ReconnectHold::NotHeld`),
//! never kept at the cost of the machine's networking or of a protocol.
//!
//! # What has not been measured
//!
//! The VM's capture (`pktmon --comp nics`, 2026-10-20) showed every engine
//! dialling and carrying under it, and every release path letting go; it
//! also showed the three gaps the ordering above and the standing filters
//! close (an Xray adapter-gone check letting go of the confinement first,
//! WireGuard's own filters dying before the hold went in). That those are
//! closed has not carried a packet yet: it is the next capture's to show.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, ReconnectHold as Report, ReconnectHoldProblem};
use windows_sys::core::GUID;

use super::confinement::{self, protocol, Action, CaptureKeys, Cond, FilterSpec, Layer, Prefix};

/// Whether a session of this profile is held when it drops. Full tunnels
/// whose engine this service runs; not IKEv2, which is never confined
/// (`confinement::IKEV2_CONFINED`) and which a hold could stop dialling --
/// Windows' own IKE and certificate checks have not been measured under
/// one -- and not Custom mode, which leaves the rest of the machine's
/// traffic outside the tunnel by design.
pub fn covers(profile: &ConnectProfile, passive: bool) -> bool {
    use ConnectProfile as P;
    !passive
        && match profile {
            P::Ikev2(_) => false,
            P::Wireguard(_)
            | P::XrayVlessReality(_)
            | P::XrayVlessTls(_)
            | P::XrayTrojan(_)
            | P::Shadowsocks(_)
            | P::Openvpn(_) => true,
        }
}

/// Whether an armed session of this profile keeps the hold's filters
/// standing in force while it is up, not only from its drop: WireGuard,
/// whose own kill switch dies with wireguard.exe (see the module's
/// comment). The other engines' sessions are confined by this service,
/// whose filters it lets go of only after the hold is in.
///
/// Standing, the filters refuse nothing the tunnel carries -- they permit
/// its adapter, its server and Neoxify's programs, the plan a WireGuard
/// tunnel was measured dialling and carrying under -- and what they refuse
/// beside it, WireGuard's kill switch refuses too.
pub fn stands_while_up(profile: &ConnectProfile) -> bool {
    matches!(profile, ConnectProfile::Wireguard(_))
}

/// The longest it holds with no tunnel up. An auto-reconnect waits at
/// most half an hour for a network (`BLOCKED_WAIT_MAX_MS` in the app) and
/// spends a few minutes dialling; past this, something has gone wrong, and
/// the machine is given its networking back.
pub const HOLD_LONGEST: Duration = Duration::from_secs(40 * 60);

/// How long a hold a drop began waits for a reconnect to follow it -- a
/// Connect, a `DisconnectForReconnect`, or the app saying the setting
/// again as its reconnect begins -- before it is let go of. The app's
/// reconnect follows within seconds; two minutes allows for a window the
/// system has slowed to a timer a minute.
pub const NO_FOLLOW_UP: Duration = Duration::from_secs(120);

/// How often the LAN, the DHCP servers and the resolvers are read again
/// while it holds, and how long a plan from them that would not go in is
/// left before it is tried again.
pub const REREAD_EVERY: Duration = Duration::from_secs(10);
pub const REREAD_AFTER_REFUSAL: Duration = Duration::from_secs(60);

/// The most resolvers a plan permits.
pub const MAX_RESOLVERS: usize = 16;

/// The most servers a plan permits by address.
pub const MAX_NODES: usize = 256;

/// What a hold lets through. See the module's comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Our tunnel adapters, by interface LUID.
    pub tunnels: Vec<u64>,
    /// Neoxify's own programs, permitted anywhere.
    pub programs: Vec<PathBuf>,
    /// The servers the app holds credentials for.
    pub nodes: Vec<Ipv4Addr>,
    /// The LAN's on-link prefixes and the DHCP servers the machine leases
    /// from, as the confinement reads them.
    pub lan: Vec<Prefix>,
    pub dhcp_servers: Vec<Ipv4Addr>,
    /// The resolvers the machine's own adapters are configured with: name
    /// lookups are permitted to these alone. Empty when they could not be
    /// read, and then to anywhere (`dns_anywhere`).
    pub dns: Vec<IpAddr>,
}

impl Plan {
    /// A plan, each list without repeats, the servers bounded.
    pub fn new(
        tunnels: Vec<u64>,
        programs: Vec<PathBuf>,
        nodes: Vec<Ipv4Addr>,
        lan: Vec<Prefix>,
        dhcp_servers: Vec<Ipv4Addr>,
    ) -> Self {
        fn once<T: PartialEq>(items: Vec<T>, most: usize) -> Vec<T> {
            let mut kept: Vec<T> = Vec::new();
            for item in items {
                if kept.len() < most && !kept.contains(&item) {
                    kept.push(item);
                }
            }
            kept
        }
        let nodes: Vec<Ipv4Addr> =
            nodes.into_iter().filter(|n| !n.is_unspecified() && !n.is_broadcast() && !n.is_loopback()).collect();
        let tunnels: Vec<u64> = tunnels.into_iter().filter(|luid| *luid != 0).collect();
        Self {
            tunnels: once(tunnels, usize::MAX),
            programs: once(programs, usize::MAX),
            nodes: once(nodes, MAX_NODES),
            lan: once(lan, usize::MAX),
            dhcp_servers: once(dhcp_servers, usize::MAX),
            dns: Vec::new(),
        }
    }

    /// The plan with name lookups permitted to `dns` alone: each once,
    /// bounded, and none that would permit everything or nothing real.
    pub fn with_dns(mut self, dns: Vec<IpAddr>) -> Self {
        let mut kept: Vec<IpAddr> = Vec::new();
        for server in dns {
            if kept.len() < MAX_RESOLVERS && !server.is_unspecified() && !server.is_loopback() && !kept.contains(&server) {
                kept.push(server);
            }
        }
        self.dns = kept;
        self
    }

    /// Whether name lookups go to anywhere on port 53, the machine's
    /// resolvers not having been read.
    pub fn dns_anywhere(&self) -> bool {
        self.dns.is_empty()
    }

    /// This plan, permitting as well every tunnel, program and server
    /// `other` does: what arming a session again keeps -- the setting said
    /// again as a reconnect begins re-arms the live session with no servers
    /// of the connect's to hand -- so a plan made again with less to go on
    /// never narrows what that session's tunnel needs. Standing under a
    /// WireGuard tunnel, a narrower one would refuse its own server.
    pub fn widened_by(self, other: &Plan) -> Plan {
        let dns = self.dns.clone();
        let mut tunnels = self.tunnels;
        tunnels.extend(other.tunnels.iter().copied());
        let mut programs = self.programs;
        programs.extend(other.programs.iter().cloned());
        let mut nodes = self.nodes;
        nodes.extend(other.nodes.iter().copied());
        Plan::new(tunnels, programs, nodes, self.lan, self.dhcp_servers).with_dns(dns)
    }
}

const WEIGHT_LOOPBACK: u8 = 15;
const WEIGHT_TUNNEL: u8 = 14;
/// Neoxify's programs and its servers.
const WEIGHT_NEOXIFY: u8 = 13;
const WEIGHT_DHCP: u8 = 12;
const WEIGHT_DNS: u8 = 11;
const WEIGHT_LAN: u8 = 10;
const WEIGHT_BLOCK: u8 = 0;

/// The filters for a plan, in the order they go in: at each IPv4 layer,
/// both directions, the permits then a block of everything; at each IPv6
/// layer, the same permits IPv4-mapped (`confinement::v6_twin`), loopback,
/// link-local and multicast (the IPv6 LAN, neighbour discovery and
/// DHCPv6), name lookups to any address, then a block of everything.
/// Neoxify's programs reach IPv6 only IPv4-mapped, as every program does
/// while a tunnel is up (the IPv6 block): every server is IPv4-only.
pub fn specs(plan: &Plan) -> Vec<FilterSpec> {
    #[derive(Clone, Copy, PartialEq)]
    enum Way {
        Both,
        Out,
        In,
    }
    let mut v4: Vec<(Way, u8, String, Vec<Cond>)> = vec![
        (Way::Both, WEIGHT_LOOPBACK, "permit loopback".into(), vec![Cond::Loopback]),
        (
            Way::Both,
            WEIGHT_LOOPBACK,
            "permit 127.0.0.0/8".into(),
            vec![Cond::RemoteV4(Prefix::new(Ipv4Addr::new(127, 0, 0, 0), 8))],
        ),
    ];
    for luid in &plan.tunnels {
        v4.push((Way::Both, WEIGHT_TUNNEL, format!("permit a Neoxify tunnel ({luid:#x})"), vec![Cond::LocalInterface(*luid)]));
    }
    for program in &plan.programs {
        let name = program.file_name().map_or_else(|| program.display().to_string(), |n| n.to_string_lossy().into_owned());
        v4.push((Way::Both, WEIGHT_NEOXIFY, format!("permit {name}"), vec![Cond::App(program.clone())]));
    }
    for node in &plan.nodes {
        v4.push((Way::Both, WEIGHT_NEOXIFY, format!("permit a Neoxify server {node}"), vec![Cond::RemoteV4(Prefix::host(*node))]));
    }
    // DHCP as the confinement permits it, and for the same reasons (see
    // `confinement::specs`): out as a client to where DHCP goes, as a
    // server to the LAN's clients, and in as a client from any server --
    // the network a laptop roams to while it is held included.
    let mut dhcp_remotes = vec![Prefix::host(Ipv4Addr::BROADCAST), Prefix::host(Ipv4Addr::UNSPECIFIED)];
    for server in &plan.dhcp_servers {
        let host = Prefix::host(*server);
        if !dhcp_remotes.contains(&host) {
            dhcp_remotes.push(host);
        }
    }
    for remote in dhcp_remotes {
        v4.push((
            Way::Out,
            WEIGHT_DHCP,
            format!("permit DHCP with {}", remote.addr),
            vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(68), Cond::RemotePort(67), Cond::RemoteV4(remote)],
        ));
        v4.push((
            Way::Both,
            WEIGHT_DHCP,
            format!("permit DHCP to this PC's own DHCP server with {}", remote.addr),
            vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(67), Cond::RemotePort(68), Cond::RemoteV4(remote)],
        ));
    }
    v4.push((
        Way::In,
        WEIGHT_DHCP,
        "permit DHCP answers to this PC from any DHCP server".into(),
        vec![Cond::Protocol(protocol::UDP), Cond::LocalPort(68), Cond::RemotePort(67)],
    ));
    // Name lookups, outbound: see the module's comment for why, and what
    // it costs. UDP and TCP to each resolver the machine is configured
    // with; to anywhere only when none could be read.
    let lookups = |remote: Cond, who: String| -> Vec<(Way, u8, String, Vec<Cond>)> {
        [(protocol::UDP, "UDP"), (protocol::TCP, "TCP")]
            .into_iter()
            .map(|(number, name)| {
                (
                    Way::Out,
                    WEIGHT_DNS,
                    format!("permit name lookups to {who} over {name}"),
                    vec![Cond::Protocol(number), Cond::RemotePort(53), remote.clone()],
                )
            })
            .collect()
    };
    if plan.dns_anywhere() {
        v4.push((Way::Out, WEIGHT_DNS, "permit name lookups to anywhere (the resolvers could not be read)".into(), vec![Cond::RemotePort(53)]));
    }
    for server in &plan.dns {
        if let IpAddr::V4(server) = server {
            v4.extend(lookups(Cond::RemoteV4(Prefix::host(*server)), server.to_string()));
        }
    }
    let mut lan: Vec<Prefix> = Vec::new();
    for prefix in plan.lan.iter().copied().chain(confinement::lan_plumbing()) {
        if !lan.contains(&prefix) {
            lan.push(prefix);
        }
    }
    for prefix in lan {
        v4.push((Way::Both, WEIGHT_LAN, format!("permit the LAN {}/{}", prefix.addr, prefix.len), vec![Cond::RemoteV4(prefix)]));
    }

    let link_local = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0);
    let multicast = Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0);
    let mut v6_native: Vec<(Way, u8, String, Vec<Cond>)> = vec![
        (Way::Both, WEIGHT_LOOPBACK, "permit ::1".into(), vec![Cond::RemoteV6(Ipv6Addr::LOCALHOST, 128)]),
        (Way::Both, WEIGHT_LAN, "permit link-local fe80::/10".into(), vec![Cond::RemoteV6(link_local, 10)]),
        (Way::Both, WEIGHT_LAN, "permit multicast ff00::/8".into(), vec![Cond::RemoteV6(multicast, 8)]),
    ];
    // Native IPv6 name lookups only to a resolver configured with an IPv6
    // address -- or, the resolvers unread, to anywhere, as for IPv4.
    if plan.dns_anywhere() {
        v6_native.push((
            Way::Out,
            WEIGHT_DNS,
            "permit name lookups to anywhere, IPv6 (the resolvers could not be read)".into(),
            vec![Cond::RemotePort(53)],
        ));
    }
    for server in &plan.dns {
        if let IpAddr::V6(server) = server {
            v6_native.extend(lookups(Cond::RemoteV6(*server, 128), server.to_string()));
        }
    }

    let direction = |layer: Layer| match layer {
        Layer::ConnectV4 | Layer::ConnectV6 => "outbound",
        Layer::RecvAcceptV4 | Layer::RecvAcceptV6 => "inbound",
    };
    let goes_in = |way: Way, layer: Layer| match way {
        Way::Both => true,
        Way::Out => matches!(layer, Layer::ConnectV4 | Layer::ConnectV6),
        Way::In => matches!(layer, Layer::RecvAcceptV4 | Layer::RecvAcceptV6),
    };
    let mut specs = Vec::new();
    for layer in [Layer::ConnectV4, Layer::RecvAcceptV4] {
        for (way, weight, name, conds) in &v4 {
            if goes_in(*way, layer) {
                specs.push(FilterSpec {
                    name: format!("Neoxify reconnect hold: {name} ({})", direction(layer)),
                    layer,
                    action: Action::Permit,
                    weight: *weight,
                    conds: conds.clone(),
                });
            }
        }
        specs.push(FilterSpec {
            name: format!("Neoxify reconnect hold: block all {} IPv4", direction(layer)),
            layer,
            action: Action::Block,
            weight: WEIGHT_BLOCK,
            conds: Vec::new(),
        });
    }
    for layer in [Layer::ConnectV6, Layer::RecvAcceptV6] {
        for (way, weight, name, conds) in &v4 {
            if goes_in(*way, layer) {
                specs.push(FilterSpec {
                    name: format!("Neoxify reconnect hold: {name}, IPv4-mapped ({})", direction(layer)),
                    layer,
                    action: Action::Permit,
                    weight: *weight,
                    conds: confinement::v6_twin(conds),
                });
            }
        }
        for (way, weight, name, conds) in &v6_native {
            if goes_in(*way, layer) {
                specs.push(FilterSpec {
                    name: format!("Neoxify reconnect hold: {name} ({})", direction(layer)),
                    layer,
                    action: Action::Permit,
                    weight: *weight,
                    conds: conds.clone(),
                });
            }
        }
        specs.push(FilterSpec {
            name: format!("Neoxify reconnect hold: block all {} IPv6", direction(layer)),
            layer,
            action: Action::Block,
            weight: WEIGHT_BLOCK,
            conds: Vec::new(),
        });
    }
    specs
}

/// Its own provider and sublayer, two pairs of them as the confinement has
/// (`confinement::CAPTURE_KEYS`): moving the hold onto a tunnel that has
/// just come up puts the new plan in before the old one is closed, and on
/// one pair the second session would take the first's objects as its own.
/// `pub(super)` so `repair` can sweep by them.
pub(super) const HOLD_PROVIDER_KEY: GUID = GUID::from_u128(0x7a2c4e91_5d3b_4f8a_9e60_1c8b3f5d2a71);
pub(super) const HOLD_SUBLAYER_KEY: GUID = GUID::from_u128(0x8b3d5fa2_6e4c_4a9b_8f71_2d9c4a6e3b82);
pub(super) const HOLD_PROVIDER_KEY_ALT: GUID = GUID::from_u128(0x7a2c4e92_5d3b_4f8a_9e60_1c8b3f5d2a71);
pub(super) const HOLD_SUBLAYER_KEY_ALT: GUID = GUID::from_u128(0x8b3d5fa3_6e4c_4a9b_8f71_2d9c4a6e3b82);

const PROVIDER_NAME: &str = "Neoxify reconnect hold";
const PROVIDER_DESCRIPTION: &str = "Neoxify VPN: the internet held while a dropped tunnel is reconnected";
const SUBLAYER_NAME: &str = "Neoxify reconnect hold";
const SUBLAYER_DESCRIPTION: &str = "Everything outside a Neoxify tunnel held while it reconnects; opt-in, removed when it ends";
const LOG_FILE: &str = "reconnect-hold.log";

pub(super) const HOLD_KEYS: [CaptureKeys; 2] = [
    CaptureKeys {
        provider: HOLD_PROVIDER_KEY,
        sublayer: HOLD_SUBLAYER_KEY,
        weight: 0xFFFB,
        provider_name: PROVIDER_NAME,
        provider_description: PROVIDER_DESCRIPTION,
        sublayer_name: SUBLAYER_NAME,
        sublayer_description: SUBLAYER_DESCRIPTION,
    },
    CaptureKeys {
        provider: HOLD_PROVIDER_KEY_ALT,
        sublayer: HOLD_SUBLAYER_KEY_ALT,
        weight: 0xFFFA,
        provider_name: PROVIDER_NAME,
        provider_description: PROVIDER_DESCRIPTION,
        sublayer_name: SUBLAYER_NAME,
        sublayer_description: SUBLAYER_DESCRIPTION,
    },
];

/// An installed hold: the dynamic WFP session that holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installed {
    /// The engine handle, as an integer -- see `Ipv6Block::engine`.
    pub engine: isize,
    pub filters: usize,
}

/// What making, installing and closing a hold needs of the machine: the
/// machine's, except in tests.
pub trait HoldOps: Send + Sync {
    fn install(&self, plan: &Plan) -> Result<Installed, String>;
    fn close(&self, engine: isize) -> u32;
    /// The LUIDs of our tunnel adapters that exist now; `None` when the
    /// adapters could not be listed.
    fn our_tunnels(&self) -> Option<Vec<u64>>;
    /// The LUID of the adapter Windows shows by this name, now.
    fn tunnel_luid(&self, adapter: &str) -> Option<u64>;
    /// The LAN and the DHCP servers, as the confinement reads them.
    fn lan(&self) -> Option<(Vec<Prefix>, Vec<Ipv4Addr>)>;
    /// Neoxify's own programs that are on this machine.
    fn programs(&self) -> Vec<PathBuf>;
    /// The resolvers the machine's adapters other than ours are configured
    /// with, IPv4 and IPv6; `None` when they could not be read.
    fn dns_servers(&self) -> Option<Vec<IpAddr>> {
        None
    }
}

/// The engines this service runs, by file name in its own directory.
const ENGINES: [&str; 3] = ["xray.exe", "openvpn.exe", "wireguard.exe"];

/// Neoxify's programs, of those `exists` finds: the engines beside the
/// service, the app beside it or in the directory above (the installed
/// layout puts the service in `resources\`), and the service itself.
pub fn programs_in(exe_dir: &Path, service: Option<PathBuf>, exists: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = ENGINES.iter().map(|engine| exe_dir.join(engine)).collect();
    candidates.push(exe_dir.join(crate::lifecycle::client_watch::APP_EXE));
    if let Some(parent) = exe_dir.parent() {
        candidates.push(parent.join(crate::lifecycle::client_watch::APP_EXE));
    }
    candidates.extend(service);
    let mut found: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if exists(&candidate) && !found.contains(&candidate) {
            found.push(candidate);
        }
    }
    found
}

/// The machine. `exe_dir` is where the engines are, beside the service.
pub struct System {
    pub exe_dir: PathBuf,
}

impl HoldOps for System {
    fn install(&self, plan: &Plan) -> Result<Installed, String> {
        let specs = specs(plan);
        let installed = confinement::install_specs_with(
            &specs,
            &HOLD_KEYS,
            SUBLAYER_NAME,
            "Holds everything outside a Neoxify tunnel while it reconnects; removed when it ends",
        )?;
        Ok(Installed { engine: installed.engine, filters: installed.filters })
    }

    fn close(&self, engine: isize) -> u32 {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::FwpmEngineClose0;
        // SAFETY: `engine` is a session `install` opened, taken out of the
        // hold under its lock, so it is closed once.
        unsafe { FwpmEngineClose0(engine as HANDLE) }
    }

    fn our_tunnels(&self) -> Option<Vec<u64>> {
        let listed = crate::adapters::list().ok()?;
        Some(
            listed
                .iter()
                .filter(|adapter| super::OUR_ADAPTER_NAMES.contains(&adapter.name.as_str()))
                .filter_map(|adapter| super::traffic::luid_of_index(adapter.index))
                .collect(),
        )
    }

    fn tunnel_luid(&self, adapter: &str) -> Option<u64> {
        let found = crate::adapters::find_by_name(adapter).ok()??;
        super::traffic::luid_of_index(found.index)
    }

    fn lan(&self) -> Option<(Vec<Prefix>, Vec<Ipv4Addr>)> {
        super::machine_lan()
    }

    fn programs(&self) -> Vec<PathBuf> {
        programs_in(&self.exe_dir, std::env::current_exe().ok(), |path| path.is_file())
    }

    fn dns_servers(&self) -> Option<Vec<IpAddr>> {
        crate::adapters::dns_servers(&super::OUR_ADAPTER_NAMES).ok()
    }
}

/// No filtering platform: what the service's own tests run with unless a
/// test puts its own in, so nothing a test does can hold the machine that
/// runs it. Every install is refused.
pub struct Inert;

impl HoldOps for Inert {
    fn install(&self, _plan: &Plan) -> Result<Installed, String> {
        Err("no filtering platform here".into())
    }
    fn close(&self, _engine: isize) -> u32 {
        0
    }
    fn our_tunnels(&self) -> Option<Vec<u64>> {
        Some(Vec::new())
    }
    fn tunnel_luid(&self, _adapter: &str) -> Option<u64> {
        None
    }
    fn lan(&self) -> Option<(Vec<Prefix>, Vec<Ipv4Addr>)> {
        Some((Vec::new(), Vec::new()))
    }
    fn programs(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

/// Why a hold is let go of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Release {
    /// On purpose -- the app, the customer, the service ending -- with the
    /// reason for the log. Nothing to report afterwards.
    Asked(&'static str),
    /// Because it could not go on, which the status then says.
    Failed(ReconnectHoldProblem, String),
}

/// The hold: one for the service's life, shared by `Arc` with every
/// session's engine watch (a drop is held from the watch's own thread,
/// without waiting for the owning one) and with the pipe (which lets go of
/// it without waiting either).
///
/// One mutex over its whole state, and every install and close made under
/// it: whichever caller gets there first does the work and every other
/// finds it done, so each WFP session it opens is closed exactly once,
/// whatever races. An install is one WFP transaction, milliseconds.
pub struct Hold {
    state: Mutex<State>,
    ops: Arc<dyn HoldOps>,
    log: Option<PathBuf>,
}

#[derive(Default)]
struct State {
    /// The setting, as the app last said it.
    wanted: bool,
    /// The session a drop would be held for, its plan, and whether that
    /// plan stands in force while the session is up (`stands_while_up`).
    armed: Option<(u64, Plan, bool)>,
    /// The WFP session in force -- a hold, or filters standing for the
    /// armed session -- 0 while none is.
    engine: isize,
    filters: usize,
    /// The plan in force, while one is.
    held: Option<Plan>,
    /// The armed session the filters in force stand for while it is up:
    /// they hold no drop yet. `None` while they hold one, and while nothing
    /// is in force. Only ever the armed session's.
    standing: Option<u64>,
    /// When it began holding.
    since: Option<Instant>,
    /// The session whose ending this hold is for: the drop that began it,
    /// or a later one it went on holding through.
    engaged_by: Option<u64>,
    /// How many drops it has held, counting one it was already holding
    /// through: a retraction lets go only of a hold no drop has reached
    /// since it looked (`Hold::release_if_engaged_by`).
    engagements: u64,
    /// Why it is not holding when it should be. Cleared when it holds
    /// again, and when it is let go of on purpose.
    problem: Option<(ReconnectHoldProblem, String)>,
    /// A drop began this hold and no reconnect has followed it yet
    /// (`NO_FOLLOW_UP`).
    awaiting_follow_up: bool,
    /// When the LAN, the DHCP servers and the resolvers are next read
    /// again while filters are in force (`Hold::reread`).
    reread_at: Option<Instant>,
}

impl State {
    /// Holding a drop: filters in force that are not standing for a
    /// session that is up.
    fn holding(&self) -> bool {
        self.engine != 0 && self.standing.is_none()
    }
}

/// Whether `held` lets through everything `plan` does that a tunnel needs
/// to carry: its tunnels, its servers and Neoxify's programs.
fn permits_all_of(held: &Plan, plan: &Plan) -> bool {
    plan.tunnels.iter().all(|t| held.tunnels.contains(t))
        && plan.nodes.iter().all(|n| held.nodes.contains(n))
        && plan.programs.iter().all(|p| held.programs.contains(p))
}

impl Hold {
    pub fn new(ops: Arc<dyn HoldOps>, log_dir: Option<&Path>) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), ops, log: log_dir.map(|dir| dir.join(LOG_FILE)) })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn note(&self, line: &str) {
        if let Some(log) = &self.log {
            super::ipv6_block::note(log, line);
        }
    }

    /// What making a plan needs of the machine.
    pub fn ops(&self) -> &dyn HoldOps {
        &*self.ops
    }

    /// The setting, as the app says it.
    pub fn set_wanted(&self, wanted: bool) {
        self.lock().wanted = wanted;
    }

    pub fn wanted(&self) -> bool {
        self.lock().wanted
    }

    /// The setting turned off: lets go of a hold, takes out filters
    /// standing for a session, and forgets the plan for either. Returns
    /// whether anything was in force.
    pub fn turn_off(&self) -> bool {
        let mut state = self.lock();
        state.wanted = false;
        state.armed = None;
        state.problem = None;
        self.close_locked(state, "the setting was turned off")
    }

    /// Arms the session `generation` with `plan`, if the setting is on.
    ///
    /// While a hold is held -- the tunnel a reconnect has just brought up
    /// -- the hold is moved onto this plan here, under the same lock, the
    /// new in before the old is closed, so that tunnel carries; a plan that
    /// will not go in lets go of the hold rather than block it.
    ///
    /// Otherwise, `stands`: the plan goes in now and stays in force while
    /// the session is up (`stands_while_up`), in place of filters standing
    /// for any other, the new in before the old is closed. One that will
    /// not go in is said in the log, and the session is armed as any other
    /// is: its drop is held from the watch's report. Not `stands`: filters
    /// standing for another session are taken out.
    pub fn arm(&self, generation: u64, plan: Plan, stands: bool) -> bool {
        let mut state = self.lock();
        if !state.wanted || generation == 0 {
            return false;
        }
        // The session whose drop this holds for, armed again -- the setting
        // said again as the reconnect begins, while that session is still in
        // the slot being taken down: its tunnel is gone, and there is nothing
        // to move the hold onto. Left as it is, armed as it was.
        if state.holding() && state.engaged_by == Some(generation) {
            return true;
        }
        // The same session armed again: never narrower than before.
        let plan = match &state.armed {
            Some((armed, before, _)) if *armed == generation => plan.widened_by(before),
            _ => plan,
        };
        state.armed = Some((generation, plan.clone(), stands));
        if state.holding() {
            if state.held.as_ref() == Some(&plan) {
                return true;
            }
            match self.ops.install(&plan) {
                Ok(installed) => {
                    let old = std::mem::replace(&mut state.engine, installed.engine);
                    state.filters = installed.filters;
                    state.held = Some(plan);
                    let err = self.ops.close(old);
                    drop(state);
                    if err != 0 {
                        self.note(&format!("the plan before was closed with {err:#010x}; its session ends with the process"));
                    }
                    self.note(&format!("holding, moved onto the tunnel that came up: {} filters", installed.filters));
                }
                Err(e) => {
                    self.release_locked(
                        state,
                        Release::Failed(
                            ReconnectHoldProblem::TunnelNotPermitted,
                            format!("the tunnel that came up could not be put in the hold's plan, so the hold was let go of: {e}"),
                        ),
                    );
                }
            }
            return true;
        }
        if !stands {
            if state.engine != 0 {
                self.close_locked(state, "the session armed now keeps nothing standing");
            }
            return true;
        }
        if state.engine != 0 && state.standing == Some(generation) && state.held.as_ref() == Some(&plan) {
            return true;
        }
        match self.ops.install(&plan) {
            Ok(installed) => {
                let old = std::mem::replace(&mut state.engine, installed.engine);
                state.filters = installed.filters;
                state.held = Some(plan);
                state.standing = Some(generation);
                state.reread_at = None;
                let err = if old == 0 { 0 } else { self.ops.close(old) };
                drop(state);
                if err != 0 {
                    self.note(&format!("the filters standing before were closed with {err:#010x}; their session ends with the process"));
                }
                self.note(&format!(
                    "standing: {} filters in force while the tunnel is up, so its drop is held from the first moment",
                    installed.filters
                ));
            }
            Err(e) => {
                if state.engine != 0 {
                    self.close_locked(state, "the filters for the session armed now would not go in");
                } else {
                    drop(state);
                }
                self.note(&format!("could not stand in force while the tunnel is up, so its drop is held from the watch's report: {e}"));
                crate::cleanup_log::note("keep the hold standing while the tunnel is up", &format!("not standing: {e}"));
            }
        }
        true
    }

    /// Forgets the plan for a drop, and takes out filters standing for the
    /// session it was for. A hold held stays: letting go of one is asked
    /// for on its own (`release`).
    pub fn disarm(&self) {
        let mut state = self.lock();
        state.armed = None;
        if state.standing.is_some() {
            self.close_locked(state, "the session they stood for is not to be held");
        }
    }

    /// Whether a drop of `generation` would be held.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn armed_for(&self, generation: u64) -> bool {
        let state = self.lock();
        state.wanted && state.armed.as_ref().is_some_and(|(armed, _, _)| *armed == generation)
    }

    /// Whether it is holding for the drop of `generation`: the session whose
    /// end began the hold, or the last one it went on holding through. That
    /// session, still in the slot while it is taken down -- its engine
    /// running on with its tunnel adapter gone, or its death not yet torn
    /// down -- is no tunnel to arm or to let go of the hold for.
    pub fn held_for(&self, generation: u64) -> bool {
        let state = self.lock();
        state.holding() && state.engaged_by == Some(generation)
    }

    /// Whether filters stand in force for `generation` while it is up.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn standing_for(&self, generation: u64) -> bool {
        let state = self.lock();
        state.engine != 0 && state.standing == Some(generation)
    }

    /// Holds, with the plan armed for `generation`, because that session is
    /// ending in a way that is not the customer's own. Returns whether it
    /// is holding now -- already, or from this call.
    ///
    /// Filters standing for that session are in force already, and simply
    /// become the hold: nothing is installed, so nothing passes between the
    /// tunnel's end and the hold. Otherwise the plan goes in as one WFP
    /// transaction, under the lock: whichever watcher gets here first
    /// installs it, and every other waits for that and finds it in. A
    /// caller lets go of the session's own protection only after this has
    /// returned.
    pub fn engage(&self, generation: u64, why: &str) -> bool {
        let mut state = self.lock();
        if state.holding() {
            // Another drop while it holds -- the tunnel a reconnect brought
            // up, gone too, or the app's own teardown of it: the hold is
            // that one's now.
            if state.armed.as_ref().is_some_and(|(armed, _, _)| *armed == generation) {
                state.engaged_by = Some(generation);
                state.engagements += 1;
            }
            return true;
        }
        if !state.wanted {
            return false;
        }
        if state.engine != 0 && state.standing == Some(generation) {
            state.standing = None;
            state.since = Some(Instant::now());
            state.engaged_by = Some(generation);
            state.engagements += 1;
            state.problem = None;
            state.awaiting_follow_up = true;
            state.reread_at = None;
            let filters = state.filters;
            drop(state);
            self.note(&format!(
                "holding: the {filters} filters standing for the tunnel were in force when it ended, so nothing passed between ({why})"
            ));
            return true;
        }
        let plan = match &state.armed {
            Some((armed, plan, _)) if *armed == generation => plan.clone(),
            _ => return false,
        };
        match self.ops.install(&plan) {
            Ok(installed) => {
                // Nothing standing can be in force here -- only ever the
                // armed session's, which is this one -- but a session is
                // never left open behind one that replaced it.
                let old = std::mem::replace(&mut state.engine, installed.engine);
                state.filters = installed.filters;
                state.held = Some(plan);
                state.standing = None;
                state.since = Some(Instant::now());
                state.engaged_by = Some(generation);
                state.engagements += 1;
                state.problem = None;
                state.awaiting_follow_up = true;
                state.reread_at = None;
                if old != 0 {
                    self.ops.close(old);
                }
                drop(state);
                self.note(&format!("holding: {} filters, nothing but Neoxify reaches the network outside a tunnel ({why})", installed.filters));
                true
            }
            Err(e) => {
                state.problem = Some((ReconnectHoldProblem::FiltersRefused, e.clone()));
                drop(state);
                self.note(&format!("could not hold ({why}), so nothing is held: {e}"));
                crate::cleanup_log::note("hold the internet while reconnecting", &format!("not held, nothing blocked: {e}"));
                false
            }
        }
    }

    /// How many drops it has held so far: what a retraction reads before
    /// the engine's watch starts again (`release_if_engaged_by`).
    pub fn engagements(&self) -> u64 {
        self.lock().engagements
    }

    /// Puts `plan` in place of the one in force, the new one in before the
    /// old is closed so nothing passes between them. `needed`: the new plan
    /// is what lets a tunnel that has just come up carry, so one that will
    /// not go in lets go of the hold altogether rather than block that
    /// tunnel. Otherwise the plan in force stays. Nothing in force, nothing
    /// done.
    pub fn replan(&self, plan: Plan, needed: bool) -> bool {
        let mut state = self.lock();
        if state.engine == 0 {
            return false;
        }
        if state.held.as_ref() == Some(&plan) {
            return true;
        }
        match self.ops.install(&plan) {
            Ok(installed) => {
                let old = std::mem::replace(&mut state.engine, installed.engine);
                state.filters = installed.filters;
                state.held = Some(plan);
                let what = if state.standing.is_some() { "standing" } else { "holding" };
                let err = self.ops.close(old);
                drop(state);
                if err != 0 {
                    self.note(&format!("the plan before was closed with {err:#010x}; its session ends with the process"));
                }
                self.note(&format!("{what}, with a new plan: {} filters", installed.filters));
                true
            }
            Err(e) if needed => {
                self.release_locked(
                    state,
                    Release::Failed(
                        ReconnectHoldProblem::TunnelNotPermitted,
                        format!("the tunnel that came up could not be put in the hold's plan, so the hold was let go of: {e}"),
                    ),
                );
                false
            }
            Err(e) => {
                drop(state);
                self.note(&format!("a new plan would not go in, so the one in force stays: {e}"));
                false
            }
        }
    }

    /// A reconnect follows the drop being held for: a Connect, a
    /// `DisconnectForReconnect`, or the app saying the setting again as
    /// its reconnect begins. The hold then lasts until it is let go of or
    /// [`HOLD_LONGEST`], no longer [`NO_FOLLOW_UP`].
    pub fn followed(&self) {
        self.lock().awaiting_follow_up = false;
    }

    /// Lets go of the hold, if one is held. Returns whether this call let
    /// go of it. Safe from any thread, any number of times. Filters
    /// standing for a live session are not a hold, and stay
    /// (`let_go_locked`).
    pub fn release(&self, why: Release) -> bool {
        let state = self.lock();
        self.let_go_locked(state, why, false)
    }

    fn release_locked(&self, state: MutexGuard<'_, State>, why: Release) -> bool {
        self.let_go_locked(state, why, false)
    }

    /// Lets go of the hold held, if one is. `retracted`: the drop it was
    /// begun for was not one -- its engine runs.
    ///
    /// Let go of on purpose over a session armed to keep its filters
    /// standing -- the WireGuard tunnel a reconnect brought up, or the one
    /// whose drop was taken back -- they stay in force, standing for it, as
    /// they are: taken out and put back there would be a moment with
    /// neither them nor wireguard.exe's own. Otherwise they are closed.
    /// Filters standing with no hold held are left alone: disarming takes
    /// them out.
    fn let_go_locked(&self, mut state: MutexGuard<'_, State>, why: Release, retracted: bool) -> bool {
        let reason = match &why {
            Release::Asked(reason) => {
                state.problem = None;
                (*reason).to_string()
            }
            Release::Failed(problem, detail) => {
                state.problem = Some((*problem, detail.clone()));
                detail.clone()
            }
        };
        if !state.holding() {
            return false;
        }
        let stand_for = match (&why, &state.armed, &state.held) {
            (Release::Asked(_), Some((armed, plan, true)), Some(held))
                if (retracted || state.engaged_by != Some(*armed)) && permits_all_of(held, plan) =>
            {
                Some(*armed)
            }
            _ => None,
        };
        if let Some(generation) = stand_for {
            let held_for = state.since.map_or_else(String::new, |since| format!(" after {}s", since.elapsed().as_secs()));
            state.standing = Some(generation);
            state.since = None;
            state.engaged_by = None;
            state.awaiting_follow_up = false;
            state.reread_at = None;
            drop(state);
            self.note(&format!("let go of{held_for}: its filters stay standing for the tunnel that is up ({reason})"));
            return true;
        }
        let failed = matches!(why, Release::Failed(..));
        let closed = self.close_locked(state, &reason);
        if failed {
            crate::cleanup_log::note("let go of the hold while reconnecting", &reason);
        }
        closed
    }

    /// Takes out whatever is in force -- a hold, or filters standing -- and
    /// forgets both. Returns whether anything was.
    fn close_locked(&self, mut state: MutexGuard<'_, State>, reason: &str) -> bool {
        let holding = state.holding();
        let engine = std::mem::take(&mut state.engine);
        let filters = state.filters;
        let held_for = state.since.map(|since| since.elapsed());
        state.held = None;
        state.standing = None;
        state.since = None;
        state.engaged_by = None;
        state.awaiting_follow_up = false;
        state.reread_at = None;
        if engine == 0 {
            return false;
        }
        let err = self.ops.close(engine);
        drop(state);
        let what = if holding { "let go of" } else { "standing filters taken out" };
        let held_for = held_for.map_or_else(String::new, |d| format!(" after {}s", d.as_secs()));
        if err == 0 {
            self.note(&format!("{what}{held_for}: {filters} filters removed ({reason})"));
        } else {
            self.note(&format!("{what}{held_for}; removal reported {err:#010x}, the session ends with the process ({reason})"));
        }
        true
    }

    /// The engine a drop report named turned out to be running: a hold that
    /// report began is let go of -- unless a drop has been held since
    /// `seen` (`engagements`, read when the report was taken back): that
    /// hold is a new drop's, and stays. Filters standing for the session
    /// stay standing, read again at once for its adapter -- a tunnel service
    /// started again can come back on another. One begun otherwise stays.
    pub fn release_if_engaged_by(&self, generation: u64, seen: u64) -> bool {
        let state = self.lock();
        if !state.holding() || state.engaged_by != Some(generation) || state.engagements != seen {
            return false;
        }
        let let_go = self.let_go_locked(state, Release::Asked("the engine reported gone is running"), true);
        let standing = {
            let mut state = self.lock();
            let standing = state.engine != 0 && state.standing.is_some();
            if standing {
                state.reread_at = None;
            }
            standing
        };
        if standing {
            self.reread(Instant::now());
        }
        let_go
    }

    /// What every status poll does to it, from whichever thread answers,
    /// with the session up now, if any: settles filters standing for a
    /// session that is no longer it (`settle_standing`); lets go of a hold
    /// nothing followed or that has held too long with no tunnel -- the
    /// session whose drop it holds, still up while it is taken down, is no
    /// tunnel -- and reads the network again while filters are in force.
    pub fn tend(&self, live: Option<u64>) {
        self.settle_standing(live);
        let tunnel_up = live.is_some() && live != self.lock().engaged_by;
        if !self.expire_if_due(tunnel_up, HOLD_LONGEST) {
            self.reread(Instant::now());
        }
    }

    /// Filters standing for a session that is no longer the one up. None
    /// up -- it ended, and nothing said so to the hold -- they hold its
    /// drop, as the watch's report would have, and the status and the
    /// backstops see it. Another up, which they were not made for: taken
    /// out rather than block its tunnel. Returns whether anything changed.
    pub fn settle_standing(&self, live: Option<u64>) -> bool {
        let mut state = self.lock();
        let Some(generation) = state.standing else { return false };
        if state.engine == 0 || live == Some(generation) {
            return false;
        }
        if live.is_some() || !state.wanted {
            self.close_locked(state, "the session they stood for is no longer the one up");
            return true;
        }
        state.standing = None;
        state.since = Some(Instant::now());
        state.engaged_by = Some(generation);
        state.engagements += 1;
        state.problem = None;
        state.awaiting_follow_up = true;
        state.reread_at = None;
        drop(state);
        self.note("holding: the session the filters stood for ended with no word to the hold, so its drop is held");
        true
    }

    /// Lets go of a hold a drop began that no reconnect has followed
    /// within `within`, with no tunnel up: the app has decided not to
    /// reconnect, or lost track, and the machine is not left held behind a
    /// screen that has moved on.
    pub fn let_go_if_unfollowed(&self, tunnel_up: bool, within: Duration) -> bool {
        let state = self.lock();
        let due = state.holding()
            && !tunnel_up
            && state.awaiting_follow_up
            && state.since.is_some_and(|since| since.elapsed() >= within);
        if !due {
            return false;
        }
        self.release_locked(
            state,
            Release::Failed(
                ReconnectHoldProblem::Other,
                format!("no reconnect followed the drop within {} seconds, so it was let go of", within.as_secs()),
            ),
        )
    }

    /// The LAN, the DHCP servers and the resolvers read again while filters
    /// are in force, at most every [`REREAD_EVERY`], and the plan moved onto
    /// them when they have changed: a laptop that roamed during the wait
    /// gets its new network's LAN, not the old one's. Our tunnel adapters
    /// are read again too, and any new one is permitted beside those held:
    /// a tunnel service started again under filters standing for it can
    /// come back on an adapter of another LUID. A plan that will not go in
    /// leaves the one in force, and is not tried again for
    /// [`REREAD_AFTER_REFUSAL`]. Resolvers that cannot be read this time
    /// keep the ones held. Returns whether the plan moved.
    pub fn reread(&self, now: Instant) -> bool {
        let held = {
            let mut state = self.lock();
            if state.engine == 0 || state.reread_at.is_some_and(|at| now < at) {
                return false;
            }
            state.reread_at = Some(now + REREAD_EVERY);
            match &state.held {
                Some(plan) => plan.clone(),
                None => return false,
            }
        };
        let Some((lan, dhcp_servers)) = self.ops.lan() else { return false };
        let dns = self.ops.dns_servers().unwrap_or_else(|| held.dns.clone());
        let mut tunnels = held.tunnels.clone();
        tunnels.extend(self.ops.our_tunnels().unwrap_or_default());
        let next = Plan::new(tunnels, held.programs.clone(), held.nodes.clone(), lan, dhcp_servers).with_dns(dns);
        if next == held {
            return false;
        }
        if self.replan(next, false) {
            self.note("the network changed while filters were in force, so the LAN, resolvers and tunnels they permit were read again");
            return true;
        }
        let mut state = self.lock();
        if state.engine != 0 {
            state.reread_at = Some(now + REREAD_AFTER_REFUSAL);
        }
        false
    }

    /// Lets go of a hold that has held for `longest` with no tunnel up --
    /// or, sooner, one a drop began that no reconnect has followed within
    /// [`NO_FOLLOW_UP`].
    pub fn expire_if_due(&self, tunnel_up: bool, longest: Duration) -> bool {
        if self.let_go_if_unfollowed(tunnel_up, NO_FOLLOW_UP) {
            return true;
        }
        let state = self.lock();
        let due = state.holding() && !tunnel_up && state.since.is_some_and(|since| since.elapsed() >= longest);
        if !due {
            return false;
        }
        self.release_locked(
            state,
            Release::Failed(
                ReconnectHoldProblem::TimedOut,
                format!("held for {} minutes with no tunnel back, so it was let go of", longest.as_secs() / 60),
            ),
        )
    }

    /// Whether a drop is being held. Filters standing for a session that is
    /// up are not.
    pub fn holding(&self) -> bool {
        self.lock().holding()
    }

    /// The plan in force, while one is.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn held_plan(&self) -> Option<Plan> {
        self.lock().held.clone()
    }

    /// What the status poll says of it. `live`: the session up now, if any
    /// -- "armed" is said only of the session that is, and a hold is said
    /// to have `landed` only under a session that came up after the drop
    /// it holds for and is armed: its tunnel in the plan, the gap over.
    /// The dropped session itself, still in the slot while it is taken
    /// down, is not one.
    pub fn report(&self, live: Option<u64>) -> Option<Report> {
        let state = self.lock();
        if state.holding() {
            let held_secs = state.since.map_or(0, |since| since.elapsed().as_secs());
            let dns_anywhere = state.held.as_ref().is_some_and(Plan::dns_anywhere);
            let landed = live.is_some()
                && live != state.engaged_by
                && state.armed.as_ref().is_some_and(|(armed, _, _)| live == Some(*armed));
            return Some(Report::Holding { held_secs, dns_anywhere, landed });
        }
        if let Some((problem, detail)) = &state.problem {
            return Some(Report::NotHeld { problem: *problem, detail: Some(detail.clone()) });
        }
        let armed = state.armed.as_ref().is_some_and(|(armed, _, _)| live == Some(*armed));
        (state.wanted && armed).then_some(Report::Armed)
    }
}

/// The last holder letting go closes it too, standing filters and all: the
/// path nobody wrote. The process ending closes the session whatever
/// happens here.
impl Drop for Hold {
    fn drop(&mut self) {
        let state = self.lock();
        self.close_locked(state, "the service let go of it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::{Ikev2Profile, OpenvpnProfile, ShadowsocksProfile, WireguardProfile, XrayProfile};
    use std::net::IpAddr;

    const TUNNEL: u64 = 0x0035_0000_0100_0000;
    const PHYSICAL: u64 = 0x0006_0000_0200_0000;

    fn xray() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Neoxify\resources\xray.exe")
    }

    fn app() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Neoxify\neoconnect-desktop.exe")
    }

    fn browser() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Browser\browser.exe")
    }

    fn node() -> Ipv4Addr {
        Ipv4Addr::new(203, 0, 113, 7)
    }

    fn plan() -> Plan {
        Plan::new(
            vec![TUNNEL],
            vec![xray(), app()],
            vec![node(), Ipv4Addr::new(198, 51, 100, 9)],
            vec![Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24)],
            vec![Ipv4Addr::new(198, 51, 100, 67)],
        )
    }

    fn profiles() -> Vec<(ConnectProfile, bool)> {
        let wireguard = ConnectProfile::Wireguard(WireguardProfile {
            private_key: String::new(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: String::new(),
            endpoint: format!("{}:51820", node()),
        });
        let reality = ConnectProfile::XrayVlessReality(XrayProfile {
            uuid: String::new(),
            flow: String::new(),
            host: node().to_string(),
            port: 443,
            reality_public_key: String::new(),
            short_id: String::new(),
            server_name: "www.example.com".into(),
        });
        let shadowsocks = ConnectProfile::Shadowsocks(ShadowsocksProfile {
            host: node().to_string(),
            port: 8388,
            method: "2022-blake3-aes-128-gcm".into(),
            password: String::new(),
        });
        let openvpn = ConnectProfile::Openvpn(OpenvpnProfile {
            cert_pem: String::new(),
            key_pem: String::new(),
            ca_cert_pem: String::new(),
            endpoint: format!("{}:1194", node()),
            proto: "udp".into(),
            tls_crypt_key: None,
        });
        let ikev2 = ConnectProfile::Ikev2(Ikev2Profile {
            server: "node.example.com".into(),
            username: String::new(),
            password: String::new(),
        });
        vec![(wireguard, true), (reality, true), (shadowsocks, true), (openvpn, true), (ikev2, false)]
    }

    /// Full tunnels on the engines this service runs are covered; IKEv2 and
    /// Custom mode are not, and the app has to say so.
    #[test]
    fn covers_full_tunnels_but_not_ikev2_or_custom_mode() {
        for (profile, covered) in profiles() {
            assert_eq!(covers(&profile, false), covered, "{profile:?}");
            assert!(!covers(&profile, true), "Custom mode: {profile:?}");
        }
    }

    /// A plan keeps each thing once, bounds the servers, and never names a
    /// server address that would permit everything or nothing real.
    #[test]
    fn a_plan_keeps_each_thing_once_and_bounds_the_servers() {
        let nodes: Vec<Ipv4Addr> = (0..400u32).map(|i| Ipv4Addr::from(0xC633_6400 + (i % 300))).chain([
            Ipv4Addr::UNSPECIFIED,
            Ipv4Addr::BROADCAST,
            Ipv4Addr::LOCALHOST,
        ]).collect();
        let plan = Plan::new(vec![TUNNEL, TUNNEL, 0], vec![xray(), xray()], nodes, Vec::new(), Vec::new());
        assert_eq!(plan.tunnels, vec![TUNNEL]);
        assert_eq!(plan.programs, vec![xray()]);
        assert_eq!(plan.nodes.len(), MAX_NODES);
        assert!(!plan.nodes.iter().any(|n| n.is_unspecified() || n.is_broadcast() || n.is_loopback()));
    }

    /// Every layer ends in a block of everything, and nothing is permitted
    /// unconditionally but by loopback: the shape that makes it a hold.
    #[test]
    fn every_layer_blocks_everything_the_permits_do_not_name() {
        let specs = specs(&plan());
        for layer in [Layer::ConnectV4, Layer::RecvAcceptV4, Layer::ConnectV6, Layer::RecvAcceptV6] {
            let blocks: Vec<&FilterSpec> = specs.iter().filter(|s| s.layer == layer && s.action == Action::Block).collect();
            assert_eq!(blocks.len(), 1, "{layer:?}");
            assert!(blocks[0].conds.is_empty() && blocks[0].weight == WEIGHT_BLOCK, "{layer:?}: {:?}", blocks[0]);
            assert!(
                specs.iter().filter(|s| s.layer == layer && s.action == Action::Permit).all(|s| !s.conds.is_empty()),
                "an unconditional permit at {layer:?}"
            );
        }
        assert!(specs.iter().all(|s| s.name.starts_with("Neoxify reconnect hold: ")), "a filter netsh would not name as ours");
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Verdict {
        Permit,
        Block,
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

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    fn v6_contains(prefix: Ipv6Addr, len: u8, addr: Ipv6Addr) -> bool {
        let bits = u32::from(len.min(128));
        let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
        u128::from(addr) & mask == u128::from(prefix) & mask
    }

    fn v4_contains(prefix: &Prefix, addr: Ipv4Addr) -> bool {
        let bits = u32::from(prefix.len.min(32));
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        u32::from(addr) & mask == u32::from(prefix.addr) & mask
    }

    fn holds(cond: &Cond, flow: &Flow) -> bool {
        match cond {
            Cond::Loopback => flow.loopback,
            Cond::RemoteV4(prefix) => matches!(flow.remote, IpAddr::V4(a) if v4_contains(prefix, a)),
            Cond::RemoteV6(prefix, len) => matches!(flow.remote, IpAddr::V6(a) if v6_contains(*prefix, *len, a)),
            Cond::LocalInterface(luid) => flow.interface == *luid,
            Cond::App(path) => &flow.app == path,
            Cond::RemotePort(port) => flow.remote_port == *port,
            Cond::LocalPort(port) => flow.local_port == *port,
            Cond::Protocol(number) => flow.protocol == *number,
        }
    }

    /// WFP's arbitration, as `confinement`'s model has it -- the highest
    /// weight matching filter in each sublayer answers for it, and a block
    /// from any sublayer wins. A model, not evidence: what WFP does is the
    /// install test's and the VM's to show.
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

    fn check(sublayers: &[Vec<FilterSpec>], rows: &[(&str, Flow, Verdict)]) {
        let wrong: Vec<String> = rows
            .iter()
            .filter_map(|(why, flow, expected)| {
                let got = decide(sublayers, flow);
                (got != *expected).then(|| format!("{why}: expected {expected:?}, got {got:?}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// What a hold lets through and what it refuses, flow by flow.
    #[test]
    fn the_flows_that_decide_the_hold() {
        const TCP: u8 = protocol::TCP;
        const UDP: u8 = protocol::UDP;
        let rows: Vec<(&str, Flow, Verdict)> = vec![
            ("a browser to the internet", out(browser(), v4(93, 184, 216, 34), 443, TCP, PHYSICAL), Verdict::Block),
            ("a browser over native IPv6", out(browser(), "2001:db8::1".parse().unwrap(), 443, TCP, PHYSICAL), Verdict::Block),
            ("a browser IPv4-mapped at V6", out(browser(), IpAddr::V6(Ipv4Addr::new(93, 184, 216, 34).to_ipv6_mapped()), 443, TCP, PHYSICAL), Verdict::Block),
            ("xray.exe to a server it was not told of", out(xray(), v4(198, 18, 0, 1), 443, TCP, PHYSICAL), Verdict::Permit),
            ("the app to its API", out(app(), v4(104, 16, 0, 1), 443, TCP, PHYSICAL), Verdict::Permit),
            ("anything to a Neoxify server -- WireGuard's kernel socket", out(PathBuf::from("System"), IpAddr::V4(node()), 51820, UDP, PHYSICAL), Verdict::Permit),
            ("a browser through a Neoxify tunnel", out(browser(), v4(93, 184, 216, 34), 443, TCP, TUNNEL), Verdict::Permit),
            ("the router's DNS", out(browser(), v4(192, 168, 1, 1), 53, UDP, PHYSICAL), Verdict::Permit),
            ("the ISP's DNS", out(browser(), v4(8, 8, 8, 8), 53, UDP, PHYSICAL), Verdict::Permit),
            ("DNS over IPv6", out(browser(), "2001:db8::53".parse().unwrap(), 53, UDP, PHYSICAL), Verdict::Permit),
            ("a printer on the LAN", out(browser(), v4(192, 168, 1, 20), 9100, TCP, PHYSICAL), Verdict::Permit),
            ("the carrier's network beyond the gateway", out(browser(), v4(10, 200, 0, 1), 443, TCP, PHYSICAL), Verdict::Block),
            ("a DHCP renewal to the ISP's server", Flow { local_port: 68, ..out(browser(), v4(198, 51, 100, 67), 67, UDP, PHYSICAL) }, Verdict::Permit),
            (
                "a DHCP answer from a network the PC roamed to",
                Flow { layer: Layer::RecvAcceptV4, local_port: 68, ..out(browser(), v4(10, 20, 30, 1), 67, UDP, PHYSICAL) },
                Verdict::Permit,
            ),
            (
                "an inbound connection from the internet",
                Flow { layer: Layer::RecvAcceptV4, local_port: 3389, ..out(browser(), v4(198, 51, 100, 77), 51_000, TCP, PHYSICAL) },
                Verdict::Block,
            ),
            ("neighbour discovery", out(browser(), "fe80::1".parse().unwrap(), 0, 58, PHYSICAL), Verdict::Permit),
            ("loopback", Flow { loopback: true, ..out(browser(), v4(127, 0, 0, 1), 8080, TCP, 1) }, Verdict::Permit),
            ("the app over native IPv6: IPv4-mapped only", out(app(), "2001:db8::1".parse().unwrap(), 443, TCP, PHYSICAL), Verdict::Block),
        ];
        check(&[specs(&plan())], &rows);
    }

    fn resolvers() -> Vec<IpAddr> {
        vec![IpAddr::V4(Ipv4Addr::new(198, 51, 100, 53)), "2001:db8:53::1".parse().unwrap()]
    }

    /// With the machine's resolvers read, name lookups go to them alone:
    /// another VPN on UDP 53, a DNS tunnel, a lookup to a resolver of the
    /// program's own choosing, and native IPv6 to any :53 are refused.
    #[test]
    fn name_lookups_go_only_to_the_machines_resolvers() {
        const TCP: u8 = protocol::TCP;
        const UDP: u8 = protocol::UDP;
        let narrowed = plan().with_dns(resolvers());
        assert!(!narrowed.dns_anywhere());
        let mapped = |a: u8, b: u8, c: u8, d: u8| IpAddr::V6(Ipv4Addr::new(a, b, c, d).to_ipv6_mapped());
        let rows: Vec<(&str, Flow, Verdict)> = vec![
            ("a browser to some host on UDP 53", out(browser(), v4(203, 0, 113, 9), 53, UDP, PHYSICAL), Verdict::Block),
            ("a browser to some host on TCP 53", out(browser(), v4(203, 0, 113, 9), 53, TCP, PHYSICAL), Verdict::Block),
            ("the same, IPv4-mapped", out(browser(), mapped(203, 0, 113, 9), 53, UDP, PHYSICAL), Verdict::Block),
            ("native IPv6 to some host's :53", out(browser(), "2001:db8::1".parse().unwrap(), 53, UDP, PHYSICAL), Verdict::Block),
            ("the configured resolver over UDP", out(browser(), v4(198, 51, 100, 53), 53, UDP, PHYSICAL), Verdict::Permit),
            ("the configured resolver over TCP", out(browser(), v4(198, 51, 100, 53), 53, TCP, PHYSICAL), Verdict::Permit),
            ("the configured resolver, IPv4-mapped", out(browser(), mapped(198, 51, 100, 53), 53, UDP, PHYSICAL), Verdict::Permit),
            ("the configured resolver on another port", out(browser(), v4(198, 51, 100, 53), 443, TCP, PHYSICAL), Verdict::Block),
            ("the configured IPv6 resolver", out(browser(), "2001:db8:53::1".parse().unwrap(), 53, UDP, PHYSICAL), Verdict::Permit),
            ("the configured IPv6 resolver on another port", out(browser(), "2001:db8:53::1".parse().unwrap(), 443, TCP, PHYSICAL), Verdict::Block),
            ("the router's resolver, on the LAN", out(browser(), v4(192, 168, 1, 1), 53, UDP, PHYSICAL), Verdict::Permit),
        ];
        check(&[specs(&narrowed)], &rows);
        // Not one unconditional port-53 permit left, at any layer.
        assert!(
            !specs(&narrowed).iter().any(|s| s.action == Action::Permit && s.conds.len() == 1 && matches!(s.conds[0], Cond::RemotePort(53))),
            "port 53 to anywhere is still permitted"
        );
    }

    /// Unread, the resolvers leave the broad rule -- and the status says
    /// so, so the screen does not claim the narrower one.
    #[test]
    fn unread_resolvers_leave_port_53_open_and_say_so() {
        assert!(plan().dns_anywhere());
        let rows: Vec<(&str, Flow, Verdict)> = vec![(
            "some host on UDP 53",
            out(browser(), v4(203, 0, 113, 9), 53, protocol::UDP, PHYSICAL),
            Verdict::Permit,
        )];
        check(&[specs(&plan())], &rows);

        let (hold, _fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        assert!(matches!(hold.report(None), Some(Report::Holding { dns_anywhere: true, .. })));
        hold.release(Release::Asked("the app proved a tunnel"));
        hold.arm(7, plan().with_dns(resolvers()), false);
        hold.engage(7, "a drop");
        assert!(matches!(hold.report(None), Some(Report::Holding { dns_anywhere: false, .. })));
    }

    /// The resolvers kept are each once, bounded, and never one that
    /// would permit everything or nothing real.
    #[test]
    fn a_plans_resolvers_are_kept_once_and_bounded() {
        let one: IpAddr = "198.51.100.53".parse().unwrap();
        let mut given = vec![one, one, "0.0.0.0".parse().unwrap(), "127.0.0.1".parse().unwrap(), "::1".parse().unwrap(), "::".parse().unwrap()];
        given.extend((1..=40u8).map(|i| IpAddr::V4(Ipv4Addr::new(198, 18, 0, i))));
        let dns = plan().with_dns(given).dns;
        assert_eq!(dns[0], one);
        assert_eq!(dns.len(), MAX_RESOLVERS);
        assert!(dns.iter().all(|a| !a.is_unspecified() && !a.is_loopback()));
    }

    /// A tunnel that comes up while it holds carries -- with the session's
    /// own IPv4 confinement and IPv6 block installed beside it, which is
    /// how a reconnected Xray session stands until the app lets go -- and
    /// what is outside that tunnel stays refused, by both.
    #[test]
    fn a_tunnel_brought_up_under_the_hold_carries_and_nothing_else_does() {
        const TCP: u8 = protocol::TCP;
        const UDP: u8 = protocol::UDP;
        let confined = confinement::plan_for(
            &profiles()[1].0,
            false,
            confinement::Inputs {
                tunnel_luid: TUNNEL,
                engine_exe: Some(xray()),
                nodes: vec![node()],
                lan: confinement::Lan::Allowed(vec![Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24)]),
                dhcp_servers: Vec::new(),
            },
        )
        .expect("an Xray full tunnel is confined")
        .expect("planned");
        let sublayers = vec![
            specs(&plan()),
            confinement::specs(&confined),
            super::super::ipv6_block::full_tunnel_specs(true, Some((TUNNEL, Some(xray().as_path())))),
        ];
        let rows: Vec<(&str, Flow, Verdict)> = vec![
            ("a browser through the tunnel", out(browser(), v4(93, 184, 216, 34), 443, TCP, TUNNEL), Verdict::Permit),
            ("DNS through the tunnel", out(browser(), v4(1, 1, 1, 1), 53, UDP, TUNNEL), Verdict::Permit),
            ("xray.exe to its server", out(xray(), IpAddr::V4(node()), 443, TCP, PHYSICAL), Verdict::Permit),
            ("a browser beside the tunnel", out(browser(), v4(93, 184, 216, 34), 443, TCP, PHYSICAL), Verdict::Block),
            ("the router's DNS beside the tunnel", out(browser(), v4(192, 168, 1, 1), 53, UDP, PHYSICAL), Verdict::Block),
            ("a printer on the LAN", out(browser(), v4(192, 168, 1, 20), 9100, TCP, PHYSICAL), Verdict::Permit),
        ];
        check(&sublayers, &rows);
        // And a tunnel the plan does not name is refused: why the plan is
        // made again, with its LUID, the moment a connect returns.
        let unnamed = out(browser(), v4(93, 184, 216, 34), 443, TCP, 0x0035_0000_0900_0000);
        assert_eq!(decide(&[specs(&plan())], &unnamed), Verdict::Block);
    }

    /// The programs a hold permits: the engines beside the service, the app
    /// beside it or one directory up, and the service -- those that exist.
    #[test]
    fn the_programs_are_neoxifys_own_that_exist() {
        let dir = PathBuf::from(r"C:\Program Files\Neoxify\resources");
        let service = dir.join("neoconnect-service.exe");
        let present = [
            dir.join("xray.exe"),
            dir.join("wireguard.exe"),
            PathBuf::from(r"C:\Program Files\Neoxify\neoconnect-desktop.exe"),
            service.clone(),
        ];
        let found = programs_in(&dir, Some(service.clone()), |p| present.iter().any(|q| q == p));
        assert_eq!(
            found,
            vec![
                dir.join("xray.exe"),
                dir.join("wireguard.exe"),
                PathBuf::from(r"C:\Program Files\Neoxify\neoconnect-desktop.exe"),
                service
            ]
        );
    }

    /// A machine's worth of WFP, for the hold's own tests: installs and
    /// closes recorded, an install refused on demand.
    #[derive(Default)]
    struct Fake {
        installs: Mutex<Vec<Plan>>,
        closed: Mutex<Vec<isize>>,
        refuse: std::sync::atomic::AtomicBool,
        next: std::sync::atomic::AtomicIsize,
        /// The LAN and DHCP servers, and the resolvers, as the test says
        /// they are now.
        lan: Mutex<(Vec<Prefix>, Vec<Ipv4Addr>)>,
        dns: Mutex<Option<Vec<IpAddr>>>,
    }

    impl HoldOps for Fake {
        fn install(&self, plan: &Plan) -> Result<Installed, String> {
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("could not add the filter (0x80320009)".into());
            }
            self.installs.lock().unwrap().push(plan.clone());
            let engine = 5000 + self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Installed { engine, filters: specs(plan).len() })
        }
        fn close(&self, engine: isize) -> u32 {
            self.closed.lock().unwrap().push(engine);
            0
        }
        fn our_tunnels(&self) -> Option<Vec<u64>> {
            Some(vec![TUNNEL])
        }
        fn tunnel_luid(&self, _adapter: &str) -> Option<u64> {
            Some(TUNNEL)
        }
        fn lan(&self) -> Option<(Vec<Prefix>, Vec<Ipv4Addr>)> {
            Some(self.lan.lock().unwrap().clone())
        }
        fn programs(&self) -> Vec<PathBuf> {
            vec![xray()]
        }
        fn dns_servers(&self) -> Option<Vec<IpAddr>> {
            self.dns.lock().unwrap().clone()
        }
    }

    fn held_by_fake() -> (Arc<Hold>, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        (Hold::new(fake.clone(), None), fake)
    }

    /// Off -- the default -- nothing arms and nothing holds, whatever ends.
    #[test]
    fn off_it_never_holds() {
        let (hold, fake) = held_by_fake();
        assert!(!hold.arm(7, plan(), false), "armed with the setting off");
        assert!(!hold.engage(7, "a drop"));
        assert!(fake.installs.lock().unwrap().is_empty());
        assert_eq!(hold.report(Some(7)), None, "the status says nothing while it is off");
    }

    /// On, a drop of the armed session holds with its plan; a drop of any
    /// other session does not; and the status says so.
    #[test]
    fn an_armed_sessions_drop_holds_and_another_sessions_does_not() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        assert!(hold.arm(7, plan(), false));
        assert_eq!(hold.report(Some(7)), Some(Report::Armed));
        assert_eq!(hold.report(Some(8)), None, "armed is said only of the live session");
        assert!(!hold.engage(6, "an older session's report"), "held for a session that was not armed");
        assert!(hold.engage(7, "a drop"));
        assert_eq!(fake.installs.lock().unwrap().clone(), vec![plan()]);
        assert!(matches!(hold.report(None), Some(Report::Holding { .. })));
        assert!(hold.engage(7, "a second report"), "already holding");
        assert_eq!(fake.installs.lock().unwrap().len(), 1, "installed twice");
        assert!(hold.release(Release::Asked("the app proved a tunnel")));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);
        assert_eq!(hold.report(None), None);
    }

    /// A hold that will not go in is said, and nothing is blocked.
    #[test]
    fn a_hold_that_will_not_go_in_says_so() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(!hold.engage(7, "a drop"));
        assert!(!hold.holding());
        assert!(matches!(
            hold.report(None),
            Some(Report::NotHeld { problem: ReconnectHoldProblem::FiltersRefused, .. })
        ));
        // Let go of on purpose afterwards: nothing left to say.
        hold.release(Release::Asked("the reconnect gave up"));
        assert_eq!(hold.report(None), None);
    }

    /// A new plan goes in before the old one is closed; a needed one that
    /// will not go in lets go of the hold rather than block the tunnel it
    /// was for; one that is not needed leaves the plan held in place.
    #[test]
    fn a_new_plan_goes_in_before_the_old_is_closed() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        let next = Plan { tunnels: vec![TUNNEL, 0x0035_0000_0300_0000], ..plan() };
        assert!(hold.replan(next.clone(), true));
        assert_eq!(fake.installs.lock().unwrap().len(), 2);
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000], "the old one, after the new");
        assert_eq!(hold.held_plan(), Some(next.clone()));
        assert!(hold.replan(next.clone(), true), "the same plan again is nothing to do");
        assert_eq!(fake.installs.lock().unwrap().len(), 2);

        fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(!hold.replan(plan(), false));
        assert!(hold.holding(), "a plan that was not needed cost the hold");
        assert!(!hold.replan(plan(), true));
        assert!(!hold.holding(), "a tunnel it could not name was left blocked");
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000, 5001]);
        assert!(matches!(
            hold.report(None),
            Some(Report::NotHeld { problem: ReconnectHoldProblem::TunnelNotPermitted, .. })
        ));
        assert!(!hold.replan(plan(), true), "nothing held, nothing to move");
    }

    /// Turning the setting off lets go at once and disarms: a drop
    /// afterwards is not held.
    #[test]
    fn turning_it_off_lets_go_and_disarms() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        assert!(hold.turn_off());
        assert!(!hold.holding());
        assert!(!hold.armed_for(7));
        assert!(!hold.engage(7, "a drop after"));
        assert_eq!(fake.installs.lock().unwrap().len(), 1);
        assert_eq!(hold.report(Some(7)), None);
    }

    /// A drop report the engine contradicts lets go of the hold it began,
    /// and only that one.
    #[test]
    fn a_retracted_drop_lets_go_of_the_hold_it_began() {
        let (hold, _fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        assert!(!hold.release_if_engaged_by(6, hold.engagements()));
        assert!(hold.holding());
        assert!(hold.release_if_engaged_by(7, hold.engagements()));
        assert!(!hold.holding());
        assert_eq!(hold.report(Some(7)), Some(Report::Armed), "still armed for the live session");
    }

    /// Held too long with no tunnel: let go of, and said. Not while a
    /// tunnel is up.
    #[test]
    fn held_too_long_without_a_tunnel_it_lets_go() {
        let (hold, _fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        assert!(!hold.expire_if_due(false, HOLD_LONGEST), "let go of at once");
        assert!(!hold.expire_if_due(true, Duration::ZERO), "let go of under a live tunnel");
        assert!(hold.expire_if_due(false, Duration::ZERO));
        assert!(matches!(hold.report(None), Some(Report::NotHeld { problem: ReconnectHoldProblem::TimedOut, .. })));
    }

    /// A hold a drop began that no reconnect follows -- no Connect, no
    /// `DisconnectForReconnect`, no word from the app -- is let go of after
    /// `NO_FOLLOW_UP`, and said; one a reconnect followed is not, nor one
    /// over a tunnel that is up.
    #[test]
    fn a_hold_nothing_followed_is_let_go_of() {
        let (hold, _fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        assert!(!hold.expire_if_due(false, HOLD_LONGEST), "let go of before NO_FOLLOW_UP");
        assert!(!hold.let_go_if_unfollowed(true, Duration::ZERO), "let go of under a live tunnel");
        assert!(hold.let_go_if_unfollowed(false, Duration::ZERO));
        assert!(!hold.holding());
        assert!(matches!(hold.report(None), Some(Report::NotHeld { problem: ReconnectHoldProblem::Other, .. })));

        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");
        hold.followed();
        assert!(!hold.let_go_if_unfollowed(false, Duration::ZERO), "let go of though a reconnect followed");
        assert!(hold.holding());
        // Followed, it lasts to the longest wait, as before.
        assert!(hold.expire_if_due(false, Duration::ZERO));
        assert!(matches!(hold.report(None), Some(Report::NotHeld { problem: ReconnectHoldProblem::TimedOut, .. })));
    }

    /// The LAN, the DHCP servers and the resolvers are read again while it
    /// holds -- at most every `REREAD_EVERY` -- and a laptop that roamed
    /// during the wait reaches its new LAN. A plan that will not go in
    /// leaves the one held, and waits `REREAD_AFTER_REFUSAL` to be tried
    /// again.
    #[test]
    fn the_lan_is_read_again_while_it_holds() {
        let (hold, fake) = held_by_fake();
        let t0 = Instant::now();
        assert!(!hold.reread(t0), "read with nothing held");
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a drop");

        let roamed = Prefix::new(Ipv4Addr::new(10, 20, 30, 0), 24);
        *fake.lan.lock().unwrap() = (vec![roamed], vec![Ipv4Addr::new(10, 20, 30, 1)]);
        *fake.dns.lock().unwrap() = Some(vec![IpAddr::V4(Ipv4Addr::new(10, 20, 30, 1))]);
        assert!(hold.reread(t0));
        let held = hold.held_plan().expect("still holding");
        assert_eq!(held.lan, vec![roamed]);
        assert_eq!(held.dns, vec![IpAddr::V4(Ipv4Addr::new(10, 20, 30, 1))]);
        assert_eq!(held.tunnels, plan().tunnels, "the tunnels moved with the LAN");
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000], "the old plan, after the new");
        let rows: Vec<(&str, Flow, Verdict)> = vec![
            ("a printer on the new LAN", out(browser(), v4(10, 20, 30, 40), 9100, protocol::TCP, PHYSICAL), Verdict::Permit),
            ("the internet", out(browser(), v4(93, 184, 216, 34), 443, protocol::TCP, PHYSICAL), Verdict::Block),
        ];
        check(&[specs(&held)], &rows);

        assert!(!hold.reread(t0), "read again within REREAD_EVERY");
        assert!(!hold.reread(t0 + REREAD_EVERY), "the same network is nothing to move");
        assert_eq!(fake.installs.lock().unwrap().len(), 2);

        // Roamed again, onto a plan the platform will not take.
        *fake.lan.lock().unwrap() = (vec![Prefix::new(Ipv4Addr::new(172, 16, 5, 0), 24)], Vec::new());
        fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
        let t1 = t0 + REREAD_EVERY * 2;
        assert!(!hold.reread(t1));
        assert!(hold.holding(), "a plan that would not go in cost the hold");
        assert_eq!(hold.held_plan().map(|p| p.lan), Some(vec![roamed]));
        fake.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!hold.reread(t1 + REREAD_EVERY), "tried again before REREAD_AFTER_REFUSAL");
        assert!(hold.reread(t1 + REREAD_AFTER_REFUSAL));

        // Resolvers that cannot be read this time keep the ones held.
        *fake.dns.lock().unwrap() = None;
        *fake.lan.lock().unwrap() = (vec![roamed], Vec::new());
        assert!(hold.reread(t1 + REREAD_AFTER_REFUSAL + REREAD_EVERY));
        assert_eq!(hold.held_plan().map(|p| p.dns), Some(vec![IpAddr::V4(Ipv4Addr::new(10, 20, 30, 1))]));
    }

    /// Thirty-two threads at once engaging, moving and letting go of one
    /// hold, as the engine watch, the owning thread and the pipe can: every
    /// WFP session it opens is closed exactly once, and none is left open.
    /// Then the same with thirty-two holds side by side.
    #[test]
    fn thirty_two_racing_callers_close_each_session_exactly_once() {
        const AT_ONCE: usize = 32;
        for _round in 0..20 {
            let (hold, fake) = held_by_fake();
            hold.set_wanted(true);
            hold.arm(7, plan(), false);
            let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
            let handles: Vec<_> = (0..AT_ONCE)
                .map(|i| {
                    let (hold, start) = (Arc::clone(&hold), Arc::clone(&start));
                    std::thread::spawn(move || {
                        start.wait();
                        match i % 4 {
                            0 => {
                                hold.engage(7, "a drop");
                            }
                            1 => {
                                hold.release(Release::Asked("the app proved a tunnel"));
                            }
                            2 => {
                                hold.replan(Plan { tunnels: vec![i as u64 + 1], ..plan() }, i % 8 == 2);
                            }
                            _ => {
                                hold.release_if_engaged_by(7, hold.engagements());
                            }
                        }
                    })
                })
                .collect();
            for handle in handles {
                handle.join().expect("a caller panicked");
            }
            drop(hold);
            let opened: Vec<isize> = (0..fake.installs.lock().unwrap().len() as isize).map(|i| 5000 + i).collect();
            let mut closed = fake.closed.lock().unwrap().clone();
            closed.sort_unstable();
            assert_eq!(closed, opened, "a session closed twice, or left open");
        }
    }

    /// WireGuard keeps the hold's filters standing in force while it is up;
    /// no other engine's session does -- theirs are confined by the service.
    #[test]
    fn only_wireguard_keeps_its_filters_standing() {
        for (profile, _) in profiles() {
            assert_eq!(stands_while_up(&profile), matches!(profile, ConnectProfile::Wireguard(_)), "{profile:?}");
        }
    }

    /// Armed to stand, the plan goes in at once and stays in force while the
    /// session is up -- said as armed, not as holding -- and its drop is held
    /// with nothing to install: the filters that hold it were in before the
    /// tunnel ended. wireguard.exe's own die with it, and on the VM traffic
    /// left 0.22 s after the kill while a hold went in after the drop. Armed
    /// not to stand, nothing is in force until the drop, as before.
    #[test]
    fn a_standing_sessions_drop_is_held_with_nothing_to_install() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        assert!(hold.arm(7, plan(), true));
        assert_eq!(fake.installs.lock().unwrap().len(), 1, "nothing in force while the tunnel is up");
        assert!(hold.standing_for(7));
        assert!(!hold.holding(), "standing is not holding");
        assert_eq!(hold.report(Some(7)), Some(Report::Armed));
        assert!(hold.engage(7, "wireguard.exe died"));
        assert!(hold.holding());
        assert!(!hold.standing_for(7));
        assert_eq!(fake.installs.lock().unwrap().len(), 1, "a hold installed after the drop: a gap");
        assert!(fake.closed.lock().unwrap().is_empty(), "the filters in force were taken out at the drop");
        assert!(matches!(hold.report(None), Some(Report::Holding { landed: false, .. })));
        // Given up with no tunnel back: closed, nothing left standing.
        assert!(hold.release(Release::Asked("the reconnect gave up")));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);
        assert!(!hold.standing_for(7));

        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        assert!(hold.arm(7, plan(), false));
        assert!(fake.installs.lock().unwrap().is_empty(), "filters standing for a session that keeps none");
        assert!(hold.engage(7, "xray.exe died"));
        assert_eq!(fake.installs.lock().unwrap().len(), 1);
    }

    /// A tunnel a reconnect brings up while it holds is put in the plan as
    /// it is armed, under the same lock, and the hold is said to have landed
    /// -- never over the dropped session itself. Letting go then leaves the
    /// filters standing for the new tunnel, in force as they were, never
    /// taken out and put back. A release with nothing held leaves them;
    /// disarming takes them out.
    #[test]
    fn letting_go_over_a_standing_tunnel_that_came_up_leaves_its_filters_in_force() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        hold.engage(7, "wireguard.exe died");
        assert!(
            matches!(hold.report(Some(7)), Some(Report::Holding { landed: false, .. })),
            "the dropped session, still in the slot, is no tunnel landed"
        );
        let next = Plan { tunnels: vec![TUNNEL, 0x0035_0000_0300_0000], ..plan() };
        assert!(hold.arm(8, next.clone(), true));
        assert_eq!(fake.installs.lock().unwrap().clone(), vec![plan(), next.clone()], "the new tunnel was not put in the plan");
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000], "the old plan, after the new");
        assert!(hold.holding());
        assert!(matches!(hold.report(Some(8)), Some(Report::Holding { landed: true, .. })));
        assert!(hold.release(Release::Asked("the app let go of it")));
        assert!(!hold.holding());
        assert!(hold.standing_for(8), "the filters for the tunnel that came up were taken out");
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000], "taken out and put back: a moment with neither");
        assert_eq!(hold.report(Some(8)), Some(Report::Armed));
        assert!(!hold.release(Release::Asked("the app let go of it")), "a release with nothing held");
        assert!(hold.standing_for(8));
        hold.disarm();
        assert!(!hold.standing_for(8));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000, 5001]);
    }

    /// The setting off takes standing filters out with any hold; arming a
    /// session that keeps none takes out what stood for the last; arming
    /// one that keeps its own puts the new in before the old is closed.
    #[test]
    fn turning_it_off_or_arming_another_session_settles_standing_filters() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        assert!(hold.turn_off());
        assert!(!hold.standing_for(7));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);

        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        hold.arm(8, plan(), false);
        assert!(!hold.standing_for(7) && !hold.standing_for(8));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);
        hold.arm(9, plan(), true);
        hold.arm(10, Plan { tunnels: vec![0x0035_0000_0400_0000], ..plan() }, true);
        assert!(hold.standing_for(10));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000, 5001], "the old ones, each after its successor");
    }

    /// Standing filters that will not go in leave the session armed as any
    /// other: its drop is still held, from the report.
    #[test]
    fn standing_filters_that_will_not_go_in_leave_the_drop_held_from_the_report() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(hold.arm(7, plan(), true));
        assert!(!hold.standing_for(7));
        assert!(hold.armed_for(7));
        fake.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(hold.engage(7, "wireguard.exe died"));
        assert_eq!(fake.installs.lock().unwrap().len(), 1);
    }

    /// Filters standing for a session that is no longer up: none up -- it
    /// ended and nothing said so -- they hold its drop, said, and the
    /// backstops reach it; another up, they are taken out rather than block
    /// its tunnel. With the one they stand for up, nothing changes.
    #[test]
    fn standing_filters_outliving_their_session_hold_its_drop_or_go() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        assert!(!hold.settle_standing(Some(7)));
        assert!(hold.standing_for(7));
        assert!(hold.settle_standing(None));
        assert!(hold.holding());
        assert!(matches!(hold.report(None), Some(Report::Holding { .. })));
        assert!(hold.let_go_if_unfollowed(false, Duration::ZERO), "the backstop does not reach it");
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);

        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        assert!(hold.settle_standing(Some(9)));
        assert!(!hold.holding() && !hold.standing_for(7));
        assert_eq!(fake.closed.lock().unwrap().clone(), vec![5000]);
    }

    /// A drop report the engine contradicts lets go of the hold it began --
    /// but not of one a newer drop has reached since the report was taken
    /// back: that is the engine dying a moment after it was found alive,
    /// and letting go would leave its drop unheld. Filters standing for the
    /// session stay standing.
    #[test]
    fn a_retraction_lets_go_only_of_a_hold_no_drop_has_reached_since() {
        let (hold, _fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        hold.engage(7, "a report");
        let seen = hold.engagements();
        hold.engage(7, "the new watch's report: it died after all");
        assert!(!hold.release_if_engaged_by(7, seen), "a real drop's hold let go of");
        assert!(hold.holding());
        assert!(hold.release_if_engaged_by(7, hold.engagements()));
        assert!(!hold.holding());

        let (hold, fake) = held_by_fake();
        *fake.lan.lock().unwrap() = (plan().lan, plan().dhcp_servers);
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        hold.engage(7, "the tunnel service stopped");
        assert!(hold.release_if_engaged_by(7, hold.engagements()));
        assert!(hold.standing_for(7), "the filters standing for a tunnel that runs were taken out");
        assert!(fake.closed.lock().unwrap().is_empty());
    }

    /// Thirty-two threads at once arming to stand, engaging, letting go,
    /// settling and disarming one hold, as the watches, the owning thread
    /// and the pipe can: every WFP session it opens is closed exactly once,
    /// and none is left open.
    #[test]
    fn thirty_two_racing_callers_with_standing_filters_close_each_session_exactly_once() {
        const AT_ONCE: usize = 32;
        for _round in 0..20 {
            let (hold, fake) = held_by_fake();
            hold.set_wanted(true);
            hold.arm(7, plan(), true);
            let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
            let handles: Vec<_> = (0..AT_ONCE)
                .map(|i| {
                    let (hold, start) = (Arc::clone(&hold), Arc::clone(&start));
                    std::thread::spawn(move || {
                        start.wait();
                        match i % 6 {
                            0 => {
                                hold.engage(7, "wireguard.exe died");
                            }
                            1 => {
                                hold.release(Release::Asked("the app let go of it"));
                            }
                            2 => {
                                hold.arm(8 + (i as u64 % 3), Plan { tunnels: vec![i as u64 + 1], ..plan() }, i % 4 == 2);
                            }
                            3 => {
                                hold.settle_standing(if i % 12 == 3 { None } else { Some(7) });
                            }
                            4 => {
                                hold.release_if_engaged_by(7, hold.engagements());
                            }
                            _ => {
                                hold.disarm();
                            }
                        }
                    })
                })
                .collect();
            for handle in handles {
                handle.join().expect("a caller panicked");
            }
            drop(hold);
            let opened: Vec<isize> = (0..fake.installs.lock().unwrap().len() as isize).map(|i| 5000 + i).collect();
            let mut closed = fake.closed.lock().unwrap().clone();
            closed.sort_unstable();
            assert_eq!(closed, opened, "a session closed twice, or left open");
        }
    }

    /// The same session armed again -- the setting said again as a
    /// reconnect begins, with none of the connect's servers to hand -- is
    /// never armed narrower: standing under a WireGuard tunnel, a plan
    /// without its server would refuse it. Another session's is its own.
    #[test]
    fn arming_the_same_session_again_never_narrows_its_plan() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), true);
        hold.arm(7, Plan { nodes: Vec::new(), ..plan() }, true);
        assert_eq!(fake.installs.lock().unwrap().len(), 1, "the same plan put in again");
        assert_eq!(hold.held_plan().map(|p| p.nodes), Some(plan().nodes), "the session's servers were dropped");
        hold.arm(8, Plan { nodes: Vec::new(), ..plan() }, true);
        assert!(hold.held_plan().is_some_and(|p| p.nodes.is_empty()));
        assert!(hold.standing_for(8));
    }

    /// The session whose drop it holds, armed again before it is taken down
    /// -- the setting said again as the reconnect begins, with that session
    /// still in the slot -- leaves the hold as it is: nothing moved onto a
    /// tunnel that is gone, nothing let go of. `held_for` names that session,
    /// and no other.
    #[test]
    fn arming_the_dropped_session_again_leaves_the_hold_as_it_is() {
        let (hold, fake) = held_by_fake();
        hold.set_wanted(true);
        hold.arm(7, plan(), false);
        assert!(!hold.held_for(7), "armed is not held for");
        hold.engage(7, "the tunnel adapter is gone");
        assert!(hold.held_for(7));
        assert!(!hold.held_for(8));
        assert!(hold.arm(7, Plan { tunnels: Vec::new(), ..plan() }, true));
        assert!(hold.holding(), "the hold was let go of");
        assert_eq!(fake.installs.lock().unwrap().clone(), vec![plan()], "the hold was moved onto a session whose tunnel is gone");
        assert!(fake.closed.lock().unwrap().is_empty());
        assert!(matches!(hold.report(Some(7)), Some(Report::Holding { landed: false, .. })));
        // A tunnel that came up after the drop is moved onto, as ever.
        let next = Plan { tunnels: vec![TUNNEL, 0x0035_0000_0300_0000], ..plan() };
        assert!(hold.arm(8, next.clone(), false));
        assert_eq!(hold.held_plan(), Some(next));
        assert!(!hold.held_for(8), "the tunnel that came up is not the drop held for");
    }

    /// The hold's filters against the real filtering engine, inside a
    /// transaction that is then aborted: WFP checks every filter as it is
    /// added, so a structure it would refuse is found here rather than on
    /// a customer's drop, where it would read as "could not hold" -- or,
    /// standing under a WireGuard tunnel, as filters that never went in.
    /// Nothing stays in force.
    ///
    /// Never skipped silently. An engine that will not open -- no
    /// administrator rights -- fails it, unless whoever runs it has said by
    /// name that they cannot run it elevated (`NEOXIFY_SKIP_WFP_TESTS=1`),
    /// which CI never may: GitHub's Windows runners are administrators, and
    /// a skip there would leave nothing having checked the hold against the
    /// real platform. What it cannot show is that traffic stops -- that is
    /// the VM's capture.
    #[test]
    fn wfp_accepts_the_hold_then_aborts() {
        let exe = std::env::current_exe().expect("the test binary");
        let lo = super::super::traffic::luid_of_index(1).unwrap_or(TUNNEL);
        let real = Plan::new(
            vec![lo],
            vec![exe],
            vec![node(), Ipv4Addr::new(198, 51, 100, 9)],
            vec![Prefix::new(Ipv4Addr::new(192, 168, 1, 0), 24), Prefix::new(Ipv4Addr::new(10, 0, 2, 0), 24)],
            vec![Ipv4Addr::new(10, 0, 2, 2)],
        )
        .with_dns(resolvers());
        let specs = specs(&real);
        match confinement::add_then_abort(&specs, &HOLD_KEYS) {
            None => {
                let on_ci = std::env::var_os("GITHUB_ACTIONS").is_some();
                let skipped_on_purpose = std::env::var("NEOXIFY_SKIP_WFP_TESTS").is_ok_and(|v| v == "1");
                assert!(
                    skipped_on_purpose && !on_ci,
                    "the filtering engine would not open, so the hold was never checked against it: run the tests as \
                     administrator (or, off CI, set NEOXIFY_SKIP_WFP_TESTS=1 to skip this on purpose)"
                );
                eprintln!("SKIPPED ON PURPOSE (NEOXIFY_SKIP_WFP_TESTS=1): the hold was not checked against the filtering platform");
            }
            Some(Ok(blocks)) => assert_eq!(blocks, 4, "one block per layer"),
            Some(Err(e)) => panic!("the Windows Filtering Platform rejected the hold: {e}"),
        }
    }
}
