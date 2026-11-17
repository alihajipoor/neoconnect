//! The helper's log: standard error, which the journal keeps, and the last
//! lines in memory for the Support screen's diagnostics.
//!
//! Every line is the helper's own wording. Nothing a request carries --
//! a key, a password, a UUID, a server's address -- is ever written into
//! one, and a path under a home directory is never written in full; that
//! rule is kept where each line is written, so this only keeps them.

use std::collections::VecDeque;
use std::sync::Mutex;

/// How many lines Diagnostics carries.
pub const KEPT: usize = 40;

static RECENT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Writes one line to standard error and keeps it.
pub fn line(text: String) {
    eprintln!("{text}");
    let kept = text.strip_prefix("neoxify-helper: ").unwrap_or(&text).to_string();
    let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    if recent.len() == KEPT {
        recent.pop_front();
    }
    recent.push_back(kept);
}

/// The last [`KEPT`] lines, oldest first.
pub fn recent() -> Vec<String> {
    RECENT.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

/// `eprintln!`, kept for Diagnostics.
#[macro_export]
macro_rules! say {
    ($($arg:tt)*) => {
        $crate::log::line(format!($($arg)*))
    };
}
