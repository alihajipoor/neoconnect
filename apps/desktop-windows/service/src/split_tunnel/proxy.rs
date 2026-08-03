//! The local relay that puts a selected app's traffic into the tunnel.
//!
//! The redirect loop (see `nat.rs`) hands connections here; this half
//! carries them the rest of the way. Its one real trick is how the
//! onward socket is placed on the tunnel:
//!
//! `IP_UNICAST_IF` -- Windows' answer to `SO_BINDTODEVICE` -- restricts
//! a socket to the routes belonging to one interface. It **constrains**
//! route selection; it does not create a route. A tunnel brought up
//! passively owns no routes at all, so a socket pinned to it fails with
//! ENETUNREACH until the controller adds a default route through it at a
//! metric nothing else would ever prefer (see `mod.rs`).
//!
//! Everything else follows from that. The interface index is read at the
//! moment each socket is created rather than captured once, which is
//! what makes Custom mode follow the active protocol across a failover
//! without being told: the next connection simply lands on whatever
//! tunnel is up by then.
//!
//! When no tunnel is up, sockets are left unpinned and the traffic goes
//! out normally. That is the fail-open behaviour decided for this
//! feature -- a game must not stall for the seconds a protocol switch
//! takes -- and the UI is responsible for saying so plainly.
//!
//! Everything here is keyed on the synthetic port `flows.rs` assigns
//! each flow, never on the app's own source port. That is what lets one
//! UDP socket hold several peers at once without their replies being
//! delivered to each other.

use std::collections::HashMap;
use std::io;
use std::mem::size_of;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::windows::io::AsRawSocket;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};
use windows_sys::Win32::Networking::WinSock::setsockopt;

use super::flows::Nat;
use super::owner::Transport;

/// `IPPROTO_IP`, the option level `IP_UNICAST_IF` lives at.
const IPPROTO_IP: i32 = 0;
/// `IP_UNICAST_IF`. Not exposed by socket2, so it is set by hand.
const IP_UNICAST_IF: i32 = 31;

/// How long the upstream half of a redirected connection may take.
/// Generous enough for a distant node, short enough that a dead tunnel
/// surfaces as a failed connection rather than a hang.
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// How often a blocked reader wakes to notice it should stop.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// How often idle flows are swept.
const EXPIRY_INTERVAL: Duration = Duration::from_secs(5);

/// The interface redirected traffic should leave by, as a live value
/// rather than a snapshot.
///
/// Zero means no tunnel, which is the fail-open case: sockets are left
/// unpinned and take the ordinary route.
#[derive(Default)]
pub struct TunnelInterface(AtomicU32);

impl TunnelInterface {
    pub fn new(index: u32) -> Self {
        Self(AtomicU32::new(index))
    }

    pub fn set(&self, index: u32) {
        self.0.store(index, Ordering::Relaxed);
    }

    fn get(&self) -> Option<u32> {
        match self.0.load(Ordering::Relaxed) {
            0 => None,
            index => Some(index),
        }
    }
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

/// A TCP socket placed on the tunnel, or on the normal route if none is
/// up.
fn connect_upstream(target: SocketAddrV4, tunnel: &TunnelInterface) -> io::Result<TcpStream> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    if let Some(index) = tunnel.get() {
        pin_to_interface(&socket, index)?;
    }
    socket.connect_timeout(&SocketAddr::V4(target).into(), UPSTREAM_CONNECT_TIMEOUT)?;
    Ok(socket.into())
}

/// A UDP socket placed the same way.
fn bind_upstream(tunnel: &TunnelInterface) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    if let Some(index) = tunnel.get() {
        pin_to_interface(&socket, index)?;
    }
    socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
    // Bounded so a reader thread notices its flow has been retired
    // instead of blocking forever on a socket nobody will answer.
    socket.set_read_timeout(Some(POLL_INTERVAL))?;
    Ok(socket.into())
}

/// Addresses used only to prove the tunnel carries traffic.
///
/// Two, because one being down or filtered is not evidence about the
/// tunnel. Both are anycast resolvers that answer on 443 from
/// essentially everywhere, so a refusal here really does say something
/// about the path rather than about the destination.
const PROBE_TARGETS: [(Ipv4Addr, u16); 2] =
    [(Ipv4Addr::new(1, 1, 1, 1), 443), (Ipv4Addr::new(8, 8, 8, 8), 443)];

/// Short on purpose: this runs inside the connect ladder, and a slow
/// answer costs the customer the same as a wrong one.
const PROBE_TIMEOUT: Duration = Duration::from_millis(3500);

