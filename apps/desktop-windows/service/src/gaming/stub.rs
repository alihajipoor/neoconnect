//! The loopback DNS stub: plain DNS in on 127.0.0.53:53, RFC 8484
//! DoH out, and a hard refusal for anything outside the game's
//! namespaces.
//!
//! # Why a stub at all
//!
//! The NRPT rules could name the node's resolver directly. They must
//! not, for the three reasons design §4.5 gives: the per-customer token
//! lives in a URL path and an NRPT rule has nowhere to put one; plain
//! 53 to a foreign address is the single most tampered-with path in
//! Iran, so the ISP could both read and forge every answer; and DoH is
//! what makes those two problems go away at once. NRPT can only point
//! at an address and a port, so something local has to be that address.
//!
//! # What it does not do
//!
//! It does not parse responses. A DoH reply is DNS wire format already,
//! so the bytes go back to the client exactly as they arrived --
//! which means there is no answer-rewriting code here to get wrong, and
//! no place for the stub to invent a record.
//!
//! # The one rule with no exception
//!
//! **There is no fallback to the ISP resolver. Ever.** If the DoH POST
//! fails -- 443 blocked, TLS intercepted, the node down -- the stub
//! answers SERVFAIL and records why. It does not retry over plain 53,
//! it does not consult the adapter's resolver, and it does not let
//! Windows quietly do either. A fallback would turn a censored, forged
//! answer into one the customer has no way to distinguish from a real
//! one, and telling somebody their game traffic is protected while the
//! censor is answering their lookups is precisely the class of lie this
//! product does not ship (design §4.2.4, §14 instrument #6).

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::dns_message::{self, Question, RCODE_FORMERR, RCODE_REFUSED, RCODE_SERVFAIL};

/// The address NRPT rules point at.
///
/// 127.0.0.53 rather than 127.0.0.1 so the stub cannot collide with
/// whatever a developer happens to be running on localhost, and because
/// systemd-resolved made the address conventional enough that a person
/// reading a packet capture recognises it. The whole 127/8 range is
/// bound to the loopback adapter on Windows by default, so no alias has
/// to be created -- but that is an assumption about the customer's
/// machine, and [`Stub::start`] fails loudly rather than working around
/// it. §14 instrument #11.
pub const STUB_ADDR: Ipv4Addr = Ipv4Addr::new(127, 0, 0, 53);

/// The only port NRPT can be told to use. An NRPT rule names servers,
/// not endpoints: there is no port field, so 53 is not a preference.
/// Falling back to another port would produce rules pointing at a
/// listener that is not there, which is a machine whose game lookups
/// silently fail -- so a bind failure is reported, never worked around.
pub const STUB_PORT: u16 = 53;

/// How long a worker waits on its socket before re-checking the stop
/// flag. Short enough that disarming feels immediate.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// UDP workers. All four recv on clones of one socket, so a query
/// waiting on a slow DoH round trip does not hold up the next three --
/// a launcher opens a burst of lookups at once and serialising them
/// behind one HTTP request would show up as the game being slow to
/// start, which is the one thing this mode exists not to be.
const UDP_WORKERS: usize = 4;

/// Ceiling on concurrent DNS-over-TCP conversations. TCP is the rare
/// path (a truncated UDP answer, or a resolver that prefers it), and an
/// unbounded thread-per-connection accept loop on a LocalSystem service
/// is a way to be made to spawn threads without limit.
const MAX_TCP_CONNECTIONS: usize = 16;

/// Largest DNS message we will read or relay. RFC 1035 caps a TCP
/// message at 65535 and EDNS0 cannot exceed it either.
const MAX_MESSAGE: usize = 65_535;

/// How long the DoH POST may take before it is a failure.
///
/// A resolver that has not answered in this long is not going to be
/// useful to a game launcher anyway, and an unbounded wait would pin a
/// worker thread for as long as a censor cares to hold the socket open.
const DOH_TIMEOUT: Duration = Duration::from_secs(5);

