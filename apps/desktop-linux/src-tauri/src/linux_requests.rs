//! The requests only the Linux helper answers (the `neoxify-linux-wire`
//! crate): its diagnostics report and installing an update. They travel
//! the same socket as everything else, one line each way; only the reply
//! is decoded against a different enum.

use std::time::Duration;

use neoxify_linux_wire::{LinuxDiagnostics, LinuxRequest, LinuxResponse, PackageKind, UpdateOutcome};

/// Ordinary requests: the helper reads files and a few small tables.
const REPLY_TIMEOUT: Duration = Duration::from_secs(45);

/// An install is answered once the package manager has been started, but
/// before that the helper copies the package and checks its signature,
/// which on a slow disk with a large file takes a while.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);

async fn ask(request: &LinuxRequest, timeout: Duration) -> Result<LinuxResponse, String> {
    let line = crate::vpn::exchange(request, timeout).await?;
    decode(&line)
}

/// A refusal comes back in the shared shape, `{"status":"error",...}`, so
/// it is looked for first; anything else must be one of this crate's
/// replies.
fn decode(line: &str) -> Result<LinuxResponse, String> {
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("could not decode the background service's reply: {e}"))?;
    if value.get("status").and_then(|s| s.as_str()) == Some("error") {
        return Err(value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("the background service refused the request")
            .to_string());
    }
    serde_json::from_value(value).map_err(|_| unexpected())
}

fn unexpected() -> String {
    "the background service returned an unexpected reply".to_string()
}

/// What the helper can see of the machine, for the Support screen.
#[tauri::command]
pub async fn vpn_linux_diagnostics() -> Result<LinuxDiagnostics, String> {
    match ask(&LinuxRequest::LinuxDiagnostics, REPLY_TIMEOUT).await? {
        LinuxResponse::LinuxDiagnostics { diagnostics } => Ok(*diagnostics),
        _ => Err(unexpected()),
    }
}

#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct UpdateSupport {
    kind: Option<PackageKind>,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Whether this install can update itself, and from which package format.
#[tauri::command]
pub async fn linux_update_support() -> Result<UpdateSupport, String> {
    match ask(&LinuxRequest::UpdateSupport, REPLY_TIMEOUT).await? {
        LinuxResponse::UpdateSupport { kind, version, reason } => Ok(UpdateSupport { kind, version, reason }),
        _ => Err(unexpected()),
    }
}

/// Hands the downloaded package to the helper, which checks everything
/// about it before the package manager sees it. Resolves once the package
/// manager has started; the helper is then replaced, and how it went is
/// asked with `linux_update_outcome`.
#[tauri::command]
pub async fn linux_update_install(state: tauri::State<'_, crate::update::Downloaded>) -> Result<(), String> {
    let Some(download) = state.current() else {
        return Err("There is no downloaded update to install. Download it again.".to_string());
    };
    if !download.path.is_file() {
        return Err("The downloaded update is gone. Download it again.".to_string());
    }
    let request = LinuxRequest::InstallUpdate {
        package: download.path.to_string_lossy().into_owned(),
        signature: download.signature.clone(),
    };
    match ask(&request, INSTALL_TIMEOUT).await? {
        LinuxResponse::UpdateStarted => Ok(()),
        _ => Err(unexpected()),
    }
}

/// How the last install went: `{state}` plus `version` and `detail` as
/// the helper reports them. The new helper answers this, so it is asked
/// after the old one has been replaced.
#[tauri::command]
pub async fn linux_update_outcome() -> Result<UpdateOutcome, String> {
    match ask(&LinuxRequest::UpdateOutcome, REPLY_TIMEOUT).await? {
        LinuxResponse::UpdateOutcome { outcome } => Ok(outcome),
        _ => Err(unexpected()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_in_the_shared_shape_is_its_sentence() {
        let err = decode(r#"{"status":"error","message":"A tunnel is up; disconnect first."}"#).unwrap_err();
        assert_eq!(err, "A tunnel is up; disconnect first.");
    }

    #[test]
    fn a_shared_reply_where_a_linux_one_was_expected_is_unexpected() {
        assert_eq!(decode(r#"{"status":"ok"}"#).unwrap_err(), unexpected());
    }

    #[test]
    fn the_outcome_reaches_the_interface_in_its_shape() {
        let reply = decode(r#"{"status":"updateOutcome","outcome":{"state":"failed","version":"0.2.1","detail":"x"}}"#)
            .unwrap();
        let LinuxResponse::UpdateOutcome { outcome } = reply else { panic!() };
        let json = serde_json::to_value(outcome).unwrap();
        assert_eq!(json, serde_json::json!({"state":"failed","version":"0.2.1","detail":"x"}));
        let none = serde_json::to_value(UpdateOutcome::None).unwrap();
        assert_eq!(none, serde_json::json!({"state":"none"}));
    }

    #[test]
    fn support_without_a_kind_is_null_with_the_reason() {
        let json = serde_json::to_value(UpdateSupport {
            kind: None,
            version: "0.2.0".into(),
            reason: Some("run from a build directory".into()),
        })
        .unwrap();
        assert_eq!(json["kind"], serde_json::Value::Null);
        assert_eq!(json["reason"], "run from a build directory");
        let json = serde_json::to_value(UpdateSupport { kind: Some(PackageKind::Rpm), version: "0.2.0".into(), reason: None })
            .unwrap();
        assert_eq!(json, serde_json::json!({"kind":"rpm","version":"0.2.0"}));
    }
}
