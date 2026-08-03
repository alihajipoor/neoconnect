//! A small safe surface over the WinDivert C API.
//!
//! Only the four calls Custom mode actually makes are wrapped -- open,
//! recv, send, shutdown -- because a fuller binding would be code with
//! no caller, and because the interesting behaviour here is not the
//! signatures but two traps the raw API sets:
//!
//! * **`WinDivertRecv` blocks indefinitely** when nothing matches the
//!   filter. A stop flag checked between receives therefore never fires,
//!   which is exactly how an earlier experiment hung for ten minutes.
//!   Stopping requires `WinDivertShutdown` from another thread, so the
//!   handle is `Sync` and [`Handle::shutdown`] is callable while a
//!   receive is in flight.
//! * **Close must happen once, after every user is done.** The handle is
//!   shared across the receive threads, so closing is tied to dropping
//!   the last `Arc` rather than to any one thread finishing.

use std::ffi::CString;
use std::io;

use windivert_sys::address::WINDIVERT_ADDRESS;
use windivert_sys::{
    ChecksumFlags, WinDivertClose, WinDivertFlags, WinDivertHelperCalcChecksums,
    WinDivertHelperCompileFilter, WinDivertLayer, WinDivertOpen, WinDivertParam, WinDivertRecv,
    WinDivertSend, WinDivertSetParam, WinDivertShutdown, WinDivertShutdownMode,
};
use windows::Win32::Foundation::HANDLE;

/// Windows' ERROR_NO_DATA, which is what a receive returns once the
/// handle has been shut down and its queue drained. It is the normal end
/// of the loop, not a failure.
const ERROR_NO_DATA: i32 = 232;

pub struct Handle(HANDLE);

// SAFETY: WinDivert handles are documented as thread-safe -- concurrent
// recv/send from several threads is the supported way to keep up with a
// busy interface, and shutdown is specifically designed to be called
// while another thread is blocked in recv.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    /// Opens a handle, installing the driver on first use.
    ///
    /// The queue is sized well above the default because this sits on
    /// the path of *all* outbound traffic while Custom mode is on (see
    /// `nat.rs` for why the filter cannot be narrowed to the selected
    /// app). An overflowing queue drops packets silently, which would
    /// look to the customer like an unreliable connection rather than
    /// like a setting they turned on.
    pub fn open(filter: &str, layer: WinDivertLayer, flags: WinDivertFlags) -> io::Result<Self> {
        let c_filter = CString::new(filter)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "filter contains a NUL"))?;

        // SAFETY: the filter is a valid NUL-terminated C string for the
        // duration of the call; the other arguments are plain values.
        let handle = unsafe { WinDivertOpen(c_filter.as_ptr(), layer, 0, flags) };
        if handle.is_invalid() {
            return Err(io::Error::last_os_error());
        }

        let handle = Self(handle);
        handle.set_param(WinDivertParam::QueueLength, 16384);
        handle.set_param(WinDivertParam::QueueSize, 33_554_432);
        handle.set_param(WinDivertParam::QueueTime, 4000);
        Ok(handle)
    }

    /// Best-effort tuning. A driver that refuses a parameter still works
    /// at its default, so a failure here is not worth failing the whole
    /// feature over.
    fn set_param(&self, param: WinDivertParam, value: u64) {
        // SAFETY: self.0 is a live handle; the parameter is a plain value.
        unsafe { WinDivertSetParam(self.0, param, value) };
    }

    /// Blocks until a packet matches, the handle is shut down, or the
    /// driver reports an error.
    ///
    /// `Ok(None)` means "shut down cleanly, stop looping" -- distinct
    /// from an error, because it is the expected outcome of a normal
    /// disconnect and must not be logged or surfaced as a fault.
    pub fn recv(&self, buffer: &mut [u8]) -> io::Result<Option<(u32, WINDIVERT_ADDRESS)>> {
        let mut len: u32 = 0;
        let mut addr = WINDIVERT_ADDRESS::default();

        // SAFETY: the buffer is valid for `buffer.len()` bytes and the
        // API writes at most that many; `len` and `addr` are owned here.
        let ok = unsafe {
            WinDivertRecv(
                self.0,
                buffer.as_mut_ptr() as *mut _,
                buffer.len() as u32,
                &mut len,
                &mut addr,
            )
        };

        if ok.as_bool() {
            return Ok(Some((len, addr)));
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_NO_DATA) {
            return Ok(None);
        }
        Err(err)
    }

    /// Injects a packet. Returns whether the driver accepted it.
    ///
    /// Acceptance is not delivery: an earlier design had every packet
    /// accepted and none of them arrive, because the stack routed them
    /// by its own table and ignored the interface this asked for. So a
    /// `true` here is worth no more than "it was not rejected".
    pub fn send(&self, packet: &[u8], len: u32, addr: &WINDIVERT_ADDRESS) -> bool {
        let mut sent: u32 = 0;
        // SAFETY: `packet` is valid for `len` bytes (checked by the
        // caller against what recv reported) and `addr` is owned by it.
        unsafe { WinDivertSend(self.0, packet.as_ptr() as *const _, len, &mut sent, addr).as_bool() }
    }

    /// Unblocks every thread sitting in [`Handle::recv`].
    pub fn shutdown(&self) {
        // SAFETY: documented as callable concurrently with recv, which
        // is the entire reason it exists.
        unsafe { WinDivertShutdown(self.0, WinDivertShutdownMode::Both) };
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is live and, because dropping consumes the
        // last owner, no thread can still be using it.
        unsafe { WinDivertClose(self.0) };
    }
}

/// Checks a filter expression without opening a handle or touching the
/// driver.
///
/// Worth having on its own because a filter string is otherwise only
/// validated when WinDivert parses it: a typo would surface as Custom
/// mode refusing to start on a customer's machine, where nobody can see
/// why. This makes it a test failure instead.
pub fn compile_filter(filter: &str) -> Result<(), String> {
    let c_filter =
        CString::new(filter).map_err(|_| "the filter contains a NUL byte".to_string())?;
    let mut object = [0u8; 8192];
    let mut error: *const std::os::raw::c_char = std::ptr::null();
    let mut position: u32 = 0;

    // SAFETY: the filter is a valid C string for the call, and the
    // output buffer is passed with its real length.
    let ok = unsafe {
        WinDivertHelperCompileFilter(
            c_filter.as_ptr(),
            WinDivertLayer::Network,
            object.as_mut_ptr() as *mut _,
            object.len() as u32,
            &mut error,
            &mut position,
        )
    };
    if ok.as_bool() {
        return Ok(());
    }

    let detail = if error.is_null() {
        "rejected".to_string()
    } else {
        // SAFETY: on failure WinDivert points this at a static
        // NUL-terminated message of its own.
        unsafe { std::ffi::CStr::from_ptr(error) }.to_string_lossy().into_owned()
    };
    Err(format!("{detail} at position {position}"))
}

/// Recomputes the IP and transport checksums after a rewrite.
///
/// Mandatory, not hygiene: a rewritten address changes the pseudo-header
/// the transport checksum covers, so an uncorrected packet is discarded
/// by the receiving stack without a word.
pub fn recalculate_checksums(packet: &mut [u8], len: u32, addr: &mut WINDIVERT_ADDRESS) {
    // SAFETY: `packet` is valid for `len` bytes; the helper only reads
    // and writes within it and within `addr`.
    unsafe {
        WinDivertHelperCalcChecksums(packet.as_mut_ptr() as *mut _, len, addr, ChecksumFlags::new())
    };
}
