//! Repair and Diagnostics.
//!
//! Repair is the Windows service's (`engines/repair.rs`) in shape: named
//! steps in a fixed order, each with one of four outcomes, and a look at
//! the machine *before* anything is touched, so the report says what was
//! really found rather than what a sweep claimed. The steps are Linux's
//! own: tunnel, engines, dns, routes, firewall, links, groups.
//!
//! The order things are undone in is not the order they are reported in:
//! the sweep (engines, routes, DNS, links) goes first and the firewall
//! table last, because that table is what blocks leaks while the rest goes.

use neoconnect_ipc::{RepairOutcome, RepairReport};
use neoxify_linux_wire::{LinkPresence, LinuxDiagnostics, PackageKind, ProgramPresence};
use neoxify_tunnel::Dirs;

use crate::backend::Backend;
use crate::hold::OUR_LINKS;
use crate::machine::{self, Survey};

pub const STEPS: [(&str, &str); 7] = [
    ("tunnel", "Disconnect the tunnel"),
    ("engines", "Stop leftover VPN engines"),
    ("dns", "Restore the DNS settings"),
    ("routes", "Remove leftover routes and routing rules"),
    ("firewall", "Remove leftover firewall rules"),
    ("links", "Remove leftover network interfaces"),
    ("groups", "Clear Custom mode's program groups"),
];

/// What the clearing itself returned, beside the two looks.
#[derive(Debug, Clone, Default)]
pub struct Acts {
    /// The firewall table's removal, and Custom mode's.
    pub firewall: Option<String>,
    pub split_table: Option<String>,
    pub groups: Option<String>,
}

