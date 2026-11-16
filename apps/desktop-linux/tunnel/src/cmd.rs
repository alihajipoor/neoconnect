//! Running the system's own tools (`ip`, `resolvectl`, `kill`), and
//! waiting, within a budget.
//!
//! The helper runs as root and the arguments here are partly built from
//! a request, so two rules hold for every program started from this
//! crate: it is looked up only in the four system directories, never
//! through `PATH`, which the environment controls; and it is started
//! directly, never through a shell, so no argument is ever parsed as
//! anything but one argument.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{Limits, Problem};

/// Where a program may come from. Root-owned on every distribution.
pub(crate) const PROGRAM_DIRS: [&str; 4] = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/// How often any wait here looks at the clock and the cancel flag. The
/// contract asks for at least every 100 ms.
pub(crate) const POLL: Duration = Duration::from_millis(50);

/// What a teardown step may take. Teardown has no caller's deadline, and
/// `ip` answers in milliseconds, so this only matters when something is
/// badly wrong -- and then waiting longer would not help.
pub(crate) const TEARDOWN_CAP: Duration = Duration::from_secs(5);

/// A deadline, and optionally the helper's cancel flag.
#[derive(Clone, Debug)]
pub(crate) struct Budget {
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
}

/// Why a wait or a program ended early.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Stop {
    TimedOut,
    Cancelled,
}

impl Budget {
    /// The caller's limits, but never more than `cap` from now.
    pub(crate) fn within(limits: &Limits, cap: Duration) -> Self {
        let capped = Instant::now() + cap;
        Self { deadline: limits.deadline.min(capped), cancel: Some(limits.cancel.clone()) }
    }

    /// No caller to cancel it: teardown, the sweep, a status question.
    pub(crate) fn quick(cap: Duration) -> Self {
        Self { deadline: Instant::now() + cap, cancel: None }
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst))
    }

    pub(crate) fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Whether to go on waiting.
    pub(crate) fn check(&self) -> Result<(), Stop> {
        if self.cancelled() {
            Err(Stop::Cancelled)
        } else if self.expired() {
            Err(Stop::TimedOut)
        } else {
            Ok(())
        }
    }

    /// Sleeps one poll step, or less when the deadline is nearer.
    pub(crate) fn nap(&self) {
        let left = self.deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(left.min(POLL));
    }

    /// Sleeps for `total`, still answering cancel and the deadline.
    pub(crate) fn sleep(&self, total: Duration) -> Result<(), Stop> {
        let until = Instant::now() + total;
        loop {
            self.check()?;
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(());
            }
            std::thread::sleep(left.min(POLL));
        }
    }
}

impl Stop {
    /// As the contract's `Problem`, naming what was waited for.
    pub(crate) fn problem(&self, what: &str) -> Problem {
        match self {
            Stop::Cancelled => Problem::Cancelled,
            Stop::TimedOut => Problem::TimedOut(what.to_string()),
        }
    }
}

/// A finished program.
#[derive(Debug, Clone)]
pub(crate) struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    /// Its complaint, in one line: stderr when it said anything, else stdout.
    pub(crate) fn complaint(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        let line = text.trim().lines().collect::<Vec<_>>().join(" | ");
        if line.is_empty() {
            "it gave no reason".to_string()
        } else {
            line
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunError {
    /// Not in any of [`PROGRAM_DIRS`].
    Missing(String),
    /// Found but would not start.
    Spawn(String),
    Stopped(Stop),
}

impl RunError {
    pub(crate) fn problem(&self, what: &str) -> Problem {
        match self {
            RunError::Missing(program) => Problem::EngineMissing(program.clone()),
            RunError::Spawn(why) => Problem::Failed(format!("could not {what}: {why}")),
            RunError::Stopped(stop) => stop.problem(what),
        }
    }
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Missing(program) => write!(f, "{program} is not installed"),
            RunError::Spawn(why) => f.write_str(why),
            RunError::Stopped(Stop::TimedOut) => f.write_str("it did not finish in time"),
            RunError::Stopped(Stop::Cancelled) => f.write_str("it was cancelled"),
        }
    }
}

