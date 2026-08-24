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
use std::time::{Duration, Instant};

use neoconnect_ipc::SplitTunnelMode;

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

/// How long after activation a selected app's pre-existing TCP
/// connections are refused rather than exempted.
///
/// This exists because closing them at the moment Custom mode starts
/// cannot close all of them. `SetTcpEntry` can only tear down an
/// ESTABLISHED connection -- there is no variant that works on one still
/// in `SYN_SENT` -- so a connection that happens to be half-open at that
/// instant survives the reset, completes a moment later against the real
/// destination, and is then met by the mid-connection rule below, which
/// exempts it permanently. A browser keeps such a socket alive and reuses
/// it, so the customer sees their own address for minutes with Custom
/// mode switched on. That is issue 9 in the handover, and the same class
/// of dishonesty as a false "Connected".
///
/// Three seconds because it has to cover a SYN that is retransmitting on
/// a slow or half-dead host: Windows sends the second SYN about a second
/// after the first and the third about two seconds after that, so three
/// seconds covers the common case of a connection that completes late
/// without holding the window open long enough to matter. It is a window
/// in which a selected app's *pre-existing* connections fail and are
/// remade through the tunnel -- an application handles that routinely,
/// it is what happens when a network changes -- and it deliberately does
/// not extend to anything else.
///
/// The same value bounds the reset's convergence loop (see
/// `split_tunnel::Convergence`), and it must: the drop is only defensible
/// while something is still working to close these connections properly.
/// A window that outlived the loop would be a period where a selected
/// app simply could not use a connection it already had, with nothing
/// arranging for it to get a better one.
pub const ACTIVATION_GRACE: Duration = Duration::from_secs(3);

const IPPROTO_TCP: u8 = 6;
const IPPROTO_UDP: u8 = 17;
const TCP_FLAG_SYN: u8 = 0x02;
const TCP_FLAG_ACK: u8 = 0x10;
const TCP_FLAG_FIN: u8 = 0x01;
const TCP_FLAG_RST: u8 = 0x04;

/// The hop limit put on a synthesised reset.
///
/// It never crosses a router -- the packet is injected straight into
/// this machine's receive path -- so the value only has to be something
/// no stack objects to. 64 is what everything else uses.
const RESET_HOP_LIMIT: u8 = 64;

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
    /// Connections found living outside the tunnel that should be
    /// inside it -- see `owner::escaped_connections`.
    ///
    /// The only number here that is not counted from inside the packet
    /// loop, and it exists because every number that *is* counted there
    /// is blind in the same direction. The loop can only describe
    /// packets it was handed; a connection that escaped -- a SYN that
    /// raced the owner lookup, a socket established before Custom mode
    /// came on, an IPv6 connection blocked rather than carried --
    /// produces no packet the loop will ever see. Every counter above
    /// reads healthy while it carries the customer's traffic out in the
    /// clear, which is precisely how this failed in 0.9.20, 0.9.25 and
    /// 0.9.27. This is read from the machine's own connection tables
    /// instead, every thirty seconds.
    ///
    /// A **gauge, not a total**: it holds what the most recent sweep
    /// found. The same connection is one escape for as long as it lives,
    /// so adding each sweep up would report a number that grows with how
    /// long Custom mode has been on rather than with how much has got
    /// away -- and a number that only ever climbs is one nobody can read
    /// a trend out of.
    ///
    /// Deliberately not consulted by [`Stats::complaint`] in this
    /// version. It has never been read against a packet capture, and
    /// this project does not let the app tell a customer something is
    /// wrong on the strength of a number nobody has checked against the
    /// wire yet.
    pub escaped: AtomicU64,
    /// Mid-connection packets refused during the activation window --
    /// see [`ACTIVATION_GRACE`].
    ///
    /// Counted, like `blocked_v6`, because it reports a *deliberate*
    /// refusal rather than a fault, and because a drop that nothing
    /// records is the one kind of change to this loop that cannot be
    /// argued about afterwards. Non-zero here is normal for the first
    /// three seconds of a session in which a selected application was
    /// already running, and means nothing at all after that.
    pub grace_dropped: AtomicU64,
    /// Resets injected back to an application whose IPv6 was blocked,
    /// and accepted by the driver.
    ///
    /// Counted after the injection rather than after the build, for the
    /// reason `redirected` is: a run where every reset was constructed
    /// and every injection refused would otherwise be indistinguishable
    /// from one that worked, and the whole point of the reset is that
    /// the application finds out.
    ///
    /// A refused injection is deliberately *not* folded into `rejected`.
    /// `complaint` treats `rejected` as evidence that redirected traffic
    /// is not arriving, and a dual-stack network produces resets
    /// continuously -- so a failure here would light a warning about
    /// something else entirely.
    pub reset_v6: AtomicU64,
    /// Datagrams the relay could not hand on towards their destination.
    ///
    /// The relay used to discard the result of that send entirely
    /// (`let _ = upstream.send_to(..)`), which made it a silent loss
    /// point on the exact path voice and gaming depend on -- and an
    /// invisible one from every angle, because a datagram that never
    /// leaves the relay is still counted `redirected` by the loop that
    /// handed it over. `returned` staying at zero was the only trace,
    /// and that reads identically to a tunnel that is not carrying
    /// traffic, which is a different fault with a different fix.
    ///
    /// The behaviour on failure is unchanged -- the datagram is dropped
    /// and the next one is served. UDP has no retransmission to hook
    /// into and the application above has its own; retrying here would
    /// duplicate a datagram the application may already have resent.
    pub udp_send_failed: AtomicU64,
    /// Replies the relay could not hand back to the application.
    ///
    /// Counted apart from `udp_send_failed` because the two point at
    /// opposite halves of the machine. A failure sending upstream says
    /// something about the tunnel; a failure sending back to the
    /// application over loopback says something about this host. Folded
    /// together they would be one number that cannot answer either
    /// question.
    pub udp_reply_failed: AtomicU64,
    /// Datagrams dropped because their flow never got an upstream
    /// socket -- see `proxy::PendingFlows`.
    ///
    /// Either the bind was still failing after the full retry, or the
    /// flow held its cap of datagrams while it waited. Both are the
    /// tentative-address window of 0.9.20 outlasting the patience the
    /// relay has for it, and both used to be a `continue`.
    pub udp_unbound: AtomicU64,
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
            "seen={} matched={} redirected={} returned={} rejected={} blocked_v6={} escaped={} \
             grace_dropped={} reset_v6={} udp_send_failed={} udp_reply_failed={} udp_unbound={}",
            self.seen.load(Ordering::Relaxed),
            self.matched.load(Ordering::Relaxed),
            self.redirected.load(Ordering::Relaxed),
            self.returned.load(Ordering::Relaxed),
            self.rejected.load(Ordering::Relaxed),
            self.blocked_v6.load(Ordering::Relaxed),
            self.escaped.load(Ordering::Relaxed),
            self.grace_dropped.load(Ordering::Relaxed),
            self.reset_v6.load(Ordering::Relaxed),
            self.udp_send_failed.load(Ordering::Relaxed),
            self.udp_reply_failed.load(Ordering::Relaxed),
            self.udp_unbound.load(Ordering::Relaxed),
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
    ///
    /// The three `udp_*` counters are not consulted here either, for the
    /// reason `escaped` is not: they have never been read against a
    /// packet capture. They exist so that a loss which used to leave no
    /// trace at all shows up in the log the moment somebody looks; what
    /// threshold on them means "tell the customer something is wrong" is
    /// a question the rig has to answer first. Until it has, this
    /// function does not speak on their behalf.
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
    /// When interception began, which is what the activation window is
    /// measured from -- see [`ACTIVATION_GRACE`].
    ///
    /// State on the redirect rather than a global, deliberately. Two
    /// sessions can overlap for a moment during a failover -- Custom
    /// mode is stopped and restarted against the new adapter -- and a
    /// process-wide clock would let the outgoing session's age decide
    /// what the incoming one does with a packet.
    ///
    /// Whatever the caller puts here is overwritten by [`start`]. The
    /// window has to begin when packets begin arriving, not when the
    /// struct was assembled, and the gap between the two is a route
    /// probe and a firewall wait -- seconds, on the path where this
    /// matters most.
    pub activated: Instant,
}

