//! Engine lifecycle: bringing one VPN protocol up, tearing it down, and
//! reporting what is actually running.
//!
//! Every engine here is a real, official upstream binary (wireguard.exe,
//! xray.exe, openvpn.exe) rather than a reimplementation -- the same
//! philosophy the server-side agent was built on. This module's whole
//! job is to write the right config file and drive the right process,
//! invisibly.

mod openvpn;
pub mod routing;
mod wireguard;
mod xray;

use routing::InstalledRoutes;

use std::io;
use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use neoconnect_ipc::{ConnectProfile, TunnelHealth};

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
}

impl Engines {
    pub fn new(exe_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self { exe_dir, config_dir, active: None, split_tunnel: SplitTunnel::new() }
    }

    /// Replaces the customer's Custom-mode selection.
    ///
    /// Takes effect immediately for connections made from now on. It
    /// deliberately does not restart anything: a customer adding a
    /// second game should not drop the first one's session.
    ///
    /// Changing it does change how the *next* tunnel is brought up,
    /// though -- passive rather than full -- so turning Custom mode on
    /// or off while connected only takes full effect on reconnect. The
    /// UI says so rather than pretending otherwise.
    pub fn set_split_tunnel(&mut self, enabled: bool, apps: Vec<String>) {
        self.split_tunnel.set_selection(enabled, apps);
    }

    pub fn split_tunnel_running(&self) -> bool {
        self.split_tunnel.is_running()
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
    pub fn connect(&mut self, profile: &ConnectProfile) -> Result<(), String> {
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
            // Both Xray protocols take the same path: one engine, one
            // adapter, one set of routes -- only the outbound differs.
            ConnectProfile::XrayVlessReality(_)
            | ConnectProfile::XrayVlessTls(_)
            | ConnectProfile::XrayTrojan(_) => {
                let (outbound, protocol) = match profile {
                    ConnectProfile::XrayVlessReality(p) => {
                        (xray::Outbound::VlessReality(p), "XRAY_VLESS_REALITY")
                    }
                    ConnectProfile::XrayVlessTls(p) => {
                        (xray::Outbound::VlessTls(p), "XRAY_VLESS_TLS")
                    }
                    ConnectProfile::XrayTrojan(p) => (xray::Outbound::Trojan(p), "XRAY_TROJAN"),
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
                self.active = Some(Active::Child { protocol, child, routes });
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

        if passive {
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

        let result = match self.active.take() {
            None => {
                // Still ask wireguard.exe to remove the tunnel service:
                // it outlives this process, so a service restart (or a
                // crash) would otherwise strand a tunnel up with nothing
                // tracking it.
                wireguard::remove_tunnel_if_present(self);
                Ok(())
            }
            Some(Active::WireguardTunnel) => wireguard::disconnect(self),
            Some(Active::Child { mut child, mut routes, .. }) => {
                // Routes first: leaving them pointed at an adapter that is
                // about to disappear would black-hole all traffic until
                // Windows noticed.
                routes.remove();
                let _ = child.kill();
                let _ = child.wait();
                Ok(())
            }
        };

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
            None => (false, None, TunnelHealth::Down),
            Some(Active::WireguardTunnel) => {
                if wireguard::tunnel_is_running() {
                    let health = match wireguard::handshake_health(self) {
                        wireguard::HandshakeHealth::Alive { age_secs } => TunnelHealth::Alive { age_secs },
                        wireguard::HandshakeHealth::Stale { age_secs } => TunnelHealth::Stale { age_secs },
                        wireguard::HandshakeHealth::NeverHandshaked => TunnelHealth::NeverHandshaked,
                        wireguard::HandshakeHealth::Unknown => TunnelHealth::Unknown,
                    };
                    (true, Some("WIREGUARD".into()), health)
                } else {
                    self.active = None;
                    (false, None, TunnelHealth::Down)
                }
            }
            Some(Active::Child { protocol, child, routes }) => match child.try_wait() {
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
        | ConnectProfile::XrayTrojan(_) => xray::ADAPTER_NAME,
        ConnectProfile::Openvpn(_) => openvpn::ADAPTER_NAME,
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
    };

    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    // Nodes are registered by address today, but a hostname is resolved
    // rather than rejected -- otherwise a DNS-named node would silently
    // lose the exclusion above.
    (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {host}: {e}"))?
        .find_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("{host} has no IPv4 address"))
}

fn split_host_port(endpoint: &str) -> Result<(String, u16), String> {
    let (host, port) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| format!("{endpoint} is not host:port"))?;
    let port = port.parse().map_err(|_| format!("{endpoint} has no valid port"))?;
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
    Command::new(exe).args(args).creation_flags(CREATE_NO_WINDOW).status()
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
