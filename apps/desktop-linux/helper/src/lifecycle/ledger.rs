//! Which session is live, whether the last one ended on its own, and what
//! a status may say without the owning thread.
//!
//! The generation logic is the Windows service's `Ledger`
//! (`service/src/lifecycle/engine_watch.rs`), kept: **every teardown the
//! helper performs closes the generation before it stops the engine**, so
//! an ending recorded for a generation that is still live is one nobody
//! here caused -- a drop. What Windows waits on with kernel handles is a
//! once-a-second `Tunnel::health` poll here, and the tunnel crate only
//! says `Down` when that is verified, so every recorded ending is certain.
//!
//! Shared by `Arc` with the socket side, because the one reader that
//! cannot wait for the owning thread -- a `Status` answered while that
//! thread is busy, which is exactly when a dead session is being torn
//! down -- has to be able to ask it directly. The mutex is held for the
//! few instructions each method takes and never across anything else.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

/// How a session ended, when it ended on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub generation: u64,
    pub protocol: String,
    pub at: Instant,
}

/// What the live session's leak protection is, for a status answered
/// without the owning thread: the same facts the owning thread reports,
/// so a warning that it failed does not vanish while that thread is busy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuardFacts {
    pub ipv6_blocked: bool,
    pub ipv4_confined: bool,
    /// The machine's DNS points into the tunnel. Kept here, not assumed:
    /// a status that cannot ask the owning thread must not say protected
    /// on no evidence.
    pub dns_protected: bool,
    pub problem: Option<String>,
}

#[derive(Default)]
struct LedgerState {
    /// The session that is live, or 0 when none is.
    live: u64,
    live_protocol: String,
    /// The most recent session to have begun, live or not.
    latest: u64,
    /// The last session that ended on its own, until something newer
    /// makes it irrelevant.
    ended: Option<Ended>,
    /// The live session's leak protection, and the generation it is for.
    guard: Option<(u64, GuardFacts)>,
}

pub struct Ledger {
    state: Mutex<LedgerState>,
    /// Long jobs queued for, or running on, the owning thread that a
    /// status need not wait behind (`Ledger::busy`).
    busy: AtomicUsize,
    /// Of those, the connects (`Ledger::connecting`).
    connecting: AtomicUsize,
}

/// A long job on the owning thread, from when it is queued until it has
/// run. Dropped with the job.
pub struct Busy {
    ledger: Arc<Ledger>,
    connect: bool,
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.ledger.busy.fetch_sub(1, Ordering::SeqCst);
        if self.connect {
            self.ledger.connecting.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Generations are unique across every ledger in the process: tests run
/// many side by side, and a generation that meant two sessions would make
/// a cross-wired test pass.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger {
    pub fn new() -> Self {
        Self { state: Mutex::new(LedgerState::default()), busy: AtomicUsize::new(0), connecting: AtomicUsize::new(0) }
    }

    /// Survives a panic elsewhere: a poisoned ledger must still answer,
    /// because the question it answers is "is this customer tunnelled".
    fn state(&self) -> MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A session has started carrying `protocol`. Returns its generation:
    /// never 0, never reused. Whatever was recorded about an earlier
    /// session is dropped -- it no longer describes the machine.
    pub fn begin(&self, protocol: &str) -> u64 {
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state();
        state.live = generation;
        state.live_protocol = protocol.to_owned();
        state.latest = generation;
        state.ended = None;
        state.guard = None;
        generation
    }

    /// The session is ending by the helper's own hand. Called before its
    /// engine is stopped, which is what makes that stop invisible to
    /// [`record`](Self::record).
    pub fn close(&self, generation: u64) {
        let mut state = self.state();
        if state.live == generation {
            state.live = 0;
            state.guard = None;
        }
    }

    /// The engine of `generation` has ended on its own. Returns `true`
    /// when that session was still live -- this is news -- and `false`
    /// when it had already been closed or replaced. Recording twice keeps
    /// the first.
    pub fn record(&self, generation: u64, at: Instant) -> bool {
        let mut state = self.state();
        if generation == 0 || state.live != generation {
            return false;
        }
        if !state.ended.as_ref().is_some_and(|e| e.generation == generation) {
            state.ended = Some(Ended { generation, protocol: state.live_protocol.clone(), at });
        }
        true
    }

    /// The live session's protocol, or `None` when no session is live.
    pub fn live_protocol(&self) -> Option<String> {
        let state = self.state();
        (state.live != 0).then(|| state.live_protocol.clone())
    }

    /// The last session ended on its own and nothing has begun since: the
    /// one state in which "no tunnel" can be answered without asking the
    /// machine.
    pub fn confirmed_drop(&self) -> Option<Ended> {
        let state = self.state();
        state.ended.clone().filter(|e| e.generation == state.latest)
    }

    /// Drops the record, for a connect that is starting: from then on the
    /// old tunnel's death is not the answer to "is this customer
    /// tunnelled". Deliberately not called on Disconnect, which leaves
    /// "no tunnel" exactly as true.
    pub fn forget(&self) {
        self.state().ended = None;
    }

    /// Notes the live session's leak protection. Ignored for a generation
    /// that is not the live one.
    pub fn note_guard(&self, generation: u64, facts: GuardFacts) {
        let mut state = self.state();
        if generation != 0 && state.live == generation {
            state.guard = Some((generation, facts));
        }
    }

    /// The live session's leak protection, or nothing with no session.
    pub fn guard(&self) -> Option<GuardFacts> {
        let state = self.state();
        match &state.guard {
            Some((generation, facts)) if *generation == state.live && state.live != 0 => Some(facts.clone()),
            _ => None,
        }
    }

    /// The owning thread has a long job queued or running -- a connect,
    /// or the thorough pass behind a teardown -- until the guard returned
    /// is dropped. A status then answers from here at once rather than
    /// waiting behind it for an answer that would be this one anyway.
    pub fn busy(ledger: &Arc<Ledger>) -> Busy {
        ledger.busy.fetch_add(1, Ordering::SeqCst);
        Busy { ledger: Arc::clone(ledger), connect: false }
    }

    /// [`busy`](Self::busy), for a connect. While one is queued or running
    /// no tunnel is finished: a link that is already up has no routes, DNS
    /// or leak protection yet, and the connect may still be rolled back.
    pub fn connecting(ledger: &Arc<Ledger>) -> Busy {
        ledger.busy.fetch_add(1, Ordering::SeqCst);
        ledger.connecting.fetch_add(1, Ordering::SeqCst);
        Busy { ledger: Arc::clone(ledger), connect: true }
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst) > 0
    }

