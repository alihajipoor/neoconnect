//! The address translation table behind Custom mode.
//!
//! Redirecting a connection means overwriting where it was going, so
//! something has to remember the original -- the proxy is handed a
//! socket with no trace of the destination the app asked for.
//!
//! # Why every flow gets its own port
//!
//! The obvious key is the app's own source port, and for TCP it would be
//! enough: a TCP socket has exactly one peer. UDP has no such promise. A
//! game routinely talks to a matchmaking service and a match server from
//! one socket, and a resolver socket queries several nameservers -- so
//! keying on the source port alone would send the second peer's
//! datagrams to the first, which is not a dropped packet but a wrong
//! one.
//!
//! So each flow is assigned a synthetic source port, and the packet
//! handed to the proxy carries that instead. The proxy then sees one
//! distinct peer per flow, and the return leg puts the app's real source
//! port back before it is delivered. TCP goes through the same machinery
//! rather than a simpler path of its own: it costs nothing, and it makes
//! a reused source port -- Windows recycles them -- unable to inherit a
//! previous connection's destination.
//!
//! Entries are retired when idle. Nothing signals the end of a UDP flow,
//! and a TCP connection can end in ways this never sees, so a table that
//! only ever grew would be the outcome of leaving Custom mode on.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::owner::Transport;

/// Where a redirected packet was really going, plus what has to be put
/// back on the way home.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Origin {
    /// The destination the app asked for.
    pub addr: Ipv4Addr,
    pub port: u16,
    /// The app's own address and port, restored on the return leg so its
    /// socket recognises the reply.
    pub client: Ipv4Addr,
    pub client_port: u16,
    /// The interface the original packet was on. Restored on the return
    /// leg, because the stack routes an injected packet by its own table
    /// and this is the only record of where the app expects it from.
    pub interface_id: u32,
}

/// Synthetic source ports are drawn from here. Above the range Windows
/// hands out by default, so a flow's assigned port is unlikely to
/// coincide with a real local port and confuse anyone reading a capture.
const NAT_PORT_FIRST: u16 = 40_000;
const NAT_PORT_LAST: u16 = 60_000;

/// How long an idle TCP flow is kept.
///
/// A live connection that goes quiet mid-session must not lose its
/// entry: the app already holds a socket to the proxy, and forgetting
/// where it was going would strand it.
const TCP_IDLE: Duration = Duration::from_secs(180);

/// UDP has no close, so this is the only thing that ever retires a flow.
/// Short enough to release the proxy's socket for a game that has
/// exited, long enough not to cut one that is merely between rounds.
const UDP_IDLE: Duration = Duration::from_secs(60);

/// How long a "leave this alone" verdict is trusted before the owning
/// process is checked again.
///
/// Deliberately *not* refreshed by use. A verdict is keyed on the source
/// port, Windows reuses ports, and a selected app inheriting one from a
/// browser would otherwise keep going out in the clear for as long as it
/// kept the port busy -- the longer it played, the longer the leak. Five
/// seconds bounds that, and costs no more than a hash lookup per port
/// per interval, because the connection tables underneath are cached.
const DIRECT_VERDICT_TTL: Duration = Duration::from_secs(5);

/// Identifies one flow on the way out, before anything is rewritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct FlowKey {
    transport: Transport,
    client_port: u16,
    destination: Ipv4Addr,
    destination_port: u16,
}

struct Redirected {
    origin: Origin,
    nat_port: u16,
    last_seen: Instant,
}

#[derive(Default)]
struct Tables {
    /// Flow -> the synthetic port carrying it.
    forward: HashMap<FlowKey, u16>,
    /// Synthetic port -> everything needed to undo the rewrite.
    reverse: HashMap<(Transport, u16), Redirected>,
    /// Source ports belonging to applications the customer did not
    /// select, and when that was decided -- so their packets cost one
    /// lookup rather than a walk of the connection tables, without the
    /// verdict outliving the process it was made about.
    direct: HashMap<(Transport, u16), Instant>,
    next_port: u16,
}

pub struct Nat {
    tables: Mutex<Tables>,
}

