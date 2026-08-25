//! Neoxify's privileged helper service.
//!
//! # Why this exists
//!
//! Bringing up a VPN tunnel on Windows needs administrator rights:
//! installing a tunnel service, creating a TUN adapter, editing the
//! system routing table. The obvious approach -- elevate the engine
//! per-connect from the app, which is what this client originally did --
//! puts a UAC prompt in front of the user every single time they press
//! Connect. That fails the product's actual requirement, which is that
//! connecting is silent and the user never sees an engine at all.
//!
//! So elevation happens exactly once, at install time, when the
//! installer registers this service. From then on the app (running
//! unelevated, as it should) asks this service to do the privileged
//! work over a local named pipe, and nothing ever prompts again.
//!
//! # Threat model
//!
//! This is a LocalSystem process taking instructions over an IPC
//! endpoint, so it is a privilege-escalation target and is built as one:
//!
//! * the pipe is ACL'd to authenticated local users (see `security`),
//! * the protocol carries credentials only -- never a path, program
//!   name, or command line, so a caller cannot choose what runs
//!   (see `neoconnect_ipc` and `Engines::engine_path`),
//! * every value that reaches a config file is validated first, because
//!   some engine config formats can execute commands
//!   (see `neoconnect_ipc::ConnectProfile::validate`), and
//! * config files holding private keys live in a directory ACL'd to
//!   SYSTEM and Administrators only.

mod adapters;
mod cleanup_log;
mod engines;
mod pipe;
mod security;
mod split_tunnel;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl,
    ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState,
    ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE_NAME: &str = "NeoxifyService";
const SERVICE_DISPLAY_NAME: &str = "Neoxify VPN Service";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

pub(crate) fn config_dir() -> PathBuf {
    // ProgramData rather than the install directory: config is mutable
    // per-connection state, and Program Files is meant to be read-only
    // after install. The ACL is set explicitly at creation -- see
    // security::create_protected_dir.
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    PathBuf::from(base).join("Neoxify")
}

fn exe_dir() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| std::io::Error::other("could not resolve the service's own directory"))
}

use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("install") => install(),
        Some("uninstall") => uninstall(),
        Some("repair") => repair(),
        // No argument means the service control manager started us.
        _ => service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(Into::into),
    }
}

/// How long the service is given to stop before the repair goes ahead
/// without it.
///
/// Generous, because a service in the middle of a connect can legitimately
/// take a few seconds, and bounded because the whole premise of this
/// command is that the service may be the broken thing. Timing out is not
/// a failure: the repair runs anyway and says the service was still
/// running, which is the honest description of what it then did.
const SERVICE_STOP_BUDGET: Duration = Duration::from_secs(15);

