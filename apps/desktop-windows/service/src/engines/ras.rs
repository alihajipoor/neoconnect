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

    #[test]
    fn params_report_their_own_size() {
        assert_eq!(
            dial_params().dwSize as usize,
            std::mem::size_of::<RASDIALPARAMSW>()
        );
    }
}
