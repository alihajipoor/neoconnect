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

use std::collections::{HashMap, HashSet};
use std::io;
use std::mem::size_of;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::windows::io::AsRawSocket;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

    fn get(&self) -> Option<(u32, Ipv4Addr)> {
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
/// check in `redirect::decide` is what covers it -- as it always did.
fn register(own: &Arc<OwnSockets>, socket: &Socket, transport: Transport) -> Option<Registration> {
    let addr = socket.local_addr().ok()?.as_socket_ipv4()?;
    if addr.ip().is_unspecified() {
        return None;
    }
    own.insert(transport, addr);
    Some(Registration { own: own.clone(), transport, addr })
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
pub(super) fn attach_to_tunnel(socket: &Socket, index: u32, address: Ipv4Addr) -> io::Result<()> {
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
pub(super) fn can_attach(index: u32, address: Ipv4Addr) -> bool {
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

/// A TCP socket placed on the tunnel, or on the normal route if none is
/// up.
fn connect_upstream(
    target: SocketAddrV4,
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
) -> io::Result<(TcpStream, Option<Registration>)> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    let pinned = tunnel.get();
    let mut registration = None;
    if let Some((index, address)) = pinned {
        if let Err(e) = attach_to_tunnel(&socket, index, address) {
            // Logged, not just returned. A failure here is invisible in
            // the redirect's counters -- packets still arrive and are
            // counted as redirected, and the only symptom is that
            // nothing ever comes back, which is exactly how this
            // presented: redirected=10 returned=0 rejected=0 with the
            // selected app timing out and the probe reporting healthy.
            note(&format!(
                "upstream attach FAILED for {target}: {e} (interface {index}, source {address})"
            ));
            return Err(e);
        }
        // Before the connect, not after: the SYN is the first thing the
        // redirect loop sees, and a registration that lands afterwards
        // is exactly the race this replaces.
        registration = register(own, &socket, Transport::Tcp);
    }
    if let Err(e) = socket.connect_timeout(&SocketAddr::V4(target).into(), UPSTREAM_CONNECT_TIMEOUT)
    {
        note(&format!(
            "upstream connect FAILED to {target}: {e} (pinned {:?})",
            pinned.map(|(i, _)| i)
        ));
        return Err(e);
    }
    Ok((socket.into(), registration))
}

/// Appends one line to the split-tunnel log.
///
/// The proxy is handed no log path -- it is started with the NAT table
/// and the interface and nothing else -- so the location is derived the
/// same way the service derives its config directory. Threading a path
/// through every call site would be tidier and was not worth delaying
/// the diagnosis of a bug whose whole difficulty is that it leaves no
/// trace anywhere.
fn note(line: &str) {
    use std::io::Write;
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    let path = std::path::Path::new(&base).join("Neoxify").join("split-tunnel.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// A UDP socket placed the same way.
/// How long to keep trying to bind a socket to the tunnel.
///
/// Covers duplicate address detection on a freshly created adapter,
/// which is the only reason this legitimately fails for more than an
/// instant. Well short of a resolver's own patience, so a retry here is
/// invisible where a dropped datagram was not.
const BIND_RETRY_FOR: Duration = Duration::from_secs(6);
const BIND_RETRY_EVERY: Duration = Duration::from_millis(100);

/// Where the relay reports a problem it would otherwise swallow.
///
/// Set once when Custom mode starts. A silent `continue` in this loop is
/// invisible from every angle -- the counters call it "seen", the app
/// calls it connected, and the customer calls it broken.
static RELAY_LOG: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_relay_log(path: PathBuf) {
    let _ = RELAY_LOG.set(path);
}

fn stats_note(message: &str) {
    if let Some(path) = RELAY_LOG.get() {
        super::append(path, message);
    }
}

fn bind_upstream_retrying(
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
) -> io::Result<(UdpSocket, Option<Registration>)> {
    let deadline = Instant::now() + BIND_RETRY_FOR;
    loop {
        match bind_upstream(tunnel, own) {
            Ok(socket) => return Ok(socket),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(BIND_RETRY_EVERY),
        }
    }
}

fn bind_upstream(
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
) -> io::Result<(UdpSocket, Option<Registration>)> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    match tunnel.get() {
        Some((index, address)) => attach_to_tunnel(&socket, index, address)?,
        // Fail-open: no tunnel, so take the ordinary route.
        None => socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?,
    }
    // Bounded so a reader thread notices its flow has been retired
    // instead of blocking forever on a socket nobody will answer.
    socket.set_read_timeout(Some(POLL_INTERVAL))?;
    // Registered while the caller still holds it and before a single
    // datagram has left, so the redirect loop can never see a packet
    // from a socket it does not yet know is ours.
    let registration = register(own, &socket, Transport::Udp);
    Ok((socket.into(), registration))
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
/// A socket pinned exactly as the proxy's are is the honest replacement,
/// for the path that actually matters rather than for the app's own
/// traffic, which deliberately does not use it.
///
/// **What a pass here does and does not mean.** It means a socket could
/// be attached to this tunnel and complete a TCP handshake through it,
/// which is what route selection needs to know and is why
/// `install_verified_route` uses this. It does **not** mean the node is
/// reachable: under Xray's own `tun` inbound the handshake is answered
/// by xray.exe's userspace stack, and nothing is sent afterwards for the
/// outbound to have to carry. This comment used to claim the opposite --
/// "proves the tunnel has a route to the internet and that the far end
/// answered" -- and the customer-facing verdict was built on that claim.
/// See `prove_carries` for the check that earns it.
pub fn probe(tunnel: &TunnelInterface) -> Result<(), String> {
    // No tunnel means the fail-open state: selected apps are going out
    // unprotected. Reporting that as reachable would be the exact
    // dishonesty this whole function exists to remove.
    let Some((index, address)) = tunnel.get() else {
        return Err("no tunnel is up, so nothing is being routed through one".into());
    };

    let mut last = String::new();
    for (target, port) in PROBE_TARGETS {
        match connect_pinned(target, port, index, address) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{target}:{port} {e}"),
        }
    }
    Err(format!("the tunnel did not carry a test connection ({last})"))
}

fn connect_pinned(
    target: Ipv4Addr,
    port: u16,
    index: u32,
    source: Ipv4Addr,
) -> Result<(), String> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    attach_to_tunnel(&socket, index, source).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&SocketAddr::from((target, port)).into(), PROBE_TIMEOUT)
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ *
 * Proving the tunnel carries traffic, as opposed to proving a socket
 * can be attached to it.
 *
 * `probe` above answers the second question, and route selection is the
 * right consumer for it: it is asking whether a route shape works at
 * all, and a completed TCP handshake settles that.
 *
 * It is not enough to put "You're protected" on a customer's screen, for
 * two reasons that compound.
 *
 * **The handshake need never leave the machine.** Xray on Windows runs
 * its own `tun` inbound -- a userspace TCP stack inside xray.exe (see
 * `engines/xray.rs`). The SYN this probe emits is answered by that
 * stack, not by 1.1.1.1. It completes as soon as xray.exe is running
 * with a live Wintun adapter, whether or not the VLESS session to the
 * node exists, and since the old probe sent zero bytes the outbound was
 * never asked to carry anything. For the kernel tunnels -- WireGuard,
 * OpenVPN, IKEv2 -- the SYN really does traverse the tunnel, so the hole
 * is narrower there but the check is still weaker than it reads.
 *
 * **REALITY does not refuse an unknown SNI; it proxies to the decoy.**
 * A node whose `dest` was changed while a client holds a stale
 * `serverName` hands that client's connection straight to a third-party
 * website. The outer TLS keeps succeeding and looks perfectly healthy
 * while the customer's traffic goes nowhere. Any far-end
 * misconfiguration produces the same shape, so a check that stops at TCP
 * cannot tell a working node from a broken one.
 *
 * What distinguishes them is **bytes coming back from the destination**.
 * Both probe targets are DNS-over-HTTPS resolvers, so a ClientHello sent
 * to them is answered with a TLS record. Nothing local can forge that:
 * xray's userspace stack will ACK a SYN, but it has no ServerHello to
 * invent, and a REALITY session handed to a decoy fails client-side
 * before any payload is relayed. So the connection is closed with
 * nothing read, and this check comes back negative -- which is the
 * behaviour the old one could not produce.
 * ------------------------------------------------------------------ */

/// Total budget for one target: connect, write, and read a reply.
///
/// Kept equal to `PROBE_TIMEOUT` rather than added to it. This runs
/// inside the connect ladder and on every health poll, and a check that
/// doubles the time a customer waits has traded one complaint for
/// another.
const CARRY_TIMEOUT: Duration = PROBE_TIMEOUT;

/// A minimal but genuine TLS 1.2+ ClientHello for `cloudflare-dns.com`.
///
/// Genuine matters. A random blob would be answered with a TLS `alert`
/// record, which is still a record and would therefore still pass -- a
/// check that cannot fail, which is the recurring defect in this
/// codebase. A well-formed ClientHello draws a `handshake` record from a
/// working path and nothing at all from a broken one.
///
/// The SNI is a real Cloudflare name because the target is 1.1.1.1;
/// 8.8.8.8 answers a ClientHello for it regardless, since a name it does
/// not serve still produces a record.
fn client_hello() -> Vec<u8> {
    const SNI: &[u8] = b"cloudflare-dns.com";

    // server_name extension: list length, type 0 (host_name), name.
    let mut server_name = Vec::new();
    server_name.extend_from_slice(&((SNI.len() + 3) as u16).to_be_bytes());
    server_name.push(0);
    server_name.extend_from_slice(&(SNI.len() as u16).to_be_bytes());
    server_name.extend_from_slice(SNI);

    let mut extensions = Vec::new();
    // server_name
    extensions.extend_from_slice(&0x0000u16.to_be_bytes());
    extensions.extend_from_slice(&(server_name.len() as u16).to_be_bytes());
    extensions.extend_from_slice(&server_name);
    // supported_versions: TLS 1.3, TLS 1.2
    extensions.extend_from_slice(&0x002bu16.to_be_bytes());
    extensions.extend_from_slice(&5u16.to_be_bytes());
    extensions.push(4);
    extensions.extend_from_slice(&0x0304u16.to_be_bytes());
    extensions.extend_from_slice(&0x0303u16.to_be_bytes());
    // supported_groups: x25519, secp256r1
    extensions.extend_from_slice(&0x000au16.to_be_bytes());
    extensions.extend_from_slice(&6u16.to_be_bytes());
    extensions.extend_from_slice(&4u16.to_be_bytes());
    extensions.extend_from_slice(&0x001du16.to_be_bytes());
    extensions.extend_from_slice(&0x0017u16.to_be_bytes());
    // signature_algorithms: ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256
    extensions.extend_from_slice(&0x000du16.to_be_bytes());
    extensions.extend_from_slice(&6u16.to_be_bytes());
    extensions.extend_from_slice(&4u16.to_be_bytes());
    extensions.extend_from_slice(&0x0403u16.to_be_bytes());
    extensions.extend_from_slice(&0x0804u16.to_be_bytes());

    let mut body = Vec::new();
    // client_version: TLS 1.2, as TLS 1.3 requires on the wire.
    body.extend_from_slice(&0x0303u16.to_be_bytes());
    // random. Fixed rather than sampled: nothing here is cryptographic,
    // the session is abandoned after one record, and a probe with no
    // entropy source is one fewer thing that can fail.
    body.extend_from_slice(&[0x4e; 32]);
    // session_id: empty.
    body.push(0);
    // cipher_suites: TLS_AES_128_GCM_SHA256, TLS_ECDHE_RSA_AES_128_GCM_SHA256
    body.extend_from_slice(&4u16.to_be_bytes());
    body.extend_from_slice(&0x1301u16.to_be_bytes());
    body.extend_from_slice(&0xc02fu16.to_be_bytes());
    // compression_methods: null only.
    body.extend_from_slice(&[1, 0]);
    body.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
    body.extend_from_slice(&extensions);

    let mut handshake = Vec::new();
    handshake.push(1); // client_hello
    let len = body.len();
    handshake.extend_from_slice(&[(len >> 16) as u8, (len >> 8) as u8, len as u8]);
    handshake.extend_from_slice(&body);

    let mut record = Vec::new();
    record.push(0x16); // handshake
    record.extend_from_slice(&0x0301u16.to_be_bytes());
    record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
    record.extend_from_slice(&handshake);
    record
}

/// Whether the first bytes off the wire are the start of a TLS record a
/// real server sent.
///
/// Deliberately narrow. `handshake` (0x16) is what a working path
/// returns; `alert` (0x15) is accepted too, because a server that
/// dislikes the ClientHello still had to receive it and reply, which is
/// the fact being established. Anything else -- an HTTP error page from
/// a captive portal, a decoy site's response, a truncated read -- is
/// not evidence that the intended destination answered.
///
/// The version check is what keeps this from accepting arbitrary bytes:
/// a record whose type byte happens to be 0x16 but whose version is not
/// a TLS one is not a TLS record.
pub(super) fn looks_like_tls(reply: &[u8]) -> bool {
    let [kind, major, minor, ..] = reply else {
        return false;
    };
    matches!(kind, 0x16 | 0x15) && *major == 0x03 && matches!(minor, 0x00..=0x04)
}

/// Proves the tunnel carried a request *and brought back an answer*.
///
/// The verdict the app turns into "You're protected" in Custom mode. See
/// the comment block above for why a completed handshake is not enough
/// on its own.
pub fn prove_carries(tunnel: &TunnelInterface) -> Result<(), String> {
    // No tunnel means the fail-open state: selected apps are going out
    // unprotected. Reporting that as carrying traffic would be the exact
    // dishonesty this whole function exists to remove.
    let Some((index, address)) = tunnel.get() else {
        return Err("no tunnel is up, so nothing is being routed through one".into());
    };

    let mut last = String::new();
    for (target, port) in PROBE_TARGETS {
        match round_trip_pinned(target, port, index, address) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{target}:{port} {e}"),
        }
    }
    Err(format!("the tunnel did not carry a test connection ({last})"))
}

fn round_trip_pinned(
    target: Ipv4Addr,
    port: u16,
    index: u32,
    source: Ipv4Addr,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let started = Instant::now();
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    attach_to_tunnel(&socket, index, source).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&SocketAddr::from((target, port)).into(), CARRY_TIMEOUT)
        .map_err(|e| format!("connect: {e}"))?;

    // Whatever is left of the budget, never zero -- a zero timeout on a
    // Windows socket means "block forever", which is how a check with a
    // deadline becomes one without.
    let remaining = CARRY_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "connect used the whole budget".to_string())?;
    socket.set_write_timeout(Some(remaining)).map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(remaining)).map_err(|e| e.to_string())?;

    let mut stream: TcpStream = socket.into();
    stream.write_all(&client_hello()).map_err(|e| format!("send: {e}"))?;

    // Five bytes is a whole TLS record header and all this needs; the
    // rest of the handshake is of no interest and reading it would only
    // cost time on a slow link.
    let mut header = [0u8; 5];
    let mut filled = 0;
    while filled < header.len() {
        match stream.read(&mut header[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("read: {e}")),
        }
    }

    if looks_like_tls(&header[..filled]) {
        return Ok(());
    }
    // Named precisely, because this is the case the old probe could not
    // see: the connection was made and the far end sent nothing back
    // that the destination could have sent. That is what a tunnel
    // terminating in a decoy site, or in xray's own userspace stack,
    // looks like from here.
    Err(format!(
        "the tunnel completed a connection but carried no reply from {target} ({filled} byte(s))"
    ))
}

