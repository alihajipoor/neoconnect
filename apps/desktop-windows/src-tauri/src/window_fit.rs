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
//! The window was created from the config before `setup()` runs, so it was
//! seen at the config's 940x700 for about 0.28 s before the resize
//! (observed on the PC, 2026-10-20). It was then created hidden, and sized
//! and placed before it was shown -- and still, in 3 of 13 launches on the
//! VM, it appeared at the config's centred place and moved 0.12-0.39 s
//! later (9x26 px at 1024x768, 120x30 px at 1920x955): the size had taken,
//! the move had not. Why is not proven. `SWP_ASYNCWINDOWPOS` (tao's flag for
//! a move or resize) was the first guess, and a doubtful one: `setup()`
//! runs on the window's own thread, where that flag changes nothing.
//! Whatever the cause, a window that is never moved cannot be seen to move,
//! and that stays unverified until the VM's 13-launch run (1024x768 and
//! 1920x955 at 100%, one at 150%) shows none.
//!
//! So the main window is no longer created from the config before
//! `setup()` (`defer_main_window`, which changes the config the app was
//! built with in memory, in `run()`, and leaves tauri.conf.json alone).
//! `setup()` creates it (`create_main_window`) from that same config with
//! its size, minimum and place already in it: the window's very first
//! rectangle is the right one, and nothing moves it after. Hidden until it
//! is painted, and shown whatever happens: a sizing that cannot be worked
//! out creates it as the config says, centred, and shows it all the same.

use std::path::PathBuf;

use tauri::utils::config::{Color, WindowConfig};
use tauri::Manager;

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

/// Leaves the main window for `setup()` to create (`create_main_window`):
/// Tauri creates every window the config lists before `setup()` runs,
/// before anything here can ask about a monitor. Hidden as well, for
/// anything that creates it from the config after all. In memory only --
/// the config file is not touched.
pub fn defer_main_window(windows: &mut [WindowConfig]) {
    for window in windows.iter_mut().filter(|w| w.label == MAIN) {
        window.create = false;
        window.visible = false;
    }
}

/// Where the main window opens and how large, in logical pixels, and the
/// smallest it may be made.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Opening {
    size: (f64, f64),
    min: (f64, f64),
    position: (f64, f64),
}

/// The opening size (`opening_size`), centred in a monitor's work area of
/// `area_size` physical pixels at `area_at`, at `scale`: worked out in
/// physical pixels, as the window will stand, and handed over in logical
/// ones, as the config takes them.
fn opening(saved: Option<(f64, f64)>, area_at: (i32, i32), area_size: (u32, u32), scale: f64) -> Opening {
    let logical_area = (area_size.0 as f64 / scale, area_size.1 as f64 / scale);
    let ((w, h), min) = opening_size(saved, logical_area);
    let width = (w * scale).round() as u32;
    let height = (h * scale).round() as u32;
    let x = area_at.0 + (area_size.0.saturating_sub(width) / 2) as i32;
    let y = area_at.1 + (area_size.1.saturating_sub(height) / 2) as i32;
    Opening {
        size: (w, h),
        min,
        position: (x as f64 / scale, y as f64 / scale),
    }
}

/// The config's main window with its opening size, minimum and place in it,
/// hidden, and not centred again: the place is the centre already -- of the
/// work area, not the whole screen. Without an opening, the config as it
/// is, hidden.
fn placed(config: &WindowConfig, at: Option<Opening>) -> WindowConfig {
    let mut config = config.clone();
    config.create = true;
    config.visible = false;
    if let Some(at) = at {
        config.width = at.size.0;
        config.height = at.size.1;
        config.min_width = Some(at.min.0);
        config.min_height = Some(at.min.1);
        config.x = Some(at.position.0);
        config.y = Some(at.position.1);
        config.center = false;
    }
    config
}

/// Creates the main window at its size and place on the monitor the
/// customer is working on (`opening_monitor`), then shows it, painted the
/// theme's base colour first. Created there rather than created and then
/// moved: the first rectangle Windows draws it in is the right one. With no
/// monitor or scale to work from, it is created as the config says.
pub fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == MAIN).cloned() else {
        return Ok(());
    };
    let config = placed(&config, main_opening(app));
    let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
    paint_base(&window);
    let _ = window.show();
    Ok(())
}

/// The opening on the monitor the customer is working on: the saved size,
/// or the wide first launch, clamped to its work area and centred in it.
fn main_opening(app: &tauri::App) -> Option<Opening> {
    let monitor = opening_monitor(app)?;
    let scale = monitor.scale_factor();
    if !(scale.is_finite() && scale > 0.0) {
        return None;
    }
    let area = monitor.work_area();
    let saved = size_file(app.path().app_data_dir())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse_size(&text));
    Some(opening(
        saved,
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        scale,
    ))
}

/// The monitor to open on: the one under the pointer as the app starts --
/// launched from a second screen's taskbar or Start menu, it opens there,
/// as Windows' own centring did -- or else the primary one. Not the primary
/// always: that took a launch from a second screen to the first.
fn opening_monitor(app: &tauri::App) -> Option<tauri::Monitor> {
    let under_pointer = || {
        let at = app.cursor_position().ok()?;
        app.monitor_from_point(at.x, at.y).ok().flatten()
    };
    first_found(under_pointer, || app.primary_monitor().ok().flatten())
}

/// The first of two that is found, the second asked only when the first is
/// not.
fn first_found<T>(first: impl FnOnce() -> Option<T>, then: impl FnOnce() -> Option<T>) -> Option<T> {
    first().or_else(then)
}

