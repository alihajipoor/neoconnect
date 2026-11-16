//! The Neoxify helper: the root daemon the Linux app talks to.
//!
//! `neoxify-helper`            serve on /run/neoxify/helper.sock
//! `neoxify-helper sweep`      clear leftovers and the nftables table, exit 0
//!                             (the unit's ExecStopPost)
//! `neoxify-helper ctl JSON`   send one request to a running helper and
//!                             print the reply
//!
//! It owns the wire protocol and the session's lifecycle and nothing else:
//! tunnels are the `tunnel` crate's, leak protection is `netguard`'s.

mod backend;
mod lifecycle;
mod peer;
mod server;
mod session;
mod traffic;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use neoxify_tunnel::Dirs;

use crate::backend::{Backend, System};
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::session::Session;

pub const SOCKET: &str = "/run/neoxify/helper.sock";
const STATE_DIR: &str = "/var/lib/neoxify";
const RUN_DIR: &str = "/run/neoxify/private";

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
        Some("ctl") => match args.get(1) {
            Some(json) => ctl_main(json),
            None => usage(),
        },
        Some(_) => usage(),
    };
    std::process::exit(code);
}

fn usage() -> i32 {
    eprintln!("usage: neoxify-helper [sweep | ctl '<request as JSON>']");
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
fn sweep(backend: &dyn Backend, dirs: &Dirs) {
    for line in backend.sweep_leftovers(dirs) {
        eprintln!("neoxify-helper: sweep: {line}");
    }
    match backend.guard_remove() {
        Ok(neoxify_netguard::Removal::Removed) => eprintln!("neoxify-helper: sweep: removed a leftover nftables table"),
        Ok(neoxify_netguard::Removal::Nothing) => {}
        Err(err) => eprintln!("neoxify-helper: sweep: {err}"),
    }
}

fn sweep_main() -> i32 {
    match dirs() {
        Ok(dirs) => sweep(&System, &dirs),
        Err(err) => {
            eprintln!("neoxify-helper: sweep: cannot find my own directory ({err}); removing the table only");
            if let Err(err) = System.guard_remove() {
                eprintln!("neoxify-helper: sweep: {err}");
            }
        }
    }
    // Always 0: this runs after a stop, and a failure here is in the log,
    // not a reason to mark the unit failed.
    0
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
            eprintln!("neoxify-helper: cannot find my own directory: {err}");
            return 1;
        }
    };
    for dir in [&dirs.state, &dirs.run] {
        if let Err(err) = make_private(dir) {
            eprintln!("neoxify-helper: cannot prepare {}: {err}", dir.display());
            return 1;
        }
    }
    let backend: Arc<dyn Backend> = Arc::new(System);
    sweep(backend.as_ref(), &dirs);

    let rt = runtime();
    rt.block_on(async move {
        let listener = match server::bind(&server::socket_path()) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("neoxify-helper: cannot listen on {SOCKET}: {err}");
                return 1;
            }
        };
        let ledger = Arc::new(Ledger::new());
        let engines = Supervisor::spawn(Session::new(Arc::clone(&backend), dirs, Arc::clone(&ledger)), "neoxify-session");
        let policy = Arc::new(peer::Policy::system());
        let shared = server::Shared::new(engines.clone(), ledger, backend, policy);
        eprintln!("neoxify-helper: listening on {SOCKET}");

        server::serve(listener, shared, stop_signal()).await;

        // Stopping: nothing new is let in, a watch firing now is not the
        // app leaving, and whatever runs is cancelled so the teardown is
        // next.
        eprintln!("neoxify-helper: stopping; taking any tunnel down");
        lifecycle::client_watch::stop_watching();
        let _ = std::fs::remove_file(SOCKET);
        engines.supersede();
        engines.cancel_running();
        let torn_down = engines.run(|session: &mut Session, _| {
            let report = session.hard_stop();
            session.finish();
            report
        });
        match tokio::time::timeout(STOP_TEARDOWN_WAIT, torn_down).await {
            Ok(Ok(report)) if !report.all_succeeded() => eprintln!("neoxify-helper: at stop: {}", report.summary()),
            Ok(_) => {}
            Err(_) => eprintln!("neoxify-helper: the teardown did not finish in time; the unit's sweep will clear what is left"),
        }
        0
    })
}

/// SIGTERM (systemd's stop) or SIGINT (a developer's Ctrl-C).
async fn stop_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        eprintln!("neoxify-helper: cannot listen for stop signals; serving until killed");
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}
