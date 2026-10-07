//! Custom mode's policy: whose traffic is carried, to where, and from
//! which exit.
//!
//! Pure. Nothing in this directory touches Windows, a socket or a clock:
//! it is the customer's choice turned into answers, asked on every
//! packet by `intercept` and on every status poll by the session. That
//! is what lets every rule here be tested as a table of cases on any
//! machine, and the test at the bottom of this file holds the line --
//! see `the_policy_names_nothing_outside_itself`.
//!
//! Three vocabularies answer three questions, asked in this order and
//! never the other way round:
//!
//! * [`Selection::should_tunnel`] -- is this application's traffic ours
//!   -- and, for a packet nobody can be shown to have sent,
//!   [`Unattributed`].
//! * [`Scoped`] -- and is *this packet* of it going somewhere we carry.
//! * [`Selection::placement`] -- where a carried flow leaves from, which
//!   can never change whether it is carried.

mod internet;
mod scope;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};

use neoconnect_ipc::{AppPlacement, ExitPlacement, SplitTunnelMode};

pub use internet::{is_public_v4, is_public_v6};
use scope::Scope;

/// The transport a port belongs to. Ports are per-protocol, so TCP 4000
/// and UDP 4000 are different sockets owned by possibly different apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Transport {
    Tcp,
    Udp,
}

/// Which address family a local port was opened in.
///
/// Kept apart rather than merged into one port -> pid map, even though
/// merging would be less code. Windows draws IPv4 and IPv6 ephemeral
/// ports from ranges that overlap, so TCP 51234 can be one process over
/// IPv4 and a different one over IPv6 at the same moment. A merged map
/// answers one of those two questions wrongly, and both wrong answers
/// are bad in the direction this feature cares about: attributing an
/// IPv6 flow to a selected app that does not own it stops traffic the
/// customer never asked to stop, and missing one leaves the leak open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    V4,
    V6,
}

/// The applications the customer chose to route through the tunnel.
///
/// Held as full paths, lowercased once at construction so matching is a
/// plain comparison rather than a case-insensitive scan per packet.
/// Paths, never process ids: the spike watched `chrome.exe` appear under
/// two different pids inside twenty seconds, and a customer who picks an
/// app means every process from that image, including ones that do not
/// exist yet.
/// A selection the redirect loop can be handed once and still see
/// later edits through.
///
/// The lock is read on every packet and written only when the customer
/// changes their choice, which is why it is an `RwLock`: the readers are
/// the hot path and they do not contend with each other.
pub type SharedSelection = Arc<RwLock<Selection>>;

#[derive(Debug, Default, Clone)]
pub struct Selection {
    paths: Vec<String>,
    /// Which way the list reads. Held here because `matches` is the hot
    /// path and the answer must not depend on a second lookup somewhere
    /// else that could disagree with it.
    mode: SplitTunnelMode,
    /// Lowercased path -> where that application's traffic is carried.
    ///
    /// Sparse on purpose. An application absent from here is not
    /// scoped, which is the behaviour this feature has always had, and
    /// it is absent for every reason there is: the app sent no list,
    /// the catalogue would not vouch for the list it had, the list did
    /// not parse, or the mode is one where a scope has no meaning. All
    /// four failures land on the same safe answer without a caller
    /// having to remember which is which.
    scopes: HashMap<String, Scope>,
    /// Lowercased path -> the exit that application's traffic should
    /// leave from.
    ///
    /// Sparse for the same reasons `scopes` is, and read on the same
    /// terms: an application absent from here has no preference, which
    /// is what every application had before this existed.
    ///
    /// **Deliberately not consulted by anything on the packet path.**
    /// A preference says where a carried flow should egress, not
    /// whether it is carried, and one session has one egress -- so
    /// there is nothing per-packet for it to decide and `decide` does
    /// not ask it. See `docs/design/per-game-exits.md` for why that
    /// separation is the safety argument rather than an optimisation.
    exits: HashMap<String, String>,
}

/// Whether `image_path`, lowercased, is exactly `lowered` -- without
/// building the lowercased copy.
///
/// ASCII only, and the callers check that first. For an ASCII string
/// `to_lowercase` is byte-for-byte `to_ascii_lowercase`, so comparing
/// byte by byte with the case folded on the fly gives exactly the answer
/// the allocating version gave. A path with anything else in it -- a
/// customer's user folder named in their own script -- takes the
/// allocating route unchanged, because Unicode lowercasing is not a
/// per-byte operation and a cheaper answer that differs from it would
/// change which applications are carried.
fn same_ascii_path(lowered: &str, image_path: &str) -> bool {
    debug_assert!(image_path.is_ascii());
    lowered.len() == image_path.len()
        && lowered.bytes().zip(image_path.bytes()).all(|(l, i)| l == i.to_ascii_lowercase())
}

impl Selection {
    pub fn new<I: IntoIterator<Item = String>>(paths: I, mode: SplitTunnelMode) -> Self {
        Self::with_scopes(paths, mode, Vec::new())
    }

    /// The same selection, plus the destinations some of those
    /// applications are narrowed to.
    ///
    /// Everything that could make a scope wrong is filtered out here,
    /// once, so that the hot path has nothing left to check:
    ///
    /// * **Not `OnlySelected`, no scopes at all.** A scope says "carry
    ///   only this application's traffic to here". Under `AllExcept`
    ///   the named applications are the ones *not* carried, so there is
    ///   nothing to narrow and any reading of a scope there would be an
    ///   invention. Refused rather than guessed at -- and note this is
    ///   belt as well as braces, since `should_tunnel` never returns
    ///   true for a named app in that mode anyway.
    /// * **Scopes naming an application that was not selected are
    ///   dropped.** They cannot describe traffic, so they can only
    ///   mislead a later reader.
    /// * **A scope that will not fully parse is dropped**, by
    ///   [`Scope::new`] returning `None`. Never narrowed to the part
    ///   that did parse.
    pub fn with_scopes<I, S>(paths: I, mode: SplitTunnelMode, scopes: S) -> Self
    where
        I: IntoIterator<Item = String>,
        S: IntoIterator<Item = neoconnect_ipc::AppScope>,
    {
        Self::with_exits(paths, mode, scopes, Vec::new())
    }