impl Redirect {
    /// Whether the activation reset is still converging, so a
    /// pre-existing connection should be refused rather than exempted.
    fn within_activation_grace(&self) -> bool {
        self.activated.elapsed() < ACTIVATION_GRACE
    }
}

/// Whether a mid-connection packet should be dropped rather than
/// permanently exempted, because the activation reset has not finished
/// yet.
///
/// Split out from [`decide`] because it is the whole of the new
/// behaviour and every one of its clauses is load-bearing:
///
/// * **Only inside the window.** Outside it, the mid-connection rule is
///   right and has been for a long time: a connection that predates
///   Custom mode holds a socket to the real destination, and rewriting
///   half of a live connection is not a redirect, it is breaking it.
/// * **Only `OnlySelected`.** In `AllExcept` an unknown owner means
///   "carry it", so the same rule there would refuse traffic belonging to
///   programs nobody has identified -- including, for the first seconds
///   of a session, most of the machine. Changing that direction needs its
///   own evidence and is not part of this wave.
/// * **Only a known owner.** A miss must never cause a drop. Attributing
///   a packet is exactly the thing this file has been wrong about
///   before, and the cost of being wrong here lands on an application the
///   customer never selected.
/// * **Never this service's own.** The proxy's upstream sockets look
///   like any other application's, and refusing them would take out the
///   relay carrying everything else.
fn drop_while_converging(
    within_grace: bool,
    selection: &Selection,
    owner_image: Option<&str>,
    is_own: bool,
) -> bool {
    within_grace
        && matches!(selection.mode(), SplitTunnelMode::OnlySelected)
        && !is_own
        && owner_image.map(|image| selection.should_tunnel(image)).unwrap_or(false)
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

    /// A handle that can stop interception from another thread, without
    /// owning the session or being able to join it.
    ///
    /// This exists for the backstop in `split_tunnel::Watchdog`, which
    /// runs *inside* the session and therefore cannot take the session
    /// apart. What it can do is the one thing that matters to somebody
    /// whose machine has stopped working: close the driver's grip on it.
    pub fn stopper(&self) -> Stopper {
        Stopper { handle: self.handle.clone(), stop: self.stop.clone() }
    }
}

