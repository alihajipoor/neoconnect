//! A session whose Windows-only parts are stand-ins, so what
//! `Session::start` acquires and what dropping a session releases can be
//! tested on a developer's machine without administrator rights.
//!
//! # What is real and what stands in
//!
//! Real: the relays -- listeners on the machine's own stack, with their
//! three threads each -- the logger, writing to a file in a temporary
//! directory, the wait for the relay to answer, and [`Worker`], which
//! every stand-in thread runs on, so the stop-and-join being exercised is
//! the production one.
//!
//! The "tunnel" is loopback: a real interface, so the relays pin their
//! onward sockets to it exactly as they would to a VPN adapter, and a
//! connection carried through them reaches a listener on this machine.
//!
//! Standing in: the route, the firewall allowance, the IPv6 block and
//! the packet loop, each of which needs administrator rights, the
//! WinDivert driver or the filtering engine; and the activation reset,
//! its rescans and the backstop, which walk the machine's real connection
//! tables and adapters and could close a real connection. The stand-in
//! threads hold what the real ones hold -- the flow table, the counters,
//! the tunnel record -- so that a thread left running is visible as a
//! reference nobody let go of.
//!
//! Every stand-in, and the real parts too, records its acquisition and
//! its release in a shared [`Ledger`], which is what the tests read.

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::adapters::Adapter;
use crate::lifecycle::budget::Limits;
use crate::split_tunnel::net::pin::TunnelInterface;
use crate::split_tunnel::policy::Selection;
use crate::split_tunnel::worker::{sleep_unless_stopped, Worker};
use crate::split_tunnel::{firewall, flows, intercept, relay, tables, SharedSelection};

use super::logger::{Audit, Logger};
use super::parts::{Intercepting, Parts, Relaying};

/// One thing that happened to one part of one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    Acquired,
    Released,
}

/// What every part of every session sharing it did, in the order it
/// happened, plus what each session handed its threads.
#[derive(Default)]
pub(super) struct Ledger {
    events: Mutex<Vec<(usize, &'static str, Step)>>,
    /// Every shared object a session handed to a part, as a check that
    /// answers whether anything still holds it.
    handed: Mutex<Vec<(usize, &'static str, Box<dyn Fn() -> bool + Send>)>>,
    /// The relays' TCP and UDP ports, to try once they are meant to be
    /// shut.
    relay_ports: Mutex<Vec<(usize, u16, u16)>>,
}

impl Ledger {
    fn record(&self, session: usize, part: &'static str, step: Step) {
        self.events.lock().unwrap().push((session, part, step));
    }

    /// The parts `session` acquired, in order.
    pub(super) fn acquired(&self, session: usize) -> Vec<&'static str> {
        self.of(session, Step::Acquired)
    }

    /// The parts `session` released, in order.
    pub(super) fn released(&self, session: usize) -> Vec<&'static str> {
        self.of(session, Step::Released)
    }

    fn of(&self, session: usize, step: Step) -> Vec<&'static str> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _, st)| *s == session && *st == step)
            .map(|(_, part, _)| *part)
            .collect()
    }

    /// Shared objects some thread or part still holds, across every
    /// session. Empty once everything that was handed one has finished.
    pub(super) fn still_held(&self) -> Vec<(usize, &'static str)> {
        self.handed
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, _, alive)| alive())
            .map(|(session, what, _)| (*session, *what))
            .collect()
    }

    pub(super) fn relay_ports(&self) -> Vec<(usize, u16, u16)> {
        self.relay_ports.lock().unwrap().clone()
    }

    fn hand<T: Send + Sync + 'static>(&self, session: usize, what: &'static str, shared: &Arc<T>) {
        let weak = Arc::downgrade(shared);
        self.handed.lock().unwrap().push((session, what, Box::new(move || weak.upgrade().is_some())));
    }
}

