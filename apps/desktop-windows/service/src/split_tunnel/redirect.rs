//! The packet loop that puts a selected app's connections on the proxy.
//!
//! # The shape that works, and the two that do not
//!
//! The obvious design -- rewrite the source to the tunnel address and
//! re-inject with `WINDIVERT_ADDRESS.Network.interface_id` set to the
//! tunnel -- fails silently. Every packet is accepted, and the node
//! receives none of them: the stack routes an injected packet by its own
//! table and treats `interface_id` as a hint about where it came from,
//! not an instruction about where to send it. Proven by capture on the
//! node, which showed 252 arriving packets, all of them Windows
//! multicast chatter and not one of them the redirected traffic.
//!
//! Routing everything through `127.0.0.1` fails too, differently:
//! WinDivert treats loopback as a special case and an injected loopback
//! packet is never delivered to the listener.
//!
//! What works is neither. Leave the source alone, rewrite the
//! destination to the machine's **own LAN address** plus the proxy's
//! port, and inject it inbound. Both ends are then ordinary addresses on
//! a real interface, the listener accepts it as a normal connection, and
//! the tunnelling is done by the proxy's own socket rather than by
//! anything done to this packet.
//!
//! # Why the filter is broad
//!
//! WinDivert compiles one filter string into the driver when the handle
//! is opened; it cannot be changed as the set of interesting ports
//! changes. Since which ports matter depends on which process owns them,
//! and that is not expressible in the filter language, the decision has
//! to happen here. What the filter *can* do is exclude, in the kernel,
//! everything that could never be interesting: loopback, the node's own
//! address, private and link-local destinations, and multicast. That
//! last one is not an optimisation -- a tunnel coming up makes Windows
//! spray mDNS, LLMNR, SSDP and IGMP at it, which for a customer who
//! asked for one game to be tunnelled would mean their local hostnames
//! going to the VPN server.
//!
//! Everything else is examined here and, overwhelmingly, sent straight
//! back out untouched. **Any path out of this loop that does not either
//! re-inject or deliberately drop a packet is a hole in the machine's
//! networking**, so the code below is written so that passing the packet
//! through is what happens by default.
//!
//! # IPv6 is blocked, not carried, and why
//!
//! Everything above rewrites IPv4. Until this was measured, the IPv6
//! case had never been run, because no machine used for the work had
//! IPv6 -- and what it did was the worst of the available outcomes.
//! Measured on a Windows 11 VM with a router-advertised IPv6 prefix,
//! Custom mode on, one 22-second window carrying both families:
//!
//! ```text
//! PRODUCTION FILTER delivered: ipv4=25 ipv6=0
//! ALL-IPV6 observer saw:      ipv4=0  ipv6=8
//!   -> [2001:db8:6ec5::1]:8686        (global unicast, off-link)
//!   -> [fd00::950d:8fd1:26eb:d4a]:8686
//! ```
//!
//! Eight IPv6 packets left the machine and the filter handed over none
//! of them, so nothing here ever saw one. A listener on the far machine
//! recorded what arrived:
//!
//! ```text
//! FROM [fd00::20b9:6840:d2bd:49a1]:56122 BYTES 105
//! PLAINTEXT: GET /BEFORE-ula HTTP/1.1 | Host: ... | User-Agent: curl/8.21.0
//! ```
//!
//! In the clear, from the customer's own address, while the app showed
//! Custom mode active. That is the failure this whole file exists to
//! prevent, arriving through the one door nobody had opened.
//!
//! ## Carrying it was not available
//!
//! The complete answer is to put IPv6 through the tunnel, and it is not
//! reachable from the client alone. A carried flow needs a v6 NAT table,
//! a v6 rewrite, and an upstream socket pinned to the tunnel with
//! `IPV6_UNICAST_IF` -- all of which is work, none of which is the
//! blocker. The blocker is that **the tunnel adapter has no IPv6
//! address**: the WireGuard engine builds its interface with
//! `Address = 10.77.0.8/32` and `AllowedIPs = 0.0.0.0/0`, and every
//! route this client installs (`0.0.0.0/1`, `128.0.0.0/1`,
//! `0.0.0.0/0`) is IPv4. There is nowhere for a v6 packet to be sent,
//! and giving it one means the node hands out v6 addressing, which is a
//! server-side change.
//!
//! So the choice here was between a silent leak and a stated gap, and
//! this project has an answer to that: a stated gap. A selected
//! application's IPv6 is dropped. Where a destination is IPv6-only it
//! becomes unreachable for that app, which is visible,
//! complainable-about and recoverable. Being logged by an ISP in Iran is
//! none of those.
//!
//! ## The same measurement afterwards
//!
//! Same rig, same targets, with the loop running -- see
//! [`live_custom_mode_blocks_ipv6_and_keeps_carrying_ipv4`], which is
//! what produced these:
//!
//! ```text
//! seen=121 matched=6 redirected=39 returned=64 rejected=0 blocked_v6=5
//! PRODUCTION FILTER delivered:    ipv4=66 ipv6=5
//! SURVIVED THE LOOP (prio -1000): ipv4=0  ipv6=0
//!   -> [2001:db8:6ec5::1]:8686   (delivered to the loop, and stopped there)
//! ```
//!
//! The second sniffer is the part that matters. It is a separate
//! WinDivert handle opened *below* this loop's priority, so it sees only
//! what the loop let past: before, it counted the eight packets on their
//! way out; after, none. The counter alone could not have said that --
//! it reports intent, and this file has been wrong about intent before.
//!
//! And the reason blocking is tolerable rather than merely safe, from
//! the same run: a name with a blocked `AAAA` and a working `A` was
//! still fetched, over IPv4, in **385ms**. That is the browser's own
//! fallback doing its job, and it is what nearly every real destination
//! will do.
//!
//! ## What is deliberately *not* blocked
//!
//! Only traffic that would have been tunnelled. An application the
//! customer did not select keeps its IPv6 exactly as before -- the whole
//! premise of a split tunnel is that it is left alone -- and so do
//! link-local, unique-local and multicast destinations, which are the
//! LAN.
//!
//! That the block is actually *scoped* was measured rather than
//! reasoned, because "it only drops the selected app" is precisely the
//! sort of claim the code can be wrong about while every counter agrees
//! with it. `curl.exe` was selected and a byte-for-byte copy of it at
//! another path was not; both fetched the same IPv6 address in the same
//! window:
//!
//! ```text
//! PRODUCTION FILTER delivered:    ipv4=115 ipv6=21
//! SURVIVED THE LOOP (prio -1000): ipv4=0   ipv6=16
//! blocked_v6=5
//!   -> [2001:db8:6ec5::1]:8686   (seen on both sides of the loop)
//! ```
//!
//! Twenty-one in, five stopped, sixteen out, and the same destination
//! appears above and below the loop. Identical binaries, identical
//! destination, opposite outcomes -- which is the split doing its job
//! and not a blanket IPv6 kill.
//!
//! Note that the address exclusions are weaker than the IPv4 ones, and
//! cannot be otherwise: IPv6 home networks are usually numbered out of
//! the global prefix the ISP delegates, so there is no `10/8` to carve
//! out. A LAN neighbour on a `2000::/3` address is indistinguishable
//! here from the internet, and a selected app will lose IPv6 to it. It
//! keeps IPv4.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windivert_sys::address::WINDIVERT_ADDRESS;
use windivert_sys::{WinDivertFlags, WinDivertLayer};

use super::divert::{recalculate_checksums, Handle};
use super::flows::{Nat, Origin, Verdict};
use super::owner::{Family, OwnerLookup, Selection, SharedSelection, Transport};
use super::proxy::OwnSockets;

/// The largest packet WinDivert will hand over.
const MAX_PACKET: usize = 65_575;

/// How many threads share the handle.
///
/// More than one because this sits on the path of all outbound traffic
/// and a single thread would cap throughput at whatever one core can
/// forward; only a few, because packets are reordered across threads and
/// a latency-sensitive audience is the reason this feature exists.
const WORKERS: usize = 2;

const IPPROTO_TCP: u8 = 6;
const IPPROTO_UDP: u8 = 17;
const TCP_FLAG_SYN: u8 = 0x02;
const TCP_FLAG_ACK: u8 = 0x10;

/// What the loop has actually done, for diagnosis.
///
/// Not telemetry and not sent anywhere -- it is written to a log file
/// beside the engine logs. Custom mode has three plausible ways to fail
/// silently (nothing intercepted, intercepted but nothing matched the
/// selection, matched but the proxy never connected) and they look
/// identical from the outside. These four numbers separate them in one
/// reading, which is worth more than the guesses it replaces.
#[derive(Default)]
pub struct Stats {
    /// Packets the filter handed over. Zero means the driver is not
    /// intercepting at all.
    pub seen: AtomicU64,
    /// Flows attributed to a selected application. Zero with `seen`
    /// high means the selection matches nothing that is running.
    pub matched: AtomicU64,
    /// Packets rewritten towards the proxy *and accepted by the driver*.
    ///
    /// Counted after the injection, not after the rewrite. The first
    /// version counted intent, which made a run where every packet was
    /// rewritten and every injection refused look identical to one that
    /// worked -- the single most useful distinction there is here.
    pub redirected: AtomicU64,
    /// Replies rewritten back. Zero with `redirected` high means the
    /// proxy is not getting answers -- so the tunnel, not the redirect.
    pub returned: AtomicU64,
    /// Injections the driver refused. Should be zero; anything else
    /// means the packets are not going where the counters imply.
    pub rejected: AtomicU64,
    /// IPv6 packets dropped because the tunnel cannot carry them.
    ///
    /// Counted separately from everything above because it is the one
    /// number here that reports a *deliberate* refusal rather than a
    /// fault, and reading it as a fault would be wrong in both
    /// directions: high is normal on a dual-stack network, and zero
    /// says only that nothing tried. Before this was written it read
    /// zero because there was nothing to count -- the packets were
    /// leaving unexamined.
    pub blocked_v6: AtomicU64,
}