/// `neoconnect-service.exe repair`, run by hand from an elevated command
/// prompt.
///
/// # Why this is a command and not only a button
///
/// The in-app button reaches this same code through the service, and is
/// the right answer whenever the service answers. The cases that
/// actually strand people are the ones where it does not: a service that
/// will not start never runs its start-up reconcile, and a service that
/// is wedged never answers a disconnect -- while the NRPT rule, the
/// routes and the tunnel service all sit there surviving reboots. This
/// path needs nothing but an administrator prompt and the binary that is
/// already installed, which is the same reason Windscribe ships an
/// out-of-band `-firewall_off`.
///
/// # What it does about the service
///
/// Stops it first, if it is running, and starts it again afterwards.
/// Not politeness: this process's `Engines` knows nothing about a tunnel
/// the *service's* `Engines` is holding, so repairing underneath a live
/// service would leave it believing it had a tunnel whose engine,
/// routes and DNS rule had all just been removed -- a machine reporting
/// "connected" while carrying nothing, which is the one state this
/// product refuses to produce. Stopping it also ends any split-tunnel
/// redirect loop inside it, which is the residue that captures every
/// process's DNS and which no registry or firewall work can reach.
///
/// Both the stop and the restart are best-effort and reported. A service
/// that will not stop does not cancel the repair, and a service that
/// will not start again is named rather than hidden -- the customer's
/// next connect depends on it.
fn repair() -> Result<(), Box<dyn std::error::Error>> {
    println!("Neoxify network repair\n");

    if !is_elevated() {
        eprintln!(
            "This must be run as an administrator.\n\n\
             Open Start, type \"cmd\", right-click Command Prompt and choose\n\
             \"Run as administrator\", then run this command again."
        );
        // Distinct from the failure exit below, so a script can tell
        // "you did not elevate" from "something could not be repaired".
        std::process::exit(2);
    }

    let stopped = stop_service_for_repair();
    println!("  {}", stopped.line);

    let exe_dir = exe_dir()?;
    let config = config_dir();
    // Best-effort: the log and the config directory both live here, and
    // a repair on a half-removed install may find neither.
    let _ = security::create_protected_dir(&config);
    let mut engines = engines::Engines::new(exe_dir.clone(), config);
    let report = engines::repair::run(&mut engines);

    for step in &report.steps {
        let (mark, detail) = match &step.outcome {
            neoconnect_ipc::RepairOutcome::AlreadyClean => ("ok  ", "nothing of ours was there".to_string()),
            neoconnect_ipc::RepairOutcome::Fixed { detail } => ("FIXED", detail.clone()),
            neoconnect_ipc::RepairOutcome::Failed { detail } => ("FAIL", detail.clone()),
            neoconnect_ipc::RepairOutcome::Unknown { detail } => ("????", detail.clone()),
        };
        println!("  [{mark}] {} -- {detail}", step.label);
    }

    let restarted = start_service_after_repair(stopped.was_running);
    if let Some(line) = &restarted {
        println!("  {line}");
    }

    let failed = report.failed();
    let indeterminate = report.indeterminate();
    let log = config_dir().join("cleanup.log");
    println!();

    if failed.is_empty() && indeterminate.is_empty() {
        println!("Everything was either already clean or has been repaired.");
        println!("A full record is in {}.", log.display());
        return Ok(());
    }

    // Reported before the failures, and to stdout, because on its own
    // this is not bad news: every check that completed was a success and
    // the repair did its work. Saying "could not be repaired" here --
    // which this used to, by lumping both kinds into one list -- tells a
    // customer the tool failed when nothing established that it had.
    if !indeterminate.is_empty() {
        println!("These checks could not be completed, so they say nothing either way:");
        for step in &indeterminate {
            println!("  - {}", step.label);
        }
        println!(
            "\nThis usually means a helper took too long on a busy machine. It does\n\
             not mean anything was left behind. A full record is in {}.",
            log.display()
        );
    }

    // Named, not counted. "3 steps failed" tells whoever is helping
    // nothing; "the WireGuard tunnel service is still registered" tells
    // them what to do next.
    if !failed.is_empty() {
        if !indeterminate.is_empty() {
            eprintln!();
        }
        eprintln!("Some things could not be repaired:");
        for step in &failed {
            eprintln!("  - {}", step.label);
        }
        eprintln!("\nA full record is in {}.", log.display());
        eprintln!("Restarting Windows clears most of what is left; if it does not, send that file to support.");
        // Only a step that determined something was wrong gets here. An
        // indeterminate step establishes nothing, and exiting non-zero
        // over one would assert a failure this code never verified.
        std::process::exit(1);
    }

    Ok(())
}

/// The outcome of stopping the service before a repair.
struct ServiceStop {
    /// Whether it was running when asked. Decides whether it is started
    /// again afterwards -- a service that was already stopped is left
    /// stopped, because this command must not silently change what the
    /// machine was doing.
    was_running: bool,
    /// What to print. One sentence, aimed at whoever is reading the
    /// output rather than at a log.
    line: String,
}

fn stop_service_for_repair() -> ServiceStop {
    let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
        return ServiceStop {
            was_running: false,
            line: "The service manager could not be reached; repairing anyway.".into(),
        };
    };
    let Ok(service) = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
    ) else {
        return ServiceStop {
            was_running: false,
            line: "The Neoxify service is not installed; repairing anyway.".into(),
        };
    };

    let running = matches!(service.query_status(), Ok(s) if s.current_state != ServiceState::Stopped);
    if !running {
        return ServiceStop {
            was_running: false,
            line: "The Neoxify service was already stopped.".into(),
        };
    }

    let _ = service.stop();
    let deadline = std::time::Instant::now() + SERVICE_STOP_BUDGET;
    while std::time::Instant::now() < deadline {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => {
                return ServiceStop {
                    was_running: true,
                    line: "Stopped the Neoxify service so nothing fights the repair.".into(),
                }
            }
            Err(_) => break,
            Ok(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    ServiceStop {
        was_running: true,
        // Said plainly. The repair below is still worth running -- most
        // of what it removes outlives any process -- but a service that
        // would not stop may put some of it back, and whoever is reading
        // this needs to know that rather than be told it all went.
        line: format!(
            "The Neoxify service did not stop within {}s; repairing anyway, \
             but restart Windows if anything below comes back.",
            SERVICE_STOP_BUDGET.as_secs()
        ),
    }
}

/// Puts the service back, if this command took it away.
///
/// Returns the line to print, or `None` when there is nothing to say.
fn start_service_after_repair(was_running: bool) -> Option<String> {
    if !was_running {
        return None;
    }
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::START).ok()?;
    match service.start(&[] as &[&std::ffi::OsStr]) {
        Ok(()) => Some("Started the Neoxify service again.".into()),
        // Not fatal, and not hidden either: the service is AutoStart, so
        // a reboot brings it back, but until then Connect will not work
        // and the customer deserves to know which of the two problems
        // they have.
        Err(e) => Some(format!(
            "The Neoxify service could not be started again ({e}). Restart Windows, or reinstall Neoxify."
        )),
    }
}

