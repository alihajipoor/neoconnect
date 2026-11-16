//! Who may ask the helper anything.
//!
//! The socket is mode 0666 because the app runs as the desktop user, so
//! the kernel's word on who is calling (`SO_PEERCRED`) is the check. Root
//! is served. Anyone else needs both of these:
//!
//! * its executable is the installed app: read from `/proc/<pid>/exe`,
//!   which the caller cannot forge, in `/usr/bin`, which only root writes.
//! * the person running it is the one at this computer's screen (logind's
//!   active user on a seat), or a member of the root-managed `neoxify`
//!   group, for a machine used without a screen of its own.
//!
//! The executable alone authenticates nothing: the app is not setuid, so
//! any local account can start it, or run its own code inside it with
//! `LD_PRELOAD`. And a tunnel is the whole machine's -- it carries every
//! user's traffic and changes the machine's DNS -- so who is calling is
//! what decides.
//!
//! For development, a root-owned `/etc/neoxify/helper.json` can name more
//! executables. It is ignored unless root owns it and nobody else can
//! write it: a file anyone could edit would be a way to let anything in.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where the packages install the app.
pub const APP_PATH: &str = "/usr/bin/neoxify";

/// The development allow-list.
pub const DEV_CONFIG: &str = "/etc/neoxify/helper.json";

/// Where logind describes each seat, including who is at it now.
pub const SEATS_DIR: &str = "/run/systemd/seats";

/// The group whose members may use the app without being at a seat. The
/// packages create it empty; only root can add anyone.
pub const GROUP: &str = "neoxify";

/// What a caller is, as far as the helper is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// Served: this is the app, run by someone allowed to. A connect from
    /// it makes its process the session's owner, whose exit ends the
    /// tunnel.
    App { pid: u32, uid: u32 },
    /// Served, not watched: root, or a tool run by root.
    Trusted,
    /// Refused, with what to log once.
    Refused { who: String },
}

pub struct Policy {
    /// The uid served without question. Root in production; a test sets
    /// its own, since tests do not run as root.
    pub trusted_uid: u32,
    /// Executables whose processes are the app.
    pub apps: Vec<PathBuf>,
    /// logind's seat files; a test points this at its own.
    pub seats: PathBuf,
    /// The group that admits a caller not at a seat.
    pub group: String,
    /// Refusals already logged, so a misbehaving caller polling every
    /// second does not fill the journal.
    logged: Mutex<HashSet<String>>,
}

/// What admits a caller running the app, apart from the executable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Standing {
    /// The caller's user is the active one on a seat: at the screen now.
    pub at_seat: bool,
    /// The calling process is in the `neoxify` group.
    pub in_group: bool,
}

impl Policy {
    pub fn new(trusted_uid: u32, apps: Vec<PathBuf>) -> Self {
        Self {
            trusted_uid,
            apps,
            seats: PathBuf::from(SEATS_DIR),
            group: GROUP.to_string(),
            logged: Mutex::new(HashSet::new()),
        }
    }

    /// The production policy: root, the installed app, and whatever the
    /// development file adds.
    pub fn system() -> Self {
        let mut apps = vec![PathBuf::from(APP_PATH)];
        match read_dev_config(Path::new(DEV_CONFIG)) {
            Ok(extra) => {
                for path in &extra {
                    eprintln!("neoxify-helper: also serving {} (from {DEV_CONFIG})", path.display());
                }
                apps.extend(extra);
            }
            Err(Some(why)) => eprintln!("neoxify-helper: ignoring {DEV_CONFIG}: {why}"),
            Err(None) => {}
        }
        Self::new(0, apps)
    }

    /// Judges one caller from what the kernel says about it.
    pub fn judge(&self, uid: u32, pid: Option<i32>) -> Caller {
        let exe = pid.and_then(exe_of);
        // Only worth reading for the app; anyone else is decided by uid.
        let standing = if exe.as_deref().is_some_and(|e| self.is_app(e)) {
            Standing {
                at_seat: active_on_a_seat(&self.seats, uid),
                in_group: pid.is_some_and(|p| process_in_group(p, &self.group)),
            }
        } else {
            Standing::default()
        };
        let pid = pid.and_then(|p| u32::try_from(p).ok());
        self.judge_with(uid, pid, exe.as_deref(), standing)
    }

    fn is_app(&self, exe: &Path) -> bool {
        self.apps.iter().any(|app| app == exe)
    }

