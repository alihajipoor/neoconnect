//! "Repair my network": undoing everything this product can leave on a
//! machine, in one pass, whether or not this service put it there.
//!
//! # Why this exists
//!
//! Customers have reported, repeatedly, that after using the client their
//! networking stays broken until they reset Windows network settings and
//! uninstall the app. Each residue behind that report is separately
//! understood and separately fixed by now -- a leftover NRPT rule that
//! survives both a reboot and Windows' own network reset, orphaned engine
//! processes, routes on an adapter whose engine is gone, a firewall rule,
//! a stranded WireGuard tunnel service, a split-tunnel redirect loop
//! still capturing every process's DNS after its tunnel died -- but
//! every one of those fixes runs on a path a broken machine may never
//! reach. A service that will not start never runs its start-up
//! reconcile; a service that is wedged never answers a disconnect.
//!
//! So this is the escape hatch, and it deliberately exists in two forms.
//! [`run`] is called through the pipe by the app's "Repair my network"
//! button, and the same function is called by
//! `neoconnect-service.exe repair`, which needs no service at all: an
//! administrator command prompt, the binary that is already installed,
//! and every step above performed by the process the customer just
//! started. That out-of-band form is the important one, because the
//! cases that hurt most are exactly the ones where the service is the
//! thing that is broken. Windscribe ships `-firewall_off` for the same
//! reason; Mullvad ships `mullvad-setup.exe reset-firewall`.
//!
//! # Rules this obeys
//!
//! **Every step is independent and non-fatal.** A repair that aborts
//! halfway leaves the machine in exactly the state it exists to remove.
//!
//! **It never leaves the machine more restricted than it found it.**
//! Nothing here installs a filter, a rule or a route; everything here
//! removes one. The product's stance is fail-open -- users in Iran are
//! worse served by a machine that is locked down safely than by one that
//! reaches the internet -- and a repair that could strand somebody would
//! be worse than the fault.
//!
//! **It reports what it verified, not what it attempted.** Each step
//! looks before it acts and looks again afterwards, and the three
//! answers it can give are "there was nothing of ours", "there was and
//! it is gone", and "there was and it is still there". A step that could
//! not look says so as `Unknown` rather than borrowing either of the
//! other two -- because this codebase's whole history is states that
//! were reported without being checked.
//!
//! **It reuses the teardowns that already exist** rather than writing
//! second copies of them. The NRPT sweep, the process reaper, the route
//! purge, the firewall delete and the bounded tunnel-service stop are
//! all called here exactly as the disconnect path calls them; what is
//! added is the census around each one and, where the ordinary path has
//! no answer at all, a last resort (see
//! [`super::wireguard::force_remove_tunnel_service`]).

use std::path::Path;

use neoconnect_ipc::{Diagnostics, RepairOutcome, RepairReport};
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{FWP_E_PROVIDER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND, HANDLE};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterCreateEnumHandle0, FwpmFilterDeleteById0,
    FwpmFilterDestroyEnumHandle0, FwpmFilterEnum0, FwpmFreeMemory0, FwpmProviderDeleteByKey0,
    FwpmSubLayerDeleteByKey0, FWPM_FILTER0, FWPM_FILTER_ENUM_TEMPLATE0,
    FWP_FILTER_ENUM_FULLY_CONTAINED,
};
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

use crate::adapters;

use super::{dns, ikev2, ipv6_block, janitor, routing, wireguard, Engines};

/// One repair step's identity.
///
/// The id is what the app maps to a translated label -- it is never
/// shown raw, because the customer reading this repair may not read
/// English. The label is the English wording, for the command-line
/// summary and for `cleanup.log`, both of which are read by whoever is
/// helping rather than by the customer.
///
/// Declared as values here rather than as literals inside each step so
/// that the set is enumerable, which is what lets the test below prove
/// every one of them has a translation on the other side of the pipe. A
/// missing translation is otherwise invisible: it surfaces as an English
/// line in a Persian interface, in front of exactly the customers this
/// feature exists for.
#[derive(Clone, Copy)]
struct StepId {
    id: &'static str,
    label: &'static str,
}

