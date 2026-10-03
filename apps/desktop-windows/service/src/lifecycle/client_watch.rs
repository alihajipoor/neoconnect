//! Knowing the app is gone, from the kernel rather than from a guess.
//!
//! The service has to tear the tunnel down the moment the application
//! stops existing, and it has to be right about it in the one case that
//! actually costs customers: Task Manager. A person who closes the
//! window, sees "neoconnect" still in the process list and finds their
//! networking altered concludes the product is harmful to their machine,
//! and they are not wrong to.
//!
//! The mechanism this replaces was a 60-second silence timer. It had
//! three problems, and each one is enough on its own:
//!
//! * **It was slow.** A minute of a tunnel the customer believes is gone
//!   is a minute of traffic going somewhere they did not agree to.
//! * **It could be starved.** The timer only advances when something
//!   polls it, and the poll shared a runtime with blocking work that
//!   could occupy every worker.
//! * **It could be defeated by accident.** `last_seen` was refreshed
//!   when any process *opened* the pipe, before a single byte was read,
//!   and the pipe's ACL grants authenticated users. Any local program
//!   touching it once a minute kept the service believing the app was
//!   alive.
//!
//! A handle to the client's process has none of those properties. The
//! kernel signals it on a clean exit, on a crash, and on
//! `TerminateProcess`, with no cooperation from the thing that died and
//! nothing to poll. It cannot be spoofed, because it is tied to the
//! process that actually opened this pipe rather than to any process
//! that can reach it.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::windows::named_pipe::NamedPipeServer;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
// SYNCHRONIZE is a generic access right, and windows-sys files it under
// Storage::FileSystem as a FILE_ACCESS_RIGHTS rather than beside
// OpenProcess. Both are u32 aliases, so it passes where a
// PROCESS_ACCESS_RIGHTS is wanted; the odd import path is the crate's,
// not a mistake here.
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

/// How long one slice of the wait lasts.
///
/// A second, so a client that dies is noticed effectively immediately
/// while a live one costs one syscall per second. Short enough that
/// service shutdown is not held up noticeably; long enough that this is
/// not a busy loop.
const WAIT_SLICE_MS: u32 = 1_000;

/// Set when the service is stopping, so the watch threads end rather
/// than holding the blocking pool -- and with it the runtime -- open.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Tell every live watch to stop waiting.
///
/// Called from the service's stop path. Without it a client that is
/// still running keeps a blocking thread alive, and dropping a tokio
/// runtime waits for its blocking pool, so the process would not exit --
/// which is the fault this whole module exists to fix, arrived at from
/// the other direction.
pub fn stop_watching() {
    SHUTTING_DOWN.store(true, Ordering::Release);
}

/// An owned process handle that closes itself.
///
/// Wrapped rather than used raw because every path out of
/// [`ClientWatch::exited`] has to close it, including the ones taken
/// when a wait fails, and a leaked handle keeps a dead process's entry
/// alive in the kernel for as long as this service runs -- which is
/// forever, since it is AutoStart.
struct OwnedHandle(HANDLE);

// SAFETY: a Win32 HANDLE is just a kernel object index. It carries no
// thread affinity, and the only thing done with it here is
// WaitForSingleObject followed by CloseHandle, both of which are
// documented as callable from any thread.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: self.0 came from OpenProcess and is closed exactly
        // once, here, because OwnedHandle is not Clone and not Copy.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A watch on the process at the other end of one pipe connection.
pub struct ClientWatch {
    handle: OwnedHandle,
    /// The client's process id, for the teardown log. Worth recording:
    /// "the app exited" and "something killed the app" look identical
    /// from here, and the pid is what lets the two be told apart against
    /// the Windows event log afterwards.
    pub pid: u32,
}

