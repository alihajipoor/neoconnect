//! What a tunnel has carried, as bytes and rates for the status poll.
//!
//! The arithmetic is the Windows service's (`service/src/engines/
//! traffic.rs`), kept with its tests; only the source of the numbers
//! differs. Here they come from `Tunnel::counters`, the tunnel interface's
//! own counters -- the bytes the customer's programs sent and received
//! through the tunnel, not an estimate. Nothing at all is reported when
//! they could not be read: a product that shows "0 KB/s" for a tunnel it
//! could not read is showing a number it did not measure.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use neoconnect_ipc::TunnelTraffic;

/// A rate is measured from the newest reading at least this old.
pub const RATE_WINDOW: Duration = Duration::from_secs(1);

/// Short of a reading [`RATE_WINDOW`] old, the oldest one is used if it is
/// at least this old; younger than that, no rate is given. Half a second of
/// a bursty download is already a coarse number, and less is noise.
pub const SHORTEST_WINDOW: Duration = Duration::from_millis(500);

/// How long readings are kept for, to measure rates from.
const KEEP_FOR: Duration = Duration::from_secs(5);

/// One reading of an interface's counters, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters {
    /// From the tunnel to this machine.
    pub rx: u64,
    /// From this machine into the tunnel.
    pub tx: u64,
}

/// A session's bytes and rates, from successive readings.
///
/// Counted from the session's first reading, and never backwards: counters
/// that fall -- an interface made again under a live engine -- carry what
/// was counted so far and are counted afresh from there. A session can be
/// under-counted, never over-counted.
#[derive(Debug, Default)]
pub struct Meter {
    base: Option<Counters>,
    carried: Counters,
    last: Option<Counters>,
    recent: VecDeque<(Instant, Counters)>,
}

impl Meter {
    /// Takes a raw reading made at `at`, and says what the session has
    /// carried and how fast.
    pub fn read(&mut self, at: Instant, raw: Counters) -> TunnelTraffic {
        let mut base = *self.base.get_or_insert(raw);
        if let Some(last) = self.last {
            if raw.rx < last.rx || raw.tx < last.tx {
                self.carry_over(last, base);
                base = raw;
                self.base = Some(raw);
            }
        }
        self.last = Some(raw);
        let total = Counters {
            rx: self.carried.rx.saturating_add(raw.rx.saturating_sub(base.rx)),
            tx: self.carried.tx.saturating_add(raw.tx.saturating_sub(base.tx)),
        };
        let reference = self
            .recent
            .iter()
            .rev()
            .find(|(when, _)| at.saturating_duration_since(*when) >= RATE_WINDOW)
            .or_else(|| self.recent.front().filter(|(when, _)| at.saturating_duration_since(*when) >= SHORTEST_WINDOW))
            .copied();
        let rates = reference.map(|(when, then)| {
            let ms = u64::try_from(at.saturating_duration_since(when).as_millis()).unwrap_or(u64::MAX).max(1);
            let per_sec = |now: u64, then: u64| now.saturating_sub(then).saturating_mul(1000) / ms;
            (per_sec(total.rx, then.rx), per_sec(total.tx, then.tx), ms)
        });
        self.recent.push_back((at, total));
        while self.recent.front().is_some_and(|(when, _)| at.saturating_duration_since(*when) > KEEP_FOR) {
            self.recent.pop_front();
        }
        TunnelTraffic {
            rx_bytes: total.rx,
            tx_bytes: total.tx,
            rx_per_sec: rates.map(|(rx, _, _)| rx),
            tx_per_sec: rates.map(|(_, tx, _)| tx),
            window_ms: rates.map(|(_, _, ms)| ms),
        }
    }

    fn carry_over(&mut self, last: Counters, base: Counters) {
        self.carried.rx = self.carried.rx.saturating_add(last.rx.saturating_sub(base.rx));
        self.carried.tx = self.carried.tx.saturating_add(last.tx.saturating_sub(base.tx));
        // A rate across the change would compare two different counts.
        self.recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    fn c(rx: u64, tx: u64) -> Counters {
        Counters { rx, tx }
    }

    #[test]
    fn bytes_count_from_the_first_reading_and_one_reading_has_no_rate() {
        let start = Instant::now();
        let mut meter = Meter::default();
        let first = meter.read(start, c(5_000_000, 1_000_000));
        assert_eq!((first.rx_bytes, first.tx_bytes), (0, 0));
        assert_eq!((first.rx_per_sec, first.tx_per_sec, first.window_ms), (None, None, None));
        let second = meter.read(at(start, 1_000), c(5_200_000, 1_050_000));
        assert_eq!((second.rx_bytes, second.tx_bytes), (200_000, 50_000));
        assert_eq!((second.rx_per_sec, second.tx_per_sec, second.window_ms), (Some(200_000), Some(50_000), Some(1_000)));
    }

    /// Two pollers -- the app's screen and its heartbeat -- read at uneven
    /// moments. A rate is measured over about a second regardless.
    #[test]
    fn a_rate_is_measured_over_a_second_whatever_the_polling() {
        let start = Instant::now();
        let mut meter = Meter::default();
        meter.read(start, c(0, 0));
        meter.read(at(start, 300), c(300, 30));
        meter.read(at(start, 1_000), c(1_000, 100));
        let close_behind = meter.read(at(start, 1_020), c(1_020, 102));
        assert_eq!(close_behind.window_ms, Some(1_020));
        assert_eq!(close_behind.rx_per_sec, Some(1_000));
        let later = meter.read(at(start, 2_100), c(3_100, 310));
        assert_eq!(later.window_ms, Some(1_080));
        assert_eq!(later.rx_per_sec, Some((3_100 - 1_020) * 1000 / 1_080));
    }

    #[test]
    fn readings_too_close_together_give_no_rate() {
        let start = Instant::now();
        let mut meter = Meter::default();
        meter.read(start, c(0, 0));
        assert_eq!(meter.read(at(start, 200), c(100, 0)).rx_per_sec, None);
        assert_eq!(meter.read(at(start, 400), c(200, 0)).rx_per_sec, None);
        let half = meter.read(at(start, 600), c(600, 0));
        assert_eq!((half.rx_per_sec, half.window_ms), (Some(1_000), Some(600)));
    }

    #[test]
    fn counters_that_fall_carry_on_from_what_was_counted() {
        let start = Instant::now();
        let mut meter = Meter::default();
        meter.read(start, c(1_000, 500));
        meter.read(at(start, 1_000), c(4_000, 900));
        let after_reset = meter.read(at(start, 2_000), c(100, 10));
        assert_eq!((after_reset.rx_bytes, after_reset.tx_bytes), (3_000, 400));
        assert_eq!(after_reset.rx_per_sec, None, "no rate across two different counts");
        let on = meter.read(at(start, 3_000), c(600, 60));
        assert_eq!((on.rx_bytes, on.tx_bytes), (3_500, 450));
        assert_eq!(on.rx_per_sec, Some(500));
    }

    #[test]
    fn the_session_total_never_goes_down() {
        let start = Instant::now();
        let mut meter = Meter::default();
        let (mut rx, mut tx) = (10_000u64, 20_000u64);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut previous = (0, 0);
        for step in 0..2_000u64 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            if seed % 97 == 0 {
                rx = seed % 1_000;
                tx = seed % 777;
            } else {
                rx += seed % 5_000;
                tx += seed % 700;
            }
            let read = meter.read(at(start, step * 250), c(rx, tx));
            assert!(read.rx_bytes >= previous.0 && read.tx_bytes >= previous.1, "went down at step {step}");
            previous = (read.rx_bytes, read.tx_bytes);
        }
    }
}
