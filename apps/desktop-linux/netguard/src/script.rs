//! The nft script for a plan. Pure: no I/O, so every flag combination is
//! testable anywhere.
//!
//! The precedence mirrors the Windows weights (`confinement.rs`): loopback,
//! the tunnel, the engine's own traffic, DHCP, the refusal of DNS, the local
//! network, then the refusal of everything else. nftables evaluates a chain
//! top to bottom and stops at the first verdict, so order here IS weight.
//!
//! Every rule that carries a guarantee has an `nx:` comment; the read-back
//! in `lib.rs` looks for those tags in what the kernel holds.

use crate::{Cidr4, Plan, Proto, Transport, TABLE};
use std::fmt::Write;
use std::net::Ipv4Addr;

/// The tags the read-back looks for. Refusal rules only: a permit proves
/// nothing about confinement.
pub(crate) const TAG_IPV4: &str = "nx:ipv4";
pub(crate) const TAG_IPV6: &str = "nx:ipv6";
pub(crate) const TAG_DNS: &str = "nx:dns";

/// Always reachable while IPv4 is confined, as on Windows (`lan_plumbing`):
/// link-local, multicast and the limited broadcast, which no LAN prefix
/// names and without which discovery protocols on the local network stop.
const LAN_PLUMBING: [Cidr4; 3] = [
    Cidr4 { addr: Ipv4Addr::new(169, 254, 0, 0), prefix: 16 },
    Cidr4 { addr: Ipv4Addr::new(224, 0, 0, 0), prefix: 4 },
    Cidr4 { addr: Ipv4Addr::new(255, 255, 255, 255), prefix: 32 },
];

/// Link-local and multicast: what neighbour discovery, router
/// advertisements and DHCPv6 travel on. Blocking them does not stop
/// internet IPv6, it stops the machine speaking to its own router.
const V6_LOCAL: &str = "{ fe80::/10, ff00::/8 }";

/// The ICMPv6 types of neighbour discovery. Held to hop limit 255, which
/// a router never forwards, so this permit cannot reach past the link.
const V6_ND: &str = "icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert, nd-redirect } ip6 hoplimit 255";

/// The kernel's rule for an interface name is 1 to 15 bytes with no "/"
/// or whitespace. This is stricter -- letters, digits, "-", "_", "." --
/// because the name is written into an nft script inside quotes, and a
/// quote or a brace in it would be nft syntax of the plan's choosing.
pub(crate) fn valid_iface(name: &str) -> bool {
    (1..=15).contains(&name.len())
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub(crate) fn normalise(c: Cidr4) -> Cidr4 {
    let prefix = c.prefix.min(32);
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    Cidr4 { addr: Ipv4Addr::from(u32::from(c.addr) & mask), prefix }
}

fn contains(outer: Cidr4, inner: Cidr4) -> bool {
    outer.prefix <= inner.prefix && normalise(Cidr4 { addr: inner.addr, prefix: outer.prefix }).addr == outer.addr
}

/// The prefixes, normalised, without duplicates and without any prefix
/// another one already covers: nft refuses an interval set whose members
/// overlap, and a LAN of 10.0.0.0/8 next to 10.1.2.0/24 is ordinary.
fn merged(prefixes: impl IntoIterator<Item = Cidr4>) -> Vec<Cidr4> {
    let all: Vec<Cidr4> = prefixes.into_iter().map(normalise).collect();
    let mut out: Vec<Cidr4> = Vec::new();
    for (i, p) in all.iter().enumerate() {
        let covered = all.iter().enumerate().any(|(j, q)| {
            j != i && contains(*q, *p) && (q.prefix < p.prefix || (q == p && j < i))
        });
        if !covered && !out.contains(p) {
            out.push(*p);
        }
    }
    out
}

fn cidr(c: Cidr4) -> String {
    if c.prefix == 32 {
        c.addr.to_string()
    } else {
        format!("{}/{}", c.addr, c.prefix)
    }
}

fn set<T: AsRef<str>>(items: &[T]) -> String {
    if items.len() == 1 {
        return items[0].as_ref().to_string();
    }
    let joined: Vec<&str> = items.iter().map(|s| s.as_ref()).collect();
    format!("{{ {} }}", joined.join(", "))
}

fn proto(p: Proto) -> &'static str {
    match p {
        Proto::Tcp => "tcp",
        Proto::Udp => "udp",
    }
}

