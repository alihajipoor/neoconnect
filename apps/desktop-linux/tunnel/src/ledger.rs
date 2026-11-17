//! The record of what a session owes back to the machine.
//!
//! A route, a DNS change or a link made by a helper that is then killed
//! stays until something removes it -- the Windows service learned this
//! from host routes that outlived every session until a reboot
//! (`route_table::OwedRoutes`). So every change here is written down
//! *before* it is made and struck off only *after* it is undone, and the
//! sweep at the helper's next start undoes whatever is still written.
//! There is no moment at which a change exists and its record does not.
//!
//! The file is in `Dirs::state`, root-only, and survives a crash. It is
//! best effort like any log: a ledger that cannot be written must never
//! fail the connect it describes, and one that cannot be read is treated
//! as owing nothing -- the sweep's own checks (our links, our route
//! protocol) are the second net.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The ledger's file name in `Dirs::state`.
pub(crate) const FILE: &str = "owed.json";

/// One route, exactly as it was added, so it is deleted exactly as it
/// was and never by destination alone: the same address may be routed by
/// something else, and that route is not ours to take.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSpec {
    /// A prefix, `203.0.113.5/32` or `0.0.0.0/1` (or IPv6, with `v6`).
    pub dest: String,
    pub dev: String,
    /// The next hop; `None` for a route on the link itself.
    #[serde(default)]
    pub via: Option<String>,
    /// A routing table other than `main`.
    #[serde(default)]
    pub table: Option<u32>,
    #[serde(default)]
    pub v6: bool,
}

/// One thing owed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Owed {
    Route(RouteSpec),
    /// A route an engine added itself (OpenVPN's host route to its server
    /// through the uplink). It does not carry our protocol, so it is
    /// deleted by destination, gateway and device alone.
    EngineRoute(RouteSpec),
    /// A policy rule, as the arguments after `ip rule add` that made it
    /// (the same ones delete it).
    Rule {
        args: Vec<String>,
        #[serde(default)]
        v6: bool,
    },
    /// systemd-resolved was given DNS settings for this link.
    ResolvedLink { link: String },
    /// `/etc/resolv.conf` was rewritten. `backup` holds what it said
    /// (absent when there was no file); `symlink` is where it pointed when
    /// it was a link; `ours` is what we wrote, so a file someone else has
    /// rewritten since is left alone.
    ResolvConf {
        backup: PathBuf,
        #[serde(default)]
        symlink: Option<PathBuf>,
        existed: bool,
        ours: String,
    },
    /// A network interface we made, or one an engine of ours made.
    Link { name: String },
    /// A file holding credentials (an engine config).
    File { path: PathBuf },
    /// An nftables table of ours (Custom mode's sorting), deleted whole.
    NftTable { family: String, name: String },
    /// A kernel setting under `/proc/sys` changed from `before`, which is
    /// written back.
    Sysctl { path: PathBuf, before: String },
}

impl Owed {
    /// The order a replay undoes things in: routes before the links they
    /// sit on, DNS before the link it names, files last.
    pub(crate) fn rank(&self) -> u8 {
        match self {
            Owed::Route(_) | Owed::EngineRoute(_) => 0,
            Owed::Rule { .. } | Owed::NftTable { .. } | Owed::Sysctl { .. } => 1,
            Owed::ResolvedLink { .. } | Owed::ResolvConf { .. } => 2,
            Owed::Link { .. } => 3,
            Owed::File { .. } => 4,
        }
    }
}

/// One lock for every read-modify-write, so two threads ending two
/// pieces of one session cannot each write back a list missing the
/// other's change.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone)]
pub struct Ledger {
    path: PathBuf,
}

impl Ledger {
    pub fn in_dir(state: &Path) -> Self {
        Self { path: state.join(FILE) }
    }

    pub fn read(&self) -> Vec<Owed> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read_unlocked()
    }

    /// Records a change as owed. Called before it is made.
    pub fn owe(&self, owed: Owed) {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.read_unlocked();
        if !all.contains(&owed) {
            all.push(owed);
        }
        self.write_unlocked(&all);
    }

    /// Strikes a change off. Called after it is undone.
    pub fn settle(&self, owed: &Owed) {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.read_unlocked();
        let before = all.len();
        all.retain(|o| o != owed);
        if all.len() != before {
            self.write_unlocked(&all);
        }
    }

    fn read_unlocked(&self) -> Vec<Owed> {
        std::fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// Written whole to a temporary file and renamed over the ledger, so
    /// a crash mid-write leaves the old list rather than half a new one.
    /// Nothing owed removes the file.
    fn write_unlocked(&self, all: &[Owed]) {
        if all.is_empty() {
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        let Ok(text) = serde_json::to_vec_pretty(all) else { return };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temporary = self.path.with_extension("json.tmp");
        if crate::files::write_private(&temporary, &text).is_ok() && std::fs::rename(&temporary, &self.path).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neoxify-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn host_route() -> Owed {
        Owed::Route(RouteSpec {
            dest: "203.0.113.5/32".into(),
            dev: "eth0".into(),
            via: Some("192.0.2.1".into()),
            table: None,
            v6: false,
        })
    }

    #[test]
    fn owed_until_settled_and_nothing_left_behind() {
        let dir = scratch("settle");
        let ledger = Ledger::in_dir(&dir);
        assert!(ledger.read().is_empty());
        ledger.owe(host_route());
        ledger.owe(host_route());
        ledger.owe(Owed::Link { name: "neoconnect0".into() });
        assert_eq!(ledger.read().len(), 2, "the same change is owed once");

        // A second handle -- the sweep after a crash -- sees the same.
        assert_eq!(Ledger::in_dir(&dir).read(), ledger.read());

        ledger.settle(&host_route());
        assert_eq!(ledger.read(), vec![Owed::Link { name: "neoconnect0".into() }]);
        ledger.settle(&Owed::Link { name: "neoconnect0".into() });
        assert!(!dir.join(FILE).exists(), "nothing owed leaves no file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_ledger_owes_nothing_rather_than_failing() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join(FILE), b"{ not json").unwrap();
        assert!(Ledger::in_dir(&dir).read().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_format_reads_back_and_ranks_routes_before_links() {
        let all = vec![
            Owed::File { path: "/run/neoxify/xray-client.json".into() },
            Owed::Link { name: "neoconnect0".into() },
            Owed::ResolvedLink { link: "neoconnect0".into() },
            Owed::Rule { args: vec!["fwmark".into(), "28280".into()], v6: false },
            host_route(),
        ];
        let text = serde_json::to_string(&all).unwrap();
        let back: Vec<Owed> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, all);
        let mut sorted = back.clone();
        sorted.sort_by_key(Owed::rank);
        assert_eq!(sorted[0], host_route());
        assert!(matches!(sorted[4], Owed::File { .. }));
    }
}
