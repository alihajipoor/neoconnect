//! The connections a session closes, and the ones it reports.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use windows_sys::Win32::Foundation::NO_ERROR;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, SetTcpEntry, TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use crate::split_tunnel::policy::{is_public_v4, is_public_v6, Selection, Transport};

use super::process::image_path;
use super::{query_table, rows, Layout};

/// The TCP state that tells Windows to tear a connection down.
const MIB_TCP_STATE_DELETE_TCB: u32 = 12;

/// The state of a connection that is actually carrying traffic.
///
/// Named because two separate places now turn on it -- the reset below
/// and the escape audit -- and a bare `5` in either of them reads like a
/// magic number rather than like the one state where a remote address in
/// the table means anything. In every other state the row's remote
/// fields are zero or provisional.
const MIB_TCP_STATE_ESTAB: u32 = 5;

/// A connection whose SYN has gone out and whose reply has not come back.
///
/// Unlike the other non-established states, its remote fields are real --
/// it is headed somewhere definite -- so it is the one state where
/// skipping the row means a connection escapes the reset and completes
/// outside the tunnel.
const MIB_TCP_STATE_SYN_SENT: u32 = 3;

/// Established connections belonging to selected applications, closed so
/// they are rebuilt through the tunnel.
///
/// Without this, switching Custom mode on does nothing for anything
/// already running. A connection is routed once, when it is created, and
/// an application that is already open keeps using the ones it has:
/// measured here, a socket opened beforehand still reported the ordinary
/// exit address thirty seconds later and never moved.
///
/// For a browser that is the whole complaint. Someone selects it, looks
/// at a page showing their address, and sees no change -- because the
/// page is being fetched down a connection that predates the decision.
/// Telegram reconnects promptly and appears to work immediately, which
/// is why the two were reported so differently.
///
/// Only *selected* applications are touched, and only established
/// connections. Resetting a connection is something applications handle
/// routinely -- it is what happens when a network changes -- and the
/// alternative is a feature that silently does not apply until every
/// program is restarted.
///
/// # What is deliberately left alone
///
/// Connections the redirect is already carrying, which is what `carried`
/// answers. This is not an optimisation. The reset runs once inline and
/// then rescans every few hundred milliseconds for the length of the
/// activation window, and a connection an application rebuilt after the
/// first pass is, by the second pass, indistinguishable by remote
/// address from one that predates activation -- so without this the loop
/// closes the very connections it just arranged. Measured on the rig
/// with *no* selected process running before activation and dialling
/// started only after `split_tunnel_active`: "activation reset settled
/// after 12 rescan(s): 30 connection(s) closed in total". All thirty had
/// been carried successfully. A selected application got three seconds
/// of churn for nothing.
///
/// The NAT table is the only thing that can tell the two apart. A
/// carried flow is keyed on the application's own local port and the
/// real destination -- the rewrite happens on the wire, not in the
/// socket, so the connection table still shows the pre-rewrite address
/// the table was keyed on. The escape audit turns on exactly the same
/// question for exactly the same reason; see
/// [`escaped_connections`].
///
/// `carried` must not disturb what it reads. Pass
/// [`crate::split_tunnel::flows::Nat::has_flow`], never `lookup_flow` -- the latter
/// refreshes `last_seen`, and a rescan loop asking about every
/// established connection twice a second would keep every entry alive
/// forever and stop `expire_idle` retiring anything.
///
/// Connections to the LAN, to loopback and to the node itself. Closing
/// those is pure harm and buys nothing, because none of them would ever
/// have been redirected: the kernel filter excludes every one of those
/// destinations before the redirect loop is given a packet, so a
/// connection to a printer, a NAS or the machine's own services is not
/// a connection that is missing out on the tunnel -- it is one the
/// tunnel was never for. The node's own address is worse than pointless:
/// it is the tunnel, and in `AllExcept` it would be closed on every
/// activation.
///
/// Neoxify's own connections, for the same reason plus a sharper one.
/// In `AllExcept` the service and the app are "selected" by default --
/// nobody thinks to exclude the VPN client -- so without this the reset
/// would close the app's link to its own API every time Custom mode came
/// on, which is the 0.9.22 bug arriving through a different door. It
/// matters more now that this runs repeatedly rather than once.
///
/// What one pass of the reset managed, and what it could not.
#[derive(Debug, Default)]
pub struct ResetOutcome {
    pub closed: usize,
    /// Rows `SetTcpEntry` refused, described well enough to act on.
    ///
    /// These used to be swallowed: the return value was checked, and a
    /// failure simply did not increment the count. That made a refusal
    /// indistinguishable from a row that was never a candidate, which
    /// matters more now that the reset runs repeatedly -- a connection
    /// that cannot be closed is one the loop will keep failing to close
    /// for the whole window, and the log would show only a number that
    /// did not move.
    pub failures: Vec<String>,
    /// Rows that were a candidate in every respect except their state:
    /// owned by a selected application, headed somewhere the tunnel is
    /// for, and in `SYN_SENT` at the instant the table was walked.
    ///
    /// They are NOT closed, and cannot be: `SetTcpEntry` has no way to
    /// tear down a half-open connection. That is why the activation reset
    /// rescans rather than running once -- a row seen here should be
    /// ESTABLISHED by a later pass and closed then.
    ///
    /// Counted because the rescan is an *assumption* that this converges,
    /// and nothing measured it. A non-zero count on the final pass is a
    /// connection that finished its handshake outside the tunnel and
    /// stayed there, which is the failure the open item since 2026-08-22
    /// describes; zero on the final pass says convergence did its job.
    pub skipped_handshaking: usize,
}

