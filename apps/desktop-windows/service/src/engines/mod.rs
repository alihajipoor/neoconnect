//! Engine lifecycle: bringing one VPN protocol up, tearing it down, and
//! reporting what is actually running.
//!
//! Every engine here is a real, official upstream binary (wireguard.exe,
//! xray.exe, openvpn.exe) rather than a reimplementation -- the same
//! philosophy the server-side agent was built on. This module's whole
//! job is to write the right config file and drive the right process,
//! invisibly.

mod openvpn;
mod split_tunnel;
mod routing;
mod wireguard;
mod xray;

use routing::InstalledRoutes;

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use neoconnect_ipc::{ConnectProfile, TunnelHealth};

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
}

impl Engines {
    pub fn new(exe_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self { exe_dir, config_dir, active: None }
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

        match profile {
            ConnectProfile::Wireguard(p) => {
                wireguard::connect(self, p)?;
                self.active = Some(Active::WireguardTunnel);
            }
            ConnectProfile::XrayVlessReality(p) => {
                let mut child = xray::connect(self, p)?;
                // Xray creates the adapter but routes nothing into it, so
                // the tunnel is inert until this succeeds. Failing here
                // must take the engine down with it rather than leave a
                // process running that reports connected and carries no
                // traffic.
                let routes = match xray::install_routes(p) {
                    Ok(routes) => routes,
                    Err(e) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(e);
                    }
                };
                self.active = Some(Active::Child {
                    protocol: "XRAY_VLESS_REALITY",
                    child,
                    routes,
                });
            }
            ConnectProfile::Openvpn(p) => {
                let child = openvpn::connect(self, p)?;
                self.active = Some(Active::Child {
                    protocol: "OPENVPN",
                    child,
                    routes: InstalledRoutes::none(),
                });
            }
        }
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
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
fn run_hidden_capture(exe: &Path, args: &[&std::ffi::OsStr]) -> io::Result<String> {
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
