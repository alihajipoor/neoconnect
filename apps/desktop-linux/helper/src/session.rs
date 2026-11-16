//! The session: the one tunnel that is up, and what is owed back to the
//! machine. Lives on the supervisor's own thread and is touched by
//! nothing else (`lifecycle::supervisor`).

use std::sync::Arc;
use std::time::Instant;

use neoconnect_ipc::{ConnectProfile, ExitProfile, Response, TunnelHealth};
use neoxify_netguard::Plan;
use neoxify_tunnel::{Dirs, Limits, Problem, Tunnel};

use crate::backend::{transport, Backend};
use crate::lifecycle::budget::{ABANDONED, CONNECT_BUDGET};
use crate::lifecycle::cancel::CancelToken;
use crate::lifecycle::ledger::{GuardFacts, Ledger};
use crate::lifecycle::teardown::{self, HardStopReport, HardStopSteps};
use crate::traffic::{Counters, Meter};

struct Live {
    tunnel: Box<dyn Tunnel>,
    generation: u64,
    started: Instant,
    guard: GuardFacts,
    dns_protected: bool,
    meter: Meter,
}

pub struct Session {
    backend: Arc<dyn Backend>,
    dirs: Dirs,
    ledger: Arc<Ledger>,
    live: Option<Live>,
    /// Tunnels that have had their fast stop and are owed the thorough
    /// one (`Tunnel::finish_stop`).
    stopped: Vec<Box<dyn Tunnel>>,
}

impl Session {
    pub fn new(backend: Arc<dyn Backend>, dirs: Dirs, ledger: Arc<Ledger>) -> Self {
        Self { backend, dirs, ledger, live: None, stopped: Vec::new() }
    }

    pub fn has_session(&self) -> bool {
        self.live.is_some()
    }

    /// Whether a thorough stop is owed.
    pub fn owes_finish(&self) -> bool {
        !self.stopped.is_empty()
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
        if self.live.is_some() {
            let report = self.hard_stop();
            if !report.all_succeeded() {
                eprintln!("neoxify-helper: clearing the decks for a connect: {}", report.summary());
            }
        }
        self.finish();
        self.ledger.forget();
        if token.is_cancelled() {
            return Err(ABANDONED.to_string());
        }

        let mut tunnel = match self.backend.connect(profile, exits, known_nodes, &self.dirs, &limits) {
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
        // A table that would not go in leaves the tunnel up and says so,
        // as on Windows: the tunnel carries, and the app must not claim
        // full protection over it. Anything half-written is deleted, so
        // what stands is either the whole table or none of it.
        let guard = match self.backend.guard_apply(&plan) {
            Ok(applied) => GuardFacts {
                ipv6_blocked: applied.ipv6_blocked,
                ipv4_confined: applied.ipv4_confined,
                problem: (!applied.ipv4_confined || !applied.ipv6_blocked || !applied.dns_confined)
                    .then(|| "leak protection is only partly in force".to_string()),
            },
            Err(err) => {
                eprintln!("neoxify-helper: leak protection did not go in, the tunnel stays up without it: {err}");
                if let Err(e) = self.backend.guard_remove() {
                    eprintln!("neoxify-helper: removing a half-written table: {e}");
                }
                GuardFacts { ipv6_blocked: false, ipv4_confined: false, problem: Some(err.to_string()) }
            }
        };
        self.ledger.note_guard(generation, guard.clone());
        eprintln!("neoxify-helper: {} is up on {}", up.protocol, up.ifaces.join(", "));
        self.live = Some(Live {
            tunnel,
            generation,
            started: Instant::now(),
            guard,
            dns_protected: up.dns_protected,
            meter: Meter::default(),
        });

        if token.is_cancelled() {
            self.hard_stop();
            self.finish();
            return Err(ABANDONED.to_string());
        }
        Ok(())
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
            // Always, tunnel or none: a table standing with nothing to
            // let through is the one leftover that takes a machine's whole
            // internet, and deleting none costs one nft call.
            fn release_leak_protection(&mut self) -> Result<(), String> {
                self.0.backend.guard_remove().map(|_| ()).map_err(|e| e.to_string())
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
    /// first, then torn down as a Disconnect would. No reconnect: the app
    /// decides that. Returns whether a thorough stop is now owed.
    fn end_dead(&mut self) -> bool {
        let Some(live) = &self.live else { return false };
        let (generation, protocol) = (live.generation, live.tunnel.up().protocol.clone());
        if self.ledger.record(generation, Instant::now()) {
            eprintln!("neoxify-helper: the {protocol} tunnel went down on its own; taking it down");
        }
        let report = self.hard_stop();
        if !report.all_succeeded() {
            eprintln!("neoxify-helper: after the drop: {}", report.summary());
        }
        true
    }

    /// The once-a-second look at the engine. Returns whether a thorough
    /// stop is owed, by this drop or by anything earlier.
    pub fn check_health(&mut self) -> bool {
        if let Some(live) = &mut self.live {
            if live.tunnel.health() == TunnelHealth::Down {
                self.end_dead();
            }
        }
        self.owes_finish()
    }

    /// The status, from the session itself. Also returns whether a
    /// thorough stop is owed, for the caller to queue.
    pub fn status(&mut self, now: Instant) -> (Response, bool) {
        if let Some(live) = &mut self.live {
            let health = live.tunnel.health();
            if health != TunnelHealth::Down {
                let traffic = live.tunnel.counters().map(|(rx, tx)| live.meter.read(now, Counters { rx, tx }));
                let state = Response::State {
                    connected: true,
                    protocol: Some(live.tunnel.up().protocol.clone()),
                    health,
                    split_tunnel_active: false,
                    split_tunnel_problem: None,
                    split_tunnel_restart_needed: Vec::new(),
                    ipv6_blocked: live.guard.ipv6_blocked,
                    tunnel_dns_unprotected: !live.dns_protected,
                    ipv4_confined: Some(live.guard.ipv4_confined),
                    confinement_problem: live.guard.problem.clone(),
                    reconnect_hold: None,
                    traffic,
                    split_tunnel_problem_code: None,
                    session_secs: Some(now.saturating_duration_since(live.started).as_secs()),
                };
                return (state, self.owes_finish());
            }
            self.end_dead();
            return (nothing(TunnelHealth::Down), true);
        }
        // No session held. `Down` is said only when the machine agrees:
        // an interface of ours still standing (a stop not yet finished, a
        // leftover) is something nothing here has verified either way.
        let health = if self.ledger.confirmed_drop().is_some() || self.backend.visible_tunnel().is_none() {
            TunnelHealth::Down
        } else {
            TunnelHealth::Unknown
        };
        (nothing(health), self.owes_finish())
    }
}

/// A status with no session in it.
pub fn nothing(health: TunnelHealth) -> Response {
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
        reconnect_hold: None,
        traffic: None,
        split_tunnel_problem_code: None,
        session_secs: None,
    }
}
