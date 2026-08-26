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
//!    settled by trying it -- see [`install_verified_route`].
//! 3. [`redirect`] intercepts outbound packets, works out which
//!    application each belongs to, and rewrites the selected ones to a
//!    local proxy.
//! 4. [`proxy`] carries them onward on sockets pinned to the tunnel with
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

mod divert;
pub(crate) mod firewall;
mod flows;
mod icon;
mod owner;
mod proxy;
mod redirect;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use neoconnect_ipc::{AppPlacement, SplitTunnelConfig, SplitTunnelMode};

use crate::adapters;
use crate::engines::ipv6_block;
use crate::engines::routing::{self, InstalledRoutes};

pub use owner::{running_apps, Selection, SharedSelection};

/// How long to wait for a tunnel adapter to appear and be given an
/// address after its engine starts.
///
/// The adapter and its address arrive separately, and a socket pinned to
/// an interface with no address of its own has nothing to use as a
/// source -- so both have to be there before the proxy is any use.
const ADAPTER_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether Custom mode is running, readable without the `Engines` lock.
///
/// A shadow of `SplitTunnel::active`, written at the two places that set
/// and clear it and nowhere else. It exists for one caller: the status
/// poll, which has to be answerable while an operation holds the lock --
/// see `pipe::dispatch`. Anything that holds the lock asks
/// [`SplitTunnel::is_running`], which reads the real thing.
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
    active: Option<Active>,
    /// Processes that were already running when the customer selected
    /// them, as `(lowercased image path, pid)`.
    ///
    /// The connections these hold predate the choice and cannot be moved
    /// into the tunnel, so this is what `restart_needed` turns into a
    /// sentence for the customer. Kept on the `SplitTunnel` rather than
    /// on `Active` because the selection can be edited before a tunnel
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

struct Active {
    redirect: redirect::Running,
    /// The flow tables the redirect loop decides against.
    ///
    /// Held here so a selection change can throw the leave-alone
    /// verdicts away -- see `set_selection`. It is the same `Arc` the
    /// loop, the relays and the audit hold; there is one table.
    nat: Arc<flows::Nat>,
    relays: proxy::Relays,
    /// Held for its Drop: without it the stack accepts none of the
    /// redirected connections. See the firewall module.
    allowance: firewall::Allowance,
    tunnel: Arc<proxy::TunnelInterface>,
    route: InstalledRoutes,
    logger: Logger,
    /// The reset loop that keeps closing pre-existing connections for
    /// the first seconds. Held so it is stopped with the session.
    convergence: Convergence,
    /// The backstop that switches interception off if the tunnel goes
    /// away without anybody noticing. Held so it is stopped with the
    /// session.
    watchdog: Watchdog,
    /// Set by the watchdog when it has stopped interception, so the
    /// status poll can say so instead of reporting a Custom mode that
    /// looks live and is not. Nothing in this product reports a state
    /// it has not verified, and "still intercepting" is such a state.
    watchdog_tripped: Arc<std::sync::atomic::AtomicBool>,
    /// The per-app IPv6 block, when one could be installed.
    ///
    /// `None` is normal and not a fault: "everything except these" does
    /// not want one, and a machine where the filtering engine refuses
    /// still gets the redirect loop's own IPv6 block. See
    /// `engines::ipv6_block::SelectedAppsIpv6Block` for what it adds
    /// over that, and for why the same idea is unsound for IPv4.
    ipv6_apps: Option<ipv6_block::SelectedAppsIpv6Block>,
    log_path: PathBuf,
    /// When interception began, so a warm-up is not mistaken
    /// for a fault. See redirect::WARMUP.
    started: Instant,
}

/// The resolver every lookup is sent to while Custom mode is on.
///
/// The same one the tunnels push for a full tunnel, so this is not a
/// second opinion arriving through a different door -- it is already
/// reachable through every node. See `redirect::is_dns` for why Custom
/// mode carries lookups at all.
const CUSTOM_MODE_RESOLVER: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);

/// How often the counters are written out.
///
/// Frequent enough to be useful within one test, rare enough that the
/// file stays readable over a long session.
const LOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// The log file's name, beside the engines' own logs in the protected
/// config directory.
const LOG_FILE: &str = "split-tunnel.log";

/// How often the escape audit walks the machine's connection tables.
///
/// Thirty seconds, which is a compromise between two costs that pull in
/// opposite directions. It is four table walks plus a process lookup per
/// unseen pid, so it is far too expensive to sit anywhere near the packet
/// path; and an escape is a connection a browser will happily keep alive
/// for minutes, so a sweep that arrives half a minute late still catches
/// it. The one thing it is deliberately *not* tuned for is catching an
/// escape quickly enough to do something about it -- nothing here does
/// anything about it. See `owner::escaped_connections`.
const AUDIT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// How many escaping connections are named in the log per sweep.
///
/// A cap rather than a truncation for its own sake: the failure this
/// audit is looking for is usually one browser holding a handful of
/// connections, and the pathological case -- `AllExcept` a moment after
/// activation, where every pre-existing connection on the machine
/// qualifies -- would otherwise write hundreds of lines into a log a
/// customer is expected to paste into a support message. The count above
/// them is the number that matters; the names are there to say which
/// program to look at.
const AUDIT_NAMES_PER_SWEEP: usize = 5;

/// How often the activation reset rescans while it converges.
///
/// Chosen against what it is chasing rather than for its own sake. The
/// rows it is waiting for are connections in `SYN_SENT`, which reach
/// ESTABLISHED as soon as the far end answers -- a few tens of
/// milliseconds on a local path, a few hundred on the sort of long,
/// lossy route this product's customers are on. A quarter of a second is
/// short enough that such a connection is closed before an application
/// has sent anything down it, and long enough that the whole window
/// costs a dozen table walks rather than hundreds.
const RESET_RESCAN: std::time::Duration = std::time::Duration::from_millis(250);

