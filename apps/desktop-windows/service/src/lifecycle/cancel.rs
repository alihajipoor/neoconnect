//! Stopping work that is already running.
//!
//! What this replaces is a single global `AtomicBool`, and the shape of
//! its failure is worth writing down because it is the reason this is a
//! type rather than a flag.
//!
//! The old abandon flag was one slot shared by every operation, and
//! every request arm cleared it on entry. Three engine budgets exceeded
//! the app's own 45-second reply deadline, so a slow connect always blew
//! that deadline; the app then gave up on the *reply* but not on the
//! *work*, tore down, and issued a fresh connect. That new connect
//! cleared the flag -- including when a customer's disconnect had set it
//! a moment earlier -- and started a whole new connection the disconnect
//! then had to wait out. The button did nothing, and it did nothing
//! *because* the customer had pressed it during a slow connect, which is
//! precisely when they would.
//!
//! A token cannot be cleared by somebody else's operation, because there
//! is no "clear": it belongs to one operation, it goes one way, and the
//! next operation gets a new one. That property is the whole point, and
//! it is why `cancel()` exists and `reset()` does not.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How often a blocking wait looks at the token.
///
/// 50ms, which is what the flag it replaces used, and the reasoning
/// still holds: a cancellation the customer waits a twentieth of a
/// second for is indistinguishable from an instant one, and polling
/// faster buys nothing anybody can perceive while costing wakeups on a
/// machine that is usually also bringing up a tunnel.
const POLL: Duration = Duration::from_millis(50);

/// A one-way signal that one operation should stop.
///
/// Cheap to clone; every clone observes the same cancellation.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask the operation holding this token to stop.
    ///
    /// Idempotent, and safe to call from any thread -- including from
    /// the async side while the operation runs on its own thread, which
    /// is the case that matters: it is how a disconnect reaches a
    /// connect that is in the middle of a thirty-second stage.
    pub fn cancel(&self) {
        // Release, so everything this thread did before deciding to
        // cancel is visible to the thread that observes it.
        self.flag.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// `Err(Cancelled)` the moment this token is cancelled.
    ///
    /// The shape every stage uses, so that cancellation travels as an
    /// ordinary `?` rather than as something each author has to remember
    /// to check. Forgetting to check is not a hypothetical: the split
    /// tunnel never read the old flag once, across a thirty-eight second
    /// window that held the engine lock, and nothing in the type system
    /// objected.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }

    /// Sleep for `how_long`, returning early if cancelled.
    ///
    /// Blocking on purpose. The engine work this serves runs on its own
    /// thread rather than on a runtime worker, and an uncancellable
    /// `thread::sleep` is how a 1.5-second startup grace became 1.5
    /// seconds a disconnect could not interrupt.
    pub fn sleep(&self, how_long: Duration) -> Result<(), Cancelled> {
        self.wait_until(Instant::now() + how_long, || false).map(|_| ())
    }

    /// Poll `ready` until it returns true, the deadline passes, or the
    /// token is cancelled.
    ///
    /// Returns whether `ready` ever became true. This is the one place
    /// a stage is allowed to wait for the world to change -- a service
    /// to appear, an adapter to get an address -- and routing all of
    /// them through here is what makes "every wait is cancellable" a
    /// property of the module rather than a promise.
    pub fn wait_until(
        &self,
        deadline: Instant,
        mut ready: impl FnMut() -> bool,
    ) -> Result<bool, Cancelled> {
        loop {
            self.check()?;
            if ready() {
                return Ok(true);
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(false);
            }
            // Never overshoot the deadline by up to a poll interval: a
            // caller that budgeted 10s should not discover it spent
            // 10.05s, because these budgets nest and the outermost one
            // is a reply the app is timing.
            std::thread::sleep(POLL.min(deadline - now));
        }
    }

    /// Wait up to `within` for `ready`.
    pub fn wait_for(
        &self,
        within: Duration,
        ready: impl FnMut() -> bool,
    ) -> Result<bool, Cancelled> {
        self.wait_until(Instant::now() + within, ready)
    }
}

