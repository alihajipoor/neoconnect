//! The Neoxify helper: the root daemon the Linux app talks to.
//!
//! `neoxify-helper`            serve on /run/neoxify/helper.sock
//! `neoxify-helper sweep`      clear leftovers and the nftables table (the
//!                             unit's ExecStopPost); exits 1 when it could
//!                             not look at, or could not clear, something
//! `neoxify-helper repair`     what the app's Repair does, from a root
//!                             shell when the helper is not answering
//! `neoxify-helper ctl JSON`   send one request to a running helper and
//!                             print the reply
//!
//! It owns the wire protocol and the session's lifecycle and nothing else:
//! tunnels are the `tunnel` crate's, leak protection is `netguard`'s.

#[macro_use]
mod log;
mod backend;
mod custom;
mod hold;
mod lifecycle;
mod machine;
mod peer;
mod repair;
mod server;
mod session;
mod traffic;
mod update;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use neoconnect_ipc::RepairOutcome;
use neoxify_tunnel::Dirs;

use crate::backend::{Backend, System};
use crate::hold::{Hold, Release, LET_GO_SAID_WITHIN};
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::session::Session;

pub const SOCKET: &str = "/run/neoxify/helper.sock";
const STATE_DIR: &str = "/var/lib/neoxify";
const RUN_DIR: &str = "/run/neoxify/private";

/// The helper's own version, the one every reply and the update check
/// state.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long the stop waits for its teardown. Bounded, because a helper
/// that refuses to stop heals nothing, while one that stops without
/// finishing is healed by the unit's ExecStopPost sweep straight after.
/// Under systemd's default 90 s stop timeout with room to spare.
const STOP_TEARDOWN_WAIT: Duration = Duration::from_secs(13);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        None => serve_main(),
        Some("sweep") => sweep_main(),
        Some("repair") => repair_main(),
        Some("ctl") => match args.get(1) {
            Some(json) => ctl_main(json),
            None => usage(),
        },
        Some("--version") => {
            println!("neoxify-helper {VERSION}");
            0
        }
        Some(_) => usage(),
    };
    std::process::exit(code);
}

fn usage() -> i32 {
    eprintln!("usage: neoxify-helper [sweep | repair | ctl '<request as JSON>' | --version]");
    2
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("building the async runtime")
}

/// Where things live. `bin` is wherever this executable is, so a request
/// can never name a program to run.
fn dirs() -> std::io::Result<Dirs> {
    let exe = std::env::current_exe()?;
    let bin = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/usr/lib/neoxify"));
    Ok(Dirs { bin, state: PathBuf::from(STATE_DIR), run: PathBuf::from(RUN_DIR) })
}

/// Root-only directories, made if missing and tightened if not.
fn make_private(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Anything of ours standing when nothing should be: a helper that died
/// left it. Engines, links, routes and DNS first, then the table -- the
/// table last, because it is what blocks leaks while the rest goes.
/// Returns false when something could not be looked at or cleared.
fn sweep(backend: &dyn Backend, dirs: &Dirs) -> bool {
    let mut clean = true;
    for line in backend.sweep_leftovers(dirs) {
        if line.starts_with("could not") || line.contains(" could not ") {
            clean = false;
        }
        say!("neoxify-helper: sweep: {line}");
    }
    match backend.guard_remove() {
        Ok(neoxify_netguard::Removal::Removed) => say!("neoxify-helper: sweep: removed a leftover nftables table"),
        Ok(neoxify_netguard::Removal::Nothing) => {}
        Err(err) => {
            clean = false;
            say!("neoxify-helper: sweep: {err}");
        }
    }
    match backend.remove_split_table() {
        Ok(true) => say!("neoxify-helper: sweep: removed Custom mode's leftover nftables table"),
        Ok(false) => {}
        Err(err) => {
            clean = false;
            say!("neoxify-helper: sweep: Custom mode's table: {err}");
        }
    }
    // What the sweep could not even read is said here: a look that failed
    // is not a clean machine.
    let after = backend.survey(dirs);
    let blind: Vec<&str> = [
        ("engines", after.engines.is_none()),
        ("routes", after.routes.is_none()),
        ("rules", after.rules.is_none()),
        ("firewall tables", after.firewall.is_none()),
        ("DNS ledger", after.dns.is_none()),
    ]
    .into_iter()
    .filter_map(|(what, failed)| failed.then_some(what))
    .collect();
    if !blind.is_empty() {
        clean = false;
        say!("neoxify-helper: sweep: could not look at: {}", blind.join(", "));
    }
    clean
}

fn sweep_main() -> i32 {
    let clean = match dirs() {
        Ok(dirs) => sweep(&System, &dirs),
        Err(err) => {
            say!("neoxify-helper: sweep: cannot find my own directory ({err}); removing the table only");
            if let Err(err) = System.guard_remove() {
                say!("neoxify-helper: sweep: {err}");
            }
            false
        }
    };
    // Non-zero only says the sweep could not finish; it runs after the
    // unit has stopped, so it changes nothing about the helper itself.
    if clean {
        0
    } else {
        1
    }
}

/// Repair from a root shell, for when the helper is not answering. It
/// clears what a session leaves exactly as the app's Repair does, prints
/// one line per step, and exits 1 if any step failed. There is no session
/// in this process, so the tunnel step is about a tunnel of ours the
/// machine still shows.
fn repair_main() -> i32 {
    // SAFETY: geteuid cannot fail and touches no memory.
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("neoxify-helper: repair has to run as root: sudo /usr/lib/neoxify/neoxify-helper repair");
        return 2;
    }
    let dirs = match dirs() {
        Ok(dirs) => dirs,
        Err(err) => {
            eprintln!("neoxify-helper: cannot find my own directory: {err}");
            return 1;
        }
    };
    let backend = System;
    let up_before = backend.visible_tunnel();
    let mut report = repair::clear(&backend, &dirs, RepairOutcome::AlreadyClean);
    let tunnel = match (up_before, backend.visible_tunnel()) {
        (None, _) => RepairOutcome::AlreadyClean,
        (Some(name), None) => RepairOutcome::Fixed { detail: format!("took down the tunnel left up on {name}") },
        (Some(_), Some(name)) => RepairOutcome::Failed { detail: format!("a tunnel of ours is still up on {name}") },
    };
    if let Some(first) = report.steps.first_mut() {
        first.outcome = tunnel;
    }
    for line in repair::lines(&report) {
        println!("{line}");
    }
    if report.steps.iter().any(|s| s.outcome.is_failure()) {
        1
    } else {
        0
    }
}