/// A refusal, for both TCP and everything else, under one tag. Outbound
/// and forwarded traffic is rejected so a program fails at once instead
/// of waiting out a timeout -- a reset for TCP, "administratively
/// prohibited" for the rest. Inbound is dropped: answering an unsolicited
/// packet from the internet only tells the sender someone is there.
fn refuse(s: &mut String, matcher: &str, tag: &str, reject: bool) {
    let sep = if matcher.is_empty() { "" } else { " " };
    if reject {
        let _ = writeln!(s, "\t\t{matcher}{sep}meta l4proto tcp reject with tcp reset comment \"{tag}\"");
        let _ = writeln!(s, "\t\t{matcher}{sep}reject with icmpx type admin-prohibited comment \"{tag}\"");
    } else {
        let _ = writeln!(s, "\t\t{matcher}{sep}drop comment \"{tag}\"");
    }
}

fn chain_head(s: &mut String, name: &str) {
    let _ = writeln!(s, "\tchain {name} {{");
    let _ = writeln!(s, "\t\ttype filter hook {name} priority 0; policy accept;");
}

pub(crate) fn build(plan: &Plan) -> String {
    // apply() refuses a plan with a bad name before it gets here. Should
    // one arrive anyway, it is left out rather than written: that only
    // makes the table stricter, never lets nft syntax in.
    let mut tunnels: Vec<String> = Vec::new();
    for name in plan.tunnel_ifaces.iter().filter(|n| valid_iface(n)) {
        let quoted = format!("\"{name}\"");
        if !tunnels.contains(&quoted) {
            tunnels.push(quoted);
        }
    }
    let mut transports: Vec<Transport> = Vec::new();
    for t in &plan.transports {
        if !transports.contains(t) {
            transports.push(*t);
        }
    }
    // A mark of 0 is every unmarked packet: a permit for it would be a
    // permit for everything. apply() refuses it; here it is simply absent.
    let fwmark = plan.engine_fwmark.filter(|m| *m != 0);
    let lan: Vec<String> = merged(plan.lan.iter().copied().chain(LAN_PLUMBING)).into_iter().map(cidr).collect();
    let lan = set(&lan);

    let mut s = String::new();
    // Declare, delete, define: the first line makes sure there is a table
    // to delete, so the whole file is one transaction that replaces any
    // earlier table of ours whether or not there was one.
    let _ = writeln!(s, "table inet {TABLE}");
    let _ = writeln!(s, "delete table inet {TABLE}");
    let _ = writeln!(s, "table inet {TABLE} {{");

    // Outbound: what this machine sends.
    chain_head(&mut s, "output");
    let _ = writeln!(s, "\t\toifname \"lo\" accept comment \"nx:loopback\"");
    if !tunnels.is_empty() {
        let _ = writeln!(s, "\t\toifname {} accept comment \"nx:tunnel\"", set(&tunnels));
    }
    for t in &transports {
        let p = proto(t.proto);
        let _ = writeln!(s, "\t\tip daddr {} {p} dport {} accept comment \"nx:transport\"", t.ip, t.port);
    }
    if let Some(mark) = fwmark {
        let _ = writeln!(s, "\t\tmeta mark {mark:#010x} accept comment \"nx:engine\"");
    }
    // DHCP by its ports, as a client and as a server (a hotspot, a VM
    // bridge). Ports alone would let any program reach any host's 67 on
    // Windows; here binding 67 or 68 needs root, which is already past
    // anything a table can hold. The renewal goes unicast to a server a
    // relay may put off the LAN, so no address is named.
    let _ = writeln!(s, "\t\tmeta nfproto ipv4 udp sport 68 udp dport 67 accept comment \"nx:dhcp\"");
    let _ = writeln!(s, "\t\tmeta nfproto ipv4 udp sport 67 udp dport 68 accept comment \"nx:dhcp\"");
    if plan.confine_dns {
        // Above the LAN, so the router cannot be used as a resolver
        // around the tunnel. Both families: an IPv6 resolver is a leak too.
        let _ = writeln!(s, "\t\ttcp dport 53 reject with tcp reset comment \"{TAG_DNS}\"");
        let _ = writeln!(s, "\t\tudp dport 53 reject with icmpx type admin-prohibited comment \"{TAG_DNS}\"");
    }
    if plan.confine_ipv4 {
        let _ = writeln!(s, "\t\tip daddr {lan} accept comment \"nx:lan\"");
        refuse(&mut s, "meta nfproto ipv4", TAG_IPV4, true);
    }
    if plan.block_ipv6 {
        let _ = writeln!(s, "\t\t{V6_ND} accept comment \"nx:ipv6-nd\"");
        // The router's link-local resolver is the same leak as its IPv4
        // one, and is refused even when DNS confinement is off: Windows
        // saw lookups to fe80::2 port 53 leave in clear text.
        let _ = writeln!(s, "\t\tip6 daddr {V6_LOCAL} tcp dport 53 reject with tcp reset comment \"nx:ipv6-dns\"");
        let _ = writeln!(
            s,
            "\t\tip6 daddr {V6_LOCAL} udp dport 53 reject with icmpx type admin-prohibited comment \"nx:ipv6-dns\""
        );
        let _ = writeln!(s, "\t\tip6 daddr {V6_LOCAL} accept comment \"nx:ipv6-local\"");
        refuse(&mut s, "meta nfproto ipv6", TAG_IPV6, true);
    }
    let _ = writeln!(s, "\t}}");

    // Inbound: what reaches this machine. Answers to anything it was
    // allowed to send come back as established; the rest is held to the
    // same shape as outbound.
    chain_head(&mut s, "input");
    let _ = writeln!(s, "\t\tiifname \"lo\" accept comment \"nx:loopback\"");
    if !tunnels.is_empty() {
        let _ = writeln!(s, "\t\tiifname {} accept comment \"nx:tunnel\"", set(&tunnels));
    }
    let _ = writeln!(s, "\t\tct state established,related accept comment \"nx:established\"");
    for t in &transports {
        let p = proto(t.proto);
        let _ = writeln!(s, "\t\tip saddr {} {p} sport {} accept comment \"nx:transport\"", t.ip, t.port);
    }
    // A DHCP OFFER or ACK comes from the server's own address, which on a
    // network first joined after Connect is on no prefix the plan knew.
    let _ = writeln!(s, "\t\tmeta nfproto ipv4 udp sport 67 udp dport 68 accept comment \"nx:dhcp\"");
    let _ = writeln!(s, "\t\tmeta nfproto ipv4 udp sport 68 udp dport 67 accept comment \"nx:dhcp\"");
    if plan.confine_ipv4 {
        let _ = writeln!(s, "\t\tip saddr {lan} accept comment \"nx:lan\"");
        refuse(&mut s, "meta nfproto ipv4", TAG_IPV4, false);
    }
    if plan.block_ipv6 {
        let _ = writeln!(s, "\t\t{V6_ND} accept comment \"nx:ipv6-nd\"");
        let _ = writeln!(s, "\t\tip6 saddr {V6_LOCAL} accept comment \"nx:ipv6-local\"");
        refuse(&mut s, "meta nfproto ipv6", TAG_IPV6, false);
    }
    let _ = writeln!(s, "\t}}");

    // Forwarded: containers and virtual machines on this computer. Their
    // traffic is this computer's traffic to everyone outside it, and a
    // Docker or libvirt bridge masquerades it out of the uplink, so left
    // open it is a leak around the tunnel. It is held to the same policy
    // as outbound: through the tunnel, to the LAN (which includes the
    // bridges' own private prefixes) and the answers back. A container
    // pinned to a resolver outside the tunnel loses DNS rather than leaks it.
    chain_head(&mut s, "forward");
    if !tunnels.is_empty() {
        let _ = writeln!(s, "\t\tiifname {} accept comment \"nx:tunnel\"", set(&tunnels));
        let _ = writeln!(s, "\t\toifname {} accept comment \"nx:tunnel\"", set(&tunnels));
    }
    let _ = writeln!(s, "\t\tct state established,related accept comment \"nx:established\"");
    if plan.confine_dns {
        let _ = writeln!(s, "\t\ttcp dport 53 reject with tcp reset comment \"{TAG_DNS}\"");
        let _ = writeln!(s, "\t\tudp dport 53 reject with icmpx type admin-prohibited comment \"{TAG_DNS}\"");
    }
    if plan.confine_ipv4 {
        let _ = writeln!(s, "\t\tip daddr {lan} accept comment \"nx:lan\"");
        refuse(&mut s, "meta nfproto ipv4", TAG_IPV4, true);
    }
    if plan.block_ipv6 {
        // Link-local is never forwarded, so there is nothing to keep.
        refuse(&mut s, "meta nfproto ipv6", TAG_IPV6, true);
    }
    let _ = writeln!(s, "\t}}");

    let _ = writeln!(s, "}}");
    s
}
