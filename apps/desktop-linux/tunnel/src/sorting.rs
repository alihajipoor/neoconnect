//! Which running programs are the customer's chosen apps, and moving them
//! into a control group of ours so the kernel can route them apart.
//!
//! An app is named by an identity: the full path of its program as
//! `/proc/<pid>/exe` shows it, with three adjustments so the identity
//! survives what packaging does to that path.
//!
//! * A snap runs from `/snap/<name>/<revision>/...`, and the revision
//!   changes at every update. The identity says `current` in its place,
//!   which is also the symlink snapd keeps to the live revision.
//! * A Flatpak app runs in its own mount namespace, where its program is
//!   `/app/bin/...` -- the same path for every Flatpak app. The identity is
//!   its installation directory, `<installation>/app/<app id>`, read from
//!   the sandbox's own `/.flatpak-info`.
//! * An AppImage runs from a fresh `/tmp/.mount_XXXX` each launch. The
//!   identity is the image file itself, from the `APPIMAGE` variable its
//!   runtime sets.
//!
//! Only processes in the customer's session (`/user.slice`) are ever
//! moved, never the init system or a user manager: choosing a program
//! that happens to be a system daemon's too must not sort the daemon.

use std::collections::{HashMap, HashSet};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::Running;

pub(crate) const CGROUP_ROOT: &str = "/sys/fs/cgroup";
/// The chosen apps. Root-level, so the nftables rule can name it at level 1.
pub(crate) const SPLIT_GROUP: &str = "neoxify.split";
/// The Neoxify app itself, whose sockets the reconnect hold lets through.
pub(crate) const APP_GROUP: &str = "neoxify.app";

/// What the kernel appends to the path of a program replaced on disk
/// while it runs (an upgrade). Still the same app.
const DELETED: &str = " (deleted)";

/// The kernel's own limit on a path (PATH_MAX).
const MAX_APP_LEN: usize = 4096;

/// How often the watcher scans `/proc` whatever it has been told.
///
/// New programs are learned from the kernel as they start: the netlink
/// process connector reports every exec, and the program is moved within
/// a fraction of a millisecond, before it has finished loading. Polling
/// alone was tried first and was not enough: in the VM a chosen curl
/// started after connect had its connection out the machine's own way
/// before a 250 ms scan reached it. The scan stays, as the net for an
/// event the kernel dropped (its socket buffer can overflow) and for a
/// machine where the connector cannot be opened. Anything a sorted
/// program starts is sorted by the kernel at fork, with no wait at all.
pub(crate) const TICK: Duration = Duration::from_millis(250);

pub(crate) const NO_UNIFIED: &str =
    "Custom mode needs unified control groups (cgroup v2), and this system does not use them";

/// Whether the machine runs the unified hierarchy alone. A hybrid layout
/// keeps a v2 tree aside, but sockets are then tagged with v1 classes and
/// the nftables match on v2 groups does not see them.
pub(crate) fn unified() -> bool {
    Path::new(CGROUP_ROOT).join("cgroup.controllers").is_file()
}

/// Makes one of our root-level groups, or finds it there already.
pub(crate) fn ensure_group(name: &str) -> Result<PathBuf, String> {
    if !unified() {
        return Err(NO_UNIFIED.to_string());
    }
    let path = Path::new(CGROUP_ROOT).join(name);
    match std::fs::create_dir(&path) {
        Ok(()) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(path),
        Err(e) => Err(format!("could not create the control group {name}: {e}")),
    }
}

// ---------------------------------------------------------------------
// Identities

/// Is this an identity the sorting can act on? Absolute, plain (no `.`,
/// `..` or empty parts, nothing after the name), no control characters,
/// bounded. `/snap/bin/...` is refused: every file there is a link to
/// snapd's own launcher, which would match every snap at once.
pub(crate) fn valid_app(app: &str) -> Result<(), String> {
    if app.is_empty() || app.len() > MAX_APP_LEN {
        return Err("an app's path is empty or too long".into());
    }
    if !app.starts_with('/') {
        return Err("an app must be named by its full path".into());
    }
    if app.chars().any(char::is_control) {
        return Err("an app's path has a control character in it".into());
    }
    if app.ends_with('/') || app[1..].split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("an app's path must be a plain full path, without empty, . or .. parts".into());
    }
    if app.ends_with(DELETED) {
        return Err("an app's path must not carry the kernel's \"(deleted)\" note".into());
    }
    if app.starts_with("/snap/bin/") {
        return Err("files in /snap/bin all start snapd's launcher; choose the app from the running apps instead".into());
    }
    if let Some((_, id)) = flatpak_parts(app) {
        if !valid_flatpak_id(id) {
            return Err("that is not a Flatpak app's directory".into());
        }
    }
    Ok(())
}