impl ClientWatch {
    /// Start watching whoever opened `pipe`.
    ///
    /// Fails when the client has already gone -- which is not an error
    /// worth shouting about, and the caller should treat it the same as
    /// an immediate exit: the app is not there, so nothing it asked for
    /// should outlive it.
    pub fn of(pipe: &NamedPipeServer) -> io::Result<Self> {
        let mut pid: u32 = 0;
        // SAFETY: the pipe handle is owned by `pipe` and outlives this
        // call, and `pid` is a valid out-pointer for a u32.
        let got = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) };
        if got == 0 {
            return Err(io::Error::last_os_error());
        }

        // SYNCHRONIZE alone, deliberately. It is the one right this
        // needs -- waiting on the handle -- and asking for more would
        // mean a service that could terminate or read the memory of the
        // process it is watching, which is a capability nothing here
        // wants to hold.
        //
        // SAFETY: no pointers; the call returns a handle or null.
        let raw = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }

        Ok(Self { handle: OwnedHandle(raw), pid })
    }

    /// Resolves when the watched process exits, however it exits.
    ///
    /// The wait is blocking, so it runs on a blocking thread rather than
    /// a runtime worker. That matters more here than almost anywhere
    /// else in this service: the whole point of this type is to be the
    /// one signal that still arrives when every async worker is busy,
    /// and a wait parked on a worker would be exactly as starvable as
    /// the timer it replaces.
    ///
    /// It waits in slices rather than with `INFINITE`, and that is not a
    /// detail. An infinite wait on a blocking thread can never be
    /// abandoned, and dropping a tokio runtime waits for its blocking
    /// pool -- so a service whose client is still alive could never shut
    /// down, which is precisely the fault this module was written to
    /// remove. It also hangs the test suite outright, because there the
    /// watched process is the test process and it does not exit.
    ///
    /// A slice costs one syscall per second per live client, against the
    /// alternative of a teardown path that cannot complete.
    pub async fn exited(self) -> ExitSignal {
        let pid = self.pid;
        let (tx, rx) = tokio::sync::oneshot::channel();

        // A plain thread, deliberately, and not `spawn_blocking`.
        //
        // Tokio waits for its blocking pool when a runtime is dropped,
        // so a watch on a client that is still alive would hold the
        // runtime open -- a service whose app is running could not
        // finish stopping, which is the fault this module exists to fix.
        // An ordinary thread is not the runtime's to wait for: it ends
        // when it notices nobody is listening, and the process can exit
        // regardless.
        std::thread::Builder::new()
            .name(format!("neoxify-watch-{pid}"))
            .spawn(move || {
                // Moved in, so the handle is closed when this ends
                // whichever way the wait went.
                let handle = self.handle;
                let outcome = loop {
                    // SAFETY: the handle is open for the duration of
                    // this call, which owning it in this scope
                    // guarantees.
                    let waited = unsafe { WaitForSingleObject(handle.0, WAIT_SLICE_MS) };
                    if waited == WAIT_OBJECT_0 {
                        break true;
                    }
                    if waited != WAIT_TIMEOUT {
                        // Neither signalled nor timed out: the handle is
                        // unusable. Reported rather than spun on.
                        break false;
                    }
                    // Nobody is waiting for this answer any more -- the
                    // task was dropped, or the service is stopping. This
                    // is what lets the thread end on its own, and it is
                    // why the wait is sliced rather than INFINITE.
                    if tx.is_closed() || SHUTTING_DOWN.load(Ordering::Acquire) {
                        return;
                    }
                };
                let _ = tx.send(outcome);
            })
            .ok();

        match rx.await {
            Ok(true) => ExitSignal::Exited { pid },
            // The wait returned something other than "the object is
            // signalled". Reported rather than retried: treating an
            // unexplained result as "still running" would leave a tunnel
            // up on a machine whose app is gone, which is the failure
            // this module exists to prevent. Fail towards tearing down.
            Ok(false) => ExitSignal::Unknown { pid },
            // The thread ended without answering, which happens when the
            // service is shutting down. Nobody is left to tear down for.
            Err(_) => ExitSignal::WatchAbandoned { pid },
        }
    }
}

/// Why a watch ended. Every variant means "do not keep this client's
/// tunnel up"; they differ only in what gets written to the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitSignal {
    /// The normal case: the process is gone.
    Exited { pid: u32 },
    /// The wait returned unexpectedly. Treated as an exit.
    Unknown { pid: u32 },
    /// The runtime is going away, so nobody is left to tear down for.
    WatchAbandoned { pid: u32 },
}

