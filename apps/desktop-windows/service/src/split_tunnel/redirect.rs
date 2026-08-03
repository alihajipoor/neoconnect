//! The packet loop that puts a selected app's connections on the proxy.
//!
//! # The shape that works, and the two that do not
//!
//! The obvious design -- rewrite the source to the tunnel address and
//! re-inject with `WINDIVERT_ADDRESS.Network.interface_id` set to the
//! tunnel -- fails silently. Every packet is accepted, and the node
//! receives none of them: the stack routes an injected packet by its own
//! table and treats `interface_id` as a hint about where it came from,
//! not an instruction about where to send it. Proven by capture on the
//! node, which showed 252 arriving packets, all of them Windows
//! multicast chatter and not one of them the redirected traffic.
//!
//! Routing everything through `127.0.0.1` fails too, differently:
//! WinDivert treats loopback as a special case and an injected loopback
//! packet is never delivered to the listener.
//!
//! What works is neither. Leave the source alone, rewrite the
//! destination to the machine's **own LAN address** plus the proxy's
//! port, and inject it inbound. Both ends are then ordinary addresses on
//! a real interface, the listener accepts it as a normal connection, and
//! the tunnelling is done by the proxy's own socket rather than by
//! anything done to this packet.
//!
//! # Why the filter is broad
//!
//! WinDivert compiles one filter string into the driver when the handle
//! is opened; it cannot be changed as the set of interesting ports
//! changes. Since which ports matter depends on which process owns them,
//! and that is not expressible in the filter language, the decision has
//! to happen here. What the filter *can* do is exclude, in the kernel,
//! everything that could never be interesting: loopback, the node's own
//! address, private and link-local destinations, and multicast. That
//! last one is not an optimisation -- a tunnel coming up makes Windows
//! spray mDNS, LLMNR, SSDP and IGMP at it, which for a customer who
//! asked for one game to be tunnelled would mean their local hostnames
//! going to the VPN server.
//!
//! Everything else is examined here and, overwhelmingly, sent straight
//! back out untouched. **Any path out of this loop that does not either
//! re-inject or deliberately drop a packet is a hole in the machine's
//! networking**, so the code below is written so that passing the packet
//! through is what happens by default.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use windivert_sys::address::WINDIVERT_ADDRESS;
use windivert_sys::{WinDivertFlags, WinDivertLayer};

use super::divert::{recalculate_checksums, Handle};
use super::flows::{Nat, Origin, Verdict};
use super::owner::{OwnerLookup, Selection, Transport};

/// The largest packet WinDivert will hand over.
const MAX_PACKET: usize = 65_575;

/// How many threads share the handle.
///
/// More than one because this sits on the path of all outbound traffic
/// and a single thread would cap throughput at whatever one core can
/// forward; only a few, because packets are reordered across threads and
/// a latency-sensitive audience is the reason this feature exists.
const WORKERS: usize = 2;

const IPPROTO_TCP: u8 = 6;
const IPPROTO_UDP: u8 = 17;
const TCP_FLAG_SYN: u8 = 0x02;
const TCP_FLAG_ACK: u8 = 0x10;

/// What the loop has actually done, for diagnosis.
///
/// Not telemetry and not sent anywhere -- it is written to a log file
/// beside the engine logs. Custom mode has three plausible ways to fail
/// silently (nothing intercepted, intercepted but nothing matched the
/// selection, matched but the proxy never connected) and they look
/// identical from the outside. These four numbers separate them in one
/// reading, which is worth more than the guesses it replaces.
#[derive(Default)]
pub struct Stats {
    /// Packets the filter handed over. Zero means the driver is not
    /// intercepting at all.
    pub seen: AtomicU64,
    /// Flows attributed to a selected application. Zero with `seen`
    /// high means the selection matches nothing that is running.
    pub matched: AtomicU64,
    /// Packets rewritten towards the proxy.
    pub redirected: AtomicU64,
    /// Replies rewritten back. Zero with `redirected` high means the
    /// proxy is not getting answers -- so the tunnel, not the redirect.
    pub returned: AtomicU64,
}

