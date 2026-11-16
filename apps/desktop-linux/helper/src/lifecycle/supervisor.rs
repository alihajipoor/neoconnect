//! One owner for the engine state, and a queue in front of it.
//!
//! What this replaces is a `tokio::sync::Mutex<Engines>` that every
//! request arm locked, and all three customer-reported faults depend on
//! it:
//!
//! * **Disconnect waited on that lock unbounded.** Two seconds, then
//!   forever, with no unlocked fallback -- so while a connect held it,
//!   the button did nothing.
//! * **Service stop waited on it with no timeout at all**, so a held
//!   lock meant the process never reported `Stopped` and stayed alive
//!   with the tunnel up.
//! * **The blocking work ran inside async tasks**, never
//!   `spawn_blocking`, so on a two-core machine the worker pool was
//!   occupied and the accept loop was not polled -- the Disconnect
//!   request could not even be *read*.
//!
//! The shape here fixes all three by construction rather than by adding
//! more timeouts to the same design.
//!
//! **The state lives on its own thread.** Not a runtime worker, not
//! behind an async mutex. Engine work blocks -- it spawns processes,
//! waits on services, calls Win32 -- and blocking belongs on a thread
//! that exists to block. Nothing it does can starve the async side,
//! because it is not on the async side.
//!
//! **Requests are messages, not lock acquisitions.** Sending is
//! immediate whatever the thread is doing, so a disconnect is always
//! *received*. It waits its turn to be *run*, which is a different thing
//! and a bounded one.
//!
//! **Cancellation does not go through the queue.** That is the part that
//! matters most. A disconnect arriving behind a thirty-second connect
//! would be useless if it had to wait for that connect to finish, so the
//! handle keeps the running operation's token and cancels it directly.
//! The connect unwinds, the queue advances, and the disconnect runs. The
//! only lock here is held for the microseconds it takes to read or
//! replace a token -- never across work, which is the entire disease
//! being cured.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::cancel::CancelToken;

/// A unit of work for the owned state, with the token that can stop it.
type Job<S> = Box<dyn FnOnce(&mut S, &CancelToken) + Send>;

/// The supervisor's thread is gone.
///
/// Only happens while the service is stopping. Callers treat it as "the
/// answer no longer matters" rather than as a fault, because by the time
/// it can happen nobody is waiting for a tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorGone;

impl std::fmt::Display for SupervisorGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the engine supervisor is no longer running")
    }
}

impl std::error::Error for SupervisorGone {}

/// A handle to the thread that owns the state. Cheap to clone.
pub struct Supervisor<S> {
    jobs: Sender<Job<S>>,
    /// The token of whatever is running right now.
    ///
    /// A `std::sync::Mutex` on purpose: it is taken for long enough to
    /// clone or replace one `Arc` and never across a `.await` or any
    /// work at all, so it can never be the thing somebody waits on.
    running: Arc<Mutex<Option<CancelToken>>>,
    /// How many times what was queued has been superseded. See
    /// [`Supervisor::supersede`].
    superseded: Arc<AtomicU64>,
}

impl<S> Clone for Supervisor<S> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
            running: Arc::clone(&self.running),
            superseded: Arc::clone(&self.superseded),
        }
    }
}

/// Where the queue stood when a job was queued, for a job that must not
/// run once something has superseded it. See [`Supervisor::supersede`].
pub struct Generation {
    at: u64,
    cell: Arc<AtomicU64>,
}

impl Generation {
    /// Whether anything superseded the queue after this was taken.
    pub fn superseded(&self) -> bool {
        self.cell.load(Ordering::SeqCst) != self.at
    }
}