/// Handles on the running relays, so the controller can stop them.
pub struct Relays {
    pub tcp_port: u16,
    pub udp_port: u16,
    /// The onward sockets this relay owns, for the redirect loop to
    /// recognise its traffic. Created here because this is the side that
    /// creates the sockets, and read by `redirect::decide`.
    pub own_sockets: Arc<OwnSockets>,
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
    sockets: Mutex<HashMap<u16, Upstream>>,
}

/// One flow's onward socket, held together with the registration that
/// says it belongs to us -- so retiring the flow retires both, and a
/// port number cannot stay claimed after Windows has reissued it.
struct Upstream {
    socket: Arc<UdpSocket>,
    _registration: Option<Registration>,
}

impl UdpUpstreams {
    fn get(&self, nat_port: u16) -> Option<Arc<UdpSocket>> {
        self.sockets.lock().unwrap().get(&nat_port).map(|u| u.socket.clone())
    }

    fn insert(&self, nat_port: u16, socket: Arc<UdpSocket>, registration: Option<Registration>) {
        self.sockets.lock().unwrap().insert(nat_port, Upstream { socket, _registration: registration });
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
    let own_sockets = Arc::new(OwnSockets::default());
    let mut threads = Vec::new();

    threads.push({
        let (nat, tunnel, stop, own) =
            (nat.clone(), tunnel.clone(), stop.clone(), own_sockets.clone());
        std::thread::spawn(move || accept_tcp(tcp, nat, tunnel, stop, own))
    });
    threads.push({
        let (nat, stop, upstreams, own) =
            (nat.clone(), stop.clone(), upstreams.clone(), own_sockets.clone());
        std::thread::spawn(move || serve_udp(udp, nat, tunnel, stop, upstreams, own))
    });
    threads.push({
        let (stop, upstreams) = (stop.clone(), upstreams.clone());
        std::thread::spawn(move || expire_flows(nat, stop, upstreams))
    });

    Ok(Relays { tcp_port, udp_port, own_sockets, stop, upstreams, threads })
}

fn accept_tcp(
    listener: TcpListener,
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stop: Arc<AtomicBool>,
    own: Arc<OwnSockets>,
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
            //
            // Said out loud rather than dropped in silence. This is the
            // one place a redirected connection can disappear without
            // any counter moving: the packets were rewritten and sent,
            // so `redirected` climbs, and nothing ever answers.
            note(&format!("accepted from port {} but no flow claims it", peer.port()));
            continue;
        };