/// The theme's base colour (theme.css `--base`), Pearl and Smoked.
const BASE_LIGHT: Color = Color(0xf1, 0xf3, 0xf6, 255);
const BASE_DARK: Color = Color(0x0b, 0x0e, 0x15, 255);

/// The window is shown before the page has painted, and until it has, the
/// first frame is the webview's own background -- white, for somebody whose
/// Windows is dark. Painted the theme's base colour first, by the system's
/// theme, which the app follows unless told otherwise (unverified on
/// hardware; check on the PC and the VM, light and dark). A failure leaves
/// the default: the window is shown either way.
fn paint_base(window: &tauri::WebviewWindow) {
    let base = match window.theme() {
        Ok(tauri::Theme::Dark) => BASE_DARK,
        _ => BASE_LIGHT,
    };
    let _ = window.set_background_color(Some(base));
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
    fn leaves_the_main_window_to_setup_and_no_other() {
        let mut windows = vec![WindowConfig::default(), WindowConfig::default()];
        windows[1].label = "other".into();
        assert!(windows.iter().all(|w| w.create && w.visible), "a window is created, visible, by default");
        defer_main_window(&mut windows);
        assert!(!windows[0].create, "setup creates the main window, at its size and place");
        assert!(!windows[0].visible, "and it waits to be shown");
        assert!(windows[1].create && windows[1].visible, "only the main window is held back");
    }

    /// The VM's launches, at 100%: a 1024x768 screen (work area 1024x720),
    /// and a 1920x955 one with a saved 1180x760. The window opened where the
    /// config's 940x700 was centred and moved 9x26 and 120x30 px a moment
    /// later; it is now created where it ends up.
    #[test]
    fn opens_where_it_ends_up_centred_in_the_work_area() {
        let small = opening(None, (0, 0), (1024, 720), 1.0);
        // 90% of the work area's width, 922 px as the window stands.
        assert!((small.size.0 - 921.6).abs() < 1e-6 && small.size.1 == 648.0);
        assert_eq!(small.position, (51.0, 36.0));
        let saved = opening(Some((1180.0, 760.0)), (0, 0), (1920, 955), 1.0);
        assert_eq!(saved.position, (370.0, 97.0));
        // Not where the config's own centring put it first.
        assert_ne!(small.position, ((1024.0 - 940.0) / 2.0, (720.0 - 700.0) / 2.0));
    }

    #[test]
    fn places_it_in_logical_pixels_on_a_scaled_screen_and_off_the_origin() {
        // 1920x1080 at 150%, a 48 px taskbar: 1280x688 logical.
        let at = opening(None, (0, 0), (1920, 1032), 1.5);
        assert!((at.size.0 - 1152.0).abs() < 1e-6);
        let (w, h) = ((at.size.0 * 1.5).round(), (at.size.1 * 1.5).round());
        // Centred in physical pixels, as the window stands.
        assert!((at.position.0 * 1.5 - ((1920.0 - w) / 2.0).floor()).abs() < 1.0);
        assert!((at.position.1 * 1.5 - ((1032.0 - h) / 2.0).floor()).abs() < 1.0);
        // A primary monitor that does not start at the origin.
        let moved = opening(Some((1000.0, 700.0)), (-1920, 40), (1920, 1040), 1.0);
        assert_eq!(moved.position, (-1920.0 + 460.0, 40.0 + 170.0));
    }

    #[test]
    fn the_window_is_created_with_its_size_minimum_and_place_and_not_centred_again() {
        let mut config = WindowConfig::default();
        config.label = MAIN.into();
        config.center = true;
        config.width = 940.0;
        config.height = 700.0;
        config.create = false;
        let made = placed(&config, Some(opening(None, (0, 0), (1024, 720), 1.0)));
        assert!((made.width - 921.6).abs() < 1e-6 && made.height == 648.0);
        assert_eq!((made.x, made.y), (Some(51.0), Some(36.0)));
        assert_eq!((made.min_width, made.min_height), (Some(720.0), Some(600.0)));
        assert!(!made.center, "centred again, it would ignore the place");
        assert!(!made.visible, "shown only once it is painted");
        assert!(made.create);
        // With nothing to work from: the config's own size, centred.
        let plain = placed(&config, None);
        assert_eq!((plain.width, plain.height, plain.x, plain.center), (940.0, 700.0, None, true));
        assert!(!plain.visible);
    }

    /// The monitor under the pointer, when there is one; the primary only
    /// when there is not -- and then only asked.
    #[test]
    fn opens_on_the_monitor_under_the_pointer_else_the_primary() {
        assert_eq!(first_found(|| Some("second screen"), || panic!("the primary asked for")), Some("second screen"));
        assert_eq!(first_found(|| None, || Some("primary")), Some("primary"));
        assert_eq!(first_found::<&str>(|| None, || None), None);
        let source = include_str!("window_fit.rs");
        let opening = &source[source.find("fn main_opening(").expect("main_opening")..];
        let opening = &opening[..opening.find("\n}\n").expect("its end")];
        assert!(opening.contains("let monitor = opening_monitor(app)?;"), "{opening}");
        assert!(!opening.contains("primary_monitor"), "the primary monitor, whatever screen the app was launched from");
    }

    #[test]
    fn lowers_the_minimum_on_a_screen_smaller_than_it() {
        let ((w, h), (min_w, min_h)) = opening_size(None, (700.0, 560.0));
        assert_eq!((min_w, min_h), (684.0, 544.0));
        assert!(w >= min_w && w <= 684.0);
        assert!(h >= min_h && h <= 544.0);
    }
}