/// Every step, in the order [`run`] performs them.
///
/// The one place a step's id and label are written. The constants below
/// index into this rather than repeating either, so a step cannot report
/// itself under a name this list does not carry -- which is what the
/// translation test relies on.
const ALL_STEPS: [StepId; 9] = [
    StepId { id: "tunnel", label: "Tunnel and Custom-mode interception" },
    StepId { id: "engines", label: "Orphaned engine processes" },
    StepId { id: "dns", label: "Tunnel DNS rule (NRPT)" },
    StepId { id: "routes", label: "Routes on Neoxify adapters" },
    StepId { id: "firewall", label: "Split-tunnel firewall rule" },
    StepId { id: "wfp", label: "Windows Filtering Platform filters" },
    StepId { id: "wireguardService", label: "Stranded WireGuard tunnel service" },
    StepId { id: "ras", label: "Neoxify entry in Windows' VPN list" },
    StepId { id: "dnsCache", label: "DNS cache" },
];

const TUNNEL: usize = 0;
const ENGINES: usize = 1;
const DNS: usize = 2;
const ROUTES: usize = 3;
const FIREWALL: usize = 4;
const WFP: usize = 5;
const WIREGUARD_SERVICE: usize = 6;
const RAS: usize = 7;
const DNS_CACHE: usize = 8;

/// Adds one step's result to the report.
fn push(report: &mut RepairReport, step: usize, outcome: RepairOutcome) {
    let step = ALL_STEPS[step];
    report.push(step.id, step.label, outcome);
}

