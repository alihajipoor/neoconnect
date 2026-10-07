//! The activation reset's second half: closing a selected app's
//! pre-existing connections as they become closeable, for the first
//! seconds of a session.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::split_tunnel::worker::{sleep_unless_stopped, Worker};
use crate::split_tunnel::{flows, intercept, tables, SharedSelection};

use crate::split_tunnel::log_file::append;

/// How often the activation reset rescans while it converges.
///
/// Chosen against what it is chasing rather than for its own sake. The
/// rows it is waiting for are connections in `SYN_SENT`, which reach
/// ESTABLISHED as soon as the far end answers -- a few tens of
/// milliseconds on a local path, a few hundred on the sort of long,
/// lossy route this product's customers are on. A quarter of a second is
/// short enough that such a connection is closed before an application
/// has sent anything down it, and long enough that the whole window
/// costs a dozen table walks rather than hundreds.
const RESET_RESCAN: std::time::Duration = std::time::Duration::from_millis(250);

/// Keeps closing a selected app's pre-existing connections for the first
/// seconds of a session.
///
/// One pass at activation is not enough, and the reason is a real
/// limitation rather than an oversight: `SetTcpEntry` can only tear down
/// a connection that has reached ESTABLISHED. A connection that is in
/// `SYN_SENT` at the instant Custom mode starts survives the pass,
/// completes against the real destination a moment later, and lives
/// outside the tunnel for as long as the application keeps it. That is
/// issue 9 in the handover, and for a browser -- which keeps sockets
/// alive and reuses them -- it is the difference between Custom mode
/// applying and appearing not to.
///
/// So the pass becomes a loop: rescan every [`RESET_RESCAN`] for
/// [`intercept::ACTIVATION_GRACE`], closing rows as they arrive in a state
/// that can be closed. The two durations are the same one on purpose --
/// while this is running, the redirect loop refuses those connections
/// rather than exempting them, and a refusal that outlived the thing
/// arranging a replacement would just be an outage.
///
/// On its own thread, so `connect()` returns no later than it did
/// before. The first pass still runs inline, which is what keeps the
/// existing behaviour and the existing log line intact; this only adds
/// the ones that were not closeable yet.
///
/// Stopped by being dropped, which joins its thread.
pub(in crate::split_tunnel) struct Convergence {
    _worker: Worker,
}

impl Convergence {
    pub(super) fn start(
        selection: SharedSelection,
        path: PathBuf,
        node: Ipv4Addr,
        own_images: Vec<String>,
        nat: Arc<flows::Nat>,
        closed_already: usize,
    ) -> Self {
        let worker = Worker::spawn(move |stop| {
            let deadline = Instant::now() + intercept::ACTIVATION_GRACE;
            let mut closed = closed_already;
            let mut passes = 0usize;
            // Overwritten by each pass, so it holds the LAST pass's
            // figure -- earlier passes seeing half-open rows is the
            // rescan working, not a fault.
            let mut still_handshaking = 0usize;

            while Instant::now() < deadline {
                // Interruptible, because Custom mode can be stopped
                // inside this window -- a failover does exactly that
                // -- and closing a customer's connections on behalf
                // of a session that no longer exists is pure harm.
                if !sleep_unless_stopped(&stop, RESET_RESCAN) {
                    return;
                }
                let selection =
                    selection.read().unwrap_or_else(|e| e.into_inner()).clone();
                // Skipping whatever the redirect is already
                // carrying. By the second pass an application has
                // rebuilt its connections into the tunnel, and
                // without this the loop closes them again -- see
                // `tables::reset_selected_connections`. `has_flow`,
                // not `lookup_flow`, so asking twice a second does
                // not keep every entry alive.
                let outcome = tables::reset_selected_connections(
                    &selection,
                    node,
                    &own_images,
                    &|transport, port, destination, destination_port| {
                        nat.has_flow(transport, port, destination, destination_port)
                    },
                );
                closed += outcome.closed;
                still_handshaking = outcome.skipped_handshaking;
                passes += 1;
                for failure in outcome.failures {
                    append(&path, &format!("  reset: {failure}"));
                }
            }

            append(
                &path,
                &format!(
                    "activation reset settled after {passes} rescan(s): {closed} connection(s) closed in total"
                ),
            );
            if still_handshaking > 0 {
                // The open item from 2026-08-22, observed rather than
                // reasoned about: these finished their handshake
                // outside the tunnel and the window closed first.
                append(
                    &path,
                    &format!(
                        "  reset: {still_handshaking} connection(s) were still mid-handshake when the window closed -- they completed outside the tunnel"
                    ),
                );
            }
        });
        Self { _worker: worker }
    }
}
