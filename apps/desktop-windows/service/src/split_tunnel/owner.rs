//! Which application owns a local port.
//!
//! This is the question Custom mode exists to answer: a packet on the
//! wire carries no hint of the program that produced it, so redirecting
//! "only this game" means mapping the packet's source port back to a
//! process and then to an executable on disk.
//!
//! # Why the connection tables and not WinDivert's FLOW layer
//!
//! The spike proved the FLOW layer attributes reliably -- 224 flows, not
//! one unattributable, TCP and UDP alike. It was still the wrong choice
//! here, for a reason the spike could not show: FLOW events are
//! delivered on their own schedule relative to the NETWORK layer, so a
//! TCP SYN can reach the redirect loop before the event announcing the
//! flow it belongs to. The consequence is not a dropped packet, it is a
//! selected app's connection quietly going out unprotected while the UI
//! says Custom mode is on -- the same class of dishonesty as a false
//! "Connected".
//!
//! `GetExtendedTcpTable`/`GetExtendedUdpTable` have no such race. The
//! socket appears in the table when it is created, before anything is
//! sent, so a lookup at the moment the first packet arrives is
//! answerable -- *provided the socket is still open when it is made*.
//! The cost is a table walk, which is why the result is cached and the
//! refresh rate-limited below.
//!
//! That proviso used to read "always answerable", and it was measured
//! wrong. A socket closed immediately after its send is out of the
//! table before the redirect loop is handed the datagram, and no
//! rebuild can recover a row that no longer exists. That is not a race
//! this file can win by asking harder, and it is why
//! [`Selection::verdict_for_unattributed`] exists: the question moves
//! from "who owns this port" -- unanswerable -- to "what is the safe
//! thing to do when nobody does".

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::windows::ffi::OsStrExt;
use std::sync::{Arc, RwLock};

use neoconnect_ipc::{AppPlacement, ExitPlacement, SplitTunnelMode, MAX_SCOPE_PREFIXES};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, HWND, NO_ERROR,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    GW_OWNER,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, SetTcpEntry, TCP_TABLE_OWNER_PID_ALL,
    UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// How long a table snapshot is trusted before being rebuilt.
///
/// Short enough that a port belonging to a process started moments ago
/// is found on the next attempt, long enough that a burst of new
/// connections does not turn into a burst of table walks.
const SNAPSHOT_TTL: Duration = Duration::from_millis(200);