/// What was on the machine before anything was undone.
///
/// Taken up front, in one pass, because the teardown that follows
/// destroys the evidence. Without it every step would report "clean" on
/// a machine it had just repaired, and the customer -- who came here
/// because something was wrong -- would be told nothing was.
struct Survey {
    orphaned_engines: Vec<String>,
    nrpt_rules: u32,
    routes: Vec<(&'static str, usize)>,
    firewall_rule: Option<bool>,
    wfp_filters: Option<usize>,
    wireguard_tunnel_service: bool,
    ras_entry: Option<bool>,
    tunnel_up: bool,
}

fn survey(engines: &mut Engines) -> Survey {
    let exe_dir = engines.exe_dir.clone();
    let (tunnel_up, _, _) = engines.status();
    Survey {
        orphaned_engines: janitor::list_orphaned_engines(&exe_dir),
        nrpt_rules: dns::rule_count(),
        routes: our_route_counts(),
        firewall_rule: split_tunnel_rule_present(),
        wfp_filters: with_wfp_engine(|engine| our_filter_ids(engine).map(|ids| ids.len())).flatten(),
        wireguard_tunnel_service: wireguard::tunnel_is_running(),
        ras_entry: ikev2::entry_present(),
        tunnel_up,
    }
}

/// Runs every repair step, in order, and reports what each one did.
///
/// The caller holds the `Engines` lock (over the pipe) or owns the value
/// outright (from the command line). Either way this is the only thing
/// touching the machine while it runs, which is the reason the pipe
/// version tears the tunnel down first rather than working around one.
pub(crate) fn run(engines: &mut Engines) -> RepairReport {
    let mut report = RepairReport::default();
    let found = survey(engines);
    let exe_dir = engines.exe_dir.clone();

    step_tunnel(engines, &found, &mut report);
    step_engines(&exe_dir, &found, &mut report);
    step_dns(&found, &mut report);
    step_routes(&found, &mut report);
    step_firewall(&found, &mut report);
    step_wfp(&found, &mut report);
    step_wireguard(engines, &found, &mut report);
    step_ras(&found, &mut report);
    step_flush(&mut report);

    for step in &report.steps {
        match &step.outcome {
            RepairOutcome::Fixed { detail } => crate::cleanup_log::record("repair", &format!("{}: fixed -- {detail}", step.label)),
            RepairOutcome::Failed { detail } => crate::cleanup_log::record("repair", &format!("{}: FAILED -- {detail}", step.label)),
            RepairOutcome::Unknown { detail } => crate::cleanup_log::record("repair", &format!("{}: unknown -- {detail}", step.label)),
            // Not logged. A healthy machine produces nothing but these,
            // and a log full of "there was nothing wrong" is a log
            // nobody reads the interesting lines out of.
            RepairOutcome::AlreadyClean => {}
        }
    }
    report
}

/// The live tunnel, and the split-tunnel redirect loop with it.
///
/// First, and not merely for tidiness: every later step removes
/// something a running tunnel depends on, and doing that underneath one
/// produces a machine that believes it is connected while nothing
/// carries its traffic -- the exact dishonest state this product refuses
/// to ship. It is also the only step that can stop a redirect loop that
/// outlived its own tunnel, because that loop lives inside this process
/// and no amount of registry or firewall work reaches it.
fn step_tunnel(engines: &mut Engines, found: &Survey, report: &mut RepairReport) {
    match engines.disconnect() {
        Ok(()) if found.tunnel_up => push(
            report,
            TUNNEL,
            RepairOutcome::Fixed { detail: "a tunnel was up and has been torn down".into() },
        ),
        Ok(()) => push(report, TUNNEL, RepairOutcome::AlreadyClean),
        Err(e) => push(report, TUNNEL, RepairOutcome::Failed { detail: e }),
    }
}

/// Engine processes belonging to this installation with nothing left to
/// stop them.
///
/// Scoped by full image path, never by name: `xray.exe` is widely
/// shipped and `openvpn.exe` is the official client's own binary, so a
/// customer may perfectly well be running either for something that has
/// nothing to do with us. See [`janitor::kill_orphaned_engines`], which
/// is what actually does this on every service start.
fn step_engines(exe_dir: &Path, found: &Survey, report: &mut RepairReport) {
    let reaped = janitor::kill_orphaned_engines(exe_dir);
    // Asked again rather than inferred from the kill: `TerminateProcess`
    // returning success means the request was accepted, which is not the
    // same as the process having gone.
    let still_there = janitor::list_orphaned_engines(exe_dir);

    if !still_there.is_empty() {
        push(
            report,
            ENGINES,
            RepairOutcome::Failed {
                detail: format!("still running: {}", still_there.join(", ")),
            },
        );
        return;
    }
    if !reaped.stuck.is_empty() {
        // Nothing is running now, but a step of this ended without being
        // able to say why -- most often because the process scan itself
        // could not be taken.
        push(
            report,
            ENGINES,
            RepairOutcome::Unknown { detail: reaped.stuck.join("; ") },
        );
        return;
    }
    if found.orphaned_engines.is_empty() && reaped.ended.is_empty() {
        push(report, ENGINES, RepairOutcome::AlreadyClean);
        return;
    }
    push(
        report,
        ENGINES,
        RepairOutcome::Fixed {
            detail: format!("ended {}", found.orphaned_engines.join(", ")),
        },
    );
}

/// The NRPT rule -- the residue that produces "no website loads at all"
/// long after the VPN is gone.
///
/// Both locations, by cmdlet and by direct registry sweep, which is what
/// [`dns::clear_reporting`] already does on every disconnect. Verified
/// afterwards by counting what is left, because the cmdlets have been
/// watched claiming success over a rule that was still there -- a rule
/// under the Group Policy key is invisible to `Get-DnsClientNrptRule`
/// entirely.
fn step_dns(found: &Survey, report: &mut RepairReport) {
    let cleared = dns::clear_reporting();
    let left = dns::rule_count();

    if left > 0 {
        push(
            report,
            DNS,
            RepairOutcome::Failed {
                detail: format!("{left} rule(s) of ours are still in the registry"),
            },
        );
        return;
    }
    if found.nrpt_rules > 0 || cleared.removed > 0 {
        push(
            report,
            DNS,
            RepairOutcome::Fixed {
                detail: format!("removed {} rule(s)", found.nrpt_rules.max(cleared.removed)),
            },
        );
        return;
    }
    match cleared.unverified {
        Some(detail) => push(report, DNS, RepairOutcome::Unknown { detail }),
        None => push(report, DNS, RepairOutcome::AlreadyClean),
    }
}

/// IPv4 routes sitting on our own adapters.
///
/// Scoped to the interface, never to a destination: deleting
/// `0.0.0.0/0` machine-wide takes the customer's real default route with
/// it, which is a fault this repair would be *causing*. See
/// [`routing::purge_interface`].
fn step_routes(found: &Survey, report: &mut RepairReport) {
    let purged = janitor::purge_adapter_routes();
    let after = our_route_counts();
    let left: usize = after.iter().map(|(_, n)| n).sum();

    if left > 0 {
        let names: Vec<String> = after
            .iter()
            .filter(|(_, n)| *n > 0)
            .map(|(name, n)| format!("{n} on {name}"))
            .collect();
        push(
            report,
            ROUTES,
            RepairOutcome::Failed { detail: format!("still present: {}", names.join(", ")) },
        );
        return;
    }
    if !purged.unknown.is_empty() {
        push(report, ROUTES, RepairOutcome::Unknown { detail: purged.unknown.join("; ") });
        return;
    }
    let before: usize = found.routes.iter().map(|(_, n)| n).sum();
    if before == 0 && purged.removed.is_empty() {
        push(report, ROUTES, RepairOutcome::AlreadyClean);
        return;
    }
    let names: Vec<String> = found
        .routes
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(name, n)| format!("{n} on {name}"))
        .collect();
    push(
        report,
        ROUTES,
        RepairOutcome::Fixed {
            detail: if names.is_empty() { purged.removed.join(", ") } else { format!("removed {}", names.join(", ")) },
        },
    );
}