/// A Flatpak installation's app directory (`<inst>/app/<id>`) or exported
/// launcher (`<inst>/exports/bin/<id>`), split into the installation and
/// the app id. The installation is any directory named `flatpak`.
fn flatpak_parts(app: &str) -> Option<(&str, &str)> {
    for marker in ["/flatpak/app/", "/flatpak/exports/bin/"] {
        if let Some(at) = app.find(marker) {
            let installation = &app[..at + "/flatpak".len()];
            let id = &app[at + marker.len()..];
            return Some((installation, id));
        }
    }
    None
}

/// A reverse-DNS app id: at least three dot-separated parts of letters,
/// digits, `_` and `-`. Nothing that could be a path.
fn valid_flatpak_id(id: &str) -> bool {
    id.len() <= 255
        && id.split('.').count() >= 3
        && id.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
}

/// A snap revision: digits, or `x` and digits for a local install.
fn is_revision(part: &str) -> bool {
    let digits = part.strip_prefix('x').unwrap_or(part);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// The one spelling of an identity both sides are compared in: a snap
/// revision as `current`, a Flatpak launcher as its app directory.
pub(crate) fn normalize(path: &str) -> String {
    let path = path.strip_suffix(DELETED).unwrap_or(path);
    if let Some(rest) = path.strip_prefix("/snap/") {
        let mut parts = rest.splitn(3, '/');
        if let (Some(name), Some(revision)) = (parts.next(), parts.next()) {
            if is_revision(revision) {
                return match parts.next() {
                    Some(tail) => format!("/snap/{name}/current/{tail}"),
                    None => format!("/snap/{name}/current"),
                };
            }
        }
    }
    if let Some((installation, id)) = flatpak_parts(path) {
        return format!("{installation}/app/{id}");
    }
    path.to_string()
}

/// Every spelling a chosen app is matched by, mapped back to the app as
/// it was chosen: the identity itself, and the program its path leads to
/// when it is a link (`/usr/bin/firefox` is a link on most distributions).
pub(crate) fn chosen_map(apps: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for app in apps {
        map.insert(normalize(app), app.clone());
        if flatpak_parts(app).is_none() {
            if let Ok(real) = std::fs::canonicalize(app) {
                if let Some(real) = real.to_str() {
                    map.entry(normalize(real)).or_insert_with(|| app.clone());
                }
            }
        }
    }
    map
}

/// The identity of a running process, or `None` for a kernel thread or
/// one that has gone.
pub(crate) fn identity_of(pid: u32) -> Option<String> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let exe = exe.to_str()?;
    if other_mount_namespace(pid) {
        if let Some(app) = std::fs::read_to_string(format!("/proc/{pid}/root/.flatpak-info"))
            .ok()
            .and_then(|text| flatpak_identity(&text))
        {
            return Some(app);
        }
    }
    if exe.starts_with("/tmp/.mount_") {
        if let Some(image) = std::fs::read(format!("/proc/{pid}/environ")).ok().and_then(|e| appimage(&e)) {
            return Some(image);
        }
    }
    Some(normalize(exe))
}

fn other_mount_namespace(pid: u32) -> bool {
    match (std::fs::read_link(format!("/proc/{pid}/ns/mnt")), std::fs::read_link("/proc/self/ns/mnt")) {
        (Ok(theirs), Ok(ours)) => theirs != ours,
        _ => false,
    }
}

