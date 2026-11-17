//! "Block the internet while reconnecting": the opt-in hold over the gap
//! between a tunnel dropping and a reconnect bringing one back.
//!
//! The state machine is the Windows service's
//! (`apps/desktop-windows/service/src/engines/reconnect_hold.rs`): the same
//! states, the same limits, the same let-gos, the same report. What differs
//! is what holds. On Windows the hold is a WFP session of its own beside
//! the confinement's; here it is the confinement's own nftables table with
//! other contents (`netguard::apply_hold`), swapped in by one transaction
//! when a tunnel drops and swapped back by `netguard::apply` when the next
//! one is up, so there is never a moment with no rules. That makes this
//! module the one writer of that table: the session asks it to confine and
//! to unconfine, and it knows at every moment which of the two is in.
//!
//! # What it changes, and only for whom
//!
//! Off by default, and off it changes nothing: "while the tunnel is down
//! nothing is blocked" is the product's default. A customer who turns the
//! setting on asks for the opposite while their tunnel is being
//! reconnected: nothing leaves the machine in the clear meanwhile.
//!
//! On, a session of a full tunnel this covers ([`covers`]: WireGuard,
//! OpenVPN and the Xray protocols; not IKEv2, not Custom mode) is *armed*
//! when its connect returns. When that session ends in a way that is not
//! the customer's own Disconnect -- the engine dying on its own (seen by
//! the health watch or by a status), or the app taking it down to
//! reconnect (`Request::DisconnectForReconnect`) -- the hold goes in in
//! place of the confinement, before anything of the session's is let go.
//! A connect while it holds keeps it: the server it dials is put in the
//! plan first (a name is resolved for that), and the tunnel it brings up
//! is confined as any other, over the hold, after which the hold reports
//! `landed` until the app lets go of it.
//!
//! WireGuard needs nothing standing here, unlike Windows: its protection
//! on Linux is this table, not a kill switch of the engine's own, so the
//! drop of every engine is held the same way.
//!
//! # What it lets through
//!
//! Our tunnel interfaces; every server the app told us about, by address,
//! any port; WireGuard's own marked packets; the app's control group, so
//! the app can reach its API to sign in again and pick the next server;
//! name lookups to the machine's own resolvers (to anywhere when they
//! cannot be read, which the status says); the LAN. Everything else, both
//! families, both directions, is refused (`netguard::hold_ruleset`).
//!
//! # What lets go of it
//!
//! The app, once it has proved a tunnel or given up
//! (`Request::ReleaseReconnectHold`); the customer's Disconnect; the
//! setting turned off; a connect it does not cover, before that one dials;
//! the app exiting or going silent; the helper stopping; Repair; a drop
//! that no reconnect follows within [`NO_FOLLOW_UP`]; and [`HOLD_LONGEST`]
//! with no tunnel. Fail open, as the confinement does: a hold that will not
//! go in is let go of and said (`ReconnectHold::NotHeld`). A table outlives
//! a helper that is killed, so the unit's `ExecStopPost` sweep and the
//! sweep at start delete it, as they delete the confinement.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, ReconnectHold as Report, ReconnectHoldProblem};
use neoxify_netguard::{Applied, HoldPlan, Plan};

use crate::backend::Backend;

/// The longest it holds with no tunnel up. An auto-reconnect waits at
/// most half an hour for a network at a time and spends a few minutes
/// dialling; past this, the machine is given its networking back.
pub const HOLD_LONGEST: Duration = Duration::from_secs(40 * 60);

/// How long a hold a drop began waits for a reconnect to follow it -- a
/// Connect, a `DisconnectForReconnect`, or the app saying the setting
/// again as its reconnect begins -- before it is let go of.
pub const NO_FOLLOW_UP: Duration = Duration::from_secs(120);

/// How often the LAN and the resolvers are read again while it holds,
/// and how long a plan from them that would not go in is left before it
/// is tried again. A laptop that roams during the wait gets its new
/// network's LAN and resolvers, not the old one's.
pub const REREAD_EVERY: Duration = Duration::from_secs(10);
pub const REREAD_AFTER_REFUSAL: Duration = Duration::from_secs(60);

