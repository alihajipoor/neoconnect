//! The session: the one tunnel that is up, and what is owed back to the
//! machine. Lives on the supervisor's own thread and is touched by
//! nothing else (`lifecycle::supervisor`). The reconnect hold is shared
//! with the socket (`hold`), and is the one writer of the nftables table.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, ExitProfile, ReconnectHold, ReconnectHoldProblem, Response, TunnelHealth};
use neoxify_netguard::{Applied, Plan};
use neoxify_tunnel::{Dirs, Limits, Problem, Shape, Tunnel};

use crate::backend::{transport, Backend};
use crate::hold::{self, Arming, Hold, Release, LET_GO_SAID_WITHIN};
use crate::lifecycle::budget::{ABANDONED, CONNECT_BUDGET};
use crate::lifecycle::cancel::CancelToken;
use crate::lifecycle::ledger::{GuardFacts, Ledger, SplitFacts};
use crate::lifecycle::teardown::{self, HardStopReport, HardStopSteps};
use crate::traffic::{Counters, Meter};

/// How long a change of Custom mode, or its probe, may take while the
/// tunnel stays up.
pub const RESHAPE_BUDGET: Duration = Duration::from_secs(20);

struct Live {
    tunnel: Box<dyn Tunnel>,
    generation: u64,
    started: Instant,
    guard: GuardFacts,
    /// The table asked for, and what the kernel confirmed of it (`None`
    /// when it did not go in, and in Custom mode, which has none), for the
    /// once-a-second look that it is still there (`recheck_protection`).
    plan: Plan,
    applied: Option<Applied>,
    /// Custom mode: no machine-wide table and no reconnect hold, as on
    /// Windows. Lookups all go through the tunnel instead.
    split: bool,
    /// The protocol is one the hold covers as a full tunnel.
    holdable: bool,
    /// What the hold lets through if this session drops.
    arming: Arming,
    meter: Meter,
}

/// What the status says of a table the kernel confirmed.
fn facts_of(applied: &Applied, dns_protected: bool) -> GuardFacts {
    GuardFacts {
        ipv6_blocked: applied.ipv6_blocked,
        ipv4_confined: applied.ipv4_confined,
        dns_protected,
        problem: (!applied.ipv4_confined || !applied.ipv6_blocked || !applied.dns_confined)
            .then(|| "leak protection is only partly in force".to_string()),
    }
}

/// What the status says in Custom mode: no machine-wide block, because
/// there is none, and that is the mode's design rather than a problem.
fn split_facts(dns_protected: bool) -> GuardFacts {
    GuardFacts { ipv6_blocked: false, ipv4_confined: false, dns_protected, problem: None }
}

pub struct Session {
    backend: Arc<dyn Backend>,
    dirs: Dirs,
    ledger: Arc<Ledger>,
    hold: Arc<Hold>,
    live: Option<Live>,
    /// Tunnels that have had their fast stop and are owed the thorough
    /// one (`Tunnel::finish_stop`).
    stopped: Vec<Box<dyn Tunnel>>,
    /// Custom mode as the app last set it; the next connect's shape.
    shape: Shape,
    /// The exit the app says the session leaves from, for
    /// `SplitTunnelExits`. Forgotten at each connect: an egress named for
    /// a tunnel that is not there is a claim about nothing.
    egress: Option<String>,
    /// The server addresses the app last named, for the hold's plan.
    known: Vec<Ipv4Addr>,
}

impl Session {
    pub fn new(backend: Arc<dyn Backend>, dirs: Dirs, ledger: Arc<Ledger>, hold: Arc<Hold>) -> Self {
        Self {
            backend,
            dirs,
            ledger,
            hold,
            live: None,
            stopped: Vec::new(),
            shape: Shape::Full,
            egress: None,
            known: Vec::new(),
        }
    }

    pub fn has_session(&self) -> bool {
        self.live.is_some()
    }

    /// Whether a thorough stop is owed.
    pub fn owes_finish(&self) -> bool {
        !self.stopped.is_empty()
    }

    fn live_generation(&self) -> Option<u64> {
        self.live.as_ref().map(|l| l.generation)
    }

