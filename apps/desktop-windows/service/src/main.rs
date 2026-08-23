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

fn config_dir() -> PathBuf {
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
        // No argument means the service control manager started us.
        _ => service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(Into::into),
    }
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
        eprintln!("could not set service recovery actions: {err}");
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
            eprintln!("uninstall cleanup: {err}");
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
        // connect at all.
        eprintln!("startup cleanup: {err}");
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