/// How many packets must have gone out before silence means anything.
///
/// One unanswered packet is normal -- a retransmit, a probe to a host
/// that is down, a UDP send nobody was ever going to reply to. Twenty
/// with nothing at all coming back is not something a working path does.
/// The threshold is deliberately well above a single stalled connection
/// so that one dead host cannot condemn a healthy tunnel.
const SILENT_AFTER: u64 = 20;

/// How long a session must have been running before silence is allowed
/// to mean anything.
///
/// Measured, not chosen: a healthy start reaches `redirected=48,
/// returned=0` before the first reply arrives, because the firewall
/// allowance takes a moment to become effective for new flows. Judged on
/// the count alone, this check called a perfectly good connection broken
/// during its first seconds -- which is worse than saying nothing, since
/// a false alarm here teaches customers to ignore the true ones.
const WARMUP: Duration = Duration::from_secs(12);

impl Stats {
    pub fn summary(&self) -> String {
        format!(
            "seen={} matched={} redirected={} returned={} rejected={} blocked_v6={}",
            self.seen.load(Ordering::Relaxed),
            self.matched.load(Ordering::Relaxed),
            self.redirected.load(Ordering::Relaxed),
            self.returned.load(Ordering::Relaxed),
            self.rejected.load(Ordering::Relaxed),
            self.blocked_v6.load(Ordering::Relaxed),
        )
    }

    /// What these numbers say about whether Custom mode is working, in
    /// words a customer can act on -- or `None` when nothing is wrong.
    ///
    /// This exists because the app had no way to notice the failure its
    /// own service was already recording. A tester's log read
    /// `redirected=90 returned=0` -- ninety packets pushed into the
    /// tunnel for his browser, not one answer -- while the app showed
    /// Connected and Custom mode on. He reported the feature as broken,
    /// which was the only conclusion available to him.
    ///
    /// The existing probe cannot catch this. It opens its own socket,
    /// pinned to the tunnel, and connects out: that proves the tunnel is
    /// alive and touches none of the interception, matching, rewriting
    /// or relaying that a selected application's packets go through. It
    /// is also read at connect time, when these counters are still zero.
    /// These are the only numbers taken from the real path under real
    /// traffic.
    ///
    /// `blocked_v6` is deliberately not consulted here, and that was a
    /// decision rather than an oversight. It counts a refusal working as
    /// designed, not a fault: on any dual-stack network it climbs from
    /// the first second and never stops, so a complaint keyed on it
    /// would be permanently lit. This whole function exists to be
    /// believed -- see `WARMUP`, which is here because one false alarm
    /// during a healthy start was judged worse than saying nothing -- and
    /// a warning that is always on is one nobody reads by the time it
    /// matters. What a customer needs to know about IPv6 is true of
    /// Custom mode always, not of this session, so it is stated in the
    /// Custom-mode line on the dashboard (`dash.customActive`) where it
    /// sits beside "on" instead of pretending to be news.
    pub fn complaint(&self, session_age: Duration) -> Option<String> {
        // Nothing is wrong yet, by definition: the redirect has not
        // had time to be wrong. See WARMUP.
        if session_age < WARMUP {
            return None;
        }
        let seen = self.seen.load(Ordering::Relaxed);
        let matched = self.matched.load(Ordering::Relaxed);
        let redirected = self.redirected.load(Ordering::Relaxed);
        let returned = self.returned.load(Ordering::Relaxed);
        let rejected = self.rejected.load(Ordering::Relaxed);

        // Injections the driver refused. The packets are not going where
        // every other counter implies, so say that before anything else.
        if rejected > 0 && rejected >= redirected {
            return Some(
                "Windows is refusing the redirected packets, so your chosen apps are not \
                 reaching the VPN. Restarting the app usually clears this."
                    .into(),
            );
        }

        // The tester's exact signature: traffic going out, nothing back.
        if redirected >= SILENT_AFTER && returned == 0 {
            return Some(
                "Your chosen apps are being sent through the VPN but nothing is coming back, \
                 so their connections will hang. The tunnel is not carrying their traffic."
                    .into(),
            );
        }

        // Intercepting the machine's traffic and recognising none of it.
        // Usually the wrong executable was picked -- a launcher rather
        // than the program, or a browser that was not running when the
        // list was taken.
        if seen >= 500 && matched == 0 {
            return Some(
                "None of the apps you chose have sent any traffic. If one of them is running, \
                 the wrong program may have been picked -- some apps launch under a different \
                 executable."
                    .into(),
            );
        }

        None
    }
}

/// Everything the loop needs that does not change while it runs.
pub struct Redirect {
    /// The machine's own address on the physical link. Redirected
    /// packets are aimed here, which is what keeps them off loopback.
    pub local_addr: Ipv4Addr,
    /// The VPN node. Its traffic is the tunnel itself and must never be
    /// touched, or the tunnel would be carried through the tunnel.
    pub node_addr: Ipv4Addr,
    pub tcp_proxy_port: u16,
    pub udp_proxy_port: u16,
    /// This service's own executable, excluded unconditionally. In
    /// fail-open mode the proxy's upstream socket is unpinned and looks
    /// exactly like an ordinary app's, so without this the proxy would
    /// intercept itself.
    pub own_images: Vec<String>,
    /// The relay's own onward sockets, as the relay itself recorded
    /// them.
    ///
    /// `own_images` answers the same question but has to go through the
    /// connection tables to do it, and that lookup is rate-limited: it
    /// cannot see a socket younger than `MIN_REFRESH_INTERVAL`, which
    /// every onward socket is when it sends its first packet. See
    /// `OwnSockets` for the measurement. This is checked first because
    /// it is both cheaper and correct.
    pub own_sockets: Arc<OwnSockets>,
    /// The interface `local_addr` lives on.
    ///
    /// A rewritten packet is aimed at that address, so it has to be
    /// injected on the link that owns it. Left as captured, a packet
    /// taken off the tunnel adapter is re-injected *on the tunnel* and
    /// Windows sends it to the VPN instead of to the proxy sitting on
    /// this machine -- which is what "everything except these" did:
    ///
    /// ```text
    /// ip: 10.77.0.3.40001 > 192.168.88.10.64129: Flags [S]   (x4, no reply)
    /// ```
    ///
    /// Nothing was dropped and nothing answered, because the SYN went
    /// down the tunnel. It never mattered before: with a passive tunnel
    /// the captured packet was already on the physical link.
    pub local_interface: u32,
    /// Whether lookups are carried at all. False for a full tunnel,
    /// which already resolves through the VPN.
    pub carry_dns: bool,
    /// Where name lookups are sent while Custom mode is on.
    ///
    /// Every lookup goes here, through the tunnel, whoever asked. See
    /// `is_dns` for why that is not the overreach it looks like.
    pub dns_resolver: Ipv4Addr,
}

/// Whether this packet is a name lookup.
///
/// Custom mode used to leave DNS alone, and that was a leak with teeth.
/// Measured on the test rig, one run, same moment:
///
/// ```text
/// CUSTOM  tcp egress: 38.60.249.229   (the node)
/// CUSTOM  dns egress: 50.34.35.228    (the customer's own address)
/// ```
///
/// So a selected application's traffic went through the tunnel while
/// the name it looked up was resolved by the network the customer was
/// trying to escape. On an ordinary connection that is merely a privacy
/// leak. On a censored one it is the whole feature failing: the
/// resolver answers blocked domains with a lie, so the browser cannot
/// open the site while an unblocked address check still shows the
/// tunnel's IP. That is exactly how it was reported -- "the IP changes
/// but the site will not open", from Iran, with Telegram working
/// because it never asks that resolver.
///
/// It cannot be done per-application: Windows resolves through its own
/// DNS Client service, so the query leaves under svchost's name rather
/// than the selected app's. Catching only the applications that resolve
/// for themselves would fix some browsers and leave the rest broken.
/// So while Custom mode is on, every lookup goes through the tunnel.
/// Nothing else about an unselected application changes -- its
/// connections still leave directly; only the name it asked about is
/// resolved somewhere honest.
fn is_dns(parsed: &Parsed) -> bool {
    parsed.destination_port == DNS_PORT
}

/// The well-known port, named because `== 53` in the middle of a
/// verdict reads like a magic number.
const DNS_PORT: u16 = 53;

