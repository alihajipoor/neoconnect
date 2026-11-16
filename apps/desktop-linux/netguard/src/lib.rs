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
use std::net::Ipv4Addr;

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
pub fn ruleset(_plan: &Plan) -> String {
    unimplemented!("netguard::ruleset")
}

/// Put the plan in force, replacing whatever of ours was there, and say
/// what the kernel now holds.
pub fn apply(_plan: &Plan) -> Result<Applied, Error> {
    unimplemented!("netguard::apply")
}

/// Delete the table. Finding none is not an error.
pub fn remove() -> Result<Removal, Error> {
    unimplemented!("netguard::remove")
}

/// What is in force right now, or `None` when there is no table.
pub fn in_force() -> Result<Option<Applied>, Error> {
    unimplemented!("netguard::in_force")
}

/// The on-link private IPv4 prefixes of the interfaces that are up,
/// leaving out the named (tunnel) interfaces. Never a whole private
/// range: only what an interface is actually addressed in.
pub fn lan_prefixes(_exclude_ifaces: &[&str]) -> Vec<Cidr4> {
    unimplemented!("netguard::lan_prefixes")
}
