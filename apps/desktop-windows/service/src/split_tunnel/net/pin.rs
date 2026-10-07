//! Placing a socket on the tunnel: `IP_UNICAST_IF` and the bind beside
//! it, and the live record of which interface that currently means.
//!
//! The relay dials through this and so does the health check, so both
//! attach a socket in exactly the same way -- a readiness check that
//! tests something *similar* to the real attach is worse than none, see
//! [`can_attach`].

use std::io;
use std::mem::size_of;
use std::net::{Ipv4Addr, SocketAddr};
use std::os::windows::io::AsRawSocket;
use std::sync::atomic::{AtomicU32, Ordering};

use socket2::{Domain, Protocol, Socket, Type};
use windows_sys::Win32::Networking::WinSock::setsockopt;

/// `IPPROTO_IP`, the option level `IP_UNICAST_IF` lives at.
const IPPROTO_IP: i32 = 0;
/// `IP_UNICAST_IF`. Not exposed by socket2, so it is set by hand.
const IP_UNICAST_IF: i32 = 31;

/// The interface redirected traffic should leave by, as a live value
/// rather than a snapshot.
///
/// Zero means no tunnel, which is the fail-open case: sockets are left
/// unpinned and take the ordinary route.
pub struct TunnelInterface {
    index: AtomicU32,
    /// The tunnel's own address, held as bits so it can live beside the
    /// index without a lock.
    ///
    /// Sockets are bound to it as well as pinned to the interface.
    /// `IP_UNICAST_IF` alone was enough for WireGuard and not for Xray
    /// or OpenVPN, whose TUN adapters answered every pinned connect with
    /// WSAEHOSTUNREACH -- so Custom mode worked on exactly the one
    /// protocol the spike happened to test it against. Binding the
    /// source address states which interface the packet belongs to in
    /// the way the stack cannot decline to honour.
    address: AtomicU32,
}

impl TunnelInterface {
    pub fn new(index: u32, address: Ipv4Addr) -> Self {
        Self {
            index: AtomicU32::new(index),
            address: AtomicU32::new(u32::from(address)),
        }
    }

    pub fn set(&self, index: u32, address: Ipv4Addr) {
        self.index.store(index, Ordering::Relaxed);
        self.address.store(u32::from(address), Ordering::Relaxed);
    }

    /// Marks that no tunnel is available. Zero is not a valid interface
    /// index, so it doubles as the fail-open signal.
    pub fn clear(&self) {
        self.index.store(0, Ordering::Relaxed);
        self.address.store(0, Ordering::Relaxed);
    }

    pub fn get(&self) -> Option<(u32, Ipv4Addr)> {
        match self.index.load(Ordering::Relaxed) {
            0 => None,
            index => Some((index, Ipv4Addr::from(self.address.load(Ordering::Relaxed)))),
        }
    }
}

impl Default for TunnelInterface {
    fn default() -> Self {
        Self { index: AtomicU32::new(0), address: AtomicU32::new(0) }
    }
}

/// Ties a socket to the tunnel: pinned to the interface, and bound to
/// the address that interface owns.
///
/// Both, not either. The pin constrains which routes may be chosen; the
/// bind states where the packet comes from. WireGuard's adapter was
/// happy with the pin alone, which is why this looked finished, but
/// Xray's and OpenVPN's TUNs refused to route for it -- every pinned
/// connect came back WSAEHOSTUNREACH and every Xray protocol failed its
/// probe, so the ladder fell through to WireGuard every single time.
pub fn attach_to_tunnel(socket: &Socket, index: u32, address: Ipv4Addr) -> io::Result<()> {
    pin_to_interface(socket, index)?;
    // Port 0: the source address is what matters, the port is not.
    socket.bind(&SocketAddr::from((address, 0)).into())
}

/// Whether a socket can actually be attached to this tunnel yet.
///
/// Calls `attach_to_tunnel` rather than reimplementing a lighter
/// version of it, because a readiness check that tests something
/// *similar* to the real operation is worse than none: 0.8.4 checked a
/// plain `bind` while production pins the interface first and then
/// binds, so the check passed on adapters where the real attach still
/// failed with WSAEADDRNOTAVAIL, and the wait it was supposed to
/// provide never happened.
pub fn can_attach(index: u32, address: Ipv4Addr) -> bool {
    let Ok(socket) = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) else {
        return false;
    };
    attach_to_tunnel(&socket, index, address).is_ok()
}

