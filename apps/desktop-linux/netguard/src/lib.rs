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

use script::{TAG_DNS, TAG_DNS_ANYWHERE, TAG_HOLD, TAG_IPV4, TAG_IPV6};

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
    load(&ruleset(plan))?;
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
///
/// A table that is a hold answers `Some(Applied::default())`: rules of
/// ours are in force, but none of the three confinement claims is made.
pub fn in_force() -> Result<Option<Applied>, Error> {
    match listing()? {
        None => Ok(None),
        Some(json) => readback(&json).map(Some).map_err(Error::NotVerified),
    }
}

/// `nft -j list table inet neoxify`, or `None` when there is no table.
fn listing() -> Result<Option<String>, Error> {
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
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// One `nft -f -`: the whole script is one transaction, so either all of
/// it is in force afterwards or none of it is and the old table stands.
fn load(script: &str) -> Result<(), Error> {
    let nft = nft()?;
    let mut child = Command::new(nft)
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::NftMissing(format!("{}: {e}", nft.display())))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes()).map_err(|e| Error::Refused(format!("writing the rules: {e}")))?;
    }
    let out = child.wait_with_output().map_err(|e| Error::Refused(e.to_string()))?;
    if !out.status.success() {
        return Err(Error::Refused(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(())
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

// ---------------------------------------------------------------------
// The reconnect hold ("block the internet while reconnecting").
//
// Between a tunnel that dropped and the next one coming up, the customer
// who asked for it gets no internet at all rather than their own address
// on the wire. On Linux that is the same table with different contents:
// the helper swaps the confinement for the hold in one transaction when a
// tunnel drops, and swaps it back with `apply` when the next one is up,
// so there is never a moment with no rules. `remove` lifts either.
// ---------------------------------------------------------------------

/// What may pass while the internet is held shut. Everything not named
/// here is refused, both families, both directions.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HoldPlan {
    /// Our own tunnel interfaces by name, whether or not they exist yet,
    /// so a tunnel that comes up under the hold carries at once.
    pub tunnel_ifaces: Vec<String>,
    /// Servers a reconnect may dial, any port, TCP and UDP. This is how
    /// the engines get out: the helper names every server the app told
    /// it about plus the one being dialled.
    pub servers: Vec<Ipv4Addr>,
    /// WireGuard's mark, when a WireGuard tunnel may come up under the
    /// hold. `None` writes no mark rule.
    pub engine_fwmark: Option<u32>,
    /// A control group, as a path relative to the cgroup root (for
    /// example `neoxify.app`), whose sockets pass anywhere. It holds the
    /// app itself, which has to reach the service to sign in again and
    /// find the next server. The group must exist when the plan is
    /// applied. `None` writes no rule.
    pub app_group: Option<String>,
    /// The machine's own resolvers: port 53 passes to these and nowhere
    /// else. See [`machine_resolvers`].
    pub resolvers: Vec<std::net::IpAddr>,
    /// The resolvers could not be read, so port 53 passes to anywhere.
    /// The app tells the customer, so this is reported back in [`Held`].
    pub dns_anywhere: bool,
    /// On-link private prefixes that stay reachable (see [`lan_prefixes`]).
    pub lan: Vec<Cidr4>,
}

/// What the kernel holds after [`apply_hold`], read back, not assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Held {
    pub dns_anywhere: bool,
}

/// The complete nft script for a hold: pure, no I/O. Loading it replaces
/// any earlier table of ours in the same transaction.
pub fn hold_ruleset(plan: &HoldPlan) -> String {
    script::build_hold(plan)
}

/// Where cgroup v2 is mounted. nft resolves a `socket cgroupv2` path
/// against this same directory when the script is loaded.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// Put the hold in force, replacing whatever of ours was there, and say
/// what the kernel now holds. An error means the load did not happen or
/// could not be confirmed; on a refusal the table that was there before
/// still stands, since the load is one transaction. The caller reports
/// it and fails open.
pub fn apply_hold(plan: &HoldPlan) -> Result<Held, Error> {
    validate_hold(plan).map_err(Error::Refused)?;
    if let Some(group) = &plan.app_group {
        // nft would refuse a missing group too, but in words about a
        // path; this says which group, which is what the helper reports.
        if !Path::new(CGROUP_ROOT).join(group).is_dir() {
            return Err(Error::Refused(format!("the control group {group:?} does not exist")));
        }
    }
    load(&hold_ruleset(plan))?;
    match hold_in_force()? {
        Some(held) => Ok(held),
        None => Err(Error::NotVerified("the hold is not in the kernel's table after loading it".into())),
    }
}

/// The hold as the kernel shows it now: `None` when the table is absent
/// or is not a hold.
pub fn hold_in_force() -> Result<Option<Held>, Error> {
    match listing()? {
        None => Ok(None),
        Some(json) => hold_readback(&json).map_err(Error::NotVerified),
    }
}

/// The resolvers this machine sends its lookups to, loopback stubs left
/// out (with systemd-resolved, the upstream servers it uses; otherwise
/// what `/etc/resolv.conf` names). Empty when they cannot be read.
pub fn machine_resolvers() -> Vec<std::net::IpAddr> {
    let etc = std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default();
    // The upstream list is read only when resolv.conf points programs at
    // resolved's stub: a machine that names its servers directly sends
    // its lookups there, whatever resolved would have used.
    let upstream = if names_resolved_stub(&etc) {
        std::fs::read_to_string("/run/systemd/resolve/resolv.conf").ok()
    } else {
        None
    };
    resolvers_from(&etc, upstream.as_deref())
}

/// The most resolvers a hold names, as on Windows (`MAX_RESOLVERS`).
const MAX_RESOLVERS: usize = 16;

/// systemd-resolved listens on 127.0.0.53, and 127.0.0.54 for its proxy.
fn names_resolved_stub(conf: &str) -> bool {
    let stubs = [Ipv4Addr::new(127, 0, 0, 53), Ipv4Addr::new(127, 0, 0, 54)];
    nameservers(conf).any(|ip| matches!(ip, std::net::IpAddr::V4(v4) if stubs.contains(&v4)))
}

fn nameservers(conf: &str) -> impl Iterator<Item = std::net::IpAddr> + '_ {
    conf.lines().filter_map(|line| {
        let mut words = line.split_whitespace();
        if words.next() != Some("nameserver") {
            return None;
        }
        // A link-local IPv6 server carries its interface ("fe80::1%eth0");
        // the rule names the address alone.
        let word = words.next()?;
        word.split('%').next()?.parse().ok()
    })
}

