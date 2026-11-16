//! Leak protection for the Linux client, as one nftables table.
//!
//! On Windows the service holds its filters in a dynamic WFP session,
//! which the kernel removes by itself if the service dies. nftables has
//! no such thing: a table outlives the process that wrote it. So the
//! whole design here is one table, `inet neoxify`, written in a single
//! atomic `nft -f -` and deleted in a single command, and three places
//! that delete it: teardown, the helper's start (a leftover from a
//! crash), and the unit's `ExecStopPost`. The stance is fail open -- a
//! customer who cannot reach the internet at all because our helper
//! crashed is worse off than one whose tunnel dropped.
//!
//! This file is the contract with the helper (`../helper`). The public
//! names and signatures below are fixed; everything behind them is this
//! crate's own business.

use std::fmt;
use std::io::Write as _;
use std::net::Ipv4Addr;
use std::path::Path;
use std::process::{Command, Stdio};

mod lan;
mod script;

use script::{TAG_DNS, TAG_IPV4, TAG_IPV6};

/// The table's name, in the `inet` family. Nothing else is ever ours.
pub const TABLE: &str = "neoxify";

/// An IPv4 prefix, e.g. 192.168.1.0/24.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cidr4 {
    pub addr: Ipv4Addr,
    pub prefix: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Proto {
    Tcp,
    Udp,
}

/// One connection the engine itself makes to a server, which has to be
/// allowed outside the tunnel or the tunnel could never come up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Transport {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub proto: Proto,
}

/// What the tunnel looks like, so the rules can let exactly it through.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// The interfaces that are the tunnel. Traffic through them passes.
    pub tunnel_ifaces: Vec<String>,
    /// The engine's own connections to its server(s).
    pub transports: Vec<Transport>,
    /// Packets carrying this mark are the engine's own (WireGuard marks
    /// its encrypted packets); they pass. `None` writes no mark rule.
    pub engine_fwmark: Option<u32>,
    /// No global IPv6 in either direction. Link-local and neighbour
    /// discovery stay, or the machine loses its own network.
    pub block_ipv6: bool,
    /// Port 53 only through the tunnel or to loopback.
    pub confine_dns: bool,
    /// Nothing leaves outside the tunnel except the transports, DHCP
    /// and the local network in `lan`.
    pub confine_ipv4: bool,
    /// On-link private prefixes that stay reachable (see
    /// [`lan_prefixes`]). Only read when `confine_ipv4` is set.
    pub lan: Vec<Cidr4>,
}

/// What is actually in force after [`apply`], read back from the kernel
/// rather than assumed from the plan. The helper reports these to the
/// app, which shows them to the customer, so each one is a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Applied {
    pub ipv6_blocked: bool,
    pub dns_confined: bool,
    pub ipv4_confined: bool,
}

/// What [`remove`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    /// There was no table.
    Nothing,
    /// There was one and it is gone.
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// `nft` is not installed or could not be started.
    NftMissing(String),
    /// `nft` refused the rules; the text is its own.
    Refused(String),
    /// The rules went in but reading them back did not show them.
    NotVerified(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NftMissing(why) => write!(f, "nftables is not available: {why}"),
            Error::Refused(why) => write!(f, "nftables refused the rules: {why}"),
            Error::NotVerified(why) => write!(f, "the rules could not be confirmed: {why}"),
        }
    }
}

impl std::error::Error for Error {}

/// The complete nft script for a plan: pure, no I/O, so it can be tested
/// anywhere. Loading it must replace any earlier table of ours in the
/// same transaction.
pub fn ruleset(plan: &Plan) -> String {
    script::build(plan)
}

