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

use neoconnect_ipc::SplitTunnelMode;

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
    active: Option<Active>,
}

struct Active {
    redirect: redirect::Running,
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
        Self { enabled: false, selection: SharedSelection::default(), active: None }
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
    pub fn set_selection(&mut self, enabled: bool, apps: Vec<String>, mode: SplitTunnelMode) {
        self.enabled = enabled;
        *self.selection.write().unwrap_or_else(|e| e.into_inner()) = Selection::new(apps, mode);

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
        let log_dir = active.log_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        // Dropped first, and deliberately: two overlapping sets would
        // both be live, and the old one names applications that are no
        // longer selected. The gap is microseconds and the redirect
        // loop covers it, which is the same fail-open trade the rest of
        // this module makes.
        active.ipv6_apps = None;
        active.ipv6_apps = install_ipv6_app_block(&self.selection, &log_dir, &active.log_path);
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
    /// Distinct from `wants_passive_tunnel` because "everything except
    /// these" needs a *full* tunnel with interception on top: the tunnel
    /// carries the machine as usual and the chosen applications are
    /// pushed out of it. Asking the passive question there would answer
    /// no and leave the excluded applications tunnelled, which is the
    /// setting doing nothing.
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
        // of, and it is the only thing that differs between the two
        // directions.
        //
        // Tunnelling the chosen applications means pinning to the VPN
        // adapter, with the tunnel itself passive so nothing else uses
        // it. Excluding them means the opposite in both halves: the
        // tunnel stays full and carries the machine as usual, and the
        // redirected connections are pinned to the physical link so they
        // leave the way they would with no VPN at all. The rewriting,
        // the NAT and the return leg are identical either way.
        let tunnel =
            Arc::new(proxy::TunnelInterface::new(tunnel_adapter.index, tunnel_address));

        // The route is chosen by trying it, not by predicting it. See
        // install_verified_route.
        let route =
            install_verified_route(tunnel_address, tunnel_adapter.index, &tunnel, &log_path)?;
        let relays = match proxy::start(nat.clone(), tunnel.clone()) {
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
        let header = format!(
            "custom mode ({direction}) on {adapter_name} (index {}, tunnel {tunnel_address})              via {local_addr}, node {node}, proxy tcp {} udp {}",
            tunnel_adapter.index,
            relays.tcp_port,
            relays.udp_port,
            direction = match mode {
                SplitTunnelMode::OnlySelected => "only the selected apps are tunnelled",
                SplitTunnelMode::AllExcept => "everything except the selected apps is tunnelled",
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

        match redirect::start(redirect, nat, self.selection.clone()) {
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

                self.active = Some(Active {
                    redirect: running,
                    relays,
                    allowance,
                    tunnel,
                    route,
                    logger,
                    convergence,
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

        let outcome = proxy::probe(&active.tunnel);

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

    /// Marks that no tunnel is available, so redirected traffic goes out
    /// unprotected instead of failing. See the fail-open note above.
    pub fn detach_tunnel(&self) {
        if let Some(active) = &self.active {
            active.tunnel.clear();
        }
    }

    pub fn stop(&mut self) {
        let Some(active) = self.active.take() else { return };
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
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

    #[test]
    fn an_empty_selection_does_not_shape_the_tunnel() {
        // The toggle being on with nothing chosen must not be read as
        // "tunnel everything" -- that is the opposite of Custom mode,
        // and it would arrive as a surprise full tunnel.
        let mut split = SplitTunnel::new();
        split.set_selection(true, Vec::new(), SplitTunnelMode::OnlySelected);
        assert!(!split.wants_passive_tunnel());

        split.set_selection(true, vec![r"C:\Games\game.exe".into()], SplitTunnelMode::OnlySelected);
        assert!(split.wants_passive_tunnel());

        split.set_selection(false, vec![r"C:\Games\game.exe".into()], SplitTunnelMode::OnlySelected);
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
    fn this_service_knows_its_own_executable() {
        // The self-exclusion depends on it. An empty string here would
        // match nothing, and the proxy would be free to intercept its
        // own upstream connections.
        let image = own_image_path();
        assert!(image.to_lowercase().ends_with(".exe"), "got {image}");
    }
}
