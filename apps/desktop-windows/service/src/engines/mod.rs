//! Engine lifecycle: bringing one VPN protocol up, tearing it down, and
//! reporting what is actually running.
//!
//! Every engine here is a real, official upstream binary (wireguard.exe,
//! xray.exe, openvpn.exe) rather than a reimplementation -- the same
//! philosophy the server-side agent was built on. This module's whole
//! job is to write the right config file and drive the right process,
//! invisibly.

/// IPv4 confined to the tunnel while a full tunnel is up -- see the
/// module's own comment.
mod confinement;
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
mod readiness;
/// "Repair my network" -- the superset teardown, reusing every module
/// above. A child of this one so it can call the same private teardowns
/// the disconnect path does rather than growing second copies of them.
pub(crate) mod repair;
pub mod route_table;
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
        /// Routes this session removes when it ends. For Xray, which
        /// routes nothing by itself, every route the service installed on
        /// its behalf. For OpenVPN, which acts on the server's pushed
        /// directives, the host routes it put on the physical uplink --
        /// taken over because nothing else would ever remove them; the
        /// half-defaults on its own adapter are purged by interface.
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
    /// The IPv4 confinement, shared with this session's engine watch so a
    /// drop report lets go of it from the watch's own thread (K2), and
    /// with the plan-error valve. Empty for a session never confined --
    /// see `confinement::Hold`.
    confinement: Arc<confinement::Hold>,
    /// The plan it was installed from, kept to put it back with a fresh
    /// LUID when a drop report turns out to be wrong.
    confinement_plan: Option<confinement::Plan>,
    /// The plan-error valve watching the engine's log after an install;
    /// stopped and joined with the session. See `confinement::run_valve`.
    valve: Option<crate::split_tunnel::worker::Worker>,
    /// The reset at connect's rescans, for its first seconds; stopped and
    /// joined with the session. See `Engines::reset_outside_the_tunnel`.
    rescan: Option<crate::split_tunnel::worker::Worker>,
}

