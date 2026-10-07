//! The background threads Custom mode runs, and how they are stopped.
//!
//! Every one of them is joined on the way down, so a wait inside one is
//! a wait inside a disconnect. This is the wait they share.

/// Waits, unless asked to stop first. Returns whether the wait ran to
/// completion rather than being cut short.
///
/// A plain `sleep` is what made Disconnect appear to hang. Both the
/// logger and the flow-expiry thread are joined during teardown, so a
/// ten-second sleep between log lines meant up to ten seconds of the app
/// sitting on "Disconnecting..." with the tunnel already gone --
/// reported as exactly that. Waiting in short steps costs nothing and
/// bounds the delay at one step.
///
/// The step was 200ms, and one step is what each joined thread costs a
/// stop -- the flow-expiry thread was measured at 150ms of a 150ms
/// `Relays::stop`, and `SplitTunnel::stop` joins four users of this one
/// after another inside phase one's 900ms. Twenty milliseconds is fifty
/// wake-ups a second per thread, each a load and a comparison, against
/// a tenth of the wait on every join.
pub(super) fn sleep_unless_stopped(
    stop: &std::sync::atomic::AtomicBool,
    total: std::time::Duration,
) -> bool {
    const STEP: std::time::Duration = std::time::Duration::from_millis(20);
    let deadline = std::time::Instant::now() + total;
    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return true;
        }
        std::thread::sleep(STEP.min(deadline - now));
    }
}