/// How long a let-go the app cannot see coming waits for a status read to
/// have said it: the app reads every 400 ms in a gap and while it dials.
pub const LET_GO_SAID_WITHIN: Duration = Duration::from_millis(600);

/// The most resolvers and servers a plan permits.
pub const MAX_RESOLVERS: usize = 16;
pub const MAX_NODES: usize = 256;

/// The interfaces the covered engines make (`tunnel`'s `link::OURS`).
/// Named in every plan whether or not they exist yet, so a tunnel brought
/// up under the hold carries at once.
pub const OUR_LINKS: [&str; 3] = ["neoconnect0", "neoxify-wg", "neoxify-ovpn"];

/// The mark WireGuard puts on its own encrypted packets (`tunnel`'s
/// `wireguard.rs`), so a WireGuard reconnect can reach its server.
pub const WIREGUARD_MARK: u32 = 28280;

/// Whether a session of this profile is held when it drops. Full tunnels
/// whose engine this helper runs; not IKEv2, which is never confined and
/// which a hold could stop dialling (strongSwan's own lookups and
/// certificate checks have not been measured under one), and not Custom
/// mode, which leaves the rest of the machine's traffic outside the tunnel
/// by design.
pub fn covers(profile: &ConnectProfile, split: bool) -> bool {
    use ConnectProfile as P;
    !split
        && match profile {
            P::Ikev2(_) => false,
            P::Wireguard(_)
            | P::XrayVlessReality(_)
            | P::XrayVlessTls(_)
            | P::XrayTrojan(_)
            | P::Shadowsocks(_)
            | P::Openvpn(_) => true,
        }
}

/// What a session armed for a drop needs let through: its interfaces and
/// the servers a reconnect may dial (every literal the app sent in
/// `known_nodes`, the session's own transports, the server it dialled).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Arming {
    pub ifaces: Vec<String>,
    pub servers: Vec<Ipv4Addr>,
    /// The machine's own resolvers as read when the session was armed.
    /// They stand in when a read at the drop finds none: an uplink that
    /// went away takes its DNS servers with it, and with none to name the
    /// hold would open port 53 to anywhere -- the proof's capture saw an
    /// ordinary program's lookups to any server leave the uplink in the
    /// clear from the moment the uplink came back until the reconnect.
    pub resolvers: Vec<IpAddr>,
}

/// Why a hold is let go of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Release {
    /// On purpose -- the app, the customer, the helper ending -- with the
    /// reason for the log. Nothing to report afterwards.
    Asked(&'static str),
    /// Because it could not go on, which the status then says.
    Failed(ReconnectHoldProblem, String),
}

/// Which of our two contents the table has, as this module last wrote it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Table {
    #[default]
    Nothing,
    Confinement,
    Hold,
}

#[derive(Default)]
struct State {
    /// The setting, as the app last said it.
    wanted: bool,
    /// The session a drop would be held for, and what it needs.
    armed: Option<(u64, Arming)>,
    table: Table,
    /// A drop is being held: from the hold going in until it is let go
    /// of. The table is the hold's, or -- once a tunnel has come up under
    /// it -- that tunnel's confinement.
    holding: bool,
    /// The plan the hold last went in with.
    held: Option<HoldPlan>,
    since: Option<Instant>,
    /// The session whose ending this hold is for.
    engaged_by: Option<u64>,
    /// Why it is not holding when it should be. Cleared when it holds
    /// again, and when it is let go of on purpose.
    problem: Option<(ReconnectHoldProblem, String)>,
    /// A drop began this hold and no reconnect has followed it yet.
    awaiting_follow_up: bool,
    reread_at: Option<Instant>,
    /// About to be let go of, and the status says so until it is.
    letting_go: bool,
    /// How many statuses have said it: what a let-go waits on.
    said_letting_go: u64,
    /// The app's control group, once its process has been moved into it.
    app_group: Option<String>,
    /// The app processes already moved, so each is moved once.
    adopted: Vec<u32>,
}