/// Writes the redirect counters to disk periodically.
///
/// This exists because of how the spike went: three attempts were spent
/// on byte counters that turned out to measure elapsed time and adapter
/// chatter, and the question was settled in one run by a packet capture.
/// The same lesson applies to a feature nobody can capture on a
/// customer's machine -- four numbers written down beat any number of
/// guesses about which stage failed.
struct Logger {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Logger {
    fn start(
        path: PathBuf,
        stats: Arc<redirect::Stats>,
        header: String,
        mut audit: Audit,
    ) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                // Appended, not truncated. Truncating lost exactly the
                // session worth reading: when a protocol fails, the
                // ladder starts the next one immediately, and that
                // second session's header wiped the first. The customer
                // was then asked for a log that could only ever show
                // the attempt which worked.
                trim_if_large(&path);
                append(&path, &format!("--- {header}"));
                while sleep_unless_stopped(&stop, LOG_INTERVAL) {
                    // The audit rides this thread rather than bringing
                    // its own. It is periodic housekeeping on the same
                    // cadence order as the counters, it is torn down by
                    // the same stop flag, and a second thread would be a
                    // second thing to join on a Disconnect that
                    // customers have already reported as slow.
                    if audit.due() {
                        audit.run(&path, &stats);
                    }
                    append(&path, &stats.summary());
                }
                append(&path, &format!("stopped {}", stats.summary()));
            })
        };
        Self { stop, thread: Some(thread) }
    }

    fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// How often the backstop looks at the adapter it was pinned to.
///
/// Three seconds. The thing it is watching for leaves the machine with
/// no working name resolution at all, so the cost of noticing late is
/// paid by somebody staring at a browser that will not load, and the
/// check itself is one adapter enumeration.
const WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);

/// How many consecutive looks must say "gone" before interception stops.
///
/// Two, so a single unlucky enumeration cannot take down a healthy
/// session. It is only ever consecutive *evidence* that counts -- a
/// query that failed is not evidence, see [`Liveness::NoEvidence`] --
/// and the run is reset by any look that finds the adapter well.
const WATCHDOG_STRIKES: u32 = 2;

/// What one look at the tunnel adapter established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Liveness {
    /// The adapter is there, up, and still carrying the address the
    /// relays bind their upstream sockets to.
    Alive,
    /// The adapter this session was built on is not usable any more.
    Gone,
    /// The question could not be answered. **Not** the same as `Gone`,
    /// and the distinction is the entire reason this is a three-valued
    /// answer rather than a bool: an adapter enumeration that fails
    /// says something about the enumeration, and tearing a working
    /// customer's tunnel down over it would be a self-inflicted outage
    /// of exactly the kind this backstop exists to prevent.
    NoEvidence,
}

/// Whether the tunnel this session was pinned to is still there.
///
/// Split out from the thread so it can be tested, because every branch
/// here is a decision to leave a customer's traffic alone or to stop
/// carrying it, and neither is safe to get wrong.
fn liveness(
    expected_index: u32,
    expected_address: Ipv4Addr,
    found: &std::io::Result<Option<adapters::Adapter>>,
) -> Liveness {
    match found {
        Err(_) => Liveness::NoEvidence,
        // The adapter is not there at all. This is what a WireGuard
        // tunnel service going away looks like, and an Xray engine
        // exiting, and a RAS connection dropping.
        Ok(None) => Liveness::Gone,
        Ok(Some(adapter)) => {
            if !adapter.is_up {
                return Liveness::Gone;
            }
            // A same-named adapter with a different index or address is
            // not this session's tunnel -- it is a new one, built by
            // somebody else, and the relays are still pinned to the old
            // one. Treated as gone rather than alive, because that is
            // what it is from this session's point of view.
            if adapter.index != expected_index || adapter.ipv4 != Some(expected_address) {
                return Liveness::Gone;
            }
            Liveness::Alive
        }
    }
}

/// Stops interception if the tunnel underneath it disappears.
///
/// The belt to `session::Slot`'s braces. `Slot` makes it impossible for
/// the engine layer to end a session without stopping Custom mode; this
/// covers the case where nobody up there noticed at all -- an adapter
/// pulled out from under a process that is still running, a driver
/// reset, an engine that is alive and no longer carrying anything.
///
/// The failure it exists to prevent is not subtle. A redirect loop with
/// no tunnel behind it takes every DNS lookup on the machine, from every
/// process, and hands them to a relay whose upstream socket cannot bind
/// -- so nothing resolves, for anything, including other VPN clients,
/// until this service's process is killed. That was a real customer's
/// afternoon on 2026-08-23.
///
/// It can only switch interception off, not take the session apart:
/// joining the redirect's workers from a thread the session owns would
/// deadlock the teardown that is trying to join this one. Switching it
/// off is what gives the machine back.
struct Watchdog {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Watchdog {
    #[allow(clippy::too_many_arguments)]
    fn start(
        adapter_name: String,
        index: u32,
        address: Ipv4Addr,
        tunnel: Arc<proxy::TunnelInterface>,
        stopper: redirect::Stopper,
        log_path: PathBuf,
        tripped: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut strikes = 0;
                while sleep_unless_stopped(&stop, WATCHDOG_INTERVAL) {
                    match liveness(index, address, &adapters::find_by_name(&adapter_name)) {
                        Liveness::Alive => strikes = 0,
                        Liveness::NoEvidence => {}
                        Liveness::Gone => {
                            strikes += 1;
                            if strikes < WATCHDOG_STRIKES {
                                continue;
                            }
                            let detail = format!(
                                "the tunnel adapter {adapter_name} (interface {index}, {address}) \
                                 is gone, but Custom mode was still intercepting this machine's \
                                 packets -- interception has been stopped so traffic can flow \
                                 normally again"
                            );
                            // Both files on purpose. cleanup.log is the
                            // one a support conversation asks for, and
                            // split-tunnel.log is where the counters
                            // that stop moving are, so the two halves of
                            // the story are readable together.
                            crate::cleanup_log::note(
                                "stop Custom mode after its tunnel disappeared",
                                &detail,
                            );
                            append(&log_path, &format!("WATCHDOG {detail}"));
                            tripped.store(true, std::sync::atomic::Ordering::SeqCst);
                            // Cleared as well as shut down: any relay
                            // thread already past the redirect sees no
                            // tunnel and takes the ordinary route rather
                            // than retrying a bind that cannot succeed.
                            tunnel.clear();
                            stopper.stop_intercepting();
                            return;
                        }
                    }
                }
            })
        };
        Self { stop, thread: Some(thread) }
    }

    fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Keeps closing a selected app's pre-existing connections for the first
