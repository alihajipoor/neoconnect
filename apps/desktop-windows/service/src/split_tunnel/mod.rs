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
mod firewall;
mod flows;
mod owner;
mod proxy;
mod redirect;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use neoconnect_ipc::SplitTunnelMode;

use crate::adapters;
use crate::engines::routing::{self, InstalledRoutes};

pub use owner::{running_apps, Selection, SharedSelection};

/// How long to wait for a tunnel adapter to appear and be given an
/// address after its engine starts.
///
/// The adapter and its address arrive separately, and a socket pinned to
/// an interface with no address of its own has nothing to use as a
/// source -- so both have to be there before the proxy is any use.
const ADAPTER_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

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
    log_path: PathBuf,
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
    fn start(path: PathBuf, stats: Arc<redirect::Stats>, header: String) -> Self {
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

        let redirect = redirect::Redirect {
            local_addr,
            local_interface: uplink.index,
            node_addr: node,
            tcp_proxy_port: relays.tcp_port,
            udp_proxy_port: relays.udp_port,
            own_image: own_image_path(),
            dns_resolver: CUSTOM_MODE_RESOLVER,
            // A full tunnel already resolves through the VPN, so there
            // is nothing to rescue and redirecting lookups would push
            // them back out of it.
            // Both directions, because the tunnel is passive in both:
            // whatever is not carried resolves on the local network
            // otherwise, which is the leak this closes.
            carry_dns: true,
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

        match redirect::start(redirect, nat, self.selection.clone()) {
            Ok(running) => {
                let logger = Logger::start(log_path.clone(), running.stats.clone(), header);
                self.active = Some(Active {
                    redirect: running,
                    relays,
                    allowance,
                    tunnel,
                    route,
                    logger,
                    log_path,
                });
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
    pub fn probe(&self) -> Result<(), String> {
        let Some(active) = &self.active else {
            return Err("custom mode is not running".into());
        };
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
        // Interception first. Stopping the relays while packets were
        // still being rewritten to them would send a selected app's
        // traffic to a port with nothing behind it -- a blackout rather
        // than the fail-open this promises.
        active.redirect.stop();
        active.relays.stop();
        let mut allowance = active.allowance;
        allowance.remove();
        active.logger.stop();
        let mut route = active.route;
        route.remove();
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
