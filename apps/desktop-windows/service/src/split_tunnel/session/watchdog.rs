//! The backstop that switches interception off when the tunnel under a
//! session disappears without anybody saying so.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;

use crate::adapters;
use crate::split_tunnel::worker::{sleep_unless_stopped, Worker};
use crate::split_tunnel::{intercept, net};

use crate::split_tunnel::log_file::append;

/// How often the backstop looks at the adapter it was pinned to.
///
/// Three seconds. The thing it is watching for leaves the machine with
/// no working name resolution at all, so the cost of noticing late is
/// paid by somebody staring at a browser that will not load, and the
/// check itself is one adapter enumeration.
const WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);

/// How many consecutive looks must say "gone" before interception stops.
///
/// Two, so a single unlucky enumeration cannot take down a healthy
/// session. It is only ever consecutive *evidence* that counts -- a
/// query that failed is not evidence, see [`Liveness::NoEvidence`] --
/// and the run is reset by any look that finds the adapter well.
const WATCHDOG_STRIKES: u32 = 2;

/// What one look at the tunnel adapter established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Liveness {
    /// The adapter is there, up, and still carrying the address the
    /// relays bind their upstream sockets to.
    Alive,
    /// The adapter this session was built on is not usable any more.
    Gone,
    /// The question could not be answered. **Not** the same as `Gone`,
    /// and the distinction is the entire reason this is a three-valued
    /// answer rather than a bool: an adapter enumeration that fails
    /// says something about the enumeration, and tearing a working
    /// customer's tunnel down over it would be a self-inflicted outage
    /// of exactly the kind this backstop exists to prevent.
    NoEvidence,
}

/// Whether the tunnel this session was pinned to is still there.
///
/// Split out from the thread so it can be tested, because every branch
/// here is a decision to leave a customer's traffic alone or to stop
/// carrying it, and neither is safe to get wrong.
fn liveness(
    expected_index: u32,
    expected_address: Ipv4Addr,
    found: &std::io::Result<Option<adapters::Adapter>>,
) -> Liveness {
    match found {
        Err(_) => Liveness::NoEvidence,
        // The adapter is not there at all. This is what a WireGuard
        // tunnel service going away looks like, and an Xray engine
        // exiting, and a RAS connection dropping.
        Ok(None) => Liveness::Gone,
        Ok(Some(adapter)) => {
            if !adapter.is_up {
                return Liveness::Gone;
            }
            // A same-named adapter with a different index or address is
            // not this session's tunnel -- it is a new one, built by
            // somebody else, and the relays are still pinned to the old
            // one. Treated as gone rather than alive, because that is
            // what it is from this session's point of view.
            if adapter.index != expected_index || adapter.ipv4 != Some(expected_address) {
                return Liveness::Gone;
            }
            Liveness::Alive
        }
    }
}

/// Stops interception if the tunnel underneath it disappears.
///
/// The belt to `engines::session::Slot`'s braces. `Slot` makes it impossible for
/// the engine layer to end a session without stopping Custom mode; this
/// covers the case where nobody up there noticed at all -- an adapter
/// pulled out from under a process that is still running, a driver
/// reset, an engine that is alive and no longer carrying anything.
///
/// The failure it exists to prevent is not subtle. A redirect loop with
/// no tunnel behind it takes every DNS lookup on the machine, from every
/// process, and hands them to a relay whose upstream socket cannot bind
/// -- so nothing resolves, for anything, including other VPN clients,
/// until this service's process is killed. That was a real customer's
/// afternoon on 2026-08-23.
///
/// It can only switch interception off, not take the session apart:
/// joining the redirect's workers from a thread the session owns would
/// deadlock the teardown that is trying to join this one. Switching it
/// off is what gives the machine back.
///
/// Stopped by being dropped, which joins its thread.
pub(super) struct Watchdog {
    _worker: Worker,
}