/// What the redirect loop should do with a packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Send it back out untouched.
    Direct,
    /// Rewrite it to the proxy, presenting it as coming from this port.
    Redirect { nat_port: u16 },
    /// Nothing is known about this flow yet; the caller must work out
    /// who owns the port and then record the answer.
    Unknown,
}

impl Default for Nat {
    fn default() -> Self {
        Self::new()
    }
}

impl Nat {
    pub fn new() -> Self {
        Self { tables: Mutex::new(Tables { next_port: NAT_PORT_FIRST, ..Tables::default() }) }
    }

    /// What to do with an outbound packet, keeping alive whatever it
    /// hits.
    pub fn lookup(
        &self,
        transport: Transport,
        client_port: u16,
        destination: Ipv4Addr,
        destination_port: u16,
    ) -> Verdict {
        if let Some(nat_port) =
            self.lookup_flow(transport, client_port, destination, destination_port)
        {
            return Verdict::Redirect { nat_port };
        }

        let tables = self.tables.lock().unwrap();
        match tables.direct.get(&(transport, client_port)) {
            Some(decided) if decided.elapsed() < DIRECT_VERDICT_TTL => Verdict::Direct,
            _ => Verdict::Unknown,
        }
    }

    /// The synthetic port already carrying this exact flow, if any.
    ///
    /// Separate from [`Nat::lookup`] because a TCP SYN must ignore the
    /// leave-alone cache -- a SYN means a new connection whatever the
    /// port was doing before -- while still recognising a retransmitted
    /// SYN, which would otherwise be handed a second synthetic port and
    /// arrive at the proxy as a second connection.
    pub fn lookup_flow(
        &self,
        transport: Transport,
        client_port: u16,
        destination: Ipv4Addr,
        destination_port: u16,
    ) -> Option<u16> {
        let key = FlowKey { transport, client_port, destination, destination_port };
        let mut tables = self.tables.lock().unwrap();
        let &nat_port = tables.forward.get(&key)?;

        match tables.reverse.get_mut(&(transport, nat_port)) {
            Some(entry) => {
                entry.last_seen = Instant::now();
                Some(nat_port)
            }
            None => {
                // The reverse half was retired without the forward half,
                // which should not happen -- drop the orphan and let the
                // caller decide again rather than rewriting to a port
                // with no origin behind it.
                tables.forward.remove(&key);
                None
            }
        }
    }

    /// Records that a port belongs to an application that was not
    /// selected, as of now.
    pub fn record_direct(&self, transport: Transport, client_port: u16) {
        let mut tables = self.tables.lock().unwrap();
        tables.direct.insert((transport, client_port), Instant::now());
    }

    /// Starts redirecting a flow, assigning it a synthetic source port.
    ///
    /// Returns `None` when no port is free, which the caller must treat
    /// as "leave this flow alone". Failing open here matches the
    /// decision made for the feature as a whole: a game that keeps
    /// playing unprotected is better than one that stops.
    pub fn redirect(&self, transport: Transport, origin: Origin) -> Option<u16> {
        let key = FlowKey {
            transport,
            client_port: origin.client_port,
            destination: origin.addr,
            destination_port: origin.port,
        };
        let mut tables = self.tables.lock().unwrap();
        let nat_port = tables.allocate(transport)?;

        tables.forward.insert(key, nat_port);
        tables
            .reverse
            .insert((transport, nat_port), Redirected { origin, nat_port, last_seen: Instant::now() });
        // A port cannot be both left alone and redirected. A TCP SYN
        // re-decides from scratch, so this is how a stale verdict from
        // the port's previous owner is cleared.
        tables.direct.remove(&(transport, origin.client_port));
        Some(nat_port)
    }

    /// The origin behind a synthetic port. Used by the proxy to learn
    /// where to connect, and by the return leg to undo the rewrite.
    pub fn origin(&self, transport: Transport, nat_port: u16) -> Option<Origin> {
        let tables = self.tables.lock().unwrap();
        Some(tables.reverse.get(&(transport, nat_port))?.origin)
    }

