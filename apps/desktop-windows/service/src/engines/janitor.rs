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

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

use crate::adapters;

use super::route_table::{OwedRoutes, Replayed, RouteOps};
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
/// image name safe. `owed` is the ledger of host routes this service put
/// on adapters that are not its own; see [`settle_owed_routes`].
pub(super) fn reconcile(exe_dir: &Path, owed: &OwedRoutes, ops: &dyn RouteOps) {
    kill_orphaned_engines(exe_dir);
    crate::split_tunnel::firewall::delete_rule();
    purge_adapter_routes();
    settle_owed_routes(owed, ops);
}

/// Removes the host routes a previous life left on the physical adapter.
///
/// The one leftover [`purge_adapter_routes`] cannot reach, because it is
/// not on an adapter of ours: the node's host route, which Xray's routing
/// and OpenVPN's `redirect-gateway` both put on the uplink. Measured on
/// the VM after Compatible sessions: two of them, still there, sending
/// every later request to those nodes -- the app's own mirror checks
/// included -- around the tunnel.
///
/// Only what the ledger names, each scoped by the interface and next hop
/// it was recorded with. Nothing is inferred from the table, because a
/// host route on the physical adapter may perfectly well be somebody
/// else's.
pub(super) fn settle_owed_routes(owed: &OwedRoutes, ops: &dyn RouteOps) -> Replayed {
    let replayed = owed.replay(ops);
    if !replayed.removed.is_empty() {
        // Destinations only: the next hop is the customer's own gateway,
        // which says where they are and is no part of answering "did
        // Neoxify leave a route behind".
        let removed: Vec<String> = replayed.removed.iter().map(|r| format!("{}/{}", r.dest, r.prefix)).collect();
        crate::cleanup_log::note(
            "remove host routes an earlier session left on another adapter",
            &format!("removed {}", removed.join(", ")),
        );
    }
    let still_owed = (!replayed.failed.is_empty()).then(|| format!("still owed: {}", replayed.failed.join("; ")));
    if let Some(line) = still_owed.as_deref().filter(|line| first_time_said(owed, line)) {
        crate::cleanup_log::note("remove host routes an earlier session left on another adapter", line);
    }
    if still_owed.is_none() {
        forget_said(owed);
    }
    replayed
}

/// The "still owed" line last written for each ledger.
///
/// This runs on every idle status poll -- the app sends one every few
/// seconds for as long as it is open and disconnected -- so a route that
/// will not delete wrote the same line to cleanup.log on every one of
/// them. Said once, and again only when what is owed changes or has been
/// cleared in between. Per ledger file, so the tests' ledgers, each in a
/// directory of its own, do not speak over each other.
static STILL_OWED_SAID: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

/// Whether `line` is news for this ledger, remembering it if so.
fn first_time_said(owed: &OwedRoutes, line: &str) -> bool {
    let mut said = STILL_OWED_SAID.lock().unwrap_or_else(|e| e.into_inner());
    match said.iter_mut().find(|(path, _)| path == owed.file()) {
        Some((_, last)) if last == line => false,
        Some((_, last)) => {
            *last = line.to_string();
            true
        }
        None => {
            said.push((owed.file().to_path_buf(), line.to_string()));
            true
        }
    }
}

/// Nothing is owed that would not delete: the next failure is news.
fn forget_said(owed: &OwedRoutes) {
    STILL_OWED_SAID.lock().unwrap_or_else(|e| e.into_inner()).retain(|(path, _)| path != owed.file());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::route_table::fake::{FakeRoutes, Op};
    use crate::engines::route_table::RouteRow;
    use std::net::Ipv4Addr;

    fn ledger_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("neoconnect-janitor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The route a killed service left, and only that one.
    ///
    /// Two look-alikes share the table with it: the same node routed
    /// through another gateway on the same adapter, and through the same
    /// gateway on another adapter. Either could be somebody else's, so a
    /// delete matched on the destination alone -- which is what
    /// `route delete <node>` with no interface does -- would take them
    /// too. Before this, the janitor never touched a non-ours adapter at
    /// all, and the owed route stayed until a reboot.
    #[test]
    fn reconcile_deletes_each_owed_route_scoped_by_interface_and_next_hop_then_clears() {
        let node = Ipv4Addr::new(203, 0, 113, 7);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let ours = RouteRow::host(node, 14, gateway, 1);
        let other_gateway = RouteRow::host(node, 14, Ipv4Addr::new(192, 0, 2, 254), 1);
        let other_adapter = RouteRow::host(node, 9, gateway, 1);
        let table = FakeRoutes::with(&[ours, other_gateway, other_adapter]);

        let dir = ledger_dir("reconcile");
        let owed = OwedRoutes::in_dir(&dir);
        owed.owe(ours);

        let replayed = settle_owed_routes(&owed, &*table);

        assert_eq!(table.log(), vec![Op::Delete(ours)], "exactly the owed route, by its own key");
        assert_eq!(table.table(), vec![other_gateway, other_adapter], "the look-alikes are not ours");
        assert_eq!(replayed.removed, vec![ours]);
        assert!(owed.read().is_empty(), "a removed route is struck off");
        assert!(!dir.join("owed-routes.json").exists(), "nothing owed leaves no file behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A route that will not delete is put in cleanup.log once, not on
    /// every pass. The janitor runs on every idle status poll, for as long
    /// as the app is open and disconnected, and each wrote the same "still
    /// owed" line again. Said again when what is owed changes.
    #[test]
    fn a_route_that_will_not_delete_is_logged_once_not_on_every_poll() {
        let route = RouteRow::host(Ipv4Addr::new(203, 0, 113, 77), 14, Ipv4Addr::new(192, 0, 2, 1), 1);
        let other = RouteRow::host(Ipv4Addr::new(203, 0, 113, 78), 14, Ipv4Addr::new(192, 0, 2, 1), 1);
        let table = FakeRoutes::with(&[route, other]);
        table.refuses_deletes();
        let dir = ledger_dir("still-owed-once");
        let owed = OwedRoutes::in_dir(&dir);
        owed.owe(route);

        for _ in 0..3 {
            settle_owed_routes(&owed, &*table);
        }
        assert_eq!(crate::cleanup_log::noted_containing("203.0.113.77/32").len(), 1);

        owed.owe(other);
        settle_owed_routes(&owed, &*table);
        settle_owed_routes(&owed, &*table);
        assert_eq!(crate::cleanup_log::noted_containing("203.0.113.78/32").len(), 1, "a change was not said");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A route that is already gone -- the machine rebooted, which clears
    /// every route `route.exe` adds -- is struck off rather than owed for
    /// ever.
    #[test]
    fn an_owed_route_that_is_already_gone_is_struck_off() {
        let route = RouteRow::host(Ipv4Addr::new(203, 0, 113, 8), 14, Ipv4Addr::new(192, 0, 2, 1), 1);
        let table = FakeRoutes::with(&[]);
        let dir = ledger_dir("gone");
        let owed = OwedRoutes::in_dir(&dir);
        owed.owe(route);

        settle_owed_routes(&owed, &*table);
        assert!(owed.read().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