fn ctl_main(json: &str) -> i32 {
    match runtime().block_on(server::call(Path::new(SOCKET), json)) {
        Ok(reply) => {
            println!("{reply}");
            0
        }
        Err(err) => {
            eprintln!("neoxify-helper: cannot reach the helper at {SOCKET}: {err}");
            1
        }
    }
}

fn serve_main() -> i32 {
    let dirs = match dirs() {
        Ok(dirs) => dirs,
        Err(err) => {
            say!("neoxify-helper: cannot find my own directory: {err}");
            return 1;
        }
    };
    for dir in [&dirs.state, &dirs.run] {
        if let Err(err) = make_private(dir) {
            say!("neoxify-helper: cannot prepare {}: {err}", dir.display());
            return 1;
        }
    }
    let backend: Arc<dyn Backend> = Arc::new(System);
    sweep(backend.as_ref(), &dirs);
    say!("neoxify-helper: version {VERSION}");

    let rt = runtime();
    rt.block_on(async move {
        let listener = match server::bind(&server::socket_path()) {
            Ok(listener) => listener,
            Err(err) => {
                say!("neoxify-helper: cannot listen on {SOCKET}: {err}");
                return 1;
            }
        };
        let ledger = Arc::new(Ledger::new());
        let hold = Hold::new(Arc::clone(&backend));
        let session = Session::new(Arc::clone(&backend), dirs.clone(), Arc::clone(&ledger), Arc::clone(&hold));
        let engines = Supervisor::spawn(session, "neoxify-session");
        let policy = Arc::new(peer::Policy::system());
        let shared = server::Shared::new(engines.clone(), ledger, backend, policy, Arc::clone(&hold), dirs);
        say!("neoxify-helper: listening on {SOCKET}");

        server::serve(listener, shared, stop_signal()).await;

        // Stopping: nothing new is let in, a watch firing now is not the
        // app leaving, and whatever runs is cancelled so the teardown is
        // next. A hold is said to be letting go before it does, so the
        // screen never says "blocked" over a machine no longer held.
        say!("neoxify-helper: stopping; taking any tunnel down");
        lifecycle::client_watch::stop_watching();
        let _ = std::fs::remove_file(SOCKET);
        engines.supersede();
        engines.cancel_running();
        let warned = Arc::clone(&hold);
        let _ = tokio::task::spawn_blocking(move || {
            warned.warn_of_letting_go(LET_GO_SAID_WITHIN);
            warned.release(Release::Asked("the helper is stopping"));
            warned.disarm();
        })
        .await;
        let torn_down = engines.run(|session: &mut Session, _| {
            let report = session.hard_stop();
            session.finish();
            report
        });
        match tokio::time::timeout(STOP_TEARDOWN_WAIT, torn_down).await {
            Ok(Ok(report)) if !report.all_succeeded() => say!("neoxify-helper: at stop: {}", report.summary()),
            Ok(_) => {}
            Err(_) => say!("neoxify-helper: the teardown did not finish in time; the unit's sweep will clear what is left"),
        }
        0
    })
}

/// SIGTERM (systemd's stop) or SIGINT (a developer's Ctrl-C).
async fn stop_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        say!("neoxify-helper: cannot listen for stop signals; serving until killed");
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}