/// Proves the tunnel is actually carrying traffic, over the exact path a
/// selected app's traffic takes.
///
/// This exists because Custom mode broke the app's own connection check
/// and the reason is structural, not a bug to patch: the check works by
/// requesting its own address and seeing the server's. In Custom mode
/// the app is not a selected app, so that request correctly goes out the
/// ordinary route -- and the check correctly reports the tunnel being
/// bypassed. Every protocol therefore "failed", the ladder walked all
/// five, and the customer was told it could not connect while the tunnel
/// was in fact up and working.
///
/// A socket pinned exactly as the proxy's are is the honest replacement.
/// A completed TCP handshake through it proves the tunnel exists, has a
/// route to the internet, and that the far end answered -- for the path
/// that actually matters, rather than for the app's own traffic, which
/// deliberately does not use it.
pub fn probe(tunnel: &TunnelInterface) -> Result<(), String> {
    // No tunnel means the fail-open state: selected apps are going out
    // unprotected. Reporting that as reachable would be the exact
    // dishonesty this whole function exists to remove.
    let Some(index) = tunnel.get() else {
        return Err("no tunnel is up, so nothing is being routed through one".into());
    };

    let mut last = String::new();
    for (address, port) in PROBE_TARGETS {
        match connect_pinned(address, port, index) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{address}:{port} {e}"),
        }
    }
    Err(format!("the tunnel did not carry a test connection ({last})"))
}

fn connect_pinned(address: Ipv4Addr, port: u16, index: u32) -> Result<(), String> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    pin_to_interface(&socket, index).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&SocketAddr::from((address, port)).into(), PROBE_TIMEOUT)
        .map_err(|e| e.to_string())
}

/// Handles on the running relays, so the controller can stop them.
pub struct Relays {
    pub tcp_port: u16,
    pub udp_port: u16,
    stop: Arc<AtomicBool>,
    upstreams: Arc<UdpUpstreams>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Relays {
    /// Signals every relay thread and waits for them.
    ///
    /// The TCP acceptor is woken by connecting to it: `accept` blocks,
    /// and a flag it never gets round to reading is not a stop.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.tcp_port));
        self.upstreams.close_all();
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

/// The upstream socket serving each redirected UDP flow, keyed by the
/// flow's synthetic port.
///
/// UDP has no connection, so all the state TCP gets for free is kept
/// here: which socket belongs to which flow, and a thread per socket,
/// because nothing prompts a reply.
#[derive(Default)]
struct UdpUpstreams {
    sockets: Mutex<HashMap<u16, Arc<UdpSocket>>>,
}

impl UdpUpstreams {
    fn get(&self, nat_port: u16) -> Option<Arc<UdpSocket>> {
        self.sockets.lock().unwrap().get(&nat_port).cloned()
    }

    fn insert(&self, nat_port: u16, socket: Arc<UdpSocket>) {
        self.sockets.lock().unwrap().insert(nat_port, socket);
    }

    fn close(&self, nat_port: u16) {
        self.sockets.lock().unwrap().remove(&nat_port);
    }

    fn close_all(&self) {
        self.sockets.lock().unwrap().clear();
    }
}

/// Starts both relays on ephemeral ports.
///
/// The ports are chosen by the OS and read back rather than fixed,
/// because the redirect filter is built from them: a hardcoded port that
/// something else already holds would fail at the worst moment, on a
/// customer's machine, with no way to pick another.
pub fn start(nat: Arc<Nat>, tunnel: Arc<TunnelInterface>) -> io::Result<Relays> {
    let tcp = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    let tcp_port = tcp.local_addr()?.port();

    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    let udp_port = udp.local_addr()?.port();
    udp.set_read_timeout(Some(POLL_INTERVAL))?;

    let stop = Arc::new(AtomicBool::new(false));
    let upstreams = Arc::new(UdpUpstreams::default());
    let mut threads = Vec::new();

    threads.push({
        let (nat, tunnel, stop) = (nat.clone(), tunnel.clone(), stop.clone());
        std::thread::spawn(move || accept_tcp(tcp, nat, tunnel, stop))
    });
    threads.push({
        let (nat, stop, upstreams) = (nat.clone(), stop.clone(), upstreams.clone());
        std::thread::spawn(move || serve_udp(udp, nat, tunnel, stop, upstreams))
    });
    threads.push({
        let (stop, upstreams) = (stop.clone(), upstreams.clone());
        std::thread::spawn(move || expire_flows(nat, stop, upstreams))
    });

    Ok(Relays { tcp_port, udp_port, stop, upstreams, threads })
}

fn accept_tcp(
    listener: TcpListener,
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stop: Arc<AtomicBool>,
) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(client) = stream else { continue };
        let Ok(peer) = client.peer_addr() else { continue };

        // The synthetic port is the whole link back: the rewritten
        // packet no longer says where it was going, and this is what
        // identifies the flow that does.
        let Some(origin) = nat.origin(Transport::Tcp, peer.port()) else {
            // Either the flow was retired underneath us, or something
            // connected to this port directly. Neither is ours to carry:
            // with no origin there is nowhere to send it.
            continue;
        };

        let tunnel = tunnel.clone();
        std::thread::spawn(move || {
            let target = SocketAddrV4::new(origin.addr, origin.port);
            if let Ok(upstream) = connect_upstream(target, &tunnel) {
                pump(client, upstream);
            }
        });
    }
}