    /// The same selection, plus the exit each of those applications
    /// should leave from.
    ///
    /// A separate constructor rather than a fourth argument on
    /// [`Self::with_scopes`], so that every existing caller keeps the
    /// signature it was written against -- the same additive rule the
    /// wire protocol follows, applied to the Rust API, because this
    /// type is constructed from tests that must not have to be
    /// rewritten to prove something unrelated.
    ///
    /// Everything that could make a preference wrong is filtered out
    /// here, once, on the same two grounds `with_scopes` uses:
    ///
    /// * **Not `OnlySelected`, no preferences at all.** Under
    ///   `AllExcept` the named applications are the ones deliberately
    ///   *not* carried, so they have no egress and a preference for one
    ///   would be an invention. This makes per-application exits an
    ///   `OnlySelected` feature, which is a real limit and is stated in
    ///   the design doc rather than worked around: "everything except
    ///   these" has no vocabulary for naming the applications that
    ///   *are* carried, so there is nothing to hang a preference on.
    /// * **A preference naming an application that was not selected is
    ///   dropped.** It describes no traffic, so it can only mislead
    ///   whoever reads the placement report later.
    ///
    /// A preference is never dropped for naming an exit that is not
    /// live. That case is not an error and is not decided here -- it is
    /// [`ExitPlacement::Fallback`], worked out against the session's
    /// egress at the moment somebody asks, with the traffic carried
    /// either way.
    ///
    /// # The group rule, which is the ban-safety half
    ///
    /// A preference is keyed on an executable and a game is routinely
    /// several of them -- `Rust.exe` is the EAC wrapper Steam launches
    /// and `RustClient.exe` is the game; `SeaOfThieves.exe` is a shim
    /// and `SoTGame.exe` is the binary. [`neoconnect_ipc::AppExit::group`]
    /// says which game an entry belongs to, and this enforces two things
    /// about it that no caller has to remember:
    ///
    /// * **A group whose members are not all selected gets no
    ///   preference at all**, rather than the part that happens to be
    ///   selected. The dropped member is not carried, so when it starts
    ///   it appears from the customer's own address while its siblings
    ///   appear from the exit -- one account, two source addresses, at
    ///   the same instant. That is the account-sharing signature
    ///   `docs/design/ban-safety.md` mechanism 4 describes, and it is
    ///   the one this product could manufacture rather than merely fail
    ///   to prevent. Placing what was found and hoping the rest follows
    ///   is the failure, not a smaller version of the feature.
    /// * **A group naming two exits is dropped whole.** Belt as well as
    ///   braces: `SplitTunnelConfig::validate` refuses such a config
    ///   outright, so nothing that comes through the pipe reaches here.
    ///   This type is also built directly, and a rule this expensive to
    ///   get wrong should not depend on which constructor was used.
    ///
    /// Both fail toward *no preference*, which carries the game on the
    /// session's exit exactly as every application was carried before
    /// any of this existed. Never toward a split.
    ///
    /// An entry with no group keeps the per-entry rule above: it is a
    /// preference for one executable, claiming nothing about a game,
    /// which is what an app that predates the field meant by it.
    pub fn with_exits<I, S, E>(paths: I, mode: SplitTunnelMode, scopes: S, exits: E) -> Self
    where
        I: IntoIterator<Item = String>,
        S: IntoIterator<Item = neoconnect_ipc::AppScope>,
        E: IntoIterator<Item = neoconnect_ipc::AppExit>,
    {
        let paths: Vec<String> = paths.into_iter().map(|p| p.to_lowercase()).collect();
        let mut built = HashMap::new();
        let mut chosen = HashMap::new();
        if matches!(mode, SplitTunnelMode::OnlySelected) {
            for scope in scopes {
                let app = scope.app.to_lowercase();
                if !paths.contains(&app) {
                    continue;
                }
                if let Some(built_scope) = Scope::new(&scope.destinations) {
                    built.insert(app, built_scope);
                }
            }
            // Materialised because the group rule needs two passes:
            // whether a group is whole cannot be known while still
            // reading its members.
            let exits: Vec<neoconnect_ipc::AppExit> = exits.into_iter().collect();
            let mut broken: Vec<String> = Vec::new();
            for (i, exit) in exits.iter().enumerate() {
                let Some(group) = exit.group.as_deref() else { continue };
                if broken.iter().any(|b| b == group) {
                    continue;
                }
                // A member that was not selected is not carried, so
                // where it goes is not ours to say -- and the rest of
                // the group must not be placed on the strength of it.
                if !paths.contains(&exit.app.to_lowercase()) {
                    broken.push(group.to_string());
                    continue;
                }
                // Two exits for one game. Refused at the wire; refused
                // again here, because this constructor has other
                // callers.
                if exits.iter().skip(i + 1).any(|other| {
                    other.group.as_deref() == Some(group) && other.exit != exit.exit
                }) {
                    broken.push(group.to_string());
                }
            }
            // No more than `MAX_CONCURRENT_EXITS` distinct exits, and if
            // there are more then **none** of them is honoured.
            //
            // Dropped whole rather than trimmed, for the reason every
            // other rule in this constructor drops whole: trimming
            // means choosing which games keep their exit, and the only
            // basis available is the order the entries happen to arrive
            // in -- which is the order a customer added games in, a
            // thing they were never told was load-bearing. The app
            // would then report `OnPreferred` for games picked by list
            // position, which is a placement nobody decided being
            // reported as one somebody did.
            //
            // Failing toward *no preference* carries every game on the
            // session's own exit, exactly as every application was
            // carried before any of this existed. Never toward a split.
            //
            // `SplitTunnelConfig::validate` refuses such a config
            // outright, so nothing arriving through the pipe reaches
            // here. This constructor is also called directly, and a
            // rule this expensive to get wrong should not depend on
            // which one was used -- the same argument the group rule
            // above makes.
            let mut distinct: Vec<&str> = Vec::new();
            for exit in &exits {
                if !paths.contains(&exit.app.to_lowercase()) {
                    continue;
                }
                if exit.group.as_deref().is_some_and(|g| broken.iter().any(|b| b == g)) {
                    continue;
                }
                if !distinct.iter().any(|e| *e == exit.exit) {
                    distinct.push(&exit.exit);
                }
            }
            let over_ceiling = distinct.len() > neoconnect_ipc::MAX_CONCURRENT_EXITS;

            for exit in exits {
                if over_ceiling {
                    break;
                }
                let app = exit.app.to_lowercase();
                if !paths.contains(&app) {
                    continue;
                }
                if exit.group.as_deref().is_some_and(|g| broken.iter().any(|b| b == g)) {
                    continue;
                }
                chosen.insert(app, exit.exit);
            }
        }
        Self { paths, mode, scopes: built, exits: chosen }
    }