    /// Retires idle entries. Returns the synthetic UDP ports that were
    /// dropped, so the proxy can close the sockets serving them -- one
    /// socket and one blocked thread per flow is a real cost to leave
    /// behind.
    pub fn expire_idle(&self) -> Vec<u16> {
        let now = Instant::now();
        let mut tables = self.tables.lock().unwrap();

        let mut dropped_udp = Vec::new();
        let mut dropped_ports = Vec::new();
        tables.reverse.retain(|(transport, port), entry| {
            let idle = match transport {
                Transport::Tcp => TCP_IDLE,
                Transport::Udp => UDP_IDLE,
            };
            let alive = now.duration_since(entry.last_seen) < idle;
            if !alive {
                dropped_ports.push(entry.nat_port);
                if matches!(transport, Transport::Udp) {
                    dropped_udp.push(*port);
                }
            }
            alive
        });
        tables.forward.retain(|_, nat_port| !dropped_ports.contains(nat_port));
        tables.direct.retain(|_, decided| now.duration_since(*decided) < DIRECT_VERDICT_TTL);

        dropped_udp
    }
}

impl Tables {
    /// Finds an unused synthetic port, scanning forward from the last
    /// one handed out so the common case is a single step.
    fn allocate(&mut self, transport: Transport) -> Option<u16> {
        let span = (NAT_PORT_LAST - NAT_PORT_FIRST) as u32;
        for _ in 0..=span {
            let port = self.next_port;
            self.next_port = if port >= NAT_PORT_LAST { NAT_PORT_FIRST } else { port + 1 };
            if !self.reverse.contains_key(&(transport, port)) {
                return Some(port);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin_to(destination: Ipv4Addr, port: u16, client_port: u16) -> Origin {
        Origin {
            addr: destination,
            port,
            client: Ipv4Addr::new(192, 168, 1, 20),
            client_port,
            interface_id: 12,
        }
    }

    #[test]
    fn one_source_port_talking_to_two_peers_gets_two_flows() {
        // The case that made per-flow ports necessary. A UDP socket may
        // hold several peers at once; sharing one entry between them
        // would deliver the second peer's traffic to the first.
        let nat = Nat::new();
        let first = origin_to(Ipv4Addr::new(1, 1, 1, 1), 53, 5000);
        let second = origin_to(Ipv4Addr::new(8, 8, 8, 8), 53, 5000);

        let a = nat.redirect(Transport::Udp, first).unwrap();
        let b = nat.redirect(Transport::Udp, second).unwrap();

        assert_ne!(a, b, "two peers on one source port must not share a port");
        assert_eq!(nat.origin(Transport::Udp, a), Some(first));
        assert_eq!(nat.origin(Transport::Udp, b), Some(second));
    }

    #[test]
    fn a_known_flow_is_recognised_without_deciding_again() {
        let nat = Nat::new();
        let origin = origin_to(Ipv4Addr::new(1, 1, 1, 1), 443, 5100);
        let nat_port = nat.redirect(Transport::Tcp, origin).unwrap();

        assert_eq!(
            nat.lookup(Transport::Tcp, 5100, Ipv4Addr::new(1, 1, 1, 1), 443),
            Verdict::Redirect { nat_port }
        );
    }

    #[test]
    fn tcp_and_udp_ports_do_not_collide() {
        // The same number is two different sockets, possibly owned by
        // two different applications -- one keyed table would let a
        // game's UDP verdict decide a browser's TCP traffic.
        let nat = Nat::new();
        nat.record_direct(Transport::Tcp, 5200);
        assert_eq!(
            nat.lookup(Transport::Tcp, 5200, Ipv4Addr::new(1, 1, 1, 1), 443),
            Verdict::Direct
        );
        assert_eq!(
            nat.lookup(Transport::Udp, 5200, Ipv4Addr::new(1, 1, 1, 1), 443),
            Verdict::Unknown
        );
    }

    #[test]
    fn redirecting_clears_a_stale_leave_alone_verdict() {
        // Ports are reused. If the previous owner's verdict survived, a
        // selected app inheriting the port would keep going out in the
        // clear while the UI claimed it was tunnelled.
        let nat = Nat::new();
        nat.record_direct(Transport::Tcp, 5300);
        let origin = origin_to(Ipv4Addr::new(1, 1, 1, 1), 443, 5300);
        let nat_port = nat.redirect(Transport::Tcp, origin).unwrap();

        assert_eq!(
            nat.lookup(Transport::Tcp, 5300, Ipv4Addr::new(1, 1, 1, 1), 443),
            Verdict::Redirect { nat_port }
        );
    }

    #[test]
    fn a_leave_alone_verdict_is_not_kept_alive_by_traffic() {
        // The point of the whole timestamp. If use refreshed it, an app
        // that inherited a port from a browser would stay untunnelled
        // for as long as it kept the port busy -- the busier it was, the
        // longer Custom mode silently did not apply to it.
        let nat = Nat::new();
        nat.record_direct(Transport::Udp, 5350);
        assert_eq!(
            nat.lookup(Transport::Udp, 5350, Ipv4Addr::new(1, 1, 1, 1), 53),
            Verdict::Direct
        );

        {
            let mut tables = nat.tables.lock().unwrap();
            let decided = tables.direct.get_mut(&(Transport::Udp, 5350)).unwrap();
            *decided = Instant::now() - DIRECT_VERDICT_TTL * 2;
        }
        assert_eq!(
            nat.lookup(Transport::Udp, 5350, Ipv4Addr::new(1, 1, 1, 1), 53),
            Verdict::Unknown,
            "an expired verdict must be re-decided, not renewed"
        );
    }

    #[test]
    fn a_retransmitted_syn_reuses_its_flow() {
        // A SYN bypasses the leave-alone cache, but not the flow table.
        // If it did, every retransmission would take another synthetic
        // port and arrive at the proxy as a separate connection.
        let nat = Nat::new();
        let origin = origin_to(Ipv4Addr::new(1, 1, 1, 1), 443, 5450);
        let first = nat.redirect(Transport::Tcp, origin).unwrap();

        let again = nat.lookup_flow(Transport::Tcp, 5450, Ipv4Addr::new(1, 1, 1, 1), 443);
        assert_eq!(again, Some(first));
    }

    #[test]
    fn an_unknown_flow_says_so_rather_than_guessing() {
        // Unknown is not Direct. Conflating them would mean every new
        // connection from a selected app escaped before anyone asked who
        // owned it.
        let nat = Nat::new();
        assert_eq!(
            nat.lookup(Transport::Tcp, 5400, Ipv4Addr::new(1, 1, 1, 1), 443),
            Verdict::Unknown
        );
    }

    #[test]
    fn expiry_drops_both_halves_of_a_flow() {
        // A forward entry outliving its reverse half would rewrite
        // packets to a port with no origin behind it -- the proxy would
        // accept the connection and have nowhere to send it.
        let nat = Nat::new();
        let origin = origin_to(Ipv4Addr::new(1, 1, 1, 1), 53, 5500);
        let nat_port = nat.redirect(Transport::Udp, origin).unwrap();

        {
            let mut tables = nat.tables.lock().unwrap();
            let entry = tables.reverse.get_mut(&(Transport::Udp, nat_port)).unwrap();
            entry.last_seen = Instant::now() - UDP_IDLE * 2;
        }

        assert_eq!(nat.expire_idle(), vec![nat_port]);
        assert_eq!(nat.origin(Transport::Udp, nat_port), None);
        assert_eq!(
            nat.lookup(Transport::Udp, 5500, Ipv4Addr::new(1, 1, 1, 1), 53),
            Verdict::Unknown
        );
    }

    #[test]
    fn port_allocation_wraps_without_reusing_a_live_flow() {
        let nat = Nat::new();
        {
            let mut tables = nat.tables.lock().unwrap();
            tables.next_port = NAT_PORT_LAST;
        }
        let first = nat.redirect(Transport::Tcp, origin_to(Ipv4Addr::new(1, 1, 1, 1), 1, 1)).unwrap();
        let second =
            nat.redirect(Transport::Tcp, origin_to(Ipv4Addr::new(1, 1, 1, 1), 2, 2)).unwrap();

        assert_eq!(first, NAT_PORT_LAST);
        assert_eq!(second, NAT_PORT_FIRST);
        assert_ne!(first, second);
    }
}
