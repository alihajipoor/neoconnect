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

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::engines::HELPER_BUDGET;

/// Absolute, because a service's PATH is not the user's and this has to
/// resolve the same way on every machine.
const NETSH: &str = r"C:\Windows\System32\netsh.exe";

/// The rule's name, shared by the TCP and UDP entries so that a single
/// delete removes both -- including one left behind by a service that
/// was killed rather than stopped.
/// `pub(crate)` so `engines::repair` can ask whether it is there before
/// calling [`delete_rule`] -- netsh's delete reports the same failure
/// for "there was nothing to delete" as for "it refused", and the repair
/// has to tell a customer which happened.
pub(crate) const RULE: &str = "Neoxify Split Tunnel";

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
    /// Both addresses are named rather than passed as a list, because
    /// the second is not optional and a slice cannot say so. See
    /// [`add_rule`] for what happens when only one is allowed: the
    /// packets are rewritten and sent, the counters climb, and Windows
    /// drops every one before the proxy is offered a connection.
    pub fn install(
        application_source: Ipv4Addr,
        relay_source: Ipv4Addr,
        tcp_port: u16,
        udp_port: u16,
    ) -> Result<Self, String> {
        delete_rule();

        let sources = [application_source, relay_source];
        add_rule("TCP", &sources, tcp_port)?;
        if let Err(e) = add_rule("UDP", &sources, udp_port) {
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
/// More than one, and the second is not optional. Two different packets
/// arrive at these ports from two different places: the redirected
/// packet itself, whose source is still the application's own -- the
/// machine's address on the physical link -- and the return leg from the
/// relay's upstream socket, which is bound to the *tunnel's* address
/// because that is what pins it to the tunnel. Allow one and the other
/// is dropped.
///
/// This used to be explained as a difference between the two Custom
/// modes, on the belief that "everything except these" built a full
/// tunnel whose route to the internet was the tunnel adapter. It does
/// not -- both modes build a passive tunnel and redirect into it, see
/// `split_tunnel::SplitTunnel::wants_interception` -- so both addresses
/// are needed in both modes, which is what the code has always passed.
///
/// Allowing only the first is a silent failure of exactly the kind this
/// module exists to prevent: the packets are rewritten and sent, the
/// counters climb, and Windows drops every one of them before the proxy
/// is ever offered the connection. Measured: redirected=10, returned=0,
/// and not a single accept.
/// The netsh command line, built where a test can read it.
///
/// Split out because this module has no tests and cannot easily have
/// many: it shells out to a real firewall, and there is nothing to
/// assert without one. The argument list is the exception -- it is a
/// pure function of three values, and every hazard this file documents
/// at length shows up in it. `remoteip` carrying both sources, the
/// `profile=any` that stops a Public-network customer getting a tunnel
/// that silently carries nothing: all of it is visible here and in
/// nothing else.
fn add_rule_args(protocol: &str, remote: &str, port: u16) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={RULE}"),
        "dir=in".into(),
        "action=allow".into(),
        format!("protocol={protocol}"),
        format!("localport={port}"),
        format!("remoteip={remote}"),
        // `profile=any` because the rule has to hold whichever profile
        // Windows has decided the network is; a customer on a Public
        // network would otherwise get a tunnel that silently carries
        // nothing, which is the exact failure this module exists to
        // stop.
        "profile=any".into(),
        "enable=yes".into(),
    ]
}

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
    // Bounded, like every other helper this service shells out to:
    // installing and removing the allowance both happen with the
    // `Engines` lock held, so a netsh that never returned would stop the
    // service answering anything at all. See engines::HELPER_BUDGET.
    let mut command = Command::new(NETSH);
    command.args(add_rule_args(protocol, &remote, port));
    let out = crate::engines::capture_hidden(command, HELPER_BUDGET)
        .map_err(|e| format!("could not run netsh: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    // netsh's own text is localised, so it is reported rather than
    // matched on -- it still tells a support conversation more than an
    // exit code would.
    Err(format!(
        "the firewall refused the {protocol} allowance: {}",
        out.stdout.trim()
    ))
}

/// Removes the rule, whether or not this session installed it.
///
/// `pub(crate)` for the janitor: a service that was killed rather than
/// stopped never dropped its [`Allowance`], so the rule outlives the
/// ports it was written for and there is no `Allowance` left to remove
/// it. See `engines::janitor`.
pub(crate) fn delete_rule() {
    // Failure here is expected and ignored: on the first run there is
    // nothing to delete, and netsh reports that as an error.
    let mut command = Command::new(NETSH);
    command.args([
        "advfirewall",
        "firewall",
        "delete",
        "rule",
        &format!("name={RULE}"),
    ]);
    let _ = crate::engines::capture_hidden(command, HELPER_BUDGET);
}

/// Waits until a TCP connection to the relay actually completes.
///
/// `netsh` returning success means the rule is written, not that the
/// filtering engine is applying it to new flows yet. Between those two
/// moments the redirect is live and everything it sends to the proxy is
/// dropped, which is invisible from here and extremely visible to a
/// customer: DNS is the first thing any application does, so a browser
/// opening a page inside that window gets "No such host is known", or a
/// stall of ten to twenty seconds before it recovers. Telegram, which
/// connects to addresses it already holds and resolves nothing, is
/// unaffected -- which is exactly how it was reported, and why it never
/// reproduced against a warm address with curl.
///
/// A completed handshake is the proof: it means the rule is effective
/// *and* the relay is listening. The connection is dropped immediately
/// afterwards -- the relay refuses anything with no recorded flow, which
/// is correct and does not matter here, because the handshake completing
/// is the whole answer.
pub fn wait_until_reachable(
    local: Ipv4Addr,
    tcp_port: u16,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<(), String> {
    const BUDGET: Duration = Duration::from_secs(8);
    const STEP: Duration = Duration::from_millis(100);
    const ATTEMPT: Duration = Duration::from_millis(400);

    let target = SocketAddr::from((local, tcp_port));
    let deadline = Instant::now() + limits.clamp(BUDGET);
    let mut last = String::from("never attempted");
    while Instant::now() < deadline {
        // Eight seconds of waiting for a socket to answer, and before
        // this it could not be interrupted. A customer pressing
        // Disconnect during a connect waited it out along with
        // everything else in this file.
        limits.check().map_err(|s| s.to_string())?;
        match TcpStream::connect_timeout(&target, ATTEMPT) {
            Ok(stream) => {
                drop(stream);
                return Ok(());
            }
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(STEP);
    }
    Err(format!(
        "the split-tunnel proxy could not be reached on {target} within {}s ({last}). \
         Custom mode would have dropped your chosen apps' traffic instead of carrying it.",
        BUDGET.as_secs()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(sources: &[Ipv4Addr]) -> Vec<String> {
        let remote = sources.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(",");
        add_rule_args("TCP", &remote, 41234)
    }

    /// The failure this module exists to prevent, as an assertion.
    ///
    /// Two different packets arrive at these ports from two different
    /// places: the redirected packet, whose source is still the
    /// application's own, and the return leg from the relay's upstream
    /// socket, bound to the tunnel's address. Allow one and Windows
    /// drops the other before the proxy is ever offered a connection --
    /// measured on the rig as redirected=10, returned=0, not a single
    /// accept, with every visible signal saying the code worked.
    #[test]
    fn both_sources_reach_the_rule() {
        let a = Ipv4Addr::new(192, 168, 1, 50);
        let b = Ipv4Addr::new(10, 77, 0, 2);
        let remote = args(&[a, b]).into_iter().find(|x| x.starts_with("remoteip=")).unwrap();

        assert!(remote.contains(&a.to_string()), "the application's source is missing");
        assert!(remote.contains(&b.to_string()), "the relay's source is missing");
    }

    /// `profile=any`, because the rule has to hold whichever profile
    /// Windows decided the network is. Without it a customer on a
    /// Public network gets a tunnel that silently carries nothing.
    #[test]
    fn the_rule_holds_on_every_network_profile() {
        assert!(args(&[Ipv4Addr::LOCALHOST]).iter().any(|a| a == "profile=any"));
    }

    /// Inbound and allow. A rule that defaulted to outbound, or to
    /// block, would read as installed and do the opposite of its job.
    #[test]
    fn the_rule_allows_inbound() {
        let a = args(&[Ipv4Addr::LOCALHOST]);
        assert!(a.iter().any(|x| x == "dir=in"));
        assert!(a.iter().any(|x| x == "action=allow"));
        assert!(a.iter().any(|x| x == "enable=yes"));
    }

    /// Named, so `delete_rule` and the janitor can find it again. A rule
    /// this service cannot name is one it cannot remove, and a stale
    /// allowance outlives the ephemeral ports it was written for.
    #[test]
    fn the_rule_carries_the_name_the_sweep_looks_for() {
        assert!(args(&[Ipv4Addr::LOCALHOST]).iter().any(|a| a == &format!("name={RULE}")));
    }

    #[test]
    fn the_port_and_protocol_are_the_ones_asked_for() {
        let a = add_rule_args("UDP", "127.0.0.1", 51820);
        assert!(a.iter().any(|x| x == "protocol=UDP"));
        assert!(a.iter().any(|x| x == "localport=51820"));
    }
}