/// Whether this process is running with administrator rights.
///
/// Asked before anything is attempted rather than discovered halfway
/// through: without elevation the registry sweep, the service manager
/// and netsh all fail *individually*, so the output would be a wall of
/// unrelated errors that reads like a broken product instead of a
/// missing "Run as administrator".
///
/// Uses the generated `TOKEN_ELEVATION` binding rather than a
/// hand-declared struct, which is a rule in this codebase paid for in a
/// memory-corrupting crash -- see `engines/ras.rs`.
fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle that needs no
    // release; `token` is a valid out-pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    // SAFETY: zeroed is a valid TOKEN_ELEVATION -- a single u32.
    let mut elevation: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut returned = 0u32;
    // SAFETY: `token` is live, and the buffer and its length match the
    // information class being asked for.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    // SAFETY: `token` came from OpenProcessToken and is not used again.
    unsafe { CloseHandle(token) };
    ok != 0 && elevation.TokenIsElevated != 0
}

/// Registers and starts the service. Run by the installer, elevated --
/// this is the one and only elevation the product asks of the user.
fn install() -> Result<(), Box<dyn std::error::Error>> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)?;
    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: SERVICE_TYPE,
        // Autostart so a reboot doesn't silently leave Connect broken
        // until the user reinstalls.
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::env::current_exe()?,
        launch_arguments: vec![],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let service = match manager.create_service(&service_info, ServiceAccess::START | ServiceAccess::CHANGE_CONFIG) {
        Ok(service) => service,
        // Reinstalling over an existing install is a normal upgrade
        // path, not an error worth failing the installer over.
        Err(_) => {
            let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
            manager.open_service(SERVICE_NAME, ServiceAccess::START | ServiceAccess::CHANGE_CONFIG)?
        }
    };
    service.set_description("Manages Neoxify VPN tunnels so connecting never requires an administrator prompt.")?;
    set_recovery_actions(&service);
    let _ = service.start(&[] as &[&std::ffi::OsStr]);
    Ok(())
}

/// Tells the Service Control Manager to start this service again if it
/// ever dies.
///
/// Windows' default is to do nothing at all, and a service registered
/// with that default is a service that stops existing the first time it
/// panics. Everything that keeps a machine's networking honest lives in
/// this process: the idle watchdog that tears a tunnel down once the app
/// stops talking (see `pipe::spawn_idle_watchdog`), the reconcile that
/// removes leftovers at start, and the NRPT rule whose removal is the
/// difference between a working resolver and none. A dead service means
/// a machine left full-tunnelled or DNS-stranded with nothing that will
/// ever fix it -- and the customer has no reason to suspect a service
/// they never knew was there.
///
/// Three attempts at widening intervals, then stop: 5s catches a
/// transient fault, 30s and 60s cover something slower to clear, and
/// beyond that the fault is not transient and restarting forever would
/// only churn. The counter resets after a day without a failure, so a
/// machine that fails once a week is retried every time rather than
/// being written off for good.
///
/// Best-effort, deliberately. This runs during install, and a service
/// that is registered and running but without recovery configured is
/// enormously better than an installer that failed -- which is a
/// product that cannot connect at all.
fn set_recovery_actions(service: &windows_service::service::Service) {
    let restart_after = |secs| ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(secs),
    };
    let actions = ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![restart_after(5), restart_after(30), restart_after(60)]),
    };
    if let Err(err) = service.update_failure_actions(actions) {
        cleanup_log::note("set the service's recovery actions", &err.to_string());
    }
}

