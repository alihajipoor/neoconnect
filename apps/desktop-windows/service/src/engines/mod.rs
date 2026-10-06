//! Engine lifecycle: bringing one VPN protocol up, tearing it down, and
//! reporting what is actually running.
//!
//! Every engine here is a real, official upstream binary (wireguard.exe,
//! xray.exe, openvpn.exe) rather than a reimplementation -- the same
//! philosophy the server-side agent was built on. This module's whole
//! job is to write the right config file and drive the right process,
//! invisibly.

// `pub(crate)` for the gaming module, which installs a second,
// separately-tagged set of NRPT rules through the sibling functions in
// here. Nothing about `apply`/`clear` changes for the engines.
pub(crate) mod dns;
mod ikev2;
pub(crate) mod ipv6_block;
mod hard_stop;
mod janitor;
mod ras;
mod openvpn;
/// "Repair my network" -- the superset teardown, reusing every module
/// above. A child of this one so it can call the same private teardowns
/// the disconnect path does rather than growing second copies of them.
pub(crate) mod repair;
pub mod routing;
mod wireguard;
mod xray;

use ipv6_block::Ipv6Block;
use routing::InstalledRoutes;

use std::io;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::Instant;

use neoconnect_ipc::{ConnectProfile, ExitProfile, SplitTunnelConfig, TunnelHealth};

use crate::adapters;
use crate::lifecycle::engine_watch::{self, Ledger, WatchGuard};
use crate::split_tunnel::SplitTunnel;

/// Suppresses the console window a child process would otherwise flash
/// on screen. Every spawn in this service sets it -- the user must never
/// see an engine appear (see the silent-engines requirement in project
/// memory), and a brief black rectangle on Connect is exactly as
/// disqualifying as a persistent window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What is currently up. Holding the `Child` here is what keeps the
/// engine process owned by the service rather than orphaned.
enum Active {
    /// wireguard.exe installs its own Windows service for the tunnel, so
    /// there is no child process for us to hold -- liveness is queried
    /// from the service manager instead.
    WireguardTunnel,
    /// Windows owns the IKEv2 tunnel, so liveness is asked of the
    /// operating system the same way WireGuard's is asked of the service
    /// manager -- but the dial's own connection handle is held here.
    ///
    /// It used to be discarded, and the tunnel hung up later by running
    /// `rasdial.exe <entry> /disconnect`. A process launch is 4.4 to 6.5
    /// seconds on the machines this was measured on, which is more than
    /// the entire budget for a disconnect. Holding the handle makes the
    /// teardown one API call, and because `ras::Connection` hangs up in
    /// `Drop` it also happens on the paths nobody wrote: a cancelled
    /// connect, an early return, a panic.
    Ikev2(ras::Connection),
    Child {
        protocol: &'static str,
        child: Child,
        /// Routes this service installed on the engine's behalf. Empty
        /// for engines that manage their own (OpenVPN acts on the
        /// server's pushed directives); populated for Xray, which does
        /// not route anything by itself.
        routes: InstalledRoutes,
    },
}

impl Active {
    /// The protocol this engine carries, as the status poll names it.
    fn protocol(&self) -> &'static str {
        match self {
            Active::WireguardTunnel => "WIREGUARD",
            Active::Ikev2(_) => "IKEV2",
            Active::Child { protocol, .. } => protocol,
        }
    }

    /// How the engine watch is to know this engine has ended.
    ///
    /// Something the kernel signals in every case, never a timer: the
    /// child's own process handle for Xray and OpenVPN, the tunnel
    /// service's process for WireGuard, and an event RAS sets for IKEv2.
    /// `scm` is how the WireGuard tunnel service's state is read -- the
    /// service manager, except in tests.
    fn liveness(&self, scm: &ScmQuery) -> io::Result<Box<dyn engine_watch::Liveness>> {
        use std::os::windows::io::AsRawHandle;
        Ok(match self {
            Active::Child { child, .. } => {
                Box::new(engine_watch::ProcessLiveness::of_handle(child.as_raw_handle() as _)?)
            }
            Active::Ikev2(live) => Box::new(live.liveness()?),
            Active::WireguardTunnel => {
                let scm = Arc::clone(scm);
                Box::new(wireguard::ServiceLiveness::with_query(move || scm()))
            }
        })
    }

    /// Whether this engine has ended, asked directly. `None` when the
    /// question could not be asked -- RAS answering with an error it gives
    /// no meaning to.
    ///
    /// The check a teardown makes before acting on a watch's report, so
    /// that nothing is taken down on the strength of a wait that merely
    /// failed. A tunnel service that is still stopping, starting again,
    /// or whose state could not be read is not an ending.
    fn has_ended(&mut self, scm: &ScmQuery) -> Option<bool> {
        match self {
            Active::Child { child, .. } => Some(!matches!(child.try_wait(), Ok(None))),
            Active::Ikev2(live) => live.is_connected().map(|up| !up),
            Active::WireguardTunnel => Some(!wireguard::counts_as_running(&scm())),
        }
    }
}

/// How the WireGuard tunnel service's state is read: the service manager
/// in the service, a script in the tests that need a tunnel service to
/// stop and start again on cue.
type ScmQuery = Arc<dyn Fn() -> wireguard::ScmView + Send + Sync>;

/// How soon a watch may be started again after the last one, at most.
///
/// A watch whose report the engine contradicts is started again at once
/// (see [`Engines::end_dead_session`]). Once in a while that is a
/// WireGuard tunnel service restarted, or an IKEv2 connection moved by
/// MOBIKE. A source that kept contradicting itself would instead make
/// it a loop through the owning thread, so a watch armed within this of
/// the last one waits this long before its first look.
const REARM_SPACING: std::time::Duration = std::time::Duration::from_secs(1);

/// How many re-arms per session are written to `cleanup.log`. The first
/// few say what happened; a source that flaps all session long would
/// otherwise fill the log with one line a second.
const REARMS_LOGGED: u32 = 3;

/// The live engine, in a box that cannot be emptied quietly.
///
/// This exists because of a field report on 2026-08-23, and it is the
/// only part of that fix that the next person cannot accidentally undo.
///
/// A customer in Custom mode had their WireGuard tunnel die on its own.
/// [`Engines::status`] noticed, wrote `self.active = None`, and reported
/// "disconnected" -- correctly, as far as it went. What it did not do
/// was stop the split tunnel, so the WinDivert redirect loop stayed up
/// with the dead adapter's interface index still pinned in it. Custom
/// mode carries *every* process's DNS, not just the selected ones, so
/// from that moment nothing on the machine could resolve a name: each
/// lookup was redirected into a relay whose upstream socket could no
/// longer bind. Disconnecting did nothing (the app already believed it
/// was disconnected), closing the app did nothing, and connecting a
/// different VPN did nothing either, because we were taking the packets
/// underneath it. Ending the service's process in Task Manager fixed it
/// instantly -- that is what closing the last WinDivert handle does.
///
/// The bug was one missing call. A second missing call is one `self
/// .active = None` away, in whichever engine arm somebody adds next, and
/// a comment asking them to remember is not a mechanism. So the field is
/// private to this module and there is no setter that empties it: the
/// only way out is [`Slot::end`], which takes the [`SplitTunnel`] by
/// `&mut` and stops it. Ending a session and stopping interception are
/// one operation because they cannot be allowed to be two.
mod session {
    use std::sync::Arc;

    use super::{Ledger, Session, SplitTunnel};

    /// The slot, and the ledger its generations are kept in.
    ///
    /// The ledger lives here rather than beside it for the same reason
    /// the split tunnel is an argument to [`Slot::end`]: closing a
    /// session's generation has to happen on every route out of the
    /// slot, before the engine is handed back to be killed, or the
    /// service's own kill would be reported to the customer as their
    /// connection dropping. One place, so it cannot be forgotten.
    pub(super) struct Slot {
        session: Option<Session>,
        ledger: Arc<Ledger>,
    }

    impl Slot {
        /// A slot with a ledger of its own, for the tests that only need
        /// a slot.
        #[cfg(test)]
        pub(super) fn empty() -> Self {
            Self::with_ledger(Arc::new(Ledger::new()))
        }

        pub(super) fn with_ledger(ledger: Arc<Ledger>) -> Self {
            Self { session: None, ledger }
        }

        pub(super) fn is_empty(&self) -> bool {
            self.session.is_none()
        }

        /// Installs the session a connect has just built, and returns the
        /// generation it was given.
        ///
        /// Every caller reaches this having just torn the previous
        /// session down -- `connect_inner` opens with `disconnect()` --
        /// so overwriting a live engine would be a leaked process rather
        /// than a merely untidy state. Asserted rather than handled,
        /// because there is no sensible handling: the `Child` is already
        /// gone from our hands by the time we could look at it.
        pub(super) fn fill(&mut self, mut session: Session) -> u64 {
            debug_assert!(self.session.is_none(), "a session was installed over a live one");
            session.generation = self.ledger.begin(session.engine.protocol());
            let generation = session.generation;
            self.session = Some(session);
            generation
        }

        /// Looks at the session without being able to remove it.
        pub(super) fn peek_mut(&mut self) -> Option<&mut Session> {
            self.session.as_mut()
        }

        pub(super) fn peek(&self) -> Option<&Session> {
            self.session.as_ref()
        }

        /// Ends the session: stops interception, then hands back
        /// whatever engine was running so the caller can tear it down.
        ///
        /// The `SplitTunnel` argument is the whole design. It is not
        /// needed to empty an `Option`; it is there so that emptying the
        /// slot is impossible without it.
        ///
        /// Interception is stopped **before** the engine goes, because
        /// the reverse order rewrites packets towards a relay whose
        /// upstream has just lost its tunnel. It is also stopped when
        /// the slot is already empty, which is not redundant: that is
        /// precisely the state the field bug left behind -- no engine
        /// tracked, a redirect loop still running -- and it is the state
        /// a Disconnect arriving after the fact has to be able to fix.
        ///
        /// The generation is closed first of all. From that moment the
        /// engine watch's report of this engine ending is refused as the
        /// service's own hand -- which it is, on every caller: an
        /// explicit Disconnect, a connect clearing the decks, a Custom
        /// mode rebuild, and the teardown of an engine that has already
        /// ended (where the drop was recorded before this ran).
        pub(super) fn end(&mut self, split_tunnel: &mut SplitTunnel) -> Option<Session> {
            if let Some(session) = &self.session {
                self.ledger.close(session.generation);
            }
            split_tunnel.stop();
            // The concurrent exits go with the engine, in the same
            // operation and for the same reason interception does.
            // Their loopback inbounds live inside the process that is
            // about to be killed, so a table that outlived it would
            // point every placed game at ports nothing is listening on
            // -- and each of those flows would fail separately, at
            // whatever moment it next tried to connect, which is a
            // game's binaries losing their exit one at a time. Cleared
            // here, they lose it together.
            split_tunnel.clear_exits();
            self.session.take()
        }
    }
}

use session::Slot;

/// One session: the engine, and everything that exists only because of
/// it.
///
/// These used to be fields of `Engines` beside the slot -- the IPv6
/// block, WireGuard's DNS-only confinement, the profile -- each kept in
/// step with the engine by every path that ended a session remembering
/// to clear it. The record of that working is the comments recording
/// when it did not: a status poll that found a dead engine once stopped
/// at the IPv6 block and left the machine's DNS rule pointing at
/// nothing, and the field bug behind [`Slot`] was the same shape. Owned
/// by the session, they cannot outlive it: ending the session yields
/// all of it at once, and whatever the caller does not hand on is
/// dropped -- and an `Ipv6Block` releases its filters when dropped.
struct Session {
    engine: Active,
    /// The profile the tunnel was built from, so Custom mode can be
    /// switched without the customer reconnecting by hand: whether a
    /// tunnel is passive or full is decided when the engine starts, so
    /// changing the mode means building it again, from this.
    profile: ConnectProfile,
    filters: SessionFilters,
    /// Which session this is, in the ledger. Given by [`Slot::fill`];
    /// zero only for a session that has not been installed.
    generation: u64,
    /// The engine watch, ended when the session is -- see
    /// `lifecycle::engine_watch`. `None` when the watch could not be
    /// started, in which case an engine that dies is still found by the
    /// status poll, as it always was.
    watch: Option<WatchGuard>,
    /// When the current watch was started, and how many times it has
    /// been started again after a report the engine contradicted. See
    /// [`REARM_SPACING`].
    armed_at: Instant,
    rearms: u32,
}

impl Session {
    fn new(engine: Active, profile: &ConnectProfile) -> Self {
        Self {
            engine,
            profile: profile.clone(),
            filters: SessionFilters::default(),
            generation: 0,
            watch: None,
            armed_at: Instant::now(),
            rearms: 0,
        }
    }
}

/// Called with a session's generation when its engine has ended on its
/// own. The pipe installs one that queues the teardown on the owning
/// thread; see [`Engines::when_an_engine_ends`].
pub type EngineGone = Arc<dyn Fn(u64) + Send + Sync>;

/// Who found a dead engine, for the log line that says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Noticed {
    ByWatch,
    ByStatus,
}

/// How long a WireGuard handshake reading is reused.
///
/// The app now asks for status every second while a tunnel is up, to
/// stop claiming protection within a second of the tunnel going. Each
/// handshake reading spawns `wg.exe`, which was fine at one poll every
/// fifteen seconds and is not at one a second. Five seconds
/// is far inside the 180-second window that separates alive from stale,
/// so nothing it reports can change meaning by being this old.
const HANDSHAKE_REUSE_FOR: std::time::Duration = std::time::Duration::from_secs(5);

/// A profile for the sessions tests install. IKEv2's, because it is the
/// smallest to build; nothing connects with it.
#[cfg(test)]
fn test_profile() -> ConnectProfile {
    ConnectProfile::Ikev2(neoconnect_ipc::Ikev2Profile {
        server: "node.example.com".into(),
        username: String::new(),
        password: String::new(),
    })
}

/// The WFP filters a session installed, released when this is dropped.
#[derive(Default)]
struct SessionFilters {
    /// The machine-wide IPv6 block that goes with a full tunnel, with
    /// the tunnel's DNS confinement in the same WFP session when the
    /// engine needs it.
    ///
    /// `Some` exactly while it is installed, which is what the status
    /// poll reports to the app -- the customer is told IPv6 is blocked
    /// because it *is* blocked, not because the protocol usually implies
    /// it. See `ipv6_block` for the measurement, and for why WireGuard
    /// is the one engine that never has one here.
    ipv6: Option<Ipv6Block>,
    /// DNS confined to the tunnel with no IPv6 block, for WireGuard --
    /// whose own kill-switch blocks IPv6 but lets DNS out by the physical
    /// NIC. Separate so that `ipv6_blocked`, and what the app tells the
    /// customer about IPv6, still follows only `ipv6`.
    dns_only: Option<Ipv6Block>,
}

impl SessionFilters {
    /// Releases both, now. Dropping does the same; this exists so the
    /// teardown can say *when*.
    fn release(mut self) {
        if let Some(mut block) = self.ipv6.take() {
            block.remove();
        }
        if let Some(mut block) = self.dns_only.take() {
            block.remove();
        }
    }
}

