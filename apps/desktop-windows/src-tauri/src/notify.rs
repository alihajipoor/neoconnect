//! Windows notifications, for "Notify me when the connection changes".
//!
//! WinRT's toast API, through the `windows` crate that Tauri already
//! builds at this version -- with two of its features switched on -- rather
//! than tauri-plugin-notification: the plugin brings crates for every
//! platform and a capability, and this needs neither.
//!
//! What to say, and when, is decided in the app (lib/connection-notify.ts),
//! in the customer's language and only for a sustained, real change. This
//! only puts the words on screen.
//!
//! Windows shows a desktop app's toast only under an AppUserModelID that a
//! Start-menu shortcut carries. The installer sets the bundle identifier on
//! its shortcuts (`SetLnkAppUserModelId` in installer.nsi), so an installed
//! build shows them; a build run from the source tree has no shortcut and
//! shows none. `notify_setting` says which, and Settings words it.

/// The bundle identifier, which the installer puts on the shortcuts.
pub const APP_ID: &str = "com.neoxify.neoconnect";

/// The longest title and sentence put in a toast. Ours are one line each;
/// the cap only keeps a mistake from making a wall of text.
const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 400;

/// The five characters XML reserves, escaped.
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are not allowed in XML 1.0 at all.
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn clipped(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A language tag Windows accepts on the toast: the two the app speaks.
pub fn toast_lang(lang: Option<&str>) -> &'static str {
    match lang {
        Some(l) if l.starts_with("fa") => "fa-IR",
        _ => "en-US",
    }
}

/// The toast: a title line and one sentence, nothing to press. `lang` lets
/// Windows lay out Persian right to left.
pub fn toast_xml(title: &str, body: &str, lang: &str) -> String {
    format!(
        "<toast><visual lang=\"{lang}\"><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(&clipped(title, MAX_TITLE)),
        escape_xml(&clipped(body, MAX_BODY)),
    )
}

#[cfg(windows)]
fn show(title: &str, body: &str, lang: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let xml = XmlDocument::new().map_err(|err| err.to_string())?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body, lang)))
        .map_err(|err| err.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&xml).map_err(|err| err.to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|err| err.to_string())?;
    notifier.Show(&toast).map_err(|err| err.to_string())
}

#[cfg(not(windows))]
fn show(_title: &str, _body: &str, _lang: &str) -> Result<(), String> {
    Err("only on Windows".into())
}

/// Whether Windows lets this app's toasts show: `"enabled"`,
/// `"disabledForApp"` (the customer turned Neoxify's off in Windows
/// Settings), `"disabledForUser"` (all notifications off), `"disabledByPolicy"`,
/// or `"unknown"` -- among others, a build with no shortcut to show them
/// under.
#[cfg(windows)]
fn setting() -> &'static str {
    use windows::core::HSTRING;
    use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};

    let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID)) else {
        return "unknown";
    };
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => "enabled",
        Ok(NotificationSetting::DisabledForApplication) => "disabledForApp",
        Ok(NotificationSetting::DisabledForUser) => "disabledForUser",
        Ok(NotificationSetting::DisabledByGroupPolicy) => "disabledByPolicy",
        _ => "unknown",
    }
}

#[cfg(not(windows))]
fn setting() -> &'static str {
    "unknown"
}

/// Puts one notification on screen. Synchronous on purpose: Tauri runs a
/// synchronous command on the main thread, which the webview has already
/// initialised for COM, as WinRT activation needs.
#[tauri::command]
pub fn notify_show(title: String, body: String, lang: Option<String>) -> Result<(), String> {
    show(&title, &body, toast_lang(lang.as_deref()))
}

/// See `setting`. Synchronous for the same reason as `notify_show`.
#[tauri::command]
pub fn notify_setting() -> &'static str {
    setting()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_app_says_cannot_break_out_of_the_xml() {
        let xml = toast_xml("A & B <i>", "\"quoted\" it's", "en-US");
        assert!(xml.contains("<text>A &amp; B &lt;i&gt;</text>"), "{xml}");
        assert!(xml.contains("<text>&quot;quoted&quot; it&apos;s</text>"), "{xml}");
        assert_eq!(xml.matches("<text>").count(), 2);
        assert!(!escape_xml("a\u{0}b\u{7}c").contains('\u{0}'));
    }

    #[test]
    fn persian_is_laid_out_as_persian() {
        assert_eq!(toast_lang(Some("fa")), "fa-IR");
        assert_eq!(toast_lang(Some("en")), "en-US");
        assert_eq!(toast_lang(None), "en-US");
        let xml = toast_xml("اتصال قطع شد", "نئوکسیفای", "fa-IR");
        assert!(xml.contains("lang=\"fa-IR\"") && xml.contains("اتصال قطع شد"), "{xml}");
    }

    #[test]
    fn a_long_sentence_is_cut_rather_than_shown_whole() {
        let xml = toast_xml(&"t".repeat(500), &"b".repeat(5000), "en-US");
        assert!(xml.len() < MAX_TITLE + MAX_BODY + 200, "{}", xml.len());
    }

    #[test]
    fn the_app_id_is_the_bundle_identifier_the_shortcuts_carry() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains(&format!("\"identifier\": \"{APP_ID}\"")));
        let installer = include_str!("../installer.nsi");
        assert!(installer.contains("SetLnkAppUserModelId"));
    }
}
