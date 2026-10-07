//! What a session writes to the split-tunnel log while it runs: the
//! counters every few seconds, and the escape audit riding the same
//! thread.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::split_tunnel::log_file::{append, trim_if_large};
use crate::split_tunnel::worker::sleep_unless_stopped;
use crate::split_tunnel::{flows, intercept, tables, SharedSelection};

/// How often the counters are written out.
///
/// Frequent enough to be useful within one test, rare enough that the
/// file stays readable over a long session.
const LOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// How often the escape audit walks the machine's connection tables.
///
/// Thirty seconds, which is a compromise between two costs that pull in
/// opposite directions. It is four table walks plus a process lookup per
/// unseen pid, so it is far too expensive to sit anywhere near the packet
/// path; and an escape is a connection a browser will happily keep alive
/// for minutes, so a sweep that arrives half a minute late still catches
/// it. The one thing it is deliberately *not* tuned for is catching an
/// escape quickly enough to do something about it -- nothing here does
/// anything about it. See `tables::escaped_connections`.
const AUDIT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// How many escaping connections are named in the log per sweep.
///
/// A cap rather than a truncation for its own sake: the failure this
/// audit is looking for is usually one browser holding a handful of
/// connections, and the pathological case -- `AllExcept` a moment after
/// activation, where every pre-existing connection on the machine
/// qualifies -- would otherwise write hundreds of lines into a log a
/// customer is expected to paste into a support message. The count above
/// them is the number that matters; the names are there to say which
/// program to look at.
const AUDIT_NAMES_PER_SWEEP: usize = 5;

/// Writes the redirect counters to disk periodically.
///
/// This exists because of how the spike went: three attempts were spent
/// on byte counters that turned out to measure elapsed time and adapter
/// chatter, and the question was settled in one run by a packet capture.
/// The same lesson applies to a feature nobody can capture on a
/// customer's machine -- four numbers written down beat any number of
/// guesses about which stage failed.
pub(super) struct Logger {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Logger {
    pub(super) fn start(
        path: PathBuf,
        stats: Arc<intercept::Stats>,
        header: String,
        mut audit: Audit,
    ) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                // Appended, not truncated. Truncating lost exactly the
                // session worth reading: when a protocol fails, the
                // ladder starts the next one immediately, and that
                // second session's header wiped the first. The customer
                // was then asked for a log that could only ever show
                // the attempt which worked.
                trim_if_large(&path);
                append(&path, &format!("--- {header}"));
                while sleep_unless_stopped(&stop, LOG_INTERVAL) {
                    // The audit rides this thread rather than bringing
                    // its own. It is periodic housekeeping on the same
                    // cadence order as the counters, it is torn down by
                    // the same stop flag, and a second thread would be a
                    // second thing to join on a Disconnect that
                    // customers have already reported as slow.
                    if audit.due() {
                        audit.run(&path, &stats);
                    }
                    append(&path, &stats.summary());
                }
                append(&path, &format!("stopped {}", stats.summary()));
            })
        };
        Self { stop, thread: Some(thread) }
    }

    pub(super) fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The periodic check for connections that got away.
///
/// Everything `intercept::Stats` counts is counted from inside the packet
/// loop, so all of it is blind to a connection the loop never saw -- and
/// a connection the loop never saw is exactly what a leak is. This walks
/// the machine's own connection tables instead and asks which of them
/// ought to be in the tunnel and is not. See
/// [`tables::escaped_connections`] for what qualifies and what is
/// deliberately excluded.
///
/// It changes nothing. No connection is closed, no packet is dropped and
/// no verdict is revised on the strength of what it finds: it writes a
/// count and a few names into the log. That restraint is on purpose --
/// the count has never been read against a packet capture, and this
/// project does not act on a number nobody has checked against the wire.
pub(super) struct Audit {
    pub(super) nat: Arc<flows::Nat>,
    pub(super) selection: SharedSelection,
    pub(super) own_images: Vec<String>,
    pub(super) node: Ipv4Addr,
    /// The relay's TCP and UDP ports, whose own connections are not
    /// escapes from the thing they are part of.
    pub(super) proxy_ports: (u16, u16),
    /// Escapes already named in the log, so a connection that lives for
    /// ten minutes is described once rather than twenty times.
    pub(super) named: std::collections::HashSet<(u16, std::net::IpAddr, u16)>,
    pub(super) last_run: Instant,
}

impl Audit {
    fn due(&self) -> bool {
        self.last_run.elapsed() >= AUDIT_INTERVAL
    }

    fn run(&mut self, path: &Path, stats: &intercept::Stats) {
        self.last_run = Instant::now();

        // Copied rather than held: what follows is four table walks and
        // a process lookup per unseen pid, and the redirect loop reads
        // this lock on every packet.
        let selection = self.selection.read().unwrap_or_else(|e| e.into_inner()).clone();
        let nat = self.nat.clone();
        let escapes = tables::escaped_connections(
            &selection,
            &self.own_images,
            self.node,
            self.proxy_ports,
            // `has_flow` rather than `lookup_flow`, because asking must
            // not renew the entry -- see `Nat::has_flow`.
            &|transport, port, destination, destination_port| {
                nat.has_flow(transport, port, destination, destination_port)
            },
        );

        stats
            .escaped
            .store(escapes.len() as u64, std::sync::atomic::Ordering::Relaxed);

        if escapes.is_empty() {
            // Nothing is out. Forget what was named, so a connection
            // that comes back later is reported again rather than being
            // silenced by a sweep it was absent from.
            self.named.clear();
            return;
        }

        append(
            path,
            &format!(
                "escape audit: {} established connection(s) outside the tunnel that should be inside",
                escapes.len()
            ),
        );

        let mut written = 0usize;
        for escape in &escapes {
            let key = (escape.local_port, escape.remote, escape.remote_port);
            if self.named.contains(&key) {
                continue;
            }
            if written >= AUDIT_NAMES_PER_SWEEP {
                append(path, "  ... and more, not listed");
                break;
            }
            append(
                path,
                &format!(
                    "  escape {} -> {}:{} (local port {})",
                    escape.image, escape.remote, escape.remote_port, escape.local_port
                ),
            );
            written += 1;
        }

        self.named = escapes
            .iter()
            .map(|e| (e.local_port, e.remote, e.remote_port))
            .collect();
    }
}