    pub fn mode(&self) -> SplitTunnelMode {
        self.mode
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// The customer's list, as WFP will need it.
    ///
    /// Lower-cased on the way in by [`Selection::new`], which is what
    /// `matches` compares against and what
    /// `FwpmGetAppIdFromFileName0` is handed. The two therefore agree
    /// about which file is meant by construction rather than by
    /// coincidence -- both identify an application by its full path,
    /// so a byte-for-byte copy of a selected binary somewhere else is
    /// a different application to both of them.
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    /// Whether an executable path is one the customer selected.
    ///
    /// Asked on every packet, so it must not allocate -- and it did: the
    /// type's own doc promised "a plain comparison" while this lowercased
    /// the whole path into a fresh `String` each time. See
    /// [`same_ascii_path`] for how the comparison is now made without one.
    pub fn matches(&self, image_path: &str) -> bool {
        if image_path.is_ascii() {
            return self.paths.iter().any(|p| same_ascii_path(p, image_path));
        }
        let lowered = image_path.to_lowercase();
        self.paths.iter().any(|p| *p == lowered)
    }

    /// Whether this application's traffic belongs in the tunnel.
    ///
    /// The direction is applied here rather than to the tunnel's shape,
    /// and that is deliberate. Building a *full* tunnel and pushing the
    /// chosen applications out of it is the obvious reading of
    /// "everything except these", and it does not work: a packet
    /// captured on the tunnel adapter and re-injected towards this
    /// machine is sent down the tunnel instead of to the proxy, and
    /// arrives nowhere. Measured, four retransmits, no reply and no
    /// drop:
    ///
    /// ```text
    /// ip: 10.77.0.3.40001 > 192.168.88.10.64129: Flags [S]
    /// ```
    ///
    /// Keeping the tunnel passive in both directions and inverting the
    /// *match* instead means every packet that is carried takes the one
    /// path already known to work. What the customer asked for is the
    /// same either way: with `AllExcept` everything is lifted into the
    /// tunnel except the applications they named, which are simply
    /// never redirected and so keep the ordinary connection.
    pub fn should_tunnel(&self, image_path: &str) -> bool {
        match self.mode {
            SplitTunnelMode::OnlySelected => self.matches(image_path),
            SplitTunnelMode::AllExcept => !self.matches(image_path),
        }
    }

    /// Whether any application is narrowed at all.
    ///
    /// The whole cost of this feature for a customer who is not using
    /// it: one `is_empty` on a map, per packet, in front of everything
    /// else. Worth having as its own answer because that is the
    /// overwhelmingly common case -- no shipped catalogue profile is
    /// prefix-complete today, so this is false on every machine until
    /// one is.
    pub fn has_scopes(&self) -> bool {
        !self.scopes.is_empty()
    }

    /// Where this application's traffic is carried to, if anywhere in
    /// particular.
    ///
    /// # The second axis, and how it meets the first
    ///
    /// [`Self::should_tunnel`] answers "is this application's traffic
    /// ours". This answers "and is *this packet* of it". They are asked
    /// in that order and this one can only ever narrow: an application
    /// the customer did not select is never carried because of a scope,
    /// and a scope is never consulted for one.
    ///
    /// It must not be confused with the unattributed case, and the
    /// signatures keep them apart. This takes an `image_path`, so it
    /// can only be asked about a packet whose owner is *known*. A
    /// packet with no owner has no application and therefore no scope;
    /// it goes to [`Self::verdict_for_unattributed`] and comes back
    /// with the same answer it did before this existed. The two are
    /// genuinely different facts -- "a selected app sent this somewhere
    /// we do not carry" is ordinary traffic that must keep working,
    /// while "nobody can be shown to have sent this" is the leak that
    /// arm was written to close -- and collapsing them would either
    /// re-open that leak or start dropping a game's telemetry.
    ///
    /// # Which way it fails
    ///
    /// Open, in the sense that matters: every uncertainty returns
    /// [`Scoped::Unscoped`], which means "behave exactly as this
    /// feature did before scopes existed". Missing list, unparseable
    /// list, list too long, a family the list says nothing about --
    /// all of them carry the application's traffic as today rather
    /// than dropping it. A game that keeps working unprotected beats a
    /// game that stops.
    ///
    /// Note that "as today" is per family and is not always "carry":
    /// for IPv6 a selected application is *blocked*, so that it retries
    /// over IPv4 and is carried there. `Unscoped` restores whichever of
    /// those the caller was already doing, which is why this returns
    /// three answers rather than a bool.
    pub fn destination_scope(&self, image_path: &str, destination: IpAddr) -> Scoped {
        // Before the lowercase, so the ordinary machine allocates
        // nothing here.
        if self.scopes.is_empty() {
            return Scoped::Unscoped;
        }
        // A walk rather than a hash lookup for the same reason `matches`
        // is: the key would have to be lowercased into a new `String`
        // first, per packet. Scopes are a handful of games at most.
        let found = if image_path.is_ascii() {
            self.scopes.iter().find(|(p, _)| same_ascii_path(p, image_path)).map(|(_, s)| s)
        } else {
            self.scopes.get(&image_path.to_lowercase())
        };
        let Some(scope) = found else {
            return Scoped::Unscoped;
        };
        match scope.contains(destination) {
            Some(true) => Scoped::InScope,
            Some(false) => Scoped::OutOfScope,
            None => Scoped::Unscoped,
        }
    }

    /// Whether any application has been given an exit at all.
    ///
    /// The cheap answer, for a caller that would otherwise walk the
    /// selection to find out that nobody chose anything.
    pub fn has_exits(&self) -> bool {
        !self.exits.is_empty()
    }

    /// The exit this application's traffic was asked to leave from.
    ///
    /// # The third axis, and why it does not meet the other two
    ///
    /// [`Self::should_tunnel`] answers "is this application's traffic
    /// ours". [`Self::destination_scope`] answers "and is *this packet*
    /// of it". Both of those decide **whether** a packet is carried,
    /// and both are asked on the packet path.
    ///
    /// This answers something else entirely: **where** a flow that is
    /// already being carried leaves from. It cannot narrow, it cannot
    /// widen, and it cannot turn a carried packet into an uncarried one
    /// or the reverse. Today one session has exactly one egress, so
    /// there is nothing for it to select between and the packet path
    /// does not call it at all -- `decide` is unchanged by this
    /// feature, which is the reason neither leak fix can regress
    /// through it.
    ///
    /// # Why the signature takes an image path
    ///
    /// The same reason [`Self::destination_scope`] does, and it is the
    /// load-bearing half of the safety argument rather than a
    /// convenience. A preference belongs to an application. A packet
    /// nobody can be shown to have sent has no application, so it can
    /// never acquire one of these -- it goes to
    /// [`Self::verdict_for_unattributed`] and comes back with the
    /// answer it came back with before this existed.
    ///
    /// That matters for the version of this feature that carries two
    /// exits at once. There, the temptation is to give an unattributed
    /// packet a default exit and send it somewhere -- and *deciding
    /// where to send it* would first require deciding to carry it,
    /// which is precisely the fire-and-forget UDP leak that
    /// `verdict_for_unattributed` exists to refuse. Exit selection has
    /// to sit strictly downstream of the carry decision. This
    /// signature is what makes taking it upstream require a
    /// deliberate change rather than an oversight.
    pub fn preferred_exit(&self, image_path: &str) -> Option<&str> {
        if self.exits.is_empty() {
            return None;
        }
        self.exits.get(&image_path.to_lowercase()).map(String::as_str)
    }

    /// Where one application's traffic is leaving from, against where
    /// the customer asked for it to leave from.
    ///
    /// `egress` is what the client said the live tunnel leaves from, or
    /// `None` when nothing is intercepting or the client did not say.
    /// `None` is answered as [`ExitPlacement::Unknown`] and never as a
    /// match: this product does not report a placement it has not
    /// established, for the same reason it does not report a tunnel
    /// state it has not verified.
    /// `is_live` answers whether an exit currently has a relay carrying
    /// traffic. It exists because comparing against `egress` alone stopped
    /// being sufficient the moment one session could hold several exits at
    /// once: the session's egress is one node, and an application routed
    /// through a concurrent relay to a different node is on its preferred
    /// exit anyway. Without this the function reported `Fallback` for
    /// exactly the applications the feature works for -- observed on a rig
    /// with two exit IPs live at once, copy A demonstrably egressing at
    /// france-1 while this said `{"placement":"fallback"}`.
    ///
    /// The routing was right and only the sentence was wrong, which is the
    /// safer way round -- but this product does not report a state it has
    /// not established, and that cuts both ways.
    pub fn placement(
        &self,
        image_path: &str,
        egress: Option<&str>,
        is_live: &dyn Fn(&str) -> bool,
    ) -> ExitPlacement {
        let Some(preferred) = self.preferred_exit(image_path) else {
            return ExitPlacement::NoPreference;
        };
        // Checked before `egress`, not after: a live relay to the preferred
        // exit is a stronger statement than which node the session as a
        // whole leaves from, and it is the case the session egress cannot
        // see.
        if is_live(preferred) {
            return ExitPlacement::OnPreferred;
        }
        match egress {
            None => ExitPlacement::Unknown { preferred: preferred.to_string() },
            Some(live) if live == preferred => ExitPlacement::OnPreferred,
            Some(_) => ExitPlacement::Fallback { preferred: preferred.to_string() },
        }
    }

    /// The whole selection's placements, one entry per selected
    /// application.
    ///
    /// Includes the applications with no preference, so the caller
    /// renders a complete list from this alone rather than filling
    /// gaps from what it remembers asking for -- which is the
    /// difference between reporting where traffic is and reporting
    /// what was requested.
    ///
    /// Empty under `AllExcept`, and that is honest rather than a
    /// shortcut: the listed applications there are the ones *not*
    /// carried, so none of them has an egress to report.
    pub fn placements(&self, egress: Option<&str>, is_live: &dyn Fn(&str) -> bool) -> Vec<AppPlacement> {
        if !matches!(self.mode, SplitTunnelMode::OnlySelected) {
            return Vec::new();
        }
        self.paths
            .iter()
            .map(|app| AppPlacement {
                app: app.clone(),
                placement: self.placement(app, egress, is_live),
            })
            .collect()
    }

    /// What to do with traffic whose owning program cannot be seen.
    ///
    /// Opposite answers for opposite directions, and both are the safe
    /// one. Tunnelling only named applications means an unknown owner is
    /// left alone, because redirecting traffic whose origin is unknown
    /// is how a split tunnel becomes a full one. Tunnelling everything
    /// *except* named applications means an unknown owner is carried,
    /// because leaving it out is how it becomes a leak.
    ///
    /// **This is no longer the whole answer for a datagram**, and
    /// callers deciding about one must use
    /// [`Self::verdict_for_unattributed`] instead. It survives because
    /// two callers really do only need the boolean: the IPv6 packet
    /// whose ports could not be read at all, which has no transport to
    /// key a finer rule on, and this function's own place inside that
    /// finer rule.
    pub fn tunnel_when_owner_unknown(&self) -> bool {
        matches!(self.mode, SplitTunnelMode::AllExcept)
    }

    /// What to do with a packet nobody can be shown to have sent.
    ///
    /// # Why "leave it alone" was not safe enough
    ///
    /// [`Self::tunnel_when_owner_unknown`] answers this in `AllExcept`
    /// and gets it right: carry it, because leaving it out is the leak.
    /// In `OnlySelected` it answers "leave it alone", on the reasoning
    /// that redirecting traffic of unknown origin turns a split tunnel
    /// into a full one. That reasoning is sound and the outcome was
    /// still a leak, because of one shape it did not account for.
    ///
    /// A UDP socket that is closed microseconds after its send is
    /// already out of the Windows UDP endpoint table by the time the
    /// redirect loop is handed the datagram. There is no row naming the
    /// owner and no rebuild can produce one -- the fact is gone, not
    /// late. So a *selected* application's datagram arrives with no
    /// owner, is answered "leave it alone", and egresses in clear text
    /// carrying the customer's real address while the app says Custom
    /// mode is on.
    ///
    /// Measured on the rig, twice: a selected program sending 15
    /// datagrams from 15 sockets, each closed microseconds after the
    /// send, put 13 and 14 of them respectively on the wire
    /// unredirected. Reproducible, and not a race retrying wins.
    ///
    /// # Why refusing, and not carrying
    ///
    /// Carrying it would send a non-selected application's traffic out
    /// of the node -- the customer asked for the opposite, and for
    /// someone whose account is judged by the address it connects from,
    /// silently moving their traffic onto a VPN address is its own kind
    /// of harm. Refusing is the same answer this feature already gives
    /// IPv6 and already gives a lookup it cannot carry: a stated gap in
    /// place of a silent leak. A one-shot datagram that does not arrive
    /// is visible, complainable-about and recoverable. Being logged by
    /// an ISP in Iran is none of those.
    ///
    /// # Why this does not take the customer's internet down
    ///
    /// The refusal is deliberately the narrowest thing that closes the
    /// hole, and every clause below is a clause that keeps ordinary
    /// traffic working:
    ///
    /// * **`AllExcept` is untouched.** It carries an unknown owner, has
    ///   no leak of this shape, and nothing here changes it.
    /// * **TCP is untouched.** A TCP socket cannot be gone before its
    ///   SYN is classified -- it has to stay open to receive the
    ///   handshake -- so this shape is UDP-only, and TCP keeps failing
    ///   open exactly as before.
    /// * **Only destinations that are the internet.** Loopback, RFC1918,
    ///   link-local, multicast and broadcast are the local network. A
    ///   datagram to one of them is not a privacy leak, and refusing it
    ///   would break mDNS, LLMNR, SSDP, WS-Discovery and DHCP -- one-shot
    ///   senders every one of them, which is precisely the shape that
    ///   would be caught.
    /// * **Only an owner that could not be found at all.** A live socket
    ///   is in the table from the moment it is created, so anything
    ///   still holding its socket -- which is every QUIC client, every
    ///   game, every long-running connection -- is attributed and
    ///   decided on its merits. Chrome went from 219 plaintext UDP/443
    ///   datagrams to 0 under the existing code precisely because a real
    ///   QUIC client holds its socket open; none of that reaches here.
    ///
    /// What is left, and it is the honest cost of this change, is a
    /// non-selected application's *one-shot* UDP to the internet, which
    /// is refused while Custom mode is on. That is a real behavioural
    /// change and it is deliberate: the alternative is that the same
    /// datagram from a selected application leaves in the clear, and
    /// this loop cannot tell the two apart. The feature fails open
    /// everywhere else; here it fails closed, because failing open here
    /// is the leak itself.
    ///
    /// Callers pass the destination rather than having it reached for,
    /// so the rule can be tested without a packet and so the WinDivert
    /// filter -- which excludes the same addresses in the kernel -- and
    /// this cannot drift apart into disagreeing about one destination.
    pub fn verdict_for_unattributed(
        &self,
        transport: Transport,
        destination: IpAddr,
    ) -> Unattributed {
        if self.tunnel_when_owner_unknown() {
            return Unattributed::Carry;
        }
        let is_internet = match destination {
            IpAddr::V4(addr) => is_public_v4(addr),
            IpAddr::V6(addr) => is_public_v6(addr),
        };
        if matches!(transport, Transport::Udp) && is_internet {
            Unattributed::Refuse
        } else {
            Unattributed::LeaveAlone
        }
    }
}

/// What to do with a packet whose owning program cannot be seen.
///
/// Three answers rather than the boolean this used to be, because the
/// two the boolean could express were both wrong for one case -- see
/// [`Selection::verdict_for_unattributed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unattributed {
    /// Put it in the tunnel. `AllExcept`, where an unknown owner is one
    /// of the many rather than one of the few.
    Carry,
    /// Send it out untouched, as before.
    LeaveAlone,
    /// Swallow it. The only answer that is neither of the two the
    /// redirect loop can otherwise give, and the one that closes the
    /// fire-and-forget leak.
    Refuse,
}