/// The hold: one for the helper's life, shared by `Arc` between the
/// session's thread (which engages it and confines) and the socket (which
/// lets go of it and reports it without waiting for that thread).
///
/// One mutex over its whole state, and every write of the table made under
/// it: whichever caller gets there first does the work and every other
/// finds it done.
pub struct Hold {
    state: Mutex<State>,
    /// Woken when a status has said the hold is being let go of, and when
    /// it goes.
    said: Condvar,
    backend: Arc<dyn Backend>,
    longest: Duration,
    follow_up: Duration,
}

impl Hold {
    pub fn new(backend: Arc<dyn Backend>) -> Arc<Self> {
        Self::with_limits(backend, HOLD_LONGEST, NO_FOLLOW_UP)
    }

    /// A hold whose backstops come sooner, for tests.
    pub fn with_limits(backend: Arc<dyn Backend>, longest: Duration, follow_up: Duration) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), said: Condvar::new(), backend, longest, follow_up })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_wanted(&self, wanted: bool) {
        self.lock().wanted = wanted;
    }

    pub fn wanted(&self) -> bool {
        self.lock().wanted
    }

    /// Moves the app's process into the group the hold lets through, once
    /// per process, so that while it holds the app can still reach its API
    /// to sign in again and find the next server. A process that cannot be
    /// moved is said in the log: the hold still holds, and the app's own
    /// requests wait for the tunnel or for a backstop to let go.
    pub fn adopt(&self, pid: u32) {
        if self.lock().adopted.contains(&pid) {
            return;
        }
        match self.backend.adopt_app(pid) {
            Ok(group) => {
                let mut state = self.lock();
                state.adopted.retain(|p| std::path::Path::new(&format!("/proc/{p}")).exists());
                state.adopted.push(pid);
                state.app_group = Some(group);
            }
            Err(why) => crate::say!("neoxify-helper: the app could not be put in its group for the reconnect hold: {why}"),
        }
    }

    /// The setting turned off: lets go of a hold and forgets the plan.
    pub fn turn_off(&self) -> bool {
        let mut state = self.lock();
        state.wanted = false;
        state.armed = None;
        state.problem = None;
        self.let_go_locked(state, Release::Asked("the setting was turned off"))
    }

    /// Arms the session `generation`, if the setting is on. A session
    /// armed that is not the one armed before, with nothing held: why the
    /// last hold was let go of was about a drop that is over.
    pub fn arm(&self, generation: u64, arming: Arming) -> bool {
        let mut state = self.lock();
        if !state.wanted || generation == 0 {
            return false;
        }
        if state.holding && state.engaged_by == Some(generation) {
            return true;
        }
        if !state.holding && state.armed.as_ref().map(|(armed, _)| *armed) != Some(generation) {
            state.problem = None;
        }
        // The same session armed again: never narrower than before.
        let arming = match &state.armed {
            Some((armed, before)) if *armed == generation => widen(arming, before),
            _ => arming,
        };
        state.armed = Some((generation, arming));
        true
    }

    /// Forgets the plan for a drop. A hold held stays: letting go of one is
    /// asked for on its own (`release`).
    pub fn disarm(&self) {
        self.lock().armed = None;
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn armed_for(&self, generation: u64) -> bool {
        let state = self.lock();
        state.wanted && state.armed.as_ref().is_some_and(|(armed, _)| *armed == generation)
    }

    /// Puts the session's confinement in force, in place of whatever of
    /// ours is there -- the hold, when a tunnel has come up under it -- in
    /// one transaction. A table that will not go in is deleted, so what
    /// stands is either the whole of one or nothing: the tunnel is up, and
    /// its confinement failing is said in the status.
    pub fn confine(&self, plan: &Plan) -> Result<Applied, neoxify_netguard::Error> {
        let mut state = self.lock();
        match self.backend.guard_apply(plan) {
            Ok(applied) => {
                state.table = Table::Confinement;
                Ok(applied)
            }
            Err(err) => {
                if let Err(e) = self.backend.guard_remove() {
                    crate::say!("neoxify-helper: removing a half-written table: {e}");
                }
                state.table = Table::Nothing;
                if state.holding {
                    crate::say!("neoxify-helper: the tunnel that came up under the hold could not be confined, so nothing is held over it");
                    // No table of ours stands now, so the hold is let go of
                    // and says why: still reporting it held would tell the
                    // app the internet is blocked when nothing blocks it.
                    let detail = format!("the tunnel came back but its leak protection would not go in: {err}");
                    self.let_go_locked(state, Release::Failed(ReconnectHoldProblem::FiltersRefused, detail));
                }
                Err(err)
            }
        }
    }

    /// Takes the session's table out -- unless it is the hold's, which a
    /// session's teardown must leave in place: that is the point of it.
    /// Always deletes otherwise, tunnel or none: a table standing with
    /// nothing to let through is the one leftover that takes a machine's
    /// whole internet, and deleting none costs one nft call.
    pub fn unconfine(&self) -> Result<(), String> {
        let mut state = self.lock();
        if state.holding && state.table == Table::Hold {
            return Ok(());
        }
        state.table = Table::Nothing;
        self.backend.guard_remove().map(|_| ()).map_err(|e| e.to_string())
    }

    /// Whether the table in force is the hold's.
    pub fn hold_in_table(&self) -> bool {
        self.lock().table == Table::Hold
    }

    /// Holds, with the plan armed for `generation`, because that session
    /// is ending in a way that is not the customer's own. Returns whether
    /// it is holding now -- already, or from this call. A caller lets go of
    /// the session's own protection only after this has returned, and only
    /// when it returned false.
    pub fn engage(&self, generation: u64, why: &str) -> bool {
        let mut state = self.lock();
        if state.holding {
            // Another drop while it holds -- the tunnel a reconnect brought
            // up, gone too, or the app's own teardown of it: the hold is
            // that one's now, and the table goes back to the hold's.
            let arming = match &state.armed {
                Some((armed, arming)) if *armed == generation => Some(arming.clone()),
                _ => None,
            };
            if arming.is_some() {
                state.engaged_by = Some(generation);
            }
            if state.table == Table::Hold {
                return true;
            }
            let mut plan = state.held.clone().unwrap_or_default();
            if let Some(arming) = &arming {
                plan = self.with_arming(plan, arming);
            }
            let plan = self.refreshed(plan, &state);
            return match self.backend.hold_apply(&plan) {
                Ok(held) => {
                    state.table = Table::Hold;
                    state.held = Some(HoldPlan { dns_anywhere: held.dns_anywhere, ..plan });
                    state.reread_at = None;
                    drop(state);
                    crate::say!("neoxify-helper: holding again: the tunnel that came up under the hold went too ({why})");
                    true
                }
                Err(e) => {
                    let detail = format!("the hold could not be put back in when the tunnel that came up under it ended: {e}");
                    self.let_go_locked(state, Release::Failed(ReconnectHoldProblem::FiltersRefused, detail));
                    false
                }
            };
        }
        if !state.wanted {
            return false;
        }
        let arming = match &state.armed {
            Some((armed, arming)) if *armed == generation => arming.clone(),
            _ => return false,
        };
        let plan = self.with_arming(HoldPlan::default(), &arming);
        let plan = self.refreshed(plan, &state);
        match self.backend.hold_apply(&plan) {
            Ok(held) => {
                let dns_anywhere = held.dns_anywhere;
                state.table = Table::Hold;
                state.held = Some(HoldPlan { dns_anywhere, ..plan });
                state.holding = true;
                state.since = Some(Instant::now());
                state.engaged_by = Some(generation);
                state.problem = None;
                state.awaiting_follow_up = true;
                state.reread_at = None;
                drop(state);
                crate::say!(
                    "neoxify-helper: holding: nothing but Neoxify reaches the network outside a tunnel{} ({why})",
                    if dns_anywhere { "; the machine's resolvers could not be read, so lookups go anywhere" } else { "" }
                );
                true
            }
            Err(e) => {
                state.problem = Some((ReconnectHoldProblem::FiltersRefused, e.to_string()));
                drop(state);
                crate::say!("neoxify-helper: could not hold ({why}), so nothing is held: {e}");
                false
            }
        }
    }

    /// A connect is about to dial `server` while it holds: the server is
    /// put in the plan first, or the engine could not reach it. A plan that
    /// will not go in lets go of the hold rather than stop that connect: a
    /// protocol is never stopped for the hold's sake.
    pub fn permit_server(&self, server: Ipv4Addr) -> bool {
        let mut state = self.lock();
        if !state.holding || state.table != Table::Hold {
            return false;
        }
        let Some(held) = state.held.clone() else { return false };
        if held.servers.contains(&server) {
            return true;
        }
        let mut plan = held;
        if plan.servers.len() < MAX_NODES {
            plan.servers.push(server);
        }
        match self.backend.hold_apply(&plan) {
            Ok(held) => {
                state.held = Some(HoldPlan { dns_anywhere: held.dns_anywhere, ..plan });
                true
            }
            Err(e) => {
                let detail = format!("the server being dialled could not be put in the hold's plan, so the hold was let go of: {e}");
                self.let_go_locked(state, Release::Failed(ReconnectHoldProblem::TunnelNotPermitted, detail));
                false
            }
        }
    }

    /// A reconnect follows the drop being held for. The hold then lasts
    /// until it is let go of or [`HOLD_LONGEST`], no longer [`NO_FOLLOW_UP`].
    pub fn followed(&self) {
        self.lock().awaiting_follow_up = false;
    }

    /// Lets go of the hold, if one is held. Returns whether this call let
    /// go of it. Safe from any thread, any number of times.
    pub fn release(&self, why: Release) -> bool {
        let state = self.lock();
        self.let_go_locked(state, why)
    }

    fn let_go_locked(&self, mut state: MutexGuard<'_, State>, why: Release) -> bool {
        let reason = match &why {
            Release::Asked(reason) => {
                state.problem = None;
                (*reason).to_string()
            }
            Release::Failed(problem, detail) => {
                state.problem = Some((*problem, detail.clone()));
                detail.clone()
            }
        };
        if !state.holding {
            return false;
        }
        let held_for = state.since.map(|since| since.elapsed().as_secs());
        // The hold's table goes; a confinement in its place is the live
        // tunnel's, and stays.
        let removal = if state.table == Table::Hold {
            state.table = Table::Nothing;
            Some(self.backend.guard_remove())
        } else {
            None
        };
        state.holding = false;
        state.held = None;
        state.since = None;
        state.engaged_by = None;
        state.awaiting_follow_up = false;
        state.reread_at = None;
        if std::mem::take(&mut state.letting_go) {
            self.said.notify_all();
        }
        drop(state);
        let held_for = held_for.map_or_else(String::new, |s| format!(" after {s}s"));
        match removal {
            Some(Err(e)) => crate::say!("neoxify-helper: let go of the hold{held_for}, but its table would not go: {e} ({reason})"),
            _ => crate::say!("neoxify-helper: let go of the hold{held_for} ({reason})"),
        }
        true
    }

    /// What every status read and the health watch do to it, with the
    /// session up now, if any: let go of a hold nothing followed or that
    /// has held too long with no tunnel -- the session whose drop it holds
    /// for, still in the slot while it is taken down, is no tunnel -- and
    /// read the network again while the hold's table is in.
    pub fn tend(&self, live: Option<u64>) {
        let tunnel_up = live.is_some() && live != self.lock().engaged_by;
        if !self.expire_if_due(tunnel_up, self.longest) {
            self.reread(Instant::now());
        }
    }

    /// Lets go of a hold that has held for `longest` with no tunnel up --
    /// or, sooner, one a drop began that no reconnect has followed within
    /// [`NO_FOLLOW_UP`] (shorter in tests).
    pub fn expire_if_due(&self, tunnel_up: bool, longest: Duration) -> bool {
        let state = self.lock();
        let held_for = state.since.map(|since| since.elapsed());
        if !state.holding || tunnel_up || held_for.is_none() {
            return false;
        }
        let held_for = held_for.unwrap_or_default();
        if state.awaiting_follow_up && held_for >= self.follow_up {
            let detail = format!("no reconnect followed the drop within {} seconds, so it was let go of", self.follow_up.as_secs());
            return self.let_go_locked(state, Release::Failed(ReconnectHoldProblem::Other, detail));
        }
        if held_for >= longest {
            let detail = format!("held for {} minutes with no tunnel back, so it was let go of", longest.as_secs() / 60);
            return self.let_go_locked(state, Release::Failed(ReconnectHoldProblem::TimedOut, detail));
        }
        false
    }

    /// The LAN and the resolvers read again while the hold's table is in,
    /// at most every [`REREAD_EVERY`], and the plan moved onto them when
    /// they have changed. Resolvers read as none -- a network going down
    /// reads none -- keep the ones held. A plan that will not go in leaves
    /// the one in force (nft's transaction leaves the old table whole), and
    /// is not tried again for [`REREAD_AFTER_REFUSAL`].
    pub fn reread(&self, now: Instant) -> bool {
        let mut state = self.lock();
        if !state.holding || state.table != Table::Hold || state.reread_at.is_some_and(|at| now < at) {
            return false;
        }
        state.reread_at = Some(now + REREAD_EVERY);
        let Some(held) = state.held.clone() else { return false };
        let next = self.refreshed(held.clone(), &state);
        if next == held {
            return false;
        }
        match self.backend.hold_apply(&next) {
            Ok(applied) => {
                state.held = Some(HoldPlan { dns_anywhere: applied.dns_anywhere, ..next });
                drop(state);
                crate::say!("neoxify-helper: the network changed while holding, so the LAN and resolvers it permits were read again");
                true
            }
            Err(e) => {
                state.reread_at = Some(now + REREAD_AFTER_REFUSAL);
                drop(state);
                crate::say!("neoxify-helper: a new plan for the hold would not go in, so the one in force stays: {e}");
                false
            }
        }
    }

    /// Says the hold is about to be let go of -- the status reports
    /// `LettingGo` -- and waits until a status has said so, at most
    /// `within`. Returns whether one did. Nothing held, nothing said.
    pub fn warn_of_letting_go(&self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        let mut state = self.lock();
        if !state.holding {
            return false;
        }
        state.letting_go = true;
        let seen = state.said_letting_go;
        loop {
            if state.said_letting_go != seen {
                return true;
            }
            if !state.letting_go {
                return false;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = match self.said.wait_timeout(state, left) {
                Ok((state, _)) => state,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    /// Lets go for `why` once a status has said it is being let go of, or
    /// `within` has passed. Nothing held, or let go of by another
    /// meanwhile -- the customer's Disconnect, a backstop -- and nothing is
    /// done, nor any problem said.
    pub fn let_go_once_said(&self, why: Release, within: Duration) -> bool {
        self.warn_of_letting_go(within);
        let state = self.lock();
        if !state.letting_go {
            return false;
        }
        self.let_go_locked(state, why)
    }

    /// Whether a drop is being held.
    pub fn holding(&self) -> bool {
        self.lock().holding
    }

    /// What the status says of it. `live`: the session up now, if any --
    /// "armed" is said only of the session that is, and a hold is said to
    /// have `landed` only under a session that came up after the drop it
    /// holds for and is armed. Every call here answers a status read, which
    /// is what a let-go waits on.
    pub fn report(&self, live: Option<u64>) -> Option<Report> {
        let mut state = self.lock();
        if state.holding && state.letting_go {
            state.said_letting_go += 1;
            self.said.notify_all();
            return Some(Report::LettingGo);
        }
        if state.holding {
            let held_secs = state.since.map_or(0, |since| since.elapsed().as_secs());
            let dns_anywhere = state.held.as_ref().is_some_and(|h| h.dns_anywhere);
            let landed = live.is_some()
                && live != state.engaged_by
                && state.armed.as_ref().is_some_and(|(armed, _)| live == Some(*armed));
            // Linux has no filters standing while a tunnel is up, so no
            // drop is ever held late.
            return Some(Report::Holding { held_secs, dns_anywhere, landed, standing_refused: false });
        }
        if let Some((problem, detail)) = &state.problem {
            return Some(Report::NotHeld { problem: *problem, detail: Some(detail.clone()) });
        }
        let armed = state.armed.as_ref().is_some_and(|(armed, _)| live == Some(*armed));
        (state.wanted && armed).then_some(Report::Armed)
    }

    /// `plan` permitting as well what `arming` needs.
    fn with_arming(&self, mut plan: HoldPlan, arming: &Arming) -> HoldPlan {
        for name in OUR_LINKS.iter().map(|s| s.to_string()).chain(arming.ifaces.iter().cloned()) {
            if !plan.tunnel_ifaces.contains(&name) {
                plan.tunnel_ifaces.push(name);
            }
        }
        for server in &arming.servers {
            if plan.servers.len() < MAX_NODES && !plan.servers.contains(server) && usable(*server) {
                plan.servers.push(*server);
            }
        }
        // Only where the plan names none: what `refreshed` falls back on
        // when the machine shows none now.
        if plan.resolvers.is_empty() {
            for r in &arming.resolvers {
                if plan.resolvers.len() < MAX_RESOLVERS && !r.is_unspecified() && !r.is_loopback() && !plan.resolvers.contains(r) {
                    plan.resolvers.push(*r);
                }
            }
        }
        plan.engine_fwmark = Some(WIREGUARD_MARK);
        plan
    }

    /// `plan` with the app's group, the LAN and the resolvers as the
    /// machine shows them now. Resolvers read as none keep those held.
    fn refreshed(&self, mut plan: HoldPlan, state: &State) -> HoldPlan {
        let ifaces: Vec<&str> = plan.tunnel_ifaces.iter().map(String::as_str).collect();
        plan.lan = self.backend.lan_prefixes(&ifaces);
        let mut resolvers: Vec<IpAddr> = Vec::new();
        for r in self.backend.machine_resolvers() {
            if resolvers.len() < MAX_RESOLVERS && !r.is_unspecified() && !r.is_loopback() && !resolvers.contains(&r) {
                resolvers.push(r);
            }
        }
        if resolvers.is_empty() {
            resolvers = state.held.as_ref().map(|h| h.resolvers.clone()).unwrap_or_default();
            if resolvers.is_empty() {
                resolvers = plan.resolvers.clone();
            }
        }
        plan.dns_anywhere = resolvers.is_empty();
        plan.resolvers = resolvers;
        plan.app_group = state.app_group.clone();
        plan
    }
}

fn usable(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_broadcast() && !ip.is_loopback() && !ip.is_multicast()
}

fn widen(mut arming: Arming, before: &Arming) -> Arming {
    for i in &before.ifaces {
        if !arming.ifaces.contains(i) {
            arming.ifaces.push(i.clone());
        }
    }
    for s in &before.servers {
        if !arming.servers.contains(s) && arming.servers.len() < MAX_NODES {
            arming.servers.push(*s);
        }
    }
    if arming.resolvers.is_empty() {
        arming.resolvers = before.resolvers.clone();
    }
    arming
}

/// The IPv4 literals among the servers the app named, bounded. Names are
/// not looked up here: a lookup for every node at every connect would be
/// slow and would tell the network which servers the app knows.
pub fn literals(known_nodes: &[String]) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    for host in known_nodes.iter().take(MAX_NODES) {
        if let Ok(ip) = host.trim().parse::<Ipv4Addr>() {
            if usable(ip) && !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    out
}

/// The host a profile dials, as written in it.
pub fn server_host(profile: &ConnectProfile) -> Option<String> {
    let host_of = |endpoint: &str| {
        endpoint.rsplit_once(':').map(|(host, _)| host.trim_start_matches('[').trim_end_matches(']').to_string())
    };
    match profile {
        ConnectProfile::Wireguard(p) => host_of(&p.endpoint),
        ConnectProfile::Openvpn(p) => host_of(&p.endpoint),
        ConnectProfile::XrayVlessReality(p) => Some(p.host.clone()),
        ConnectProfile::XrayVlessTls(p) => Some(p.host.clone()),
        ConnectProfile::XrayTrojan(p) => Some(p.host.clone()),
        ConnectProfile::Shadowsocks(p) => Some(p.host.clone()),
        ConnectProfile::Ikev2(p) => Some(p.server.clone()),
    }
}
