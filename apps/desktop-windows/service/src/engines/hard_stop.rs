//! Phase one of a teardown, against the real engines.
//!
//! [`crate::lifecycle::teardown`] owns the shape -- the order, the
//! budget, the rule that no step may short-circuit another -- and is
//! tested without Windows. This is the half that actually touches the
//! machine.
//!
//! Every step here is chosen for the same property: it must finish in
//! milliseconds and must not depend on anything else finishing. No
//! process is launched, nothing is polled until it disappears, and no
//! cmdlet is run. What the slow, thorough pass does afterwards is
//! [`Engines::disconnect`], which still exists unchanged and still runs
//! -- just behind the customer rather than in front of them.

use super::{dns, wireguard, Active, Engines};
use crate::lifecycle::teardown::HardStopSteps;

impl HardStopSteps for Engines {
    /// Take the session down by the shortest route available for
    /// whatever is live.
    ///
    /// `Slot::end` is what stops Custom mode as well, which matters:
    /// leaving the redirect running over a tunnel that no longer exists
    /// is the 2026-08-23 class of bug the slot type was introduced to
    /// make unrepresentable.
    fn kill_engines(&mut self) -> Result<(), String> {
        let Some(active) = self.end_session() else {
            return Ok(());
        };

        match active {
            // TerminateProcess, by way of `Child::kill`. Not a graceful
            // shutdown and not a wait for one: traffic stops when the
            // process dies, and the adapter goes with it, which takes
            // most of the routes with it too.
            //
            // Most, not all -- and the routes are removed here rather
            // than left to the thorough pass, because by then there is
            // nothing to remove them *from*. `end_session` took the
            // session, so a later `disconnect()` finds an empty slot and
            // the record of what was installed is gone with it. The one
            // route that does not vanish with the adapter is the host
            // route to the node, which sits on the *physical* interface;
            // leaving it would be a small leak that nothing cleans until
            // the machine reboots.
            //
            // This is the one step that runs an executable, and it is a
            // deliberate exception rather than a hole in the rule. The
            // rule is about PowerShell, where 4.4 to 6.5 seconds is
            // spent before the first statement runs; `route.exe` is a
            // small native program with no runtime to start, and there
            // are at most three of them.
            Active::Child { protocol, mut child, mut routes } => {
                let killed = child
                    .kill()
                    .map_err(|err| format!("could not stop the {protocol} engine: {err}"));
                // After the kill and regardless of it: a route left
                // behind is worse than one removed from an engine that
                // was already gone.
                routes.remove();
                killed
            }

            // Dropping the handle is RasHangUpW. One API call, no
            // process -- see `ras::Connection`.
            Active::Ikev2(live) => {
                let code = live.hang_up();
                if code == 0 {
                    Ok(())
                } else {
                    Err(format!("the IKEv2 tunnel did not hang up: {}", super::ikev2::dial_error(code)))
                }
            }

            // Handled by the dedicated step, because stopping it and
            // waiting for it to be gone are different operations and
            // only the first belongs here.
            Active::WireguardTunnel => Ok(()),
        }
    }

    /// Let go of the kernel's filters.
    ///
    /// Both the IPv6 block and WinDivert are reclaimed by the kernel
    /// when their handles close, so this is not what *makes* them safe
    /// -- a killed service already unblocks IPv6 at the same instant it
    /// stops carrying IPv4. Dropping them explicitly only makes it
    /// immediate rather than process-lifetime, which is the difference
    /// between a customer's IPv6 working again now and working again
    /// when they next reboot.
    fn release_kernel_filters(&mut self) -> Result<(), String> {
        self.unblock_ipv6();
        Ok(())
    }

    /// Delete the NRPT rules by writing the registry.
    ///
    /// The leftover that strands a whole machine, and the one step where
    /// the choice of mechanism decides whether the budget is met at all:
    /// 48 to 64 milliseconds for the registry delete against 4.4 to 6.5
    /// seconds merely to start PowerShell.
    fn clear_dns_rules(&mut self) -> Result<(), String> {
        let cleared = dns::clear_registry_only();
        self.forget_dns_state();
        match cleared.unverified {
            // Reported, not fatal, and not retried here with cmdlets --
            // the thorough pass behind this does that. An unverified
            // removal must never read as a clean one, which is the
            // distinction this field exists for.
            Some(why) => Err(format!("the DNS rules were not verifiably removed: {why}")),
            None => Ok(()),
        }
    }

    fn request_tunnel_service_stop(&mut self) -> Result<(), String> {
        wireguard::request_stop_without_waiting()
    }
}
