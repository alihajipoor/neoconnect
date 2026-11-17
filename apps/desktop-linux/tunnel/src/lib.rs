//! Everything on Linux that makes a tunnel carry traffic: the engines,
//! the routes and DNS.
//!
//! The helper daemon (`../helper`) owns the wire protocol and the
//! session's lifecycle and calls only what is declared in this file. The
//! public names and signatures below are the contract between the two
//! and are fixed; everything behind them is this crate's own business.
//!
//! Leak protection is not here. It is `../netguard`, and the helper puts
//! it in force after [`connect`] returns, from what [`Up`] says.

use std::fmt;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

// The shared plumbing every engine uses, each in its own module so the
// WireGuard and OpenVPN engines can be added beside `xray` without
// touching it: `cmd` runs system programs within a budget, `ledger`
// records what is owed back to the machine, `routes`, `link` and `dns`
// change the machine and undo it, `process` starts and finds engines,
// `cleanup` undoes the ledger and sweeps after a crash. Custom mode is
// `sorting` (which programs are chosen, and their control group) and
// `split` (routing that group its own way).
mod cleanup;
mod cmd;
mod dns;
mod files;
mod ikev2;
mod ledger;
mod link;
mod openvpn;
mod process;
mod routes;
mod sorting;
mod split;
mod wireguard;
mod xray;

pub use neoconnect_ipc::{ConnectProfile, ExitProfile, TunnelHealth};

/// Where things live. The helper fills this in once at start; nothing in
/// a request can change it, so a request can never name a program.
#[derive(Debug, Clone)]
pub struct Dirs {
    /// The directory holding the bundled engine (`xray`). Root-owned.
    pub bin: PathBuf,
    /// Root-only state that must survive a crash: the ledger of what is
    /// owed back to the machine. `/var/lib/neoxify`.
    pub state: PathBuf,
    /// Root-only scratch for configs and engine logs, gone at reboot.
    /// `/run/neoxify/private` (the socket's directory above it has to be
    /// readable by the app, so the private part is one level down).
    pub run: PathBuf,
}

/// How long a call may take and how it is told to give up early.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Nothing may still be working after this moment.
    pub deadline: Instant,
    /// Set by the helper when the customer disconnects mid-connect.
    /// Poll it at least every 100 ms in any wait.
    pub cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Proto {
    Tcp,
    Udp,
}

/// One connection the engine itself makes to a server, outside the
/// tunnel. The helper hands these to netguard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Transport {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub proto: Proto,
}

/// How much of the machine's traffic the tunnel takes.
///
/// `Full` is the ordinary connection. The other two are Custom mode,
/// which on Linux sorts programs by control group: the programs named
/// here (and everything they start) are moved into a group of ours, and
/// the kernel routes that group's packets one way and everything else's
/// the other. Each entry is an app identity that has passed
/// [`valid_app`]; in practice the full path of a program.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Shape {
    /// Everything goes through the tunnel.
    #[default]
    Full,
    /// Only the named apps go through the tunnel; everything else
    /// leaves the machine's own way. Lookups go through the tunnel
    /// whoever makes them, as on Windows.
    OnlySelected(Vec<String>),
    /// Everything goes through the tunnel except the named apps.
    AllExcept(Vec<String>),
}

impl Shape {
    pub fn is_split(&self) -> bool {
        !matches!(self, Shape::Full)
    }
}

/// Custom mode as the machine shows it now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SplitState {
    /// The sorting is really in the kernel (the rules and the routing
    /// table were read back), not merely asked for.
    pub active: bool,
    /// What is wrong, as a plain English sentence and the kind the app
    /// sorts it into, or `None`.
    pub problem: Option<(String, neoconnect_ipc::SplitTunnelProblemCode)>,
    /// Apps that were already running when they were chosen: their open
    /// connections stay where they were until the app is restarted.
    /// Bare file names, as Windows reports them.
    pub restart_needed: Vec<String>,
}

/// One running program a customer could choose for Custom mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Running {
    pub pid: u32,
    /// The app identity to send back in a [`Shape`]: what [`valid_app`]
    /// accepts and what the sorting matches on.
    pub app: String,
    /// The program's own short name (`comm`), for a list.
    pub name: String,
}

