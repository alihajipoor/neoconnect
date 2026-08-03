//! Running the installer this executable carries.

use std::io;
use std::path::PathBuf;
use std::process::Command;
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

    let status = Command::new(&target).arg("/S").status()?;

    // Best-effort: the installer has exited, so the file is free, but a
    // scanner holding it open is not worth failing an otherwise
    // successful install over.
    let _ = std::fs::remove_file(&target);

    if status.success() {
        return Ok(());
    }
    // Cancelling at the UAC prompt lands here. It is the one failure a
    // customer causes deliberately, so it is worth naming rather than
    // reporting as an error code they cannot act on.
    Err(io::Error::other(match status.code() {
        Some(1223) => "Installation was cancelled.".to_string(),
        Some(code) => format!("The installer stopped with code {code}."),
        None => "The installer stopped unexpectedly.".to_string(),
    }))
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