/// `<installation>/app/<id>` from a sandbox's `/.flatpak-info`: the app
/// id from `[Application] name=`, the installation from where
/// `[Instance] app-path=` says the app's files are.
pub(crate) fn flatpak_identity(info: &str) -> Option<String> {
    let mut section = "";
    let (mut name, mut app_path) = (None, None);
    for line in info.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match (section, key.trim()) {
            ("[Application]", "name") => name = Some(value.trim()),
            ("[Instance]", "app-path") => app_path = Some(value.trim()),
            _ => {}
        }
    }
    let (name, app_path) = (name?, app_path?);
    if !valid_flatpak_id(name) {
        return None;
    }
    let marker = format!("/app/{name}/");
    let at = app_path.find(&marker)?;
    let identity = format!("{}/app/{name}", &app_path[..at]);
    (valid_app(&identity).is_ok() && flatpak_parts(&identity).is_some()).then_some(identity)
}

/// The image file an AppImage was started from.
pub(crate) fn appimage(environ: &[u8]) -> Option<String> {
    environ
        .split(|b| *b == 0)
        .find_map(|var| var.strip_prefix(b"APPIMAGE="))
        .and_then(|v| std::str::from_utf8(v).ok())
        .filter(|v| valid_app(v).is_ok())
        .map(str::to_string)
}

// ---------------------------------------------------------------------
// Processes and groups

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// Start time in clock ticks since boot: with the pid, names one
    /// process for good, so a reused pid is never taken for the old one.
    pub start: u64,
}

/// `/proc/<pid>/stat` -> parent and start time. The program name sits in
/// parentheses and may hold spaces or parentheses itself, so the fields
/// are counted from the last `)`.
pub(crate) fn parse_stat(text: &str) -> Option<(u32, u64)> {
    let rest = &text[text.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

pub(crate) fn processes() -> Vec<Proc> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .filter_map(|pid| {
            let (ppid, start) = parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
            Some(Proc { pid, ppid, start })
        })
        .collect()
}

/// Each root with everything below it, attributed to the root's app.
pub(crate) fn with_descendants(procs: &[Proc], roots: &[(u32, String)]) -> HashMap<u32, String> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut out = HashMap::new();
    for (root, app) in roots {
        let mut stack = vec![*root];
        while let Some(pid) = stack.pop() {
            if out.insert(pid, app.clone()).is_some() {
                continue;
            }
            stack.extend(children.get(&pid).into_iter().flatten().copied());
        }
    }
    out
}

/// The v2 group line of `/proc/<pid>/cgroup` (`0::/path`).
pub(crate) fn parse_cgroup(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("0::")).map(str::to_string)
}

fn cgroup_of(pid: u32) -> Option<String> {
    parse_cgroup(&std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?)
}

/// A process of the customer's own session, which is all the sorting
/// ever moves. A user manager (`user@N.service/init.scope`) is in the
/// session's slice too but is never moved: it would take every app with it.
pub(crate) fn movable(cgroup: &str) -> bool {
    cgroup.starts_with("/user.slice/") && !cgroup.ends_with("/init.scope")
}

/// Moves one process (all its threads) into a group, by its path below
/// the cgroup root.
fn move_into(group: &str, pid: u32) -> std::io::Result<()> {
    let group = group.trim_start_matches('/');
    std::fs::write(Path::new(CGROUP_ROOT).join(group).join("cgroup.procs"), pid.to_string())
}

fn uid_of(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|l| l.strip_prefix("Uid:"))?.split_whitespace().next()?.parse().ok()
}

/// One user's processes and the identity each would be chosen by.
pub(crate) fn running(uid: u32) -> Vec<Running> {
    let me = std::process::id();
    let mut out = Vec::new();
    for p in processes() {
        if p.pid == me || uid_of(p.pid) != Some(uid) {
            continue;
        }
        let Some(app) = identity_of(p.pid).filter(|a| valid_app(a).is_ok()) else { continue };
        let name = std::fs::read_to_string(format!("/proc/{}/comm", p.pid)).map(|s| s.trim().to_string()).unwrap_or_default();
        out.push(Running { pid: p.pid, app, name });
    }
    out
}