/// The half of a running redirect that can switch it off.
///
/// Deliberately cannot join the workers. Joining from a thread that the
/// session owns would deadlock the teardown that is trying to join *it*,
/// and the whole point of this type is to be safe to hold from the
/// inside. `Running::stop` still joins afterwards; the flag and the
/// shutdown are both idempotent, so the two cannot get in each other's
/// way whichever order they arrive in.
#[derive(Clone)]
pub struct Stopper {
    handle: Arc<Handle>,
    stop: Arc<AtomicBool>,
}

impl Stopper {
    /// Stops taking packets off the machine. Everything the session
    /// still holds -- relays, firewall allowance, route -- stays until
    /// somebody tears it down properly, but nothing is being intercepted
    /// any more, which is what fails the machine open.
    pub fn stop_intercepting(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.shutdown();
    }
}

/// `stats` is passed in rather than created here because the relay
/// counts into the same table -- see `Stats::udp_send_failed` -- and the
/// relay is started first, before the firewall allowance and the
/// reachability wait that sit between the two.
pub fn start(
    mut redirect: Redirect,
    nat: Arc<Nat>,
    selection: SharedSelection,
    stats: Arc<Stats>,
) -> Result<Running, String> {
    // Stamped here rather than trusted from the caller: the window has
    // to start when packets start arriving. Between the caller building
    // this struct and the driver handing over a first packet sit a route
    // probe and a wait for the firewall rule to become effective, which
    // on the path where any of this matters take seconds -- long enough
    // to spend the whole grace window before a single packet is seen.
    redirect.activated = Instant::now();

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
        let mut reset = None;
        let rewrote = handle_packet(
            &mut packet[..len as usize],
            &mut address,
            &redirect,
            &nat,
            &chosen,
            &mut owner,
            &stats,
            &mut reset,
        );

        // Released before the send: nothing below consults it, and a
        // lock held across a syscall would make every other worker wait
        // on this one.
        drop(chosen);

        // Injected before the original packet is dealt with, so the
        // application learns its connection is gone in the same breath
        // as the segment being refused. It is built from that segment
        // and does not touch it -- see `build_v6_reset`.
        if let Some(reset) = reset {
            inject_v6_reset(&handle, &reset, &address, &stats);
        }

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
    /// Where the transport header begins, after however many extension
    /// headers this packet carried.
    ///
    /// Added when the block gained a reset. Everything above can be
    /// decided from the ports alone, but building a reset the
    /// application's own stack will accept means reading the sequence
    /// numbers out of the segment being refused -- and those are not at
    /// a fixed offset for exactly the reason `parse_v6` exists.
    transport_offset: usize,
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
            transport_offset: offset,
        });
    }
    None
}

