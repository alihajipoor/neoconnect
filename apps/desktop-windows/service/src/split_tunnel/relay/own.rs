//! The relay's own onward sockets, recorded by the side that creates them.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::{Arc, Mutex};

use socket2::Socket;

use crate::split_tunnel::policy::Transport;

/// The local addresses of the relay's own onward sockets.
///
/// The redirect loop has to recognise the relay's own traffic, or it
/// sends the relay's onward packets back into the relay. It used to
/// answer that question from the connection tables, via
/// `OwnerLookup::image_for_port`, and that is a race it loses: the
/// lookup will not rebuild its snapshot more than once every
/// `MIN_REFRESH_INTERVAL`, so a socket created microseconds ago is
/// invisible for up to that long. The onward socket for a redirected
/// flow is *always* microseconds old when it sends its first packet.
///
/// Measured on this machine, two DNS lookups fired with a gap between
/// them, Custom mode on a WireGuard tunnel:
///
/// ```text
///   gap=  0ms  answered=0/2      gap= 25ms  answered=2/2
///   gap=  5ms  answered=1/2      gap= 50ms  answered=2/2
///   gap= 10ms  answered=0/2      gap=250ms  answered=2/2
/// ```
///
/// The cliff sits exactly on the 20ms refresh interval. Any two lookups
/// closer together than that lost *both* answers -- which is a page
/// whose text arrives and whose images and stylesheets do not, because
/// the browser resolves those hosts in one burst. NTP through the same
/// relay, eight flows at once, lost nothing: it never enters the DNS
/// branch, so it never needed the guard that was failing.
///
/// So ownership is recorded by the side that creates the socket, before
/// it can send anything, rather than inferred afterwards from a table
/// that has not caught up.
#[derive(Default)]
pub struct OwnSockets {
    tcp: Mutex<HashSet<SocketAddrV4>>,
    udp: Mutex<HashSet<SocketAddrV4>>,
}

impl OwnSockets {
    fn set(&self, transport: Transport) -> &Mutex<HashSet<SocketAddrV4>> {
        match transport {
            Transport::Tcp => &self.tcp,
            Transport::Udp => &self.udp,
        }
    }

    /// Whether this source is one of the relay's own onward sockets.
    ///
    /// Keyed on the address as well as the port, and that is not
    /// belt-and-braces. The onward sockets are bound to the tunnel's
    /// address while applications are bound to the machine's LAN
    /// address, so the same port number is legitimately in use by both
    /// at the same time. Matching on the port alone would hand an
    /// application's packet the "this is ours, leave it alone" verdict
    /// and quietly drop it out of the tunnel.
    pub fn contains(&self, transport: Transport, source: Ipv4Addr, port: u16) -> bool {
        self.set(transport).lock().unwrap_or_else(|e| e.into_inner()).contains(&SocketAddrV4::new(source, port))
    }

    fn insert(&self, transport: Transport, addr: SocketAddrV4) {
        self.set(transport).lock().unwrap_or_else(|e| e.into_inner()).insert(addr);
    }

    fn remove(&self, transport: Transport, addr: &SocketAddrV4) {
        self.set(transport).lock().unwrap_or_else(|e| e.into_inner()).remove(addr);
    }
}

/// Keeps one onward socket registered for exactly as long as it exists.
///
/// A guard rather than paired calls because the ways a relayed flow ends
/// are many -- the app closes it, the far end closes it, the flow is
/// expired, the relay is torn down -- and a registration left behind
/// would claim a port number that Windows is free to hand to an
/// application next, which is the leak `contains` guards against.
pub(super) struct Registration {
    own: Arc<OwnSockets>,
    transport: Transport,
    addr: SocketAddrV4,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.own.remove(self.transport, &self.addr);
    }
}

/// Registers a socket that has already been bound, if it was bound to a
/// real address.
///
/// Returns `None` in the fail-open case, where the socket is left
/// unpinned and unbound and so has no address to be known by until it
/// connects. That case is unchanged: no tunnel is up, and the image
/// check in `intercept::decide` is what covers it -- as it always did.
pub(super) fn register(own: &Arc<OwnSockets>, socket: &Socket, transport: Transport) -> Option<Registration> {
    let addr = socket.local_addr().ok()?.as_socket_ipv4()?;
    if addr.ip().is_unspecified() {
        return None;
    }
    own.insert(transport, addr);
    Some(Registration { own: own.clone(), transport, addr })
}

#[cfg(test)]
mod tests {
    use super::*;
    use socket2::{Domain, Protocol, Type};
    use std::net::SocketAddr;

    #[test]
    fn an_onward_socket_is_known_by_its_address_and_not_by_its_port_alone() {
        // The onward sockets are bound to the tunnel's address and
        // applications to the machine's LAN address, so the same port
        // number is legitimately in use by both at once. Keyed on the
        // port alone, an application's packet would be answered "this is
        // ours" and left out of the tunnel -- a leak, and a silent one.
        let own = Arc::new(OwnSockets::default());
        let tunnel = Ipv4Addr::new(10, 66, 0, 2);
        let lan = Ipv4Addr::new(192, 168, 1, 20);
        own.insert(Transport::Udp, SocketAddrV4::new(tunnel, 51000));

        assert!(own.contains(Transport::Udp, tunnel, 51000));
        assert!(!own.contains(Transport::Udp, lan, 51000), "an app on the same port is not ours");
        // Transports are separate namespaces for the same reason.
        assert!(!own.contains(Transport::Tcp, tunnel, 51000));
    }

    #[test]
    fn a_registration_lasts_exactly_as_long_as_its_socket() {
        // A registration left behind claims a port number that Windows
        // is then free to hand to an application, which is the leak the
        // test above describes -- arriving later instead of at once.
        let own = Arc::new(OwnSockets::default());
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into()).unwrap();
        let bound = socket.local_addr().unwrap().as_socket_ipv4().unwrap();

        let registration = register(&own, &socket, Transport::Udp).expect("a bound socket registers");
        assert!(own.contains(Transport::Udp, *bound.ip(), bound.port()));

        drop(registration);
        assert!(!own.contains(Transport::Udp, *bound.ip(), bound.port()));
    }

    #[test]
    fn an_unbound_socket_is_not_registered_under_a_wildcard_address() {
        // The fail-open case: no tunnel, so the socket is left unpinned
        // and has no address until it connects. Registering 0.0.0.0 here
        // would match every application on that port number. That case is
        // covered by the image check in `intercept::decide`, as it always
        // was, and this returns nothing rather than something wrong.
        let own = Arc::new(OwnSockets::default());
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into()).unwrap();

        assert!(register(&own, &socket, Transport::Udp).is_none());
    }

}