/// The reconnect hold's group for the app and everything it has started
/// (its web view's network process makes its connections).
pub(crate) fn adopt_app(pid: u32) -> Result<String, String> {
    if pid <= 1 || pid == std::process::id() {
        return Err(format!("process {pid} cannot be moved"));
    }
    ensure_group(APP_GROUP)?;
    let procs = processes();
    if !procs.iter().any(|p| p.pid == pid) {
        return Err(format!("process {pid} is not running"));
    }
    for (each, _) in with_descendants(&procs, &[(pid, String::new())]) {
        if cgroup_of(each).is_some_and(|cg| cg.ends_with("/init.scope")) {
            continue;
        }
        match move_into(APP_GROUP, each) {
            Ok(()) => {}
            Err(e) if each == pid => return Err(format!("could not move process {pid} into {APP_GROUP}: {e}")),
            // A child that exited meanwhile.
            Err(_) => {}
        }
    }
    Ok(APP_GROUP.to_string())
}

// ---------------------------------------------------------------------
// The watcher

/// One process we moved, and where it came from, so it can go back.
#[derive(Debug, Clone)]
struct Moved {
    start: u64,
    from: String,
    app: String,
}

#[derive(Default)]
struct SortState {
    apps: Vec<String>,
    /// [`chosen_map`] of `apps`, as of the last scan: what an exec is
    /// matched against without resolving links on the event's path.
    wanted: HashMap<String, String>,
    moved: HashMap<u32, Moved>,
    /// For each chosen app, its processes that were already running when
    /// it was chosen: their open connections stay where they were.
    already_running: HashMap<String, Vec<(u32, u64)>>,
    /// Apps chosen since the last look, whose first sighting is recorded.
    newly_chosen: HashSet<String>,
}

struct Shared {
    stop: AtomicBool,
    state: Mutex<SortState>,
}

/// Keeps the chosen apps in [`SPLIT_GROUP`] for the life of a session.
pub(crate) struct Sorter {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Sorter {
    /// Sorts what is running now, before returning, then watches.
    pub(crate) fn start(apps: &[String]) -> Result<Sorter, String> {
        ensure_group(SPLIT_GROUP)?;
        let state = SortState { apps: apps.to_vec(), newly_chosen: apps.iter().cloned().collect(), ..Default::default() };
        let shared = Arc::new(Shared { stop: AtomicBool::new(false), state: Mutex::new(state) });
        tick(&mut shared.state.lock().unwrap_or_else(|e| e.into_inner()));
        let watched = shared.clone();
        // Opened here, not in the thread, so it listens before this returns.
        let listener = ExecListener::open()
            .inspect_err(|e| eprintln!("neoxify-helper: no exec notifications ({e}); chosen apps are found by scanning"))
            .ok();
        let thread = std::thread::Builder::new()
            .name("neoxify-sorter".into())
            .spawn(move || {
                let mut scanned = std::time::Instant::now();
                while !watched.stop.load(Ordering::SeqCst) {
                    let wait = TICK.saturating_sub(scanned.elapsed());
                    match &listener {
                        Some(listener) => {
                            let started = listener.wait(wait);
                            if !started.is_empty() {
                                let mut state = watched.state.lock().unwrap_or_else(|e| e.into_inner());
                                for pid in started {
                                    on_exec(&mut state, pid);
                                }
                            }
                        }
                        None => std::thread::sleep(wait),
                    }
                    if watched.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if scanned.elapsed() >= TICK {
                        tick(&mut watched.state.lock().unwrap_or_else(|e| e.into_inner()));
                        scanned = std::time::Instant::now();
                    }
                }
            })
            .map_err(|e| format!("could not start watching for chosen apps: {e}"))?;
        Ok(Sorter { shared, thread: Some(thread) })
    }

    /// A new list. Processes moved for an app no longer chosen go back
    /// where they came from; new apps are sorted before this returns.
    pub(crate) fn set_apps(&self, apps: &[String]) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let gone: HashSet<String> = state.apps.iter().filter(|a| !apps.contains(a)).cloned().collect();
        let added: Vec<String> = apps.iter().filter(|a| !state.apps.contains(a)).cloned().collect();
        let back: Vec<(u32, Moved)> =
            state.moved.iter().filter(|(_, m)| gone.contains(&m.app)).map(|(p, m)| (*p, m.clone())).collect();
        for (pid, moved) in back {
            put_back(pid, &moved);
            state.moved.remove(&pid);
        }
        for app in &gone {
            state.already_running.remove(app);
        }
        state.apps = apps.to_vec();
        state.newly_chosen.extend(added);
        tick(&mut state);
    }

