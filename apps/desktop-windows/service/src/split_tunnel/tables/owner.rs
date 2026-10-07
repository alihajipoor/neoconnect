//! Which application owns a local port.
//!
//! This is the question Custom mode exists to answer: a packet on the
//! wire carries no hint of the program that produced it, so redirecting
//! "only this game" means mapping the packet's source port back to a
//! process and then to an executable on disk.
//!
//! # Why the connection tables and not WinDivert's FLOW layer
//!
//! The spike proved the FLOW layer attributes reliably -- 224 flows, not
//! one unattributable, TCP and UDP alike. It was still the wrong choice
//! here, for a reason the spike could not show: FLOW events are
//! delivered on their own schedule relative to the NETWORK layer, so a
//! TCP SYN can reach the redirect loop before the event announcing the
//! flow it belongs to. The consequence is not a dropped packet, it is a
//! selected app's connection quietly going out unprotected while the UI
//! says Custom mode is on -- the same class of dishonesty as a false
//! "Connected".
//!
//! `GetExtendedTcpTable`/`GetExtendedUdpTable` have no such race. The
//! socket appears in the table when it is created, before anything is
//! sent, so a lookup at the moment the first packet arrives is
//! answerable -- *provided the socket is still open when it is made*.
//! The cost is a table walk, which is why the result is cached and the
//! refresh rate-limited below.
//!
//! That proviso used to read "always answerable", and it was measured
//! wrong. A socket closed immediately after its send is out of the
//! table before the redirect loop is handed the datagram, and no
//! rebuild can recover a row that no longer exists. That is not a race
//! this file can win by asking harder, and it is why
//! `policy::Selection::verdict_for_unattributed` exists: the question moves
//! from "who owns this port" -- unanswerable -- to "what is the safe
//! thing to do when nobody does".


use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::split_tunnel::policy::{Family, Transport};

use super::process::image_path;
use super::{tcp6_table, tcp_table, udp6_table, udp_table};

/// How long a table snapshot is trusted before being rebuilt.
///
/// Short enough that a port belonging to a process started moments ago
/// is found on the next attempt, long enough that a burst of new
/// connections does not turn into a burst of table walks.
const SNAPSHOT_TTL: Duration = Duration::from_millis(200);

/// The floor on how often a miss may force an early rebuild.
///
/// Without it, traffic to ports that genuinely have no owner -- and
/// there is always some -- would rebuild the table on every packet.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_millis(20);

/// Caches the two connection tables and the image path of each process
/// seen in them.
pub struct OwnerLookup {
    tcp: HashMap<u16, u32>,
    udp: HashMap<u16, u32>,
    /// The same two tables for IPv6. Queried on every rebuild rather
    /// than only when an IPv6 packet turns up: the rebuild is what the
    /// 200ms snapshot budget is spent on, and a second pair of table
    /// walks there is far cheaper than discovering mid-packet that the
    /// snapshot cannot answer and having to walk again.
    tcp6: HashMap<u16, u32>,
    udp6: HashMap<u16, u32>,
    built_at: Instant,
    last_refresh: Instant,
    /// Only successful resolutions live here -- see image_for_port.
    images: HashMap<u32, String>,
}

impl OwnerLookup {
    pub fn new() -> Self {
        // Far enough in the past that the first lookup builds rather
        // than trusting an empty snapshot.
        let stale = Instant::now() - SNAPSHOT_TTL * 2;
        Self {
            tcp: HashMap::new(),
            udp: HashMap::new(),
            tcp6: HashMap::new(),
            udp6: HashMap::new(),
            built_at: stale,
            last_refresh: stale,
            images: HashMap::new(),
        }
    }

    /// The executable behind a local port, or `None` if the port has no
    /// owner this can see.
    ///
    /// A miss triggers at most one rebuild, then answers from the fresh
    /// snapshot -- so a socket created microseconds ago is still found,
    /// without a hot loop for ports that will never be found.
    pub fn image_for_port(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.built_at.elapsed() > SNAPSHOT_TTL {
            self.rebuild();
        }
        let mut pid = self.pid_for(family, transport, port);
        if pid.is_none() && self.last_refresh.elapsed() > MIN_REFRESH_INTERVAL {
            self.rebuild();
            pid = self.pid_for(family, transport, port);
        }
        let pid = pid?;

        // Resolved once per process rather than per connection: an
        // image path cannot change while a process lives, and a busy
        // browser opens far more connections than processes.
        //
        // Only *successful* lookups are cached, and that is the whole
        // point. Caching a failure was a real bug: `OpenProcess` can
        // fail transiently, the entry then survives for as long as the
        // process is in the connection table, and every later
        // connection from it resolves to "unknown" and is left
        // untunnelled. Reported exactly that way -- Chrome quietly
        // stopped using the VPN and only came back after restarting
        // it, because restarting is what finally retired the poisoned
        // process id.
        if !self.images.contains_key(&pid) {
            if let Some(path) = image_path(pid) {
                self.images.insert(pid, path);
            }
        }
        self.images.get(&pid).map(String::as_str)
    }