/// Where a known application's packet falls against that application's
/// destination scope.
///
/// Deliberately not a `bool`. The third answer is the one that keeps
/// this safe: "this scope has nothing to say about that address" is a
/// different fact from "that address is not in it", and turning the
/// first into the second is how a v4-only prefix list would push a
/// game's IPv6 out of the tunnel while its IPv4 stayed in -- the two
/// source addresses, one account problem that `prefixComplete` exists
/// to prevent, arriving by the other family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scoped {
    /// No usable scope for this application on this address family.
    /// Whatever the caller was already doing is right; nothing here
    /// changes it.
    Unscoped,
    /// A destination this application's traffic is carried to.
    InScope,
    /// A destination it is not. Treated exactly as an unselected
    /// application's traffic would be -- passed through untouched --
    /// and **not** as a refusal. This is a game talking to its own
    /// telemetry or store, which must keep working.
    OutOfScope,
}

/// No exit relay is carrying anything -- the world the placement tests
/// were written in, before one session could hold several exits at once.
/// Placement then falls through to the session-egress comparison.
///
/// At file scope because this file has two separate `#[cfg(test)]`
/// modules and the call sites are in the second one. A plain fn rather
/// than a `const &dyn Fn`, because a closure is not a constant.
#[cfg(test)]
fn no_live(_exit: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope_of(app: &str, destinations: &[&str]) -> neoconnect_ipc::AppScope {
        neoconnect_ipc::AppScope {
            app: app.to_string(),
            destinations: destinations.iter().map(|d| d.to_string()).collect(),
        }
    }

    const GAME: &str = r"C:\Games\game.exe";

    #[test]
    fn a_selection_only_keeps_scopes_it_can_act_on() {
        // Four ways a scope fails to apply, all landing on the same
        // safe answer -- the app is carried in full -- so that no
        // caller has to remember which is which.
        let apps = || [GAME.to_string(), r"C:\Chat\chat.exe".to_string()];

        // Naming an app that was not selected.
        let stray = Selection::with_scopes(
            apps(),
            SplitTunnelMode::OnlySelected,
            [scope_of(r"C:\Other\other.exe", &["203.0.113.0/24"])],
        );
        assert!(!stray.has_scopes());

        // A list that will not fully parse.
        let broken = Selection::with_scopes(
            apps(),
            SplitTunnelMode::OnlySelected,
            [scope_of(GAME, &["203.0.113.0/24", "garbage"])],
        );
        assert!(!broken.has_scopes());
        assert_eq!(
            broken.destination_scope(GAME, "198.51.100.1".parse().unwrap()),
            Scoped::Unscoped,
            "an unparseable list must carry the app in full, not narrow it to what parsed"
        );

        // An empty list.
        let empty = Selection::with_scopes(
            apps(),
            SplitTunnelMode::OnlySelected,
            [scope_of(GAME, &[])],
        );
        assert!(!empty.has_scopes());

        // The other direction, where a scope has no meaning: the named
        // apps are the ones *not* carried, so there is nothing to
        // narrow and any reading of it would be an invention.
        let except = Selection::with_scopes(
            apps(),
            SplitTunnelMode::AllExcept,
            [scope_of(GAME, &["203.0.113.0/24"])],
        );
        assert!(!except.has_scopes());

        // And the one that does apply, so the four above are proven to
        // be rejections rather than this never working at all.
        let good = Selection::with_scopes(
            apps(),
            SplitTunnelMode::OnlySelected,
            [scope_of(GAME, &["203.0.113.0/24"])],
        );
        assert!(good.has_scopes());
        assert_eq!(
            good.destination_scope(GAME, "203.0.113.7".parse().unwrap()),
            Scoped::InScope
        );
        assert_eq!(
            good.destination_scope(GAME, "198.51.100.7".parse().unwrap()),
            Scoped::OutOfScope
        );
        // A different selected app, with no scope of its own, is
        // untouched by another app's.
        assert_eq!(
            good.destination_scope(r"C:\Chat\chat.exe", "198.51.100.7".parse().unwrap()),
            Scoped::Unscoped
        );
    }

    #[test]
    fn a_scope_is_matched_case_insensitively_like_every_other_path() {
        // Windows paths are case-insensitive and the picker's spelling
        // does not always match what a process reports. A scope that
        // silently stopped applying because of a capital letter would
        // present as the game being carried in full -- which is safe,
        // but is also indistinguishable from the feature not working.
        let selection = Selection::with_scopes(
            [GAME.to_string()],
            SplitTunnelMode::OnlySelected,
            [scope_of(r"c:\games\GAME.exe", &["203.0.113.0/24"])],
        );
        assert!(selection.has_scopes());
        assert_eq!(
            selection.destination_scope(r"C:\GAMES\Game.EXE", "203.0.113.7".parse().unwrap()),
            Scoped::InScope
        );
    }

    /// Matching no longer lowercases the path into a new string per
    /// packet, and the cheaper comparison must give exactly the answer
    /// the old one did -- a disagreement changes which applications are
    /// carried. So the old rule is written out here as the oracle and
    /// every case is asked of both.
    ///
    /// The non-ASCII rows are the ones that matter most: a customer's
    /// user folder is named in their own script, and those paths still
    /// take the allocating route on purpose.
    #[test]
    fn matching_without_allocating_agrees_with_lowercasing_first() {
        let selected = [
            r"C:\Games\Game.exe",
            r"C:\Users\ÄLI\AppData\Local\Game\game.exe",
            r"C:\Users\علی\Desktop\launcher.exe",
        ];
        let selection = Selection::new(selected.iter().map(|s| s.to_string()), SplitTunnelMode::OnlySelected);
        let oracle = |image: &str| selected.iter().any(|s| s.to_lowercase() == image.to_lowercase());

        for image in [
            r"C:\Games\Game.exe",
            r"c:\games\game.exe",
            r"C:\GAMES\GAME.EXE",
            r"C:\Games\Game.exe2",
            r"C:\Games\Game.ex",
            r"C:\Games\Gamf.exe",
            r"D:\Games\Game.exe",
            r"C:\Users\ÄLI\AppData\Local\Game\game.exe",
            r"c:\users\äli\appdata\local\game\GAME.EXE",
            r"c:\users\ali\appdata\local\game\game.exe",
            r"C:\Users\علی\Desktop\LAUNCHER.exe",
            r"C:\Users\علی\Desktop\launcher.exe.bak",
            "",
        ] {
            assert_eq!(selection.matches(image), oracle(image), "{image}");
        }

        let scoped = Selection::with_scopes(
            [r"C:\Users\ÄLI\Game\game.exe".to_string()],
            SplitTunnelMode::OnlySelected,
            [scope_of(r"c:\users\äli\game\GAME.exe", &["203.0.113.0/24"])],
        );
        let inside: IpAddr = "203.0.113.7".parse().unwrap();
        assert_eq!(scoped.destination_scope(r"C:\USERS\ÄLI\GAME\game.exe", inside), Scoped::InScope);
        assert_eq!(scoped.destination_scope(r"C:\Users\ALI\Game\game.exe", inside), Scoped::Unscoped);
    }

    /// The rule, spelled out as a table, because every cell of it is a
    /// decision somebody could reasonably make differently and three of
    /// them are the difference between a leak and an outage.
    ///
    /// `Refuse` appears exactly once: `OnlySelected`, UDP, a destination
    /// on the internet. That single cell is the fire-and-forget leak.
    /// Every other cell keeps the behaviour that shipped, and the test
    /// asserts them by name rather than trusting the one that changed to
    /// have stayed in its lane.
    #[test]
    fn only_a_datagram_to_the_internet_with_no_owner_is_refused() {
        let internet = IpAddr::V4("203.0.113.9".parse().unwrap());
        let only = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::OnlySelected);
        let except = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::AllExcept);

        assert_eq!(
            only.verdict_for_unattributed(Transport::Udp, internet),
            Unattributed::Refuse,
            "the measured leak: a datagram nobody owns, going to the internet, in the \
             mode where an unknown owner used to mean leave it alone"
        );
        assert_eq!(
            only.verdict_for_unattributed(Transport::Tcp, internet),
            Unattributed::LeaveAlone,
            "TCP keeps failing open -- a TCP socket cannot be gone before its SYN is \
             classified, so this shape does not arise there"
        );
        assert_eq!(
            except.verdict_for_unattributed(Transport::Udp, internet),
            Unattributed::Carry,
            "everything-except carries an unknown owner; leaving it out is the leak there"
        );
        assert_eq!(
            except.verdict_for_unattributed(Transport::Tcp, internet),
            Unattributed::Carry,
        );
    }

    /// The clauses that keep a customer's machine on its own network.
    ///
    /// Refusing these would not close any leak -- a datagram that never
    /// leaves the local network cannot tell an ISP anything -- and it
    /// would break mDNS, LLMNR, SSDP, WS-Discovery and DHCP, every one
    /// of which is a one-shot sender and therefore exactly the shape
    /// that would be caught. "Blocked too broadly" here means the
    /// customer's printer and their television stop being found, which
    /// is a far worse day than the leak.
    ///
    /// The list is the same one `is_public_v4`/`is_public_v6` answer and
    /// the same one the WinDivert filter excludes in the kernel, which
    /// is why the destination is passed in rather than reached for: the
    /// three cannot drift into disagreeing about one address.
    #[test]
    fn the_local_network_is_never_refused() {
        let only = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::OnlySelected);
        for local in [
            "127.0.0.1",     // loopback
            "10.1.2.3",      // RFC1918
            "172.16.0.5",    // RFC1918
            "192.168.1.1",   // RFC1918, and the router
            "169.254.10.1",  // link-local
            "224.0.0.251",   // mDNS
            "239.255.255.250", // SSDP
            "255.255.255.255", // broadcast, and DHCP
        ] {
            let address = IpAddr::V4(local.parse().unwrap());
            assert_eq!(
                only.verdict_for_unattributed(Transport::Udp, address),
                Unattributed::LeaveAlone,
                "{local} is the local network, not the internet"
            );
        }

        for local in ["::1", "fe80::1", "fd00::1", "ff02::fb"] {
            let address = IpAddr::V6(local.parse().unwrap());
            assert_eq!(
                only.verdict_for_unattributed(Transport::Udp, address),
                Unattributed::LeaveAlone,
                "{local} is the local network, not the internet"
            );
        }

        assert_eq!(
            only.verdict_for_unattributed(
                Transport::Udp,
                IpAddr::V6("2001:db8:6ec5::1".parse().unwrap())
            ),
            Unattributed::Refuse,
            "a global v6 address is the internet and leaks the same way v4 does"
        );
    }

    #[test]
    fn selection_matching_ignores_case() {
        // Windows paths are case-insensitive, and the path the customer
        // picked through a file dialog will not always be cased the same
        // way as the one the process reports.
        let selection = Selection::new([r"C:\Games\Valorant\VALORANT.exe".to_string()], SplitTunnelMode::OnlySelected);
        assert!(selection.matches(r"c:\games\valorant\valorant.exe"));
        assert!(selection.matches(r"C:\GAMES\VALORANT\VALORANT.EXE"));
        assert!(!selection.matches(r"C:\Games\Other\VALORANT.exe"));
    }

    #[test]
    fn an_empty_selection_matches_nothing() {
        // The state Custom mode starts in. Matching everything here
        // would tunnel the whole machine the moment the toggle went on
        // with no apps chosen -- the opposite of what it promises.
        let selection = Selection::default();
        assert!(selection.is_empty());
        assert!(!selection.matches(r"C:\Windows\explorer.exe"));
    }

    /// What "pure" means here, written down where it can fail.
    ///
    /// `policy` is the one part of Custom mode meant to be readable and
    /// testable without Windows: a table of rules, asked on every packet.
    /// The moment it reaches for an API, a socket or another part of the
    /// subsystem it stops being that, and nothing at compile time would
    /// say so -- this crate only builds on Windows, so a platform call in
    /// here compiles as happily as anywhere else. So the sources are read
    /// and the line is held by a test instead.
    #[test]
    fn the_policy_names_nothing_outside_itself() {
        for (file, source) in [
            ("policy/mod.rs", include_str!("mod.rs")),
            ("policy/scope.rs", include_str!("scope.rs")),
            ("policy/internet.rs", include_str!("internet.rs")),
        ] {
            for forbidden in ["windows", "winsock", "windivert", "socket2", "TcpStream", "UdpSocket", "TcpListener", "crate::", "super::super", "std::thread", "std::time", "std::fs", "std::process", "unsafe"] {
                let found = source
                    .lines()
                    .filter(|line| !line.trim_start().starts_with("//"))
                    .filter(|line| !line.contains("forbidden in ["))
                    .any(|line| line.contains(forbidden));
                assert!(!found, "{file} uses {forbidden}, and policy must stay pure");
            }
        }
    }
}