    /// Bring a tunnel up, replacing whatever is up. The decks are cleared
    /// in full first -- the old tunnel's DNS restored before the new one
    /// sets its own -- and the budget runs from the start, so clearing
    /// them is paid for out of the same 38 seconds the app is waiting.
    pub fn connect(
        &mut self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        token: &CancelToken,
    ) -> Result<(), String> {
        let limits = Limits { deadline: Instant::now() + CONNECT_BUDGET.limit, cancel: token.flag() };
        let shape = self.shape.clone();
        let split = shape.is_split();
        let named = hold::literals(known_nodes);
        if !named.is_empty() {
            self.known = named;
        }
        self.egress = None;
        let dialled = self.through_the_hold(profile, split);

        if self.live.is_some() {
            let report = self.hard_stop();
            if !report.all_succeeded() {
                crate::say!("neoxify-helper: clearing the decks for a connect: {}", report.summary());
            }
        }
        self.finish();
        self.ledger.forget();
        if token.is_cancelled() {
            return Err(ABANDONED.to_string());
        }

        let mut tunnel = match self.backend.connect(profile, exits, known_nodes, &shape, &self.dirs, &limits) {
            Ok(tunnel) => tunnel,
            Err(Problem::Cancelled) => return Err(ABANDONED.to_string()),
            Err(problem) => return Err(problem.to_string()),
        };
        // Cancelled in the instant it came up: the customer asked for no
        // tunnel, so none is left standing.
        if token.is_cancelled() {
            tunnel.hard_stop();
            tunnel.finish_stop();
            return Err(ABANDONED.to_string());
        }

        let up = tunnel.up().clone();
        let generation = self.ledger.begin(&up.protocol);
        let ifaces: Vec<&str> = up.ifaces.iter().map(String::as_str).collect();
        let plan = Plan {
            tunnel_ifaces: up.ifaces.clone(),
            transports: up.transports.iter().map(transport).collect(),
            engine_fwmark: up.fwmark,
            block_ipv6: true,
            confine_dns: true,
            confine_ipv4: true,
            lan: self.backend.lan_prefixes(&ifaces),
        };
        let (guard, applied) = if split {
            // Custom mode: no machine-wide table. One standing -- the last
            // session's, a leftover -- would block what this mode leaves
            // outside the tunnel on purpose.
            if let Err(e) = self.hold.unconfine() {
                crate::say!("neoxify-helper: removing a table that stood before Custom mode: {e}");
            }
            (split_facts(up.dns_protected), None)
        } else {
            // A table that would not go in leaves the tunnel up and says
            // so, as on Windows: the tunnel carries, and the app must not
            // claim full protection over it. Under a hold this is the swap
            // from the hold to the tunnel's own confinement.
            match self.hold.confine(&plan) {
                Ok(applied) => (facts_of(&applied, up.dns_protected), Some(applied)),
                Err(err) => {
                    crate::say!("neoxify-helper: leak protection did not go in, the tunnel stays up without it: {err}");
                    let facts = GuardFacts {
                        ipv6_blocked: false,
                        ipv4_confined: false,
                        dns_protected: up.dns_protected,
                        problem: Some(err.to_string()),
                    };
                    (facts, None)
                }
            }
        };
        self.ledger.note_guard(generation, guard.clone());

        let mut servers = self.known.clone();
        servers.extend(up.transports.iter().map(|t| t.ip));
        servers.extend(dialled);
        // Read with the tunnel up, which `machine_resolvers` leaves out.
        let resolvers = if hold::covers(profile, split) { self.backend.machine_resolvers() } else { Vec::new() };
        let arming = Arming { ifaces: up.ifaces.clone(), servers, resolvers };
        let holdable = hold::covers(profile, false);
        if holdable && !split {
            self.hold.arm(generation, arming.clone());
        }
        crate::say!("neoxify-helper: {} is up on {}{}", up.protocol, up.ifaces.join(", "), if split { " (Custom mode)" } else { "" });
        self.live = Some(Live {
            tunnel,
            generation,
            started: Instant::now(),
            guard,
            plan,
            applied,
            split,
            holdable,
            arming,
            meter: Meter::default(),
        });

        if token.is_cancelled() {
            self.hard_stop();
            self.finish();
            return Err(ABANDONED.to_string());
        }
        Ok(())
    }