/// The filter string, built from the addresses and ports in use.
///
/// Written out rather than assembled from parts because it is the one
/// piece of this module that runs in the kernel, and being able to read
/// it in one piece is worth more than being able to compose it.
/// Each exclusion is written as a pair of comparisons rather than as
/// `not (low and high)`. That is not style: WinDivert's parser rejects
/// `not` in front of a parenthesised expression, and it rejects it at
/// load time with a position offset and nothing else. Found by the
/// compile test below, which exists for exactly this.
/// The IPv6 half is deliberately narrower than a mirror of the IPv4
/// one. Two bounds, not six, because IPv6 has nothing to mirror: there
/// is no RFC1918 to carve out, since a home IPv6 network numbers its own
/// devices out of the global prefix its ISP delegates. What can be
/// excluded by address is only what is genuinely not the internet --
/// everything from `fc00::` up, which is unique-local, link-local and
/// multicast in one comparison -- and everything below
/// `0:0:0:0:ffff:ffff:ffff:ffff`, which is the unspecified address,
/// loopback, and the IPv4-mapped range that is IPv4 traffic wearing a
/// v6 shape and already handled above.
///
/// Nothing excludes the node here: no node this client talks to has an
/// IPv6 address, so the tunnel itself can never appear in this half.
pub fn filter_for(redirect: &Redirect) -> String {
    format!(
        "(outbound and ip and (tcp or udp) and not loopback \
           and ip.DstAddr != {node} \
           and (ip.DstAddr < 10.0.0.0 or ip.DstAddr > 10.255.255.255) \
           and (ip.DstAddr < 127.0.0.0 or ip.DstAddr > 127.255.255.255) \
           and (ip.DstAddr < 169.254.0.0 or ip.DstAddr > 169.254.255.255) \
           and (ip.DstAddr < 172.16.0.0 or ip.DstAddr > 172.31.255.255) \
           and (ip.DstAddr < 192.168.0.0 or ip.DstAddr > 192.168.255.255) \
           and ip.DstAddr < 224.0.0.0) \
         or (outbound and ipv6 and (tcp or udp) and not loopback \
           and ipv6.DstAddr > 0:0:0:0:ffff:ffff:ffff:ffff \
           and ipv6.DstAddr < fc00::) \
         or (ip and tcp.SrcPort == {tcp}) \
         or (ip and udp.SrcPort == {udp})",
        node = redirect.node_addr,
        tcp = redirect.tcp_proxy_port,
        udp = redirect.udp_proxy_port,
    )
}

/// A running redirect loop.
pub struct Running {
    handle: Arc<Handle>,
    stop: Arc<AtomicBool>,
    pub stats: Arc<Stats>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Running {
    pub fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        // The only thing that unblocks a thread sitting in recv. A flag
        // alone would leave them there for as long as the filter matched
        // nothing, which on a quiet machine is indefinitely.
        self.handle.shutdown();
        for thread in self.threads {
            let _ = thread.join();
        }
    }
}

pub fn start(
    redirect: Redirect,
    nat: Arc<Nat>,
    selection: SharedSelection,
) -> Result<Running, String> {
    let filter = filter_for(&redirect);
    // Checked before opening so a filter problem is reported as one.
    // WinDivertOpen fails with a generic error for a bad expression,
    // which is indistinguishable from the driver refusing to load.
    super::divert::compile_filter(&filter)
        .map_err(|e| format!("internal error: the packet filter is invalid ({e})"))?;

    let handle = Handle::open(&filter, WinDivertLayer::Network, WinDivertFlags::new())
        .map_err(|e| format!("could not start packet interception: {e}"))?;

    let handle = Arc::new(handle);
    let redirect = Arc::new(redirect);
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Stats::default());

    let threads = (0..WORKERS)
        .map(|_| {
            let (handle, redirect, nat, selection, stop, stats) = (
                handle.clone(),
                redirect.clone(),
                nat.clone(),
                selection.clone(),
                stop.clone(),
                stats.clone(),
            );
            std::thread::spawn(move || worker(handle, redirect, nat, selection, stop, stats))
        })
        .collect();

    Ok(Running { handle, stop, stats, threads })
}

/// Appends a line to the split-tunnel log, beside the counters.
///
/// Same file the periodic stats go to, so a worker that died and the
/// numbers that stopped moving are read together rather than in two
/// places.
fn note(line: &str) {
    use std::io::Write;
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    let path = std::path::Path::new(&base).join("Neoxify").join("split-tunnel.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

fn worker(
    handle: Arc<Handle>,
    redirect: Arc<Redirect>,
    nat: Arc<Nat>,
    selection: SharedSelection,
    stop: Arc<AtomicBool>,
    stats: Arc<Stats>,
) {
    // One per thread rather than shared: the lookup caches a snapshot of
    // the connection tables, and a lock around it would put every
    // decision behind every other one.
    let mut owner = OwnerLookup::new();
    let mut packet = vec![0u8; MAX_PACKET];

    while !stop.load(Ordering::SeqCst) {
        let (len, mut address) = match handle.recv(&mut packet) {
            Ok(Some(received)) => received,
            // Shut down cleanly, or the driver gave up on us. Either way
            // there is nothing further to read.
            Ok(None) => return,
            // Said out loud rather than swallowed. A worker that exits
            // here stops intercepting silently, and the only visible
            // symptom is `seen=0` in the counters while the customer's
            // selected app quietly goes direct -- which is exactly the
            // kind of quiet failure this file exists to avoid.
            Err(e) => {
                note(&format!("redirect worker stopped: {e}"));
                return;
            }
        };

        stats.seen.fetch_add(1, Ordering::Relaxed);
        // Read per packet, not captured once at startup. Editing the
        // chosen applications while Custom mode stays on does not
        // rebuild anything, so a copy taken here would be the customer's
        // first choice forever -- which is what shipped, and what made a
        // tester report that changing the list did nothing until they
        // restarted the app.
        let chosen = selection.read().unwrap_or_else(|e| e.into_inner());
        let rewrote = handle_packet(
            &mut packet[..len as usize],
            &mut address,
            &redirect,
            &nat,
            &chosen,
            &mut owner,
            &stats,
        );

        // Released before the send: nothing below consults it, and a
        // lock held across a syscall would make every other worker wait
        // on this one.
        drop(chosen);

        // Deliberately not re-injected: the only way a packet is meant
        // to disappear here. Everything else must reach the network,
        // which is why this is the single early exit in the loop.
        if rewrote == Some(Leg::Swallowed) {
            continue;
        }

        if rewrote.is_some() {
            recalculate_checksums(&mut packet[..len as usize], len, &mut address);
        }
        // Sent whether or not anything was rewritten. A packet that
        // falls out of the logic above still has to reach the network.
        let sent = handle.send(&packet[..len as usize], len, &address);

        // Counted here rather than at the rewrite, so the numbers say
        // what was delivered rather than what was intended.
        match (rewrote, sent) {
            (Some(Leg::Outbound), true) => stats.redirected.fetch_add(1, Ordering::Relaxed),
            (Some(Leg::Return), true) => stats.returned.fetch_add(1, Ordering::Relaxed),
            (Some(_), false) => stats.rejected.fetch_add(1, Ordering::Relaxed),
            // Unreachable: a swallowed packet leaves the loop above
            // before anything is sent. Spelled out rather than folded
            // into a wildcard so that adding a Leg later has to come
            // back here and decide what it means.
            (Some(Leg::Swallowed), _) => 0,
            (None, _) => 0,
        };
    }
}

/// Which half of the translation a packet went through, so the worker
/// can attribute the injection that follows.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Leg {
    /// App towards the proxy.
    Outbound,
    /// Proxy's reply back to the app.
    Return,
    /// Swallowed on purpose: not re-injected, and not a hole in the
    /// machine's networking but a deliberate refusal. Only the DNS
    /// branch produces this, and only when the alternative would be to
    /// send the lookup to the customer's own ISP.
    Swallowed,
}

/// The fields the decision needs, or `None` if this is not an IPv4
/// TCP/UDP packet with a complete header.
struct Parsed {
    transport: Transport,
    header_len: usize,
    source: Ipv4Addr,
    destination: Ipv4Addr,
    source_port: u16,
    destination_port: u16,
    tcp_flags: u8,
}

fn parse(packet: &[u8]) -> Option<Parsed> {
    // Version and header length share the first byte; the length is in
    // 32-bit words and may be larger than the minimum when options are
    // present, so the transport header is not at a fixed offset.
    let first = *packet.first()?;
    if first >> 4 != 4 {
        return None;
    }
    let header_len = ((first & 0x0F) as usize) * 4;
    if header_len < 20 {
        return None;
    }

    let transport = match *packet.get(9)? {
        IPPROTO_TCP => Transport::Tcp,
        IPPROTO_UDP => Transport::Udp,
        _ => return None,
    };

    // A TCP header is 20 bytes and a UDP one is 8, but the flags byte
    // this reads sits at offset 13, so 14 covers both reads below.
    let ports = packet.get(header_len..header_len + 14)?;
    let tcp_flags = if matches!(transport, Transport::Tcp) { ports[13] } else { 0 };

    Some(Parsed {
        transport,
        header_len,
        source: Ipv4Addr::new(packet[12], packet[13], packet[14], packet[15]),
        destination: Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]),
        source_port: u16::from_be_bytes([ports[0], ports[1]]),
        destination_port: u16::from_be_bytes([ports[2], ports[3]]),
        tcp_flags,
    })
}

