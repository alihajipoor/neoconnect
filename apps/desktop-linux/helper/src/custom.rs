//! Custom mode's requests, checked and translated for Linux.
//!
//! The wire carries the Windows config (`SplitTunnelConfig`), whose own
//! `validate()` is Windows-shaped -- a drive letter, `.exe` -- and would
//! refuse every Linux program, so it is never called here. Each app is
//! checked with the tunnel crate's own rule instead (`valid_app`), the one
//! that matches what root reads from `/proc`. There is no game catalogue
//! and no per-game exit on Linux: that data names Windows programs. Scopes
//! and exits are accepted and ignored; the egress is only remembered.

use std::collections::BTreeMap;

use neoconnect_ipc::{RunningApp, SplitTunnelConfig, SplitTunnelMode};
use neoxify_tunnel::{Running, Shape};

/// The most apps one config may name, as on Windows.
pub const MAX_APPS: usize = 64;

/// The shape a config asks for, or why it is refused. On with nothing
/// chosen is the toggle turned on before anything is picked, and changes
/// nothing, as on Windows (`wants_passive_tunnel`).
pub fn shape_of(config: &SplitTunnelConfig, valid_app: impl Fn(&str) -> Result<(), String>) -> Result<Shape, String> {
    if !config.enabled {
        return Ok(Shape::Full);
    }
    if config.apps.len() > MAX_APPS {
        return Err(format!("Custom mode can carry at most {MAX_APPS} apps"));
    }
    let mut apps: Vec<String> = Vec::new();
    for app in &config.apps {
        valid_app(app).map_err(|why| format!("an app in the Custom mode list was refused: {why}"))?;
        if !apps.contains(app) {
            apps.push(app.clone());
        }
    }
    if apps.is_empty() {
        return Ok(Shape::Full);
    }
    Ok(match config.mode {
        SplitTunnelMode::OnlySelected => Shape::OnlySelected(apps),
        SplitTunnelMode::AllExcept => Shape::AllExcept(apps),
    })
}

/// One entry per program, every process of it listed, sorted by name.
/// No icon: the app finds names and icons from the desktop's own files.
pub fn group_running(processes: Vec<Running>) -> Vec<RunningApp> {
    let mut by_app: BTreeMap<String, RunningApp> = BTreeMap::new();
    for p in processes {
        let entry = by_app.entry(p.app.clone()).or_insert_with(|| RunningApp {
            path: p.app.clone(),
            name: p.name.clone(),
            paths: vec![p.app.clone()],
            icon: None,
            pids: Vec::new(),
        });
        if !entry.pids.contains(&p.pid) {
            entry.pids.push(p.pid);
        }
    }
    let mut apps: Vec<RunningApp> = by_app.into_values().collect();
    for app in &mut apps {
        app.pids.sort_unstable();
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux_rule(app: &str) -> Result<(), String> {
        if app.starts_with('/') && !app.contains('\n') {
            Ok(())
        } else {
            Err(format!("{app:?} is not a program's full path"))
        }
    }

    fn config(enabled: bool, mode: SplitTunnelMode, apps: &[&str]) -> SplitTunnelConfig {
        SplitTunnelConfig { enabled, mode, apps: apps.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn a_linux_path_is_accepted_where_the_windows_rules_would_refuse_it() {
        let c = config(true, SplitTunnelMode::OnlySelected, &["/usr/bin/firefox", "/usr/bin/firefox"]);
        assert!(c.validate().is_err(), "the Windows rules accept a Linux path; this test no longer proves anything");
        assert_eq!(shape_of(&c, linux_rule), Ok(Shape::OnlySelected(vec!["/usr/bin/firefox".into()])));
        let c = config(true, SplitTunnelMode::AllExcept, &["/usr/bin/curl"]);
        assert_eq!(shape_of(&c, linux_rule), Ok(Shape::AllExcept(vec!["/usr/bin/curl".into()])));
    }

    #[test]
    fn off_or_on_with_nothing_chosen_is_the_ordinary_tunnel() {
        assert_eq!(shape_of(&config(false, SplitTunnelMode::OnlySelected, &["relative"]), linux_rule), Ok(Shape::Full));
        assert_eq!(shape_of(&config(true, SplitTunnelMode::OnlySelected, &[]), linux_rule), Ok(Shape::Full));
    }

    #[test]
    fn a_bad_app_or_too_many_is_refused() {
        let refused = shape_of(&config(true, SplitTunnelMode::OnlySelected, &["firefox"]), linux_rule).unwrap_err();
        assert!(refused.contains("refused"), "{refused}");
        let many: Vec<String> = (0..=MAX_APPS).map(|i| format!("/usr/bin/app{i}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(shape_of(&config(true, SplitTunnelMode::OnlySelected, &many), linux_rule).unwrap_err().contains("at most"));
    }

    #[test]
    fn processes_are_grouped_by_program_and_sorted_by_name() {
        let p = |pid, app: &str, name: &str| Running { pid, app: app.into(), name: name.into() };
        let apps = group_running(vec![
            p(30, "/usr/bin/zed", "zed"),
            p(12, "/usr/lib/firefox/firefox", "firefox"),
            p(11, "/usr/lib/firefox/firefox", "firefox"),
            p(12, "/usr/lib/firefox/firefox", "firefox"),
        ]);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].path, "/usr/lib/firefox/firefox");
        assert_eq!(apps[0].pids, vec![11, 12]);
        assert_eq!(apps[0].paths, vec!["/usr/lib/firefox/firefox".to_string()]);
        assert!(apps[0].icon.is_none());
        assert_eq!(apps[1].name, "zed");
    }
}
