//! The Windows web component the app is drawn in, read once at start.
//!
//! The app is drawn by Microsoft Edge WebView2 Runtime, whichever version
//! Windows has. The stylesheet carries fallbacks down to Chromium 99
//! (scripts/old-engine-css.mjs): everything in it sits inside cascade
//! layers, which arrived in 99, so an engine older than that draws the app
//! unstyled -- a page of raw text and buttons, not a screen anybody could
//! use or trust. Below that floor the main window shows a plain page
//! instead (`public/webview-too-old.html`), which says what is out of date
//! and what to do, in the app's saved language when it can be read.
//!
//! When in doubt the app starts normally: a version that cannot be read, or
//! does not start with a number, is never a reason to hold the app back.
//! Nothing else changes for that page: the service, the heartbeat and the
//! deep-link registration run as always; the page itself dials nothing and
//! says nothing about the connection.

use std::path::PathBuf;

use tauri::Manager;

/// The oldest Chromium the app's stylesheet can draw (cascade layers).
pub const FLOOR_MAJOR: u32 = 99;

/// The page shown below the floor, in the frontend's files (Vite copies
/// `public/` into the build as it is).
pub const PAGE: &str = "webview-too-old.html";

/// The version read at start, for the frontend: the Support diagnostics and
/// the note on a connection report (lib/webview-engine.ts).
pub struct Engine(pub Option<String>);

/// The major version a WebView2 version string starts with: "100" of
/// "100.0.1185.36". None for anything that does not start with a number,
/// and for 0, which no WebView2 Runtime has ever reported.
pub fn major(version: &str) -> Option<u32> {
    let digits: String = version.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u32>() {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

/// Whether the engine is too old to draw the app at all. Only a version
/// that reads as a number below the floor is: unknown is not.
pub fn too_old(version: Option<&str>) -> bool {
    matches!(version.and_then(major), Some(m) if m < FLOOR_MAJOR)
}

/// The version WebView2 reports, if it reports one.
pub fn read() -> Option<String> {
    tauri::webview_version()
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The language the customer chose in the app (lib/i18n.tsx keeps it as
/// "language" in the store file settings.json), if it is one the page has.
fn saved_language(settings: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(settings).ok()?;
    match value.get("language")?.as_str()? {
        "fa" => Some("fa"),
        "en" => Some("en"),
        _ => None,
    }
}

/// The store file the language is in: the plugin resolves its relative
/// paths against the app's data directory.
fn settings_file(dir: Result<PathBuf, tauri::Error>) -> Option<PathBuf> {
    dir.ok().map(|dir| dir.join("settings.json"))
}

/// The page's address: the version found, and the saved language when
/// there is one (without it the page shows both). The version is cut to
/// the characters a version has, so nothing else reaches the address.
pub fn page_path(version: &str, language: Option<&str>) -> String {
    let version: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.')
        .take(40)
        .collect();
    match language {
        Some(lang) => format!("{PAGE}?v={version}&lang={lang}"),
        None => format!("{PAGE}?v={version}"),
    }
}

/// The page to open instead of the app, when the engine is below the
/// floor; None when the app should start as it always does.
pub fn page_for(app: &tauri::App, version: Option<&str>) -> Option<String> {
    if !too_old(version) {
        return None;
    }
    let language = settings_file(app.path().app_data_dir())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| saved_language(&text));
    Some(page_path(version.unwrap_or_default(), language))
}

/// The version read at start, for the frontend. Unknown is None.
#[tauri::command]
pub fn webview_version(state: tauri::State<Engine>) -> Option<String> {
    state.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_major_version_or_nothing() {
        assert_eq!(major("100.0.4896.75"), Some(100));
        assert_eq!(major("157.0.1"), Some(157));
        assert_eq!(major(" 98.0.1108.43 "), Some(98));
        assert_eq!(major("104"), Some(104));
        assert_eq!(major(""), None);
        assert_eq!(major("garbage"), None);
        assert_eq!(major("v100"), None);
        assert_eq!(major("0.0.0.0"), None);
        assert_eq!(major("99999999999999.0"), None);
    }

    #[test]
    fn holds_back_only_a_version_below_the_floor() {
        // Too old to draw the app at all.
        assert!(too_old(Some("98.0.1108.43")));
        assert!(too_old(Some("86.0.622.38")));
        // Drawn: 99 to 104 by the stylesheet's fallbacks, 105 on as is.
        assert!(!too_old(Some("99.0")));
        assert!(!too_old(Some("100.0.4896.75")));
        assert!(!too_old(Some("104")));
        assert!(!too_old(Some("105")));
        assert!(!too_old(Some("157.0.1")));
        // When in doubt, start normally.
        assert!(!too_old(Some("garbage")));
        assert!(!too_old(Some("")));
        assert!(!too_old(Some("0.0.0.0")));
        assert!(!too_old(None));
    }

    #[test]
    fn follows_the_saved_language_when_it_can_be_read() {
        assert_eq!(saved_language(r#"{"language":"fa","theme":"system"}"#), Some("fa"));
        assert_eq!(saved_language(r#"{"language":"en"}"#), Some("en"));
        assert_eq!(saved_language(r#"{"language":"de"}"#), None);
        assert_eq!(saved_language(r#"{"theme":"dark"}"#), None);
        assert_eq!(saved_language("not json"), None);
    }

    #[test]
    fn the_address_carries_only_the_version_and_the_language() {
        assert_eq!(page_path("98.0.1108.43", Some("fa")), "webview-too-old.html?v=98.0.1108.43&lang=fa");
        assert_eq!(page_path("98.0.1108.43", None), "webview-too-old.html?v=98.0.1108.43");
        assert_eq!(page_path("98.0 beta&x=<y>", None), "webview-too-old.html?v=98.0betaxy");
    }

    #[test]
    fn the_page_is_one_the_frontend_ships() {
        let page = include_str!("../../public/webview-too-old.html");
        assert!(page.contains("Microsoft Edge WebView2 Runtime"));
        // Nothing that itself needs a newer engine, and nothing it fetches.
        for needs in ["@layer", "@container", ":has(", "color-mix(", "<link", "src=\"http", "fetch(", "XMLHttpRequest", "@import"] {
            assert!(!page.contains(needs), "the page uses {needs}");
        }
        // And it says nothing about the connection.
        for claim in ["connected", "protected", "VPN", "وصل", "وی‌پی‌ان"] {
            assert!(!page.contains(claim), "the page mentions {claim}");
        }
    }
}