/// What the stub will and will not forward, plus the counters the
/// status surface reports.
///
/// Shared by every worker thread. Read-only after `start`, apart from
/// the counters.
pub struct Policy {
    doh_url: String,
    /// Suffixes, normalised: lowercase, no leading or trailing dot.
    namespaces: Vec<String>,
    excludes: Vec<String>,
    client: reqwest::blocking::Client,
    forwarded: AtomicU64,
    refused: AtomicU64,
    failed: AtomicU64,
    /// The most recent DoH failure, in words. `None` while nothing has
    /// gone wrong. This is what turns a `partial` state into a sentence
    /// a customer can act on.
    last_error: Mutex<Option<String>>,
}

impl Policy {
    fn new(
        doh_url: &str,
        namespaces: &[String],
        excludes: &[String],
    ) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(DOH_TIMEOUT)
            .connect_timeout(DOH_TIMEOUT)
            // No redirects. A redirect on a DoH endpoint is either a
            // misconfiguration or a captive portal, and following one
            // would post the customer's query -- and the token in the
            // path -- somewhere nobody chose.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("could not build the DoH client: {e}"))?;
        Ok(Self {
            doh_url: doh_url.to_string(),
            namespaces: namespaces.iter().map(|n| dns_message::normalise(n)).collect(),
            excludes: excludes.iter().map(|n| dns_message::normalise(n)).collect(),
            client,
            forwarded: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            last_error: Mutex::new(None),
        })
    }

    /// Whether this name is one the game profile asked us to resolve.
    ///
    /// Exclusions win. They exist for the reason design §4.3 names --
    /// patch CDN hosts, which would otherwise pull multi-GB downloads
    /// through the node and eat a metered plan's cap -- and "excluded"
    /// has to beat "inside an allowed suffix" or the exclusion could
    /// never do anything, since a CDN host under `blizzard.com` matches
    /// the namespace by construction.
    pub fn allows(&self, name: &str) -> bool {
        let name = dns_message::normalise(name);
        if self
            .excludes
            .iter()
            .any(|e| dns_message::matches_namespace(&name, e))
        {
            return false;
        }
        self.namespaces
            .iter()
            .any(|n| dns_message::matches_namespace(&name, n))
    }

    /// Counters, for the status surface. (forwarded, refused, failed)
    pub fn counters(&self) -> (u64, u64, u64) {
        (
            self.forwarded.load(Ordering::Relaxed),
            self.refused.load(Ordering::Relaxed),
            self.failed.load(Ordering::Relaxed),
        )
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    /// Posts the query as RFC 8484 and hands back the raw response.
    ///
    /// The body is the query exactly as it arrived and the reply is
    /// returned exactly as it came back: no parsing in either
    /// direction, so there is nothing here that could rewrite an
    /// answer.
    fn forward(&self, query: &[u8]) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .post(&self.doh_url)
            .header("content-type", "application/dns-message")
            .header("accept", "application/dns-message")
            .body(query.to_vec())
            .send()
            .map_err(|e| format!("the DoH request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the resolver answered HTTP {}", status.as_u16()));
        }
        let body = response
            .bytes()
            .map_err(|e| format!("could not read the DoH reply: {e}"))?;
        if body.len() < dns_message::HEADER_LEN || body.len() > MAX_MESSAGE {
            return Err(format!("the resolver returned {} bytes", body.len()));
        }
        Ok(body.to_vec())
    }

    /// One query in, one response out. The whole decision, in one
    /// place, so UDP and TCP cannot drift apart about what is allowed.
    pub fn answer(&self, query: &[u8]) -> Vec<u8> {
        let question: Question = match dns_message::parse_query(query) {
            Ok(q) => q,
            Err(_) => {
                // Never forwarded. A packet we could not read is a
                // packet whose name we cannot check.
                self.refused.fetch_add(1, Ordering::Relaxed);
                return dns_message::error_response(query, None, RCODE_FORMERR);
            }
        };

        if !self.allows(&question.name) {
            // REFUSED, and it does not leave the machine. This is
            // §4.2.6: a resolver that forwards anything it is asked is
            // an open resolver, an amplifier, and a fast way to get the
            // node's address blocklisted -- and the node's address
            // reputation is the product.
            self.refused.fetch_add(1, Ordering::Relaxed);
            return dns_message::error_response(query, Some(&question), RCODE_REFUSED);
        }

        match self.forward(query) {
            Ok(response) => {
                self.forwarded.fetch_add(1, Ordering::Relaxed);
                response
            }
            Err(err) => {
                // SERVFAIL, and nothing else. There is deliberately no
                // second attempt over plain 53 and no consultation of
                // the adapter's resolver: see this module's header. The
                // customer is told, by way of the status surface, that
                // the resolver could not be reached -- which is the
                // truth, and is what §14 instrument #6 exists to prove
                // we say.
                self.failed.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut slot) = self.last_error.lock() {
                    *slot = Some(err);
                }
                dns_message::error_response(query, Some(&question), RCODE_SERVFAIL)
            }
        }
    }
}

