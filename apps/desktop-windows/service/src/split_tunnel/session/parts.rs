//! What a session is assembled from, one method per step of the
//! bring-up.
//!
//! A trait for the reason `lifecycle::teardown::HardStopSteps` is one:
//! so the order things are acquired and released in can be tested
//! without Windows. Nearly every step here is a system mutation that a
//! unit test cannot make -- a route needs a tunnel adapter, the
//! allowance needs the firewall, the IPv6 block needs the filtering
//! engine and interception needs the driver -- and the order they are
//! taken down in is the part of `stop` that had a comment explaining it
//! at every step and nothing checking any of it.
//!
//! [`Windows`] is the real thing and the only implementation outside
//! the tests. Each of its methods is the call the bring-up used to make
//! directly, with the same arguments and the same error text.
//!
//! Every associated type is held by `Session` for its `Drop`, which is
//! its teardown. None of them has a `stop` for anybody to remember.

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::adapters::{self, Adapter};
use crate::engines::ipv6_block::SelectedAppsIpv6Block;
use crate::engines::routing::InstalledRoutes;
use crate::lifecycle::budget::Limits;
use crate::split_tunnel::net::pin::TunnelInterface;
use crate::split_tunnel::policy::Selection;
use crate::split_tunnel::{firewall, flows, intercept, relay, tables, SharedSelection};

use super::convergence::Convergence;
use super::logger::{Audit, Logger};
use super::tunnel;
use super::watchdog::Watchdog;

/// The steps of a bring-up, in the order `Session::start` takes them.
pub(in crate::split_tunnel) trait Parts {
    /// The passive route through the tunnel. Removed when dropped.
    type Route;
    /// The local relays a redirected connection is handed to. Stopped,
    /// with every connection they carry closed, when dropped.
    type Relays: Relaying;
    /// The inbound firewall rule the relays need. Deleted when dropped.
    type Allowance;
    /// The per-app IPv6 block. Removed when dropped.
    type Ipv6Block;
    /// The packet loop. Stopped and joined when dropped.
    type Interception: Intercepting;
    /// The thread writing the counters. Joined when dropped.
    type Logger;
    /// The activation reset's rescans. Joined when dropped.
    type Convergence;
    /// The backstop. Joined when dropped.
    type Watchdog;

    /// The tunnel adapter, once it exists and has an address.
    fn wait_for_tunnel(&self, adapter_name: &str, limits: &Limits) -> Result<Adapter, String>;

    /// The adapter the machine's own traffic leaves on.
    fn physical_uplink(&self, tunnel_adapter: &str) -> Result<Adapter, String>;

    fn install_route(
        &self,
        tunnel_address: Ipv4Addr,
        tunnel_index: u32,
        tunnel: &TunnelInterface,
        log_path: &Path,
        limits: &Limits,
    ) -> Result<Self::Route, String>;

    fn start_relays(
        &self,
        nat: Arc<flows::Nat>,
        tunnel: Arc<TunnelInterface>,
        stats: Arc<intercept::Stats>,
        exits: Arc<relay::ExitRelays>,
    ) -> io::Result<Self::Relays>;

    fn allow(
        &self,
        application_source: Ipv4Addr,
        relay_source: Ipv4Addr,
        tcp_port: u16,
        udp_port: u16,
    ) -> Result<Self::Allowance, String>;

    /// Proof that the relay answers, before anything is sent to it.
    fn wait_until_reachable(&self, local: Ipv4Addr, tcp_port: u16, limits: &Limits) -> Result<(), String>;

    /// `None` is not a failure -- see `install_ipv6_app_block`.
    fn block_ipv6(&self, selection: &SharedSelection, log_dir: &Path, log_path: &Path) -> Option<Self::Ipv6Block>;

    fn intercept(
        &self,
        redirect: intercept::Redirect,
        nat: Arc<flows::Nat>,
        selection: SharedSelection,
        stats: Arc<intercept::Stats>,
    ) -> Result<Self::Interception, String>;

    fn start_logger(&self, path: PathBuf, stats: Arc<intercept::Stats>, header: String, audit: Audit) -> Self::Logger;

    /// The first pass of the activation reset, made inline.
    fn reset_connections(
        &self,
        selection: &Selection,
        node: Ipv4Addr,
        own_images: &[String],
        nat: &flows::Nat,
    ) -> tables::ResetOutcome;

    fn converge(
        &self,
        selection: SharedSelection,
        path: PathBuf,
        node: Ipv4Addr,
        own_images: Vec<String>,
        nat: Arc<flows::Nat>,
        closed_already: usize,
    ) -> Self::Convergence;

    #[allow(clippy::too_many_arguments)]
    fn watch(
        &self,
        adapter_name: String,
        index: u32,
        address: Ipv4Addr,
        tunnel: Arc<TunnelInterface>,
        interception: &Self::Interception,
        log_path: PathBuf,
        tripped: Arc<AtomicBool>,
    ) -> Self::Watchdog;
}

