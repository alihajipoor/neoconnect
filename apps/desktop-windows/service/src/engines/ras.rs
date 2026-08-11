//! The RAS dial API, hand-declared.
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
//! dials without any of that, so the engine calls it directly. The
//! structures are declared here rather than taken from a crate because
//! the `windows` crate's `Networking::Ras` feature is not enabled in
//! this build and one function does not justify it.

use std::ffi::c_void;

/// `RASDIALPARAMSW`.
///
/// The fixed array lengths are the ones in `ras.h`: `RAS_MaxEntryName`
/// 256, `RAS_MaxPhoneNumber` 128, `RAS_MaxCallbackNumber` 128, `UNLEN`
/// 256, `PWLEN` 256, `DNLEN` 15, each plus a terminator. `dwSize` is
/// checked by the API against the layout it expects, so none of this is
/// free to drift: getting it wrong returns 632 rather than misbehaving
/// quietly, which is at least loud.
#[repr(C)]
pub struct RasDialParams {
    pub dw_size: u32,
    pub entry_name: [u16; 257],
    pub phone_number: [u16; 129],
    pub callback_number: [u16; 129],
    pub user_name: [u16; 257],
    pub password: [u16; 257],
    pub domain: [u16; 16],
    pub sub_entry: u32,
    pub callback_id: usize,
    pub if_index: u32,
}

impl Default for RasDialParams {
    fn default() -> Self {
        Self {
            dw_size: std::mem::size_of::<Self>() as u32,
            entry_name: [0; 257],
            phone_number: [0; 129],
            callback_number: [0; 129],
            user_name: [0; 257],
            password: [0; 257],
            domain: [0; 16],
            sub_entry: 0,
            callback_id: 0,
            if_index: 0,
        }
    }
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
    /// Extensions and the notifier are null: the defaults are what we
    /// want, and a null notifier makes the call synchronous, which is
    /// the whole reason to prefer it over the alternatives. It returns
    /// only when the tunnel is up or has failed.
    #[link_name = "RasDialW"]
    pub fn ras_dial(
        extensions: *const c_void,
        phonebook: *const u16,
        params: *mut RasDialParams,
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