/// Copies in both directions until either side closes.
///
/// Two threads rather than one loop because either direction can block
/// indefinitely, and a TLS handshake talks both ways before either side
/// has finished saying anything.
fn pump(client: TcpStream, upstream: TcpStream) {
    let (mut client_read, mut upstream_write) = (client, upstream);
    let (Ok(mut client_write), Ok(mut upstream_read)) =
        (client_read.try_clone(), upstream_write.try_clone())
    else {
        return;
    };

    let outbound = std::thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        // Half-close rather than drop: the far end may still have a
        // reply in flight, and tearing the whole socket down here would
        // truncate it.
        let _ = upstream_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = io::copy(&mut upstream_read, &mut client_write);
    let _ = client_write.shutdown(std::net::Shutdown::Write);
    let _ = outbound.join();
}

fn serve_udp(
    local: UdpSocket,
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stop: Arc<AtomicBool>,
    upstreams: Arc<UdpUpstreams>,
) {
    let local = Arc::new(local);
    let mut buffer = vec![0u8; 65_535];

    while !stop.load(Ordering::SeqCst) {
        let Ok((len, from)) = local.recv_from(&mut buffer) else {
            continue; // read timeout, or a transient error worth retrying
        };
        let SocketAddr::V4(from) = from else { continue };
        let nat_port = from.port();

        let Some(origin) = nat.origin(Transport::Udp, nat_port) else { continue };

        let upstream = match upstreams.get(nat_port) {
            Some(socket) => socket,
            None => {
                let Ok(socket) = bind_upstream(&tunnel) else { continue };
                let socket = Arc::new(socket);
                upstreams.insert(nat_port, socket.clone());

                let (reader, back, nat, stop) =
                    (socket.clone(), local.clone(), nat.clone(), stop.clone());
                std::thread::spawn(move || {
                    read_udp_replies(reader, back, nat, stop, nat_port, origin.client)
                });
                socket
            }
        };

        let target = SocketAddrV4::new(origin.addr, origin.port);
        let _ = upstream.send_to(&buffer[..len], target);
    }
}

/// Carries replies on one UDP flow back to the app.
///
/// The reply is addressed to the flow's synthetic port; the redirect
/// loop restores the app's real source port before delivering it.
///
/// Exits when the flow is retired -- the read timeout is what gives it
/// the chance to notice, since a datagram that never comes would
/// otherwise hold the thread forever.
fn read_udp_replies(
    upstream: Arc<UdpSocket>,
    local: Arc<UdpSocket>,
    nat: Arc<Nat>,
    stop: Arc<AtomicBool>,
    nat_port: u16,
    client: Ipv4Addr,
) {
    let mut buffer = vec![0u8; 65_535];
    loop {
        if stop.load(Ordering::SeqCst) || nat.origin(Transport::Udp, nat_port).is_none() {
            return;
        }
        let Ok((len, _)) = upstream.recv_from(&mut buffer) else { continue };
        let _ = local.send_to(&buffer[..len], SocketAddrV4::new(client, nat_port));
    }
}