/// The inbound allowance Custom mode installs for its own relay.
///
/// Torn down with the split tunnel in the ordinary case; left behind by
/// a service that was killed rather than stopped, where it allows
/// inbound traffic to ephemeral ports nothing listens on any more.
fn step_firewall(found: &Survey, report: &mut RepairReport) {
    crate::split_tunnel::firewall::delete_rule();
    match (found.firewall_rule, split_tunnel_rule_present()) {
        (_, Some(true)) => push(
            report,
            FIREWALL,
            RepairOutcome::Failed { detail: "the rule is still in the Windows firewall".into() },
        ),
        (Some(true), Some(false)) => push(
            report,
            FIREWALL,
            RepairOutcome::Fixed { detail: "removed the leftover inbound allowance".into() },
        ),
        (Some(false), Some(false)) => push(report, FIREWALL, RepairOutcome::AlreadyClean),
        // netsh could not be asked. The delete still ran; what cannot be
        // said is whether there was anything to delete or whether it
        // went.
        _ => push(
            report,
            FIREWALL,
            RepairOutcome::Unknown { detail: "the Windows firewall could not be queried".into() },
        ),
    }
}

/// Filters carrying our WFP provider key.
///
/// The full-tunnel IPv6 block opens a `FWPM_SESSION_FLAG_DYNAMIC`
/// session, so the kernel destroys its filters when the process holding
/// them dies -- which is why there is normally nothing here, and why
/// that design was chosen. What this catches is the case
/// [`ipv6_block::add_provider`] already tolerates in so many words: a
/// provider registered *persistently* by an older build, whose filters
/// then outlive everything. Those would keep blocking IPv6 on a machine
/// with no VPN on it, which is precisely the class of report this whole
/// feature answers.
///
/// Removal only. Nothing here can leave the machine more restricted than
/// it was found.
fn step_wfp(found: &Survey, report: &mut RepairReport) {
    let outcome = with_wfp_engine(|engine| {
        let Some(ids) = our_filter_ids(engine) else {
            return RepairOutcome::Unknown {
                detail: "the filtering platform would not list filters under our provider".into(),
            };
        };
        for id in &ids {
            // SAFETY: `engine` is a live handle from `with_wfp_engine`,
            // and `id` came from an enumeration on the same engine.
            //
            // The return value is deliberately dropped: "not found"
            // means somebody else got there first, which is the outcome
            // being asked for, and every other failure is caught by the
            // re-enumeration below. What is on the machine afterwards is
            // the only thing worth reporting -- a delete that returned
            // success over a filter that is still there is exactly the
            // kind of evidence this codebase has learned not to accept.
            unsafe { FwpmFilterDeleteById0(engine, *id) };
        }
        // The sublayer and provider after the filters, in that order,
        // because a provider with objects still referencing it refuses
        // rather than cascading. Best-effort by design: the copies made
        // by a dynamic session went with the process that made them, so
        // there is usually nothing here to remove.
        //
        // There are *two* sublayers under the one provider -- the
        // full-tunnel block's and Custom mode's per-app block's -- and
        // both have to go before the provider will. Deleting only the
        // first would leave the second pinning the provider on every
        // future repair.
        // SAFETY: `engine` is live; both keys are 'static constants.
        let sublayer = unsafe { FwpmSubLayerDeleteByKey0(engine, &ipv6_block::SUBLAYER_KEY) };
        // SAFETY: as above.
        let split_sublayer =
            unsafe { FwpmSubLayerDeleteByKey0(engine, &ipv6_block::SPLIT_SUBLAYER_KEY) };
        // SAFETY: as above.
        let provider = unsafe { FwpmProviderDeleteByKey0(engine, &ipv6_block::PROVIDER_KEY) };

        // What actually decides the outcome: are any filters of ours
        // still installed. Nothing else here can affect a packet -- a
        // sublayer holding no filters filters nothing, and a provider is
        // a label. Reporting a stuck registration as a failed repair
        // would tell a customer their networking is still broken over an
        // object that has never touched a packet in its life.
        let remaining = our_filter_ids(engine);
        let registration_left: Vec<&str> = [
            (sublayer, FWP_E_SUBLAYER_NOT_FOUND as u32, "sublayer"),
            (split_sublayer, FWP_E_SUBLAYER_NOT_FOUND as u32, "Custom-mode sublayer"),
            (provider, FWP_E_PROVIDER_NOT_FOUND as u32, "provider"),
        ]
        .iter()
        .filter(|(err, absent, _)| *err != 0 && err != absent)
        .map(|(_, _, what)| *what)
        .collect();
        let note = if registration_left.is_empty() {
            String::new()
        } else {
            format!(
                " (our WFP {} could not be deregistered, which filters nothing)",
                registration_left.join(" and ")
            )
        };

        match remaining {
            Some(left) if !left.is_empty() => RepairOutcome::Failed {
                detail: format!("{} filter(s) of ours are still installed", left.len()),
            },
            Some(_) if ids.is_empty() => RepairOutcome::AlreadyClean,
            Some(_) => RepairOutcome::Fixed {
                detail: format!("removed {} leftover filter(s){note}", ids.len()),
            },
            // The deletes ran and then the engine stopped answering, so
            // whether they took cannot be said. Not "clean".
            None => RepairOutcome::Unknown {
                detail: "the filters were deleted but the result could not be re-checked".into(),
            },
        }
    });

    push(
        report,
        WFP,
        outcome.unwrap_or_else(|| {
            // Worth distinguishing from a clean answer. If WFP itself
            // cannot be opened, the Base Filtering Engine service may be
            // stopped -- which is its own cause of "my network is
            // broken" and something support needs told, not something to
            // paper over with a green tick.
            let detail = if found.wfp_filters.is_some() {
                "the filtering platform stopped answering part-way through".to_string()
            } else {
                "the Windows Filtering Platform could not be opened (is the Base Filtering Engine running?)".to_string()
            };
            RepairOutcome::Unknown { detail }
        }),
    );
}

