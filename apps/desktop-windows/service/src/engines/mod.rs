//! Engine lifecycle: bringing one VPN protocol up, tearing it down, and
//! reporting what is actually running.
//!
//! Every engine here is a real, official upstream binary (wireguard.exe,
//! xray.exe, openvpn.exe) rather than a reimplementation -- the same
//! philosophy the server-side agent was built on. This module's whole
//! job is to write the right config file and drive the right process,
//! invisibly.

mod dns;
mod ikev2;
mod ipv6_block;
mod janitor;
mod ras;
mod openvpn;
pub mod routing;
mod wireguard;
mod xray;

use ipv6_block::Ipv6Block;
use routing::InstalledRoutes;

use std::io;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use neoconnect_ipc::{ConnectProfile, SplitTunnelMode, TunnelHealth};

use crate::adapters;
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
    /// Windows owns the IKEv2 tunnel: it is a RAS phonebook entry, not a
    /// process, so there is nothing here to hold. Liveness is asked of
    /// the operating system, the same way WireGuard's is asked of the
    /// service manager.
    Ikev2,
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

pub struct Engines {
    exe_dir: PathBuf,
    config_dir: PathBuf,
    active: Option<Active>,
    /// Custom mode. Owned here because this is the only component that
    /// knows which protocol is live, and the split tunnel has to follow
    /// it -- an implementation bound to one adapter would stop working
    /// the moment failover moved the customer, and would do it silently.
    split_tunnel: SplitTunnel,
    /// The machine-wide IPv6 block that goes with a full tunnel.
    ///
    /// `Some` exactly while it is installed, which is what the status
    /// poll reports to the app -- the customer is told IPv6 is blocked
    /// because it *is* blocked, not because the protocol usually implies
    /// it. See `ipv6_block` for the measurement, and for why WireGuard
    /// is the one engine that never has one here.
    ipv6_block: Option<Ipv6Block>,
    /// The profile the live tunnel was built from.
    ///
    /// Kept so Custom mode can be switched without the customer
    /// reconnecting by hand: whether a tunnel is passive or full is
    /// decided when the engine starts, so changing the mode means
    /// building it again, and that needs the profile back.
    last_profile: Option<ConnectProfile>,
}

