//! Knowing the tunnel engine is gone, from the kernel rather than from a
//! poll.
//!
//! Measured on 2026-10-06 in the test VM, desktop 0.9.43 on Stealth
//! (Xray), capturing at the NIC miniport and sampling the app's text on
//! the same clock: after `xray.exe` was killed, traffic went out direct
//! within 0.2s and the dashboard kept saying "You're protected" for 17.0
//! seconds. The service's log said nothing about the engine at all.
//!
//! The reason was structural. The service held no wait on any engine.
//! A dead engine was found only by `Engines::status` calling `try_wait`,
//! and `status` only ran when somebody asked -- the app's health poll,
//! every fifteen seconds, or the idle watchdog a minute after the app
//! went quiet. Until then the session stayed in the slot: its routes,
//! its WFP filters and its DNS rule all pointed at a tunnel that was no
//! longer there, and the app went on repeating the last verdict it had.
//!
//! [`client_watch`](super::client_watch) already solved the same problem
//! for the app's own process, and this is its sibling: a plain thread
//! per session, waiting on something the kernel signals when the engine
//! ends. What it waits on depends on the engine -- a process handle for
//! Xray and OpenVPN, the tunnel service's process for WireGuard, an
//! event RAS sets for IKEv2 -- so that part is a [`Liveness`] the engine
//! supplies. Everything else is here: the thread, the stop, and the
//! [`Ledger`] that decides whether an ending is news.
//!
//! Like everything in this directory it knows nothing about tunnels. It
//! knows that a session has a generation, that the service's own
//! teardowns close that generation before they kill anything, and that
//! an ending reported for a closed generation is therefore the service's
//! own hand and not a drop.
//!
//! **What it does not do**: block anything, reconnect, or hold traffic.
//! Fail open is a product decision (docs/windows-service-rewrite.md,
//! rule 3), and the defect this fixes was the *claim* -- a tunnel
//! reported up after it had gone -- not the fail-open.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
// SYNCHRONIZE is filed under Storage::FileSystem by windows-sys; see the
// note at the same import in `client_watch`.
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, SetEvent,
    WaitForMultipleObjects, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// How long one wait on a live engine lasts before the thread looks
/// again.
///
/// The kernel ends the wait the instant the engine goes, so this is not
/// a detection latency. It bounds two other things: how long a stopping
/// service waits for this thread to notice, and how often a source with
/// a cheap status call of its own (RAS) is asked directly, in case its
/// notification never comes.
const SLICE_MS: u32 = 1_000;

/// How long to wait before looking again at a source that has nothing to
/// wait on yet -- a tunnel service still starting, or one the service
/// manager has not finished marking stopped.
const AGAIN_MS: u32 = 100;

/// An owned kernel handle that closes itself.
///
/// The same shape as `client_watch`'s private one, and for the same
/// reason: every path out of a watch must close what it opened, and a
/// leaked handle keeps a dead process's kernel entry alive for as long
/// as this AutoStart service runs.
pub struct OwnedHandle(HANDLE);

// SAFETY: a Win32 HANDLE is a kernel object index with no thread
// affinity. What is done with these -- WaitForSingleObject,
// WaitForMultipleObjects, SetEvent, GetExitCodeProcess, CloseHandle --
// is documented as callable from any thread.
unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    /// Takes ownership of `raw`. `None` for a null handle, which is how
    /// the APIs that produce these report failure.
    pub fn from_raw(raw: HANDLE) -> Option<Self> {
        if raw.is_null() {
            None
        } else {
            Some(Self(raw))
        }
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }

    /// Whether the object is signalled right now, without waiting.
    ///
    /// `false` for a handle the kernel will not wait on at all, which the
    /// watch loop then meets as a failed wait and reports as such.
    pub fn is_signalled(&self) -> bool {
        // SAFETY: the handle is open for as long as `self` exists.
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }

    /// A second handle to the same object with the same rights, so two
    /// owners can each close their own.
    pub fn duplicate(&self) -> io::Result<Self> {
        duplicate(self.0, 0, DUPLICATE_SAME_ACCESS)
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: closed exactly once, here; the type is neither Clone
        // nor Copy.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn duplicate(source: HANDLE, access: u32, options: u32) -> io::Result<OwnedHandle> {
    let mut out: HANDLE = std::ptr::null_mut();
    // SAFETY: both process handles are the current-process pseudo
    // handle, `source` is a handle the caller holds open, and `out` is a
    // valid out-pointer.
    let ok = unsafe {
        DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &mut out, access, 0, options)
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    OwnedHandle::from_raw(out).ok_or_else(io::Error::last_os_error)
}