/// A running stub: the sockets, the policy, and the threads serving
/// them.
pub struct Stub {
    /// Where it actually bound. In production this is
    /// `127.0.0.53:53`; tests parameterise it so they need no
    /// administrator and no NRPT.
    pub addr: SocketAddr,
    pub policy: Arc<Policy>,
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Stub {
    /// Binds both sockets and starts serving.
    ///
    /// `bind` is a parameter rather than a constant for one reason:
    /// binding port 53 needs the service's privileges and installing
    /// NRPT rules needs more, so a test that could only exercise this
    /// as SYSTEM would not be run -- and the QNAME policing here is the
    /// part that most needs exercising. Pass port 0 to let the OS
    /// choose; the TCP listener then follows the UDP socket's port.
    ///
    /// A bind failure is returned with the address in it and is never
    /// worked around. NRPT rules can only name a server, not a port, so
    /// a stub that quietly moved to another port would leave the rules
    /// pointing at nothing -- lookups for the game's hostnames would
    /// fail with no listener to blame, on a machine whose owner was
    /// told gaming mode was on.
    pub fn start(
        bind: SocketAddr,
        doh_url: &str,
        namespaces: &[String],
        excludes: &[String],
    ) -> Result<Self, String> {
        let policy = Arc::new(Policy::new(doh_url, namespaces, excludes)?);

        let udp = UdpSocket::bind(bind).map_err(|e| bind_failure(bind, "UDP", &e))?;
        let addr = udp
            .local_addr()
            .map_err(|e| format!("the DNS stub could not read back its own address: {e}"))?;
        let tcp = TcpListener::bind(addr).map_err(|e| bind_failure(addr, "TCP", &e))?;

        let stop = Arc::new(AtomicBool::new(false));
        let mut threads = Vec::new();

        for _ in 0..UDP_WORKERS {
            let socket = udp
                .try_clone()
                .map_err(|e| format!("the DNS stub could not clone its UDP socket: {e}"))?;
            socket
                .set_read_timeout(Some(POLL_INTERVAL))
                .map_err(|e| format!("the DNS stub could not set a read timeout: {e}"))?;
            let (policy, stop) = (Arc::clone(&policy), Arc::clone(&stop));
            threads.push(std::thread::spawn(move || serve_udp(socket, policy, stop)));
        }

        {
            let (policy, stop) = (Arc::clone(&policy), Arc::clone(&stop));
            threads.push(std::thread::spawn(move || serve_tcp(tcp, policy, stop)));
        }

        Ok(Self {
            addr,
            policy,
            stop,
            threads,
        })
    }

    /// Signals every worker and waits for it.
    ///
    /// The waits are the point. Disarming removes the NRPT rules and
    /// then stops the stub, and returning before the sockets are
    /// actually closed would let a re-arm a moment later fail to bind
    /// its own port -- which, on the one port NRPT can use, is not
    /// recoverable by choosing another.
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // The UDP workers wake on their own read timeout. The TCP
        // acceptor blocks in `accept`, which no flag reaches, so it is
        // woken by connecting to it -- the `split_tunnel::proxy`
        // precedent.
        let _ = TcpStream::connect(self.addr);
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

fn bind_failure(addr: SocketAddr, transport: &str, err: &std::io::Error) -> String {
    format!(
        "Gaming mode could not start: the DNS stub could not listen on {addr} ({transport}) -- {err}. \
         Something else on this machine is using port {port}, or {ip} is not available on the loopback adapter. \
         Gaming mode cannot use another port, because a Windows DNS policy rule can only name a server, not a port.",
        port = addr.port(),
        ip = addr.ip(),
    )
}

fn serve_udp(socket: UdpSocket, policy: Arc<Policy>, stop: Arc<AtomicBool>) {
    let mut buffer = vec![0u8; MAX_MESSAGE];
    while !stop.load(Ordering::SeqCst) {
        let (len, from) = match socket.recv_from(&mut buffer) {
            Ok(v) => v,
            // A read timeout is the normal way round this loop.
            Err(_) => continue,
        };
        let response = policy.answer(&buffer[..len]);
        // UDP answers are capped at 512 bytes unless the client
        // advertised EDNS0. Rather than parse the query's OPT record to
        // find out, an over-long answer is returned truncated with TC
        // set, which is exactly what a resolver is required to handle:
        // it retries over TCP, and the TCP path has no such limit.
        let response = truncate_for_udp(response);
        let _ = socket.send_to(&response, from);
    }
}

/// Caps a UDP answer at the 512 bytes RFC 1035 guarantees, setting TC
/// so the client knows to ask again over TCP.
///
/// Conservative on purpose. Answering with more than the client is
/// prepared to receive produces a reply that is silently dropped by
/// something in the middle, which presents as a lookup that times out
/// -- indistinguishable, from the game's side, from the resolver being
/// unreachable.
fn truncate_for_udp(mut response: Vec<u8>) -> Vec<u8> {
    const UDP_FLOOR: usize = 512;
    if response.len() <= UDP_FLOOR || response.len() < dns_message::HEADER_LEN {
        return response;
    }
    // Header only, with TC set and every count zeroed: a partial
    // record would be worse than none.
    response.truncate(dns_message::HEADER_LEN);
    response[2] |= 0x02; // TC
    response[6..12].fill(0);
    response
}

fn serve_tcp(listener: TcpListener, policy: Arc<Policy>, stop: Arc<AtomicBool>) {
    let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for incoming in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(stream) = incoming else { continue };
        if live.load(Ordering::SeqCst) >= MAX_TCP_CONNECTIONS {
            // Dropped rather than queued. A refusal a client can retry
            // is better than a thread we promised to create.
            continue;
        }
        live.fetch_add(1, Ordering::SeqCst);
        let (policy, live) = (Arc::clone(&policy), Arc::clone(&live));
        std::thread::spawn(move || {
            serve_tcp_connection(stream, &policy);
            live.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

/// One DNS-over-TCP conversation: a two-byte length prefix, then that
/// many bytes, repeated for as long as the client keeps asking.
fn serve_tcp_connection(mut stream: TcpStream, policy: &Policy) {
    // Bounded so a client that opens a connection and says nothing
    // cannot hold a thread indefinitely.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    loop {
        let mut length = [0u8; 2];
        if stream.read_exact(&mut length).is_err() {
            return;
        }
        let len = u16::from_be_bytes(length) as usize;
        if len == 0 || len > MAX_MESSAGE {
            return;
        }
        let mut query = vec![0u8; len];
        if stream.read_exact(&mut query).is_err() {
            return;
        }
        let response = policy.answer(&query);
        // Not truncated: TCP is where an over-long answer belongs.
        let framed = u16::try_from(response.len()).unwrap_or(u16::MAX);
        if stream.write_all(&framed.to_be_bytes()).is_err() {
            return;
        }
        if stream.write_all(&response[..framed as usize]).is_err() {
            return;
        }
        let _ = stream.flush();
    }
}

/// Asks the stub itself for `hostname` and returns the A records it
/// answered with.
///
/// Used by the integration test rather than by the canary check --
/// [`super::canary`] deliberately resolves through Windows instead, for
/// the reason stated there. This is the version that can run without
/// NRPT and therefore without administrator.
#[cfg(test)]
pub fn query_stub_for_a_records(
    stub: SocketAddr,
    hostname: &str,
    timeout: Duration,
) -> Result<(u8, Vec<Ipv4Addr>), String> {
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("could not open a socket to ask the stub: {e}"))?;
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|e| format!("could not set a timeout: {e}"))?;

    let id: u16 = 0x4E58; // "NX"
    let mut query = Vec::new();
    query.extend_from_slice(&id.to_be_bytes());
    query.extend_from_slice(&[0x01, 0x00]); // standard query, RD
    query.extend_from_slice(&1u16.to_be_bytes());
    query.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    for label in hostname.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("{hostname:?} is not a resolvable name"));
        }
        query.push(label.len() as u8);
        query.extend_from_slice(label.as_bytes());
    }
    query.push(0);
    query.extend_from_slice(&1u16.to_be_bytes()); // A
    query.extend_from_slice(&1u16.to_be_bytes()); // IN

    socket
        .send_to(&query, stub)
        .map_err(|e| format!("could not send to the stub: {e}"))?;
    let mut buffer = vec![0u8; MAX_MESSAGE];
    let len = socket
        .recv(&mut buffer)
        .map_err(|e| format!("the stub did not answer: {e}"))?;
    let packet = &buffer[..len];
    if packet.len() < dns_message::HEADER_LEN {
        return Err("the stub answered with a runt packet".into());
    }
    if u16::from_be_bytes([packet[0], packet[1]]) != id {
        return Err("the stub answered a different query".into());
    }
    let rcode = packet[3] & 0x0F;
    Ok((rcode, extract_a_records(packet)))
}

