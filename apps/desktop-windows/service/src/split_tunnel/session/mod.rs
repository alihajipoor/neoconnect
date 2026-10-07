//! One Custom-mode session: what bringing it up acquires, what it holds
//! while it runs, and the order it is taken down in.
//!
//! `SplitTunnel` holds at most one of these, in its `ActiveSlot`, and
//! asks it everything it knows about a running session. Everything that
//! outlives a session -- the customer's selection, the exit table the
//! engine layer writes, the restart notice -- stays on `SplitTunnel`.
//!
//! # Acquisition in order, teardown by drop
//!
//! Every part a session holds undoes itself when it is dropped, and the
//! session is nothing but those parts in the order they are taken down
//! -- see [`Session`]. So there is no `stop` to keep in step with
//! `start`: stopping is letting go, and the order is the field order.
//!
//! A bring-up that fails part way holds its parts in locals, and those
//! drop in the reverse of the order they were *declared* in, which is
//! arranged to be the order the old hand-written unwinds used -- see
//! [`Session::start`]. A panic anywhere in the bring-up is unwound by
//! the same drops, where it used to strand whatever had already started
//! -- interception included.
//!
//! The three orders are not the same, and need not be. Stopping a
//! running session: watchdog, interception, convergence, relays,
//! allowance, logger, route, IPv6 block. A step that fails: relays, IPv6
//! block, allowance, route -- interception never started. A panic after
//! interception started: whatever came after the relays, newest first
//! (convergence, logger, interception), then the same four. What all
//! three keep is what the customer depends on: the packet loop stops
//! before the relays it sends to, and the per-app IPv6 block comes off
//! after the loop. Each order has a test.
//!
//! The parts themselves come from [`Parts`], so the order can be tested
//! without Windows; [`Windows`] is the real thing.

mod convergence;
#[cfg(test)]
mod fake;
mod logger;
mod parts;
mod tunnel;
mod watchdog;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use neoconnect_ipc::SplitTunnelMode;

use crate::engines::ipv6_block;
use crate::split_tunnel::log_file::{append, LOG_FILE};
use crate::split_tunnel::net::pin::TunnelInterface;
use crate::split_tunnel::{flows, health, intercept, relay, SharedSelection};

use logger::Audit;
use parts::{Intercepting, Parts, Relaying};
pub(super) use parts::Windows;
use tunnel::default_routes;

/// The resolver every lookup is sent to while Custom mode is on.
///
/// The same one the tunnels push for a full tunnel, so this is not a
/// second opinion arriving through a different door -- it is already
/// reachable through every node. See `intercept::decide::is_dns` for why Custom
/// mode carries lookups at all.
const CUSTOM_MODE_RESOLVER: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);

/// A running Custom-mode session.
///
/// # The field order is the teardown
///
/// Rust drops a struct's fields in the order they are declared, and
/// every part below undoes itself in its `Drop`. So the first eight
/// fields are not a list of what a session has -- they are `stop`, the
/// ten-step sequence that used to be written out by hand with a comment
/// at each step saying why *that* position, now carried by the type.
/// The comments moved with the steps. Reordering these fields reorders
/// a disconnect; `a_session_is_taken_down_in_the_order_stop_always_used`
/// fails if that happens.
///
/// Before the first field drops, `ActiveSlot::take` has already cleared
/// the lock-free running flag, as `stop` always did first.
///
/// The parts nothing reads while the session runs are named with a
/// leading underscore, as this crate names everything held only for its
/// `Drop`.
pub(super) struct Session<P: Parts = Windows> {
    /// The backstop that switches interception off if the tunnel goes
    /// away without anybody noticing.
    ///
    /// First of all, and before the join below can take any time: the
    /// backstop must not be looking for a vanished adapter while the
    /// session it would complain about is being taken down on purpose.
    /// Stopping it is also what keeps the teardown from being joined by
    /// a thread it is itself joining.
    _watchdog: P::Watchdog,
    /// The packet loop.
    ///
    /// Interception before the relays. Stopping the relays while
    /// packets were still being rewritten to them would send a selected
    /// app's traffic to a port with nothing behind it -- a blackout
    /// rather than the fail-open this promises.
    interception: P::Interception,
    /// The reset loop that keeps closing pre-existing connections for
    /// the first seconds.
    ///
    /// Before the relays, and for the same reason interception is
    /// stopped before them: this thread closes customers' connections
    /// on the assumption that a tunnel is there to rebuild them
    /// through, and that assumption stops being true here.
    _convergence: P::Convergence,
    _relays: P::Relays,
    /// Held for its Drop: without it the stack accepts none of the
    /// redirected connections. See the firewall module.
    _allowance: P::Allowance,
    _logger: P::Logger,
    _route: P::Route,
    /// The per-app IPv6 block, when one could be installed.
    ///
    /// `None` is normal and not a fault: "everything except these" does
    /// not want one, and a machine where the filtering engine refuses
    /// still gets the redirect loop's own IPv6 block. See
    /// `engines::ipv6_block::SelectedAppsIpv6Block` for what it adds
    /// over that, and for why the same idea is unsound for IPv4.
    ///
    /// Last, so that at no point is Custom mode still intercepting
    /// while a selected app's IPv6 has already been let out again.
    /// Both blocks come off together as far as the customer is
    /// concerned; the order only decides which way the overlap falls,
    /// and the safe way is for the WFP one to outlast the loop.
    ipv6_apps: Option<P::Ipv6Block>,