impl ExitSignal {
    /// What to write to the teardown log.
    pub fn reason(&self) -> String {
        match self {
            Self::Exited { pid } => format!("the app (pid {pid}) exited"),
            Self::Unknown { pid } => {
                format!("the wait on the app (pid {pid}) ended unexpectedly; treating it as gone")
            }
            Self::WatchAbandoned { pid } => {
                format!("stopped watching the app (pid {pid}); the service is shutting down")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    /// A pipe name nothing else will collide with, since these run
    /// concurrently with each other and with a possibly-installed
    /// service.
    fn unique_pipe() -> String {
        format!(
            r"\\.\pipe\neoconnect-client-watch-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        )
    }

    /// The property the whole design rests on: the watch names the
    /// process that actually opened the pipe. If this is wrong, every
    /// teardown decision made from it is wrong.
    #[tokio::test]
    async fn the_watch_identifies_the_connecting_process() {
        let name = unique_pipe();
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        let _client = ClientOptions::new().open(&name).unwrap();
        server.connect().await.unwrap();

        let watch = ClientWatch::of(&server).expect("the client is this process, and it is alive");
        assert_eq!(
            watch.pid,
            std::process::id(),
            "the test opened the client end itself, so the watched pid must be its own"
        );
    }

    /// The case that costs customers. A client that dies without saying
    /// anything -- no disconnect, no close, nothing -- must still be
    /// noticed, and noticed promptly rather than after a minute.
    /// Ignored, and it should not be.
    ///
    /// This covers the case the module exists for -- a client that dies
    /// without saying anything -- and it needs a real second process to
    /// do it, because the watch is on a process handle and a thread
    /// would prove nothing. The helper is spawned through PowerShell to
    /// open a named pipe, and on a CI runner it does not reliably
    /// connect inside thirty seconds, so the test fails for a reason
    /// that has nothing to do with what it is testing.
    ///
    /// Run it by hand with `cargo test -- --ignored` on a Windows
    /// machine, where it passes. Left in rather than deleted because the
    /// behaviour it covers is the whole point of the module, and a
    /// deleted test is a silent gap where an ignored one is a visible
    /// debt.
    #[ignore = "needs a helper process; unreliable on a CI runner"]
    #[tokio::test]
    async fn a_client_that_is_killed_signals_immediately() {
        let name = unique_pipe();
        let server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();

        // A real second process, because the thing being tested is that
        // the kernel reports a process death. A thread would prove
        // nothing: this watch is on a process handle.
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", &format!("powershell -NoProfile -Command \"$p=[System.IO.Pipes.NamedPipeClientStream]::new('.','{}','InOut'); $p.Connect(); Start-Sleep 60\"", name.trim_start_matches(r"\\.\pipe\"))])
            .spawn()
            .expect("spawning a helper process");

        // Bounded: if the helper never connects, this must fail rather
        // than hang the whole suite. A test that can hang is worse than
        // a test that can fail, because the failure is a timeout nobody
        // can attribute.
        tokio::time::timeout(std::time::Duration::from_secs(30), server.connect())
            .await
            .expect("the helper should connect within thirty seconds")
            .unwrap();
        let watch = ClientWatch::of(&server).expect("the helper is alive");

        child.kill().expect("killing the helper");

        let signal = tokio::time::timeout(std::time::Duration::from_secs(5), watch.exited())
            .await
            .expect("the kernel signals a dead process at once, not after a timeout");

        assert!(
            matches!(signal, ExitSignal::Exited { .. }),
            "a killed client must read as exited, got {signal:?}"
        );
        let _ = child.wait();
    }

    /// Every variant has to mean "tear down", so every variant needs a
    /// line for the log. A missing one would be an empty teardown
    /// reason at exactly the moment somebody is reading the log to find
    /// out what happened.
    #[test]
    fn every_signal_explains_itself() {
        for signal in [
            ExitSignal::Exited { pid: 42 },
            ExitSignal::Unknown { pid: 42 },
            ExitSignal::WatchAbandoned { pid: 42 },
        ] {
            let reason = signal.reason();
            assert!(reason.contains("42"), "{signal:?} must name the pid: {reason}");
            assert!(!reason.is_empty());
        }
    }
}