    pub fn is_connecting(&self) -> bool {
        self.connecting.load(Ordering::SeqCst) > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations_are_unique_and_never_zero() {
        let (a, b) = (Ledger::new(), Ledger::new());
        let (x, y) = (a.begin("XRAY_VLESS_REALITY"), b.begin("WIREGUARD"));
        assert!(x != 0 && y != 0 && x != y);
    }

    /// The helper's own teardown closes first, so its stop is not a drop.
    #[test]
    fn an_ending_after_close_is_not_news() {
        let ledger = Ledger::new();
        let g = ledger.begin("WIREGUARD");
        ledger.close(g);
        assert!(!ledger.record(g, Instant::now()));
        assert_eq!(ledger.confirmed_drop(), None);
    }

    #[test]
    fn a_drop_is_recorded_once_and_answers_until_the_next_connect() {
        let ledger = Ledger::new();
        let g = ledger.begin("OPENVPN");
        let first = Instant::now();
        assert!(ledger.record(g, first));
        assert!(ledger.record(g, Instant::now()), "still news while live");
        assert_eq!(ledger.confirmed_drop().map(|e| (e.generation, e.at)), Some((g, first)));
        // The teardown of the dead session closes it; the record stays.
        ledger.close(g);
        assert!(ledger.confirmed_drop().is_some());
        // A new session makes it irrelevant.
        ledger.begin("OPENVPN");
        assert_eq!(ledger.confirmed_drop(), None);
    }

    #[test]
    fn guard_facts_belong_to_the_live_session_only() {
        let ledger = Ledger::new();
        let g = ledger.begin("WIREGUARD");
        ledger.note_guard(g + 1_000_000, GuardFacts::default());
        assert_eq!(ledger.guard(), None, "another generation's facts were taken");
        let facts = GuardFacts { ipv6_blocked: true, ipv4_confined: false, dns_protected: true, problem: Some("x".into()) };
        ledger.note_guard(g, facts.clone());
        assert_eq!(ledger.guard(), Some(facts));
        assert_eq!(ledger.live_protocol().as_deref(), Some("WIREGUARD"));
        ledger.close(g);
        assert_eq!(ledger.guard(), None);
        assert_eq!(ledger.live_protocol(), None);
    }

    #[test]
    fn busy_lasts_as_long_as_its_guard() {
        let ledger = Arc::new(Ledger::new());
        assert!(!ledger.is_busy());
        let a = Ledger::busy(&ledger);
        let b = Ledger::busy(&ledger);
        drop(a);
        assert!(ledger.is_busy());
        drop(b);
        assert!(!ledger.is_busy());
        let c = Ledger::connecting(&ledger);
        assert!(ledger.is_busy() && ledger.is_connecting());
        let d = Ledger::busy(&ledger);
        drop(c);
        assert!(ledger.is_busy() && !ledger.is_connecting(), "a teardown's pass is not a connect");
        drop(d);
    }
}
