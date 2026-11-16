//! Knowing the app has gone, from the kernel rather than from silence.
//!
//! The Windows service waits on the app's process handle; the Linux
//! equivalent is a pidfd (`pidfd_open`, Linux 5.3), which becomes readable
//! the moment the process exits. It is waited on through tokio's reactor,
//! so a watch costs no thread at all.
//!
//! The watch is on the *process*, not the connection: the app opens a
//! connection per request, so a connection closing is the app going quiet
//! between requests, and a process ending is the app being gone. One watch
//! at a time, keyed on the pid, and only of Neoxify's own app -- on
//! Windows, watching whoever connected last meant a status probe from
//! another tool, finishing and exiting, was read as the customer closing
//! Neoxify, and the tunnel came down under a running app.

use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::unix::AsyncFd;
use tokio::io::Interest;

/// Set when the helper is stopping, so a watch that fires meanwhile does
/// not cancel the stop's own teardown. See [`tears_down`].
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub fn stop_watching() {
    SHUTTING_DOWN.store(true, Ordering::Release);
}

pub fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::Acquire)
}

/// Why a watch ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitSignal {
    /// The normal case: the process is gone.
    Exited { pid: u32 },
    /// The wait failed unexpectedly. Treated as an exit, as on Windows:
    /// a watch that can no longer see the app must not keep its tunnel.
    Unknown { pid: u32 },
}

impl ExitSignal {
    pub fn reason(&self) -> String {
        match self {
            Self::Exited { pid } => format!("the app (pid {pid}) exited"),
            Self::Unknown { pid } => format!("the wait on the app (pid {pid}) failed; treating it as gone"),
        }
    }
}

/// Whether a watch that just ended should run the app-went-away teardown.
/// Not while the helper is stopping: the stop cancels what is running and
/// queues its own full teardown, and a watch cancelling *that* left it
/// half done on Windows.
pub fn tears_down(service_stopping: bool) -> bool {
    !service_stopping
}

/// A watch on one process.
pub struct PidWatch {
    pub pid: u32,
    fd: OwnedFd,
}

impl PidWatch {
    /// Opens a pidfd on `pid`. Fails on a kernel older than 5.3, or when
    /// the process is already gone; the idle watchdog is the backstop.
    pub fn open(pid: u32) -> io::Result<Self> {
        let pid_t = libc::pid_t::try_from(pid).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: pidfd_open takes a pid and flags and returns a new file
        // descriptor or -1; no memory is passed.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid_t, 0 as libc::c_uint) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the descriptor was just returned to us and nothing else
        // owns it.
        let fd = unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) };
        Ok(Self { pid, fd })
    }

    /// Resolves when the process has exited.
    pub async fn exited(self) -> ExitSignal {
        let pid = self.pid;
        // SAFETY: the AsyncFd takes ownership of the OwnedFd, so the
        // descriptor stays open and the same for the AsyncFd's lifetime.
        match unsafe { AsyncFd::register_with_interest(self.fd, Interest::READABLE) } {
            Ok(fd) => match fd.readable().await {
                Ok(_) => ExitSignal::Exited { pid },
                Err(_) => ExitSignal::Unknown { pid },
            },
            Err(_) => ExitSignal::Unknown { pid },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A real child process, really exiting: the watch must see it.
    #[tokio::test]
    async fn a_process_that_exits_is_seen_to_exit() {
        let mut child = std::process::Command::new("sleep").arg("0.3").spawn().expect("sleep");
        let watch = PidWatch::open(child.id()).expect("pidfd_open");
        let signal = tokio::time::timeout(Duration::from_secs(10), watch.exited())
            .await
            .expect("the exit was never seen");
        assert_eq!(signal, ExitSignal::Exited { pid: child.id() });
        let _ = child.wait();
    }

    /// And one that is still running is not.
    #[tokio::test]
    async fn a_running_process_is_not_seen_to_exit() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().expect("sleep");
        let watch = PidWatch::open(child.id()).expect("pidfd_open");
        let early = tokio::time::timeout(Duration::from_millis(400), watch.exited()).await;
        assert!(early.is_err(), "a running process was reported gone");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn the_stop_has_its_own_teardown() {
        assert!(tears_down(false));
        assert!(!tears_down(true));
    }
}