/// seconds of a session.
///
/// One pass at activation is not enough, and the reason is a real
/// limitation rather than an oversight: `SetTcpEntry` can only tear down
/// a connection that has reached ESTABLISHED. A connection that is in
/// `SYN_SENT` at the instant Custom mode starts survives the pass,
/// completes against the real destination a moment later, and lives
/// outside the tunnel for as long as the application keeps it. That is
/// issue 9 in the handover, and for a browser -- which keeps sockets
/// alive and reuses them -- it is the difference between Custom mode
/// applying and appearing not to.
///
/// So the pass becomes a loop: rescan every [`RESET_RESCAN`] for
/// [`redirect::ACTIVATION_GRACE`], closing rows as they arrive in a state
/// that can be closed. The two durations are the same one on purpose --
/// while this is running, the redirect loop refuses those connections
/// rather than exempting them, and a refusal that outlived the thing
/// arranging a replacement would just be an outage.
///
/// On its own thread, so `connect()` returns no later than it did
/// before. The first pass still runs inline, which is what keeps the
/// existing behaviour and the existing log line intact; this only adds
/// the ones that were not closeable yet.
struct Convergence {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Convergence {
    fn start(
        selection: SharedSelection,
        path: PathBuf,
        node: Ipv4Addr,
        own_images: Vec<String>,
        nat: Arc<flows::Nat>,
        closed_already: usize,
    ) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + redirect::ACTIVATION_GRACE;
                let mut closed = closed_already;
                let mut passes = 0usize;

                while Instant::now() < deadline {
                    // Interruptible, because Custom mode can be stopped
                    // inside this window -- a failover does exactly that
                    // -- and closing a customer's connections on behalf
                    // of a session that no longer exists is pure harm.
                    if !sleep_unless_stopped(&stop, RESET_RESCAN) {
                        return;
                    }
                    let selection =
                        selection.read().unwrap_or_else(|e| e.into_inner()).clone();
                    // Skipping whatever the redirect is already
                    // carrying. By the second pass an application has
                    // rebuilt its connections into the tunnel, and
                    // without this the loop closes them again -- see
                    // `owner::reset_selected_connections`. `has_flow`,
                    // not `lookup_flow`, so asking twice a second does
                    // not keep every entry alive.
                    let outcome = owner::reset_selected_connections(
                        &selection,
                        node,
                        &own_images,
                        &|transport, port, destination, destination_port| {
                            nat.has_flow(transport, port, destination, destination_port)
                        },
                    );
                    closed += outcome.closed;
                    passes += 1;
                    for failure in outcome.failures {
                        append(&path, &format!("  reset: {failure}"));
                    }
                }

                append(
                    &path,
                    &format!(
                        "activation reset settled after {passes} rescan(s): {closed} connection(s) closed in total"
                    ),
                );
            })
        };
        Self { stop, thread: Some(thread) }
    }

    fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The periodic check for connections that got away.
///
/// Everything `redirect::Stats` counts is counted from inside the packet
/// loop, so all of it is blind to a connection the loop never saw -- and
/// a connection the loop never saw is exactly what a leak is. This walks
/// the machine's own connection tables instead and asks which of them
/// ought to be in the tunnel and is not. See
/// [`owner::escaped_connections`] for what qualifies and what is
/// deliberately excluded.
///
/// It changes nothing. No connection is closed, no packet is dropped and
/// no verdict is revised on the strength of what it finds: it writes a
/// count and a few names into the log. That restraint is on purpose --
/// the count has never been read against a packet capture, and this
/// project does not act on a number nobody has checked against the wire.
struct Audit {
    nat: Arc<flows::Nat>,
    selection: SharedSelection,
    own_images: Vec<String>,
    node: Ipv4Addr,
    /// The relay's TCP and UDP ports, whose own connections are not
    /// escapes from the thing they are part of.
    proxy_ports: (u16, u16),
    /// Escapes already named in the log, so a connection that lives for
    /// ten minutes is described once rather than twenty times.
    named: std::collections::HashSet<(u16, std::net::IpAddr, u16)>,
    last_run: Instant,
}

impl Audit {
    fn due(&self) -> bool {
        self.last_run.elapsed() >= AUDIT_INTERVAL
    }

    fn run(&mut self, path: &Path, stats: &redirect::Stats) {
        self.last_run = Instant::now();

        // Copied rather than held: what follows is four table walks and
        // a process lookup per unseen pid, and the redirect loop reads
        // this lock on every packet.
        let selection = self.selection.read().unwrap_or_else(|e| e.into_inner()).clone();
        let nat = self.nat.clone();
        let escapes = owner::escaped_connections(
            &selection,
            &self.own_images,
            self.node,
            self.proxy_ports,
            // `has_flow` rather than `lookup_flow`, because asking must
            // not renew the entry -- see `Nat::has_flow`.
            &|transport, port, destination, destination_port| {
                nat.has_flow(transport, port, destination, destination_port)
            },
        );

        stats
            .escaped
            .store(escapes.len() as u64, std::sync::atomic::Ordering::Relaxed);

        if escapes.is_empty() {
            // Nothing is out. Forget what was named, so a connection
            // that comes back later is reported again rather than being
            // silenced by a sweep it was absent from.
            self.named.clear();
            return;
        }

        append(
            path,
            &format!(
                "escape audit: {} established connection(s) outside the tunnel that should be inside",
                escapes.len()
            ),
        );

        let mut written = 0usize;
        for escape in &escapes {
            let key = (escape.local_port, escape.remote, escape.remote_port);
            if self.named.contains(&key) {
                continue;
            }
            if written >= AUDIT_NAMES_PER_SWEEP {
                append(path, "  ... and more, not listed");
                break;
            }
            append(
                path,
                &format!(
                    "  escape {} -> {}:{} (local port {})",
                    escape.image, escape.remote, escape.remote_port, escape.local_port
                ),
            );
            written += 1;
        }

        self.named = escapes
            .iter()
            .map(|e| (e.local_port, e.remote, e.remote_port))
            .collect();
    }
}

