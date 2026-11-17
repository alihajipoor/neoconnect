//! Bringing the running window forward when a second launch hands it a
//! link.
//!
//! On Wayland a program may not raise its own window; the compositor only
//! focuses a window for an activation token that the launcher (the
//! browser opening a neoconnect:// link, the dock, a file manager) issued
//! to the program it started. That program is the *second* instance,
//! which exits at once, and the single-instance plugin passes on only its
//! arguments, not the environment the token arrives in
//! (`XDG_ACTIVATION_TOKEN`, or `DESKTOP_STARTUP_ID` from older launchers
//! and on X11). So the second instance leaves the token in a file of the
//! user's runtime directory before the plugin runs, and the first reads
//! it in the plugin's callback and gives it to GTK before presenting.

use std::path::PathBuf;
use std::time::Duration;

/// A token left longer ago than this belongs to some earlier launch: the
/// handover takes milliseconds, and compositors expire tokens soon anyway.
const FRESH: Duration = Duration::from_secs(20);

fn channel() -> Option<PathBuf> {
    let dir = std::env::var("XDG_RUNTIME_DIR").ok().filter(|d| d.starts_with('/'))?;
    Some(PathBuf::from(dir).join("neoxify-activation-token"))
}

/// The token this process was started with, if it is one worth passing.
pub(crate) fn token_from_env(xdg: Option<String>, startup_id: Option<String>) -> Option<String> {
    xdg.into_iter().chain(startup_id).map(|t| t.trim().to_string()).find(|t| plausible(t))
}

/// Tokens are opaque, but none is long or contains spaces or control
/// characters; anything else is not passed on to GTK.
fn plausible(token: &str) -> bool {
    !token.is_empty() && token.len() <= 512 && token.chars().all(|c| c.is_ascii_graphic())
}

/// In every instance, before the single-instance plugin: leave the token
/// for the running instance. The first instance removes its own in
/// `forget`, since GTK already used it for its first window.
pub fn leave_for_running_instance() {
    let token = token_from_env(std::env::var("XDG_ACTIVATION_TOKEN").ok(), std::env::var("DESKTOP_STARTUP_ID").ok());
    let (Some(token), Some(path)) = (token, channel()) else { return };
    let _ = write_private(&path, &token);
}

fn write_private(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = path.with_extension(format!("{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(token.as_bytes())?;
    drop(file);
    std::fs::rename(&temp, path)
}

/// In the first instance at start: whatever is in the channel is its own
/// launch's or stale.
pub fn forget() {
    if let Some(path) = channel() {
        let _ = std::fs::remove_file(path);
    }
}

/// In the first instance, from the plugin's callback: the second
/// instance's token, if it left a fresh one. Taken, so it is used once.
pub fn take() -> Option<String> {
    let path = channel()?;
    let age = std::fs::metadata(&path).ok()?.modified().ok()?.elapsed().unwrap_or_default();
    let text = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    let token = text?.trim().to_string();
    (age <= FRESH && plausible(&token)).then_some(token)
}

/// Gives the token to GTK so the next present is allowed to take focus.
/// Must run on the main thread.
///
/// On Wayland that is the display's startup notification id, which GDK
/// hands to the compositor through xdg-activation when the window is
/// presented. The function is looked up at run time rather than linked,
/// so a GTK built without its Wayland backend still runs. On X11 it is
/// the window's startup id, which carries the launch's timestamp.
pub fn apply(window: &tauri::WebviewWindow, token: &str) {
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::{GtkWindowExt, ObjectExt, WidgetExt};

    let Ok(gtk_window) = window.gtk_window() else { return };
    let display = gtk_window.display();
    if display.type_().name() == "GdkWaylandDisplay" {
        type SetId = unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkDisplay, *const std::os::raw::c_char);
        let Ok(c_token) = std::ffi::CString::new(token) else { return };
        // SAFETY: dlsym on the process's own symbols; the signature is
        // GDK's documented one (gdk/wayland/gdkwayland.h, since 3.22), and
        // the display is a live GdkWaylandDisplay, checked just above.
        unsafe {
            let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"gdk_wayland_display_set_startup_notification_id".as_ptr());
            if symbol.is_null() {
                return;
            }
            let set: SetId = std::mem::transmute::<*mut libc::c_void, SetId>(symbol);
            set(display.to_glib_none().0, c_token.as_ptr());
        }
    } else {
        gtk_window.set_startup_id(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wayland_token_is_preferred_and_junk_is_not_passed() {
        assert_eq!(token_from_env(Some("abc_123".into()), Some("x_TIME1".into())).as_deref(), Some("abc_123"));
        assert_eq!(token_from_env(None, Some("launcher-1_TIME42".into())).as_deref(), Some("launcher-1_TIME42"));
        assert_eq!(token_from_env(Some("has space".into()), None), None);
        assert_eq!(token_from_env(Some("".into()), Some("".into())), None);
        assert_eq!(token_from_env(Some("a\nb".into()), None), None);
        assert_eq!(token_from_env(Some("x".repeat(600)), None), None);
    }

    #[test]
    fn a_token_is_handed_over_once() {
        let dir = std::env::temp_dir().join(format!("nx-act-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("neoxify-activation-token");
        write_private(&path, "tok_1").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "tok_1");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