/// The resolvers from `/etc/resolv.conf` and, when it names resolved's
/// stub, from resolved's own list of upstream servers. Loopback is left
/// out (the hold passes it anyway), and so is anything no rule should
/// name.
fn resolvers_from(etc: &str, upstream: Option<&str>) -> Vec<std::net::IpAddr> {
    let mut out: Vec<std::net::IpAddr> = Vec::new();
    for ip in nameservers(etc).chain(upstream.into_iter().flat_map(nameservers)) {
        if !ip.is_loopback() && usable_resolver(ip) && !out.contains(&ip) && out.len() < MAX_RESOLVERS {
            out.push(ip);
        }
    }
    out
}

/// A server's address that a permit can name without naming more than one
/// host: not 0.0.0.0, not the broadcast, not a multicast group.
pub(crate) fn usable_v4(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_broadcast() && !ip.is_multicast()
}

pub(crate) fn usable_resolver(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => usable_v4(v4),
        std::net::IpAddr::V6(v6) => !v6.is_unspecified() && !v6.is_multicast(),
    }
}

/// The hold's counterpart of [`validate`]: nothing in the plan becomes nft
/// syntax, and nothing widens a permit to everyone.
fn validate_hold(plan: &HoldPlan) -> Result<(), String> {
    for name in &plan.tunnel_ifaces {
        if !script::valid_iface(name) {
            return Err(format!("{name:?} is not an interface name this accepts"));
        }
    }
    if plan.engine_fwmark == Some(0) {
        return Err("an engine mark of 0 would match every unmarked packet".into());
    }
    for ip in &plan.servers {
        if !usable_v4(*ip) {
            return Err(format!("{ip} is not a server's address"));
        }
    }
    for ip in &plan.resolvers {
        if !usable_resolver(*ip) {
            return Err(format!("{ip} is not a resolver's address"));
        }
    }
    if let Some(group) = &plan.app_group {
        if !script::valid_group(group) {
            return Err(format!("{group:?} is not a control group path this accepts"));
        }
    }
    for c in &plan.lan {
        if c.prefix < 8 || c.prefix > 32 {
            return Err(format!("{}/{} is not a local network", c.addr, c.prefix));
        }
    }
    Ok(())
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
    let seen = Seen::parse(json)?;
    Ok(Applied {
        ipv6_blocked: seen.refused(TAG_IPV6, &["output", "input", "forward"]),
        dns_confined: seen.refused(TAG_DNS, &["output", "forward"]),
        ipv4_confined: seen.refused(TAG_IPV4, &["output", "input", "forward"]),
    })
}