/// What came up.
#[derive(Debug, Clone)]
pub struct Up {
    /// The protocol name the app expects back in its status, exactly as
    /// the Windows service reports it for the same profile.
    pub protocol: String,
    /// The interface(s) that are the tunnel.
    pub ifaces: Vec<String>,
    /// The engine's own connections to its server(s).
    pub transports: Vec<Transport>,
    /// The mark the engine puts on its own packets, when it uses one.
    pub fwmark: Option<u32>,
    /// False when the machine's DNS could not be pointed at the tunnel.
    /// The tunnel stays up and the app says so; this is never an error.
    pub dns_protected: bool,
}

/// Why a tunnel did not come up. `Display` gives the English sentence
/// the app sorts into a kind (`src/lib/connection-errors.ts` in the
/// shared interface), so the wording is part of the contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// No way out to the internet at all. Displays as
    /// `neoconnect_ipc::NO_NETWORK`, which the app matches exactly.
    NoNetwork,
    /// A program the tunnel needs is not installed; names it.
    EngineMissing(String),
    /// The helper asked us to stop.
    Cancelled,
    /// The server did not answer in time; says what was waited for.
    TimedOut(String),
    /// Anything else, in plain words.
    Failed(String),
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::NoNetwork => f.write_str(neoconnect_ipc::NO_NETWORK),
            Problem::EngineMissing(what) => write!(f, "{what} is missing from the install"),
            Problem::Cancelled => f.write_str("the connection attempt was cancelled"),
            Problem::TimedOut(what) => write!(f, "timed out waiting for {what}"),
            Problem::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for Problem {}

/// A tunnel that is up. Dropping it without calling the two stops must
/// still leave the machine clean (implement `Drop` as hard + finish).
pub trait Tunnel: Send {
    fn up(&self) -> &Up;

    /// Is it carrying? `Down` only when that is verified (the engine
    /// process is gone, the link is gone); a failed look is `Unknown`.
    fn health(&mut self) -> TunnelHealth;

    /// Bytes received and sent on the tunnel interface since it came up,
    /// or `None` when they cannot be read. Never a made-up zero.
    fn counters(&self) -> Option<(u64, u64)>;

    /// Whether the machine's lookups still go where the connect pointed
    /// them. Read afresh rather than remembered, because something else
    /// can undo it mid-session -- a DHCP client rewriting
    /// `/etc/resolv.conf` at a lease renewal -- and the app tells the
    /// customer their DNS is protected on this word.
    fn dns_protected(&self) -> bool {
        self.up().dns_protected
    }

    /// The shape in force. An engine that cannot do Custom mode only
    /// ever reports `Full`.
    fn shape(&self) -> Shape {
        Shape::Full
    }

    /// Change the shape without dropping the session: the engine stays
    /// up and only the routes, rules and sorted programs change. On an
    /// error the earlier shape is still in force.
    fn reshape(&mut self, shape: &Shape, limits: &Limits) -> Result<(), Problem> {
        let _ = limits;
        if shape.is_split() {
            return Err(Problem::Failed("Custom mode is not available with this protocol on Linux".into()));
        }
        Ok(())
    }

    /// Custom mode as the kernel shows it, or `None` when the shape is
    /// `Full`.
    fn split(&self) -> Option<SplitState> {
        None
    }

    /// Does a connection made on the tunnel interface itself reach the
    /// internet? This is how Custom mode is checked, where the app's own
    /// traffic may not be in the tunnel at all. Never dials outside it.
    fn probe(&self, limits: &Limits) -> Result<(), String> {
        let _ = limits;
        Err("this tunnel cannot be probed".into())
    }

    /// The fast half of teardown: stop the engine and take the routes
    /// out, so traffic is back on the machine's own network within
    /// milliseconds. Must not wait on anything slow. Safe to call twice.
    fn hard_stop(&mut self);

    /// The thorough half: restore DNS, delete links, settle the ledger.
    /// May take seconds. Safe to call twice, and without `hard_stop`.
    fn finish_stop(&mut self);
}

