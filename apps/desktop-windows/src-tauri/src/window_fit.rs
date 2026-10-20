//! The main window's size, set at runtime rather than in tauri.conf.json
//! (owner decision, 2026-10-19):
//!
//! - on the first launch of the redesign it opens wide, about 1180x760, so
//!   the customer meets the whole layout -- sidebar, hero, locations panel
//!   and tray;
//! - after that it opens at the size it was closed at;
//! - on every launch the window, and its minimum, are clamped to the
//!   monitor's work area: a 1920x1080 laptop at 150% has about 688 logical
//!   pixels above the taskbar, so a 700px window does not fit at all.
//!
//! The window is created from the config before `setup()` runs, so it was
//! seen at the config's 940x700 for about 0.28 s before the resize
//! (observed on the PC, 2026-10-20). It is now created hidden --
//! `start_hidden`, which changes the config the app was built with in
//! memory, in `run()`, and leaves tauri.conf.json alone -- and shown by
//! `fit_main_window` once it has its size and place. Shown whatever
//! happens: a sizing that fails leaves it at the config's size, never
//! hidden.

use std::path::PathBuf;

use tauri::utils::config::WindowConfig;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize};

/// The main window's label (the config's window has none, so it is the
/// default).
const MAIN: &str = "main";

/// The smallest window the layout is designed for (the medium layout).
const MIN_W: f64 = 720.0;
const MIN_H: f64 = 600.0;
/// The first-launch size, at most this share of the work area.
const WIDE_W: f64 = 1180.0;
const WIDE_H: f64 = 760.0;
const SCREEN_SHARE: f64 = 0.9;
/// Room kept around a window clamped to the work area.
const MARGIN: f64 = 16.0;
/// Where the size the window was closed at is kept, in the app's data
/// directory: "width,height" in logical pixels.
const SIZE_FILE: &str = "window-size-v1";

/// A saved "width,height", if it is one.
fn parse_size(text: &str) -> Option<(f64, f64)> {
    let (w, h) = text.trim().split_once(',')?;
    let w: f64 = w.trim().parse().ok()?;
    let h: f64 = h.trim().parse().ok()?;
    (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))
}

/// The size to open at and the minimum, in logical pixels, for a work area
/// of `area` logical pixels: the saved size, or the wide first-launch one,
/// clamped to what fits.
fn opening_size(saved: Option<(f64, f64)>, area: (f64, f64)) -> ((f64, f64), (f64, f64)) {
    let (area_w, area_h) = area;
    let max_w = (area_w - MARGIN).max(1.0);
    let max_h = (area_h - MARGIN).max(1.0);
    let min_w = MIN_W.min(max_w);
    let min_h = MIN_H.min(max_h);
    let (w, h) = saved.unwrap_or((
        WIDE_W.min(area_w * SCREEN_SHARE),
        WIDE_H.min(area_h * SCREEN_SHARE),
    ));
    (
        (w.min(max_w).max(min_w), h.min(max_h).max(min_h)),
        (min_w, min_h),
    )
}

fn size_file(dir: Result<PathBuf, tauri::Error>) -> Option<PathBuf> {
    dir.ok().map(|dir| dir.join(SIZE_FILE))
}

/// Creates the main window hidden: it is shown once `fit_main_window` has
/// sized it, so the config's size is never seen. In memory only -- the
/// config file is not touched.
pub fn start_hidden(windows: &mut [WindowConfig]) {
    for window in windows.iter_mut().filter(|w| w.label == MAIN) {
        window.visible = false;
    }
}

/// Sizes and centres the main window on the monitor it opened on, then
/// shows it -- after the size and the place are set, so the first frame
/// anybody sees is the right one. Any failure in the sizing leaves the
/// window as the config made it, and shows it all the same.
pub fn fit_main_window(app: &tauri::App) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    size_main_window(app, &window);
    let _ = window.show();
}

fn size_main_window(app: &tauri::App, window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    if !(scale.is_finite() && scale > 0.0) {
        return;
    }
    let area = monitor.work_area();
    let logical_area = (
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    );
    let saved = size_file(app.path().app_data_dir())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse_size(&text));
    let ((w, h), (min_w, min_h)) = opening_size(saved, logical_area);
    let _ = window.set_min_size(Some(LogicalSize::new(min_w, min_h)));
    let width = (w * scale).round() as u32;
    let height = (h * scale).round() as u32;
    let _ = window.set_size(PhysicalSize::new(width, height));
    let x = area.position.x + (area.size.width.saturating_sub(width) / 2) as i32;
    let y = area.position.y + (area.size.height.saturating_sub(height) / 2) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Keeps the size the window is closed at, for the next launch. Not when
/// maximized or minimized: that is not a size anybody chose.
pub fn remember_size(window: &tauri::Window) {
    if window.is_maximized().unwrap_or(true) || window.is_minimized().unwrap_or(true) {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if !(scale.is_finite() && scale > 0.0) {
        return;
    }
    let Some(path) = size_file(window.path().app_data_dir()) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        path,
        format!(
            "{:.0},{:.0}",
            size.width as f64 / scale,
            size.height as f64 / scale
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_real_size() {
        assert_eq!(parse_size("1180,760"), Some((1180.0, 760.0)));
        assert_eq!(parse_size(" 940 , 700\n"), Some((940.0, 700.0)));
        assert_eq!(parse_size("1180"), None);
        assert_eq!(parse_size("wide,tall"), None);
        assert_eq!(parse_size("0,700"), None);
        assert_eq!(parse_size("-5,700"), None);
    }

    #[test]
    fn opens_wide_the_first_time_on_a_screen_with_room() {
        let ((w, h), (min_w, min_h)) = opening_size(None, (1920.0, 1040.0));
        assert_eq!((w, h), (1180.0, 760.0));
        assert_eq!((min_w, min_h), (720.0, 600.0));
    }

    #[test]
    fn opens_at_the_size_it_was_closed_at() {
        assert_eq!(
            opening_size(Some((1000.0, 720.0)), (1920.0, 1040.0)).0,
            (1000.0, 720.0)
        );
    }

    #[test]
    fn never_opens_larger_than_the_work_area() {
        // 1920x1080 at 150%: 1280x688 logical above the taskbar.
        let ((w, h), (_, min_h)) = opening_size(Some((1400.0, 900.0)), (1280.0, 688.0));
        assert!(w <= 1280.0 - MARGIN);
        assert!(h <= 688.0 - MARGIN);
        assert!(min_h <= h);
        // First launch there: 90% of the screen, not past it.
        let ((w, h), _) = opening_size(None, (1280.0, 688.0));
        assert!((w - 1152.0).abs() < 1e-6);
        assert!((h - 619.2).abs() < 1e-6);
    }

    #[test]
    fn creates_the_main_window_hidden_and_no_other() {
        let mut windows = vec![WindowConfig::default(), WindowConfig::default()];
        windows[1].label = "other".into();
        assert!(windows.iter().all(|w| w.visible), "a window is visible by default");
        start_hidden(&mut windows);
        assert!(!windows[0].visible, "the main window waits to be sized");
        assert!(windows[1].visible, "only the main window is held back");
    }

    #[test]
    fn lowers_the_minimum_on_a_screen_smaller_than_it() {
        let ((w, h), (min_w, min_h)) = opening_size(None, (700.0, 560.0));
        assert_eq!((min_w, min_h), (684.0, 544.0));
        assert!(w >= min_w && w <= 684.0);
        assert!(h >= min_h && h <= 544.0);
    }
}