pub struct Engines {
    exe_dir: PathBuf,
    config_dir: PathBuf,
    active: Slot,
    /// Custom mode. Owned here because this is the only component that
    /// knows which protocol is live, and the split tunnel has to follow
    /// it -- an implementation bound to one adapter would stop working
    /// the moment failover moved the customer, and would do it silently.
    split_tunnel: SplitTunnel,
    /// The filters of a session phase one has ended, held between its
    /// first two steps and nowhere else.
    ///
    /// `kill_engines` ends the session -- it has to, to take the engine
    /// -- and `release_kernel_filters` is the step that releases them,
    /// after the engine is gone. The teardown's order is its own tested
    /// module, so the hand-over is a field rather than a reordering; it
    /// is `None` at every other moment.
    ending_filters: Option<SessionFilters>,
    /// What happened to the tunnel's own DNS rule on this session.
    ///
    /// Beside `ipv6_block` and for the same reason: the app puts this in
    /// front of the customer in words, so it has to be a fact about the
    /// machine rather than a guess from the protocol name. WireGuard
    /// installs its own DNS and a Custom-mode tunnel deliberately leaves
    /// the machine's lookups alone, and both are `NotRequested` -- which
    /// is not a complaint and must never be shown as one.
    ///
    /// Collected from `dns::tunnel_dns()` at the end of a connect rather
    /// than passed back up: `xray::configure_adapter` installs the rule
    /// from a free function two frames below any `Engines`, so there is
    /// nowhere to return it to. See `dns::TunnelDns` for the decision it
    /// records, which is that a tunnel comes up even when this fails and
    /// the customer is told.
    dns_state: dns::TunnelDns,
    /// Which session is live and whether the last one ended on its own.
    /// Shared with the pipe, which reads it without the owning thread --
    /// see `lifecycle::engine_watch::Ledger`.
    ledger: Arc<Ledger>,
    /// Where a watch reports an engine that ended on its own. `None`
    /// until the pipe installs one, and in tests that drive `Engines`
    /// directly; the ledger is written either way.
    engine_gone: Option<EngineGone>,
    /// The last WireGuard handshake reading and when it was taken. See
    /// [`HANDSHAKE_REUSE_FOR`].
    handshake_reading: Option<(Instant, wireguard::HandshakeHealth)>,
    /// How the WireGuard tunnel service's state is read. See [`ScmQuery`].
    wireguard_scm: ScmQuery,
    /// How many sessions have been ended, by any route. For the tests
    /// that prove a dead engine racing a Disconnect is torn down once.
    #[cfg(test)]
    sessions_ended: u32,
}

impl Engines {
    pub fn new(exe_dir: PathBuf, config_dir: PathBuf) -> Self {
        let ledger = Arc::new(Ledger::new());
        Self {
            exe_dir,
            config_dir,
            active: Slot::with_ledger(Arc::clone(&ledger)),
            split_tunnel: SplitTunnel::new(),
            ending_filters: None,
            dns_state: dns::TunnelDns::NotRequested,
            ledger,
            engine_gone: None,
            handshake_reading: None,
            wireguard_scm: Arc::new(wireguard::scm_view),
            #[cfg(test)]
            sessions_ended: 0,
        }
    }

    /// The ledger, for the pipe to answer a status from while the owning
    /// thread is busy.
    pub fn ledger(&self) -> Arc<Ledger> {
        Arc::clone(&self.ledger)
    }

    /// Where to report an engine that has ended on its own.
    ///
    /// Called on the watch thread, so it must only hand the work on --
    /// the pipe's queues a teardown on the owning thread. Applies to
    /// sessions begun after this is set.
    pub fn when_an_engine_ends(&mut self, sink: EngineGone) {
        self.engine_gone = Some(sink);
    }

    /// Replaces the customer's Custom-mode selection, and makes it true
    /// of the tunnel that is up right now.
    ///
    /// Editing the list is cheap: the redirect reads the selection per
    /// decision, so adding a second game never drops the first one's
    /// session and nothing is rebuilt.
    ///
    /// Turning the mode on or off is not cheap, because it changes the
    /// *shape* of the tunnel. A full tunnel owns the default route; a
    /// Custom-mode tunnel deliberately owns no routes at all and reaches
    /// selected applications through the redirect instead. That is
    /// decided when the engine starts, so switching means building the
    /// tunnel again.
    ///
    /// It used to just record the choice and wait for the next connect.
    /// A tester turned Custom mode on while connected, watched nothing
    /// happen, and reasonably concluded the feature was broken -- then
    /// restarted the app to make it take, which is how they ended up in
    /// a state where the app said connected and their applications had
    /// no route to anywhere.
    ///
    /// So the rebuild happens here, from the profile the live tunnel was
    /// built with. Failure is returned rather than swallowed: a switch
    /// that leaves no tunnel up must not look like success.
    pub fn set_split_tunnel(&mut self, config: SplitTunnelConfig) -> Result<(), String> {
        let was_passive = self.split_tunnel.wants_passive_tunnel();
        let was_intercepting = self.split_tunnel.wants_interception();
        let was_mode = self.split_tunnel.mode();
        self.split_tunnel.set_selection(config);
        let now_passive = self.split_tunnel.wants_passive_tunnel();
        let now_intercepting = self.split_tunnel.wants_interception();
        let now_mode = self.split_tunnel.mode();

        if self.active.is_empty() {
            // No tunnel, so there is no shape to change and the choice
            // just waits for the next connect.
            //
            // It does not follow that there is nothing to do. A session
            // whose engine died leaves this slot empty while the
            // redirect loop is still up, and that is the state the
            // 2026-08-23 field bug produced -- in which the customer's
            // most obvious move, turning Custom mode off, returned
            // success here and changed nothing at all. Stopping is
            // cheap and it is a no-op when nothing is running.
            self.split_tunnel.stop();
            return Ok(());
        }

        // Interception changed but the tunnel's shape did not: turning
        // "everything except these" on or off, where the tunnel carries
        // the machine either way. Restarting the redirect in place is
        // enough, and is what keeps the switch immediate -- rebuilding
        // the tunnel would drop every live connection to change
        // something the tunnel does not care about.
        if was_passive == now_passive {
            if was_intercepting != now_intercepting || was_mode != now_mode {
                let Some(profile) = self.active.peek().map(|s| s.profile.clone()) else {
                    return Err(
                        "Custom mode changed, but this tunnel cannot be rebuilt without reconnecting."
                            .to_string(),
                    );
                };
                self.split_tunnel.stop();
                // A separate request, so its own boundary read rather
                // than a token borrowed from a connect that has finished.
                return self.start_split_tunnel(
                    &profile,
                    &crate::lifecycle::budget::Limits::new(
                        current_token(),
                        crate::lifecycle::budget::CONNECT_BUDGET.limit,
                    ),
                );
            }
            // Editing the list within a mode changes nothing about how
            // the tunnel is built, and the redirect reads the selection
            // per packet.
            return Ok(());
        }
        let Some(profile) = self.active.peek().map(|s| s.profile.clone()) else {
            // Nothing to rebuild from. Saying so is better than leaving
            // the customer with a tunnel that contradicts the toggle.
            return Err(
                "Custom mode changed, but this tunnel cannot be rebuilt without reconnecting."
                    .to_string(),
            );
        };
        self.connect(&profile, &[])
    }

    pub fn split_tunnel_running(&self) -> bool {
        self.split_tunnel.is_running()
    }

    /// Whether this session is actually blocking IPv6 right now.
    ///
    /// Read from the installed block rather than inferred from the
    /// protocol, because the app puts this in front of the customer in
    /// words and the two can differ: a WireGuard session has no block of
    /// ours at all, and an install that failed leaves none either. The
    /// rule in this product is that the UI never reports a state nothing
    /// verified, and "IPv6 is blocked" is exactly such a state.
    pub fn ipv6_blocked(&self) -> bool {
        self.active.peek().is_some_and(|s| s.filters.ipv6.is_some())
    }

    /// Whether this session asked for the tunnel's DNS rule and did not
    /// get it. `false` is not a claim that DNS is protected -- see
    /// [`dns::TunnelDns`].
    pub fn tunnel_dns_unprotected(&self) -> bool {
        self.dns_state.unprotected()
    }

    /// Drops what this service can claim about the machine's lookups.
    ///
    /// Called from `disconnect` and at the top of a connect. Separate
    /// from the field so the discipline can be tested without running a
    /// teardown that touches the machine -- a stale complaint surviving
    /// into the next session is the failure that matters here, and it is
    /// a one-line mistake to make.
    fn forget_dns_state(&mut self) {
        self.dns_state = dns::TunnelDns::NotRequested;
    }

    /// Installs a session around a process the test started, exactly as a
    /// connect would -- watch included -- without touching the network.
    /// Returns its generation.
    #[cfg(test)]
    pub(crate) fn begin_test_session(&mut self, protocol: &'static str, child: Child) -> u64 {
        self.begin_session(Active::Child { protocol, child, routes: InstalledRoutes::none() }, &test_profile());
        self.active.peek().map_or(0, |s| s.generation)
    }

    /// The same, with the first watch on `first_watch` instead of the
    /// process -- for a source that reports an ending the process then
    /// contradicts, which is what a restarted WireGuard tunnel service or
    /// an IKEv2 connection moved by MOBIKE look like from here. A watch
    /// started again afterwards is on the process, as in a real session.
    #[cfg(test)]
    pub(crate) fn begin_test_session_watched_by(
        &mut self,
        protocol: &'static str,
        child: Child,
        first_watch: Box<dyn engine_watch::Liveness>,
    ) -> u64 {
        let generation = self
            .active
            .fill(Session::new(Active::Child { protocol, child, routes: InstalledRoutes::none() }, &test_profile()));
        let guard = engine_watch::watch(generation, protocol, first_watch, self.report_to()).expect("starting a watch");
        if let Some(session) = self.active.peek_mut() {
            session.watch = Some(guard);
        }
        generation
    }

    /// A WireGuard session over a scripted service manager. Nothing is
    /// installed; the script is what the watch, phase one and `status`
    /// read the tunnel service's state from.
    #[cfg(test)]
    fn begin_test_wireguard_session(
        &mut self,
        scm: impl Fn() -> wireguard::ScmView + Send + Sync + 'static,
    ) -> u64 {
        self.wireguard_scm = Arc::new(scm);
        self.begin_session(Active::WireguardTunnel, &test_profile());
        self.active.peek().map_or(0, |s| s.generation)
    }

    #[cfg(test)]
    pub(crate) fn has_session(&self) -> bool {
        !self.active.is_empty()
    }

    /// Whether the live session has a watch thread still running.
    #[cfg(test)]
    pub(crate) fn session_is_watched(&self) -> bool {
        self.active
            .peek()
            .and_then(|s| s.watch.as_ref())
            .is_some_and(|w| !w.finished().load(std::sync::atomic::Ordering::Acquire))
    }

    /// How many times the live session's watch has been started again.
    #[cfg(test)]
    pub(crate) fn session_rearms(&self) -> u32 {
        self.active.peek().map_or(0, |s| s.rearms)
    }

    #[cfg(test)]
    pub(crate) fn sessions_ended(&self) -> u32 {
        self.sessions_ended
    }

    /// Puts a session into a given DNS state without connecting.
    ///
    /// The pipe test needs a session that reports a complaint, and the
    /// only honest way to get one otherwise is to bring a tunnel up on
    /// the machine running the tests.
    #[cfg(test)]
    pub(crate) fn set_dns_state_for_test(&mut self, state: dns::TunnelDns) {
        self.dns_state = state;
    }

    /// What Custom mode's packet counters say is wrong, for the status
    /// poll. `None` while it is healthy or not running.
    pub fn split_tunnel_complaint(&self) -> Option<String> {
        self.split_tunnel.complaint()
    }

    /// Where each selected application's traffic is leaving from. See
    /// `SplitTunnel::exit_placements` for what this does and does not
    /// claim.
    pub fn exit_placements(&self) -> (Option<String>, Vec<neoconnect_ipc::AppPlacement>) {
        self.split_tunnel.exit_placements()
    }

    /// Applications the customer selected while they were already
    /// running, and which are still running.
    ///
    /// `&mut self` because answering re-checks which of them are still
    /// alive, so the notice clears itself the moment the customer
    /// restarts one. See `SplitTunnel::restart_needed`.
    pub fn split_tunnel_restart_needed(&mut self) -> Vec<String> {
        self.split_tunnel.restart_needed()
    }

    /// Proves the tunnel carries traffic, over the path selected apps
    /// use. See `SplitTunnel::probe` for why the app cannot check this
    /// for itself once Custom mode is on.
    pub fn probe_split_tunnel(&self) -> Result<(), String> {
        self.split_tunnel.probe()
    }

    /// Resolves an engine binary from the service's own directory.
    ///
    /// This is the reason the IPC protocol carries no paths: the set of
    /// programs this service can execute is fixed at build time and
    /// rooted next to itself, so a caller -- even a fully compromised
    /// one -- cannot point it at an arbitrary executable and get code
    /// running as SYSTEM.
    fn engine_path(&self, file_name: &str) -> Result<PathBuf, String> {
        let path = self.exe_dir.join(file_name);
        if !path.is_file() {
            return Err(format!("{file_name} is missing from the installation"));
        }
        Ok(path)
    }

    fn config_path(&self, file_name: &str) -> PathBuf {
        self.config_dir.join(file_name)
    }

    /// Tears down whatever is up, then brings up `profile`. Teardown
    /// happens first and unconditionally so that switching servers can
    /// never leave two engines fighting over the system routing table.
    /// Wraps the real work so that EVERY failure path picks up the hint,
    /// rather than the two or three someone remembered to decorate.
    pub fn connect(&mut self, profile: &ConnectProfile, exits: &[ExitProfile]) -> Result<(), String> {
        // Noted before the attempt, reported only if it fails.
        //
        // Another VPN that is up owns the default route, and two clients
        // fighting over it produces a tunnel that connects and then
        // carries nothing -- which is indistinguishable, from the
        // customer's side, from our engine being broken. Naming the
        // other one turns "it doesn't work" into something they can act
        // on.
        //
        // Not a refusal. Plenty of these coexist fine -- a split-tunnel
        // corporate client, an idle ZeroTier -- and blocking on a guess
        // would stop people connecting for no reason, which is worse
        // than the fault being diagnosed. So it only ever decorates an
        // error that was going to happen anyway.
        // Every adapter this service brings up, or the hint accuses the
        // customer's own Neoxify tunnel of being a rival VPN. That is not
        // hypothetical: enabling Custom mode on a live OpenVPN connection
        // reported "Another VPN is connected on this machine
        // (Neoxify-OpenVPN)", pointing at the very tunnel being rebuilt.
        let rivals = adapters::other_vpns_up(&[
            xray::ADAPTER_NAME,
            wireguard::TUNNEL_NAME,
            openvpn::ADAPTER_NAME,
            ikev2::ENTRY_NAME,
        ])
        .unwrap_or_default();
        // The one place the published token is read on this path.
        //
        // Below here cancellation is a parameter. That is the whole
        // point: the split tunnel went thirty-eight seconds without
        // checking for a disconnect because nothing was ever passed to
        // it, and a global is a thing an author can simply not know
        // about, where an argument is a thing they have to decide about.
        // One lookup, at the boundary, and then it travels explicitly.
        // The boundary builds both facts at once: the published
        // token, and the clock the whole connect has to answer by.
        let limits = crate::lifecycle::budget::Limits::new(
            current_token(),
            crate::lifecycle::budget::CONNECT_BUDGET.limit,
        );
        // The profile Custom mode rebuilds from is the session's own,
        // so a failed attempt -- which ends whatever session it began --
        // cannot leave one behind.
        self.connect_inner(profile, exits, &limits)
            .map_err(|e| with_rival_hint(e, &rivals))
    }