/// A TCP reset addressed back to the application, built from the packet
/// being refused.
///
/// # Why a blocked connection is told rather than left hanging
///
/// Blocking a selected application's IPv6 is the right answer -- see the
/// module comment -- but *silently* blocking it is not the same thing.
/// A new connection recovers on its own: the SYN is swallowed, no answer
/// comes, and every browser and every resolver falls back to the A
/// record within a fraction of a second. Measured at 385ms on the rig.
///
/// A connection that already existed does not recover. The application
/// holds a socket it believes is fine, its segments vanish, and TCP does
/// what TCP does about a black hole: it retransmits, backs off, and
/// keeps the socket for minutes before giving up. Nothing tells it there
/// is a perfectly good IPv4 path to the same host. So Custom mode coming
/// on turned a working page into a hang, and the counters read
/// `blocked_v6` climbing, which looks exactly like the feature working.
///
/// A reset converts that into the case that already recovers. The
/// application is told its connection is gone -- which it is -- and
/// opens a new one, which fails over to IPv4 in milliseconds.
///
/// # Why it is built from the packet in hand
///
/// A stack does not accept any reset addressed at it; a reset outside
/// the receive window is discarded, which is the whole reason blind
/// reset attacks are hard. The one already in the window is the one
/// derived from a segment the socket just sent: its acknowledgement
/// number is, by definition, the sequence number the peer would next
/// send from. So the reset is sent with `seq` equal to that
/// acknowledgement, and acknowledges everything the segment consumed.
/// A pure SYN carries no acknowledgement to borrow, so a reset for one
/// starts at zero and acknowledges the initial sequence number, which is
/// what a refusing host sends.
///
/// UDP gets no equivalent, and cannot: there is no in-band way to tell a
/// datagram socket that its peer is unreachable, so a selected
/// application's IPv6 UDP stays silently swallowed. That is a gap, and
/// this comment is where it is stated rather than a decision hidden in
/// the shape of the code.
fn build_v6_reset(packet: &[u8], parsed: &ParsedV6) -> Option<Vec<u8>> {
    if !matches!(parsed.transport, Transport::Tcp) {
        return None;
    }
    // Never answer a reset with a reset. The connection is already gone
    // and the two ends would otherwise have something to say to each
    // other about it.
    if parsed.tcp_flags & TCP_FLAG_RST != 0 {
        return None;
    }

    let tcp = packet.get(parsed.transport_offset..parsed.transport_offset + 14)?;
    let their_seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);
    let their_ack = u32::from_be_bytes([tcp[8], tcp[9], tcp[10], tcp[11]]);
    // The data offset is in 32-bit words and cannot legally be under
    // five; a malformed one is clamped rather than trusted, because it
    // is subtracted below and an under-count would acknowledge bytes
    // that were never sent.
    let data_offset = (((tcp[12] >> 4) as usize) * 4).max(20);

    // How much sequence space the segment being refused consumed, which
    // is what the reset has to acknowledge. `payload_length` counts
    // everything after the fixed header; the captured packet may be
    // shorter than it claims, so the smaller of the two is used.
    let declared = IPV6_HEADER + u16::from_be_bytes([*packet.get(4)?, *packet.get(5)?]) as usize;
    let segment = declared.min(packet.len()).checked_sub(parsed.transport_offset)?;
    let consumed = segment.saturating_sub(data_offset) as u32
        + u32::from(parsed.tcp_flags & TCP_FLAG_SYN != 0)
        + u32::from(parsed.tcp_flags & TCP_FLAG_FIN != 0);

    let (seq, ack) = if parsed.tcp_flags & TCP_FLAG_ACK != 0 {
        (their_ack, their_seq.wrapping_add(consumed))
    } else {
        // A first SYN. Nothing has been acknowledged yet, so there is
        // no number to borrow and the reset starts where a refusing
        // host starts.
        (0, their_seq.wrapping_add(consumed))
    };

    let source = packet.get(8..24)?;
    let destination = packet.get(24..40)?;

    let mut reset = vec![0u8; IPV6_HEADER + 20];
    reset[0] = 0x60;
    reset[4..6].copy_from_slice(&20u16.to_be_bytes());
    reset[6] = IPPROTO_TCP;
    reset[7] = RESET_HOP_LIMIT;
    // Both ends swapped: this has to look like the remote answering.
    reset[8..24].copy_from_slice(destination);
    reset[24..40].copy_from_slice(source);

    let tcp = IPV6_HEADER;
    reset[tcp..tcp + 2].copy_from_slice(&parsed.destination_port.to_be_bytes());
    reset[tcp + 2..tcp + 4].copy_from_slice(&parsed.source_port.to_be_bytes());
    reset[tcp + 4..tcp + 8].copy_from_slice(&seq.to_be_bytes());
    reset[tcp + 8..tcp + 12].copy_from_slice(&ack.to_be_bytes());
    reset[tcp + 12] = 0x50; // data offset: five words, no options
    reset[tcp + 13] = TCP_FLAG_RST | TCP_FLAG_ACK;
    // Window, checksum and urgent pointer stay zero. The checksum is
    // computed by the driver's own helper at injection, because a
    // hand-rolled one that is wrong is discarded by the receiving stack
    // without a word -- which would put this straight back to the silent
    // black hole it exists to remove.
    Some(reset)
}

