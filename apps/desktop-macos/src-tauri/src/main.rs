// Prevents an additional console window on Windows in release. Kept
// despite this crate only building for macOS: it is inert elsewhere,
// and the line is what every Tauri template carries, so removing it
// invites someone to wonder later whether its absence was deliberate.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_macos_lib::run()
}
