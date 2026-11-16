//! Taking the tunnel down in two phases.
//!
//! The ordering and the rules are the Windows service's
//! (`apps/desktop-windows/service/src/lifecycle/teardown.rs`), where they
//! were learned the hard way; only the steps differ, because Linux has
//! fewer things to undo.
//!
//! * **Phase one** is what the customer waits for: stop the engine and
//!   take its routes out (`Tunnel::hard_stop`), then delete our nftables
//!   table. Kill, delete, answer. Nothing here may wait for anything slow.
//! * **Phase two** is `Tunnel::finish_stop` -- DNS restored, links
//!   deleted, the ledger settled -- run behind the reply, because it can
//!   take seconds and the machine's networking is already back.
//!
//! The engine goes first because that is what stops traffic. The leak
//! protection goes straight after it: it allows nothing but the tunnel,
//! so holding it a moment longer than the tunnel would leave the machine
//! with no internet at all, and this product fails open.
//!
//! **No step may short-circuit another.** Every one runs regardless of
//! what the previous returned. A failure halfway that left the rest
//! undone is how a machine ends up with a firewall table nobody owns.

use std::time::{Duration, Instant};

/// The budget phase one is held to. The Windows number, kept: the
/// customer's promise is the same on every platform.
pub const HARD_STOP_BUDGET: Duration = Duration::from_millis(900);

/// The steps of a hard stop, in the order they must run. A trait so the
/// sequencing can be tested without a tunnel or root.
///
/// Every method returns `Result` so a failure can be *reported*, never so
/// it can stop the rest. See [`hard_stop`].
pub trait HardStopSteps {
    /// Stop the engine and take its routes out (`Tunnel::hard_stop`).
    fn stop_tunnel(&mut self) -> Result<(), String>;

    /// Delete the nftables table, the moment the engine is gone.
    fn release_leak_protection(&mut self) -> Result<(), String>;
}

/// What one step did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutcome {
    pub name: &'static str,
    pub took: Duration,
    /// `None` when it succeeded.
    pub failed: Option<String>,
}

/// What a hard stop did, in full.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardStopReport {
    pub steps: Vec<StepOutcome>,
    pub took: Duration,
}

impl HardStopReport {
    pub fn all_succeeded(&self) -> bool {
        self.steps.iter().all(|s| s.failed.is_none())
    }

    /// Whether this ran inside the budget. Reported rather than enforced:
    /// stopping a teardown early leaves more behind, not less.
    pub fn within_budget(&self) -> bool {
        self.took <= HARD_STOP_BUDGET
    }

    /// One line for the log. Names the steps that failed and their own
    /// reasons, which are ours (never a profile's contents).
    pub fn summary(&self) -> String {
        let failures: Vec<String> = self
            .steps
            .iter()
            .filter_map(|s| s.failed.as_ref().map(|why| format!("{} ({why})", s.name)))
            .collect();
        let shape = if failures.is_empty() {
            "all steps ok".to_owned()
        } else {
            format!("failed: {}", failures.join(", "))
        };
        format!("hard stop in {}ms, {shape}", self.took.as_millis())
    }
}

/// Run phase one. Every step runs, whatever the one before it did.
pub fn hard_stop(steps: &mut dyn HardStopSteps) -> HardStopReport {
    let began = Instant::now();
    let mut outcomes = Vec::with_capacity(2);

    // Written out rather than looped: the order is the part that matters.
    let at = Instant::now();
    let r = steps.stop_tunnel();
    outcomes.push(StepOutcome { name: "stop the tunnel", took: at.elapsed(), failed: r.err() });

    let at = Instant::now();
    let r = steps.release_leak_protection();
    outcomes.push(StepOutcome { name: "remove the leak protection", took: at.elapsed(), failed: r.err() });

    HardStopReport { steps: outcomes, took: began.elapsed() }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Spy {
        order: Vec<&'static str>,
        fail: Vec<&'static str>,
    }

    impl Spy {
        fn record(&mut self, name: &'static str) -> Result<(), String> {
            self.order.push(name);
            if self.fail.contains(&name) {
                return Err(format!("{name} went wrong"));
            }
            Ok(())
        }
    }

    impl HardStopSteps for Spy {
        fn stop_tunnel(&mut self) -> Result<(), String> {
            self.record("tunnel")
        }
        fn release_leak_protection(&mut self) -> Result<(), String> {
            self.record("guard")
        }
    }

    /// The engine first, because that is what stops traffic; the table
    /// straight after, because it blocks everything but the tunnel.
    #[test]
    fn the_engine_goes_first_and_the_table_straight_after() {
        let mut spy = Spy { order: Vec::new(), fail: Vec::new() };
        let report = hard_stop(&mut spy);
        assert_eq!(spy.order, vec!["tunnel", "guard"]);
        assert!(report.all_succeeded());
        assert!(report.within_budget());
        assert!(report.summary().contains("all steps ok"));
    }

    /// A failed engine stop must not leave the machine behind a table
    /// that allows only a tunnel that is gone.
    #[test]
    fn a_failing_step_does_not_stop_the_ones_after_it() {
        let mut spy = Spy { order: Vec::new(), fail: vec!["tunnel"] };
        let report = hard_stop(&mut spy);
        assert_eq!(spy.order, vec!["tunnel", "guard"], "every step must run");
        assert!(!report.all_succeeded());
        assert!(report.summary().contains("stop the tunnel (tunnel went wrong)"), "{}", report.summary());
    }
}
