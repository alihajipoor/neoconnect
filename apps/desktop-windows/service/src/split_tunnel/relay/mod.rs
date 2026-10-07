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

mod exits;
mod own;
mod socks;

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use super::flows::Nat;
use super::net::pin::{attach_to_tunnel, TunnelInterface};
use super::policy::Transport;
use super::redirect::Stats;

pub use exits::ExitRelays;
pub use own::OwnSockets;
use own::{register, Registration};

/// How long the upstream half of a redirected connection may take.
/// Generous enough for a distant node, short enough that a dead tunnel
/// surfaces as a failed connection rather than a hang.
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// How often a blocked reader wakes to notice it should stop.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// How often idle flows are swept.
const EXPIRY_INTERVAL: Duration = Duration::from_secs(5);

/// A TCP socket placed on the tunnel, or on the normal route if none is
/// up.
///
/// `exit` is the flow's concurrent exit, if it has one. When it does,
/// the socket is not pinned to anything: it is an ordinary loopback
/// connection to the Xray inbound routed to that exit's node, and Xray
/// pins its *own* outbound to the physical link. Nothing else in this
/// function applies to that path, which is why it returns before any of
/// it -- there is no interface to attach to and no registration to
/// make, because the redirect loop's filter ends in `not loopback` and
/// never sees the hop at all.
fn connect_upstream(
    target: SocketAddrV4,
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
    exits: &ExitRelays,
    exit: Option<u8>,
) -> io::Result<(TcpStream, Option<Registration>)> {
    if let Some(port) = exit.and_then(|index| exits.port_at(index)) {
        return match socks::connect(port, target) {
            Ok(stream) => Ok((stream, None)),
            Err(e) => {
                // Logged for the same reason the attach failure below
                // is: a flow that silently never connects is invisible
                // in the counters, because the packets were rewritten
                // and counted as redirected before this ran.
                note(&format!(
                    "exit relay connect FAILED to {target}: {e} (socks inbound on 127.0.0.1:{port})"
                ));
                // Failed, deliberately not fallen back to the tunnel
                // adapter -- and this is the one place in this feature
                // where "keep the game working" is the wrong answer.
                //
                // Everywhere else, fail-open means an application whose
                // exit is unavailable is carried on the session's own,
                // and that is safe because it happens to the **whole
                // selection at once**: the exit is either in
                // `ExitRelays` or it is not, so every binary of every
                // game moves together.
                //
                // A per-connection fallback is not that. It would fire
                // for one connection of one binary while its siblings
                // stayed on the exit -- so `RustClient.exe` reaches the
                // game's servers from Germany while `Rust.exe` reaches
                // them from the customer's own session exit, at the same
                // instant, on one account. That is precisely the
                // two-source-address signature `docs/design/ban-safety.md`
                // mechanism 4 describes and that the group rules in
                // `Selection::with_exits` exist to make unrepresentable.
                // Reintroducing it here, at runtime, below every check
                // that enforces it, would undo all of them.
                //
                // So the connection fails. The application retries, and
                // if the inbound is genuinely gone the engine's teardown
                // clears the whole table, which moves every game back to
                // the session's exit together -- the atomic transition
                // that a per-connection fallback is not.
                Err(e)
            }
        };
    }
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
    exits: &ExitRelays,
    exit: Option<u8>,
) -> io::Result<(UpstreamUdp, Option<Registration>)> {
    let deadline = Instant::now() + BIND_RETRY_FOR;
    loop {
        match bind_upstream(tunnel, own, exits, exit) {
            Ok(socket) => return Ok(socket),
            Err(e) if Instant::now() >= deadline || stop.load(Ordering::SeqCst) => return Err(e),
            Err(_) => std::thread::sleep(BIND_RETRY_EVERY),
        }
    }
}

/// The onward half of a redirected UDP flow.
///
/// Two ways of reaching the same place, behind one pair of methods so
/// the relay loops do not branch per datagram:
///
/// * [`UpstreamUdp::Pinned`] is the original -- a socket attached to the
///   tunnel adapter, which sends and receives ordinary datagrams.
/// * [`UpstreamUdp::Exit`] is a SOCKS5 UDP association with a loopback
///   Xray inbound, which frames each datagram with its destination and
///   strips the frame off the replies.
///
/// The difference is deliberately invisible above this type. Both
/// `send_to` and `recv_from` take and return exactly what the plain
/// socket did, so `send_upstream` and the return-leg thread are
/// unchanged by concurrent exits -- and the rewriting they do, which is
/// the part a mistake would corrupt, is not touched at all.
enum UpstreamUdp {
    Pinned(UdpSocket),
    Exit(socks::UdpAssociation),
}