    fn connect_inner(
        &mut self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        limits: &crate::lifecycle::budget::Limits,
    ) -> Result<(), String> {
        profile.validate().map_err(|e| e.to_string())?;

        // A drop recorded from an earlier session stops being the answer
        // the moment a new connect begins. Left standing, a status
        // answered from the ledger while this connect holds the owning
        // thread would report the old tunnel's death over the new one.
        self.ledger.forget();

        // Asked before the teardown, not only after it.
        //
        // The `disconnect` below is the clear-the-decks pass every
        // connect starts with, and it is not cheap: it can stop a tunnel
        // service, purge routes and sweep DNS. The first cancellation
        // check used to sit after it, so a disconnect arriving in the
        // instant a connect began was answered only once that whole pass
        // had run. Asking first costs a mutex and is the difference
        // between a button that responds and one that responds
        // eventually.
        if limits.cancelled() {
            return Err(ABANDONED.to_string());
        }

        self.disconnect()?;
        // Belt and braces with `disconnect`'s own reset: a connect that
        // fails part way must not leave the previous session's DNS
        // complaint attached to nothing.
        self.forget_dns_state();
        // Checked between the stages as well as inside the waits, so a
        // customer who pressed Disconnect gets the tunnel left down
        // rather than watching it come back up because the request that
        // was already running finished its job.
        if limits.cancelled() {
            return Err(ABANDONED.to_string());
        }

        // Decided once, up front. Every engine below has to know whether
        // to install its own routes, and asking again per branch invites
        // one of them to disagree -- which would show up as a full
        // tunnel for a customer who asked for one app.
        let passive = self.split_tunnel.wants_passive_tunnel();

        match profile {
            ConnectProfile::Wireguard(p) => {
                wireguard::connect(self, p, passive, limits)?;
                self.begin_session(Active::WireguardTunnel, profile);
            }
            // Nothing is spawned: Windows brings the interface up and
            // routes it. Custom mode works here too now -- the entry is
            // created with -SplitTunneling so Windows leaves the default
            // route alone, and the split tunnel pins to the RAS
            // interface like it pins to any other adapter.
            ConnectProfile::Ikev2(p) => {
                let live = ikev2::connect(p, passive)?;
                self.begin_session(Active::Ikev2(live), profile);
            }
            // Both Xray protocols take the same path: one engine, one
            // adapter, one set of routes -- only the outbound differs.
            ConnectProfile::XrayVlessReality(_)
            | ConnectProfile::XrayVlessTls(_)
            | ConnectProfile::XrayTrojan(_)
            | ConnectProfile::Shadowsocks(_) => {
                let (outbound, protocol) = match profile {
                    ConnectProfile::XrayVlessReality(p) => {
                        (xray::Outbound::VlessReality(p), "XRAY_VLESS_REALITY")
                    }
                    ConnectProfile::XrayVlessTls(p) => {
                        (xray::Outbound::VlessTls(p), "XRAY_VLESS_TLS")
                    }
                    ConnectProfile::XrayTrojan(p) => (xray::Outbound::Trojan(p), "XRAY_TROJAN"),
                    ConnectProfile::Shadowsocks(p) => {
                        (xray::Outbound::Shadowsocks(p), "SHADOWSOCKS")
                    }
                    _ => unreachable!("outer match restricts this to the Xray protocols"),
                };

                // The concurrent exits this session will carry, if
                // any. Built here rather than in `xray::connect`
                // because it is the one place that holds both the
                // request's profiles and the split tunnel they have to
                // be registered with.
                //
                // Dropped entirely for a non-Xray primary -- the outer
                // match makes that unreachable, and
                // `ConnectProfile::carries_concurrent_exits` is what
                // says so for the branches that are not here.
                //
                // Truncated rather than refused at
                // `MAX_CONCURRENT_EXITS`, the last of the three places
                // that ceiling is applied: refusing at this point would
                // fail the whole connect over a preference, which is
                // the one thing every rule about exits agrees must not
                // happen.
                let mut extra: Vec<(String, xray::Outbound)> = Vec::new();
                for exit in exits.iter().take(neoconnect_ipc::MAX_CONCURRENT_EXITS) {
                    // An exit whose own profile is not Xray-carried is
                    // dropped, not refused. It cannot become an
                    // outbound in this config, and failing the connect
                    // would take a working session down over a game's
                    // preference.
                    let Some(exit_outbound) = xray_outbound_for(&exit.profile) else {
                        continue;
                    };
                    if exit.profile.validate().is_err() {
                        continue;
                    }
                    extra.push((exit.exit.clone(), exit_outbound));
                }

                let (mut child, table) =
                    xray::connect_returning_exits(self, &outbound, &extra, passive)?;
                // Registered before the routes and before the session
                // is filled in, so that no flow can be decided against
                // a table that is not there yet. Interception does not
                // start until `start_split_tunnel`, which is later
                // still.
                self.split_tunnel.set_exits(table);
                // Xray creates the adapter but routes nothing into it, so
                // the tunnel is inert until this succeeds. Failing here
                // must take the engine down with it rather than leave a
                // process running that reports connected and carries no
                // traffic. In Custom mode the adapter still has to be
                // given an address -- a socket pinned to an interface
                // with none has no source to send from -- but nothing is
                // routed into it.
                let prepared = if passive {
                    xray::prepare_passive(&outbound, limits).map(|_| InstalledRoutes::none())
                } else {
                    xray::install_routes(&outbound, limits)
                };
                let routes = match prepared {
                    Ok(routes) => routes,
                    Err(e) => {
                        let _ = child.kill();
                        reap(&mut child);
                        return Err(e);
                    }
                };
                self.begin_session(Active::Child { protocol, child, routes }, profile);
            }
            ConnectProfile::Openvpn(p) => {
                let child = openvpn::connect(self, p, passive, limits)?;
                let engine = Active::Child { protocol: "OPENVPN", child, routes: InstalledRoutes::none() };
                self.begin_session(engine, profile);
            }
        }

        if limits.cancelled() {
            let _ = self.disconnect();
            return Err(ABANDONED.to_string());
        }

        // Interception, not passivity -- and the reason is no longer the
        // one this comment used to give.
        //
        // It claimed "everything except these" built a *full* tunnel and
        // pushed the chosen applications out of it, so asking about
        // passivity would answer no and skip the redirect. That belief
        // was wrong and `SplitTunnel::wants_interception` says so at
        // length: `mode` reaches two places in that file, the selection
        // and the log header, so no branch anywhere builds a different
        // shape of tunnel for AllExcept. One shape, proven by one route
        // probe.
        //
        // The call is still the right one to make, because it is the
        // question actually being asked here -- does anything need
        // intercepting -- rather than because the two answers differ.
        // They do not: `wants_passive_tunnel` is defined as this.
        if self.split_tunnel.wants_interception() {
            self.start_split_tunnel(profile, limits)?;
        }
        self.block_ipv6_if_needed(profile);
        // Whatever the engine above reported about the tunnel's DNS
        // rule, collected onto the session now that there is one. Read
        // rather than returned because the engines install it from free
        // functions with no `Engines` to hand it back to.
        self.dns_state = dns::tunnel_dns();
        Ok(())
    }

    /// Blocks IPv6 for a full tunnel, on the engines that would
    /// otherwise leak it.
    ///
    /// Two gates, and both are load-bearing.
    ///
    /// **Custom mode is excluded**, which is what `wants_interception`
    /// asks. The 0.9.27 block in `split_tunnel/redirect.rs` already
    /// covers that path, and covers it *per application*: a selected
    /// app's IPv6 is dropped and an unselected one's is left exactly as
    /// it was, which is the whole premise of a split tunnel. Installing
    /// a machine-wide block on top would change the behaviour of
    /// applications the customer deliberately kept out of the VPN --
    /// a policy change nobody asked for, and one they could not undo
    /// without disconnecting.
    ///
    /// That leaves one honest gap: in "everything except these", the
    /// applications the customer excluded keep their IPv6, and so does
    /// everything else on the machine, because that mode also runs
    /// through the redirect. It is stated here rather than papered over.
    ///
    /// **WireGuard is excluded** because `wireguard.exe` installs its
    /// own; see `ipv6_block::needed_for`.
    ///
    /// A failure is logged and not returned. The tunnel is up and
    /// carrying IPv4 at this point, and tearing it down over a filter
    /// that would not install leaves the customer with nothing rather
    /// than with less than they wanted -- but it must not be reported as
    /// a block either, which is why the field stays `None` and the app's
    /// status follows the field.
    fn block_ipv6_if_needed(&mut self, profile: &ConnectProfile) {
        let filters = self.filters_for(profile);
        // Owned by the session from here. There is always one at this
        // point -- this runs after the engine is in the slot -- and if
        // somehow there were not, dropping the filters releases them,
        // which is the right outcome for filters with no tunnel.
        if let Some(session) = self.active.peek_mut() {
            session.filters = filters;
        }
    }

    /// Installs whatever this tunnel needs, and returns it to be owned by
    /// the session.
    fn filters_for(&self, profile: &ConnectProfile) -> SessionFilters {
        let mut filters = SessionFilters::default();
        if self.split_tunnel.wants_interception() {
            return filters;
        }
        let dns = self.dns_confinement_for(profile);
        if !ipv6_block::needed_for(profile) {
            // WireGuard: its own kill-switch blocks IPv6, but not DNS
            // leaving by the physical NIC. See `Ipv6Block::install_dns_only`.
            if let Some(dns) = dns {
                match Ipv6Block::install_dns_only(&self.config_dir, &dns) {
                    Ok(block) => filters.dns_only = Some(block),
                    Err(e) => eprintln!("DNS could not be confined to the tunnel: {e}"),
                }
            }
            return filters;
        }
        let installed = match Ipv6Block::install(&self.config_dir, dns.as_ref()) {
            // The DNS filters share the IPv6 block's transaction, so a
            // rejection of theirs would take the IPv6 block down with
            // them. Losing DNS confinement must not cost the IPv6 block,
            // which was measured leaking on its own -- so try again with
            // the block alone. The failure is in ipv6-block.log either
            // way.
            Err(e) if dns.is_some() => {
                eprintln!("DNS could not be confined to the tunnel: {e}");
                Ipv6Block::install(&self.config_dir, None)
            }
            other => other,
        };
        match installed {
            Ok(block) => filters.ipv6 = Some(block),
            Err(e) => eprintln!("IPv6 could not be blocked for this tunnel: {e}"),
        }
        filters
    }