/// A part that records its own release, and then releases what it holds.
///
/// The release is recorded first, so the ledger's order is the order in
/// which teardown *reached* each part.
pub(super) struct Held<T> {
    inner: Option<T>,
    ledger: Arc<Ledger>,
    session: usize,
    part: &'static str,
}

impl<T> Held<T> {
    fn new(ledger: &Arc<Ledger>, session: usize, part: &'static str, inner: T) -> Self {
        ledger.record(session, part, Step::Acquired);
        Self { inner: Some(inner), ledger: ledger.clone(), session, part }
    }

    fn inner(&self) -> &T {
        self.inner.as_ref().expect("held until dropped")
    }
}

impl<T> Drop for Held<T> {
    fn drop(&mut self) {
        self.ledger.record(self.session, self.part, Step::Released);
        drop(self.inner.take());
    }
}

/// A thread standing in for one of the session's own, holding whatever
/// it is handed until it is asked to stop.
fn idle_thread<T: Send + 'static>(holding: T) -> Worker {
    Worker::spawn(move |stop| {
        let _holding = holding;
        while sleep_unless_stopped(&stop, std::time::Duration::from_secs(60)) {}
    })
}

/// The packet loop's stand-in: the counters it reads, and a thread that
/// holds the flow table and the counters as the real workers do.
pub(super) struct Loop {
    stats: Arc<intercept::Stats>,
    _thread: Worker,
}

impl Intercepting for Held<Loop> {
    fn stats(&self) -> &Arc<intercept::Stats> {
        &self.inner().stats
    }
}

impl Relaying for Held<relay::Relays> {
    fn ports(&self) -> (u16, u16) {
        self.inner().ports()
    }

    fn own_sockets(&self) -> Arc<relay::OwnSockets> {
        self.inner().own_sockets()
    }
}

/// Parts for one session.
pub(super) struct Fake {
    pub(super) ledger: Arc<Ledger>,
    pub(super) session: usize,
    /// The step that fails, by the name the ledger uses for it, or
    /// `reachable` for the wait that has no part of its own.
    ///
    /// The steps that cannot fail -- `logger`, `reset` (the first pass
    /// of the activation reset, which has no part of its own),
    /// `convergence` and `watchdog` -- panic instead, which is the only
    /// way out of a bring-up they have.
    pub(super) fail_at: Option<&'static str>,
}

impl Fake {
    fn fails(&self, step: &str) -> Result<(), String> {
        match self.fail_at {
            Some(failing) if failing == step => Err(format!("{step} refused, as the test asked")),
            _ => Ok(()),
        }
    }

    fn panics(&self, step: &str) {
        if self.fail_at == Some(step) {
            panic!("{step} panicked, as the test asked");
        }
    }

    fn held<T>(&self, part: &'static str, inner: T) -> Held<T> {
        Held::new(&self.ledger, self.session, part, inner)
    }
}

impl Parts for Fake {
    type Route = Held<()>;
    type Relays = Held<relay::Relays>;
    type Allowance = Held<()>;
    type Ipv6Block = Held<()>;
    type Interception = Held<Loop>;
    type Logger = Held<Logger>;
    type Convergence = Held<Worker>;
    type Watchdog = Held<Worker>;

    fn wait_for_tunnel(&self, adapter_name: &str, _limits: &Limits) -> Result<Adapter, String> {
        // Loopback, interface 1 on every Windows machine -- the same
        // stand-in `net::pin`'s test pins to. The relays attach their
        // onward sockets to it the way they attach them to a real
        // tunnel, so what they carry goes the production path and
        // arrives at a listener here. An address no adapter holds would
        // make every carried connection fail its bind instead.
        Ok(Adapter {
            index: 1,
            name: adapter_name.to_string(),
            gateway: None,
            ipv4: Some(Ipv4Addr::LOCALHOST),
            is_up: true,
            description: "stand-in tunnel".to_string(),
        })
    }

