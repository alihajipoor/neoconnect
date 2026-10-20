//! "Open Neoxify when I sign in to Windows": the current user's Run key.
//!
//! The value is named after the product, `Neoxify`, which is the name the
//! installer's uninstaller already deletes (`installer.nsi`:
//! `DeleteRegValue HKCU "...\Run" "${PRODUCTNAME}"`), so removing the app
//! never leaves a launch behind it. An update keeps it.
//!
//! Read back from Windows every time the app asks, never remembered by the
//! app: the switch in Settings shows what Windows will actually do at the
//! next sign-in. That includes the customer turning Neoxify off in Task
//! Manager's Startup apps, which leaves the Run value in place and marks it
//! disabled under `StartupApproved` -- the switch then reads off, as it is.
//!
//! No plugin: this is two registry values, and the crate already reads the
//! registry (`windows-registry`, for the proxy settings in health_ip.rs).
//! So no capability and no `tauri.conf.json` change is needed for it.

/// The Run value's name: the product name the uninstaller removes.
pub const VALUE_NAME: &str = "Neoxify";

/// Added to the command line Windows runs at sign-in, so the app can tell
/// a launch at sign-in from one the customer made (`launched_at_sign_in`).
pub const LAUNCH_ARG: &str = "--autostart";

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Where Task Manager's Startup apps records an entry switched off.
#[cfg(windows)]
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

/// The command line Windows runs at sign-in: this executable, quoted (it
/// lives under Program Files), and the launch marker.
pub fn command_line(exe: &str) -> String {
    format!("\"{exe}\" {LAUNCH_ARG}")
}

/// Whether a Run value starts this executable. One left by an install in
/// another folder would start nothing, so it counts as off, and switching
/// on replaces it. Windows paths are not case-sensitive.
pub fn names_exe(value: &str, exe: &str) -> bool {
    let exe = exe.trim();
    !exe.is_empty() && value.to_lowercase().contains(&exe.to_lowercase())
}

/// Whether Task Manager lets the Run value run. No flag means allowed.
/// Windows writes twelve bytes whose first is even (02, 06) for an entry
/// switched on and odd (03, 07) for one switched off.
pub fn approved(flag: Option<&[u8]>) -> bool {
    match flag.and_then(|bytes| bytes.first()) {
        None => true,
        Some(first) => first & 1 == 0,
    }
}

#[cfg(windows)]
fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("could not find this program's path: {err}"))
}

/// What Windows will do at the next sign-in.
#[cfg(windows)]
fn read() -> Result<bool, String> {
    let exe = exe_path()?;
    // No key, or no value: nothing starts. Neither is an error.
    let Ok(run) = windows_registry::CURRENT_USER.open(RUN_KEY) else {
        return Ok(false);
    };
    let Ok(value) = run.get_string(VALUE_NAME) else {
        return Ok(false);
    };
    if !names_exe(&value, &exe) {
        return Ok(false);
    }
    let flag = windows_registry::CURRENT_USER
        .open(APPROVED_KEY)
        .ok()
        .and_then(|key| key.get_value(VALUE_NAME).ok());
    Ok(approved(flag.as_deref()))
}

#[cfg(windows)]
fn write(enabled: bool) -> Result<(), String> {
    let run = windows_registry::CURRENT_USER
        .create(RUN_KEY)
        .map_err(|err| format!("could not open the Run key: {err}"))?;
    if enabled {
        let exe = exe_path()?;
        run.set_string(VALUE_NAME, command_line(&exe))
            .map_err(|err| format!("could not write the Run value: {err}"))?;
        // An entry the customer once switched off in Task Manager stays off
        // until that flag goes; they have just asked for it on, here.
        if let Ok(flags) = windows_registry::CURRENT_USER.options().read().write().open(APPROVED_KEY) {
            let _ = flags.remove_value(VALUE_NAME);
        }
    } else {
        // Absent already is off already; what is read back says.
        let _ = run.remove_value(VALUE_NAME);
    }
    Ok(())
}

#[cfg(not(windows))]
fn read() -> Result<bool, String> {
    Err("only on Windows".into())
}

#[cfg(not(windows))]
fn write(_enabled: bool) -> Result<(), String> {
    Err("only on Windows".into())
}

/// Whether Neoxify opens when this user signs in to Windows.
#[tauri::command]
pub fn autostart_state() -> Result<bool, String> {
    read()
}

/// Switches it, and answers with what Windows now says -- not with what
/// was asked for.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    write(enabled)?;
    read()
}

/// Whether this process was started by Windows at sign-in.
#[tauri::command]
pub fn launched_at_sign_in() -> bool {
    std::env::args().any(|arg| arg == LAUNCH_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_line_quotes_the_path_and_carries_the_marker() {
        let line = command_line(r"C:\Program Files\Neoxify\neoconnect-desktop.exe");
        assert_eq!(line, r#""C:\Program Files\Neoxify\neoconnect-desktop.exe" --autostart"#);
    }

    #[test]
    fn a_value_counts_only_when_it_starts_this_executable() {
        let exe = r"C:\Program Files\Neoxify\neoconnect-desktop.exe";
        assert!(names_exe(&command_line(exe), exe));
        // Windows paths are not case-sensitive.
        assert!(names_exe(r#""c:\program files\neoxify\NEOCONNECT-DESKTOP.EXE" --autostart"#, exe));
        // An install in another folder starts nothing of this one's.
        assert!(!names_exe(r#""D:\Old\neoconnect-desktop.exe" --autostart"#, exe));
        assert!(!names_exe("", exe));
        assert!(!names_exe("anything", ""));
    }

    #[test]
    fn task_managers_flag_decides_whether_it_runs() {
        // No flag: allowed.
        assert!(approved(None));
        assert!(approved(Some(&[][..])));
        // What Task Manager writes for on and for off.
        assert!(approved(Some(&[0x02u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][..])));
        assert!(approved(Some(&[0x06u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][..])));
        assert!(!approved(Some(&[0x03u8, 0, 0, 0, 0x5d, 0x1a, 0, 0, 0, 0, 0, 0][..])));
        assert!(!approved(Some(&[0x07u8][..])));
    }

    #[test]
    fn the_value_name_is_the_one_the_uninstaller_deletes() {
        let installer = include_str!("../installer.nsi");
        assert!(installer.contains(r#"DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}""#));
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains(&format!("\"productName\": \"{VALUE_NAME}\"")), "productName must stay {VALUE_NAME}");
    }
}