    /// Whether this tunnel's DNS needs confining to it, and to what.
    ///
    /// Every engine but OpenVPN, whose config already carries
    /// `block-outside-dns`. Measured on a Windows 11 guest with a query
    /// deliberately made the way Windows' own connectivity probes make
    /// theirs, capture at the NIC miniport: Xray leaked those probes;
    /// WireGuard let a query bound to the physical NIC reach its
    /// configured resolver in clear text; IKEv2 let a query to the
    /// on-link resolver -- on a real network, the router, and from there
    /// the ISP -- out and answered. OpenVPN refused all three. See
    /// `ipv6_block::DnsConfinement`.
    ///
    /// `None` when the adapter cannot be found, which is logged rather
    /// than fatal for the same reason the IPv6 block's own failure is:
    /// the tunnel is carrying traffic, and refusing it over a filter
    /// would leave the customer with less, not more.
    fn dns_confinement_for(&self, profile: &ConnectProfile) -> Option<ipv6_block::DnsConfinement> {
        use neoconnect_ipc::ConnectProfile as P;
        let skip = |reason: String| {
            ipv6_block::note_not_confined(&self.config_dir, &reason);
            None
        };
        let engine_exe = match profile {
            P::Openvpn(_) => return None,
            P::XrayVlessReality(_) | P::XrayVlessTls(_) | P::XrayTrojan(_) | P::Shadowsocks(_) => {
                match self.engine_path("xray.exe") {
                    Ok(exe) => Some(exe),
                    Err(e) => return skip(e),
                }
            }
            // wireguard.exe talks to its peer, never to port 53, and the
            // IKEv2 client is the kernel's: no process of ours to permit.
            P::Wireguard(_) | P::Ikev2(_) => None,
        };
        let name = adapter_name_for(profile);
        // Polled, briefly. wireguard.exe's tunnel service brings its
        // adapter up on its own schedule, and the first version of this
        // looked once, found nothing, and left WireGuard's DNS unconfined
        // on every connect -- measured, a query bound to the physical NIC
        // still leaving after the fix had landed for every other engine.
        // Every other engine's adapter is up by now, so this costs them
        // one lookup.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let adapter = loop {
            match crate::adapters::find_by_name(name) {
                Ok(Some(adapter)) => break adapter,
                Err(e) => return skip(format!("could not list adapters: {e}")),
                Ok(None) if std::time::Instant::now() >= deadline => {
                    return skip(format!("the tunnel adapter {name} did not appear within 5s"));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        };
        match ipv6_block::DnsConfinement::new(adapter.index, engine_exe) {
            Ok(confinement) => Some(confinement),
            Err(e) => skip(e),
        }
    }

    /// Brings Custom mode up against the tunnel that was just started.
    ///
    /// A failure here tears the engine down rather than leaving it
    /// running. A passive tunnel with no redirect carries nothing at
    /// all, so reporting success would tell the customer they were
    /// protected while every application, selected or not, went out in
    /// the clear.
    fn start_split_tunnel(
        &mut self,
        profile: &ConnectProfile,
        limits: &crate::lifecycle::budget::Limits,
    ) -> Result<(), String> {
        let adapter = adapter_name_for(profile);
        let node = match node_address(profile, limits) {
            Ok(node) => node,
            Err(e) => {
                let _ = self.disconnect();
                return Err(e);
            }
        };

        let log_dir = self.config_dir.clone();
        // The subsystem that never had a token now gets the caller's.
        // Every wait inside the bring-up unwinds on a disconnect instead
        // of holding the engine state for the ~38 seconds those waits
        // add up to.
        if let Err(e) = self.split_tunnel.start(adapter, node, &log_dir, limits) {
            let _ = self.disconnect();
            return Err(e);
        }
        Ok(())
    }

    /// Installs a session and starts watching its engine.
    ///
    /// The one way into the slot, so that no engine can be running
    /// unwatched: every connect path comes through here.
    ///
    /// A watch that cannot be started is logged and not fatal. The
    /// tunnel is up and carrying traffic; refusing it over the watch
    /// would leave the customer with less, and a dead engine is still
    /// found by the status poll exactly as before this existed.
    fn begin_session(&mut self, engine: Active, profile: &ConnectProfile) {
        let label = engine.protocol();
        let liveness = engine.liveness(&self.wireguard_scm);
        let generation = self.active.fill(Session::new(engine, profile));

        let started = liveness.and_then(|liveness| {
            engine_watch::watch(generation, label, liveness, self.report_to())
        });
        match started {
            Ok(guard) => {
                if let Some(session) = self.active.peek_mut() {
                    session.watch = Some(guard);
                }
            }
            Err(e) => crate::cleanup_log::note(
                "watch the tunnel engine",
                &format!("{label}: {e}; a drop will only be noticed by the status poll"),
            ),
        }
    }

    /// What a watch does when it sees its engine end: put it on record,
    /// then hand the teardown to whoever is listening.
    ///
    /// Runs on the watch thread. The ledger decides whether it is news:
    /// a generation the service has already closed is its own teardown,
    /// and nothing is reported. A wait that failed is not recorded --
    /// nothing is known -- but is still handed on while the session is
    /// live, because the teardown checks the engine itself before it
    /// acts. An ending from a source that can come back is recorded
    /// unconfirmed, and answers no status until that check confirms it.
    fn report_to(&self) -> engine_watch::OnGone {
        let ledger = Arc::clone(&self.ledger);
        let sink = self.engine_gone.clone();
        Arc::new(move |gone: engine_watch::Gone| {
            let news = if gone.definitive {
                ledger.record(gone.generation, gone.detail, gone.at, !gone.may_return)
            } else {
                ledger.is_live(gone.generation)
            };
            if news {
                if let Some(sink) = &sink {
                    sink(gone.generation);
                }
            }
        })
    }

    /// Phase one after an engine has ended on its own: take down what the
    /// session left behind, now, rather than on the next status poll.
    ///
    /// Returns whether it tore the session down, which is when phase two
    /// is owed. It does nothing -- and that is the common, correct
    /// outcome of a race -- when the session is no longer the one the
    /// watch was started for (a Disconnect, a connect or a status poll
    /// got there first).
    ///
    /// When the engine, asked directly, turns out not to have ended, the
    /// report was a moment rather than an ending: a WireGuard tunnel
    /// service the manager stopped and is starting again, an IKEv2
    /// connection out of `Connected` while MOBIKE moved it, a wait that
    /// failed. The watch that reported it has finished, so this does two
    /// things before returning: it takes back what the watch put on
    /// record -- left there, the status and Disconnect fallbacks would go
    /// on answering "no tunnel" for a live one -- and it starts the watch
    /// again, or the session would go unwatched for the rest of its life.
    ///
    /// Only releases things. Fail open is a product decision: nothing
    /// here blocks traffic or brings a tunnel back. What changes is that
    /// the machine is put back within a second of the engine dying
    /// instead of up to fifteen, and that in that gap the session's
    /// filters no longer hold plain DNS and IPv6 hostage to a tunnel that
    /// is gone. See [`Self::tear_down_dead_session`].
    pub fn end_dead_session(&mut self, generation: u64) -> bool {
        // What the watch put on record, if anything: a definite ending
        // from the kernel or RAS, as opposed to a wait that failed.
        let on_record = self
            .ledger
            .ended_without_successor()
            .is_some_and(|ended| ended.generation == generation);
        let scm = Arc::clone(&self.wireguard_scm);
        let ended = match self.active.peek_mut() {
            Some(session) if session.generation == generation => match session.engine.has_ended(&scm) {
                Some(ended) => ended,
                // RAS cannot say right now. Its own notification already
                // did, and that is what a record means; without one there
                // is nothing to act on.
                None => on_record,
            },
            _ => return false,
        };
        if ended {
            self.ledger.confirm(generation);
            self.tear_down_dead_session(Noticed::ByWatch);
            return true;
        }
        let retracted = self.ledger.retract(generation);
        self.rearm_watch(retracted);
        false
    }

    /// Starts the live session's watch again, after a report its engine
    /// contradicted. See [`Self::end_dead_session`].
    ///
    /// Spaced: a watch armed within [`REARM_SPACING`] of the last one
    /// waits that long before its first look, so a source that keeps
    /// reporting endings the engine keeps contradicting costs one look a
    /// second rather than a loop through this thread.
    fn rearm_watch(&mut self, retracted: bool) {
        let report = self.report_to();
        let scm = Arc::clone(&self.wireguard_scm);
        let Some(session) = self.active.peek_mut() else {
            return;
        };
        let label = session.engine.protocol();
        let too_soon = session.armed_at.elapsed() < REARM_SPACING;
        session.armed_at = Instant::now();
        session.rearms = session.rearms.saturating_add(1);
        // The old guard's thread has already returned -- it reported, and
        // that is the last thing a watch does -- so this only closes its
        // stop event.
        drop(session.watch.take());
        let started = session.engine.liveness(&scm).and_then(|liveness| {
            let liveness: Box<dyn engine_watch::Liveness> = if too_soon {
                Box::new(engine_watch::Settle::new(liveness, REARM_SPACING))
            } else {
                liveness
            };
            engine_watch::watch(session.generation, label, liveness, report)
        });
        let rearms = session.rearms;
        let outcome = match started {
            Ok(guard) => {
                session.watch = Some(guard);
                "watching it again".to_string()
            }
            Err(e) => format!("the watch could not be started again ({e}); a drop will only be noticed by the status poll"),
        };
        if rearms <= REARMS_LOGGED {
            crate::cleanup_log::note(
                "the tunnel engine was reported ended but is still running",
                &format!(
                    "{label}: {}; {outcome}{}",
                    if retracted { "the report was taken back" } else { "the watch's wait failed" },
                    if rearms == REARMS_LOGGED { "; further ones this session are not logged" } else { "" }
                ),
            );
        }
    }

    /// Phase two after an engine ended on its own: the thorough pass.
    ///
    /// The same `disconnect()` that runs behind a customer's Disconnect,
    /// on what is by now an empty slot -- the WireGuard tunnel service a
    /// dead tunnel leaves registered (and `StartAutomatic`), the IKEv2
    /// phonebook entry, orphaned engines, the generated configs with
    /// their credentials. Queued behind phase one rather than run in it,
    /// because some of it is slow and nobody is waiting on it.
    ///
    /// Only while nothing has begun since. A connect that started in
    /// between has already run this pass for itself, and running the
    /// janitor now would take that connect's own engine for an orphan.
    pub fn finish_dead_session(&mut self, generation: u64) {
        if !self.active.is_empty() || !self.ledger.is_latest(generation) {
            return;
        }
        if let Err(message) = self.disconnect() {
            crate::cleanup_log::note("thorough teardown after the tunnel engine ended", &message);
        }
    }

    /// Takes down a session whose engine has already ended.
    ///
    /// One body for both witnesses -- the engine watch and the status
    /// poll -- because two copies of a teardown are how one of them comes
    /// to forget a step; the history of this file is mostly that.
    ///
    /// Phase-one rules (docs/windows-service-rewrite.md): no PowerShell,
    /// no waiting for anything to disappear. At most three `route.exe`
    /// for Xray's own routes or two for OpenVPN's pushed ones, the same
    /// allowance the hard stop has, and for the same reason -- the record
    /// of which routes were installed ends with the session.
    ///
    /// The order is the order of harm. Custom mode first (inside
    /// `end_session`), because its redirect is pinned to an adapter that
    /// no longer exists and would otherwise go on swallowing the selected
    /// applications' traffic. Then the routes, then the WFP filters --
    /// whose DNS confinement permits port 53 only through the dead
    /// adapter, so until they go no plain DNS lookup on the machine
    /// succeeds -- then the NRPT rule, by registry.
    fn tear_down_dead_session(&mut self, noticed: Noticed) {
        let Some(generation) = self.active.peek().map(|s| s.generation) else {
            return;
        };
        // On record before the generation closes, so a death the status
        // poll found first is a drop like one the watch found. Keeps the
        // first witness's time if the watch already recorded it, and is
        // certain either way: both callers have asked the engine itself.
        self.ledger.record(generation, None, Instant::now(), true);
        let ended = self.ledger.ended_without_successor().filter(|e| e.generation == generation);

        let engine = self.end_session();
        let protocol = engine.as_ref().map_or("unknown", Active::protocol);
        match engine {
            Some(Active::Child { protocol, mut child, mut routes }) => {
                routes.remove();
                // OpenVPN's pushed half-defaults sit on an adapter that is
                // kept between sessions, so they do not go with the
                // process. By destination, as the hard stop does.
                if protocol == "OPENVPN" {
                    if let Ok(Some(adapter)) = adapters::find_by_name(openvpn::ADAPTER_NAME) {
                        routing::purge_pushed_half_defaults(adapter.index);
                    }
                }
                // Already exited, so this is one look; it collects the
                // process so nothing of it lingers in the kernel.
                reap(&mut child);
            }
            // RAS has already dropped it. Hanging up the handle releases
            // it -- one API call, and harmless on a dead connection.
            Some(Active::Ikev2(live)) => {
                let _ = live.hang_up();
            }
            Some(Active::WireguardTunnel) | None => {}
        }
        self.unblock_ipv6();
        let dns = dns::clear_registry_only();
        self.forget_dns_state();

        // What the number is depends on who gave it.
        let code_is = match protocol {
            "IKEV2" => "RAS error",
            "WIREGUARD" => "service exit code",
            _ => "exit code",
        };
        let mut detail = format!(
            "{protocol}{}, noticed by {}",
            match ended.as_ref().and_then(|e| e.detail) {
                Some(code) => format!(", {code_is} {code}"),
                None => String::new(),
            },
            match noticed {
                Noticed::ByWatch => "the engine watch",
                Noticed::ByStatus => "a status poll",
            }
        );
        if let Some(e) = &ended {
            let _ = std::fmt::Write::write_fmt(
                &mut detail,
                format_args!("; routes, filters and DNS rule released {}ms after it was seen", e.at.elapsed().as_millis()),
            );
        }
        if let Some(why) = dns.unverified {
            let _ = std::fmt::Write::write_fmt(&mut detail, format_args!("; the DNS rule was not verifiably removed: {why}"));
        }
        crate::cleanup_log::note("the tunnel engine ended on its own", &detail);
    }

    /// Ends the session and hands back the engine that was running.
    ///
    /// The single funnel every teardown goes through -- an explicit
    /// Disconnect, a connect that starts by clearing the decks, and the
    /// status poll noticing an engine died on its own. Stopping Custom
    /// mode happens here, once, inside [`Slot::end`], rather than at
    /// each of those call sites where one of them can be forgotten. It
    /// was, and the customer's whole machine lost DNS for it.
    fn end_session(&mut self) -> Option<Active> {
        let mut session = self.active.end(&mut self.split_tunnel)?;
        // The watch goes first, before the engine is handed back to be
        // killed. `Slot::end` has already closed the generation, so the
        // ledger would refuse the kill as a drop anyway; ending the
        // watch here means its thread is not left waiting on a process
        // nobody cares about any more.
        drop(session.watch.take());
        self.handshake_reading = None;
        #[cfg(test)]
        {
            self.sessions_ended += 1;
        }
        // The DNS state is a claim about this session's rule, so it ends
        // with it -- on every path, including a status poll finding the
        // engine dead, which used to leave the last session's complaint
        // standing.
        self.forget_dns_state();
        // The profile is dropped with the session: a Custom-mode toggle
        // after a disconnect must not resurrect a connection the
        // customer ended, and after an engine died there is nothing to
        // rebuild towards. The filters are parked for the caller's
        // release step -- every caller has one, after the engine is
        // gone -- and anything parked before is released now rather
        // than replaced, so no filter can be orphaned by this.
        if let Some(earlier) = self.ending_filters.replace(session.filters) {
            earlier.release();
        }
        Some(session.engine)
    }

    /// Releases the filters of the session just ended: the machine-wide
    /// IPv6 block (with the DNS confinement in it) and WireGuard's
    /// DNS-only confinement.
    ///
    /// Dropping a block's handle ends its dynamic WFP session, which is
    /// what removes the filters, so releasing twice is a no-op.
    ///
    /// The same property is what makes a crash safe: the session belongs
    /// to this process, so the kernel tears it down when the process
    /// dies whether or not any of this code ran. There is deliberately
    /// no boot-time or persistent filter that could survive to strand a
    /// customer's networking.
    fn unblock_ipv6(&mut self) {
        if let Some(filters) = self.ending_filters.take() {
            filters.release();
        }
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
        // The rule is going away with everything else, so what this
        // service can claim about the machine's lookups goes with it.
        self.forget_dns_state();
        let result = match self.end_session() {
            None => {
                // Still ask wireguard.exe to remove the tunnel service:
                // it outlives this process, so a service restart (or a
                // crash) would otherwise strand a tunnel up with nothing
                // tracking it.
                wireguard::remove_tunnel_if_present(self);
                // Same reasoning: the phonebook entry outlives this
                // process, so a crash or a service restart would leave
                // "Neoxify" in the customer's Windows VPN list.
                let _ = ikev2::disconnect();
                // Everything else that outlives this process and was
                // not being tracked: an orphaned engine, the firewall
                // allowance, routes on our adapters. Nothing tracked
                // means either this service has just started -- where
                // anything present is by definition a leftover -- or a
                // previous life ended without running its teardown.
                //
                // Cheap on a clean machine: no adapter means no route
                // purge, and the process scan costs one snapshot.
                //
                // The IPv6 block is deliberately not among the leftovers
                // this reaps, and the order relative to the `take` above
                // therefore does not matter. Every other side effect
                // here is one Windows keeps after the process that made
                // it is gone -- a wireguard.exe tunnel service, a RAS
                // phonebook entry, a netsh rule, a route -- which is why
                // they need reaping at all. The block is the one that
                // cleans itself up: its WFP session is opened
                // `FWPM_SESSION_FLAG_DYNAMIC`, so the kernel destroys
                // every filter in it when the owning process dies,
                // killed or otherwise. There is nothing a later life
                // could find to remove, and equally nothing it could
                // remove too early. See `ipv6_block`.
                //
                // Two consequences worth stating rather than rediscovering:
                // a service killed mid-tunnel unblocks IPv6 at the same
                // instant it stops carrying IPv4, so it fails open on
                // both rather than stranding the machine; and on this
                // arm `self.ipv6_block` is `None` by construction, since
                // it is only ever set alongside `self.active`.
                janitor::reconcile(&self.exe_dir);
                Ok(())
            }
            Some(Active::WireguardTunnel) => wireguard::disconnect(self),
            Some(Active::Ikev2(live)) => {
                // Hanging up is the urgent half and it is now a single
                // API call with no process behind it. Removing the
                // phonebook entry is tidying -- it only matters so that
                // "Neoxify" does not sit in the customer's Windows VPN
                // list, dialable by hand -- so it stays here with the
                // rest of the thorough work rather than on the path a
                // customer is waiting on.
                let code = live.hang_up();
                let removed = ikev2::remove_entry();
                if code != 0 {
                    crate::cleanup_log::note(
                        "hang up the IKEv2 tunnel",
                        &ikev2::dial_error(code),
                    );
                }
                removed
            }
            Some(Active::Child {
                mut child,
                mut routes,
                protocol,
            }) => {
                // Routes first: leaving them pointed at an adapter that is
                // about to disappear would black-hole all traffic until
                // Windows noticed.
                routes.remove();
                let _ = child.kill();
                reap(&mut child);

                // OpenVPN installs the server's pushed routes itself, so
                // they are not in `routes` above and a killed process
                // never gets to withdraw them. Done after the kill, so
                // there is nothing left running to put them back.
                if protocol == "OPENVPN" {
                    if let Ok(Some(adapter)) = adapters::find_by_name(openvpn::ADAPTER_NAME) {
                        routing::purge_interface(adapter.index);
                    }
                }
                Ok(())
            }
        };

        // Unconditionally, like the config wipe: an NRPT rule left
        // behind points the whole machine's lookups at a resolver that
        // is no longer reachable, which presents as "no website loads
        // at all" long after the VPN is gone. Cheap, and safe when
        // there is nothing to remove.
        dns::clear();
        // After the engine, not before, and unconditionally.
        //
        // It used to run first, which left a window with the tunnel
        // still up and IPv6 already unblocked -- on WireGuard's
        // `/uninstalltunnelservice` that window is seconds, and every
        // one of them is a customer who is told they are connected
        // while their IPv6 goes out in the clear. Removing it last
        // inverts the failure: the block outlives the tunnel by a
        // moment instead of the tunnel outliving the block, and a
        // moment of no IPv6 is not a leak.
        //
        // Outside the `result` match on purpose. An engine teardown
        // that fails must not leave a machine-wide filter behind --
        // that is the case where the customer has the least working
        // and can do the least about it.
        self.unblock_ipv6();
        self.wipe_generated_configs();
        result
    }

    /// Everything that must not outlive the installation.
    ///
    /// [`disconnect`](Self::disconnect) undoes the tunnel and, through
    /// its leftovers path, the orphaned engines, the firewall
    /// allowance, the routes on our adapters, the RAS entry and the
    /// NRPT rule. What it deliberately leaves is the OpenVPN adapter,
    /// kept between sessions because creating one is slow -- reasoning
    /// that inverts exactly here, since after this there is no product
    /// left on the machine that knows what that adapter is or how to
    /// remove it.
    ///
    /// Best-effort, and the tunnel teardown's own result is still what
    /// is returned: an uninstall that cannot clean up must still
    /// uninstall, or the customer is left with both problems.
    pub fn uninstall_cleanup(&mut self) -> Result<(), String> {
        let result = self.disconnect();
        if let Err(err) = openvpn::delete_adapter(self) {
            crate::cleanup_log::note("remove the OpenVPN adapter at uninstall", &err);
        }
        result
    }

    /// Removes the generated engine configs once nothing is using them.
    ///
    /// These files contain live credentials -- a WireGuard private key, an
    /// OpenVPN client certificate and key, an Xray UUID -- each of which is
    /// enough on its own to connect as that customer from any client. The
    /// directory ACL keeps non-administrators out, but there is no reason
    /// for the material to sit on disk between sessions at all, so the
    /// window it exists in is narrowed to the time a tunnel is actually up.
    ///
    /// Failures are ignored deliberately: a file that can't be removed
    /// must not turn a successful disconnect into an error the user can do
    /// nothing about.
    fn wipe_generated_configs(&self) {
        for name in ["neoconnect.conf", "xray-client.json", "neoconnect.ovpn"] {
            let _ = std::fs::remove_file(self.config_path(name));
        }
    }

    /// Reports live state rather than a remembered flag, so an engine
    /// that died on its own is reported as disconnected instead of the
    /// UI showing a tunnel that isn't there.
    /// The third element is the honest answer to "is traffic actually
    /// getting through", which the first two cannot give. A running
    /// engine is necessary but nowhere near sufficient -- see
    /// [`wireguard::handshake_health`].
    pub fn status(&mut self) -> (bool, Option<String>, TunnelHealth) {
        // Decided first, acted on second.
        //
        // Ending a session needs the split tunnel as well as the engine
        // slot, and the borrow checker will not lend out both while a
        // match on the slot is live. That is `session::Slot` doing its
        // job rather than an inconvenience it puts in the way: the arms
        // below that discover a dead engine can no longer quietly write
        // `None` into the slot, which is exactly what two of them used
        // to do, so they fall out to the one place that tears a session
        // down properly.
        let verdict = match self.active.peek_mut().map(|s| &mut s.engine) {
            // Nothing tracked is NOT the same as nothing running, and
            // treating them as the same stranded customers.
            //
            // A WireGuard tunnel service and an IKEv2 phonebook entry
            // both outlive this process -- disconnect() has always said
            // so, which is why its None arm calls
            // wireguard::remove_tunnel_if_present. So after a service
            // restart or crash with a tunnel up, `active` is None while
            // the machine is still fully tunnelled. This arm then
            // answered "disconnected" without asking anything, and the
            // app believed it.
            //
            // What that does to a customer, reported 2026-08-17: their
            // traffic still goes through the tunnel, the app says "not
            // connected" when reopened, so it offers no Disconnect
            // button -- and no other VPN can work while ours holds the
            // routes. They cannot get out of it from the UI at all.
            //
            // Asking the OS costs two cheap calls and makes the honest
            // answer available: report it up, unnamed, so the app shows
            // connected and lets them disconnect. disconnect()'s None
            // arm already knows how to tear exactly this down.
            None => {
                if wireguard::tunnel_is_running() {
                    Verdict::Reported(true, Some("WIREGUARD".to_string()), TunnelHealth::Unknown)
                } else if ikev2::is_connected() {
                    Verdict::Reported(true, Some("IKEV2".to_string()), TunnelHealth::Unknown)
                } else {
                    // Nothing tracked and nothing running. Still routed
                    // through `Dead` rather than answered here, because
                    // an untracked slot is exactly the shape the field
                    // bug left behind, and a redirect loop may well be
                    // running underneath it. Stopping one that is not
                    // there costs nothing.
                    Verdict::NothingTracked
                }
            }
            Some(Active::Ikev2(live)) => {
                // Windows owns this tunnel, so its own view is the only
                // truth available. There is no handshake to read the way
                // WireGuard has, so health stays Unknown and the app's
                // egress check is what actually proves traffic flows --
                // the same position the Xray protocols are in.
                //
                // Asked of the connection's own handle first: one RAS
                // call, where `ikev2::is_connected` launches PowerShell
                // for `Get-VpnConnection` once the entry exists -- which,
                // on this arm, it always does. That ran on every status
                // poll for as long as an IKEv2 tunnel was up. The cmdlet
                // stays only for the answer RAS could not give.
                let up = live.is_connected().unwrap_or_else(ikev2::is_connected);
                if up {
                    Verdict::Reported(true, Some("IKEV2".to_string()), TunnelHealth::Unknown)
                } else {
                    // This arm used to report Down and leave the session
                    // sitting in the slot, so a dropped IKEv2 tunnel
                    // kept Custom mode intercepting indefinitely.
                    Verdict::Dead
                }
            }
            Some(Active::WireguardTunnel) => {
                // `tunnel_is_running`, through the same query the watch
                // and phase one read -- the service manager, except in
                // the tests that script one.
                if wireguard::counts_as_running(&(self.wireguard_scm)()) {
                    // The handshake age needs `&self`, which cannot be
                    // taken while the slot is borrowed above, so it is
                    // read once the match has ended.
                    Verdict::WireguardUp
                } else {
                    Verdict::Dead
                }
            }
            Some(Active::Child { protocol, child, .. }) => match child.try_wait() {
                // `Ok(Some(_))` means it has already exited.
                //
                // Its routes are left behind pointing at an adapter that
                // no longer exists. They used to be removed here, inside
                // the borrow; `tear_down_dead_session` removes them now,
                // from the engine `end_session` hands back, so the watch
                // and this poll take the same steps in the same order.
                Ok(Some(_)) | Err(_) => Verdict::Dead,
                // Xray and OpenVPN have no equivalent of WireGuard's
                // handshake timestamp available this cheaply, so this
                // reports Unknown rather than implying evidence that was
                // never gathered. The app's egress check covers them.
                Ok(None) => {
                    Verdict::Reported(true, Some((*protocol).to_string()), TunnelHealth::Unknown)
                }
            },
        };

        match verdict {
            Verdict::Reported(up, protocol, health) => (up, protocol, health),
            Verdict::WireguardUp => {
                // Reused for a few seconds rather than read per poll; see
                // HANDSHAKE_REUSE_FOR. Cleared with the session.
                let reading = match self.handshake_reading {
                    Some((taken, reading)) if taken.elapsed() < HANDSHAKE_REUSE_FOR => reading,
                    _ => {
                        let reading = wireguard::handshake_health(self);
                        self.handshake_reading = Some((Instant::now(), reading));
                        reading
                    }
                };
                let health = match reading {
                    wireguard::HandshakeHealth::Alive { age_secs } => {
                        TunnelHealth::Alive { age_secs }
                    }
                    wireguard::HandshakeHealth::Stale { age_secs } => {
                        TunnelHealth::Stale { age_secs }
                    }
                    wireguard::HandshakeHealth::NeverHandshaked => TunnelHealth::NeverHandshaked,
                    wireguard::HandshakeHealth::Unknown => TunnelHealth::Unknown,
                };
                (true, Some("WIREGUARD".into()), health)
            }
            // Whatever this session was built on is gone. Everything
            // that outlived it comes down here -- including Custom mode,
            // which is the entire reason this goes through end_session()
            // instead of clearing the slot where it noticed.
            //
            // Fail open, deliberately. A customer with no tunnel gets
            // ordinary networking back, not a machine still held by a
            // redirect that has nowhere to send anything.
            //
            // Usually the engine watch has already done this within a
            // second of the engine ending, and the slot is empty by the
            // time a poll looks. This arm is for the session whose watch
            // could not be started, or whose report is still queued
            // behind other work on this thread: the same teardown, then
            // the same thorough pass the watch queues as phase two --
            // run inline here, as this arm always has. It reaches the
            // phonebook entry, the janitor, the DNS sweep and the
            // generated configs, which it used to do piecemeal and,
            // for the configs, not at all.
            Verdict::Dead => {
                self.tear_down_dead_session(Noticed::ByStatus);
                if let Err(message) = self.disconnect() {
                    crate::cleanup_log::note("thorough teardown after the tunnel engine ended", &message);
                }
                (false, None, TunnelHealth::Down)
            }
            // Nothing was tracked and nothing is running. Unchanged from
            // before the engine watch: this is the idle answer, and the
            // steps below are the ones it has always taken.
            Verdict::NothingTracked => {
                if let Some(Active::Ikev2(_)) = self.end_session() {
                    // The phonebook entry outlives the tunnel, and
                    // somebody who is no longer connected must not be
                    // left with "Neoxify" in their Windows VPN list.
                    let _ = ikev2::disconnect();
                }
                self.unblock_ipv6();

                // The machine-wide DNS rule outlives everything above,
                // and leaving it is how a machine ends up with no
                // internet at all.
                //
                // This arm used to stop at unblock_ipv6(), which meant
                // an engine that died on its own left the NRPT `.` rule
                // pointing every lookup on the machine at a resolver
                // that no longer exists -- while reporting `false` here,
                // so the app showed "disconnected" and the customer had
                // no reason to press Disconnect. The idle watchdog did
                // not catch it either: it gates on `if !up { continue; }`
                // and status had just said down. Nothing cleared it
                // until the next connect, an explicit disconnect, Repair,
                // or a reboot.
                //
                // Unconditional, like the calls above it: this is the
                // fail-open path. `clear()` reports its own failures
                // through cleanup_log and returns nothing, so there is
                // no result to handle here.
                dns::clear();

                // Same reasoning for everything else that only
                // disconnect() reached: a dead engine can leave an
                // orphaned xray.exe or openvpn.exe holding routes and,
                // in OpenVPN's case, block-outside-dns filters that drop
                // every lookup off the tunnel adapter.
                janitor::reconcile(&self.exe_dir);

                (false, None, TunnelHealth::Down)
            }
        }
    }
}

/// What one look at the engine slot concluded, before anything was done
/// about it. See [`Engines::status`] for why those are two steps.
enum Verdict {
    Reported(bool, Option<String>, TunnelHealth),
    /// The WireGuard tunnel service is up; its handshake age still has
    /// to be read, and that needs a borrow the slot was holding.
    WireguardUp,
    /// Whatever this session was built on is no longer running.
    Dead,
    /// No session, and nothing of ours visible on the machine.
    NothingTracked,
}

/// What the operating system says is tunnelling right now, asked
/// without the `Engines` lock.
///
/// This exists for the one question a customer must always get an answer
/// to: am I tunnelled, and can I get out? [`Engines::status`] is the
/// fuller answer and needs the lock, so while a connect or a Custom-mode
/// rebuild is in flight it cannot be given at all -- and the case where
/// that matters most is precisely the one where something has gone
/// wrong and the app has stopped hearing back.
///
/// Every check below asks Windows directly and touches nothing this
/// service owns, so it is safe to run beside an operation that is
/// halfway through changing things. It is also still evidence rather
/// than a remembered flag, which is the rule state is reported under
/// here: what it loses against the locked answer is the WireGuard
/// handshake age and which of the Xray protocols an adapter belongs to,
/// neither of which an adapter can be asked. Those are reported as
/// unknown rather than guessed.
pub fn os_visible_tunnel() -> (bool, Option<String>, TunnelHealth) {
    // Cheapest first, and in the order that matters: the two that
    // outlive this process -- a WireGuard tunnel service and a RAS
    // phonebook entry -- are the ones that can strand somebody.
    if wireguard::tunnel_is_running() {
        return (true, Some("WIREGUARD".to_string()), TunnelHealth::Unknown);
    }
    for (adapter, protocol) in [(xray::ADAPTER_NAME, "XRAY"), (openvpn::ADAPTER_NAME, "OPENVPN")] {
        if matches!(adapters::find_by_name(adapter), Ok(Some(a)) if a.is_up && a.ipv4.is_some()) {
            return (true, Some(protocol.to_string()), TunnelHealth::Unknown);
        }
    }
    // Last because it costs a PowerShell process -- half a second,
    // measured -- where the others cost an API call.
    if ikev2::is_connected() {
        return (true, Some("IKEV2".to_string()), TunnelHealth::Unknown);
    }
    (false, None, TunnelHealth::Down)
}

/// The network adapter a given protocol's engine creates.
///
/// Custom mode has to pin its sockets to it by index, so this mapping
/// has to match what each engine actually names its adapter -- guarded
/// by a test below rather than left to memory.
fn adapter_name_for(profile: &ConnectProfile) -> &'static str {
    match profile {
        ConnectProfile::Wireguard(_) => wireguard::TUNNEL_NAME,
        ConnectProfile::XrayVlessReality(_)
        | ConnectProfile::XrayVlessTls(_)
        | ConnectProfile::XrayTrojan(_)
        | ConnectProfile::Shadowsocks(_) => xray::ADAPTER_NAME,
        ConnectProfile::Openvpn(_) => openvpn::ADAPTER_NAME,
        // The RAS interface Windows brings up for the phonebook
        // entry. It carries the entry's name and has an index and an
        // address like any other adapter, so a socket can be pinned
        // to it -- which is all Custom mode needs. What used to be
        // missing was stopping Windows claiming the default route,
        // and -SplitTunneling does that (see ikev2::connect).
        ConnectProfile::Ikev2(_) => ikev2::ENTRY_NAME,
    }
}