/// The operation was asked to stop and did.
///
/// Deliberately not an `io::Error`. A cancellation is not a fault, and
/// the difference matters at the top of the stack: a connect that was
/// cancelled must not be reported to the customer as a connection
/// failure, and must not be written to the teardown log as one either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the operation was cancelled")
    }
}

impl std::error::Error for Cancelled {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_token_is_not_cancelled() {
        assert!(!CancelToken::new().is_cancelled());
        assert!(CancelToken::new().check().is_ok());
    }

    /// The property the whole design rests on: a clone handed to a
    /// worker observes a cancellation raised by whoever kept the
    /// original. Without this, cancelling reaches nothing.
    #[test]
    fn a_clone_sees_the_cancellation() {
        let token = CancelToken::new();
        let worker = token.clone();
        token.cancel();
        assert!(worker.is_cancelled());
        assert_eq!(worker.check(), Err(Cancelled));
    }

    /// Cancelling twice is not an error. Disconnect and client-death can
    /// both fire for the same operation -- somebody presses Disconnect
    /// and then closes the window -- and the second must not be a
    /// special case anywhere.
    #[test]
    fn cancelling_twice_is_harmless() {
        let token = CancelToken::new();
        token.cancel();
        token.cancel();
        assert!(token.is_cancelled());
    }

    /// There is no way back. This is the bug the old global flag had:
    /// any request arm could clear it, so a retrying connect wiped the
    /// cancellation a customer's disconnect had just set. A token with
    /// no reset cannot express that mistake.
    #[test]
    fn there_is_no_way_to_uncancel() {
        let token = CancelToken::new();
        token.cancel();
        let other = CancelToken::new();
        // A different operation's token is a different signal entirely.
        assert!(!other.is_cancelled());
        // And the cancelled one stays cancelled.
        assert!(token.is_cancelled());
    }

    /// A sleep that cannot be interrupted is how a 1.5s startup grace
    /// became 1.5s of a dead Disconnect button.
    #[test]
    fn a_sleep_ends_early_when_cancelled() {
        let token = CancelToken::new();
        let worker = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            worker.cancel();
        });

        let started = Instant::now();
        let outcome = token.sleep(Duration::from_secs(30));
        let took = started.elapsed();

        assert_eq!(outcome, Err(Cancelled));
        assert!(took < Duration::from_secs(5), "returned after {took:?}, so it waited out the sleep");
    }

    #[test]
    fn a_wait_reports_when_the_condition_arrives() {
        let token = CancelToken::new();
        let mut looks = 0;
        let got = token
            .wait_for(Duration::from_secs(5), || {
                looks += 1;
                looks >= 3
            })
            .expect("not cancelled");
        assert!(got);
    }

    /// A deadline that passes is not a cancellation. The caller has to
    /// be able to tell "I gave up waiting" from "somebody stopped me",
    /// because one is a connection failure worth reporting and the other
    /// is the customer getting what they asked for.
    #[test]
    fn a_deadline_that_passes_is_not_a_cancellation() {
        let token = CancelToken::new();
        let got = token.wait_for(Duration::from_millis(120), || false).expect("not cancelled");
        assert!(!got, "the condition never became true, so this is a timeout");
        assert!(!token.is_cancelled());
    }

    /// Budgets nest, and the outermost one is a reply the app is timing.
    /// A wait that overshoots by up to a poll interval turns a stack of
    /// honest budgets into one that does not add up.
    #[test]
    fn a_wait_does_not_overshoot_its_deadline() {
        let token = CancelToken::new();
        let started = Instant::now();
        let _ = token.wait_for(Duration::from_millis(120), || false);
        let took = started.elapsed();
        assert!(
            took < Duration::from_millis(120) + POLL,
            "waited {took:?} against a 120ms budget"
        );
    }

    /// Cancellation beats the condition. A stage whose resource arrives
    /// in the same instant the customer gives up must still stop --
    /// otherwise a disconnect pressed at the wrong moment proceeds to
    /// bring the tunnel the rest of the way up.
    #[test]
    fn cancellation_wins_over_a_ready_condition() {
        let token = CancelToken::new();
        token.cancel();
        assert_eq!(token.wait_for(Duration::from_secs(5), || true), Err(Cancelled));
    }
}