impl Session {
    fn new(engine: Active, profile: &ConnectProfile, confinement: Arc<confinement::Hold>) -> Self {
        Self {
            engine,
            profile: profile.clone(),
            filters: SessionFilters::default(),
            generation: 0,
            watch: None,
            armed_at: Instant::now(),
            rearms: 0,
            confinement,
            confinement_plan: None,
            valve: None,
            rescan: None,
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

/// "XRAY_TROJAN, exit code 1": the protocol, and the number the source
/// gave for the ending when it gave one -- named for who gave it.
fn describe_ending(protocol: &str, ended: Option<&engine_watch::Ended>) -> String {
    let code_is = match protocol {
        "IKEV2" => "RAS error",
        "WIREGUARD" => "service exit code",
        _ => "exit code",
    };
    match ended.and_then(|e| e.detail) {
        Some(code) => format!("{protocol}, {code_is} {code}"),
        None => protocol.to_string(),
    }
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
    /// it. See `ipv6_block` for the measurement, and for why WireGuard,
    /// once the exception, has one too.
    ipv6: Option<Ipv6Block>,
}

impl SessionFilters {
    /// Releases them, now. Dropping does the same; this exists so the
    /// teardown can say *when*.
    fn release(mut self) {
        if let Some(mut block) = self.ipv6.take() {
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
    /// The IPv4 confinement of a session that has just ended, held between
    /// `end_session` and `let_go_of_confinement` -- which every teardown
    /// calls the moment its engine has stopped, before DNS and phonebook
    /// tidying (K1) -- and nowhere else.
    ending_confinement: Option<Arc<confinement::Hold>>,
    /// What installing and holding a confinement does: the machine's WFP,
    /// except in tests.
    confinement_ops: Arc<dyn confinement::ConfinementOps>,
    /// The teardown steps as they ran, for the tests that pin their order.
    #[cfg(test)]
    teardown_steps: Vec<&'static str>,
    /// What happened to the tunnel's own DNS rule on this session.
    ///
    /// Beside `ipv6_block` and for the same reason: the app puts this in
    /// front of the customer in words, so it has to be a fact about the
    /// machine rather than a guess from the protocol name. WireGuard
    /// installs its own DNS and a Custom-mode tunnel deliberately leaves
    /// the machine's lookups alone, and both are `NotRequested` -- which
    /// is not a complaint and must never be shown as one.
    ///
    /// A full tunnel's is collected from `dns::tunnel_dns()` at the end of
    /// a connect rather than passed back up: `xray::configure_adapter`
    /// installs the rule from a free function two frames below any
    /// `Engines`, so there is nowhere to return it to. Custom mode's is
    /// recorded as it goes in, once the redirect is up
    /// (`pin_custom_mode_dns`). See `dns::TunnelDns` for the decision it
    /// records, which is that a tunnel comes up even when this fails and
    /// the customer is told.
    ///
    /// A Custom-mode pin given back while the tunnel is measured not to
    /// carry leaves this `Forced`: that is not a complaint the customer is
    /// shown, whose words say traffic flows. See `dns_pin`.
    dns_state: dns::TunnelDns,
    /// Custom mode's pin through this session: given back while the
    /// tunnel is measured not to carry, put back when it does. See
    /// `dns::PinWatch`. Forgotten with `dns_state`.
    dns_pin: dns::PinWatch,
    /// What putting the pin in, giving it back and putting it in again
    /// do. The machine's NRPT table, except in tests.
    pin_ops: Arc<dyn dns::PinOps>,
    /// What the pin is told about Custom mode, in place of the split
    /// tunnel's own answer: the tests cannot run its driver.
    #[cfg(test)]
    custom_mode_for_test: Option<CustomModeView>,
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
    /// The routing table, for the host routes this service owns on
    /// adapters that are not its own. The machine's, except in tests --
    /// see `route_table`.
    route_ops: Arc<dyn route_table::RouteOps>,
    /// The most recent generation a thorough pass -- `disconnect()` --
    /// has run after, with nothing begun since. Phase two after a drop
    /// is skipped for a generation already swept: a Disconnect or the app
    /// going away that reached the owning thread first has done it.
    swept_after: u64,
    /// The generation whose drop has already been written to
    /// `cleanup.log`, so the line is written once whichever teardown
    /// ends the session.
    drop_logged: u64,
    /// How many sessions have been ended, by any route. For the tests
    /// that prove a dead engine racing a Disconnect is torn down once.
    #[cfg(test)]
    sessions_ended: u32,
    /// How many thorough passes have run. For the test that proves
    /// phase two does not repeat one.
    #[cfg(test)]
    thorough_passes: u32,
}

impl Engines {
    pub fn new(exe_dir: PathBuf, config_dir: PathBuf) -> Self {
        let ledger = Arc::new(Ledger::new());
        let confinement_ops: Arc<dyn confinement::ConfinementOps> =
            Arc::new(confinement::System { log_dir: config_dir.clone() });
        Self {
            exe_dir,
            config_dir,
            active: Slot::with_ledger(Arc::clone(&ledger)),
            split_tunnel: SplitTunnel::new(),
            ending_filters: None,
            ending_confinement: None,
            confinement_ops,
            #[cfg(test)]
            teardown_steps: Vec::new(),
            dns_state: dns::TunnelDns::NotRequested,
            dns_pin: dns::PinWatch::default(),
            pin_ops: Arc::new(dns::MachinePin),
            #[cfg(test)]
            custom_mode_for_test: None,
            ledger,
            engine_gone: None,
            handshake_reading: None,
            wireguard_scm: Arc::new(wireguard::scm_view),
            route_ops: route_table::system(),
            swept_after: 0,
            drop_logged: 0,
            #[cfg(test)]
            sessions_ended: 0,
            #[cfg(test)]
            thorough_passes: 0,
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
            // Nothing to intercept before or after -- an empty list
            // flipped between "only these" and "all except these" -- is a
            // full tunnel either way, and a redirect has nothing to do on
            // it. Restarting one would bring Custom mode's machinery to a
            // session that is not in Custom mode, and `start_split_tunnel`
            // lets go of the IPv4 confinement it finds there, for good.
            if !now_intercepting {
                return Ok(());
            }
            if was_intercepting != now_intercepting || was_mode != now_mode {
                let Some(profile) = self.active.peek().map(|s| s.profile.clone()) else {
                    return Err(
                        "Custom mode changed, but this tunnel cannot be rebuilt without reconnecting."
                            .to_string(),
                    );
                };
                // Out while the redirect is down, which carries what it
                // pins; `start_split_tunnel` puts it back.
                self.unpin_custom_mode_dns();
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
        // No known servers: the rebuild has just torn down the session
        // whose own host route it would have found, and the delete before
        // the add covers a leftover to this server.
        self.connect(&profile, &[], &[])
    }

    pub fn split_tunnel_running(&self) -> bool {
        self.split_tunnel.is_running()
    }

    /// Whether this session is actually blocking IPv6 right now.
    ///
    /// Read from the installed block rather than inferred from the
    /// protocol, because the app puts this in front of the customer in
    /// words and the two can differ: a Custom-mode session has no block
    /// of ours at all, and an install that failed leaves none either. The
    /// rule in this product is that the UI never reports a state nothing
    /// verified, and "IPv6 is blocked" is exactly such a state.
    pub fn ipv6_blocked(&self) -> bool {
        self.active.peek().is_some_and(|s| s.filters.ipv6.is_some())
    }

    /// Whether this session's IPv4 is confined to its tunnel, read from
    /// its hold: `None` for a session never meant to be (the app must not
    /// warn), else whether it is right now. See `confinement::Hold`.
    pub fn ipv4_confined(&self) -> Option<bool> {
        self.active.peek().and_then(|s| s.confinement.confined())
    }

    /// Why this session's IPv4 is not confined, while it should be.
    pub fn confinement_problem(&self) -> Option<String> {
        self.active.peek().and_then(|s| s.confinement.problem())
    }

    /// Confines the session's IPv4 to its tunnel, where `confinement::plan_for`
    /// says so: a full Xray or OpenVPN tunnel. `nodes` are the servers the
    /// engine's own connection goes to, as the connect resolved them.
    ///
    /// Never fails the connect (the owner's decision (d)): the tunnel is up
    /// and carrying by now, and a confinement that cannot be planned or
    /// installed leaves it up, with the hold saying why -- the status poll
    /// reports `ipv4_confined: false` and the app does not claim full
    /// protection. cleanup.log says why too.
    fn confine_if_needed(&mut self, profile: &ConnectProfile, passive: bool, nodes: Vec<Ipv4Addr>) {
        use neoconnect_ipc::ConnectProfile as P;
        let engine_exe = match profile {
            P::XrayVlessReality(_) | P::XrayVlessTls(_) | P::XrayTrojan(_) | P::Shadowsocks(_) => {
                self.engine_path("xray.exe").ok()
            }
            P::Openvpn(_) => self.engine_path("openvpn.exe").ok(),
            P::Wireguard(_) | P::Ikev2(_) => None,
        };
        // Read only for a session that is confined: nothing else needs the
        // tunnel's LUID or the LAN.
        if !confinement::applies_to(profile, passive) {
            return;
        }
        let ops = Arc::clone(&self.confinement_ops);
        let luid = ops.luid(adapter_name_for(profile));
        let (lan, dhcp_servers) = machine_lan();
        let inputs = confinement::Inputs {
            tunnel_luid: *luid.as_ref().unwrap_or(&0),
            engine_exe,
            nodes,
            lan: confinement::Lan::Allowed(lan),
            dhcp_servers,
        };
        let Some(decision) = confinement::plan_for(profile, passive, inputs) else { return };
        let Some(session) = self.active.peek_mut() else { return };
        let mut witness = None;
        let refused = match decision {
            // The LUID's own error says more than "could not be read".
            Err(why) => Some(match luid {
                Err(e) => e,
                Ok(_) => why,
            }),
            Ok(plan) => match ops.install(&plan) {
                Ok(installed) => {
                    witness = Some(ops.witness(&plan, &installed));
                    session.confinement_plan = Some(plan);
                    session.confinement.put(installed);
                    None
                }
                Err(why) => Some(format!("the filters could not be installed: {why}")),
            },
        };
        if let Some(why) = refused {
            session.confinement.refuse(why.clone());
            crate::cleanup_log::note(
                "confine IPv4 to the tunnel",
                &format!("not confined, the tunnel left up: {why}"),
            );
            return;
        }
        if let Some(witness) = witness {
            self.start_valve(witness);
        }
    }

    /// The owner's decision (c): established IPv4 TCP connections outside
    /// the tunnel -- opened before Connect, or in the gap between two rungs
    /// -- are reset once at connect, so they come back through it.
    ///
    /// For the sessions that are confined (`confinement::applies_to`),
    /// whether or not the filters went in: a confinement re-examines open
    /// flows at their next packet (P0-D) and so stops them leaking, but only
    /// a reset tells an idle connection to come back. See
    /// `split_tunnel::OutsideTunnel` for what is left alone. One pass now,
    /// then the session's own rescans every quarter-second for
    /// [`RESET_RESCAN_FOR`], for rows that were mid-handshake at the first:
    /// `SetTcpEntry` cannot close a handshake. What each pass closed goes to
    /// confinement.log, which a capture's resets are checked against.
    fn reset_outside_the_tunnel(&mut self, profile: &ConnectProfile, passive: bool) {
        if !confinement::applies_to(profile, passive) {
            return;
        }
        let ops = Arc::clone(&self.confinement_ops);
        let log_dir = self.config_dir.clone();
        let Some(session) = self.active.peek_mut() else { return };
        let listed = adapters::list().unwrap_or_default();
        let mut tunnel_addresses = tunnel_addresses_in(&listed, adapter_name_for(profile), &OUR_ADAPTER_NAMES);
        if matches!(profile, ConnectProfile::XrayVlessReality(_) | ConnectProfile::XrayVlessTls(_) | ConnectProfile::XrayTrojan(_) | ConnectProfile::Shadowsocks(_))
            && !tunnel_addresses.contains(&xray::TUN_ADDRESS)
        {
            tunnel_addresses.push(xray::TUN_ADDRESS);
        }
        let lan = match &session.confinement_plan {
            Some(plan) => confinement::lan_reachable(&plan.lan),
            None => confinement::lan_reachable(&confinement::Lan::Allowed(machine_lan().0)),
        };
        let engine_pid = match &session.engine {
            Active::Child { child, .. } => Some(child.id()),
            Active::Ikev2(_) | Active::WireguardTunnel => None,
        };
        let rules = crate::split_tunnel::OutsideTunnel { tunnel_addresses, engine_pid, lan };

        let first = ops.reset(&rules);
        note_reset(&log_dir, "reset at connect", &first);
        let closed_at_first = first.closed;
        session.rescan = Some(crate::split_tunnel::worker::Worker::spawn(move |stop| {
            let deadline = Instant::now() + RESET_RESCAN_FOR;
            let (mut closed, mut passes, mut handshaking) = (closed_at_first, 0usize, first.skipped_handshaking);
            while Instant::now() < deadline {
                if !crate::split_tunnel::worker::sleep_unless_stopped(&stop, RESET_RESCAN_EVERY) {
                    return;
                }
                let outcome = ops.reset(&rules);
                closed += outcome.closed;
                handshaking = outcome.skipped_handshaking;
                passes += 1;
                if !outcome.closed_rows.is_empty() || !outcome.failures.is_empty() {
                    note_reset(&log_dir, "reset rescan", &outcome);
                }
            }
            confinement::note(
                &log_dir,
                &format!(
                    "reset settled after {passes} rescan(s): {closed} connection(s) closed in all{}",
                    if handshaking > 0 {
                        format!("; {handshaking} still mid-handshake at the end, which completed outside the tunnel or were refused")
                    } else {
                        String::new()
                    }
                ),
            );
        }));
    }

    /// Starts the plan-error valve on the live session (K5): WFP's record
    /// of what it refused, through `witness`, and its engine's log from
    /// where it stands now, for `confinement::VALVE_FOR`. Owned by the
    /// session, so it stops and is joined when the session ends. Xray and
    /// OpenVPN only, the engines confined.
    fn start_valve(&mut self, mut witness: confinement::Witness) {
        let config_dir = self.config_dir.clone();
        let Some(session) = self.active.peek_mut() else { return };
        let Some(plan) = &session.confinement_plan else { return };
        let log = match plan.transport {
            confinement::Transport::Xray { .. } => config_dir.join(xray::LOG_FILE),
            confinement::Transport::Openvpn { .. } => config_dir.join(openvpn::LOG_FILE),
            confinement::Transport::Ikev2 { .. } => return,
        };
        // Read before the thread starts, so a refusal written in between
        // is after it.
        let from = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        let transport = plan.transport.clone();
        let hold = Arc::clone(&session.confinement);
        session.valve = Some(crate::split_tunnel::worker::Worker::spawn(move |stop| {
            confinement::run_valve(&log, from, &transport, &hold, &stop, confinement::VALVE_FOR, &mut witness);
        }));
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
        // And whether this session had given its pin back: the next one
        // starts with its own, and nothing of this one's is put back.
        self.dns_pin.reset();
    }

    /// What Custom mode looks like to the pin right now.
    fn custom_mode_view(&self) -> CustomModeView {
        #[cfg(test)]
        if let Some(view) = self.custom_mode_for_test {
            return view;
        }
        CustomModeView {
            intercepting: self.split_tunnel.wants_passive_tunnel() && self.split_tunnel.is_running(),
            interception_stopped: self.split_tunnel.interception_stopped(),
        }
    }

    /// Gives Custom mode's DNS pin back while the tunnel is measured not to
    /// carry, and puts it back when it is shown to. See `dns::PinWatch` for
    /// the policy and what it costs.
    ///
    /// Only a Custom-mode session -- a passive tunnel with the redirect up --
    /// whose rule went in, or that this gave back: a full tunnel's rule is
    /// left alone, since every lookup there is meant to go through the
    /// tunnel and, with it stalled, so is every connection. `read` is asked
    /// only then, so a poll of any other session reads no log.
    fn keep_dns_pin(&mut self, read: impl FnOnce(&Self) -> dns::Carrying) {
        let custom = self.custom_mode_view();
        if !custom.intercepting {
            return;
        }
        if self.dns_state != dns::TunnelDns::Forced && !self.dns_pin.released() {
            return;
        }
        let reading = if custom.interception_stopped { dns::Carrying::InterceptionStopped } else { read(self) };
        match self.dns_pin.observe(reading, Instant::now()) {
            dns::PinMove::Keep => {}
            dns::PinMove::Release => {
                self.pin_ops.release();
                crate::cleanup_log::note(
                    "give the machine its own DNS back while Custom mode's tunnel is not carrying",
                    &format!(
                        "{reading:?}; the NRPT rule is out and this PC resolves through its own network, \
                         the selected applications' lookups included, until the tunnel is shown to carry again"
                    ),
                );
            }
            dns::PinMove::Restore => {
                let state = self.pin_ops.restore(dns::CUSTOM_MODE_RESOLVER);
                self.dns_pin.restored(state == dns::TunnelDns::Forced);
                if state == dns::TunnelDns::Forced {
                    crate::cleanup_log::note(
                        "pin DNS to the tunnel again now that Custom mode's tunnel carries",
                        "the NRPT rule is back and the DNS cache was flushed",
                    );
                }
                // Unforced is reported in the status poll from here, as at
                // connect: the tunnel carries and the lookups are not
                // pinned to it.
                self.dns_state = state;
            }
        }
    }

    /// Puts Custom mode's DNS rule in, once its redirect carries lookups,
    /// and records what became of it on the session.
    ///
    /// Here, and not in any engine's connect: every engine used to put it
    /// in inside its own connect, seconds before the redirect started, and
    /// in between every lookup on the PC was pinned to 1.1.1.1 with nothing
    /// to carry it into the tunnel. They left by the physical adapter in
    /// clear text, seen at the NIC on the VM during a WireGuard and an Xray
    /// Custom-mode connect. Until this runs the lookups go where they went
    /// before Connect, as the selected applications' connections do until
    /// the redirect is up; the caller flushes what was answered meanwhile.
    ///
    /// Only Custom mode -- a passive tunnel with its redirect up, as the
    /// pin's watch reads it (`custom_mode_view`) -- and the watch starts
    /// afresh with the rule. A rule that will not go in is reported in the
    /// status poll as unpinned DNS and never fails the connect
    /// (`dns::TunnelDns`).
    fn pin_custom_mode_dns(&mut self) {
        let Some(resolver) = dns::custom_mode_rule(self.custom_mode_view().intercepting) else {
            return;
        };
        self.dns_pin.reset();
        self.dns_state = self.pin_ops.install(resolver);
    }

    /// Takes Custom mode's rule out before its redirect is stopped to be
    /// started again in place: while the redirect is down nothing carries
    /// the lookups it pins. `start_split_tunnel` puts it back. A rule the
    /// watch has already given back is not taken out twice, and a full
    /// tunnel's is not touched.
    fn unpin_custom_mode_dns(&mut self) {
        if !self.custom_mode_view().intercepting {
            return;
        }
        if self.dns_state == dns::TunnelDns::Forced && !self.dns_pin.released() {
            self.pin_ops.release();
        }
        self.forget_dns_state();
    }

    /// Installs a session around a process the test started, exactly as a
    /// connect would -- watch included -- without touching the network.
    /// Returns its generation.
    #[cfg(test)]
    pub(crate) fn begin_test_session(&mut self, protocol: &'static str, child: Child) -> u64 {
        self.begin_test_session_with_routes(protocol, child, InstalledRoutes::none())
    }

    /// A session around a process the test started, for `profile`.
    #[cfg(test)]
    fn begin_test_session_for(&mut self, profile: &ConnectProfile, protocol: &'static str, child: Child) -> u64 {
        self.begin_session(Active::Child { protocol, child, routes: InstalledRoutes::none() }, profile);
        self.active.peek().map_or(0, |s| s.generation)
    }

    /// The same, with routes for the session to own.
    #[cfg(test)]
    fn begin_test_session_with_routes(&mut self, protocol: &'static str, child: Child, routes: InstalledRoutes) -> u64 {
        self.begin_session(Active::Child { protocol, child, routes }, &test_profile());
        self.active.peek().map_or(0, |s| s.generation)
    }

    /// Points this instance at a confinement the test owns. Before the
    /// session begins: its hold is made then.
    #[cfg(test)]
    fn set_confinement_ops_for_test(&mut self, ops: Arc<dyn confinement::ConfinementOps>) {
        self.confinement_ops = ops;
    }

    /// Confines the live session the way a connect does, through the ops:
    /// an Xray plan to one server, the LAN allowed. Returns whether it is
    /// now held.
    #[cfg(test)]
    fn confine_for_test(&mut self) -> bool {
        let ops = Arc::clone(&self.confinement_ops);
        let Some(session) = self.active.peek_mut() else { return false };
        let luid = ops.luid(adapter_name_for(&session.profile)).expect("a LUID");
        let plan = confinement::Plan {
            tunnel_luid: luid,
            transport: confinement::Transport::Xray {
                exe: PathBuf::from(r"C:\Program Files\Neoxify\xray.exe"),
                nodes: vec![Ipv4Addr::new(203, 0, 113, 7)],
            },
            lan: confinement::Lan::Allowed(Vec::new()),
            dhcp_servers: Vec::new(),
        };
        let installed = ops.install(&plan).expect("installed");
        session.confinement_plan = Some(plan);
        session.confinement.put(installed)
    }

    /// Records a teardown step, for the tests that pin their order.
    fn mark(&mut self, _step: &'static str) {
        #[cfg(test)]
        self.teardown_steps.push(_step);
    }

    /// Points this instance at a routing table the test owns.
    #[cfg(test)]
    fn set_route_ops_for_test(&mut self, ops: Arc<dyn route_table::RouteOps>) {
        self.route_ops = ops;
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
            .fill(Session::new(Active::Child { protocol, child, routes: InstalledRoutes::none() }, &test_profile(), self.confinement_ops.hold()));
        let hold = self.active.peek().map(|s| Arc::clone(&s.confinement)).expect("just filled");
        let guard = engine_watch::watch(generation, protocol, first_watch, self.report_to(hold)).expect("starting a watch");
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

    #[cfg(test)]
    pub(crate) fn thorough_passes(&self) -> u32 {
        self.thorough_passes
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
    ///
    /// A reply is also what puts Custom mode's DNS pin back after it was
    /// given back (`keep_dns_pin`), before the answer reaches the app: the
    /// "connected" it leads to is never shown over a pin still out, unless
    /// putting it back failed -- which the status poll then reports as
    /// unpinned DNS, as it would at connect.
    pub fn probe_split_tunnel(&mut self) -> Result<(), String> {
        let outcome = self.split_tunnel.probe();
        self.note_probe(&outcome);
        outcome
    }

    /// What a split-tunnel probe tells the pin. A reply the destination had
    /// to send is the strongest "carrying" there is. A failure is told
    /// nothing: it has been seen to fail while the tunnel carried, which is
    /// why the app reads it as "unverified", and the pin is given back only
    /// on a measurement (`dns::PinWatch`) -- nor does it interrupt the run of
    /// readings that one is building up.
    fn note_probe(&mut self, outcome: &Result<(), String>) {
        if outcome.is_ok() {
            self.keep_dns_pin(|_| dns::Carrying::Yes);
        }
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

    /// The ledger of host routes this service owes the machine. See
    /// `route_table::OwedRoutes`.
    fn owed_routes(&self) -> route_table::OwedRoutes {
        route_table::OwedRoutes::in_dir(&self.config_dir)
    }

    /// Tears down whatever is up, then brings up `profile`. Teardown
    /// happens first and unconditionally so that switching servers can
    /// never leave two engines fighting over the system routing table.
    /// Wraps the real work so that EVERY failure path picks up the hint,
    /// rather than the two or three someone remembered to decorate.
    pub fn connect(
        &mut self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
    ) -> Result<(), String> {
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
        let rivals = adapters::other_vpns_up(&OUR_ADAPTER_NAMES).unwrap_or_default();
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
        self.connect_inner(profile, exits, known_nodes, &limits)
            .map_err(|e| with_rival_hint(e, &rivals))
    }

    fn connect_inner(
        &mut self,
        profile: &ConnectProfile,
        exits: &[ExitProfile],
        known_nodes: &[String],
        limits: &crate::lifecycle::budget::Limits,
    ) -> Result<(), String> {
        profile.validate().map_err(|e| e.to_string())?;

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

        let cleared = self.disconnect();
        // A drop recorded from an earlier session stops being the answer
        // once this connect is past clearing the decks. Left standing, a
        // status answered from the ledger while the connect holds the
        // owning thread would report the old tunnel's death over the new
        // one.
        //
        // After the `disconnect` above rather than before it: that is
        // the teardown which ends a dead session whose own teardown had
        // not run yet, and it is the record that lets it say so in
        // `cleanup.log` (see `end_session`). Until the new engine starts
        // there is no tunnel, so the record answers truthfully meanwhile.
        //
        // And whether or not that pass succeeded. One that failed may
        // have left something of the old tunnel up, and a record saying
        // "no tunnel" is then exactly the answer that must not stand.
        self.ledger.forget();
        cleared?;
        // Before anything of the new session is built, and on a table the
        // teardown above has just cleared of everything this process held.
        self.purge_stale_node_routes(known_nodes, &our_interfaces());
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

        // The servers the engine's own connection goes to, as this connect
        // resolved them: what the IPv4 confinement permits the engine to
        // reach around the tunnel, and nothing else.
        let mut confine_nodes: Vec<Ipv4Addr> = Vec::new();

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
                // ESP's permit names the server's address; IKE's does not
                // (K3). Only asked while IKEv2's plan is on, which it is
                // not until its own VM gate passes (`IKEV2_CONFINED`).
                if confinement::applies_to(profile, passive) {
                    if let Ok(node) = node_address(profile, limits) {
                        confine_nodes.push(node);
                    }
                }
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

                // The way out to the server, while nothing of ours is
                // routed yet -- see `xray::plan_uplink`. Custom mode
                // routes nothing around the tunnel, so it asks nothing.
                let uplink = if passive { None } else { Some(xray::plan_uplink(&outbound, limits)?) };
                // The address the host route is for is the one xray.exe is
                // permitted to: the two agree, as they must. Exits named by
                // address are permitted too; one named by a hostname is
                // left out -- in a full tunnel its connection is routed
                // into the tunnel, whose interface is permitted anyway.
                if let Some(plan) = &uplink {
                    confine_nodes.push(plan.server);
                    for (_, exit) in &extra {
                        if let Ok(address) = exit.host().parse::<Ipv4Addr>() {
                            confine_nodes.push(address);
                        }
                    }
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
                let prepared = match uplink {
                    None => xray::prepare_passive(&outbound, limits).map(|_| InstalledRoutes::none()),
                    Some(plan) => xray::install_routes(plan, Arc::clone(&self.route_ops), self.owed_routes(), limits),
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
                let (child, added) = openvpn::connect(self, p, passive, limits)?;
                let routes = self.openvpn_routes(added);
                let engine = Active::Child { protocol: "OPENVPN", child, routes };
                self.begin_session(engine, profile);
                // The address openvpn.exe was told to dial: a literal, as
                // nodes are registered, at once; a hostname resolved the way
                // the split tunnel resolves it. One that cannot be leaves
                // the session unconfined, and says so.
                if !passive {
                    if let Ok(node) = node_address(profile, limits) {
                        confine_nodes.push(node);
                    }
                }
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
        // And IPv4, for a full tunnel on an engine with no kill switch of
        // its own: everything outside the tunnel refused but the engine's
        // link to its servers, the LAN, DHCP and loopback. See
        // `confinement`. A failure leaves the tunnel up and is reported.
        self.confine_if_needed(profile, passive, confine_nodes);
        // Then what was opened outside it before, so it comes back through
        // it: the owner's decision (c).
        self.reset_outside_the_tunnel(profile, passive);
        // Whatever the engine above reported about a full tunnel's DNS
        // rule, collected onto the session now that there is one. Read
        // rather than returned because the engines install it from free
        // functions with no `Engines` to hand it back to. Custom mode's
        // was recorded as it went in, once the redirect was up
        // (`pin_custom_mode_dns`).
        if !passive {
            self.dns_state = dns::tunnel_dns();
        }
        Ok(())
    }

    /// Removes host routes to our own servers that an earlier session left
    /// on an adapter that is not ours.
    ///
    /// The second net under the ledger, and the only one for what was
    /// left before the ledger existed: releases up to 0.9.48 left a host
    /// route to the server on the physical adapter after every OpenVPN
    /// session, and those are on customers' machines now. Measured on the
    /// VM, one of them sent the next session's checks against that node's
    /// mirror around the tunnel and moved the customer off a working
    /// server. See `route_table::stale_node_routes` for what qualifies.
    ///
    /// Only addresses: a name in the list is ignored rather than resolved,
    /// because a host route is to an address, and the names the app sends
    /// are IKEv2 certificate names whose server it also lists by address.
    /// Bounded, so a caller cannot make this walk the table for an
    /// unbounded list.
    fn purge_stale_node_routes(&self, known_nodes: &[String], ours: &[u32]) {
        let nodes: Vec<Ipv4Addr> =
            known_nodes.iter().take(MAX_KNOWN_NODES).filter_map(|host| host.trim().parse().ok()).collect();
        if nodes.is_empty() {
            return;
        }
        let Ok(rows) = self.route_ops.rows() else { return };
        let owed = self.owed_routes();
        let mut removed = Vec::new();
        for row in route_table::stale_node_routes(&rows, &nodes, ours) {
            match self.route_ops.delete(&row) {
                Ok(()) => {
                    owed.settle(&row);
                    removed.push(format!("{}/{}", row.dest, row.prefix));
                }
                Err(why) => crate::cleanup_log::note(
                    "remove a host route to a server an earlier session left",
                    &format!("{}/{}: {why}", row.dest, row.prefix),
                ),
            }
        }
        if !removed.is_empty() {
            crate::cleanup_log::note(
                "remove a host route to a server an earlier session left",
                &format!("removed {}", removed.join(", ")),
            );
        }
    }

    /// The routes an OpenVPN session owns: the host routes openvpn.exe
    /// added on the uplink, taken over so that every teardown -- a
    /// Disconnect, a dead engine's, the hard stop -- removes them, and owed
    /// in the ledger in case none of those runs. See
    /// `InstalledRoutes::adopted`.
    fn openvpn_routes(&self, added: Vec<route_table::RouteRow>) -> InstalledRoutes {
        InstalledRoutes::adopted(added, Arc::clone(&self.route_ops), self.owed_routes())
    }

    /// Blocks IPv6 for a full tunnel, on the engines that would
    /// otherwise leak it.
    ///
    /// Two gates, and both are load-bearing.
    ///
    /// **Custom mode is excluded**, which is what `wants_interception`
    /// asks. The 0.9.27 block in `split_tunnel/intercept` already
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
    /// **WireGuard is included**, beside `wireguard.exe`'s own kill-switch,
    /// so that IPv6 fails on the PC at once rather than vanishing into a
    /// tunnel with no IPv6 at either end; see `ipv6_block::needed_for`.
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
    /// the session. What that is, is [`filter_plan`]'s to say.
    fn filters_for(&self, profile: &ConnectProfile) -> SessionFilters {
        let mut filters = SessionFilters::default();
        let plan = filter_plan(profile, self.split_tunnel.wants_interception());
        if !plan.ipv6_block {
            return filters;
        }
        let dns = if plan.dns_confinement { self.dns_confinement_for(profile) } else { None };
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
    /// `block-outside-dns` (`filter_plan`). Measured on a Windows 11 guest with a query
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
        // Custom mode is never confined (`confinement::applies_to`): a
        // machine-wide IPv4 block would take the internet from the
        // applications the customer kept out of the VPN. Nothing reaches
        // here confined; if something ever did, it is let go of rather than
        // left under the redirect.
        if let Some(session) = self.active.peek() {
            debug_assert_ne!(session.confinement.confined(), Some(true), "a Custom-mode session was confined");
            session.confinement.release(confinement::Release::Teardown);
        }
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
        // Custom mode's DNS rule, now that the redirect carries what it
        // pins (`pin_custom_mode_dns`), and not before.
        self.pin_custom_mode_dns();
        // Then the cache. Until the rule went in, lookups went to the
        // network's own resolver, and on a line that hijacks port 53 the
        // block page's answer was cached and would be served to the
        // selected applications through the redirect afterwards.
        dns::flush_cache();
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
        let hold = self.confinement_ops.hold();
        let generation = self.active.fill(Session::new(engine, profile, Arc::clone(&hold)));

        let started = liveness.and_then(|liveness| {
            engine_watch::watch(generation, label, liveness, self.report_to(hold))
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
    fn report_to(&self, confinement: Arc<confinement::Hold>) -> engine_watch::OnGone {
        let ledger = Arc::clone(&self.ledger);
        let sink = self.engine_gone.clone();
        Arc::new(move |gone: engine_watch::Gone| {
            // First, on any report -- definitive or not, news or not --
            // and here, on the watch's own thread. The owning thread may
            // be busy (a diagnostics snapshot, a probe), and phase one is
            // queued behind it; a dead tunnel's IPv4 block must not wait
            // for it (K2). If the engine turns out to be alive, phase one
            // puts it back (`confine_again`).
            confinement.release(confinement::Release::Dropped);
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
        // The report let go of the confinement on the watch's thread; the
        // engine is alive, so it goes back. Its hold is re-armed *before*
        // the new watch starts: a report from that watch -- the engine
        // dying a moment after it was found alive -- must find the hold
        // marked dropped, so the confinement put back after it is let go
        // of at once. Re-armed after, it erased that mark, and a dead
        // engine's confinement was held until a phase one queued behind
        // whatever the owning thread was doing (K2).
        let owed = self.active.peek().is_some_and(|session| {
            let owed = session.confinement.owed_after_drop();
            if owed {
                session.confinement.rearm();
            }
            owed
        });
        self.rearm_watch(retracted);
        if owed {
            self.confine_again();
        }
        false
    }

    /// Puts back a confinement a drop report let go of, once the engine is
    /// shown to be running (K2), with the tunnel adapter's LUID read again:
    /// a RAS interface can come back from a MOBIKE move with a new one, and
    /// a permit for the old one would block the tunnel it was for.
    ///
    /// Only for a confinement owed after a drop report, its hold already
    /// re-armed (`end_dead_session`, before the new watch). A plan the
    /// engine tripped over is never put back: `Hold::put` refuses it, as it
    /// refuses one a later drop report let go of. A put-back that fails
    /// leaves the session unconfined and says why, as at connect.
    fn confine_again(&mut self) {
        let ops = Arc::clone(&self.confinement_ops);
        let Some(session) = self.active.peek() else { return };
        let Some(plan) = session.confinement_plan.clone() else { return };
        let hold = Arc::clone(&session.confinement);
        let adapter = adapter_name_for(&session.profile);
        let installed = ops.luid(adapter).and_then(|tunnel_luid| {
            let plan = confinement::Plan { tunnel_luid, ..plan };
            ops.install(&plan).map(|installed| (ops.witness(&plan, &installed), installed))
        });
        let mut put_back = None;
        let detail = match installed {
            Ok((witness, installed)) => {
                if hold.put(installed) {
                    put_back = Some(witness);
                    "put back, with the tunnel adapter's LUID read again".to_string()
                } else {
                    "let go of again at once: another report came in while it went back".to_string()
                }
            }
            Err(why) => {
                hold.refuse(format!("could not be put back after the engine was reported gone: {why}"));
                format!("not put back: {why}")
            }
        };
        crate::cleanup_log::note("the IPv4 confinement after a drop report the engine contradicted", &detail);
        if let Some(witness) = put_back {
            // A plan put back is a plan installed: watched like one.
            self.start_valve(witness);
        }
    }

    /// Starts the live session's watch again, after a report its engine
    /// contradicted. See [`Self::end_dead_session`].
    ///
    /// Spaced: a watch armed within [`REARM_SPACING`] of the last one
    /// waits that long before its first look, so a source that keeps
    /// reporting endings the engine keeps contradicting costs one look a
    /// second rather than a loop through this thread.
    fn rearm_watch(&mut self, retracted: bool) {
        let Some(hold) = self.active.peek().map(|s| Arc::clone(&s.confinement)) else {
            return;
        };
        let report = self.report_to(hold);
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
    ///
    /// And only once. A Disconnect, or the app going away, that reached
    /// this thread between phase one and here queued its own thorough
    /// pass ahead of this one; it swept the same machine for the same
    /// ended session, and a second sweep -- which can reach the cmdlets
    /// -- would find nothing to do and take seconds doing it.
    pub fn finish_dead_session(&mut self, generation: u64) {
        if !self.active.is_empty() || !self.ledger.is_latest(generation) {
            return;
        }
        if self.swept_after == generation {
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
    /// no waiting for anything to disappear. At most two `route.exe`, for
    /// Xray's half-defaults or OpenVPN's pushed ones, the same allowance
    /// the hard stop has, and for the same reason -- the record of which
    /// routes were installed ends with the session. The host route to the
    /// node is deleted natively.
    ///
    /// The order is the order of harm. Custom mode first (inside
    /// `end_session`), because its redirect is pinned to an adapter that
    /// no longer exists and would otherwise go on swallowing the selected
    /// applications' traffic. Then the IPv4 confinement -- which permits
    /// nothing but the dead adapter, so until it goes the machine has no
    /// internet at all; the watch's report has usually let go of it
    /// already, and the engine is stopped by definition here -- then the
    /// routes, then the IPv6 block's WFP filters, whose DNS
    /// confinement permits port 53 only through the dead adapter, so until
    /// they go no plain DNS lookup on the machine succeeds, then the NRPT
    /// rule, by registry.
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
        // This function writes the log line; `end_session` must not.
        self.drop_logged = generation;

        let engine = self.end_session();
        let protocol = engine.as_ref().map_or("unknown", Active::protocol);
        // The engine has ended already: that is why this runs.
        self.mark("engine stopped");
        // Usually let go of already, by the watch's report; this is the
        // poll's path and the net under it (K2). Before the route.exe
        // deletes, which would otherwise run with the machine refused
        // everything they send to the physical adapter (K1).
        self.let_go_of_confinement();
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
                self.mark("routes removed");
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
        self.mark("dns cleared");
        let dns = dns::clear_registry_only();
        self.forget_dns_state();

        let mut detail = format!(
            "{}, noticed by {}",
            describe_ending(protocol, ended.as_ref()),
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
        // A drop on record that its own teardown never got to: a
        // Disconnect, a connect clearing the decks, or the app going
        // away reached this thread between the watch's report and phase
        // one, and phase one then found the slot empty and did nothing.
        // The session still ended on its own, and support reads this log
        // to find out why a tunnel went -- so it is written here, the one
        // place every route out of the slot passes. `tear_down_dead_session`
        // writes its own fuller line and marks the generation first.
        if self.drop_logged != session.generation {
            if let Some(ended) = self.ledger.ended_without_successor().filter(|e| e.generation == session.generation) {
                self.drop_logged = session.generation;
                crate::cleanup_log::note(
                    "the tunnel engine ended on its own",
                    &format!(
                        "{}, noticed by the engine watch{}; the session was then ended by another teardown -- a Disconnect, a connect or the app going away -- before the watch's own ran",
                        describe_ending(session.engine.protocol(), Some(&ended)),
                        if ended.confirmed { "" } else { " (not confirmed: the engine was not asked again)" },
                    ),
                );
            }
        }
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
        // The IPv4 confinement is parked the same way, for the step every
        // teardown takes the moment its engine has stopped
        // (`let_go_of_confinement`).
        if let Some(earlier) = self.ending_confinement.replace(session.confinement) {
            earlier.release(confinement::Release::Teardown);
        }
        Some(session.engine)
    }

    /// Lets go of the IPv4 confinement of the session just ended. Called
    /// by every teardown the moment its engine has stopped and its routes
    /// are gone, before anything slower: DNS, the phonebook entry, the
    /// OpenVPN adapter's routes by PowerShell, the IPv6 block. Held through
    /// those, every Disconnect and every rung of the ladder would black the
    /// machine out for as long as they take (K1). Safe to call when there
    /// is nothing to let go of.
    fn let_go_of_confinement(&mut self) {
        if let Some(hold) = self.ending_confinement.take() {
            hold.release(confinement::Release::Teardown);
            self.mark("confinement released");
        }
    }

    /// Releases the filters of the session just ended: the machine-wide
    /// IPv6 block, with the DNS confinement in it.
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
        // Every teardown has let go of the confinement already, straight
        // after its engine; this is the net under a path that did not.
        self.let_go_of_confinement();
        if let Some(filters) = self.ending_filters.take() {
            filters.release();
            self.mark("ipv6 released");
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
                janitor::reconcile(&self.exe_dir, &self.owed_routes(), &*self.route_ops);
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
                self.mark("engine stopped");
                // Before the phonebook entry, whose removal can fall back
                // to PowerShell for seconds (K1).
                self.let_go_of_confinement();
                self.mark("phonebook removed");
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
                self.mark("routes removed");
                let _ = child.kill();
                self.mark("engine stopped");
                // The engine is killed and its routes are gone: the IPv4
                // confinement goes now, before the reap (up to REAP_BUDGET),
                // the OpenVPN purge below (PowerShell, seconds) and the DNS
                // sweep. With the routes out, everything it still held was
                // headed for the physical adapter and refused there (K1).
                self.let_go_of_confinement();
                reap(&mut child);
                self.mark("engine reaped");

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

        // The arms above that had a confinement let go of it straight after
        // their engine; this covers the ones that had none (WireGuard, an
        // empty slot) and an arm that returned early.
        self.let_go_of_confinement();
        // Unconditionally, like the config wipe: an NRPT rule left
        // behind points the whole machine's lookups at a resolver that
        // is no longer reachable, which presents as "no website loads
        // at all" long after the VPN is gone. Cheap, and safe when
        // there is nothing to remove.
        self.mark("dns cleared");
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
        // The slot is empty now, so the latest session to have begun has
        // ended and this pass has swept up after it. Phase two after a
        // drop reads this so as not to sweep the same machine twice.
        self.swept_after = self.ledger.latest();
        #[cfg(test)]
        {
            self.thorough_passes += 1;
        }
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
                } else {
                    match ikev2::connection_state() {
                        Some(true) => Verdict::Reported(true, Some("IKEV2".to_string()), TunnelHealth::Unknown),
                        // Nothing tracked and nothing running. Not answered
                        // here: `NothingTracked` below still takes the idle
                        // steps -- Custom mode stopped, the IPv6 block
                        // released, the NRPT rule cleared, the janitor run --
                        // because an untracked slot is exactly the shape the
                        // field bug left behind, and a redirect loop may well
                        // be running underneath it. Stopping one that is not
                        // there costs nothing.
                        //
                        // `Down` only when Windows answered. A PowerShell
                        // that failed says nothing about an IKEv2 tunnel this
                        // service did not start -- one left up across a
                        // service restart, which the app may be showing --
                        // and `Down` is what the app reads as that tunnel
                        // having ended. See `os_visible_tunnel`.
                        Some(false) => Verdict::NothingTracked(TunnelHealth::Down),
                        None => Verdict::NothingTracked(TunnelHealth::Unknown),
                    }
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
            Verdict::Reported(up, protocol, health) => {
                // OpenVPN's own log is the one measurement of its link this
                // poll can take; the other engines answer `Unknown` here and
                // keep their pin through a stall, as before.
                let openvpn = up && protocol.as_deref() == Some("OPENVPN");
                self.keep_dns_pin(|engines| {
                    if openvpn {
                        openvpn::link_reading(&openvpn::log_tail(engines))
                    } else {
                        dns::Carrying::Unknown
                    }
                });
                (up, protocol, health)
            }
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
                self.keep_dns_pin(|_| wireguard::carrying(reading));
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
            Verdict::NothingTracked(health) => {
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
                janitor::reconcile(&self.exe_dir, &self.owed_routes(), &*self.route_ops);

                (false, None, health)
            }
        }
    }
}

/// What Custom mode's DNS pin is told about the split tunnel. See
/// [`Engines::keep_dns_pin`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CustomModeView {
    /// A passive tunnel with the redirect up: Custom mode, whose pin this
    /// is.
    intercepting: bool,
    /// The backstop has switched interception off under it.
    interception_stopped: bool,
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
    /// No session, and nothing of ours visible on the machine. With the
    /// health to report: `Down` when every question was answered,
    /// `Unknown` when one was not.
    NothingTracked(TunnelHealth),
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
/// unknown rather than guessed -- and so is the health of a tunnel it
/// cannot see, for the reason given at the end.
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
    // Nothing visible is not the same as nothing running, so this says
    // `Unknown`, not `Down` -- which the IPC defines as "nothing is
    // running", and which `Engines::status` and the ledger give from the
    // engine itself. None of the looks above is that. An Xray adapter is
    // briefly absent while a Custom-mode rebuild holds the owning thread;
    // `ikev2::is_connected` answers false when PowerShell fails or times
    // out. The app reads `connected: false` with `Down` as the tunnel
    // ended and with `Unknown` as a question nobody could answer, and only
    // the first is grounds to tell a customer their connection was lost.
    // Shipped apps read every `connected: false` the same way whatever the
    // health says, so to them nothing changes.
    (false, None, TunnelHealth::Unknown)
}

/// Which WFP filters a session gets: the machine-wide IPv6 block, and DNS
/// confined to the tunnel. Decided before anything is installed, so the
/// decision can be tested where WFP cannot be.
#[derive(Debug, Default, PartialEq, Eq)]
struct FilterPlan {
    ipv6_block: bool,
    dns_confinement: bool,
}

/// The filters for a tunnel of `profile`, in Custom mode or not.
///
/// Custom mode gets none: its redirect covers the selected applications
/// per application, and a machine-wide filter would change the behaviour
/// of the ones the customer kept out of the VPN (see
/// `Engines::block_ipv6_if_needed`). A full tunnel gets the IPv6 block
/// where `ipv6_block::needed_for` says so, and DNS confinement on every
/// engine but OpenVPN, whose config carries `block-outside-dns` -- the
/// same filters, written by OpenVPN (`Engines::dns_confinement_for`).
fn filter_plan(profile: &ConnectProfile, custom_mode: bool) -> FilterPlan {
    if custom_mode {
        return FilterPlan::default();
    }
    FilterPlan {
        ipv6_block: ipv6_block::needed_for(profile),
        dns_confinement: !matches!(profile, ConnectProfile::Openvpn(_)),
    }
}

/// The most server addresses a connect will look for host routes to. An
/// account holds a handful of credentials, each naming its server two or
/// three ways; this is far above that, and far below anything that would
/// make the purge cost noticeable.
const MAX_KNOWN_NODES: usize = 256;

/// Every adapter this service's engines bring up, by the name Windows
/// shows. What "ours" means wherever a route or an adapter has to be told
/// apart from the customer's -- the rival-VPN hint, the uplink, and the
/// host routes taken over from OpenVPN.
const OUR_ADAPTER_NAMES: [&str; 4] =
    [xray::ADAPTER_NAME, wireguard::TUNNEL_NAME, openvpn::ADAPTER_NAME, ikev2::ENTRY_NAME];

/// The interface indexes of [`OUR_ADAPTER_NAMES`] that exist right now.
/// Empty when the adapters cannot be listed, which only ever makes the
/// callers take fewer routes for the customer's.
fn our_interfaces() -> Vec<u32> {
    adapters::list()
        .map(|all| all.into_iter().filter(|a| OUR_ADAPTER_NAMES.contains(&a.name.as_str())).map(|a| a.index).collect())
        .unwrap_or_default()
}

/// How long the reset at connect goes on rescanning, and how often. The
/// same shape as Custom mode's activation reset (`split_tunnel::session::
/// convergence`), for the same reason: a connection in SYN_SENT at the
/// first pass is closeable a few hundred milliseconds later.
const RESET_RESCAN_FOR: std::time::Duration = std::time::Duration::from_secs(3);
const RESET_RESCAN_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

/// The local addresses a connection is inside one of our tunnels from:
/// every IPv4 address on every adapter of ours, the session's own first.
/// Every one, because a Wintun adapter can hold a stale APIPA address
/// beside its real one and list it first -- and a connection from either
/// is in the tunnel, not to be reset.
fn tunnel_addresses_in(listed: &[adapters::Adapter], session_adapter: &str, ours: &[&str]) -> Vec<Ipv4Addr> {
    let mut addresses: Vec<Ipv4Addr> = Vec::new();
    let session_first = listed.iter().filter(|a| a.name == session_adapter);
    let others = listed.iter().filter(|a| a.name != session_adapter && ours.contains(&a.name.as_str()));
    for adapter in session_first.chain(others) {
        for address in &adapter.ipv4_all {
            if !addresses.contains(address) {
                addresses.push(*address);
            }
        }
    }
    addresses
}

/// One reset pass, in confinement.log: what was closed, by owner and
/// remote, and what refused to close.
fn note_reset(log_dir: &Path, what: &str, outcome: &crate::split_tunnel::ResetOutcome) {
    let mut line = format!("{what}: {} connection(s) closed", outcome.closed);
    if !outcome.closed_rows.is_empty() {
        line.push_str(&format!(" ({})", outcome.closed_rows.join(", ")));
    }
    if outcome.skipped_handshaking > 0 {
        line.push_str(&format!("; {} mid-handshake, left for the rescans", outcome.skipped_handshaking));
    }
    for failure in &outcome.failures {
        line.push_str(&format!("; {failure}"));
    }
    confinement::note(log_dir, &line);
}

/// The LAN as this machine's adapters are on it right now, for the IPv4
/// confinement's LAN permit -- see `confinement::lan_prefixes` for what
/// counts. Read at connect and fixed for the session: a network joined
/// later is refused until the next connect. Adapters that cannot be listed
/// give no on-link prefix, which leaves the plan's link-local, multicast
/// and broadcast permits and refuses the rest of the LAN -- the narrower
/// failure.
///
/// With it, the DHCP servers those same adapters lease from
/// (`confinement::lan_dhcp_servers`), the one way DHCP leaves the LAN.
fn machine_lan() -> (Vec<confinement::Prefix>, Vec<Ipv4Addr>) {
    let Ok(all) = adapters::list() else { return (Vec::new(), Vec::new()) };
    let lan: Vec<confinement::LanAdapter> = all
        .iter()
        .map(|a| confinement::LanAdapter {
            name: &a.name,
            description: &a.description,
            is_up: a.is_up,
            ipv4: a.ipv4,
            prefix_len: a.ipv4_prefix,
            dhcp_server: a.dhcp_server,
        })
        .collect();
    (confinement::lan_prefixes(&lan, &OUR_ADAPTER_NAMES), confinement::lan_dhcp_servers(&lan, &OUR_ADAPTER_NAMES))
}

/// The physical adapter traffic to `toward` leaves by, and the next hop
/// on it, for an engine that routes its own way around the tunnel.
/// Windows' own answer when there is an address to ask about -- see
/// `adapters::best_uplink_for` -- and the first adapter with a gateway
/// when there is not.
fn uplink_toward(toward: Option<Ipv4Addr>) -> Option<adapters::Uplink> {
    match toward {
        Some(dest) => adapters::best_uplink_for(dest, &OUR_ADAPTER_NAMES).ok().flatten(),
        None => adapters::physical_uplink(&OUR_ADAPTER_NAMES)
            .ok()
            .flatten()
            .and_then(|a| a.gateway.map(|gateway| adapters::Uplink { index: a.index, next_hop: gateway })),
    }
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
        Session::new(Active::WireguardTunnel, &profile, confinement::Hold::with_closer(Arc::new(|_| 0)))
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

    /// Phase two is the thorough pass, and runs once per drop. A
    /// Disconnect -- or the app going away -- that reached the owning
    /// thread between phase one and phase two queued its own pass ahead
    /// of it; sweeping the machine again finds nothing and costs seconds.
    #[test]
    fn phase_two_does_not_repeat_a_thorough_pass_that_already_ran() {
        let mut engines = engines_for_test();
        let g = engines.begin_test_session("XRAY_VLESS_TLS", engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()));
        assert!(engines.end_dead_session(g));
        assert_eq!(engines.thorough_passes(), 0, "phase one ran the thorough pass");
        let _ = engines.disconnect();
        assert_eq!(engines.thorough_passes(), 1);
        engines.finish_dead_session(g);
        assert_eq!(engines.thorough_passes(), 1, "phase two swept the same machine again");

        // Without one in between, phase two is the pass -- once.
        let mut engines = engines_for_test();
        let g = engines.begin_test_session("XRAY_VLESS_TLS", engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()));
        assert!(engines.end_dead_session(g));
        engines.finish_dead_session(g);
        assert_eq!(engines.thorough_passes(), 1, "phase two did not run");
        engines.finish_dead_session(g);
        assert_eq!(engines.thorough_passes(), 1, "phase two ran twice");
    }

    /// A drop whose own teardown never ran, because a Disconnect reached
    /// the owning thread first, is still in `cleanup.log` -- once.
    #[test]
    fn a_drop_a_disconnect_takes_over_is_still_logged_once() {
        const LABEL: &str = "TEST_DROP_TAKEN_BY_A_DISCONNECT";
        let mut engines = engines_for_test();
        let g = engines.begin_test_session(LABEL, engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()));

        let _ = crate::lifecycle::teardown::hard_stop(&mut engines);
        assert!(!engines.has_session());
        assert!(!engines.end_dead_session(g), "phase one found the slot empty");
        let _ = engines.disconnect();

        let lines = crate::cleanup_log::noted_containing(LABEL);
        assert_eq!(lines.len(), 1, "{lines:#?}");
        assert!(lines[0].contains("| the tunnel engine ended on its own |"), "{}", lines[0]);
        assert!(lines[0].contains(&format!("{LABEL}, exit code 1")), "{}", lines[0]);
        assert!(lines[0].contains("ended by another teardown"), "{}", lines[0]);
    }

    /// The same for a connect, which used to forget the drop before its
    /// clear-the-decks teardown could see it.
    #[test]
    fn a_drop_a_connect_takes_over_is_still_logged() {
        const LABEL: &str = "TEST_DROP_TAKEN_BY_A_CONNECT";
        let mut engines = engines_for_test();
        let g = engines.begin_test_session(LABEL, engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()));

        let profile = ConnectProfile::Wireguard(neoconnect_ipc::WireguardProfile {
            private_key: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=".into(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=".into(),
            endpoint: "203.0.113.5:51888".into(),
        });
        // `connect_inner` with a token of its own: `connect` reads the
        // process-wide published one, which other tests running beside
        // this one adopt and cancel.
        let limits = crate::lifecycle::budget::Limits::new(
            crate::lifecycle::cancel::CancelToken::new(),
            crate::lifecycle::budget::CONNECT_BUDGET.limit,
        );
        assert!(engines.connect_inner(&profile, &[], &[], &limits).is_err(), "there is no wireguard.exe to connect with here");
        assert!(!engines.end_dead_session(g));
        assert!(engines.ledger().ended_without_successor().is_none(), "the connect left the old drop answering");

        let lines = crate::cleanup_log::noted_containing(LABEL);
        assert_eq!(lines.len(), 1, "{lines:#?}");
        assert!(lines[0].contains("ended by another teardown"), "{}", lines[0]);
    }

    /// And a drop torn down by its own phase one is logged once, with the
    /// fuller line, not a second time by the teardown inside it.
    #[test]
    fn a_drop_torn_down_by_its_own_phase_one_is_logged_once() {
        const LABEL: &str = "TEST_DROP_OWN_TEARDOWN";
        let mut engines = engines_for_test();
        let g = engines.begin_test_session(LABEL, engine_stand_in());
        kill_engine_behind_its_back(&mut engines);
        assert!(wait_for(Duration::from_secs(5), || engines.ledger().confirmed_drop().is_some()));
        assert!(engines.end_dead_session(g));
        engines.finish_dead_session(g);

        let lines = crate::cleanup_log::noted_containing(LABEL);
        assert_eq!(lines.len(), 1, "{lines:#?}");
        assert!(lines[0].contains(&format!("{LABEL}, exit code 1, noticed by the engine watch; routes, filters")), "{}", lines[0]);
    }

    // ---- Which filters a session gets --------------------------------

    fn wireguard_profile() -> ConnectProfile {
        ConnectProfile::Wireguard(neoconnect_ipc::WireguardProfile {
            private_key: String::new(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0, ::/0".into(),
            server_public_key: String::new(),
            endpoint: "203.0.113.1:51820".into(),
        })
    }

    /// WireGuard's full tunnel refuses IPv6 on the PC, as every other
    /// engine's does, with its DNS confined in the same set.
    ///
    /// Before: no block of ours, and wireguard.exe's AllowedIPs carried
    /// IPv6 into a tunnel that has no IPv6 address at either end. A forced
    /// IPv6 connect waited 6-8 s on the VM before failing, where the other
    /// engines refuse it in milliseconds; wireguard.exe's own kill switch
    /// permits its tunnel, so nothing refused it sooner. Custom mode stays
    /// without any machine-wide filter, as for every engine.
    #[test]
    fn wireguard_full_tunnel_refuses_ipv6_on_the_pc() {
        let full = filter_plan(&wireguard_profile(), false);
        assert_eq!(full, FilterPlan { ipv6_block: true, dns_confinement: true });
        assert_eq!(filter_plan(&wireguard_profile(), true), FilterPlan::default(), "Custom mode gets none");

        // The rest, unchanged: OpenVPN brings block-outside-dns of its own.
        assert_eq!(filter_plan(&test_profile(), false), FilterPlan { ipv6_block: true, dns_confinement: true });
        let openvpn = ConnectProfile::Openvpn(neoconnect_ipc::OpenvpnProfile {
            cert_pem: String::new(),
            key_pem: String::new(),
            ca_cert_pem: String::new(),
            endpoint: "203.0.113.1:1194".into(),
            proto: "udp".into(),
            tls_crypt_key: None,
        });
        assert_eq!(filter_plan(&openvpn, false), FilterPlan { ipv6_block: true, dns_confinement: false });
    }

    // ---- OpenVPN's host route to its server ---------------------------
    //
    // Measured on the VM: after Compatible sessions, a host route to each
    // node stayed on the guest's Ethernet adapter, and the next Stealth
    // connect's check against one of those nodes' mirrors went around the
    // tunnel and moved the customer off a server that worked. openvpn.exe
    // adds that route itself and is always ended by TerminateProcess, so
    // it never takes it back; these pin the session taking it over. What
    // they cannot pin is the real table, which is the VM's job.

    /// A recording table with the customer's default route on the uplink.
    fn uplink_table() -> (Arc<route_table::fake::FakeRoutes>, Ipv4Addr) {
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let default =
            route_table::RouteRow { dest: Ipv4Addr::UNSPECIFIED, prefix: 0, if_index: 14, next_hop: gateway, metric: 25, netmgmt: true };
        (route_table::fake::FakeRoutes::with(&[default]), gateway)
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neoconnect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The route openvpn.exe pushed while it connected belongs to the
    /// session, and is owed in the ledger before anything can end it.
    #[test]
    fn openvpn_session_owns_the_host_route_it_pushed() {
        let (table, gateway) = uplink_table();
        let node = route_table::RouteRow::host(Ipv4Addr::new(203, 0, 113, 7), 14, gateway, 0);
        let dir = fresh_dir("openvpn-owns");
        let mut engines = Engines::new(dir.clone(), dir.clone());
        engines.set_route_ops_for_test(table.clone());

        let watch = openvpn::HostRouteWatch::begin(&*table, Some(adapters::Uplink { index: 14, next_hop: gateway }), Some(node.dest), None, Vec::new());
        table.gain(node);
        let routes = engines.openvpn_routes(watch.added(&*table));
        assert_eq!(routes.foreign_rows(), vec![node], "the session does not own the route OpenVPN pushed");
        assert_eq!(engines.owed_routes().read(), vec![node], "the route is not owed, so a killed service leaves it");

        engines.begin_test_session_with_routes("OPENVPN", engine_stand_in(), routes);
        let _ = engines.disconnect();
        assert!(!table.table().contains(&node), "the disconnect left the host route behind");
        assert!(engines.owed_routes().read().is_empty(), "a removed route is still owed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every way an OpenVPN session ends removes its host route, once:
    /// a Disconnect, the hard stop, the engine dying on its own, and the
    /// engine dying while the hard stop races it.
    ///
    /// Thirty-two at once on one table, per CLAUDE.md: the relay teardown
    /// passed every single-instance run and failed under load.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn every_openvpn_teardown_deletes_the_adopted_route() {
        use crate::lifecycle::supervisor::Supervisor;
        use route_table::fake::Op;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

        const AT_ONCE: usize = 32;
        let (table, gateway) = uplink_table();
        let node = |i: usize| route_table::RouteRow::host(Ipv4Addr::new(203, 0, 113, i as u8 + 1), 14, gateway, 0);
        let base = fresh_dir("openvpn-teardowns");

        let mut racers = Vec::new();
        for i in 0..AT_ONCE {
            let dir = base.join(i.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            let mut engines = Engines::new(dir.clone(), dir.clone());
            engines.set_route_ops_for_test(table.clone());
            let watch = openvpn::HostRouteWatch::begin(&*table, Some(adapters::Uplink { index: 14, next_hop: gateway }), Some(node(i).dest), None, Vec::new());
            table.gain(node(i));
            let routes = engines.openvpn_routes(watch.added(&*table));
            assert_eq!(routes.foreign_rows(), vec![node(i)], "racer {i}: the pushed route was not taken over");

            let sup = Supervisor::spawn(engines, "test-openvpn-routes");
            let teardown = sup.clone();
            let pid = sup
                .run(move |engines: &mut Engines, _| {
                    engines.when_an_engine_ends(Arc::new(move |generation| {
                        let _ = teardown.run_detached(move |engines: &mut Engines, _| {
                            engines.end_dead_session(generation);
                        });
                    }));
                    let child = engine_stand_in();
                    let pid = child.id();
                    engines.begin_test_session_with_routes("OPENVPN", child, routes);
                    pid
                })
                .await
                .unwrap();
            racers.push((i, sup, pid, dir));
        }

        let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
        let mut threads = Vec::new();
        for (i, sup, pid, _) in &racers {
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
                let hard_stop = || {
                    let _ = sup.run_detached(|engines: &mut Engines, token| {
                        adopt_token(token);
                        let _ = crate::lifecycle::teardown::hard_stop(engines);
                    });
                };
                match i % 4 {
                    0 => {
                        let _ = sup.run_detached(|engines: &mut Engines, _| {
                            let _ = engines.disconnect();
                        });
                    }
                    1 => hard_stop(),
                    2 => kill(),
                    // Both orders, so neither side always wins.
                    _ if i % 8 == 3 => {
                        kill();
                        hard_stop();
                    }
                    _ => {
                        hard_stop();
                        kill();
                    }
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }

        for (i, sup, _, dir) in racers {
            let mut settled = None;
            for _ in 0..250 {
                let empty = !sup.run(|engines: &mut Engines, _| engines.has_session()).await.unwrap();
                if empty {
                    // Long enough for a report still in flight to land and
                    // be run, and so be counted if it did anything.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    settled = Some(sup.run(|engines: &mut Engines, _| engines.sessions_ended()).await.unwrap());
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let ended = settled.unwrap_or_else(|| panic!("racer {i}: the session was never ended"));
            assert_eq!(ended, 1, "racer {i}: the session was ended {ended} times");
            let deletes = table.log().iter().filter(|op| **op == Op::Delete(node(i))).count();
            assert_eq!(deletes, 1, "racer {i}: the host route was deleted {deletes} times");
            assert!(!table.table().contains(&node(i)), "racer {i}: the host route was left behind");
            assert!(route_table::OwedRoutes::in_dir(&dir).read().is_empty(), "racer {i}: the route is still owed");
            // Drop the sink, which holds a handle to this supervisor, so
            // its thread can end with the test.
            let _ = sup.run(|engines: &mut Engines, _| engines.engine_gone = None).await;
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A host route to a known server that an earlier session left on the
    /// uplink is gone before the next session is built, and struck off the
    /// ledger if it was owed there. Names in the list are ignored, and a
    /// host route to any other address is the customer's.
    #[test]
    fn a_connect_removes_host_routes_to_known_servers_an_earlier_session_left() {
        let (table, gateway) = uplink_table();
        let left = route_table::RouteRow::host(Ipv4Addr::new(203, 0, 113, 7), 14, gateway, 0);
        let customers = route_table::RouteRow::host(Ipv4Addr::new(198, 51, 100, 9), 14, gateway, 0);
        table.gain(left);
        table.gain(customers);
        let dir = fresh_dir("stale-purge");
        let mut engines = Engines::new(dir.clone(), dir.clone());
        engines.set_route_ops_for_test(table.clone());
        engines.owed_routes().owe(left);

        engines.purge_stale_node_routes(&["203.0.113.7".into(), "node.example.com".into(), "not an address".into()], &[]);

        assert!(!table.table().contains(&left), "the leftover host route survived the connect");
        assert!(table.table().contains(&customers), "a host route to an unknown address was taken");
        assert!(engines.owed_routes().read().is_empty(), "a removed route is still owed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The DNS cache is flushed once Custom mode's redirect is carrying
    /// lookups.
    ///
    /// The redirect starts seconds into a connect, after the relays and
    /// the firewall allowance. Lookups before it went to a resolver over
    /// the physical link -- 1.1.1.1 while each engine put Custom mode's rule
    /// in inside its own connect, the network's own since it goes in after
    /// the redirect -- and on a line that hijacks port 53 the block page's
    /// answer was cached and served to selected applications after the
    /// redirect had started. From the source, as `repair`'s survey order
    /// is held: the order is the whole of the fix.
    #[test]
    fn the_dns_cache_is_flushed_once_the_redirect_is_carrying_lookups() {
        let source = include_str!("mod.rs");
        let start = source.find("    fn start_split_tunnel(").unwrap();
        let body = &source[start..start + source[start..].find("\n    }\n").unwrap()];
        let started = body.find("self.split_tunnel.start(").expect("the redirect is started here");
        let flushed = body.find("dns::flush_cache();").expect("nothing flushes the cache once it has");
        assert!(flushed > started, "the cache is flushed before the redirect carries anything");
    }

    /* Custom mode's DNS pin through a live session (`keep_dns_pin`).
     *
     * Before: once the rule was in it stayed in for the life of the
     * session. A WireGuard handshake gone stale, an OpenVPN stuck
     * restarting, interception switched off under the session -- every
     * lookup on the PC still went to 1.1.1.1 and the redirect carried it
     * into a tunnel that answered nothing, so the applications the customer
     * kept out of the VPN stopped resolving names too. */

    /// What the pin did to the machine, instead of doing it.
    #[derive(Default)]
    struct RecordingPin {
        installed: std::sync::atomic::AtomicU32,
        released: std::sync::atomic::AtomicU32,
        restored: std::sync::atomic::AtomicU32,
        /// What putting it in reports; `Forced` unless a test says.
        install_fails: std::sync::atomic::AtomicBool,
        /// What putting it back reports; `Forced` unless a test says.
        restore_fails: std::sync::atomic::AtomicBool,
    }

    impl RecordingPin {
        fn installed(&self) -> u32 {
            self.installed.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn released(&self) -> u32 {
            self.released.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn restored(&self) -> u32 {
            self.restored.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl dns::PinOps for RecordingPin {
        fn install(&self, resolver: &str) -> dns::TunnelDns {
            assert_eq!(resolver, dns::CUSTOM_MODE_RESOLVER);
            self.installed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.install_fails.load(std::sync::atomic::Ordering::SeqCst) {
                dns::TunnelDns::Unforced("the rule would not go in".into())
            } else {
                dns::TunnelDns::Forced
            }
        }
        fn release(&self) {
            self.released.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn restore(&self, resolver: &str) -> dns::TunnelDns {
            assert_eq!(resolver, dns::CUSTOM_MODE_RESOLVER);
            self.restored.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.restore_fails.load(std::sync::atomic::Ordering::SeqCst) {
                dns::TunnelDns::Unforced("the rule would not go back in".into())
            } else {
                dns::TunnelDns::Forced
            }
        }
    }

    /// An `Engines` in its own directory, as a Custom-mode session whose
    /// rule went in would leave it: the pin recorded, no hold, so one
    /// reading is a run.
    fn custom_mode_engines(name: &str) -> (Engines, Arc<RecordingPin>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("neoconnect-pin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut engines = Engines::new(dir.clone(), dir.clone());
        let pin = Arc::new(RecordingPin::default());
        engines.pin_ops = Arc::clone(&pin) as Arc<dyn dns::PinOps>;
        engines.dns_pin = dns::PinWatch::with_hold(Duration::ZERO);
        engines.custom_mode_for_test = Some(CustomModeView { intercepting: true, interception_stopped: false });
        (engines, pin, dir)
    }

    /// A session's rule went in, as `connect_inner` records it.
    fn rule_went_in(engines: &mut Engines) {
        engines.set_dns_state_for_test(dns::TunnelDns::Forced);
    }

    fn handshake(engines: &mut Engines, reading: wireguard::HandshakeHealth) {
        engines.handshake_reading = Some((Instant::now(), reading));
    }

    #[test]
    fn a_stale_wireguard_handshake_gives_the_pin_back_and_a_fresh_one_puts_it_back() {
        let (mut engines, pin, dir) = custom_mode_engines("wireguard");
        let mut service_process = engine_stand_in();
        let pid = service_process.id();
        engines.begin_test_wireguard_session(move || wireguard::ScmView::Running(Some(pid)));
        rule_went_in(&mut engines);

        handshake(&mut engines, wireguard::HandshakeHealth::Alive { age_secs: 20 });
        engines.status();
        assert_eq!(pin.released(), 0, "a tunnel that carries keeps its pin");

        handshake(&mut engines, wireguard::HandshakeHealth::Stale { age_secs: 600 });
        let (up, _, health) = engines.status();
        assert!(up);
        assert_eq!(health, TunnelHealth::Stale { age_secs: 600 }, "the status poll says what it said before");
        assert_eq!(pin.released(), 1, "a stale handshake left every lookup on the PC in a dead tunnel");
        engines.status();
        assert_eq!(pin.released(), 1, "given back once");
        assert!(!engines.tunnel_dns_unprotected(), "not the connect-time complaint, whose words say traffic flows");

        handshake(&mut engines, wireguard::HandshakeHealth::Alive { age_secs: 3 });
        engines.status();
        assert_eq!(pin.restored(), 1, "the pin did not go back when the tunnel carried again");
        assert!(!engines.dns_pin.released());
        assert!(!engines.tunnel_dns_unprotected());

        let _ = service_process.kill();
        let _ = service_process.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A tunnel that never handshook is measured too: the peer never answered.
    #[test]
    fn a_wireguard_tunnel_that_never_handshook_gives_the_pin_back() {
        let (mut engines, pin, dir) = custom_mode_engines("wireguard-never");
        let mut service_process = engine_stand_in();
        let pid = service_process.id();
        engines.begin_test_wireguard_session(move || wireguard::ScmView::Running(Some(pid)));
        rule_went_in(&mut engines);

        handshake(&mut engines, wireguard::HandshakeHealth::NeverHandshaked);
        engines.status();
        assert_eq!(pin.released(), 1);

        let _ = service_process.kill();
        let _ = service_process.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn openvpn_stuck_restarting_gives_the_pin_back_and_a_probe_that_carried_puts_it_back() {
        let (mut engines, pin, dir) = custom_mode_engines("openvpn");
        engines.begin_test_session("OPENVPN", engine_stand_in());
        rule_went_in(&mut engines);

        std::fs::write(dir.join("openvpn.log"), "Initialization Sequence Completed\n").unwrap();
        engines.status();
        assert_eq!(pin.released(), 0, "up, as far as OpenVPN says");

        // A failed probe is not a measurement: nothing is given back on it.
        std::fs::write(
            dir.join("openvpn.log"),
            "Initialization Sequence Completed\nSIGUSR1[soft,ping-restart] received, process restarting\n",
        )
        .unwrap();
        engines.note_probe(&Err("the tunnel did not carry a test connection".into()));
        assert_eq!(pin.released(), 0, "a failed probe gave the pin back");

        engines.status();
        assert_eq!(pin.released(), 1, "OpenVPN restarting left every lookup on the PC in a dead tunnel");

        // OpenVPN's word that it is up again does not put it back...
        std::fs::write(
            dir.join("openvpn.log"),
            "SIGUSR1[soft,ping-restart] received, process restarting\nInitialization Sequence Completed\n",
        )
        .unwrap();
        engines.status();
        assert_eq!(pin.restored(), 0);
        // ...a reply through the tunnel does.
        engines.note_probe(&Ok(()));
        assert_eq!(pin.restored(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing measures an Xray or IKEv2 link while its adapter is up, so a
    /// stall keeps the pin as it always has. Interception switched off is
    /// another matter, on every engine: nothing carries the pinned lookups
    /// any more, and the pin only sends them to 1.1.1.1 over the bare line.
    #[test]
    fn interception_switched_off_gives_the_pin_back_for_good_on_any_engine() {
        let (mut engines, pin, dir) = custom_mode_engines("xray");
        engines.begin_test_session("XRAY_VLESS_REALITY", engine_stand_in());
        rule_went_in(&mut engines);

        engines.status();
        engines.note_probe(&Err("nothing came back".into()));
        assert_eq!(pin.released(), 0, "an Xray stall has no measurement to give the pin back on");

        engines.custom_mode_for_test = Some(CustomModeView { intercepting: true, interception_stopped: true });
        engines.status();
        assert_eq!(pin.released(), 1);
        engines.note_probe(&Ok(()));
        engines.status();
        assert_eq!(pin.restored(), 0, "put back with nothing to carry the lookups");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Only Custom mode's pin, and only one that went in.
    #[test]
    fn a_full_tunnel_or_a_rule_that_never_went_in_is_left_alone() {
        for (intercepting, state) in [
            (false, dns::TunnelDns::Forced),
            (true, dns::TunnelDns::NotRequested),
            (true, dns::TunnelDns::Unforced("refused".into())),
        ] {
            let (mut engines, pin, dir) = custom_mode_engines("left-alone");
            let mut service_process = engine_stand_in();
            let pid = service_process.id();
            engines.begin_test_wireguard_session(move || wireguard::ScmView::Running(Some(pid)));
            engines.custom_mode_for_test = Some(CustomModeView { intercepting, interception_stopped: false });
            engines.set_dns_state_for_test(state.clone());

            handshake(&mut engines, wireguard::HandshakeHealth::Stale { age_secs: 600 });
            engines.status();
            assert_eq!(pin.released(), 0, "{intercepting} {state:?}: given back");

            let _ = service_process.kill();
            let _ = service_process.wait();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Putting it back can fail as installing it can at connect, and is
    /// reported the same way: the tunnel carries, its lookups are not
    /// pinned to it.
    #[test]
    fn a_pin_that_will_not_go_back_is_reported_as_unpinned_dns() {
        let (mut engines, pin, dir) = custom_mode_engines("restore-fails");
        let mut service_process = engine_stand_in();
        let pid = service_process.id();
        engines.begin_test_wireguard_session(move || wireguard::ScmView::Running(Some(pid)));
        rule_went_in(&mut engines);
        pin.restore_fails.store(true, std::sync::atomic::Ordering::SeqCst);

        handshake(&mut engines, wireguard::HandshakeHealth::Stale { age_secs: 600 });
        engines.status();
        handshake(&mut engines, wireguard::HandshakeHealth::Alive { age_secs: 3 });
        engines.status();
        assert_eq!(pin.restored(), 1);
        assert!(engines.tunnel_dns_unprotected(), "a pin that is out was not reported");
        engines.status();
        assert_eq!(pin.restored(), 1, "tried again on every poll");

        let _ = service_process.kill();
        let _ = service_process.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* Custom mode's DNS pin, put in only once the redirect carries lookups.
     *
     * Before: each engine put the rule in inside its own connect, seconds
     * before the redirect started. In between, every lookup on the PC was
     * pinned to 1.1.1.1 with nothing to carry it into the tunnel, and left by
     * the physical adapter in clear text: seen at the NIC on the VM during a
     * WireGuard Custom-mode connect (p1-22, from 2.8 s before the connect
     * returned) and an Xray one (p1-24). */

    /// The order, from the source, as the flush's is held above: the
    /// redirect, then the rule, then the flush that drops whatever the
    /// network's resolver answered before it.
    #[test]
    fn custom_modes_rule_goes_in_once_the_redirect_has_started() {
        let source = include_str!("mod.rs");
        let start = source.find("    fn start_split_tunnel(").unwrap();
        let body = &source[start..start + source[start..].find("\n    }\n").unwrap()];
        let started = body.find("self.split_tunnel.start(").expect("the redirect is started here");
        let pinned = body.find("self.pin_custom_mode_dns();").expect("Custom mode's rule never goes in");
        let flushed = body.find("dns::flush_cache();").expect("nothing flushes the cache");
        assert!(started < pinned, "the rule goes in before the redirect can carry the lookups");
        assert!(pinned < flushed, "the cache is flushed before the rule is in");
    }

    /// And it comes out before the redirect is stopped to be started again
    /// in place -- Custom mode's list read the other way round while
    /// connected -- for the same reason: while the redirect is down, nothing
    /// carries the pinned lookups. `start_split_tunnel` puts it back.
    #[test]
    fn custom_modes_rule_comes_out_while_its_redirect_restarts() {
        let source = include_str!("mod.rs");
        let start = source.find("    pub fn set_split_tunnel(").unwrap();
        let body = &source[start..start + source[start..].find("\n    }\n").unwrap()];
        let branch = body
            .find("if was_intercepting != now_intercepting || was_mode != now_mode {")
            .expect("the in-place restart");
        let restart = &body[branch..];
        let unpinned = restart.find("self.unpin_custom_mode_dns();").expect("the rule stays in through the restart");
        let stopped = restart.find("self.split_tunnel.stop();").expect("the redirect is stopped");
        let started = restart.find("self.start_split_tunnel(").expect("and started again");
        assert!(unpinned < stopped && stopped < started);
    }

    #[test]
    fn custom_modes_rule_goes_in_for_the_session_and_a_failure_is_reported() {
        let (mut engines, pin, dir) = custom_mode_engines("install");
        engines.pin_custom_mode_dns();
        assert_eq!(pin.installed(), 1, "Custom mode's rule never went in");
        assert_eq!(engines.dns_state, dns::TunnelDns::Forced);
        assert!(!engines.tunnel_dns_unprotected());

        pin.install_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        engines.pin_custom_mode_dns();
        assert!(engines.tunnel_dns_unprotected(), "a rule that would not go in was not reported");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Not a full tunnel's: its rule, where it has one, is its engine's.
    #[test]
    fn a_full_tunnel_gets_no_custom_mode_rule() {
        let (mut engines, pin, dir) = custom_mode_engines("full");
        engines.custom_mode_for_test = Some(CustomModeView { intercepting: false, interception_stopped: false });
        engines.set_dns_state_for_test(dns::TunnelDns::Forced);
        engines.pin_custom_mode_dns();
        engines.unpin_custom_mode_dns();
        assert_eq!(pin.installed(), 0);
        assert_eq!(pin.released(), 0, "a full tunnel's rule was taken out");
        assert_eq!(engines.dns_state, dns::TunnelDns::Forced);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Each session's own, thirty-two at once: put in, given back by the
    /// watch while OpenVPN restarts, taken out for a redirect restart --
    /// which does not take out a rule the watch already gave back -- and put
    /// in again, fresh, with nothing of the watch's state carried over.
    #[test]
    fn custom_modes_rule_belongs_to_its_session_thirty_two_at_once() {
        let handles: Vec<_> = (0..32)
            .map(|i| {
                std::thread::spawn(move || {
                    let (mut engines, pin, dir) = custom_mode_engines(&format!("own-{i}"));
                    let generation = engines.begin_test_session("OPENVPN", engine_stand_in());
                    engines.pin_custom_mode_dns();
                    assert_eq!(pin.installed(), 1, "{i}: never went in");
                    assert_eq!(engines.dns_state, dns::TunnelDns::Forced, "{i}");

                    std::fs::write(dir.join("openvpn.log"), "SIGUSR1[soft,ping-restart] received, process restarting\n")
                        .unwrap();
                    engines.status();
                    assert_eq!(pin.released(), 1, "{i}: the watch did not give it back");

                    engines.unpin_custom_mode_dns();
                    assert_eq!(pin.released(), 1, "{i}: taken out twice");
                    assert_eq!(engines.dns_state, dns::TunnelDns::NotRequested, "{i}");
                    assert!(!engines.dns_pin.released(), "{i}: the watch's state outlived the restart");

                    engines.pin_custom_mode_dns();
                    assert_eq!(pin.installed(), 2, "{i}: not put back after the restart");
                    engines.unpin_custom_mode_dns();
                    assert_eq!(pin.released(), 2, "{i}: a rule that was in stayed in through the restart");

                    kill_engine_behind_its_back(&mut engines);
                    let scm = Arc::clone(&engines.wireguard_scm);
                    assert!(wait_for(Duration::from_secs(5), || {
                        matches!(engines.active.peek_mut().map(|s| s.engine.has_ended(&scm)), Some(Some(true)))
                    }));
                    assert!(engines.end_dead_session(generation), "{i}: the dead session was not ended");
                    let _ = std::fs::remove_dir_all(&dir);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("a session's rule was not its own");
        }
    }

    /// The four engines pin Custom mode to the same resolver, which is the
    /// one it is put back to.
    #[test]
    fn the_pin_goes_back_to_the_resolver_every_engine_pins() {
        assert_eq!(xray::TUN_DNS, dns::CUSTOM_MODE_RESOLVER);
        assert_eq!(ikev2::IKEV2_DNS, dns::CUSTOM_MODE_RESOLVER);
        assert_eq!(dns::custom_mode_rule(true), Some(dns::CUSTOM_MODE_RESOLVER));
    }

    /// A pin given back goes with its session, by whichever teardown ends
    /// it: nothing of it is put back in the next one, and the next one's is
    /// its own. Thirty-two at once, each on its own `Engines`, because the
    /// state that decides this must belong to the session and not to the
    /// process -- `dns::tunnel_dns` is a process-wide static, and two tests
    /// that shared one were how a per-session field came to exist.
    #[test]
    fn a_pin_given_back_ends_with_its_session_thirty_two_at_once() {
        let handles: Vec<_> = (0..32)
            .map(|i| {
                std::thread::spawn(move || {
                    let (mut engines, pin, dir) = custom_mode_engines(&format!("teardown-{i}"));
                    let generation = engines.begin_test_session("OPENVPN", engine_stand_in());
                    rule_went_in(&mut engines);
                    std::fs::write(dir.join("openvpn.log"), "SIGUSR1[soft,ping-restart] received, process restarting\n")
                        .unwrap();
                    engines.status();
                    assert_eq!(pin.released(), 1, "{i}: not given back");

                    // The engine dies; the watch ends the session.
                    kill_engine_behind_its_back(&mut engines);
                    let scm = Arc::clone(&engines.wireguard_scm);
                    assert!(wait_for(Duration::from_secs(5), || {
                        matches!(engines.active.peek_mut().map(|s| s.engine.has_ended(&scm)), Some(Some(true)))
                    }));
                    assert!(engines.end_dead_session(generation), "{i}: the dead session was not ended");
                    assert!(!engines.dns_pin.released(), "{i}: the given-back pin outlived its session");
                    assert_eq!(engines.dns_state, dns::TunnelDns::NotRequested);

                    // The next session: up, carrying, and nothing of the old
                    // one's is put back.
                    engines.begin_test_session("OPENVPN", engine_stand_in());
                    rule_went_in(&mut engines);
                    std::fs::write(dir.join("openvpn.log"), "Initialization Sequence Completed\n").unwrap();
                    engines.status();
                    engines.note_probe(&Ok(()));
                    assert_eq!(pin.restored(), 0, "{i}: the old session's pin was put back");
                    assert_eq!(pin.released(), 1, "{i}: another session's evidence reached this one");
                    let _ = std::fs::remove_dir_all(&dir);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("a session's pin outlived it");
        }
    }

    // ---- The IPv4 confinement's lifetime (K1, K2) ----------------------
    //
    // A confinement is a block of everything IPv4 outside the tunnel. Held
    // a moment too long it is a machine with no internet: through DNS and
    // phonebook tidying it blacks out every Disconnect and every rung of
    // the ladder (K1); held by a busy owning thread after the engine died
    // it strands the customer behind a tunnel that is gone (K2). These pin
    // when it is let go of, with a recording closer in place of WFP.

    /// The machine's confinement, standing in: LUIDs that change on every
    /// read, installs that are recorded, closes that are counted.
    struct FakeConfinement {
        luid_reads: std::sync::Mutex<u64>,
        installs: std::sync::Mutex<Vec<confinement::Plan>>,
        next: std::sync::atomic::AtomicIsize,
        closed: Arc<std::sync::Mutex<Vec<isize>>>,
        /// Every install refused, as WFP would refuse a filter.
        refuse: std::sync::atomic::AtomicBool,
        /// The rules of every reset pass asked for.
        resets: std::sync::Mutex<Vec<crate::split_tunnel::OutsideTunnel>>,
        /// What every witness handed out says: WFP's record of a refusal,
        /// as the test sets it.
        wfp_says: Arc<std::sync::Mutex<Option<String>>>,
    }

    impl FakeConfinement {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                luid_reads: std::sync::Mutex::new(0),
                installs: std::sync::Mutex::new(Vec::new()),
                next: std::sync::atomic::AtomicIsize::new(1000),
                closed: Arc::default(),
                refuse: std::sync::atomic::AtomicBool::new(false),
                resets: std::sync::Mutex::new(Vec::new()),
                wfp_says: Arc::default(),
            })
        }
        fn closed(&self) -> Vec<isize> {
            self.closed.lock().unwrap().clone()
        }
        fn luids_installed(&self) -> Vec<u64> {
            self.installs.lock().unwrap().iter().map(|p| p.tunnel_luid).collect()
        }
    }

    impl confinement::ConfinementOps for FakeConfinement {
        fn luid(&self, _adapter: &str) -> Result<u64, String> {
            let mut reads = self.luid_reads.lock().unwrap();
            *reads += 1;
            Ok(*reads * 100)
        }
        fn install(&self, plan: &confinement::Plan) -> Result<confinement::Installed, String> {
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("could not add the filter (0x80320009)".into());
            }
            self.installs.lock().unwrap().push(plan.clone());
            let engine = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(confinement::Installed { engine, filters: confinement::specs(plan).len(), blocks: vec![1, 2, 3, 4], since: 0 })
        }
        fn witness(&self, _plan: &confinement::Plan, _installed: &confinement::Installed) -> confinement::Witness {
            let says = Arc::clone(&self.wfp_says);
            Box::new(move || says.lock().unwrap().clone())
        }
        fn reset(&self, rules: &crate::split_tunnel::OutsideTunnel) -> crate::split_tunnel::ResetOutcome {
            self.resets.lock().unwrap().push(rules.clone());
            crate::split_tunnel::ResetOutcome::default()
        }
        fn hold(&self) -> Arc<confinement::Hold> {
            let closed = Arc::clone(&self.closed);
            confinement::Hold::with_closer(Arc::new(move |engine| {
                closed.lock().unwrap().push(engine);
                0
            }))
        }
    }

    /// Engines over a fake confinement, with an Xray session begun and
    /// confined.
    fn confined_session() -> (Engines, Arc<FakeConfinement>, u64) {
        let fake = FakeConfinement::new();
        let mut engines = engines_for_test();
        engines.set_confinement_ops_for_test(fake.clone());
        let generation = engines.begin_test_session("XRAY_VLESS_REALITY", engine_stand_in());
        assert!(engines.confine_for_test(), "the fake confinement was not held");
        engines.teardown_steps.clear();
        (engines, fake, generation)
    }

    /// The steps, in the order given, each present and each after the one
    /// before it.
    fn in_order(steps: &[&'static str], wanted: &[&str]) {
        let at = |step: &str| {
            steps.iter().position(|s| *s == step).unwrap_or_else(|| panic!("{step} never happened: {steps:?}"))
        };
        for pair in wanted.windows(2) {
            assert!(at(pair[0]) < at(pair[1]), "{} after {}: {steps:?}", pair[0], pair[1]);
        }
    }

    /// Disconnect, a dead engine's teardown and the hard stop each let go
    /// of the confinement straight after the engine stops -- before DNS,
    /// and before the IPv6 block, which goes last on purpose.
    #[test]
    fn confinement_released_right_after_engine_stop_before_dns_and_phonebook() {
        // A Disconnect (and a connect clearing the decks): the thorough
        // pass.
        let (mut engines, fake, _) = confined_session();
        engines.disconnect().expect("disconnect");
        assert_eq!(fake.closed(), vec![1000], "Disconnect: closed exactly once");
        in_order(&engines.teardown_steps, &["engine stopped", "confinement released", "dns cleared", "ipv6 released"]);

        // An engine that died, torn down by phase one.
        let (mut engines, fake, generation) = confined_session();
        kill_engine_behind_its_back(&mut engines);
        let scm = Arc::clone(&engines.wireguard_scm);
        assert!(wait_for(Duration::from_secs(5), || {
            matches!(engines.active.peek_mut().map(|s| s.engine.has_ended(&scm)), Some(Some(true)))
        }));
        assert!(engines.end_dead_session(generation));
        assert_eq!(fake.closed(), vec![1000], "dead session: closed exactly once");
        in_order(&engines.teardown_steps, &["engine stopped", "confinement released", "ipv6 released", "dns cleared"]);

        // The hard stop, phase one of a Disconnect.
        let (mut engines, fake, _) = confined_session();
        let report = crate::lifecycle::teardown::hard_stop(&mut engines);
        assert_eq!(fake.closed(), vec![1000], "hard stop: closed exactly once");
        in_order(&engines.teardown_steps, &["engine stopped", "confinement released", "ipv6 released", "dns cleared"]);
        assert!(report.steps.iter().any(|s| s.name == "release the IPv4 confinement" && s.failed.is_none()));
    }

    /// Not a step later than it must, either. Once the engine is killed the
    /// confinement protects nothing -- the session is ending -- and held
    /// through the route.exe deletes and the reap it only takes the
    /// machine's internet away for as long as they take: routes going one
    /// at a time send traffic to the physical adapter, where it is
    /// refused. So: the hard stop lets go the moment it has killed the
    /// engine, before the routes; the thorough pass, whose routes come out
    /// before its kill, lets go straight after the kill and before the
    /// reap (up to five seconds); and a dead engine's teardown lets go
    /// first, its engine being stopped already.
    #[test]
    fn confinement_released_the_moment_the_engine_is_killed_before_routes_and_reap() {
        let (mut engines, fake, _) = confined_session();
        let _ = crate::lifecycle::teardown::hard_stop(&mut engines);
        assert_eq!(fake.closed(), vec![1000], "hard stop: closed exactly once");
        in_order(&engines.teardown_steps, &["engine stopped", "confinement released", "routes removed"]);

        let (mut engines, fake, _) = confined_session();
        engines.disconnect().expect("disconnect");
        assert_eq!(fake.closed(), vec![1000], "Disconnect: closed exactly once");
        in_order(&engines.teardown_steps, &["routes removed", "engine stopped", "confinement released", "engine reaped"]);

        let (mut engines, fake, generation) = confined_session();
        kill_engine_behind_its_back(&mut engines);
        let scm = Arc::clone(&engines.wireguard_scm);
        assert!(wait_for(Duration::from_secs(5), || {
            matches!(engines.active.peek_mut().map(|s| s.engine.has_ended(&scm)), Some(Some(true)))
        }));
        assert!(engines.end_dead_session(generation));
        assert_eq!(fake.closed(), vec![1000], "dead session: closed exactly once");
        in_order(&engines.teardown_steps, &["engine stopped", "confinement released", "routes removed"]);
    }

    /// Custom mode switched on with nothing chosen is a full tunnel --
    /// there is nothing to intercept -- and on Xray or OpenVPN a confined
    /// one. Flipping the list between "only these" and "all except these"
    /// then changes nothing about that tunnel: still nothing to intercept.
    /// It used to restart the redirect in place on it, and
    /// `start_split_tunnel` let go of the confinement it found there --
    /// silently in a release build, a panic in a debug one -- and nothing
    /// ever put it back: one toggle in the settings, and the rest of the
    /// session ran unconfined.
    #[test]
    fn flipping_an_empty_custom_list_leaves_a_confined_full_tunnel_alone() {
        use neoconnect_ipc::{SplitTunnelConfig, SplitTunnelMode};
        let config = |mode| SplitTunnelConfig {
            enabled: true,
            mode,
            apps: Vec::new(),
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        };
        for (from, to) in [
            (SplitTunnelMode::OnlySelected, SplitTunnelMode::AllExcept),
            (SplitTunnelMode::AllExcept, SplitTunnelMode::OnlySelected),
        ] {
            let (mut engines, fake, _) = confined_session();
            engines.split_tunnel.set_selection(config(from));
            assert!(!engines.split_tunnel.wants_interception(), "an empty list intercepts nothing");
            let switched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engines.set_split_tunnel(config(to))));
            assert!(matches!(switched, Ok(Ok(()))), "{from:?} -> {to:?}: {switched:?}");
            assert!(fake.closed().is_empty(), "{from:?} -> {to:?}: the confinement was let go of");
            assert_eq!(engines.ipv4_confined(), Some(true), "{from:?} -> {to:?}");
            assert!(!engines.split_tunnel_running(), "{from:?} -> {to:?}: a redirect was started on a full tunnel");
            end_test_session(&mut engines);
        }
    }

    /// IKEv2's Disconnect hangs up with one API call and then removes the
    /// phonebook entry, which can take seconds of PowerShell. The
    /// confinement goes between the two. Read from the source: nothing
    /// here can dial RAS. (IKEv2 is not confined while `IKEV2_CONFINED` is
    /// off; this holds the order for when it is.)
    #[test]
    fn ikev2_lets_go_of_the_confinement_between_hanging_up_and_the_phonebook() {
        let source = include_str!("mod.rs");
        let start = source.find("    pub fn disconnect(&mut self) -> Result<(), String> {").expect("disconnect");
        let body = &source[start..];
        let arm = &body[body.find("Some(Active::Ikev2(live)) => {").expect("the IKEv2 arm")..];
        let hang_up = arm.find("live.hang_up()").expect("hang up");
        let release = arm.find("self.let_go_of_confinement()").expect("the confinement let go of in the IKEv2 arm");
        let phonebook = arm.find("ikev2::remove_entry()").expect("phonebook");
        assert!(hang_up < release && release < phonebook);
    }

    /// The engine dies while the owning thread is busy: the watch's own
    /// thread lets go of the confinement, without waiting for phase one
    /// to be run (K2). Also for a report that is not definitive -- a wait
    /// that failed -- because the engine may be gone all the same.
    #[test]
    fn any_drop_report_lets_go_of_the_confinement_from_the_watch_thread() {
        let (mut engines, fake, _) = confined_session();
        kill_engine_behind_its_back(&mut engines);
        assert!(
            wait_for(Duration::from_secs(5), || fake.closed() == vec![1000]),
            "a dead engine's confinement waited for the owning thread"
        );
        assert_eq!(engines.active.peek().map(|s| s.confinement.confined()), Some(Some(false)));
        end_test_session(&mut engines);
        assert_eq!(fake.closed(), vec![1000], "and not closed a second time");

        let fake = FakeConfinement::new();
        let mut engines = engines_for_test();
        engines.set_confinement_ops_for_test(fake.clone());
        engines.begin_test_session_watched_by("OPENVPN", engine_stand_in(), Box::new(WaitFails));
        // The failed wait may already have reported; a confinement put in
        // after it is let go of at once.
        engines.confine_for_test();
        assert!(
            wait_for(Duration::from_secs(5), || fake.closed() == vec![1000]),
            "a failed wait kept the confinement"
        );
        end_test_session(&mut engines);
    }

    /// A drop report the engine contradicts -- a wait that failed, a RAS
    /// connection MOBIKE moved -- lets go of the confinement at once, and
    /// phase one, finding the engine alive, puts it back with the tunnel's
    /// LUID read again: an IKEv2 interface can come back with a new one.
    #[test]
    fn any_drop_report_releases_and_retraction_reinstalls_with_fresh_luid() {
        use windows_sys::Win32::System::Threading::SetEvent;
        let fake = FakeConfinement::new();
        let mut engines = engines_for_test();
        engines.set_confinement_ops_for_test(fake.clone());
        let go = engine_watch::new_event().unwrap();
        let g = engines.begin_test_session_watched_by("XRAY_VLESS_REALITY", engine_stand_in(), Box::new(GoneWhen(go.duplicate().unwrap())));
        assert!(engines.confine_for_test());
        assert_eq!(fake.luids_installed(), vec![100]);

        // SAFETY: a live event handle.
        unsafe { SetEvent(go.raw()) };
        assert!(wait_for(Duration::from_secs(5), || fake.closed() == vec![1000]), "the report did not let go of it");

        assert!(!engines.end_dead_session(g), "a running engine was torn down");
        assert_eq!(fake.luids_installed(), vec![100, 200], "put back, with the LUID read again");
        assert_eq!(engines.active.peek().map(|s| s.confinement.confined()), Some(Some(true)));
        assert_eq!(fake.closed(), vec![1000], "the new one is held, not closed");

        end_test_session(&mut engines);
        assert_eq!(fake.closed(), vec![1000, 1001], "the session's end closes the one put back");
    }

    /// The order K2 depends on when a drop report is taken back: the hold
    /// is re-armed before the new watch starts, and the put-back after it
    /// does not re-arm it again. The other way round, a report from the
    /// new watch -- the engine dying a moment after phase one found it
    /// alive -- set the hold's mark and the put-back's re-arm erased it,
    /// so the confinement went back in and was held for a dead engine.
    /// Read from the source: the window is microseconds wide (the test
    /// below races it for real).
    #[test]
    fn a_retracted_drop_rearms_the_hold_before_the_new_watch_starts() {
        let source = include_str!("mod.rs");
        let body_of = |signature: &str| {
            let start = source.find(signature).unwrap_or_else(|| panic!("{signature}"));
            &source[start..start + source[start..].find("\n    }\n").expect("its end")]
        };
        let body = body_of("    pub fn end_dead_session(&mut self, generation: u64) -> bool {");
        let rearm = body.find("session.confinement.rearm();").expect("the hold re-armed by phase one");
        let watch = body.find("self.rearm_watch(retracted);").expect("the watch started again");
        let again = body.find("self.confine_again();").expect("the confinement put back");
        assert!(rearm < watch && watch < again, "re-arm {rearm}, watch {watch}, put back {again}");
        let body = body_of("    fn confine_again(&mut self) {");
        assert!(!body.contains(".rearm()"), "the put-back re-arms the hold after the new watch has started");
    }

    /// A drop report racing the put-back, thirty-two sessions at once: each
    /// confined, its first report taken back by phase one, and its engine
    /// killed at a different moment around that -- before phase one looks,
    /// while it re-arms and puts the confinement back, after. Whatever the
    /// order, a dead engine's confinement is not held: phase one tears it
    /// down, the new watch's report lets go of it, or the put-back is let
    /// go of at once. And every confinement installed is closed exactly
    /// once.
    #[test]
    fn a_drop_report_racing_the_put_back_never_leaves_a_dead_engine_confined() {
        use windows_sys::Win32::System::Threading::SetEvent;
        const AT_ONCE: usize = 32;
        let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
        let handles: Vec<_> = (0..AT_ONCE)
            .map(|i| {
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let fake = FakeConfinement::new();
                    let mut engines = engines_for_test();
                    engines.set_confinement_ops_for_test(fake.clone());
                    let go = engine_watch::new_event().unwrap();
                    let g = engines.begin_test_session_watched_by(
                        "XRAY_VLESS_REALITY",
                        engine_stand_in(),
                        Box::new(GoneWhen(go.duplicate().unwrap())),
                    );
                    assert!(engines.confine_for_test());
                    // SAFETY: a live event handle.
                    unsafe { SetEvent(go.raw()) };
                    assert!(wait_for(Duration::from_secs(5), || fake.closed() == vec![1000]), "{i}: the report did not let go");
                    let pid = match engines.active.peek() {
                        Some(Session { engine: Active::Child { child, .. }, .. }) => child.id(),
                        _ => panic!("{i}: no engine"),
                    };
                    start.wait();
                    let killer = std::thread::spawn(move || {
                        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
                        std::thread::sleep(Duration::from_micros((i as u64 % 8) * 150));
                        // SAFETY: plain calls; the handle is closed below.
                        unsafe {
                            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                            if !h.is_null() {
                                TerminateProcess(h, 1);
                                windows_sys::Win32::Foundation::CloseHandle(h);
                            }
                        }
                    });
                    let _ = engines.end_dead_session(g);
                    killer.join().unwrap();
                    // The new watch waits out REARM_SPACING before its first
                    // look, then reports; a margin past that.
                    assert!(
                        wait_for(Duration::from_secs(4), || {
                            engines.active.peek().map_or(true, |s| s.confinement.confined() != Some(true))
                        }),
                        "{i}: a dead engine's confinement was held"
                    );
                    end_test_session(&mut engines);
                    let installs = fake.installs.lock().unwrap().len();
                    let mut closed = fake.closed();
                    closed.sort_unstable();
                    let expected: Vec<isize> = (1000..1000 + installs as isize).collect();
                    assert_eq!(closed, expected, "{i}: each confinement closed exactly once");
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("a dead engine's confinement held, or one closed other than once");
        }
    }

    /// Thirty-two sessions at once, each confined, each engine killed
    /// behind its back at the moment the owning thread runs the hard stop:
    /// the watch's thread and the owning thread let go of the same
    /// confinement concurrently, and each is closed exactly once.
    #[test]
    fn thirty_two_confined_sessions_dying_during_a_disconnect_close_once_each() {
        const AT_ONCE: usize = 32;
        let start = Arc::new(std::sync::Barrier::new(AT_ONCE));
        let handles: Vec<_> = (0..AT_ONCE)
            .map(|i| {
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let (mut engines, fake, _) = confined_session();
                    let pid = match engines.active.peek() {
                        Some(Session { engine: Active::Child { child, .. }, .. }) => child.id(),
                        _ => panic!("{i}: no engine"),
                    };
                    start.wait();
                    let killer = std::thread::spawn(move || {
                        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
                        // SAFETY: plain calls; the handle is closed below.
                        unsafe {
                            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                            if !h.is_null() {
                                TerminateProcess(h, 1);
                                windows_sys::Win32::Foundation::CloseHandle(h);
                            }
                        }
                    });
                    let _ = crate::lifecycle::teardown::hard_stop(&mut engines);
                    killer.join().unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                    assert_eq!(fake.closed(), vec![1000], "{i}: closed {:?}", fake.closed());
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("a confinement closed other than once");
        }
    }

    // ---- Confined at connect, and said so (3.5) ------------------------

    /// Engines over a fake confinement whose engine directory holds
    /// stand-ins for xray.exe and openvpn.exe -- the plan names the engine,
    /// and an engine that is not installed is no permit at all.
    fn engines_with_engine_files(name: &str) -> (Engines, Arc<FakeConfinement>, PathBuf) {
        let dir = fresh_dir(name);
        for exe in ["xray.exe", "openvpn.exe"] {
            std::fs::write(dir.join(exe), b"").unwrap();
        }
        let fake = FakeConfinement::new();
        let mut engines = Engines::new(dir.clone(), dir.clone());
        engines.set_confinement_ops_for_test(fake.clone());
        (engines, fake, dir)
    }

    fn reality_profile() -> ConnectProfile {
        ConnectProfile::XrayVlessReality(neoconnect_ipc::XrayProfile {
            uuid: String::new(),
            flow: String::new(),
            host: "203.0.113.7".into(),
            port: 443,
            reality_public_key: String::new(),
            short_id: String::new(),
            server_name: "www.example.com".into(),
        })
    }

    fn openvpn_profile() -> ConnectProfile {
        ConnectProfile::Openvpn(neoconnect_ipc::OpenvpnProfile {
            cert_pem: String::new(),
            key_pem: String::new(),
            ca_cert_pem: String::new(),
            endpoint: "203.0.113.7:1194".into(),
            proto: "udp".into(),
            tls_crypt_key: None,
        })
    }

    /// What the status poll says about IPv4 after a full-tunnel connect,
    /// per engine: confined on Xray and OpenVPN; not said on WireGuard
    /// (wireguard.exe's own kill switch, K8) or IKEv2 (not until its own
    /// proof); not said in Custom mode on any engine.
    #[test]
    fn status_reports_ipv4_confined_for_xray_and_openvpn_none_for_wireguard() {
        let node = Ipv4Addr::new(203, 0, 113, 7);
        let shadowsocks = ConnectProfile::Shadowsocks(neoconnect_ipc::ShadowsocksProfile {
            host: "203.0.113.7".into(),
            port: 8388,
            method: "2022-blake3-aes-128-gcm".into(),
            password: String::new(),
        });
        for (protocol, profile, expected) in [
            ("XRAY_VLESS_REALITY", reality_profile(), Some(true)),
            ("SHADOWSOCKS", shadowsocks, Some(true)),
            ("OPENVPN", openvpn_profile(), Some(true)),
            ("WIREGUARD", wireguard_profile(), None),
            ("IKEV2", test_profile(), None),
        ] {
            let (mut engines, fake, dir) = engines_with_engine_files(&format!("confined-{protocol}"));
            engines.begin_test_session_for(&profile, protocol, engine_stand_in());
            engines.confine_if_needed(&profile, false, vec![node]);
            assert_eq!(engines.ipv4_confined(), expected, "{protocol}");
            assert_eq!(engines.confinement_problem(), None, "{protocol}");
            let installs = fake.installs.lock().unwrap().clone();
            assert_eq!(installs.len(), usize::from(expected == Some(true)), "{protocol}");
            if let Some(plan) = installs.first() {
                let names_the_engine = match &plan.transport {
                    confinement::Transport::Xray { exe, nodes } => exe.ends_with("xray.exe") && nodes == &[node],
                    confinement::Transport::Openvpn { exe, node: n, port, .. } => {
                        exe.ends_with("openvpn.exe") && *n == node && *port == 1194
                    }
                    confinement::Transport::Ikev2 { .. } => false,
                };
                assert!(names_the_engine, "{protocol}: {plan:?}");
                assert_eq!(plan.tunnel_luid, 100, "{protocol}: the tunnel's LUID, read now");
            }
            end_test_session(&mut engines);
            let _ = std::fs::remove_dir_all(&dir);
        }

        // Custom mode, on the engines that would otherwise be confined.
        for (protocol, profile) in [("XRAY_VLESS_REALITY", reality_profile()), ("OPENVPN", openvpn_profile())] {
            let (mut engines, fake, dir) = engines_with_engine_files(&format!("custom-{protocol}"));
            engines.begin_test_session_for(&profile, protocol, engine_stand_in());
            engines.confine_if_needed(&profile, true, vec![node]);
            assert_eq!(engines.ipv4_confined(), None, "{protocol} in Custom mode");
            assert!(fake.installs.lock().unwrap().is_empty());
            end_test_session(&mut engines);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The owner's decision (d): filters that will not go in leave the
    /// tunnel up, and the status poll says it is not confined, with the
    /// reason -- never a claim of full protection, and never a connect
    /// failed over it. The same for a plan that cannot be made.
    #[test]
    fn failed_install_keeps_tunnel_and_reports_false() {
        let (mut engines, fake, dir) = engines_with_engine_files("confine-refused");
        fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", engine_stand_in());
        engines.confine_if_needed(&reality_profile(), false, vec![Ipv4Addr::new(203, 0, 113, 7)]);
        assert_eq!(engines.ipv4_confined(), Some(false));
        assert!(engines.confinement_problem().is_some_and(|p| p.contains("0x80320009")), "{:?}", engines.confinement_problem());
        assert!(engines.has_session(), "the tunnel was taken down over its filters");
        assert!(engines.status().0, "the tunnel is reported up");
        end_test_session(&mut engines);

        // No server address to permit the engine to: no plan, said so.
        fake.refuse.store(false, std::sync::atomic::Ordering::SeqCst);
        engines.begin_test_session_for(&openvpn_profile(), "OPENVPN", engine_stand_in());
        engines.confine_if_needed(&openvpn_profile(), false, Vec::new());
        assert_eq!(engines.ipv4_confined(), Some(false));
        assert!(engines.confinement_problem().is_some_and(|p| p.contains("address")), "{:?}", engines.confinement_problem());
        assert!(fake.installs.lock().unwrap().is_empty(), "a plan without the engine's permit was installed");
        assert!(engines.has_session());
        end_test_session(&mut engines);

        // And an engine that is not there to name.
        let _ = std::fs::remove_file(dir.join("xray.exe"));
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", engine_stand_in());
        engines.confine_if_needed(&reality_profile(), false, vec![Ipv4Addr::new(203, 0, 113, 7)]);
        assert_eq!(engines.ipv4_confined(), Some(false));
        assert!(fake.installs.lock().unwrap().is_empty());
        end_test_session(&mut engines);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The connect confines once the tunnel and its IPv6 block are up, for
    /// both the engines that are confined, and hands each its servers.
    #[test]
    fn the_connect_confines_after_the_ipv6_block() {
        let source = include_str!("mod.rs");
        let start = source.find("    fn connect_inner(").expect("connect_inner");
        let body = &source[start..start + source[start..].find("\n    }\n").expect("its end")];
        let block = body.find("self.block_ipv6_if_needed(profile);").expect("the IPv6 block");
        let confine = body.find("self.confine_if_needed(profile, passive, confine_nodes);").expect("the confinement");
        assert!(block < confine);
        // And the reset after it: the old flows are refused from the moment
        // the filters go in, then told to come back.
        let reset = body.find("self.reset_outside_the_tunnel(profile, passive);").expect("the reset");
        assert!(confine < reset);
        assert!(body.find("confine_nodes.push(plan.server)").is_some(), "Xray's server");
        assert!(body.find("confine_nodes.push(node)").is_some(), "OpenVPN's server");
        // IKEv2's, only while its plan is on: no lookup otherwise.
        let ikev2 = &body[body.find("ConnectProfile::Ikev2(p) => {").expect("the IKEv2 arm")..];
        let ikev2 = &ikev2[..ikev2.find("\n            }\n").expect("its end")];
        assert!(ikev2.contains("if confinement::applies_to(profile, passive) {"));
        assert!(ikev2.contains("confine_nodes.push(node)"));
    }

    /// K5, through the session: a confined Xray tunnel whose engine then
    /// writes that its own connection was refused has the confinement let
    /// go of within the valve's window, the tunnel left up, and the reason
    /// said -- so a wrong permit costs the confinement, never the protocol.
    /// The line is a provisional fixture (see `confinement`'s valve tests).
    #[test]
    fn engine_log_wsaeacces_releases_confinement_and_reports_reason() {
        let (mut engines, fake, dir) = engines_with_engine_files("valve");
        std::fs::write(dir.join(xray::LOG_FILE), "2026/10/12 21:04:01 [Warning] core: Xray 26.1.23 started\n").unwrap();
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", engine_stand_in());
        engines.confine_if_needed(&reality_profile(), false, vec![Ipv4Addr::new(203, 0, 113, 7)]);
        assert_eq!(engines.ipv4_confined(), Some(true));

        use std::io::Write;
        let mut log = std::fs::OpenOptions::new().append(true).open(dir.join(xray::LOG_FILE)).unwrap();
        writeln!(log, "2026/10/12 21:04:05 [Warning] [3123123] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > common/retry: [dial tcp 203.0.113.7:443: connectex: An attempt was made to access a socket in a way forbidden by its access permissions.] > common/retry: all retry attempts failed").unwrap();
        drop(log);

        assert!(
            wait_for(Duration::from_secs(5), || engines.ipv4_confined() == Some(false)),
            "the engine's own refusal did not let go of the confinement"
        );
        assert_eq!(fake.closed(), vec![1000]);
        assert!(engines.confinement_problem().is_some_and(|p| p.contains("refused")), "{:?}", engines.confinement_problem());
        assert!(engines.has_session(), "the tunnel was taken down over its plan");
        assert!(engines.status().0);
        end_test_session(&mut engines);
        assert_eq!(fake.closed(), vec![1000], "closed once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// K5 by WFP's own record, the witness that does not depend on the
    /// engine: the log says nothing -- the bundled xray-core writes a
    /// refused dial at Info, below the config's level; OpenVPN's dropped UDP
    /// is never told -- and WFP records this plan's block refusing the
    /// engine. The confinement is let go of within the valve's window, the
    /// tunnel left up, and the reason said.
    #[test]
    fn a_refusal_wfp_recorded_releases_confinement_though_the_engine_log_is_quiet() {
        let (mut engines, fake, dir) = engines_with_engine_files("valve-wfp");
        std::fs::write(dir.join(xray::LOG_FILE), "2026/10/12 21:04:01 [Warning] core: Xray 26.1.23 started
").unwrap();
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", engine_stand_in());
        engines.confine_if_needed(&reality_profile(), false, vec![Ipv4Addr::new(203, 0, 113, 7)]);
        assert_eq!(engines.ipv4_confined(), Some(true));

        *fake.wfp_says.lock().unwrap() =
            Some("the tunnel engine's own connection was refused by the IPv4 confinement: TCP to port 443".into());
        assert!(
            wait_for(Duration::from_secs(5), || engines.ipv4_confined() == Some(false)),
            "WFP's record of refusing the engine did not let go of the confinement"
        );
        assert_eq!(fake.closed(), vec![1000]);
        assert!(engines.confinement_problem().is_some_and(|p| p.contains("refused")), "{:?}", engines.confinement_problem());
        assert!(engines.has_session(), "the tunnel was taken down over its plan");
        end_test_session(&mut engines);
        assert_eq!(fake.closed(), vec![1000], "closed once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- The reset at connect (decision (c)) -------------------------

    /// A full Xray tunnel's connect resets what is open outside it: one
    /// pass at once, then again every quarter-second for its first three
    /// seconds -- for connections that were mid-handshake at the first --
    /// leaving the engine's own process, the tunnel's address and the LAN
    /// alone. The rescans are the session's: they stop when it ends, and
    /// settle on their own.
    #[test]
    fn a_full_tunnel_resets_what_is_outside_it_and_the_rescans_end_with_the_session() {
        let node = Ipv4Addr::new(203, 0, 113, 7);
        let (mut engines, fake, dir) = engines_with_engine_files("reset");
        let child = engine_stand_in();
        let pid = child.id();
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", child);
        engines.confine_if_needed(&reality_profile(), false, vec![node]);
        engines.reset_outside_the_tunnel(&reality_profile(), false);
        let passes = || fake.resets.lock().unwrap().len();
        assert!(passes() >= 1, "no pass at connect");
        let rules = fake.resets.lock().unwrap()[0].clone();
        assert_eq!(rules.engine_pid, Some(pid), "the engine's link would be cut");
        assert!(rules.tunnel_addresses.contains(&xray::TUN_ADDRESS), "{rules:?}");
        assert!(rules.lan.contains(&(Ipv4Addr::new(169, 254, 0, 0), 16)), "{rules:?}");
        assert!(wait_for(Duration::from_secs(2), || passes() >= 3), "no rescans");
        end_test_session(&mut engines);
        let after = passes();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(passes(), after, "a rescan outlived its session");

        // Left alone, the rescans settle within their window.
        engines.begin_test_session_for(&reality_profile(), "XRAY_VLESS_REALITY", engine_stand_in());
        engines.reset_outside_the_tunnel(&reality_profile(), false);
        std::thread::sleep(Duration::from_millis(3_600));
        let settled = passes();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(passes(), settled, "the rescans did not settle");
        end_test_session(&mut engines);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A connection from any address on one of our adapters is in a tunnel
    /// and is not reset: a Wintun adapter can hold a stale APIPA address
    /// beside its real one, listed first, and taking only the first left
    /// connections already inside OpenVPN's tunnel to be reset for three
    /// seconds. The physical adapter's address is never one of them.
    #[test]
    fn every_address_on_our_adapters_counts_as_in_the_tunnel() {
        let adapter = |name: &str, all: Vec<Ipv4Addr>| adapters::Adapter {
            index: 7,
            name: name.to_string(),
            gateway: None,
            ipv4: all.first().copied(),
            ipv4_prefix: Some(24),
            ipv4_all: all,
            is_up: true,
            dhcp_server: None,
            description: String::new(),
        };
        let listed = vec![
            adapter("Ethernet", vec![Ipv4Addr::new(192, 168, 1, 23)]),
            adapter(openvpn::ADAPTER_NAME, vec![Ipv4Addr::new(169, 254, 12, 34), Ipv4Addr::new(10, 8, 0, 6)]),
            adapter(xray::ADAPTER_NAME, vec![xray::TUN_ADDRESS]),
        ];
        let got = tunnel_addresses_in(&listed, openvpn::ADAPTER_NAME, &OUR_ADAPTER_NAMES);
        for address in [Ipv4Addr::new(10, 8, 0, 6), Ipv4Addr::new(169, 254, 12, 34), xray::TUN_ADDRESS] {
            assert!(got.contains(&address), "{address} missing from {got:?}");
        }
        assert!(!got.contains(&Ipv4Addr::new(192, 168, 1, 23)), "the physical adapter is not a tunnel");
    }

    /// No reset where there is no confinement of ours: WireGuard (its own
    /// kill switch re-examines open flows -- P0-D saw it reset one), IKEv2
    /// while it is not confined, and Custom mode, whose own reset covers
    /// the applications it carries and leaves the rest alone.
    #[test]
    fn no_reset_for_wireguard_ikev2_or_custom_mode() {
        let (mut engines, fake, dir) = engines_with_engine_files("no-reset");
        for (protocol, profile, passive) in [
            ("WIREGUARD", wireguard_profile(), false),
            ("IKEV2", test_profile(), false),
            ("XRAY_VLESS_REALITY", reality_profile(), true),
            ("OPENVPN", openvpn_profile(), true),
        ] {
            engines.begin_test_session_for(&profile, protocol, engine_stand_in());
            engines.reset_outside_the_tunnel(&profile, passive);
            std::thread::sleep(Duration::from_millis(300));
            assert!(fake.resets.lock().unwrap().is_empty(), "{protocol}, passive {passive}");
            end_test_session(&mut engines);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