    /// The reconnect hold, before a connect dials: kept and widened to the
    /// server about to be dialled, or let go of -- said in the status first
    /// -- when this connect is one it does not cover or whose server it
    /// cannot name. Returns the dialled server's address when it is known.
    fn through_the_hold(&mut self, profile: &ConnectProfile, split: bool) -> Option<Ipv4Addr> {
        let hold = Arc::clone(&self.hold);
        let host = hold::server_host(profile);
        let literal = host.as_deref().and_then(|h| h.parse::<Ipv4Addr>().ok());
        if !hold.wanted() {
            hold.release(Release::Asked("a connect with the setting off"));
            hold.disarm();
            return literal;
        }
        if !hold::covers(profile, split) {
            hold.let_go_once_said(
                Release::Failed(
                    ReconnectHoldProblem::NotCovered,
                    format!(
                        "the next connection ({}{}) is one the hold does not cover, so it was let go of before that one dialled",
                        profile.protocol_name(),
                        if split { ", Custom mode" } else { "" }
                    ),
                ),
                LET_GO_SAID_WITHIN,
            );
            hold.disarm();
            return literal;
        }
        if !hold.holding() {
            // A connect of the customer's own, or the first of a session: it
            // begins no hold.
            hold.disarm();
            return literal;
        }
        // A tunnel that came up under the hold and is replaced now: held
        // from here, so nothing passes while it is taken down.
        if let Some(live) = &self.live {
            if !live.split {
                hold.engage(live.generation, "a connect replaces the tunnel that came up under the hold");
            }
        }
        let server = literal.or_else(|| host.as_deref().and_then(|h| self.backend.resolve_ipv4(h)));
        match server {
            Some(ip) => {
                hold.permit_server(ip);
            }
            None => {
                hold.let_go_once_said(
                    Release::Failed(
                        ReconnectHoldProblem::TunnelNotPermitted,
                        "the server could not be named as an IPv4 address to put in the hold's plan, so it was let go of before that connection dialled".to_string(),
                    ),
                    LET_GO_SAID_WITHIN,
                );
                hold.disarm();
            }
        }
        server
    }

    /// The live session is about to be taken down by the app to reconnect
    /// (`Request::DisconnectForReconnect`): held from now, before its
    /// engine stops, if it is armed -- and a reconnect is what follows it.
    pub fn hold_for_reconnect(&mut self) -> bool {
        let holding = match &self.live {
            Some(live) if !live.split => self.hold.engage(live.generation, "the app is reconnecting"),
            _ => self.hold.holding(),
        };
        self.hold.followed();
        holding
    }

    /// The setting turned on while a tunnel is up: the live session is
    /// armed, if the hold covers it.
    pub fn arm_live(&mut self) {
        if let Some(live) = &self.live {
            if live.holdable && !live.split {
                self.hold.arm(live.generation, live.arming.clone());
            }
        }
    }

    /// Custom mode as the app sets it. Remembered for the next connect;
    /// while a tunnel is up, applied to it in place (`Tunnel::reshape`),
    /// and turning the mode on or off moves the machine-wide table and the
    /// hold with it. If the tunnel refuses the change, the earlier state
    /// stays in force and the error is returned.
    pub fn set_split(&mut self, shape: Shape, egress: Option<String>, token: &CancelToken) -> Result<(), String> {
        self.egress = egress;
        let Some(live) = &mut self.live else {
            self.shape = shape;
            return Ok(());
        };
        if live.tunnel.shape() == shape {
            self.shape = shape;
            return Ok(());
        }
        let limits = Limits { deadline: Instant::now() + RESHAPE_BUDGET, cancel: token.flag() };
        if let Err(problem) = live.tunnel.reshape(&shape, &limits) {
            // The live tunnel keeps its earlier shape, but the next connect
            // takes the new one: OpenVPN answers a switch between the full
            // tunnel and Custom mode with "needs a reconnect", and without
            // this the reconnect it asks for came back up in the old shape.
            self.shape = shape;
            return Err(problem.to_string());
        }
        let now_split = shape.is_split();
        self.shape = shape;
        if live.split == now_split {
            return Ok(());
        }
        let dns = live.tunnel.dns_protected();
        if now_split {
            self.hold.release(Release::Asked("Custom mode was turned on"));
            self.hold.disarm();
            if let Err(e) = self.hold.unconfine() {
                crate::say!("neoxify-helper: removing leak protection for Custom mode: {e}");
            }
            live.split = true;
            live.applied = None;
            live.guard = split_facts(dns);
        } else {
            live.split = false;
            let ifaces: Vec<&str> = live.plan.tunnel_ifaces.iter().map(String::as_str).collect();
            live.plan.lan = self.backend.lan_prefixes(&ifaces);
            match self.hold.confine(&live.plan) {
                Ok(applied) => {
                    live.applied = Some(applied);
                    live.guard = facts_of(&applied, dns);
                }
                Err(err) => {
                    crate::say!("neoxify-helper: leak protection did not go in after Custom mode was turned off: {err}");
                    live.applied = None;
                    live.guard =
                        GuardFacts { ipv6_blocked: false, ipv4_confined: false, dns_protected: dns, problem: Some(err.to_string()) };
                }
            }
            if live.holdable {
                self.hold.arm(live.generation, live.arming.clone());
            }
        }
        self.ledger.note_guard(live.generation, live.guard.clone());
        Ok(())
    }

