//! Reaping what a previous life left behind.
//!
//! [`Engines::disconnect`](super::Engines::disconnect) can only undo
//! what it is still holding. A service that was killed rather than
//! stopped -- Task Manager, a crash, an installer that ran `taskkill`,
//! a machine that lost power -- comes back with `active` set to `None`
//! and no memory of the engine it started, while the machine still
//! carries every side effect: an xray.exe or openvpn.exe with no parent,
//! a firewall allowance for ports nothing listens on any more, and
//! routes pointing into an adapter that is not carrying anything.
//!
//! Those are the leftovers behind "I uninstalled it and my network was
//! still broken". None of them is undone by removing the application,
//! and none of them is visible to a customer looking for a cause.
//!
//! So this runs whenever nothing is tracked: at service start (which is
//! by definition the leftovers case -- no client has asked for anything
//! yet) and on any disconnect that finds nothing of its own to tear
//! down. Every step is best-effort and independently fallible: a
//! janitor that aborts halfway leaves exactly the state it exists to
//! remove, and one that refuses to let the service start would cost the
//! customer the ability to connect at all.

use std::path::Path;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

use crate::adapters;

use super::{openvpn, routing, xray};

/// The engines that are plain child processes of this service, and so
/// are the ones that can be orphaned by it dying.
///
/// wireguard.exe is deliberately absent: its tunnel is a Windows
/// service in its own right, which
/// [`wireguard::remove_tunnel_if_present`](super::wireguard::remove_tunnel_if_present)
/// already removes on this same path. IKEv2 has no process at all.
const ORPHANABLE: [&str; 2] = ["xray.exe", "openvpn.exe"];

/// Undoes what a service that never got to run its teardown left on the
/// machine.
///
/// `exe_dir` is this service's own directory, which is where the
/// engines it starts live -- and the only thing that makes killing by
/// image name safe.
pub(super) fn reconcile(exe_dir: &Path) {
    kill_orphaned_engines(exe_dir);
    crate::split_tunnel::firewall::delete_rule();
    purge_adapter_routes();
}

/// What one sweep for orphaned engines found.
///
/// The counts exist for `repair`, which has to tell a customer what was
/// wrong rather than only fixing it silently. The reconcile path above
/// ignores this and behaves exactly as it did.
#[derive(Default)]
pub(super) struct Reaped {
    /// Image paths of processes that were ours and are now ended.
    pub ended: Vec<String>,
    /// Ours, still running, and why they could not be stopped.
    pub stuck: Vec<String>,
}

