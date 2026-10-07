//! The split-tunnel log: one file, beside the engines' own logs, that a
//! support conversation asks for. The session writes it and so does the
//! relay, so it belongs to neither.

use std::path::Path;

/// The log file's name, beside the engines' own logs in the protected
/// config directory.
pub(super) const LOG_FILE: &str = "split-tunnel.log";

/// Keeps the log from growing without bound across many attempts.
///
/// Reconnect churn writes a session header plus a line every ten
/// seconds, so a long troubleshooting evening adds up. A quarter of a
/// megabyte is far more history than any diagnosis needs and small
/// enough to paste.
pub(super) fn trim_if_large(path: &Path) {
    const LIMIT: u64 = 256 * 1024;
    if std::fs::metadata(path).map(|m| m.len() > LIMIT).unwrap_or(false) {
        let _ = std::fs::remove_file(path);
    }
}

/// Best-effort. A log line that cannot be written must never affect the
/// connection it is describing.
pub(super) fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}
