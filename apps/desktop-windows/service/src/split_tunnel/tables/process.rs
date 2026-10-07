//! Which processes are running which executable.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// The processes running right now whose image is one of `images`,
/// as `(image path, pid)` pairs.
///
/// Deliberately not [`crate::split_tunnel::picker::running_apps`], which groups by product, builds a
/// display name and extracts an icon for every user application on the
/// machine. The caller here has a handful of paths and one question
/// about each of them, and asks it on a path that holds the `Engines`
/// lock.
///
/// Matched the way `policy::Selection::matches` matches -- the whole path,
/// lowercased -- so an answer from here cannot disagree with the answer
/// the redirect loop would give about the same process.
pub fn pids_running_images(images: &[String]) -> Vec<(String, u32)> {
    if images.is_empty() {
        return Vec::new();
    }
    let wanted: Vec<String> = images.iter().map(|i| i.to_lowercase()).collect();
    let mut found = Vec::new();

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return found;
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if let Some(path) = image_path(pid) {
            let lowered = path.to_lowercase();
            if wanted.iter().any(|w| *w == lowered) {
                found.push((lowered, pid));
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };

    found
}

/// Which of `pids` are still running the image they were recorded
/// against.
///
/// The pid is checked *with* its image rather than on its own, because
/// Windows reuses pids. A game that exits and a background service that
/// starts a moment later can carry the same number, and treating that as
/// "the game is still running" would leave a warning on screen that the
/// customer has already done everything they can about.
pub fn still_running(recorded: &[(String, u32)]) -> Vec<(String, u32)> {
    if recorded.is_empty() {
        return Vec::new();
    }
    let mut live = Vec::new();
    for (image, pid) in recorded {
        if let Some(path) = image_path(*pid) {
            if path.to_lowercase() == *image {
                live.push((image.clone(), *pid));
            }
        }
    }
    live
}

/// The full path of a running process's executable.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than the fuller access
/// right on purpose: it is the least this needs, and it is the one that
/// works against protected processes, which some anti-cheat-guarded
/// games are.
pub fn image_path(pid: u32) -> Option<String> {
    // SAFETY: a plain call; a failure returns a null handle.
    let process: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
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
