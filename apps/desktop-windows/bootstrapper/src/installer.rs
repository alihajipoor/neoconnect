//! Running the installer this executable carries.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

/// The real NSIS installer, baked in at build time by build.rs.
const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.exe"));

/// Whether this build actually carries an installer.
///
/// A payload-less build is possible on purpose so `cargo check` does
/// not require a full Tauri build first -- see build.rs. It must never
/// reach a customer, so it is refused at startup rather than failing
/// later with something that looks like a broken download.
pub fn has_payload() -> bool {
    PAYLOAD.len() > 1024 * 1024
}

/// What the worker thread reports back to the UI.
pub enum Progress {
    Finished,
    Failed(String),
}

/// Writes the payload somewhere runnable and starts it silently.
///
/// `/S` is NSIS's own silent switch. Everything the wizard used to ask
/// has already been asked on this window, so there is nothing left for
/// it to show -- and a second window appearing over this one would look
/// like two installers fighting.
fn run_payload() -> io::Result<()> {
    let target = temp_path();
    std::fs::write(&target, PAYLOAD)?;

    let outcome = shell_execute_and_wait(&target, "/S");

    // Best-effort: the installer has exited, so the file is free, but a
    // scanner holding it open is not worth failing an otherwise
    // successful install over.
    let _ = std::fs::remove_file(&target);

    match outcome? {
        0 => Ok(()),
        code => Err(io::Error::other(format!("The installer stopped with code {code}."))),
    }
}

/// Starts a program through the shell and waits for it to finish.
///
/// `std::process::Command` cannot do this. It goes through
/// `CreateProcess`, which refuses outright -- ERROR_ELEVATION_REQUIRED,
/// error 740 -- when the target's manifest asks for administrator, and
/// it never shows a UAC prompt. Our NSIS installer is `perMachine`, so
/// it always asks. `ShellExecuteEx` is the only call that raises the
/// prompt and then hands back a process to wait on.
fn shell_execute_and_wait(program: &Path, parameters: &str) -> io::Result<u32> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let file: Vec<u16> = program.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let verb = wide("runas");
    let params = wide(parameters);

    // SAFETY: a zeroed SHELLEXECUTEINFOW is the documented starting
    // point; every pointer below outlives the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    // NOCLOSEPROCESS is what makes hProcess valid afterwards, which is
    // the only way to wait for it. NOASYNC is required because this
    // runs on a worker thread rather than the one pumping messages.
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;

    // SAFETY: `info` is fully initialised and its pointers are alive.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let err = io::Error::last_os_error();
        // 1223 is ERROR_CANCELLED: the customer chose No at the UAC
        // prompt. The one failure here somebody causes on purpose, so
        // it is named rather than shown as a number they cannot act on.
        if err.raw_os_error() == Some(1223) {
            return Err(io::Error::other("Installation was cancelled."));
        }
        return Err(err);
    }

    if info.hProcess.is_null() {
        return Err(io::Error::other("The installer did not start."));
    }

    // SAFETY: a live process handle from a successful ShellExecuteEx.
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if ok == 0 {
            return Err(io::Error::other("The installer's result could not be read."));
        }
        Ok(code)
    }
}

/// A unique path per run, so two copies started at once cannot overwrite
/// each other's payload mid-execution.
fn temp_path() -> PathBuf {
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    dir.join(format!("neoxify-setup-{pid}.exe"))
}

/// Runs the install off the UI thread and reports the outcome.
///
/// On its own thread because the whole point of this window is that it
/// keeps drawing while the install runs; doing the work inline would
/// freeze it at the moment the customer is watching it hardest.
pub fn start(report: Sender<Progress>) {
    std::thread::spawn(move || {
        let outcome = match run_payload() {
            Ok(()) => Progress::Finished,
            Err(e) => Progress::Failed(e.to_string()),
        };
        let _ = report.send(outcome);
    });
}