/// A `WireGuardTunnel$neoconnect` service with nothing managing it.
///
/// It is a Windows service in its own right and starts automatically, so
/// one left registered takes the default route and DNS on every boot,
/// with the application that created it possibly uninstalled. The
/// ordinary path first -- wireguard.exe's own `/uninstalltunnelservice`
/// plus the bounded stop in [`wireguard::clear_tunnel_service`] -- and
/// only if the name is still taken, the direct stop-and-delete that
/// needs no wireguard.exe at all.
fn step_wireguard(engines: &Engines, found: &Survey, report: &mut RepairReport) {
    if !found.wireguard_tunnel_service {
        // Asked again all the same: `step_tunnel` above may have created
        // nothing, but a tunnel torn down between the survey and here
        // would leave one.
        if !wireguard::tunnel_is_running() {
            push(report, WIREGUARD_SERVICE, RepairOutcome::AlreadyClean);
            return;
        }
    }

    wireguard::remove_tunnel_if_present(engines);
    let mut trouble: Option<String> = None;
    if wireguard::tunnel_is_running() {
        // wireguard.exe either is not there or did not manage it. Its
        // `/uninstalltunnelservice` is also the call that can hang for
        // 25 minutes on a service stuck in START_PENDING, which is why
        // the fallback talks to the service manager directly.
        if let Err(e) = wireguard::force_remove_tunnel_service() {
            trouble = Some(e);
        }
    }

    if wireguard::tunnel_is_running() {
        push(
            report,
            WIREGUARD_SERVICE,
            RepairOutcome::Failed {
                detail: trouble.unwrap_or_else(|| "the tunnel service is still registered".into()),
            },
        );
        return;
    }
    push(
        report,
        WIREGUARD_SERVICE,
        RepairOutcome::Fixed { detail: "removed the leftover WireGuard tunnel service".into() },
    );
}

/// The `Neoxify` entry in the customer's Windows VPN list.
///
/// Left behind, it is dialable by hand and outlives the app -- so
/// somebody who uninstalled still has a VPN entry with our name on it,
/// pointing at credentials that no longer work.
fn step_ras(found: &Survey, report: &mut RepairReport) {
    if found.ras_entry == Some(false) {
        push(report, RAS, RepairOutcome::AlreadyClean);
        return;
    }
    let removal = ikev2::disconnect();
    match (ikev2::entry_present(), removal) {
        (Some(false), _) if found.ras_entry == Some(true) => push(
            report,
            RAS,
            RepairOutcome::Fixed { detail: "removed the leftover VPN entry".into() },
        ),
        (Some(false), _) => push(report, RAS, RepairOutcome::AlreadyClean),
        (Some(true), Err(e)) => push(report, RAS, RepairOutcome::Failed { detail: e }),
        (Some(true), Ok(())) => push(
            report,
            RAS,
            RepairOutcome::Failed { detail: "the entry is still in Windows' VPN list".into() },
        ),
        (None, _) => push(
            report,
            RAS,
            RepairOutcome::Unknown { detail: "Windows' VPN list could not be queried".into() },
        ),
    }
}