#[cfg(test)]
mod exit_tests {
    use super::*;
    use std::net::Ipv4Addr;

    const GAME: &str = r"C:\Games\game.exe";
    const OTHER: &str = r"C:\Games\other.exe";

    fn exit_of(app: &str, exit: &str) -> neoconnect_ipc::AppExit {
        neoconnect_ipc::AppExit { app: app.to_string(), exit: exit.to_string(), group: None }
    }

    fn grouped(app: &str, exit: &str, group: &str) -> neoconnect_ipc::AppExit {
        neoconnect_ipc::AppExit {
            app: app.to_string(),
            exit: exit.to_string(),
            group: Some(group.to_string()),
        }
    }

    fn with_groups(apps: &[&str], exits: Vec<neoconnect_ipc::AppExit>) -> Selection {
        Selection::with_exits(
            apps.iter().map(|a| (*a).to_string()),
            SplitTunnelMode::OnlySelected,
            Vec::new(),
            exits,
        )
    }

    fn preferring(apps: &[&str], exits: &[(&str, &str)], mode: SplitTunnelMode) -> Selection {
        Selection::with_exits(
            apps.iter().map(|a| (*a).to_string()),
            mode,
            Vec::new(),
            exits.iter().map(|(app, exit)| exit_of(app, exit)).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn a_game_on_its_preferred_exit_is_reported_as_such() {
        let selection = preferring(
            &[GAME],
            &[(GAME, "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(
            selection.placement(GAME, Some("germany-1"), &no_live),
            ExitPlacement::OnPreferred
        );
    }

    /// The defect this parameter exists for, recorded on
    /// `rig/cme-v2-verify`: with two exits live at once, copy A was
    /// demonstrably egressing at france-1 and the service answered
    /// `{"placement":"fallback","preferred":"france-1"}` -- which reads
    /// to a customer as "we could not put you on your exit".
    ///
    /// The session's egress is germany-1 here and always will be; that is
    /// what a session egress *is* once concurrent exits exist. What
    /// settles it is that france-1 has a relay carrying traffic.
    #[test]
    fn a_game_on_a_live_concurrent_exit_is_on_its_preferred_exit() {
        let selection = preferring(
            &[GAME],
            &[(GAME, "france-1")],
            SplitTunnelMode::OnlySelected,
        );
        let france_is_live: &dyn Fn(&str) -> bool = &|exit: &str| exit == "france-1";

        assert_eq!(
            selection.placement(GAME, Some("germany-1"), france_is_live),
            ExitPlacement::OnPreferred
        );
        // And the old answer, to show the parameter is what changed it
        // rather than something else moving underneath.
        assert_eq!(
            selection.placement(GAME, Some("germany-1"), &no_live),
            ExitPlacement::Fallback { preferred: "france-1".to_string() }
        );
    }

    /// A relay for some *other* exit must not launder this one. Only the
    /// application's own preferred exit being live counts.
    #[test]
    fn a_live_relay_for_a_different_exit_is_still_a_fallback() {
        let selection = preferring(
            &[GAME],
            &[(GAME, "france-1")],
            SplitTunnelMode::OnlySelected,
        );
        let elsewhere: &dyn Fn(&str) -> bool = &|exit: &str| exit == "singapore-1";

        assert_eq!(
            selection.placement(GAME, Some("germany-1"), elsewhere),
            ExitPlacement::Fallback { preferred: "france-1".to_string() }
        );
    }

    /// A live relay is a stronger statement than an absent egress, so it
    /// resolves the case that would otherwise be Unknown.
    #[test]
    fn a_live_relay_answers_even_without_a_session_egress() {
        let selection = preferring(
            &[GAME],
            &[(GAME, "france-1")],
            SplitTunnelMode::OnlySelected,
        );
        let france_is_live: &dyn Fn(&str) -> bool = &|exit: &str| exit == "france-1";

        assert_eq!(selection.placement(GAME, None, france_is_live), ExitPlacement::OnPreferred);
        assert_eq!(
            selection.placement(GAME, None, &no_live),
            ExitPlacement::Unknown { preferred: "france-1".to_string() }
        );
    }

    #[test]
    fn a_game_with_no_preference_takes_the_session_exit() {
        // The overwhelmingly common case, and the one that must not
        // acquire an opinion: an application nobody chose an exit for
        // is on whatever the session is on, and says so.
        let selection = preferring(
            &[GAME, OTHER],
            &[(GAME, "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(
            selection.placement(OTHER, Some("germany-1"), &no_live),
            ExitPlacement::NoPreference
        );
        assert_eq!(
            selection.placement(OTHER, Some("finland-1"), &no_live),
            ExitPlacement::NoPreference,
            "an app with no preference cannot be on the wrong exit"
        );
    }

    #[test]
    fn an_unavailable_preferred_exit_falls_back_and_names_what_was_asked_for() {
        // Fail open on the new axis. The application is carried; the
        // report says where the customer wanted it, so the app can
        // offer to reconnect there rather than silently doing nothing
        // or silently dropping the game.
        let selection = preferring(
            &[GAME],
            &[(GAME, "turkey-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(
            selection.placement(GAME, Some("germany-1"), &no_live),
            ExitPlacement::Fallback { preferred: "turkey-1".to_string() }
        );
        // And the carry decision is untouched by any of it.
        assert!(
            selection.should_tunnel(GAME),
            "a preference that cannot be honoured must not stop the app being carried"
        );
    }

    #[test]
    fn an_unknown_egress_is_never_reported_as_a_match() {
        // The honesty clause. With nothing to compare against, the
        // answer is `Unknown` -- not `OnPreferred`, which would claim a
        // match nobody established, and not `Fallback`, which would
        // claim a mismatch nobody established.
        let selection = preferring(
            &[GAME],
            &[(GAME, "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(
            selection.placement(GAME, None, &no_live),
            ExitPlacement::Unknown { preferred: "germany-1".to_string() }
        );
    }

    #[test]
    fn a_preference_for_an_app_that_was_not_selected_is_dropped() {
        let selection = preferring(
            &[GAME],
            &[(OTHER, "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert!(!selection.has_exits());
        assert_eq!(selection.preferred_exit(OTHER), None);
        assert_eq!(
            selection.placement(OTHER, Some("finland-1"), &no_live),
            ExitPlacement::NoPreference
        );
    }

    // ---- exit groups: a game's binaries go together or nowhere ------
    //
    // `docs/design/ban-safety.md` mechanism 4. Rust's launch target is
    // `Rust.exe`, the EAC wrapper; the game is `RustClient.exe`. One
    // account's connections arriving from two source addresses at the
    // same instant is the account-sharing signature publishers look
    // for, and it is the one mechanism in that document Neoxify could
    // manufacture rather than merely fail to prevent.

    const RUST_WRAPPER: &str = r"C:\Rust\Rust.exe";
    const RUST_CLIENT: &str = r"C:\Rust\RustClient.exe";
    const SOT: &str = r"C:\SoT\SoTGame.exe";

    #[test]
    fn a_whole_group_lands_on_one_exit() {
        let selection = with_groups(
            &[RUST_WRAPPER, RUST_CLIENT],
            vec![
                grouped(RUST_WRAPPER, "germany-1", "rust"),
                grouped(RUST_CLIENT, "germany-1", "rust"),
            ],
        );
        assert_eq!(selection.preferred_exit(RUST_WRAPPER), Some("germany-1"));
        assert_eq!(selection.preferred_exit(RUST_CLIENT), Some("germany-1"));
        // And both report the same placement, which is the customer-
        // visible form of the same fact.
        for app in [RUST_WRAPPER, RUST_CLIENT] {
            assert_eq!(selection.placement(app, Some("germany-1"), &no_live), ExitPlacement::OnPreferred);
        }
    }

    /// The hard case, and the one that must not be answered with "place
    /// the ones you found and hope".
    ///
    /// A launcher is running while the game is not -- which is the
    /// ordinary state of a machine at the moment somebody adds a game,
    /// since names are resolved against *running* processes. The
    /// unselected binary is not carried at all, so when it starts it
    /// leaves from the customer's own address while its sibling leaves
    /// from the exit. The honest outcome is no per-game exit for that
    /// game: it is carried on the session's exit like everything else,
    /// which is safe.
    #[test]
    fn a_partly_selected_group_gets_no_preference_at_all() {
        let selection = with_groups(
            // Only the wrapper is selected. The client sent both,
            // because the group is what the catalogue says it is.
            &[RUST_WRAPPER],
            vec![
                grouped(RUST_WRAPPER, "germany-1", "rust"),
                grouped(RUST_CLIENT, "germany-1", "rust"),
            ],
        );
        assert_eq!(
            selection.preferred_exit(RUST_WRAPPER),
            None,
            "placing the half of a game that happens to be running is the split"
        );
        assert!(!selection.has_exits());
        assert_eq!(
            selection.placement(RUST_WRAPPER, Some("finland-1"), &no_live),
            ExitPlacement::NoPreference
        );
        // Fail toward the safe behaviour, never toward dropping
        // traffic: the game is still carried.
        assert!(selection.should_tunnel(RUST_WRAPPER));
    }

    /// One incomplete group must not cost a different game its
    /// preference. All-or-nothing is per game, not per config.
    #[test]
    fn a_partly_selected_group_does_not_disturb_a_whole_one() {
        let selection = with_groups(
            &[RUST_WRAPPER, SOT],
            vec![
                grouped(RUST_WRAPPER, "germany-1", "rust"),
                grouped(RUST_CLIENT, "germany-1", "rust"),
                grouped(SOT, "turkey-1", "sea-of-thieves"),
            ],
        );
        assert_eq!(selection.preferred_exit(RUST_WRAPPER), None);
        assert_eq!(selection.preferred_exit(SOT), Some("turkey-1"));
    }

    /// Belt as well as braces. `SplitTunnelConfig::validate` refuses a
    /// config that puts one game on two exits, so nothing arriving
    /// through the pipe reaches here -- but this type is constructed
    /// directly too, and a rule whose cost is a customer's account
    /// should not depend on which door the caller came through.
    #[test]
    fn a_group_naming_two_exits_is_dropped_whole() {
        let selection = with_groups(
            &[RUST_WRAPPER, RUST_CLIENT],
            vec![
                grouped(RUST_WRAPPER, "germany-1", "rust"),
                grouped(RUST_CLIENT, "turkey-1", "rust"),
            ],
        );
        assert_eq!(selection.preferred_exit(RUST_WRAPPER), None);
        assert_eq!(
            selection.preferred_exit(RUST_CLIENT),
            None,
            "neither half of a split group may be honoured -- honouring either IS the split"
        );
        assert!(selection.should_tunnel(RUST_WRAPPER) && selection.should_tunnel(RUST_CLIENT));
    }

    /// Two games on two exits is the feature. Ban-safety mechanism 5 is
    /// the argument for it: a restriction on a shared address hits
    /// every customer on that address and support cannot lift it.
    #[test]
    fn two_whole_groups_may_name_two_different_exits() {
        let selection = with_groups(
            &[RUST_WRAPPER, RUST_CLIENT, SOT],
            vec![
                grouped(RUST_WRAPPER, "germany-1", "rust"),
                grouped(RUST_CLIENT, "germany-1", "rust"),
                grouped(SOT, "turkey-1", "sea-of-thieves"),
            ],
        );
        assert_eq!(selection.preferred_exit(RUST_CLIENT), Some("germany-1"));
        assert_eq!(selection.preferred_exit(SOT), Some("turkey-1"));
    }

    /// An entry with no group is what an app that predates the field
    /// sends, and it means a preference for one executable that claims
    /// nothing about a game. The old per-entry rule still applies to
    /// it: dropped when its app is not selected, honoured when it is,
    /// and never dragging anything else down with it.
    #[test]
    fn an_ungrouped_preference_keeps_the_per_entry_rule() {
        let selection = with_groups(
            &[RUST_WRAPPER, SOT],
            vec![
                exit_of(RUST_WRAPPER, "germany-1"),
                exit_of(RUST_CLIENT, "germany-1"),
                grouped(SOT, "turkey-1", "sea-of-thieves"),
            ],
        );
        assert_eq!(selection.preferred_exit(RUST_WRAPPER), Some("germany-1"));
        assert_eq!(selection.preferred_exit(SOT), Some("turkey-1"));
    }

    /// The fail-open rule composed with the group rule, which is the
    /// combination the design promises and the one worth pinning: an
    /// exit that is not live must not drop traffic, and must not break
    /// the group apart either. Both binaries stay carried and both
    /// report the same `Fallback` naming the same exit -- so the app
    /// can offer to reconnect the game as a whole rather than half of
    /// it.
    #[test]
    fn an_unavailable_exit_keeps_the_group_together() {
        let selection = with_groups(
            &[RUST_WRAPPER, RUST_CLIENT],
            vec![
                grouped(RUST_WRAPPER, "turkey-1", "rust"),
                grouped(RUST_CLIENT, "turkey-1", "rust"),
            ],
        );
        for app in [RUST_WRAPPER, RUST_CLIENT] {
            assert!(selection.should_tunnel(app), "fail open: the game keeps working");
            assert_eq!(
                selection.placement(app, Some("germany-1"), &no_live),
                ExitPlacement::Fallback { preferred: "turkey-1".to_string() }
            );
        }
    }

    #[test]
    fn preferences_are_dropped_under_everything_except() {
        // Under `AllExcept` the named applications are the ones
        // deliberately *not* carried. They have no egress, so a
        // preference for one would be an invention -- the same rule
        // `with_scopes` applies to scopes, for the same reason.
        let selection = preferring(
            &[GAME],
            &[(GAME, "germany-1")],
            SplitTunnelMode::AllExcept,
        );
        assert!(!selection.has_exits());
        assert_eq!(selection.preferred_exit(GAME), None);
        assert!(
            selection.placements(Some("germany-1"), &no_live).is_empty(),
            "the listed apps in AllExcept are the uncarried ones and have nothing to report"
        );
    }

    #[test]
    fn a_preference_is_matched_however_the_path_is_cased() {
        // Paths arrive from the client spelled however the shell spelled
        // them, and are compared against what a process reports. The
        // selection lowercases once at construction; the preference map
        // has to be built and read on the same terms or a customer whose
        // picker returned `C:\GAMES\Game.exe` gets a preference that
        // silently never applies.
        let selection = preferring(
            &[r"C:\Games\Game.exe"],
            &[(r"C:\GAMES\GAME.EXE", "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(
            selection.placement(r"c:\games\game.exe", Some("germany-1"), &no_live),
            ExitPlacement::OnPreferred
        );
    }

    #[test]
    fn every_selected_app_appears_in_the_report() {
        // The app renders the list from this answer alone. A report
        // that omitted the unpreferred applications would force it to
        // fill the gaps from what it remembers asking for, which is the
        // difference between reporting where traffic is and reporting
        // what was requested.
        let selection = preferring(
            &[GAME, OTHER],
            &[(GAME, "turkey-1")],
            SplitTunnelMode::OnlySelected,
        );
        let placements = selection.placements(Some("germany-1"), &no_live);
        assert_eq!(placements.len(), 2);
        let game = placements
            .iter()
            .find(|p| p.app.eq_ignore_ascii_case(GAME))
            .expect("the preferred game is in the report");
        assert_eq!(
            game.placement,
            ExitPlacement::Fallback { preferred: "turkey-1".to_string() }
        );
        let other = placements
            .iter()
            .find(|p| p.app.eq_ignore_ascii_case(OTHER))
            .expect("the unpreferred game is in the report too");
        assert_eq!(other.placement, ExitPlacement::NoPreference);
    }

    #[test]
    fn two_games_may_prefer_two_different_exits() {
        // The customer-visible point of the feature, and the reason
        // `ban-safety.md` counts it as risk reduction rather than
        // convenience: a restriction on a shared exit hits every user of
        // that address, so spreading games across exits shrinks the
        // blast radius. One session can only honour one of these today,
        // which is why the other reports `Fallback` rather than being
        // silently treated as satisfied.
        let selection = preferring(
            &[GAME, OTHER],
            &[(GAME, "germany-1"), (OTHER, "finland-1")],
            SplitTunnelMode::OnlySelected,
        );
        assert_eq!(selection.preferred_exit(GAME), Some("germany-1"));
        assert_eq!(selection.preferred_exit(OTHER), Some("finland-1"));
        assert_eq!(
            selection.placement(GAME, Some("germany-1"), &no_live),
            ExitPlacement::OnPreferred
        );
        assert_eq!(
            selection.placement(OTHER, Some("germany-1"), &no_live),
            ExitPlacement::Fallback { preferred: "finland-1".to_string() }
        );
    }


    // -----------------------------------------------------------------
    // The three-game ceiling.
    // -----------------------------------------------------------------

    /// The owner's limit, in the units it was set in: three *games*, not
    /// three executables. A game is routinely several binaries and they
    /// all leave from one exit or from none, so what is counted is
    /// distinct exits.
    #[test]
    fn three_games_on_three_exits_is_within_the_ceiling() {
        let selection = with_groups(
            &[r"c:\a\launcher.exe", r"c:\a\game.exe", r"c:\b\game.exe", r"c:\c\game.exe"],
            vec![
                // Two binaries, one game, one exit -- which is the case
                // that must not be counted as two.
                grouped(r"c:\a\launcher.exe", "germany-1", "game-a"),
                grouped(r"c:\a\game.exe", "germany-1", "game-a"),
                grouped(r"c:\b\game.exe", "turkey-1", "game-b"),
                grouped(r"c:\c\game.exe", "finland-1", "game-c"),
            ],
        );
        assert_eq!(selection.preferred_exit(r"c:\a\launcher.exe"), Some("germany-1"));
        assert_eq!(selection.preferred_exit(r"c:\a\game.exe"), Some("germany-1"));
        assert_eq!(selection.preferred_exit(r"c:\b\game.exe"), Some("turkey-1"));
        assert_eq!(selection.preferred_exit(r"c:\c\game.exe"), Some("finland-1"));
    }

    /// A fourth exit withholds **every** preference rather than the
    /// fourth one.
    ///
    /// Trimming would mean choosing which games keep their exit, and
    /// the only basis available is the order entries happen to arrive
    /// in -- the order a customer added games, which they were never
    /// told was load-bearing. The app would then report `OnPreferred`
    /// for games picked by list position: a placement nobody decided,
    /// reported as one somebody did.
    #[test]
    fn a_fourth_exit_withholds_every_preference() {
        let apps = [r"c:\a\game.exe", r"c:\b\game.exe", r"c:\c\game.exe", r"c:\d\game.exe"];
        let selection = with_groups(
            &apps,
            vec![
                grouped(r"c:\a\game.exe", "germany-1", "game-a"),
                grouped(r"c:\b\game.exe", "turkey-1", "game-b"),
                grouped(r"c:\c\game.exe", "finland-1", "game-c"),
                grouped(r"c:\d\game.exe", "poland-1", "game-d"),
            ],
        );
        for app in apps {
            assert_eq!(
                selection.preferred_exit(app),
                None,
                "over the ceiling, every game falls back to the session's exit -- \
                 including the three that would otherwise have fitted"
            );
        }
    }

    /// And it fails toward *no preference*, never toward a split: every
    /// application is still carried, exactly as it was before exits
    /// existed.
    #[test]
    fn being_over_the_ceiling_never_stops_carrying_an_application() {
        let apps = [r"c:\a\game.exe", r"c:\b\game.exe", r"c:\c\game.exe", r"c:\d\game.exe"];
        let selection = with_groups(
            &apps,
            vec![
                grouped(r"c:\a\game.exe", "germany-1", "game-a"),
                grouped(r"c:\b\game.exe", "turkey-1", "game-b"),
                grouped(r"c:\c\game.exe", "finland-1", "game-c"),
                grouped(r"c:\d\game.exe", "poland-1", "game-d"),
            ],
        );
        for app in apps {
            assert!(selection.should_tunnel(app), "the traffic is still carried");
        }
    }

    /// Many binaries, three exits: the ceiling counts exits, so a game
    /// with a launcher, a client and an anti-cheat service does not eat
    /// three of the three.
    #[test]
    fn many_binaries_across_three_exits_stay_within_the_ceiling() {
        let apps = [
            r"c:\a\1.exe",
            r"c:\a\2.exe",
            r"c:\a\3.exe",
            r"c:\b\1.exe",
            r"c:\b\2.exe",
            r"c:\c\1.exe",
        ];
        let selection = with_groups(
            &apps,
            vec![
                grouped(r"c:\a\1.exe", "germany-1", "game-a"),
                grouped(r"c:\a\2.exe", "germany-1", "game-a"),
                grouped(r"c:\a\3.exe", "germany-1", "game-a"),
                grouped(r"c:\b\1.exe", "turkey-1", "game-b"),
                grouped(r"c:\b\2.exe", "turkey-1", "game-b"),
                grouped(r"c:\c\1.exe", "finland-1", "game-c"),
            ],
        );
        assert_eq!(selection.preferred_exit(r"c:\a\3.exe"), Some("germany-1"));
        assert_eq!(selection.preferred_exit(r"c:\b\2.exe"), Some("turkey-1"));
        assert_eq!(selection.preferred_exit(r"c:\c\1.exe"), Some("finland-1"));
    }

    /// Three games all naming the *same* exit is one exit, not three.
    #[test]
    fn several_games_sharing_one_exit_cost_one_place() {
        let apps = [r"c:\a\g.exe", r"c:\b\g.exe", r"c:\c\g.exe", r"c:\d\g.exe"];
        let selection = with_groups(
            &apps,
            vec![
                grouped(r"c:\a\g.exe", "germany-1", "game-a"),
                grouped(r"c:\b\g.exe", "germany-1", "game-b"),
                grouped(r"c:\c\g.exe", "germany-1", "game-c"),
                grouped(r"c:\d\g.exe", "turkey-1", "game-d"),
            ],
        );
        for app in apps {
            assert!(
                selection.preferred_exit(app).is_some(),
                "four games on two exits is two concurrent exits and is allowed"
            );
        }
    }

    #[test]
    fn exits_and_scopes_are_independent_axes() {
        // One narrows what is carried, the other says where what is
        // carried leaves from. Neither may quietly become the other:
        // an out-of-scope destination is still reported on the exit the
        // application prefers, because the placement describes the
        // application and not one packet of it.
        let selection = Selection::with_exits(
            [GAME.to_string()],
            SplitTunnelMode::OnlySelected,
            [neoconnect_ipc::AppScope {
                app: GAME.to_string(),
                destinations: vec!["203.0.113.0/24".to_string()],
            }],
            [exit_of(GAME, "germany-1")],
        );
        assert!(selection.has_scopes() && selection.has_exits());
        assert_eq!(
            selection.destination_scope(GAME, IpAddr::V4(Ipv4Addr::new(198, 51, 100, 9))),
            Scoped::OutOfScope
        );
        assert_eq!(
            selection.placement(GAME, Some("germany-1"), &no_live),
            ExitPlacement::OnPreferred
        );
    }

    #[test]
    fn an_unattributable_packet_can_never_reach_a_preference() {
        // The composition rule, asserted at the type level as far as a
        // test can. `verdict_for_unattributed` takes no image path and
        // therefore cannot consult `exits`; its answer with preferences
        // configured is byte-for-byte the answer without them.
        //
        // This is the guard against the multi-exit version of this
        // feature giving an ownerless datagram a "default exit" -- which
        // would mean deciding to carry it, which is the fire-and-forget
        // leak.
        let bare = Selection::new([GAME.to_string()], SplitTunnelMode::OnlySelected);
        let with_exits = preferring(
            &[GAME],
            &[(GAME, "germany-1")],
            SplitTunnelMode::OnlySelected,
        );
        let internet = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9));
        assert_eq!(
            with_exits.verdict_for_unattributed(Transport::Udp, internet),
            Unattributed::Refuse
        );
        assert_eq!(
            with_exits.verdict_for_unattributed(Transport::Udp, internet),
            bare.verdict_for_unattributed(Transport::Udp, internet),
        );
        assert_eq!(
            with_exits.verdict_for_unattributed(Transport::Tcp, internet),
            bare.verdict_for_unattributed(Transport::Tcp, internet),
        );
    }
}