/// Clears everything of ours a session would leave, looking first and
/// after. `tunnel` is the first step's outcome, which the caller decided
/// (it is the one that disconnects).
pub fn clear(backend: &dyn Backend, dirs: &Dirs, tunnel: RepairOutcome) -> RepairReport {
    let before = backend.survey(dirs);
    for line in backend.sweep_leftovers(dirs) {
        crate::say!("neoxify-helper: repair: {line}");
    }
    let mut acts = Acts::default();
    if let Err(e) = backend.guard_remove() {
        acts.firewall = Some(e.to_string());
    }
    if let Err(e) = backend.remove_split_table() {
        acts.split_table = Some(e);
    }
    if let Err(e) = backend.remove_empty_groups() {
        acts.groups = Some(e);
    }
    let after = backend.survey(dirs);
    let report = report(tunnel, &before, &after, &acts);
    for step in &report.steps {
        if step.outcome != RepairOutcome::AlreadyClean {
            crate::say!("neoxify-helper: repair: {}: {:?}", step.id, step.outcome);
        }
    }
    report
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Before and after a count: nothing either time is clean; something that
/// went is fixed; something left is a failure; a look that failed says
/// nothing, and is never counted clean.
fn compare(before: Option<u32>, after: Option<u32>, fixed: impl FnOnce(u32) -> String, failed: impl FnOnce(u32) -> String) -> RepairOutcome {
    match (before, after) {
        (_, None) => RepairOutcome::Unknown { detail: "could not look whether anything is left".to_string() },
        (Some(0), Some(0)) => RepairOutcome::AlreadyClean,
        (None, Some(0)) => {
            RepairOutcome::Unknown { detail: "could not look before clearing; nothing of ours is there now".to_string() }
        }
        (Some(b), Some(0)) => RepairOutcome::Fixed { detail: fixed(b) },
        (_, Some(a)) => RepairOutcome::Failed { detail: failed(a) },
    }
}

fn add(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    Some(a? + b?)
}

fn tables(s: &Survey) -> Option<u32> {
    Some(u32::from(s.firewall?) + u32::from(s.split_table?))
}

pub fn report(tunnel: RepairOutcome, before: &Survey, after: &Survey, acts: &Acts) -> RepairReport {
    let mut report = RepairReport::default();
    fn label(id: &'static str) -> &'static str {
        STEPS.iter().find(|(i, _)| *i == id).map(|(_, l)| *l).unwrap_or(id)
    }
    report.push("tunnel", label("tunnel"), tunnel);

    report.push(
        "engines",
        label("engines"),
        compare(
            before.engines,
            after.engines,
            |n| format!("stopped {}", plural(n, "leftover engine", "leftover engines")),
            |n| format!("{} of ours still running", plural(n, "engine is", "engines are")),
        ),
    );
    report.push(
        "dns",
        label("dns"),
        compare(
            before.dns,
            after.dns,
            |n| format!("undid {}", plural(n, "DNS change of ours", "DNS changes of ours")),
            |n| format!("{} could not be undone", plural(n, "DNS change of ours", "DNS changes of ours")),
        ),
    );
    report.push(
        "routes",
        label("routes"),
        compare(
            add(before.routes, before.rules),
            add(after.routes, after.rules),
            |n| format!("removed {}", plural(n, "route or rule of ours", "routes and rules of ours")),
            |n| format!("{} still there", plural(n, "route or rule of ours is", "routes and rules of ours are")),
        ),
    );
    let firewall = match compare(
        tables(before),
        tables(after),
        |n| format!("removed {}", plural(n, "firewall table of ours", "firewall tables of ours")),
        |n| format!("{} still there", plural(n, "firewall table of ours is", "firewall tables of ours are")),
    ) {
        RepairOutcome::Failed { detail } => {
            let why: Vec<String> = [&acts.firewall, &acts.split_table].into_iter().flatten().cloned().collect();
            RepairOutcome::Failed { detail: if why.is_empty() { detail } else { format!("{detail}: {}", why.join("; ")) } }
        }
        other => other,
    };
    report.push("firewall", label("firewall"), firewall);
    let len = |s: &Survey| s.links.as_ref().map(|l| l.len() as u32);
    report.push(
        "links",
        label("links"),
        compare(
            len(before),
            len(after),
            |n| format!("removed {}", plural(n, "interface of ours", "interfaces of ours")),
            |n| {
                let names = after.links.clone().unwrap_or_default().join(", ");
                format!("{} still there ({names})", plural(n, "interface of ours is", "interfaces of ours are"))
            },
        ),
    );
    report.push("groups", label("groups"), groups(before, after, acts));
    report
}

/// The groups step. The app's own group holding the app is how the hold
/// is meant to look while the app runs, so it is not a leftover; Custom
/// mode's group still holding programs once the tunnel is down is said as
/// it is -- those programs are not routed differently any more, and are
/// not ours to move.
fn groups(before: &Survey, after: &Survey, acts: &Acts) -> RepairOutcome {
    let leftovers = |s: &Survey| -> Option<Vec<(String, u32)>> {
        Some(s.groups.clone()?.into_iter().filter(|(name, procs)| !(name == "neoxify.app" && *procs > 0)).collect())
    };
    let (Some(before), Some(after)) = (leftovers(before), leftovers(after)) else {
        return RepairOutcome::Unknown { detail: "could not read the control groups".to_string() };
    };
    if let Some(why) = &acts.groups {
        return RepairOutcome::Failed { detail: format!("a control group of ours could not be removed: {why}") };
    }
    if before.is_empty() {
        return RepairOutcome::AlreadyClean;
    }
    let busy: u32 = after.iter().map(|(_, procs)| *procs).sum();
    if busy > 0 {
        return RepairOutcome::Unknown {
            detail: format!(
                "{} still in Custom mode's group; with the tunnel down they use the ordinary connection, and leave it when restarted",
                plural(busy, "program is", "programs are")
            ),
        };
    }
    if after.is_empty() {
        RepairOutcome::Fixed { detail: format!("removed {}", plural(before.len() as u32, "empty group", "empty groups")) }
    } else {
        RepairOutcome::Failed { detail: "an empty group of ours is still there".to_string() }
    }
}

/// What the Support screen shows: counts and names, never an address, a
/// key or a user's path.
pub fn diagnostics(backend: &dyn Backend, dirs: &Dirs, session_live: bool, package: Option<PackageKind>) -> LinuxDiagnostics {
    let survey = backend.survey(dirs);
    let links = survey.links.clone().unwrap_or_default();
    LinuxDiagnostics {
        helper_version: crate::VERSION.to_string(),
        package,
        our_links: OUR_LINKS.iter().map(|n| LinkPresence { name: n.to_string(), present: links.iter().any(|l| l == n) }).collect(),
        other_vpns_up: machine::other_vpns_up(),
        our_routes: survey.routes.unwrap_or(0),
        our_rules: survey.rules.unwrap_or(0),
        firewall_table: survey.firewall.unwrap_or(false),
        split_table: survey.split_table.unwrap_or(false),
        dns_mode: machine::dns_mode().to_string(),
        dns_pointed_at_us: survey.dns.is_some_and(|n| n > 0),
        orphaned_engines: survey.engines.unwrap_or(0).saturating_sub(u32::from(session_live)),
        owed: survey.owed.unwrap_or(0),
        control_groups: machine::control_groups(),
        programs: machine::programs(dirs).into_iter().map(|(name, present)| ProgramPresence { name, present }).collect(),
        recent_log: crate::log::recent(),
    }
}

/// The lines `neoxify-helper repair` prints, one per step.
pub fn lines(report: &RepairReport) -> Vec<String> {
    report
        .steps
        .iter()
        .map(|s| {
            let (mark, detail) = match &s.outcome {
                RepairOutcome::AlreadyClean => ("[ok]   ", None),
                RepairOutcome::Fixed { detail } => ("[FIXED]", Some(detail)),
                RepairOutcome::Failed { detail } => ("[FAIL] ", Some(detail)),
                RepairOutcome::Unknown { detail } => ("[????] ", Some(detail)),
            };
            match detail {
                Some(d) => format!("{mark} {}: {d}", s.label),
                None => format!("{mark} {}", s.label),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean() -> Survey {
        Survey {
            engines: Some(0),
            dns: Some(0),
            routes: Some(0),
            rules: Some(0),
            firewall: Some(false),
            split_table: Some(false),
            links: Some(Vec::new()),
            groups: Some(Vec::new()),
            owed: Some(0),
        }
    }

    #[test]
    fn steps_come_in_the_fixed_order_and_a_clean_machine_is_clean() {
        let r = report(RepairOutcome::AlreadyClean, &clean(), &clean(), &Acts::default());
        let ids: Vec<&str> = r.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["tunnel", "engines", "dns", "routes", "firewall", "links", "groups"]);
        assert!(r.steps.iter().all(|s| s.outcome == RepairOutcome::AlreadyClean), "{r:?}");
    }

    #[test]
    fn what_was_found_and_went_is_fixed_and_what_stayed_failed() {
        let before = Survey {
            engines: Some(2),
            routes: Some(3),
            rules: Some(1),
            firewall: Some(true),
            links: Some(vec!["neoxify-wg".into()]),
            ..clean()
        };
        let after = Survey { links: Some(vec!["neoxify-wg".into()]), firewall: Some(true), ..clean() };
        let acts = Acts { firewall: Some("nftables refused the rules: busy".into()), ..Default::default() };
        let r = report(RepairOutcome::AlreadyClean, &before, &after, &acts);
        let step = |id: &str| r.steps.iter().find(|s| s.id == id).unwrap().outcome.clone();
        assert!(matches!(step("engines"), RepairOutcome::Fixed { detail } if detail.contains("2 leftover engines")));
        assert!(matches!(step("routes"), RepairOutcome::Fixed { detail } if detail.contains("4 routes")));
        assert!(matches!(step("firewall"), RepairOutcome::Failed { detail } if detail.contains("busy")));
        assert!(matches!(step("links"), RepairOutcome::Failed { detail } if detail.contains("neoxify-wg")));
        assert_eq!(step("dns"), RepairOutcome::AlreadyClean);
    }

    #[test]
    fn a_look_that_failed_is_never_clean() {
        let blind = Survey { engines: None, groups: None, ..clean() };
        let r = report(RepairOutcome::AlreadyClean, &blind, &blind, &Acts::default());
        let step = |id: &str| r.steps.iter().find(|s| s.id == id).unwrap().outcome.clone();
        assert!(matches!(step("engines"), RepairOutcome::Unknown { .. }));
        assert!(matches!(step("groups"), RepairOutcome::Unknown { .. }));
    }

    #[test]
    fn the_running_apps_own_group_is_not_a_leftover() {
        let with_app = Survey { groups: Some(vec![("neoxify.app".into(), 3)]), ..clean() };
        let r = report(RepairOutcome::AlreadyClean, &with_app, &with_app, &Acts::default());
        assert_eq!(r.steps[6].outcome, RepairOutcome::AlreadyClean);
        let split = Survey { groups: Some(vec![("neoxify.split".into(), 2)]), ..clean() };
        let r = report(RepairOutcome::AlreadyClean, &split, &split, &Acts::default());
        assert!(matches!(&r.steps[6].outcome, RepairOutcome::Unknown { detail } if detail.contains("2 programs")));
        let empty = Survey { groups: Some(vec![("neoxify.split".into(), 0)]), ..clean() };
        let r = report(RepairOutcome::AlreadyClean, &empty, &clean(), &Acts::default());
        assert!(matches!(&r.steps[6].outcome, RepairOutcome::Fixed { .. }));
    }

    #[test]
    fn the_command_line_says_one_line_per_step() {
        let r = report(RepairOutcome::Fixed { detail: "disconnected".into() }, &clean(), &clean(), &Acts::default());
        let lines = lines(&r);
        assert_eq!(lines.len(), 7);
        assert!(lines[0].starts_with("[FIXED]") && lines[0].contains("disconnected"), "{lines:?}");
        assert!(lines[1].starts_with("[ok]"));
    }
}
