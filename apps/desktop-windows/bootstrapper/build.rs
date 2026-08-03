//! Bakes the real NSIS installer into this executable.
//!
//! The customer downloads one file. That file is this bootstrapper, and
//! the installer it runs is carried inside it -- so there is nothing to
//! fetch at install time and nothing that can go missing between the
//! download and the double-click.
//!
//! The path comes from `NEOXIFY_SETUP`, set by the release script after
//! `tauri build` has produced the installer. When it is unset the build
//! still succeeds with an empty payload, because `cargo check` and CI
//! run in trees where no installer has been built -- and a bootstrapper
//! that refuses to compile without an 18 MB artifact would make every
//! type check depend on a full Tauri build. An empty payload is caught
//! at startup instead, loudly, where it cannot be mistaken for a
//! working installer.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=NEOXIFY_SETUP");

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is always set")).join("payload.exe");

    match std::env::var("NEOXIFY_SETUP") {
        Ok(source) if !source.is_empty() => {
            println!("cargo:rerun-if-changed={source}");
            std::fs::copy(&source, &out)
                .unwrap_or_else(|e| panic!("could not read the installer at {source}: {e}"));
        }
        _ => {
            println!(
                "cargo:warning=NEOXIFY_SETUP is not set, so this build carries no installer and \
                 will refuse to run. Set it to the path of Neoxify_<version>_x64-setup.exe."
            );
            std::fs::write(&out, b"").expect("could not write the placeholder payload");
        }
    }
}