/// Kills engine processes that came from our installation and have
/// nobody left to stop them.
///
/// **Matched on the full image path, never on the name alone.** xray.exe
/// is a widely shipped binary and openvpn.exe is the official OpenVPN
/// client's own executable: a customer may perfectly well be running
/// either for something that has nothing to do with this product, and
/// killing it would be this service reaching outside itself to break
/// somebody else's software. Only a process running the exact file we
/// installed is ours to end.
pub(super) fn kill_orphaned_engines(exe_dir: &Path) -> Reaped {
    let mut reaped = Reaped::default();
    // Compared lowercased, because Windows paths are case-insensitive
    // and a process reports whatever casing it was started with.
    let mut ours = exe_dir.to_string_lossy().to_lowercase();
    if !ours.ends_with('\\') {
        ours.push('\\');
    }

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        crate::cleanup_log::note("reap orphaned engines", "could not enumerate processes");
        // Not "nothing was found": the question could not be asked. The
        // repair path reports that as unknown rather than as clean.
        reaped.stuck.push("could not enumerate processes".to_string());
        return reaped;
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set, and
    // setting it is what the API uses to version the struct.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        // The cheap test first: the name comes with the snapshot, while
        // the path costs a handle per process.
        if has_orphanable_name(&entry) {
            match image_path(pid) {
                Some(path) if path.to_lowercase().starts_with(&ours) => {
                    if kill(pid, &path) {
                        reaped.ended.push(path);
                    } else {
                        reaped.stuck.push(format!("{path} (pid {pid})"));
                    }
                }
                // Either it is somebody else's engine, or it is a
                // process this service is not allowed to look at --
                // which is itself a reason to leave it alone.
                _ => {}
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };
    reaped
}

/// The same scan without the killing, for the diagnostics snapshot.
///
/// Reported as `name (pid N)` rather than as the full path: on a
/// per-user install that path contains the customer's account name, and
/// this text is written to be pasted into a support ticket.
pub(super) fn list_orphaned_engines(exe_dir: &Path) -> Vec<String> {
    let mut ours = exe_dir.to_string_lossy().to_lowercase();
    if !ours.ends_with('\\') {
        ours.push('\\');
    }

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return Vec::new();
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    let mut found = Vec::new();
    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if has_orphanable_name(&entry) {
            if let Some(path) = image_path(pid) {
                if path.to_lowercase().starts_with(&ours) {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "engine".to_string());
                    found.push(format!("{name} (pid {pid})"));
                }
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };
    found
}

fn has_orphanable_name(entry: &PROCESSENTRY32W) -> bool {
    let end = entry
        .szExeFile
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(entry.szExeFile.len());
    let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
    ORPHANABLE.contains(&name.as_str())
}

fn image_path(pid: u32) -> Option<String> {
    // SAFETY: a plain call; a failure returns a null handle.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut buffer = [0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer is valid for `len` wide characters and the API
    // writes at most that many, updating `len` with what it wrote.
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
    // SAFETY: `process` came from OpenProcess and is not used again.
    unsafe { CloseHandle(process) };
    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

/// Ends one process, reporting whether it actually went.
fn kill(pid: u32, path: &str) -> bool {
    // SAFETY: a plain call; a failure returns a null handle.
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        crate::cleanup_log::note(
            "reap orphaned engines",
            &format!("could not open {path} (pid {pid}) to end it"),
        );
        return false;
    }
    // SAFETY: the handle came from OpenProcess with PROCESS_TERMINATE.
    let ok = unsafe { TerminateProcess(process, 1) };
    // SAFETY: `process` came from OpenProcess and is not used again.
    unsafe { CloseHandle(process) };
    if ok == 0 {
        crate::cleanup_log::note("reap orphaned engines", &format!("could not end {path} (pid {pid})"));
        false
    } else {
        // A success worth recording: an orphan being here at all means
        // a previous life ended without running its teardown, which is
        // the fact that explains everything else in the file.
        crate::cleanup_log::note("reap orphaned engines", &format!("ended {path} (pid {pid})"));
        true
    }
}

/// Our adapters, and the names this product gives them.
///
/// One list rather than two literals repeated at every call site --
/// `repair` and the diagnostics snapshot both need exactly the set the
/// route purge below already walks.
pub(super) const OUR_ADAPTERS: [&str; 2] = [xray::ADAPTER_NAME, openvpn::ADAPTER_NAME];

/// Removes IPv4 routes left on the adapters this product creates.
///
/// A route into an adapter whose engine is gone black-holes whatever it
/// matches, and the default route is exactly the kind that gets left:
/// Xray's routes are installed by this service rather than by the
/// engine, so a killed service never withdrew them. Windows keeps them
/// as long as the adapter exists -- and the OpenVPN adapter is
/// deliberately never deleted (see `openvpn::ensure_adapter`), so
/// "reboot and it clears" does not apply to it.
///
/// Asked of the adapter first, which is the common case's escape: on a
/// machine that has never run these engines there is no adapter, so
/// this costs one API call and spawns nothing.
pub(super) fn purge_adapter_routes() -> Purged {
    let mut purged = Purged::default();
    for name in OUR_ADAPTERS {
        match adapters::find_by_name(name) {
            Ok(Some(adapter)) => {
                // Counted before the purge, because afterwards there is
                // nothing left to count -- and "how many were there" is
                // the only thing that distinguishes a machine this fixed
                // from one that was already fine.
                let before = routing::interface_routes(adapter.index).len();
                routing::purge_interface(adapter.index);
                if before > 0 {
                    purged.removed.push(format!("{before} route(s) on {name}"));
                }
            }
            Ok(None) => {}
            Err(e) => {
                crate::cleanup_log::note(
                    "purge leftover routes",
                    &format!("could not look up the {name} adapter: {e}"),
                );
                purged.unknown.push(format!("could not look up the {name} adapter: {e}"));
            }
        }
    }
    purged
}

/// What one route purge did.
#[derive(Default)]
pub(super) struct Purged {
    pub removed: Vec<String>,
    /// Adapters that could not be looked up, which is not the same as
    /// adapters that were absent.
    pub unknown: Vec<String>,
}
