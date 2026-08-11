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
/// 256, `PWLEN` 256, `DNLEN` 15, each plus a terminator.
///
/// The struct ends at `dwIfIndex`, and that is not an oversight.
/// `ras.h` adds `szEncPassword` at `WINVER >= 0x0602`, which would make
/// this 2128 bytes -- and Windows 11 rejects 2128 outright with error
/// 632, "An incorrect structure size was detected". Measured, not
/// assumed: the 2128 version was built and dialled, and that is what
/// came back. 2120 is the size this API wants.
///
/// What the wrong size does *not* do is fail quietly, so the size is
/// not the thing to suspect when a dial misbehaves. See [`ras_dial`]
/// for the failure that actually bit here.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The size Windows actually accepts, established by asking it.
    ///
    /// Pinned as a literal rather than derived, because deriving it from
    /// the struct would make the test agree with whatever the struct
    /// happens to say. 2128 -- the layout including `szEncPassword` --
    /// was built and dialled on Windows 11 and came back as error 632,
    /// "An incorrect structure size was detected". 2120 is the one that
    /// dials.
    #[test]
    fn matches_the_layout_windows_accepts() {
        assert_eq!(std::mem::size_of::<RasDialParams>(), 2120);
    }

    #[test]
    fn default_reports_its_own_size() {
        assert_eq!(
            RasDialParams::default().dw_size as usize,
            std::mem::size_of::<RasDialParams>()
        );
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

/// `RASDIALEXTENSIONS`, needed only for one flag.
///
/// Passing null here is legal and was what this did first. It is also
/// how the service came to die: dialling with no extensions from
/// LocalSystem authenticated fine, brought the tunnel up -- RasClient
/// logged "link established" -- and then faulted inside RASAPI32.dll
/// with 0xC0000005 before `RasDialW` ever returned. Nothing restarts
/// the service, so that one attempt left the client unable to connect
/// on *any* protocol until the machine was rebooted.
/// The trailing `fSkipPppAuth` and `RASDEVSPECIFICINFO` are guarded on
/// `WINVER >= 0x0601` in `ras.h` and are required: stopping after
/// `RasEapInfo` gives 48 bytes and Windows 11 refuses it with 632.
///
/// The nested structs below are declared as structs rather than
/// flattened into this one, and that distinction is the whole
/// difference between 64 bytes and 72. `RASDEVSPECIFICINFO` has 8-byte
/// alignment of its own, so in C it begins at offset 56; flattening its
/// two members inline lets Rust place the leading `u32` at 52, which
/// both shortens the struct and shifts every field after it. Windows
/// reported that as the same generic 632 -- correct, and no help at all
/// in locating it. Printing `size_of` was what found it.
#[repr(C)]
pub struct RasEapInfo {
    pub size_of_eap_info: u32,
    pub eap_info: *mut u8,
}

#[repr(C)]
pub struct RasDevSpecificInfo {
    pub size: u32,
    pub dev_specific_info: *mut u8,
}

#[repr(C)]
pub struct RasDialExtensions {
    pub dw_size: u32,
    pub dwf_options: u32,
    pub hwnd_parent: *mut c_void,
    pub reserved: usize,
    pub reserved1: usize,
    pub eap_info: RasEapInfo,
    /// `BOOL`, so 4 bytes rather than Rust's 1-byte bool.
    pub skip_ppp_auth: i32,
    pub dev_specific: RasDevSpecificInfo,
}

/// `RDEOPT_NoUser`: dial on behalf of someone who is not logged on.
///
/// This is the flag a service is supposed to set. Without it RAS treats
/// the dial as belonging to an interactive user and goes looking for a
/// session that does not exist in session 0.
pub const RDEOPT_NO_USER: u32 = 0x0000_0010;

impl Default for RasDialExtensions {
    fn default() -> Self {
        Self {
            dw_size: std::mem::size_of::<Self>() as u32,
            dwf_options: RDEOPT_NO_USER,
            hwnd_parent: std::ptr::null_mut(),
            reserved: 0,
            reserved1: 0,
            eap_info: RasEapInfo { size_of_eap_info: 0, eap_info: std::ptr::null_mut() },
            skip_ppp_auth: 0,
            dev_specific: RasDevSpecificInfo { size: 0, dev_specific_info: std::ptr::null_mut() },
        }
    }
}

#[link(name = "rasapi32")]
extern "system" {
    /// The notifier is null, which makes the call synchronous: it
    /// returns only when the tunnel is up or has failed, which is what
    /// makes a failed connect observable here rather than something the
    /// app discovers later.
    ///
    /// The extensions are *not* null -- see [`RasDialExtensions`].
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

#[cfg(test)]
mod layout {
    use super::*;

    /// 72, and the nested structs are why.
    ///
    /// Flattening `RASDEVSPECIFICINFO` into the parent gives 64 and a
    /// shifted layout, which Windows rejects with the same generic 632
    /// as every other size mistake. Asserting the number here turns
    /// that into a compile-time-ish check instead of a VM round trip.
    #[test]
    fn extensions_match_the_c_layout() {
        assert_eq!(std::mem::size_of::<RasDialExtensions>(), 72);
    }

    #[test]
    fn extensions_default_reports_its_own_size() {
        assert_eq!(
            RasDialExtensions::default().dw_size as usize,
            std::mem::size_of::<RasDialExtensions>()
        );
    }
}
