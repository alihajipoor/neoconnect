//! The ladder that decides what one outbound IPv4 packet is: carried,
//! left alone, or refused.
//!
//! Split out of the loop because it is the loop's whole policy and the
//! part every leak fix in this subsystem has landed in. Nothing here
//! touches the driver: it reads a parsed header, the flow tables, the
//! owner lookup and the selection, and returns a [`Verdict`].

use std::net::IpAddr;
use std::sync::atomic::Ordering;

use neoconnect_ipc::SplitTunnelMode;

use crate::split_tunnel::flows::{Nat, Origin, Verdict};
use crate::split_tunnel::policy::{Family, Scoped, Selection, Transport, Unattributed};
use crate::split_tunnel::relay::ExitRelays;
use crate::split_tunnel::tables::OwnerLookup;

use super::packet::{Parsed, TCP_FLAG_ACK, TCP_FLAG_SYN};
use super::{Redirect, Stats};

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
pub(super) fn drop_while_converging(
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
/// CUSTOM  tcp egress: 203.0.113.10    (the node)
/// CUSTOM  dns egress: 192.0.2.228     (the customer's own line)
/// ```
///
/// Both addresses above are redacted to documentation ranges. The
/// real ones were a node exit and a beta tester's home line; what
/// the capture showed is that the two differ. See
/// docs/node-address-hygiene.md.
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
pub(super) fn is_dns(parsed: &Parsed) -> bool {
    parsed.destination_port == DNS_PORT
}

/// The well-known port, named because `== 53` in the middle of a
/// verdict reads like a magic number.
pub(super) const DNS_PORT: u16 = 53;

/// Which concurrent exit a flow leaves from, once it is already being
/// carried.
///
/// # The signature is the enforcement
///
/// This takes an `image_path`, exactly as `Selection::preferred_exit`
/// and `Selection::destination_scope` do, and that is load-bearing
/// rather than convenient. An exit preference belongs to an
/// application. A packet nobody can be shown to have sent has no
/// application, so the only call is behind `carry.owner_image()?` --
/// there is no image to pass, so there is no exit to acquire, and giving
/// one to an unattributed datagram would mean first writing a call that
/// does not typecheck today.
///
/// That matters more here than anywhere else in this feature.
/// `docs/design/per-game-exits.md` §4.1 names it as *the* trap in the
/// concurrent version: the temptation is to give an ownerless datagram
/// a default exit and send it there, and **deciding where to send a
/// packet requires having already decided to carry it**. That decision
/// is the fire-and-forget UDP leak `verdict_for_unattributed` exists to
/// refuse -- 13 of 15 datagrams in the clear on one rig run, 14 on the
/// next.
///
/// The other half of the ordering used to be positional, held by
/// layout and one test. It is now this function's argument: it takes a
/// [`ladder::Carry`], which only [`ladder::settle`] can make, after both
/// refusals in [`decide`] have run -- and `settle` in turn takes the
/// proof that every rung before it ran. See [`ladder`].
///
/// # Fail-open, on both of its two axes
///
/// * **No exits live.** The ordinary case, and the one the length
///   check makes free: every flow takes the session's tunnel adapter,
///   which is what every flow did before this existed.
/// * **A preference naming an exit this engine did not bring up.** Also
///   the session's adapter. `ExitPlacement::Fallback` reports it, and a
///   game that keeps working from the wrong address beats a game that
///   stops.
fn exit_for(carry: &ladder::Carry, selection: &Selection, exits: &ExitRelays) -> Option<u8> {
    // Checked first so a session with no concurrent exits -- which is
    // every WireGuard, OpenVPN and IKEv2 session, and most Xray ones --
    // never lowercases a path or touches the preference map.
    if exits.is_empty() {
        return None;
    }
    // A carried datagram with no application behind it has no
    // preference to look up, so it takes the session's exit.
    exits.index_of(selection.preferred_exit(carry.owner_image()?)?)
}

/// What one outbound IPv4 packet is: carried, left alone, or refused.
///
/// A ladder of seven rungs, climbed in order until one of them decides.
/// The order is the safety property -- see [`ladder`] -- and it is held
/// by the types each rung takes and returns rather than by where its
/// code sits, so `climb` below cannot be written in a different order
/// and still compile.
pub(super) fn decide(
    parsed: &Parsed,
    nat: &Nat,
    selection: &Selection,
    owner: &mut OwnerLookup,
    redirect: &Redirect,
    interface_id: u32,
    stats: &Stats,
) -> Verdict {
    let packet = ladder::Packet { parsed, nat, selection, redirect, interface_id, stats };
    match climb(&packet, owner) {
        Ok(verdict) | Err(verdict) => verdict,
    }
}

/// The rungs, in the only order their types allow. Each one either ends
/// the climb with a verdict -- the `Err` side, so `?` stops here -- or
/// hands the next rung what it needs to run.
fn climb(packet: &ladder::Packet, owner: &mut OwnerLookup) -> Result<Verdict, Verdict> {
    let undecided = ladder::undecided(packet)?;
    let foreign = ladder::not_the_relays_own(packet, undecided)?;
    let opening = ladder::opens_a_flow(packet, foreign, owner)?;
    let attributed = ladder::attribute(packet, opening, owner);
    let not_a_lookup = ladder::carry_lookups(packet, attributed)?;
    let carry = ladder::settle(packet, not_a_lookup)?;
    Ok(ladder::carry(packet, carry))
}

/// [`decide`]'s ladder, one rung per function, with the order carried by
/// types.
///
/// The ladder's safety property is an ordering: every refusal must come
/// before the only place a carried flow can acquire a concurrent exit,
/// because deciding *where* to send a packet presupposes having decided
/// to carry it -- and giving an exit to a datagram that should have been
/// refused is the fire-and-forget leak with a destination attached. That
/// ordering used to be held by layout, eight early returns and one test.
/// [`exit_for`] was the first part of it put into a type: it takes a
/// [`Carry`], which only [`settle`] can make.
///
/// The rest of the ladder is now the same shape. Each rung takes, by
/// value, the token the rung before it returns, and returns the token
/// the next rung needs: [`Undecided`], [`Foreign`], [`Opening`],
/// [`Attributed`], [`NotALookup`], [`Carry`]. Every token's fields are
/// private to this module and each is built in exactly one place -- the
/// rung that returns it -- so nothing outside can forge one and skip a
/// rung, and running a rung ahead of the one before it is a type error
/// rather than a leak. The two places a flow is handed to the relay are
/// rungs too: [`carry_lookups`], which cannot give a lookup an exit, and
/// [`carry`], which needs a `Carry`.
///
/// The rungs themselves are the ladder `decide` always was, line for
/// line and comment for comment; only the joints between them changed.
/// The comments still say "above" for what runs earlier and "below" for
/// what runs later, as they did when this was one function read top to
/// bottom.
mod ladder {
    use super::*;

    /// What every rung reads, so each signature says what it consumes
    /// and returns and nothing else.
    pub(super) struct Packet<'a> {
        pub(super) parsed: &'a Parsed,
        pub(super) nat: &'a Nat,
        pub(super) selection: &'a Selection,
        pub(super) redirect: &'a Redirect,
        pub(super) interface_id: u32,
        pub(super) stats: &'a Stats,
    }

    /// Past rung 1: no flow-table entry and no leave-alone verdict
    /// already answers for this packet.
    pub(super) struct Undecided {
        is_new_connection: bool,
    }

    /// Past rung 2: not one of the relay's own onward sockets.
    pub(super) struct Foreign {
        is_new_connection: bool,
    }

    /// Past rung 3: a packet that opens a flow -- a SYN, or a UDP
    /// datagram nothing has decided about. Every mid-connection TCP
    /// packet has been answered by then, which is what lets rung 4 ask
    /// for the owner the insistent way unconditionally.
    pub(super) struct Opening(());

    /// Rung 4's answer: who sent it, and what the selection says about
    /// that. Computes everything and decides nothing.
    pub(super) struct Attributed<'o> {
        owner_image: Option<&'o str>,
        known_owner: bool,
        is_own: bool,
        unattributed: Option<Unattributed>,
        selected: bool,
    }

    /// Past rung 5: not a lookup carried whoever sent it.
    pub(super) struct NotALookup<'o> {
        attributed: Attributed<'o>,
    }

    /// Past rung 6: a packet that has passed every refusal and is to be
    /// carried.
    pub(super) struct Carry<'o> {
        /// The application behind it, when there is one. `None` is a
        /// datagram carried without attribution -- `AllExcept`'s answer
        /// for an owner nobody can see -- which has no preference and so
        /// can never reach an exit.
        owner_image: Option<&'o str>,
    }

    impl<'o> Carry<'o> {
        pub(super) fn owner_image(&self) -> Option<&'o str> {
            self.owner_image
        }
    }

    /// Rung 1: a flow somebody already decided about.
    pub(super) fn undecided(packet: &Packet) -> Result<Undecided, Verdict> {
        let Packet { parsed, nat, .. } = *packet;
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
            return Err(known);
        }
        Ok(Undecided { is_new_connection })
    }

    /// Rung 2: the relay's own onward socket.
    pub(super) fn not_the_relays_own(packet: &Packet, undecided: Undecided) -> Result<Foreign, Verdict> {
        let Packet { parsed, redirect, .. } = *packet;
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
            return Err(Verdict::Direct);
        }
        Ok(Foreign { is_new_connection: undecided.is_new_connection })
    }

    /// Rung 3: a connection already under way when nothing knew about it.
    pub(super) fn opens_a_flow(packet: &Packet, foreign: Foreign, owner: &mut OwnerLookup) -> Result<Opening, Verdict> {
        let Packet { parsed, nat, selection, redirect, stats, .. } = *packet;
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
        if matches!(parsed.transport, Transport::Tcp) && !foreign.is_new_connection {
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
                    return Err(Verdict::Drop);
                }
            }
            // Recorded against this flow, not this port. For TCP the two
            // are almost the same thing -- a port changes destination by
            // sending a SYN, and a SYN skips this cache -- so this call is
            // the one of the three whose meaning barely moves.
            nat.record_direct(
                parsed.transport,
                parsed.source_port,
                parsed.destination,
                parsed.destination_port,
            );
            return Err(Verdict::Direct);
        }
        Ok(Opening(()))
    }

    /// Rung 4: who sent it. Decides nothing; every answer it works out is
    /// acted on by a later rung.
    pub(super) fn attribute<'o>(packet: &Packet, _opening: Opening, owner: &'o mut OwnerLookup) -> Attributed<'o> {
        let Packet { parsed, selection, redirect, .. } = *packet;
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
        //
        // The insistent question unconditionally, and that is not a
        // change: this used to choose between the two lookups on
        // "a SYN, or UDP", and every packet that was neither -- a TCP
        // packet mid-connection -- had already been answered by the
        // mid-connection rule above. The `Opening` that rule returns is
        // what says so now.
        let owner_image = owner.image_for_new_connection(Family::V4, parsed.transport, parsed.source_port);
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
        // A port with no owner this can see, which is the case the rest of
        // this function used to get wrong -- see
        // `Selection::verdict_for_unattributed` for the measurement and for
        // why the answer for a datagram is now "refuse" rather than "leave
        // it alone".
        //
        // Worked out here and acted on further down rather than returned on
        // the spot, because the DNS branch below has to run first: a lookup
        // is carried whoever made it, and carrying an unattributable one is
        // strictly better than swallowing it. Refusing here would have
        // turned a carried query into a dropped one, which is a slower page
        // in exchange for nothing.
        let unattributed = match owner_image {
            Some(_) => None,
            None => Some(selection.verdict_for_unattributed(
                parsed.transport,
                IpAddr::V4(parsed.destination),
            )),
        };
        let selected = match owner_image {
            // Two questions, in this order: is this application's traffic
            // ours, and is this packet of it going somewhere we carry.
            //
            // The second can only ever narrow the first, which is what
            // makes it safe to bolt onto a decision this load-bearing. An
            // application the customer did not select cannot be pulled into
            // the tunnel by a scope, because `should_tunnel` has already
            // said no and `&&` never revisits that.
            //
            // `Scoped::Unscoped` -- no scope, an unusable one, or one with
            // nothing to say about IPv4 -- leaves the answer exactly as it
            // was before scopes existed. See `Selection::destination_scope`
            // for why every uncertainty lands there and not on a refusal.
            Some(image) => {
                !is_own
                    && selection.should_tunnel(image)
                    && !matches!(
                        selection.destination_scope(image, IpAddr::V4(parsed.destination)),
                        Scoped::OutOfScope
                    )
            }
            // A port with no owner this loop can see. In `OnlySelected`
            // that used to mean "leave it alone", and leaving it alone was
            // the leak: 15 datagrams from 15 short-lived sockets, 13 out in
            // the clear on one rig run and 14 on the next, from a selected
            // application, with the app reporting Custom mode on. The
            // module header carries the mechanism, why a WFP
            // `ALE_APP_ID` filter cannot take this job instead, and what
            // the refusal costs.
            //
            // Only `Carry` means "into the tunnel". `Refuse` is deliberately
            // not acted on here -- see where `unattributed` is worked out
            // above for why it has to wait for the DNS branch.
            None => matches!(unattributed, Some(Unattributed::Carry)),
        };
        Attributed { owner_image, known_owner, is_own, unattributed, selected }
    }

    /// Rung 5: a name lookup, carried whoever sent it -- and never given
    /// an exit, which this rung cannot do: the `Origin` it builds is
    /// written with `exit: None` and it holds no `Carry` to ask for one.
    pub(super) fn carry_lookups<'o>(packet: &Packet, attributed: Attributed<'o>) -> Result<NotALookup<'o>, Verdict> {
        let Packet { parsed, nat, redirect, interface_id, stats, .. } = *packet;
        // A lookup is carried whoever made it -- see `is_dns` -- except this
        // service's own.
        if redirect.carry_dns && is_dns(parsed) && !attributed.is_own {
            let origin = Origin {
                addr: parsed.destination,
                port: parsed.destination_port,
                client: parsed.source,
                client_port: parsed.source_port,
                interface_id,
                // Answered by a resolver reached through the tunnel, not by
                // the one the network handed out.
                upstream: Some(std::net::SocketAddrV4::new(redirect.dns_resolver, DNS_PORT)),
                // A lookup is carried whoever made it -- including a
                // datagram with no owner this loop can see, which is the
                // one case in this function where a packet is carried
                // without an application behind it. That is exactly the
                // packet that must never acquire an exit: a preference
                // belongs to an application, and inventing one for a
                // datagram nobody can be shown to have sent is the
                // fire-and-forget leak with a destination attached.
                //
                // So every lookup takes the session's own exit, including
                // one made by a game that named a different one. That is a
                // real limit and it is the honest side of it: a resolver
                // reached through the session's exit answers with what that
                // exit's network sees, which is the same answer this
                // client has always given. A per-game resolver would be a
                // second feature with its own evidence problem -- see
                // `docs/design/per-game-exits.md` §4.1.
                exit: None,
            };
            return Err(match nat.redirect(parsed.transport, origin) {
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
            });
        }
        Ok(NotALookup { attributed })
    }

    /// Rung 6: the two refusals, in order, and the only constructor of
    /// [`Carry`].
    pub(super) fn settle<'o>(packet: &Packet, not_a_lookup: NotALookup<'o>) -> Result<Carry<'o>, Verdict> {
        let Packet { parsed, nat, stats, .. } = *packet;
        let Attributed { owner_image, known_owner, unattributed, selected, .. } = not_a_lookup.attributed;
        // Nothing on this machine can say who sent this datagram, and in
        // `OnlySelected` the honest answer is to refuse it rather than to
        // let it out in the clear on the chance it was not the selected
        // app's. See `Selection::verdict_for_unattributed`.
        //
        // Nothing is recorded against the port. A leave-alone verdict here
        // would exempt whatever opens that port next, and the whole point
        // of this branch is that the port is not evidence of anything -- it
        // had no owner a moment ago and may have a perfectly ordinary one
        // by the next datagram, which then gets decided on its merits.
        if matches!(unattributed, Some(Unattributed::Refuse)) {
            stats.refused_unattributed.fetch_add(1, Ordering::Relaxed);
            return Err(Verdict::Drop);
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
            //
            // Recorded against this flow rather than this port, and for UDP
            // that is the difference between remembering an answer and
            // inventing one. The old key covered every destination the port
            // reached for five seconds, on the strength of one decision
            // about one peer -- so a port that had been left alone once
            // short-circuited `Nat::lookup` for a name lookup sent from it
            // afterwards, and the DNS branch above, which carries a lookup
            // whoever makes it, never ran. The query went to whichever
            // resolver the network supplied. See `Tables::direct`.
            //
            // That flow key is also what lets a *scoped* application reach
            // this line at all. `docs/design/gaming-mode.md` §5.3 lists it
            // as a trap -- "a per-destination policy must not call
            // `record_direct`" -- and that was true when it was written,
            // because the cache was keyed on `(transport, source port)`.
            // One out-of-scope packet would then have exempted the whole
            // port for five seconds, game-server traffic included, and a
            // game scoped to its servers would have been carried for
            // whichever destination it happened to reach first. Keyed on
            // the flow, "this app does not send *here* through the tunnel"
            // is all it says, and the same port's next packet to a
            // destination that *is* in scope is decided on its own merits.
            // The trap is spent; the note stays because the shape of this
            // key is now load-bearing for two features rather than one.
            if known_owner {
                nat.record_direct(
                    parsed.transport,
                    parsed.source_port,
                    parsed.destination,
                    parsed.destination_port,
                );
            }
            return Err(Verdict::Direct);
        }

        Ok(Carry { owner_image })
    }

    /// Rung 7: carried, from whichever exit [`exit_for`] says -- the only
    /// `Origin` in this ladder that can name one, built only from a
    /// [`Carry`].
    pub(super) fn carry(packet: &Packet, carry: Carry) -> Verdict {
        let Packet { parsed, nat, selection, redirect, interface_id, stats } = *packet;
        // Past both refusals, so this is reached only for a packet already
        // decided to be carried -- and that is now a property of the types
        // rather than of where this line sits.
        let origin = Origin {
            addr: parsed.destination,
            port: parsed.destination_port,
            client: parsed.source,
            client_port: parsed.source_port,
            interface_id,
            upstream: None,
            exit: exit_for(&carry, selection, &redirect.exits),
        };
        match nat.redirect(parsed.transport, origin) {
            Some(nat_port) => {
                stats.matched.fetch_add(1, Ordering::Relaxed);
                Verdict::Redirect { nat_port }
            }
            // Out of synthetic ports. Fail open, consistent with the rest of
            // the feature: unprotected traffic beats a stalled game.
            //
            // This is a *selected* application, so what is recorded here has
            // to be as narrow as the failure that caused it. Keyed on the
            // port it was not: one exhausted moment handed the whole port a
            // five-second exemption covering every destination it reached
            // next, and because UDP has no SYN to re-decide, nothing took it
            // back early -- a selected app kept egressing in the clear long
            // after `expire_idle` had freed the ports that would have
            // carried it. Keyed on the flow it says only what is true: this
            // one flow could not be carried.
            None => {
                nat.record_direct(
                    parsed.transport,
                    parsed.source_port,
                    parsed.destination,
                    parsed.destination_port,
                );
                Verdict::Direct
            }
        }
    }
}