    // Nothing below this line does anything when it is dropped.
    /// The flow tables the redirect loop decides against.
    ///
    /// Held here so a selection change can throw the leave-alone
    /// verdicts away -- see `set_selection`. It is the same `Arc` the
    /// loop, the relays and the audit hold; there is one table.
    nat: Arc<flows::Nat>,
    tunnel: Arc<TunnelInterface>,
    /// Set by the watchdog when it has stopped interception, so the
    /// status poll can say so instead of reporting a Custom mode that
    /// looks live and is not. Nothing in this product reports a state
    /// it has not verified, and "still intercepting" is such a state.
    watchdog_tripped: Arc<AtomicBool>,
    log_path: PathBuf,
    /// When interception began, so a warm-up is not mistaken
    /// for a fault. See intercept::stats::WARMUP.
    started: Instant,
    /// Where the parts came from, for the one that is rebuilt while the
    /// session runs -- the IPv6 block, on a selection change.
    parts: P,
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
/// `intercept::handle_ipv6_parsed` still covers for every packet it can
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

impl<P: Parts> Session<P> {
    /// Brings a session up against a tunnel that is already running
    /// passively -- the body of `SplitTunnel::start` once it has
    /// decided there is something to intercept.
    ///
    /// Each part is acquired in the order it always was, and nothing
    /// here unwinds by hand: a step that fails returns, and whatever was
    /// already acquired is released by being dropped on the way out.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn start(
        parts: P,
        adapter_name: &str,
        node: Ipv4Addr,
        log_dir: &Path,
        limits: &crate::lifecycle::budget::Limits,
        selection: &SharedSelection,
        exits: &Arc<relay::ExitRelays>,
        mode: SplitTunnelMode,
    ) -> Result<Self, String> {
        // Needed before the session is assembled, because choosing the
        // route writes to it.
        let log_path = log_dir.join(LOG_FILE);

        let tunnel_adapter = parts.wait_for_tunnel(adapter_name, limits)?;
        let tunnel_address = tunnel_adapter
            .ipv4
            .ok_or_else(|| format!("{adapter_name} came up without an address"))?;

        let uplink = parts.physical_uplink(adapter_name)?;
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
        let tunnel = Arc::new(TunnelInterface::new(tunnel_adapter.index, tunnel_address));

        // The route is chosen by trying it, not by predicting it. See
        // install_verified_route.
        let route =
            parts.install_route(tunnel_address, tunnel_adapter.index, &tunnel, &log_path, limits)?;

        // Declared here and filled further down, because a local is
        // dropped in the reverse of the order it was *declared* in, not
        // the order it was assigned. Declaring these two ahead of the
        // relays is what makes a bring-up that fails past this point
        // release what it holds exactly as the unwinds written out here
        // by hand used to: the relays first, then the IPv6 block, then
        // the firewall allowance, then the route. A local that was never
        // assigned is not dropped at all.
        //
        // Everything declared after the relays -- interception, the
        // logger, the convergence -- drops before them on a panic, which
        // is what keeps the packet loop from outliving the relays it
        // sends to. Declaring any of those three up here with these two
        // would break that, and only the panic test would notice.
        let allowance;
        let ipv6_apps;

        // Created here rather than inside `intercept::start`, because
        // the relay counts into the same table and the relay is started
        // first -- the firewall allowance and the reachability wait sit
        // between the two.
        let stats = Arc::new(intercept::Stats::default());
        let relays = parts
            .start_relays(nat.clone(), tunnel.clone(), stats.clone(), exits.clone())
            .map_err(|e| format!("could not start the local relay: {e}"))?;
        let (tcp_port, udp_port) = relays.ports();

        // Before the redirect starts, so that no packet is ever sent
        // to a port the firewall is still dropping.
        allowance = parts.allow(local_addr, tunnel_address, tcp_port, udp_port)?;

        // So the relay can report a datagram it had to drop. Set before
        // the redirect starts, because the first seconds are exactly
        // when it matters.
        relay::set_relay_log(log_path.clone());

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
        parts.wait_until_reachable(local_addr, tcp_port, limits)?;

        let redirect = intercept::Redirect {
            local_addr,
            local_interface: uplink.index,
            node_addr: node,
            tcp_proxy_port: tcp_port,
            udp_proxy_port: udp_port,
            own_images: own_images(),
            own_sockets: relays.own_sockets(),
            dns_resolver: CUSTOM_MODE_RESOLVER,
            // A full tunnel already resolves through the VPN, so there
            // is nothing to rescue and redirecting lookups would push
            // them back out of it.
            // Both directions, because the tunnel is passive in both:
            // whatever is not carried resolves on the local network
            // otherwise, which is the leak this closes.
            carry_dns: true,
            // Begun by `intercept::start` as interception starts -- the
            // route probe and the firewall wait sit between here and there.
            activated: intercept::Activation::pending(),
            exits: exits.clone(),
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
        let scoped = selection
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .has_scopes();
        let header = format!(
            "custom mode ({direction}, {scoping}) on {adapter_name} (index {}, tunnel {tunnel_address})              via {local_addr}, node {node}, proxy tcp {} udp {}",
            tunnel_adapter.index,
            tcp_port,
            udp_port,
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
            selection: selection.clone(),
            own_images: own_images(),
            node,
            proxy_ports: (tcp_port, udp_port),
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
        // `intercept::start` fails below, this is dropped on the way out
        // and the filters go with it.
        ipv6_apps = parts.block_ipv6(selection, log_dir, &log_path);

        let interception = parts.intercept(redirect, nat.clone(), selection.clone(), stats)?;

        let logger = parts.start_logger(log_path.clone(), interception.stats().clone(), header, audit);

        // Only now, with the redirect actually running, so
        // that what an application reconnects into is the
        // tunnel rather than the ordinary route it just
        // left. Doing it earlier would simply hand it the
        // same connection back.
        let outcome = {
            // Poison is survived here as it is at the other nine read
            // sites. This was once the site where it mattered most: a
            // panic between `intercept::start` returning and the
            // session being assembled left interception live,
            // `RUNNING` false, and nothing in `active` for `stop` to
            // take -- the stranded-background-tunnel complaint,
            // reachable from one unwrap. The unwind now drops the loop
            // with everything else acquired so far, so a panic here
            // would cost a failed connect rather than a stranded
            // machine. That is still a cost, so the read still survives
            // poison rather than paying it.
            let selection = selection.read().unwrap_or_else(|e| e.into_inner());
            parts.reset_connections(&selection, node, &own_images(), &reset_nat)
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
        let convergence = parts.converge(
            selection.clone(),
            log_path.clone(),
            node,
            own_images(),
            reset_nat,
            outcome.closed,
        );

        // Started last, with everything it watches already up,
        // so it cannot mistake a session still being assembled
        // for one whose tunnel has failed.
        let watchdog_tripped = Arc::new(AtomicBool::new(false));
        let watchdog = parts.watch(
            adapter_name.to_string(),
            tunnel_adapter.index,
            tunnel_address,
            tunnel.clone(),
            &interception,
            log_path.clone(),
            watchdog_tripped.clone(),
        );

        Ok(Session {
            _watchdog: watchdog,
            interception,
            _convergence: convergence,
            _relays: relays,
            _allowance: allowance,
            _logger: logger,
            _route: route,
            ipv6_apps,
            nat,
            tunnel,
            watchdog_tripped,
            log_path,
            started: Instant::now(),
            parts,
        })
    }

    /// What the live counters say is wrong, or `None` when nothing is.
    /// See `SplitTunnel::complaint`.
    pub(super) fn complaint(&self) -> Option<String> {
        // Ahead of the counters, because it explains them. Once the
        // backstop has switched interception off the numbers stop
        // moving, and "nothing is coming back" would be a true reading
        // pointed at the wrong cause.
        if self.watchdog_tripped.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(
                "The VPN adapter Custom mode was using disappeared, so it stopped \
                 redirecting and your applications are using your ordinary \
                 connection. Reconnect to protect them again."
                    .to_string(),
            );
        }
        self.interception.stats().complaint(self.started.elapsed())
    }

    /// Whether the tunnel is really carrying traffic. See
    /// `SplitTunnel::probe`.
    pub(super) fn probe(&self) -> Result<(), String> {
        // Real traffic beats a synthetic connection. If the customer's
        // own packets are already proving the path is broken, say so in
        // their terms instead of opening a socket that tests a different
        // path and may well succeed.
        if let Some(problem) = self.interception.stats().complaint(self.started.elapsed()) {
            append(&self.log_path, &format!("probe FAILED (counters): {problem}"));
            append(&self.log_path, &format!("  {}", self.interception.stats().summary()));
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
        let outcome = health::prove_carries(&self.tunnel);

        // Written down because this verdict is what decides whether the
        // ladder keeps this protocol or moves to the next one. Without
        // it the log showed a tunnel that looked healthy and gave no
        // hint why the app had abandoned it.
        match &outcome {
            Ok(()) => append(&self.log_path, "probe: the tunnel carried a test connection"),
            Err(e) => {
                append(&self.log_path, &format!("probe FAILED: {e}"));
                // The routing table, at the moment it mattered.
                //
                // Three rounds were spent reasoning about why a pinned
                // socket could not reach anything, each guess costing
                // the customer another build. What the guessing needed
                // and never had was the table the stack was actually
                // consulting, so it is written down here instead.
                for line in default_routes() {
                    append(&self.log_path, &format!("  route  {line}"));
                }
            }
        }
        outcome
    }

    /// Brings a running session in line with a selection the customer
    /// has just edited. See `SplitTunnel::set_selection`.
    pub(super) fn selection_changed(&mut self, selection: &SharedSelection) {
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
        self.nat.forget_direct();
        let log_dir = self.log_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        // Dropped first, and deliberately: two overlapping sets would
        // both be live, and the old one names applications that are no
        // longer selected. The gap is microseconds and the redirect
        // loop covers it, which is the same fail-open trade the rest of
        // this module makes.
        self.ipv6_apps = None;
        self.ipv6_apps = self.parts.block_ipv6(selection, &log_dir, &self.log_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_service_knows_its_own_executable() {
        // The self-exclusion depends on it. An empty string here would
        // match nothing, and the proxy would be free to intercept its
        // own upstream connections.
        let image = own_image_path();
        assert!(image.to_lowercase().ends_with(".exe"), "got {image}");
    }

    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
    use std::sync::{Barrier, RwLock};
    use std::time::Duration;

    use socket2::{Domain, Protocol, Socket, Type};

    use crate::split_tunnel::policy::Transport;
    use crate::split_tunnel::Selection;
    use fake::{Fake, Ledger};

    /// The order `stop` took a session down in when it was written out
    /// by hand, one comment per step. It is `Session`'s field order now,
    /// and this is what holds it there.
    const TEARDOWN: [&str; 8] =
        ["watchdog", "interception", "convergence", "relays", "allowance", "logger", "route", "ipv6"];

    /// The order the bring-up acquires them in, which this rewrite was
    /// not allowed to change.
    const BRING_UP: [&str; 8] =
        ["route", "relays", "allowance", "ipv6", "interception", "logger", "convergence", "watchdog"];

    /// A directory of this test run's own for the logs the real logger
    /// writes, so nothing lands beside the service's real ones.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neoxify-session-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    /// Brings up one stand-in session. The selection names a program no
    /// machine has, in "only these" mode, so nothing about it can match
    /// anything real.
    fn start(ledger: &Arc<Ledger>, session: usize, fail_at: Option<&'static str>, log_dir: &Path) -> Result<Session<Fake>, String> {
        let selection: SharedSelection = Arc::new(RwLock::new(Selection::new(
            vec![r"C:\Neoxify-test\not-a-real-game.exe".to_string()],
            SplitTunnelMode::OnlySelected,
        )));
        let limits = crate::lifecycle::budget::Limits::new(
            crate::lifecycle::cancel::CancelToken::new(),
            Duration::from_secs(30),
        );
        Session::start(
            Fake { ledger: ledger.clone(), session, fail_at },
            "Neoxify-test-tunnel",
            Ipv4Addr::new(203, 0, 113, 1),
            log_dir,
            &limits,
            &selection,
            &Arc::new(relay::ExitRelays::default()),
            SplitTunnelMode::OnlySelected,
        )
    }

    /// Everything a session acquired, it released -- once each.
    fn balanced(ledger: &Ledger, session: usize) -> bool {
        let mut acquired = ledger.acquired(session);
        let mut released = ledger.released(session);
        acquired.sort_unstable();
        released.sort_unstable();
        acquired == released
    }

    /// The order a disconnect takes a session down in.
    ///
    /// `stop` used to be ten steps written out by hand, four of them with
    /// a comment explaining why *that* position, and nothing checking any
    /// of it. Now it is the order `Session`'s fields are declared in, and
    /// this is the check: moving a field moves a step of every
    /// disconnect, and fails here.
    #[test]
    fn a_session_is_taken_down_in_the_order_stop_always_used() {
        let ledger = Arc::new(Ledger::default());
        let dir = scratch("order");
        let session = start(&ledger, 0, None, &dir).expect("a stand-in bring-up has nothing to fail on");
        assert_eq!(ledger.acquired(0), BRING_UP, "the bring-up's order moved");
        assert!(ledger.released(0).is_empty(), "nothing may be released while the session runs");

        drop(session);
        assert_eq!(ledger.released(0), TEARDOWN);
        assert!(balanced(&ledger, 0));
        assert!(ledger.still_held().is_empty(), "a thread outlived its session: {:?}", ledger.still_held());

        // The real logger writes its last line as it is joined, so the
        // line being there is the join having happened before the drop
        // returned -- not merely having been asked for.
        let log = std::fs::read_to_string(dir.join(LOG_FILE)).expect("the logger wrote its file");
        assert!(log.lines().any(|line| line.starts_with("stopped ")), "the logger was not joined: {log}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A bring-up that fails releases what it already holds, in the
    /// order the unwinds written out by hand at each failure used to.
    ///
    /// Those unwinds stopped the relays explicitly and left the rest to
    /// their `Drop`s, so the relays always went first and the route
    /// always last. The order now comes from the order the locals are
    /// declared in, and a declaration moved by somebody tidying up would
    /// change it without a compiler error -- hence one case per step that
    /// can fail.
    #[test]
    fn a_bring_up_that_fails_releases_what_it_holds_in_the_order_it_always_did() {
        let ledger = Arc::new(Ledger::default());
        let dir = scratch("unwind");
        let cases: [(&str, &[&str]); 5] = [
            ("route", &[]),
            ("relays", &["route"]),
            ("allowance", &["relays", "route"]),
            ("reachable", &["relays", "allowance", "route"]),
            ("interception", &["relays", "ipv6", "allowance", "route"]),
        ];
        for (n, (fail_at, expected)) in cases.into_iter().enumerate() {
            let outcome = start(&ledger, n, Some(fail_at), &dir);
            let Err(error) = outcome else { panic!("{fail_at}: a failing step must fail the bring-up") };
            assert!(error.contains("refused, as the test asked"), "{fail_at}: {error}");
            assert_eq!(ledger.released(n), expected, "{fail_at}: released in the wrong order");
            assert!(balanced(&ledger, n), "{fail_at}: acquired {:?}, released {:?}", ledger.acquired(n), ledger.released(n));
        }
        // The relay's error keeps the words it always had.
        let Err(error) = start(&ledger, 99, Some("relays"), &dir) else { unreachable!() };
        assert!(error.starts_with("could not start the local relay: "), "{error}");
        assert!(ledger.still_held().is_empty(), "a failed bring-up left a thread running: {:?}", ledger.still_held());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A bring-up that panics after interception started releases
    /// everything, with the packet loop stopped before the relays and
    /// the per-app IPv6 block outlasting it.
    ///
    /// Nothing in the bring-up should panic, and the supervisor catches
    /// it if something does -- so the cost of a panic here used to be
    /// interception left running with nothing that knew to stop it. Now
    /// the unwind stops it, in an order that is neither the disconnect's
    /// nor a failing step's: the parts acquired after the relays go
    /// first, newest first, then the four a failing step releases. That
    /// order comes from where each local is *declared*, and a declaration
    /// moved up beside `allowance` and `ipv6_apps` would put the packet
    /// loop after the relays it sends to with no other test noticing.
    #[test]
    fn a_bring_up_that_panics_stops_interception_before_the_relays() {
        let ledger = Arc::new(Ledger::default());
        let dir = scratch("panic");
        let cases: [(&str, &[&str]); 4] = [
            ("logger", &["interception", "relays", "ipv6", "allowance", "route"]),
            ("reset", &["logger", "interception", "relays", "ipv6", "allowance", "route"]),
            ("convergence", &["logger", "interception", "relays", "ipv6", "allowance", "route"]),
            ("watchdog", &["convergence", "logger", "interception", "relays", "ipv6", "allowance", "route"]),
        ];
        for (n, (panic_at, expected)) in cases.into_iter().enumerate() {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&ledger, n, Some(panic_at), &dir)));
            let Err(payload) = outcome else { panic!("{panic_at}: the bring-up was meant to panic") };
            let message = payload.downcast_ref::<String>().map(String::as_str).unwrap_or_default();
            assert!(message.contains("panicked, as the test asked"), "{panic_at}: a different panic: {message}");
            assert_eq!(ledger.released(n), expected, "{panic_at}: released in the wrong order");
            assert!(balanced(&ledger, n), "{panic_at}: acquired {:?}, released {:?}", ledger.acquired(n), ledger.released(n));
        }
        assert!(ledger.still_held().is_empty(), "a panicked bring-up left a thread running: {:?}", ledger.still_held());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One TCP connection and one UDP flow carried through a session's
    /// real relays, to far ends on this machine that never hang up.
    struct Carrying {
        /// Both sides of the TCP connection. Each must see it end when
        /// the session is dropped: nothing else would ever end it.
        app: TcpStream,
        far_end: TcpStream,
        /// The relay's onward UDP socket, as the far end saw it.
        upstream: SocketAddr,
    }

    /// Records a flow in a session's table, as the packet loop would,
    /// and returns the synthetic port it was given.
    fn record_flow(nat: &flows::Nat, transport: Transport, destination: SocketAddrV4) -> io::Result<u16> {
        let origin = flows::Origin {
            addr: *destination.ip(),
            port: destination.port(),
            client: Ipv4Addr::LOCALHOST,
            client_port: 40000,
            interface_id: 1,
            upstream: None,
            exit: None,
        };
        nat.redirect(transport, origin).ok_or_else(|| io::Error::other("the flow table is full"))
    }

    fn v4(address: io::Result<SocketAddr>) -> io::Result<SocketAddrV4> {
        match address? {
            SocketAddr::V4(v4) => Ok(v4),
            SocketAddr::V6(v6) => Err(io::Error::other(format!("bound to {v6}"))),
        }
    }

    fn because<T>(what: &str, result: io::Result<T>) -> io::Result<T> {
        result.map_err(|e| io::Error::new(e.kind(), format!("{what}: {e}")))
    }

    /// Carries one connection and one flow through `session`'s relays,
    /// standing in for the packet loop the way the relay's own tests do:
    /// the flow is recorded by hand and the application's socket is bound
    /// to the synthetic port the loop would have rewritten it to.
    fn carry(session: &Session<Fake>) -> io::Result<Carrying> {
        let (tcp_port, udp_port) = session._relays.ports();
        let patient = Some(Duration::from_secs(10));

        // TCP, to a far end that reads and never answers or hangs up.
        let quiet = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let quiet_at = v4(quiet.local_addr())?;
        let (accepted, far_end) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = quiet.accept() {
                let _ = accepted.send(stream);
            }
        });
        let nat_port = record_flow(&session.nat, Transport::Tcp, quiet_at)?;
        let source = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        // Shared, as in the relay's tests: every session's table hands
        // out the same first port, and each connects to its own relay.
        source.set_reuse_address(true)?;
        source.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, nat_port)).into())?;
        because("connect to the relay", source.connect(&SocketAddr::from((Ipv4Addr::LOCALHOST, tcp_port)).into()))?;
        let mut app: TcpStream = source.into();
        app.write_all(b"hello")?;
        let mut far_end = far_end
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| io::Error::other("the relay never dialled the far end"))?;
        far_end.set_read_timeout(patient)?;
        because("the far end hearing the application", far_end.read_exact(&mut [0u8; 5]))?;

        // UDP, to a far end that answers once and remembers who asked.
        let echo = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
        echo.set_read_timeout(patient)?;
        let echo_at = v4(echo.local_addr())?;
        // Bound without sharing, and retried on a new flow when that
        // fails: a shared UDP port would deliver each reply to whichever
        // session's socket Windows liked. See the relay's `udp_flow`.
        let mut app_udp = None;
        for _ in 0..64 {
            let nat_port = record_flow(&session.nat, Transport::Udp, echo_at)?;
            if let Ok(socket) = UdpSocket::bind((Ipv4Addr::LOCALHOST, nat_port)) {
                app_udp = Some(socket);
                break;
            }
        }
        let app_udp = app_udp.ok_or_else(|| io::Error::other("no synthetic port could be bound for a UDP flow"))?;
        app_udp.set_read_timeout(patient)?;
        app_udp.send_to(b"ping", (Ipv4Addr::LOCALHOST, udp_port))?;
        let mut buffer = [0u8; 16];
        let (len, upstream) = because("the far end hearing the datagram", echo.recv_from(&mut buffer))?;
        echo.send_to(&buffer[..len], upstream)?;
        let (len, _) = because("the reply coming back", app_udp.recv_from(&mut buffer))?;
        if &buffer[..len] != b"ping" {
            return Err(io::Error::other(format!("the reply came back as {:?}", &buffer[..len])));
        }
        Ok(Carrying { app, far_end, upstream })
    }

