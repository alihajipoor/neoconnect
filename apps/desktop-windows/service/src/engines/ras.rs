//! The RAS dial API.
//!
//! `rasdial.exe` cannot be used for this. It works for the older
//! password protocols, but an IKEv2 entry authenticates with EAP, and
//! for EAP entries rasdial refuses with error 703 -- "the connection
//! needs information from you, but the application does not allow user
//! interaction" -- no matter what is on its command line, and no matter
//! whether the credential has already been stored with
//! `RasSetCredentials`. Both were tried against the real node before
//! this module was written.
//!
//! `RasDialW` takes the username and password in its parameters and
//! dials without any of that, so the engine calls it directly.
//!
//! **The structures come from `windows-sys`, and hand-declaring them
//! again would be a mistake worth naming.** They were hand-declared
//! originally, on the reasoning that one function did not justify the
//! dependency -- which was already present anyway. That produced three
//! wrong layouts in a row and one memory-corrupting crash:
//!
//! * `RASDIALPARAMSW` is `#[repr(C, packed(4))]` and *does* contain
//!   `szEncPassword`. Packed to 4, that still totals 2120 bytes -- the
//!   same total as a naturally-aligned struct that stops at
//!   `dwIfIndex`. So the hand-written version passed the `dwSize` check
//!   by coincidence while placing `dwCallbackId` and `dwIfIndex` four
//!   bytes off and omitting the trailing pointer entirely. RAS read a
//!   pointer from the wrong offset, and the service died with
//!   0xC0000005 inside RASAPI32.dll one second after the tunnel came
//!   up. Nothing restarts it, so a single IKEv2 attempt left the
//!   customer unable to connect on any protocol until they rebooted.
//! * `RASDIALEXTENSIONS` is packed the same way, making it 60 bytes,
//!   not the 72 a naturally-aligned reading gives. Windows answered
//!   both wrong sizes with the same undifferentiated error 632.
//! * `RDEOPT_NoUser` is 512. The hand-written constant said 16, which
//!   is `RDEOPT_IgnoreSoftwareCompression` -- a different flag
//!   entirely, silently.
//!
//! Only the three function signatures are still declared here, because
//! `windows-sys` 0.59 ships the RAS types and constants but not these
//! entry points. Signatures are not where the danger was.

use std::ffi::c_void;

use windows_sys::Win32::NetworkManagement::Rras::{RASDIALEXTENSIONS, RASDIALPARAMSW};

/// A zeroed `RASDIALPARAMSW` with `dwSize` filled in.
///
/// The generated type has no `Default`, and it must not simply be
/// zeroed wholesale either: `dwSize` is what RAS validates the layout
/// against.
pub fn dial_params() -> RASDIALPARAMSW {
    // SAFETY: every field is a plain integer, fixed array or pointer,
    // for which an all-zero bit pattern is valid.
    let mut params: RASDIALPARAMSW = unsafe { std::mem::zeroed() };
    params.dwSize = std::mem::size_of::<RASDIALPARAMSW>() as u32;
    params
}

/// A zeroed `RASDIALEXTENSIONS` with `dwSize` filled in.
///
/// Unused while the dial passes null extensions, and kept because the
/// service context may yet need `RDEOPT_NoUser`. Constructing it
/// correctly is the point -- see the module note.
#[allow(dead_code)]
pub fn dial_extensions() -> RASDIALEXTENSIONS {
    // SAFETY: as above -- plain data throughout.
    let mut ext: RASDIALEXTENSIONS = unsafe { std::mem::zeroed() };
    ext.dwSize = std::mem::size_of::<RASDIALEXTENSIONS>() as u32;
    ext
}

/// Copies a string into one of the fixed fields, truncating rather than
/// overflowing.
///
/// Truncation cannot actually happen for our values -- the control plane
/// generates a 16-character username and a 43-character password, and
/// the validator caps the hostname at 253 -- but a buffer this size
/// written by hand deserves the check regardless of what is believed
/// about its inputs.
pub fn set_field(dst: &mut [u16], value: &str) {
    let encoded: Vec<u16> = value.encode_utf16().take(dst.len() - 1).collect();
    dst[..encoded.len()].copy_from_slice(&encoded);
    dst[encoded.len()] = 0;
}