impl Engines {
    pub fn new(exe_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            exe_dir,
            config_dir,
            active: None,
            split_tunnel: SplitTunnel::new(),
            ipv6_block: None,
            last_profile: None,
        }
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
    pub fn set_split_tunnel(
        &mut self,
        enabled: bool,
        apps: Vec<String>,
        mode: SplitTunnelMode,
    ) -> Result<(), String> {
        let was_passive = self.split_tunnel.wants_passive_tunnel();
        let was_intercepting = self.split_tunnel.wants_interception();
        let was_mode = self.split_tunnel.mode();
        self.split_tunnel.set_selection(enabled, apps, mode);
        let now_passive = self.split_tunnel.wants_passive_tunnel();
        let now_intercepting = self.split_tunnel.wants_interception();
        let now_mode = self.split_tunnel.mode();

        if self.active.is_none() {
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
                let Some(profile) = self.last_profile.clone() else {
                    return Err(
                        "Custom mode changed, but this tunnel cannot be rebuilt without reconnecting."
                            .to_string(),
                    );
                };
                self.split_tunnel.stop();
                return self.start_split_tunnel(&profile);
            }
            // Editing the list within a mode changes nothing about how
            // the tunnel is built, and the redirect reads the selection
            // per packet.
            return Ok(());
        }
        let Some(profile) = self.last_profile.clone() else {
            // Nothing to rebuild from. Saying so is better than leaving
            // the customer with a tunnel that contradicts the toggle.
            return Err(
                "Custom mode changed, but this tunnel cannot be rebuilt without reconnecting."
                    .to_string(),
            );
        };
        self.connect(&profile)
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
        self.ipv6_block.is_some()
    }

    /// What Custom mode's packet counters say is wrong, for the status
    /// poll. `None` while it is healthy or not running.
    pub fn split_tunnel_complaint(&self) -> Option<String> {
        self.split_tunnel.complaint()
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
    pub fn connect(&mut self, profile: &ConnectProfile) -> Result<(), String> {
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
        let result = self.connect_inner(profile).map_err(|e| with_rival_hint(e, &rivals));
        // Remembered only on success, so a failed attempt cannot leave a
        // profile behind for Custom mode to rebuild from.
        if result.is_ok() {
            self.last_profile = Some(profile.clone());
        }
        result
    }

    fn connect_inner(&mut self, profile: &ConnectProfile) -> Result<(), String> {
        profile.validate().map_err(|e| e.to_string())?;
        self.disconnect()?;
        // Checked between the stages as well as inside the waits, so a
        // customer who pressed Disconnect gets the tunnel left down
        // rather than watching it come back up because the request that
        // was already running finished its job.
        if abandoned() {
            return Err(ABANDONED.to_string());
        }

        // Decided once, up front. Every engine below has to know whether
        // to install its own routes, and asking again per branch invites
        // one of them to disagree -- which would show up as a full
        // tunnel for a customer who asked for one app.
        let passive = self.split_tunnel.wants_passive_tunnel();

        match profile {
            ConnectProfile::Wireguard(p) => {
                wireguard::connect(self, p, passive)?;
                self.active = Some(Active::WireguardTunnel);
            }
            // Nothing is spawned: Windows brings the interface up and
            // routes it. Custom mode works here too now -- the entry is
            // created with -SplitTunneling so Windows leaves the default
            // route alone, and the split tunnel pins to the RAS
            // interface like it pins to any other adapter.
            ConnectProfile::Ikev2(p) => {
                ikev2::connect(p, passive)?;
                self.active = Some(Active::Ikev2);
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

                let mut child = xray::connect(self, &outbound, passive)?;
                // Xray creates the adapter but routes nothing into it, so
                // the tunnel is inert until this succeeds. Failing here
                // must take the engine down with it rather than leave a
                // process running that reports connected and carries no
                // traffic. In Custom mode the adapter still has to be
                // given an address -- a socket pinned to an interface
                // with none has no source to send from -- but nothing is
                // routed into it.
                let prepared = if passive {
                    xray::prepare_passive(&outbound).map(|_| InstalledRoutes::none())
                } else {
                    xray::install_routes(&outbound)
                };
                let routes = match prepared {
                    Ok(routes) => routes,
                    Err(e) => {
                        let _ = child.kill();
                        reap(&mut child);
                        return Err(e);
                    }
                };
                self.active = Some(Active::Child {
                    protocol,
                    child,
                    routes,
                });
            }
            ConnectProfile::Openvpn(p) => {
                let child = openvpn::connect(self, p, passive)?;
                self.active = Some(Active::Child {
                    protocol: "OPENVPN",
                    child,
                    routes: InstalledRoutes::none(),
                });
            }
        }

        // Interception, not passivity. "Everything except these"
        // deliberately builds a *full* tunnel and then pushes the chosen
        // applications out of it, so asking whether the tunnel is
        // passive answers no and skips the redirect entirely -- which
        // presents as the excluded applications still being tunnelled,
        // the setting doing nothing at all.
        if abandoned() {
            let _ = self.disconnect();
            return Err(ABANDONED.to_string());
        }
        if self.split_tunnel.wants_interception() {
            self.start_split_tunnel(profile)?;
        }
        self.block_ipv6_if_needed(profile);
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
        self.ipv6_block = None;
        if self.split_tunnel.wants_interception() || !ipv6_block::needed_for(profile) {
            return;
        }
        match Ipv6Block::install(&self.config_dir) {
            Ok(block) => self.ipv6_block = Some(block),
            Err(e) => eprintln!("IPv6 could not be blocked for this tunnel: {e}"),
        }
    }

    /// Brings Custom mode up against the tunnel that was just started.
    ///
    /// A failure here tears the engine down rather than leaving it
    /// running. A passive tunnel with no redirect carries nothing at
    /// all, so reporting success would tell the customer they were
    /// protected while every application, selected or not, went out in
    /// the clear.
    fn start_split_tunnel(&mut self, profile: &ConnectProfile) -> Result<(), String> {
        let adapter = adapter_name_for(profile);
        let node = match node_address(profile) {
            Ok(node) => node,
            Err(e) => {
                let _ = self.disconnect();
                return Err(e);
            }
        };

        let log_dir = self.config_dir.clone();
        if let Err(e) = self.split_tunnel.start(adapter, node, &log_dir) {
            let _ = self.disconnect();
            return Err(e);
        }
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
        // Before the engine, so no packet is ever rewritten towards a
        // proxy whose upstream has just lost its tunnel. Stopping the
        // redirect also restores ordinary routing for the selected apps,
        // which is the state they should be left in.
        self.split_tunnel.stop();
        // Before the engine too, and unconditionally. Dropping the
        // handle ends the dynamic WFP session, which is what removes the
        // filters -- `Ipv6Block::remove` runs from `Drop`, so taking the
        // Option is the removal and doing it twice is a no-op.
        //
        // The same property is what makes a crash safe: the session
        // belongs to this process, so the kernel tears it down when the
        // process dies whether or not any of this code ran. There is
        // deliberately no boot-time or persistent filter that could
        // survive to strand a customer's networking.
        if let Some(mut block) = self.ipv6_block.take() {
            block.remove();
        }
        // Dropped with the tunnel: a Custom-mode toggle after a disconnect
        // must not resurrect a connection the customer ended.
        self.last_profile = None;

        let result = match self.active.take() {
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
                janitor::reconcile(&self.exe_dir);
                Ok(())
            }
            Some(Active::WireguardTunnel) => wireguard::disconnect(self),
            Some(Active::Ikev2) => ikev2::disconnect(),
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
        match &mut self.active {
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
                    (true, Some("WIREGUARD".to_string()), TunnelHealth::Unknown)
                } else if ikev2::is_connected() {
                    (true, Some("IKEV2".to_string()), TunnelHealth::Unknown)
                } else {
                    (false, None, TunnelHealth::Down)
                }
            }
            Some(Active::Ikev2) => {
                // Windows owns this tunnel, so its own view is the only
                // truth available. There is no handshake to read the way
                // WireGuard has, so health stays Unknown and the app's
                // egress check is what actually proves traffic flows --
                // the same position the Xray protocols are in.
                let up = ikev2::is_connected();
                (
                    up,
                    Some("IKEV2".to_string()),
                    if up {
                        TunnelHealth::Unknown
                    } else {
                        TunnelHealth::Down
                    },
                )
            }
            Some(Active::WireguardTunnel) => {
                if wireguard::tunnel_is_running() {
                    let health = match wireguard::handshake_health(self) {
                        wireguard::HandshakeHealth::Alive { age_secs } => {
                            TunnelHealth::Alive { age_secs }
                        }
                        wireguard::HandshakeHealth::Stale { age_secs } => {
                            TunnelHealth::Stale { age_secs }
                        }
                        wireguard::HandshakeHealth::NeverHandshaked => {
                            TunnelHealth::NeverHandshaked
                        }
                        wireguard::HandshakeHealth::Unknown => TunnelHealth::Unknown,
                    };
                    (true, Some("WIREGUARD".into()), health)
                } else {
                    self.active = None;
                    (false, None, TunnelHealth::Down)
                }
            }
            Some(Active::Child {
                protocol,
                child,
                routes,
            }) => match child.try_wait() {
                // `Ok(Some(_))` means it has already exited.
                Ok(Some(_)) | Err(_) => {
                    // An engine that died on its own leaves its routes
                    // behind pointing at an adapter that no longer
                    // exists, which black-holes traffic. Clean up as soon
                    // as we notice, not only on an explicit disconnect.
                    routes.remove();
                    self.active = None;
                    // The tunnel this was pinned to has gone. Selected
                    // apps fall back to the ordinary route rather than
                    // failing, which is the decided behaviour -- and the
                    // UI is responsible for saying so.
                    self.split_tunnel.detach_tunnel();
                    (false, None, TunnelHealth::Down)
                }
                // Xray and OpenVPN have no equivalent of WireGuard's
                // handshake timestamp available this cheaply, so this
                // reports Unknown rather than implying evidence that was
                // never gathered. The app's egress check covers them.
                Ok(None) => (true, Some((*protocol).to_string()), TunnelHealth::Unknown),
            },
        }
    }
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
fn node_address(profile: &ConnectProfile) -> Result<Ipv4Addr, String> {
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
    // connection failed with "could not resolve de1.neoxify.site: No
    // such host is known", on a machine whose DNS was working before and
    // after. One retry loop is the difference between Custom mode
    // working on OpenVPN and not.
    let deadline = std::time::Instant::now() + RESOLVE_RETRY_FOR;
    let mut last = String::new();
    loop {
        match (host.as_str(), port).to_socket_addrs() {
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
        if std::time::Instant::now() >= deadline || abandoned() {
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
static ABANDON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Asks the operation in flight to stop waiting and fail.
///
/// Advisory, not a kill: it is read at the points where this service
/// waits on something outside itself, so the operation unwinds through
/// its own error paths and leaves the machine in a state it chose.
pub fn abandon_current_operation() {
    ABANDON.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Clears the flag. Called by every request once it holds the lock, so
/// an abandonment aimed at the previous operation cannot be inherited by
/// the next one.
pub fn begin_operation() {
    ABANDON.store(false, std::sync::atomic::Ordering::SeqCst);
}

fn abandoned() -> bool {
    ABANDON.load(std::sync::atomic::Ordering::SeqCst)
}

/// What an abandoned operation reports.
///
/// Written for the customer rather than as a status code, because it can
/// reach them: pressing Disconnect while a connect is still running ends
/// that connect, and the app shows whatever it said.
const ABANDONED: &str = "this attempt was stopped so the disconnect could go ahead";

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
    let mut command = Command::new(exe);
    command.args(args);
    Ok(capture_hidden(command, HELPER_BUDGET)?.stdout)
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
}