        let tunnel = tunnel.clone();
        let own = own.clone();
        std::thread::spawn(move || {
            let target = origin.upstream.unwrap_or_else(|| SocketAddrV4::new(origin.addr, origin.port));
            // The registration is held for the life of the connection,
            // not just the connect: every packet this socket sends has
            // to be recognised as ours, not only its SYN.
            if let Ok((upstream, _registration)) = connect_upstream(target, &tunnel, &own) {
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
    own: Arc<OwnSockets>,
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
                // Retried rather than dropped, and this is the whole
                // "the browser takes ten to twenty seconds" bug.
                //
                // A tunnel address is tentative for a moment after the
                // adapter comes up, while Windows finishes duplicate
                // address detection, and a socket cannot be bound to it
                // until that completes. This used to `continue`, so
                // every datagram in that window vanished with no log and
                // no retry. DNS is the first thing anything does, so the
                // resolver exhausted its retry budget and the lookup
                // failed outright -- while TCP, which retransmits its
                // own SYN for far longer, sailed through and made the
                // whole thing look like a DNS-specific fault.
                //
                // Measured: nothing on the wire for the first fourteen
                // seconds, then every lookup fine.
                let (socket, registration) = match bind_upstream_retrying(&tunnel, &own) {
                    Ok(bound) => bound,
                    Err(e) => {
                        stats_note(&format!("upstream bind failed for udp flow: {e}"));
                        continue;
                    }
                };
                let socket = Arc::new(socket);
                upstreams.insert(nat_port, socket.clone(), registration);

                let (reader, back, nat, stop) =
                    (socket.clone(), local.clone(), nat.clone(), stop.clone());
                std::thread::spawn(move || {
                    read_udp_replies(reader, back, nat, stop, nat_port, origin.client)
                });
                socket
            }
        };

        let target = origin.upstream.unwrap_or_else(|| SocketAddrV4::new(origin.addr, origin.port));
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
        tunnel.set(14, Ipv4Addr::new(10, 66, 0, 3));
        assert_eq!(tunnel.get(), Some((14, Ipv4Addr::new(10, 66, 0, 3))));
        tunnel.clear();
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
    fn proving_carriage_refuses_to_pass_when_no_tunnel_is_up() {
        // The same fail-open guard as above, on the stricter check --
        // written out rather than assumed, because this is the one whose
        // verdict becomes "You're protected".
        let error =
            prove_carries(&TunnelInterface::default()).expect_err("no tunnel means no proof");
        assert!(error.contains("no tunnel"), "got {error}");
    }

    #[test]
    fn a_completed_connection_that_answers_nothing_is_not_proof() {
        // The whole point of the stricter probe, exercised against a
        // listener that behaves exactly as the failure modes do: it
        // accepts the connection and never sends a byte.
        //
        // That is what xray-core's own `tun` inbound does when its
        // outbound cannot be dialled -- it has already ACKed the SYN
        // locally -- and it is what a REALITY session handed to a decoy
        // site produces, because the client aborts before any payload is
        // relayed. The old probe passed both. This is the control that
        // shows it: `looks_like_tls` on what such a peer sends back is
        // false, so `round_trip_pinned` cannot return Ok.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepted = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // Read the ClientHello so the write side cannot fail, then
            // hang up without answering.
            let mut sink = [0u8; 1024];
            let _ = std::io::Read::read(&mut stream, &mut sink);
            drop(stream);
        });