impl<S: Send + 'static> Supervisor<S> {
    /// Move `state` onto its own thread and return a handle to it.
    pub fn spawn(state: S, thread_name: &str) -> Self {
        let (jobs, inbox) = mpsc::channel::<Job<S>>();
        let running: Arc<Mutex<Option<CancelToken>>> = Arc::new(Mutex::new(None));
        let mine = Arc::clone(&running);

        std::thread::Builder::new()
            .name(thread_name.to_owned())
            .spawn(move || Self::serve(state, inbox, mine))
            .expect("spawning the supervisor thread");

        Self { jobs, running, superseded: Arc::new(AtomicU64::new(0)) }
    }

    fn serve(mut state: S, inbox: Receiver<Job<S>>, running: Arc<Mutex<Option<CancelToken>>>) {
        for job in inbox {
            // A token per job, published before the job starts so a
            // cancellation racing the start still reaches it. The old
            // global flag's defining bug was that the *next* operation
            // could clear the *previous* one's cancellation; here the
            // previous token is simply dropped, and nothing that holds a
            // clone of it is affected by what replaces it.
            let token = CancelToken::new();
            if let Ok(mut slot) = running.lock() {
                *slot = Some(token.clone());
            }

            // A panicking operation must not take the thread with it.
            // If it did, the service would keep running with no engine
            // owner at all: every later request would hang on a channel
            // nobody reads, which from the outside is indistinguishable
            // from the lock-held-forever behaviour this replaces.
            let _ = catch_unwind(AssertUnwindSafe(|| job(&mut state, &token)));

            if let Ok(mut slot) = running.lock() {
                *slot = None;
            }
        }
    }

    /// Queue `work` and return a future for its result.
    ///
    /// **Deliberately not an `async fn`.** An `async fn` body does not
    /// run until the future is polled, which would mean the job was not
    /// queued until the caller awaited -- and "queueing is immediate
    /// however busy the thread is" is this module's whole promise. A
    /// caller that queues a teardown and then waits on something else
    /// first has to get a teardown that is already on its way.
    ///
    /// So the send happens here, synchronously, and the returned future
    /// only waits for the answer. The wait is the caller's to bound;
    /// every caller has a deadline of its own, and they nest.
    pub fn run<R, F>(&self, work: F) -> impl std::future::Future<Output = Result<R, SupervisorGone>>
    where
        F: FnOnce(&mut S, &CancelToken) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let queued = self
            .jobs
            .send(Box::new(move |state, token| {
                // The receiver is gone when the caller stopped waiting.
                // Not an error: the work still ran, and whether anyone
                // read the answer is their business.
                let _ = tx.send(work(state, token));
            }))
            .map_err(|_| SupervisorGone);

        async move {
            queued?;
            rx.await.map_err(|_| SupervisorGone)
        }
    }

    /// Queue `work` without waiting for it.
    ///
    /// For the paths that must not block on the engine thread at all --
    /// a client disappearing, the service stopping -- where the caller
    /// needs the teardown started, not finished.
    pub fn run_detached<F>(&self, work: F) -> Result<(), SupervisorGone>
    where
        F: FnOnce(&mut S, &CancelToken) + Send + 'static,
    {
        self.jobs.send(Box::new(work)).map_err(|_| SupervisorGone)
    }

    /// Stop whatever is running right now.
    ///
    /// Out of band, which is the point: a disconnect queued behind a
    /// thirty-second connect would be useless if it had to wait for that
    /// connect to end. This reaches it directly, the connect unwinds,
    /// and the queue advances to the disconnect.
    ///
    /// Harmless when nothing is running, and it deliberately does not
    /// say which it was -- a caller that behaved differently on "nothing
    /// to cancel" would be racing the thread for no benefit.
    pub fn cancel_running(&self) {
        let token = self.running.lock().ok().and_then(|slot| slot.clone());
        if let Some(token) = token {
            token.cancel();
        }
    }

    /// Marks everything queued so far as no longer wanted -- for the jobs
    /// that ask.
    ///
    /// `cancel_running` reaches only the job running now. A connect
    /// queued *behind* it -- behind a disconnect's thorough pass, which
    /// never adopts its token and cannot be hurried -- got a fresh token
    /// when it started and ran in full after the customer had pressed
    /// stop and been told "disconnected": a dialled server, routes and a
    /// DNS rule, for up to a whole connect, before the hard stop queued
    /// behind it took them down again.
    ///
    /// Not a cancellation of the queue. A teardown queued earlier must
    /// still run, and run to the end; cancelling it would have its helpers
    /// abort themselves (the self-cancel trap wireguard.rs documents). So
    /// this only moves a number, and a job that must not outlive it -- a
    /// connect -- takes a [`Generation`] when it is queued and checks it
    /// before doing anything.
    pub fn supersede(&self) {
        self.superseded.fetch_add(1, Ordering::SeqCst);
    }

    /// Where the queue stands now. Take it immediately before queueing
    /// the job that will check it.
    pub fn generation(&self) -> Generation {
        Generation { at: self.superseded.load(Ordering::SeqCst), cell: Arc::clone(&self.superseded) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn work_runs_against_the_owned_state_and_answers() {
        let sup = Supervisor::spawn(7_u32, "test-basic");
        let doubled = sup.run(|state: &mut u32, _| {
            *state *= 2;
            *state
        });
        assert_eq!(doubled.await, Ok(14));
    }

    #[tokio::test]
    async fn state_persists_across_jobs() {
        let sup = Supervisor::spawn(Vec::<u8>::new(), "test-state");
        sup.run(|s: &mut Vec<u8>, _| s.push(1)).await.unwrap();
        sup.run(|s: &mut Vec<u8>, _| s.push(2)).await.unwrap();
        assert_eq!(sup.run(|s: &mut Vec<u8>, _| s.clone()).await.unwrap(), vec![1, 2]);
    }

    /// The headline property. A disconnect arriving while a connect runs
    /// must reach it, not queue behind it -- which is the difference
    /// between a button that works and the one customers report.
    #[tokio::test]
    async fn cancelling_reaches_an_operation_already_running() {
        let sup = Supervisor::spawn((), "test-cancel");
        let started = Arc::new(tokio::sync::Notify::new());
        let tell = Arc::clone(&started);

        let slow = sup.run(move |_: &mut (), token: &CancelToken| {
            tell.notify_one();
            // Stands in for a connect stage: a long wait that polls.
            token.sleep(Duration::from_secs(30))
        });

        started.notified().await;
        sup.cancel_running();

        let outcome = tokio::time::timeout(Duration::from_secs(5), slow)
            .await
            .expect("a cancelled operation must not run to its full length");
        assert_eq!(outcome.unwrap(), Err(super::super::cancel::Cancelled));
    }

    /// Sending must never block on the thread being free, because that
    /// is what made Disconnect unreachable. The queue accepts it at
    /// once; only *running* it waits.
    #[tokio::test]
    async fn a_request_is_accepted_while_the_thread_is_busy() {
        let sup = Supervisor::spawn((), "test-queue");
        let gate = Arc::new(tokio::sync::Notify::new());
        let tell = Arc::clone(&gate);

        let busy = sup.run(move |_: &mut (), token: &CancelToken| {
            tell.notify_one();
            let _ = token.sleep(Duration::from_secs(30));
        });
        gate.notified().await;

        // The thread is mid-operation. Queueing must still be instant.
        let queued = tokio::time::timeout(
            Duration::from_millis(500),
            async { sup.run_detached(|_: &mut (), _| {}) },
        )
        .await
        .expect("queueing must not wait for the thread to be free");
        assert_eq!(queued, Ok(()));

        sup.cancel_running();
        let _ = busy.await;
    }

    /// The old flag's defining bug, written as a test: one operation's
    /// cancellation must not reach the next one. Here the first job is
    /// cancelled and the second must still run normally.
    #[tokio::test]
    async fn a_cancellation_does_not_leak_into_the_next_operation() {
        let sup = Supervisor::spawn((), "test-fresh-token");
        let gate = Arc::new(tokio::sync::Notify::new());
        let tell = Arc::clone(&gate);

        let first = sup.run(move |_: &mut (), token: &CancelToken| {
            tell.notify_one();
            token.sleep(Duration::from_secs(30))
        });
        gate.notified().await;
        sup.cancel_running();
        assert!(first.await.unwrap().is_err());

        let second = sup
            .run(|_: &mut (), token: &CancelToken| token.is_cancelled())
            .await
            .unwrap();
        assert!(!second, "the next operation must get a token of its own");
    }

    /// A panicking operation must not take the owner thread with it. If
    /// it did, every later request would hang on a channel nobody reads
    /// -- which from outside looks exactly like the lock-held-forever
    /// behaviour this type exists to remove.
    #[tokio::test]
    async fn a_panicking_operation_does_not_kill_the_supervisor() {
        let sup = Supervisor::spawn(0_u32, "test-panic");
        let died = sup.run(|_: &mut u32, _| panic!("engine code did something regrettable")).await;
        assert_eq!(died, Err(SupervisorGone), "the caller is told, rather than hanging");

        // The thread is still there and the state survived.
        let after = sup.run(|s: &mut u32, _| {
            *s += 5;
            *s
        });
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), after).await.expect("not hung"),
            Ok(5)
        );
    }

    /// A caller that stops waiting must not stop the work. The service
    /// relies on this: the app's reply deadline can pass while a
    /// teardown is still usefully running, and abandoning it there would
    /// leave exactly the half-torn-down machine this project keeps
    /// finding.
    #[tokio::test]
    async fn work_completes_even_when_nobody_reads_the_answer() {
        let ran = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&ran);
        let sup = Supervisor::spawn((), "test-detached");

        {
            // Dropped without ever being awaited. Because `run` queues
            // eagerly, the work is already on its way; an `async fn`
            // here would never have sent it at all.
            let fut = sup.run(move |_: &mut (), _| counter.fetch_add(1, Ordering::SeqCst));
            drop(fut);
        }

        // Something later still gets through, proving the thread kept going.
        sup.run(|_: &mut (), _| {}).await.unwrap();
        assert_eq!(ran.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelling_with_nothing_running_is_harmless() {
        let sup = Supervisor::spawn((), "test-idle-cancel");
        sup.cancel_running();
        assert_eq!(sup.run(|_: &mut (), _| 1).await, Ok(1));
    }

    /// A job queued before a `supersede` learns of it when it starts; one
    /// queued after does not; and nothing is cancelled by it -- a
    /// teardown queued earlier still runs to the end.
    #[tokio::test]
    async fn superseding_reaches_queued_work_without_cancelling_it() {
        let sup = Supervisor::spawn((), "test-supersede");
        let (release, parked) = std::sync::mpsc::channel::<()>();
        let busy = sup.run(move |_: &mut (), _| {
            let _ = parked.recv_timeout(Duration::from_secs(10));
        });

        let before = sup.generation();
        let queued_before = sup.run(move |_: &mut (), token: &CancelToken| (before.superseded(), token.is_cancelled()));
        sup.supersede();
        let after = sup.generation();
        let queued_after = sup.run(move |_: &mut (), _| after.superseded());

        release.send(()).unwrap();
        busy.await.unwrap();
        assert_eq!(queued_before.await.unwrap(), (true, false), "superseded, and not cancelled");
        assert!(!queued_after.await.unwrap());
    }
}