/// A manual-reset event, not signalled.
pub fn new_event() -> io::Result<OwnedHandle> {
    // SAFETY: no attributes, no name; the call returns a handle or null.
    let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    OwnedHandle::from_raw(raw).ok_or_else(io::Error::last_os_error)
}

/// A handle of our own to a process that the caller already holds one
/// to, reduced to the two rights a watch needs.
///
/// Duplicated from the caller's handle rather than opened by pid, and
/// that is the point: a pid can be reused the moment its process exits,
/// a handle cannot. The caller keeps ownership of the original -- for an
/// engine that is the `Child` the session holds -- and the watch closes
/// only its copy.
pub fn process_handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    duplicate(raw, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0)
}

/// A handle to a process known only by its id, for waiting on it.
///
/// For the WireGuard tunnel service, whose process this service did not
/// start and so holds no handle to. The pid comes from the service
/// manager the moment the service reports running.
pub fn open_process(pid: u32) -> io::Result<OwnedHandle> {
    // SAFETY: no pointers; the call returns a handle or null.
    let raw = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    OwnedHandle::from_raw(raw).ok_or_else(io::Error::last_os_error)
}

/// A process's exit code, when it has one.
pub fn exit_code(process: &OwnedHandle) -> Option<i64> {
    const STILL_ACTIVE: u32 = 0x103;
    let mut code: u32 = 0;
    // SAFETY: the handle carries PROCESS_QUERY_LIMITED_INFORMATION and
    // `code` is a valid out-pointer.
    let ok = unsafe { GetExitCodeProcess(process.raw(), &mut code) };
    (ok != 0 && code != STILL_ACTIVE).then_some(i64::from(code))
}

/// What one look at an engine found.
pub enum Look {
    /// Alive, and this handle is signalled when that changes. Borrowed
    /// from the [`Liveness`] that returned it, which keeps it open.
    WaitOn(HANDLE),
    /// Not decidable yet and nothing to wait on: look again shortly.
    Again,
    /// Gone, with whatever the source could say about why -- a process
    /// exit code, a service's exit code, a RAS error number.
    Gone(Option<i64>),
}

/// One engine's way of being watched.
///
/// `look` is called on the watch thread, first straight away and then
/// each time what it last returned to wait on is signalled, a slice
/// passes, or it asked to be looked at again. It must not block for long
/// -- a service-manager query or one RAS call is the most any of them
/// does.
pub trait Liveness: Send + 'static {
    fn look(&mut self) -> Look;

    /// Whether an ending this source reports can be undone without us.
    ///
    /// `false` for a process: one that has exited stays exited, so its
    /// handle being signalled is the whole answer. `true` for the two
    /// sources that report a *state* someone else can change back -- the
    /// service manager restarting a WireGuard tunnel service under its
    /// recovery actions, and RAS reporting an IKEv2 connection not
    /// `Connected` for the moment MOBIKE moves it to another network.
    /// What such a source reports is put on record as unconfirmed, and
    /// the status fallbacks do not answer from it until the owning thread
    /// has asked the engine directly (see [`Ledger::confirmed_drop`]).
    fn may_return(&self) -> bool {
        false
    }
}

/// A source that is not looked at until a moment has passed.
///
/// For a watch started again straight after the last one ended: a source
/// that reports an ending the engine then contradicts, over and over,
/// would otherwise turn into a loop through the owning thread. One look
/// a second at most is plenty for something that has just been seen
/// alive.
pub struct Settle {
    until: Instant,
    inner: Box<dyn Liveness>,
}

impl Settle {
    pub fn new(inner: Box<dyn Liveness>, wait: std::time::Duration) -> Self {
        Self { until: Instant::now() + wait, inner }
    }
}

impl Liveness for Settle {
    fn look(&mut self) -> Look {
        if Instant::now() < self.until {
            Look::Again
        } else {
            self.inner.look()
        }
    }

    fn may_return(&self) -> bool {
        self.inner.may_return()
    }
}

/// A process, by a handle of our own to it: Xray and OpenVPN, which are
/// plain children of this service.
pub struct ProcessLiveness {
    process: OwnedHandle,
}

impl ProcessLiveness {
    /// Watches the process behind `raw`, which the caller keeps owning.
    pub fn of_handle(raw: HANDLE) -> io::Result<Self> {
        Ok(Self { process: process_handle(raw)? })
    }
}