    pub fn judge_with(&self, uid: u32, pid: Option<u32>, exe: Option<&Path>, standing: Standing) -> Caller {
        let is_app = exe.is_some_and(|exe| self.is_app(exe));
        let allowed = uid == self.trusted_uid || standing.at_seat || standing.in_group;
        let exe_text =
            || exe.map_or_else(|| "an executable that could not be read".to_string(), |e| e.display().to_string());
        match (is_app, pid) {
            (true, Some(pid)) if allowed => Caller::App { pid, uid },
            _ if uid == self.trusted_uid => Caller::Trusted,
            (true, Some(_)) => Caller::Refused {
                who: format!("uid {uid}, {}, neither at this computer's screen nor in the {} group", exe_text(), self.group),
            },
            _ => Caller::Refused { who: format!("uid {uid}, {}", exe_text()) },
        }
    }

    /// True the first time a refused caller is seen.
    pub fn first_refusal(&self, who: &str) -> bool {
        self.logged.lock().map(|mut seen| seen.insert(who.to_owned())).unwrap_or(false)
    }
}

/// The executable of a process. A program replaced on disk while it runs
/// (a package upgrade) reads as "<path> (deleted)"; the path is still the
/// one it was started from, in a directory only root can write, so that
/// is accepted rather than refusing the app until it is restarted.
pub fn exe_of(pid: i32) -> Option<PathBuf> {
    let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let text = link.to_str()?;
    Some(PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(text)))
}

/// Whether `uid` is the active user on any seat: the person at a screen
/// and keyboard of this computer now, as logind records it
/// (`ACTIVE_UID=` in its seat files, what `sd_seat_get_active` reads). A
/// user switched away from, or logged in over SSH, is not. No logind, no
/// seat files: nobody is, and only root and the group are served.
pub fn active_on_a_seat(seats: &Path, uid: u32) -> bool {
    let Ok(entries) = std::fs::read_dir(seats) else { return false };
    entries.filter_map(|e| e.ok()).any(|e| {
        std::fs::read_to_string(e.path()).is_ok_and(|text| seat_active_uid(&text) == Some(uid))
    })
}

/// A seat file's `ACTIVE_UID`.
pub fn seat_active_uid(text: &str) -> Option<u32> {
    text.lines().find_map(|line| line.strip_prefix("ACTIVE_UID=")).and_then(|v| v.trim().parse().ok())
}

/// Whether process `pid` holds `group`, as its effective or a
/// supplementary group. From `/proc/<pid>/status`, the kernel's own
/// record: a process cannot add a group to itself without root.
fn process_in_group(pid: i32, group: &str) -> bool {
    let Some(gid) = std::fs::read_to_string("/etc/group").ok().and_then(|text| gid_of(&text, group)) else {
        return false;
    };
    std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|status| status_has_gid(&status, gid))
}

/// A group's id, from `/etc/group`'s text.
pub fn gid_of(etc_group: &str, group: &str) -> Option<u32> {
    etc_group.lines().find_map(|line| {
        let mut fields = line.split(':');
        (fields.next() == Some(group)).then(|| fields.nth(1)).flatten().and_then(|gid| gid.parse().ok())
    })
}

/// Whether a `/proc/<pid>/status` shows `gid` as the effective group
/// (the second of `Gid:`) or among `Groups:`.
pub fn status_has_gid(status: &str, gid: u32) -> bool {
    status.lines().any(|line| {
        if let Some(ids) = line.strip_prefix("Gid:") {
            ids.split_whitespace().nth(1).and_then(|g| g.parse::<u32>().ok()) == Some(gid)
        } else if let Some(ids) = line.strip_prefix("Groups:") {
            ids.split_whitespace().any(|g| g.parse::<u32>().ok() == Some(gid))
        } else {
            false
        }
    })
}

/// The development allow-list, if there is a trustworthy one.
/// `Err(None)`: no file, the ordinary case. `Err(Some(why))`: a file that
/// is not trusted or not understood, which is worth one log line.
fn read_dev_config(path: &Path) -> Result<Vec<PathBuf>, Option<String>> {
    use std::os::unix::fs::MetadataExt;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(None),
        Err(e) => return Err(Some(e.to_string())),
    };
    let text = if meta.file_type().is_file() { std::fs::read_to_string(path).map_err(|e| Some(e.to_string()))? } else { String::new() };
    accept_config(meta.uid(), meta.mode(), meta.file_type().is_file(), &text).map_err(Some)
}