/// The floor on how often a miss may force an early rebuild.
///
/// Without it, traffic to ports that genuinely have no owner -- and
/// there is always some -- would rebuild the table on every packet.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_millis(20);

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
    pub fn matches(&self, image_path: &str) -> bool {
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
        let Some(scope) = self.scopes.get(&image_path.to_lowercase()) else {
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
    pub fn placement(&self, image_path: &str, egress: Option<&str>) -> ExitPlacement {
        let Some(preferred) = self.preferred_exit(image_path) else {
            return ExitPlacement::NoPreference;
        };
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
    pub fn placements(&self, egress: Option<&str>) -> Vec<AppPlacement> {
        if !matches!(self.mode, SplitTunnelMode::OnlySelected) {
            return Vec::new();
        }
        self.paths
            .iter()
            .map(|app| AppPlacement {
                app: app.clone(),
                placement: self.placement(app, egress),
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

/// Where one selected application's traffic is carried *to*.
///
/// # Why this cannot hold a partial list
///
/// A scope only exists if every prefix handed to [`Scope::new`] parsed.
/// One unreadable entry and the constructor returns `None`, which the
/// caller turns into "this application is not scoped" -- all of its
/// traffic carried, exactly as before scopes existed.
///
/// That is not defensive tidiness, it is the safety rule. Scoping a
/// game to *some* of its publisher's address space splits the game's
/// own connections across two paths: World of Warcraft holds its Home
/// and World connections open together, and one account appearing from
/// two source addresses at the same instant is the account-sharing
/// signature that gets people banned. `docs/design/gaming-mode.md` §5.4
/// states the rule as "the client must refuse to activate a game
/// profile whose CIDR list is not prefix-complete rather than activate
/// a partial one".
///
/// The client already refuses -- `canRouteByDestination` in
/// `game-apps.ts` sends nothing unless the catalogue says the list is
/// whole. This is the second, independent refusal, and it exists
/// because the first one being wrong is a ban rather than a bug. There
/// is deliberately **no** constructor that can build a `Scope` from a
/// list it did not fully understand, so no future caller can reach for
/// one in a hurry.
///
/// # Shape, and what it costs per packet
///
/// Sorted, merged, half-open-free inclusive ranges over the integer
/// value of the address, searched by bisection. A prefix list is a set
/// of ranges and nothing about it needs a trie: 512 prefixes is nine
/// comparisons, and the two families are kept apart so an IPv4 packet
/// never touches 128-bit arithmetic.
///
/// The per-packet cost when nothing is scoped is one `is_empty` on a
/// map -- see [`Selection::destination_scope`] -- so a customer who has
/// not added a scoped game pays exactly what they paid before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    /// Inclusive `[start, end]` ranges, sorted by start and merged, so
    /// the last range starting at or below an address is the only one
    /// that can contain it.
    v4: Vec<(u32, u32)>,
    v6: Vec<(u128, u128)>,
}

impl Scope {
    /// Builds a scope, or refuses.
    ///
    /// `None` for an empty list and `None` if **any** prefix is
    /// unreadable -- never a scope over the ones that happened to
    /// parse. See the type's own note for why that is the whole point.
    ///
    /// Also `None` past [`MAX_SCOPE_PREFIXES`], and for the same
    /// reason rather than as a resource limit: truncating a list to fit
    /// manufactures precisely the partial scope this refuses to build.
    pub fn new<I, S>(prefixes: I) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut v4: Vec<(u32, u32)> = Vec::new();
        let mut v6: Vec<(u128, u128)> = Vec::new();
        let mut seen = 0usize;
        for prefix in prefixes {
            seen += 1;
            if seen > MAX_SCOPE_PREFIXES {
                return None;
            }
            match parse_prefix(prefix.as_ref())? {
                Prefix::V4(start, end) => v4.push((start, end)),
                Prefix::V6(start, end) => v6.push((start, end)),
            }
        }
        if v4.is_empty() && v6.is_empty() {
            return None;
        }
        merge(&mut v4);
        merge(&mut v6);
        Some(Self { v4, v6 })
    }

    /// Whether this address is one the application's traffic is carried
    /// to -- or `None` when this scope cannot answer for that family.
    ///
    /// The third answer is not indecision, it is the honest reading of
    /// a v4-only prefix list being asked about an IPv6 packet. Saying
    /// "not in scope" there would be a guess, and a guess in that
    /// direction is the two-source-address failure again by a different
    /// road: the game's IPv4 goes through the tunnel while its IPv6 to
    /// the very same server goes out direct. `None` means the caller
    /// falls back to what this feature did before scopes existed, which
    /// for IPv6 is to block the packet so the application retries over
    /// IPv4 and is carried there.
    ///
    /// A scope always answers for at least one family: [`Scope::new`]
    /// refuses to build one with no prefixes at all.
    pub fn contains(&self, destination: IpAddr) -> Option<bool> {
        match destination {
            IpAddr::V4(addr) => {
                if self.v4.is_empty() {
                    return None;
                }
                Some(contains_in(&self.v4, u32::from(addr)))
            }
            IpAddr::V6(addr) => {
                if self.v6.is_empty() {
                    return None;
                }
                Some(contains_in(&self.v6, u128::from(addr)))
            }
        }
    }
}

/// One parsed prefix, as the inclusive range it covers.
enum Prefix {
    V4(u32, u32),
    V6(u128, u128),
}

/// `a.b.c.d/len`, `addr`, or an IPv6 equivalent.
///
/// A bare address is accepted as a single-host prefix because that is
/// unambiguous and a catalogue may hold one. Host bits below the prefix
/// length are **masked off** rather than refused: `10.1.2.3/8` means
/// `10.0.0.0/8` to every tool a person edits these lists with, and
/// refusing it would drop a whole publisher's scope over a piece of
/// notation everything else accepts.
///
/// Everything genuinely unreadable -- a bad length, a bad address, a
/// second slash -- returns `None`, and one `None` refuses the whole
/// scope.
fn parse_prefix(text: &str) -> Option<Prefix> {
    let text = text.trim();
    let (addr, len) = match text.split_once('/') {
        Some((addr, len)) => (addr, Some(len)),
        None => (text, None),
    };
    if let Ok(v4) = addr.parse::<Ipv4Addr>() {
        let bits = match len {
            Some(len) => len.parse::<u32>().ok().filter(|b| *b <= 32)?,
            None => 32,
        };
        let base = u32::from(v4);
        // Shifting by the full width is undefined in C and a panic in
        // debug Rust, so /0 is spelled out rather than computed.
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        let start = base & mask;
        return Some(Prefix::V4(start, start | !mask));
    }
    let v6 = addr.parse::<Ipv6Addr>().ok()?;
    let bits = match len {
        Some(len) => len.parse::<u32>().ok().filter(|b| *b <= 128)?,
        None => 128,
    };
    let base = u128::from(v6);
    let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
    let start = base & mask;
    Some(Prefix::V6(start, start | !mask))
}

/// Sorts and merges overlapping or touching ranges.
///
/// Merging is what makes the bisection in [`contains_in`] correct and
/// not merely fast: with overlaps left in, the last range starting at
/// or below an address is not necessarily the one that contains it, and
/// the search would answer "no" for an address covered by an earlier,
/// wider prefix. Publisher lists routinely contain a `/16` and a `/24`
/// inside it, so this is the normal case rather than a corner.
fn merge<T: Ord + Copy>(ranges: &mut Vec<(T, T)>) {
    ranges.sort_unstable();
    let mut merged: Vec<(T, T)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        match merged.last_mut() {
            // `start <= last.1` and not `<` because two prefixes can
            // abut exactly; leaving them separate is still correct here,
            // only wider than it needs to be.
            Some(last) if start <= last.1 => {
                if end > last.1 {
                    last.1 = end;
                }
            }
            _ => merged.push((start, end)),
        }
    }
    *ranges = merged;
}

/// Bisection over merged ranges. O(log n) per packet.
fn contains_in<T: Ord + Copy>(ranges: &[(T, T)], value: T) -> bool {
    match ranges.binary_search_by(|range| range.0.cmp(&value)) {
        // A range starts exactly here.
        Ok(_) => true,
        // Every range starts above it.
        Err(0) => false,
        // The one range that could contain it is the last one starting
        // at or below it, which is what merging guarantees.
        Err(next) => value <= ranges[next - 1].1,
    }
}

/// Caches the two connection tables and the image path of each process
/// seen in them.
pub struct OwnerLookup {
    tcp: HashMap<u16, u32>,
    udp: HashMap<u16, u32>,
    /// The same two tables for IPv6. Queried on every rebuild rather
    /// than only when an IPv6 packet turns up: the rebuild is what the
    /// 200ms snapshot budget is spent on, and a second pair of table
    /// walks there is far cheaper than discovering mid-packet that the
    /// snapshot cannot answer and having to walk again.
    tcp6: HashMap<u16, u32>,
    udp6: HashMap<u16, u32>,
    built_at: Instant,
    last_refresh: Instant,
    /// Only successful resolutions live here -- see image_for_port.
    images: HashMap<u32, String>,
}

impl OwnerLookup {
    pub fn new() -> Self {
        // Far enough in the past that the first lookup builds rather
        // than trusting an empty snapshot.
        let stale = Instant::now() - SNAPSHOT_TTL * 2;
        Self {
            tcp: HashMap::new(),
            udp: HashMap::new(),
            tcp6: HashMap::new(),
            udp6: HashMap::new(),
            built_at: stale,
            last_refresh: stale,
            images: HashMap::new(),
        }
    }

    /// The executable behind a local port, or `None` if the port has no
    /// owner this can see.
    ///
    /// A miss triggers at most one rebuild, then answers from the fresh
    /// snapshot -- so a socket created microseconds ago is still found,
    /// without a hot loop for ports that will never be found.
    pub fn image_for_port(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.built_at.elapsed() > SNAPSHOT_TTL {
            self.rebuild();
        }
        let mut pid = self.pid_for(family, transport, port);
        if pid.is_none() && self.last_refresh.elapsed() > MIN_REFRESH_INTERVAL {
            self.rebuild();
            pid = self.pid_for(family, transport, port);
        }
        let pid = pid?;

        // Resolved once per process rather than per connection: an
        // image path cannot change while a process lives, and a busy
        // browser opens far more connections than processes.
        //
        // Only *successful* lookups are cached, and that is the whole
        // point. Caching a failure was a real bug: `OpenProcess` can
        // fail transiently, the entry then survives for as long as the
        // process is in the connection table, and every later
        // connection from it resolves to "unknown" and is left
        // untunnelled. Reported exactly that way -- Chrome quietly
        // stopped using the VPN and only came back after restarting
        // it, because restarting is what finally retired the poisoned
        // process id.
        if !self.images.contains_key(&pid) {
            if let Some(path) = image_path(pid) {
                self.images.insert(pid, path);
            }
        }
        self.images.get(&pid).map(String::as_str)
    }

    /// The same answer as [`Self::image_for_port`], for a port that is
    /// opening a connection right now, where a miss is not allowed to
    /// stand on a snapshot taken moments ago.
    ///
    /// The rate limit above exists so that ports which genuinely have no
    /// owner cannot turn every packet into a table walk. That is right
    /// for the general case and wrong for a TCP SYN, because of what a
    /// miss costs: with `OnlySelected` an unknown owner means "leave it
    /// alone", the SYN goes out unredirected, **and the far end answers
    /// it**. The connection is then established outside the tunnel for
    /// good -- there is no retransmit to have a second go at, and a
    /// browser keeps that socket alive and reuses it for minutes.
    ///
    /// Measured on this machine with Custom mode on and Edge selected: a
    /// page opened six seconds after the redirect started reported the
    /// customer's own address, over a socket created after the switch,
    /// while sibling connections made in the same second went through
    /// the tunnel. That is what the rate limit buys, and it is not worth
    /// it: a SYN is a small share of packets and each one costs at most
    /// one extra walk.
    pub fn image_for_new_connection(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.pid_for(family, transport, port).is_none() {
            self.rebuild();
        }
        self.image_for_port(family, transport, port)
    }

    fn pid_for(&self, family: Family, transport: Transport, port: u16) -> Option<u32> {
        match (family, transport) {
            (Family::V4, Transport::Tcp) => self.tcp.get(&port).copied(),
            (Family::V4, Transport::Udp) => self.udp.get(&port).copied(),
            (Family::V6, Transport::Tcp) => self.tcp6.get(&port).copied(),
            (Family::V6, Transport::Udp) => self.udp6.get(&port).copied(),
        }
    }

    fn rebuild(&mut self) {
        if let Some(table) = tcp_table() {
            self.tcp = table;
        }
        if let Some(table) = udp_table() {
            self.udp = table;
        }
        if let Some(table) = tcp6_table() {
            self.tcp6 = table;
        }
        if let Some(table) = udp6_table() {
            self.udp6 = table;
        }
        let now = Instant::now();
        self.built_at = now;
        self.last_refresh = now;

        // Processes that have gone are dropped rather than accumulating
        // for the life of the connection. Windows reuses process ids, so
        // a stale entry is not merely wasted memory -- it would answer
        // for whatever took the id next.
        let live: std::collections::HashSet<u32> = self
            .tcp
            .values()
            .chain(self.udp.values())
            .chain(self.tcp6.values())
            .chain(self.udp6.values())
            .copied()
            .collect();
        self.images.retain(|pid, _| live.contains(pid));
    }
}

/// Local port -> owning process id, for every IPv4 TCP connection.
///
/// Sized by asking first: the table changes between the two calls often
/// enough that a single guess is not safe, which is why the API is
/// documented as a retry loop.
fn tcp_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or valid for `*size` bytes.
        unsafe {
            GetExtendedTcpTable(
                buf,
                size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        }
    })?;

    // MIB_TCPTABLE_OWNER_PID: a u32 count followed by that many
    // 6 x u32 rows. Read field by field rather than by casting to the
    // generated struct, whose trailing array is declared with length 1
    // and would make an indexed read into the rest of the table
    // out of bounds.
    const ROW_WORDS: usize = 6;
    const LOCAL_PORT: usize = 2;
    const OWNING_PID: usize = 5;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Local port -> owning process id, for every IPv4 UDP socket.
fn udp_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;

    // MIB_UDPTABLE_OWNER_PID rows are {dwLocalAddr, dwLocalPort, dwOwningPid}.
    const ROW_WORDS: usize = 3;
    const LOCAL_PORT: usize = 1;
    const OWNING_PID: usize = 2;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Local port -> owning process id, for every IPv6 TCP connection.
///
/// A separate call rather than a parameter on [`tcp_table`] because the
/// row layout differs, not just the family: `MIB_TCP6ROW_OWNER_PID`
/// carries 16-byte addresses and a scope id for each end, so the port
/// and pid sit at different offsets. Passing `AF_INET6` to the IPv4
/// reader would parse address bytes as a port and return a plausible
/// number for the wrong socket -- the same class of mistake the IPv4
/// reader avoids by not casting to the generated struct.
fn tcp6_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or valid for `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    })?;

    // MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
    // dwState, dwOwningPid -- fourteen 32-bit words in all.
    const ROW_WORDS: usize = 14;
    const LOCAL_PORT: usize = 5;
    const OWNING_PID: usize = 13;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Local port -> owning process id, for every IPv6 UDP socket.
fn udp6_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET6 as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;

    // MIB_UDP6ROW_OWNER_PID rows are {ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, dwOwningPid}.
    const ROW_WORDS: usize = 7;
    const LOCAL_PORT: usize = 5;
    const OWNING_PID: usize = 6;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Runs the size-then-fetch dance both table APIs require.
fn query_table<F>(mut call: F) -> Option<Vec<u32>>
where
    F: FnMut(*mut std::ffi::c_void, *mut u32) -> u32,
{
    let mut size: u32 = 0;
    let ret = call(std::ptr::null_mut(), &mut size);
    if ret != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }

    for _ in 0..3 {
        // u32-backed so the buffer is aligned for the DWORD fields read
        // out of it below.
        let mut buffer: Vec<u32> = vec![0; (size as usize).div_ceil(4)];
        let ret = call(buffer.as_mut_ptr() as *mut _, &mut size);
        if ret == NO_ERROR {
            return Some(buffer);
        }
        if ret != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
    }
    None
}

/// Turns a raw `MIB_*TABLE_OWNER_PID` buffer into a port -> pid map.
fn parse_table(
    words: &[u32],
    row_words: usize,
    port_offset: usize,
    pid_offset: usize,
) -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    let Some(&count) = words.first() else {
        return map;
    };

    for row in 0..count as usize {
        let base = 1 + row * row_words;
        let Some(&raw_port) = words.get(base + port_offset) else {
            break;
        };
        let Some(&pid) = words.get(base + pid_offset) else {
            break;
        };
        // dwLocalPort holds the port in network byte order in its low
        // half, so the bytes come out swapped on a little-endian host.
        map.insert((raw_port as u16).swap_bytes(), pid);
    }
    map
}

/// The full path of a running process's executable.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than the fuller access
/// right on purpose: it is the least this needs, and it is the one that
/// works against protected processes, which some anti-cheat-guarded
/// games are.
/// The applications running right now, for the picker to offer.
///
/// Deduplicated by path, because a modern application is many processes
/// and a list with chrome.exe in it eleven times is not a list. Sorted
/// by name so the order does not shuffle between refreshes.
///
/// Filtered to what a person would recognise as a program: anything
/// under the Windows system directories is the operating system going
/// about its business, and offering it invites a customer to route
/// their own machinery through a VPN. The path is what a selection is
/// actually made of -- see `Selection` -- so the path is returned, with
/// the file name alongside only for display.
/// The applications a customer would actually recognise, grouped one
/// entry per product.
///
/// Two things decide what appears here, and the previous version had
/// neither. It listed every process whose image was not under System32,
/// which is a definition of "not a Windows binary" rather than of "an
/// app" -- so background helpers, update services and telemetry hosts
/// filled the list -- and it listed each executable separately, so one
/// product appeared two or three times under names nobody recognises.
///
/// A **visible window with a title** is what a person means by "an app
/// that is open". Everything without one is exactly the noise being
/// complained about.
///
/// Grouping is by the product name recorded in the executable itself,
/// falling back to the install directory when there is none. That is
/// what puts `Discord.exe` and `Update.exe` under a single "Discord".
pub fn running_apps() -> Vec<neoconnect_ipc::RunningApp> {
    let mut by_product: HashMap<String, (String, Vec<String>, Vec<u32>)> = HashMap::new();

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return Vec::new();
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set, and
    // setting it is what the API uses to version the struct.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if let Some(path) = image_path(pid) {
            if is_user_application(&path) {
                let (key, label) = product_of(&path);
                let slot = by_product
                    .entry(key)
                    .or_insert_with(|| (label, Vec::new(), Vec::new()));
                let lowered = path.to_lowercase();
                if !slot.1.iter().any(|p| p.to_lowercase() == lowered) {
                    slot.1.push(path);
                }
                slot.2.push(pid);
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };

    // Every sibling goes with the group, so choosing one product routes
    // all of it -- but siblings that are not running are unknown here,
    // which is why the group is built from what the product is rather
    // than from what happens to be on screen.
    let mut apps: Vec<neoconnect_ipc::RunningApp> = by_product
        .into_values()
        .filter_map(|(name, mut paths, pids)| {
            paths.sort();
            // The executable a person associates with the product, not
            // whichever sorts first. Microsoft Edge ships an
            // `elevation_service.exe` that sorts before `msedge.exe`,
            // and taking the first put a service's icon and path under
            // the name "Microsoft Edge".
            //
            // The closest match to the product's own name wins: it is
            // what publishers name their main binary after, and the one
            // whose icon is the product's.
            let path = pick_primary(&name, &paths)?;
            // Taken from the executable shown, which is the one whose
            // icon a person associates with the product.
            let icon = super::icon::icon_png_base64(&path);
            Some(neoconnect_ipc::RunningApp { path, name, paths, icon, pids })
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

/// The processes running right now whose image is one of `images`,
/// as `(image path, pid)` pairs.
///
/// Deliberately not [`running_apps`], which groups by product, builds a
/// display name and extracts an icon for every user application on the
/// machine. The caller here has a handful of paths and one question
/// about each of them, and asks it on a path that holds the `Engines`
/// lock.
///
/// Matched the way [`Selection::matches`] matches -- the whole path,
/// lowercased -- so an answer from here cannot disagree with the answer
/// the redirect loop would give about the same process.
pub fn pids_running_images(images: &[String]) -> Vec<(String, u32)> {
    if images.is_empty() {
        return Vec::new();
    }
    let wanted: Vec<String> = images.iter().map(|i| i.to_lowercase()).collect();
    let mut found = Vec::new();

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return found;
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if let Some(path) = image_path(pid) {
            let lowered = path.to_lowercase();
            if wanted.iter().any(|w| *w == lowered) {
                found.push((lowered, pid));
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };

    found
}

/// Which of `pids` are still running the image they were recorded
/// against.
///
/// The pid is checked *with* its image rather than on its own, because
/// Windows reuses pids. A game that exits and a background service that
/// starts a moment later can carry the same number, and treating that as
/// "the game is still running" would leave a warning on screen that the
/// customer has already done everything they can about.
pub fn still_running(recorded: &[(String, u32)]) -> Vec<(String, u32)> {
    if recorded.is_empty() {
        return Vec::new();
    }
    let mut live = Vec::new();
    for (image, pid) in recorded {
        if let Some(path) = image_path(*pid) {
            if path.to_lowercase() == *image {
                live.push((image.clone(), *pid));
            }
        }
    }
    live
}

/// The executable that best represents a product.
///
/// Scored rather than guessed: an exact stem match first, then one that
/// contains the product's letters, then the shortest name -- helpers are
/// almost always the longer, more qualified ones
/// (`elevation_service`, `crashpad_handler`, `Update`).
fn pick_primary(product: &str, paths: &[String]) -> Option<String> {
    let wanted: String = product
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    paths
        .iter()
        .min_by_key(|path| {
            let stem: String = std::path::Path::new(path.as_str())
                .file_stem()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let rank = if stem == wanted {
                0
            } else if !wanted.is_empty() && (wanted.contains(&stem) || stem.contains(&wanted)) {
                1
            } else {
                2
            };
            (rank, stem.len())
        })
        .cloned()
}

/// Process ids that own a visible, titled, top-level window.
///
/// The closest thing Windows offers to "this is an application the
/// person can see". Owned windows and tool windows are skipped: a
/// splash screen or a tray tooltip is not an app someone chose to open.
fn pids_with_windows() -> std::collections::HashSet<u32> {
    let mut set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // SAFETY: `set` outlives the enumeration, which is synchronous, and
    // the callback only ever touches it through this pointer.
    unsafe {
        EnumWindows(Some(collect_window_pid), &mut set as *mut _ as isize);
    }
    set
}

unsafe extern "system" fn collect_window_pid(window: HWND, param: isize) -> i32 {
    // SAFETY: the pointer is the &mut HashSet handed to EnumWindows.
    let set = unsafe { &mut *(param as *mut std::collections::HashSet<u32>) };

    // SAFETY: `window` is supplied by the enumeration and valid here.
    unsafe {
        if IsWindowVisible(window) == 0 || GetWindowTextLengthW(window) == 0 {
            return 1;
        }
        // A window owned by another one is a dialog or a splash, not the
        // application itself.
        if !GetWindow(window, GW_OWNER).is_null() {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid != 0 {
            set.insert(pid);
        }
    }
    1
}

/// A grouping key and a display name for whatever product owns this
/// executable.
///
/// The product name inside the binary is the only thing that reliably
/// ties several executables together -- file names do not (`Update.exe`
/// is a dozen different products) and neither do directories, since a
/// launcher and the program it launches often sit in different folders
/// under one install root.
fn product_of(path: &str) -> (String, String) {
    // The friendly name first: "Notepad" rather than "Microsoft(R)
    // Windows(R) Operating System", which is what ProductName says for
    // every accessory Windows ships.
    let description = version_string(path, "FileDescription");

    if let Some(product) = product_name(path) {
        let trimmed = product.trim();
        // Some publishers put the platform in ProductName rather than
        // the program, and Microsoft puts it on everything from Notepad
        // to Explorer. Grouping on that collapses a dozen unrelated
        // accessories into one entry -- measured here as a single
        // "Windows Operating System" holding nine executables, which a
        // customer selecting it would have tunnelled all of.
        //
        // Those are not one product to anybody using them, so they are
        // kept apart and named individually.
        if !trimmed.is_empty() && !is_platform_product(trimmed) {
            let label = description.unwrap_or_else(|| trimmed.to_string());
            return (trimmed.to_lowercase(), label);
        }
        if !trimmed.is_empty() {
            let label = description.unwrap_or_else(|| file_label(path));
            // Keyed by the executable, so each accessory stands alone.
            return (path.to_lowercase(), label);
        }
    }
    if let Some(label) = description {
        return (path.to_lowercase(), label);
    }
    // No version block: fall back to the folder, which at least keeps
    // one program's pieces together, and show the file name.
    let file = std::path::Path::new(path);
    let label = file
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let key = file
        .parent()
        .map(|d| d.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| label.to_lowercase());
    (key, label)
}

/// Whether this names the platform rather than the program.
///
/// Windows stamps one ProductName across everything it ships, so it is
/// a grouping key that means "made by the OS" rather than "the same
/// application".
fn is_platform_product(product: &str) -> bool {
    let lowered = product.to_lowercase();
    lowered.contains("operating system") || lowered == "microsoft windows"
}

/// The last path segment without its extension, for a display name of
/// last resort.
fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// `ProductName` from the executable's version resource.
fn product_name(path: &str) -> Option<String> {
    version_string(path, "ProductName")
}

/// One named string from an executable's version resource.
fn version_string(path: &str, field: &str) -> Option<String> {
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a valid null-terminated wide string.
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: the buffer is `size` bytes, which is what the call asked
    // for above.
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr() as *mut _) } == 0 {
        return None;
    }

    // The translation table says which language block the strings are
    // in. Assuming one is how this returns nothing for half the
    // machines it runs on.
    let mut lang_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut lang_len: u32 = 0;
    let translation: Vec<u16> = std::ffi::OsStr::new("\\VarFileInfo\\Translation")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: buffer came from GetFileVersionInfoW; the out params are
    // owned here.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            translation.as_ptr(),
            &mut lang_ptr,
            &mut lang_len,
        )
    };
    if ok == 0 || lang_ptr.is_null() || lang_len < 4 {
        return None;
    }
    // SAFETY: the block is at least one 4-byte language/codepage pair.
    let (language, codepage) = unsafe {
        let pair = lang_ptr as *const u16;
        (*pair, *pair.add(1))
    };

    let query = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\{field}");
    let query: Vec<u16> = std::ffi::OsStr::new(&query)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut value: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut chars: u32 = 0;
    // SAFETY: as above.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            query.as_ptr(),
            &mut value,
            &mut chars,
        )
    };
    if ok == 0 || value.is_null() || chars == 0 {
        return None;
    }
    // SAFETY: `chars` UTF-16 units, trailing null included.
    let text = unsafe { std::slice::from_raw_parts(value as *const u16, chars as usize) };
    let text = String::from_utf16_lossy(text);
    Some(text.trim_end_matches('\0').to_string())
}

/// Whether this is a program a customer would recognise, rather than a
/// part of Windows.
fn is_user_application(path: &str) -> bool {
    let lowered = path.to_lowercase();
    if !lowered.ends_with(".exe") {
        return false;
    }
    // Excluded rather than merely sorted last: a customer who routes
    // svchost through a VPN has not made a choice, they have made a
    // mistake, and an offered list is where that starts.
    const SYSTEM: [&str; 4] = [
        r"\windows\system32\",
        r"\windows\syswow64\",
        r"\windows\winsxs\",
        r"\windows\servicing\",
    ];
    if SYSTEM.iter().any(|dir| lowered.contains(dir)) {
        return false;
    }

    // Traps rather than choices, and each one was really offered.
    //
    // `msedgewebview2.exe` is this application's own window: Tauri runs
    // on WebView2, so it is always in the list, and it sits one letter
    // away from the browser somebody actually means. A tester picked
    // from this list, opened Edge, and reported that Custom mode did
    // nothing -- correctly, because Edge was never what got selected.
    // Edge itself is absent unless it happens to be running, which is
    // what makes the near-miss so easy.
    //
    // The other two are the app and the service. Routing the client
    // that manages the tunnel through its own tunnel is not a setting
    // anybody wants, and the redirect excludes the service anyway --
    // so offering them can only mislead.
    const NEVER_OFFER: [&str; 3] = [
        "msedgewebview2.exe",
        "neoconnect-desktop.exe",
        "neoconnect-service.exe",
    ];
    let file_name = std::path::Path::new(&lowered)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    !NEVER_OFFER.contains(&file_name.as_str())
}

fn image_path(pid: u32) -> Option<String> {
    // SAFETY: a plain call; a failure returns a null handle.
    let process: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }

    let mut buffer = [0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer is valid for `len` wide characters and the API
    // writes at most that many, updating `len` with what it wrote.
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
    // SAFETY: `process` came from OpenProcess and is not used again.
    unsafe { CloseHandle(process) };

    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
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
    fn a_scope_refuses_to_exist_unless_every_prefix_parsed() {
        // The whole safety rule in one assertion. Scoping a game to the
        // prefixes that happened to parse is scoping it to a partial
        // list, and a partial list splits the game's simultaneous
        // connections across two source addresses -- the
        // account-sharing signature. There is deliberately no way to
        // build a `Scope` that holds less than it was asked to.
        assert!(Scope::new(["203.0.113.0/24", "198.51.100.0/24"]).is_some());

        for bad in [
            "203.0.113.0/33",     // a length IPv4 does not have
            "203.0.113.0/",       // no length at all
            "203.0.113.999/24",   // not an address
            "not-an-address",     //
            "203.0.113.0/24/8",   // a second slash
            "203.0.113.0/-1",     // a negative length
        ] {
            assert!(
                Scope::new(["198.51.100.0/24", bad]).is_none(),
                "one unreadable prefix ({bad}) must refuse the whole scope, \
                 never narrow it to the rest"
            );
        }

        assert!(Scope::new(Vec::<String>::new()).is_none(), "an empty list is not a scope");
    }

    #[test]
    fn a_scope_refuses_a_list_longer_than_it_will_hold() {
        // Refused rather than truncated, and that distinction is the
        // same one as above: a truncated list *is* a partial list.
        let ok: Vec<String> =
            (0..MAX_SCOPE_PREFIXES).map(|i| format!("10.{}.{}.0/24", i / 256, i % 256)).collect();
        assert!(Scope::new(&ok).is_some());

        let too_many: Vec<String> = (0..MAX_SCOPE_PREFIXES + 1)
            .map(|i| format!("10.{}.{}.0/24", i / 256, i % 256))
            .collect();
        assert!(
            Scope::new(&too_many).is_none(),
            "an over-long list must be refused whole, not cut down to fit"
        );
    }

    #[test]
    fn a_scope_answers_for_the_families_it_covers_and_no_others() {
        // The third answer is the one that matters. A v4-only list
        // asked about IPv6 must say "I cannot tell you", not "no" --
        // saying "no" would let a scoped game's IPv6 out in the clear
        // while its IPv4 went through the tunnel, which is the two
        // source addresses problem arriving by the other family.
        let v4_only = Scope::new(["203.0.113.0/24"]).expect("a scope");
        assert_eq!(v4_only.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(v4_only.contains("198.51.100.7".parse().unwrap()), Some(false));
        assert_eq!(
            v4_only.contains("2001:db8::1".parse().unwrap()),
            None,
            "a v4-only list must not claim to know anything about IPv6"
        );

        let v6_only = Scope::new(["2001:db8::/32"]).expect("a scope");
        assert_eq!(v6_only.contains("2001:db8::1".parse().unwrap()), Some(true));
        assert_eq!(v6_only.contains("2001:dead::1".parse().unwrap()), Some(false));
        assert_eq!(v6_only.contains("203.0.113.7".parse().unwrap()), None);

        let both = Scope::new(["203.0.113.0/24", "2001:db8::/32"]).expect("a scope");
        assert_eq!(both.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(both.contains("2001:db8::1".parse().unwrap()), Some(true));
        assert_eq!(both.contains("198.51.100.7".parse().unwrap()), Some(false));
        assert_eq!(both.contains("2001:dead::1".parse().unwrap()), Some(false));
    }

    #[test]
    fn overlapping_prefixes_do_not_hide_each_other() {
        // The reason `merge` exists, and the bug it prevents. A
        // publisher list routinely holds a /16 and a /24 inside it.
        // Bisection finds the last range starting at or below the
        // address, so with the /24 left sitting inside the /16 as its
        // own range, an address above the /24 but inside the /16 would
        // land on the /24, fail its end test, and be reported out of
        // scope -- a game server excluded from a list that names it.
        let scope = Scope::new(["10.0.0.0/16", "10.0.5.0/24", "10.0.2.0/24"]).expect("a scope");
        for addr in ["10.0.0.1", "10.0.2.1", "10.0.5.1", "10.0.9.1", "10.0.255.255"] {
            assert_eq!(
                scope.contains(addr.parse().unwrap()),
                Some(true),
                "{addr} is inside the /16 and must be in scope"
            );
        }
        assert_eq!(scope.contains("10.1.0.1".parse().unwrap()), Some(false));
    }

    #[test]
    fn prefix_notation_a_person_would_actually_write_is_understood() {
        // Host bits below the length are masked rather than refused.
        // `10.1.2.3/8` means `10.0.0.0/8` to every tool these lists are
        // edited with, and refusing it would drop a whole publisher's
        // scope over notation everything else accepts.
        let masked = Scope::new(["10.1.2.3/8"]).expect("host bits are masked, not refused");
        assert_eq!(masked.contains("10.9.9.9".parse().unwrap()), Some(true));
        assert_eq!(masked.contains("11.0.0.1".parse().unwrap()), Some(false));

        // A bare address is a single host.
        let host = Scope::new(["203.0.113.7"]).expect("a bare address is a /32");
        assert_eq!(host.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(host.contains("203.0.113.8".parse().unwrap()), Some(false));

        // /0 is the whole family. Spelled out rather than computed,
        // because shifting a u32 by 32 is a panic in debug Rust.
        let everything = Scope::new(["0.0.0.0/0"]).expect("a scope");
        assert_eq!(everything.contains("1.2.3.4".parse().unwrap()), Some(true));
        assert_eq!(everything.contains("255.255.255.255".parse().unwrap()), Some(true));

        // Whitespace round an entry, which a hand-edited list has.
        assert!(Scope::new([" 203.0.113.0/24 "]).is_some());
    }

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

    #[test]
    fn table_rows_are_read_at_the_right_offsets() {
        // Two UDP rows: {localAddr, localPort, pid}. The port is stored
        // network-order in the low half of its DWORD, which is the
        // detail worth a test -- getting it wrong yields plausible
        // nonsense (port 4416 for 4113) rather than an obvious failure.
        let words = vec![
            2, // dwNumEntries
            0x0100_007F,
            0x1110_u32.swap_bytes() >> 16,
            4242,
            0x0000_0000,
            0x0050_u32.swap_bytes() >> 16,
            777,
        ];
        let map = parse_table(&words, 3, 1, 2);
        assert_eq!(map.get(&0x1110), Some(&4242));
        assert_eq!(map.get(&80), Some(&777));
    }

    #[test]
    fn a_truncated_table_does_not_panic() {
        // The count is what the API reported; the buffer is what
        // actually arrived. Trusting the former over the latter would
        // read past the end, in a service running as LocalSystem.
        let words = vec![10, 0, 1, 2];
        let map = parse_table(&words, 3, 1, 2);
        assert_eq!(map.len(), 1);
    }

    /// Runs against this machine's real connection tables. The point is
    /// not a fixed expectation but that the walk returns real data and
    /// resolves to real executables -- the part every redirect decision
    /// depends on being correct.
    #[test]
    fn resolves_a_real_listening_port_to_a_real_executable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let mut lookup = OwnerLookup::new();
        let image = lookup.image_for_port(Family::V4, Transport::Tcp, port);

        let image = image.expect("the test's own listening port must have an owner");
        assert!(
            image.to_lowercase().contains(".exe"),
            "expected an executable path, got {image}"
        );
        println!("port {port} -> {image}");
    }

    /// The socket that opens inside the rate limiter's window, which is
    /// the one a browser opens and the one that used to escape.
    ///
    /// Measured on this machine, three consecutive Custom-mode starts
    /// with a browser selected: 4 of 47, 9 of 60 and 8 of 55 new TCP
    /// connections were not in the snapshot the loop already held. Every
    /// one of them was found by rebuilding, and under the old lookup
    /// every one of them would have gone out untunnelled for good.
    ///
    /// The two lookups here run microseconds apart, which is what puts
    /// the second one inside `MIN_REFRESH_INTERVAL` and makes this the
    /// case being tested rather than an ordinary hit.
    #[test]
    fn a_socket_created_after_the_snapshot_is_still_attributed() {
        let mut lookup = OwnerLookup::new();

        // Builds the snapshot and marks it freshly refreshed.
        let warm = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let _ = lookup.image_for_port(Family::V4, Transport::Tcp, warm.local_addr().unwrap().port());

        // Opened after that snapshot was taken, so it cannot be in it.
        let fresh = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = fresh.local_addr().unwrap().port();

        assert!(
            lookup.image_for_new_connection(Family::V4, Transport::Tcp, port).is_some(),
            "a new connection's owner must be resolved even when the snapshot was just rebuilt"
        );
    }
}

/// The TCP state that tells Windows to tear a connection down.
const MIB_TCP_STATE_DELETE_TCB: u32 = 12;

/// The state of a connection that is actually carrying traffic.
///
/// Named because two separate places now turn on it -- the reset below
/// and the escape audit -- and a bare `5` in either of them reads like a
/// magic number rather than like the one state where a remote address in
/// the table means anything. In every other state the row's remote
/// fields are zero or provisional.
const MIB_TCP_STATE_ESTAB: u32 = 5;

/// Established connections belonging to selected applications, closed so
/// they are rebuilt through the tunnel.
///
/// Without this, switching Custom mode on does nothing for anything
/// already running. A connection is routed once, when it is created, and
/// an application that is already open keeps using the ones it has:
/// measured here, a socket opened beforehand still reported the ordinary
/// exit address thirty seconds later and never moved.
///
/// For a browser that is the whole complaint. Someone selects it, looks
/// at a page showing their address, and sees no change -- because the
/// page is being fetched down a connection that predates the decision.
/// Telegram reconnects promptly and appears to work immediately, which
/// is why the two were reported so differently.
///
/// Only *selected* applications are touched, and only established
/// connections. Resetting a connection is something applications handle
/// routinely -- it is what happens when a network changes -- and the
/// alternative is a feature that silently does not apply until every
/// program is restarted.
///
/// # What is deliberately left alone
///
/// Connections the redirect is already carrying, which is what `carried`
/// answers. This is not an optimisation. The reset runs once inline and
/// then rescans every few hundred milliseconds for the length of the
/// activation window, and a connection an application rebuilt after the
/// first pass is, by the second pass, indistinguishable by remote
/// address from one that predates activation -- so without this the loop
/// closes the very connections it just arranged. Measured on the rig
/// with *no* selected process running before activation and dialling
/// started only after `split_tunnel_active`: "activation reset settled
/// after 12 rescan(s): 30 connection(s) closed in total". All thirty had
/// been carried successfully. A selected application got three seconds
/// of churn for nothing.
///
/// The NAT table is the only thing that can tell the two apart. A
/// carried flow is keyed on the application's own local port and the
/// real destination -- the rewrite happens on the wire, not in the
/// socket, so the connection table still shows the pre-rewrite address
/// the table was keyed on. The escape audit turns on exactly the same
/// question for exactly the same reason; see
/// [`escaped_connections`].
///
/// `carried` must not disturb what it reads. Pass
/// [`super::flows::Nat::has_flow`], never `lookup_flow` -- the latter
/// refreshes `last_seen`, and a rescan loop asking about every
/// established connection twice a second would keep every entry alive
/// forever and stop `expire_idle` retiring anything.
///
/// Connections to the LAN, to loopback and to the node itself. Closing
/// those is pure harm and buys nothing, because none of them would ever
/// have been redirected: the kernel filter excludes every one of those
/// destinations before the redirect loop is given a packet, so a
/// connection to a printer, a NAS or the machine's own services is not
/// a connection that is missing out on the tunnel -- it is one the
/// tunnel was never for. The node's own address is worse than pointless:
/// it is the tunnel, and in `AllExcept` it would be closed on every
/// activation.
///
/// Neoxify's own connections, for the same reason plus a sharper one.
/// In `AllExcept` the service and the app are "selected" by default --
/// nobody thinks to exclude the VPN client -- so without this the reset
/// would close the app's link to its own API every time Custom mode came
/// on, which is the 0.9.22 bug arriving through a different door. It
/// matters more now that this runs repeatedly rather than once.
///
/// What one pass of the reset managed, and what it could not.
#[derive(Debug, Default)]
pub struct ResetOutcome {
    pub closed: usize,
    /// Rows `SetTcpEntry` refused, described well enough to act on.
    ///
    /// These used to be swallowed: the return value was checked, and a
    /// failure simply did not increment the count. That made a refusal
    /// indistinguishable from a row that was never a candidate, which
    /// matters more now that the reset runs repeatedly -- a connection
    /// that cannot be closed is one the loop will keep failing to close
    /// for the whole window, and the log would show only a number that
    /// did not move.
    pub failures: Vec<String>,
}

/// Returns what was closed and what refused to close, for the log.
pub fn reset_selected_connections(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> ResetOutcome {
    // SAFETY: `row` is a correctly shaped MIB_TCPROW; the call only
    // reads it.
    reset_with(selection, node, own_images, carried, &|row| unsafe {
        SetTcpEntry(row.as_mut_ptr() as *mut _)
    })
}

/// The reset with the one thing that touches the machine handed in.
///
/// Split out only so it can be tested. `reset_selected_connections`
/// walks this machine's real connection table -- there is no other kind
/// -- so a test that exercised the real closer would tear down whatever
/// the developer or the build agent happened to have open. With the
/// closer stubbed, the classification can be checked against real rows
/// without a single `SetTcpEntry`.
fn reset_with(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
    close: &dyn Fn(&mut [u32; 5]) -> u32,
) -> ResetOutcome {
    let mut outcome = ResetOutcome::default();
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return outcome;
    };

    let Some(&count) = words.first() else {
        return outcome;
    };

    // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    // remote port, owning pid -- six DWORDs.
    const ROW: usize = 6;
    let mut images: HashMap<u32, Option<String>> = HashMap::new();

    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        let (state, pid) = (fields[0], fields[5]);

        // Only connections that actually carry traffic. A listener has
        // no peer to re-route and killing one would stop a program
        // accepting connections, which is not what was asked for.
        if state != MIB_TCP_STATE_ESTAB {
            continue;
        }

        // Where the far end is, decided before the more expensive
        // question of who owns the row.
        let remote = Ipv4Addr::from(fields[3].to_ne_bytes());
        let remote_port = (fields[4] as u16).swap_bytes();

        // The node is the tunnel itself; everything else excluded here
        // is a destination the kernel filter would never have handed to
        // the redirect loop anyway. Closing them would break a printer,
        // a NAS or a local service to gain exactly nothing.
        if remote == node || !is_public_v4(remote) {
            continue;
        }

        // Already in the tunnel, so closing it would undo this
        // function's own work -- see the doc comment. Asked before the
        // owner is resolved, because this is a hash lookup under a
        // mutex and `image_path` opens a process handle.
        let local_port = (fields[2] as u16).swap_bytes();
        if carried(Transport::Tcp, local_port, remote, remote_port) {
            continue;
        }

        let image = images
            .entry(pid)
            .or_insert_with(|| image_path(pid))
            .clone();
        let Some(image) = image else { continue };
        // Never Neoxify's own. In AllExcept the app and the service are
        // carried by default, and closing the app's link to its own API
        // on every activation is the 0.9.22 failure arriving by another
        // route.
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // MIB_TCPROW is the same five leading fields without the pid.
        let mut set = [MIB_TCP_STATE_DELETE_TCB, fields[1], fields[2], fields[3], fields[4]];
        let ret = close(&mut set);
        if ret == NO_ERROR {
            outcome.closed += 1;
        } else {
            // Said out loud rather than swallowed. A connection that
            // will not close is one that goes on carrying the
            // customer's traffic outside the tunnel, and it is the
            // single most useful thing this function can report: the
            // count alone cannot tell "there was nothing to close" from
            // "Windows refused every attempt".
            outcome
                .failures
                .push(format!("could not close {image} -> {remote}:{remote_port} (error {ret})"));
        }
    }
    outcome
}

/// Whether an IPv4 destination is out on the internet, rather than
/// somewhere a split tunnel deliberately leaves alone.
///
/// The exclusions are deliberately the *same set* the kernel filter
/// carries (see `redirect::filter_for`), and keeping them in step is the
/// whole point rather than a tidiness argument. The filter decides what
/// the redirect loop is ever allowed to see; this decides what the audit
/// is allowed to call an escape. If the two drifted apart the audit
/// would report a stream of "escapes" the loop was never given a chance
/// to carry -- a number that looks like a leak and is really a
/// disagreement between two lists, which is exactly the sort of false
/// alarm this project has already decided is worse than saying nothing.
pub fn is_public_v4(addr: Ipv4Addr) -> bool {
    let o = addr.octets();
    !(addr.is_unspecified()
        || addr.is_loopback()
        // Multicast, the reserved space above it, and the all-ones
        // broadcast, in one comparison -- as in the filter.
        || o[0] >= 224
        || o[0] == 10
        || (o[0] == 172 && (16..32).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 169 && o[1] == 254))
}

/// The same question for IPv6, and necessarily a weaker answer.
///
/// There is no RFC1918 to carve out: a home IPv6 network numbers its own
/// devices out of the global prefix its ISP delegates, so a LAN
/// neighbour on a `2000::/3` address is indistinguishable here from the
/// internet. What can be excluded is only what is genuinely not the
/// internet -- loopback, the unspecified address, multicast, unique-local
/// and link-local -- which mirrors the IPv6 half of the filter for the
/// same reason the IPv4 version mirrors the IPv4 half.
///
/// An IPv4-mapped address is IPv4 traffic wearing a v6 shape, and is
/// answered by the IPv4 rules so the two cannot disagree about one
/// destination written two ways.
pub fn is_public_v6(addr: Ipv6Addr) -> bool {
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let first = addr.segments()[0];
    !(addr.is_unspecified()
        || addr.is_loopback()
        || addr.is_multicast()
        // fc00::/7, unique-local.
        || first & 0xfe00 == 0xfc00
        // fe80::/10, link-local.
        || first & 0xffc0 == 0xfe80)
}

/// One row of the machine's TCP tables, in the shape the audit needs.
///
/// Separate from the `port -> pid` maps [`OwnerLookup`] builds, because
/// those deliberately throw away the two things the audit turns on: the
/// connection's state, and where its far end is.
struct TcpConnection {
    state: u32,
    local_port: u16,
    remote: IpAddr,
    remote_port: u16,
    pid: u32,
}

/// Every IPv4 TCP row, with its state and remote end intact.
fn tcp_connections_v4() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    let Some(&count) = words.first() else {
        return Vec::new();
    };

    // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    // remote port, owning pid -- six DWORDs.
    const ROW: usize = 6;
    let mut rows = Vec::new();
    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        rows.push(TcpConnection {
            state: fields[0],
            // A port sits network-order in the low half of its DWORD; an
            // address is already a network-order byte sequence, so the
            // DWORD's own bytes are the octets in order.
            local_port: (fields[2] as u16).swap_bytes(),
            remote: IpAddr::V4(Ipv4Addr::from(fields[3].to_ne_bytes())),
            remote_port: (fields[4] as u16).swap_bytes(),
            pid: fields[5],
        });
    }
    rows
}

/// Every IPv6 TCP row.
///
/// Walked as well as the IPv4 table, and that is the point rather than
/// completeness for its own sake: a selected app's IPv6 is *blocked*
/// while Custom mode runs, so any established v6 connection it still
/// holds predates the switch and is living entirely outside the tunnel,
/// with nothing in the counters able to say so.
fn tcp_connections_v6() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    let Some(&count) = words.first() else {
        return Vec::new();
    };

    // MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
    // dwState, dwOwningPid -- fourteen 32-bit words.
    const ROW: usize = 14;
    let mut rows = Vec::new();
    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        let mut octets = [0u8; 16];
        for (i, word) in fields[6..10].iter().enumerate() {
            octets[i * 4..i * 4 + 4].copy_from_slice(&word.to_ne_bytes());
        }
        rows.push(TcpConnection {
            state: fields[12],
            local_port: (fields[5] as u16).swap_bytes(),
            remote: IpAddr::V6(Ipv6Addr::from(octets)),
            remote_port: (fields[11] as u16).swap_bytes(),
            pid: fields[13],
        });
    }
    rows
}

/// A connection living outside the tunnel that should be inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Escape {
    pub image: String,
    pub remote: IpAddr,
    pub remote_port: u16,
    pub local_port: u16,
}

/// Established connections belonging to applications whose traffic is
/// supposed to be carried, which the redirect is not carrying.
///
/// # Why this exists at all
///
/// Every number in `redirect::Stats` is counted from inside the packet
/// loop, which means all of them are blind in the same direction: they
/// can only describe packets the loop was given. A connection that
/// escaped -- because its SYN raced the owner lookup, because it was
/// established before Custom mode came on, or because it is IPv6 and was
/// blocked rather than carried -- produces no packet the loop will ever
/// count. `seen`, `matched` and `redirected` all read healthy while it
/// carries the customer's traffic out in the clear. That is the failure
/// this feature has now shipped three separate versions of, and the
/// counters structurally cannot report it.
///
/// So this asks the other question, from the other side: not what the
/// loop did, but what the machine is actually holding open. The
/// connection tables know about every socket whether or not a packet of
/// its was ever intercepted, so a flow that got away is visible here and
/// nowhere else.
///
/// # What it deliberately does not report
///
/// * Rows whose owning process cannot be resolved. In `AllExcept` an
///   unresolvable owner is supposed to be tunnelled, so skipping it
///   under-reports -- but calling a connection an escape without being
///   able to name the program that made it produces a number nobody can
///   act on, and this file's history says an alarm nobody can act on is
///   worse than silence.
/// * Anything belonging to Neoxify itself. The relay's own onward
///   sockets are established to exactly the public destinations the
///   customer's apps asked for and have no NAT entry of their own, so
///   without this every carried flow would be counted twice: once as
///   itself and once as its own escape.
/// * The node, the LAN, loopback and the relay's own two ports -- none
///   of which the redirect was ever supposed to carry.
///
/// `carried` answers whether the redirect already holds a flow. It is
/// passed in rather than reached for, so this stays testable without a
/// NAT table and so the caller can guarantee the read does not disturb
/// the table's idle timers -- see `Nat::has_flow`.
///
/// This is **observation only**. Nothing here closes, drops or rewrites
/// anything: it produces a count and a list for the log, and every
/// decision about what to do with them is made elsewhere.
pub fn escaped_connections(
    selection: &Selection,
    own_images: &[String],
    node: Ipv4Addr,
    proxy_ports: (u16, u16),
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> Vec<Escape> {
    let mut images: HashMap<u32, Option<String>> = HashMap::new();
    let mut escapes = Vec::new();

    for row in tcp_connections_v4().into_iter().chain(tcp_connections_v6()) {
        // Only a connection that is carrying traffic. In every other
        // state the remote fields are zero or provisional, so there is
        // nothing to classify and nothing that has leaked yet.
        if row.state != MIB_TCP_STATE_ESTAB {
            continue;
        }

        // The relay's own ports, on either end of the row. The proxy's
        // listening side and the app's connection into it are both
        // ordinary TCP connections on this machine, and would otherwise
        // read as traffic that got away from the very thing carrying it.
        if row.local_port == proxy_ports.0
            || row.local_port == proxy_ports.1
            || row.remote_port == proxy_ports.0
            || row.remote_port == proxy_ports.1
        {
            continue;
        }

        match row.remote {
            // The node is the tunnel itself. Everything else excluded
            // here is the local network a split tunnel exists to leave
            // alone.
            IpAddr::V4(addr) if addr == node || !is_public_v4(addr) => continue,
            IpAddr::V6(addr) if !is_public_v6(addr) => continue,
            _ => {}
        }

        let image = images.entry(row.pid).or_insert_with(|| image_path(row.pid)).clone();
        let Some(image) = image else { continue };
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // A carried flow is keyed on the app's own port and the real
        // destination, which is what the connection table still shows:
        // the rewrite happens on the wire, not in the socket, so the
        // stack's idea of where this connection is going is the
        // pre-rewrite address the NAT table was keyed on.
        //
        // There is no v6 half to ask. The NAT table is IPv4 only, so an
        // established v6 connection belonging to a carried application
        // is an escape by construction -- which is the honest reading of
        // the 0.9.27 decision to block rather than carry, not a fault in
        // it.
        if let IpAddr::V4(addr) = row.remote {
            if carried(Transport::Tcp, row.local_port, addr, row.remote_port) {
                continue;
            }
        }

        escapes.push(Escape {
            image,
            remote: row.remote,
            remote_port: row.remote_port,
            local_port: row.local_port,
        });
    }

    escapes
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[test]
    fn the_public_test_matches_what_the_kernel_filter_hands_over() {
        // These are the same list seen from opposite ends -- see
        // is_public_v4. Every address the filter string in redirect.rs
        // excludes must be excluded here too, or the audit reports
        // escapes for traffic the loop was never given.
        for local in [
            "0.0.0.0",
            "127.0.0.1",
            "10.4.4.4",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "169.254.10.10",
            "224.0.0.251",
            "255.255.255.255",
        ] {
            assert!(!is_public_v4(local.parse().unwrap()), "{local} must not count as public");
        }
        // The near misses, which is where an off-by-one range would
        // show: 172.15 and 172.32 are outside RFC1918, and 192.169 is
        // not 192.168. 203.0.113.10 stands in for a node address --
        // redacted, see docs/node-address-hygiene.md.
        for public in
            ["1.1.1.1", "8.8.8.8", "203.0.113.10", "172.15.0.1", "172.32.0.1", "192.169.0.1"]
        {
            assert!(is_public_v4(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn the_ipv6_test_leaves_the_local_network_alone() {
        for local in ["::", "::1", "fe80::1", "fd00::950d:8fd1:26eb:d4a", "ff02::fb", "fc00::5"] {
            assert!(!is_public_v6(local.parse().unwrap()), "{local} must not count as public");
        }
        for public in ["2607:f8b0:400a:809::200e", "2001:db8:6ec5::1"] {
            assert!(is_public_v6(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn an_ipv4_mapped_address_is_answered_by_the_ipv4_rules() {
        // One destination written two ways must not get two answers, or
        // a LAN address wearing a v6 shape becomes an escape.
        assert!(!is_public_v6("::ffff:192.168.1.20".parse().unwrap()));
        assert!(is_public_v6("::ffff:8.8.8.8".parse().unwrap()));
    }

    /// The audit against this machine's real tables, with a selection
    /// that carries nothing.
    ///
    /// Not an assertion about a number -- that depends on whatever
    /// happens to be running -- but about the one property that holds
    /// whatever is running: an empty `OnlySelected` selection tunnels
    /// nothing, so nothing can have escaped from it. A non-zero answer
    /// would mean the classification is wrong, not that the machine is
    /// leaking.
    #[test]
    fn nothing_escapes_a_selection_that_carries_nothing() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        assert!(escapes.is_empty(), "found {escapes:?}");
    }

    /// The opposite direction, which is what shows the walk returns real
    /// rows rather than nothing at all.
    ///
    /// `AllExcept` with an empty list means everything is supposed to be
    /// carried, and `carried` here says nothing is -- so every
    /// established public connection this machine holds should come
    /// back. The count is not asserted, because a build agent may hold
    /// none; what is asserted is that whatever comes back is well formed
    /// and passes the classification it claims to have passed.
    #[test]
    fn the_walk_returns_rows_that_are_what_they_claim_to_be() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        println!("{} established connection(s) outside a nothing-carried tunnel", escapes.len());
        for escape in escapes.iter().take(5) {
            println!("{} -> {}:{}", escape.image, escape.remote, escape.remote_port);
            assert!(escape.image.to_lowercase().ends_with(".exe"), "{escape:?}");
            assert_ne!(escape.remote_port, 0, "{escape:?}");
            match escape.remote {
                IpAddr::V4(addr) => assert!(is_public_v4(addr), "{escape:?}"),
                IpAddr::V6(addr) => assert!(is_public_v6(addr), "{escape:?}"),
            }
        }
    }

    #[test]
    fn the_reset_leaves_a_machine_alone_when_nothing_is_selected() {
        // Against this machine's real connection table, which is the
        // only way to run it. An empty OnlySelected list carries
        // nothing, so nothing may be closed -- and this test exists
        // because the cost of being wrong about that is other people's
        // connections dying on a developer's desktop.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let outcome = reset_selected_connections(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
        );
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// The convergence loop's own connections, which it used to close.
    ///
    /// `AllExcept` with an empty exclusion list selects everything on
    /// the machine, which is the widest the reset can ever be asked to
    /// be. With `carried` saying every flow is already in the tunnel,
    /// the correct number of closures is zero -- that is the whole
    /// claim. Before the predicate existed the same call closed every
    /// established public connection on the machine, which is what the
    /// rig measured as thirty closures across twelve rescans with
    /// nothing stale to close.
    ///
    /// Run through `reset_with` with the closer stubbed, so a
    /// regression fails the assertion instead of tearing down the
    /// developer's connections to prove it.
    #[test]
    fn a_flow_the_redirect_already_holds_is_not_reset() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| true,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        assert_eq!(attempts.get(), 0, "a carried flow was handed to SetTcpEntry");
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// The other direction, which is what stops the test above passing
    /// because the walk found nothing.
    ///
    /// Same selection, same stub closer, `carried` saying nothing is in
    /// the tunnel. Whatever this machine holds open to the public
    /// internet should now be a candidate. The count is not asserted --
    /// a build agent may legitimately hold none -- but it is printed,
    /// and if it is non-zero then the assertion above means something.
    #[test]
    fn without_the_predicate_the_same_walk_finds_candidates() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        println!("{} connection(s) would have been closed", attempts.get());
        assert_eq!(outcome.closed, attempts.get());
    }

    #[test]
    fn a_flow_the_redirect_already_holds_is_not_an_escape() {
        // The predicate the whole audit turns on, said with a stub
        // rather than a live NAT table so the test states the rule
        // instead of restating the table's implementation.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| true,
        );
        // Every IPv4 row is claimed as carried, so only IPv6 rows -- for
        // which there is no NAT table to ask -- may remain.
        assert!(
            escapes.iter().all(|e| matches!(e.remote, IpAddr::V6(_))),
            "an IPv4 flow the NAT table holds must not be an escape: {escapes:?}"
        );
    }

    // ---- per-application exits -------------------------------------

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
            selection.placement(GAME, Some("germany-1")),
            ExitPlacement::OnPreferred
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
            selection.placement(OTHER, Some("germany-1")),
            ExitPlacement::NoPreference
        );
        assert_eq!(
            selection.placement(OTHER, Some("finland-1")),
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
            selection.placement(GAME, Some("germany-1")),
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
            selection.placement(GAME, None),
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
            selection.placement(OTHER, Some("finland-1")),
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
            assert_eq!(selection.placement(app, Some("germany-1")), ExitPlacement::OnPreferred);
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
            selection.placement(RUST_WRAPPER, Some("finland-1")),
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
                selection.placement(app, Some("germany-1")),
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
            selection.placements(Some("germany-1")).is_empty(),
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
            selection.placement(r"c:\games\game.exe", Some("germany-1")),
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
        let placements = selection.placements(Some("germany-1"));
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
            selection.placement(GAME, Some("germany-1")),
            ExitPlacement::OnPreferred
        );
        assert_eq!(
            selection.placement(OTHER, Some("germany-1")),
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
            selection.placement(GAME, Some("germany-1")),
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