impl Liveness for ProcessLiveness {
    fn look(&mut self) -> Look {
        if self.process.is_signalled() {
            Look::Gone(exit_code(&self.process))
        } else {
            Look::WaitOn(self.process.raw())
        }
    }
}

/// What a watch tells its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gone {
    /// The session this watch was started for.
    pub generation: u64,
    pub detail: Option<i64>,
    /// Whether the source said "gone" (`true`), or the wait itself
    /// failed and nothing could be concluded (`false`). Only the first
    /// is recorded as a drop; the second asks for the engine to be
    /// checked, which the teardown does before acting on anything.
    pub definitive: bool,
    /// Whether the source can come back on its own -- see
    /// [`Liveness::may_return`]. A process cannot; a service the manager
    /// restarts and a RAS connection that reconnects can.
    pub may_return: bool,
    /// When the watch saw it, so the teardown can say how long after
    /// the engine ended the machine was put back.
    pub at: Instant,
}

/// Called on the watch thread when the engine has gone. Keep it short:
/// record, and hand the work to the owning thread.
pub type OnGone = Arc<dyn Fn(Gone) + Send + Sync>;

/// Holds a watch open. Dropping it ends the watch thread.
///
/// Owned by the session, so a session that ends -- by any route --
/// stops its own watch without anybody having to remember to.
pub struct WatchGuard {
    stop: OwnedHandle,
    /// Read only by tests; set by the thread either way.
    #[cfg_attr(not(test), allow(dead_code))]
    finished: Arc<AtomicBool>,
}

impl WatchGuard {
    /// Set when the watch thread has returned, for the tests that prove
    /// no thread outlives its session.
    #[cfg(test)]
    pub fn finished(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.finished)
    }
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        // SAFETY: the event is open for as long as the guard exists.
        unsafe {
            SetEvent(self.stop.raw());
        }
    }
}

/// Marks a watch finished however its thread ends, panic included.
struct Finished(Arc<AtomicBool>);

impl Drop for Finished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Starts watching one engine for the session `generation`.
///
/// A plain thread, not `spawn_blocking`, for the reason `client_watch`
/// gives: tokio waits for its blocking pool when a runtime is dropped,
/// so a watch on an engine that is still running would hold a stopping
/// service open.
pub fn watch(
    generation: u64,
    label: &str,
    liveness: Box<dyn Liveness>,
    on_gone: OnGone,
) -> io::Result<WatchGuard> {
    let stop = new_event()?;
    let theirs = stop.duplicate()?;
    let finished = Arc::new(AtomicBool::new(false));
    let marker = Finished(Arc::clone(&finished));
    std::thread::Builder::new()
        .name(format!("neoxify-engine-{label}-{generation}"))
        .spawn(move || {
            let _marker = marker;
            run(generation, liveness, &theirs, &*on_gone);
        })?;
    Ok(WatchGuard { stop, finished })
}

fn run(generation: u64, mut liveness: Box<dyn Liveness>, stop: &OwnedHandle, on_gone: &dyn Fn(Gone)) {
    // A stop that has been asked for outranks an ending seen at the same
    // moment. Ending a session on purpose signals the stop before the
    // engine is killed, and the kernel reports the lowest signalled
    // index first, so without this check our own kill could be reported
    // as a drop. The ledger refuses it anyway -- the generation is
    // closed before the kill -- and this is the cheaper of the two
    // guards, not the only one.
    let may_return = liveness.may_return();
    let report = |definitive: bool, detail: Option<i64>| {
        if !stop.is_signalled() {
            on_gone(Gone { generation, detail, definitive, may_return, at: Instant::now() });
        }
    };
    loop {
        if super::client_watch::shutting_down() || stop.is_signalled() {
            return;
        }
        match liveness.look() {
            Look::Gone(detail) => {
                report(true, detail);
                return;
            }
            Look::WaitOn(handle) => {
                let handles = [handle, stop.raw()];
                // SAFETY: both handles are open for the duration of the
                // call -- the first is owned by `liveness`, which this
                // frame holds, and the second by `stop`.
                let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, SLICE_MS) };
                match waited {
                    // The engine's object, or a slice: look again, which
                    // is what turns a signalled handle into an answer.
                    WAIT_OBJECT_0 | WAIT_TIMEOUT => continue,
                    w if w == WAIT_OBJECT_0 + 1 => return,
                    // The wait itself failed: nothing is known about the
                    // engine. Reported, not spun on, and not as a drop --
                    // the owner checks the engine before acting.
                    _ => {
                        report(false, None);
                        return;
                    }
                }
            }
            Look::Again => {
                // SAFETY: the stop event is open while `stop` exists.
                if unsafe { WaitForSingleObject(stop.raw(), AGAIN_MS) } != WAIT_TIMEOUT {
                    return;
                }
            }
        }
    }
}