/// The rules for the development file, apart from reading it.
pub fn accept_config(uid: u32, mode: u32, is_file: bool, text: &str) -> Result<Vec<PathBuf>, String> {
    if !is_file {
        return Err("not a regular file".into());
    }
    if uid != 0 {
        return Err("not owned by root".into());
    }
    if mode & 0o022 != 0 {
        return Err("writable by group or others".into());
    }
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(default)]
        allowed_clients: Vec<String>,
    }
    let file: File = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    Ok(file
        .allowed_clients
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT_SEAT: Standing = Standing { at_seat: true, in_group: false };
    const IN_GROUP: Standing = Standing { at_seat: false, in_group: true };
    const NEITHER: Standing = Standing { at_seat: false, in_group: false };

    #[test]
    fn root_is_trusted_and_not_watched() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        assert_eq!(policy.judge_with(0, Some(10), Some(Path::new("/usr/bin/python3")), NEITHER), Caller::Trusted);
    }

    #[test]
    fn the_app_is_served_when_its_user_is_at_the_screen_or_in_the_group() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        let app = Some(Path::new(APP_PATH));
        assert_eq!(policy.judge_with(1000, Some(42), app, AT_SEAT), Caller::App { pid: 42, uid: 1000 });
        assert_eq!(policy.judge_with(1000, Some(42), app, IN_GROUP), Caller::App { pid: 42, uid: 1000 });
        // Root running the app is still the app: its exit ends its tunnel.
        assert_eq!(policy.judge_with(0, Some(43), app, NEITHER), Caller::App { pid: 43, uid: 0 });
    }

    /// The finding this answers: any local account could start the app
    /// (or preload its own code into it) and own the machine's routing.
    #[test]
    fn the_app_run_by_anyone_else_is_refused() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        let Caller::Refused { who } = policy.judge_with(1001, Some(42), Some(Path::new(APP_PATH)), NEITHER) else {
            panic!("the app was served to a user who is neither at the screen nor in the group");
        };
        assert!(who.contains("uid 1001") && who.contains("group"), "{who}");
    }

    #[test]
    fn anyone_else_is_refused_and_logged_once() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        let Caller::Refused { who } = policy.judge_with(1000, Some(42), Some(Path::new("/usr/bin/curl")), AT_SEAT)
        else {
            panic!("a stranger was served");
        };
        assert!(who.contains("/usr/bin/curl"));
        assert!(policy.first_refusal(&who));
        assert!(!policy.first_refusal(&who));
        assert!(matches!(policy.judge_with(1000, None, None, AT_SEAT), Caller::Refused { .. }));
        // A look-alike path is not the app.
        assert!(matches!(
            policy.judge_with(1000, Some(1), Some(Path::new("/home/user/usr/bin/neoxify")), AT_SEAT),
            Caller::Refused { .. }
        ));
    }

    #[test]
    fn the_seat_and_group_records_are_read_as_logind_and_the_kernel_write_them() {
        let seat = "# This is private data. Do not parse.\nIS_SEAT0=1\nCAN_MULTI_SESSION=1\nACTIVE=2\nACTIVE_UID=1000\nSESSIONS=2\nUIDS=1000\n";
        assert_eq!(seat_active_uid(seat), Some(1000));
        assert_eq!(seat_active_uid("IS_SEAT0=1\nSESSIONS=\n"), None, "a seat at the login screen has nobody at it");

        let dir = std::env::temp_dir().join(format!("nxh-seats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("seat0"), seat).unwrap();
        assert!(active_on_a_seat(&dir, 1000));
        assert!(!active_on_a_seat(&dir, 1001));
        assert!(!active_on_a_seat(Path::new("/nonexistent/seats"), 1000));
        let _ = std::fs::remove_dir_all(&dir);

        let etc_group = "root:x:0:\nneoxifyish:x:998:\nneoxify:x:997:alice\n";
        assert_eq!(gid_of(etc_group, "neoxify"), Some(997));
        assert_eq!(gid_of(etc_group, "absent"), None);
        let status = "Name:\tneoxify\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t4 24 997 1000 \n";
        assert!(status_has_gid(status, 997));
        assert!(status_has_gid(status, 1000), "the effective group counts");
        assert!(!status_has_gid(status, 998));
    }

    #[test]
    fn this_process_reads_its_own_executable() {
        let exe = exe_of(std::process::id() as i32).expect("readable");
        assert_eq!(exe, std::env::current_exe().unwrap());
    }

    #[test]
    fn the_development_file_is_trusted_only_when_root_alone_can_write_it() {
        let json = r#"{"allowed_clients": ["/home/dev/neoxify", "relative/path"]}"#;
        assert_eq!(accept_config(0, 0o100644, true, json), Ok(vec![PathBuf::from("/home/dev/neoxify")]));
        assert!(accept_config(1000, 0o100644, true, json).is_err());
        assert!(accept_config(0, 0o100664, true, json).is_err());
        assert!(accept_config(0, 0o100646, true, json).is_err());
        assert!(accept_config(0, 0o100644, false, json).is_err());
        assert!(accept_config(0, 0o100644, true, "not json").is_err());
        assert!(read_dev_config(Path::new("/nonexistent/neoxify/helper.json")) == Err(None));
    }
}