    /// Bare file names of chosen apps that still have a process that was
    /// running when the app was chosen.
    pub(crate) fn restart_needed(&self) -> Vec<String> {
        let state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut names: Vec<String> = state
            .already_running
            .iter()
            .filter(|(_, pids)| pids.iter().any(|(pid, start)| alive(*pid, *start)))
            .filter_map(|(app, _)| app.rsplit('/').next().map(str::to_string))
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// The fast half: stop looking. Nothing new is moved after this.
    pub(crate) fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
    }

    /// The thorough half: wait for the watcher, and put every process we
    /// moved back in the group it came from, so the session's own tools
    /// (systemd's scopes) keep track of them as before.
    pub(crate) fn finish(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        for (pid, moved) in std::mem::take(&mut state.moved) {
            put_back(pid, &moved);
        }
        state.already_running.clear();
    }
}

impl Drop for Sorter {
    fn drop(&mut self) {
        self.finish();
    }
}

fn alive(pid: u32, start: u64) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|t| parse_stat(&t))
        .is_some_and(|(_, s)| s == start)
}

/// Back to where it was, if it is the same process, still in our group,
/// and the group it came from still exists (systemd removes an emptied
/// scope; then it stays with us, which routes nothing once the table goes).
fn put_back(pid: u32, moved: &Moved) {
    if !alive(pid, moved.start) || cgroup_of(pid).as_deref() != Some(&format!("/{SPLIT_GROUP}")) {
        return;
    }
    if Path::new(CGROUP_ROOT).join(moved.from.trim_start_matches('/')).is_dir() {
        let _ = move_into(&moved.from, pid);
    }
}

/// A program has just started (an exec): into the group if it is chosen.
fn on_exec(state: &mut SortState, pid: u32) {
    if state.wanted.is_empty() || pid <= 1 || pid == std::process::id() {
        return;
    }
    let Some(app) = identity_of(pid).and_then(|id| state.wanted.get(&id).cloned()) else { return };
    let Some(cgroup) = cgroup_of(pid) else { return };
    if cgroup == format!("/{SPLIT_GROUP}") || !movable(&cgroup) {
        return;
    }
    let Some((_, start)) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|t| parse_stat(&t)) else {
        return;
    };
    if move_into(SPLIT_GROUP, pid).is_ok() {
        state.moved.insert(pid, Moved { start, from: cgroup, app });
    }
}

/// One look: every process running a chosen program, and everything it
/// has started, into the group.
fn tick(state: &mut SortState) {
    let me = std::process::id();
    let procs = processes();
    let by_pid: HashMap<u32, Proc> = procs.iter().map(|p| (p.pid, *p)).collect();
    state.moved.retain(|pid, m| by_pid.get(pid).is_some_and(|p| p.start == m.start));

    let wanted = chosen_map(&state.apps);
    state.wanted = wanted.clone();
    let roots: Vec<(u32, String)> = if wanted.is_empty() {
        Vec::new()
    } else {
        procs
            .iter()
            .filter(|p| p.pid > 1 && p.pid != me)
            .filter_map(|p| wanted.get(&identity_of(p.pid)?).map(|app| (p.pid, app.clone())))
            .collect()
    };
    let target = format!("/{SPLIT_GROUP}");
    for (pid, app) in with_descendants(&procs, &roots) {
        let Some(proc_) = by_pid.get(&pid) else { continue };
        if pid == me {
            continue;
        }
        let Some(cgroup) = cgroup_of(pid) else { continue };
        if cgroup == target || !movable(&cgroup) {
            continue;
        }
        if move_into(SPLIT_GROUP, pid).is_ok() {
            state.moved.insert(pid, Moved { start: proc_.start, from: cgroup, app: app.clone() });
            if state.newly_chosen.contains(&app) {
                state.already_running.entry(app).or_default().push((pid, proc_.start));
            }
        }
    }
    state.newly_chosen.clear();
}

