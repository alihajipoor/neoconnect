//! Whatever the app opens -- a link in the browser, the folder of a
//! download -- runs in a systemd scope of its own, not in the app's
//! control group.
//!
//! When "block the internet while reconnecting" is on, the helper moves
//! this app into a group whose connections the hold lets through, and a
//! child process is born into its parent's group. A browser the app
//! started to open a link would therefore be let through the hold too,
//! for as long as it ran, while the customer is told the internet is
//! blocked. The opener plugin starts `xdg-open` by name from `PATH`, so a
//! small `xdg-open` of ours goes first on it and hands the real one to
//! `systemd-run --user --scope`, which asks the user's systemd for a new
//! scope before the program starts. Where the user has no systemd, the
//! real one runs as before.

use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Where the real opener is, from the distribution's xdg-utils.
const REAL_OPENERS: [&str; 2] = ["/usr/bin/xdg-open", "/bin/xdg-open"];

/// The script, for a real opener at `real`.
pub(crate) fn script(real: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Written by the Neoxify app (opener_scope.rs): runs the real opener in a\n\
         # systemd scope of its own, so what it starts is not in the app's group.\n\
         if systemd-run --user --scope --quiet --collect -- true >/dev/null 2>&1; then\n\
         \x20   exec systemd-run --user --scope --quiet --collect -- '{real}' \"$@\"\n\
         fi\n\
         exec '{real}' \"$@\"\n"
    )
}

/// Writes the script into the user's runtime directory and puts its
/// directory first on `PATH`. Called first thing, before any thread starts,
/// since it changes the environment. Nothing is changed when any part of it
/// cannot be done: links then open as they did before.
pub fn install() {
    let Some(real) = REAL_OPENERS.iter().find(|p| Path::new(p).is_file()) else { return };
    let Some(dir) = std::env::var("XDG_RUNTIME_DIR").ok().filter(|d| d.starts_with('/')).map(|d| PathBuf::from(d).join("neoxify-opener"))
    else {
        return;
    };
    if write(&dir, real).is_err() {
        return;
    }
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
    let ours = dir.to_string_lossy().into_owned();
    if !path.split(':').any(|p| p == ours) {
        std::env::set_var("PATH", format!("{ours}:{path}"));
    }
}

fn write(dir: &Path, real: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let temp = dir.join(format!(".xdg-open.{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o700).open(&temp)?;
    std::io::Write::write_all(&mut file, script(real).as_bytes())?;
    drop(file);
    std::fs::rename(&temp, dir.join("xdg-open"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_opener_runs_in_its_own_scope_and_without_one_as_before() {
        let s = script("/usr/bin/xdg-open");
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains("exec systemd-run --user --scope --quiet --collect -- '/usr/bin/xdg-open' \"$@\"\n"));
        assert!(s.ends_with("exec '/usr/bin/xdg-open' \"$@\"\n"), "{s}");
    }

    #[test]
    fn the_script_is_private_and_runnable() {
        let dir = std::env::temp_dir().join(format!("nx-opener-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "/usr/bin/xdg-open").unwrap();
        let mode = std::fs::metadata(dir.join("xdg-open")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