/// Waits, unless asked to stop first. Returns whether the wait ran to
/// completion rather than being cut short.
///
/// A plain `sleep` is what made Disconnect appear to hang. Both the
/// logger and the flow-expiry thread are joined during teardown, so a
/// ten-second sleep between log lines meant up to ten seconds of the app
/// sitting on "Disconnecting..." with the tunnel already gone --
/// reported as exactly that. Waiting in short steps costs nothing and
/// bounds the delay at one step.
pub(super) fn sleep_unless_stopped(
    stop: &std::sync::atomic::AtomicBool,
    total: std::time::Duration,
) -> bool {
    const STEP: std::time::Duration = std::time::Duration::from_millis(200);
    let deadline = std::time::Instant::now() + total;
    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return true;
        }
        std::thread::sleep(STEP.min(deadline - now));
    }
}

/// The machine's IPv4 default routes, one line each.
///
/// `route print` rather than an API call because its data rows are
/// numbers and addresses in fixed columns -- readable regardless of the
/// Windows display language, which a parsed `netsh` heading would not
/// be. Only 0.0.0.0 destinations are kept: this is asked when a pinned
/// socket says a host is unreachable, and the default route is the one
/// that was supposed to carry it.
fn default_routes() -> Vec<String> {
    let exe = std::path::PathBuf::from(r"C:\Windows\System32\route.exe");
    let Ok(out) = crate::engines::run_hidden_capture(&exe, &[std::ffi::OsStr::new("print"), std::ffi::OsStr::new("-4")])
    else {
        return vec!["could not read the routing table".to_string()];
    };
    out.lines()
        .map(str::trim)
        .filter(|line| line.starts_with("0.0.0.0"))
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}

/// Installs the passive default route in whichever shape the tunnel
/// actually works with.
///
/// Three rounds were spent predicting this and all three were wrong,
/// because the prediction is unfalsifiable from where it was made:
/// `route add` succeeds for both shapes, so an install that "worked"
/// tells you nothing about whether a socket can use it. WireGuard was
/// fine on on-link and every Xray and OpenVPN attempt failed with
/// WSAEHOSTUNREACH on the same machine, which is the signature of a
/// route the stack has but cannot resolve a next hop over.
///
/// So this stops predicting. It installs a shape, opens a real pinned
/// socket to a real host -- the same probe the ladder uses, over the
/// exact path a selected app's traffic takes -- and keeps the first
/// shape that carries it.
///
/// If none do, the first shape is reinstalled and the session continues.
/// That is deliberately no worse than the previous behaviour: the app's
/// own probe still decides whether to keep this protocol, and failing
/// the session here would turn a tunnel that works on a network where
/// the probe hosts happen to be blocked into a protocol that can never
/// be selected.
fn install_verified_route(
    tunnel_address: Ipv4Addr,
    tunnel_index: u32,
    tunnel: &proxy::TunnelInterface,
    log_path: &Path,
) -> Result<InstalledRoutes, String> {
    let mut last_error = String::new();

    for shape in routing::PassiveRouteShape::ALL {
        let mut installed =
            match routing::install_passive_default_shaped(tunnel_address, tunnel_index, shape) {
                Ok(installed) => installed,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            };

        match proxy::probe(tunnel) {
            Ok(()) => {
                append(log_path, &format!("route {}: carries traffic", shape.label()));
                return Ok(installed);
            }
            Err(e) => {
                append(log_path, &format!("route {}: no traffic ({e})", shape.label()));
                last_error = e;
                installed.remove();
            }
        }
    }

    // Nothing carried, on either shape, to either probe target. Say so
    // with the state that would explain it -- and then refuse.
    //
    // This used to install the on-link shape anyway and carry on, and
    // that was the wrong call in the worst possible way. A tester's log
    // showed it happening against three different nodes in one sitting:
    //
    // ```text
    // route on-link: no traffic (8.8.8.8:443 timed out)
    // route via the tunnel address: no traffic (...)
    // no route shape carried traffic (...)
    // probe FAILED: the tunnel did not carry a test connection
    // ```
    //
    // Custom mode started every time. His chosen browser was then
    // redirected into a tunnel already proven dead, and when the engine
    // dropped, the deliberate fail-open sent it out on the ordinary
    // route -- so he watched his own address come back with Custom mode
    // switched on, and reported the feature as broken. It was not: the
    // tunnel was.
    //
    // Refusing turns that into a failed candidate, which the connect
    // ladder handles by trying the next protocol. Same reasoning as the
    // IKEv2 refusal above it: giving somebody an unprotected app while
    // the switch says otherwise is the same shape of lie as a false
    // "Connected", and it is worth a failed connection to avoid.
    append(log_path, &format!("no route shape carried traffic ({last_error})"));
    for line in default_routes() {
        append(log_path, &format!("  route  {line}"));
    }
    for line in adapter_diagnostics(tunnel_index) {
        append(log_path, &format!("  adapter  {line}"));
    }

    Err(format!(
        "Custom mode did not start: this tunnel is not carrying traffic ({last_error}).          Your chosen apps would have used the ordinary connection without telling you."
    ))
}

/// What the tunnel adapter actually looks like to Windows.
///
/// Logged only when every route shape has failed, because that is the
/// point at which the remaining question is about the adapter rather
/// than the routing table -- whether the address being bound is really
/// on it, and whether it is the kind of interface that needs a next hop
/// resolved at all.
fn adapter_diagnostics(index: u32) -> Vec<String> {
    match adapters::list() {
        Ok(list) => list
            .into_iter()
            .filter(|a| a.index == index)
            .map(|a| {
                format!(
                    "{} index {} ipv4 {:?}",
                    a.name, a.index, a.ipv4
                )
            })
            .collect(),
        Err(e) => vec![format!("could not enumerate adapters: {e}")],
    }
}

