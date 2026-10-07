//! Reading a packet, once, and building the one packet this loop writes
//! from nothing.
//!
//! Everything here is a pure function of bytes: it decides nothing about
//! where a packet goes. The loop reads each packet through [`parse`] or
//! [`parse_v6`] in its dispatcher and hands that reading on, so the
//! worker, the ladder in `decide` and the flow hash all agree about what
//! the packet was.

use std::net::{Ipv4Addr, Ipv6Addr};

use crate::split_tunnel::policy::Transport;

pub(super) const IPPROTO_TCP: u8 = 6;
pub(super) const IPPROTO_UDP: u8 = 17;

/// ICMP, on both families.
///
/// Named here despite nothing in this loop ever *carrying* an ICMP
/// packet, because the loop now has to recognise one in order to refuse
/// it. See [`icmp_echo_request`] for why refusing is the only available
/// answer.
pub(super) const IPPROTO_ICMP: u8 = 1;
pub(super) const IPPROTO_ICMPV6: u8 = 58;

/// The first byte of an ICMP header is its type. These are the two that
/// mean "ping", one per family; they are numbered differently and there
/// is no relationship between the numbers.
pub(super) const ICMP_ECHO_REQUEST: u8 = 8;
pub(super) const ICMPV6_ECHO_REQUEST: u8 = 128;
pub(super) const TCP_FLAG_SYN: u8 = 0x02;
pub(super) const TCP_FLAG_ACK: u8 = 0x10;
pub(super) const TCP_FLAG_FIN: u8 = 0x01;
pub(super) const TCP_FLAG_RST: u8 = 0x04;

/// The hop limit put on a synthesised reset.
///
/// It never crosses a router -- the packet is injected straight into
/// this machine's receive path -- so the value only has to be something
/// no stack objects to. 64 is what everything else uses.
pub(super) const RESET_HOP_LIMIT: u8 = 64;

/// The fields the decision needs, or `None` if this is not an IPv4
/// TCP/UDP packet with a complete header.
pub(super) struct Parsed {
    pub(super) transport: Transport,
    pub(super) header_len: usize,
    pub(super) source: Ipv4Addr,
    pub(super) destination: Ipv4Addr,
    pub(super) source_port: u16,
    pub(super) destination_port: u16,
    pub(super) tcp_flags: u8,
}

/// Whether this is an outbound ICMP echo request -- a ping -- on either
/// family.
///
/// # Why this loop refuses ping rather than carrying it
///
/// A real game measured on the rig had its TCP fully tunnelled while
/// **174 ICMP echo requests left in the clear** to roughly 170 of its
/// world servers, one per world, every time its server browser
/// refreshed. So a correctly-routed player still handed their real
/// address to every one of those hosts, and the latency numbers the
/// game displayed described the direct path rather than the tunnel.
///
/// Carrying them instead is not available, for two independent reasons,
/// either of which alone would settle it:
///
/// * **Nothing can say which process sent one.** Attribution here is
///   `port -> pid`, read from `GetExtendedTcpTable` and
///   `GetExtendedUdpTable` (see `tables::OwnerLookup`). An ICMP packet
///   has no port, and Win32 has no ICMP analogue of those tables -- the
///   endpoint tables cover TCP and UDP and nothing else. WFP's ALE
///   layers *do* know the process for ICMP, but WinDivert exposes them
///   only as a receive-only observation layer that cannot block or
///   inject, and the flow event that carries the process id is raised by
///   the same first packet we would have to hold. For a sweep that pings
///   170 hosts once each, *every* packet is a first packet, so there is
///   nothing to correlate against in time.
/// * **The relay could not carry one if we knew.** `relay/` is a
///   transparent NAT relay with no wire protocol: the loop rewrites the
///   destination to the relay's port and the source to a synthetic NAT
///   port, and the relay recovers the real destination *from that source
///   port alone*. The whole mechanism is keyed on ports. An ICMP packet
///   has none, so there is nothing to rewrite and nothing to look the
///   origin up by.
///
/// That leaves refusing. It is deliberately the narrowest refusal that
/// closes the disclosure: **echo requests only**, and only to the public
/// destinations the filter already selects, so pinging the LAN and the
/// default gateway keeps working and ICMP error messages are untouched.
///
/// No state and no key. The decision is a pure function of the bytes in
/// front of it, which is why it needs no cache and cannot grow
/// `FlowKey` -- and why it sits *above* every selection and exit
/// question rather than beside them.
///
/// **The cost, which the app tells the customer about rather than
/// hiding:** this cannot be narrowed to the selected applications,
/// because narrowing it would need exactly the attribution that does not
/// exist. While Custom mode is on, ping stops working for everything on
/// the machine. The alternative was an address disclosure the customer
/// could not see, and a visible broken feature beats an invisible leak.
///
/// An ICMPv6 echo request behind an extension-header chain is recognised
/// too: the IPv6 arms read the same chain walk as `parse_v6`. That used
/// to be a stated gap -- only the fixed header was looked at, so a ping
/// behind a hop-by-hop or destination-options header went out in the
/// clear. Windows' own ICMP helper was never seen to emit one; it was a
/// hole rather than a proof, and now it is neither.
/// Whether this is ICMP at all, on either family.
///
/// Separate from [`icmp_echo_request`] because the two answers are used
/// for opposite purposes: an echo request is refused, and everything
/// else ICMP is passed through untouched rather than handed to code
/// that expects ports to exist.
pub(super) fn is_icmp(packet: &[u8]) -> bool {
    match packet.first().map(|first| first >> 4) {
        Some(4) => packet.get(9) == Some(&IPPROTO_ICMP),
        Some(6) => v6_upper_layer(packet).is_some_and(|(next, _)| next == IPPROTO_ICMPV6),
        _ => false,
    }
}

