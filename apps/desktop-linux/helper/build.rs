//! Compiles the updater's public key into the helper from its one place,
//! the Windows app's `tauri.conf.json`, so the key an in-app update is
//! checked against can never drift from the one releases are signed for.
//! A config without the key fails the build rather than ship a helper that
//! could verify nothing.

use std::path::PathBuf;

fn main() {
    let conf = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../desktop-windows/src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    let text = std::fs::read_to_string(&conf).unwrap_or_else(|e| panic!("reading {}: {e}", conf.display()));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {}: {e}", conf.display()));
    let key = value
        .pointer("/plugins/updater/pubkey")
        .and_then(|k| k.as_str())
        .filter(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)))
        .unwrap_or_else(|| panic!("{} has no usable plugins.updater.pubkey", conf.display()));
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("updater_key.rs");
    std::fs::write(
        out,
        format!("/// The updater's public key: base64 of a minisign public-key file.\npub const UPDATER_PUBKEY: &str = \"{key}\";\n"),
    )
    .unwrap();
}
