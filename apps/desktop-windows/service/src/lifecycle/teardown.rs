//! Taking the tunnel down in two phases.
//!
//! The bar is one to two seconds: press Disconnect, the engines are gone
//! from the machine, networking is back to normal. Other clients manage
//! it and customers compare.
//!
//! One measurement decides the whole design, and it is already recorded
//! in `engines::dns` from a 4-vCPU Windows 11 guest:
//!
//! ```text
//!   powershell -NoProfile -Command 1                            4.4 -  6.5s
//!   Get-DnsClientNrptRule | Measure-Object                      9.6 - 66.7s
//!   the registry enumeration that replaces it                   32 -  237ms
//!   the registry delete that replaces Remove-DnsClientNrptRule  48 -   64ms
//! ```
//!
//! **Starting PowerShell at all costs more than the entire budget.** So
//! the teardown splits:
//!
//! * **Phase one** is what the customer waits for. It may not launch a
//!   process, wait for anything to disappear, poll for a service to
//!   deregister, or take a lock another operation can hold. Kill, close,
//!   delete, answer.
//! * **Phase two** is everything slow and thorough, run in the
//!   background. If it takes forty seconds nobody notices, because the
//!   machine's networking came back in phase one.
//!
//! The ordering inside phase one is not arbitrary. Engines die first,
//! because that is what stops traffic, and a customer who pressed
//! Disconnect wants their packets to stop going through a tunnel more
//! than they want a tidy registry. DNS comes next, because a stale NRPT
//! rule is the one leftover that strands a whole machine.
//!
//! **No step may short-circuit another.** Every one runs regardless of
//! what the previous returned. This is the single most important rule
//! here, and it is the rule the old code broke: its cleanup sat at the
//! end of a successful disconnect, so a failure halfway through left
//! everything after it undone -- which is how a machine ends up with its
//! DNS pointed at a resolver that no longer exists.

use std::time::{Duration, Instant};

/// The budget phase one is held to.
///
/// Below the one-to-two seconds a customer is promised, because this is
/// not the only thing between pressing the button and seeing it change:
/// the reply still has to cross the pipe and the app still has to
/// redraw.
pub const HARD_STOP_BUDGET: Duration = Duration::from_millis(900);

/// The steps of a hard stop, in the order they must run.
///
/// A trait so the sequencing and the budget can be tested without
/// Windows -- which matters here more than almost anywhere, because the
/// service cannot be compiled off Windows and every check against the
/// real thing costs a sixteen-minute CI cycle.
///
/// Every method returns `Result` so a failure can be *reported*, never
/// so it can stop the rest. See [`hard_stop`].
pub trait HardStopSteps {
    /// `TerminateProcess` on every engine child.
    ///
    /// Not a graceful shutdown and not a wait for one. Traffic stops
    /// when the process dies, and asking an engine politely to exit is
    /// how a disconnect comes to take forty-five seconds. Adapters
    /// vanish with their processes, and routes on a vanished adapter go
    /// with them, so most of "networking back to normal" is this step.
    fn kill_engines(&mut self) -> Result<(), String>;

    /// Drop the WFP and WinDivert handles.
    ///
    /// Both are handle-scoped or in dynamic sessions, so the kernel
    /// reclaims the filters whether or not anything here runs. Closing
    /// them explicitly only makes it immediate rather than
    /// process-lifetime.
    fn release_kernel_filters(&mut self) -> Result<(), String>;

    /// Delete the NRPT rules by writing the registry directly.
    ///
    /// Never by cmdlet. This is the leftover that strands a machine --
    /// a machine-wide DNS override, in the registry, surviving both a
    /// kill and a reboot -- and it is also, by the measurements above,
    /// three orders of magnitude cheaper to remove the direct way.
    fn clear_dns_rules(&mut self) -> Result<(), String>;

    /// Ask the SCM to stop the WireGuard tunnel service, and do not wait.
    ///
    /// The old path called `wireguard.exe /uninstalltunnelservice` and
    /// waited up to forty-five seconds for the service to disappear; it
    /// once held the engine lock for twenty-five minutes in the field,
    /// and every request behind it went unanswered while the customer
    /// sat tunnelled with no way out. The stop is requested here and
    /// confirmed in phase two.
    fn request_tunnel_service_stop(&mut self) -> Result<(), String>;
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