/// Whether the kernel's table is a hold, and what it lets through. It is
/// one only when the hold's refusal sits in all three hooks; DNS counts as
/// open to anywhere when the permit for that is in the outbound hook, so
/// the customer is never told lookups are held when the table says not.
fn hold_readback(json: &str) -> Result<Option<Held>, String> {
    let seen = Seen::parse(json)?;
    if !seen.refused(TAG_HOLD, &["output", "input", "forward"]) {
        return Ok(None);
    }
    Ok(Some(Held { dns_anywhere: seen.accepted(TAG_DNS_ANYWHERE, "output") }))
}

/// What `nft -j list table` shows of our table: each base chain's hook,
/// and each commented rule with whether it refuses or accepts.
struct Seen {
    hooks: Vec<(String, String)>,
    refusals: Vec<(String, String)>,
    accepts: Vec<(String, String)>,
}

impl Seen {
    fn hooked(&self, chain: &str, hook: &str) -> bool {
        self.hooks.iter().any(|(n, h)| n == chain && h == hook)
    }

    fn refused(&self, tag: &str, at: &[&str]) -> bool {
        at.iter().all(|hook| self.refusals.iter().any(|(chain, comment)| comment == tag && self.hooked(chain, hook)))
    }

    fn accepted(&self, tag: &str, hook: &str) -> bool {
        self.accepts.iter().any(|(chain, comment)| comment == tag && self.hooked(chain, hook))
    }

    fn parse(json: &str) -> Result<Seen, String> {
        use serde_json::Value;
        let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable nft output: {e}"))?;
        let items = v.get("nftables").and_then(Value::as_array).ok_or("nft output has no \"nftables\" list")?;
        let mut seen = Seen { hooks: Vec::new(), refusals: Vec::new(), accepts: Vec::new() };
        for item in items {
            if let Some(chain) = item.get("chain") {
                if chain.get("table").and_then(Value::as_str) != Some(TABLE) {
                    continue;
                }
                if let (Some(name), Some(hook)) =
                    (chain.get("name").and_then(Value::as_str), chain.get("hook").and_then(Value::as_str))
                {
                    seen.hooks.push((name.to_string(), hook.to_string()));
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
                let expr = rule.get("expr").and_then(Value::as_array);
                let has = |verdict: &str| expr.is_some_and(|e| e.iter().any(|x| x.get(verdict).is_some()));
                let entry = (chain.to_string(), comment.to_string());
                if has("reject") || has("drop") {
                    seen.refusals.push(entry);
                } else if has("accept") {
                    seen.accepts.push(entry);
                }
            }
        }
        Ok(seen)
    }
}

#[cfg(test)]
mod tests;