impl UpstreamUdp {
    fn send_to(&self, datagram: &[u8], target: SocketAddrV4) -> io::Result<usize> {
        match self {
            UpstreamUdp::Pinned(socket) => socket.send_to(datagram, target),
            UpstreamUdp::Exit(association) => association.send_to(datagram, target),
        }
    }

    fn recv_from(&self, buffer: &mut [u8]) -> io::Result<(usize, SocketAddrV4)> {
        match self {
            UpstreamUdp::Pinned(socket) => match socket.recv_from(buffer)? {
                (len, SocketAddr::V4(from)) => Ok((len, from)),
                // The socket is bound to an IPv4 address, so a v6 peer
                // cannot reach it. Reported rather than unwrapped
                // because a panic in a relay thread takes the flow with
                // it silently.
                (_, from) => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("an IPv4 socket received from {from}"),
                )),
            },
            UpstreamUdp::Exit(association) => association.recv_from(buffer),
        }
    }
}

fn bind_upstream(
    tunnel: &TunnelInterface,
    own: &Arc<OwnSockets>,
    exits: &ExitRelays,
    exit: Option<u8>,
) -> io::Result<(UpstreamUdp, Option<Registration>)> {
    // The exit path first and returning early, for the reason
    // `connect_upstream` does: none of what follows applies to it.
    // There is no interface to attach to -- the association's socket
    // talks to loopback -- and no registration to make, because the
    // redirect loop's filter ends in `not loopback` and never hands
    // over a packet from it.
    if let Some(port) = exit.and_then(|index| exits.port_at(index)) {
        let association = socks::UdpAssociation::open(port).inspect_err(|e| {
            note(&format!("exit relay associate FAILED: {e} (socks inbound on 127.0.0.1:{port})"));
        })?;
        association.set_read_timeout(Some(POLL_INTERVAL))?;
        // No fallback to the tunnel adapter, for the reason spelled out
        // in `connect_upstream`: a per-flow fallback puts one of a
        // game's binaries on a different address from its siblings,
        // which is the signature this feature exists to avoid.
        return Ok((UpstreamUdp::Exit(association), None));
    }
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
    Ok((UpstreamUdp::Pinned(socket.into()), registration))
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
    carried: Arc<Carried>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Relays {
    /// Signals every relay thread and waits for them.
    ///
    /// The TCP acceptor is woken by connecting to it: `accept` blocks,
    /// and a flag it never gets round to reading is not a stop.
    ///
    /// Carried connections are closed, not waited for. Their copy threads
    /// unblock when their sockets shut and finish on their own; joining
    /// them here would put "wait for something to disappear" on the
    /// disconnect path, which is the one thing it may not do.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.tcp_port));
        // The UDP receive is woken the same way, by being given
        // something to receive. It used to be left to notice the flag on
        // its next read timeout, and that wait was measured at 455 to
        // 465ms on every stop -- half of the 900ms phase one of a
        // disconnect is held to, spent waiting for a socket to time out.
        if let Ok(waker) = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)) {
            let _ = waker.send_to(&[0], (Ipv4Addr::LOCALHOST, self.udp_port));
        }
        self.carried.close_all();
        self.upstreams.close_all();
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

/// The TCP connections the relay is carrying, so a stop can close them.
///
/// Before this, nothing owned them. Each ran on a detached thread whose
/// copy loop had no timeout and never read the stop flag, so a
/// connection outlived its relay for as long as its far end stayed
/// quiet -- teardown depended on the other side breaking rather than on
/// this side closing anything.
///
/// Holds each half by the *same* handle `pump` copies through -- an
/// `Arc`, never a `try_clone`. A clone is a second handle made by
/// `WSADuplicateSocket`, and on Windows such a handle was measured to
/// lose sight of its connection while the original kept carrying it:
/// with 32 relays stopping at once, 8 to 20 of the stops shut a clone
/// that answered `NotConnected` and left the live connection to its far
/// end untouched -- the exact failure this type exists to remove, back
/// again at random. One handle has nothing to disagree with.
#[derive(Default)]
struct Carried {
    inner: Mutex<CarriedInner>,
}