/// Keeps the log from growing without bound across many attempts.
///
/// Reconnect churn writes a session header plus a line every ten
/// seconds, so a long troubleshooting evening adds up. A quarter of a
/// megabyte is far more history than any diagnosis needs and small
/// enough to paste.
fn trim_if_large(path: &Path) {
    const LIMIT: u64 = 256 * 1024;
    if std::fs::metadata(path).map(|m| m.len() > LIMIT).unwrap_or(false) {
        let _ = std::fs::remove_file(path);
    }
}

/// Best-effort. A log line that cannot be written must never affect the
/// connection it is describing.
fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
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
            active: None,
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
        // `owner::still_running` for why the pid alone is not enough.
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
            let already_running = owner::pids_running_images(&newly_selected);
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

        // The customer's choice has to reach the next packet, not the
        // next packet after a timer they cannot see. A leave-alone
        // verdict recorded while an app was unselected would otherwise
        // keep answering for its UDP flows for `DIRECT_VERDICT_TTL`.
        //
        // Strictly downstream of nothing: this throws a cache away, it
        // does not decide anything. Every flow it forgets is decided
        // again by `decide`, through the same owner lookup and the same
        // refusal for anything unattributable. See
        // `flows::Nat::forget_direct`.
        active.nat.forget_direct();
        let log_dir = active.log_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        // Dropped first, and deliberately: two overlapping sets would
        // both be live, and the old one names applications that are no
        // longer selected. The gap is microseconds and the redirect
        // loop covers it, which is the same fail-open trade the rest of
        // this module makes.
        active.ipv6_apps = None;
        active.ipv6_apps = install_ipv6_app_block(&self.selection, &log_dir, &active.log_path);
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
        let placements =
            self.selection.read().unwrap_or_else(|e| e.into_inner()).placements(live);
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
        self.pre_existing = owner::still_running(&self.pre_existing);

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
    ) -> Result<(), String> {
        self.stop();
        if !self.wants_interception() {
            return Ok(());
        }
        let mode = self.mode();

        // Needed before the session is assembled, because choosing the
        // route writes to it.
        let log_path = log_dir.join(LOG_FILE);

        let tunnel_adapter = wait_for_addressed_adapter(adapter_name)?;
        let tunnel_address = tunnel_adapter
            .ipv4
            .ok_or_else(|| format!("{adapter_name} came up without an address"))?;

        let uplink = adapters::physical_uplink(&[adapter_name])
            .map_err(|e| format!("could not enumerate network adapters: {e}"))?
            .ok_or_else(|| "no physical network connection to send traffic over".to_string())?;
        let local_addr = uplink
            .ipv4
            .ok_or_else(|| "the physical network connection has no address".to_string())?;

        let nat = Arc::new(flows::Nat::new());

        // Which interface the proxy sends a redirected connection out
        // of: the VPN adapter, in both directions of the list.
        //
        // Being redirected *is* being tunnelled here. The tunnel is
        // passive either way -- it owns no default route, so nothing
        // reaches it except what this pins there -- and the two modes
        // differ only in which processes get pinned:
        // `Selection::should_tunnel` answers `matches()` for "only
        // these" and `!matches()` for "everything except these". So
        // "everything except these" is a passive tunnel with almost
        // everything redirected into it, not a full tunnel with a few
        // applications carved out.
        //
        // A comment here used to describe that second design -- full
        // tunnel, redirected connections pinned to the physical link --
        // and it was wrong in a way worth naming, because it reads like
        // an invariant somebody could build on. There is no branch on
        // `mode` in this function at all; the line below is what runs
        // for both. The rewriting, the NAT and the return leg really are
        // identical either way, which is the part that was true.
        let tunnel =
            Arc::new(proxy::TunnelInterface::new(tunnel_adapter.index, tunnel_address));

        // The route is chosen by trying it, not by predicting it. See
        // install_verified_route.
        let route =
            install_verified_route(tunnel_address, tunnel_adapter.index, &tunnel, &log_path)?;
        // Created here rather than inside `redirect::start`, because
        // the relay counts into the same table and the relay is started
        // first -- the firewall allowance and the reachability wait sit
        // between the two.
        let stats = Arc::new(redirect::Stats::default());
        let relays = match proxy::start(nat.clone(), tunnel.clone(), stats.clone()) {
            Ok(relays) => relays,
            Err(e) => {
                let mut route = route;
                route.remove();
                return Err(format!("could not start the local relay: {e}"));
            }
        };

        // Before the redirect starts, so that no packet is ever sent
        // to a port the firewall is still dropping.
        let allowance =
            match firewall::Allowance::install(&[local_addr, tunnel_address], relays.tcp_port, relays.udp_port) {
                Ok(allowance) => allowance,
                Err(e) => {
                    relays.stop();
                    let mut route = route;
                    route.remove();
                    return Err(e);
                }
            };

        // The allowance is installed by netsh, and netsh returning is
        // not the same as the rule being effective for new flows. There
        // is a window of a second or two where the redirect is running
        // and every packet it sends to the proxy is still dropped.
        //
        // That window is the whole customer-visible bug. DNS is the
        // first thing anything does, so a browser opening a site during
        // it gets "No such host is known" or a stall of ten to twenty
        // seconds -- measured -- while Telegram, which connects to
        // addresses it already holds and never resolves, is instant.
        // Same machine, same tunnel, opposite experience, and it made
        // the feature look broken to everyone who tested it with a
        // browser.
        //
        // So wait for proof instead of assuming. A completed TCP
        // handshake to the relay means the rule is live and the listener
        // is up; nothing is redirected until that succeeds.
        // So the relay can report a datagram it had to drop. Set before
        // the redirect starts, because the first seconds are exactly
        // when it matters.
        proxy::set_relay_log(log_path.clone());

        if let Err(e) = firewall::wait_until_reachable(local_addr, relays.tcp_port) {
            relays.stop();
            let mut route = route;
            route.remove();
            return Err(e);
        }

        let redirect = redirect::Redirect {
            local_addr,
            local_interface: uplink.index,
            node_addr: node,
            tcp_proxy_port: relays.tcp_port,
            udp_proxy_port: relays.udp_port,
            own_images: own_images(),
            own_sockets: relays.own_sockets.clone(),
            dns_resolver: CUSTOM_MODE_RESOLVER,
            // A full tunnel already resolves through the VPN, so there
            // is nothing to rescue and redirecting lookups would push
            // them back out of it.
            // Both directions, because the tunnel is passive in both:
            // whatever is not carried resolves on the local network
            // otherwise, which is the leak this closes.
            carry_dns: true,
            // Overwritten by `redirect::start`, which stamps it when
            // interception actually begins -- the route probe and the
            // firewall wait sit between here and there.
            activated: Instant::now(),
        };

        // Recorded before anything can go wrong with it: if Custom mode
        // turns out to route nothing, the first question is always
        // whether it was pointed at the right adapter and the right
        // local address, and this is the only place that is written
        // down.
        // Whether any application is narrowed to particular
        // destinations is written down here for one reason: a scoped
        // app not being carried and an unscoped app not being carried
        // are the same symptom on a packet capture and two completely
        // different faults. Without this line the first question on the
        // rig cannot be answered from the evidence.
        //
        // It says only whether scoping is in play, never which
        // addresses. The list is the customer's own catalogue choice
        // and belongs in no log this may be asked to send anywhere.
        let scoped = self
            .selection
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .has_scopes();
        let header = format!(
            "custom mode ({direction}, {scoping}) on {adapter_name} (index {}, tunnel {tunnel_address})              via {local_addr}, node {node}, proxy tcp {} udp {}",
            tunnel_adapter.index,
            relays.tcp_port,
            relays.udp_port,
            direction = match mode {
                SplitTunnelMode::OnlySelected => "only the selected apps are tunnelled",
                SplitTunnelMode::AllExcept => "everything except the selected apps is tunnelled",
            },
            scoping = if scoped {
                "some apps narrowed to specific destinations"
            } else {
                "every selected app carried in full"
            }
        );

        // Cloned before the table is handed to the redirect loop: the
        // audit has to ask the same table the loop is filling, or it
        // would report every carried flow as an escape from itself.
        let audit = Audit {
            nat: nat.clone(),
            selection: self.selection.clone(),
            own_images: own_images(),
            node,
            proxy_ports: (relays.tcp_port, relays.udp_port),
            named: std::collections::HashSet::new(),
            last_run: Instant::now(),
        };

        // The same table the redirect loop fills and the audit reads,
        // held once more so the reset can ask it whether a row it is
        // about to close is one the tunnel is already carrying.
        let reset_nat = nat.clone();

        // Before the redirect starts, so there is no instant in which
        // Custom mode is on and nothing is refusing a selected app's
        // IPv6. Held in a local until the session is assembled: if
        // `redirect::start` fails below, this is dropped on the way out
        // and the filters go with it.
        let ipv6_apps = install_ipv6_app_block(&self.selection, log_dir, &log_path);

        let nat_for_active = nat.clone();
        match redirect::start(redirect, nat, self.selection.clone(), stats) {
            Ok(running) => {
                let logger =
                    Logger::start(log_path.clone(), running.stats.clone(), header, audit);

                // Only now, with the redirect actually running, so
                // that what an application reconnects into is the
                // tunnel rather than the ordinary route it just
                // left. Doing it earlier would simply hand it the
                // same connection back.
                let outcome = {
                    let selection = self.selection.read().expect("selection lock");
                    owner::reset_selected_connections(
                        &selection,
                        node,
                        &own_images(),
                        &|transport, port, destination, destination_port| {
                            reset_nat.has_flow(transport, port, destination, destination_port)
                        },
                    )
                };
                append(
                    &log_path,
                    &format!(
                        "closed {} existing connection(s) so they rebuild through the tunnel",
                        outcome.closed
                    ),
                );
                for failure in &outcome.failures {
                    append(&log_path, &format!("  reset: {failure}"));
                }

                // One pass cannot close a connection that is still in
                // SYN_SENT -- SetTcpEntry has no way to -- so keep
                // rescanning for the length of the redirect's activation
                // window. See Convergence.
                let convergence = Convergence::start(
                    self.selection.clone(),
                    log_path.clone(),
                    node,
                    own_images(),
                    reset_nat,
                    outcome.closed,
                );

                // Started last, with everything it watches already up,
                // so it cannot mistake a session still being assembled
                // for one whose tunnel has failed.
                let watchdog_tripped =
                    Arc::new(std::sync::atomic::AtomicBool::new(false));
                let watchdog = Watchdog::start(
                    adapter_name.to_string(),
                    tunnel_adapter.index,
                    tunnel_address,
                    tunnel.clone(),
                    running.stopper(),
                    log_path.clone(),
                    watchdog_tripped.clone(),
                );

                self.active = Some(Active {
                    redirect: running,
                    nat: nat_for_active,
                    relays,
                    allowance,
                    tunnel,
                    route,
                    logger,
                    convergence,
                    watchdog,
                    watchdog_tripped,
                    ipv6_apps,
                    log_path,
                    started: Instant::now(),
                });
                RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
            Err(e) => {
                relays.stop();
                let mut route = route;
                route.remove();
                Err(e)
            }
        }
    }

    /// Whether the tunnel is really carrying traffic, checked over the
    /// same kind of pinned socket a selected app's traffic uses.
    ///
    /// The app cannot answer this for itself in Custom mode: its own
    /// requests deliberately do not go through the tunnel, so its usual
    /// "did my address change" check correctly reports being bypassed
    /// and would fail every protocol in turn. See [`proxy::probe`].
    /// What the live counters say is wrong, or `None` when nothing is.
    ///
    /// Read from the real path under the customer's own traffic, which
    /// is the one thing [`Self::probe`] cannot do -- see
    /// [`redirect::Stats::complaint`]. Reported on every status poll
    /// rather than only at connect, because the numbers that matter are
    /// zero at connect and only become meaningful once the chosen apps
    /// have actually tried to send something.
    pub fn complaint(&self) -> Option<String> {
        let active = self.active.as_ref()?;
        // Ahead of the counters, because it explains them. Once the
        // backstop has switched interception off the numbers stop
        // moving, and "nothing is coming back" would be a true reading
        // pointed at the wrong cause.
        if active.watchdog_tripped.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(
                "The VPN adapter Custom mode was using disappeared, so it stopped \
                 redirecting and your applications are using your ordinary \
                 connection. Reconnect to protect them again."
                    .to_string(),
            );
        }
        active.redirect.stats.complaint(active.started.elapsed())
    }

    pub fn probe(&self) -> Result<(), String> {
        let Some(active) = &self.active else {
            return Err("custom mode is not running".into());
        };

        // Real traffic beats a synthetic connection. If the customer's
        // own packets are already proving the path is broken, say so in
        // their terms instead of opening a socket that tests a different
        // path and may well succeed.
        if let Some(problem) = active.redirect.stats.complaint(active.started.elapsed()) {
            append(&active.log_path, &format!("probe FAILED (counters): {problem}"));
            append(&active.log_path, &format!("  {}", active.redirect.stats.summary()));
            return Err(problem);
        }

        // `prove_carries`, not `probe`. The two ask different questions
        // and only one of them is fit to be turned into "You're
        // protected" on a customer's screen: `probe` completes a TCP
        // handshake, which under Xray's own `tun` inbound is answered by
        // xray.exe's userspace stack without a packet leaving the
        // machine, and which a REALITY server quietly proxying to its
        // decoy site satisfies just as readily as a working one.
        //
        // `prove_carries` requires a reply the destination had to send.
        // Route selection still uses `probe`: it is asking whether a
        // route shape can be attached to at all, which is exactly what a
        // handshake settles.
        let outcome = proxy::prove_carries(&active.tunnel);

        // Written down because this verdict is what decides whether the
        // ladder keeps this protocol or moves to the next one. Without
        // it the log showed a tunnel that looked healthy and gave no
        // hint why the app had abandoned it.
        match &outcome {
            Ok(()) => append(&active.log_path, "probe: the tunnel carried a test connection"),
            Err(e) => {
                append(&active.log_path, &format!("probe FAILED: {e}"));
                // The routing table, at the moment it mattered.
                //
                // Three rounds were spent reasoning about why a pinned
                // socket could not reach anything, each guess costing
                // the customer another build. What the guessing needed
                // and never had was the table the stack was actually
                // consulting, so it is written down here instead.
                for line in default_routes() {
                    append(&active.log_path, &format!("  route  {line}"));
                }
            }
        }
        outcome
    }

    pub fn stop(&mut self) {
        // Counted before the early return, so the count answers "was
        // this asked to stop", not "did it have something to stop".
        // The invariant under test is about the call being made.
        #[cfg(test)]
        self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let Some(active) = self.active.take() else { return };
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        // First of all, and before the join below can take any time:
        // the backstop must not be looking for a vanished adapter while
        // the session it would complain about is being taken down on
        // purpose. Stopping it is also what keeps `stop()` from being
        // joined by a thread it is itself joining.
        active.watchdog.stop();
        // Interception first. Stopping the relays while packets were
        // still being rewritten to them would send a selected app's
        // traffic to a port with nothing behind it -- a blackout rather
        // than the fail-open this promises.
        active.redirect.stop();
        // Before the relays, and for the same reason interception is
        // stopped before them: this thread closes customers' connections
        // on the assumption that a tunnel is there to rebuild them
        // through, and that assumption stops being true here.
        active.convergence.stop();
        active.relays.stop();
        let mut allowance = active.allowance;
        allowance.remove();
        active.logger.stop();
        let mut route = active.route;
        route.remove();
        // Last, so that at no point is Custom mode still intercepting
        // while a selected app's IPv6 has already been let out again.
        // Both blocks come off together as far as the customer is
        // concerned; the order only decides which way the overlap falls,
        // and the safe way is for the WFP one to outlast the loop.
        if let Some(mut block) = active.ipv6_apps {
            block.remove();
        }
    }
}

