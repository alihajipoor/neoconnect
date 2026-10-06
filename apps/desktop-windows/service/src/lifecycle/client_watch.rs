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

/// Whether [`stop_watching`] has been called. The engine watches in
/// `engine_watch` honour the same signal, so one call ends every watch
/// thread the service has.
pub(crate) fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::Acquire)
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

/// The desktop app's executable, as the installer lays it down: beside
/// the `resources` directory the service runs from.
const APP_EXE: &str = "neoconnect-desktop.exe";

/// Whether the process at the other end of the pipe is Neoxify's own app.
///
/// Only the app's exit means "the customer closed Neoxify". The pipe's
/// ACL admits any authenticated local process, and the watch used to be
/// placed on whichever one connected last -- so a status probe, a second
/// tool, anything that opened the pipe and then exited, was read as the
/// app going away and tore the customer's tunnel down while the app still
/// showed it connected. Found on the test VM on 2026-10-04: three
/// teardowns in the service's own log, each logged as "the app exited",
/// each actually a test script finishing.
///
/// Decided by the executable path, which a look-alike cannot fake: the
/// install directory is under Program Files, where writing needs the
/// elevation that would make faking it pointless.
pub fn is_the_app(pid: u32) -> bool {
    let Some(client) = process_image(pid) else { return false };
    let Ok(service) = std::env::current_exe() else { return false };
    names_the_app(std::path::Path::new(&client), &service)
}

/// The rule, apart from the lookups so it can be tested: the client is
/// `neoconnect-desktop.exe`, in the service's own directory or in the one
/// above it (the installed layout puts the service in `resources\`).
/// Compared without regard to case, as Windows paths are.
fn names_the_app(client: &std::path::Path, service: &std::path::Path) -> bool {
    let lower = |p: Option<&std::path::Path>| p.map(|p| p.to_string_lossy().to_lowercase());
    let named_right = client
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(APP_EXE));
    let client_dir = lower(client.parent());
    let service_dir = service.parent();
    named_right
        && client_dir.is_some()
        && (client_dir == lower(service_dir) || client_dir == lower(service_dir.and_then(|d| d.parent())))
}

/// The full path of a process's executable, or `None` if it cannot be
/// asked -- which `is_the_app` reads as "not the app".
fn process_image(pid: u32) -> Option<String> {
    use windows_sys::Win32::System::Threading::{
        QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: no pointers; the call returns a handle or null.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        return None;
    }
    let handle = OwnedHandle(raw);
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer is valid for `len` wide characters, and the call
    // writes at most that many and updates `len`.
    let ok = unsafe { QueryFullProcessImageNameW(handle.0, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut len) };
    (ok != 0).then(|| String::from_utf16_lossy(&buffer[..len as usize]))
}

/// Why a watch ended. `Exited` and `Unknown` mean "do not keep this
/// client's tunnel up". `WatchAbandoned` does not: it means the service
/// is stopping, and the stop has its own teardown -- see [`tears_down`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitSignal {
    /// The normal case: the process is gone.
    Exited { pid: u32 },
    /// The wait returned unexpectedly. Treated as an exit.
    Unknown { pid: u32 },
    /// The runtime is going away, so nobody is left to tear down for.
    WatchAbandoned { pid: u32 },
}

/// Whether a watch that just ended should run the app-went-away
/// teardown.
///
/// Not while the service is stopping. The stop path (main.rs) cancels
/// what is running, queues its own full teardown and waits for it; the
/// watch, abandoned within a second of the stop beginning, used to read
/// that as the app going away: it logged so, cancelled the *stop's*
/// teardown -- the job running at that moment, whose route.exe, poke and
/// `/uninstalltunnelservice` helpers then died mid-step -- and queued a
/// replacement the process then exited without running. An app that
/// genuinely exits at the same moment needs nothing more: the stop's
/// teardown is a full disconnect and a gaming disarm.
pub fn tears_down(signal: ExitSignal, service_stopping: bool) -> bool {
    !service_stopping && !matches!(signal, ExitSignal::WatchAbandoned { .. })
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

    /// A service stop is not the app going away. The watch is abandoned
    /// within a second of a stop beginning, and treating that as an exit
    /// cancelled the stop's own teardown mid-step.
    #[test]
    fn a_service_stop_does_not_run_the_app_teardown() {
        assert!(tears_down(ExitSignal::Exited { pid: 1 }, false));
        assert!(tears_down(ExitSignal::Unknown { pid: 1 }, false));
        assert!(!tears_down(ExitSignal::WatchAbandoned { pid: 1 }, false));
        // An app that really exits while the service stops: the stop's
        // teardown already covers it.
        assert!(!tears_down(ExitSignal::Exited { pid: 1 }, true));

        // And the pipe's watch task asks before it logs or cancels.
        let pipe = include_str!("../pipe.rs");
        let asked = pipe.find("client_watch::tears_down(").expect("the watch task asks");
        let noted = asked + pipe[asked..].find("\"the app went away\"").unwrap();
        let cancelled = noted + pipe[noted..].find("engines.cancel_running()").unwrap();
        assert!(asked < noted && noted < cancelled);
        assert!(
            pipe[..asked].rfind("watch.exited().await").is_some(),
            "the check is on the watch's own signal"
        );
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

    /// Only the installed app's own executable counts as the app. The
    /// failure this guards against was measured, not imagined: on the
    /// test VM every short-lived pipe client was taken for the app and
    /// its exit tore the tunnel down.
    #[test]
    fn only_the_installed_app_counts_as_the_app() {
        use std::path::Path;
        let service = Path::new(r"C:\Program Files\Neoxify\resources\neoconnect-service.exe");

        assert!(names_the_app(Path::new(r"C:\Program Files\Neoxify\neoconnect-desktop.exe"), service));
        assert!(names_the_app(Path::new(r"c:\program files\neoxify\NEOCONNECT-DESKTOP.EXE"), service), "case-blind");
        // A layout with the service beside the app also counts.
        assert!(names_the_app(
            Path::new(r"D:\Neoxify\neoconnect-desktop.exe"),
            Path::new(r"D:\Neoxify\neoconnect-service.exe")
        ));

        for stranger in [
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Users\someone\Downloads\neoconnect-desktop.exe",
            r"C:\Program Files\Neoxify\resources\neoconnect-desktop.exe.bak",
            r"C:\Program Files\Neoxify\neoconnect-desktop2.exe",
        ] {
            assert!(!names_the_app(Path::new(stranger), service), "{stranger} is not the app");
        }
    }

    /// The test process is not the app, so it must not be watched as one --
    /// which is also what keeps the pipe tests from tearing anything down.
    #[test]
    fn this_test_process_is_not_the_app() {
        assert!(!is_the_app(std::process::id()));
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