/// The node's IPv4 address.
///
/// Custom mode's packet filter excludes it, which is not an
/// optimisation: the tunnel's own encrypted traffic goes to this
/// address, and redirecting that would put the tunnel inside itself.
fn node_address(profile: &ConnectProfile, limits: &crate::lifecycle::budget::Limits) -> Result<Ipv4Addr, String> {
    let (host, port) = match profile {
        ConnectProfile::Wireguard(p) => split_host_port(&p.endpoint)?,
        ConnectProfile::Openvpn(p) => split_host_port(&p.endpoint)?,
        ConnectProfile::XrayVlessReality(p) => (p.host.clone(), p.port),
        ConnectProfile::XrayVlessTls(p) => (p.host.clone(), p.port),
        ConnectProfile::XrayTrojan(p) => (p.host.clone(), p.port),
        ConnectProfile::Shadowsocks(p) => (p.host.clone(), p.port),
        // The hostname, resolved below like any other. IKEv2 always
        // starts on 500 even when it moves to 4500 for NAT traversal.
        ConnectProfile::Ikev2(p) => (p.server.clone(), 500),
    };

    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    // Nodes are registered by address today, but a hostname is resolved
    // rather than rejected -- otherwise a DNS-named node would silently
    // lose the exclusion above.
    //
    // Retried, because of when this runs. Turning Custom mode on while
    // connected rebuilds the tunnel, and the rebuild tears the old one
    // down first -- so this lookup lands in the seconds where the
    // engine's DNS servers are gone and the adapter's own are not back.
    // Measured on the test rig: toggling Custom mode on a live OpenVPN
    // connection failed with "could not resolve <node hostname>: No
    // such host is known", on a machine whose DNS was working before and
    // after. One retry loop is the difference between Custom mode
    // working on OpenVPN and not.
    //
    // The real hostname was here until 2026-08-26 and is redacted per
    // docs/node-address-hygiene.md -- this repository is public.
    // Clamped: the retry window is this stage's own ceiling, and what
    // the connect has left is the real bound when earlier stages have
    // already spent the budget.
    let deadline = std::time::Instant::now() + limits.clamp(RESOLVE_RETRY_FOR);
    let mut last = String::new();
    loop {
        // getaddrinfo, moved off this thread so a disconnect does not
        // have to wait for it.
        //
        // It is a synchronous Win32 call with no timeout and no way in,
        // and the loop around it only reads the abandon flag *after* it
        // returns -- so the real bound here was the retry window plus
        // one full resolver timeout, which on a node that is not
        // answering is exactly when a customer gives up and presses
        // Disconnect. The syscall still cannot be cancelled; what is
        // cancelled is this operation's interest in it.
        let resolving = {
            let host = host.clone();
            limits.token().interruptible(move || (host.as_str(), port).to_socket_addrs())
        };
        let resolving = match resolving {
            Ok(result) => result,
            Err(_) => return Err(ABANDONED.to_string()),
        };
        match resolving {
            Ok(mut addrs) => {
                if let Some(v4) = addrs.find_map(|a| match a.ip() {
                    IpAddr::V4(v4) => Some(v4),
                    IpAddr::V6(_) => None,
                }) {
                    return Ok(v4);
                }
                // Answered, but with nothing usable. Retrying cannot
                // change that.
                return Err(format!("{host} has no IPv4 address"));
            }
            Err(e) => last = e.to_string(),
        }
        // Which of the three reasons it was, because they are not the
        // same thing to whoever reads it. A resolver that answered with
        // a failure is a DNS problem; a disconnect is not a problem at
        // all; and a spent budget is a slow connect, where naming this
        // lookup sends the reader after the wrong stage.
        if let Err(stop) = limits.check() {
            return Err(stop.to_string());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("could not resolve {host}: {last}"));
        }
        std::thread::sleep(RESOLVE_RETRY_EVERY);
    }
}

/// How long a node's hostname is given to resolve, and how often it is
/// retried. Generous enough to cover the gap after a teardown, short
/// enough that a genuinely wrong hostname still fails while the customer
/// is watching.
const RESOLVE_RETRY_FOR: std::time::Duration = std::time::Duration::from_secs(6);
const RESOLVE_RETRY_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