impl Stats {
    pub fn summary(&self) -> String {
        format!(
            "seen={} matched={} redirected={} returned={}",
            self.seen.load(Ordering::Relaxed),
            self.matched.load(Ordering::Relaxed),
            self.redirected.load(Ordering::Relaxed),
            self.returned.load(Ordering::Relaxed),
        )
    }
}

/// Everything the loop needs that does not change while it runs.
pub struct Redirect {
    /// The machine's own address on the physical link. Redirected
    /// packets are aimed here, which is what keeps them off loopback.
    pub local_addr: Ipv4Addr,
    /// The VPN node. Its traffic is the tunnel itself and must never be
    /// touched, or the tunnel would be carried through the tunnel.
    pub node_addr: Ipv4Addr,
    pub tcp_proxy_port: u16,
    pub udp_proxy_port: u16,
    /// This service's own executable, excluded unconditionally. In
    /// fail-open mode the proxy's upstream socket is unpinned and looks
    /// exactly like an ordinary app's, so without this the proxy would
    /// intercept itself.
    pub own_image: String,
}

/// The filter string, built from the addresses and ports in use.
///
/// Written out rather than assembled from parts because it is the one
/// piece of this module that runs in the kernel, and being able to read
/// it in one piece is worth more than being able to compose it.
/// Each exclusion is written as a pair of comparisons rather than as
/// `not (low and high)`. That is not style: WinDivert's parser rejects
/// `not` in front of a parenthesised expression, and it rejects it at
/// load time with a position offset and nothing else. Found by the
/// compile test below, which exists for exactly this.
pub fn filter_for(redirect: &Redirect) -> String {
    format!(
        "(outbound and ip and (tcp or udp) and not loopback \
           and ip.DstAddr != {node} \
           and (ip.DstAddr < 10.0.0.0 or ip.DstAddr > 10.255.255.255) \
           and (ip.DstAddr < 127.0.0.0 or ip.DstAddr > 127.255.255.255) \
           and (ip.DstAddr < 169.254.0.0 or ip.DstAddr > 169.254.255.255) \
           and (ip.DstAddr < 172.16.0.0 or ip.DstAddr > 172.31.255.255) \
           and (ip.DstAddr < 192.168.0.0 or ip.DstAddr > 192.168.255.255) \
           and ip.DstAddr < 224.0.0.0) \
         or (ip and tcp.SrcPort == {tcp}) \
         or (ip and udp.SrcPort == {udp})",
        node = redirect.node_addr,
        tcp = redirect.tcp_proxy_port,
        udp = redirect.udp_proxy_port,
    )
}

