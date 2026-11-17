//! Everything the helper asks of the machine, behind one trait.
//!
//! The daemon's own logic -- framing, who may call, the order of a
//! teardown, cancellation, noticing a dead engine, the reconnect hold's
//! state, Custom mode's bookkeeping, what a repair reports -- is tested
//! without root and without a tunnel by putting a fake behind this.
//! [`System`] is the real thing: the `tunnel` and `netguard` crates,
//! called exactly as their contracts declare, and the helper's own looks
//! at the machine (`machine`).

use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::time::Duration;

use neoconnect_ipc::{ConnectProfile, ExitProfile};
use neoxify_netguard::{Applied, Cidr4, Held, HoldPlan, Plan, Removal};
use neoxify_tunnel::{Dirs, Limits, Problem, Running, Shape, Tunnel};

use crate::machine::{self, Survey};

pub trait Backend: Send + Sync + 'static {
    fn connect(
        &self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        shape: &Shape,
        dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem>;
    fn way_out(&self, profile: &ConnectProfile) -> Result<(), Problem>;
    fn sweep_leftovers(&self, dirs: &Dirs) -> Vec<String>;
    fn visible_tunnel(&self) -> Option<String>;
    fn guard_apply(&self, plan: &Plan) -> Result<Applied, neoxify_netguard::Error>;
    fn guard_remove(&self) -> Result<Removal, neoxify_netguard::Error>;
    /// What of the table is in the kernel now, or `None` with no table.
    fn guard_in_force(&self) -> Result<Option<Applied>, neoxify_netguard::Error>;
    fn lan_prefixes(&self, exclude_ifaces: &[&str]) -> Vec<Cidr4>;

    /// The reconnect hold: the same table, other contents (`netguard`).
    fn hold_apply(&self, plan: &HoldPlan) -> Result<Held, neoxify_netguard::Error>;
    fn machine_resolvers(&self) -> Vec<IpAddr>;
    /// Moves the app's process into the group the hold lets through.
    fn adopt_app(&self, pid: u32) -> Result<String, String>;
    /// A server's name as one IPv4 address, for a connect dialled under
    /// the hold, whose plan has to name the server before the engine can
    /// reach it.
    fn resolve_ipv4(&self, host: &str) -> Option<Ipv4Addr>;

    /// Custom mode's list of programs, and its rule for an app identity.
    fn running_processes(&self, uid: u32) -> Vec<Running>;
    fn valid_app(&self, app: &str) -> Result<(), String>;

    /// What of ours the machine shows, for Repair and Diagnostics.
    fn survey(&self, dirs: &Dirs) -> Survey;
    /// Deletes Custom mode's own nftables table, if it stands. Returns
    /// whether there was one.
    fn remove_split_table(&self) -> Result<bool, String>;
    /// Removes our control groups that hold no process. Returns how many.
    fn remove_empty_groups(&self) -> Result<u32, String>;
}

/// The machine.
pub struct System;

/// How long a name lookup for the hold's plan may take. A connect under
/// the hold is waiting on it, and a name that does not resolve in this
/// long will not resolve for the engine either.
const RESOLVE_WAIT: Duration = Duration::from_secs(5);

impl Backend for System {
    fn connect(
        &self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        shape: &Shape,
        dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem> {
        neoxify_tunnel::connect(profile, exits, known_nodes, shape, dirs, limits)
    }

    fn way_out(&self, profile: &ConnectProfile) -> Result<(), Problem> {
        neoxify_tunnel::way_out(profile)
    }

    fn sweep_leftovers(&self, dirs: &Dirs) -> Vec<String> {
        neoxify_tunnel::sweep_leftovers(dirs)
    }

    fn visible_tunnel(&self) -> Option<String> {
        neoxify_tunnel::visible_tunnel()
    }

    fn guard_apply(&self, plan: &Plan) -> Result<Applied, neoxify_netguard::Error> {
        neoxify_netguard::apply(plan)
    }

    fn guard_remove(&self) -> Result<Removal, neoxify_netguard::Error> {
        neoxify_netguard::remove()
    }

    fn guard_in_force(&self) -> Result<Option<Applied>, neoxify_netguard::Error> {
        neoxify_netguard::in_force()
    }

    fn lan_prefixes(&self, exclude_ifaces: &[&str]) -> Vec<Cidr4> {
        neoxify_netguard::lan_prefixes(exclude_ifaces)
    }

    fn hold_apply(&self, plan: &HoldPlan) -> Result<Held, neoxify_netguard::Error> {
        neoxify_netguard::apply_hold(plan)
    }

    fn machine_resolvers(&self) -> Vec<IpAddr> {
        neoxify_netguard::machine_resolvers()
    }

    fn adopt_app(&self, pid: u32) -> Result<String, String> {
        neoxify_tunnel::adopt_app(pid)
    }

    fn resolve_ipv4(&self, host: &str) -> Option<Ipv4Addr> {
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            return Some(ip);
        }
        // getaddrinfo has no timeout of its own, so it runs on a thread
        // that is left behind if it takes too long.
        let host = host.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let found = (host.as_str(), 443).to_socket_addrs().ok().and_then(|mut all| {
                all.find_map(|a| match a.ip() {
                    IpAddr::V4(v4) => Some(v4),
                    IpAddr::V6(_) => None,
                })
            });
            let _ = tx.send(found);
        });
        rx.recv_timeout(RESOLVE_WAIT).ok().flatten()
    }

    fn running_processes(&self, uid: u32) -> Vec<Running> {
        neoxify_tunnel::running_processes(uid)
    }

    fn valid_app(&self, app: &str) -> Result<(), String> {
        neoxify_tunnel::valid_app(app)
    }

    fn survey(&self, dirs: &Dirs) -> Survey {
        machine::survey(dirs)
    }

    fn remove_split_table(&self) -> Result<bool, String> {
        machine::remove_split_table()
    }

    fn remove_empty_groups(&self) -> Result<u32, String> {
        machine::remove_empty_groups()
    }
}

/// The tunnel crate's description of an engine connection, in netguard's
/// terms. Two identical types in two crates, kept apart so that neither
/// crate depends on the other.
pub fn transport(t: &neoxify_tunnel::Transport) -> neoxify_netguard::Transport {
    neoxify_netguard::Transport {
        ip: t.ip,
        port: t.port,
        proto: match t.proto {
            neoxify_tunnel::Proto::Tcp => neoxify_netguard::Proto::Tcp,
            neoxify_tunnel::Proto::Udp => neoxify_netguard::Proto::Udp,
        },
    }
}