/// Telling the DNS client to forget everything it resolved under
/// whatever was just removed.
///
/// Unconditional here, unlike on the disconnect path: this is a machine
/// somebody has had to ask for a repair on, so a cached answer resolved
/// through a resolver that is now unreachable is exactly the residue
/// being chased. Best-effort by construction -- see
/// [`dns::flush_and_reload`], where a failed poke still leaves the
/// registry correct and a reboot finishes the job.
fn step_flush(report: &mut RepairReport) {
    dns::flush_and_reload();
    push(
        report,
        DNS_CACHE,
        RepairOutcome::Fixed { detail: "flushed, and the resolver told to reload its policy".into() },
    );
}

/// A redacted picture of what this product has on the machine right now.
///
/// Named fields only, and every one of them either a count, a boolean,
/// or a string this code produced. Nothing is read out of an engine
/// config, a stored profile or the phonebook -- those carry a WireGuard
/// private key, an OpenVPN client key and an Xray UUID respectively,
/// each enough on its own to connect as that customer, and this text is
/// written to be pasted into a support ticket.
pub(crate) fn diagnostics(engines: &mut Engines) -> Diagnostics {
    let exe_dir = engines.exe_dir.clone();
    Diagnostics {
        service_version: env!("CARGO_PKG_VERSION").to_string(),
        our_adapters: janitor::OUR_ADAPTERS
            .iter()
            .map(|name| neoconnect_ipc::AdapterPresence {
                name: (*name).to_string(),
                present: matches!(adapters::find_by_name(name), Ok(Some(_))),
            })
            .collect(),
        other_vpns_up: adapters::other_vpns_up(&janitor::OUR_ADAPTERS).unwrap_or_default(),
        our_routes: our_routes_named(),
        nrpt_rules: dns::rule_count(),
        split_tunnel_firewall_rule: split_tunnel_rule_present().unwrap_or(false),
        orphaned_engines: janitor::list_orphaned_engines(&exe_dir),
        wireguard_tunnel_service: wireguard::tunnel_is_running(),
        ras_entry: ikev2::entry_present().unwrap_or(false),
        wfp_filters: with_wfp_engine(|engine| our_filter_ids(engine).map(|ids| ids.len() as u32))
            .flatten()
            .unwrap_or(0),
        cleanup_log_tail: crate::cleanup_log::tail(40),
    }
}

/// How many IPv4 routes sit on each of our adapters, right now.
fn our_route_counts() -> Vec<(&'static str, usize)> {
    janitor::OUR_ADAPTERS
        .iter()
        .map(|name| {
            let count = match adapters::find_by_name(name) {
                Ok(Some(adapter)) => routing::interface_routes(adapter.index).len(),
                _ => 0,
            };
            (*name, count)
        })
        .collect()
}

/// The same routes, as `adapter: destination/prefix`, for diagnostics.
fn our_routes_named() -> Vec<String> {
    let mut out = Vec::new();
    for name in janitor::OUR_ADAPTERS {
        let Ok(Some(adapter)) = adapters::find_by_name(name) else {
            continue;
        };
        for destination in routing::interface_routes(adapter.index) {
            out.push(format!("{name}: {destination}"));
        }
    }
    out
}

/// Whether the split-tunnel firewall rule exists.
///
/// `None` when netsh could not be asked, which is deliberately not
/// `Some(false)`: the delete that follows reports "there was nothing to
/// delete" and "it refused" identically, so an unanswered query is the
/// only thing standing between a real check and a guess.
fn split_tunnel_rule_present() -> Option<bool> {
    use std::process::Command;

    let rule = crate::split_tunnel::firewall::RULE;
    let mut command = Command::new(r"C:\Windows\System32\netsh.exe");
    command.args([
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={rule}"),
    ]);
    let out = super::capture_hidden(command, super::HELPER_BUDGET).ok()?;
    // netsh's text is localised, so the exit status is what is read:
    // success means it found the rule, failure means it did not. That is
    // the one thing about this command that does not change with the
    // machine's language.
    Some(out.status.success())
}