/// The header offsets an IPv6 decision needs.
///
/// Deliberately much less than [`Parsed`] carries. An IPv6 packet here
/// is only ever passed through or dropped, never rewritten, so the
/// addresses are not needed -- and not reading them keeps this from
/// looking like the beginning of a v6 rewrite that does not exist.
struct ParsedV6 {
    transport: Transport,
    source_port: u16,
    destination_port: u16,
    tcp_flags: u8,
}

/// Extension headers, which sit between the IPv6 header and the
/// transport one and must be walked rather than assumed away.
const IPPROTO_HOPOPTS: u8 = 0;
const IPPROTO_ROUTING: u8 = 43;
const IPPROTO_FRAGMENT: u8 = 44;
const IPPROTO_AH: u8 = 51;
const IPPROTO_DSTOPTS: u8 = 60;

/// The fixed IPv6 header, before any extension header.
const IPV6_HEADER: usize = 40;

/// How many extension headers are walked before giving up.
///
/// A real packet has none or one. A long chain is either malformed or
/// built to be, and either way the answer is to stop rather than to keep
/// following a next-header field around a packet an attacker supplied.
const MAX_EXTENSION_HEADERS: usize = 8;

/// Reads the ports out of an IPv6 packet, or `None` when they cannot be
/// found.
///
/// `None` is not "this is not TCP or UDP" -- the filter already settled
/// that, since WinDivert walks the chain itself to decide `tcp or udp`.
/// It means *this code* could not follow the chain: an extension header
/// it does not know, or a fragment after the first, which carries no
/// transport header at all. The caller must treat that as an unknown
/// owner rather than as permission to pass the packet on.
fn parse_v6(packet: &[u8]) -> Option<ParsedV6> {
    if packet.len() < IPV6_HEADER || packet.first()? >> 4 != 6 {
        return None;
    }

    let mut next = packet[6];
    let mut offset = IPV6_HEADER;

    for _ in 0..MAX_EXTENSION_HEADERS {
        let transport = match next {
            IPPROTO_TCP => Transport::Tcp,
            IPPROTO_UDP => Transport::Udp,
            // Header length is in 8-byte units, not counting the first.
            IPPROTO_HOPOPTS | IPPROTO_ROUTING | IPPROTO_DSTOPTS => {
                let header = packet.get(offset..offset + 2)?;
                next = header[0];
                offset += (header[1] as usize + 1) * 8;
                continue;
            }
            // Authentication headers count in 4-byte units and subtract
            // two rather than one, which is the sort of detail that
            // makes a hand-rolled walk worth writing down.
            IPPROTO_AH => {
                let header = packet.get(offset..offset + 2)?;
                next = header[0];
                offset += (header[1] as usize + 2) * 4;
                continue;
            }
            IPPROTO_FRAGMENT => {
                let header = packet.get(offset..offset + 8)?;
                // Only the first fragment carries the transport header;
                // the rest have no ports to read and no owner to find.
                if u16::from_be_bytes([header[2], header[3]]) & 0xFFF8 != 0 {
                    return None;
                }
                next = header[0];
                offset += 8;
                continue;
            }
            _ => return None,
        };

        // Flags sit at offset 13 of a TCP header, so 14 bytes covers
        // both reads -- the same reasoning as the IPv4 parser.
        let ports = packet.get(offset..offset + 14)?;
        return Some(ParsedV6 {
            transport,
            source_port: u16::from_be_bytes([ports[0], ports[1]]),
            destination_port: u16::from_be_bytes([ports[2], ports[3]]),
            tcp_flags: if matches!(transport, Transport::Tcp) { ports[13] } else { 0 },
        });
    }
    None
}

/// What to do with an IPv6 packet, which this loop has no way to carry.
///
/// Drop when the flow is one whose traffic belongs in the tunnel, pass
/// it through otherwise. See the module comment for why blocking is the
/// answer here and carrying is not.
///
/// The decision is made per packet with no flow table behind it, unlike
/// the IPv4 path. Nothing needs remembering: the verdict is the same
/// every time it is asked, so there is no earlier answer to stay
/// consistent with and nothing a reused port could inherit.
fn handle_ipv6(
    packet: &[u8],
    redirect: &Redirect,
    selection: &Selection,
    owner: &mut OwnerLookup,
    stats: &Stats,
) -> Option<Leg> {
    let block = |stats: &Stats| {
        stats.blocked_v6.fetch_add(1, Ordering::Relaxed);
        Some(Leg::Swallowed)
    };

    // A packet whose ports could not be read. Answered the same way the
    // IPv4 path answers an unknown owner, and for the same reason: which
    // way to fail depends on which way the customer's list reads.
    let Some(parsed) = parse_v6(packet) else {
        return if selection.tunnel_when_owner_unknown() { block(stats) } else { None };
    };

    // A SYN is asked about insistently, exactly as on the IPv4 side. A
    // miss here is not merely a dropped packet: the SYN goes out over
    // IPv6, **the far end answers it**, and the connection is then
    // established in the clear from the customer's own address. That is
    // the leak, not a slower version of it.
    let is_new_connection = matches!(parsed.transport, Transport::Tcp)
        && parsed.tcp_flags & TCP_FLAG_SYN != 0
        && parsed.tcp_flags & TCP_FLAG_ACK == 0;
    let owner_image = if is_new_connection {
        owner.image_for_new_connection(Family::V6, parsed.transport, parsed.source_port)
    } else {
        owner.image_for_port(Family::V6, parsed.transport, parsed.source_port)
    };

    // This service's own traffic is never touched, on either family.
    let is_own = owner_image
        .map(|image| {
            redirect
                .own_images
                .iter()
                .any(|own| image.eq_ignore_ascii_case(own))
        })
        .unwrap_or(false);
    if is_own {
        return None;
    }

    // A lookup sent over IPv6 would be answered by the resolver the
    // network handed out -- for somebody in Iran, their ISP -- which is
    // the precise leak `is_dns` exists to close, arriving over the other
    // family. It cannot be carried instead: the redirect that carries a
    // lookup rewrites it towards an IPv4 resolver through an IPv4 proxy,
    // and there is no v6 equivalent to send it to.
    //
    // Dropping it is not the end of the lookup. Windows asks its
    // configured resolvers in turn, so the query is re-sent over IPv4 a
    // moment later and carried through the tunnel as usual. The gap
    // worth stating: on a network whose *only* resolver is IPv6,
    // Custom mode has no honest way to resolve names, and this makes
    // that visible as slow lookups rather than silently handing them to
    // the ISP.
    if redirect.carry_dns && parsed.destination_port == DNS_PORT {
        return block(stats);
    }

    let tunnelled = match owner_image {
        Some(image) => selection.should_tunnel(image),
        None => selection.tunnel_when_owner_unknown(),
    };
    if tunnelled {
        stats.matched.fetch_add(1, Ordering::Relaxed);
        block(stats)
    } else {
        // An application the customer did not choose. Its IPv6 is none
        // of this feature's business and goes out exactly as it did
        // before Custom mode was switched on.
        None
    }
}

/// Rewrites the packet in place if it should be redirected. Returns
/// whether anything changed, which is what decides if the checksums need
/// recomputing.
fn handle_packet(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    redirect: &Redirect,
    nat: &Nat,
    selection: &Selection,
    owner: &mut OwnerLookup,
    stats: &Stats,
) -> Option<Leg> {
    // Decided before anything below is consulted, because none of it can
    // carry an IPv6 packet: the NAT table, the rewrite and the proxy's
    // upstream socket are all IPv4, and so is the address on the tunnel
    // adapter they would send it to.
    if packet.first().map(|first| first >> 4) == Some(6) {
        return handle_ipv6(packet, redirect, selection, owner, stats);
    }

    let parsed = parse(packet)?;

    let proxy_port = match parsed.transport {
        Transport::Tcp => redirect.tcp_proxy_port,
        Transport::Udp => redirect.udp_proxy_port,
    };

    if parsed.source_port == proxy_port {
        return rewrite_return_leg(packet, address, &parsed, nat).then_some(Leg::Return);
    }

    // Read before the rewrite, which overwrites it: the return leg has
    // to be delivered on the interface the app's socket is expecting.
    //
    // SAFETY: this came from the network layer, so the Network arm of
    // the union is the live one.
    let interface_id = unsafe { address.union_field.Network.interface_id };
    let verdict = decide(&parsed, nat, selection, owner, redirect, interface_id, stats);
    match verdict {
        Verdict::Direct | Verdict::Unknown => None,
        Verdict::Drop => Some(Leg::Swallowed),
        Verdict::Redirect { nat_port } => {
            rewrite_outbound(
                packet,
                address,
                &parsed,
                redirect.local_addr,
                redirect.local_interface,
                nat_port,
                proxy_port,
            );
            Some(Leg::Outbound)
        }
    }
}

