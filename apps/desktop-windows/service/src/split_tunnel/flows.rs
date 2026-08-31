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
    /// Where the proxy should dial instead of `addr:port`, when those
    /// differ.
    ///
    /// Only DNS uses this today, and it is the whole point of carrying
    /// it: a lookup has to be answered by a resolver reached *through*
    /// the tunnel, while the reply must still appear to come from the
    /// resolver the application asked, or its socket discards it. So
    /// the query goes to `upstream` and the return leg is rewritten
    /// from `addr:port` as usual.
    pub upstream: Option<std::net::SocketAddrV4>,
    /// Which concurrent exit this flow leaves from, as an index into
    /// [`super::proxy::ExitRelays`].
    ///
    /// `None` -- overwhelmingly the common case -- means the session's
    /// own tunnel adapter, which is what every flow used before
    /// concurrent exits existed.
    ///
    /// # Why it is here and not on `FlowKey`
    ///
    /// `FlowKey` must not grow another component. It is the key of
    /// `Tables::direct`, the leave-alone cache, and that cache records
    /// "this flow is not carried" -- a fact about an application and a
    /// peer that is true whichever exit the session is on. Adding an
    /// exit would multiply the entries a chatty socket produces and
    /// push the table toward its overflow path for a distinction that
    /// does not exist. `docs/design/per-game-exits.md` §4.2 notes that
    /// key is load-bearing for three separate features already.
    ///
    /// `Origin` is the value rather than the key, and it is built
    /// **after** the decision to carry the packet has been made. That
    /// is the whole safety argument, and §4.1 names this field as the
    /// correct attachment point for exactly that reason: choosing
    /// where to send a packet requires having already decided to carry
    /// it, so an exit that could be attached earlier would be the
    /// fire-and-forget UDP leak rebuilt.
    ///
    /// # Why an index rather than the identifier
    ///
    /// `Origin` is `Copy` and is held per live flow. A `String` here
    /// would make it neither, and would allocate on the packet path.
    /// The index is meaningful because
    /// [`super::proxy::ExitRelays`] is fixed for the life of a
    /// session -- see the note on that type.
    pub exit: Option<u8>,
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
/// Deliberately *not* refreshed by use. Windows reuses ports, and a
/// selected app inheriting one from a browser would otherwise keep going
/// out in the clear for as long as it kept the port busy -- the longer
/// it played, the longer the leak. Five seconds bounds that, and costs
/// no more than a hash lookup per flow per interval, because the
/// connection tables underneath are cached.
///
/// It bounds a narrower window than it used to. A verdict keyed on the
/// source port alone had to survive every destination that port reached;
/// keyed on the flow, an inherited port only carries the stale verdict
/// where the new owner happens to talk to the same peer on the same
/// port as the old one. Five seconds is still the bound, but there is
/// far less inside it.
const DIRECT_VERDICT_TTL: Duration = Duration::from_secs(5);

