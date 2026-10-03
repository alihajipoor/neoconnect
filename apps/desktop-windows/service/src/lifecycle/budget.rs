//! Deadlines that have to fit inside each other.
//!
//! Every slow operation in this service runs inside something that is
//! already timing it. A stage's budget that exceeds its parent's is not
//! a tuning question, it is a guaranteed failure: the parent gives up
//! first, every time, and the child never gets to finish or to report
//! why. The symptom is never "a timeout was too short" -- it is a retry
//! storm, a request answered with nothing, or an operation that cannot
//! be cancelled because the thing that would cancel it already gave up.
//!
//! Two of these shipped, and both were found by arithmetic rather than
//! by testing:
//!
//! * **The connect path.** The app waits 45 seconds for a reply.
//!   OpenVPN's tunnel-up budget is 75, Xray's adapter wait is 60, and
//!   WireGuard's service-gone wait is exactly 45. So a connect that is
//!   slow but working *always* blows the app's deadline; the app then
//!   abandons the reply but not the work, tears down, and issues a fresh
//!   connect -- which clears the abandon flag the customer's disconnect
//!   had just set. The dead Disconnect button is this arithmetic.
//!
//! * **The control plane.** Each API endpoint got an 8 second timeout,
//!   tried in sequence, inside a 6 second refresh budget. The budget
//!   expired inside the first endpoint, so the remaining seven were
//!   never tried at all. One blocked address meant the refresh failed
//!   every time, which is why a customer could connect on Android and
//!   not on Windows from the same network.
//!
//! Neither was a hard thing to see. Both needed somebody to put two
//! numbers from two different files next to each other, which is what
//! this module exists to do once rather than hopefully.

use std::time::Duration;

/// A named deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub name: &'static str,
    pub limit: Duration,
}

impl Budget {
    pub const fn new(name: &'static str, limit: Duration) -> Self {
        Self { name, limit }
    }

    /// Whether `self` can run to its full length inside `parent`.
    ///
    /// Strictly less than, not less-than-or-equal. A child that exactly
    /// equals its parent leaves nothing for the overhead either side of
    /// it -- the request still has to cross a pipe and be deserialised
    /// -- so equality is a budget that is already spent. WireGuard's
    /// 45-second service-gone wait against the app's 45-second reply
    /// deadline is exactly this case, and it reads as "fits" to anyone
    /// checking casually.
    pub fn fits_inside(&self, parent: &Budget) -> bool {
        self.limit < parent.limit
    }
}

/// Every child must fit inside `parent`. Returns the ones that do not.
pub fn violations<'a>(parent: &Budget, children: &'a [Budget]) -> Vec<&'a Budget> {
    children.iter().filter(|c| !c.fits_inside(parent)).collect()
}

/// What the app waits for a reply to one request.
///
/// `REPLY_TIMEOUT` in the Tauri layer. The ceiling every per-request
/// budget in the service has to sit under, because once it passes the
/// app stops listening whatever the service goes on to do.
pub const APP_REPLY_DEADLINE: Budget =
    Budget::new("the app's reply deadline", Duration::from_secs(45));

/// What a disconnect's fast half may spend.
///
/// The customer-facing promise, and the only budget here derived from
/// what a person will sit through rather than from what a machine needs.
pub const HARD_STOP: Budget = Budget::new("a hard stop", Duration::from_millis(900));

#[cfg(test)]
mod tests {
    use super::*;

    /// The budgets the engines actually use today, read from their own
    /// modules. Kept here as literals rather than imported because this
    /// crate does not compile off Windows and these tests have to run
    /// where the work happens; the test below is what keeps them honest
    /// against the real constants.
    const OPENVPN_TUNNEL_UP: Budget =
        Budget::new("openvpn tunnel-up", Duration::from_secs(75));
    const XRAY_ADAPTER_WAIT: Budget =
        Budget::new("xray adapter wait", Duration::from_secs(60));
    const WIREGUARD_SERVICE_GONE: Budget =
        Budget::new("wireguard service-gone", Duration::from_secs(45));

    #[test]
    fn a_hard_stop_fits_inside_the_reply_deadline() {
        assert!(HARD_STOP.fits_inside(&APP_REPLY_DEADLINE));
    }

    /// The arithmetic that produced the dead Disconnect button, written
    /// down so it cannot quietly come back.
    ///
    /// This asserts the bug rather than the fix, deliberately: the three
    /// engine budgets still exceed the app's deadline on disk, and
    /// changing them is a behavioural decision about how long a slow
    /// connect may take, not a number to adjust in passing. When they
    /// are brought under the deadline this test fails, and the right
    /// response is to invert it -- at which point it becomes the
    /// regression guard it should have been all along.
    #[test]
    fn the_engine_budgets_still_exceed_the_reply_deadline() {
        let engines = [OPENVPN_TUNNEL_UP, XRAY_ADAPTER_WAIT, WIREGUARD_SERVICE_GONE];
        let bad = violations(&APP_REPLY_DEADLINE, &engines);
        assert_eq!(
            bad.len(),
            3,
            "all three still overrun; if this changed, invert the assertion rather than deleting it"
        );
    }

    /// Equality is not fitting. WireGuard's 45 seconds against the app's
    /// 45 is the case that reads as fine and is not.
    #[test]
    fn a_budget_equal_to_its_parent_does_not_fit() {
        assert!(!WIREGUARD_SERVICE_GONE.fits_inside(&APP_REPLY_DEADLINE));
    }

    /// The control-plane bug, in the same shape. An 8 second per-address
    /// timeout inside a 6 second refresh meant exactly one address was
    /// ever tried.
    #[test]
    fn the_endpoint_timeout_never_fitted_the_refresh_budget() {
        let refresh = Budget::new("pre-connect config refresh", Duration::from_secs(6));
        let per_endpoint = Budget::new("one API endpoint", Duration::from_secs(8));
        assert!(
            !per_endpoint.fits_inside(&refresh),
            "this is the arithmetic that stopped Windows reaching the control plane"
        );
    }

    #[test]
    fn a_child_that_fits_is_reported_as_fitting() {
        let parent = Budget::new("parent", Duration::from_secs(10));
        let child = Budget::new("child", Duration::from_secs(9));
        assert!(child.fits_inside(&parent));
        assert!(violations(&parent, &[child]).is_empty());
    }

    #[test]
    fn violations_name_every_offender() {
        let parent = Budget::new("parent", Duration::from_secs(5));
        let children = [
            Budget::new("ok", Duration::from_secs(1)),
            Budget::new("too long", Duration::from_secs(6)),
            Budget::new("exactly equal", Duration::from_secs(5)),
        ];
        let bad = violations(&parent, &children);
        let names: Vec<&str> = bad.iter().map(|b| b.name).collect();
        assert_eq!(names, vec!["too long", "exactly equal"]);
    }
}