fn split_host_port(endpoint: &str) -> Result<(String, u16), String> {
    let (host, port) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| format!("{endpoint} is not host:port"))?;
    let port = port
        .parse()
        .map_err(|_| format!("{endpoint} has no valid port"))?;
    Ok((host.to_string(), port))
}

/// Writes a config file into the protected config directory. Truncates
/// any previous contents so credentials from an earlier session never
/// linger in a partially-overwritten file.
fn write_config(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// How long a short-lived helper is given before it is killed and the
/// operation reported as failed.
///
/// Not a performance figure. It is the difference between one helper
/// misbehaving and the whole service going deaf, because every command
/// below runs while the `Engines` lock is held. Measured on this
/// machine, all of them return in well under a second: `route print -4`
/// in 0.09s, `netsh` in 0.15s, a PowerShell one-liner in 0.25s,
/// `Get-VpnConnection` in 0.52s, and wireguard.exe's tunnel install and
/// uninstall in under a second each. Fifteen seconds is more than
/// twenty times the slowest of them, and two of them back to back still
/// fit inside the app's 45-second read deadline.
///
/// The number that made a limit necessary is on the other side.
/// `wireguard.exe /installtunnelservice` can enter an unbounded retry
/// loop (see [`wireguard::clear_tunnel_service`]); with `.status()` and
/// no limit, it held this lock for 25 minutes in the field and for as
/// long as it was watched here, so every request behind it -- `status`
/// and `disconnect` included -- went unanswered and the customer sat
/// tunnelled with no way out.
pub(crate) const HELPER_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

/// How long a **PowerShell cmdlet** on the connect path is given, as
/// opposed to a native helper.
///
/// [`HELPER_BUDGET`] is not being weakened: it stays at 15s and every
/// native helper still takes it. This is a different cost, not the same
/// cost being slower.
///
/// The 15s figure is calibrated on `route.exe`, `netsh`, `sc.exe`,
/// `ipconfig` and `wireguard.exe` -- processes that start, do one thing
/// and exit, measured at 0.09s to 1s. A cmdlet out of `DnsClient` or
/// `VpnClient` pays three things none of those do: PowerShell engine
/// start, a CDXML module autoload, and a CIM session to
/// `root\StandardCimv2`.
///
/// Measured on the rig -- a 4-vCPU Windows 11 guest -- with a fresh
/// process per row, which is what the service spawns. The spread is
/// across two runs at different levels of contention, and the spread is
/// itself the point:
///
/// ```text
///   powershell -NoProfile -Command 1              4.4 -  6.5s
///   Get-DnsClientNrptRule | Measure-Object        9.6 - 66.7s
///   Add-DnsClientNrptRule                        10.0 - 55.1s
///   Get-VpnConnection -AllUserConnection         41.9 - 72.4s
///   route.exe print -4, for contrast              5.0s
/// ```
///
/// **This number is therefore not derived from those measurements, and
/// it would be dishonest to present it as if it were.** The same cmdlet
/// on the same machine varied seven-fold between runs; no wall-clock
/// budget bounds that usefully, and picking one that covered the worst
/// row would be picking a number past the point where the customer has
/// already been told the connect failed.
///
/// What the measurements do establish is the shape of the fix. A budget
/// cannot make a cmdlet fast, so the accompanying changes make the
/// connect spawn fewer of them: `ikev2::connect` went from three
/// PowerShell processes to one -- measured at 111.5s and 14.4s
/// respectively, in the same run, seven-fold -- and `dns::clear` from
/// one on every connect and disconnect to none in the ordinary case.
///
/// So 15s was never a bound on misbehaviour here; it was a coin toss on
/// a cmdlet's mood, and the rig watched it come up tails on three
/// engines out of four.
///
/// **What stops this being a licence to raise every budget.** The
/// deafness this whole mechanism exists to prevent is no longer bounded
/// by the budget at all: `Status` never queues behind the lock
/// (`STATUS_LOCK_WAIT` in `pipe::dispatch`, with an unlocked OS-visible
/// answer behind it), and `Disconnect` waits two seconds and then
/// cancels the running operation's token, which [`wait_within`] reads
/// every 50ms and kills the child on. A budget is still needed -- it is
/// what turns an *unbounded* wait into a failure -- but it is a backstop
/// now rather than the thing keeping the service answerable.
///
/// What chooses 35 specifically is one number up, not anything below:
/// the app abandons a request after 45s (`REPLY_TIMEOUT`,
/// `src-tauri/src/vpn.rs`), so a connect that outlives that is reported
/// to the customer as a failure whatever the service goes on to do.
/// 35s is the largest value that still leaves room for the rest of a
/// connect inside that deadline. It is deliberately **not** enough for
/// three cmdlets end to end -- there would be no such value -- which is
/// the point at which "raise the budget" stops being an available fix.
///
/// Only two call sites take this, and both are on the connect path with
/// nothing polling behind them: the IKEv2 entry script and
/// `dns::apply`. `is_connected` deliberately keeps [`HELPER_BUDGET`]
/// because it answers `status`, and `entry_present` and `remove_entry`
/// keep it because they are on the repair path, whose own deadline is
/// derived from budget arithmetic -- see `REPAIR_TIMEOUT`.
pub(crate) const CMDLET_BUDGET: std::time::Duration = std::time::Duration::from_secs(35);

/// How often a running child is checked while waiting for it.
const HELPER_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// How long a killed child is given to be collected.
///
/// `kill` can fail -- a process can be protected, or already gone in a
/// way that leaves the handle live -- and `wait` on a child that did not
/// die is the same unbounded wait this module exists to remove, arriving
/// through the cleanup path instead of the main one.
const REAP_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Set when a caller has asked whatever holds the `Engines` lock to give
/// up so the lock is released.
///
/// The escape hatch for the failure this is all about: an operation that
/// is waiting on something slow, and a customer who wants out of the
/// tunnel now. `HELPER_BUDGET` bounds the wait, but bounded is not the
/// same as immediate, and Disconnect is the one request that should
/// never queue behind anything. See `pipe::dispatch`.
/// The operation currently in flight, as a token rather than a flag.
///
/// Still one global slot, which is the thing the rewrite is working
/// towards removing -- but a token can be *handed to* code that needs to
/// poll it, and a bare `static AtomicBool` could only be read by code
/// that knew the static existed. That is the whole difference, and it is
/// why the split tunnel never checked the flag once across a
/// thirty-eight second window: nothing was ever passed to it.
///
/// A `std::sync::Mutex` holding a clonable token, replaced outright by
/// each job rather than reset. Replacing is what stops one operation
/// clearing another's cancellation -- the old flag's defining bug, where
/// a retrying connect wiped the abandon a customer's disconnect had just
/// set. There is no reset to call.
static ABANDON: std::sync::Mutex<Option<crate::lifecycle::cancel::CancelToken>> =
    std::sync::Mutex::new(None);

/// Publish the running operation's token, so ambient readers can poll it.
///
/// Advisory, not a kill: it is read at the points where this service
/// waits on something outside itself, so the operation unwinds through
/// its own error paths and leaves the machine in a state it chose.
///
/// Called at the top of every job the supervisor runs, with that job's
/// own token. The global and the per-operation token are then the same
/// value rather than two mechanisms that have to be kept in step --
/// which is what the two functions this replaced were, and why
/// cancelling used to mean remembering to do both.
///
/// Cancelling is now `Supervisor::cancel_running`, which cancels the
/// token this published, which is the one `abandoned()` reads. One
/// signal, one owner, no reset.
pub(crate) fn adopt_token(token: &crate::lifecycle::cancel::CancelToken) {
    if let Ok(mut slot) = ABANDON.lock() {
        *slot = Some(token.clone());
    }
}

/// The token for the operation in flight.
///
/// Read at a boundary -- the top of [`Engines::connect`], a teardown, a
/// Custom-mode toggle -- and then passed down as an argument. Reaching
/// for this deeper than that is the habit it exists to replace.
///
/// Returns a cancelled token when there is no operation, which is the
/// safe direction: code that asks for a token outside an operation is
/// code that should not be starting long work.
pub(super) fn current_token() -> crate::lifecycle::cancel::CancelToken {
    match ABANDON.lock() {
        Ok(slot) => slot.clone().unwrap_or_else(|| {
            let spent = crate::lifecycle::cancel::CancelToken::new();
            spent.cancel();
            spent
        }),
        Err(_) => {
            let spent = crate::lifecycle::cancel::CancelToken::new();
            spent.cancel();
            spent
        }
    }
}

/// The ambient read, now down to one caller: [`wait_within`].
///
/// Kept deliberately rather than threaded. `wait_within` is the floor of
/// `run_hidden_within` and `capture_hidden`, the generic "run a process
/// under a budget" primitive that DNS, routing, repair, the janitor and
/// the firewall all sit on. Those are not connect-path functions and
/// their authors have no cancellation decision to make: any process this
/// service starts inside a cancelled operation should abort, always, and
/// requiring every one of them to pass a token down would be ceremony
/// that adds no choice. This is the one place where ambient is the
/// correct answer rather than the lazy one.
fn abandoned() -> bool {
    ABANDON
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|t| t.is_cancelled()))
        .unwrap_or(false)
}

/// What an abandoned operation reports. Defined with the other stop
/// reason in [`crate::lifecycle::budget`], so the words a customer sees
/// and the type that decides between them cannot drift apart.
const ABANDONED: &str = crate::lifecycle::budget::ABANDONED;

/// What a connect that ran out of time reports.
///
/// Distinct from [`ABANDONED`] because the causes are different and so
/// is the advice: one means somebody pressed Disconnect, the other means
/// every stage was still working when the clock ran out. Also distinct
/// from a stage's own timeout message, which names that stage -- by the
/// time the budget is gone the stage that happens to notice is an
/// accident of ordering, and blaming OpenVPN for a slow DNS lookup
/// three stages earlier sends whoever reads it to the wrong place.
pub(super) const OUT_OF_TIME: &str = crate::lifecycle::budget::OUT_OF_TIME;

/// The name to put in an error message, from the command being run.
fn helper_name(command: &Command) -> String {
    Path::new(command.get_program())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the helper".to_string())
}

/// Waits for a child, killing it if it outstays `budget` or if the
/// operation it belongs to has been abandoned.
fn wait_within(
    child: &mut Child,
    budget: std::time::Duration,
    what: &str,
) -> io::Result<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        let give_up = if abandoned() {
            // The customer's sentence, not the helper's name: every
            // caller prefixes this with the stage it was in, which is
            // the part worth reading, and "tapctl.exe was still
            // running" is not something to put in front of somebody who
            // pressed Disconnect.
            Some(ABANDONED.to_string())
        } else if std::time::Instant::now() >= deadline {
            Some(format!("{what} did not finish within {}s", budget.as_secs()))
        } else {
            None
        };
        if let Some(reason) = give_up {
            let _ = child.kill();
            reap(child);
            return Err(io::Error::new(io::ErrorKind::TimedOut, reason));
        }
        std::thread::sleep(HELPER_POLL);
    }
}

/// Collects a child that has been killed, giving up rather than waiting
/// on one that refused to die.
fn reap(child: &mut Child) {
    let deadline = std::time::Instant::now() + REAP_BUDGET;
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(HELPER_POLL),
        }
    }
}

/// Runs a short-lived command to completion, hidden and bounded.
fn run_hidden(exe: &Path, args: &[&std::ffi::OsStr]) -> io::Result<std::process::ExitStatus> {
    run_hidden_within(exe, args, HELPER_BUDGET)
}

fn run_hidden_within(
    exe: &Path,
    args: &[&std::ffi::OsStr],
    budget: std::time::Duration,
) -> io::Result<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(exe);
    command
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null());
    let what = helper_name(&command);
    let mut child = command.spawn()?;
    wait_within(&mut child, budget, &what)
}

/// What a captured helper produced.
pub(crate) struct Captured {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a command, hidden, and returns what it printed -- within
/// [`HELPER_BUDGET`].
///
/// `Command::output` cannot be used for this. It waits for the child and
/// then reads its pipes to end-of-file, neither of which has a limit, so
/// a helper that hangs -- or one whose own child inherited the pipe and
/// outlived it -- takes this thread and the `Engines` lock with it. The
/// pipe is drained on a thread of its own for the same reason: a helper
/// blocked writing into a full pipe would never reach the exit that is
/// being waited for.
pub(crate) fn capture_hidden(
    mut command: Command,
    budget: std::time::Duration,
) -> io::Result<Captured> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;

    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let what = helper_name(&command);
    let mut child = command.spawn()?;

    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(mut pipe) = pipe {
            std::thread::spawn(move || {
                let mut buffer = Vec::new();
                let _ = pipe.read_to_end(&mut buffer);
                let _ = tx.send(buffer);
            });
        }
        rx
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let status = wait_within(&mut child, budget, &what)?;

    // The child has gone, so its ends of both pipes are closed and the
    // readers are already at end-of-file -- unless something it spawned
    // inherited them, which is the case this refuses to wait out.
    let collect = |rx: std::sync::mpsc::Receiver<Vec<u8>>| {
        rx.recv_timeout(HELPER_POLL * 20)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    };
    Ok(Captured { status, stdout: collect(out), stderr: collect(err) })
}

/// Runs a short-lived command, hidden, and returns its stdout.
pub(crate) fn run_hidden_capture(exe: &Path, args: &[&std::ffi::OsStr]) -> io::Result<String> {
    run_hidden_capture_within(exe, args, HELPER_BUDGET)
}

/// The same, against a budget the caller chooses.
///
/// For the helpers that are not short-lived whatever the name of the
/// function says -- `tapctl.exe create` installs a network device. See
/// `openvpn::ADAPTER_CREATE_BUDGET`.
pub(crate) fn run_hidden_capture_within(
    exe: &Path,
    args: &[&std::ffi::OsStr],
    budget: std::time::Duration,
) -> io::Result<String> {
    let mut command = Command::new(exe);
    command.args(args);
    Ok(capture_hidden(command, budget)?.stdout)
}

/// How long to wait after spawning before deciding the engine is up.
///
/// An engine that rejects its config dies within a few hundred
/// milliseconds. Without this the service reported success the instant
/// it had spawned a process, so the app said "Connected" for an engine
/// that had already exited -- which is exactly how OpenVPN and Xray
/// looked connected while the user's IP never changed.
const STARTUP_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Spawns a long-running engine, hidden, and hands back the child so the
/// service keeps ownership of its lifetime.
///
/// Output goes to a log file rather than being discarded. These engines
/// explain their failures on stderr, and throwing that away meant a
/// failed tunnel left nothing behind to diagnose -- the whole reason
/// Xray's misbehaviour was invisible.
fn spawn_hidden(
    exe: &Path,
    args: &[&std::ffi::OsStr],
    working_dir: &Path,
    log_path: &Path,
) -> io::Result<Child> {
    use std::os::windows::process::CommandExt;

    let log = std::fs::File::create(log_path)?;
    let log_err = log.try_clone()?;

    Command::new(exe)
        .args(args)
        .current_dir(working_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()
}

/// Confirms the engine is still alive shortly after starting, and
/// surfaces whatever it logged if it isn't.
///
/// This is deliberately a liveness check, not a proof that traffic
/// flows -- but it turns the most common failure (bad config, missing
/// driver, unreachable server) from a silent false "Connected" into a
/// real error with the engine's own explanation attached.
fn confirm_started(mut child: Child, engine: &str, log_path: &Path) -> Result<Child, String> {
    std::thread::sleep(STARTUP_GRACE);

    match child.try_wait() {
        Ok(None) => Ok(child),
        Ok(Some(status)) => {
            let detail = std::fs::read_to_string(log_path)
                .ok()
                .map(|s| s.lines().rev().take(6).collect::<Vec<_>>().join(" | "))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "no output".to_string());
            Err(format!("{engine} exited immediately ({status}): {detail}"))
        }
        Err(e) => {
            let _ = child.kill();
            Err(format!("could not check whether {engine} started: {e}"))
        }
    }
}