/// Restricts a socket to one interface's routes.
///
/// The index goes in network byte order for IPv4 -- and host order for
/// IPv6, an asymmetry that produces a socket pinned to an interface
/// which does not exist rather than an error.
fn pin_to_interface(socket: &Socket, index: u32) -> io::Result<()> {
    let value = index.to_be();
    // SAFETY: the socket is live for the call, and `value` is a u32
    // whose address and length are passed consistently.
    let rc = unsafe {
        setsockopt(
            socket.as_raw_socket() as usize,
            IPPROTO_IP,
            IP_UNICAST_IF,
            &value as *const u32 as *const u8,
            size_of::<u32>() as i32,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_zero_interface_means_no_tunnel() {
        // Zero is not a valid interface index, and it is what the
        // controller stores between engines. Pinning to it would fail
        // every connection during a failover, which is precisely the
        // moment the decided behaviour is to let traffic through.
        let tunnel = TunnelInterface::default();
        assert_eq!(tunnel.get(), None);
        tunnel.set(14, Ipv4Addr::new(10, 66, 0, 3));
        assert_eq!(tunnel.get(), Some((14, Ipv4Addr::new(10, 66, 0, 3))));
        tunnel.clear();
        assert_eq!(tunnel.get(), None);
    }

    #[test]
    #[ignore = "same unguaranteed premise as the probe test above"]
    fn a_socket_pinned_to_a_nonexistent_interface_cannot_connect() {
        // The property Custom mode's honesty rests on. `setsockopt`
        // itself accepts any index -- checked here, and it does -- so
        // the guarantee cannot come from the call succeeding. It comes
        // from the connect afterwards: a pinned socket is restricted to
        // that interface's routes, an interface that does not exist has
        // none, and the connection fails rather than quietly taking the
        // ordinary route. If that ever changed, a broken tunnel would
        // present as a working one.
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        pin_to_interface(&socket, u32::MAX).expect("the option itself is accepted");

        let target = SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443));
        let result = socket.connect_timeout(&target.into(), Duration::from_secs(5));
        assert!(result.is_err(), "a pinned socket must not fall back to the normal route");
    }

    /// The property Custom mode's honesty rests on, with a running test
    /// at last: a socket pinned to a real interface that has no route to
    /// a destination fails, rather than quietly leaving by the ordinary
    /// route. If it fell back, a selected app's traffic would go out in
    /// the clear the moment the tunnel stopped carrying it, while every
    /// check said it was pinned.
    ///
    /// The two earlier attempts pinned to an index that names nothing,
    /// and Windows treated that as no pin at all -- see the ignored test
    /// in `health.rs`. Loopback is a real adapter on every Windows
    /// machine and carries no route to the internet, so it is the
    /// stand-in for a tunnel adapter with nowhere to send.
    ///
    /// Measured first on 2026-10-04: unpinned, the connect to a public
    /// resolver succeeded; pinned to loopback, it failed in 59µs with
    /// WSAENETUNREACH. The unpinned control is what makes the pinned
    /// failure mean something -- on a machine with no network at all
    /// both fail, and the assertion that matters still holds.
    #[test]
    fn a_socket_pinned_to_an_interface_with_no_route_fails_instead_of_falling_back() {
        const LOOPBACK_INTERFACE: u32 = 1;
        let target: SocketAddr = "1.1.1.1:443".parse().unwrap();

        let pinned = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        pin_to_interface(&pinned, LOOPBACK_INTERFACE).expect("loopback is a real interface to pin to");
        let error = pinned
            .connect_timeout(&target.into(), Duration::from_secs(4))
            .expect_err("a pinned socket must not reach a destination its interface has no route to");
        assert!(
            matches!(error.kind(), io::ErrorKind::NetworkUnreachable | io::ErrorKind::HostUnreachable),
            "it must fail as unreachable, not by timing out on some other path: {error:?}"
        );

        let plain = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        if plain.connect_timeout(&target.into(), Duration::from_secs(4)).is_err() {
            eprintln!("no ordinary route to {target} here, so the pinned failure proves less than it could");
        }
    }

}