/// Returns what was closed and what refused to close, for the log.
pub fn reset_selected_connections(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> ResetOutcome {
    // SAFETY: `row` is a correctly shaped MIB_TCPROW; the call only
    // reads it.
    reset_with(selection, node, own_images, carried, &|row| unsafe {
        SetTcpEntry(row.as_mut_ptr() as *mut _)
    })
}

/// The reset with the one thing that touches the machine handed in.
///
/// Split out only so it can be tested. `reset_selected_connections`
/// walks this machine's real connection table -- there is no other kind
/// -- so a test that exercised the real closer would tear down whatever
/// the developer or the build agent happened to have open. With the
/// closer stubbed, the classification can be checked against real rows
/// without a single `SetTcpEntry`.
fn reset_with(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
    close: &dyn Fn(&mut [u32; 5]) -> u32,
) -> ResetOutcome {
    let mut outcome = ResetOutcome::default();
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return outcome;
    };

    let mut images: HashMap<u32, Option<String>> = HashMap::new();

    for row in rows(&words, Layout::Tcp4) {
        let (Some(state), pid) = (row.state(), row.pid()) else { continue };

        // Only connections that actually carry traffic. A listener has
        // no peer to re-route and killing one would stop a program
        // accepting connections, which is not what was asked for.
        //
        // SYN_SENT is let through to the candidacy checks below but never
        // closed: it is the one non-established state whose remote fields
        // are real, so a row skipped here is a connection that escapes the
        // reset and completes outside the tunnel. It is counted rather
        // than closed -- see ResetOutcome::skipped_handshaking.
        let handshaking = state == MIB_TCP_STATE_SYN_SENT;
        if state != MIB_TCP_STATE_ESTAB && !handshaking {
            continue;
        }

        // Where the far end is, decided before the more expensive
        // question of who owns the row.
        let Some((IpAddr::V4(remote), remote_port)) = row.remote() else { continue };

        // The node is the tunnel itself; everything else excluded here
        // is a destination the kernel filter would never have handed to
        // the redirect loop anyway. Closing them would break a printer,
        // a NAS or a local service to gain exactly nothing.
        if remote == node || !is_public_v4(remote) {
            continue;
        }

        // Already in the tunnel, so closing it would undo this
        // function's own work -- see the doc comment. Asked before the
        // owner is resolved, because this is a hash lookup under a
        // mutex and `image_path` opens a process handle.
        let local_port = row.local_port();
        if carried(Transport::Tcp, local_port, remote, remote_port) {
            continue;
        }

        let image = images
            .entry(pid)
            .or_insert_with(|| image_path(pid))
            .clone();
        let Some(image) = image else { continue };
        // Never Neoxify's own. In AllExcept the app and the service are
        // carried by default, and closing the app's link to its own API
        // on every activation is the 0.9.22 failure arriving by another
        // route.
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // Every candidacy test above has passed, so this row would have
        // been closed had it been established. Count it and move on.
        if handshaking {
            outcome.skipped_handshaking += 1;
            continue;
        }

        // MIB_TCPROW is the same five leading fields without the pid,
        // handed back to Windows exactly as they arrived -- the one
        // place a row is wanted raw rather than decoded.
        let f = row.fields;
        let mut set = [MIB_TCP_STATE_DELETE_TCB, f[1], f[2], f[3], f[4]];
        let ret = close(&mut set);
        if ret == NO_ERROR {
            outcome.closed += 1;
        } else {
            // Said out loud rather than swallowed. A connection that
            // will not close is one that goes on carrying the
            // customer's traffic outside the tunnel, and it is the
            // single most useful thing this function can report: the
            // count alone cannot tell "there was nothing to close" from
            // "Windows refused every attempt".
            outcome
                .failures
                .push(format!("could not close {image} -> {remote}:{remote_port} (error {ret})"));
        }
    }
    outcome
}

