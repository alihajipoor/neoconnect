//! What a tunnel has carried, read from the adapter Windows counts it on.
//!
//! # Where the numbers come from
//!
//! Every engine's tunnel is an interface Windows keeps counters for: Xray's
//! and OpenVPN's Wintun adapters, WireGuard's own, and the RAS interface an
//! IKEv2 connection brings up. `GetIfEntry2` reads them -- `InOctets`, what
//! came out of the tunnel to this PC (download), and `OutOctets`, what this
//! PC sent into it (upload). Those are the bytes the customer's programs
//! sent and received through the tunnel, before the engine wraps them for
//! the wire; they are not an estimate, and nothing here makes one.
//!
//! # What is reported, and what is not
//!
//! Bytes since the session began, and bytes per second over the last
//! second or so -- measured between two readings the status poll took, not
//! smoothed and not guessed. Nothing at all when the adapter could not be
//! read: no session, an adapter not found, a busy service. A product that
//! shows "0 KB/s" for a tunnel it could not read is showing a number it
//! did not measure, which this one does not do.
//!
//! Not measured on a real tunnel yet: whether a RAS interface (IKEv2)
//! counts its traffic the way a Wintun adapter does is for the VM to show,
//! with a download of known size per engine.

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

/// One reading of an adapter's counters, in octets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters {
    /// `InOctets`: from the tunnel to this PC.
    pub rx: u64,
    /// `OutOctets`: from this PC into the tunnel.
    pub tx: u64,
}

/// A session's bytes and rates, from successive readings.
///
/// Counted from the session's first reading, and never backwards: an
/// adapter whose counters fall -- made again under a live engine, or a
/// different adapter answering -- carries what was counted so far and is
/// counted afresh from there. What passed between the last reading before
/// and the first after is lost, so a session can be under-counted, never
/// over-counted.
#[derive(Debug, Default)]
pub struct Meter {
    /// The reading the session's bytes are counted from.
    base: Option<Counters>,
    /// What was counted before the counters were last started afresh.
    carried: Counters,
    /// The last raw reading.
    last: Option<Counters>,
    /// Recent readings, oldest first: when, and the session's bytes then.
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

    /// The counters about to be read are another adapter's: what was
    /// counted is kept, and the next reading starts afresh.
    pub fn adapter_changed(&mut self) {
        if let (Some(last), Some(base)) = (self.last, self.base) {
            self.carry_over(last, base);
        }
        self.base = None;
        self.last = None;
    }

    fn carry_over(&mut self, last: Counters, base: Counters) {
        self.carried.rx = self.carried.rx.saturating_add(last.rx.saturating_sub(base.rx));
        self.carried.tx = self.carried.tx.saturating_add(last.tx.saturating_sub(base.tx));
        // A rate across the change would compare two different counts.
        self.recent.clear();
    }
}

/// How an adapter's counters are read: the machine, except in tests.
pub trait TrafficOps: Send + Sync {
    /// The interface LUID of the adapter Windows shows by this name.
    fn luid(&self, adapter: &str) -> Option<u64>;
    /// Its counters now; `None` when it does not answer.
    fn counters(&self, luid: u64) -> Option<Counters>;
}

/// A session's traffic: the adapter it is read from, and its meter.
#[derive(Debug, Default)]
pub struct SessionTraffic {
    luid: Option<u64>,
    meter: Meter,
}

impl SessionTraffic {
    /// Reads the session's adapter now. Found by name the first time, and
    /// again whenever the one known stops answering; `None` when it cannot
    /// be read at all, which the status reports as nothing.
    pub fn read(&mut self, ops: &dyn TrafficOps, adapter: &str, at: Instant) -> Option<TunnelTraffic> {
        if let Some(counters) = self.luid.and_then(|luid| ops.counters(luid)) {
            return Some(self.meter.read(at, counters));
        }
        let luid = ops.luid(adapter)?;
        let counters = ops.counters(luid)?;
        if self.luid.is_some_and(|known| known != luid) {
            self.meter.adapter_changed();
        }
        self.luid = Some(luid);
        Some(self.meter.read(at, counters))
    }
}