/// Pulls the A records out of a response.
///
/// The one place anything here reads an answer section, and it exists
/// only for the checks -- the relay path never does. Deliberately
/// forgiving: it walks records and takes the IPv4 ones, and a record it
/// cannot follow ends the walk rather than failing the whole read.
///
/// A records only, on purpose. The nodes have IPv6 and a v6 answer in
/// an assertion shaped like this one has previously produced a
/// convincing false negative.
#[cfg(test)]
pub fn extract_a_records(packet: &[u8]) -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    if packet.len() < dns_message::HEADER_LEN {
        return found;
    }
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]);
    let ancount = u16::from_be_bytes([packet[6], packet[7]]);
    let mut offset = dns_message::HEADER_LEN;

    for _ in 0..qdcount {
        let Some(next) = skip_name(packet, offset) else {
            return found;
        };
        offset = next + 4;
    }
    for _ in 0..ancount {
        let Some(next) = skip_name(packet, offset) else {
            return found;
        };
        offset = next;
        if packet.len() < offset + 10 {
            return found;
        }
        let rtype = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
        let rdlength = u16::from_be_bytes([packet[offset + 8], packet[offset + 9]]) as usize;
        offset += 10;
        if packet.len() < offset + rdlength {
            return found;
        }
        if rtype == 1 && rdlength == 4 {
            found.push(Ipv4Addr::new(
                packet[offset],
                packet[offset + 1],
                packet[offset + 2],
                packet[offset + 3],
            ));
        }
        offset += rdlength;
    }
    found
}