/// Installs the per-app IPv6 block for the current selection, or
/// explains in the log why it did not.
///
/// # Why a failure here is written down and not returned
///
/// Custom mode's job is to carry a selected application's **IPv4**
/// through the tunnel, and it does that whether or not these filters
/// exist. Refusing to start the feature because the filtering engine
/// would not take a filter would leave a customer in Iran with no
/// tunnel at all in exchange for closing a narrow IPv6 gap that
/// `redirect::handle_ipv6` still covers for every packet it can
/// attribute. That trade is the wrong way round, so this returns
/// `None` and says so on disk.
///
/// # Why "everything except these" gets nothing
///
/// In that mode the redirect loop's answer for a packet whose owner it
/// cannot see is already *block* --
/// `Selection::tunnel_when_owner_unknown` is true there -- so the hole
/// these filters close does not exist. The WFP shape for that mode
/// would be a machine-wide block with a hole per excluded application,
/// which is a much larger blast radius bought for nothing measured.
/// Stated rather than silently skipped.
fn install_ipv6_app_block(
    selection: &SharedSelection,
    log_dir: &Path,
    log_path: &Path,
) -> Option<ipv6_block::SelectedAppsIpv6Block> {
    let (mode, paths) = {
        let selection = selection.read().unwrap_or_else(|e| e.into_inner());
        (selection.mode(), selection.paths().to_vec())
    };

    if !matches!(mode, SplitTunnelMode::OnlySelected) {
        append(
            log_path,
            "IPv6: no per-app filters in this mode -- the redirect loop already blocks IPv6 \
             whose owner it cannot see when everything except the named apps is tunnelled",
        );
        return None;
    }
    if paths.is_empty() {
        return None;
    }

    match ipv6_block::SelectedAppsIpv6Block::install(&paths, log_dir) {
        Ok(block) => {
            append(
                log_path,
                &format!(
                    "IPv6: {} app(s) blocked at ALE_AUTH_CONNECT_V6 as well as in the loop",
                    paths.len()
                ),
            );
            Some(block)
        }
        Err(e) => {
            // Named as a reduction rather than as a failure, because
            // that is what it is: the loop still blocks everything it
            // can attribute.
            append(
                log_path,
                &format!(
                    "IPv6: per-app filters unavailable ({e}); the redirect loop is the only \
                     block this session has"
                ),
            );
            None
        }
    }
}