/// Opens a WFP session, runs `body`, and closes it.
///
/// Not a dynamic session, unlike [`ipv6_block`]: a dynamic one would
/// delete everything it created when it closed, and this session creates
/// nothing -- it exists to find and remove objects a *previous* process
/// left behind. Returns `None` when the engine could not be opened at
/// all, which callers report as unknown rather than as clean.
fn with_wfp_engine<T>(body: impl FnOnce(HANDLE) -> T) -> Option<T> {
    let mut engine: HANDLE = std::ptr::null_mut();
    // SAFETY: null credentials and a null session are the documented way
    // to open the engine as the calling identity with default settings;
    // `engine` is a valid out-pointer.
    let err = unsafe {
        FwpmEngineOpen0(
            std::ptr::null(),
            RPC_C_AUTHN_WINNT,
            std::ptr::null(),
            std::ptr::null(),
            &mut engine,
        )
    };
    if err != 0 {
        return None;
    }
    let result = body(engine);
    // SAFETY: `engine` came from FwpmEngineOpen0 and is not used again.
    unsafe { FwpmEngineClose0(engine) };
    Some(result)
}

/// How many filters to ask for per enumeration call. Ours are ten at
/// most, so one call answers in practice; the loop is there because the
/// API is allowed to return fewer than asked.
const FILTER_PAGE: u32 = 64;