/// Steps over a name in a *response*, where compression pointers are
/// legal and routine. Returns the offset just past it.
#[cfg(test)]
fn skip_name(packet: &[u8], mut offset: usize) -> Option<usize> {
    loop {
        let len = *packet.get(offset)?;
        if len & 0xC0 == 0xC0 {
            // A pointer is two bytes and ends the name; it is not
            // followed, because nothing here needs the name itself.
            return Some(offset + 2);
        }
        if len & 0xC0 != 0 {
            return None;
        }
        offset += 1;
        if len == 0 {
            return Some(offset);
        }
        offset = offset.checked_add(len as usize)?;
        if offset > packet.len() {
            return None;
        }
    }
}

/// Whether a TCP connection to the proxy completes. Check 3 of §8.3.
///
/// A connect and nothing more: it proves the address answers on that
/// port, which is the strongest claim a client can make about a proxy
/// it has not been asked to send anything through yet. Forced to IPv4,
/// like everything else here.
pub fn proxy_reachable(ip: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let addr: Ipv4Addr = ip
        .parse()
        .map_err(|_| format!("{ip} is not an IPv4 address"))?;
    TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(addr), port), timeout)
        .map(|_| ())
        .map_err(|e| format!("could not reach {addr}:{port} -- {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `203.0.113.10` below -- and the `[203, 0, 113, 10]` byte array it
    // is assembled from -- is an RFC 5737 stand-in. A real node's exit
    // address was here until 2026-08-26, written as separate octets
    // inside a synthetic DNS answer, which is a form no dotted-quad grep
    // finds. Redacted per docs/node-address-hygiene.md; this repository
    // is public.

    fn policy(namespaces: &[&str], excludes: &[&str]) -> Policy {
        Policy::new(
            "https://example.invalid/dns-query",
            &namespaces.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &excludes.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .expect("a policy with no network involved must build")
    }

    #[test]
    fn allows_a_namespace_and_its_subdomains() {
        let p = policy(&["blizzard.com", ".battle.net"], &[]);
        assert!(p.allows("blizzard.com"));
        assert!(p.allows("us.actual.battle.net"));
        assert!(p.allows("BATTLE.NET"));
        assert!(p.allows("battle.net."));
    }

    #[test]
    fn refuses_everything_else() {
        let p = policy(&["blizzard.com"], &[]);
        assert!(!p.allows("example.com"));
        assert!(!p.allows("evilblizzard.com"));
        assert!(!p.allows(""));
    }

    /// Exclusions have to beat the allowlist or they can never do
    /// anything: a patch CDN host under `blizzard.com` matches the
    /// namespace by construction, and that is exactly the host design
    /// §4.3 excludes so a multi-GB download does not eat a metered
    /// plan's cap through the node.
    #[test]
    fn an_exclusion_beats_the_namespace_that_contains_it() {
        let p = policy(&["blizzard.com"], &["dist.blizzard.com"]);
        assert!(p.allows("eu.blizzard.com"));
        assert!(!p.allows("dist.blizzard.com"));
        assert!(!p.allows("level3.dist.blizzard.com"), "subdomains of an exclusion too");
    }

    /// A refusal must be produced without any network call at all --
    /// the counter is the only observable proof, since a forward would
    /// have had to reach `example.invalid`.
    #[test]
    fn a_refused_name_is_never_forwarded() {
        let p = policy(&["blizzard.com"], &[]);
        let query = super::super::dns_message::tests_support::query(7, "example.com", 1);
        let response = p.answer(&query);
        assert_eq!(response[3] & 0x0F, RCODE_REFUSED);
        assert_eq!(&response[0..2], &[0, 7], "the id must be echoed");
        let (forwarded, refused, failed) = p.counters();
        assert_eq!((forwarded, refused, failed), (0, 1, 0));
    }

    #[test]
    fn an_unparseable_query_is_refused_rather_than_forwarded() {
        let p = policy(&["blizzard.com"], &[]);
        let response = p.answer(&[0xAA, 0xBB, 0x01, 0x00]);
        assert_eq!(response[3] & 0x0F, RCODE_FORMERR);
        assert_eq!(p.counters(), (0, 1, 0));
    }

    /// The whole of §4.2.4 in one assertion: a DoH endpoint that cannot
    /// be reached produces SERVFAIL, not an answer from anywhere else.
    /// `example.invalid` cannot resolve by definition (RFC 2606), so
    /// this exercises the failure path without depending on a network.
    #[test]
    fn a_doh_failure_is_servfail_and_never_a_fallback() {
        let p = policy(&["blizzard.com"], &[]);
        let query = super::super::dns_message::tests_support::query(9, "eu.blizzard.com", 1);
        let response = p.answer(&query);
        assert_eq!(
            response[3] & 0x0F,
            RCODE_SERVFAIL,
            "a failed DoH request must never become an answer"
        );
        assert_eq!(
            u16::from_be_bytes([response[6], response[7]]),
            0,
            "SERVFAIL must carry no answer records"
        );
        let (forwarded, _, failed) = p.counters();
        assert_eq!(forwarded, 0);
        assert_eq!(failed, 1);
        assert!(p.last_error().is_some(), "the failure has to be recorded");
    }

    #[test]
    fn a_stub_binds_and_stops_on_a_non_privileged_port() {
        let stub = Stub::start(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            "https://example.invalid/dns-query",
            &["blizzard.com".to_string()],
            &[],
        )
        .expect("binding an ephemeral loopback port needs no privileges");
        assert_ne!(stub.addr.port(), 0);
        stub.stop();
    }

    /// End to end over the real UDP socket, with no network beyond
    /// loopback: a name outside the namespaces comes back REFUSED and
    /// nothing was forwarded.
    #[test]
    fn the_running_stub_refuses_a_name_outside_its_namespaces() {
        let stub = Stub::start(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            "https://example.invalid/dns-query",
            &["blizzard.com".to_string()],
            &["dist.blizzard.com".to_string()],
        )
        .expect("should bind");

        for name in ["example.com", "evilblizzard.com", "dist.blizzard.com"] {
            let (rcode, addresses) =
                query_stub_for_a_records(stub.addr, name, Duration::from_secs(5))
                    .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(rcode, RCODE_REFUSED, "{name} was not refused");
            assert!(addresses.is_empty());
        }
        let (forwarded, refused, failed) = stub.policy.counters();
        assert_eq!(
            (forwarded, failed),
            (0, 0),
            "a refused name must produce no outbound request"
        );
        assert_eq!(refused, 3);
        stub.stop();
    }

    #[test]
    fn an_over_long_udp_answer_is_truncated_rather_than_dropped() {
        let mut long = vec![0u8; 900];
        long[6] = 0;
        long[7] = 4;
        let out = truncate_for_udp(long);
        assert_eq!(out.len(), dns_message::HEADER_LEN);
        assert_eq!(out[2] & 0x02, 0x02, "TC must be set");
        assert_eq!(&out[6..12], &[0, 0, 0, 0, 0, 0]);
    }

    /// Reading answers is only used by the checks, but a check that
    /// mis-reads a response is a check that can pass on the wrong
    /// evidence.
    #[test]
    fn reads_the_a_records_out_of_a_compressed_response() {
        // Header, question for "a.example" A IN, then one answer
        // naming the question by pointer -- which is what every real
        // resolver sends.
        let mut packet = vec![
            0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
        ];
        packet.extend_from_slice(&[1, b'a', 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 0]);
        packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
        packet.extend_from_slice(&[0xC0, 0x0C]); // pointer to the question
        packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // A IN
        packet.extend_from_slice(&[0x00, 0x00, 0x00, 0x3C]); // TTL
        packet.extend_from_slice(&[0x00, 0x04]); // RDLENGTH
        packet.extend_from_slice(&[203, 0, 113, 10]);

        assert_eq!(
            extract_a_records(&packet),
            vec![Ipv4Addr::new(203, 0, 113, 10)]
        );
    }

    #[test]
    fn reading_a_truncated_response_yields_nothing_rather_than_panicking() {
        let packet = vec![
            0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x03, b'a',
        ];
        assert!(extract_a_records(&packet).is_empty());
    }
}

/// The stub, stood up for real against a public DoH resolver.
///
/// `#[ignore]` because it needs the internet, and a test that fails on
/// an aeroplane is a test people learn to skip. Run it with:
///
/// ```text
/// cargo test -p neoconnect-service -- --ignored --nocapture serves_a_real_doh_endpoint
/// ```
///
/// Everything about it is deliberately non-privileged: it binds an
/// ephemeral loopback port instead of `127.0.0.53:53` (which needs the
/// service's rights) and installs no NRPT rules at all (which needs
/// more). What it therefore proves is the stub -- QNAME policing, the
/// allowlist, the DoH round trip, the byte-for-byte relay -- and
/// **not** that Windows routes anything to it. That second half is §14
/// instruments #9 and #11 and needs a real machine.
///
/// `cloudflare-dns.com` is read-only and is not our infrastructure; it
/// stands in for the node's per-customer endpoint, which does not exist
/// yet.
#[cfg(test)]
mod live {
    use super::*;

    const PUBLIC_DOH: &str = "https://cloudflare-dns.com/dns-query";

    #[test]
    #[ignore = "needs the internet; run with --ignored"]
    fn serves_a_real_doh_endpoint_and_refuses_everything_else() {
        let stub = Stub::start(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            PUBLIC_DOH,
            &["example.com".to_string()],
            &["excluded.example.com".to_string()],
        )
        .expect("should bind an ephemeral loopback port");
        println!("stub listening on {}", stub.addr);

        // (a) An allowlisted name is forwarded and answered.
        let (rcode, addresses) =
            query_stub_for_a_records(stub.addr, "example.com", Duration::from_secs(10))
                .expect("the stub must answer");
        println!("example.com -> rcode {rcode}, addresses {addresses:?}");
        assert_eq!(rcode, 0, "an allowlisted name must come back NOERROR");
        assert!(
            !addresses.is_empty(),
            "NOERROR with no A record is not an answer"
        );

        // (b) A name outside the namespaces is REFUSED, and -- the part
        // that matters -- never left the machine. The forwarded counter
        // is the proof: it is incremented only on a successful DoH
        // round trip, so it staying put across these three queries is
        // positive evidence that no request was made, not merely the
        // absence of an error.
        let (forwarded_before, _, _) = stub.policy.counters();
        for name in ["example.org", "notexample.com", "excluded.example.com"] {
            let (rcode, addresses) =
                query_stub_for_a_records(stub.addr, name, Duration::from_secs(10))
                    .unwrap_or_else(|e| panic!("{name}: {e}"));
            println!("{name} -> rcode {rcode}, addresses {addresses:?}");
            assert_eq!(rcode, RCODE_REFUSED, "{name} must be REFUSED");
            assert!(addresses.is_empty());
        }
        let (forwarded_after, refused, failed) = stub.policy.counters();
        println!("counters: forwarded={forwarded_after} refused={refused} failed={failed}");
        assert_eq!(
            forwarded_after, forwarded_before,
            "a refused name produced an outbound DoH request"
        );
        assert_eq!(refused, 3);
        assert_eq!(failed, 0);

        stub.stop();
    }

    /// §4.2.4 and §14 instrument #6, against a real client: an endpoint
    /// that cannot be reached produces SERVFAIL and nothing else. The
    /// name is unresolvable by RFC 2606, which is the closest a test can
    /// get to "the ISP blocked 443 to the resolver" without asking
    /// somebody in Iran.
    #[test]
    #[ignore = "needs the internet; run with --ignored"]
    fn an_unreachable_resolver_is_servfail_and_never_a_fallback() {
        let stub = Stub::start(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            "https://this-resolver-does-not-exist.invalid/dns-query",
            &["example.com".to_string()],
            &[],
        )
        .expect("should bind");

        let (rcode, addresses) =
            query_stub_for_a_records(stub.addr, "example.com", Duration::from_secs(15))
                .expect("the stub must answer even when its resolver cannot");
        println!("example.com with a dead resolver -> rcode {rcode}, addresses {addresses:?}");
        assert_eq!(rcode, RCODE_SERVFAIL);
        assert!(
            addresses.is_empty(),
            "an answer here would mean something else resolved it -- the exact lie this mode must not tell"
        );
        assert!(stub.policy.last_error().is_some());
        stub.stop();
    }
}