/// What the bring-up reads back off the relays it started.
pub(in crate::split_tunnel) trait Relaying {
    /// The TCP and UDP ports, chosen by the OS.
    fn ports(&self) -> (u16, u16);
    fn own_sockets(&self) -> Arc<relay::OwnSockets>;
}

/// What a running session reads off its packet loop.
pub(in crate::split_tunnel) trait Intercepting {
    /// The counters the loop and the relays count into -- the same
    /// table the bring-up created and handed to both.
    fn stats(&self) -> &Arc<intercept::Stats>;
}

impl Relaying for relay::Relays {
    fn ports(&self) -> (u16, u16) {
        (self.tcp_port, self.udp_port)
    }

    fn own_sockets(&self) -> Arc<relay::OwnSockets> {
        self.own_sockets.clone()
    }
}

impl Intercepting for intercept::Running {
    fn stats(&self) -> &Arc<intercept::Stats> {
        &self.stats
    }
}

/// The real thing.
pub(in crate::split_tunnel) struct Windows;

impl Parts for Windows {
    type Route = InstalledRoutes;
    type Relays = relay::Relays;
    type Allowance = firewall::Allowance;
    type Ipv6Block = SelectedAppsIpv6Block;
    type Interception = intercept::Running;
    type Logger = Logger;
    type Convergence = Convergence;
    type Watchdog = Watchdog;

    fn wait_for_tunnel(&self, adapter_name: &str, limits: &Limits) -> Result<Adapter, String> {
        tunnel::wait_for_addressed_adapter(adapter_name, limits)
    }

    fn physical_uplink(&self, tunnel_adapter: &str) -> Result<Adapter, String> {
        adapters::physical_uplink(&[tunnel_adapter])
            .map_err(|e| format!("could not enumerate network adapters: {e}"))?
            .ok_or_else(|| "no physical network connection to send traffic over".to_string())
    }

    fn install_route(
        &self,
        tunnel_address: Ipv4Addr,
        tunnel_index: u32,
        tunnel: &TunnelInterface,
        log_path: &Path,
        limits: &Limits,
    ) -> Result<InstalledRoutes, String> {
        tunnel::install_verified_route(tunnel_address, tunnel_index, tunnel, log_path, limits)
    }

    fn start_relays(
        &self,
        nat: Arc<flows::Nat>,
        tunnel: Arc<TunnelInterface>,
        stats: Arc<intercept::Stats>,
        exits: Arc<relay::ExitRelays>,
    ) -> io::Result<relay::Relays> {
        relay::start(nat, tunnel, stats, exits)
    }

    fn allow(
        &self,
        application_source: Ipv4Addr,
        relay_source: Ipv4Addr,
        tcp_port: u16,
        udp_port: u16,
    ) -> Result<firewall::Allowance, String> {
        firewall::Allowance::install(application_source, relay_source, tcp_port, udp_port)
    }

    fn wait_until_reachable(&self, local: Ipv4Addr, tcp_port: u16, limits: &Limits) -> Result<(), String> {
        firewall::wait_until_reachable(local, tcp_port, limits)
    }

    fn block_ipv6(&self, selection: &SharedSelection, log_dir: &Path, log_path: &Path) -> Option<SelectedAppsIpv6Block> {
        super::install_ipv6_app_block(selection, log_dir, log_path)
    }

    fn intercept(
        &self,
        redirect: intercept::Redirect,
        nat: Arc<flows::Nat>,
        selection: SharedSelection,
        stats: Arc<intercept::Stats>,
    ) -> Result<intercept::Running, String> {
        intercept::start(redirect, nat, selection, stats)
    }

    fn start_logger(&self, path: PathBuf, stats: Arc<intercept::Stats>, header: String, audit: Audit) -> Logger {
        Logger::start(path, stats, header, audit)
    }

    fn reset_connections(
        &self,
        selection: &Selection,
        node: Ipv4Addr,
        own_images: &[String],
        nat: &flows::Nat,
    ) -> tables::ResetOutcome {
        tables::reset_selected_connections(
            selection,
            node,
            own_images,
            &|transport, port, destination, destination_port| {
                nat.has_flow(transport, port, destination, destination_port)
            },
        )
    }

    fn converge(
        &self,
        selection: SharedSelection,
        path: PathBuf,
        node: Ipv4Addr,
        own_images: Vec<String>,
        nat: Arc<flows::Nat>,
        closed_already: usize,
    ) -> Convergence {
        Convergence::start(selection, path, node, own_images, nat, closed_already)
    }

    fn watch(
        &self,
        adapter_name: String,
        index: u32,
        address: Ipv4Addr,
        tunnel: Arc<TunnelInterface>,
        interception: &intercept::Running,
        log_path: PathBuf,
        tripped: Arc<AtomicBool>,
    ) -> Watchdog {
        Watchdog::start(adapter_name, index, address, tunnel, interception.stopper(), log_path, tripped)
    }
}