/// How a session ended, when it ended on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub generation: u64,
    /// The protocol the session was carrying, as the engine names it.
    pub protocol: &'static str,
    pub detail: Option<i64>,
    pub at: Instant,
    /// Whether the ending is beyond doubt: a process exit, or a source
    /// that can come back which the owning thread has since asked
    /// directly and found ended. Only a confirmed ending answers a status
    /// on its own -- see [`Ledger::confirmed_drop`].
    pub confirmed: bool,
}

#[derive(Default)]
struct LedgerState {
    /// The session that is live, or 0 when none is.
    live: u64,
    live_protocol: &'static str,
    /// The most recent session to have begun, whether or not it is
    /// still live.
    latest: u64,
    /// The last session that ended on its own, until something newer
    /// makes it irrelevant.
    ended: Option<Ended>,
}

/// Which session is live, and whether the last one ended on its own.
///
/// One per `Engines`, shared by `Arc` with the pipe, because the one
/// reader that cannot wait for the owning thread -- a `Status` answered
/// while that thread is busy, which is exactly when a dead session is
/// being torn down -- has to be able to ask it directly. The mutex is
/// held for the few instructions each method takes and never across
/// anything else.
///
/// The rule that makes it safe: **every teardown the service performs
/// closes the generation before it kills the engine.** `Slot::end` does
/// it, and every teardown goes through `Slot::end`. So an ending reported
/// for a generation that is still live is one nobody here caused.
pub struct Ledger {
    state: Mutex<LedgerState>,
}

