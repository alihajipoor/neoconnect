//! A record of what teardown could not undo.
//!
//! Everything in this service that cleans up after a tunnel is
//! deliberately best-effort: a failed removal must never stop a
//! disconnect, a service start, or an uninstall, because each of those
//! is what a stranded customer is reaching for. The cost of that
//! decision is that failures leave no trace at all -- and the failures
//! that matter here are precisely the ones nobody is watching, on a
//! machine that has since been rebooted, by a customer who reports
//! "the VPN broke my internet" weeks later.
//!
//! `eprintln!` does not fill the gap. This process runs as a Windows
//! service, so its standard error goes nowhere at all; the messages
//! only ever existed for whoever ran the binary by hand.
//!
//! So every teardown failure is appended here instead, with the time,
//! what was being attempted, and what Windows said. It is the first
//! file to ask for when somebody says uninstalling did not fix it: it
//! answers whether the NRPT rule was removed, whether an orphaned
//! engine was still running, and whether the adapter went -- questions
//! that otherwise have to be guessed at.

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;

/// Where it lives, beside the engine logs the service already writes.
fn log_path() -> PathBuf {
    crate::config_dir().join("cleanup.log")
}

/// What the file is allowed to grow to before the current contents are
/// set aside.
///
/// A megabyte is far more than a healthy machine will ever write -- an
/// entry is a line, and a clean teardown writes none -- and small
/// enough to be pasted into a support conversation. One previous file
/// is kept rather than none, because the interesting entries are
/// usually the ones from before the customer started retrying.
const MAX_BYTES: u64 = 1024 * 1024;

/// Records a teardown step that did not do what it was asked.
///
/// `operation` is what was being attempted, in words a support
/// conversation can use ("clear the tunnel DNS rule"), and `detail` is
/// whatever Windows said about it.
///
/// Never fails, never blocks, never panics: this is called from paths
/// whose entire purpose is to keep going, and a logger that could
/// break one of them would be worse than no logger.
pub fn note(operation: &str, detail: &str) {
    // Still printed, so running the binary by hand shows the same
    // thing the file will hold.
    eprintln!("teardown: {operation}: {detail}");

    let mut line = String::new();
    let _ = writeln!(line, "{} | {operation} | {detail}", now());
    append(&line);
}

fn append(line: &str) {
    let path = log_path();
    // The directory exists in every normal install (the service creates
    // it at start, ACL'd to SYSTEM and Administrators -- see
    // security::create_protected_dir). Created here only so the
    // uninstall path, which may run when it does not, still records.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_if_large(&path);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Sets the current file aside once it is big enough, keeping exactly
/// one older copy.
///
/// Unbounded would be the easy choice and the wrong one: this writes
/// from the disconnect path, so a machine stuck in a loop -- an engine
/// that will not die, a registry key that will not delete -- is exactly
/// the machine that would grow it without limit, and it lives in
/// ProgramData where the customer will never see it doing so.
fn rotate_if_large(path: &std::path::Path) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if metadata.len() < MAX_BYTES {
        return;
    }
    let previous = path.with_extension("log.1");
    let _ = std::fs::remove_file(&previous);
    let _ = std::fs::rename(path, &previous);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap is the only part of this that can fail silently: a
    /// logger that never rotates looks identical to one that does
    /// until the machine it is on has been failing for a month.
    #[test]
    fn the_log_is_set_aside_once_it_reaches_its_cap() {
        let dir = std::env::temp_dir().join("neoxify-cleanup-log-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cleanup.log");
        let previous = dir.join("cleanup.log.1");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&previous);

        std::fs::write(&path, vec![b'x'; (MAX_BYTES - 1) as usize]).expect("should write");
        rotate_if_large(&path);
        assert!(
            !previous.exists(),
            "rotated a file that had not reached the cap"
        );

        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize]).expect("should write");
        rotate_if_large(&path);
        assert!(previous.exists(), "a full log was not set aside");
        assert!(!path.exists(), "the current log was not cleared");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Local time, because the reader is a person comparing this against
/// when their internet stopped working, not a machine correlating
/// across hosts.
fn now() -> String {
    // SAFETY: zeroed is a valid SYSTEMTIME, and GetLocalTime only
    // writes to it.
    let mut t: SYSTEMTIME = unsafe { std::mem::zeroed() };
    // SAFETY: `t` is a valid, writable SYSTEMTIME for the call.
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}
