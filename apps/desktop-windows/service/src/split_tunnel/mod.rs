//! Custom mode: route only the applications the customer chose.
//!
//! The opposite of the usual "exclude this app from the VPN". Here the
//! default is that nothing is tunnelled and the selected applications
//! are the exception -- the shape a gaming accelerator has, and the one
//! that was asked for.
//!
//! # How the pieces fit
//!
//! 1. The engine brings its tunnel up **passively**: an adapter exists
//!    and will encrypt anything, but no routes are installed, so the
//!    machine's traffic carries on exactly as before.
//! 2. One route through that adapter, at a metric nothing will ever
//!    prefer, makes the tunnel reachable to a socket that asks for it by
//!    name without making it attractive to anything that does not. Which
//!    *shape* of route that has to be is adapter-dependent and is
//!    settled by trying it -- see `session::tunnel::install_verified_route`.
//! 3. [`intercept`] intercepts outbound packets, works out which
//!    application each belongs to, and rewrites the selected ones to a
//!    local proxy.
//! 4. [`relay`] carries them onward on sockets pinned to the tunnel with
//!    `IP_UNICAST_IF`, and relays the replies back.
//!
//! Each of those was proven separately against a real node before any of
//! this was written -- interception, pinning, TCP end to end and UDP end
//! to end -- because two earlier designs failed in ways that counters
//! and return codes reported as success.
//!
//! # Following the active protocol
//!
//! The interface is not captured when Custom mode starts; it is read
//! when each socket is created, so nothing here is bound to one
//! protocol's adapter.
//!
//! Failover itself arrives as an ordinary `Connect`, which tears the old
//! engine down and brings a new one up -- and takes Custom mode with it,
//! stopping and restarting against the new adapter. That deliberately
//! reuses the existing path instead of adding a re-point of its own:
//! there is then one way a tunnel is established, not two, and the
//! seconds in between behave exactly as a full-tunnel customer's would.
//!
//! # Failing open
//!
//! In the seconds when no tunnel exists -- mid-failover, or before the
//! first connect -- selected traffic goes out unprotected rather than
//! being dropped. That was the decision for this feature, and it is the
//! right one for a game. It is not automatically right for someone using
//! this to reach a blocked site, so **the UI must say plainly that
//! traffic can leave unprotected while reconnecting.** Leaking silently
//! is the failure this project has spent the most effort removing.

mod flows;
mod health;
mod net;
mod picker;
mod intercept;
mod log_file;
mod policy;
mod relay;
mod session;
mod tables;
mod worker;

use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;

use neoconnect_ipc::{AppPlacement, SplitTunnelConfig, SplitTunnelMode};

use session::Session;

// Boundary: `engines::janitor` and `engines::repair` reach `delete_rule`
// and `RULE` by this path, so it stays where they look for it.
pub(crate) use net::firewall;
pub use policy::{Selection, SharedSelection};
pub use picker::running_apps;

/// Whether Custom mode is running, readable without the `Engines` lock.
///
/// A shadow of `SplitTunnel::active`, written only by [`ActiveSlot`],
/// whose two mutators are the only ways to fill or empty it. It exists
/// for one caller: the status poll, which has to be answerable while an
/// operation holds the lock -- see `pipe::dispatch`. Anything that holds
/// the lock asks [`SplitTunnel::is_running`], which reads the real thing.
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The running session, and the only code that writes [`RUNNING`].
///
/// The flag used to be kept in step by hand, "at the two places that set
/// and clear it and nowhere else" -- an invariant held by prose, which
/// the next place to assign `active` would not have read. Now the slot
/// cannot change without the flag changing with it.
struct ActiveSlot(Option<Session>);

impl ActiveSlot {
    fn empty() -> Self {
        Self(None)
    }