/// Appends the other VPNs that were up when a connection failed.
///
/// Only on failure, and only ever as extra sentence: the presence of
/// another VPN is evidence, not a diagnosis, and a customer reading this
/// is better served by "here is what else is running" than by us
/// guessing which of the two is at fault.
/// The Xray outbound for a profile, or `None` for a protocol Xray does
/// not carry.
///
/// The borrow is the reason this is a free function taking a reference
/// rather than a method: `xray::Outbound` holds a shared reference into
/// the profile, so the profile has to outlive it and the caller is the
/// only place that can promise that.
fn xray_outbound_for(profile: &ConnectProfile) -> Option<xray::Outbound<'_>> {
    match profile {
        ConnectProfile::XrayVlessReality(p) => Some(xray::Outbound::VlessReality(p)),
        ConnectProfile::XrayVlessTls(p) => Some(xray::Outbound::VlessTls(p)),
        ConnectProfile::XrayTrojan(p) => Some(xray::Outbound::Trojan(p)),
        ConnectProfile::Shadowsocks(p) => Some(xray::Outbound::Shadowsocks(p)),
        _ => None,
    }
}

fn with_rival_hint(error: String, rivals: &[String]) -> String {
    if rivals.is_empty() {
        return error;
    }
    format!(
        "{error} Another VPN is connected on this machine ({}), which takes over the default route --          disconnecting it and trying again is the usual fix.",
        rivals.join(", ")
    )
}

#[cfg(test)]
mod helper_tests {
    /// A stale DNS complaint must not outlive the session it came from.
    ///
    /// The failure mode is a customer who reconnects successfully and is
    /// still shown a red line saying their lookups are not pinned -- or
    /// worse, one who disconnects and is shown it with nothing running.
    /// It is a one-line mistake: the field is set on every connect and
    /// the reset is a separate statement.
    ///
    /// Per-instance on purpose. This state was briefly a process-global
    /// that `status` read directly, and two tests that shared it passed
    /// alone and failed together -- which is the same class of bug on a
    /// customer's machine, not merely a test problem.
    #[test]
    fn a_session_that_ended_stops_claiming_anything_about_dns() {
        use std::path::PathBuf;
        let dir = PathBuf::from(std::env::temp_dir()).join("neoconnect-test-no-engines");
        let mut engines = super::Engines::new(dir.clone(), dir);

        assert!(
            !engines.tunnel_dns_unprotected(),
            "a fresh session claimed a DNS problem it never had"
        );

        engines.set_dns_state_for_test(super::dns::TunnelDns::Unforced(
            "powershell did not finish within 35s".into(),
        ));
        assert!(engines.tunnel_dns_unprotected(), "the test hook did not take");

        engines.forget_dns_state();
        assert!(
            !engines.tunnel_dns_unprotected(),
            "a DNS complaint survived the end of the session it came from"
        );
    }

    use super::*;
    use std::ffi::OsStr;
    use std::time::{Duration, Instant};