/// Generations are unique across every ledger in the process. Tests run
/// many ledgers side by side, and a generation that meant two sessions
/// would make a cross-wired test pass.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger {
    pub fn new() -> Self {
        Self { state: Mutex::new(LedgerState::default()) }
    }

    /// Survives a panic elsewhere: a poisoned ledger must still answer,
    /// because the question it answers is "is this customer tunnelled".
    fn state(&self) -> MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A session has started carrying `protocol`. Returns its generation:
    /// never 0, never reused. Whatever was recorded about an earlier
    /// session is dropped -- it no longer describes the machine.
    pub fn begin(&self, protocol: &'static str) -> u64 {
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let mut state = self.state();
        state.live = generation;
        state.live_protocol = protocol;
        state.latest = generation;
        state.ended = None;
        generation
    }

    /// The session is ending by the service's own hand. Called before
    /// its engine is killed, which is what makes that kill invisible to
    /// [`record`](Self::record).
    pub fn close(&self, generation: u64) {
        let mut state = self.state();
        if state.live == generation {
            state.live = 0;
        }
    }

    /// The engine of `generation` has ended on its own.
    ///
    /// Returns `true` when that session was still live -- this is news --
    /// and `false` when it had already been closed, which is the service
    /// tearing it down itself, or replaced. Recording twice keeps the
    /// first, so whichever of the watch and the status poll saw it first
    /// is the one that says when; a second witness that is `certain` does
    /// confirm what the first left unconfirmed.
    ///
    /// `certain` is false for an ending reported by a source that can
    /// come back on its own ([`Liveness::may_return`]). Such a record
    /// still says when and why, and the owning thread acts on it; what it
    /// does not do until [`confirm`](Self::confirm) is answer a status
    /// by itself.
    pub fn record(&self, generation: u64, detail: Option<i64>, at: Instant, certain: bool) -> bool {
        let mut state = self.state();
        if generation == 0 || state.live != generation {
            return false;
        }
        match state.ended.as_mut() {
            Some(e) if e.generation == generation => e.confirmed |= certain,
            _ => {
                state.ended =
                    Some(Ended { generation, protocol: state.live_protocol, detail, at, confirmed: certain });
            }
        }
        true
    }

    /// The owning thread asked the engine of `generation` directly and it
    /// has ended: what the watch put on record is now beyond doubt.
    pub fn confirm(&self, generation: u64) {
        if let Some(e) = self.state().ended.as_mut().filter(|e| e.generation == generation) {
            e.confirmed = true;
        }
    }

    /// The owning thread asked the engine of `generation` directly and it
    /// is still running: what the watch reported was a moment, not an
    /// ending -- a WireGuard tunnel service the manager restarted, an
    /// IKEv2 connection that left `Connected` while MOBIKE moved it, a
    /// service-manager query that failed. The record goes, so that no
    /// fallback answers "no tunnel" for a tunnel that is up.
    ///
    /// Only while the session is still live. Once it has been closed the
    /// record is history, and history is not rewritten.
    pub fn retract(&self, generation: u64) -> bool {
        let mut state = self.state();
        if generation == 0 || state.live != generation {
            return false;
        }
        if state.ended.as_ref().is_some_and(|e| e.generation == generation) {
            state.ended = None;
            return true;
        }
        false
    }

    pub fn is_live(&self, generation: u64) -> bool {
        generation != 0 && self.state().live == generation
    }

    /// Whether `generation` is the most recent session to have begun --
    /// live or not. The thorough pass after a drop runs only while it is:
    /// once a new session has begun, its own connect already cleared the
    /// decks, and a janitor pass now would take *its* engine for an
    /// orphan.
    pub fn is_latest(&self, generation: u64) -> bool {
        generation != 0 && self.state().latest == generation
    }

    /// The last session ended on its own and nothing has begun since --
    /// confirmed or not. What the owning thread acts on and what the log
    /// line quotes.
    pub fn ended_without_successor(&self) -> Option<Ended> {
        let state = self.state();
        state.ended.clone().filter(|e| e.generation == state.latest)
    }

    /// The same, only once it is beyond doubt.
    ///
    /// The one state in which "no tunnel" can be answered without asking
    /// Windows: the engine is known to have ended, and no engine has been
    /// started after it. Known means a process exit, or an ending the
    /// owning thread has checked for itself -- not a service-manager or
    /// RAS state seen once by the watch, which can change back and, until
    /// it is checked, is left to the fallback's own question.
    pub fn confirmed_drop(&self) -> Option<Ended> {
        self.ended_without_successor().filter(|e| e.confirmed)
    }

    /// Drops the record, for a connect that is starting: from then on
    /// the old tunnel's death is not the answer to "is this customer
    /// tunnelled".
    ///
    /// Deliberately not called on Disconnect. The record only ever
    /// answers "no tunnel", which a Disconnect leaves exactly as true,
    /// and keeping it lets a status that arrives while the thorough pass
    /// holds the owning thread be answered without asking Windows.
    pub fn forget(&self) {
        self.state().ended = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::Barrier;
    use std::time::Duration;

    /// How many engines die at once in the concurrency tests. Thirty-two
    /// because that is the number the relay teardown was caught at: one
    /// at a time passed every run, thirty-two lost eight to twenty. See
    /// docs/split-tunnel-rewrite.md.
    const AT_ONCE: usize = 32;

    /// A real process that stays up for about half a minute. Every
    /// Windows install has ping, and a thread would prove nothing: these
    /// watches are on process handles.
    fn engine_stand_in() -> Child {
        Command::new(r"C:\Windows\System32\ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawning ping")
    }

    fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        done()
    }

    #[test]
    fn generations_are_distinct_and_never_zero() {
        let a = Ledger::new();
        let b = Ledger::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            for ledger in [&a, &b] {
                let g = ledger.begin("TEST");
                assert_ne!(g, 0);
                assert!(seen.insert(g), "generation {g} was handed out twice");
            }
        }
    }

    /// The generation guard on its own terms: the service closing a
    /// session before killing its engine is what makes the kill not a
    /// drop.
    #[test]
    fn an_ending_after_close_is_the_services_own_hand_and_is_refused() {
        let ledger = Ledger::new();
        let g = ledger.begin("XRAY_VLESS_REALITY");
        ledger.close(g);
        assert!(!ledger.record(g, Some(1), Instant::now(), true));
        assert!(ledger.ended_without_successor().is_none());
    }

    #[test]
    fn a_drop_is_recorded_once_with_the_protocol_and_the_first_time() {
        let ledger = Ledger::new();
        let g = ledger.begin("OPENVPN");
        let first = Instant::now();
        assert!(ledger.record(g, Some(1), first, true));
        assert!(ledger.record(g, Some(2), first + Duration::from_secs(1), true), "still news to the second witness");
        let ended = ledger.ended_without_successor().expect("recorded");
        assert_eq!(ended.generation, g);
        assert_eq!(ended.protocol, "OPENVPN");
        assert_eq!(ended.detail, Some(1), "the first witness says when and why");
        assert_eq!(ended.at, first);
    }

    /// A record about an old session must never answer for a new one.
    #[test]
    fn a_new_session_makes_the_old_drop_history() {
        let ledger = Ledger::new();
        let old = ledger.begin("WIREGUARD");
        assert!(ledger.record(old, None, Instant::now(), true));
        ledger.close(old);
        let new = ledger.begin("IKEV2");
        assert!(ledger.ended_without_successor().is_none());
        assert!(!ledger.record(old, None, Instant::now(), true), "a stale generation cannot record over a live one");
        assert!(ledger.is_live(new));
    }

    #[test]
    fn forgetting_clears_the_record() {
        let ledger = Ledger::new();
        let g = ledger.begin("XRAY_TROJAN");
        assert!(ledger.record(g, None, Instant::now(), true));
        ledger.forget();
        assert!(ledger.ended_without_successor().is_none());
    }

    /// An ending the engine turned out not to have had: a WireGuard
    /// tunnel service the manager restarted, an IKEv2 connection that
    /// left `Connected` for a moment. Left on record it answered "no
    /// tunnel" for a live one for as long as the session lasted.
    #[test]
    fn an_ending_the_engine_contradicts_is_retracted() {
        let ledger = Ledger::new();
        let g = ledger.begin("WIREGUARD");
        assert!(ledger.record(g, Some(1066), Instant::now(), false));
        assert!(ledger.retract(g));
        assert!(ledger.ended_without_successor().is_none());
        assert!(ledger.confirmed_drop().is_none());
        assert!(ledger.is_live(g), "a retraction is not a teardown");
        assert!(!ledger.retract(g), "nothing left to retract");

        // And a later, real ending is news again, with its own time.
        let later = Instant::now();
        assert!(ledger.record(g, Some(1), later, true));
        assert_eq!(ledger.confirmed_drop().map(|e| (e.detail, e.at)), Some((Some(1), later)));
    }

    /// History is not rewritten: once the service has closed a session,
    /// whatever was recorded about it stays, and a report about an older
    /// session cannot retract a newer one's.
    #[test]
    fn only_a_live_sessions_own_record_can_be_retracted() {
        let ledger = Ledger::new();
        let g = ledger.begin("IKEV2");
        assert!(ledger.record(g, Some(829), Instant::now(), true));
        ledger.close(g);
        assert!(!ledger.retract(g));
        assert!(ledger.ended_without_successor().is_some());

        let newer = ledger.begin("IKEV2");
        assert!(ledger.record(newer, None, Instant::now(), false));
        assert!(!ledger.retract(g), "a stale generation retracted a newer session's record");
        assert_eq!(ledger.ended_without_successor().map(|e| e.generation), Some(newer));
    }

    /// What a source that can come back reports answers nothing on its
    /// own until the owning thread has looked; a process exit does at
    /// once, and a certain second witness confirms an uncertain first.
    #[test]
    fn an_ending_that_may_be_undone_answers_nothing_until_confirmed() {
        let ledger = Ledger::new();
        let g = ledger.begin("WIREGUARD");
        let first = Instant::now();
        assert!(ledger.record(g, Some(1066), first, false));
        assert!(ledger.ended_without_successor().is_some(), "on record for the owning thread");
        assert!(ledger.confirmed_drop().is_none(), "answered a status before anyone checked");
        ledger.confirm(g);
        assert_eq!(ledger.confirmed_drop().map(|e| (e.detail, e.at)), Some((Some(1066), first)));

        let g = ledger.begin("IKEV2");
        assert!(ledger.record(g, None, Instant::now(), false));
        assert!(ledger.record(g, Some(5), Instant::now(), true));
        let ended = ledger.confirmed_drop().expect("confirmed by the certain witness");
        assert_eq!(ended.detail, None, "the first witness still says why");

        let g = ledger.begin("XRAY_VLESS_REALITY");
        assert!(ledger.record(g, Some(1), Instant::now(), true));
        assert!(ledger.confirmed_drop().is_some(), "a process exit is beyond doubt at once");
    }

    #[test]
    fn a_settling_source_is_not_looked_at_until_its_moment_has_passed() {
        struct Counted(Arc<AtomicU64>);
        impl Liveness for Counted {
            fn look(&mut self) -> Look {
                self.0.fetch_add(1, Ordering::SeqCst);
                Look::Gone(Some(3))
            }
            fn may_return(&self) -> bool {
                true
            }
        }
        let looks = Arc::new(AtomicU64::new(0));
        let mut settle = Settle::new(Box::new(Counted(Arc::clone(&looks))), Duration::from_millis(300));
        assert!(settle.may_return(), "the wrapper must not change what the source is");
        assert!(matches!(settle.look(), Look::Again));
        assert_eq!(looks.load(Ordering::SeqCst), 0);
        std::thread::sleep(Duration::from_millis(350));
        assert!(matches!(settle.look(), Look::Gone(Some(3))));
        assert_eq!(looks.load(Ordering::SeqCst), 1);
    }

    /// The case this module exists for, at the scale teardown bugs
    /// show up at: thirty-two engines killed at the same instant, each
    /// watched for its own session. Every one has to be reported, by its
    /// own watch, for its own generation, and promptly -- a lost report
    /// is a customer told "You're protected" over a dead tunnel.
    #[test]
    fn every_engine_killed_at_once_is_noticed_by_its_own_watch() {
        let reports: Arc<Mutex<Vec<(usize, u64, u32, Instant)>>> = Arc::default();
        let mut sessions = Vec::new();
        for i in 0..AT_ONCE {
            let child = engine_stand_in();
            let pid = child.id();
            let ledger = Arc::new(Ledger::new());
            let generation = ledger.begin("TEST");
            let liveness = ProcessLiveness::of_handle(child.as_raw_handle() as HANDLE).expect("a handle of our own");
            let (seen, ledger_for_watch) = (Arc::clone(&reports), Arc::clone(&ledger));
            let guard = watch(
                generation,
                "test",
                Box::new(liveness),
                Arc::new(move |gone: Gone| {
                    if gone.definitive && ledger_for_watch.record(gone.generation, gone.detail, gone.at, !gone.may_return) {
                        seen.lock().unwrap().push((i, gone.generation, pid, gone.at));
                    }
                }),
            )
            .expect("starting a watch");
            sessions.push((i, child, pid, generation, guard));
        }

        // All killed at once, from as many threads, the way a teardown
        // racing itself would.
        let start = Arc::new(Barrier::new(AT_ONCE));
        let mut killers = Vec::new();
        let mut expected = Vec::new();
        let mut guards = Vec::new();
        for (i, mut child, pid, generation, guard) in sessions {
            expected.push((i, generation, pid));
            guards.push(guard);
            let start = Arc::clone(&start);
            killers.push(std::thread::spawn(move || {
                start.wait();
                let killed_at = Instant::now();
                child.kill().expect("killing the stand-in");
                let _ = child.wait();
                (i, killed_at)
            }));
        }
        let killed_at: std::collections::HashMap<usize, Instant> =
            killers.into_iter().map(|k| k.join().unwrap()).collect();

        let all_in = wait_until(Duration::from_secs(10), || reports.lock().unwrap().len() >= AT_ONCE);
        let reports = reports.lock().unwrap().clone();
        assert!(all_in, "only {} of {AT_ONCE} deaths were noticed", reports.len());
        assert_eq!(reports.len(), AT_ONCE, "a death was reported twice: {reports:?}");

        let mut slowest = Duration::ZERO;
        for (i, generation, pid) in expected {
            let mine: Vec<_> = reports.iter().filter(|r| r.0 == i).collect();
            assert_eq!(mine.len(), 1, "session {i} was reported {} times", mine.len());
            let (_, seen_generation, seen_pid, at) = *mine[0];
            assert_eq!(seen_generation, generation, "session {i} was reported under another session's generation");
            assert_eq!(seen_pid, pid);
            let after = at.saturating_duration_since(killed_at[&i]);
            slowest = slowest.max(after);
            assert!(after < Duration::from_secs(2), "session {i} was noticed {after:?} after it died");
        }
        // Printed for `--nocapture`, so the figure quoted in the journal
        // can be re-taken rather than taken on trust.
        eprintln!("slowest of {AT_ONCE} engine deaths noticed after {slowest:?}");
        drop(guards);
    }

    /// The inverse, and just as important: the service's own teardowns
    /// must never read as drops, and no watch may outlive its session.
    ///
    /// Half the sessions are ended the way `Slot::end` ends them -- the
    /// generation closed, the guard dropped -- and only then killed.
    /// The other half keep their guard until after the kill, so the only
    /// thing standing between them and a false "connection lost" is the
    /// closed generation. Both halves have to report nothing.
    #[test]
    fn sessions_ended_on_purpose_report_nothing_and_leave_no_thread() {
        let reports = Arc::new(AtomicU64::new(0));
        let mut sessions = Vec::new();
        for i in 0..AT_ONCE {
            let child = engine_stand_in();
            let ledger = Arc::new(Ledger::new());
            let generation = ledger.begin("TEST");
            let liveness = ProcessLiveness::of_handle(child.as_raw_handle() as HANDLE).expect("a handle of our own");
            let (count, ledger_for_watch) = (Arc::clone(&reports), Arc::clone(&ledger));
            let guard = watch(
                generation,
                "test",
                Box::new(liveness),
                Arc::new(move |gone: Gone| {
                    if ledger_for_watch.record(gone.generation, gone.detail, gone.at, !gone.may_return) {
                        count.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .expect("starting a watch");
            sessions.push((i, child, ledger, generation, guard));
        }

        let start = Arc::new(Barrier::new(AT_ONCE));
        let mut finished = Vec::new();
        let mut enders = Vec::new();
        for (i, mut child, ledger, generation, guard) in sessions {
            finished.push(guard.finished());
            let start = Arc::clone(&start);
            enders.push(std::thread::spawn(move || {
                start.wait();
                ledger.close(generation);
                if i % 2 == 0 {
                    drop(guard);
                    child.kill().expect("killing the stand-in");
                } else {
                    child.kill().expect("killing the stand-in");
                    let _ = child.wait();
                    // Long enough for the watch to have seen the exit
                    // and asked the ledger, which must have said no.
                    std::thread::sleep(Duration::from_millis(300));
                    drop(guard);
                }
                let _ = child.wait();
            }));
        }
        for ender in enders {
            ender.join().unwrap();
        }

        let all_ended = wait_until(Duration::from_secs(5), || finished.iter().all(|f| f.load(Ordering::Acquire)));
        assert_eq!(reports.load(Ordering::SeqCst), 0, "a teardown of our own was reported as a drop");
        let left = finished.iter().filter(|f| !f.load(Ordering::Acquire)).count();
        assert!(all_ended, "{left} watch threads outlived their sessions");
    }

    /// A source with nothing to wait on yet -- a tunnel service still
    /// starting -- is looked at again until it can answer, and reported
    /// exactly once.
    #[test]
    fn a_source_that_cannot_answer_yet_is_asked_again() {
        struct Starting(u32);
        impl Liveness for Starting {
            fn look(&mut self) -> Look {
                self.0 += 1;
                if self.0 < 4 {
                    Look::Again
                } else {
                    Look::Gone(Some(7))
                }
            }
        }
        let seen: Arc<Mutex<Vec<Gone>>> = Arc::default();
        let into = Arc::clone(&seen);
        let guard = watch(42, "test", Box::new(Starting(0)), Arc::new(move |g: Gone| into.lock().unwrap().push(g)))
            .expect("starting a watch");
        assert!(wait_until(Duration::from_secs(5), || !seen.lock().unwrap().is_empty()));
        assert!(wait_until(Duration::from_secs(2), || guard.finished().load(Ordering::Acquire)));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].generation, 42);
        assert_eq!(seen[0].detail, Some(7));
        assert!(seen[0].definitive);
    }

    /// An event somebody else sets -- RAS, for IKEv2 -- is waited on
    /// like a process and ends the watch the same way.
    #[test]
    fn an_event_set_by_someone_else_ends_the_watch() {
        struct OnEvent(OwnedHandle);
        impl Liveness for OnEvent {
            fn look(&mut self) -> Look {
                if self.0.is_signalled() {
                    Look::Gone(None)
                } else {
                    Look::WaitOn(self.0.raw())
                }
            }
        }
        let event = new_event().unwrap();
        let theirs = event.duplicate().unwrap();
        let seen = Arc::new(AtomicU64::new(0));
        let count = Arc::clone(&seen);
        let _guard = watch(7, "test", Box::new(OnEvent(theirs)), Arc::new(move |_: Gone| {
            count.fetch_add(1, Ordering::SeqCst);
        }))
        .unwrap();

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(seen.load(Ordering::SeqCst), 0, "reported before anything happened");
        let set_at = Instant::now();
        // SAFETY: the event is open.
        unsafe { SetEvent(event.raw()) };
        assert!(wait_until(Duration::from_secs(2), || seen.load(Ordering::SeqCst) == 1));
        assert!(set_at.elapsed() < Duration::from_secs(2));
    }

    /// The exit code is what a supporter reads first in the log, so it
    /// has to be the process's own.
    #[test]
    fn a_killed_process_reports_its_exit_code() {
        let mut child = engine_stand_in();
        let handle = process_handle(child.as_raw_handle() as HANDLE).unwrap();
        assert_eq!(exit_code(&handle), None, "a running process has no exit code");
        child.kill().unwrap();
        let _ = child.wait();
        assert!(wait_until(Duration::from_secs(2), || handle.is_signalled()));
        assert_eq!(exit_code(&handle), Some(1), "Child::kill terminates with exit code 1");
    }
}