    fn physical_uplink(&self, _tunnel_adapter: &str) -> Result<Adapter, String> {
        // Loopback, so the real wait for the relay below reaches the real
        // relay without a firewall rule.
        Ok(Adapter {
            index: 1,
            name: "stand-in uplink".to_string(),
            gateway: None,
            ipv4: Some(Ipv4Addr::LOCALHOST),
            is_up: true,
            description: "stand-in uplink".to_string(),
        })
    }

    fn install_route(
        &self,
        _tunnel_address: Ipv4Addr,
        _tunnel_index: u32,
        _tunnel: &TunnelInterface,
        _log_path: &Path,
        _limits: &Limits,
    ) -> Result<Held<()>, String> {
        self.fails("route")?;
        Ok(self.held("route", ()))
    }

    fn start_relays(
        &self,
        nat: Arc<flows::Nat>,
        tunnel: Arc<TunnelInterface>,
        stats: Arc<intercept::Stats>,
        exits: Arc<relay::ExitRelays>,
    ) -> io::Result<Held<relay::Relays>> {
        // Everything a session hands its threads passes through here, so
        // this is where the ledger starts watching it.
        self.ledger.hand(self.session, "flow table", &nat);
        self.ledger.hand(self.session, "counters", &stats);
        self.ledger.hand(self.session, "tunnel record", &tunnel);
        if let Err(e) = self.fails("relays") {
            return Err(io::Error::other(e));
        }
        let relays = relay::start(nat, tunnel, stats, exits)?;
        self.ledger.relay_ports.lock().unwrap().push((self.session, relays.tcp_port, relays.udp_port));
        Ok(self.held("relays", relays))
    }

    fn allow(&self, _application: Ipv4Addr, _relay: Ipv4Addr, _tcp: u16, _udp: u16) -> Result<Held<()>, String> {
        self.fails("allowance")?;
        Ok(self.held("allowance", ()))
    }

    fn wait_until_reachable(&self, local: Ipv4Addr, tcp_port: u16, limits: &Limits) -> Result<(), String> {
        self.fails("reachable")?;
        firewall::wait_until_reachable(local, tcp_port, limits)
    }

    fn block_ipv6(&self, _selection: &SharedSelection, _log_dir: &Path, _log_path: &Path) -> Option<Held<()>> {
        Some(self.held("ipv6", ()))
    }

    fn intercept(
        &self,
        redirect: intercept::Redirect,
        nat: Arc<flows::Nat>,
        selection: SharedSelection,
        stats: Arc<intercept::Stats>,
    ) -> Result<Held<Loop>, String> {
        self.fails("interception")?;
        let thread = idle_thread((redirect, nat, selection, stats.clone()));
        Ok(self.held("interception", Loop { stats, _thread: thread }))
    }

    fn start_logger(&self, path: PathBuf, stats: Arc<intercept::Stats>, header: String, audit: Audit) -> Held<Logger> {
        self.panics("logger");
        self.held("logger", Logger::start(path, stats, header, audit))
    }

    fn reset_connections(
        &self,
        _selection: &Selection,
        _node: Ipv4Addr,
        _own_images: &[String],
        _nat: &flows::Nat,
    ) -> tables::ResetOutcome {
        self.panics("reset");
        tables::ResetOutcome::default()
    }

    fn converge(
        &self,
        selection: SharedSelection,
        _path: PathBuf,
        _node: Ipv4Addr,
        _own_images: Vec<String>,
        nat: Arc<flows::Nat>,
        _closed_already: usize,
    ) -> Held<Worker> {
        self.panics("convergence");
        self.held("convergence", idle_thread((selection, nat)))
    }

    fn watch(
        &self,
        _adapter_name: String,
        _index: u32,
        _address: Ipv4Addr,
        tunnel: Arc<TunnelInterface>,
        _interception: &Held<Loop>,
        _log_path: PathBuf,
        tripped: Arc<AtomicBool>,
    ) -> Held<Worker> {
        self.panics("watchdog");
        self.held("watchdog", idle_thread((tunnel, tripped)))
    }
}