    /// The bug this whole budget exists for, in miniature.
    ///
    /// `Command::status` waits for a child with no limit at all, and
    /// `wireguard.exe /installtunnelservice` really does refuse to
    /// return -- 25 minutes in the field, and still going after 90
    /// seconds when it was reproduced here. Because every helper runs
    /// with the `Engines` lock held, that one child made the service
    /// deaf to everything, `status` and `disconnect` included.
    ///
    /// `ping -n 30` stands in for it: about half a minute of a process
    /// that is definitely still there, using a binary every Windows
    /// install has.
    #[test]
    fn a_helper_past_its_budget_is_killed_rather_than_waited_on() {
        let ping = Path::new(r"C:\Windows\System32\ping.exe");
        let started = Instant::now();
        let err = run_hidden_within(
            ping,
            &[OsStr::new("-n"), OsStr::new("30"), OsStr::new("127.0.0.1")],
            Duration::from_millis(500),
        )
        .expect_err("a helper past its budget must fail, not block");

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "gave up after {:?}, which is not a bound at all",
            started.elapsed()
        );
    }

    /// Ending a session must stop Custom mode, and this is the test
    /// that can say so.
    ///
    /// Asserting on `split_tunnel.is_running()` would not: it is false
    /// before and after, because nothing here can start a real redirect
    /// loop without the WinDivert driver and a live tunnel. A test built
    /// that way passes whether or not the stop ever happens, which is
    /// the shape of test that let the 2026-08-23 bug through. So the
    /// call itself is counted -- see `SplitTunnel::stop_calls`.
    ///
    /// Revert `Slot::end` to a bare `self.0.take()` and this fails.
    /// A session to put in a slot. IKEv2's profile, because it is the
    /// smallest to build; nothing here connects.
    fn test_session() -> Session {
        let profile = ConnectProfile::Ikev2(neoconnect_ipc::Ikev2Profile {
            server: "node.example.com".into(),
            username: String::new(),
            password: String::new(),
        });
        Session::new(Active::WireguardTunnel, &profile)
    }

    #[test]
    fn ending_a_session_stops_the_split_tunnel() {
        let mut slot = Slot::empty();
        let mut split = SplitTunnel::new();
        slot.fill(test_session());

        assert_eq!(split.stop_calls(), 0, "nothing should have been stopped yet");
        assert!(slot.end(&mut split).is_some(), "the engine should come back out");
        assert_eq!(
            split.stop_calls(),
            1,
            "ending a session left the redirect loop running -- this is the field bug"
        );
        assert!(slot.is_empty());
    }

    /// What the session type is for: nothing that belongs to a session
    /// survives its end. The profile Custom mode would rebuild from goes
    /// with it, and so does the DNS complaint -- which a status poll that
    /// found a dead engine used to leave standing, attached to nothing.
    #[test]
    fn ending_a_session_takes_its_profile_and_dns_state_with_it() {
        let mut engines = Engines::new(PathBuf::new(), PathBuf::new());
        engines.active.fill(test_session());
        engines.set_dns_state_for_test(dns::TunnelDns::Unforced("test".into()));
        assert!(engines.active.peek().is_some(), "the session's profile is there to rebuild from");

        assert!(engines.end_session().is_some());
        assert!(engines.active.peek().is_none(), "the profile outlived its session");
        assert!(!engines.tunnel_dns_unprotected(), "the DNS complaint outlived its session");
        engines.unblock_ipv6();
        assert!(engines.ending_filters.is_none(), "filters were left parked after the release step");
    }

    /// The same, for the state the field bug actually left behind.
    ///
    /// `status()` had already emptied the slot when the customer's
    /// Disconnect arrived, so a teardown that only stopped Custom mode
    /// "when there was a session" would have skipped it precisely when
    /// it was needed. Every route out of the slot stops the redirect,
    /// including the one where there is no engine left to take.
    #[test]
    fn ending_an_already_empty_session_still_stops_the_split_tunnel() {
        let mut slot = Slot::empty();
        let mut split = SplitTunnel::new();

        assert!(slot.end(&mut split).is_none());
        assert_eq!(
            split.stop_calls(),
            1,
            "an untracked engine is exactly when an orphaned redirect needs stopping"
        );
    }

    /// The other half: bounding the wait must not cost the output. The
    /// capture path had to stop using `Command::output` -- which reads
    /// both pipes to end-of-file with no limit -- so what it replaces it
    /// with has to still deliver what the helper printed.
    #[test]
    fn a_captured_helper_still_returns_what_it_printed() {
        let out = run_hidden_capture(
            Path::new(r"C:\Windows\System32\cmd.exe"),
            &[OsStr::new("/c"), OsStr::new("echo neoxify")],
        )
        .expect("cmd should run");
        assert!(out.contains("neoxify"), "captured nothing usable: {out:?}");
    }

    // ---- An engine that ends on its own ------------------------------
    //
    // Measured on 2026-10-06: xray.exe killed, traffic direct in 0.2s,
    // "You're protected" for 17.0s, nothing in cleanup.log. These pin the
    // service's half of the fix -- noticing without being asked, and
    // tearing down once -- with a real process standing in for the
    // engine. What they cannot pin is what the packets do; that is the
    // VM's job, and is not claimed here.

    /// A real process that stays up for about half a minute.
    fn engine_stand_in() -> Child {
        use std::os::windows::process::CommandExt;
        Command::new(r"C:\Windows\System32\ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawning ping")
    }

    /// Kills the session's engine without ending the session -- what a
    /// crash, or `Stop-Process -Force`, does to it.
    fn kill_engine_behind_its_back(engines: &mut Engines) -> Instant {
        let Some(Session { engine: Active::Child { child, .. }, .. }) = engines.active.peek_mut() else {
            panic!("no child engine to kill");
        };
        let at = Instant::now();
        child.kill().expect("killing the stand-in");
        at
    }

    fn reports_into(engines: &mut Engines) -> Arc<std::sync::Mutex<Vec<(u64, Instant)>>> {
        let seen: Arc<std::sync::Mutex<Vec<(u64, Instant)>>> = Arc::default();
        let into = Arc::clone(&seen);
        engines.when_an_engine_ends(Arc::new(move |generation| {
            into.lock().unwrap().push((generation, Instant::now()));
        }));
        seen
    }

    fn wait_for(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        done()
    }

    fn engines_for_test() -> Engines {
        let dir = std::env::temp_dir().join("neoconnect-test-no-engines");
        Engines::new(dir.clone(), dir)
    }

    /// Every process engine, by the label it is reported under: the four
    /// Xray protocols share one engine, and OpenVPN is the other child.
    /// Each must be noticed promptly with nobody asking, and torn down
    /// exactly once.
    #[test]
    fn every_process_engine_that_dies_is_noticed_and_torn_down_once() {
        for protocol in ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_TROJAN", "SHADOWSOCKS", "OPENVPN"] {
            let mut engines = engines_for_test();
            let seen = reports_into(&mut engines);
            let generation = engines.begin_test_session(protocol, engine_stand_in());
            assert_ne!(generation, 0);
            assert_eq!(
                engines.status(),
                (true, Some(protocol.to_string()), TunnelHealth::Unknown),
                "{protocol}: a live engine must read as up"
            );

            let killed_at = kill_engine_behind_its_back(&mut engines);
            assert!(
                wait_for(Duration::from_secs(5), || !seen.lock().unwrap().is_empty()),
                "{protocol}: nobody was told the engine died"
            );
            let (reported, at) = seen.lock().unwrap()[0];
            assert_eq!(reported, generation, "{protocol}: reported for the wrong session");
            assert!(
                at.duration_since(killed_at) < Duration::from_secs(2),
                "{protocol}: noticed {:?} after it died",
                at.duration_since(killed_at)
            );
            let ended = engines.ledger().ended_without_successor().expect("the drop is on record");
            assert_eq!(ended.protocol, protocol);
            assert_eq!(ended.generation, generation);

            assert!(engines.end_dead_session(generation), "{protocol}: phase one did nothing");
            assert!(!engines.has_session(), "{protocol}: the dead session is still in the slot");
            assert_eq!(engines.split_tunnel.stop_calls(), 1, "{protocol}: Custom mode was not stopped");
            assert!(engines.ending_filters.is_none(), "{protocol}: the session's filters were not released");
            assert!(!engines.tunnel_dns_unprotected());
            assert_eq!(engines.sessions_ended(), 1);

            // Once. A second report, or the watch and a poll both
            // arriving, must find nothing left to do.
            assert!(!engines.end_dead_session(generation), "{protocol}: torn down twice");
            assert_eq!(engines.sessions_ended(), 1);
            assert_eq!(seen.lock().unwrap().len(), 1, "{protocol}: reported more than once");
        }
    }

    /// The status poll finding a dead engine first is the same drop,
    /// taken down by the same steps.
    #[test]
    fn a_status_poll_that_finds_the_engine_dead_records_the_drop() {
        let mut engines = engines_for_test();
        let generation = engines.begin_test_session("XRAY_VLESS_REALITY", engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        let scm = Arc::clone(&engines.wireguard_scm);
        assert!(wait_for(Duration::from_secs(5), || {
            matches!(engines.active.peek_mut().map(|s| s.engine.has_ended(&scm)), Some(Some(true)))
        }));

        assert_eq!(engines.status(), (false, None, TunnelHealth::Down));
        assert!(!engines.has_session());
        let ended = engines.ledger().ended_without_successor().expect("the drop is on record");
        assert_eq!(ended.generation, generation);
        // And the watch's own report, arriving behind it, finds nothing.
        assert!(!engines.end_dead_session(generation));
        assert_eq!(engines.sessions_ended(), 1);
    }

    /// A report about an older session must never take down a newer one.
    #[test]
    fn a_death_reported_for_an_older_session_leaves_the_newer_one_alone() {
        let mut engines = engines_for_test();
        let seen = reports_into(&mut engines);
        let old = engines.begin_test_session("XRAY_TROJAN", engine_stand_in());
        // Ended by the service, as a Disconnect or a reconnect would.
        if let Some(Active::Child { mut child, .. }) = engines.end_session() {
            let _ = child.kill();
            let _ = child.wait();
        }
        engines.unblock_ipv6();
        let new = engines.begin_test_session("XRAY_TROJAN", engine_stand_in());
        assert_ne!(old, new);

        std::thread::sleep(Duration::from_millis(300));
        assert!(seen.lock().unwrap().is_empty(), "the service's own kill was reported as a drop");
        assert!(!engines.end_dead_session(old), "a stale report took down the live session");
        assert!(engines.has_session());
        assert_eq!(engines.status().0, true, "the newer engine is untouched");
        assert!(engines.ledger().ended_without_successor().is_none());

        if let Some(Active::Child { mut child, .. }) = engines.end_session() {
            let _ = child.kill();
            let _ = child.wait();
        }
        engines.unblock_ipv6();
    }

    /// An engine that dies at the moment the customer presses
    /// Disconnect: the watch's teardown and the Disconnect's hard stop
    /// race on the owning thread, in either order. The session must be
    /// ended exactly once, and nothing may be left in the slot.
    ///
    /// Thirty-two at once, because that is where the relay teardown was
    /// caught failing when one at a time passed every run
    /// (docs/split-tunnel-rewrite.md).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_dead_engine_racing_a_disconnect_is_torn_down_once() {
        use crate::lifecycle::supervisor::Supervisor;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

        const AT_ONCE: usize = 32;
        let mut racers = Vec::new();
        for i in 0..AT_ONCE {
            let sup = Supervisor::spawn(engines_for_test(), "test-race");
            let teardown = sup.clone();
            let pid = sup
                .run(move |engines: &mut Engines, _| {
                    // What the pipe installs: queue phase one on the owning
                    // thread. Phase two is left out -- it is the thorough
                    // pass, the same one a Disconnect queues, and running
                    // sixty-four of them proves nothing more about the race.
                    engines.when_an_engine_ends(Arc::new(move |generation| {
                        let _ = teardown.run_detached(move |engines: &mut Engines, _| {
                            engines.end_dead_session(generation);
                        });
                    }));
                    let child = engine_stand_in();
                    let pid = child.id();
                    engines.begin_test_session("XRAY_VLESS_REALITY", child);
                    pid
                })
                .await
                .unwrap();
            racers.push((i, sup, pid));
        }

        let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
        let mut threads = Vec::new();
        for (i, sup, pid) in &racers {
            let (i, sup, pid, start) = (*i, sup.clone(), *pid, Arc::clone(&start));
            threads.push(std::thread::spawn(move || {
                start.wait();
                let kill = || {
                    // SAFETY: plain calls; the handle is closed below.
                    unsafe {
                        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                        if !h.is_null() {
                            TerminateProcess(h, 1);
                            windows_sys::Win32::Foundation::CloseHandle(h);
                        }
                    }
                };
                let disconnect = || {
                    let _ = sup.run_detached(|engines: &mut Engines, token| {
                        adopt_token(token);
                        let _ = crate::lifecycle::teardown::hard_stop(engines);
                    });
                };
                // Both orders, so neither side always wins.
                if i % 2 == 0 {
                    kill();
                    disconnect();
                } else {
                    disconnect();
                    kill();
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }

        for (i, sup, _) in racers {
            let mut settled = None;
            for _ in 0..100 {
                let empty = !sup.run(|engines: &mut Engines, _| engines.has_session()).await.unwrap();
                if empty {
                    // Long enough for a report still in flight to land
                    // and be run, and so be counted if it did anything.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    settled = Some(
                        sup.run(|engines: &mut Engines, _| (engines.has_session(), engines.sessions_ended()))
                            .await
                            .unwrap(),
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (still_there, ended) = settled.unwrap_or_else(|| panic!("racer {i}: the session was never ended"));
            assert!(!still_there, "racer {i}: a session was left in the slot");
            assert_eq!(ended, 1, "racer {i}: the session was ended {ended} times");
            // Drop the sink, which holds a handle to this supervisor, so
            // its thread can end with the test.
            let _ = sup.run(|engines: &mut Engines, _| engines.engine_gone = None).await;
        }
    }

    // ---- A report the engine contradicts -----------------------------
    //
    // Found by both reviews of this branch. The watch put a drop on
    // record, phase one asked the engine and found it running, and
    // returned -- leaving the record in the ledger, so the status and
    // Disconnect fallbacks answered "no tunnel" for a live one, and the
    // session with no watch at all, because a watch that reports has
    // finished. What does that, on a real machine: a WireGuard tunnel
    // service stopped and started again by the service manager, a
    // service-manager query that fails, an IKEv2 connection out of
    // `Connected` while MOBIKE moves it.

    /// A source that reports an ending on its first look, whatever the
    /// engine is doing -- which is what the three above look like to the
    /// watch. A state, so it can come back.
    struct SaysGone(Option<i64>);
    impl engine_watch::Liveness for SaysGone {
        fn look(&mut self) -> engine_watch::Look {
            engine_watch::Look::Gone(self.0)
        }
        fn may_return(&self) -> bool {
            true
        }
    }

    /// The same, held back until `go` is set, so thirty-two of them can
    /// report at one instant.
    struct GoneWhen(engine_watch::OwnedHandle);
    impl engine_watch::Liveness for GoneWhen {
        fn look(&mut self) -> engine_watch::Look {
            if self.0.is_signalled() {
                engine_watch::Look::Gone(Some(1066))
            } else {
                engine_watch::Look::WaitOn(self.0.raw())
            }
        }
        fn may_return(&self) -> bool {
            true
        }
    }

    /// A wait the kernel refuses: nothing is learned, nothing recorded.
    struct WaitFails;
    impl engine_watch::Liveness for WaitFails {
        fn look(&mut self) -> engine_watch::Look {
            engine_watch::Look::WaitOn(std::ptr::null_mut())
        }
    }

    fn recorded(engines: &Engines, generation: u64) -> bool {
        engines.ledger().ended_without_successor().is_some_and(|e| e.generation == generation)
    }

    fn end_test_session(engines: &mut Engines) {
        if let Some(Active::Child { mut child, .. }) = engines.end_session() {
            let _ = child.kill();
            let _ = child.wait();
        }
        engines.unblock_ipv6();
    }

    /// The generic case, with a real process as the engine: the report
    /// is taken back, the session stays up and is watched again, status
    /// still says up -- and the engine's real death afterwards is still
    /// caught, with its own exit code rather than the retracted one's.
    #[test]
    fn a_report_the_engine_contradicts_is_taken_back_and_the_session_watched_again() {
        let mut engines = engines_for_test();
        let g = engines.begin_test_session_watched_by("XRAY_VLESS_REALITY", engine_stand_in(), Box::new(SaysGone(Some(1066))));
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)), "the watch never reported");
        assert!(engines.ledger().confirmed_drop().is_none(), "a source that can come back answered a status unchecked");

        assert!(!engines.end_dead_session(g), "a running engine was torn down");
        assert!(engines.has_session());
        assert_eq!(engines.sessions_ended(), 0);
        assert_eq!(engines.split_tunnel.stop_calls(), 0, "Custom mode was stopped over a live tunnel");
        assert!(!recorded(&engines, g), "the contradicted report was left on record");
        assert!(engines.ledger().is_live(g), "a retraction closed the generation");
        assert_eq!(engines.session_rearms(), 1);
        assert!(engines.session_is_watched(), "the session was left unwatched");
        assert_eq!(engines.status(), (true, Some("XRAY_VLESS_REALITY".to_string()), TunnelHealth::Unknown));

        let killed_at = kill_engine_behind_its_back(&mut engines);
        assert!(
            wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()),
            "after the re-arm, the engine's real death went unnoticed"
        );
        let ended = engines.ledger().confirmed_drop().unwrap();
        assert_eq!(ended.generation, g);
        assert_eq!(ended.detail, Some(1), "the real death's own exit code, not the retracted report's");
        // The re-armed watch waits out REARM_SPACING before its first
        // look, because it was armed within a second of the first.
        assert!(ended.at.duration_since(killed_at) < Duration::from_secs(2));
        assert!(engines.end_dead_session(g));
        assert!(!engines.has_session());
        assert_eq!(engines.sessions_ended(), 1);
        assert_eq!(engines.session_rearms(), 0, "nothing left to re-arm");
    }

    /// A wait that failed records nothing; phase one asks, finds the
    /// engine running, and starts the watch again rather than leaving the
    /// session unwatched for good.
    #[test]
    fn a_watch_whose_wait_failed_is_started_again() {
        let mut engines = engines_for_test();
        let g = engines.begin_test_session_watched_by("OPENVPN", engine_stand_in(), Box::new(WaitFails));
        assert!(wait_for(Duration::from_secs(5), || !engines.session_is_watched()), "the failed wait did not end the watch");
        assert!(!recorded(&engines, g), "a wait that failed was recorded as a drop");

        assert!(!engines.end_dead_session(g));
        assert!(engines.has_session());
        assert_eq!(engines.session_rearms(), 1);
        assert!(engines.session_is_watched());

        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)), "the re-armed watch missed the death");
        assert!(engines.end_dead_session(g));
        assert_eq!(engines.sessions_ended(), 1);
    }

    /// The WireGuard trigger, through the same query the watch, phase
    /// one and `status` all read. The service manager is scripted; the
    /// tunnel service's process is a real one, killed for real.
    #[test]
    fn a_wireguard_tunnel_service_stopped_and_started_again_is_not_a_drop() {
        use wireguard::ScmView;
        let mut service_process = engine_stand_in();
        let scm = Arc::new(std::sync::Mutex::new(ScmView::Running(Some(service_process.id()))));
        let script = Arc::clone(&scm);
        let set = |view: ScmView| *scm.lock().unwrap() = view;

        let mut engines = engines_for_test();
        let g = engines.begin_test_wireguard_session(move || *script.lock().unwrap());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!recorded(&engines, g), "a running tunnel service was reported gone");
        assert!(engines.session_is_watched());

        // The service's process dies and the manager marks it stopped...
        set(ScmView::Stopped(Some(1066)));
        service_process.kill().unwrap();
        let _ = service_process.wait();
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)), "the stopped service was not noticed");
        assert!(engines.ledger().confirmed_drop().is_none(), "a Stopped seen once answered a status");

        // ...and starts it again before phase one gets to ask.
        set(ScmView::Pending);
        assert!(!engines.end_dead_session(g), "a tunnel service starting again was taken down");
        assert!(engines.has_session());
        assert!(!recorded(&engines, g), "the report was left on record");
        assert_eq!(engines.session_rearms(), 1);
        assert!(engines.session_is_watched());

        // Running again as a new process, which the re-armed watch takes up.
        let mut restarted = engine_stand_in();
        set(ScmView::Running(Some(restarted.id())));
        std::thread::sleep(Duration::from_millis(1_400));
        assert!(!recorded(&engines, g), "the restarted service was reported gone");
        assert!(engines.session_is_watched());

        // And a real ending after it is still caught, and taken down once.
        set(ScmView::Stopped(Some(1)));
        restarted.kill().unwrap();
        let _ = restarted.wait();
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)), "the real stop went unnoticed");
        assert!(engines.end_dead_session(g), "a stopped tunnel service was not taken down");
        assert!(!engines.has_session());
        assert_eq!(engines.sessions_ended(), 1);
        let ended = engines.ledger().confirmed_drop().expect("confirmed by phase one");
        assert_eq!(ended.detail, Some(1));
        assert_eq!(ended.protocol, "WIREGUARD");
    }

    /// A service manager that cannot be asked -- the transient
    /// `OpenService` failure, which used to read as "not registered" --
    /// is neither noticed as an ending by the watch nor acted on by phase
    /// one.
    #[test]
    fn a_tunnel_service_whose_state_cannot_be_read_is_not_taken_down() {
        use wireguard::ScmView;
        let mut service_process = engine_stand_in();
        let scm = Arc::new(std::sync::Mutex::new(ScmView::Running(Some(service_process.id()))));
        let script = Arc::clone(&scm);
        let set = |view: ScmView| *scm.lock().unwrap() = view;

        let mut engines = engines_for_test();
        let g = engines.begin_test_wireguard_session(move || *script.lock().unwrap());
        std::thread::sleep(Duration::from_millis(300));

        // Unreadable for longer than a slice, with the process alive.
        set(ScmView::Unreadable);
        std::thread::sleep(Duration::from_millis(1_300));
        assert!(!recorded(&engines, g), "an unanswered question was reported as an ending");
        assert!(engines.session_is_watched());

        // The watch does see a stop; by the time phase one asks, the
        // manager cannot answer. "Could not ask" is not "down".
        set(ScmView::Stopped(Some(1066)));
        service_process.kill().unwrap();
        let _ = service_process.wait();
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)));
        set(ScmView::Unreadable);
        assert!(!engines.end_dead_session(g), "taken down on a question nobody answered");
        assert!(engines.has_session());
        assert!(!recorded(&engines, g));
        assert!(engines.session_is_watched(), "left unwatched after an unanswered question");

        // Once the manager answers again, the stop is caught.
        set(ScmView::Stopped(Some(1066)));
        assert!(wait_for(Duration::from_secs(5), || recorded(&engines, g)), "the re-armed watch missed the stop");
        assert!(engines.end_dead_session(g));
        assert_eq!(engines.sessions_ended(), 1);
    }

    /// Thirty-two at once, for the reason the race test above gives.
    ///
    /// Every session's watch reports an ending at the same instant that
    /// its engine contradicts. Half of them have a Disconnect racing the
    /// report; the other half are left alone. The left-alone half must
    /// all end up up, with nothing on record and a watch running; the
    /// raced half must be ended exactly once, by the Disconnect. Then the
    /// left-alone half's engines are killed at once for real, and every
    /// one must be caught by its re-armed watch and torn down exactly
    /// once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn contradicted_reports_at_once_are_taken_back_and_real_deaths_after_them_still_caught() {
        use crate::lifecycle::supervisor::Supervisor;
        use windows_sys::Win32::System::Threading::{OpenProcess, SetEvent, TerminateProcess, PROCESS_TERMINATE};

        const AT_ONCE: usize = 32;
        let go = engine_watch::new_event().unwrap();
        let mut racers = Vec::new();
        for i in 0..AT_ONCE {
            let sup = Supervisor::spawn(engines_for_test(), "test-contradicted");
            let teardown = sup.clone();
            let theirs = go.duplicate().unwrap();
            let (pid, generation) = sup
                .run(move |engines: &mut Engines, _| {
                    engines.when_an_engine_ends(Arc::new(move |generation| {
                        let _ = teardown.run_detached(move |engines: &mut Engines, _| {
                            engines.end_dead_session(generation);
                        });
                    }));
                    let child = engine_stand_in();
                    let pid = child.id();
                    let g = engines.begin_test_session_watched_by("XRAY_TROJAN", child, Box::new(GoneWhen(theirs)));
                    (pid, g)
                })
                .await
                .unwrap();
            racers.push((i, sup, pid, generation));
        }

        // Every watch reports at once; the odd ones race a Disconnect.
        let start = Arc::new(std::sync::Barrier::new(AT_ONCE + 1));
        let mut threads = Vec::new();
        for (i, sup, _, _) in &racers {
            let (i, sup, start) = (*i, sup.clone(), Arc::clone(&start));
            threads.push(std::thread::spawn(move || {
                start.wait();
                if i % 2 == 1 {
                    let _ = sup.run_detached(|engines: &mut Engines, token| {
                        adopt_token(token);
                        let _ = crate::lifecycle::teardown::hard_stop(engines);
                    });
                }
            }));
        }
        start.wait();
        // SAFETY: the event is open.
        unsafe { SetEvent(go.raw()) };
        for t in threads {
            t.join().unwrap();
        }

        for (i, sup, _, g) in &racers {
            let g = *g;
            let mut settled = None;
            for _ in 0..200 {
                let state = sup
                    .run(move |engines: &mut Engines, _| {
                        (
                            engines.has_session(),
                            engines.session_rearms(),
                            engines.session_is_watched(),
                            recorded(engines, g),
                            engines.sessions_ended(),
                        )
                    })
                    .await
                    .unwrap();
                let done = if i % 2 == 0 { state.1 >= 1 && state.2 && !state.3 } else { !state.0 };
                if done {
                    // Long enough for anything still in flight to land.
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    settled = Some(
                        sup.run(move |engines: &mut Engines, _| {
                            (
                                engines.has_session(),
                                engines.session_is_watched(),
                                recorded(engines, g),
                                engines.ledger().confirmed_drop().is_some(),
                                engines.sessions_ended(),
                                engines.status().0,
                            )
                        })
                        .await
                        .unwrap(),
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (has, watched, on_record, confirmed, ended, up) =
                settled.unwrap_or_else(|| panic!("racer {i}: never settled"));
            if i % 2 == 0 {
                assert!(has, "racer {i}: a live tunnel was taken down over a contradicted report");
                assert!(watched, "racer {i}: left unwatched");
                assert!(!on_record && !confirmed, "racer {i}: the contradicted report stayed on record");
                assert_eq!(ended, 0, "racer {i}");
                assert!(up, "racer {i}: status said down over a live engine");
            } else {
                assert!(!has, "racer {i}: the Disconnect left a session");
                assert!(!confirmed, "racer {i}: a Disconnect's own teardown read as a confirmed drop");
                assert_eq!(ended, 1, "racer {i}: ended {ended} times");
                assert!(!up, "racer {i}");
            }
        }

        // The real deaths, all at once.
        let start = Arc::new(std::sync::Barrier::new(AT_ONCE / 2));
        let mut killers = Vec::new();
        for (_, _, pid, _) in racers.iter().filter(|r| r.0 % 2 == 0) {
            let (pid, start) = (*pid, Arc::clone(&start));
            killers.push(std::thread::spawn(move || {
                start.wait();
                // SAFETY: plain calls; the handle is closed straight after.
                unsafe {
                    let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                    if !h.is_null() {
                        TerminateProcess(h, 1);
                        windows_sys::Win32::Foundation::CloseHandle(h);
                    }
                }
            }));
        }
        for k in killers {
            k.join().unwrap();
        }
        for (i, sup, _, g) in racers.iter().filter(|r| r.0 % 2 == 0) {
            let g = *g;
            let mut result = None;
            for _ in 0..250 {
                let (has, ended, confirmed) = sup
                    .run(move |engines: &mut Engines, _| {
                        (
                            engines.has_session(),
                            engines.sessions_ended(),
                            engines.ledger().confirmed_drop().is_some_and(|e| e.generation == g),
                        )
                    })
                    .await
                    .unwrap();
                if !has {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let ended = sup.run(|engines: &mut Engines, _| engines.sessions_ended()).await.unwrap();
                    result = Some((ended, confirmed));
                    break;
                }
                let _ = ended;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (ended, confirmed) = result.unwrap_or_else(|| panic!("racer {i}: the real death was never torn down"));
            assert_eq!(ended, 1, "racer {i}: torn down {ended} times");
            assert!(confirmed, "racer {i}: the real death is not on record");
        }

        for (_, sup, _, _) in racers {
            let _ = sup
                .run(|engines: &mut Engines, _| {
                    engines.engine_gone = None;
                    end_test_session(engines);
                })
                .await;
        }
    }
}