fn decide(
    parsed: &Parsed,
    nat: &Nat,
    selection: &Selection,
    owner: &mut OwnerLookup,
    redirect: &Redirect,
    interface_id: u32,
    stats: &Stats,
) -> Verdict {
    // A SYN without an ACK is a new connection, so any leave-alone
    // verdict recorded against this port belongs to whatever held it
    // before and must not be inherited. The flow table is still
    // consulted, so a retransmitted SYN keeps its existing port.
    let is_new_connection = matches!(parsed.transport, Transport::Tcp)
        && parsed.tcp_flags & TCP_FLAG_SYN != 0
        && parsed.tcp_flags & TCP_FLAG_ACK == 0;

    let known = if is_new_connection {
        nat.lookup_flow(
            parsed.transport,
            parsed.source_port,
            parsed.destination,
            parsed.destination_port,
        )
        .map_or(Verdict::Unknown, |nat_port| Verdict::Redirect { nat_port })
    } else {
        nat.lookup(
            parsed.transport,
            parsed.source_port,
            parsed.destination,
            parsed.destination_port,
        )
    };
    if known != Verdict::Unknown {
        return known;
    }

    // The relay's own onward socket, carrying a flow that has already
    // been decided. Answered from what the relay recorded when it
    // created the socket, before the owner tables are consulted at all.
    //
    // This has to come first, and not merely as an optimisation. The
    // image-based check below cannot see a socket this young -- the
    // owner lookup will not rebuild more than once every 20ms -- so a
    // lookup made while another was in flight fell through to the DNS
    // branch and was posted back into the relay it came from. It never
    // reached a resolver, and the answer never came. Two lookups fired
    // less than 20ms apart lost both; 25ms apart lost neither.
    //
    // A browser opening a page resolves every asset host at once, which
    // is why this presented as text arriving while images and
    // stylesheets did not.
    if redirect.own_sockets.contains(parsed.transport, parsed.source, parsed.source_port) {
        return Verdict::Direct;
    }

    // Anything mid-connection that nothing is known about started before
    // Custom mode did, or before its app was selected. Moving it now
    // would break it: the app holds a socket to the real destination,
    // and rewriting half a live connection is not a redirect.
    if matches!(parsed.transport, Transport::Tcp) && !is_new_connection {
        nat.record_direct(parsed.transport, parsed.source_port);
        return Verdict::Direct;
    }

    // A SYN asks the more insistent question -- see
    // `image_for_new_connection`. This is the one packet whose answer
    // decides where a whole connection lives, and the one whose miss
    // cannot be taken back afterwards.
    let owner_image = if is_new_connection {
        owner.image_for_new_connection(Family::V4, parsed.transport, parsed.source_port)
    } else {
        owner.image_for_port(Family::V4, parsed.transport, parsed.source_port)
    };
    let known_owner = owner_image.is_some();
    // This service, resolving for itself. Checked separately because it
    // has to be excluded from the DNS rule below as well as from the
    // selection: the proxy's upstream lookups must not be routed into
    // the proxy. Getting this wrong took DNS out for the whole machine
    // the moment Custom mode came on -- the first version of this rule
    // did exactly that.
    let is_own = owner_image
        .map(|image| {
            redirect
                .own_images
                .iter()
                .any(|own| image.eq_ignore_ascii_case(own))
        })
        .unwrap_or(false);
    let selected = match owner_image {
        Some(image) => !is_own && selection.should_tunnel(image),
        // A port with no owner this can see. Which way to fail depends
        // on the direction -- see `tunnel_when_owner_unknown`.
        None => selection.tunnel_when_owner_unknown(),
    };

    // A lookup is carried whoever made it -- see `is_dns` -- except this
    // service's own.
    if redirect.carry_dns && is_dns(parsed) && !is_own {
        let origin = Origin {
            addr: parsed.destination,
            port: parsed.destination_port,
            client: parsed.source,
            client_port: parsed.source_port,
            interface_id,
            // Answered by a resolver reached through the tunnel, not by
            // the one the network handed out.
            upstream: Some(std::net::SocketAddrV4::new(redirect.dns_resolver, DNS_PORT)),
        };
        return match nat.redirect(parsed.transport, origin) {
            Some(nat_port) => {
                stats.matched.fetch_add(1, Ordering::Relaxed);
                Verdict::Redirect { nat_port }
            }
            // Dropped, not sent out in the clear.
            //
            // This used to fall back to Direct, which handed the lookup
            // to whichever resolver the network supplied -- for somebody
            // in Iran, their ISP. That is precisely what carrying DNS
            // through the tunnel exists to prevent, and it happened
            // silently at the one moment the table was under pressure.
            //
            // A lookup that does not answer is a page that does not
            // load, which the customer sees and can act on. A lookup
            // answered by their ISP is a record of where they went,
            // which they never learn about. The retry costs a moment;
            // the leak cannot be taken back.
            None => Verdict::Drop,
        };
    }

    if !selected {
        // Only remember the decision when the owner was actually known.
        //
        // Recording it on a miss was a real, reported bug: a TCP SYN can
        // reach here in the moment between the socket being created and
        // the connection table showing it, and pinning that connection
        // to Direct meant it stayed unprotected for its whole life --
        // however many times a lookup would have succeeded afterwards.
        // Browsers keep connections alive and reuse them, so one lost
        // race left Chrome showing the real IP until enough reloads
        // happened to open a fresh connection that won it. Reported
        // exactly that way: "had to refresh a few times until I see the
        // VPN ip".
        //
        // This is the same poisoning that OwnerLookup's image cache had
        // and it survived here, one layer up, because the cache fix
        // only stopped the *lookup* from going permanently wrong.
        //
        // Not recording it was only ever half the answer, and the half
        // that was written down here was wrong: it said the cost was a
        // repeat lookup on the SYN retransmit a second later. There is
        // no retransmit. A SYN that reaches here unredirected is sent
        // to the real destination, **which answers it**, so the
        // connection is established outside the tunnel and there is
        // never a second packet to decide about. That is why the miss
        // itself had to stop happening -- see
        // `OwnerLookup::image_for_new_connection`, which is what the
        // lookup above uses for a SYN.
        if known_owner {
            nat.record_direct(parsed.transport, parsed.source_port);
        }
        return Verdict::Direct;
    }

    let origin = Origin {
        addr: parsed.destination,
        port: parsed.destination_port,
        client: parsed.source,
        client_port: parsed.source_port,
        interface_id,
        upstream: None,
    };
    match nat.redirect(parsed.transport, origin) {
        Some(nat_port) => {
            stats.matched.fetch_add(1, Ordering::Relaxed);
            Verdict::Redirect { nat_port }
        }
        // Out of synthetic ports. Fail open, consistent with the rest of
        // the feature: unprotected traffic beats a stalled game.
        None => {
            nat.record_direct(parsed.transport, parsed.source_port);
            Verdict::Direct
        }
    }
}

fn rewrite_outbound(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    parsed: &Parsed,
    local_addr: Ipv4Addr,
    local_interface: u32,
    nat_port: u16,
    proxy_port: u16,
) {
    // Destination only: the source address stays as the app's, so both
    // ends of the rewritten packet are ordinary addresses on a real
    // interface. Sending it to 127.0.0.1 instead is what made two
    // earlier attempts fail.
    packet[16..20].copy_from_slice(&local_addr.octets());

    let ports = parsed.header_len;
    // The source port becomes the flow's synthetic port, which is how
    // the proxy tells one peer from another on a single UDP socket.
    packet[ports..ports + 2].copy_from_slice(&nat_port.to_be_bytes());
    packet[ports + 2..ports + 4].copy_from_slice(&proxy_port.to_be_bytes());

    // Injected on the link that owns the address it is now aimed at.
    // See `Redirect::local_interface`.
    //
    // SAFETY: this came from the network layer, so the Network arm of
    // the union is the live one.
    unsafe { address.union_field.Network.interface_id = local_interface };

    // Still outbound, and that is the whole fix.
    //
    // After the rewrite both ends of the packet are this machine's own
    // address. Re-injected outbound, IP output sees a local destination
    // and loops the packet back up to the listening socket, which is
    // what an ordinary connect() to your own address does. Re-injected
    // inbound it instead enters the receive path as something arriving
    // off the wire claiming one of our own addresses as its source, and
    // the stack drops it as spoofed before any socket is consulted.
    //
    // Nothing reports that loss. WinDivert's send succeeds either way,
    // so the redirect counts the packet and nothing is rejected; the
    // only symptom is the selected application hanging forever. On the
    // test rig, with the flip in place and the proxy confirmed
    // listening and idle:
    //
    //   seen=115 matched=2 redirected=10 returned=0 rejected=0
    //   TCP 0.0.0.0:49559 LISTENING     (and never a connection to it)
    //
    // The return leg is the opposite case and does flip: its source is
    // the real remote server, so arriving inbound is legitimate there.
}