/// Waits for an adapter to exist *and* to have an address.
fn wait_for_addressed_adapter(name: &str) -> Result<adapters::Adapter, String> {
    let deadline = std::time::Instant::now() + ADAPTER_WAIT;
    loop {
        match adapters::find_by_name(name) {
            Ok(Some(adapter))
                if adapter
                    .ipv4
                    .is_some_and(|ip| proxy::can_attach(adapter.index, ip))
                    || (adapter.ipv4.is_some() && std::time::Instant::now() >= deadline) =>
            {
                return Ok(adapter)
            }
            Ok(_) if std::time::Instant::now() < deadline => {}
            Ok(_) => {
                return Err(format!(
                    "the tunnel adapter ({name}) never came up with an address, so \
                     selected apps had nowhere to send their traffic"
                ))
            }
            Err(e) => return Err(format!("could not enumerate network adapters: {e}")),
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// This service's own executable.
///
/// Excluded from redirection unconditionally. When no tunnel is up the
/// proxy's onward socket is unpinned and looks like any other
/// application's, so without this the proxy would intercept its own
/// traffic and hand it back to itself.
fn own_image_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Everything belonging to Neoxify itself, which must never be routed
/// through the tunnel Neoxify is managing.
///
/// The service was already here, because its own lookups being fed into
/// its own proxy took DNS out for the whole machine. **The app has the
/// same problem in "everything except these" mode** and it was missed:
/// in that mode anything the customer did not exclude is tunnelled, and
/// the app is not something a customer would think to exclude. Its
/// requests to the API then depend on the tunnel it is supposed to be
/// controlling.
///
/// Reported exactly that way -- the app span for twenty seconds, gave
/// up with "can't reach Neoxify right now", and then could not say
/// whether it was connected, while the browser beside it was plainly
/// going out through the VPN. A control panel must not lose contact
/// with the thing it controls because that thing is working.
///
/// The app sits one directory above the service, which lives in
/// `resources\`.
fn own_images() -> Vec<String> {
    let service = own_image_path();
    let mut images = vec![service.clone()];

    if let Some(app) = std::path::Path::new(&service)
        .parent()
        .and_then(|resources| resources.parent())
        .map(|root| root.join("neoconnect-desktop.exe"))
    {
        images.push(app.to_string_lossy().into_owned());
    }
    images
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

    /// A tunnel adapter that is present and well must never be read as
    /// gone. This is the case the backstop must not get wrong in the
    /// expensive direction -- tearing a working customer's Custom mode
    /// down would be an outage this code caused.
    fn adapter(index: u32, ipv4: Option<Ipv4Addr>, is_up: bool) -> adapters::Adapter {
        adapters::Adapter {
            index,
            name: "neoconnect".to_string(),
            gateway: None,
            ipv4,
            is_up,
            description: "WireGuard Tunnel".to_string(),
        }
    }

    const IDX: u32 = 20;
    fn addr() -> Ipv4Addr {
        Ipv4Addr::new(10, 66, 0, 2)
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

    #[test]
    fn a_healthy_tunnel_adapter_is_left_alone() {
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, Some(addr()), true)))),
            Liveness::Alive
        );
    }

    #[test]
    fn an_adapter_that_has_gone_is_reported_gone() {
        // The measured shape of the 2026-08-23 field bug: the WireGuard
        // tunnel service was uninstalled, the adapter went with it, and
        // the relays kept trying to bind to interface 20 / 10.66.0.2 --
        // "upstream attach FAILED for 1.1.1.1:53 ... (interface 20,
        // source 10.66.0.2)", several times a second, forever.
        assert_eq!(liveness(IDX, addr(), &Ok(None)), Liveness::Gone);
        // Present but down is the same thing from here.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, Some(addr()), false)))),
            Liveness::Gone
        );
        // Present, up, and no longer holding the address the relays bind
        // their upstream sockets to. Binding is what fails first, so an
        // adapter that kept its index and lost its address is just as
        // dead to this session.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, None, true)))),
            Liveness::Gone
        );
        // A same-named adapter that somebody else rebuilt. Not ours.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX + 1, Some(addr()), true)))),
            Liveness::Gone
        );
    }

    /// The control, and the reason `liveness` has three values rather
    /// than two.
    ///
    /// A `bool` implementation reading "not provably alive means dead"
    /// passes every assertion above and fails this one. Without it the
    /// whole matrix could not come back negative for the mistake most
    /// worth catching: an adapter enumeration that failed says nothing
    /// about the adapter, and treating it as death would let one
    /// unlucky syscall drop a working customer out of their tunnel.
    #[test]
    fn a_failed_enumeration_is_not_evidence_of_anything() {
        let failed = Err(std::io::Error::new(std::io::ErrorKind::Other, "GetAdaptersAddresses"));
        assert_eq!(liveness(IDX, addr(), &failed), Liveness::NoEvidence);
        assert_ne!(
            liveness(IDX, addr(), &failed),
            Liveness::Gone,
            "a query that failed must never be read as the tunnel having gone"
        );
    }

    /// One bad look is not enough, and the run has to be consecutive.
    #[test]
    fn the_backstop_needs_more_than_one_look() {
        assert!(WATCHDOG_STRIKES > 1, "a single unlucky look must not stop interception");
    }

    #[test]
    fn this_service_knows_its_own_executable() {
        // The self-exclusion depends on it. An empty string here would
        // match nothing, and the proxy would be free to intercept its
        // own upstream connections.
        let image = own_image_path();
        assert!(image.to_lowercase().ends_with(".exe"), "got {image}");
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