/// One row of the machine's TCP tables, in the shape the audit needs.
///
/// Separate from the `port -> pid` maps [`OwnerLookup`] builds, because
/// those deliberately throw away the two things the audit turns on: the
/// connection's state, and where its far end is.
struct TcpConnection {
    state: u32,
    local_port: u16,
    remote: IpAddr,
    remote_port: u16,
    pid: u32,
}

/// Every IPv4 TCP row, with its state and remote end intact.
fn tcp_connections_v4() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    tcp_connections(&words, Layout::Tcp4)
}

/// The rows of a TCP table, kept whole for the audit.
fn tcp_connections(words: &[u32], layout: Layout) -> Vec<TcpConnection> {
    rows(words, layout)
        .filter_map(|row| {
            let (remote, remote_port) = row.remote()?;
            Some(TcpConnection {
                state: row.state()?,
                local_port: row.local_port(),
                remote,
                remote_port,
                pid: row.pid(),
            })
        })
        .collect()
}

/// Every IPv6 TCP row.
///
/// Walked as well as the IPv4 table, and that is the point rather than
/// completeness for its own sake: a selected app's IPv6 is *blocked*
/// while Custom mode runs, so any established v6 connection it still
/// holds predates the switch and is living entirely outside the tunnel,
/// with nothing in the counters able to say so.
fn tcp_connections_v6() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    tcp_connections(&words, Layout::Tcp6)
}

/// A connection living outside the tunnel that should be inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Escape {
    pub image: String,
    pub remote: IpAddr,
    pub remote_port: u16,
    pub local_port: u16,
}

