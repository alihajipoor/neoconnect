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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};
use windows_sys::Win32::Networking::WinSock::setsockopt;

use super::flows::Nat;
use super::owner::Transport;
use super::redirect::Stats;

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

/// How many datagrams one flow may hold while its upstream socket is
/// still being bound.
///
/// A bound is needed because the wait can last [`BIND_RETRY_FOR`], and a
/// flow that sends sixty datagrams a second -- an ordinary game -- would
/// otherwise hold half a megabyte, times however many flows started at
/// the same moment. Two hundred and fifty-six covers a resolver's whole
/// retry budget many times over and a game's first few seconds.
///
/// The *oldest* held datagrams are the ones kept: the first datagram of
/// a flow is the one that matters -- it is the DNS query, the handshake,
/// the login -- and it is the one 0.9.20 exists to protect.
const MAX_HELD_DATAGRAMS: usize = 256;

/// How often a repeated relay complaint may be written to the log.
///
/// The conditions these report can hold for seconds while thousands of
/// datagrams pass, and a line per datagram is a log nobody can read.
const COMPLAINT_EVERY: Duration = Duration::from_secs(5);

/// Lets a repeated complaint through at most once per
/// [`COMPLAINT_EVERY`], so a persistent fault is visible without being
/// the only thing in the file.
struct Throttle(Mutex<Option<Instant>>);

impl Throttle {
    const fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn ready(&self) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        match *last {
            Some(previous) if now.duration_since(previous) < COMPLAINT_EVERY => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

/// Flows whose upstream socket could not be bound at once, and the
/// datagrams held for them while it is retried **off the receive loop**.
///
/// `serve_udp` is a single receive loop serving every redirected UDP
/// flow on the machine. It used to call `bind_upstream_retrying` inline,
/// which retries for `BIND_RETRY_FOR` at `BIND_RETRY_EVERY` -- so one
/// new flow that could not bind stopped *every other UDP flow* for up to
/// six seconds. Nothing about that was theoretical: the condition that
/// makes a bind fail is a tunnel address still tentative under duplicate
/// address detection, which is to say the seconds just after a connect
/// or a protocol failover. The freeze therefore landed at the one moment
/// the customer was already watching.
///
/// The 0.9.20 behaviour is kept exactly: a datagram that arrives before
/// its flow can be bound is still not dropped, it is still retried for
/// six seconds, and it is still sent afterwards -- in the order it
/// arrived. What changed is which thread waits.
#[derive(Default)]
struct PendingFlows {
    /// How many flows are waiting. Read on the receive loop for every
    /// datagram, so that the ordinary case -- nothing pending, which is
    /// every datagram of every established flow -- costs one relaxed
    /// load instead of a lock.
    waiting: AtomicUsize,
    held: Mutex<HashMap<u16, Vec<Vec<u8>>>>,
}

/// What happened to a datagram offered to [`PendingFlows::hold`].
#[derive(PartialEq, Eq, Debug)]
enum Hold {
    /// Queued behind this flow's earlier datagrams.
    Held,
    /// The flow is waiting, but its queue is full -- see
    /// [`MAX_HELD_DATAGRAMS`]. Not sent, and counted rather than
    /// vanishing.
    Overflowed,
    /// This flow is not waiting on a bind; the caller carries on.
    NotWaiting,
}

impl PendingFlows {
    /// Whether any flow at all is waiting.
    fn any(&self) -> bool {
        self.waiting.load(Ordering::Relaxed) != 0
    }

    /// Queues a datagram if its flow is waiting on a bind.
    fn hold(&self, nat_port: u16, datagram: &[u8]) -> Hold {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.get_mut(&nat_port) {
            None => Hold::NotWaiting,
            Some(queue) if queue.len() >= MAX_HELD_DATAGRAMS => Hold::Overflowed,
            Some(queue) => {
                queue.push(datagram.to_vec());
                Hold::Held
            }
        }
    }

    /// Starts a flow waiting, holding its first datagram.
    ///
    /// Returns whether this call created the wait, which is what tells
    /// the caller to start the retry. False means one is already running
    /// and this datagram has joined its queue.
    fn begin(&self, nat_port: u16, datagram: &[u8]) -> bool {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.entry(nat_port) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if entry.get().len() < MAX_HELD_DATAGRAMS {
                    entry.get_mut().push(datagram.to_vec());
                }
                false
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(vec![datagram.to_vec()]);
                self.waiting.fetch_add(1, Ordering::Relaxed);
                true
            }
        }
    }