    /// Filled, then announced -- the order it always had, so the
    /// lock-free reader never sees "running" with nothing behind it.
    fn fill(&mut self, active: Session) {
        self.0 = Some(active);
        RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Emptied, and the flag cleared only if there was something to
    /// clear, exactly as `stop` did.
    fn take(&mut self) -> Option<Session> {
        let active = self.0.take();
        if active.is_some() {
            RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        active
    }

    fn as_ref(&self) -> Option<&Session> {
        self.0.as_ref()
    }

    fn as_mut(&mut self) -> Option<&mut Session> {
        self.0.as_mut()
    }

    fn is_some(&self) -> bool {
        self.0.is_some()
    }
}

/// Whether Custom mode is running, for a caller that cannot take the
/// `Engines` lock.
pub fn running_without_the_lock() -> bool {
    RUNNING.load(std::sync::atomic::Ordering::SeqCst)
}

/// Custom mode, whether or not it is currently running.
///
/// The selection outlives any one connection: a customer who picked
/// their game keeps it selected across disconnects, reconnects and
/// protocol switches.
pub struct SplitTunnel {
    enabled: bool,
    selection: SharedSelection,
    /// What the client said the tunnel it is bringing up leaves from.
    ///
    /// Held rather than derived because it cannot be derived: the
    /// service can see which adapter is up and which address is on it,
    /// and neither of those says which node the far end egresses from.
    /// On a relayed route they are different machines and the egress is
    /// the one the far end sees.
    ///
    /// Kept separately from the selection because it describes the
    /// *session*, not the customer's choices, and because it is only
    /// ever reported alongside a live session -- see
    /// [`SplitTunnel::exit_placements`].
    egress: Option<String>,
    /// The concurrent exits the engine has brought up for this session,
    /// as identifier -> loopback SOCKS5 port.
    ///
    /// On the `SplitTunnel` rather than on [`Session`] because it is
    /// written by the engine layer, which brings an engine up *before*
    /// interception starts and tears it down after interception stops.
    /// A table that only existed while `Session` did would be unwritable
    /// at both of the moments it has to change.
    ///
    /// Empty for every session that does not use concurrent exits --
    /// every WireGuard, OpenVPN and IKEv2 session, and every Xray
    /// session where the customer placed no game. Empty is the state in
    /// which this feature costs one length check per carried packet.
    exits: Arc<relay::ExitRelays>,
    active: ActiveSlot,
    /// Processes that were already running when the customer selected
    /// them, as `(lowercased image path, pid)`.
    ///
    /// The connections these hold predate the choice and cannot be moved
    /// into the tunnel, so this is what `restart_needed` turns into a
    /// sentence for the customer. Kept on the `SplitTunnel` rather than
    /// on `Session` because the selection can be edited before a tunnel
    /// exists, and a notice that appeared only for people who happened
    /// to select in the other order would be worse than none.
    pre_existing: Vec<(String, u32)>,
    /// How many times [`SplitTunnel::stop`] has been called.
    ///
    /// Test-only, and it exists because the invariant it checks cannot
    /// be observed any other way. `stop()` on a session that is not
    /// running is correctly a no-op, so a test that "ends a session"
    /// and then looks at `is_running()` passes whether or not the stop
    /// ever happened -- which is precisely the shape of test that let
    /// the 2026-08-23 bug ship. Counting the calls is the difference
    /// between a test that can come back negative and one that cannot.
    #[cfg(test)]
    stops: std::sync::atomic::AtomicU32,
}

impl Default for SplitTunnel {
    fn default() -> Self {
        Self::new()
    }
}

impl SplitTunnel {
    pub fn new() -> Self {
        Self {
            enabled: false,
            selection: SharedSelection::default(),
            egress: None,
            exits: Arc::new(relay::ExitRelays::default()),
            active: ActiveSlot::empty(),
            pre_existing: Vec::new(),
            #[cfg(test)]
            stops: std::sync::atomic::AtomicU32::new(0),
        }
    }

    /// How many times `stop()` has been called on this one. See the
    /// field's own note for why counting is the only honest check.
    #[cfg(test)]
    pub fn stop_calls(&self) -> u32 {
        self.stops.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Replaces the customer's choice. Takes effect on the next
    /// connection a selected app makes, without restarting anything --
    /// the redirect loop reads the selection per decision.
    ///
    /// The contents are replaced rather than the cell: the running
    /// redirect holds a clone of this handle, and handing it a new one
    /// would leave it reading the old choice. That is not hypothetical.
    /// It shipped that way, and because editing the list within Custom
    /// mode deliberately rebuilds nothing, the customer's first choice
    /// was the only one that ever took effect.
    /// Takes the whole config rather than its fields one by one.
    ///
    /// Deliberate: `apps` and the applications named inside `scopes`
    /// are two lists that have to agree, and passing them as separate
    /// positional arguments through three layers is an invitation to
    /// hand one of them to the wrong parameter. Nothing about a scope
    /// can be lost or crossed on the way in if the way in is the
    /// message itself.
    pub fn set_selection(&mut self, config: SplitTunnelConfig) {
        self.enabled = config.enabled;
        // Replaced, never merged into what was there. A config that
        // names no egress means the client is not asserting one now --
        // which is a different fact from the one it asserted last time,
        // and keeping the old value would report a stale exit for a
        // tunnel that may well have been rebuilt against another node.
        self.egress = config.egress;

        // Taken before the selection is replaced, because "newly
        // selected" is a difference between two lists and one of them is
        // about to be gone.
        let newly_selected: Vec<String> = {
            let previous = self.selection.read().unwrap_or_else(|e| e.into_inner());
            config
                .apps
                .iter()
                .filter(|app| !previous.matches(app))
                .map(|app| app.to_lowercase())
                .collect()
        };

        *self.selection.write().unwrap_or_else(|e| e.into_inner()) =
            Selection::with_exits(config.apps, config.mode, config.scopes, config.exits);

        // What the customer has to be told, and the one thing this
        // product must not do by staying quiet.
        //
        // A process that was already running when it was selected holds
        // connections that predate the choice. Those cannot be moved --
        // a TCP connection is a socket to the real destination, and
        // rewriting half of a live one is not a redirect -- so the
        // honest answer is to say so and let the customer restart it.
        //
        // Recorded as `(image, pid)` pairs rather than as a flag, so it
        // clears itself: restart the game and the pid is gone, the
        // warning goes with it, and nobody is left staring at a notice
        // about something they have already done. See
        // `tables::still_running` for why the pid alone is not enough.
        //
        // Only ever *added* to on a selection change. A list that was
        // replaced would forget an app the customer selected two clicks
        // ago and is still running, which is exactly the case the notice
        // exists for.
        // Only while Custom mode is actually on. With the toggle off the
        // selection is inert -- nothing is being routed, so nothing is
        // failing to be routed, and telling the customer to restart a
        // game would be a warning about a state they are not in. A
        // notice that appears when nothing is wrong is how a customer
        // learns to ignore the one that matters.
        if config.enabled {
            let already_running = tables::pids_running_images(&newly_selected);
            for entry in already_running {
                if !self.pre_existing.contains(&entry) {
                    self.pre_existing.push(entry);
                }
            }
        } else {
            self.pre_existing.clear();
        }
        // Deselecting has to take the warning with it, or a customer who
        // changed their mind keeps being told to restart something that
        // is no longer being routed at all.
        {
            let selection = self.selection.read().unwrap_or_else(|e| e.into_inner());
            self.pre_existing.retain(|(image, _)| selection.should_tunnel(image));
        }

        // The redirect loop reads the selection per decision and so
        // needs nothing here. The WFP filters are a fixed set installed
        // once, and that difference matters in one direction far more
        // than the other: a program the customer has just *deselected*
        // would otherwise keep losing its IPv6 until the next
        // reconnect, which is a setting that visibly does not take
        // effect. Rebuilt rather than patched, because the whole set is
        // six filters per application and a partial edit is a way to
        // get out of step with the list.
        let Some(active) = self.active.as_mut() else { return };
        active.selection_changed(&self.selection);
    }

    /// Where each selected application's traffic is leaving from.
    ///
    /// # The one rule this function exists to enforce
    ///
    /// The egress is reported **only while a session is actually
    /// intercepting**. Not while Custom mode is switched on in
    /// settings, not because the client named one on the last
    /// `SetSplitTunnel`, and not because a tunnel is up -- because
    /// none of those is a selected application's traffic leaving from
    /// anywhere.
    ///
    /// Without that coupling this is a status surface that reports a
    /// request as an observation, which is the exact shape of the
    /// "Connected" indicator that told customers they were protected
    /// while nothing flowed. When there is no live session every
    /// application with a preference comes back
    /// [`ExitPlacement::Unknown`], which is the honest answer and is
    /// deliberately not the same answer as "on the exit you asked
    /// for".
    ///
    /// # What it still does not prove
    ///
    /// That the egress the client named is the address the far end
    /// sees. Nothing on this machine can establish that -- it is a
    /// fact about the node, and the only ground truth for it is an
    /// exit-IP check made through the tunnel. This reports which exit
    /// the client dialled and whether interception is live; it does
    /// not verify the node.
    pub fn exit_placements(&self) -> (Option<String>, Vec<AppPlacement>) {
        let live = if self.is_running() { self.egress.as_deref() } else { None };
        // A concurrent exit relay carrying an application is what makes it
        // "on its preferred exit" even when the session egresses elsewhere.
        let exits = Arc::clone(&self.exits);
        let is_live = move |exit: &str| exits.index_of(exit).is_some();
        let placements = self
            .selection
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .placements(live, &is_live);
        (live.map(str::to_string), placements)
    }

    /// The applications the customer selected while they were already
    /// running, and which are still running, as bare executable names.
    ///
    /// # What this is telling them
    ///
    /// Selecting a program that is already open routes the connections
    /// it makes *next*, and cannot route the ones it already has. A TCP
    /// connection is a socket to the real destination: it can be closed,
    /// but it cannot be moved, and rewriting half of a live one is not a
    /// redirect. UDP flows already in the leave-alone cache are re-asked
    /// immediately -- see `set_selection` -- but a socket the game is
    /// already using is still the socket it is already using.
    ///
    /// So the app says "restart it". That is a smaller claim than the
    /// customer would otherwise assume from silence, and this project's
    /// rule is that silence must not be the thing making the claim.
    ///
    /// # Why names rather than a boolean
    ///
    /// A customer with six things selected needs to know which one to
    /// restart. The bare file name is what they see in the picker and on
    /// their taskbar; the full path is the service's business and would
    /// put a `C:\Program Files\...` string into a sentence.
    ///
    /// Empty is the ordinary answer, including for every customer who
    /// selected their game before opening it -- which is the order the
    /// app's own copy now recommends.
    pub fn restart_needed(&mut self) -> Vec<String> {
        // Re-checked rather than remembered, so the notice disappears
        // the moment the customer acts on it.
        self.pre_existing = tables::still_running(&self.pre_existing);

        let mut names: Vec<String> = self
            .pre_existing
            .iter()
            .map(|(image, _)| {
                image
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or(image.as_str())
                    .to_string()
            })
            .collect();
        // One line per program, not one per process: a game with three
        // helpers is one thing to restart.
        names.sort();
        names.dedup();
        names
    }

    /// Whether Custom mode should shape how the next tunnel is brought
    /// up. False when the toggle is off, and false when it is on with
    /// nothing chosen -- which must not mean "tunnel everything", since
    /// that is the opposite of what the customer asked for.
    pub fn wants_passive_tunnel(&self) -> bool {
        self.wants_interception()
    }

    /// Whether packets must be intercepted at all, whichever way the
    /// list reads.
    ///
    /// The same answer as `wants_passive_tunnel`, and deliberately so.
    /// **Both** modes build a passive tunnel and lift traffic into it
    /// through the redirect; they differ only in which side of the list
    /// gets lifted, which is [`Selection::should_tunnel`]'s business and
    /// nothing this function needs to know.
    ///
    /// This carried a note for a long time claiming the two were
    /// distinct, because "everything except these" supposedly built a
    /// *full* tunnel and pushed the named applications back out of it.
    /// That is not what the code does and, on the evidence, never was:
    /// `mode` reaches exactly two places in this file -- the selection
    /// it is stored in, and the log header -- so there is no branch
    /// anywhere that could build a different shape of tunnel for it.
    /// The note was removed rather than the code changed, because the
    /// code is right: one shape, proven by one route probe, is one
    /// failure mode instead of two.
    pub fn wants_interception(&self) -> bool {
        self.enabled && !self.selection.read().unwrap_or_else(|e| e.into_inner()).is_empty()
    }

    /// Which way the list reads right now.
    pub fn mode(&self) -> SplitTunnelMode {
        self.selection.read().unwrap_or_else(|e| e.into_inner()).mode()
    }

    pub fn is_running(&self) -> bool {
        self.active.is_some()
    }

    /// Brings Custom mode up against a tunnel that is already running
    /// passively.
    ///
    /// `adapter_name` is the engine's own adapter; `node` is the VPN
    /// server, whose traffic must never be redirected -- doing so would
    /// carry the tunnel through itself.
    pub fn start(
        &mut self,
        adapter_name: &str,
        node: Ipv4Addr,
        log_dir: &Path,
        limits: &crate::lifecycle::budget::Limits,
    ) -> Result<(), String> {
        self.stop();
        if !self.wants_interception() {
            return Ok(());
        }
        let mode = self.mode();

        let session = Session::start(
            session::Windows,
            adapter_name,
            node,
            log_dir,
            limits,
            &self.selection,
            &self.exits,
            mode,
        )?;
        self.active.fill(session);
        Ok(())
    }

    /// What the live counters say is wrong, or `None` when nothing is.
    ///
    /// Read from the real path under the customer's own traffic, which
    /// is the one thing [`Self::probe`] cannot do -- see
    /// [`intercept::Stats::complaint`]. Reported on every status poll
    /// rather than only at connect, because the numbers that matter are
    /// zero at connect and only become meaningful once the chosen apps
    /// have actually tried to send something.
    pub fn complaint(&self) -> Option<String> {
        let active = self.active.as_ref()?;
        active.complaint()
    }

    /// Whether the tunnel is really carrying traffic, checked over the
    /// same kind of pinned socket a selected app's traffic uses.
    ///
    /// The app cannot answer this for itself in Custom mode: its own
    /// requests deliberately do not go through the tunnel, so its usual
    /// "did my address change" check correctly reports being bypassed
    /// and would fail every protocol in turn. See [`health::probe`].
    pub fn probe(&self) -> Result<(), String> {
        let Some(active) = self.active.as_ref() else {
            return Err("custom mode is not running".into());
        };
        active.probe()
    }

    /// Records the concurrent exits the engine has just brought up.
    ///
    /// Called by the engine layer between starting the engine and
    /// starting interception, so that a table is never half-written
    /// while the packet path is reading it.
    pub fn set_exits(&mut self, exits: Vec<(String, u16)>) {
        self.exits.set(exits);
    }

    /// Forgets them.
    ///
    /// This is what makes the transition back to one exit **atomic**,
    /// which is the property the whole feature's ban-safety rests on.
    /// Every carried flow reads the table through the same `Arc`, so
    /// clearing it moves every game back to the session's own exit in
    /// one step rather than one connection at a time -- and a game
    /// whose binaries move at different moments is the two-source-
    /// address signature `docs/design/ban-safety.md` mechanism 4
    /// describes.
    pub fn clear_exits(&mut self) {
        self.exits.clear();
    }

    pub fn stop(&mut self) {
        // Counted before the early return, so the count answers "was
        // this asked to stop", not "did it have something to stop".
        // The invariant under test is about the call being made.
        #[cfg(test)]
        self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Taking it out of the slot clears the lock-free flag first, as
        // this always did; letting go of it is the rest of the teardown,
        // in the order `Session`'s fields are declared in.
        drop(self.active.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A selection with no destination scoping, which is what every
    /// test in this file is about.
    fn config_of(enabled: bool, apps: Vec<String>) -> SplitTunnelConfig {
        SplitTunnelConfig {
            enabled,
            mode: SplitTunnelMode::OnlySelected,
            apps,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        }
    }

    #[test]
    fn an_empty_selection_does_not_shape_the_tunnel() {
        // The toggle being on with nothing chosen must not be read as
        // "tunnel everything" -- that is the opposite of Custom mode,
        // and it would arrive as a surprise full tunnel.
        let mut split = SplitTunnel::new();
        split.set_selection(config_of(true, Vec::new()));
        assert!(!split.wants_passive_tunnel());

        split.set_selection(config_of(true, vec![r"C:\Games\game.exe".into()]));
        assert!(split.wants_passive_tunnel());

        split.set_selection(config_of(false, vec![r"C:\Games\game.exe".into()]));
        assert!(!split.wants_passive_tunnel());
    }

    #[test]
    fn stopping_when_nothing_is_running_is_harmless() {
        // Disconnect calls this unconditionally, including for customers
        // who have never turned Custom mode on.
        let mut split = SplitTunnel::new();
        split.stop();
        split.stop();
        assert!(!split.is_running());
    }

    #[test]
    fn an_egress_is_not_reported_while_nothing_is_intercepting() {
        // The rule `exit_placements` exists to enforce, and the one a
        // status surface gets wrong by default.
        //
        // The client named an exit and chose a game. Nothing is
        // running: no session has been started, so no selected
        // application's traffic is leaving from anywhere. Reporting
        // "germany-1" here would be reporting a request as an
        // observation -- the same class of claim as a "Connected"
        // indicator that nothing checked, which is the bug this
        // product's rules were written around.
        let mut split = SplitTunnel::new();
        split.set_selection(SplitTunnelConfig {
            enabled: true,
            mode: SplitTunnelMode::OnlySelected,
            apps: vec![r"C:\Games\game.exe".to_string()],
            scopes: Vec::new(),
            exits: vec![neoconnect_ipc::AppExit {
                app: r"C:\Games\game.exe".to_string(),
                exit: "germany-1".to_string(),
                group: Some("a-game".to_string()),
            }],
            egress: Some("germany-1".to_string()),
        });

        assert!(!split.is_running());
        let (egress, placements) = split.exit_placements();
        assert_eq!(egress, None, "no session means no egress to report");
        assert_eq!(placements.len(), 1);
        assert_eq!(
            placements[0].placement,
            neoconnect_ipc::ExitPlacement::Unknown { preferred: "germany-1".to_string() },
            "a preference with nothing to compare it against is unknown, not satisfied"
        );
    }

    #[test]
    fn a_config_that_names_no_egress_clears_the_last_one() {
        // Replaced rather than merged. The client not naming an egress
        // is a statement -- "I am not asserting one now" -- and keeping
        // the previous value would report a stale exit for a tunnel
        // that may have been rebuilt against a different node entirely.
        let mut split = SplitTunnel::new();
        let with_egress = |egress: Option<&str>| SplitTunnelConfig {
            enabled: true,
            mode: SplitTunnelMode::OnlySelected,
            apps: vec![r"C:\Games\game.exe".to_string()],
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: egress.map(str::to_string),
        };
        split.set_selection(with_egress(Some("germany-1")));
        split.set_selection(with_egress(None));
        assert_eq!(split.egress, None);
    }

    /// A selection made with the program already open is reported, so
    /// the app can tell the customer to restart it.
    ///
    /// This test binary is the running program, which is the only image
    /// a test can be certain is running.
    ///
    /// Both halves are asserted, and the second is the one that makes
    /// the first mean anything: an implementation that simply returned
    /// every selected application would pass the first assertion and
    /// tell every customer to restart a game they had not yet opened.
    #[test]
    fn selecting_a_program_that_is_already_running_says_so() {
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut split = SplitTunnel::new();

        assert!(
            split.restart_needed().is_empty(),
            "nothing is selected yet, so there is nothing to restart"
        );

        split.set_selection(SplitTunnelConfig {
            enabled: true,
            apps: vec![me.clone()],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        let needed = split.restart_needed();
        assert_eq!(
            needed.len(),
            1,
            "the running program the customer just selected must be named, got {needed:?}"
        );
        assert!(
            needed[0].to_lowercase().ends_with(".exe"),
            "the customer is shown the file name, not the full path, got {needed:?}"
        );

        // The control. A program that is not running is not something
        // the customer can usefully restart, and saying so would train
        // them to ignore the notice.
        let mut split = SplitTunnel::new();
        split.set_selection(SplitTunnelConfig {
            enabled: true,
            apps: vec![r"C:\Games\not-running.exe".to_string()],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        assert!(
            split.restart_needed().is_empty(),
            "a program that was not running when it was selected needs no restart"
        );
    }

    /// With the toggle off, there is nothing to say.
    ///
    /// A selection that is not being applied cannot be failing to apply.
    /// Telling a customer whose Custom mode is switched off to restart
    /// their game is a warning about a state they are not in, and the
    /// cost of those is that the warnings which matter get ignored too.
    #[test]
    fn a_selection_that_is_switched_off_asks_for_nothing() {
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut split = SplitTunnel::new();

        // On first, so there is something to lose.
        split.set_selection(SplitTunnelConfig {
            enabled: true,
            apps: vec![me.clone()],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        assert_eq!(split.restart_needed().len(), 1, "the row that had to be non-zero");

        // Same list, toggle off.
        split.set_selection(SplitTunnelConfig {
            enabled: false,
            apps: vec![me],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        assert!(
            split.restart_needed().is_empty(),
            "with Custom mode off nothing is being routed, so nothing needs restarting"
        );
    }

    /// Deselecting takes the notice with it.
    ///
    /// A customer who changed their mind must not keep being told to
    /// restart something that is no longer being routed at all -- that
    /// is a warning they cannot act on, about a state that no longer
    /// exists.
    #[test]
    fn deselecting_a_program_stops_asking_for_a_restart() {
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut split = SplitTunnel::new();

        split.set_selection(SplitTunnelConfig {
            enabled: true,
            apps: vec![me],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        assert_eq!(split.restart_needed().len(), 1, "the row that had to be non-zero");

        split.set_selection(SplitTunnelConfig {
            enabled: true,
            apps: Vec::new(),
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        });
        assert!(
            split.restart_needed().is_empty(),
            "an application the customer deselected must not still be asking for a restart"
        );
    }

    /// Selecting the same program twice does not name it twice.
    ///
    /// The customer edits this list repeatedly -- that is what the
    /// picker is for -- and every edit re-sends the whole selection. An
    /// implementation that appended on each one would grow the notice
    /// every time they touched anything.
    #[test]
    fn re_sending_the_same_selection_does_not_repeat_the_notice() {
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut split = SplitTunnel::new();
        let config = SplitTunnelConfig {
            enabled: true,
            apps: vec![me],
            mode: SplitTunnelMode::OnlySelected,
            scopes: Vec::new(),
            exits: Vec::new(),
            egress: None,
        };

        split.set_selection(config.clone());
        split.set_selection(config.clone());
        split.set_selection(config);

        assert_eq!(
            split.restart_needed().len(),
            1,
            "three identical edits must produce one name, not three"
        );
    }
}
