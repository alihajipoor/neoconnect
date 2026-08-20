//! The inbound allowance the redirected packets need to be delivered.
//!
//! A redirected packet is rewritten to the machine's own address and the
//! proxy's port, and re-injected. The stack loops it back and hands it
//! to TCP, which asks the firewall whether this connection may be
//! accepted -- and by default the answer is no, because nothing ever
//! allowed inbound connections to an ephemeral port on this machine.
//!
//! That is what the feature's first version got wrong, and it was
//! expensive to find because every visible signal said the code was
//! working: the proxy was listening, WinDivert reported every send as
//! successful, the redirect counters climbed, nothing was rejected, and
//! the selected application simply hung. It took `pktmon` to say it out
//! loud:
//!
//! ```text
//! Drop: Direction Rx, Type IP, DropReason "INET: accept inspection"
//! ip: 192.168.88.10.40001 > 192.168.88.10.52490: Flags [S]
//! ```
//!
//! Turning the firewall off made the same run succeed and put the
//! selected app's traffic out of the node, which is what settled it.
//!
//! The rule is kept as narrow as that evidence allows: the two ports
//! this session actually listens on, and only from this machine's own
//! address, which is the source every injected packet carries. It is
//! torn down with the split tunnel, so no allowance outlives the
//! feature being switched off.

use std::net::Ipv4Addr;
use std::os::windows::process::CommandExt;
use std::process::Command;

/// Hides the console window netsh would otherwise flash up. The service
/// runs invisibly and a window appearing on a customer's screen when
/// they toggle Custom mode would be a bug in its own right.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Absolute, because a service's PATH is not the user's and this has to
/// resolve the same way on every machine.
const NETSH: &str = r"C:\Windows\System32\netsh.exe";

/// The rule's name, shared by the TCP and UDP entries so that a single
/// delete removes both -- including one left behind by a service that
/// was killed rather than stopped.
const RULE: &str = "Neoxify Split Tunnel";

/// An inbound allowance that lasts as long as the value does.
pub struct Allowance {
    /// False once removed, so the drop does not run the delete twice.
    installed: bool,
}

impl Allowance {
    /// Allows inbound TCP and UDP to `tcp_port` and `udp_port` from
    /// `local_addr`.
    ///
    /// Any rule left over from a previous session is deleted first: the
    /// ports are ephemeral, so a stale rule allows something arbitrary
    /// while failing to allow what this session needs.
    pub fn install(sources: &[Ipv4Addr], tcp_port: u16, udp_port: u16) -> Result<Self, String> {
        delete_rule();

        add_rule("TCP", sources, tcp_port)?;
        if let Err(e) = add_rule("UDP", sources, udp_port) {
            delete_rule();
            return Err(e);
        }
        Ok(Self { installed: true })
    }

    /// Removes the allowance. Safe to call more than once.
    pub fn remove(&mut self) {
        if std::mem::take(&mut self.installed) {
            delete_rule();
        }
    }
}

impl Drop for Allowance {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Every address a redirected packet can arrive from.
///
/// More than one, and the second is not optional. Which source a
/// rewritten packet carries depends on where the application's traffic
/// was headed before it was intercepted: with a passive tunnel it is
/// the machine's address on the physical link, but with a full one --
/// which is what "everything except these" builds -- the route to the
/// internet is the tunnel, so the socket's source is the *tunnel's*
/// address instead.
///
/// Allowing only the first is a silent failure of exactly the kind this
/// module exists to prevent: the packets are rewritten and sent, the
/// counters climb, and Windows drops every one of them before the proxy
/// is ever offered the connection. Measured: redirected=10, returned=0,
/// and not a single accept.
fn add_rule(protocol: &str, sources: &[Ipv4Addr], port: u16) -> Result<(), String> {
    let remote = sources
        .iter()
        .map(|a| a.to_string())
        .collect::<Vec<_>>()
        .join(",");
    // `profile=any` because the rule has to hold whichever profile
    // Windows has decided the network is; a customer on a Public
    // network would otherwise get a tunnel that silently carries
    // nothing, which is the exact failure this module exists to stop.
    let out = Command::new(NETSH)
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={RULE}"),
            "dir=in",
            "action=allow",
            &format!("protocol={protocol}"),
            &format!("localport={port}"),
            &format!("remoteip={remote}"),
            "profile=any",
            "enable=yes",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not run netsh: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    // netsh's own text is localised, so it is reported rather than
    // matched on -- it still tells a support conversation more than an
    // exit code would.
    Err(format!(
        "the firewall refused the {protocol} allowance: {}",
        String::from_utf8_lossy(&out.stdout).trim()
    ))
}

fn delete_rule() {
    // Failure here is expected and ignored: on the first run there is
    // nothing to delete, and netsh reports that as an error.
    let _ = Command::new(NETSH)
        .args([
            "advfirewall",
            "firewall",
            "delete",
            "rule",
            &format!("name={RULE}"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}