    /// The same answer as [`Self::image_for_port`], for a port that is
    /// opening a connection right now, where a miss is not allowed to
    /// stand on a snapshot taken moments ago.
    ///
    /// The rate limit above exists so that ports which genuinely have no
    /// owner cannot turn every packet into a table walk. That is right
    /// for the general case and wrong for a TCP SYN, because of what a
    /// miss costs: with `OnlySelected` an unknown owner means "leave it
    /// alone", the SYN goes out unredirected, **and the far end answers
    /// it**. The connection is then established outside the tunnel for
    /// good -- there is no retransmit to have a second go at, and a
    /// browser keeps that socket alive and reuses it for minutes.
    ///
    /// Measured on this machine with Custom mode on and Edge selected: a
    /// page opened six seconds after the redirect started reported the
    /// customer's own address, over a socket created after the switch,
    /// while sibling connections made in the same second went through
    /// the tunnel. That is what the rate limit buys, and it is not worth
    /// it: a SYN is a small share of packets and each one costs at most
    /// one extra walk.
    pub fn image_for_new_connection(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.pid_for(family, transport, port).is_none() {
            self.rebuild();
        }
        self.image_for_port(family, transport, port)
    }

    fn pid_for(&self, family: Family, transport: Transport, port: u16) -> Option<u32> {
        match (family, transport) {
            (Family::V4, Transport::Tcp) => self.tcp.get(&port).copied(),
            (Family::V4, Transport::Udp) => self.udp.get(&port).copied(),
            (Family::V6, Transport::Tcp) => self.tcp6.get(&port).copied(),
            (Family::V6, Transport::Udp) => self.udp6.get(&port).copied(),
        }
    }

    fn rebuild(&mut self) {
        if let Some(table) = tcp_table() {
            self.tcp = table;
        }
        if let Some(table) = udp_table() {
            self.udp = table;
        }
        if let Some(table) = tcp6_table() {
            self.tcp6 = table;
        }
        if let Some(table) = udp6_table() {
            self.udp6 = table;
        }
        // Marked fresh even if every walk above failed, and that is a
        // decision rather than an oversight. A failed walk keeps the
        // previous table, which is the best answer there is; the other
        // choice -- leaving the snapshot stale so the next lookup walks
        // again -- turns a failing API into a table walk per packet on
        // the redirect loop. The cost is that a stale table answers for
        // one more `SNAPSHOT_TTL`. A SYN does not pay it:
        // `image_for_new_connection` walks again on any miss, whatever
        // this says.
        let now = Instant::now();
        self.built_at = now;
        self.last_refresh = now;

        // Processes that have gone are dropped rather than accumulating
        // for the life of the connection. Windows reuses process ids, so
        // a stale entry is not merely wasted memory -- it would answer
        // for whatever took the id next.
        let live: std::collections::HashSet<u32> = self
            .tcp
            .values()
            .chain(self.udp.values())
            .chain(self.tcp6.values())
            .chain(self.udp6.values())
            .copied()
            .collect();
        self.images.retain(|pid, _| live.contains(pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against this machine's real connection tables. The point is
    /// not a fixed expectation but that the walk returns real data and
    /// resolves to real executables -- the part every redirect decision
    /// depends on being correct.
    #[test]
    fn resolves_a_real_listening_port_to_a_real_executable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let mut lookup = OwnerLookup::new();
        let image = lookup.image_for_port(Family::V4, Transport::Tcp, port);

        let image = image.expect("the test's own listening port must have an owner");
        assert!(
            image.to_lowercase().contains(".exe"),
            "expected an executable path, got {image}"
        );
        println!("port {port} -> {image}");
    }

    /// The socket that opens inside the rate limiter's window, which is
    /// the one a browser opens and the one that used to escape.
    ///
    /// Measured on this machine, three consecutive Custom-mode starts
    /// with a browser selected: 4 of 47, 9 of 60 and 8 of 55 new TCP
    /// connections were not in the snapshot the loop already held. Every
    /// one of them was found by rebuilding, and under the old lookup
    /// every one of them would have gone out untunnelled for good.
    ///
    /// The two lookups here run microseconds apart, which is what puts
    /// the second one inside `MIN_REFRESH_INTERVAL` and makes this the
    /// case being tested rather than an ordinary hit.
    #[test]
    fn a_socket_created_after_the_snapshot_is_still_attributed() {
        let mut lookup = OwnerLookup::new();

        // Builds the snapshot and marks it freshly refreshed.
        let warm = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let _ = lookup.image_for_port(Family::V4, Transport::Tcp, warm.local_addr().unwrap().port());

        // Opened after that snapshot was taken, so it cannot be in it.
        let fresh = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = fresh.local_addr().unwrap().port();

        assert!(
            lookup.image_for_new_connection(Family::V4, Transport::Tcp, port).is_some(),
            "a new connection's owner must be resolved even when the snapshot was just rebuilt"
        );
    }
}
