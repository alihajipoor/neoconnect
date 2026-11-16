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
    /// `/run/neoxify`.
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
/// host routes may be purged before connecting.
pub fn connect(
    _profile: &ConnectProfile,
    _exits: &[ExitProfile],
    _known_nodes: &[String],
    _dirs: &Dirs,
    _limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    unimplemented!("tunnel::connect")
}

/// Is there a way out to the internet for this profile's server right
/// now? Answers from the routing table. Never dials anything.
pub fn way_out(_profile: &ConnectProfile) -> Result<(), Problem> {
    unimplemented!("tunnel::way_out")
}

/// Clean up after a helper that died: orphaned engines (matched by
/// their full program path only), our links, our routes and rules, DNS
/// we pointed at ourselves, and whatever the ledger says is still owed.
/// Returns one plain line per thing it removed or could not remove.
pub fn sweep_leftovers(_dirs: &Dirs) -> Vec<String> {
    unimplemented!("tunnel::sweep_leftovers")
}

/// The name of one of our tunnel interfaces if the kernel shows one up
/// right now. For answering a status question when the session's owner
/// is busy: what the machine shows, not what we remember.
pub fn visible_tunnel() -> Option<String> {
    unimplemented!("tunnel::visible_tunnel")
}