    /// Whether a connection has ended, rather than merely gone quiet.
    fn ended(stream: &mut TcpStream) -> bool {
        if stream.set_read_timeout(Some(Duration::from_secs(3))).is_err() {
            return true;
        }
        match stream.read(&mut [0u8; 1]) {
            Ok(n) => n == 0,
            Err(e) => !matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock),
        }
    }

    /// Whether a UDP port is free for the taking within `within`: the
    /// socket that held it has been closed.
    fn released(port: SocketAddr, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            if UdpSocket::bind(port).is_ok() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// What one session in `many_sessions_...` still holds, if anything.
    fn held_by(ledger: &Ledger, session: usize) -> Vec<&'static str> {
        ledger.still_held().into_iter().filter(|(n, _)| *n == session).map(|(_, what)| what).collect()
    }

    /// Many sessions brought up and torn down at once leave nothing
    /// behind: every stand-in route, rule and block released exactly
    /// once and in order, every thread finished, every connection a
    /// relay carried closed, and every relay port -- TCP and UDP --
    /// closed.
    ///
    /// Concurrent on purpose. The relay's stop once passed every
    /// single-instance test and left a connection open in 8 to 20 of 32
    /// stops made at once (see `relay::Carried`), so a teardown here is
    /// asked the question both ways -- and half the sessions are carrying
    /// a TCP connection and a UDP flow through their real relays when
    /// they are dropped, so the closing that hazard was about happens
    /// here, from a session's drop, rather than only in the relay's own
    /// tests. A quarter fail as interception would, and begin their
    /// bring-ups only once the others start coming down, so their unwinds
    /// run among the others' teardowns rather than on their own.
    ///
    /// "Every thread finished" is measured, not inferred: each session's
    /// flow table, counters and tunnel record are handed to its relay
    /// threads, its logger and the stand-ins for its other threads, and
    /// once a session is gone nothing may still hold any of them. A thread
    /// left running would. For a session that carried nothing that is
    /// checked the moment its drop returns, which is what catches a thread
    /// that was signalled and not joined.
    ///
    /// A carrying session is not held to that, because the relay does not
    /// join a carried connection's threads -- see `Relays`' `Drop`. What it
    /// is held to: both ends of the TCP connection see it end the moment
    /// the session is dropped, the relay's onward UDP socket is gone
    /// within three seconds (a UDP reader notices within one read
    /// timeout), and once the two ends have closed their sockets in turn,
    /// as an application and a server answer a close, every thread is
    /// gone within three seconds more. Not sooner: the copy threads stay
    /// in their reads until the far ends close -- measured, 16 of 16 still
    /// there twenty seconds after the drop with both ends held open.
    #[test]
    fn many_sessions_started_and_stopped_at_once_leave_nothing_behind() {
        const N: usize = 32;
        let ledger = Arc::new(Ledger::default());
        let dir = scratch("many");
        let gate = Arc::new(Barrier::new(N));
        let fails = |n: usize| n % 4 == 3;
        let carries = |n: usize| n % 4 == 1 || n % 4 == 2;
        let grace = Duration::from_secs(3);

        let threads: Vec<_> = (0..N)
            .map(|n| {
                let (ledger, gate, dir) = (ledger.clone(), gate.clone(), dir.clone());
                std::thread::spawn(move || -> Result<(), String> {
                    gate.wait();
                    let up = (!fails(n)).then(|| start(&ledger, n, None, &dir));
                    let carrying = match &up {
                        Some(Ok(session)) if carries(n) => Some(carry(session)),
                        _ => None,
                    };
                    // Every session that comes up is up, and carrying
                    // what it carries, before any of them is taken down.
                    // Nothing above returns early, or the others would
                    // wait here for good.
                    gate.wait();
                    let failed = fails(n).then(|| start(&ledger, n, Some("interception"), &dir).map(drop));
                    let up = up.map(|outcome| outcome.map(drop));
                    match (&up, &failed) {
                        (Some(Ok(())), None) | (None, Some(Err(_))) => {}
                        _ => return Err(format!("session {n}: brought up {up:?}, failing bring-up {failed:?}")),
                    }

                    let Some(carrying) = carrying else {
                        let held = held_by(&ledger, n);
                        if !held.is_empty() {
                            return Err(format!("session {n}: a thread outlived its drop, still holding {held:?}"));
                        }
                        return Ok(());
                    };
                    let mut carrying = carrying.map_err(|e| format!("session {n} could not carry a connection: {e}"))?;
                    if !ended(&mut carrying.app) {
                        return Err(format!("session {n}: the application's side of a carried connection outlived it"));
                    }
                    if !ended(&mut carrying.far_end) {
                        return Err(format!("session {n}: the upstream side of a carried connection outlived it"));
                    }
                    if !released(carrying.upstream, grace) {
                        return Err(format!("session {n}: the relay's onward UDP socket {} outlived it", carrying.upstream));
                    }
                    // Each side answers the close by closing, as an
                    // application and a server do. Not before: the
                    // relay's copy threads wait for exactly that.
                    drop(carrying);
                    let deadline = Instant::now() + grace;
                    while !held_by(&ledger, n).is_empty() && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let held = held_by(&ledger, n);
                    if !held.is_empty() {
                        return Err(format!("session {n}: a carried connection's thread never finished, still holding {held:?}"));
                    }
                    Ok(())
                })
            })
            .collect();
        let failures: Vec<String> =
            threads.into_iter().filter_map(|thread| thread.join().expect("a session thread panicked").err()).collect();
        assert!(failures.is_empty(), "{} of {N} sessions left something behind: {failures:#?}", failures.len());

        for n in 0..N {
            let expected: &[&str] = if fails(n) { &["relays", "ipv6", "allowance", "route"] } else { &TEARDOWN };
            assert_eq!(ledger.released(n), expected, "session {n} was taken down out of order");
            assert!(balanced(&ledger, n), "session {n}: acquired {:?}, released {:?}", ledger.acquired(n), ledger.released(n));
        }

        // A listener on loopback answers a connect at once, so anything
        // other than a connection inside half a second is a port nobody
        // is listening on. Knocked on in parallel, because Windows
        // retries a refused loopback connect for about two seconds before
        // it says so, and thirty-two of those in a row is a minute.
        //
        // The UDP port is tried by binding it. A carried flow's reader
        // holds the relay's UDP socket to send replies on, and lets go
        // within one read timeout of the stop, hence the grace.
        let ports = ledger.relay_ports();
        assert_eq!(ports.len(), N, "every session started real relays");
        let knocks: Vec<_> = ports
            .into_iter()
            .map(|(n, tcp, udp)| {
                std::thread::spawn(move || {
                    let open = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, tcp).into(), Duration::from_millis(500));
                    (n, tcp, open.is_ok(), udp, released(SocketAddr::from((Ipv4Addr::UNSPECIFIED, udp)), grace))
                })
            })
            .collect();
        for knock in knocks {
            let (n, tcp, open, udp, udp_released) = knock.join().unwrap();
            assert!(!open, "session {n}'s relay is still accepting on TCP port {tcp}");
            assert!(udp_released, "session {n}'s relay still holds UDP port {udp}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
