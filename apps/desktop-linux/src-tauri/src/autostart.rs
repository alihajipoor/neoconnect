//! "Open Neoxify when I sign in": an XDG autostart entry,
//! `~/.config/autostart/neoxify.desktop`, which GNOME, KDE, Xfce and the
//! other desktops that follow the XDG autostart spec start at sign-in.
//!
//! Read back from the file every time the app asks, never remembered: the
//! switch shows what the desktop will do at the next sign-in. An entry the
//! person disabled in their desktop's startup settings (`Hidden=true`, or
//! GNOME's `X-GNOME-Autostart-enabled=false`) reads as off, and one left by
//! an install somewhere else, which would start nothing, reads as off too.

use std::path::PathBuf;

const FILE_NAME: &str = "neoxify.desktop";

/// The same marker the Windows Run key carries. Nothing reads it yet; it is
/// written so an entry made today has it when that decision is wired.
const LAUNCH_ARG: &str = "--autostart";

fn autostart_dir() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("autostart"))
}

fn exe() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("could not find this program's own path: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

/// The entry, starting this executable. The path is quoted per the
/// Desktop Entry spec, so a path with a space still works.
fn entry(exe: &str) -> String {
    let quoted = exe.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[Desktop Entry]\nType=Application\nName=Neoxify\nComment=Neoxify VPN\nExec=\"{quoted}\" {LAUNCH_ARG}\nIcon=neoxify\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

/// Whether an entry's text would start `exe` at sign-in.
fn starts(text: &str, exe: &str) -> bool {
    let mut names_exe = false;
    let mut enabled = true;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Exec=") {
            names_exe = !exe.is_empty() && value.contains(exe);
        } else if line.eq_ignore_ascii_case("Hidden=true") || line.eq_ignore_ascii_case("X-GNOME-Autostart-enabled=false") {
            enabled = false;
        }
    }
    names_exe && enabled
}

fn read() -> Result<bool, String> {
    let Some(path) = autostart_dir().map(|d| d.join(FILE_NAME)) else {
        return Ok(false);
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(starts(&text, &exe()?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

fn write(enabled: bool) -> Result<(), String> {
    let dir = autostart_dir().ok_or("no home directory to put the autostart entry in")?;
    let path = dir.join(FILE_NAME);
    if enabled {
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        std::fs::write(&path, entry(&exe()?)).map_err(|e| format!("could not write {}: {e}", path.display()))
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove {}: {e}", path.display())),
        }
    }
}

/// Whether Neoxify opens when this user signs in.
#[tauri::command]
pub fn autostart_state() -> Result<bool, String> {
    read()
}

/// Switches it, and answers with what the file now says, not with what was
/// asked for.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    write(enabled)?;
    read()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_written_reads_back_as_starting_this_program() {
        let text = entry("/usr/bin/neoxify");
        assert!(text.contains("Exec=\"/usr/bin/neoxify\" --autostart"), "{text}");
        assert!(starts(&text, "/usr/bin/neoxify"));
    }

    #[test]
    fn an_entry_for_another_install_or_switched_off_is_off() {
        let text = entry("/opt/elsewhere/neoxify");
        assert!(!starts(&text, "/usr/bin/neoxify"));
        let hidden = format!("{}Hidden=true\n", entry("/usr/bin/neoxify"));
        assert!(!starts(&hidden, "/usr/bin/neoxify"));
        let gnome_off = entry("/usr/bin/neoxify").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false");
        assert!(!starts(&gnome_off, "/usr/bin/neoxify"));
    }
}
