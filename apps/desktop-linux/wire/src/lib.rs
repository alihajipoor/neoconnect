//! Requests and replies that exist only on Linux.
//!
//! The Windows service and the Linux helper speak one wire contract, the
//! `neoconnect-ipc` crate, and that crate ships to live Windows users.
//! Two things the Linux client does have no counterpart in it: installing
//! an update (a distribution package handed to the package manager, where
//! Windows runs an installer) and a diagnostics report whose fields are
//! Linux's own. Rather than widen the shared contract for them, they live
//! here, used by the helper and by the app's Rust side and by nothing
//! else.
//!
//! On the socket they look like every other request: one JSON object per
//! line, tagged `type`, answered by one JSON object tagged `status`. The
//! helper reads a line as a [`LinuxRequest`] when its `type` is one of
//! the names below and as a shared `Request` otherwise. An error is
//! answered in the shared shape, `{"status":"error","message":"..."}`,
//! so the app has one way to read a refusal.

use serde::{Deserialize, Serialize};

/// The `type` values that belong to this crate, for the helper's
/// dispatcher to tell the two contracts apart without parsing twice.
pub const LINUX_REQUEST_TYPES: [&str; 4] = ["updateSupport", "installUpdate", "updateOutcome", "linuxDiagnostics"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LinuxRequest {
    /// Can this install update itself, and from which kind of package?
    UpdateSupport,
    /// Install a newer Neoxify package the app has downloaded.
    ///
    /// `package` is the absolute path of the downloaded file and
    /// `signature` is the text of the published `.sig` beside it, exactly
    /// as the updates API returns it (what `tauri signer sign` writes:
    /// base64 of a minisign signature).
    ///
    /// The helper is root and this is the one request that makes it run
    /// a program the request brought, so everything about it is checked
    /// by the helper and nothing is taken on trust: the file is copied
    /// into a root-only directory first and only the copy is used; the
    /// signature must verify against the updater key compiled into the
    /// helper; the package must be Neoxify's own; its version must be
    /// newer than the running helper's, so an old signed package cannot
    /// be replayed to bring back an old flaw; and no tunnel may be up.
    /// The answer is `UpdateStarted` once the package manager has been
    /// started. The helper itself is restarted by the package's own
    /// scripts, so how it went is asked afterwards with `UpdateOutcome`.
    InstallUpdate { package: String, signature: String },
    /// How the last install started by `InstallUpdate` went. Survives the
    /// helper being replaced, because the new helper answers it.
    UpdateOutcome,
    /// What the helper can see of the machine, for the Support screen.
    LinuxDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LinuxResponse {
    #[serde(rename_all = "camelCase")]
    UpdateSupport {
        /// The package format this install came from, or `None` when it
        /// is not an install the helper can update (run from a build
        /// directory, or no package manager it knows).
        kind: Option<PackageKind>,
        /// The running helper's own version.
        version: String,
        /// Why not, in plain words, when `kind` is `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    UpdateStarted,
    UpdateOutcome {
        outcome: UpdateOutcome,
    },
    LinuxDiagnostics {
        diagnostics: Box<LinuxDiagnostics>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageKind {
    Deb,
    Rpm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateOutcome {
    /// No install has been started since this version was installed.
    None,
    /// The package manager is still working.
    Running { version: String },
    /// It finished and the running helper is that version.
    Installed { version: String },
    /// It did not install; `detail` is the package manager's last words.
    Failed { version: String, detail: String },
}

/// What the helper can see, in plain counts and names. Never an address,
/// a key or a user's path.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDiagnostics {
    pub helper_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageKind>,
    /// Each of our tunnel interfaces and whether it exists now.
    pub our_links: Vec<LinkPresence>,
    /// Names of tunnel interfaces that are up and are not ours: another
    /// VPN is the commonest reason ours misbehaves.
    pub other_vpns_up: Vec<String>,
    /// Routes carrying our mark, and policy-routing rules of ours.
    pub our_routes: u32,
    pub our_rules: u32,
    /// Whether our nftables tables exist: leak protection (or the hold),
    /// and Custom mode's.
    pub firewall_table: bool,
    pub split_table: bool,
    /// "systemd-resolved" or "resolv.conf", and whether lookups are
    /// pointed at a tunnel of ours right now.
    pub dns_mode: String,
    pub dns_pointed_at_us: bool,
    /// Engine processes of ours running without a session.
    pub orphaned_engines: u32,
    /// Entries the crash ledger still says are owed back to the machine.
    pub owed: u32,
    /// Unified control groups (cgroup v2) are there: Custom mode and the
    /// reconnect hold need them.
    pub control_groups: bool,
    /// The distribution's programs each protocol needs, by name, and
    /// whether each was found.
    pub programs: Vec<ProgramPresence>,
    /// The helper's own last log lines, already free of secrets.
    pub recent_log: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPresence {
    pub name: String,
    pub present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramPresence {
    pub name: String,
    pub present: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listed_types_are_exactly_the_requests() {
        let all = [
            LinuxRequest::UpdateSupport,
            LinuxRequest::InstallUpdate { package: "/x".into(), signature: "s".into() },
            LinuxRequest::UpdateOutcome,
            LinuxRequest::LinuxDiagnostics,
        ];
        let mut seen = Vec::new();
        for r in &all {
            let v = serde_json::to_value(r).unwrap();
            seen.push(v["type"].as_str().unwrap().to_string());
        }
        seen.sort();
        let mut listed: Vec<String> = LINUX_REQUEST_TYPES.iter().map(|s| s.to_string()).collect();
        listed.sort();
        assert_eq!(seen, listed);
    }

    #[test]
    fn replies_are_tagged_status_in_camel_case() {
        let v = serde_json::to_value(LinuxResponse::UpdateSupport {
            kind: Some(PackageKind::Deb),
            version: "0.2.0".into(),
            reason: None,
        })
        .unwrap();
        assert_eq!(v["status"], "updateSupport");
        assert_eq!(v["kind"], "deb");
        let v = serde_json::to_value(LinuxResponse::UpdateOutcome {
            outcome: UpdateOutcome::Failed { version: "0.2.1".into(), detail: "x".into() },
        })
        .unwrap();
        assert_eq!(v["outcome"]["state"], "failed");
    }
}