/// A running redirect loop.
pub struct Running {
    handle: Arc<Handle>,
    stop: Arc<AtomicBool>,
    pub stats: Arc<Stats>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Running {
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // The only thing that unblocks a thread sitting in recv. A flag
        // alone would leave them there for as long as the filter matched
        // nothing, which on a quiet machine is indefinitely.
        self.handle.shutdown();
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

pub fn start(
    redirect: Redirect,
    nat: Arc<Nat>,
    selection: Arc<Selection>,
) -> Result<Running, String> {
    let filter = filter_for(&redirect);
    // Checked before opening so a filter problem is reported as one.
    // WinDivertOpen fails with a generic error for a bad expression,
    // which is indistinguishable from the driver refusing to load.
    super::divert::compile_filter(&filter)
        .map_err(|e| format!("internal error: the packet filter is invalid ({e})"))?;

    let handle = Handle::open(&filter, WinDivertLayer::Network, WinDivertFlags::new())
        .map_err(|e| format!("could not start packet interception: {e}"))?;

    let handle = Arc::new(handle);
    let redirect = Arc::new(redirect);
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Stats::default());

    let threads = (0..WORKERS)
        .map(|_| {
            let (handle, redirect, nat, selection, stop, stats) = (
                handle.clone(),
                redirect.clone(),
                nat.clone(),
                selection.clone(),
                stop.clone(),
                stats.clone(),
            );
            std::thread::spawn(move || worker(handle, redirect, nat, selection, stop, stats))
        })
        .collect();

    Ok(Running { handle, stop, stats, threads })
}

fn worker(
    handle: Arc<Handle>,
    redirect: Arc<Redirect>,
    nat: Arc<Nat>,
    selection: Arc<Selection>,
    stop: Arc<AtomicBool>,
    stats: Arc<Stats>,
) {
    // One per thread rather than shared: the lookup caches a snapshot of
    // the connection tables, and a lock around it would put every
    // decision behind every other one.
    let mut owner = OwnerLookup::new();
    let mut packet = vec![0u8; MAX_PACKET];

    while !stop.load(Ordering::SeqCst) {
        let (len, mut address) = match handle.recv(&mut packet) {
            Ok(Some(received)) => received,
            // Shut down cleanly, or the driver gave up on us. Either way
            // there is nothing further to read.
            Ok(None) | Err(_) => return,
        };

        stats.seen.fetch_add(1, Ordering::Relaxed);
        let handled = handle_packet(
            &mut packet[..len as usize],
            &mut address,
            &redirect,
            &nat,
            &selection,
            &mut owner,
            &stats,
        );

        if handled {
            recalculate_checksums(&mut packet[..len as usize], len, &mut address);
        }
        // Sent whether or not anything was rewritten. A packet that
        // falls out of the logic above still has to reach the network.
        handle.send(&packet[..len as usize], len, &address);
    }
}

/// The fields the decision needs, or `None` if this is not an IPv4
/// TCP/UDP packet with a complete header.
struct Parsed {
    transport: Transport,
    header_len: usize,
    source: Ipv4Addr,
    destination: Ipv4Addr,
    source_port: u16,
    destination_port: u16,
    tcp_flags: u8,
}

fn parse(packet: &[u8]) -> Option<Parsed> {
    // Version and header length share the first byte; the length is in
    // 32-bit words and may be larger than the minimum when options are
    // present, so the transport header is not at a fixed offset.
    let first = *packet.first()?;
    if first >> 4 != 4 {
        return None;
    }
    let header_len = ((first & 0x0F) as usize) * 4;
    if header_len < 20 {
        return None;
    }

    let transport = match *packet.get(9)? {
        IPPROTO_TCP => Transport::Tcp,
        IPPROTO_UDP => Transport::Udp,
        _ => return None,
    };

    // A TCP header is 20 bytes and a UDP one is 8, but the flags byte
    // this reads sits at offset 13, so 14 covers both reads below.
    let ports = packet.get(header_len..header_len + 14)?;
    let tcp_flags = if matches!(transport, Transport::Tcp) { ports[13] } else { 0 };

    Some(Parsed {
        transport,
        header_len,
        source: Ipv4Addr::new(packet[12], packet[13], packet[14], packet[15]),
        destination: Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]),
        source_port: u16::from_be_bytes([ports[0], ports[1]]),
        destination_port: u16::from_be_bytes([ports[2], ports[3]]),
        tcp_flags,
    })
}

/// Rewrites the packet in place if it should be redirected. Returns
/// whether anything changed, which is what decides if the checksums need
/// recomputing.
fn handle_packet(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    redirect: &Redirect,
    nat: &Nat,
    selection: &Selection,
    owner: &mut OwnerLookup,
    stats: &Stats,
) -> bool {
    let Some(parsed) = parse(packet) else { return false };

    let proxy_port = match parsed.transport {
        Transport::Tcp => redirect.tcp_proxy_port,
        Transport::Udp => redirect.udp_proxy_port,
    };

    if parsed.source_port == proxy_port {
        let rewritten = rewrite_return_leg(packet, address, &parsed, nat);
        if rewritten {
            stats.returned.fetch_add(1, Ordering::Relaxed);
        }
        return rewritten;
    }

    // Read before the rewrite, which overwrites it: the return leg has
    // to be delivered on the interface the app's socket is expecting.
    //
    // SAFETY: this came from the network layer, so the Network arm of
    // the union is the live one.
    let interface_id = unsafe { address.union_field.Network.interface_id };
    let verdict = decide(&parsed, nat, selection, owner, redirect, interface_id, stats);
    match verdict {
        Verdict::Direct | Verdict::Unknown => false,
        Verdict::Redirect { nat_port } => {
            rewrite_outbound(packet, address, &parsed, redirect.local_addr, nat_port, proxy_port);
            stats.redirected.fetch_add(1, Ordering::Relaxed);
            true
        }
    }
}