/// The ids of every filter carrying our provider key.
///
/// Matched on the provider key alone, which is the whole reason
/// `ipv6_block` registers one: an engineer reading
/// `netsh wfp show filters` on a customer's machine can tell our filters
/// from WireGuard's, and so can this. Nothing else on the machine is
/// touched.
///
/// # Safety
/// `engine` must be a live handle from [`with_wfp_engine`].
fn our_filter_ids(engine: HANDLE) -> Option<Vec<u64>> {
    let mut provider_key: GUID = ipv6_block::PROVIDER_KEY;
    // SAFETY: zeroed is a valid template; a zero `layerKey` is how a
    // by-value GUID expresses "every layer", and FULLY_CONTAINED is the
    // enumeration type that permits it.
    let mut template: FWPM_FILTER_ENUM_TEMPLATE0 = unsafe { std::mem::zeroed() };
    template.providerKey = &mut provider_key;
    template.enumType = FWP_FILTER_ENUM_FULLY_CONTAINED;
    template.actionMask = u32::MAX;

    let mut enum_handle: HANDLE = std::ptr::null_mut();
    // SAFETY: `engine` is live, the template is fully initialised, and
    // `enum_handle` is a valid out-pointer.
    let err = unsafe { FwpmFilterCreateEnumHandle0(engine, &template, &mut enum_handle) };
    if err != 0 {
        return None;
    }

    let mut ids = Vec::new();
    loop {
        let mut entries: *mut *mut FWPM_FILTER0 = std::ptr::null_mut();
        let mut returned: u32 = 0;
        // SAFETY: both out-pointers are valid; on success WFP allocates
        // the array and it is freed below.
        let err = unsafe {
            FwpmFilterEnum0(engine, enum_handle, FILTER_PAGE, &mut entries, &mut returned)
        };
        if err != 0 {
            // SAFETY: `enum_handle` came from FwpmFilterCreateEnumHandle0.
            unsafe { FwpmFilterDestroyEnumHandle0(engine, enum_handle) };
            return None;
        }
        if returned == 0 || entries.is_null() {
            break;
        }
        for i in 0..returned as usize {
            // SAFETY: WFP guarantees `returned` valid pointers in the
            // array it just allocated.
            let filter = unsafe { *entries.add(i) };
            if filter.is_null() {
                continue;
            }
            // SAFETY: as above -- a non-null FWPM_FILTER0 from the API.
            ids.push(unsafe { (*filter).filterId });
        }
        // SAFETY: `entries` is the array WFP allocated for this call,
        // and nothing above retained a pointer into it -- only the
        // `filterId` values were copied out.
        unsafe { FwpmFreeMemory0(&mut entries as *mut _ as *mut *mut core::ffi::c_void) };
        if returned < FILTER_PAGE {
            break;
        }
    }

    // SAFETY: `enum_handle` came from FwpmFilterCreateEnumHandle0 and is
    // not used again.
    unsafe { FwpmFilterDestroyEnumHandle0(engine, enum_handle) };
    Some(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::RepairStep;

    fn step(id: &str, outcome: RepairOutcome) -> RepairStep {
        RepairStep { id: id.into(), label: id.into(), outcome }
    }

    /// The rule the whole feature turns on: an unverified step is not a
    /// clean one.
    ///
    /// Written with the control case beside it, because a `is_clean`
    /// that simply returned true would pass the first assertion and a
    /// hardcoded false would pass the rest. All four outcomes are
    /// exercised.
    #[test]
    fn a_step_that_could_not_look_is_not_reported_as_clean() {
        let mut clean = RepairReport::default();
        clean.push("a", "a", RepairOutcome::AlreadyClean);
        clean.push("b", "b", RepairOutcome::Fixed { detail: "gone".into() });
        assert!(clean.is_clean(), "found nothing and fixed something is a success");
        assert!(clean.unresolved().is_empty());

        let mut unknown = RepairReport::default();
        unknown.push("a", "a", RepairOutcome::AlreadyClean);
        unknown.push("b", "b", RepairOutcome::Unknown { detail: "could not ask".into() });
        assert!(
            !unknown.is_clean(),
            "a step that could not be checked was reported as a clean machine"
        );
        assert_eq!(unknown.unresolved().len(), 1);
        assert_eq!(unknown.unresolved()[0].id, "b");

        let mut failed = RepairReport::default();
        failed.push("a", "a", RepairOutcome::Failed { detail: "still there".into() });
        assert!(!failed.is_clean());
        assert_eq!(failed.unresolved().len(), 1);

        // An empty report is vacuously clean, which is correct and worth
        // pinning: it is what the command line prints an exit code from,
        // and a repair that ran no steps at all must not read as a
        // failure either.
        assert!(RepairReport::default().is_clean());
    }

    #[test]
    fn only_failures_count_as_failures() {
        assert!(step("x", RepairOutcome::Failed { detail: String::new() }).outcome.is_failure());
        assert!(!step("x", RepairOutcome::Unknown { detail: String::new() }).outcome.is_failure());
        assert!(!step("x", RepairOutcome::AlreadyClean).outcome.is_failure());
        assert!(!step("x", RepairOutcome::Fixed { detail: String::new() }).outcome.is_failure());
    }

    /// Every step this service can report has a label the app can
    /// translate.
    ///
    /// The two sides are in different languages and different build
    /// systems, so nothing else connects them: TypeScript cannot fail to
    /// compile over a key the Rust side invented, and Rust never sees
    /// the dictionary. The failure that leaves is silent and lands
    /// exactly where it hurts -- an English line in the middle of a
    /// Persian repair report, in front of the customers this feature
    /// exists for.
    ///
    /// So the dictionary is read directly. `i18n.tsx` keeps English and
    /// Persian as one typed record each, and TypeScript already refuses
    /// to build when a key exists in one and not the other, so finding
    /// `repair.step.<id>` in the file is enough to know both languages
    /// carry it.
    #[test]
    fn every_step_has_a_translation_in_the_app() {
        const DICTIONARY: &str = include_str!("../../../src/lib/i18n.tsx");

        for step in ALL_STEPS {
            let key = format!("\"repair.step.{}\"", step.id);
            assert!(
                DICTIONARY.contains(&key),
                "the repair step {} has no {key} in src/lib/i18n.tsx, so the app would show \
                 an untranslated label for it",
                step.label
            );
        }

        // The control. Without it the assertion above would pass on a
        // dictionary that happened to contain the substring for another
        // reason, and would pass identically if `ALL_STEPS` were empty.
        assert_eq!(ALL_STEPS.len(), 9, "a step was added or removed");
        assert!(
            !DICTIONARY.contains("\"repair.step.thisKeyDoesNotExist\""),
            "the dictionary check matches keys that are not there"
        );
    }

    /// No two steps share an id, and each index constant names the step
    /// it is called after.
    ///
    /// The ids key the app's translations and its per-row rendering, so
    /// a duplicate -- or an index constant one place out after a step is
    /// inserted -- would render one step's wording under another's
    /// outcome. That is not a cosmetic bug here: it would tell a
    /// customer their DNS rule is clear when what was actually checked
    /// was their routes.
    #[test]
    fn each_index_names_its_own_step() {
        assert_eq!(ALL_STEPS[TUNNEL].id, "tunnel");
        assert_eq!(ALL_STEPS[ENGINES].id, "engines");
        assert_eq!(ALL_STEPS[DNS].id, "dns");
        assert_eq!(ALL_STEPS[ROUTES].id, "routes");
        assert_eq!(ALL_STEPS[FIREWALL].id, "firewall");
        assert_eq!(ALL_STEPS[WFP].id, "wfp");
        assert_eq!(ALL_STEPS[WIREGUARD_SERVICE].id, "wireguardService");
        assert_eq!(ALL_STEPS[RAS].id, "ras");
        assert_eq!(ALL_STEPS[DNS_CACHE].id, "dnsCache");

        let mut ids: Vec<&str> = ALL_STEPS.iter().map(|s| s.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "two repair steps share an id");
    }
}