/// How many leave-alone verdicts are kept at once.
///
/// A port-keyed cache could not grow past the port space. A flow-keyed
/// one can, and one chatty UDP socket -- a torrent client, a peer
/// discovery beacon -- reaches thousands of destinations well inside the
/// five seconds a verdict lives. This is what stops "remember every
/// decision" from meaning "remember every peer in the swarm".
///
/// Overflowing costs a re-decision, never a leak. A forgotten verdict
/// reads as [`Verdict::Unknown`], which sends the caller back to the
/// owner lookup -- where the answer came from in the first place, and
/// which for a socket that is still open is a hash lookup in a snapshot
/// the loop already holds rather than a walk of the connection tables.
const DIRECT_MAX_ENTRIES: usize = 8_192;

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
    /// Flows belonging to applications the customer did not select, and
    /// when that was decided -- so their packets cost one lookup rather
    /// than a walk of the connection tables, without the verdict
    /// outliving the process it was made about.
    ///
    /// Keyed on the whole flow, not on the source port. Keying it on the
    /// port was the same mistake `forward` above exists to avoid, and it
    /// failed the same way: one UDP socket talks to several peers, so
    /// "leave this port alone" answered for destinations nobody had ever
    /// decided about.
    ///
    /// TCP hid it. A SYN is how a TCP port changes destination and a SYN
    /// re-decides from scratch, so a stale verdict never got to answer
    /// for a new peer. UDP has no SYN, so a verdict recorded against one
    /// peer covered every other peer that port reached until the TTL
    /// lapsed -- including a name lookup, which `redirect::decide`
    /// carries through the tunnel whoever makes it, and which this cache
    /// was answering *before* that rule was ever consulted. A datagram
    /// answered from here never reaches the DNS branch at all.
    direct: HashMap<FlowKey, Instant>,
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
    /// Swallow it. Used only where letting the packet through would send
    /// it somewhere the customer asked it not to go -- see the DNS
    /// branch in `redirect::decide`.
    Drop,
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

        let key = FlowKey { transport, client_port, destination, destination_port };
        let tables = self.tables.lock().unwrap();
        match tables.direct.get(&key) {
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

    /// Whether this exact flow is already being carried, without
    /// touching its idle timer.
    ///
    /// Deliberately not [`Nat::lookup_flow`], which refreshes
    /// `last_seen` as a side effect. The escape audit walks every
    /// established connection on the machine every thirty seconds and
    /// asks this about each one; doing that through `lookup_flow` would
    /// renew every entry it read, and `expire_idle` would then never
    /// retire anything for as long as Custom mode was on. An observer
    /// that changes what it observes is worse than no observer, because
    /// the leak it introduces is invisible in the numbers it produces.
    pub fn has_flow(
        &self,
        transport: Transport,
        client_port: u16,
        destination: Ipv4Addr,
        destination_port: u16,
    ) -> bool {
        let key = FlowKey { transport, client_port, destination, destination_port };
        let tables = self.tables.lock().unwrap();
        match tables.forward.get(&key) {
            // The same orphan check `lookup_flow` makes: a forward entry
            // whose reverse half has been retired carries nothing, so
            // the flow it names is not being carried either.
            Some(&nat_port) => tables.reverse.contains_key(&(transport, nat_port)),
            None => false,
        }
    }

    /// Records that a flow belongs to an application that was not
    /// selected -- or could not be carried -- as of now.
    ///
    /// Per flow rather than per port; see `Tables::direct` for what the
    /// port-keyed version answered that nobody had asked. Every caller
    /// already holds the destination, so carrying it costs nothing at
    /// the call site.
    pub fn record_direct(
        &self,
        transport: Transport,
        client_port: u16,
        destination: Ipv4Addr,
        destination_port: u16,
    ) {
        let key = FlowKey { transport, client_port, destination, destination_port };
        let mut tables = self.tables.lock().unwrap();
        if tables.direct.len() >= DIRECT_MAX_ENTRIES {
            let now = Instant::now();
            tables.direct.retain(|_, decided| now.duration_since(*decided) < DIRECT_VERDICT_TTL);
            // If the sweep barely freed anything, the table is full of
            // live verdicts and the next datagram would sweep it again
            // -- a walk of the whole table on the packet path, which is
            // the cost this cache exists to avoid. Drop the lot instead,
            // so every walk is paid off by at least a quarter of the
            // cap's worth of plain inserts before another can happen.
            //
            // Throwing away verdicts is safe in a way that keeping stale
            // ones is not: what is lost is the shortcut, not the answer.
            if tables.direct.len() > DIRECT_MAX_ENTRIES * 3 / 4 {
                tables.direct.clear();
            }
        }
        tables.direct.insert(key, Instant::now());
    }

    /// Throws away every leave-alone verdict, so the next packet of
    /// each flow is decided again from scratch.
    ///
    /// # Why a selection change needs this
    ///
    /// A verdict in here says "this flow belongs to an application we
    /// are not carrying". That is a statement about the customer's
    /// choice, and the moment they change their choice it may simply be
    /// false -- but nothing expires it early, by design: see
    /// [`DIRECT_VERDICT_TTL`], which is deliberately not refreshed by
    /// use precisely so a stale verdict cannot be kept alive forever.
    ///
    /// For TCP that costs nothing, because a connection opens with a
    /// SYN and `decide` makes a SYN skip this cache outright. UDP has no
    /// SYN. A game already talking to its server on one 4-tuple keeps
    /// hitting the same key, so the verdict recorded while it was
    /// unselected answered for every datagram until the TTL lapsed --
    /// the customer clicked, and for the next five seconds nothing
    /// happened. Five seconds of a match is not nothing.
    ///
    /// # Why clearing everything is the right shape
    ///
    /// The alternative is to forget only the flows belonging to the
    /// application that changed, and that cannot be done from here: the
    /// cache does not record who owns a flow, and teaching it would mean
    /// adding a component to [`FlowKey`] -- which is load-bearing for
    /// three separate features and must not grow one.
    ///
    /// Clearing the lot instead is cheap in the only way that matters.
    /// It costs a re-decision per live flow, and a re-decision is a hash
    /// lookup in a snapshot the loop already holds. It happens when a
    /// customer clicks something, not on the packet path.
    ///
    /// # What it cannot do
    ///
    /// It cannot cause a leak, and the reason is structural rather than
    /// careful. `decide` only calls [`Nat::record_direct`] when the
    /// owning image is known, so this table never holds a verdict about
    /// an unattributed flow. There is nothing in here for a selection
    /// change to release, and a datagram nobody can attribute goes back
    /// to `Selection::verdict_for_unattributed` and is refused exactly
    /// as it was before. A test asserts that rather than trusting it.
    ///
    /// It also does not move an established connection. Nothing here
    /// does -- see `SplitTunnel::set_selection` for what the customer is
    /// told about the half that cannot be moved.
    pub fn forget_direct(&self) {
        let mut tables = self.tables.lock().unwrap();
        tables.direct.clear();
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
        // A flow cannot be both left alone and redirected. A TCP SYN
        // re-decides from scratch, so this is how a stale verdict from
        // the port's previous owner is cleared. With the verdict keyed
        // on the flow there is usually nothing here to clear -- a
        // previous owner talking to somewhere else left no entry that
        // could have answered for this one.
        tables.direct.remove(&key);
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
            upstream: None,
            exit: None,
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
        nat.record_direct(Transport::Tcp, 5200, Ipv4Addr::new(1, 1, 1, 1), 443);
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
        nat.record_direct(Transport::Tcp, 5300, Ipv4Addr::new(1, 1, 1, 1), 443);
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
        nat.record_direct(Transport::Udp, 5350, Ipv4Addr::new(1, 1, 1, 1), 53);
        assert_eq!(
            nat.lookup(Transport::Udp, 5350, Ipv4Addr::new(1, 1, 1, 1), 53),
            Verdict::Direct
        );

        {
            let mut tables = nat.tables.lock().unwrap();
            let key = FlowKey {
                transport: Transport::Udp,
                client_port: 5350,
                destination: Ipv4Addr::new(1, 1, 1, 1),
                destination_port: 53,
            };
            let decided = tables.direct.get_mut(&key).unwrap();
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
    fn asking_whether_a_flow_is_carried_does_not_keep_it_alive() {
        // The escape audit asks this about every established connection
        // on the machine, every thirty seconds. If the question renewed
        // the entry, an idle flow would never be retired for as long as
        // Custom mode stayed on -- and the audit would have created a
        // leak of sockets while looking for a leak of traffic.
        let nat = Nat::new();
        let origin = origin_to(Ipv4Addr::new(1, 1, 1, 1), 53, 5600);
        let nat_port = nat.redirect(Transport::Udp, origin).unwrap();

        {
            let mut tables = nat.tables.lock().unwrap();
            tables.reverse.get_mut(&(Transport::Udp, nat_port)).unwrap().last_seen =
                Instant::now() - UDP_IDLE * 2;
        }

        assert!(nat.has_flow(Transport::Udp, 5600, Ipv4Addr::new(1, 1, 1, 1), 53));
        assert_eq!(nat.expire_idle(), vec![nat_port], "the question must not have renewed it");
        assert!(!nat.has_flow(Transport::Udp, 5600, Ipv4Addr::new(1, 1, 1, 1), 53));
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

    #[test]
    fn a_leave_alone_verdict_does_not_answer_for_another_peer() {
        // The leak this key change exists for. One UDP socket routinely
        // talks to several peers -- which is why `forward` is keyed on
        // the whole flow -- and a verdict recorded about one of them
        // used to answer for all of them. There is no SYN in UDP to
        // re-decide, so a selected app that inherited a port, or one
        // whose flow was left alone once because the table was full,
        // kept egressing in the clear to peers nobody had ever looked
        // at.
        let nat = Nat::new();
        nat.record_direct(Transport::Udp, 5700, Ipv4Addr::new(203, 0, 113, 9), 443);

        assert_eq!(
            nat.lookup(Transport::Udp, 5700, Ipv4Addr::new(203, 0, 113, 9), 443),
            Verdict::Direct,
            "the flow that was decided about must still be remembered"
        );
        assert_eq!(
            nat.lookup(Transport::Udp, 5700, Ipv4Addr::new(198, 51, 100, 4), 443),
            Verdict::Unknown,
            "a peer nobody decided about must be decided about, not assumed"
        );
    }

    #[test]
    fn a_leave_alone_verdict_does_not_answer_for_a_name_lookup() {
        // The same bug where it costs the most. `redirect::decide`
        // carries a DNS query through the tunnel whoever makes it, and
        // it drops one it cannot carry rather than handing it to the
        // resolver the network supplied -- for somebody in Iran, their
        // ISP. None of that ran if this cache answered first, and keyed
        // on the port it did: any port left alone in the previous five
        // seconds short-circuited the whole rule.
        let nat = Nat::new();
        nat.record_direct(Transport::Udp, 5750, Ipv4Addr::new(203, 0, 113, 9), 443);

        assert_eq!(
            nat.lookup(Transport::Udp, 5750, Ipv4Addr::new(8, 8, 8, 8), 53),
            Verdict::Unknown,
            "a lookup must reach the branch that decides about lookups"
        );
    }

    #[test]
    fn a_tcp_verdict_still_covers_the_connection_it_was_made_about() {
        // The narrower key must not cost the thing the cache is for. A
        // mid-connection TCP packet is decided once and then answered
        // from here for every packet after it, which is the difference
        // between one hash lookup and a walk of the connection tables
        // per packet.
        let nat = Nat::new();
        nat.record_direct(Transport::Tcp, 5800, Ipv4Addr::new(203, 0, 113, 9), 443);

        for _ in 0..3 {
            assert_eq!(
                nat.lookup(Transport::Tcp, 5800, Ipv4Addr::new(203, 0, 113, 9), 443),
                Verdict::Direct
            );
        }
    }

    #[test]
    fn the_leave_alone_cache_cannot_grow_without_bound() {
        // A port-keyed table could not outgrow the port space; a
        // flow-keyed one can. A peer-to-peer client reaches thousands of
        // destinations from one socket well inside the five seconds a
        // verdict lives, and this table is walked under a lock on the
        // packet path.
        let nat = Nat::new();
        for i in 0..(DIRECT_MAX_ENTRIES * 2) {
            let octets = (i as u32).to_be_bytes();
            nat.record_direct(
                Transport::Udp,
                5900,
                Ipv4Addr::new(203, octets[1], octets[2], octets[3]),
                443,
            );
        }

        let held = nat.tables.lock().unwrap().direct.len();
        assert!(
            held <= DIRECT_MAX_ENTRIES,
            "the leave-alone cache grew to {held}, past its cap of {DIRECT_MAX_ENTRIES}"
        );
    }

    #[test]
    fn expiry_still_reclaims_leave_alone_verdicts() {
        // `expire_idle` is the only thing that retires these on a quiet
        // machine -- the cap above only ever fires on a busy one. If it
        // stopped reclaiming them, a session that saw one burst would
        // carry the table for as long as Custom mode stayed on.
        let nat = Nat::new();
        nat.record_direct(Transport::Udp, 5950, Ipv4Addr::new(203, 0, 113, 9), 443);

        {
            let mut tables = nat.tables.lock().unwrap();
            for decided in tables.direct.values_mut() {
                *decided = Instant::now() - DIRECT_VERDICT_TTL * 2;
            }
        }

        nat.expire_idle();
        assert!(
            nat.tables.lock().unwrap().direct.is_empty(),
            "an expired verdict must be reclaimed, not merely ignored"
        );
    }

    /// `FlowKey` has exactly four components, and adding a fifth must
    /// be a deliberate act rather than a passing thought.
    ///
    /// # Why this is a destructuring and not an assertion about a size
    ///
    /// The pattern below has no `..`, so a new field is a **compile
    /// error** on this line rather than a test that happens to fail.
    /// That is the only instrument that catches the mistake in the form
    /// it would actually arrive in: somebody adds `exit: Option<u8>`
    /// here because a flow's exit feels like part of its identity, every
    /// existing test still passes because every existing flow has
    /// `None`, and nothing says otherwise until a customer's table
    /// overflows.
    ///
    /// # What it is protecting
    ///
    /// This key is the key of `Tables::direct`, the leave-alone cache,
    /// and it is load-bearing for three separate features -- the
    /// fire-and-forget leak fix, destination scoping, and now exits.
    /// `docs/design/per-game-exits.md` section 4.2 states the rule:
    /// the cache records *"this flow is not carried"*, which is a fact
    /// about an application and a peer and is true whichever exit the
    /// session happens to be on. An exit component would multiply the
    /// entries one chatty UDP socket produces -- a torrent client
    /// reaches thousands of peers well inside the five seconds a
    /// verdict lives -- and push the table toward `DIRECT_MAX_ENTRIES`
    /// for a distinction that does not exist.
    ///
    /// The exit lives on [`Origin`] instead, which is the *value* and
    /// is built only after the decision to carry has been made. See the
    /// note on `Origin::exit`.
    #[test]
    fn the_flow_key_has_exactly_four_components_and_none_of_them_is_an_exit() {
        let key = FlowKey {
            transport: Transport::Udp,
            client_port: 40_000,
            destination: Ipv4Addr::new(203, 0, 113, 9),
            destination_port: 27_015,
        };
        // No `..`: a fifth field stops this compiling.
        let FlowKey { transport, client_port, destination, destination_port } = key;
        assert_eq!(transport, Transport::Udp);
        assert_eq!(client_port, 40_000);
        assert_eq!(destination, Ipv4Addr::new(203, 0, 113, 9));
        assert_eq!(destination_port, 27_015);
    }

    /// Two flows that differ *only* by the exit their applications
    /// prefer are one entry in the leave-alone cache, not two.
    ///
    /// The behavioural half of the rule above: even if somebody found
    /// another way to make the exit part of the key, this is the
    /// consequence that would change.
    #[test]
    fn the_leave_alone_cache_does_not_distinguish_flows_by_exit() {
        let nat = Nat::new();
        let peer = Ipv4Addr::new(203, 0, 113, 9);
        nat.record_direct(Transport::Udp, 40_000, peer, 27_015);
        // The same flow, whatever exit anything prefers -- the cache
        // has no vocabulary for one, which is the point.
        assert_eq!(
            nat.lookup(Transport::Udp, 40_000, peer, 27_015),
            Verdict::Direct,
            "one flow, one verdict, one entry"
        );
    }
}