pub(super) fn icmp_echo_request(packet: &[u8]) -> bool {
    match packet.first().map(|first| first >> 4) {
        Some(4) => {
            if *packet.get(9).unwrap_or(&0) != IPPROTO_ICMP {
                return false;
            }
            // Options may sit between the fixed header and the ICMP one,
            // so the type byte is not at a fixed offset.
            let header_len = ((packet[0] & 0x0F) as usize) * 4;
            if header_len < 20 {
                return false;
            }
            packet.get(header_len) == Some(&ICMP_ECHO_REQUEST)
        }
        Some(6) => v6_upper_layer(packet).is_some_and(|(next, offset)| {
            next == IPPROTO_ICMPV6 && packet.get(offset) == Some(&ICMPV6_ECHO_REQUEST)
        }),
        _ => false,
    }
}

pub(super) fn parse(packet: &[u8]) -> Option<Parsed> {
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

/// The header offsets an IPv6 decision needs.
///
/// Deliberately much less than [`Parsed`] carries. An IPv6 packet here
/// is only ever passed through or dropped, never rewritten, so the
/// addresses are not needed -- and not reading them keeps this from
/// looking like the beginning of a v6 rewrite that does not exist.
pub(super) struct ParsedV6 {
    pub(super) transport: Transport,
    /// Where the packet is going, read for the same reason the IPv4
    /// parser reads it: the decision about a packet nobody can
    /// attribute turns on whether the destination is the internet or
    /// the local network, and asking the packet is what stops that rule
    /// and the kernel filter drifting into disagreement.
    pub(super) destination: Ipv6Addr,
    pub(super) source_port: u16,
    pub(super) destination_port: u16,
    pub(super) tcp_flags: u8,
    /// Where the transport header begins, after however many extension
    /// headers this packet carried.
    ///
    /// Added when the block gained a reset. Everything above can be
    /// decided from the ports alone, but building a reset the
    /// application's own stack will accept means reading the sequence
    /// numbers out of the segment being refused -- and those are not at
    /// a fixed offset for exactly the reason `parse_v6` exists.
    pub(super) transport_offset: usize,
}

/// Extension headers, which sit between the IPv6 header and the
/// transport one and must be walked rather than assumed away.
pub(super) const IPPROTO_HOPOPTS: u8 = 0;
pub(super) const IPPROTO_ROUTING: u8 = 43;
pub(super) const IPPROTO_FRAGMENT: u8 = 44;
pub(super) const IPPROTO_AH: u8 = 51;
pub(super) const IPPROTO_DSTOPTS: u8 = 60;

/// The fixed IPv6 header, before any extension header.
pub(super) const IPV6_HEADER: usize = 40;

/// How many extension headers are walked before giving up.
///
/// A real packet has none or one. A long chain is either malformed or
/// built to be, and either way the answer is to stop rather than to keep
/// following a next-header field around a packet an attacker supplied.
pub(super) const MAX_EXTENSION_HEADERS: usize = 8;

/// Reads the ports out of an IPv6 packet, or `None` when they cannot be
/// found.
///
/// `None` is not "this is not TCP or UDP" -- the filter already settled
/// that, since WinDivert walks the chain itself to decide `tcp or udp`.
/// It means *this code* could not follow the chain: an extension header
/// it does not know, or a fragment after the first, which carries no
/// transport header at all. The caller must treat that as an unknown
/// owner rather than as permission to pass the packet on.
pub(super) fn parse_v6(packet: &[u8]) -> Option<ParsedV6> {
    let (next, offset) = v6_upper_layer(packet)?;
    let transport = match next {
        IPPROTO_TCP => Transport::Tcp,
        IPPROTO_UDP => Transport::Udp,
        _ => return None,
    };

    // Bytes 24..40 of the fixed header, which `v6_upper_layer` has
    // already required to be there.
    let mut destination = [0u8; 16];
    destination.copy_from_slice(&packet[24..40]);
    let destination = Ipv6Addr::from(destination);

    // Flags sit at offset 13 of a TCP header, so 14 bytes covers
    // both reads -- the same reasoning as the IPv4 parser.
    let ports = packet.get(offset..offset + 14)?;
    Some(ParsedV6 {
        transport,
        destination,
        source_port: u16::from_be_bytes([ports[0], ports[1]]),
        destination_port: u16::from_be_bytes([ports[2], ports[3]]),
        tcp_flags: if matches!(transport, Transport::Tcp) { ports[13] } else { 0 },
        transport_offset: offset,
    })
}

/// Walks an IPv6 packet's extension headers to the protocol after them,
/// returning that protocol and where its header begins -- or `None` when
/// the chain cannot be followed: an unknown extension header, a fragment
/// after the first, or more headers than [`MAX_EXTENSION_HEADERS`].
///
/// Split out of `parse_v6` so the ICMPv6 checks read the same walk. They
/// used to look only at the fixed header's Next Header and at byte 40,
/// so an echo request behind any extension header was not recognised
/// and went out in the clear -- the gap the old note on
/// `icmp_echo_request` stated rather than closed.
pub(super) fn v6_upper_layer(packet: &[u8]) -> Option<(u8, usize)> {
    if packet.len() < IPV6_HEADER || packet.first()? >> 4 != 6 {
        return None;
    }
    let mut next = packet[6];
    let mut offset = IPV6_HEADER;

    for _ in 0..MAX_EXTENSION_HEADERS {
        match next {
            // Header length is in 8-byte units, not counting the first.
            IPPROTO_HOPOPTS | IPPROTO_ROUTING | IPPROTO_DSTOPTS => {
                let header = packet.get(offset..offset + 2)?;
                next = header[0];
                offset += (header[1] as usize + 1) * 8;
            }
            // Authentication headers count in 4-byte units and subtract
            // two rather than one, which is the sort of detail that
            // makes a hand-rolled walk worth writing down.
            IPPROTO_AH => {
                let header = packet.get(offset..offset + 2)?;
                next = header[0];
                offset += (header[1] as usize + 2) * 4;
            }
            IPPROTO_FRAGMENT => {
                let header = packet.get(offset..offset + 8)?;
                // Only the first fragment carries the upper-layer
                // header; the rest have nothing to read and no owner to
                // find.
                if u16::from_be_bytes([header[2], header[3]]) & 0xFFF8 != 0 {
                    return None;
                }
                next = header[0];
                offset += 8;
            }
            upper => return Some((upper, offset)),
        }
    }
    None
}

/// A TCP reset addressed back to the application, built from the packet
/// being refused.
///
/// # Why a blocked connection is told rather than left hanging
///
/// Blocking a selected application's IPv6 is the right answer -- see the
/// module comment -- but *silently* blocking it is not the same thing.
/// A new connection recovers on its own: the SYN is swallowed, no answer
/// comes, and every browser and every resolver falls back to the A
/// record within a fraction of a second. Measured at 385ms on the rig.
///
/// A connection that already existed does not recover. The application
/// holds a socket it believes is fine, its segments vanish, and TCP does
/// what TCP does about a black hole: it retransmits, backs off, and
/// keeps the socket for minutes before giving up. Nothing tells it there
/// is a perfectly good IPv4 path to the same host. So Custom mode coming
/// on turned a working page into a hang, and the counters read
/// `blocked_v6` climbing, which looks exactly like the feature working.
///
/// A reset converts that into the case that already recovers. The
/// application is told its connection is gone -- which it is -- and
/// opens a new one, which fails over to IPv4 in milliseconds.
///
/// # Why it is built from the packet in hand
///
/// A stack does not accept any reset addressed at it; a reset outside
/// the receive window is discarded, which is the whole reason blind
/// reset attacks are hard. The one already in the window is the one
/// derived from a segment the socket just sent: its acknowledgement
/// number is, by definition, the sequence number the peer would next
/// send from. So the reset is sent with `seq` equal to that
/// acknowledgement, and acknowledges everything the segment consumed.
/// A pure SYN carries no acknowledgement to borrow, so a reset for one
/// starts at zero and acknowledges the initial sequence number, which is
/// what a refusing host sends.
///
/// UDP gets no equivalent, and cannot: there is no in-band way to tell a
/// datagram socket that its peer is unreachable, so a selected
/// application's IPv6 UDP stays silently swallowed. That is a gap, and
/// this comment is where it is stated rather than a decision hidden in
/// the shape of the code.
pub(super) fn build_v6_reset(packet: &[u8], parsed: &ParsedV6) -> Option<Vec<u8>> {
    if !matches!(parsed.transport, Transport::Tcp) {
        return None;
    }
    // Never answer a reset with a reset. The connection is already gone
    // and the two ends would otherwise have something to say to each
    // other about it.
    if parsed.tcp_flags & TCP_FLAG_RST != 0 {
        return None;
    }

    let tcp = packet.get(parsed.transport_offset..parsed.transport_offset + 14)?;
    let their_seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);
    let their_ack = u32::from_be_bytes([tcp[8], tcp[9], tcp[10], tcp[11]]);
    // The data offset is in 32-bit words and cannot legally be under
    // five; a malformed one is clamped rather than trusted, because it
    // is subtracted below and an under-count would acknowledge bytes
    // that were never sent.
    let data_offset = (((tcp[12] >> 4) as usize) * 4).max(20);

    // How much sequence space the segment being refused consumed, which
    // is what the reset has to acknowledge. `payload_length` counts
    // everything after the fixed header; the captured packet may be
    // shorter than it claims, so the smaller of the two is used.
    let declared = IPV6_HEADER + u16::from_be_bytes([*packet.get(4)?, *packet.get(5)?]) as usize;
    let segment = declared.min(packet.len()).checked_sub(parsed.transport_offset)?;
    let consumed = segment.saturating_sub(data_offset) as u32
        + u32::from(parsed.tcp_flags & TCP_FLAG_SYN != 0)
        + u32::from(parsed.tcp_flags & TCP_FLAG_FIN != 0);

    let (seq, ack) = if parsed.tcp_flags & TCP_FLAG_ACK != 0 {
        (their_ack, their_seq.wrapping_add(consumed))
    } else {
        // A first SYN. Nothing has been acknowledged yet, so there is
        // no number to borrow and the reset starts where a refusing
        // host starts.
        (0, their_seq.wrapping_add(consumed))
    };

    let source = packet.get(8..24)?;
    let destination = packet.get(24..40)?;

    let mut reset = vec![0u8; IPV6_HEADER + 20];
    reset[0] = 0x60;
    reset[4..6].copy_from_slice(&20u16.to_be_bytes());
    reset[6] = IPPROTO_TCP;
    reset[7] = RESET_HOP_LIMIT;
    // Both ends swapped: this has to look like the remote answering.
    reset[8..24].copy_from_slice(destination);
    reset[24..40].copy_from_slice(source);

    let tcp = IPV6_HEADER;
    reset[tcp..tcp + 2].copy_from_slice(&parsed.destination_port.to_be_bytes());
    reset[tcp + 2..tcp + 4].copy_from_slice(&parsed.source_port.to_be_bytes());
    reset[tcp + 4..tcp + 8].copy_from_slice(&seq.to_be_bytes());
    reset[tcp + 8..tcp + 12].copy_from_slice(&ack.to_be_bytes());
    reset[tcp + 12] = 0x50; // data offset: five words, no options
    reset[tcp + 13] = TCP_FLAG_RST | TCP_FLAG_ACK;
    // Window, checksum and urgent pointer stay zero. The checksum is
    // computed by the driver's own helper at injection, because a
    // hand-rolled one that is wrong is discarded by the receiving stack
    // without a word -- which would put this straight back to the silent
    // black hole it exists to remove.
    Some(reset)
}
