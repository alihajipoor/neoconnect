//! Engine processes: started from our own install only, watched, and
//! found again after a crash by their program path alone.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::cmd::{self, Budget, Stop};
use crate::Problem;

/// How long an engine must stay alive after starting before it counts
/// as started. The Windows service's number (`engines::STARTUP_GRACE`):
/// an engine that rejects its config dies within a few hundred
/// milliseconds, and without this wait the app said "Connected" for an
/// engine that had already exited.
pub(crate) const STARTUP_GRACE: Duration = Duration::from_millis(1500);

/// Starts `exe` with its output in `log`, in its own process group so a
/// signal meant for the helper (a Ctrl-C in a terminal) does not reach it
/// half way through a teardown.
pub(crate) fn spawn(exe: &Path, args: &[&str], log: &Path) -> std::io::Result<Child> {
    let out = std::fs::File::create(log)?;
    let err = out.try_clone()?;
    Command::new(exe)
        .args(args)
        .current_dir(exe.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .process_group(0)
        .spawn()
}

/// The engine is still alive after [`STARTUP_GRACE`], or what it logged
/// as it died. A liveness check, not a proof that traffic flows -- but it
/// turns a bad config or a missing piece into a real error.
pub(crate) fn confirm_started(child: &mut Child, engine: &str, log: &Path, budget: &Budget) -> Result<(), Problem> {
    let waited = budget.sleep(STARTUP_GRACE);
    match child.try_wait() {
        // Starting is local: running out of time here says nothing about
        // a server, so it is not worded as a timeout (`RunError::problem`).
        Ok(None) => waited.map_err(|stop| match stop {
            Stop::Cancelled => Problem::Cancelled,
            Stop::TimedOut => Problem::Failed(format!("{engine} did not start in time")),
        }),
        Ok(Some(status)) => {
            log_last_words(engine, log);
            Err(Problem::Failed(format!("{engine} exited immediately ({status})")))
        }
        Err(e) => Err(Problem::Failed(format!("could not check whether {engine} started: {e}"))),
    }
}

/// Puts an engine's last words in the helper's journal. They are kept out
/// of the error the app is given: the app sorts errors by their words, and
/// a log line saying a certificate "expired" read there as the customer's
/// subscription having run out.
pub(crate) fn log_last_words(engine: &str, log: &Path) {
    eprintln!("neoxify-helper: {engine}'s last words: {}", log_tail(log));
}

/// The last lines of an engine's log, on one line.
pub(crate) fn log_tail(log: &Path) -> String {
    std::fs::read_to_string(log)
        .ok()
        .map(|s| s.lines().rev().filter(|l| !l.trim().is_empty()).take(6).collect::<Vec<_>>().join(" | "))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "no output".to_string())
}

/// Every process whose program is exactly `exe`.
///
/// Matched by `/proc/<pid>/exe` and nothing else: a process name can be
/// anything its owner likes, and another xray on the machine -- a
/// customer's own, in their home directory -- is not ours to kill. An
/// install upgraded under a running engine shows the old file as
/// "<path> (deleted)", which is still ours.
pub(crate) fn running_from(exe: &Path) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    let deleted = PathBuf::from(format!("{} (deleted)", exe.display()));
    let me = std::process::id();
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .filter(|pid| *pid != me)
        .filter(|pid| {
            std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|target| target == exe || target == deleted)
        })
        .collect()
}

/// Every process of the system program `program` (by file name, as
/// `/usr/sbin/openvpn` is ours to start but not ours alone) whose command
/// line names `arg` exactly.
///
/// For an engine that is the distribution's rather than ours: another
/// OpenVPN on the machine -- the customer's own, run by NetworkManager --
/// is never ours to kill, and the only thing that tells ours apart is
/// that it reads our config, in our root-only directory.
pub(crate) fn running_with_arg(program: &str, arg: &Path) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    let me = std::process::id();
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .filter(|pid| *pid != me)
        .filter(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|bytes| cmdline_names(&bytes, program, arg))
        })
        .collect()
}

/// Whether a `/proc/<pid>/cmdline` (arguments separated by NUL) is
/// `program` run with `arg` among its arguments.
pub(crate) fn cmdline_names(cmdline: &[u8], program: &str, arg: &Path) -> bool {
    let mut parts = cmdline.split(|b| *b == 0).filter(|p| !p.is_empty());
    let Some(first) = parts.next() else { return false };
    let name = Path::new(std::str::from_utf8(first).unwrap_or("")).file_name().and_then(|n| n.to_str());
    let wanted = arg.to_string_lossy();
    name == Some(program) && parts.any(|p| p == wanted.as_bytes())
}

/// SIGKILL to one process, through `kill(1)`: this crate takes no C
/// dependency for one system call.
pub(crate) fn kill_pid(pid: u32) -> Result<(), String> {
    match cmd::run("kill", &["-KILL", &pid.to_string()], &Budget::quick(cmd::TEARDOWN_CAP)) {
        Ok(out) if out.success => Ok(()),
        Ok(out) => Err(out.complaint()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_process_by_its_program_and_nothing_else() {
        // This test binary is running from its own path; nothing else is.
        let me = std::fs::read_link("/proc/self/exe").unwrap();
        assert!(running_from(&me).is_empty(), "the caller is never listed");
        assert!(running_from(Path::new("/nonexistent/neoxify/xray")).is_empty());
    }

    #[test]
    fn a_distribution_engine_is_ours_only_when_it_reads_our_config() {
        let ours = Path::new("/run/neoxify/neoxify.ovpn");
        assert!(cmdline_names(b"/usr/sbin/openvpn\0--config\0/run/neoxify/neoxify.ovpn\0", "openvpn", ours));
        assert!(!cmdline_names(b"/usr/sbin/openvpn\0--config\0/etc/openvpn/client.conf\0", "openvpn", ours));
        assert!(!cmdline_names(b"/usr/bin/cat\0/run/neoxify/neoxify.ovpn\0", "openvpn", ours));
        assert!(!cmdline_names(b"", "openvpn", ours));
    }

    #[test]
    fn an_engine_that_dies_at_once_is_not_started_and_says_why() {
        let dir = std::env::temp_dir().join(format!("neoxify-proc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("engine.log");
        let mut child = spawn(Path::new("/bin/sh"), &["-c", "echo config refused >&2; exit 3"], &log).unwrap();
        let budget = Budget::quick(Duration::from_secs(5));
        let err = confirm_started(&mut child, "Xray", &log, &budget).unwrap_err();
        assert!(err.to_string().contains("Xray exited immediately"), "{err}");
        // The engine's own words go to the journal, not into what the app
        // sorts by wording ("refused" there means a server not answering).
        assert!(!err.to_string().contains("refused"), "{err}");
        assert!(log_tail(&log).contains("config refused"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