/// The machine's adapters.
pub struct System;

impl TrafficOps for System {
    fn luid(&self, adapter: &str) -> Option<u64> {
        let found = crate::adapters::find_by_name(adapter).ok()??;
        luid_of_index(found.index)
    }

    fn counters(&self, luid: u64) -> Option<Counters> {
        if_counters(luid)
    }
}

/// Nothing to read: the tests that drive sessions without a tunnel, so a
/// stand-in's session never reports some real adapter's bytes.
pub struct NoAdapters;

impl TrafficOps for NoAdapters {
    fn luid(&self, _adapter: &str) -> Option<u64> {
        None
    }

    fn counters(&self, _luid: u64) -> Option<Counters> {
        None
    }
}

/// An interface's LUID from its index.
pub(super) fn luid_of_index(index: u32) -> Option<u64> {
    use windows_sys::Win32::NetworkManagement::IpHelper::ConvertInterfaceIndexToLuid;
    use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
    let mut luid = NET_LUID_LH { Value: 0 };
    // SAFETY: `luid` is a valid out-parameter for the call.
    let err = unsafe { ConvertInterfaceIndexToLuid(index, &mut luid) };
    // SAFETY: written by the call above when it succeeded.
    (err == 0).then(|| unsafe { luid.Value })
}

/// An interface's octet counters, by LUID, from `GetIfEntry2`.
pub fn if_counters(luid: u64) -> Option<Counters> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
    use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
    // SAFETY: MIB_IF_ROW2 is plain data, for which all zeros is a valid
    // value; the call reads the LUID set below and writes the rest.
    let mut row: MIB_IF_ROW2 = unsafe { std::mem::zeroed() };
    row.InterfaceLuid = NET_LUID_LH { Value: luid };
    // SAFETY: `row` is a valid, initialised MIB_IF_ROW2 for the call.
    let err = unsafe { GetIfEntry2(&mut row) };
    (err == 0).then_some(Counters { rx: row.InOctets, tx: row.OutOctets })
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

    /// Counted from the session's first reading -- an adapter kept between
    /// sessions (OpenVPN's) has counted earlier sessions' bytes -- and no
    /// rate from one reading alone.
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
    /// moments. A rate is measured over about a second regardless: from the
    /// newest reading at least a second old, never from the one a few
    /// milliseconds before.
    #[test]
    fn a_rate_is_measured_over_a_second_whatever_the_polling() {
        let start = Instant::now();
        let mut meter = Meter::default();
        meter.read(start, c(0, 0));
        meter.read(at(start, 300), c(300, 30));
        meter.read(at(start, 1_000), c(1_000, 100));
        let close_behind = meter.read(at(start, 1_020), c(1_020, 102));
        // The newest reading a second old is the first one.
        assert_eq!(close_behind.window_ms, Some(1_020));
        assert_eq!(close_behind.rx_per_sec, Some(1_000));
        let later = meter.read(at(start, 2_100), c(3_100, 310));
        // Now the reading at 1,020 ms is the newest one a second old.
        assert_eq!(later.window_ms, Some(1_080));
        assert_eq!(later.rx_per_sec, Some((3_100 - 1_020) * 1000 / 1_080));
    }

    /// Readings closer together than half a second give no rate yet; from
    /// half a second, the oldest one is used.
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

    /// Counters that fall -- an adapter made again under a live engine --
    /// keep what was counted and count on from the new reading: never a
    /// negative or wrapped number, never more than was measured.
    #[test]
    fn counters_that_fall_carry_on_from_what_was_counted() {
        let start = Instant::now();
        let mut meter = Meter::default();
        meter.read(start, c(1_000, 500));
        meter.read(at(start, 1_000), c(4_000, 900));
        let after_reset = meter.read(at(start, 2_000), c(100, 10));
        assert_eq!((after_reset.rx_bytes, after_reset.tx_bytes), (3_000, 400), "what was counted, nothing invented");
        assert_eq!(after_reset.rx_per_sec, None, "no rate across two different counts");
        let on = meter.read(at(start, 3_000), c(600, 60));
        assert_eq!((on.rx_bytes, on.tx_bytes), (3_500, 450));
        assert_eq!(on.rx_per_sec, Some(500));
    }

    /// Bytes never go down between readings of one session, whatever the
    /// counters do: a long, random walk of readings with resets in it.
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

    struct Scripted {
        luids: std::sync::Mutex<Vec<Option<u64>>>,
        counters: std::sync::Mutex<std::collections::HashMap<u64, Counters>>,
    }

    impl TrafficOps for Scripted {
        fn luid(&self, _adapter: &str) -> Option<u64> {
            let mut luids = self.luids.lock().unwrap();
            if luids.len() > 1 {
                luids.remove(0)
            } else {
                luids.first().copied().flatten()
            }
        }
        fn counters(&self, luid: u64) -> Option<Counters> {
            self.counters.lock().unwrap().get(&luid).copied()
        }
    }

    /// A session whose adapter cannot be found reports nothing -- not zero
    /// bytes -- and is found by name once it appears; one that stops
    /// answering is looked up again, and another adapter answering in its
    /// place is counted afresh rather than added in whole.
    #[test]
    fn an_adapter_not_found_is_nothing_and_another_one_is_counted_afresh() {
        let start = Instant::now();
        let ops = Scripted { luids: std::sync::Mutex::new(vec![None]), counters: Default::default() };
        let mut session = SessionTraffic::default();
        assert_eq!(session.read(&ops, "neoconnect0", start), None, "an adapter not found is not zero bytes");

        *ops.luids.lock().unwrap() = vec![Some(7)];
        ops.counters.lock().unwrap().insert(7, c(100, 10));
        assert_eq!(session.read(&ops, "neoconnect0", at(start, 1_000)).map(|t| t.rx_bytes), Some(0));
        ops.counters.lock().unwrap().insert(7, c(1_100, 110));
        assert_eq!(session.read(&ops, "neoconnect0", at(start, 2_000)).map(|t| t.rx_bytes), Some(1_000));

        // Gone, and another adapter by the same name, with counts of its own.
        ops.counters.lock().unwrap().remove(&7);
        *ops.luids.lock().unwrap() = vec![Some(9)];
        ops.counters.lock().unwrap().insert(9, c(50_000_000, 9_000_000));
        let swapped = session.read(&ops, "neoconnect0", at(start, 3_000)).expect("read");
        assert_eq!((swapped.rx_bytes, swapped.tx_bytes), (1_000, 100), "the new adapter's own history was added in");
        ops.counters.lock().unwrap().insert(9, c(50_000_500, 9_000_050));
        let on = session.read(&ops, "neoconnect0", at(start, 4_000)).expect("read");
        assert_eq!((on.rx_bytes, on.tx_bytes), (1_500, 150));
    }

    /// The real call, against this machine's own adapters: an adapter
    /// Windows lists answers `GetIfEntry2` by the LUID its index converts
    /// to, and a LUID no adapter has answers nothing rather than zeros.
    /// What it cannot show is that a tunnel's bytes are counted: that is
    /// the VM's download of known size.
    #[test]
    fn get_if_entry2_answers_for_a_real_adapter_and_not_for_none() {
        let listed = crate::adapters::list().expect("adapters");
        let luids: Vec<(String, u64)> =
            listed.iter().filter_map(|a| luid_of_index(a.index).map(|luid| (a.name.clone(), luid))).collect();
        let answered: Vec<&String> = luids.iter().filter(|(_, luid)| if_counters(*luid).is_some()).map(|(name, _)| name).collect();
        assert!(luids.is_empty() || !answered.is_empty(), "none of {luids:?} answered GetIfEntry2");
        assert_eq!(if_counters(0x7fff_ffff_ffff_fff1), None, "an adapter that does not exist read as something");
    }
}