        // Loopback, unpinned: the interface machinery is not what is
        // under test here and cannot be stood up in a unit test.
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        std::io::Write::write_all(&mut stream, &client_hello()).expect("send");
        stream.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        let mut header = [0u8; 5];
        let filled = std::io::Read::read(&mut stream, &mut header).unwrap_or(0);
        accepted.join().expect("listener");

        assert_eq!(filled, 0, "a silent peer must not send anything");
        assert!(!looks_like_tls(&header[..filled]), "silence is not a TLS reply");
    }

    #[test]
    fn only_a_tls_record_from_the_far_end_counts_as_a_reply() {
        // The other half of the same guard, and the reason it is written
        // as a table: a check that accepts anything is the recurring
        // defect this file keeps producing. Each rejected case is a real
        // thing that arrives on port 443 through a broken path.
        assert!(looks_like_tls(&[0x16, 0x03, 0x03, 0x00, 0x5a]), "a TLS 1.2 handshake record");
        assert!(looks_like_tls(&[0x16, 0x03, 0x01, 0x00, 0x2a]), "a TLS 1.0-framed record");
        assert!(looks_like_tls(&[0x15, 0x03, 0x03, 0x00, 0x02]), "an alert is still a reply");

        assert!(!looks_like_tls(&[]), "nothing came back");
        assert!(!looks_like_tls(&[0x16, 0x03]), "a truncated read is not a record");
        // A captive portal or a decoy site answering HTTP: "HTTP/1.1".
        assert!(!looks_like_tls(b"HTTP/1"), "an HTTP response is not a TLS record");
        // The type byte alone must not carry the decision.
        assert!(!looks_like_tls(&[0x16, 0x09, 0x09, 0x00, 0x01]), "0x16 with no TLS version");
        assert!(!looks_like_tls(&[0x17, 0x03, 0x03, 0x00, 0x01]), "application data unprompted");
    }

    #[test]
    fn the_client_hello_is_one_well_formed_tls_record() {
        // Not cosmetic. A malformed blob would draw an `alert` record,
        // which `looks_like_tls` accepts -- so the check would pass on
        // any path that reaches a TLS server at all and would have
        // nothing to say about whether it reached the right one. Worse,
        // it would still pass through a decoy, which is the failure this
        // exists to catch.
        let hello = client_hello();
        assert_eq!(hello[0], 0x16, "handshake record");
        assert_eq!(&hello[1..3], &[0x03, 0x01], "record version TLS 1.0, as TLS 1.3 requires");

        let record_len = u16::from_be_bytes([hello[3], hello[4]]) as usize;
        assert_eq!(record_len, hello.len() - 5, "the record header must describe the record");

        assert_eq!(hello[5], 0x01, "client_hello");
        let handshake_len = ((hello[6] as usize) << 16) | ((hello[7] as usize) << 8) | hello[8] as usize;
        assert_eq!(handshake_len, hello.len() - 9, "the handshake header likewise");

        // Small enough to leave in one segment on any path, which is
        // what keeps this cheap on a slow censored link.
        assert!(hello.len() < 512, "the ClientHello is {} bytes", hello.len());
    }

    #[test]
    #[ignore = "u32::MAX is not a reliable stand-in for an unreachable interface -- see the comment"]
    fn the_probe_fails_rather_than_falling_back_to_the_normal_route() {
        // Pinned to an interface that does not exist, so there should be
        // no route to reach anything.
        //
        // Ignored because the premise is not a guarantee. This is the
        // second time this same test has been written against an assumed
        // Windows behaviour and been wrong: first `setsockopt` was
        // expected to reject a bogus index and did not, and now `connect`
        // over one is observed to succeed on a real machine -- an invalid
        // index appears to leave the socket unconstrained rather than
        // constrained to nothing.
        //
        // The property itself does hold for indices that name a real
        // adapter, which is the only case production has. The evidence is
        // a customer's own log: on one machine, at one moment, sockets
        // pinned to the Xray and OpenVPN adapters failed with
        // WSAEHOSTUNREACH while a socket pinned to the WireGuard adapter
        // connected. If pinning were being ignored, all three would have
        // gone out the physical link and all three would have succeeded.
        //
        // Left in place rather than deleted so the next person does not
        // write it a third time.
        let error = probe(&TunnelInterface::new(u32::MAX, Ipv4Addr::new(10, 66, 0, 3)))
            .expect_err("nothing can be reached");
        assert!(error.contains("did not carry"), "got {error}");
    }

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
        // covered by the image check in `redirect::decide`, as it always
        // was, and this returns nothing rather than something wrong.
        let own = Arc::new(OwnSockets::default());
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into()).unwrap();

        assert!(register(&own, &socket, Transport::Udp).is_none());
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
                    upstream: None,
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