    /// Takes whatever is queued for a flow, or ends the wait if nothing
    /// is.
    ///
    /// `None` means the queue was empty **and the flow has stopped
    /// waiting in the same critical section that observed that**. That
    /// atomicity is the whole point: the receive loop either sees the
    /// flow still waiting and queues behind what is being drained, or
    /// does not see it and finds the upstream socket already installed.
    /// There is no instant at which it can queue into a list nobody will
    /// come back for, and none at which it can send ahead of one.
    fn take(&self, nat_port: u16) -> Option<Vec<Vec<u8>>> {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let queue = held.get_mut(&nat_port)?;
        if queue.is_empty() {
            held.remove(&nat_port);
            self.waiting.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        Some(std::mem::take(queue))
    }

    /// Ends a wait that cannot be satisfied, returning how many
    /// datagrams went with it so the loss can be reported rather than
    /// inferred.
    fn abandon(&self, nat_port: u16) -> usize {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.remove(&nat_port) {
            Some(queue) => {
                self.waiting.fetch_sub(1, Ordering::Relaxed);
                queue.len()
            }
            None => 0,
        }
    }
}

/// Retries a bind for up to [`BIND_RETRY_FOR`].
///
/// **Never call this from the receive loop.** It sleeps, and everything
/// redirected over UDP goes through that one loop -- see
/// [`PendingFlows`]. It is called from the per-flow setup thread, where
/// the only flow it can delay is its own.
fn bind_upstream_retrying(
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
    stop: &AtomicBool,
) -> io::Result<(UdpSocket, Option<Registration>)> {
    let deadline = Instant::now() + BIND_RETRY_FOR;
    loop {
        match bind_upstream(tunnel, own) {
            Ok(socket) => return Ok(socket),
            Err(e) if Instant::now() >= deadline || stop.load(Ordering::SeqCst) => return Err(e),
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
/// A socket pinned exactly as the proxy's are is the honest replacement.
/// A completed TCP handshake through it proves the tunnel exists, has a
/// route to the internet, and that the far end answered -- for the path
/// that actually matters, rather than for the app's own traffic, which
/// deliberately does not use it.
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

/// Deliberately does **not** disable Nagle, unlike every relayed
/// connection. Nagle governs when queued application data is released,
/// and this socket never writes a byte: it completes a handshake and is
/// dropped. Setting the option here would cost a syscall inside the
/// connect ladder -- where `PROBE_TIMEOUT` is deliberately short because
/// a slow answer costs the customer as much as a wrong one -- and change
/// nothing observable.
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

    /// Installs a socket for a flow that does not have one, and hands
    /// back the incumbent if it does.
    ///
    /// Insert-if-absent rather than insert, because two paths now bind:
    /// the receive loop's single inline attempt and the per-flow setup
    /// thread that takes over when that attempt fails. They cannot
    /// overlap for the same flow while it is waiting -- `PendingFlows`
    /// sees to that -- but a plain insert would still be a socket
    /// silently replaced if they ever did, stranding the reader thread
    /// that was carrying that flow's replies home. Returning the
    /// incumbent instead makes the loser drop its socket, which closes
    /// it and retires its registration with it.
    fn insert_if_absent(
        &self,
        nat_port: u16,
        socket: Arc<UdpSocket>,
        registration: Option<Registration>,
    ) -> Option<Arc<UdpSocket>> {
        let mut sockets = self.sockets.lock().unwrap();
        if let Some(existing) = sockets.get(&nat_port) {
            return Some(existing.socket.clone());
        }
        sockets.insert(nat_port, Upstream { socket, _registration: registration });
        None
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
pub fn start(
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stats: Arc<Stats>,
) -> io::Result<Relays> {
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
        let (nat, stop, upstreams, own, stats) =
            (nat.clone(), stop.clone(), upstreams.clone(), own_sockets.clone(), stats.clone());
        std::thread::spawn(move || serve_udp(udp, nat, tunnel, stop, upstreams, own, stats))
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

/// Turns Nagle off on both halves of a relayed connection.
///
/// Every relayed TCP byte crosses two sockets that this process owns,
/// and both had Nagle enabled because that is the Windows default and
/// nothing here ever said otherwise. Two Nagles in series is worse than
/// one: a small write from the app waits at the app-facing socket for
/// the previous segment to be acknowledged, is then handed to the
/// upstream socket, and waits there again. Against a peer using delayed
/// acknowledgement the wait is up to that peer's delayed-ACK timer --
/// 200ms on Windows, 40ms on Linux -- and it lands on exactly the
/// traffic that is all small writes: a game's realm connection, an
/// interactive SSH session, a chat app's keepalives.
///
/// Nagle only ever helps a sender that emits many tiny writes and does
/// not care when they arrive. A relay is not that sender: it never
/// originates anything, it forwards what an application already chose
/// to send, and coalescing here would be second-guessing a decision the
/// application already made.
///
/// Set on both halves, not one. Turning it off only upstream still
/// leaves the app-facing socket holding the replies coming back, which
/// is the same stall in the other direction.
///
/// A failure is logged and not fatal. This is a latency option; refusing
/// to carry the connection because it could not be set would turn a
/// tuning problem into a broken connection, which is a far worse trade.
fn disable_nagle(stream: &TcpStream, side: &str) {
    if let Err(e) = stream.set_nodelay(true) {
        note(&format!("could not disable Nagle on the {side} socket: {e}"));
    }
}

/// Copies in both directions until either side closes.
///
/// Two threads rather than one loop because either direction can block
/// indefinitely, and a TLS handshake talks both ways before either side
/// has finished saying anything.
fn pump(client: TcpStream, upstream: TcpStream) {
    // Here rather than at the accept and the connect because this is the
    // one place both halves of a relayed connection are in scope
    // together, and because it is the function that does the forwarding
    // -- so a future path that reaches the copy loop some other way
    // cannot arrive with Nagle still on.
    disable_nagle(&client, "app-facing");
    disable_nagle(&upstream, "upstream");

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

#[allow(clippy::too_many_arguments)]
fn serve_udp(
    local: UdpSocket,
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stop: Arc<AtomicBool>,
    upstreams: Arc<UdpUpstreams>,
    own: Arc<OwnSockets>,
    stats: Arc<Stats>,
) {
    let local = Arc::new(local);
    let pending = Arc::new(PendingFlows::default());
    let mut buffer = vec![0u8; 65_535];

    while !stop.load(Ordering::SeqCst) {
        let Ok((len, from)) = local.recv_from(&mut buffer) else {
            continue; // read timeout, or a transient error worth retrying
        };
        let SocketAddr::V4(from) = from else { continue };
        let nat_port = from.port();

        let Some(origin) = nat.origin(Transport::Udp, nat_port) else { continue };

        // Asked before the upstream table and before any bind, so a
        // datagram cannot overtake earlier ones still held for a flow
        // whose socket is only now being bound. Gated on a relaxed load
        // so an established flow -- which is almost every datagram --
        // does not pay for a lock.
        if pending.any() {
            match pending.hold(nat_port, &buffer[..len]) {
                Hold::Held => continue,
                Hold::Overflowed => {
                    stats.udp_unbound.fetch_add(1, Ordering::Relaxed);
                    static OVERFLOWED: Throttle = Throttle::new();
                    if OVERFLOWED.ready() {
                        stats_note(&format!(
                            "udp flow {nat_port} held {MAX_HELD_DATAGRAMS} datagrams waiting for \
                             its upstream socket; further ones are being dropped"
                        ));
                    }
                    continue;
                }
                Hold::NotWaiting => {}
            }
        }

        let upstream = match upstreams.get(nat_port) {
            Some(socket) => socket,
            None => {
                // One attempt, on this thread. `bind_upstream` is four
                // non-blocking local calls -- socket, setsockopt, bind,
                // setsockopt -- so the case that always used to succeed
                // still costs microseconds and still happens here.
                match bind_upstream(&tunnel, &own) {
                    Ok((socket, registration)) => install_upstream(
                        nat_port,
                        socket,
                        registration,
                        &upstreams,
                        &local,
                        &nat,
                        &stop,
                        origin.client,
                        &stats,
                    ),
                    Err(_) => {
                        // Retried rather than dropped, and this is the
                        // whole "the browser takes ten to twenty
                        // seconds" bug.
                        //
                        // A tunnel address is tentative for a moment
                        // after the adapter comes up, while Windows
                        // finishes duplicate address detection, and a
                        // socket cannot be bound to it until that
                        // completes. This used to `continue`, so every
                        // datagram in that window vanished with no log
                        // and no retry. DNS is the first thing anything
                        // does, so the resolver exhausted its retry
                        // budget and the lookup failed outright --
                        // while TCP, which retransmits its own SYN for
                        // far longer, sailed through and made the whole
                        // thing look like a DNS-specific fault.
                        //
                        // Measured: nothing on the wire for the first
                        // fourteen seconds, then every lookup fine.
                        //
                        // The retry itself now runs on a thread of this
                        // flow's own. Held here, it froze every other
                        // UDP flow on the machine for the six seconds it
                        // waited -- and the condition that triggers it
                        // is a connect or a failover, so the freeze
                        // arrived precisely when the customer was
                        // already looking at it.
                        if pending.begin(nat_port, &buffer[..len]) {
                            let (tunnel, own, upstreams, local, nat, stop, pending, stats) = (
                                tunnel.clone(),
                                own.clone(),
                                upstreams.clone(),
                                local.clone(),
                                nat.clone(),
                                stop.clone(),
                                pending.clone(),
                                stats.clone(),
                            );
                            std::thread::spawn(move || {
                                bind_pending(
                                    nat_port, tunnel, own, upstreams, local, nat, stop, pending,
                                    stats,
                                )
                            });
                        }
                        continue;
                    }
                }
            }
        };

        let target = origin.upstream.unwrap_or_else(|| SocketAddrV4::new(origin.addr, origin.port));
        send_upstream(&upstream, &buffer[..len], target, &stats);
    }
}

/// Hands one datagram on towards its destination, saying so when it
/// cannot.
///
/// The result of this send used to be discarded outright, which made it
/// a silent loss point on the exact path voice and gaming depend on --
/// and an invisible one from every angle, because the redirect loop
/// counted the datagram `redirected` the moment it handed it over. The
/// only trace was `returned` staying at zero, and that reads identically
/// to a tunnel which is not carrying traffic: a different fault with a
/// different fix, and the one the counters would have sent somebody to
/// investigate.
///
/// The behaviour on failure is deliberately unchanged -- the datagram is
/// dropped and the next one is served. UDP has no retransmission of its
/// own to hook into, the application above has whatever it needs, and
/// retrying here would hand the destination a duplicate of something the
/// application may already have resent. What was missing was not a
/// remedy but a record.
fn send_upstream(upstream: &UdpSocket, datagram: &[u8], target: SocketAddrV4, stats: &Stats) {
    if let Err(e) = upstream.send_to(datagram, target) {
        stats.udp_send_failed.fetch_add(1, Ordering::Relaxed);
        static FAILED: Throttle = Throttle::new();
        if FAILED.ready() {
            stats_note(&format!("relay could not send a datagram to {target}: {e}"));
        }
    }
}

/// Puts a freshly bound socket into service for a flow, with the thread
/// that carries its replies home.
///
/// Returns the socket that is actually serving the flow, which is not
/// necessarily the one passed in -- see
/// [`UdpUpstreams::insert_if_absent`].
#[allow(clippy::too_many_arguments)]
fn install_upstream(
    nat_port: u16,
    socket: UdpSocket,
    registration: Option<Registration>,
    upstreams: &Arc<UdpUpstreams>,
    local: &Arc<UdpSocket>,
    nat: &Arc<Nat>,
    stop: &Arc<AtomicBool>,
    client: Ipv4Addr,
    stats: &Arc<Stats>,
) -> Arc<UdpSocket> {
    let socket = Arc::new(socket);
    match upstreams.insert_if_absent(nat_port, socket.clone(), registration) {
        // Somebody bound one first. Theirs already has a reader thread;
        // ours is dropped here, which closes it and retires its
        // registration in one step.
        Some(existing) => existing,
        None => {
            let (reader, back, nat, stop, stats) =
                (socket.clone(), local.clone(), nat.clone(), stop.clone(), stats.clone());
            std::thread::spawn(move || {
                read_udp_replies(reader, back, nat, stop, nat_port, client, stats)
            });
            socket
        }
    }
}

/// Waits out duplicate address detection for one flow, then sends what
/// was held for it, in order.
///
/// A thread per waiting flow rather than one shared setup thread. A
/// shared one would rebuild the same head-of-line blocking a level down:
/// two flows stuck at once and the second waits twelve seconds. These
/// threads exist for at most [`BIND_RETRY_FOR`], and only ever while a
/// tunnel address is tentative, which is the seconds after a connect.
#[allow(clippy::too_many_arguments)]
fn bind_pending(
    nat_port: u16,
    tunnel: Arc<TunnelInterface>,
    own: Arc<OwnSockets>,
    upstreams: Arc<UdpUpstreams>,
    local: Arc<UdpSocket>,
    nat: Arc<Nat>,
    stop: Arc<AtomicBool>,
    pending: Arc<PendingFlows>,
    stats: Arc<Stats>,
) {
    let (socket, registration) = match bind_upstream_retrying(&tunnel, &own, &stop) {
        Ok(bound) => bound,
        Err(e) => {
            // Said out loud, with the cost. The old code logged the
            // failure of a single datagram; this one has to say how many
            // went with it, or the log understates the loss by however
            // many arrived during the wait.
            let dropped = pending.abandon(nat_port);
            stats.udp_unbound.fetch_add(dropped as u64, Ordering::Relaxed);
            stats_note(&format!(
                "upstream bind failed for udp flow {nat_port} after {BIND_RETRY_FOR:?}: {e} \
                 ({dropped} datagram(s) held for it were dropped)"
            ));
            return;
        }
    };

    // Re-read rather than captured before the wait: six seconds is long
    // enough for the flow to have been retired underneath us, and
    // installing a reader thread for a flow that no longer exists would
    // leave it spinning until the expiry sweep noticed.
    let Some(origin) = nat.origin(Transport::Udp, nat_port) else {
        drop((socket, registration));
        let dropped = pending.abandon(nat_port);
        stats.udp_unbound.fetch_add(dropped as u64, Ordering::Relaxed);
        stats_note(&format!(
            "udp flow {nat_port} was retired while its upstream socket was being bound \
             ({dropped} datagram(s) dropped)"
        ));
        return;
    };
    let upstream = install_upstream(
        nat_port, socket, registration, &upstreams, &local, &nat, &stop, origin.client, &stats,
    );

    // Drained in a loop, not once: datagrams keep arriving while this
    // runs, and the flow does not stop waiting until a take finds
    // nothing left. That is what keeps them in order -- the receive loop
    // is still queueing behind us for as long as there is anything here.
    while let Some(batch) = pending.take(nat_port) {
        // Retired mid-drain. Abandoned rather than broken out of: an
        // entry left behind is a flow that stays "waiting" forever, and
        // the receive loop would hold every future datagram for it
        // against a drain that is never coming back.
        let Some(origin) = nat.origin(Transport::Udp, nat_port) else {
            let dropped = pending.abandon(nat_port) + batch.len();
            stats.udp_unbound.fetch_add(dropped as u64, Ordering::Relaxed);
            stats_note(&format!(
                "udp flow {nat_port} was retired while its held datagrams were being sent \
                 ({dropped} dropped)"
            ));
            return;
        };
        let target = origin.upstream.unwrap_or_else(|| SocketAddrV4::new(origin.addr, origin.port));
        for datagram in batch {
            send_upstream(&upstream, &datagram, target, &stats);
        }
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
#[allow(clippy::too_many_arguments)]
fn read_udp_replies(
    upstream: Arc<UdpSocket>,
    local: Arc<UdpSocket>,
    nat: Arc<Nat>,
    stop: Arc<AtomicBool>,
    nat_port: u16,
    client: Ipv4Addr,
    stats: Arc<Stats>,
) {
    let mut buffer = vec![0u8; 65_535];
    loop {
        if stop.load(Ordering::SeqCst) || nat.origin(Transport::Udp, nat_port).is_none() {
            return;
        }
        let Ok((len, _)) = upstream.recv_from(&mut buffer) else { continue };
        // The mirror of `send_upstream`, and silent until now for the
        // same reason. A reply that reaches the relay and does not reach
        // the application is still counted `returned` by the redirect
        // loop, because the loop only ever sees the packet carrying it
        // home -- so this loss looked, from the counters, exactly like
        // no loss at all.
        let back = SocketAddrV4::new(client, nat_port);
        if let Err(e) = local.send_to(&buffer[..len], back) {
            stats.udp_reply_failed.fetch_add(1, Ordering::Relaxed);
            static FAILED: Throttle = Throttle::new();
            if FAILED.ready() {
                stats_note(&format!("relay could not return a datagram to {back}: {e}"));
            }
        }
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

    /// A counter table for a relay under test. Production shares one
    /// with the redirect loop; a test that does not read the numbers
    /// only needs somewhere for them to go.
    fn counters() -> Arc<Stats> {
        Arc::new(Stats::default())
    }

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
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()), counters())
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

    /// Opens a real connected TCP pair on loopback and hands back both
    /// ends, so a test can give one end to production code and keep the
    /// other to inspect.
    fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn both_halves_of_a_relayed_connection_have_nagle_disabled() {
        // The sockets are inspected through clones rather than through
        // the originals, because `pump` takes ownership of those. A
        // cloned `TcpStream` is a duplicated handle onto the same
        // socket, so `nodelay()` on the clone reads the option `pump`
        // set on the original -- which is the point: this asserts on the
        // production path, not on a helper called in isolation.
        let (client, client_peer) = connected_pair();
        let (upstream, upstream_peer) = connected_pair();
        let client_view = client.try_clone().unwrap();
        let upstream_view = upstream.try_clone().unwrap();

        // Both start Nagled, which is the Windows default and the state
        // this whole change is about. Asserted rather than assumed, so
        // that a future platform where the default flips cannot turn
        // this test green without the fix.
        assert!(!client_view.nodelay().unwrap(), "the default is Nagle on");
        assert!(!upstream_view.nodelay().unwrap(), "the default is Nagle on");

        let pumping = std::thread::spawn(move || pump(client, upstream));

        // Polled rather than read once: `pump` sets the options on its
        // own thread, so a single read races the spawn. The deadline is
        // what makes the negative case fail -- without the fix the
        // options never become true and this runs out.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if client_view.nodelay().unwrap() && upstream_view.nodelay().unwrap() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(client_view.nodelay().unwrap(), "the app-facing socket is still Nagled");
        assert!(upstream_view.nodelay().unwrap(), "the upstream socket is still Nagled");

        // Closing both peers ends both copies, so `pump` returns and the
        // test does not leak a thread.
        drop(client_peer);
        drop(upstream_peer);
        pumping.join().unwrap();
    }

    /// An address on the machine that no interface owns, so binding to
    /// it fails at once and deterministically.
    ///
    /// This stands in for a tunnel address that is still tentative under
    /// duplicate address detection -- the real reason a bind fails here.
    /// The failure mode is the same one production sees
    /// (WSAEADDRNOTAVAIL from the bind inside `attach_to_tunnel`), and
    /// unlike a real adapter it does not need a driver, a tunnel or
    /// administrator rights to reproduce. 203.0.113.0/24 is the
    /// documentation range, so it is nothing a developer machine can
    /// legitimately hold.
    const UNBINDABLE: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 9);

    /// A UDP echo server on loopback, and the address to reach it at.
    fn udp_echo() -> SocketAddrV4 {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = socket.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 2048];
            while let Ok((len, from)) = socket.recv_from(&mut buffer) {
                let _ = socket.send_to(&buffer[..len], from);
            }
        });
        match addr {
            SocketAddr::V4(v4) => v4,
            SocketAddr::V6(_) => unreachable!("bound to an IPv4 loopback address"),
        }
    }

    /// Records a UDP flow to `target` and returns a socket standing in
    /// for the application, bound to the synthetic port the redirect
    /// loop would have rewritten its packets to carry.
    fn udp_flow(nat: &Nat, target: SocketAddrV4) -> (u16, UdpSocket) {
        let nat_port = nat
            .redirect(
                Transport::Udp,
                Origin {
                    addr: *target.ip(),
                    port: target.port(),
                    client: Ipv4Addr::LOCALHOST,
                    client_port: 40000,
                    interface_id: 1,
                    upstream: None,
                },
            )
            .unwrap();
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        socket.set_reuse_address(true).unwrap();
        socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, nat_port)).into()).unwrap();
        let socket: UdpSocket = socket.into();
        socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        (nat_port, socket)
    }

    #[test]
    fn one_flow_that_cannot_bind_does_not_freeze_the_others() {
        // The defect, stated as a measurement. `serve_udp` is a single
        // receive loop serving every redirected UDP flow on the machine,
        // and it used to sit inside `bind_upstream_retrying` -- six
        // seconds of sleeping -- whenever one new flow could not bind.
        // Every other flow stopped for that long. The condition that
        // makes a bind fail is a tentative tunnel address, which is to
        // say a connect or a failover, so the freeze arrived exactly
        // when the customer was watching.
        let echo = udp_echo();
        let nat = Arc::new(Nat::new());
        let tunnel = Arc::new(TunnelInterface::default());
        let relays = start(nat.clone(), tunnel.clone(), counters()).expect("relays should bind");
        let relay = SocketAddrV4::new(Ipv4Addr::LOCALHOST, relays.udp_port);

        // An established flow, bound while there is no tunnel at all --
        // the fail-open path, and the only one testable without a node.
        let (_, established) = udp_flow(&nat, echo);
        established.send_to(b"first", relay).unwrap();
        let mut buffer = [0u8; 64];
        let (len, _) = established.recv_from(&mut buffer).expect("the flow is carrying traffic");
        assert_eq!(&buffer[..len], b"first");

        // Now every *new* bind fails, as it does while the tunnel
        // address is tentative. The established flow already has its
        // socket and is unaffected by this.
        tunnel.set(1, UNBINDABLE);

        // A new flow arrives and cannot be bound. This is the datagram
        // that used to take the receive loop out of service.
        let (_, stuck) = udp_flow(&nat, echo);
        stuck.send_to(b"stuck", relay).unwrap();
        // Long enough that the receive loop has certainly picked it up
        // and, in the broken version, has certainly gone to sleep on it.
        std::thread::sleep(Duration::from_millis(200));

        // The measurement. The old code answered this after
        // BIND_RETRY_FOR; the fixed code answers it at loopback speed.
        let sent = Instant::now();
        established.send_to(b"second", relay).unwrap();
        let (len, _) = established.recv_from(&mut buffer).expect("the established flow must answer");
        let waited = sent.elapsed();
        assert_eq!(&buffer[..len], b"second");
        assert!(
            waited < BIND_RETRY_FOR / 3,
            "an unrelated flow's bind held the receive loop for {waited:?}"
        );

        relays.stop();
    }

    #[test]
    fn datagrams_held_during_a_tentative_address_are_all_sent_in_order() {
        // The 0.9.20 guarantee, restated where the waiting now happens.
        // Moving the retry off the receive loop must not turn it back
        // into the `continue` it replaced: a datagram that arrives
        // before its flow can be bound is still not dropped, and the
        // ones behind it must not overtake it either -- a resolver that
        // gets its second query answered and not its first is no better
        // off.
        let echo = udp_echo();
        let nat = Arc::new(Nat::new());
        // Tentative from the outset: nothing can bind yet.
        let tunnel = Arc::new(TunnelInterface::new(1, UNBINDABLE));
        let relays = start(nat.clone(), tunnel.clone(), counters()).expect("relays should bind");
        let relay = SocketAddrV4::new(Ipv4Addr::LOCALHOST, relays.udp_port);

        let (_, app) = udp_flow(&nat, echo);
        for datagram in [b"one", b"two", b"six"] {
            app.send_to(datagram, relay).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }

        // Nothing can have been echoed yet: the flow has no socket.
        app.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut buffer = [0u8; 64];
        assert!(app.recv_from(&mut buffer).is_err(), "nothing should be through yet");

        // Duplicate address detection completes. The next retry binds.
        tunnel.clear();

        app.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut received = Vec::new();
        for _ in 0..3 {
            let (len, _) = app.recv_from(&mut buffer).expect("every held datagram must be sent");
            received.push(buffer[..len].to_vec());
        }
        assert_eq!(received, vec![b"one".to_vec(), b"two".to_vec(), b"six".to_vec()]);

        relays.stop();
    }

    #[test]
    fn a_datagram_the_relay_could_not_send_is_counted() {
        // The loss point this used to have no name for. `send_to`'s
        // result was discarded, so a datagram that never left the relay
        // was still counted `redirected` by the loop that handed it
        // over -- and the only trace was `returned` staying at zero,
        // which is what a tunnel carrying nothing looks like too.
        //
        // 0.0.0.0:9 fails with WSAEADDRNOTAVAIL every time, so the
        // failure is the test's premise rather than its hope.
        let unsendable = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 9);
        let nat = Arc::new(Nat::new());
        let stats = counters();
        let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), stats.clone())
            .expect("relays should bind");
        let relay = SocketAddrV4::new(Ipv4Addr::LOCALHOST, relays.udp_port);

        let (_, app) = udp_flow(&nat, unsendable);
        assert_eq!(stats.udp_send_failed.load(Ordering::Relaxed), 0);
        app.send_to(b"nowhere", relay).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while stats.udp_send_failed.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            stats.udp_send_failed.load(Ordering::Relaxed),
            1,
            "a send the OS refused has to be visible somewhere"
        );
        // The relay carries on rather than tearing the flow down, which
        // is the unchanged half of this: UDP has no retransmission to
        // hook into and the application above has its own.
        app.send_to(b"nowhere either", relay).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while stats.udp_send_failed.load(Ordering::Relaxed) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(stats.udp_send_failed.load(Ordering::Relaxed), 2, "the flow still serves");

        relays.stop();
    }

    #[test]
    fn a_flow_that_never_binds_reports_how_much_it_lost() {
        // The other UDP loss point, and the one this change introduced:
        // datagrams held for a flow whose upstream socket could not be
        // bound before the retry ran out. The old code dropped a single
        // datagram per failure and logged that; this holds them, so the
        // count has to travel with the failure or the log understates
        // the loss by however many arrived during the six seconds.
        let echo = udp_echo();
        let nat = Arc::new(Nat::new());
        // Tentative forever: this bind is never going to succeed.
        let tunnel = Arc::new(TunnelInterface::new(1, UNBINDABLE));
        let stats = counters();
        let relays = start(nat.clone(), tunnel, stats.clone()).expect("relays should bind");
        let relay = SocketAddrV4::new(Ipv4Addr::LOCALHOST, relays.udp_port);

        let (_, app) = udp_flow(&nat, echo);
        for datagram in [b"one", b"two"] {
            app.send_to(datagram, relay).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }

        let deadline = Instant::now() + BIND_RETRY_FOR + Duration::from_secs(4);
        while stats.udp_unbound.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            stats.udp_unbound.load(Ordering::Relaxed),
            2,
            "both held datagrams were lost, and both have to be counted"
        );

        relays.stop();
    }

    #[test]
    fn a_waiting_flow_stops_waiting_only_when_its_queue_is_empty() {
        // The handover between the setup thread and the receive loop.
        // `take` returning None has to mean "nothing left *and* no
        // longer waiting", decided in one critical section -- otherwise
        // the receive loop can queue a datagram into a list nobody comes
        // back for, or send one ahead of a list still being drained.
        let pending = PendingFlows::default();
        assert!(!pending.any());

        assert!(pending.begin(7, b"one"), "the first datagram starts the wait");
        assert!(pending.any());
        assert!(!pending.begin(7, b"two"), "a second does not start a second retry");
        assert_eq!(pending.hold(7, b"three"), Hold::Held);
        assert_eq!(pending.hold(8, b"other flow"), Hold::NotWaiting);

        assert_eq!(
            pending.take(7),
            Some(vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]),
            "in arrival order"
        );
        // Still waiting: the drain has not yet found the queue empty, so
        // anything arriving now must queue rather than race ahead.
        assert!(pending.any());
        assert_eq!(pending.hold(7, b"late"), Hold::Held);
        assert_eq!(pending.take(7), Some(vec![b"late".to_vec()]));

        assert_eq!(pending.take(7), None, "empty ends the wait");
        assert!(!pending.any());
        assert_eq!(pending.hold(7, b"after"), Hold::NotWaiting);
    }

    #[test]
    fn a_held_queue_is_bounded_and_keeps_the_oldest() {
        // Unbounded, a flow sending sixty datagrams a second would hold
        // half a megabyte for the six seconds it waits, times every flow
        // that started at the same moment. The oldest are the ones kept:
        // the first datagram of a flow is the query, the handshake, the
        // login -- the one 0.9.20 exists to protect.
        let pending = PendingFlows::default();
        assert!(pending.begin(9, b"first"));
        for _ in 1..MAX_HELD_DATAGRAMS {
            assert_eq!(pending.hold(9, b"filler"), Hold::Held);
        }
        assert_eq!(pending.hold(9, b"too many"), Hold::Overflowed);

        let drained = pending.take(9).expect("the queue is full, not empty");
        assert_eq!(drained.len(), MAX_HELD_DATAGRAMS);
        assert_eq!(drained[0], b"first".to_vec(), "the oldest survived");
    }

    #[test]
    fn abandoning_a_flow_reports_what_went_with_it() {
        // A bind that never succeeds drops whatever was held. The count
        // is what stops the log understating the loss by however many
        // datagrams arrived during the six-second wait.
        let pending = PendingFlows::default();
        assert!(pending.begin(11, b"one"));
        assert_eq!(pending.hold(11, b"two"), Hold::Held);
        assert_eq!(pending.abandon(11), 2);
        assert!(!pending.any());
        assert_eq!(pending.abandon(11), 0, "abandoning twice is not a double count");
    }

    #[test]
    fn a_tcp_connection_with_no_recorded_flow_is_dropped() {
        // Nothing else can be done with it: the rewritten packet no
        // longer says where it was going. Carrying on regardless is how
        // a relay ends up connecting somewhere nobody asked for.
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()), counters())
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
        let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), counters())
            .expect("relays should bind");

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