// ---------------------------------------------------------------------
// Exec notifications

/// The kernel's process connector (`linux/cn_proc.h`), as far as an exec.
const CN_IDX_PROC: u32 = 1;
const CN_VAL_PROC: u32 = 1;
const PROC_CN_MCAST_LISTEN: u32 = 1;
const PROC_CN_MCAST_IGNORE: u32 = 2;
const PROC_EVENT_EXEC: u32 = 2;
/// `struct nlmsghdr`, then `struct cn_msg`: where the payload starts.
const NLMSG_HDR: usize = 16;
const CN_MSG_HDR: usize = 20;

/// A netlink socket subscribed to the kernel's process events. Root only.
struct ExecListener {
    fd: OwnedFd,
}

impl ExecListener {
    fn open() -> std::io::Result<Self> {
        // SAFETY: plain socket calls on a descriptor owned here; the
        // address and the message are live locals of the sizes given.
        unsafe {
            let raw = libc::socket(libc::AF_NETLINK, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, libc::NETLINK_CONNECTOR);
            if raw < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let fd = OwnedFd::from_raw_fd(raw);
            let mut addr: libc::sockaddr_nl = std::mem::zeroed();
            addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
            addr.nl_groups = CN_IDX_PROC;
            if libc::bind(
                fd.as_raw_fd(),
                (&addr as *const libc::sockaddr_nl).cast(),
                std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
            ) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let listener = ExecListener { fd };
            listener.send_op(PROC_CN_MCAST_LISTEN)?;
            Ok(listener)
        }
    }

    fn send_op(&self, op: u32) -> std::io::Result<()> {
        let msg = control_message(op);
        // SAFETY: a live buffer of the length given.
        let sent = unsafe { libc::send(self.fd.as_raw_fd(), msg.as_ptr().cast(), msg.len(), 0) };
        if sent < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// The processes that exec'd, waiting up to `timeout` for the first.
    fn wait(&self, timeout: Duration) -> Vec<u32> {
        let mut pfd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one pollfd owned by this frame.
        let ready = unsafe { libc::poll(&mut pfd, 1, timeout.as_millis().min(1000) as libc::c_int) };
        if ready <= 0 {
            return Vec::new();
        }
        let mut pids = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: a live buffer of the length given.
            let got = unsafe { libc::recv(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), libc::MSG_DONTWAIT) };
            // Nothing more, or the kernel dropped events (ENOBUFS): the
            // scan picks up whatever was missed.
            if got <= 0 {
                break;
            }
            pids.extend(exec_events(&buf[..got as usize]));
        }
        pids
    }
}

impl Drop for ExecListener {
    fn drop(&mut self) {
        let _ = self.send_op(PROC_CN_MCAST_IGNORE);
    }
}

/// A connector message carrying one `PROC_CN_MCAST_*` operation.
fn control_message(op: u32) -> Vec<u8> {
    let len = (NLMSG_HDR + CN_MSG_HDR + 4) as u32;
    let mut msg = Vec::with_capacity(len as usize);
    msg.extend(len.to_ne_bytes());
    msg.extend((libc::NLMSG_DONE as u16).to_ne_bytes());
    msg.extend(0u16.to_ne_bytes()); // flags
    msg.extend(0u32.to_ne_bytes()); // seq
    msg.extend(0u32.to_ne_bytes()); // port: the kernel's to fill
    msg.extend(CN_IDX_PROC.to_ne_bytes());
    msg.extend(CN_VAL_PROC.to_ne_bytes());
    msg.extend(0u32.to_ne_bytes()); // seq
    msg.extend(0u32.to_ne_bytes()); // ack
    msg.extend(4u16.to_ne_bytes()); // payload length
    msg.extend(0u16.to_ne_bytes()); // flags
    msg.extend(op.to_ne_bytes());
    msg
}

