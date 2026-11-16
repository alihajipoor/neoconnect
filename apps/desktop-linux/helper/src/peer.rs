//! Who may ask the helper anything.
//!
//! The socket is mode 0666 because the app runs as the desktop user, so
//! the kernel's word on who is calling (`SO_PEERCRED`) is the check: root,
//! and any process whose executable is the installed app. The executable
//! is read from `/proc/<pid>/exe`, which the caller cannot forge, and
//! `/usr/bin` is root's, so only root could have put a program there.
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

/// What a caller is, as far as the helper is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// Served, and watched: this is the app, and its exit ends its tunnel.
    App { pid: u32 },
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
    /// Refusals already logged, so a misbehaving caller polling every
    /// second does not fill the journal.
    logged: Mutex<HashSet<String>>,
}

impl Policy {
    pub fn new(trusted_uid: u32, apps: Vec<PathBuf>) -> Self {
        Self { trusted_uid, apps, logged: Mutex::new(HashSet::new()) }
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
        let pid = pid.and_then(|p| u32::try_from(p).ok());
        self.judge_with(uid, pid, exe.as_deref())
    }

    pub fn judge_with(&self, uid: u32, pid: Option<u32>, exe: Option<&Path>) -> Caller {
        let is_app = exe.is_some_and(|exe| self.apps.iter().any(|app| app == exe));
        match (is_app, pid) {
            (true, Some(pid)) => Caller::App { pid },
            _ if uid == self.trusted_uid => Caller::Trusted,
            _ => Caller::Refused {
                who: format!(
                    "uid {uid}, {}",
                    exe.map_or_else(|| "an executable that could not be read".to_string(), |e| e.display().to_string())
                ),
            },
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

    #[test]
    fn root_is_trusted_and_not_watched() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        assert_eq!(policy.judge_with(0, Some(10), Some(Path::new("/usr/bin/python3"))), Caller::Trusted);
    }

    #[test]
    fn the_app_is_served_and_watched_whoever_runs_it() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        assert_eq!(policy.judge_with(1000, Some(42), Some(Path::new(APP_PATH))), Caller::App { pid: 42 });
        // Root running the app is still the app: its exit ends its tunnel.
        assert_eq!(policy.judge_with(0, Some(43), Some(Path::new(APP_PATH))), Caller::App { pid: 43 });
    }

    #[test]
    fn anyone_else_is_refused_and_logged_once() {
        let policy = Policy::new(0, vec![PathBuf::from(APP_PATH)]);
        let Caller::Refused { who } = policy.judge_with(1000, Some(42), Some(Path::new("/usr/bin/curl"))) else {
            panic!("a stranger was served");
        };
        assert!(who.contains("/usr/bin/curl"));
        assert!(policy.first_refusal(&who));
        assert!(!policy.first_refusal(&who));
        assert!(matches!(policy.judge_with(1000, None, None), Caller::Refused { .. }));
        // A look-alike path is not the app.
        assert!(matches!(
            policy.judge_with(1000, Some(1), Some(Path::new("/home/user/usr/bin/neoxify"))),
            Caller::Refused { .. }
        ));
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