#[derive(Default)]
struct CarriedInner {
    /// Set once by `close_all` and never cleared: the relays it belongs
    /// to are finished.
    closed: bool,
    next: u64,
    live: HashMap<u64, [Arc<TcpStream>; 2]>,
}

impl Carried {
    /// Never refused over a poisoned lock. The map is only ever inserted
    /// into or removed from whole, so a panic elsewhere cannot leave it
    /// half-written -- and the caller that most needs it is `stop`.
    fn lock(&self) -> std::sync::MutexGuard<'_, CarriedInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records a connection for the life of the returned guard, or
    /// refuses it if the relays have already stopped.
    ///
    /// The check and the insert are one critical section on purpose. A
    /// connection can spend up to `UPSTREAM_CONNECT_TIMEOUT` dialling,
    /// and one that finishes after the stop has swept the map would
    /// otherwise be carried by nobody's leave, for good.
    fn adopt(
        self: &Arc<Self>,
        client: &Arc<TcpStream>,
        upstream: &Arc<TcpStream>,
    ) -> Option<CarriedGuard> {
        let mut inner = self.lock();
        if inner.closed {
            return None;
        }
        let id = inner.next;
        inner.next += 1;
        inner.live.insert(id, [client.clone(), upstream.clone()]);
        Some(CarriedGuard { carried: self.clone(), id })
    }