fn decide(
    parsed: &Parsed,
    nat: &Nat,
    selection: &Selection,
    owner: &mut OwnerLookup,
    redirect: &Redirect,
    interface_id: u32,
    stats: &Stats,
) -> Verdict {
    // A SYN without an ACK is a new connection, so any leave-alone
    // verdict recorded against this port belongs to whatever held it
    // before and must not be inherited. The flow table is still
    // consulted, so a retransmitted SYN keeps its existing port.
    let is_new_connection = matches!(parsed.transport, Transport::Tcp)
        && parsed.tcp_flags & TCP_FLAG_SYN != 0
        && parsed.tcp_flags & TCP_FLAG_ACK == 0;

    let known = if is_new_connection {
        nat.lookup_flow(
            parsed.transport,
            parsed.source_port,
            parsed.destination,
            parsed.destination_port,
        )
        .map_or(Verdict::Unknown, |nat_port| Verdict::Redirect { nat_port })
    } else {
        nat.lookup(
            parsed.transport,
            parsed.source_port,
            parsed.destination,
            parsed.destination_port,
        )
    };
    if known != Verdict::Unknown {
        return known;
    }

    // Anything mid-connection that nothing is known about started before
    // Custom mode did, or before its app was selected. Moving it now
    // would break it: the app holds a socket to the real destination,
    // and rewriting half a live connection is not a redirect.
    if matches!(parsed.transport, Transport::Tcp) && !is_new_connection {
        nat.record_direct(parsed.transport, parsed.source_port);
        return Verdict::Direct;
    }

    let selected = match owner.image_for_port(parsed.transport, parsed.source_port) {
        Some(image) => !image.eq_ignore_ascii_case(&redirect.own_image) && selection.matches(image),
        // A port with no owner this can see. Leaving it alone is the
        // only safe answer -- redirecting traffic whose origin is
        // unknown is how a split tunnel becomes a full one.
        None => false,
    };
    if !selected {
        nat.record_direct(parsed.transport, parsed.source_port);
        return Verdict::Direct;
    }

    let origin = Origin {
        addr: parsed.destination,
        port: parsed.destination_port,
        client: parsed.source,
        client_port: parsed.source_port,
        interface_id,
    };
    match nat.redirect(parsed.transport, origin) {
        Some(nat_port) => {
            stats.matched.fetch_add(1, Ordering::Relaxed);
            Verdict::Redirect { nat_port }
        }
        // Out of synthetic ports. Fail open, consistent with the rest of
        // the feature: unprotected traffic beats a stalled game.
        None => {
            nat.record_direct(parsed.transport, parsed.source_port);
            Verdict::Direct
        }
    }
}

fn rewrite_outbound(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    parsed: &Parsed,
    local_addr: Ipv4Addr,
    nat_port: u16,
    proxy_port: u16,
) {
    // Destination only: the source address stays as the app's, so both
    // ends of the rewritten packet are ordinary addresses on a real
    // interface. Sending it to 127.0.0.1 instead is what made two
    // earlier attempts fail.
    packet[16..20].copy_from_slice(&local_addr.octets());

    let ports = parsed.header_len;
    // The source port becomes the flow's synthetic port, which is how
    // the proxy tells one peer from another on a single UDP socket.
    packet[ports..ports + 2].copy_from_slice(&nat_port.to_be_bytes());
    packet[ports + 2..ports + 4].copy_from_slice(&proxy_port.to_be_bytes());

    // Inbound, because this is now a delivery to a local socket rather
    // than something being sent anywhere.
    address.set_outbound(false);
}