/// The full path of a system program, from [`PROGRAM_DIRS`] only.
pub(crate) fn find(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        return None;
    }
    PROGRAM_DIRS.iter().map(|dir| PathBuf::from(dir).join(program)).find(|path| path.is_file())
}

/// Runs a system program to completion within the budget. A program
/// still running when the budget ends is killed and reaped.
pub(crate) fn run(program: &str, args: &[&str], budget: &Budget) -> Result<Output, RunError> {
    let path = find(program).ok_or_else(|| RunError::Missing(program.to_string()))?;
    budget.check().map_err(RunError::Stopped)?;
    let mut child = Command::new(&path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The tools print what we parse; a translated message would not
        // match the few words we look for.
        .env("LC_ALL", "C")
        .spawn()
        .map_err(|e| RunError::Spawn(format!("{program}: {e}")))?;

    // Read on threads, so a program that fills one pipe while we wait on
    // the other cannot stall both of us.
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let out = reader(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    // Short looks first: `ip` answers in a millisecond or two, and a
    // teardown runs several in a row, so a flat 50 ms step would make a
    // hard stop take a quarter of a second for nothing.
    let mut step = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Spawn(format!("{program}: {e}")));
            }
        }
        if let Err(stop) = budget.check() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::Stopped(stop));
        }
        std::thread::sleep(step.min(budget.deadline.saturating_duration_since(Instant::now())));
        step = (step * 2).min(POLL);
    };
    Ok(Output {
        success: status.success(),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// `ip` with these arguments; its stdout on success, its complaint on
/// failure.
pub(crate) fn ip(args: &[&str], budget: &Budget) -> Result<String, IpError> {
    match run("ip", args, budget) {
        Ok(out) if out.success => Ok(out.stdout),
        Ok(out) => Err(IpError::Refused(out.complaint())),
        Err(e) => Err(IpError::Run(e)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IpError {
    /// `ip` ran and said no.
    Refused(String),
    Run(RunError),
}

impl IpError {
    pub(crate) fn problem(&self, what: &str) -> Problem {
        match self {
            IpError::Refused(why) => Problem::Failed(format!("could not {what}: {why}")),
            IpError::Run(e) => e.problem(what),
        }
    }

    /// Whether `ip` refused because the thing is already gone, which for
    /// a deletion is success.
    pub(crate) fn already_gone(&self) -> bool {
        matches!(self, IpError::Refused(why) if gone_words(why))
    }
}

impl std::fmt::Display for IpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpError::Refused(why) => f.write_str(why),
            IpError::Run(e) => write!(f, "{e}"),
        }
    }
}

/// The kernel's ways of saying "there is no such thing" to a delete.
fn gone_words(why: &str) -> bool {
    ["No such process", "Cannot find device", "No such file or directory", "does not exist", "No such device"]
        .iter()
        .any(|w| why.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_never_come_from_a_path_or_a_relative_name() {
        assert_eq!(find("../ip"), None);
        assert_eq!(find("/tmp/ip"), None);
        assert_eq!(find("bin/ip"), None);
    }

    #[test]
    fn a_delete_of_something_already_gone_is_recognised() {
        assert!(IpError::Refused("RTNETLINK answers: No such process".into()).already_gone());
        assert!(IpError::Refused("Cannot find device \"neoconnect0\"".into()).already_gone());
        assert!(!IpError::Refused("RTNETLINK answers: Operation not permitted".into()).already_gone());
        assert!(!IpError::Run(RunError::Missing("ip".into())).already_gone());
    }

    #[test]
    fn a_cancelled_budget_stops_a_wait_at_once() {
        let flag = Arc::new(AtomicBool::new(true));
        let limits = Limits { deadline: Instant::now() + Duration::from_secs(60), cancel: flag };
        let budget = Budget::within(&limits, Duration::from_secs(60));
        let started = Instant::now();
        assert_eq!(budget.sleep(Duration::from_secs(30)), Err(Stop::Cancelled));
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn the_budget_never_outlives_the_callers_deadline() {
        let limits = Limits { deadline: Instant::now(), cancel: Arc::new(AtomicBool::new(false)) };
        let budget = Budget::within(&limits, Duration::from_secs(60));
        assert_eq!(budget.sleep(Duration::from_secs(30)), Err(Stop::TimedOut));
    }
}