    fn close_all(&self) {
        let live = {
            let mut inner = self.lock();
            inner.closed = true;
            std::mem::take(&mut inner.live)
        };
        // Outside the lock: a copy thread finishing at the same moment
        // takes it to remove its own entry.
        for halves in live.values() {
            for half in halves {
                let _ = half.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

/// Removes a finished connection from `Carried`, so the map holds only
/// what is live rather than every connection the relay ever carried.
struct CarriedGuard {
    carried: Arc<Carried>,
    id: u64,
}

impl Drop for CarriedGuard {
    fn drop(&mut self) {
        self.carried.lock().live.remove(&self.id);
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
    socket: Arc<UpstreamUdp>,
    _registration: Option<Registration>,
}

impl UdpUpstreams {
    fn get(&self, nat_port: u16) -> Option<Arc<UpstreamUdp>> {
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
        socket: Arc<UpstreamUdp>,
        registration: Option<Registration>,
    ) -> Option<Arc<UpstreamUdp>> {
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
    exits: Arc<ExitRelays>,
) -> io::Result<Relays> {
    let tcp = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    let tcp_port = tcp.local_addr()?.port();

    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    let udp_port = udp.local_addr()?.port();
    udp.set_read_timeout(Some(POLL_INTERVAL))?;

    let stop = Arc::new(AtomicBool::new(false));
    let upstreams = Arc::new(UdpUpstreams::default());
    let own_sockets = Arc::new(OwnSockets::default());
    let carried = Arc::new(Carried::default());
    let mut threads = Vec::new();

    threads.push({
        let (nat, tunnel, stop, own, exits, carried) =
            (nat.clone(), tunnel.clone(), stop.clone(), own_sockets.clone(), exits.clone(), carried.clone());
        std::thread::spawn(move || accept_tcp(tcp, nat, tunnel, stop, own, exits, carried))
    });
    threads.push({
        let (nat, stop, upstreams, own, stats) =
            (nat.clone(), stop.clone(), upstreams.clone(), own_sockets.clone(), stats.clone());
        std::thread::spawn(move || serve_udp(udp, nat, tunnel, stop, upstreams, own, stats, exits))
    });
    threads.push({
        let (stop, upstreams) = (stop.clone(), upstreams.clone());
        std::thread::spawn(move || expire_flows(nat, stop, upstreams))
    });

    Ok(Relays { tcp_port, udp_port, own_sockets, stop, upstreams, carried, threads })
}

#[allow(clippy::too_many_arguments)]
fn accept_tcp(
    listener: TcpListener,
    nat: Arc<Nat>,
    tunnel: Arc<TunnelInterface>,
    stop: Arc<AtomicBool>,
    own: Arc<OwnSockets>,
    exits: Arc<ExitRelays>,
    carried: Arc<Carried>,
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
        let exits = exits.clone();
        let carried = carried.clone();
        std::thread::spawn(move || {
            let target = origin.upstream.unwrap_or_else(|| SocketAddrV4::new(origin.addr, origin.port));
            // The registration is held for the life of the connection,
            // not just the connect: every packet this socket sends has
            // to be recognised as ours, not only its SYN.
            if let Ok((upstream, _registration)) =
                connect_upstream(target, &tunnel, &own, &exits, origin.exit)
            {
                let (client, upstream) = (Arc::new(client), Arc::new(upstream));
                // Refused when the relays stopped while this was still
                // dialling. Dropping both halves here closes them.
                let Some(_carried) = carried.adopt(&client, &upstream) else { return };
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
///
/// Both threads use the one handle each socket has, shared by `Arc`:
/// std reads and writes through `&TcpStream`, and a socket takes a send
/// and a receive from two threads at once. It used to split each socket
/// with `try_clone`, whose duplicated handles were measured losing sight
/// of their connection on Windows -- see `Carried`.
fn pump(client: Arc<TcpStream>, upstream: Arc<TcpStream>) {
    // Here rather than at the accept and the connect because this is the
    // one place both halves of a relayed connection are in scope
    // together, and because it is the function that does the forwarding
    // -- so a future path that reaches the copy loop some other way
    // cannot arrive with Nagle still on.
    disable_nagle(&client, "app-facing");
    disable_nagle(&upstream, "upstream");

    let outbound = {
        let (client, upstream) = (client.clone(), upstream.clone());
        std::thread::spawn(move || {
            let _ = io::copy(&mut &*client, &mut &*upstream);
            // Half-close rather than drop: the far end may still have a
            // reply in flight, and tearing the whole socket down here
            // would truncate it.
            let _ = upstream.shutdown(std::net::Shutdown::Write);
        })
    };
    let _ = io::copy(&mut &*upstream, &mut &*client);
    let _ = client.shutdown(std::net::Shutdown::Write);
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
    exits: Arc<ExitRelays>,
) {
    let local = Arc::new(local);
    let pending = Arc::new(PendingFlows::default());
    let mut buffer = vec![0u8; 65_535];

    while !stop.load(Ordering::SeqCst) {
        let Ok((len, from)) = local.recv_from(&mut buffer) else {
            continue; // read timeout, or a transient error worth retrying
        };
        // Before the datagram is looked at, not only at the top of the
        // loop: `Relays::stop` wakes this receive by sending one, and a
        // wake-up must never be read as a flow's traffic -- whatever
        // port it happened to leave from. The flag is set before the
        // wake is sent, so this sees it.
        if stop.load(Ordering::SeqCst) {
            return;
        }
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
                match bind_upstream(&tunnel, &own, &exits, origin.exit) {
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
                            let (tunnel, own, upstreams, local, nat, stop, pending, stats, exits) = (
                                tunnel.clone(),
                                own.clone(),
                                upstreams.clone(),
                                local.clone(),
                                nat.clone(),
                                stop.clone(),
                                pending.clone(),
                                stats.clone(),
                                exits.clone(),
                            );
                            std::thread::spawn(move || {
                                bind_pending(
                                    nat_port, tunnel, own, upstreams, local, nat, stop, pending,
                                    stats, exits,
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
fn send_upstream(upstream: &UpstreamUdp, datagram: &[u8], target: SocketAddrV4, stats: &Stats) {
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
    socket: UpstreamUdp,
    registration: Option<Registration>,
    upstreams: &Arc<UdpUpstreams>,
    local: &Arc<UdpSocket>,
    nat: &Arc<Nat>,
    stop: &Arc<AtomicBool>,
    client: Ipv4Addr,
    stats: &Arc<Stats>,
) -> Arc<UpstreamUdp> {
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
    exits: Arc<ExitRelays>,
) {
    // Read before the wait, unlike `origin` below, because it decides
    // *what kind* of upstream to open rather than what to do with one.
    // A flow retired underneath us is handled after the bind, where it
    // always was.
    let exit = nat.origin(Transport::Udp, nat_port).and_then(|origin| origin.exit);
    let (socket, registration) = match bind_upstream_retrying(&tunnel, &own, &stop, &exits, exit) {
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
    upstream: Arc<UpstreamUdp>,
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
    fn relays_bind_distinct_ephemeral_ports() {
        // The redirect filter is built from these, so they have to be
        // real and they have to differ.
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
            .expect("relays should bind");
        assert!(relays.tcp_port > 0);
        assert!(relays.udp_port > 0);
        assert_ne!(relays.tcp_port, relays.udp_port);
        relays.stop();
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
        // The sockets are inspected through a second `Arc` on the same
        // handle `pump` is given, so `nodelay()` here reads the option
        // `pump` set -- which is the point: this asserts on the
        // production path, not on a helper called in isolation.
        let (client, client_peer) = connected_pair();
        let (upstream, upstream_peer) = connected_pair();
        let (client, upstream) = (Arc::new(client), Arc::new(upstream));
        let (client_view, upstream_view) = (client.clone(), upstream.clone());

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
    ///
    /// Bound **exclusively**, and retried with a new flow if that fails.
    /// Every `Nat` starts allocating from the same number, so two of
    /// these tests running at once ask for the same synthetic port --
    /// and with `SO_REUSEADDR` both binds succeed and Windows delivers
    /// each reply to whichever socket it likes. That is a test which
    /// passes or fails on the scheduler, which is worse than one that
    /// does not exist. An exclusive bind makes the collision a failure
    /// the loser can see and step around.
    fn udp_flow(nat: &Nat, target: SocketAddrV4) -> (u16, UdpSocket) {
        for _ in 0..64 {
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
                        exit: None,
                    },
                )
                .unwrap();
            let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
            if socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, nat_port)).into()).is_err() {
                continue;
            }
            let socket: UdpSocket = socket.into();
            socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            return (nat_port, socket);
        }
        panic!("no synthetic port could be bound for a test flow");
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
        let relays = start(nat.clone(), tunnel.clone(), counters(), Arc::new(ExitRelays::default())).expect("relays should bind");
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
        let relays = start(nat.clone(), tunnel.clone(), counters(), Arc::new(ExitRelays::default())).expect("relays should bind");
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
        let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), stats.clone(), Arc::new(ExitRelays::default()))
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
        let relays = start(nat.clone(), tunnel, stats.clone(), Arc::new(ExitRelays::default())).expect("relays should bind");
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
        let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
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
        let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
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
                    exit: None,
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

    /// Connects to the relay from `nat_port`, standing in for the
    /// rewrite the redirect loop would have done.
    fn connect_as_flow(nat: &Nat, relay_port: u16, target_port: u16) -> TcpStream {
        let client = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        client.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into()).unwrap();
        let client_port = client.local_addr().unwrap().as_socket_ipv4().unwrap().port();
        let nat_port = nat
            .redirect(
                Transport::Tcp,
                Origin {
                    addr: Ipv4Addr::LOCALHOST,
                    port: target_port,
                    client: Ipv4Addr::LOCALHOST,
                    client_port,
                    interface_id: 1,
                    upstream: None,
                    exit: None,
                },
            )
            .unwrap();
        drop(client);
        let source = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).unwrap();
        source.set_reuse_address(true).unwrap();
        source.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, nat_port)).into()).unwrap();
        source.connect(&SocketAddr::from((Ipv4Addr::LOCALHOST, relay_port)).into()).unwrap();
        source.into()
    }

    /// True when a read ended because the connection did, and false when
    /// it only gave up waiting. The difference is the whole assertion:
    /// a timeout here means the relay is still holding the connection.
    /// Stopping the relays is part of phase one of a disconnect, which
    /// is held to 900ms. It measured 455 to 465ms on every stop -- the
    /// UDP receive waiting out its read timeout -- then 150ms from the
    /// expiry thread's sleep step; with both fixed it is about 10ms.
    ///
    /// The bound is the median of eight against 200ms: loose enough for
    /// a busy runner, and still failed outright by either of the waits
    /// this replaced.
    #[test]
    fn stopping_the_relays_does_not_wait_out_a_timeout() {
        let mut took: Vec<Duration> = (0..8)
            .map(|_| {
                let relays = start(Arc::new(Nat::new()), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
                    .expect("relays should bind");
                std::thread::sleep(Duration::from_millis(50));
                let began = Instant::now();
                relays.stop();
                began.elapsed()
            })
            .collect();
        took.sort();
        let median = took[took.len() / 2];
        assert!(median < Duration::from_millis(200), "relays.stop took {took:?}");
    }

    fn ended(result: &io::Result<usize>) -> bool {
        match result {
            Ok(n) => *n == 0,
            Err(e) => !matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock),
        }
    }

    /// Stopping the relays closes the connections they are carrying.
    ///
    /// They used to outlive it: each ran on a detached thread with no
    /// timeout and no stop flag, so a connection whose far end stayed
    /// quiet -- a game between rounds, a chat app's idle socket -- went
    /// on holding both sockets after a disconnect, until the far end
    /// happened to break. Teardown was something that happened *to* the
    /// relay rather than something it did.
    #[test]
    fn stopping_the_relays_closes_the_connections_they_carry() {
        use std::io::{Read, Write};

        // An upstream that accepts, says nothing, and never hangs up.
        let quiet = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let quiet_port = quiet.local_addr().unwrap().port();
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = quiet.accept() {
                let _ = accepted_tx.send(stream);
            }
        });

        let nat = Arc::new(Nat::new());
        let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
            .expect("relays should bind");
        let mut app = connect_as_flow(&nat, relays.tcp_port, quiet_port);
        app.write_all(b"hello").unwrap();

        let mut far_end = accepted_rx.recv_timeout(Duration::from_secs(5)).expect("the relay must dial the upstream");
        let mut buffer = [0u8; 5];
        far_end.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        far_end.read_exact(&mut buffer).expect("the relay is carrying the connection");

        relays.stop();

        app.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        far_end.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let app_side = app.read(&mut buffer);
        assert!(ended(&app_side), "the application's side must be closed by the stop: {app_side:?}");
        let upstream_side = far_end.read(&mut buffer);
        assert!(ended(&upstream_side), "the upstream side must be closed by the stop: {upstream_side:?}");
    }

    /// The same stop, with many relays stopping at once.
    ///
    /// This is the test that caught the first version of the fix. With
    /// one relay at a time it passed every run; with 32 at once, 8 to 20
    /// of the stops closed the application's side and left the upstream
    /// open, because the handle being shut was a `try_clone` that had
    /// lost sight of its connection. A single-relay test cannot see that,
    /// so this one exists beside it.
    #[test]
    fn stopping_many_relays_at_once_closes_every_connection() {
        use std::io::{Read, Write};
        const RELAYS: usize = 16;
        let outcomes: Vec<Result<(), String>> = (0..RELAYS)
            .map(|_| {
                std::thread::spawn(|| -> Result<(), String> {
                    let quiet = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
                    let quiet_port = quiet.local_addr().unwrap().port();
                    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
                    std::thread::spawn(move || {
                        if let Ok((stream, _)) = quiet.accept() {
                            let _ = accepted_tx.send(stream);
                        }
                    });
                    let nat = Arc::new(Nat::new());
                    let relays = start(nat.clone(), Arc::new(TunnelInterface::default()), counters(), Arc::new(ExitRelays::default()))
                        .map_err(|e| format!("bind: {e}"))?;
                    let mut app = connect_as_flow(&nat, relays.tcp_port, quiet_port);
                    app.write_all(b"hello").map_err(|e| format!("send: {e}"))?;
                    let mut far_end = accepted_rx.recv_timeout(Duration::from_secs(10)).map_err(|e| format!("no dial: {e}"))?;
                    let mut buffer = [0u8; 5];
                    far_end.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                    far_end.read_exact(&mut buffer).map_err(|e| format!("not carried: {e}"))?;

                    relays.stop();

                    app.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    far_end.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let (app_side, upstream_side) = (app.read(&mut buffer), far_end.read(&mut buffer));
                    if ended(&app_side) && ended(&upstream_side) {
                        Ok(())
                    } else {
                        Err(format!("app {app_side:?}, upstream {upstream_side:?}"))
                    }
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().expect("a relay thread panicked"))
            .collect();
        let failures: Vec<String> = outcomes.into_iter().filter_map(Result::err).collect();
        assert!(failures.is_empty(), "{} of {RELAYS} stops left a connection open: {failures:?}", failures.len());
    }
    /// A connection that finishes dialling after the stop has swept the
    /// table must be refused, or it is carried by nothing that can end
    /// it -- the dial can take up to `UPSTREAM_CONNECT_TIMEOUT`.
    #[test]
    fn a_connection_that_arrives_after_the_stop_is_refused() {
        let (one, two) = connected_pair();
        let carried = Arc::new(Carried::default());
        carried.close_all();
        assert!(carried.adopt(&Arc::new(one), &Arc::new(two)).is_none());
    }

    /// The table holds what is live, not every connection ever carried.
    #[test]
    fn a_finished_connection_leaves_the_table() {
        let (one, two) = connected_pair();
        let carried = Arc::new(Carried::default());
        let (one, two) = (Arc::new(one), Arc::new(two));
        let guard = carried.adopt(&one, &two).expect("a running relay adopts");
        assert_eq!(carried.lock().live.len(), 1);
        drop(guard);
        assert!(carried.lock().live.is_empty());
    }

}