/// Bring a tunnel up for a profile and return once it is ready to carry
/// traffic: engine running, interface addressed, routes in, DNS pointed
/// at it. On any failure everything already done is undone first.
///
/// `exits` are extra Xray exits to run beside the main one (empty for
/// every other protocol); `known_nodes` are server addresses whose stale
/// host routes may be purged before connecting; `shape` says how much of
/// the machine's traffic the tunnel is to take.
pub fn connect(
    profile: &ConnectProfile,
    exits: &[ExitProfile],
    known_nodes: &[String],
    shape: &Shape,
    dirs: &Dirs,
    limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    match profile {
        ConnectProfile::XrayVlessReality(_)
        | ConnectProfile::XrayVlessTls(_)
        | ConnectProfile::XrayTrojan(_)
        | ConnectProfile::Shadowsocks(_) => xray::connect(profile, exits, known_nodes, shape, dirs, limits),
        ConnectProfile::Wireguard(_) => wireguard::connect(profile, known_nodes, shape, dirs, limits),
        ConnectProfile::Openvpn(_) => openvpn::connect(profile, known_nodes, shape, dirs, limits),
        ConnectProfile::Ikev2(_) => ikev2::connect(profile, known_nodes, shape, dirs, limits),
    }
}

/// Is this app identity one the sorting can act on? Checked on every
/// identity in a request before anything uses it, because it is matched
/// against what root reads from `/proc` and written into nothing else.
pub fn valid_app(app: &str) -> Result<(), String> {
    sorting::valid_app(app)
}

/// The running programs of one user that could be chosen for Custom
/// mode, one entry per process. The app turns these into names and
/// icons; this side only says what is running.
pub fn running_processes(uid: u32) -> Vec<Running> {
    sorting::running(uid)
}

/// Put a process and its own helper processes (its web view's) into the
/// control group whose sockets the reconnect hold lets through, and return
/// the group's path relative to the cgroup root (what
/// `netguard::HoldPlan::app_group` takes). The helper calls this for the
/// app itself when a hold is wanted. Programs started later by the app
/// inherit the group, which is why the app opens links in a scope of its own.
pub fn adopt_app(pid: u32) -> Result<String, String> {
    sorting::adopt_app(pid)
}

/// The user a session belongs to: Custom mode sorts only that user's
/// programs. `None` or root sorts every matching program, for root's own
/// tools.
pub fn set_session_owner(uid: Option<u32>) {
    sorting::set_owner(uid)
}

/// Is there a way out to the internet for this profile's server right
/// now? Answers from the routing table. Never dials anything.
pub fn way_out(profile: &ConnectProfile) -> Result<(), Problem> {
    // The server's own address when the profile names it by one (as nodes
    // are registered); otherwise any public address -- the question is
    // whether there is a way out at all, and a name is not looked up.
    let probe = server_literal(profile).unwrap_or(Ipv4Addr::new(1, 1, 1, 1));
    match routes::way_out_to(probe) {
        Ok(false) => Err(Problem::NoNetwork),
        // Found one, or could not read the table: a table that could not
        // be read says nothing, and the connect goes on to find out.
        Ok(true) | Err(_) => Ok(()),
    }
}

/// The server's address when the profile names it by one, without
/// looking anything up.
fn server_literal(profile: &ConnectProfile) -> Option<Ipv4Addr> {
    let host_of = |endpoint: &str| endpoint.rsplit_once(':').map(|(host, _)| host.to_string());
    let host = match profile {
        ConnectProfile::Wireguard(p) => host_of(&p.endpoint),
        ConnectProfile::Openvpn(p) => host_of(&p.endpoint),
        ConnectProfile::XrayVlessReality(p) => Some(p.host.clone()),
        ConnectProfile::XrayVlessTls(p) => Some(p.host.clone()),
        ConnectProfile::XrayTrojan(p) => Some(p.host.clone()),
        ConnectProfile::Shadowsocks(p) => Some(p.host.clone()),
        ConnectProfile::Ikev2(p) => Some(p.server.clone()),
    };
    host.and_then(|host| host.parse().ok())
}

/// Clean up after a helper that died: orphaned engines (matched by
/// their full program path only), our links, our routes and rules, DNS
/// we pointed at ourselves, and whatever the ledger says is still owed.
/// Returns one plain line per thing it removed or could not remove.
pub fn sweep_leftovers(dirs: &Dirs) -> Vec<String> {
    cleanup::sweep(dirs)
}

/// The name of one of our tunnel interfaces if the kernel shows one up
/// right now. For answering a status question when the session's owner
/// is busy: what the machine shows, not what we remember.
pub fn visible_tunnel() -> Option<String> {
    link::OURS
        .iter()
        .find(|name| link::is_up(name) == Some(true))
        .map(|name| name.to_string())
        // IKEv2's TUN has no fixed name; it is found from the engine.
        .or_else(ikev2::visible_link)
}