#[link(name = "rasapi32")]
extern "system" {
    /// A null notifier makes the call synchronous: it returns only when
    /// the tunnel is up or has failed, which is what makes a failed
    /// connect observable here rather than something the app discovers
    /// later.
    #[link_name = "RasDialW"]
    pub fn ras_dial(
        extensions: *mut RASDIALEXTENSIONS,
        phonebook: *const u16,
        params: *mut RASDIALPARAMSW,
        notifier_type: u32,
        notifier: *const c_void,
        connection: *mut *mut c_void,
    ) -> u32;

    #[link_name = "RasHangUpW"]
    pub fn ras_hang_up(connection: *mut c_void) -> u32;

    /// Turns a RAS error number into Windows' own wording for it.
    ///
    /// Used for the codes we have nothing better to say about. The
    /// system's text is generic, but it is accurate and translated,
    /// which beats inventing a sentence per code.
    #[link_name = "RasGetErrorStringW"]
    pub fn ras_get_error_string(error: u32, buffer: *mut u16, buffer_size: u32) -> u32;
}

/// Windows' own description of a RAS error, if it has one.
pub fn error_text(code: u32) -> Option<String> {
    let mut buffer = [0u16; 512];
    // SAFETY: the buffer and its length are consistent, and the API
    // writes at most that many UTF-16 units including the terminator.
    let rc = unsafe { ras_get_error_string(code, buffer.as_mut_ptr(), buffer.len() as u32) };
    if rc != 0 {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sizes the packed layouts actually produce.
    ///
    /// Asserted so that swapping these types back for hand-written ones
    /// fails here rather than at a customer's machine. 2120 is the
    /// coincidence that made the original bug so quiet: a struct with
    /// the wrong field offsets and a missing trailing pointer added up
    /// to exactly the same total, so `dwSize` validation passed.
    #[test]
    fn the_packed_layouts_are_what_ras_expects() {
        assert_eq!(std::mem::size_of::<RASDIALPARAMSW>(), 2120);
        assert_eq!(std::mem::size_of::<RASDIALEXTENSIONS>(), 60);
    }

    /// Field offsets, not just the total.
    ///
    /// The total was never the problem -- it matched. Pinning
    /// `dwCallbackId` catches the natural-alignment mistake directly:
    /// packed to 4 it sits at 2100, and 8-byte alignment pushes it to
    /// 2104, which is what RAS was reading a pointer from.
    ///
    /// `offset_of!` rather than taking a reference, because a reference
    /// into a packed struct is refused by the compiler -- which is the
    /// same hazard this test exists to guard, caught one level up.
    #[test]
    fn dw_callback_id_sits_where_packing_puts_it() {
        assert_eq!(std::mem::offset_of!(RASDIALPARAMSW, dwCallbackId), 2100);
        assert_eq!(std::mem::offset_of!(RASDIALPARAMSW, dwIfIndex), 2108);
        assert_eq!(std::mem::offset_of!(RASDIALPARAMSW, szEncPassword), 2112);
    }

    /// The status structure RAS validates by `dwSize`: 608 bytes is the
    /// Windows 7 and later layout, with both tunnel endpoints and the
    /// substate. A different size is answered with an error rather than
    /// a status, which the status poll would read as "cannot tell".
    #[test]
    fn the_status_layout_is_the_one_ras_validates() {
        use windows_sys::Win32::NetworkManagement::Rras::RASCONNSTATUSW;
        assert_eq!(std::mem::size_of::<RASCONNSTATUSW>(), 608);
    }

    /// A handle RAS never issued must never read as a connected tunnel,
    /// and must not crash. Asked of the real API.
    ///
    /// Which of the other two answers comes back depends on the machine,
    /// and the first version of this test pinned the wrong thing: this
    /// development PC answers `ERROR_INVALID_HANDLE`, read as
    /// `Some(false)`, while the Windows Server CI runner answers some
    /// other code, read as `None` -- "could not ask", which the status
    /// poll answers by falling back to the cmdlet. Both are safe. Only
    /// `Some(true)` would be a lie, so that is what is asserted.
    #[test]
    fn a_handle_ras_never_issued_never_reads_as_connected() {
        let answer = connect_status(0x5EED_usize as *mut c_void);
        assert_ne!(answer, Some(true), "a handle RAS never issued was reported connected");
    }

    /// Watching a handle RAS never issued must neither crash nor put a
    /// drop on record. Asked of the real API, the way the test above
    /// asks for status.
    ///
    /// The generation is closed first, as every teardown of ours closes
    /// it before hanging up -- so whatever RAS answers about a handle it
    /// does not know (this PC says `ERROR_INVALID_HANDLE`, which reads as
    /// gone; a CI runner may say something else, which reads as unknown),
    /// the ledger must refuse it.
    #[test]
    fn a_watch_on_a_handle_ras_never_issued_is_harmless() {
        use crate::lifecycle::engine_watch::{watch, Gone, Ledger};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        let ledger = Arc::new(Ledger::new());
        let generation = ledger.begin("IKEV2");
        ledger.close(generation);

        let liveness = liveness_of(0x5EED_usize as *mut c_void).expect("an event can always be made");
        let recorded = Arc::new(AtomicBool::new(false));
        let (flag, ledger_for_watch) = (Arc::clone(&recorded), Arc::clone(&ledger));
        let guard = watch(
            generation,
            "test-ras",
            Box::new(liveness),
            Arc::new(move |g: Gone| {
                if ledger_for_watch.record(g.generation, g.detail, g.at) {
                    flag.store(true, Ordering::SeqCst);
                }
            }),
        )
        .expect("starting a watch");

        // Past one slice, so the status call has been made at least once.
        std::thread::sleep(Duration::from_millis(1_300));
        assert!(!recorded.load(Ordering::SeqCst), "a handle RAS never issued was recorded as a drop");
        assert!(ledger.ended_without_successor().is_none());

        let finished = guard.finished();
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !finished.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(finished.load(Ordering::Acquire), "the watch outlived its guard");
    }

    #[test]
    fn params_report_their_own_size() {
        assert_eq!(
            dial_params().dwSize as usize,
            std::mem::size_of::<RASDIALPARAMSW>()
        );
    }
}

/// A live RAS connection, hung up when it is dropped.
///
/// `RasDialW` hands back a handle to the connection it made, and the
/// service used to discard it on success and hang up later by running
/// `rasdial.exe <entry> /disconnect`. That cost a process launch on the
/// disconnect path, and a process launch is 4.4 to 6.5 seconds on the
/// machines this was measured on -- more than the whole budget a
/// customer is promised for a disconnect.
///
/// Keeping the handle makes the teardown one API call with no process,
/// no PowerShell and no wait. Hanging up in `Drop` rather than from a
/// method means it also happens on the paths nobody wrote: a cancelled
/// connect, an error return halfway through, a panic. Cleanup that lives
/// only at the end of a successful disconnect is the defect this whole
/// rewrite exists to remove.
///
/// Dropping does **not** remove the phonebook entry. That is deliberate:
/// hanging up is urgent and belongs in the fast half of a teardown,
/// while removing the entry is tidying and belongs in the slow half.
/// They are separated so the customer waits only for the first.
pub struct Connection(*mut c_void);

// SAFETY: an HRASCONN is a process-wide handle, not thread-affine --
// RasHangUpW is documented as callable from any thread, and the service
// dials on its engine thread while teardown may run from another.
unsafe impl Send for Connection {}

impl Connection {
    /// Takes ownership of a handle returned by `RasDialW`.
    ///
    /// Returns `None` for a null handle, which RAS can hand back even on
    /// a successful-looking call.
    pub fn from_raw(handle: *mut c_void) -> Option<Self> {
        if handle.is_null() {
            None
        } else {
            Some(Self(handle))
        }
    }

    /// Whether this connection is up, asked of RAS by its own handle.
    ///
    /// For the status poll, which the app makes continuously. While an
    /// IKEv2 tunnel was up, every poll asked by launching PowerShell for
    /// `Get-VpnConnection` -- 511ms on a warm CI runner, more on a
    /// customer's machine -- when the service was holding the handle
    /// that answers the same question in one call with no process.
    ///
    /// `Some(false)` when RAS says the connection is not connected, or
    /// no longer recognises the handle at all (`ERROR_INVALID_HANDLE`):
    /// both mean the tunnel is gone. `None` when the question could not
    /// be asked, which the caller must not read as either answer.
    pub fn is_connected(&self) -> Option<bool> {
        connect_status(self.0)
    }

    /// A watch on this connection ending, for the engine watch.
    ///
    /// RAS is asked to set an event of ours when the connection goes
    /// (`RasConnectionNotificationW` with `RASCN_Disconnection`), and the
    /// handle's own status is asked once a slice besides. The second is
    /// not redundant: nothing has yet observed the notification fire for
    /// a real IKEv2 drop on a real machine, and if it does not, the poll
    /// still notices within a second. A notification that could not be
    /// registered is the same case, so it is not an error here.
    ///
    /// The raw handle is copied into the watch, not shared: the session
    /// keeps the `Connection` and hangs it up. A watch that asks about it
    /// after that gets `ERROR_INVALID_HANDLE`, which reads as gone -- and
    /// is refused by the ledger, because the session closed its
    /// generation before hanging up.
    pub fn liveness(&self) -> std::io::Result<RasLiveness> {
        liveness_of(self.0)
    }

    /// Hangs up now, consuming the handle.
    ///
    /// Only needed where the result matters; otherwise let it drop.
    pub fn hang_up(self) -> u32 {
        let code = unsafe { ras_hang_up(self.0) };
        // Already hung up by this call, so the Drop below must not run.
        std::mem::forget(self);
        code
    }
}

/// `RasGetConnectStatusW` for one handle, read the way
/// [`Connection::is_connected`] documents. Free of `Connection` so a test
/// can ask about a handle RAS has never issued without that test owning
/// -- and on drop hanging up -- a handle it made up.
fn connect_status(handle: *mut c_void) -> Option<bool> {
    connect_state(handle).map(|(connected, _)| connected)
}

/// The same, with the error RAS gives for the connection's state -- the
/// reason a dropped connection dropped, when it has one.
fn connect_state(handle: *mut c_void) -> Option<(bool, u32)> {
    use windows_sys::Win32::NetworkManagement::Rras::{
        RasGetConnectStatusW, RASCONNSTATUSW, RASCS_Connected,
    };
    const ERROR_INVALID_HANDLE: u32 = 6;

    // SAFETY: every field is plain data, for which all-zero is valid;
    // `dwSize` is what RAS checks the layout against.
    let mut status: RASCONNSTATUSW = unsafe { std::mem::zeroed() };
    status.dwSize = std::mem::size_of::<RASCONNSTATUSW>() as u32;
    // SAFETY: `status` is a correctly sized, writable RASCONNSTATUSW.
    let rc = unsafe { RasGetConnectStatusW(handle as _, &mut status) };
    match rc {
        0 => Some((status.rasconnstate == RASCS_Connected, status.dwError)),
        ERROR_INVALID_HANDLE => Some((false, ERROR_INVALID_HANDLE)),
        _ => None,
    }
}

/// [`Connection::liveness`], for a raw handle -- free of `Connection` for
/// the same reason [`connect_status`] is.
fn liveness_of(handle: *mut c_void) -> std::io::Result<RasLiveness> {
    use windows_sys::Win32::NetworkManagement::Rras::{RasConnectionNotificationW, RASCN_Disconnection};
    let event = crate::lifecycle::engine_watch::new_event()?;
    // SAFETY: an open event of ours, and a handle RAS validates itself --
    // one it never issued is answered with an error, not dereferenced
    // (see `a_watch_on_a_handle_ras_never_issued_is_harmless`). RAS
    // takes its own reference to the event for the notification.
    let registered = unsafe { RasConnectionNotificationW(handle as _, event.raw(), RASCN_Disconnection) };
    if registered != 0 {
        // Not fatal: the watch still asks RAS once a slice. Logged so a
        // drop noticed a second late can be told apart from one the
        // notification missed.
        crate::cleanup_log::note(
            "ask RAS to report the IKEv2 tunnel dropping",
            &format!(
                "{}; the watch will ask once a second instead",
                error_text(registered).unwrap_or_else(|| format!("RAS error {registered}"))
            ),
        );
    }
    Ok(RasLiveness { event, connection: handle as usize })
}

/// An IKEv2 connection as a [`Liveness`]. See [`Connection::liveness`].
///
/// [`Liveness`]: crate::lifecycle::engine_watch::Liveness
pub struct RasLiveness {
    event: crate::lifecycle::engine_watch::OwnedHandle,
    /// The HRASCONN, as an integer so the watch can be sent to its
    /// thread. Only ever passed back to RAS, never dereferenced.
    connection: usize,
}

impl crate::lifecycle::engine_watch::Liveness for RasLiveness {
    fn look(&mut self) -> crate::lifecycle::engine_watch::Look {
        use crate::lifecycle::engine_watch::Look;
        let state = connect_state(self.connection as *mut c_void);
        let reason = |state: Option<(bool, u32)>| state.map(|(_, e)| i64::from(e)).filter(|e| *e != 0);
        if self.event.is_signalled() {
            return Look::Gone(reason(state));
        }
        match state {
            Some((false, _)) => Look::Gone(reason(state)),
            // Connected, or RAS could not be asked: neither is an ending.
            _ => Look::WaitOn(self.event.raw()),
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // SAFETY: the handle came from RasDialW, is non-null by
        // construction, and is hung up exactly once -- Connection is
        // neither Clone nor Copy, and `hang_up` forgets itself.
        unsafe {
            ras_hang_up(self.0);
        }
    }
}