fn rewrite_return_leg(
    packet: &mut [u8],
    address: &mut WINDIVERT_ADDRESS,
    parsed: &Parsed,
    nat: &Nat,
) -> bool {
    // The proxy addressed its reply to the flow's synthetic port, which
    // is what identifies the flow it belongs to.
    let Some(origin) = nat.origin(parsed.transport, parsed.destination_port) else {
        return false;
    };

    // Put the remote's identity back on it, so the app's socket
    // recognises the reply as coming from the address it dialled.
    packet[12..16].copy_from_slice(&origin.addr.octets());
    let ports = parsed.header_len;
    packet[ports..ports + 2].copy_from_slice(&origin.port.to_be_bytes());
    packet[ports + 2..ports + 4].copy_from_slice(&origin.client_port.to_be_bytes());

    address.set_outbound(false);
    // Restored because the stack routes an injected packet by its own
    // table, and this is the only record of where the app expects its
    // reply to arrive from.
    address.union_field.Network.interface_id = origin.interface_id;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(seen: u64, matched: u64, redirected: u64, returned: u64, rejected: u64) -> Stats {
        Stats {
            seen: AtomicU64::new(seen),
            matched: AtomicU64::new(matched),
            redirected: AtomicU64::new(redirected),
            returned: AtomicU64::new(returned),
            rejected: AtomicU64::new(rejected),
            blocked_v6: AtomicU64::new(0),
        }
    }

    #[test]
    fn a_warming_up_session_is_given_time_before_it_is_judged() {
        // Measured from a healthy start: 48 packets out and none back
        // before the firewall allowance became effective. Judged on the
        // count alone this said "nothing is coming back" about a
        // connection that went on to work perfectly.
        assert_eq!(stats(81, 16, 48, 0, 0).complaint(Duration::from_secs(3)), None);
    }

    #[test]
    fn the_same_counters_do_complain_once_it_has_had_time() {
        // Same numbers, later. Silence that persists is the real thing,
        // and the only difference between the two is how long it has
        // been allowed to continue.
        let c = stats(81, 16, 48, 0, 0)
            .complaint(WARMUP + Duration::from_secs(1))
            .expect("must complain once warmed up");
        assert!(c.contains("nothing is coming back"), "{c}");
    }

    #[test]
    fn a_fresh_session_complains_about_nothing() {
        // Every counter is zero for a moment after every connect. If
        // that read as a fault, Custom mode would report itself broken
        // every single time it started.
        assert_eq!(stats(0, 0, 0, 0, 0).complaint(WARMUP * 2), None);
    }

    #[test]
    fn traffic_flowing_both_ways_is_healthy() {
        assert_eq!(stats(4000, 900, 850, 800, 0).complaint(WARMUP * 2), None);
    }

    #[test]
    fn a_few_unanswered_packets_are_not_a_fault() {
        // A retransmit, or a host that is simply down. Condemning the
        // tunnel for this would make the warning worthless.
        assert_eq!(stats(300, 30, SILENT_AFTER - 1, 0, 0).complaint(WARMUP * 2), None);
    }

    #[test]
    fn sending_with_nothing_coming_back_is_reported() {
        // The tester's log, exactly: redirected=90, returned=0, while
        // the app showed Connected and Custom mode on.
        let c = stats(441, 90, 90, 0, 0).complaint(WARMUP * 2).expect("must complain");
        assert!(c.contains("nothing is coming back"), "{c}");
    }

    #[test]
    fn one_reply_is_enough_to_stay_quiet() {
        // The claim is "nothing comes back". A single reply disproves
        // it, and something quieter than a hard failure is happening.
        assert_eq!(stats(441, 90, 90, 1, 0).complaint(WARMUP * 2), None);
    }

    #[test]
    fn refused_injections_are_named_before_the_silence() {
        // Both conditions hold here. The refusal is the cause and the
        // silence is its consequence, so the refusal is what to say.
        let c = stats(500, 90, 90, 0, 90).complaint(WARMUP * 2).expect("must complain");
        assert!(c.contains("refusing"), "{c}");
    }

    #[test]
    fn intercepting_everything_and_matching_nothing_is_reported() {
        let c = stats(5000, 0, 0, 0, 0).complaint(WARMUP * 2).expect("must complain");
        assert!(c.contains("None of the apps you chose"), "{c}");
    }

    #[test]
    fn a_quiet_machine_that_matches_nothing_is_not_yet_a_fault() {
        // Below the threshold this is just an idle machine, and saying
        // "none of your apps have sent traffic" would be true but
        // useless noise a second after switching it on.
        assert_eq!(stats(10, 0, 0, 0, 0).complaint(WARMUP * 2), None);
    }

    /// A minimal IPv4 TCP packet, so the parser is exercised against
    /// bytes rather than against a struct built to suit it.
    fn tcp_packet(
        source: Ipv4Addr,
        destination: Ipv4Addr,
        source_port: u16,
        destination_port: u16,
        flags: u8,
    ) -> Vec<u8> {
        let mut packet = vec![0u8; 40];
        packet[0] = 0x45; // IPv4, 20-byte header
        packet[9] = IPPROTO_TCP;
        packet[12..16].copy_from_slice(&source.octets());
        packet[16..20].copy_from_slice(&destination.octets());
        packet[20..22].copy_from_slice(&source_port.to_be_bytes());
        packet[22..24].copy_from_slice(&destination_port.to_be_bytes());
        packet[33] = flags;
        packet
    }

    fn udp_packet(
        source: Ipv4Addr,
        destination: Ipv4Addr,
        source_port: u16,
        destination_port: u16,
    ) -> Vec<u8> {
        let mut packet = vec![0u8; 40];
        packet[0] = 0x45; // IPv4, 20-byte header
        packet[9] = IPPROTO_UDP;
        packet[12..16].copy_from_slice(&source.octets());
        packet[16..20].copy_from_slice(&destination.octets());
        packet[20..22].copy_from_slice(&source_port.to_be_bytes());
        packet[22..24].copy_from_slice(&destination_port.to_be_bytes());
        packet
    }

    #[test]
    fn parses_a_plain_tcp_packet() {
        let packet = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(1, 1, 1, 1),
            51234,
            443,
            TCP_FLAG_SYN,
        );
        let parsed = parse(&packet).expect("a well-formed packet should parse");

        assert_eq!(parsed.transport, Transport::Tcp);
        assert_eq!(parsed.source, Ipv4Addr::new(192, 168, 1, 20));
        assert_eq!(parsed.destination, Ipv4Addr::new(1, 1, 1, 1));
        assert_eq!(parsed.source_port, 51234);
        assert_eq!(parsed.destination_port, 443);
        assert_eq!(parsed.tcp_flags, TCP_FLAG_SYN);
    }

    #[test]
    fn honours_the_header_length_rather_than_assuming_twenty_bytes() {
        // IP options are rare but legal, and reading the ports at a
        // fixed offset would find payload bytes instead -- producing a
        // plausible port number and a redirect to nowhere.
        let mut packet = vec![0u8; 60];
        packet[0] = 0x46; // 24-byte header
        packet[9] = IPPROTO_TCP;
        packet[24..26].copy_from_slice(&4444u16.to_be_bytes());
        packet[26..28].copy_from_slice(&80u16.to_be_bytes());

        let parsed = parse(&packet).expect("options are legal");
        assert_eq!(parsed.header_len, 24);
        assert_eq!(parsed.source_port, 4444);
        assert_eq!(parsed.destination_port, 80);
    }

    #[test]
    fn refuses_packets_it_cannot_read_rather_than_indexing_past_the_end() {
        // A short or malformed packet must fall through to being passed
        // on untouched. Panicking here would take down a service running
        // as LocalSystem, and every packet on the machine goes past it.
        assert!(parse(&[]).is_none());
        assert!(parse(&[0x45]).is_none());
        assert!(parse(&vec![0x45; 25]).is_none(), "no protocol byte set");

        let mut truncated = vec![0u8; 24];
        truncated[0] = 0x45;
        truncated[9] = IPPROTO_TCP;
        assert!(parse(&truncated).is_none(), "the transport header is incomplete");

        let mut ipv6 = vec![0u8; 60];
        ipv6[0] = 0x60;
        assert!(parse(&ipv6).is_none());
    }

    #[test]
    fn the_outbound_rewrite_changes_the_destination_and_leaves_the_source() {
        // The exact shape that works. Rewriting the source too, or
        // aiming at loopback, are the two variants that were tried
        // against a real node and delivered nothing.
        let mut packet = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(1, 1, 1, 1),
            51234,
            443,
            TCP_FLAG_SYN,
        );
        let parsed = parse(&packet).unwrap();

        // No address argument: the rewrite cannot touch the direction,
        // so the packet stays outbound and the stack loops it back to
        // the proxy's socket. Flipping it to inbound made the stack
        // drop it as spoofed, since by then both ends are local.
        let mut address = WINDIVERT_ADDRESS::default();
        address.set_outbound(true);
        rewrite_outbound(
            &mut packet,
            &mut address,
            &parsed,
            Ipv4Addr::new(192, 168, 1, 20),
            5,
            41000,
            19999,
        );

        let after = parse(&packet).unwrap();
        assert_eq!(after.source, Ipv4Addr::new(192, 168, 1, 20), "source must be untouched");
        assert_eq!(after.destination, Ipv4Addr::new(192, 168, 1, 20));
        assert_eq!(after.source_port, 41000);
        assert_eq!(after.destination_port, 19999);
    }

    #[test]
    fn the_return_rewrite_undoes_the_outbound_one() {
        // The round trip is the property that matters: whatever the
        // outbound leg did, the app has to see a reply from the address
        // and port it originally dialled, or its socket discards it.
        let nat = Nat::new();
        let origin = Origin {
            addr: Ipv4Addr::new(1, 1, 1, 1),
            port: 443,
            client: Ipv4Addr::new(192, 168, 1, 20),
            client_port: 51234,
            interface_id: 12,
            upstream: None,
        };
        let nat_port = nat.redirect(Transport::Tcp, origin).unwrap();

        let mut reply = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(192, 168, 1, 20),
            19999,
            nat_port,
            TCP_FLAG_ACK,
        );
        let parsed = parse(&reply).unwrap();
        let mut address = WINDIVERT_ADDRESS::default();

        assert!(rewrite_return_leg(&mut reply, &mut address, &parsed, &nat));

        let after = parse(&reply).unwrap();
        assert_eq!(after.source, Ipv4Addr::new(1, 1, 1, 1));
        assert_eq!(after.source_port, 443);
        assert_eq!(after.destination_port, 51234);
        // SAFETY: a network-layer address in a test we built.
        assert_eq!(unsafe { address.union_field.Network.interface_id }, 12);
    }

    #[test]
    fn a_reply_for_an_unknown_flow_is_left_alone() {
        // Rewriting it would invent a source address. Passing it on
        // unchanged is harmless: nothing is listening for it.
        let nat = Nat::new();
        let mut reply = tcp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(192, 168, 1, 20),
            19999,
            41000,
            TCP_FLAG_ACK,
        );
        let parsed = parse(&reply).unwrap();
        let mut address = WINDIVERT_ADDRESS::default();
        assert!(!rewrite_return_leg(&mut reply, &mut address, &parsed, &nat));
    }

    #[test]
    fn a_lookup_is_carried_even_when_its_app_is_not_selected() {
        // The leak this closes, measured on the test rig in one run:
        //
        //   CUSTOM  tcp egress: 38.60.249.229   (the node)
        //   CUSTOM  dns egress: 50.34.35.228    (the customer's own line)
        //
        // A selected app's traffic went through the tunnel while the
        // name it asked about was resolved by the network being escaped.
        // On a censored connection that answer is a lie, so the site
        // will not open while an address check still shows the tunnel --
        // reported exactly that way from Iran.
        //
        // It cannot be done per-application, because Windows resolves
        // through its own DNS Client service rather than the asking
        // program, so the query never carries the app's name.
        assert!(is_dns(&parse(&udp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(192, 168, 1, 1),
            51000,
            53,
        ))
        .unwrap()));

        // Anything else still obeys the selection.
        assert!(!is_dns(&parse(&udp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(203, 0, 113, 9),
            51000,
            443,
        ))
        .unwrap()));
    }

    #[test]
    fn the_filter_excludes_the_node_and_every_local_destination() {
        // Each exclusion is load-bearing. The node's address carries the
        // tunnel itself; the private ranges are the LAN a split tunnel
        // is supposed to leave alone; the multicast range is the
        // mDNS/LLMNR/SSDP chatter a new adapter provokes, which would
        // otherwise send local hostnames to the VPN server.
        let filter = filter_for(&Redirect {
            local_addr: Ipv4Addr::new(192, 168, 1, 20),
            node_addr: Ipv4Addr::new(203, 0, 113, 7),
            tcp_proxy_port: 19999,
            udp_proxy_port: 19998,
            own_images: Vec::new(),
            own_sockets: Arc::new(OwnSockets::default()),
            dns_resolver: Ipv4Addr::new(1, 1, 1, 1),
            carry_dns: true,
            local_interface: 5,
        });

        assert!(filter.contains("ip.DstAddr != 203.0.113.7"));
        assert!(filter.contains("not loopback"));
        for range in ["10.0.0.0", "172.16.0.0", "192.168.0.0", "169.254.0.0", "224.0.0.0"] {
            assert!(filter.contains(range), "{range} must be excluded");
        }
        // `not (...)` is what the parser refuses, so its absence is
        // worth asserting rather than only catching in the compile test.
        assert!(!filter.contains("not ("));
        assert!(filter.contains("tcp.SrcPort == 19999"));
        assert!(filter.contains("udp.SrcPort == 19998"));
    }

    fn sample_redirect() -> Redirect {
        Redirect {
            local_addr: Ipv4Addr::new(192, 168, 1, 20),
            node_addr: Ipv4Addr::new(203, 0, 113, 7),
            tcp_proxy_port: 19999,
            udp_proxy_port: 19998,
            own_images: Vec::new(),
            own_sockets: Arc::new(OwnSockets::default()),
            dns_resolver: Ipv4Addr::new(1, 1, 1, 1),
            carry_dns: true,
            local_interface: 5,
        }
    }

    /// A minimal IPv6 TCP packet, with an optional extension-header
    /// chain in front of the transport header.
    fn ipv6_packet(destination: &str, destination_port: u16, chain: &[(u8, usize)]) -> Vec<u8> {
        // Each extension header here is written with an 8-byte body, so
        // its length field is `words - 1` in 8-byte units.
        let extension_bytes: usize = chain.iter().map(|(_, bytes)| *bytes).sum();
        let mut packet = vec![0u8; IPV6_HEADER + extension_bytes + 20];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&((extension_bytes + 20) as u16).to_be_bytes());
        packet[7] = 64; // hop limit
        let src: std::net::Ipv6Addr = "2001:db8::1".parse().unwrap();
        let dst: std::net::Ipv6Addr = destination.parse().unwrap();
        packet[8..24].copy_from_slice(&src.octets());
        packet[24..40].copy_from_slice(&dst.octets());

        // Walk the chain forwards, writing each header's "next" field.
        let mut cursor = IPV6_HEADER;
        let mut previous_next = 6usize; // the fixed header's Next Header
        for (kind, bytes) in chain {
            packet[previous_next] = *kind;
            if *kind == IPPROTO_FRAGMENT {
                // Offset and flags live in bytes 2..4; left at zero this
                // is the first fragment.
                previous_next = cursor;
            } else if *kind == IPPROTO_AH {
                packet[cursor + 1] = (bytes / 4 - 2) as u8;
                previous_next = cursor;
            } else {
                packet[cursor + 1] = (bytes / 8 - 1) as u8;
                previous_next = cursor;
            }
            cursor += bytes;
        }
        packet[previous_next] = IPPROTO_TCP;

        packet[cursor..cursor + 2].copy_from_slice(&51234u16.to_be_bytes());
        packet[cursor + 2..cursor + 4].copy_from_slice(&destination_port.to_be_bytes());
        packet[cursor + 12] = 0x50; // data offset
        packet[cursor + 13] = TCP_FLAG_SYN;
        packet
    }

    fn outbound_address(ipv6: bool) -> WINDIVERT_ADDRESS {
        let mut address = WINDIVERT_ADDRESS::default();
        address.set_layer(windivert_sys::WinDivertLayer::Network);
        address.set_event(windivert_sys::WinDivertEvent::NetworkPacket);
        address.set_outbound(true);
        address.set_ipv6(ipv6);
        address
    }

    /// A well-formed IPv4 TCP SYN, with the length fields the filter
    /// evaluator insists on -- `tcp_packet` above leaves them zero,
    /// which the evaluator rejects before it looks at an address.
    fn ipv4_syn(destination: Ipv4Addr, destination_port: u16) -> Vec<u8> {
        let mut packet = vec![0u8; 40];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&40u16.to_be_bytes());
        packet[8] = 64;
        packet[9] = IPPROTO_TCP;
        packet[12..16].copy_from_slice(&Ipv4Addr::new(192, 168, 1, 20).octets());
        packet[16..20].copy_from_slice(&destination.octets());
        packet[20..22].copy_from_slice(&51234u16.to_be_bytes());
        packet[22..24].copy_from_slice(&destination_port.to_be_bytes());
        packet[32] = 0x50;
        packet[33] = TCP_FLAG_SYN;
        packet
    }

    #[test]
    fn the_filter_used_to_be_blind_to_ipv6_and_no_longer_is() {
        // The measurement that started this, reduced to something a test
        // can hold. Asked of WinDivert's own evaluator -- the code the
        // driver runs -- rather than of a reading of the filter string,
        // because the shipped filter matched IPv4 and silently matched
        // no IPv6 at all, and nothing in the counters could say so: a
        // packet the driver never delivers leaves no trace to count.
        //
        // On a VM with a router-advertised IPv6 prefix the old filter
        // delivered ipv4=25 ipv6=0 while eight IPv6 packets left the
        // machine, one of them to a global-unicast address. See the
        // module comment.
        let filter = filter_for(&sample_redirect());
        let real_google_v6 = ipv6_packet("2607:f8b0:400a:809::200e", 443, &[]);

        assert!(
            super::super::divert::eval_filter(&filter, &real_google_v6, &outbound_address(true)),
            "an IPv6 connection to the internet must reach the loop"
        );
        assert!(
            super::super::divert::eval_filter(
                &filter,
                &ipv4_syn(Ipv4Addr::new(142, 250, 74, 78), 443),
                &outbound_address(false)
            ),
            "the IPv4 half must be unchanged"
        );
    }

    #[test]
    fn the_ipv6_half_leaves_the_local_network_alone() {
        // The IPv4 filter excludes the LAN so a split tunnel does not
        // disturb it, and the same has to hold here. Multicast matters
        // most: a tunnel coming up makes Windows spray mDNS and SSDP,
        // and over IPv6 that is ff02::fb and ff02::c.
        let filter = filter_for(&sample_redirect());
        for (address, why) in [
            ("fe80::1", "link-local"),
            ("fd00::950d:8fd1:26eb:d4a", "unique-local"),
            ("ff02::fb", "multicast mDNS"),
            ("::1", "loopback"),
            ("::ffff:8.8.8.8", "IPv4-mapped, which the IPv4 half handles"),
        ] {
            assert!(
                !super::super::divert::eval_filter(
                    &filter,
                    &ipv6_packet(address, 443, &[]),
                    &outbound_address(true)
                ),
                "{address} ({why}) must not be handed over"
            );
        }
    }

    #[test]
    fn reads_the_ports_of_a_plain_ipv6_packet() {
        let parsed = parse_v6(&ipv6_packet("2001:db8::2", 443, &[])).expect("must parse");
        assert_eq!(parsed.transport, Transport::Tcp);
        assert_eq!(parsed.source_port, 51234);
        assert_eq!(parsed.destination_port, 443);
        assert_eq!(parsed.tcp_flags, TCP_FLAG_SYN);
    }

    #[test]
    fn walks_the_extension_headers_rather_than_assuming_none() {
        // IPv6 puts optional headers between the fixed header and the
        // transport one, so the ports are not at a fixed offset. Reading
        // at 40 regardless would find option bytes, produce a plausible
        // port, attribute the flow to whatever process happened to own
        // it -- and, for a selected app, leave the real flow leaking.
        for chain in [
            vec![(IPPROTO_HOPOPTS, 8)],
            vec![(IPPROTO_DSTOPTS, 16)],
            vec![(IPPROTO_ROUTING, 24)],
            vec![(IPPROTO_AH, 12)],
            vec![(IPPROTO_HOPOPTS, 8), (IPPROTO_DSTOPTS, 8)],
            vec![(IPPROTO_FRAGMENT, 8)],
        ] {
            let packet = ipv6_packet("2001:db8::2", 443, &chain);
            let parsed = parse_v6(&packet).unwrap_or_else(|| panic!("{chain:?} should parse"));
            assert_eq!(parsed.destination_port, 443, "{chain:?}");
            assert_eq!(parsed.source_port, 51234, "{chain:?}");
        }
    }

    #[test]
    fn refuses_an_ipv6_packet_whose_ports_it_cannot_find() {
        // Each of these has to come back None so the caller falls to the
        // unknown-owner rule instead of inventing an attribution. A
        // wrong one here either leaks a selected app's traffic or stops
        // an unselected app's, and both are worse than "cannot tell".
        assert!(parse_v6(&[]).is_none());
        assert!(parse_v6(&[0x60; 20]).is_none(), "shorter than a v6 header");

        let mut truncated = ipv6_packet("2001:db8::2", 443, &[]);
        truncated.truncate(IPV6_HEADER + 6);
        assert!(parse_v6(&truncated).is_none(), "the transport header is incomplete");

        // A later fragment carries no ports at all.
        let mut later_fragment = ipv6_packet("2001:db8::2", 443, &[(IPPROTO_FRAGMENT, 8)]);
        later_fragment[IPV6_HEADER + 2..IPV6_HEADER + 4]
            .copy_from_slice(&(185u16 << 3).to_be_bytes());
        assert!(parse_v6(&later_fragment).is_none(), "a later fragment has no ports");

        // A chain long enough to be an attack rather than a packet.
        let endless = vec![(IPPROTO_DSTOPTS, 8); MAX_EXTENSION_HEADERS + 2];
        assert!(parse_v6(&ipv6_packet("2001:db8::2", 443, &endless)).is_none());

        // IPv4 must not be answered by the IPv6 reader.
        assert!(parse_v6(&ipv4_syn(Ipv4Addr::new(1, 1, 1, 1), 443)).is_none());
    }

    /// The live rig the module comment's before/after numbers came from.
    ///
    /// Ignored because it needs three things no unit test has:
    /// administrator rights to open a WinDivert handle, a machine with
    /// working IPv6, and real traffic. Everything it runs is the
    /// production path -- the real filter, the real relays, the real
    /// owner lookup -- with only the tunnel absent: `TunnelInterface`
    /// is left cleared, which is the fail-open case the proxy already
    /// has, so a redirected IPv4 flow is carried straight out instead of
    /// through a node. That is deliberate. It keeps a live node out of
    /// the loop while still exercising interception, attribution,
    /// rewriting and relaying, which are the parts this change touches.
    /// It proves nothing about encryption and is not evidence about it.
    ///
    /// Told where it is by environment, so one binary runs on any rig:
    ///
    /// ```text
    /// NEOX_LOCAL_ADDR  this machine's address on the physical link
    /// NEOX_LOCAL_IF    that link's interface index
    /// NEOX_V6_URL      a global-unicast IPv6 URL that must be blocked
    /// NEOX_V4_URL      a URL that must keep working through the relay
    /// NEOX_DUAL_URL    a name with both an A and a blocked AAAA record
    /// ```
    #[test]
    #[ignore]
    fn live_custom_mode_blocks_ipv6_and_keeps_carrying_ipv4() {
        use super::super::{firewall, proxy};
        use neoconnect_ipc::SplitTunnelMode;
        use std::process::Command;
        use std::sync::RwLock;

        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set"));
        let local_addr: Ipv4Addr = env("NEOX_LOCAL_ADDR").parse().expect("NEOX_LOCAL_ADDR");
        let local_interface: u32 = env("NEOX_LOCAL_IF").parse().expect("NEOX_LOCAL_IF");
        let curl = r"C:\Windows\System32\curl.exe";

        let nat = Arc::new(Nat::new());
        // Index zero is the fail-open signal, so this is a relay with no
        // tunnel under it rather than one pointed at a broken tunnel.
        let tunnel = Arc::new(proxy::TunnelInterface::new(0, Ipv4Addr::UNSPECIFIED));
        let relays = proxy::start(nat.clone(), tunnel).expect("relays must start");
        let mut allowance =
            firewall::Allowance::install(&[local_addr], relays.tcp_port, relays.udp_port)
                .expect("the inbound allowance must install");
        firewall::wait_until_reachable(local_addr, relays.tcp_port).expect("relay must be up");

        let selection: SharedSelection = Arc::new(RwLock::new(Selection::new(
            [curl.to_string()],
            SplitTunnelMode::OnlySelected,
        )));
        let own = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        let running = start(
            Redirect {
                local_addr,
                node_addr: Ipv4Addr::new(203, 0, 113, 7),
                tcp_proxy_port: relays.tcp_port,
                udp_proxy_port: relays.udp_port,
                own_images: vec![own],
                own_sockets: relays.own_sockets.clone(),
                local_interface,
                // Left off on purpose. Carrying DNS points every lookup
                // on the machine at a resolver reached through a tunnel
                // that does not exist here, which would take name
                // resolution out for the whole rig for the length of
                // the test.
                carry_dns: false,
                dns_resolver: Ipv4Addr::new(1, 1, 1, 1),
            },
            nat,
            selection,
        )
        .expect("the redirect loop must start");

        let fetch = |url: String, family: &str| -> (bool, Duration) {
            let began = std::time::Instant::now();
            let out = Command::new(curl)
                .args([family, "-s", "-o", "NUL", "--max-time", "8", &url])
                .output()
                .expect("curl must run");
            (out.status.success(), began.elapsed())
        };

        let (v6_reached, _) = fetch(env("NEOX_V6_URL"), "-6");
        let (v4_reached, _) = fetch(env("NEOX_V4_URL"), "-4");
        let (dual_reached, dual_took) = fetch(env("NEOX_DUAL_URL"), "-s");

        let summary = running.stats.summary();
        let blocked = running.stats.blocked_v6.load(Ordering::Relaxed);
        running.stop();
        relays.stop();
        allowance.remove();

        println!("{summary}");
        println!("v6 reached={v6_reached} v4 reached={v4_reached} dual={dual_reached} in {dual_took:?}");

        assert!(blocked > 0, "IPv6 from the selected app must have been dropped: {summary}");
        assert!(!v6_reached, "the IPv6-only destination must not have been reached");
        assert!(v4_reached, "IPv4 must still be carried: {summary}");
        // The point of blocking rather than carrying: a destination
        // that has both records is still reached, over IPv4.
        assert!(dual_reached, "a dual-stack destination must still connect over IPv4");
    }

    #[test]
    fn the_filter_the_driver_gets_actually_compiles() {
        // A filter string is only checked when the driver parses it, so
        // a typo in the expression above would otherwise surface as
        // Custom mode failing to start on a customer's machine.
        let filter = filter_for(&Redirect {
            local_addr: Ipv4Addr::new(192, 168, 1, 20),
            node_addr: Ipv4Addr::new(203, 0, 113, 7),
            tcp_proxy_port: 19999,
            udp_proxy_port: 19998,
            own_images: Vec::new(),
            own_sockets: Arc::new(OwnSockets::default()),
            dns_resolver: Ipv4Addr::new(1, 1, 1, 1),
            carry_dns: true,
            local_interface: 5,
        });
        super::super::divert::compile_filter(&filter).expect("the filter must compile");
    }
}
