//! The background threads Custom mode runs, and how they are stopped.
//!
//! Every one of them is joined on the way down, so a wait inside one is
//! a wait inside a disconnect. This is the wait they share, and the
//! handle that does the joining.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A thread that is asked to stop and joined when this is dropped.
///
/// The logger, the activation reset and the backstop each carried their
/// own copy of this -- a flag, a join handle and a `stop(self)` that the
/// session had to remember to call, in the right place. Holding one of
/// these is the call: whatever owns it stops the thread by letting it go,
/// on every path out, including an early return and a panic.
///
/// The body is handed the flag and is expected to wait through
/// [`sleep_unless_stopped`] so that a drop is answered within one step
/// rather than one whole interval.
pub(super) struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
    /// Runs `body` on a thread of its own.
    pub(super) fn spawn(body: impl FnOnce(Arc<AtomicBool>) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || body(stop))
        };
        Self { stop, thread: Some(thread) }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Waits, unless asked to stop first. Returns whether the wait ran to
/// completion rather than being cut short.
///
/// A plain `sleep` is what made Disconnect appear to hang. Both the
/// logger and the flow-expiry thread are joined during teardown, so a
/// ten-second sleep between log lines meant up to ten seconds of the app
/// sitting on "Disconnecting..." with the tunnel already gone --
/// reported as exactly that. Waiting in short steps costs nothing and
/// bounds the delay at one step.
///
/// The step was 200ms, and one step is what each joined thread costs a
/// stop -- the flow-expiry thread was measured at 150ms of a 150ms
/// `Relays::stop`, and `SplitTunnel::stop` joins four users of this one
/// after another inside phase one's 900ms. Twenty milliseconds is fifty
/// wake-ups a second per thread, each a load and a comparison, against
/// a tenth of the wait on every join.
pub(super) fn sleep_unless_stopped(
    stop: &std::sync::atomic::AtomicBool,
    total: std::time::Duration,
) -> bool {
    const STEP: std::time::Duration = std::time::Duration::from_millis(20);
    let deadline = std::time::Instant::now() + total;
    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return true;
        }
        std::thread::sleep(STEP.min(deadline - now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A worker that sleeps for a minute between rounds, which is what
    /// the logger and the backstop look like from here.
    fn sleeper(finished: &Arc<AtomicBool>) -> Worker {
        let finished = finished.clone();
        Worker::spawn(move |stop| {
            while sleep_unless_stopped(&stop, Duration::from_secs(60)) {}
            finished.store(true, Ordering::SeqCst);
        })
    }

    /// Letting go of a worker is the whole of stopping it: the drop does
    /// not return until the thread has finished, and it does not wait
    /// out the thread's interval to get there.
    #[test]
    fn dropping_a_worker_stops_its_thread_and_waits_for_it() {
        let finished = Arc::new(AtomicBool::new(false));
        let worker = sleeper(&finished);
        let began = Instant::now();
        drop(worker);
        assert!(finished.load(Ordering::SeqCst), "the drop returned before the thread had finished");
        assert!(began.elapsed() < Duration::from_secs(2), "the drop waited out the interval: {:?}", began.elapsed());
    }

    /// The same, with many dropped at once from as many threads. A
    /// teardown that passes one at a time and fails under load has
    /// happened in this subsystem before -- see the relay's `try_clone`
    /// note -- so it is asked both ways.
    #[test]
    fn many_workers_dropped_at_once_all_finish() {
        const N: usize = 32;
        let finished: Vec<Arc<AtomicBool>> = (0..N).map(|_| Arc::new(AtomicBool::new(false))).collect();
        let workers: Vec<Worker> = finished.iter().map(sleeper).collect();
        let gate = Arc::new(std::sync::Barrier::new(N));
        let droppers: Vec<_> = workers
            .into_iter()
            .map(|worker| {
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    drop(worker);
                })
            })
            .collect();
        for dropper in droppers {
            dropper.join().unwrap();
        }
        let left = finished.iter().filter(|f| !f.load(Ordering::SeqCst)).count();
        assert_eq!(left, 0, "{left} of {N} worker threads were still running after their drop returned");
    }
}