/// Stops and deregisters the service, waiting for the process to
/// actually exit.
///
/// The wait is the point, not politeness. `stop()` only *requests* a
/// stop, and the process keeps its own executable locked until it really
/// exits -- so returning early makes the very next step (overwriting
/// that executable) fail with "Error opening file for writing". That is
/// exactly what happened when reinstalling over a running install, and
/// it would happen on every auto-update too, so this waits rather than
/// hoping the timing works out.
fn uninstall() -> Result<(), Box<dyn std::error::Error>> {
    // Before the service is stopped, while something still knows how to
    // undo what was done.
    //
    // Uninstalling Neoxify while connected used to leave the WireGuard
    // tunnel service registered on the machine. It is a Windows service
    // in its own right and starts automatically, so it would come back
    // on every boot -- taking the default route and DNS with it -- with
    // the application that created it now deleted and no way for the
    // user to find or remove it. Removing the VPN would permanently
    // break their network, which is about the worst outcome an uninstall
    // can have.
    //
    // Best-effort throughout: an uninstall that cannot clean up must
    // still uninstall, or the user is stuck with both problems.
    if let Ok(exe_dir) = exe_dir() {
        let mut engines = engines::Engines::new(exe_dir, config_dir());
        if let Err(err) = engines.uninstall_cleanup() {
            cleanup_log::note("tear the tunnel down before uninstalling", &err);
        }
    }

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS,
    )?;

    // A service that is already stopped errors here, which must not stop
    // the uninstall from removing it.
    let _ = service.stop();

    // Generous but bounded: a hung service must not wedge the installer
    // forever. If it does time out, the delete below still marks it for
    // removal, and the installer surfaces the file-write error rather
    // than silently shipping a half-updated install.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => break,
            // Already gone is a fine outcome for a function whose job is
            // to make it gone.
            Err(_) => break,
            Ok(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }

    service.delete()?;
    Ok(())
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(err) = run_service() {
        eprintln!("service failed: {err}");
    }
}

fn run_service() -> Result<(), Box<dyn std::error::Error>> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let mut shutdown_tx = Some(shutdown_tx);

    let status_handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        ServiceControl::Stop | ServiceControl::Shutdown => {
            if let Some(tx) = shutdown_tx.take() {
                let _ = tx.send(());
            }
            ServiceControlHandlerResult::NoError
        }
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;

    let running = |state: ServiceState, accept: ServiceControlAccept| ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    status_handle.set_service_status(running(ServiceState::Running, ServiceControlAccept::STOP))?;

    let config_dir = config_dir();
    security::create_protected_dir(&config_dir)?;
    let mut engines = engines::Engines::new(exe_dir()?, config_dir);

    // Tear down anything left over from a previous life, before serving
    // anyone.
    //
    // This is the fix for the worst bug testers reported -- "installing
    // the VPN broke my network and some apps stopped working". The cause
    // is that `wireguard.exe /installtunnelservice` registers a Windows
    // service of its own, and Windows services are automatic: it starts
    // at boot whether or not Neoxify is running. So a crash, a force
    // quit, or simply rebooting while connected leaves a machine whose
    // default route and DNS point into a tunnel that nothing is managing
    // and that may never come up. Nothing in the product noticed,
    // because the only teardown path ran when the app asked for it.
    //
    // At the moment this service starts, no client has asked for
    // anything, so by definition any tunnel present is a leftover. This
    // service is AutoStart too, which means the machine now heals itself
    // on the next boot rather than needing the app opened.
    // Done before the value is shared, so it needs no lock and cannot
    // race a client that connects the instant the pipe opens.
    if let Err(err) = engines.disconnect() {
        // Not fatal: a failed cleanup must not stop the service coming
        // up, or a stuck tunnel would also cost the user the ability to
        // connect at all. Recorded rather than printed: a service's
        // standard error goes nowhere, and this is the one teardown
        // nobody is ever watching, because it runs at boot.
        cleanup_log::note("clear leftovers at service start", &err);
    }

    let engines = Arc::new(Mutex::new(engines));

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        let serving = pipe::serve(Arc::clone(&engines));
        tokio::select! {
            result = serving => {
                if let Err(err) = result {
                    eprintln!("pipe server stopped: {err}");
                }
            }
            _ = shutdown_rx => {}
        }
        // Leaving a tunnel up after the service that manages it has gone
        // away would strand the machine's routing table pointed at an
        // engine nothing is tracking.
        let _ = engines.lock().await.disconnect();
    });

    status_handle.set_service_status(running(ServiceState::Stopped, ServiceControlAccept::empty()))?;
    Ok(())
}
