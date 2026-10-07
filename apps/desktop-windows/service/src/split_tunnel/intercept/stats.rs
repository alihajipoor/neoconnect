//! What the loop has done, counted where it happened.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
    ///
    /// **It now reads lower than it used to, and that is not a
    /// regression.** `engines::ipv6_block::SelectedAppsIpv6Block`
    /// refuses a selected application's IPv6 at `connect()`, before a
    /// packet is built, so a session where those filters installed
    /// cleanly produces nothing here for a selected app's new TCP
    /// connections at all -- the refusal happened a layer up. What
    /// still lands here is what that block does not cover: connections
    /// that were already open, and applications the filters could not
    /// be installed for. Read the two together, from
    /// `ipv6-block-custom.log` and this line, or read neither.
    pub blocked_v6: AtomicU64,
    /// ICMP echo requests refused because the tunnel cannot carry one.
    ///
    /// The second *deliberate* refusal in this struct, and it needs the
    /// same reading as `blocked_v6`: high is normal for anything that
    /// pings, and zero says only that nothing tried. Before the filter
    /// was opened to ICMP this could not have read anything but zero --
    /// the driver never handed the loop a ping, and 174 of them were
    /// measured leaving in the clear while the same application's TCP
    /// was fully tunnelled.
    ///
    /// **Not per-application, and that is the honest name for it.**
    /// Nothing can attribute an ICMP packet to a process here, so this
    /// counts every ping the machine attempts while Custom mode is on,
    /// not only a selected application's. `settings.customIcmpBody`
    /// is where the customer is told the same thing.
    pub blocked_icmp: AtomicU64,
    /// Connections found living outside the tunnel that should be
    /// inside it -- see `tables::escaped_connections`.
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
    /// Datagrams swallowed because nothing could say who sent them --
    /// see `Selection::verdict_for_unattributed`.
    ///
    /// The one counter here that reports the *inversion* of this
    /// feature's usual trade. Everywhere else an unanswerable question
    /// fails open, because unprotected traffic beats a stalled app; for
    /// this one shape failing open **is** the leak, so it fails closed
    /// and this is what says how often that happened.
    ///
    /// It has to be counted for a reason the other refusals do not: a
    /// drop nobody records is a change to this loop that cannot be
    /// argued about afterwards, and this is the only drop that can hit
    /// an application the customer did not choose. If it is large on a
    /// customer's machine, something is sending one-shot UDP hard and
    /// the number is where that conversation starts.
    ///
    /// Both families. An IPv6 refusal is also counted in `blocked_v6`,
    /// which is a count of v6 packets dropped whatever the reason;
    /// overlapping is better here than a `blocked_v6` that silently
    /// stops being the total.
    ///
    /// Deliberately not read by [`Stats::complaint`], for the reason
    /// `blocked_v6` is not: it counts a refusal working as designed. A
    /// machine with chatty one-shot senders would light that warning
    /// permanently, and this project has already decided a warning that
    /// is always on is one nobody reads when it matters.
    pub refused_unattributed: AtomicU64,
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
    /// socket -- see `relay::PendingFlows`.
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
pub(super) const SILENT_AFTER: u64 = 20;

/// How long a session must have been running before silence is allowed
/// to mean anything.
///
/// Measured, not chosen: a healthy start reaches `redirected=48,
/// returned=0` before the first reply arrives, because the firewall
/// allowance takes a moment to become effective for new flows. Judged on
/// the count alone, this check called a perfectly good connection broken
/// during its first seconds -- which is worse than saying nothing, since
/// a false alarm here teaches customers to ignore the true ones.
pub(super) const WARMUP: Duration = Duration::from_secs(12);

impl Stats {
    pub fn summary(&self) -> String {
        format!(
            "seen={} matched={} redirected={} returned={} rejected={} blocked_v6={} \
             blocked_icmp={} escaped={} \
             grace_dropped={} reset_v6={} refused_unattributed={} udp_send_failed={} \
             udp_reply_failed={} udp_unbound={}",
            self.seen.load(Ordering::Relaxed),
            self.matched.load(Ordering::Relaxed),
            self.redirected.load(Ordering::Relaxed),
            self.returned.load(Ordering::Relaxed),
            self.rejected.load(Ordering::Relaxed),
            self.blocked_v6.load(Ordering::Relaxed),
            self.blocked_icmp.load(Ordering::Relaxed),
            self.escaped.load(Ordering::Relaxed),
            self.grace_dropped.load(Ordering::Relaxed),
            self.reset_v6.load(Ordering::Relaxed),
            self.refused_unattributed.load(Ordering::Relaxed),
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