/// Put the plan in force, replacing whatever of ours was there, and say
/// what the kernel now holds.
pub fn apply(plan: &Plan) -> Result<Applied, Error> {
    validate(plan).map_err(Error::Refused)?;
    let nft = nft()?;
    let mut child = Command::new(nft)
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::NftMissing(format!("{}: {e}", nft.display())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(ruleset(plan).as_bytes()).map_err(|e| Error::Refused(format!("writing the rules: {e}")))?;
    }
    let out = child.wait_with_output().map_err(|e| Error::Refused(e.to_string()))?;
    if !out.status.success() {
        return Err(Error::Refused(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    // What the customer is told comes from the kernel, not the plan: a
    // flag the plan asked for and the table does not show is an error.
    let Some(applied) = in_force()? else {
        return Err(Error::NotVerified("the table is not there after loading it".into()));
    };
    let missing: Vec<&str> = [
        (plan.block_ipv6 && !applied.ipv6_blocked, "the IPv6 block"),
        (plan.confine_dns && !applied.dns_confined, "the DNS confinement"),
        (plan.confine_ipv4 && !applied.ipv4_confined, "the IPv4 confinement"),
    ]
    .into_iter()
    .filter_map(|(gone, what)| gone.then_some(what))
    .collect();
    if !missing.is_empty() {
        return Err(Error::NotVerified(format!("not found in the kernel's table: {}", missing.join(", "))));
    }
    Ok(applied)
}

/// Delete the table. Finding none is not an error.
pub fn remove() -> Result<Removal, Error> {
    let nft = nft()?;
    let out = Command::new(nft)
        .args(["delete", "table", "inet", TABLE])
        .output()
        .map_err(|e| Error::NftMissing(format!("{}: {e}", nft.display())))?;
    if out.status.success() {
        return Ok(Removal::Removed);
    }
    // Rather than read nft's wording of "no such table", which changes
    // between versions, ask whether the table is there.
    if !table_exists(nft)? {
        return Ok(Removal::Nothing);
    }
    Err(Error::Refused(String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

/// What is in force right now, or `None` when there is no table.
pub fn in_force() -> Result<Option<Applied>, Error> {
    let nft = nft()?;
    let out = Command::new(nft)
        .args(["-j", "list", "table", "inet", TABLE])
        .output()
        .map_err(|e| Error::NftMissing(format!("{}: {e}", nft.display())))?;
    if !out.status.success() {
        if !table_exists(nft)? {
            return Ok(None);
        }
        return Err(Error::NotVerified(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    readback(&String::from_utf8_lossy(&out.stdout)).map(Some).map_err(Error::NotVerified)
}

/// The on-link private IPv4 prefixes of the interfaces that are up,
/// leaving out the named (tunnel) interfaces. Never a whole private
/// range: only what an interface is actually addressed in.
pub fn lan_prefixes(exclude_ifaces: &[&str]) -> Vec<Cidr4> {
    let ip = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"].into_iter().map(Path::new).find(|p| p.is_file());
    let Some(ip) = ip else { return Vec::new() };
    match Command::new(ip).args(["-j", "-4", "addr", "show", "up"]).output() {
        Ok(out) if out.status.success() => lan::parse(&String::from_utf8_lossy(&out.stdout), exclude_ifaces),
        _ => Vec::new(),
    }
}

/// nft from the system's own directories only. The helper runs as root,
/// and a `PATH` lookup would run whatever `nft` comes first in it.
fn nft() -> Result<&'static Path, Error> {
    ["/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft", "/bin/nft"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.is_file())
        .ok_or_else(|| Error::NftMissing("no nft in /usr/sbin, /sbin, /usr/bin or /bin".into()))
}

fn table_exists(nft: &Path) -> Result<bool, Error> {
    let out = Command::new(nft)
        .args(["list", "tables", "inet"])
        .output()
        .map_err(|e| Error::NftMissing(format!("{}: {e}", nft.display())))?;
    if !out.status.success() {
        return Err(Error::NotVerified(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    let wanted = format!("table inet {TABLE}");
    Ok(String::from_utf8_lossy(&out.stdout).lines().any(|l| l.trim() == wanted))
}

/// Everything in a plan that is written into the script, checked before
/// it is: nothing a plan carries may become nft syntax, and nothing may
/// quietly turn a permit into a permit for everything.
fn validate(plan: &Plan) -> Result<(), String> {
    for name in &plan.tunnel_ifaces {
        if !script::valid_iface(name) {
            return Err(format!("{name:?} is not an interface name this accepts"));
        }
    }
    if plan.engine_fwmark == Some(0) {
        return Err("an engine mark of 0 would match every unmarked packet".into());
    }
    for t in &plan.transports {
        if t.ip.is_unspecified() || t.ip.is_broadcast() || t.ip.is_multicast() || t.port == 0 {
            return Err(format!("{}:{} is not a server's address", t.ip, t.port));
        }
    }
    if plan.confine_ipv4 {
        for c in &plan.lan {
            // Anything wider than a /8 is most of the internet, not a LAN.
            if c.prefix < 8 || c.prefix > 32 {
                return Err(format!("{}/{} is not a local network", c.addr, c.prefix));
            }
        }
    }
    Ok(())
}

/// Which guarantees the kernel's table holds, from `nft -j list table`.
/// A guarantee counts only when a refusal rule carrying its tag sits in
/// a chain hooked where it has to act: IPv4 and IPv6 on output, input
/// and forward; DNS on output and forward.
fn readback(json: &str) -> Result<Applied, String> {
    use serde_json::Value;
    let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable nft output: {e}"))?;
    let items = v.get("nftables").and_then(Value::as_array).ok_or("nft output has no \"nftables\" list")?;
    let mut hooks: Vec<(String, String)> = Vec::new();
    let mut refusals: Vec<(String, String)> = Vec::new();
    for item in items {
        if let Some(chain) = item.get("chain") {
            if chain.get("table").and_then(Value::as_str) != Some(TABLE) {
                continue;
            }
            if let (Some(name), Some(hook)) =
                (chain.get("name").and_then(Value::as_str), chain.get("hook").and_then(Value::as_str))
            {
                hooks.push((name.to_string(), hook.to_string()));
            }
        }
        if let Some(rule) = item.get("rule") {
            if rule.get("table").and_then(Value::as_str) != Some(TABLE) {
                continue;
            }
            let (Some(chain), Some(comment)) =
                (rule.get("chain").and_then(Value::as_str), rule.get("comment").and_then(Value::as_str))
            else {
                continue;
            };
            let refuses = rule
                .get("expr")
                .and_then(Value::as_array)
                .is_some_and(|e| e.iter().any(|x| x.get("reject").is_some() || x.get("drop").is_some()));
            if refuses {
                refusals.push((chain.to_string(), comment.to_string()));
            }
        }
    }
    let held = |tag: &str, at: &[&str]| {
        at.iter().all(|hook| {
            refusals
                .iter()
                .any(|(chain, comment)| comment == tag && hooks.iter().any(|(n, h)| n == chain && h == hook))
        })
    };
    Ok(Applied {
        ipv6_blocked: held(TAG_IPV6, &["output", "input", "forward"]),
        dns_confined: held(TAG_DNS, &["output", "forward"]),
        ipv4_confined: held(TAG_IPV4, &["output", "input", "forward"]),
    })
}

#[cfg(test)]
mod tests;
