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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
/// A socket stays in the control group it was created in, so a chosen
/// program has to be in the group before it opens its first socket, and
/// nothing that learns of a program after it has started is fast enough
/// for that. Two ways were tried in the VM and both lost the race to a
/// curl that connects as soon as it starts: a 250 ms scan, and the netlink
/// process connector, which reports an exec only once it has happened and
/// whose move into the group then takes the kernel 2 to 15 ms. So the
/// chosen programs' files carry a fanotify exec-permission mark (the
/// gate): the kernel holds each exec of one until the helper has moved
/// the process and answered, so the program's first instruction already
/// runs in the group. The connector and the scan stay, as the net for
/// what the gate cannot mark (a Flatpak app, a snap that was updated to a
/// new revision mid-session) or a kernel without fanotify; a process they
/// sort late while it holds a connection is reported as needing a restart.
/// Anything a sorted program starts is sorted by the kernel at fork.
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
    if other_mount_namespace(pid) && !fuse_backed(pid, "/.flatpak-info") {
        if let Some(app) = read_capped(&format!("/proc/{pid}/root/.flatpak-info"), MAX_FLATPAK_INFO)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| flatpak_identity(&text))
        {
            return Some(app);
        }
    }
    if exe.starts_with("/tmp/.mount_") {
        if let Some(image) = read_capped(&format!("/proc/{pid}/environ"), MAX_ENVIRON).and_then(|e| appimage(&e)) {
            return Some(image);
        }
    }
    Some(normalize(exe))
}

/// A real `/.flatpak-info` is a few hundred bytes.
const MAX_FLATPAK_INFO: u64 = 8192;
/// The kernel's own limit on the arguments and environment together.
const MAX_ENVIRON: u64 = 2 * 1024 * 1024;

/// Reads at most `cap` bytes of a regular file, without following a link
/// in its last part and without waiting on it. Root reads these files out
/// of any process's view of the filesystem, which that process controls:
/// a FIFO there would block the read for ever and `/dev/zero` would grow
/// it without end, and the sorting holds its lock while it reads, so
/// either would stop Custom mode, and the connect that starts it, dead.
pub(crate) fn read_capped(path: &str, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.file_type().is_file() {
        return None;
    }
    let mut out = Vec::new();
    file.take(cap).read_to_end(&mut out).ok()?;
    Some(out)
}

/// Whether the mount that holds `path` in a process's own view is a FUSE
/// filesystem. Its server is any program the user runs, and it can leave
/// a lookup or a read unanswered for ever, which no open flag prevents, so
/// the sorting does not look inside one. `/proc/<pid>/mountinfo` is the
/// kernel's own list and never waits on anyone.
fn fuse_backed(pid: u32, path: &str) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/mountinfo")) {
        Ok(text) => mount_fs_type(&text, path).is_none_or(|fs| fs.starts_with("fuse")),
        Err(_) => true,
    }
}

/// The filesystem type of the mount `path` is on, from a mountinfo table:
/// the last mount (the one on top) at the longest mount point that holds it.
pub(crate) fn mount_fs_type<'a>(mountinfo: &'a str, path: &str) -> Option<&'a str> {
    let mut best: Option<(usize, &str)> = None;
    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        let Some(point) = fields.get(4) else { continue };
        let Some(dash) = fields.iter().position(|f| *f == "-") else { continue };
        let Some(fs) = fields.get(dash + 1) else { continue };
        let holds = *point == "/" || path == *point || path.strip_prefix(point).is_some_and(|rest| rest.starts_with('/'));
        if holds && best.is_none_or(|(len, _)| point.len() >= len) {
            best = Some((point.len(), fs));
        }
    }
    best.map(|(_, fs)| fs)
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
///
/// The app's own group (for the reconnect hold) is movable too: a chosen
/// program the app started where its opener could not give it a scope of
/// its own would otherwise never be sorted, and leave the tunnel in "only
/// chosen apps".
pub(crate) fn movable(cgroup: &str) -> bool {
    (cgroup.starts_with("/user.slice/") && !cgroup.ends_with("/init.scope")) || cgroup == format!("/{APP_GROUP}")
}