    /// Whether this ran inside the budget it is held to.
    ///
    /// Reported rather than enforced. There is no useful way to abandon
    /// a teardown halfway -- stopping early leaves more behind, not
    /// less -- so the budget is a thing to notice in the log and fix at
    /// the source, not a deadline to abort on.
    pub fn within_budget(&self) -> bool {
        self.took <= HARD_STOP_BUDGET
    }

    /// One line for the teardown log.
    pub fn summary(&self) -> String {
        let failures: Vec<&str> = self
            .steps
            .iter()
            .filter(|s| s.failed.is_some())
            .map(|s| s.name)
            .collect();
        let shape = if failures.is_empty() {
            "all steps ok".to_owned()
        } else {
            format!("failed: {}", failures.join(", "))
        };
        format!("hard stop in {}ms, {shape}", self.took.as_millis())
    }
}

/// Run phase one.
///
/// Every step runs. None of them can stop another, whatever it returns
/// or however long it takes -- a failed DNS clear must not mean the
/// engines keep running, and a failed engine kill must not mean the
/// machine keeps a dead resolver.
pub fn hard_stop(steps: &mut dyn HardStopSteps) -> HardStopReport {
    let began = Instant::now();
    let mut outcomes = Vec::with_capacity(4);

    // Order matters; see the module comment. Engines first, because
    // that is what stops traffic. Written out rather than looped: each
    // step is a different method, and a macro or a closure over them
    // would hide the order, which is the part that matters.
    let at = Instant::now();
    let r = steps.kill_engines();
    outcomes.push(StepOutcome { name: "kill engines", took: at.elapsed(), failed: r.err() });

    let at = Instant::now();
    let r = steps.release_kernel_filters();
    outcomes.push(StepOutcome { name: "release kernel filters", took: at.elapsed(), failed: r.err() });

    let at = Instant::now();
    let r = steps.clear_dns_rules();
    outcomes.push(StepOutcome { name: "clear DNS rules", took: at.elapsed(), failed: r.err() });

    let at = Instant::now();
    let r = steps.request_tunnel_service_stop();
    outcomes.push(StepOutcome {
        name: "request tunnel service stop",
        took: at.elapsed(),
        failed: r.err(),
    });

    HardStopReport { steps: outcomes, took: began.elapsed() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Records the order steps ran in, and can be told to fail any of
    /// them.
    struct Spy {
        order: Arc<std::sync::Mutex<Vec<&'static str>>>,
        fail: Vec<&'static str>,
        slow: Option<(&'static str, Duration)>,
        ran: Arc<AtomicUsize>,
    }

    impl Spy {
        fn new() -> Self {
            Self {
                order: Arc::new(std::sync::Mutex::new(Vec::new())),
                fail: Vec::new(),
                slow: None,
                ran: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn record(&mut self, name: &'static str) -> Result<(), String> {
            self.order.lock().unwrap().push(name);
            self.ran.fetch_add(1, Ordering::SeqCst);
            if let Some((slow, how_long)) = self.slow {
                if slow == name {
                    std::thread::sleep(how_long);
                }
            }
            if self.fail.contains(&name) {
                return Err(format!("{name} went wrong"));
            }
            Ok(())
        }
    }

    impl HardStopSteps for Spy {
        fn kill_engines(&mut self) -> Result<(), String> {
            self.record("kill")
        }
        fn release_kernel_filters(&mut self) -> Result<(), String> {
            self.record("filters")
        }
        fn clear_dns_rules(&mut self) -> Result<(), String> {
            self.record("dns")
        }
        fn request_tunnel_service_stop(&mut self) -> Result<(), String> {
            self.record("service")
        }
    }

    /// Engines die first because that is what stops traffic. A customer
    /// who pressed Disconnect wants their packets to stop going through
    /// a tunnel more than they want a tidy registry.
    #[test]
    fn engines_are_killed_before_anything_else() {
        let mut spy = Spy::new();
        let order = Arc::clone(&spy.order);
        hard_stop(&mut spy);
        assert_eq!(order.lock().unwrap().as_slice(), &["kill", "filters", "dns", "service"]);
    }

    /// The rule the old code broke. Its cleanup sat at the end of a
    /// successful disconnect, so a failure halfway left everything after
    /// it undone -- which is how a machine ends up with DNS pointed at a
    /// resolver that no longer exists.
    #[test]
    fn a_failing_step_does_not_stop_the_ones_after_it() {
        let mut spy = Spy::new();
        spy.fail = vec!["kill"];
        let ran = Arc::clone(&spy.ran);
        let report = hard_stop(&mut spy);

        assert_eq!(ran.load(Ordering::SeqCst), 4, "every step must run");
        assert!(!report.all_succeeded());
        assert_eq!(report.steps[0].failed.as_deref(), Some("kill went wrong"));
        assert!(report.steps[2].failed.is_none(), "DNS must still have been cleared");
    }

    /// Every step failing is still every step attempted. There is no
    /// state of the machine in which giving up early leaves less behind.
    #[test]
    fn all_steps_run_even_when_all_of_them_fail() {
        let mut spy = Spy::new();
        spy.fail = vec!["kill", "filters", "dns", "service"];
        let ran = Arc::clone(&spy.ran);
        let report = hard_stop(&mut spy);
        assert_eq!(ran.load(Ordering::SeqCst), 4);
        assert_eq!(report.steps.iter().filter(|s| s.failed.is_some()).count(), 4);
    }

    #[test]
    fn a_clean_stop_reports_itself_as_one() {
        let mut spy = Spy::new();
        let report = hard_stop(&mut spy);
        assert!(report.all_succeeded());
        assert!(report.summary().contains("all steps ok"), "{}", report.summary());
    }

    /// The log line has to name what went wrong, because it is read by
    /// somebody trying to work out why a machine is in a strange state.
    #[test]
    fn the_summary_names_the_failures() {
        let mut spy = Spy::new();
        spy.fail = vec!["dns", "service"];
        let report = hard_stop(&mut spy);
        let summary = report.summary();
        assert!(summary.contains("clear DNS rules"), "{summary}");
        assert!(summary.contains("request tunnel service stop"), "{summary}");
    }

    /// A step that blows the budget is reported, not aborted. Abandoning
    /// a teardown halfway leaves more behind, not less -- so this is a
    /// thing to notice in the log and fix at the source.
    #[test]
    fn an_overrun_is_reported_rather_than_aborted() {
        let mut spy = Spy::new();
        spy.slow = Some(("dns", HARD_STOP_BUDGET + Duration::from_millis(150)));
        let ran = Arc::clone(&spy.ran);
        let report = hard_stop(&mut spy);

        assert_eq!(ran.load(Ordering::SeqCst), 4, "the overrun must not cancel later steps");
        assert!(!report.within_budget());
        assert!(report.all_succeeded(), "slow is not the same as failed");
    }

    /// The ordinary case has to fit, or the promise to the customer is
    /// not kept. Real steps are a process kill, two handle closes and a
    /// registry delete; none of them is slow, and this guards against
    /// somebody later adding one that is.
    #[test]
    fn a_normal_hard_stop_fits_the_budget() {
        let mut spy = Spy::new();
        let report = hard_stop(&mut spy);
        assert!(
            report.within_budget(),
            "took {:?} against a {HARD_STOP_BUDGET:?} budget",
            report.took
        );
    }

    /// Four steps, always, in the report. A caller reading it should not
    /// have to wonder whether something was skipped.
    #[test]
    fn the_report_covers_every_step() {
        let mut spy = Spy::new();
        let report = hard_stop(&mut spy);
        assert_eq!(report.steps.len(), 4);
        let names: Vec<&str> = report.steps.iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![
                "kill engines",
                "release kernel filters",
                "clear DNS rules",
                "request tunnel service stop"
            ]
        );
    }
}
