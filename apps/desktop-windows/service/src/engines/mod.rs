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
mod ras;
mod openvpn;
pub mod routing;
mod wireguard;
mod xray;

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
                        let _ = child.wait();
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
        if self.split_tunnel.wants_interception() {
            self.start_split_tunnel(profile)?;
        }
        Ok(())
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
                let _ = child.wait();

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

/// Runs a short-lived command to completion, hidden.
fn run_hidden(exe: &Path, args: &[&std::ffi::OsStr]) -> io::Result<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
}

/// Runs a short-lived command, hidden, and returns its stdout.
pub(crate) fn run_hidden_capture(exe: &Path, args: &[&std::ffi::OsStr]) -> io::Result<String> {
    use std::os::windows::process::CommandExt;
    let out = Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