impl Watchdog {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn start(
        adapter_name: String,
        index: u32,
        address: Ipv4Addr,
        tunnel: Arc<net::pin::TunnelInterface>,
        stopper: intercept::Stopper,
        log_path: PathBuf,
        tripped: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let worker = Worker::spawn(move |stop| {
            let mut strikes = 0;
            while sleep_unless_stopped(&stop, WATCHDOG_INTERVAL) {
                match liveness(index, address, &adapters::find_by_name(&adapter_name)) {
                    Liveness::Alive => strikes = 0,
                    Liveness::NoEvidence => {}
                    Liveness::Gone => {
                        strikes += 1;
                        if strikes < WATCHDOG_STRIKES {
                            continue;
                        }
                        let detail = format!(
                            "the tunnel adapter {adapter_name} (interface {index}, {address}) \
                             is gone, but Custom mode was still intercepting this machine's \
                             packets -- interception has been stopped so traffic can flow \
                             normally again"
                        );
                        // Both files on purpose. cleanup.log is the
                        // one a support conversation asks for, and
                        // split-tunnel.log is where the counters
                        // that stop moving are, so the two halves of
                        // the story are readable together.
                        crate::cleanup_log::note(
                            "stop Custom mode after its tunnel disappeared",
                            &detail,
                        );
                        append(&log_path, &format!("WATCHDOG {detail}"));
                        tripped.store(true, std::sync::atomic::Ordering::SeqCst);
                        // Cleared as well as shut down: any relay
                        // thread already past the redirect sees no
                        // tunnel and takes the ordinary route rather
                        // than retrying a bind that cannot succeed.
                        tunnel.clear();
                        stopper.stop_intercepting();
                        return;
                    }
                }
            }
        });
        Self { _worker: worker }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tunnel adapter that is present and well must never be read as
    /// gone. This is the case the backstop must not get wrong in the
    /// expensive direction -- tearing a working customer's Custom mode
    /// down would be an outage this code caused.
    fn adapter(index: u32, ipv4: Option<Ipv4Addr>, is_up: bool) -> adapters::Adapter {
        adapters::Adapter {
            index,
            name: "neoconnect".to_string(),
            gateway: None,
            ipv4,
            is_up,
            description: "WireGuard Tunnel".to_string(),
        }
    }

    const IDX: u32 = 20;
    fn addr() -> Ipv4Addr {
        Ipv4Addr::new(10, 66, 0, 2)
    }

    #[test]
    fn a_healthy_tunnel_adapter_is_left_alone() {
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, Some(addr()), true)))),
            Liveness::Alive
        );
    }

    #[test]
    fn an_adapter_that_has_gone_is_reported_gone() {
        // The measured shape of the 2026-08-23 field bug: the WireGuard
        // tunnel service was uninstalled, the adapter went with it, and
        // the relays kept trying to bind to interface 20 / 10.66.0.2 --
        // "upstream attach FAILED for 1.1.1.1:53 ... (interface 20,
        // source 10.66.0.2)", several times a second, forever.
        assert_eq!(liveness(IDX, addr(), &Ok(None)), Liveness::Gone);
        // Present but down is the same thing from here.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, Some(addr()), false)))),
            Liveness::Gone
        );
        // Present, up, and no longer holding the address the relays bind
        // their upstream sockets to. Binding is what fails first, so an
        // adapter that kept its index and lost its address is just as
        // dead to this session.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX, None, true)))),
            Liveness::Gone
        );
        // A same-named adapter that somebody else rebuilt. Not ours.
        assert_eq!(
            liveness(IDX, addr(), &Ok(Some(adapter(IDX + 1, Some(addr()), true)))),
            Liveness::Gone
        );
    }

    /// The control, and the reason `liveness` has three values rather
    /// than two.
    ///
    /// A `bool` implementation reading "not provably alive means dead"
    /// passes every assertion above and fails this one. Without it the
    /// whole matrix could not come back negative for the mistake most
    /// worth catching: an adapter enumeration that failed says nothing
    /// about the adapter, and treating it as death would let one
    /// unlucky syscall drop a working customer out of their tunnel.
    #[test]
    fn a_failed_enumeration_is_not_evidence_of_anything() {
        let failed = Err(std::io::Error::new(std::io::ErrorKind::Other, "GetAdaptersAddresses"));
        assert_eq!(liveness(IDX, addr(), &failed), Liveness::NoEvidence);
        assert_ne!(
            liveness(IDX, addr(), &failed),
            Liveness::Gone,
            "a query that failed must never be read as the tunnel having gone"
        );
    }

    /// One bad look is not enough, and the run has to be consecutive.
    #[test]
    fn the_backstop_needs_more_than_one_look() {
        assert!(WATCHDOG_STRIKES > 1, "a single unlucky look must not stop interception");
    }
}