/// Hands a synthesised reset to the driver, addressed the way the
/// application expects to receive it.
///
/// Inbound, on the interface the original packet was seen on. The same
/// reasoning as the return leg: a packet whose source is the real remote
/// is legitimate arriving inbound, and the interface is the only record
/// of where the application's socket expects its peer to be.
fn inject_v6_reset(
    handle: &Handle,
    reset: &[u8],
    original: &WINDIVERT_ADDRESS,
    stats: &Stats,
) {
    let mut address = *original;
    address.set_outbound(false);
    address.set_ipv6(true);

    let mut packet = reset.to_vec();
    let len = packet.len() as u32;
    recalculate_checksums(&mut packet, len, &mut address);

    if handle.send(&packet, len, &address) {
        stats.reset_v6.fetch_add(1, Ordering::Relaxed);
    }
    // A refusal is deliberately not counted anywhere. `rejected` is what
    // `complaint` reads to decide that redirected traffic is not
    // arriving, and on a dual-stack network these are produced
    // continuously -- so folding a failure here into that number would
    // light a warning about something else entirely.
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
    reset: &mut Option<Vec<u8>>,
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
        // Told, not merely stopped. A new connection recovers from
        // silence on its own -- the SYN goes unanswered and the
        // application falls back to the A record in milliseconds -- but
        // one that already existed does not: it retransmits into a black
        // hole for minutes while the customer watches a page hang with
        // Custom mode switched on. See `build_v6_reset`.
        //
        // Only TCP. UDP has no in-band way to say this and stays
        // silently swallowed, which is a gap and is stated as one.
        *reset = build_v6_reset(packet, &parsed);
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
    reset: &mut Option<Vec<u8>>,
) -> Option<Leg> {
    // Decided before anything below is consulted, because none of it can
    // carry an IPv6 packet: the NAT table, the rewrite and the proxy's
    // upstream socket are all IPv4, and so is the address on the tunnel
    // adapter they would send it to.
    if packet.first().map(|first| first >> 4) == Some(6) {
        return handle_ipv6(packet, redirect, selection, owner, stats, reset);
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
    //
    // That is right in general and wrong for the first seconds of a
    // session, and the difference is what this branch now makes.
    // Activation closes a selected app's existing connections so they
    // are rebuilt through the tunnel -- but `SetTcpEntry` cannot close a
    // connection that is still in `SYN_SENT`, and one that was half-open
    // at that instant completes a moment later against the real
    // destination. It then arrives here as an ordinary mid-connection
    // packet, is exempted, and lives outside the tunnel for as long as
    // the application keeps it -- which for a browser is minutes.
    //
    // Inside the window, refuse it instead. The application sees the
    // connection fail, which is a thing every application handles, and
    // opens a new one that this loop is on time for. Outside the window
    // the old behaviour returns unchanged. See `drop_while_converging`
    // for why each clause of the test is there.
    if matches!(parsed.transport, Transport::Tcp) && !is_new_connection {
        if redirect.within_activation_grace() {
            // Not `image_for_new_connection`: this packet is not opening
            // a connection, and forcing a table rebuild for every
            // mid-connection packet on the machine for three seconds
            // would be a table walk per packet at the busiest moment a
            // session has.
            let image = owner.image_for_port(Family::V4, parsed.transport, parsed.source_port);
            let is_own = image
                .map(|image| {
                    redirect
                        .own_images
                        .iter()
                        .any(|own| image.eq_ignore_ascii_case(own))
                })
                .unwrap_or(false);
            if drop_while_converging(true, selection, image, is_own) {
                stats.grace_dropped.fetch_add(1, Ordering::Relaxed);
                return Verdict::Drop;
            }
        }
        nat.record_direct(parsed.transport, parsed.source_port);
        return Verdict::Direct;
    }

    // A SYN asks the more insistent question -- see
    // `image_for_new_connection`. This is the one packet whose answer
    // decides where a whole connection lives, and the one whose miss
    // cannot be taken back afterwards.
    //
    // A UDP datagram that has reached this line asks exactly the same
    // question, and until now it was not being asked. `is_new_connection`
    // is SYN-only, because UDP has no SYN -- but the flow table and the
    // leave-alone cache between them say the same thing a SYN says: both
    // were consulted above, and reaching here means this datagram belongs
    // to a flow nothing is carrying and nothing has decided about. For
    // UDP that *is* the new-flow signal, and it is available without any
    // help from the protocol.
    //
    // What it costs to keep missing it is the 0.9.25 bug arriving over
    // UDP. A socket is microseconds old when it sends its first
    // datagram, which puts that datagram inside `MIN_REFRESH_INTERVAL`,
    // where the owner lookup will not rebuild and answers "nobody". In
    // `OnlySelected` that means leave it alone, so a selected app's very
    // first datagram goes out direct -- and for a browser that datagram
    // is the QUIC Initial. Twenty milliseconds later the snapshot is
    // stale enough to rebuild, datagram two is attributed correctly and
    // redirected, and the handshake is now split across two paths with
    // two source addresses. It does not fail fast: the browser waits out
    // its whole QUIC timeout before falling back to TCP.
    //
    // The residual cost is one extra pair of table walks per UDP flow
    // whose owner cannot be resolved at all, since those record nothing
    // and so ask again on the next datagram. That is the same trade
    // `image_for_new_connection` already accepted for SYNs, and it is
    // bounded by how rare an unattributable UDP source port is -- a live
    // socket is in the table from the moment it is created. It has not
    // been measured under load; see the rig note.
    let opens_a_flow = is_new_connection || matches!(parsed.transport, Transport::Udp);
    let owner_image = if opens_a_flow {
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
        //
        // # The measured gap this arm cannot close
        //
        // A UDP socket that is closed immediately after its send leaks
        // in `OnlySelected`, and no amount of asking harder fixes it.
        // Windows drops the port from the UDP endpoint table when the
        // socket closes, and this loop is handed the datagram after the
        // send returns -- so by the time `image_for_new_connection`
        // rebuilds, the row naming the owner is already gone. No owner
        // means `tunnel_when_owner_unknown()`, which in `OnlySelected`
        // is false, which is "leave it alone". The datagram egresses in
        // clear text from a selected application.
        //
        // Measured on the rig, twice: a selected program sending 15
        // datagrams from 15 sockets, each closed microseconds after the
        // send, put 13 and 14 of them respectively on the wire
        // unredirected. It is reproducible, it is not a race that
        // retrying wins, and it is the one hole the redesign of the
        // paragraph above did not close.
        //
        // It is deliberately not the browser case, and the same session
        // measured that too: a real QUIC client holds its socket open
        // for the life of the connection, so the second datagram is
        // always attributable and the first is caught by
        // `image_for_new_connection`. Chrome went from 219 plaintext
        // UDP/443 datagrams before activation to 0 after. What is left
        // is fire-and-forget senders -- a beacon, a one-shot resolver, a
        // telemetry ping -- which is a smaller shape than QUIC and still
        // real.
        //
        // Closing it needs a mechanism that does not depend on the
        // socket still existing when the packet is classified. A WFP
        // filter at `FWPM_LAYER_ALE_AUTH_CONNECT_V4` keyed on
        // `FWPM_CONDITION_ALE_APP_ID` is classified by the kernel at
        // send time, inside the sending process, where the owner is not
        // a lookup but the caller -- the B2 proposal on the roadmap.
        // `engines/ipv6_block.rs` already builds and installs a dynamic
        // filter set from this service, so the machinery exists; what is
        // missing is the decision about what such a filter should do
        // with a datagram it cannot hand to the relay.
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
            escaped: AtomicU64::new(0),
            grace_dropped: AtomicU64::new(0),
            reset_v6: AtomicU64::new(0),
            udp_send_failed: AtomicU64::new(0),
            udp_reply_failed: AtomicU64::new(0),
            udp_unbound: AtomicU64::new(0),
        }
    }

    #[test]
    fn the_relays_own_udp_losses_reach_the_log() {
        // The counters are only worth adding if somebody reads them, and
        // the only place anybody reads them is this line. A number that
        // is incremented and never printed is the same silence it was
        // meant to end.
        let counters = stats(1, 1, 1, 1, 0);
        counters.udp_send_failed.store(4, Ordering::Relaxed);
        counters.udp_reply_failed.store(5, Ordering::Relaxed);
        counters.udp_unbound.store(6, Ordering::Relaxed);

        let summary = counters.summary();
        assert!(summary.contains("udp_send_failed=4"), "got {summary}");
        assert!(summary.contains("udp_reply_failed=5"), "got {summary}");
        assert!(summary.contains("udp_unbound=6"), "got {summary}");
    }

    #[test]
    fn the_relays_udp_losses_do_not_speak_to_the_customer_yet() {
        // Deliberate, and the same decision `escaped` carries: these
        // numbers have never been read against a packet capture, and
        // this project does not let the app tell somebody their VPN is
        // broken on the strength of a number nobody has checked against
        // the wire. They belong in the log until the rig says what a
        // healthy value looks like.
        let counters = stats(1000, 900, 800, 700, 0);
        counters.udp_send_failed.store(5000, Ordering::Relaxed);
        counters.udp_reply_failed.store(5000, Ordering::Relaxed);
        counters.udp_unbound.store(5000, Ordering::Relaxed);

        assert_eq!(counters.complaint(WARMUP * 2), None);
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
    fn escapes_are_recorded_without_changing_what_the_customer_is_told() {
        // Observability only, in this version. The escape count has
        // never been read against a packet capture, and a complaint
        // keyed on an unverified number is exactly the false alarm
        // WARMUP exists to prevent -- see the field's own comment.
        let healthy = stats(4000, 900, 850, 800, 0);
        healthy.escaped.store(7, Ordering::Relaxed);
        assert_eq!(healthy.complaint(WARMUP * 2), None);
        assert!(healthy.summary().contains("escaped=7"), "{}", healthy.summary());
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

    fn selection_of(paths: &[&str], mode: SplitTunnelMode) -> Selection {
        Selection::new(paths.iter().map(|p| p.to_string()), mode)
    }

    #[test]
    fn a_selected_apps_surviving_connection_is_refused_while_the_reset_converges() {
        // The SYN_SENT hole: a connection that was half-open when Custom
        // mode started completes against the real destination a moment
        // later, and the mid-connection rule would exempt it for its
        // whole life. Inside the window it is refused instead, so the
        // application opens a new one the loop is on time for.
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::OnlySelected);
        assert!(drop_while_converging(true, &selection, Some(r"c:\games\game.exe"), false));
    }

    #[test]
    fn the_window_closes_and_the_old_behaviour_returns() {
        // Outside it, exempting a pre-existing connection is right and
        // has been for a long time: the app holds a socket to the real
        // destination and rewriting half of a live connection breaks it.
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::OnlySelected);
        assert!(!drop_while_converging(false, &selection, Some(r"c:\games\game.exe"), false));
    }

    #[test]
    fn a_packet_nobody_can_attribute_is_never_dropped() {
        // The miss must not cost anything. Attributing a packet is the
        // thing this file has been wrong about before, and here the
        // price of being wrong is paid by an application the customer
        // never chose.
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::OnlySelected);
        assert!(!drop_while_converging(true, &selection, None, false));
    }

    #[test]
    fn an_unselected_app_keeps_its_connections_through_the_window() {
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::OnlySelected);
        assert!(!drop_while_converging(true, &selection, Some(r"c:\windows\explorer.exe"), false));
    }

    #[test]
    fn this_service_is_never_refused() {
        // The proxy's upstream sockets look like any other
        // application's. Refusing them would take out the relay carrying
        // everything else -- and in AllExcept the service is "selected"
        // by default, so this is the common case there, not the corner.
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::OnlySelected);
        assert!(!drop_while_converging(true, &selection, Some(r"c:\games\game.exe"), true));
    }

    #[test]
    fn everything_except_these_is_left_exactly_as_it_was() {
        // In AllExcept an unknown owner means "carry it", so this rule
        // there would refuse traffic belonging to programs nobody has
        // identified -- most of the machine, for the first seconds of a
        // session. Changing that direction needs its own evidence.
        let selection = selection_of(&[r"C:\Games\game.exe"], SplitTunnelMode::AllExcept);
        assert!(!drop_while_converging(true, &selection, Some(r"c:\windows\explorer.exe"), false));
        assert!(!drop_while_converging(true, &selection, None, false));
    }

    #[test]
    fn a_udp_socket_created_inside_the_rate_limiter_window_is_still_attributed() {
        // The UDP twin of the 0.9.25 fix, and the reason it needed one.
        // A SYN forces the owner snapshot to be rebuilt because a miss
        // there cannot be taken back; UDP has no SYN, so a brand-new
        // socket's first datagram landed inside OwnerLookup's 20ms floor,
        // was attributed to nobody, and in OnlySelected went out direct.
        // For a browser that datagram is the QUIC Initial, and datagram
        // two -- attributed correctly and redirected -- arrives from a
        // different address: the handshake does not fail fast, it hangs
        // until QUIC gives up and TCP is tried instead.
        //
        // Both socket operations here happen microseconds apart, which
        // is what puts the second inside the floor and makes this the
        // case being tested rather than an ordinary hit.
        let mut owner = OwnerLookup::new();
        let nat = Nat::new();
        let redirect = sample_redirect();
        let stats = Stats::default();
        let me = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let selection = Selection::new([me], SplitTunnelMode::OnlySelected);

        // Builds the snapshot and marks it freshly refreshed, so the
        // socket opened next cannot be in it and a miss on its own
        // cannot force a rebuild.
        let warm = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind");
        let _ =
            owner.image_for_port(Family::V4, Transport::Udp, warm.local_addr().unwrap().port());

        let fresh = std::net::UdpSocket::bind("0.0.0.0:0").expect("bind");
        let port = fresh.local_addr().unwrap().port();

        // Not port 53: the DNS branch carries a lookup whoever made it,
        // so it would answer this without ever consulting the owner and
        // the test would prove nothing.
        let packet = udp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(203, 0, 113, 9),
            port,
            443,
        );
        let parsed = parse(&packet).expect("a well-formed packet");
        let verdict = decide(&parsed, &nat, &selection, &mut owner, &redirect, 5, &stats);

        assert!(
            matches!(verdict, Verdict::Redirect { .. }),
            "a selected app's first datagram must be carried, got {verdict:?}"
        );
    }

    #[test]
    fn an_unselected_apps_first_datagram_is_still_left_alone() {
        // The forced rebuild changes how confidently the question is
        // answered, not what the answer means. An app the customer did
        // not choose keeps its ordinary connection -- the whole premise
        // of a split tunnel -- and its port is remembered so the next
        // datagram costs a hash lookup instead of another walk.
        let mut owner = OwnerLookup::new();
        let nat = Nat::new();
        let redirect = sample_redirect();
        let stats = Stats::default();
        let selection =
            Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::OnlySelected);

        let fresh = std::net::UdpSocket::bind("0.0.0.0:0").expect("bind");
        let port = fresh.local_addr().unwrap().port();
        let packet = udp_packet(
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(203, 0, 113, 9),
            port,
            443,
        );
        let parsed = parse(&packet).expect("a well-formed packet");

        assert_eq!(
            decide(&parsed, &nat, &selection, &mut owner, &redirect, 5, &stats),
            Verdict::Direct
        );
        assert_eq!(
            nat.lookup(Transport::Udp, port, Ipv4Addr::new(203, 0, 113, 9), 443),
            Verdict::Direct,
            "a known owner's verdict must be remembered"
        );
    }

    #[test]
    fn the_window_is_measured_from_when_interception_began() {
        // Per-redirect rather than global: a failover stops Custom mode
        // and starts it again against the new adapter, and a
        // process-wide clock would let the outgoing session's age decide
        // what the incoming one does with a packet.
        let mut redirect = sample_redirect();
        assert!(redirect.within_activation_grace());
        redirect.activated = Instant::now() - ACTIVATION_GRACE - Duration::from_millis(1);
        assert!(!redirect.within_activation_grace());
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
            activated: Instant::now(),
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
            activated: Instant::now(),
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

    /// The same builder the loop uses, given a segment shaped like one
    /// an established connection sends.
    fn established_v6_segment(seq: u32, ack: u32, payload: usize) -> Vec<u8> {
        let mut packet = vec![0u8; IPV6_HEADER + 20 + payload];
        packet[0] = 0x60;
        packet[4..6].copy_from_slice(&((20 + payload) as u16).to_be_bytes());
        packet[6] = IPPROTO_TCP;
        packet[7] = 64;
        let src: std::net::Ipv6Addr = "2001:db8::1".parse().unwrap();
        let dst: std::net::Ipv6Addr = "2607:f8b0:400a:809::200e".parse().unwrap();
        packet[8..24].copy_from_slice(&src.octets());
        packet[24..40].copy_from_slice(&dst.octets());
        packet[40..42].copy_from_slice(&51234u16.to_be_bytes());
        packet[42..44].copy_from_slice(&443u16.to_be_bytes());
        packet[44..48].copy_from_slice(&seq.to_be_bytes());
        packet[48..52].copy_from_slice(&ack.to_be_bytes());
        packet[52] = 0x50;
        packet[53] = TCP_FLAG_ACK;
        packet
    }

    #[test]
    fn a_blocked_connection_is_told_rather_than_left_hanging() {
        // The whole point of the reset. A pre-existing IPv6 connection
        // whose packets are swallowed does not fail fast: TCP
        // retransmits into the black hole and holds the socket for
        // minutes, so the customer sees a page hang while `blocked_v6`
        // climbs and looks like the feature working.
        //
        // A stack does not accept just any reset -- one outside the
        // receive window is discarded -- so the numbers here are the
        // property being tested, not decoration. The reset's sequence
        // number is the acknowledgement the segment just carried, which
        // is by definition where the peer would send from next.
        let segment = established_v6_segment(1_000, 5_000, 120);
        let parsed = parse_v6(&segment).expect("must parse");
        let reset = build_v6_reset(&segment, &parsed).expect("a TCP segment must produce one");

        assert_eq!(reset.len(), IPV6_HEADER + 20);
        // Both ends swapped: it has to look like the remote answering.
        assert_eq!(&reset[8..24], &segment[24..40]);
        assert_eq!(&reset[24..40], &segment[8..24]);
        assert_eq!(u16::from_be_bytes([reset[40], reset[41]]), 443);
        assert_eq!(u16::from_be_bytes([reset[42], reset[43]]), 51234);
        assert_eq!(
            u32::from_be_bytes([reset[44], reset[45], reset[46], reset[47]]),
            5_000,
            "the reset must start where the peer would have"
        );
        assert_eq!(
            u32::from_be_bytes([reset[48], reset[49], reset[50], reset[51]]),
            1_120,
            "and acknowledge every byte the segment carried"
        );
        assert_eq!(reset[53], TCP_FLAG_RST | TCP_FLAG_ACK);
        assert_eq!(reset[6], IPPROTO_TCP);
    }

    #[test]
    fn a_refused_syn_gets_the_reset_a_refusing_host_would_send() {
        // A first SYN carries no acknowledgement to borrow, so the
        // reset starts at zero and acknowledges the initial sequence
        // number -- which is exactly what a host with nothing listening
        // sends, and therefore exactly what the connecting stack is
        // already prepared to accept.
        let mut segment = established_v6_segment(7_777, 0, 0);
        segment[53] = TCP_FLAG_SYN;
        let parsed = parse_v6(&segment).expect("must parse");
        let reset = build_v6_reset(&segment, &parsed).expect("a SYN must produce one");

        assert_eq!(u32::from_be_bytes([reset[44], reset[45], reset[46], reset[47]]), 0);
        assert_eq!(u32::from_be_bytes([reset[48], reset[49], reset[50], reset[51]]), 7_778);
    }

    #[test]
    fn a_fin_is_acknowledged_like_the_byte_it_is() {
        let mut segment = established_v6_segment(400, 900, 0);
        segment[53] = TCP_FLAG_ACK | TCP_FLAG_FIN;
        let parsed = parse_v6(&segment).expect("must parse");
        let reset = build_v6_reset(&segment, &parsed).unwrap();
        assert_eq!(u32::from_be_bytes([reset[48], reset[49], reset[50], reset[51]]), 401);
    }

    #[test]
    fn nothing_answers_a_reset_with_a_reset() {
        // The connection is already gone. Two ends exchanging resets
        // about it is a loop, not a recovery.
        let mut segment = established_v6_segment(1, 2, 0);
        segment[53] = TCP_FLAG_RST;
        let parsed = parse_v6(&segment).expect("must parse");
        assert!(build_v6_reset(&segment, &parsed).is_none());
    }

    #[test]
    fn udp_gets_no_reset_because_there_is_none_to_send() {
        // Stated rather than implied. There is no in-band way to tell a
        // datagram socket its peer is unreachable, so a selected app's
        // IPv6 UDP stays silently swallowed -- a gap, not a decision
        // buried in the shape of the code.
        let mut segment = established_v6_segment(1, 2, 8);
        segment[6] = IPPROTO_UDP;
        let parsed = parse_v6(&segment).expect("must parse");
        assert!(matches!(parsed.transport, Transport::Udp));
        assert!(build_v6_reset(&segment, &parsed).is_none());
    }

    #[test]
    fn a_segment_behind_extension_headers_is_still_answered() {
        // The sequence numbers are not at a fixed offset, for the same
        // reason the ports are not. Reading them at 40 regardless would
        // build a reset the application's stack discards as out of
        // window, which is the silent black hole all over again.
        let packet = ipv6_packet("2607:f8b0:400a:809::200e", 443, &[(IPPROTO_DSTOPTS, 16)]);
        let parsed = parse_v6(&packet).expect("must parse");
        assert_eq!(parsed.transport_offset, IPV6_HEADER + 16);
        let reset = build_v6_reset(&packet, &parsed).expect("must produce a reset");
        assert_eq!(u16::from_be_bytes([reset[40], reset[41]]), 443);
        assert_eq!(u16::from_be_bytes([reset[42], reset[43]]), 51234);
    }

    #[test]
    fn a_truncated_segment_produces_nothing_rather_than_nonsense() {
        // A service running as LocalSystem, with every packet on the
        // machine going past it.
        let mut segment = established_v6_segment(1, 2, 0);
        let parsed = parse_v6(&segment).expect("must parse");
        segment.truncate(IPV6_HEADER + 10);
        assert!(build_v6_reset(&segment, &parsed).is_none());
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
        // One table for both halves, as production wires it: the relay
        // counts its own UDP losses into the same counters the loop
        // fills.
        let stats = Arc::new(Stats::default());
        let relays =
            proxy::start(nat.clone(), tunnel, stats.clone()).expect("relays must start");
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
                // Overwritten by `start`; see ACTIVATION_GRACE.
                activated: Instant::now(),
            },
            nat,
            selection,
            stats,
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
            activated: Instant::now(),
        });
        super::super::divert::compile_filter(&filter).expect("the filter must compile");
    }
}
