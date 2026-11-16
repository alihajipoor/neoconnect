//! Everything the helper asks of the machine, behind one trait.
//!
//! The daemon's own logic -- framing, who may call, the order of a
//! teardown, cancellation, noticing a dead engine -- is tested without
//! root and without a tunnel by putting a fake behind this. [`System`] is
//! the real thing: the `tunnel` and `netguard` crates, called exactly as
//! their contracts declare.

use neoconnect_ipc::{ConnectProfile, ExitProfile};
use neoxify_netguard::{Applied, Cidr4, Plan, Removal};
use neoxify_tunnel::{Dirs, Limits, Problem, Tunnel};

pub trait Backend: Send + Sync + 'static {
    fn connect(
        &self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem>;
    fn way_out(&self, profile: &ConnectProfile) -> Result<(), Problem>;
    fn sweep_leftovers(&self, dirs: &Dirs) -> Vec<String>;
    fn visible_tunnel(&self) -> Option<String>;
    fn guard_apply(&self, plan: &Plan) -> Result<Applied, neoxify_netguard::Error>;
    fn guard_remove(&self) -> Result<Removal, neoxify_netguard::Error>;
    fn lan_prefixes(&self, exclude_ifaces: &[&str]) -> Vec<Cidr4>;
}

/// The machine.
pub struct System;

impl Backend for System {
    fn connect(
        &self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem> {
        neoxify_tunnel::connect(profile, exits, known_nodes, dirs, limits)
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

    fn lan_prefixes(&self, exclude_ifaces: &[&str]) -> Vec<Cidr4> {
        neoxify_netguard::lan_prefixes(exclude_ifaces)
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