/// Established connections belonging to applications whose traffic is
/// supposed to be carried, which the redirect is not carrying.
///
/// # Why this exists at all
///
/// Every number in `redirect::Stats` is counted from inside the packet
/// loop, which means all of them are blind in the same direction: they
/// can only describe packets the loop was given. A connection that
/// escaped -- because its SYN raced the owner lookup, because it was
/// established before Custom mode came on, or because it is IPv6 and was
/// blocked rather than carried -- produces no packet the loop will ever
/// count. `seen`, `matched` and `redirected` all read healthy while it
/// carries the customer's traffic out in the clear. That is the failure
/// this feature has now shipped three separate versions of, and the
/// counters structurally cannot report it.
///
/// So this asks the other question, from the other side: not what the
/// loop did, but what the machine is actually holding open. The
/// connection tables know about every socket whether or not a packet of
/// its was ever intercepted, so a flow that got away is visible here and
/// nowhere else.
///
/// # What it deliberately does not report
///
/// * Rows whose owning process cannot be resolved. In `AllExcept` an
///   unresolvable owner is supposed to be tunnelled, so skipping it
///   under-reports -- but calling a connection an escape without being
///   able to name the program that made it produces a number nobody can
///   act on, and this file's history says an alarm nobody can act on is
///   worse than silence.
/// * Anything belonging to Neoxify itself. The relay's own onward
///   sockets are established to exactly the public destinations the
///   customer's apps asked for and have no NAT entry of their own, so
///   without this every carried flow would be counted twice: once as
///   itself and once as its own escape.
/// * The node, the LAN, loopback and the relay's own two ports -- none
///   of which the redirect was ever supposed to carry.
///
/// `carried` answers whether the redirect already holds a flow. It is
/// passed in rather than reached for, so this stays testable without a
/// NAT table and so the caller can guarantee the read does not disturb
/// the table's idle timers -- see `Nat::has_flow`.
///
/// This is **observation only**. Nothing here closes, drops or rewrites
/// anything: it produces a count and a list for the log, and every
/// decision about what to do with them is made elsewhere.
pub fn escaped_connections(
    selection: &Selection,
    own_images: &[String],
    node: Ipv4Addr,
    proxy_ports: (u16, u16),
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> Vec<Escape> {
    let mut images: HashMap<u32, Option<String>> = HashMap::new();
    let mut escapes = Vec::new();

    for row in tcp_connections_v4().into_iter().chain(tcp_connections_v6()) {
        // Only a connection that is carrying traffic. In every other
        // state the remote fields are zero or provisional, so there is
        // nothing to classify and nothing that has leaked yet.
        if row.state != MIB_TCP_STATE_ESTAB {
            continue;
        }

        // The relay's own ports, on either end of the row. The proxy's
        // listening side and the app's connection into it are both
        // ordinary TCP connections on this machine, and would otherwise
        // read as traffic that got away from the very thing carrying it.
        if row.local_port == proxy_ports.0
            || row.local_port == proxy_ports.1
            || row.remote_port == proxy_ports.0
            || row.remote_port == proxy_ports.1
        {
            continue;
        }

        match row.remote {
            // The node is the tunnel itself. Everything else excluded
            // here is the local network a split tunnel exists to leave
            // alone.
            IpAddr::V4(addr) if addr == node || !is_public_v4(addr) => continue,
            IpAddr::V6(addr) if !is_public_v6(addr) => continue,
            _ => {}
        }

        let image = images.entry(row.pid).or_insert_with(|| image_path(row.pid)).clone();
        let Some(image) = image else { continue };
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // A carried flow is keyed on the app's own port and the real
        // destination, which is what the connection table still shows:
        // the rewrite happens on the wire, not in the socket, so the
        // stack's idea of where this connection is going is the
        // pre-rewrite address the NAT table was keyed on.
        //
        // There is no v6 half to ask. The NAT table is IPv4 only, so an
        // established v6 connection belonging to a carried application
        // is an escape by construction -- which is the honest reading of
        // the 0.9.27 decision to block rather than carry, not a fault in
        // it.
        if let IpAddr::V4(addr) = row.remote {
            if carried(Transport::Tcp, row.local_port, addr, row.remote_port) {
                continue;
            }
        }

        escapes.push(Escape {
            image,
            remote: row.remote,
            remote_port: row.remote_port,
            local_port: row.local_port,
        });
    }

    escapes
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::SplitTunnelMode;

    /// The audit against this machine's real tables, with a selection
    /// that carries nothing.
    ///
    /// Not an assertion about a number -- that depends on whatever
    /// happens to be running -- but about the one property that holds
    /// whatever is running: an empty `OnlySelected` selection tunnels
    /// nothing, so nothing can have escaped from it. A non-zero answer
    /// would mean the classification is wrong, not that the machine is
    /// leaking.
    #[test]
    fn nothing_escapes_a_selection_that_carries_nothing() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        assert!(escapes.is_empty(), "found {escapes:?}");
    }

    /// The opposite direction, which is what shows the walk returns real
    /// rows rather than nothing at all.
    ///
    /// `AllExcept` with an empty list means everything is supposed to be
    /// carried, and `carried` here says nothing is -- so every
    /// established public connection this machine holds should come
    /// back. The count is not asserted, because a build agent may hold
    /// none; what is asserted is that whatever comes back is well formed
    /// and passes the classification it claims to have passed.
    #[test]
    fn the_walk_returns_rows_that_are_what_they_claim_to_be() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        println!("{} established connection(s) outside a nothing-carried tunnel", escapes.len());
        for escape in escapes.iter().take(5) {
            println!("{} -> {}:{}", escape.image, escape.remote, escape.remote_port);
            // An absolute path, not a name ending in `.exe`. That was the
            // original check and it is not a property Windows guarantees:
            // GitHub's own hosted runner agent is
            // `C:\ProgramData\GitHub\HostedComputeAgent\hosted-compute-agent`,
            // with no extension at all, and this test failed the moment
            // that process happened to hold a connection while it ran.
            // What the walk actually promises is a resolved image path,
            // so that is what is asserted.
            assert!(!escape.image.is_empty(), "{escape:?}");
            assert!(
                escape.image.contains('\\') || escape.image.contains('/'),
                "{escape:?}"
            );
            assert_ne!(escape.remote_port, 0, "{escape:?}");
            match escape.remote {
                IpAddr::V4(addr) => assert!(is_public_v4(addr), "{escape:?}"),
                IpAddr::V6(addr) => assert!(is_public_v6(addr), "{escape:?}"),
            }
        }
    }

    #[test]
    fn the_reset_leaves_a_machine_alone_when_nothing_is_selected() {
        // Against this machine's real connection table, which is the
        // only way to run it. An empty OnlySelected list carries
        // nothing, so nothing may be closed -- and this test exists
        // because the cost of being wrong about that is other people's
        // connections dying on a developer's desktop.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let outcome = reset_selected_connections(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
        );
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// The convergence loop's own connections, which it used to close.
    ///
    /// `AllExcept` with an empty exclusion list selects everything on
    /// the machine, which is the widest the reset can ever be asked to
    /// be. With `carried` saying every flow is already in the tunnel,
    /// the correct number of closures is zero -- that is the whole
    /// claim. Before the predicate existed the same call closed every
    /// established public connection on the machine, which is what the
    /// rig measured as thirty closures across twelve rescans with
    /// nothing stale to close.
    ///
    /// Run through `reset_with` with the closer stubbed, so a
    /// regression fails the assertion instead of tearing down the
    /// developer's connections to prove it.
    #[test]
    fn a_flow_the_redirect_already_holds_is_not_reset() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| true,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        assert_eq!(attempts.get(), 0, "a carried flow was handed to SetTcpEntry");
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// A half-open row is counted, never closed, and never counted when
    /// it was not a candidate in the first place.
    ///
    /// Only the negative direction is asserted, for the same reason the
    /// test below does not assert a count: whether this machine happens
    /// to hold a connection in SYN_SENT at this instant is not something
    /// a test can arrange. With `carried` saying everything is already in
    /// the tunnel, nothing is a candidate -- so a non-zero count here
    /// would mean the skip is being tallied before the candidacy checks
    /// rather than after them, which is the mistake worth guarding.
    #[test]
    fn a_handshaking_row_is_only_counted_when_it_was_a_candidate() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| true,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        assert_eq!(attempts.get(), 0, "a carried flow was handed to SetTcpEntry");
        assert_eq!(
            outcome.skipped_handshaking, 0,
            "a row that was never a candidate was counted as skipped"
        );
    }

    /// The other direction, which is what stops the test above passing
    /// because the walk found nothing.
    ///
    /// Same selection, same stub closer, `carried` saying nothing is in
    /// the tunnel. Whatever this machine holds open to the public
    /// internet should now be a candidate. The count is not asserted --
    /// a build agent may legitimately hold none -- but it is printed,
    /// and if it is non-zero then the assertion above means something.
    #[test]
    fn without_the_predicate_the_same_walk_finds_candidates() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        println!("{} connection(s) would have been closed", attempts.get());
        assert_eq!(outcome.closed, attempts.get());
    }

    #[test]
    fn a_flow_the_redirect_already_holds_is_not_an_escape() {
        // The predicate the whole audit turns on, said with a stub
        // rather than a live NAT table so the test states the rule
        // instead of restating the table's implementation.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| true,
        );
        // Every IPv4 row is claimed as carried, so only IPv6 rows -- for
        // which there is no NAT table to ask -- may remain.
        assert!(
            escapes.iter().all(|e| matches!(e.remote, IpAddr::V6(_))),
            "an IPv4 flow the NAT table holds must not be an escape: {escapes:?}"
        );
    }
}