/// The thread-group ids of the exec events in one datagram. A
/// `proc_event` is `what`, `cpu`, a 64-bit timestamp, then for an exec
/// the pid and the thread group id.
pub(crate) fn exec_events(buf: &[u8]) -> Vec<u32> {
    let word = |at: usize| buf.get(at..at + 4).map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]));
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(len) = word(at).map(|l| l as usize) {
        if len < NLMSG_HDR || at + len > buf.len() {
            break;
        }
        let event = at + NLMSG_HDR + CN_MSG_HDR;
        if word(event) == Some(PROC_EVENT_EXEC) {
            if let Some(tgid) = word(event + 20) {
                out.push(tgid);
            }
        }
        at += (len + 3) & !3;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_events_are_read_from_the_connectors_layout() {
        let event = |what: u32, pid: u32, tgid: u32| {
            let mut m = Vec::new();
            let len = (NLMSG_HDR + CN_MSG_HDR + 24) as u32;
            m.extend(len.to_ne_bytes());
            m.extend([0u8; 12]);
            m.extend(CN_IDX_PROC.to_ne_bytes());
            m.extend(CN_VAL_PROC.to_ne_bytes());
            m.extend([0u8; 12]);
            m.extend(what.to_ne_bytes());
            m.extend(3u32.to_ne_bytes()); // cpu
            m.extend(123456789u64.to_ne_bytes());
            m.extend(pid.to_ne_bytes());
            m.extend(tgid.to_ne_bytes());
            m
        };
        let mut two = event(PROC_EVENT_EXEC, 4243, 4242);
        two.extend(event(1, 5000, 5000)); // a fork: not an exec
        two.extend(event(PROC_EVENT_EXEC, 6001, 6001));
        assert_eq!(exec_events(&two), vec![4242, 6001]);
        assert!(exec_events(&[]).is_empty());
        assert!(exec_events(&[200, 0, 0, 0, 1]).is_empty(), "a length past the end");
        assert_eq!(control_message(PROC_CN_MCAST_LISTEN).len(), 40);
    }

    #[test]
    fn plain_full_paths_are_apps() {
        for ok in [
            "/usr/bin/curl",
            "/opt/google/chrome/chrome",
            "/home/nx/Applications/Some App.AppImage",
            "/snap/firefox/current/usr/lib/firefox/firefox",
            "/snap/firefox/4793/usr/lib/firefox/firefox",
            "/var/lib/flatpak/app/org.mozilla.firefox",
            "/home/nx/.local/share/flatpak/app/com.discordapp.Discord",
            "/var/lib/flatpak/exports/bin/org.telegram.desktop",
        ] {
            assert_eq!(valid_app(ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn anything_that_could_be_mistaken_is_refused() {
        let long = format!("/{}", "a".repeat(MAX_APP_LEN));
        for bad in [
            "",
            "/",
            "curl",
            "usr/bin/curl",
            "C:\\Program Files\\app.exe",
            "/usr/bin/../bin/curl",
            "/usr/./bin/curl",
            "/usr//bin/curl",
            "/usr/bin/",
            "/usr/bin/curl\n/usr/bin/wget",
            "/usr/bin/cu\u{7}rl",
            "/usr/lib/firefox/firefox (deleted)",
            "/snap/bin/firefox",
            "/var/lib/flatpak/app/org.mozilla.firefox/x86_64",
            "/var/lib/flatpak/app/firefox",
            long.as_str(),
        ] {
            assert!(valid_app(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_snap_keeps_matching_across_revisions() {
        let chosen = "/snap/firefox/current/usr/lib/firefox/firefox";
        assert_eq!(normalize("/snap/firefox/4793/usr/lib/firefox/firefox"), chosen);
        assert_eq!(normalize("/snap/firefox/5012/usr/lib/firefox/firefox"), chosen);
        assert_eq!(normalize("/snap/firefox/x3/usr/lib/firefox/firefox"), chosen, "a local install");
        assert_eq!(normalize(chosen), chosen);
        assert_eq!(normalize("/snap/firefox/4793/usr/lib/firefox/firefox (deleted)"), chosen);
        // Not a revision: left alone, so two snaps never collapse into one.
        assert_eq!(normalize("/snap/core22/abc/usr/bin/x"), "/snap/core22/abc/usr/bin/x");
        assert_ne!(normalize("/snap/chromium/2900/usr/lib/chromium-browser/chrome"), chosen);
        assert_eq!(normalize("/usr/bin/curl"), "/usr/bin/curl");
    }

    #[test]
    fn a_flatpak_launcher_and_its_app_directory_are_one_app() {
        assert_eq!(
            normalize("/var/lib/flatpak/exports/bin/org.mozilla.firefox"),
            "/var/lib/flatpak/app/org.mozilla.firefox"
        );
        let map = chosen_map(&["/var/lib/flatpak/exports/bin/org.mozilla.firefox".to_string()]);
        assert_eq!(
            map.get("/var/lib/flatpak/app/org.mozilla.firefox").map(String::as_str),
            Some("/var/lib/flatpak/exports/bin/org.mozilla.firefox"),
            "matched in the app directory's spelling, reported as chosen"
        );
    }

    #[test]
    fn a_flatpak_sandbox_names_its_app() {
        // `/.flatpak-info` from Flathub's Firefox, ids and commit replaced.
        let info = "[Application]\nname=org.mozilla.firefox\nruntime=runtime/org.freedesktop.Platform/x86_64/24.08\n\n\
                    [Instance]\ninstance-id=1234567890\nbranch=stable\narch=x86_64\n\
                    app-path=/var/lib/flatpak/app/org.mozilla.firefox/x86_64/stable/0123abcd/files\n\
                    runtime-path=/var/lib/flatpak/runtime/org.freedesktop.Platform/x86_64/24.08/4567ef/files\n";
        assert_eq!(flatpak_identity(info).as_deref(), Some("/var/lib/flatpak/app/org.mozilla.firefox"));
        let user = info.replace("/var/lib/flatpak/app", "/home/nx/.local/share/flatpak/app");
        assert_eq!(flatpak_identity(&user).as_deref(), Some("/home/nx/.local/share/flatpak/app/org.mozilla.firefox"));
        assert_eq!(flatpak_identity("[Application]\nname=../../etc\n[Instance]\napp-path=/x/app/../../etc/y\n"), None);
        assert_eq!(flatpak_identity(""), None);
    }

    #[test]
    fn an_appimage_is_its_image_file() {
        let environ = b"HOME=/home/nx\0APPIMAGE=/home/nx/Apps/Tool.AppImage\0APPDIR=/tmp/.mount_ToolAb12\0";
        assert_eq!(appimage(environ).as_deref(), Some("/home/nx/Apps/Tool.AppImage"));
        assert_eq!(appimage(b"APPIMAGE=relative/Tool.AppImage\0"), None);
        assert_eq!(appimage(b"PATH=/usr/bin\0"), None);
    }

    #[test]
    fn stat_is_read_past_a_name_with_spaces_and_parentheses() {
        // `/proc/<pid>/stat` of a process named "Web Content (x)".
        let stat = "4242 (Web Content (x)) S 4100 4100 4100 0 -1 4194560 2000 0 0 0 10 5 0 0 20 0 30 0 123456 1000000 2000 18446744073709551615";
        assert_eq!(parse_stat(stat), Some((4100, 123456)));
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn descendants_follow_their_root() {
        let p = |pid, ppid| Proc { pid, ppid, start: 1 };
        let procs = [p(1, 0), p(100, 1), p(101, 100), p(102, 101), p(200, 1), p(201, 200)];
        let got = with_descendants(&procs, &[(100, "/opt/app".to_string())]);
        let mut pids: Vec<u32> = got.keys().copied().collect();
        pids.sort();
        assert_eq!(pids, [100, 101, 102]);
        assert!(got.values().all(|a| a == "/opt/app"));
    }

    #[test]
    fn only_the_customers_session_is_moved() {
        // `/proc/<pid>/cgroup` on Ubuntu 24.04 for a GNOME app.
        let text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-firefox-4242.scope\n";
        let cg = parse_cgroup(text).unwrap();
        assert!(movable(&cg));
        assert!(!movable("/user.slice/user-1000.slice/user@1000.service/init.scope"), "the user manager");
        assert!(!movable("/init.scope"));
        assert!(!movable("/system.slice/neoxify-helper.service"));
        assert!(!movable("/neoxify.app"), "the Neoxify app itself");
        assert_eq!(parse_cgroup("12:pids:/x\n"), None, "a v1-only line is not a v2 group");
    }
}