    /// The exit the app last named for this session.
    pub fn egress(&self) -> Option<String> {
        self.egress.clone()
    }

    /// Does the tunnel itself reach the internet? Custom mode's check.
    pub fn probe(&self, token: &CancelToken) -> Result<(), String> {
        let Some(live) = &self.live else { return Err("no tunnel is up".to_string()) };
        let limits = Limits { deadline: Instant::now() + RESHAPE_BUDGET, cancel: token.flag() };
        live.tunnel.probe(&limits)
    }

    /// Phase one: what a Disconnect waits for. The generation is closed
    /// before the engine stops, so the stop is not taken for a drop.
    pub fn hard_stop(&mut self) -> HardStopReport {
        struct Steps<'a>(&'a mut Session);
        impl HardStopSteps for Steps<'_> {
            fn stop_tunnel(&mut self) -> Result<(), String> {
                if let Some(mut live) = self.0.live.take() {
                    self.0.ledger.close(live.generation);
                    live.tunnel.hard_stop();
                    self.0.stopped.push(live.tunnel);
                }
                Ok(())
            }
            // Always, tunnel or none, unless the table is the reconnect
            // hold's: then it is what this teardown is for.
            fn release_leak_protection(&mut self) -> Result<(), String> {
                self.0.hold.unconfine()
            }
        }
        teardown::hard_stop(&mut Steps(self))
    }

    /// Phase two: every thorough stop owed.
    pub fn finish(&mut self) {
        for mut tunnel in self.stopped.drain(..) {
            tunnel.finish_stop();
        }
    }

    /// Ends a session whose engine has gone on its own: recorded as a drop
    /// first, held if the customer asked for that, then torn down as a
    /// Disconnect would. No reconnect: the app decides that. Returns
    /// whether a thorough stop is now owed.
    fn end_dead(&mut self) -> bool {
        let Some(live) = &self.live else { return false };
        let (generation, protocol, split) = (live.generation, live.tunnel.up().protocol.clone(), live.split);
        if self.ledger.record(generation, Instant::now()) {
            crate::say!("neoxify-helper: the {protocol} tunnel went down on its own; taking it down");
        }
        // The hold goes in in place of the confinement before anything of
        // the session's goes, so nothing passes between them.
        if !split {
            self.hold.engage(generation, "the tunnel went down on its own");
        }
        let report = self.hard_stop();
        if !report.all_succeeded() {
            crate::say!("neoxify-helper: after the drop: {}", report.summary());
        }
        true
    }

    /// The once-a-second look at the engine. Returns whether a thorough
    /// stop is owed, by this drop or by anything earlier.
    pub fn check_health(&mut self) -> bool {
        if let Some(live) = &mut self.live {
            if live.tunnel.health() == TunnelHealth::Down {
                self.end_dead();
            } else {
                self.recheck_protection();
            }
        }
        self.hold.tend(self.live_generation());
        self.owes_finish()
    }

    /// What the status claims about DNS and the table, read back from the
    /// machine rather than kept from the connect. Either can be undone
    /// under a live tunnel -- a DHCP client rewriting `/etc/resolv.conf`,
    /// `nft flush ruleset` from a firewall reload -- and the app tells the
    /// customer they are protected on these words. A table that went is
    /// put back; one that will not go back is reported as gone.
    fn recheck_protection(&mut self) {
        let Some(live) = &mut self.live else { return };
        let mut changed = false;

        let dns = live.tunnel.dns_protected();
        if dns != live.guard.dns_protected {
            if !dns {
                crate::say!("neoxify-helper: the machine's DNS no longer points into the tunnel; something else rewrote it");
            }
            live.guard.dns_protected = dns;
            changed = true;
        }

        // Not while the hold's table stands in for it: a connect's swap is
        // mid-way, and the hold is the one writing.
        if let (Some(expected), false) = (live.applied, self.hold.hold_in_table()) {
            match self.backend.guard_in_force() {
                Ok(Some(now)) if now == expected => {}
                Ok(_) => {
                    crate::say!("neoxify-helper: leak protection was changed or removed by something else; putting it back");
                    live.guard = match self.hold.confine(&live.plan) {
                        Ok(applied) => {
                            live.applied = Some(applied);
                            facts_of(&applied, dns)
                        }
                        Err(err) => {
                            crate::say!("neoxify-helper: leak protection could not be put back: {err}");
                            live.applied = None;
                            GuardFacts {
                                ipv6_blocked: false,
                                ipv4_confined: false,
                                dns_protected: dns,
                                problem: Some(format!(
                                    "leak protection was removed by something else and could not be put back: {err}"
                                )),
                            }
                        }
                    };
                    changed = true;
                }
                // A look that could not run proves nothing either way.
                Err(_) => {}
            }
        }

        if changed {
            self.ledger.note_guard(live.generation, live.guard.clone());
        }
    }

    /// The status, from the session itself. Also returns whether a
    /// thorough stop is owed, for the caller to queue.
    pub fn status(&mut self, now: Instant) -> (Response, bool) {
        self.hold.tend(self.live_generation());
        if let Some(live) = &mut self.live {
            let health = live.tunnel.health();
            if health != TunnelHealth::Down {
                let traffic = live.tunnel.counters().map(|(rx, tx)| live.meter.read(now, Counters { rx, tx }));
                let split = live.tunnel.split();
                self.ledger.note_split(
                    live.generation,
                    split.as_ref().map(|s| SplitFacts {
                        active: s.active,
                        problem: s.problem.clone(),
                        restart_needed: s.restart_needed.clone(),
                    }),
                );
                let (problem, code) = match split.as_ref().and_then(|s| s.problem.clone()) {
                    Some((sentence, code)) => (Some(sentence), Some(code)),
                    None => (None, None),
                };
                let state = Response::State {
                    connected: true,
                    protocol: Some(live.tunnel.up().protocol.clone()),
                    health,
                    split_tunnel_active: split.as_ref().is_some_and(|s| s.active),
                    split_tunnel_problem: problem,
                    split_tunnel_restart_needed: split.map(|s| s.restart_needed).unwrap_or_default(),
                    ipv6_blocked: live.guard.ipv6_blocked,
                    tunnel_dns_unprotected: !live.guard.dns_protected,
                    ipv4_confined: Some(live.guard.ipv4_confined),
                    confinement_problem: live.guard.problem.clone(),
                    reconnect_hold: self.hold.report(Some(live.generation)),
                    traffic,
                    split_tunnel_problem_code: code,
                    session_secs: Some(now.saturating_duration_since(live.started).as_secs()),
                };
                return (state, self.owes_finish());
            }
            self.end_dead();
            return (nothing(TunnelHealth::Down, self.hold.report(None)), true);
        }
        // No session held. `Down` is said only when the machine agrees:
        // an interface of ours still standing (a stop not yet finished, a
        // leftover) is something nothing here has verified either way.
        let health = if self.ledger.confirmed_drop().is_some() || self.backend.visible_tunnel().is_none() {
            TunnelHealth::Down
        } else {
            TunnelHealth::Unknown
        };
        (nothing(health, self.hold.report(None)), self.owes_finish())
    }
}

/// A status with no session in it.
pub fn nothing(health: TunnelHealth, reconnect_hold: Option<ReconnectHold>) -> Response {
    Response::State {
        connected: false,
        protocol: None,
        health,
        split_tunnel_active: false,
        split_tunnel_problem: None,
        split_tunnel_restart_needed: Vec::new(),
        ipv6_blocked: false,
        tunnel_dns_unprotected: false,
        ipv4_confined: None,
        confinement_problem: None,
        reconnect_hold,
        traffic: None,
        split_tunnel_problem_code: None,
        session_secs: None,
    }
}