/// The user whose session Custom mode belongs to. Only that user's
/// processes are sorted: one person's choice of apps must not move
/// another person's programs out of their own session and route them.
/// Root's own tools (no owner, or root) sort whatever matches.
static OWNER: AtomicU32 = AtomicU32::new(NO_OWNER);
const NO_OWNER: u32 = u32::MAX;

pub(crate) fn set_owner(uid: Option<u32>) {
    OWNER.store(uid.unwrap_or(NO_OWNER), Ordering::SeqCst);
}

fn owned(pid: u32) -> bool {
    owned_by(OWNER.load(Ordering::SeqCst), uid_of(pid))
}

pub(crate) fn owned_by(owner: u32, uid: Option<u32>) -> bool {
    owner == NO_OWNER || owner == 0 || uid == Some(owner)
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

/// The reconnect hold's group for the app and the parts of it that run as
/// processes of their own (its web view's processes, whose network
/// process makes the interface's connections). Nothing else the app has
/// started goes in: the hold lets this group go anywhere, and a browser
/// the app opened a link in is not the app. What the app starts later
/// inherits the group, so the app runs its opener in a scope of its own
/// (the app's `opener_scope.rs`).
pub(crate) fn adopt_app(pid: u32) -> Result<String, String> {
    if pid <= 1 || pid == std::process::id() {
        return Err(format!("process {pid} cannot be moved"));
    }
    ensure_group(APP_GROUP)?;
    let procs = processes();
    if !procs.iter().any(|p| p.pid == pid) {
        return Err(format!("process {pid} is not running"));
    }
    let app_exe = exe_of(pid);
    for (each, _) in with_descendants(&procs, &[(pid, String::new())]) {
        if cgroup_of(each).is_some_and(|cg| cg.ends_with("/init.scope")) {
            continue;
        }
        if each != pid && !app_own(app_exe.as_deref(), exe_of(each).as_deref()) {
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

fn exe_of(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()?.to_str().map(str::to_string)
}

/// Whether a process the app started is part of the app: another process
/// of the app's own program, or one of WebKitGTK's helper processes.
pub(crate) fn app_own(app_exe: Option<&str>, exe: Option<&str>) -> bool {
    let Some(exe) = exe.map(|e| e.strip_suffix(DELETED).unwrap_or(e)) else { return false };
    if app_exe.map(|a| a.strip_suffix(DELETED).unwrap_or(a)) == Some(exe) {
        return true;
    }
    let (dir, name) = exe.rsplit_once('/').unwrap_or(("", exe));
    name.starts_with("WebKit") && (dir.contains("/webkit2gtk-") || dir.contains("/webkitgtk-"))
}

/// Moves every process still in the chosen apps' group out of it: into
/// its parent's group when that is a session group, else into a scope of
/// its own in its user's slice. Called before a session's table goes in,
/// for whatever an earlier session or a crashed helper left behind, and
/// when a session ends, for what its sorted programs started meanwhile.
/// A process left in the group would be routed as a chosen app by the next
/// session's rules, whatever that session chose.
pub(crate) fn evict_all() {
    let Ok(text) = std::fs::read_to_string(Path::new(CGROUP_ROOT).join(SPLIT_GROUP).join("cgroup.procs")) else {
        return;
    };
    let target = format!("/{SPLIT_GROUP}");
    let parents: HashMap<u32, u32> = processes().into_iter().map(|p| (p.pid, p.ppid)).collect();
    for pid in text.lines().filter_map(|l| l.trim().parse::<u32>().ok()) {
        let parent_group = parents.get(&pid).and_then(|ppid| cgroup_of(*ppid));
        // A session group only: never the app's, which the hold lets through.
        if let Some(group) = parent_group.filter(|g| *g != target && movable(g) && g.starts_with("/user.slice/")) {
            if move_into(&group, pid).is_ok() {
                continue;
            }
        }
        rehome(pid);
    }
}

/// Into a new systemd scope in the process's user's slice, so it is back
/// in its user's tree (their limits apply, and logging out ends it) when
/// the group it came from is gone: systemd removes a scope once it is
/// empty, and a scope's directory cannot be made again by hand.
fn rehome(pid: u32) -> bool {
    let (Some(uid), Some((_, start))) = (
        uid_of(pid),
        std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|t| parse_stat(&t)),
    ) else {
        return false;
    };
    let asked = std::process::Command::new("busctl")
        .args(rehome_args(pid, start, uid))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !asked {
        eprintln!("neoxify-helper: process {pid} could not be given a scope of its own and stays in {SPLIT_GROUP}");
        return false;
    }
    // systemd moves it as the scope's job runs, just after the call returns.
    let target = format!("/{SPLIT_GROUP}");
    for _ in 0..40 {
        if cgroup_of(pid).is_none_or(|g| g != target) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// systemd's StartTransientUnit for a scope holding one process, as
/// `busctl` arguments. The name carries the start time so a reused pid
/// never collides with an earlier scope.
pub(crate) fn rehome_args(pid: u32, start: u64, uid: u32) -> Vec<String> {
    [
        "--timeout=3",
        "call",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StartTransientUnit",
        "ssa(sv)a(sa(sv))",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        format!("neoxify-returned-{pid}-{start}.scope"),
        "fail".into(),
        "2".into(),
        "PIDs".into(),
        "au".into(),
        "1".into(),
        pid.to_string(),
        "Slice".into(),
        "s".into(),
        format!("user-{uid}.slice"),
        "0".into(),
    ])
    .collect()
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
    /// Processes just sorted at their start, looked at again shortly
    /// after: a launcher (GLib, gnome-shell) asks systemd for the new
    /// program's own scope as it starts it, and systemd's move can land
    /// just after ours, taking it out of the group with its first sockets.
    recheck: Vec<Recheck>,
}

#[derive(Debug, Clone, Copy)]
struct Recheck {
    pid: u32,
    start: u64,
    /// How many looks are done; the next is due at `RECHECKS[done]` after `since`.
    done: usize,
    since: std::time::Instant,
}

/// When a process sorted at its start is looked at again.
const RECHECKS: [Duration; 3] = [Duration::from_millis(20), Duration::from_millis(100), Duration::from_millis(300)];

struct Shared {
    stop: AtomicBool,
    state: Mutex<SortState>,
}

/// Keeps the chosen apps in [`SPLIT_GROUP`] for the life of a session.
pub(crate) struct Sorter {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
    gate: Option<Arc<ExecGate>>,
    gate_thread: Option<JoinHandle<()>>,
}

impl Sorter {
    /// Sorts what is running now, before returning, then watches.
    pub(crate) fn start(apps: &[String]) -> Result<Sorter, String> {
        ensure_group(SPLIT_GROUP)?;
        let state = SortState { apps: apps.to_vec(), newly_chosen: apps.iter().cloned().collect(), ..Default::default() };
        let shared = Arc::new(Shared { stop: AtomicBool::new(false), state: Mutex::new(state) });
        // The gate and the listener are both in place before the first
        // scan, so a chosen program started while the scan runs is caught
        // by one of them rather than left for the next scan.
        let gate = ExecGate::open()
            .inspect_err(|e| eprintln!("neoxify-helper: no exec gate ({e}); chosen apps started from now on may be sorted late"))
            .ok()
            .map(Arc::new);
        if let Some(gate) = &gate {
            gate.mark_only(apps);
        }
        // Opened here, not in the thread, so it listens before this returns.
        let listener = ExecListener::open()
            .inspect_err(|e| eprintln!("neoxify-helper: no exec notifications ({e}); chosen apps are found by scanning"))
            .ok();
        tick(&mut shared.state.lock().unwrap_or_else(|e| e.into_inner()));
        let gate_thread = match &gate {
            Some(gate) => {
                let (gate, watched) = (gate.clone(), shared.clone());
                Some(
                    std::thread::Builder::new()
                        .name("neoxify-gate".into())
                        .spawn(move || {
                            while !watched.stop.load(Ordering::SeqCst) {
                                let wait = next_recheck(&watched.state, TICK);
                                gate.serve(wait, Some(&watched.state));
                                recheck_due(&mut watched.state.lock().unwrap_or_else(|e| e.into_inner()));
                            }
                            // Stopped: no exec may wait on a gate nobody
                            // serves any more, so the marks go and what is
                            // already queued is let through unsorted.
                            gate.unmark_all();
                            gate.serve(Duration::ZERO, None);
                        })
                        .map_err(|e| format!("could not start watching for chosen apps: {e}"))?,
                )
            }
            None => None,
        };
        let watched = shared.clone();
        let thread = std::thread::Builder::new()
            .name("neoxify-sorter".into())
            .spawn(move || {
                let mut scanned = std::time::Instant::now();
                while !watched.stop.load(Ordering::SeqCst) {
                    let wait = next_recheck(&watched.state, TICK.saturating_sub(scanned.elapsed()));
                    match &listener {
                        Some(listener) => {
                            let started = listener.wait(wait);
                            let mut state = watched.state.lock().unwrap_or_else(|e| e.into_inner());
                            for pid in started {
                                on_exec(&mut state, pid);
                            }
                            recheck_due(&mut state);
                        }
                        None => {
                            std::thread::sleep(wait);
                            recheck_due(&mut watched.state.lock().unwrap_or_else(|e| e.into_inner()));
                        }
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
        Ok(Sorter { shared, thread: Some(thread), gate, gate_thread })
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
        // Marked before the scan, for the same reason as at start. The
        // gate thread waits for this lock to sort, so it answers an exec of
        // a newly chosen app only once this has finished; that holds the
        // exec for the length of one scan at most.
        if let Some(gate) = &self.gate {
            gate.mark_only(apps);
        }
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
        if let Some(gate) = &self.gate {
            gate.unmark_all();
        }
    }

    /// The thorough half: wait for the watcher, and put every process we
    /// moved back in the group it came from, so the session's own tools
    /// (systemd's scopes) keep track of them as before.
    pub(crate) fn finish(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.gate_thread.take() {
            let _ = thread.join();
        }
        // Closing the gate lets through any exec still waiting on it.
        self.gate = None;
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        for (pid, moved) in std::mem::take(&mut state.moved) {
            put_back(pid, &moved);
        }
        state.already_running.clear();
        state.recheck.clear();
        drop(state);
        // What the sorted programs started is in the group too, by birth,
        // and was never in `moved`.
        evict_all();
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

/// Back to where it was, if it is the same process and still in our group.
/// systemd removes a scope once it is empty, so the group it came from may
/// be gone; it then gets a scope of its own rather than staying with us,
/// where the next session's rules would route it as a chosen app.
fn put_back(pid: u32, moved: &Moved) {
    if !alive(pid, moved.start) || cgroup_of(pid).as_deref() != Some(&format!("/{SPLIT_GROUP}")) {
        return;
    }
    if Path::new(CGROUP_ROOT).join(moved.from.trim_start_matches('/')).is_dir() && move_into(&moved.from, pid).is_ok() {
        return;
    }
    rehome(pid);
}

/// A program has just started (an exec): into the group if it is chosen.
fn on_exec(state: &mut SortState, pid: u32) {
    if state.wanted.is_empty() || pid <= 1 || pid == std::process::id() || !owned(pid) {
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
        late_with_connections(state, pid, start, &app);
        state.moved.insert(pid, Moved { start, from: cgroup, app });
        state.recheck.push(Recheck { pid, start, done: 0, since: std::time::Instant::now() });
    }
}

/// How long the watcher may wait before the next look again is due.
fn next_recheck(state: &Mutex<SortState>, longest: Duration) -> Duration {
    let state = state.lock().unwrap_or_else(|e| e.into_inner());
    state
        .recheck
        .iter()
        .filter_map(|r| RECHECKS.get(r.done).map(|after| after.saturating_sub(r.since.elapsed())))
        .fold(longest, Duration::min)
}

/// The looks again that are due: a process taken out of the group since it
/// was sorted (by systemd placing it in its launcher's new scope) goes
/// back in, and the scope it was taken into is where it returns at the end.
fn recheck_due(state: &mut SortState) {
    let target = format!("/{SPLIT_GROUP}");
    let mut pending = std::mem::take(&mut state.recheck);
    pending.retain_mut(|r| {
        let Some(after) = RECHECKS.get(r.done) else { return false };
        if r.since.elapsed() < *after {
            return true;
        }
        r.done += 1;
        if !alive(r.pid, r.start) {
            return false;
        }
        let Some(cgroup) = cgroup_of(r.pid) else { return false };
        if cgroup != target && movable(&cgroup) && move_into(SPLIT_GROUP, r.pid).is_ok() {
            if let Some(moved) = state.moved.get_mut(&r.pid) {
                moved.from = cgroup;
                let app = moved.app.clone();
                late_with_connections(state, r.pid, r.start, &app);
            }
        }
        r.done < RECHECKS.len()
    });
    state.recheck.append(&mut pending);
}

/// A process sorted after it had started (by the connector or the scan,
/// not the gate) may already have opened connections, and those stay
/// where they were made. If it holds one, it is reported with the
/// programs that were running when they were chosen, so the app can say
/// it needs a restart rather than claim it is fully sorted.
fn late_with_connections(state: &mut SortState, pid: u32, start: u64, app: &str) {
    if holds_inet_socket(pid) {
        let entry = state.already_running.entry(app.to_string()).or_default();
        if !entry.contains(&(pid, start)) {
            entry.push((pid, start));
        }
    }
}

/// Whether a process has an IPv4 or IPv6 socket open: its socket
/// descriptors against its network namespace's own socket tables.
fn holds_inet_socket(pid: u32) -> bool {
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return false };
    let inodes: HashSet<u64> = fds
        .filter_map(|e| e.ok())
        .filter_map(|e| std::fs::read_link(e.path()).ok())
        .filter_map(|l| l.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok())
        .collect();
    if inodes.is_empty() {
        return false;
    }
    ["tcp", "tcp6", "udp", "udp6", "raw", "raw6"].iter().any(|table| {
        std::fs::read_to_string(format!("/proc/{pid}/net/{table}"))
            .is_ok_and(|text| socket_inodes(&text).iter().any(|i| inodes.contains(i)))
    })
}

/// The inode column of a `/proc/net/{tcp,udp,raw}[6]` table.
pub(crate) fn socket_inodes(table: &str) -> Vec<u64> {
    table.lines().skip(1).filter_map(|l| l.split_whitespace().nth(9)?.parse().ok()).collect()
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
            .filter(|p| p.pid > 1 && p.pid != me && owned(p.pid))
            .filter_map(|p| wanted.get(&identity_of(p.pid)?).map(|app| (p.pid, app.clone())))
            .collect()
    };
    let target = format!("/{SPLIT_GROUP}");
    let sorted = with_descendants(&procs, &roots);
    let mut born_inside = Vec::new();
    for (pid, app) in &sorted {
        let (pid, app) = (*pid, app.clone());
        let Some(proc_) = by_pid.get(&pid) else { continue };
        if pid == me || !owned(pid) {
            continue;
        }
        let Some(cgroup) = cgroup_of(pid) else { continue };
        if cgroup == target {
            // Started by a sorted program, so in the group from birth and
            // never moved by us: recorded with its ancestor's origin, so it
            // goes back with it when the app stops being chosen.
            if !state.moved.contains_key(&pid) {
                born_inside.push((pid, proc_.start, app));
            }
            continue;
        }
        if !movable(&cgroup) {
            continue;
        }
        if move_into(SPLIT_GROUP, pid).is_ok() {
            state.moved.insert(pid, Moved { start: proc_.start, from: cgroup, app: app.clone() });
            if state.newly_chosen.contains(&app) {
                state.already_running.entry(app).or_default().push((pid, proc_.start));
            } else {
                late_with_connections(state, pid, proc_.start, &app);
            }
        }
    }
    for (pid, start, app) in born_inside {
        let mut at = by_pid.get(&pid).map(|p| p.ppid);
        let mut from = None;
        for _ in 0..64 {
            let Some(parent) = at else { break };
            if let Some(moved) = state.moved.get(&parent) {
                from = Some(moved.from.clone());
                break;
            }
            at = by_pid.get(&parent).map(|p| p.ppid);
        }
        // With no sorted ancestor on record it is left to the sweep of the
        // group when the session ends (`evict_all`).
        if let Some(from) = from {
            state.moved.insert(pid, Moved { start, from, app });
        }
    }
    state.newly_chosen.clear();
}

// ---------------------------------------------------------------------
// The exec gate

/// The files whose exec the gate holds: each chosen app's program, where
/// it really is on disk. A Flatpak app is a directory, not a program, and
/// is left to the connector and the scan.
fn gate_files(apps: &[String]) -> HashSet<PathBuf> {
    apps.iter()
        .filter(|app| flatpak_parts(app).is_none())
        .filter_map(|app| std::fs::canonicalize(app).ok())
        .filter(|path| path.is_file())
        .collect()
}

/// A fanotify group holding an exec-permission mark on each chosen
/// program. Root only. While it is open the kernel waits for an answer
/// before letting any exec of a marked file go on, and lets everything
/// through once it is closed, so a helper that dies cannot leave a
/// program unable to start.
struct ExecGate {
    fd: OwnedFd,
    marked: Mutex<HashSet<PathBuf>>,
}

/// `struct fanotify_event_metadata`: its size, and where `mask`, `fd` and
/// `pid` sit in it.
const FAN_META_LEN: usize = 24;

impl ExecGate {
    fn open() -> std::io::Result<Self> {
        // SAFETY: a plain system call; the descriptor it returns is owned
        // from here on.
        let raw = unsafe {
            libc::fanotify_init(
                libc::FAN_CLASS_CONTENT | libc::FAN_CLOEXEC | libc::FAN_NONBLOCK,
                (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_LARGEFILE) as libc::c_uint,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: just returned to us, and not owned elsewhere.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        Ok(ExecGate { fd, marked: Mutex::new(HashSet::new()) })
    }

    fn mark(&self, path: &Path, flags: libc::c_uint) -> std::io::Result<()> {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        // SAFETY: a live, NUL-terminated path and a descriptor we own.
        let rc = unsafe { libc::fanotify_mark(self.fd.as_raw_fd(), flags, libc::FAN_OPEN_EXEC_PERM, libc::AT_FDCWD, c.as_ptr()) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// Marks exactly the programs of `apps`: new ones added, ones no
    /// longer chosen removed.
    fn mark_only(&self, apps: &[String]) {
        let want = gate_files(apps);
        let mut marked = self.marked.lock().unwrap_or_else(|e| e.into_inner());
        for gone in marked.difference(&want).cloned().collect::<Vec<_>>() {
            let _ = self.mark(&gone, libc::FAN_MARK_REMOVE);
            marked.remove(&gone);
        }
        for path in want {
            if marked.contains(&path) {
                continue;
            }
            match self.mark(&path, libc::FAN_MARK_ADD) {
                Ok(()) => {
                    marked.insert(path);
                }
                Err(e) => eprintln!("neoxify-helper: could not gate a chosen app ({e}); it may be sorted late"),
            }
        }
    }

    fn unmark_all(&self) {
        let mut marked = self.marked.lock().unwrap_or_else(|e| e.into_inner());
        for path in marked.drain() {
            let _ = self.mark(&path, libc::FAN_MARK_REMOVE);
        }
    }

    /// Answers every exec waiting on the gate, waiting up to `timeout` for
    /// the first. With `state`, each process is moved into the group
    /// before its exec is let go on; without it (stopping), it is only
    /// let go. Every event is answered "allow" whatever happens: the gate
    /// decides where a program's traffic goes, never whether it may run.
    fn serve(&self, timeout: Duration, state: Option<&Mutex<SortState>>) {
        let mut pfd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one pollfd owned by this frame.
        let ready = unsafe { libc::poll(&mut pfd, 1, timeout.as_millis().min(1000) as libc::c_int) };
        if ready <= 0 {
            return;
        }
        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: a live buffer of the length given.
            let got = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if got <= 0 {
                break;
            }
            for (mask, fd, pid) in gate_events(&buf[..got as usize]) {
                if fd < 0 {
                    continue;
                }
                // SAFETY: the kernel opened this descriptor for us with
                // the event; it is ours to close.
                let file = unsafe { OwnedFd::from_raw_fd(fd) };
                if let Some(state) = state {
                    if let Ok(path) = std::fs::read_link(format!("/proc/self/fd/{fd}")) {
                        on_gate(&mut state.lock().unwrap_or_else(|e| e.into_inner()), pid, &path);
                    }
                }
                if mask & libc::FAN_OPEN_EXEC_PERM != 0 {
                    let answer = libc::fanotify_response { fd, response: libc::FAN_ALLOW };
                    // SAFETY: a live struct of the size given.
                    unsafe {
                        libc::write(
                            self.fd.as_raw_fd(),
                            (&answer as *const libc::fanotify_response).cast(),
                            std::mem::size_of::<libc::fanotify_response>(),
                        );
                    }
                }
                drop(file);
            }
        }
    }
}

/// `(mask, fd, pid)` of each event in one read from a fanotify group.
pub(crate) fn gate_events(buf: &[u8]) -> Vec<(u64, i32, u32)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + FAN_META_LEN <= buf.len() {
        let len = u32::from_ne_bytes(buf[at..at + 4].try_into().unwrap_or_default()) as usize;
        if len < FAN_META_LEN || at + len > buf.len() {
            break;
        }
        let mask = u64::from_ne_bytes(buf[at + 8..at + 16].try_into().unwrap_or_default());
        let fd = i32::from_ne_bytes(buf[at + 16..at + 20].try_into().unwrap_or_default());
        let pid = i32::from_ne_bytes(buf[at + 20..at + 24].try_into().unwrap_or_default());
        out.push((mask, fd, pid.max(0) as u32));
        at += len;
    }
    out
}

/// A chosen program is being started by `pid`: into the group now, while
/// the kernel holds the exec. The process still shows the program it is
/// replacing, so the app is named from the file being started.
fn on_gate(state: &mut SortState, pid: u32, file: &Path) {
    if pid <= 1 || pid == std::process::id() || !owned(pid) {
        return;
    }
    let Some(file) = file.to_str() else { return };
    let id = normalize(file);
    let app = state.wanted.get(&id).cloned().unwrap_or(id);
    let Some(cgroup) = cgroup_of(pid) else { return };
    if cgroup == format!("/{SPLIT_GROUP}") || !movable(&cgroup) {
        return;
    }
    let Some((_, start)) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|t| parse_stat(&t)) else {
        return;
    };
    if move_into(SPLIT_GROUP, pid).is_ok() {
        // Sockets it already holds were made by the program it is
        // replacing (an exec keeps open descriptors), and stay where they
        // were made.
        late_with_connections(state, pid, start, &app);
        state.moved.insert(pid, Moved { start, from: cgroup, app });
        state.recheck.push(Recheck { pid, start, done: 0, since: std::time::Instant::now() });
    }
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
    fn gate_events_are_read_from_fanotifys_layout() {
        let event = |mask: u64, fd: i32, pid: i32| {
            let mut m = Vec::new();
            m.extend((FAN_META_LEN as u32).to_ne_bytes());
            m.extend([3u8, 0]); // version, reserved
            m.extend((FAN_META_LEN as u16).to_ne_bytes());
            m.extend(mask.to_ne_bytes());
            m.extend(fd.to_ne_bytes());
            m.extend(pid.to_ne_bytes());
            m
        };
        let mut two = event(libc::FAN_OPEN_EXEC_PERM, 7, 4242);
        two.extend(event(libc::FAN_OPEN_EXEC_PERM, 8, 4300));
        assert_eq!(
            gate_events(&two),
            vec![(libc::FAN_OPEN_EXEC_PERM, 7, 4242), (libc::FAN_OPEN_EXEC_PERM, 8, 4300)]
        );
        assert!(gate_events(&two[..20]).is_empty(), "a short read");
        let mut bad = event(libc::FAN_OPEN_EXEC_PERM, 7, 1);
        bad[0] = 200;
        assert!(gate_events(&bad).is_empty(), "a length past the end");
    }

    #[test]
    fn socket_inodes_are_read_from_procs_tables() {
        // `/proc/net/udp` and `/proc/net/tcp` on Ubuntu 24.04, addresses replaced.
        let udp = "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n\
                    \x20 312: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   991        0 21654 2 0000000000000000 0\n";
        assert_eq!(socket_inodes(udp), vec![21654]);
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                   \x20  0: 0F02000A:D2B4 010200C6:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 98765 1 0000000000000000 20 4 30 10 -1\n";
        assert_eq!(socket_inodes(tcp), vec![98765]);
        assert!(socket_inodes("").is_empty());
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
        assert!(movable("/neoxify.app"), "a chosen app the Neoxify app started");
        assert!(!movable("/neoxify.app/x"));
        assert!(!movable("/neoxify.split"));
        assert_eq!(parse_cgroup("12:pids:/x\n"), None, "a v1-only line is not a v2 group");
    }

    #[test]
    fn only_the_session_owners_processes_are_sorted() {
        assert!(owned_by(1000, Some(1000)));
        assert!(!owned_by(1000, Some(1001)), "another user's matching program");
        assert!(!owned_by(1000, None), "a process whose owner could not be read");
        assert!(owned_by(0, Some(1001)), "root's own tools");
        assert!(owned_by(NO_OWNER, Some(1001)));
    }

    #[test]
    fn a_sandbox_file_that_could_stall_root_is_not_read() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("nx-capped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a live NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        // A FIFO nobody writes to: a plain read would wait for ever.
        assert_eq!(read_capped(fifo.to_str().unwrap(), 8192), None);
        // A device that never ends: a plain read would fill memory.
        assert_eq!(read_capped("/dev/zero", 8192), None);
        let real = dir.join("real");
        std::fs::write(&real, vec![b'x'; 20000]).unwrap();
        assert_eq!(read_capped(real.to_str().unwrap(), 8192).map(|b| b.len()), Some(8192), "read to the cap only");
        let link = dir.join("link");
        symlink(&real, &link).unwrap();
        assert_eq!(read_capped(link.to_str().unwrap(), 8192), None, "a link in the last part");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_fuse_root_is_not_looked_into() {
        // `/proc/<pid>/mountinfo` of a sandbox, shortened.
        let flatpak = "100 90 0:50 / / rw,nosuid - tmpfs tmpfs rw\n\
                       101 100 0:51 /info /.flatpak-info ro - tmpfs tmpfs rw\n\
                       102 100 0:52 / /usr ro - ext4 /dev/sda2 rw\n";
        assert_eq!(mount_fs_type(flatpak, "/.flatpak-info"), Some("tmpfs"));
        let fuse_root = "200 190 0:60 / / rw - fuse.trap trap rw\n";
        assert_eq!(mount_fs_type(fuse_root, "/.flatpak-info"), Some("fuse.trap"));
        let fuse_file = "100 90 0:50 / / rw - tmpfs tmpfs rw\n101 100 0:61 / /.flatpak-info rw - fuse trap rw\n";
        assert_eq!(mount_fs_type(fuse_file, "/.flatpak-info"), Some("fuse"));
        // `/.flatpak-infox` is not inside a mount at `/.flatpak-info`.
        assert_eq!(mount_fs_type(fuse_file, "/.flatpak-infox"), Some("tmpfs"));
        assert_eq!(mount_fs_type("", "/.flatpak-info"), None);
    }

    #[test]
    fn only_the_app_and_its_web_view_join_the_holds_group() {
        let app = Some("/usr/bin/neoxify");
        assert!(app_own(app, Some("/usr/bin/neoxify")));
        assert!(app_own(app, Some("/usr/bin/neoxify (deleted)")), "the app replaced on disk by an update");
        assert!(app_own(app, Some("/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess")));
        assert!(app_own(app, Some("/usr/libexec/webkit2gtk-4.1/WebKitWebProcess")));
        assert!(!app_own(app, Some("/usr/lib/firefox/firefox")), "a browser it opened a link in");
        assert!(!app_own(app, Some("/usr/bin/xdg-open")));
        assert!(!app_own(app, Some("/tmp/WebKitNetworkProcess")), "a WebKit name outside WebKit's directory");
        assert!(!app_own(app, None));
    }

    #[test]
    fn a_stranded_process_gets_a_scope_in_its_users_slice() {
        let args = rehome_args(4242, 98765, 1000);
        assert_eq!(args[5], "StartTransientUnit");
        assert_eq!(
            &args[7..],
            ["neoxify-returned-4242-98765.scope", "fail", "2", "PIDs", "au", "1", "4242", "Slice", "s", "user-1000.slice", "0"]
        );
    }
}
