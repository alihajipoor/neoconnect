//! Desktop notifications, for "Notify me when the connection changes".
//!
//! Sent over D-Bus to the desktop's notification server
//! (org.freedesktop.Notifications) through notify-rust's pure-Rust zbus
//! backend, so no C library is needed beyond what WebKitGTK brings. What to
//! say, and when, is decided in the app (lib/connection-notify.ts); this
//! only puts the words on screen.

/// The longest title and sentence shown. Ours are one line each; the cap
/// only keeps a mistake from making a wall of text.
const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 400;

fn clipped(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Many notification servers render a subset of HTML in the body, so the
/// app's words are escaped rather than trusted to contain no markup.
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Puts one notification on screen. `lang` is accepted for the Windows
/// signature; the notification server lays text out by its own script.
#[tauri::command]
pub async fn notify_show(title: String, body: String, lang: Option<String>) -> Result<(), String> {
    let _ = lang;
    let title = clipped(&title, MAX_TITLE);
    let body = escape_markup(&clipped(&body, MAX_BODY));
    // Blocking D-Bus round trip, off Tauri's async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        notify_rust::Notification::new()
            .appname("Neoxify")
            .summary(&title)
            .body(&body)
            .icon("neoxify")
            .show()
            .map(|_| ())
            .map_err(|e| format!("could not show a notification: {e}"))
    })
    .await
    .map_err(|e| format!("could not show a notification: {e}"))?
}

/// Whether notifications can show. Linux has no per-application switch an
/// app can read, so "enabled" when a notification server answers on the
/// session bus and "unknown" otherwise, which Settings words as such.
#[tauri::command]
pub async fn notify_setting() -> &'static str {
    tauri::async_runtime::spawn_blocking(|| match notify_rust::get_server_information() {
        Ok(_) => "enabled",
        Err(_) => "unknown",
    })
    .await
    .unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_in_what_the_app_says_is_shown_as_text() {
        assert_eq!(escape_markup("A & B <b>"), "A &amp; B &lt;b&gt;");
    }

    #[test]
    fn a_long_sentence_is_cut() {
        assert_eq!(clipped(&"b".repeat(5000), MAX_BODY).len(), MAX_BODY);
    }
}