/// Retires idle flows and closes the sockets that served them.
fn expire_flows(nat: Arc<Nat>, stop: Arc<AtomicBool>, upstreams: Arc<UdpUpstreams>) {
    // Interruptible, because this thread is joined during teardown: a
    // plain five-second sleep between sweeps meant Disconnect could sit
    // for five seconds after everything else was already torn down.
    while super::sleep_unless_stopped(&stop, EXPIRY_INTERVAL) {
        for nat_port in nat.expire_idle() {
            upstreams.close(nat_port);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split_tunnel::flows::Origin;

    #[test]
    fn a_zero_interface_means_no_tunnel() {
        // Zero is not a valid interface index, and it is what the
        // controller stores between engines. Pinning to it would fail
        // every connection during a failover, which is precisely the
        // moment the decided behaviour is to let traffic through.
        let tunnel = TunnelInterface::default();
        assert_eq!(tunnel.get(), None);
        tunnel.set(14);
        assert_eq!(tunnel.get(), Some(14));
        tunnel.set(0);
        assert_eq!(tunnel.get(), None);
    }

    #[test]
    fn the_probe_refuses_to_pass_when_no_tunnel_is_up() {
        // The fail-open state: selected apps are going out unprotected.
        // Reporting that as reachable would let the ladder settle on a
        // "connection" carrying nothing through the tunnel -- the exact
        // false-Connected this project keeps having to remove.
        let error = probe(&TunnelInterface::default()).expect_err("no tunnel means no proof");
        assert!(error.contains("no tunnel"), "got {error}");
    }

    #[test]
    fn the_probe_fails_rather_than_falling_back_to_the_normal_route() {
        // Pinned to an interface that does not exist, so there is no
        // route to reach anything. If this ever passed, the probe would
        // be measuring the machine's ordinary connectivity and would
        // call a dead tunnel healthy.
        let error = probe(&TunnelInterface::new(u32::MAX)).expect_err("nothing can be reached");
        assert!(error.contains("did not carry"), "got {error}");
    }

    #[test]
    fn relays_bind_distinct_ephemeral_ports() {
        // The redirect filter is built from these, so they have to be
        // real and they have to differ.
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()))
            .expect("relays should bind");
        assert!(relays.tcp_port > 0);
        assert!(relays.udp_port > 0);
        assert_ne!(relays.tcp_port, relays.udp_port);
        relays.stop();
    }

    #[test]
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

    #[test]
    fn a_tcp_connection_with_no_recorded_flow_is_dropped() {
        // Nothing else can be done with it: the rewritten packet no
        // longer says where it was going. Carrying on regardless is how
        // a relay ends up connecting somewhere nobody asked for.
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()))
            .expect("relays should bind");

        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, relays.tcp_port))
            .expect("the relay accepts, then decides");
        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();

        use std::io::Read;
        let mut buffer = [0u8; 1];
        assert!(matches!(client.read(&mut buffer), Ok(0) | Err(_)));
        relays.stop();
    }

    #[test]
    fn tcp_relays_a_real_connection_to_the_recorded_destination() {
        // End to end through the relay, without WinDivert: a flow is
        // recorded by hand, a client connects to the relay on that
        // flow's synthetic port, and the bytes have to come out at the
        // destination the flow named -- not the one the client dialled.
        let echo = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = echo.accept() {
                let mut buffer = [0u8; 16];
                use std::io::{Read, Write};
                if let Ok(n) = stream.read(&mut buffer) {
                    let _ = stream.write_all(&buffer[..n]);
                }
            }
        });

        let nat = Arc::new(Nat::new());
        let relays =
            start(nat.clone(), Arc::new(TunnelInterface::default())).expect("relays should bind");

        // No tunnel is up, so the upstream socket is unpinned -- the
        // fail-open path, which is also the only one testable without a
        // real node.
        let client = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        client.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into()).unwrap();
        let client_port = client.local_addr().unwrap().as_socket_ipv4().unwrap().port();

        let nat_port = nat
            .redirect(
                Transport::Tcp,
                Origin {
                    addr: Ipv4Addr::LOCALHOST,
                    port: echo_port,
                    client: Ipv4Addr::LOCALHOST,
                    client_port,
                    interface_id: 1,
                },
            )
            .unwrap();
        // Stand in for the rewrite: connect from the synthetic port the
        // redirect loop would have presented to the relay.
        drop(client);
        let source = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        source.set_reuse_address(true).unwrap();
        source.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, nat_port)).into()).unwrap();
        source
            .connect(&SocketAddr::from((Ipv4Addr::LOCALHOST, relays.tcp_port)).into())
            .unwrap();

        let mut stream: TcpStream = source.into();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        use std::io::{Read, Write};
        stream.write_all(b"through").unwrap();

        let mut buffer = [0u8; 7];
        stream.read_exact(&mut buffer).expect("the echo server must have been reached");
        assert_eq!(&buffer, b"through");
        relays.stop();
    }
}
