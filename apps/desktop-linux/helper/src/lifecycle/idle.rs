//! The idle watchdog's arithmetic, copied from the Windows service
//! (`service/src/pipe.rs`) with its comments.
//!
//! The tunnel is torn down once the app has been silent long enough to be
//! considered gone. Measured from the last request, not from a connection
//! being open: the app opens a fresh connection per request and closes it
//! immediately, so "a client is connected" is true only for milliseconds
//! at a time and is not a signal about anything. Tearing down on a
//! connection closing shipped on Windows once (0.9.6) and customers
//! reported it as connecting and then losing it immediately.
//!
//! On Linux the app's process is watched directly (`client_watch`), so
//! this is the backstop for what a process watch cannot see: an app that
//! is alive but has stopped asking anything, which is what a wedged app
//! looks like.

use std::time::{Duration, Instant};

/// How long the tunnel outlives the app's silence. Sixty seconds because
/// the app polls status every few seconds while it is open (and sends a
/// heartbeat every twenty), so silence for a minute means it is genuinely
/// gone rather than between polls.
pub const IDLE_GRACE: Duration = Duration::from_secs(60);

/// How often the idle check runs.
pub const IDLE_POLL: Duration = Duration::from_secs(10);

/// What one tick of the idle watchdog makes of the app's silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleTick {
    /// Heard from within `IDLE_GRACE`.
    Heard,
    /// The tick itself took more than twice `IDLE_POLL`: the machine
    /// stopped -- a VM paused, a laptop asleep, the helper starved -- and
    /// the app's silence was the machine's, not its own. Its grace starts
    /// again, up to `IDLE_STALLS` times before the app is heard from again.
    Stalled,
    /// Silent for `IDLE_GRACE` on a machine that ran: gone, or frozen.
    Silent,
}

/// How many late ticks in a row, the app not heard from between them, each
/// start its grace again. Past that, the machine stopping is no reason to
/// wait for it: a machine whose ticks keep coming late would otherwise
/// hold for an app that is gone for as long as that goes on. An app that
/// is there is heard from within a second or two of a resume, and its
/// count starts again.
pub const IDLE_STALLS: u32 = 3;

/// `tick`: how long the watchdog's last sleep of `IDLE_POLL` took.
/// `silent`: how long since the app was last heard from. `stalls`: late
/// ticks already excused since then.
///
/// Both are read off `Instant`, which on the Windows VM counted a 72 s
/// freeze of the whole guest: at resume the tick ran before the app's
/// first request was served and called the app silent. On Linux `Instant`
/// is CLOCK_MONOTONIC, which does not count a suspend; then neither
/// reading counts it, and nothing is let go of for it either.
pub fn idle_tick(tick: Duration, silent: Duration, stalls: u32) -> IdleTick {
    if tick > IDLE_POLL * 2 && stalls < IDLE_STALLS {
        IdleTick::Stalled
    } else if silent < IDLE_GRACE {
        IdleTick::Heard
    } else {
        IdleTick::Silent
    }
}

/// The idle watchdog's memory between ticks: the late ticks excused since
/// the app was last heard from, and the moment the last one started its
/// grace again -- a `last_seen` other than that is the app's own.
#[derive(Default)]
pub struct IdleWatch {
    excused: Option<Instant>,
    stalls: u32,
}

impl IdleWatch {
    /// One tick at `now`, whose sleep took `tick`. `seen`: when the app was
    /// last heard from, started again here when a late tick is excused.
    pub fn tick(&mut self, tick: Duration, seen: &mut Instant, now: Instant) -> IdleTick {
        if self.excused.is_some_and(|at| *seen != at) {
            self.excused = None;
            self.stalls = 0;
        }
        let said = idle_tick(tick, now.saturating_duration_since(*seen), self.stalls);
        if said == IdleTick::Stalled {
            *seen = now;
            self.excused = Some(now);
            self.stalls += 1;
        }
        said
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The watchdog over a run of ticks, through its own `IdleWatch`: when
    /// it lets go, in seconds from the start. `ticks`: how long each sleep
    /// took. `heard_after`: the ticks after which the app is heard from, a
    /// second later; otherwise only at the start.
    fn lets_go_after(ticks: &[u64], heard_after: &[usize]) -> Option<u64> {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        let (mut watch, mut seen, mut now) = (IdleWatch::default(), at(0), 0);
        for (i, &tick) in ticks.iter().enumerate() {
            now += tick;
            if watch.tick(Duration::from_secs(tick), &mut seen, at(now)) == IdleTick::Silent {
                return Some(now);
            }
            if heard_after.contains(&i) {
                seen = at(now + 1);
            }
        }
        None
    }

    #[test]
    fn a_machine_that_stopped_is_not_an_app_gone_silent() {
        assert_eq!(idle_tick(Duration::from_secs(75), Duration::from_secs(73), 0), IdleTick::Stalled);
        assert_eq!(idle_tick(Duration::from_secs(21), Duration::from_secs(61), 0), IdleTick::Stalled);
        // Late, but not by a stall: an app silent for the grace is let go of.
        assert_eq!(idle_tick(Duration::from_secs(20), Duration::from_secs(60), 0), IdleTick::Silent);
        assert_eq!(idle_tick(IDLE_POLL, Duration::from_secs(59), 0), IdleTick::Heard);
        // Its grace starts again at the stall: the app reading again after
        // the resume is heard long before it ends.
        assert_eq!(lets_go_after(&[10, 10, 75, 10, 10], &[]), None);
        assert_eq!(lets_go_after(&[10, 10, 75, 10, 10, 10, 10, 10, 10, 10], &[2, 5, 8]), None);
    }

    #[test]
    fn an_app_frozen_on_a_machine_that_runs_is_still_let_go_of_after_the_grace() {
        assert_eq!(lets_go_after(&[10; 10], &[]), Some(60));
        // A stall on the way gives a full grace from it, and no more.
        assert_eq!(lets_go_after(&[10, 10, 30, 10, 10, 10, 10, 10, 10, 10], &[]), Some(110));
    }

    #[test]
    fn ticks_that_keep_coming_late_hold_for_a_gone_app_only_so_long() {
        assert_eq!(lets_go_after(&[75; 10], &[]), Some(4 * 75));
        assert_eq!(lets_go_after(&[25; 20], &[]), Some(6 * 25));
        assert_eq!(idle_tick(Duration::from_secs(75), Duration::from_secs(75), IDLE_STALLS), IdleTick::Silent);
        let resumes: Vec<usize> = (0..20).collect();
        assert_eq!(lets_go_after(&[75; 20], &resumes), None);
        assert_eq!(lets_go_after(&[75; 10], &[1]), Some(6 * 75));
    }
}
