//! Windows security-descriptor helpers.
//!
//! Two things in this service need an explicit ACL rather than whatever
//! they would inherit:
//!
//! * the control pipe, because it is the one way to make a LocalSystem
//!   process act, and
//! * the directory the engine config files are written into, because
//!   those files contain the customer's private keys.
//!
//! Both are expressed as SDDL and converted once, which is far easier to
//! review than hand-assembling ACLs through the raw API.

use std::ffi::c_void;
use std::io;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{BOOL, LocalFree, ERROR_ALREADY_EXISTS, ERROR_SUCCESS};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

const SDDL_REVISION_1: u32 = 1;

/// Owns a security descriptor allocated by the Win32 allocator and frees
/// it on drop, so callers can't leak it or use it after free.
pub struct SecurityDescriptor {
    psd: PSECURITY_DESCRIPTOR,
}

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let wide: Vec<u16> = sddl.encode_utf16().chain(once(0)).collect();
        let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is a valid NUL-terminated UTF-16 string and
        // `psd` is a valid out-pointer. On success the callee allocates
        // a descriptor that this type frees in Drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { psd })
    }

    /// Builds a SECURITY_ATTRIBUTES borrowing this descriptor. The
    /// returned value must not outlive `self`, which the lifetime tie
    /// enforces.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.psd,
            bInheritHandle: 0,
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.psd.is_null() {
            // SAFETY: `psd` came from the Win32 allocator via
            // ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.psd as *mut c_void) };
        }
    }
}

/// The control pipe's ACL.
///
/// LocalSystem and Administrators get full control (they already
/// effectively do). Authenticated users get read+write only -- enough to
/// send a request and read the reply, and nothing else. Notably absent
/// is any grant to Anonymous or Everyone: an unauthenticated local
/// process must not be able to drive a SYSTEM service.
///
/// This is intentionally not a lockdown to a single user account. The
/// app runs as whichever interactive user launched it, and on a shared
/// machine that legitimately varies; the meaningful boundary is
/// "authenticated on this machine", with the protocol itself (which
/// carries no paths or commands -- see neoconnect_ipc) being what keeps
/// that grant safe.
pub const PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)";

/// The config directory's ACL: SYSTEM and Administrators only, and
/// `P` (protected) so it does not inherit the broader grants ProgramData
/// hands out by default. These files hold private keys, so a
/// non-administrative user on the same machine must not be able to read
/// another user's tunnel credentials.
const CONFIG_DIR_SDDL: &str = "D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)";

/// Creates the config directory, and enforces its ACL whether or not it
/// already existed.
///
/// Applying the ACL only at creation time was a real hole: a directory
/// left behind by an earlier install kept ProgramData's default grants,
/// under which any local user can read its contents. Since that is where
/// generated tunnel configs live -- WireGuard private keys, OpenVPN
/// client certificates -- anyone with a login could lift a customer's
/// credentials and connect with their own client. Found by inspection of
/// a real install, not theory.
///
/// So the permissions are re-asserted on every service start rather than
/// assumed from the moment of creation.
pub fn create_protected_dir(path: &Path) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(CONFIG_DIR_SDDL)?;
    let mut attrs = sd.attributes();
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    // SAFETY: `wide` is a valid NUL-terminated path and `attrs` borrows
    // a live descriptor owned by `sd`, which outlives this call.
    let ok = unsafe { CreateDirectoryW(wide.as_ptr(), &mut attrs) };
    if ok == 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
            return Err(err);
        }
    }

    apply_protected_dacl(path, &sd)
}

/// Replaces the directory's DACL with the one from `sd`, and marks it
/// protected so ProgramData's inheritable grants can't reappear.
fn apply_protected_dacl(path: &Path, sd: &SecurityDescriptor) -> io::Result<()> {
    let mut dacl_present: BOOL = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut dacl_defaulted: BOOL = 0;

    // SAFETY: `sd.psd` is a valid descriptor built from our own SDDL,
    // which always includes a DACL, and the out-params are valid.
    let ok = unsafe { GetSecurityDescriptorDacl(sd.psd, &mut dacl_present, &mut dacl, &mut dacl_defaulted) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    if dacl_present == 0 {
        return Err(io::Error::other("config directory ACL is missing a DACL"));
    }

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    // SAFETY: `wide` is a valid NUL-terminated path and `dacl` points
    // into the descriptor owned by `sd`, alive for this call.
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}