fn rewrite_return_leg(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    parsed: &Parsed,
    nat: &Nat,
) -> bool {
    // The proxy addressed its reply to the flow's synthetic port, which
    // is what identifies the flow it belongs to.
    let Some(origin) = nat.origin(parsed.transport, parsed.destination_port) else {
        return false;
    };

    // Put the remote's identity back on it, so the app's socket
    // recognises the reply as coming from the address it dialled.
    packet[12..16].copy_from_slice(&origin.addr.octets());
    let ports = parsed.header_len;
    packet[ports..ports + 2].copy_from_slice(&origin.port.to_be_bytes());
    packet[ports + 2..ports + 4].copy_from_slice(&origin.client_port.to_be_bytes());

    address.set_outbound(false);
    // Restored because the stack routes an injected packet by its own
    // table, and this is the only record of where the app expects its
    // reply to arrive from.
    address.union_field.Network.interface_id = origin.interface_id;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal IPv4 TCP packet, so the parser is exercised against
    /// bytes rather than against a struct built to suit it.
    fn tcp_packet(
        source: Ipv4Addr,
        destination: Ipv4Addr,
        source_port: u16,
        destination_port: u16,
        flags: u8,
    ) -> Vec<u8> {
        let mut packet = vec![0u8; 40];
        packet[0] = 0x45; // IPv4, 20-byte header
        packet[9] = IPPROTO_TCP;
        packet[12..16].copy_from_slice(&source.octets());
        packet[16..20].copy_from_slice(&destination.octets());
        packet[20..22].copy_from_slice(&source_port.to_be_bytes());
        packet[22..24].copy_from_slice(&destination_port.to_be_bytes());
        packet[33] = flags;
        packet
    }

    #[test]
    fn parses_a_plain_tcp_packet() {
        let packet = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(1, 1, 1, 1),
            51234,
            443,
            TCP_FLAG_SYN,
        );
        let parsed = parse(&packet).expect("a well-formed packet should parse");

        assert_eq!(parsed.transport, Transport::Tcp);
        assert_eq!(parsed.source, Ipv4Addr::new(192, 168, 1, 20));
        assert_eq!(parsed.destination, Ipv4Addr::new(1, 1, 1, 1));
        assert_eq!(parsed.source_port, 51234);
        assert_eq!(parsed.destination_port, 443);
        assert_eq!(parsed.tcp_flags, TCP_FLAG_SYN);
    }

    #[test]
    fn honours_the_header_length_rather_than_assuming_twenty_bytes() {
        // IP options are rare but legal, and reading the ports at a
        // fixed offset would find payload bytes instead -- producing a
        // plausible port number and a redirect to nowhere.
        let mut packet = vec![0u8; 60];
        packet[0] = 0x46; // 24-byte header
        packet[9] = IPPROTO_TCP;
        packet[24..26].copy_from_slice(&4444u16.to_be_bytes());
        packet[26..28].copy_from_slice(&80u16.to_be_bytes());

        let parsed = parse(&packet).expect("options are legal");
        assert_eq!(parsed.header_len, 24);
        assert_eq!(parsed.source_port, 4444);
        assert_eq!(parsed.destination_port, 80);
    }

    #[test]
    fn refuses_packets_it_cannot_read_rather_than_indexing_past_the_end() {
        // A short or malformed packet must fall through to being passed
        // on untouched. Panicking here would take down a service running
        // as LocalSystem, and every packet on the machine goes past it.
        assert!(parse(&[]).is_none());
        assert!(parse(&[0x45]).is_none());
        assert!(parse(&vec![0x45; 25]).is_none(), "no protocol byte set");

        let mut truncated = vec![0u8; 24];
        truncated[0] = 0x45;
        truncated[9] = IPPROTO_TCP;
        assert!(parse(&truncated).is_none(), "the transport header is incomplete");

        let mut ipv6 = vec![0u8; 60];
        ipv6[0] = 0x60;
        assert!(parse(&ipv6).is_none());
    }

    #[test]
    fn the_outbound_rewrite_changes_the_destination_and_leaves_the_source() {
        // The exact shape that works. Rewriting the source too, or
        // aiming at loopback, are the two variants that were tried
        // against a real node and delivered nothing.
        let mut packet = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(1, 1, 1, 1),
            51234,
            443,
            TCP_FLAG_SYN,
        );
        let parsed = parse(&packet).unwrap();
        let mut address = WINDIVERT_ADDRESS::default();
        address.set_outbound(true);

        rewrite_outbound(
            &mut packet,
            &mut address,
            &parsed,
            Ipv4Addr::new(192, 168, 1, 20),
            41000,
            19999,
        );

        let after = parse(&packet).unwrap();
        assert_eq!(after.source, Ipv4Addr::new(192, 168, 1, 20), "source must be untouched");
        assert_eq!(after.destination, Ipv4Addr::new(192, 168, 1, 20));
        assert_eq!(after.source_port, 41000);
        assert_eq!(after.destination_port, 19999);
        assert!(!address.outbound(), "a delivery to a local socket is inbound");
    }

    #[test]
    fn the_return_rewrite_undoes_the_outbound_one() {
        // The round trip is the property that matters: whatever the
        // outbound leg did, the app has to see a reply from the address
        // and port it originally dialled, or its socket discards it.
        let nat = Nat::new();
        let origin = Origin {
            addr: Ipv4Addr::new(1, 1, 1, 1),
            port: 443,
            client: Ipv4Addr::new(192, 168, 1, 20),
            client_port: 51234,
            interface_id: 12,
        };
        let nat_port = nat.redirect(Transport::Tcp, origin).unwrap();

        let mut reply = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(192, 168, 1, 20),
            19999,
            nat_port,
            TCP_FLAG_ACK,
        );
        let parsed = parse(&reply).unwrap();
        let mut address = WINDIVERT_ADDRESS::default();

        assert!(rewrite_return_leg(&mut reply, &mut address, &parsed, &nat));

        let after = parse(&reply).unwrap();
        assert_eq!(after.source, Ipv4Addr::new(1, 1, 1, 1));
        assert_eq!(after.source_port, 443);
        assert_eq!(after.destination_port, 51234);
        // SAFETY: a network-layer address in a test we built.
        assert_eq!(unsafe { address.union_field.Network.interface_id }, 12);
    }

    #[test]
    fn a_reply_for_an_unknown_flow_is_left_alone() {
        // Rewriting it would invent a source address. Passing it on
        // unchanged is harmless: nothing is listening for it.
        let nat = Nat::new();
        let mut reply = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(192, 168, 1, 20),
            19999,
            41000,
            TCP_FLAG_ACK,
        );
        let parsed = parse(&reply).unwrap();
        let mut address = WINDIVERT_ADDRESS::default();
        assert!(!rewrite_return_leg(&mut reply, &mut address, &parsed, &nat));
    }

    #[test]
    fn the_filter_excludes_the_node_and_every_local_destination() {
        // Each exclusion is load-bearing. The node's address carries the
        // tunnel itself; the private ranges are the LAN a split tunnel
        // is supposed to leave alone; the multicast range is the
        // mDNS/LLMNR/SSDP chatter a new adapter provokes, which would
        // otherwise send local hostnames to the VPN server.
        let filter = filter_for(&Redirect {
            local_addr: Ipv4Addr::new(192, 168, 1, 20),
            node_addr: Ipv4Addr::new(203, 0, 113, 7),
            tcp_proxy_port: 19999,
            udp_proxy_port: 19998,
            own_image: String::new(),
        });

        assert!(filter.contains("ip.DstAddr != 203.0.113.7"));
        assert!(filter.contains("not loopback"));
        for range in ["10.0.0.0", "172.16.0.0", "192.168.0.0", "169.254.0.0", "224.0.0.0"] {
            assert!(filter.contains(range), "{range} must be excluded");
        }
        // `not (...)` is what the parser refuses, so its absence is
        // worth asserting rather than only catching in the compile test.
        assert!(!filter.contains("not ("));
        assert!(filter.contains("tcp.SrcPort == 19999"));
        assert!(filter.contains("udp.SrcPort == 19998"));
    }

    #[test]
    fn the_filter_the_driver_gets_actually_compiles() {
        // A filter string is only checked when the driver parses it, so
        // a typo in the expression above would otherwise surface as
        // Custom mode failing to start on a customer's machine.
        let filter = filter_for(&Redirect {
            local_addr: Ipv4Addr::new(192, 168, 1, 20),
            node_addr: Ipv4Addr::new(203, 0, 113, 7),
            tcp_proxy_port: 19999,
            udp_proxy_port: 19998,
            own_image: String::new(),
        });
        super::super::divert::compile_filter(&filter).expect("the filter must compile");
    }
}
