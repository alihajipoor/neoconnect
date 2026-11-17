//! What of ours the machine shows, read from the kernel and the
//! filesystem rather than remembered, for Repair (which looks before it
//! acts, so its report says what was really found) and for Diagnostics.
//!
//! Every program is run from the system's own directories by full path:
//! this is root, and a `PATH` lookup would run whatever came first in it.
//! Every count is `None` when the look itself failed, which a report says
//! as "could not look" -- never as clean.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use neoxify_tunnel::Dirs;

use crate::hold::OUR_LINKS;

/// The routing tables of ours: WireGuard's, Custom mode's two (the chosen
/// apps', and lookups'), and the one strongSwan is given for IKEv2.
pub const OUR_TABLES: [&str; 4] = ["28280", "28281", "28282", "28283"];
/// The protocol number our routes carry (`tunnel`'s `ROUTE_PROTO`).
pub const ROUTE_PROTO: &str = "98";
/// Custom mode's own nftables table, beside leak protection's.
pub const SPLIT_TABLE: &str = "neoxify_split";
/// Our control groups, at the root of the unified hierarchy.
pub const GROUPS: [&str; 2] = ["neoxify.split", "neoxify.app"];
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const RESOLVED_SOCKET: &str = "/run/systemd/resolve/io.systemd.Resolve";
/// The tunnel crate's crash ledger, in `Dirs::state`.
const OWED_FILE: &str = "owed.json";

/// How long one look may take.
const LOOK_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Survey {
    /// Engine processes of ours running.
    pub engines: Option<u32>,
    /// DNS changes the ledger says are in force.
    pub dns: Option<u32>,
    pub routes: Option<u32>,
    pub rules: Option<u32>,
    /// Leak protection's (or the hold's) table.
    pub firewall: Option<bool>,
    pub split_table: Option<bool>,
    /// Our interfaces that exist.
    pub links: Option<Vec<String>>,
    /// Our control groups that exist, and how many processes each holds.
    pub groups: Option<Vec<(String, u32)>>,
    /// Entries the crash ledger still owes.
    pub owed: Option<u32>,
}

/// A system program by name, from the system's own directories only.
pub fn program(name: &str) -> Option<PathBuf> {
    ["/usr/sbin", "/sbin", "/usr/bin", "/bin"].iter().map(|dir| Path::new(dir).join(name)).find(|p| p.is_file())
}

/// Runs a system program with a deadline; a program that does not finish
/// in time is killed and is an error.
pub fn run(name: &str, args: &[&str], wait: Duration) -> Result<Output, String> {
    let path = program(name).ok_or_else(|| format!("{name} is not installed"))?;
    let mut child = Command::new(&path)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{name} could not be started: {e}"))?;
    let until = Instant::now() + wait;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|e| format!("{name}: {e}")),
            Ok(None) if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} did not finish in {}s", wait.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
}

pub fn survey(dirs: &Dirs) -> Survey {
    let owed = read_owed(&dirs.state);
    Survey {
        engines: count_engines(dirs),
        dns: owed.as_ref().map(|all| all.iter().filter(|k| k.as_str() == "resolvedLink" || k.as_str() == "resolvConf").count() as u32),
        routes: count_routes(),
        rules: count_rules(),
        firewall: nft_tables().map(|t| t.iter().any(|n| n == neoxify_netguard::TABLE)),
        split_table: nft_tables().map(|t| t.iter().any(|n| n == SPLIT_TABLE)),
        links: Some(OUR_LINKS.iter().filter(|n| Path::new("/sys/class/net").join(n).exists()).map(|n| n.to_string()).collect()),
        groups: groups(),
        owed: owed.map(|all| all.len() as u32),
    }
}

/// The kinds of what the ledger owes, or `None` when it could not be read.
/// No file is nothing owed.
fn read_owed(state: &Path) -> Option<Vec<String>> {
    let text = match std::fs::read_to_string(state.join(OWED_FILE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    if text.trim().is_empty() {
        return Some(Vec::new());
    }
    let all: Vec<serde_json::Value> = serde_json::from_str(&text).ok()?;
    Some(all.iter().map(|o| o.get("kind").and_then(|k| k.as_str()).unwrap_or("").to_string()).collect())
}

/// Our engines: the bundled Xray by its full path, and any program
/// started with a file from our private run directory (OpenVPN's config,
/// which only we write).
fn count_engines(dirs: &Dirs) -> Option<u32> {
    let xray = dirs.bin.join("xray");
    let run = dirs.run.to_string_lossy().to_string();
    let entries = std::fs::read_dir("/proc").ok()?;
    let mut count = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|s| s.bytes().all(|b| b.is_ascii_digit())) else { continue };
        let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
        let ours = exe.as_deref() == Some(xray.as_path())
            || std::fs::read(format!("/proc/{pid}/cmdline"))
                .is_ok_and(|raw| raw.split(|b| *b == 0).any(|arg| String::from_utf8_lossy(arg).starts_with(&run)));
        if ours {
            count += 1;
        }
    }
    Some(count)
}

fn json_rows(args: &[&str]) -> Option<Vec<serde_json::Value>> {
    let out = run("ip", args, LOOK_WAIT).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text.trim().is_empty() {
        return Some(Vec::new());
    }
    serde_json::from_str(&text).ok()
}

fn count_routes() -> Option<u32> {
    let v4 = json_rows(&["-j", "route", "show", "table", "all", "proto", ROUTE_PROTO])?;
    let v6 = json_rows(&["-j", "-6", "route", "show", "table", "all", "proto", ROUTE_PROTO])?;
    Some((v4.len() + v6.len()) as u32)
}

fn count_rules() -> Option<u32> {
    let mut count = 0;
    for family in [None, Some("-6")] {
        let mut args = vec!["-j"];
        args.extend(family);
        args.extend(["rule", "show"]);
        let rows = json_rows(&args)?;
        count += rows
            .iter()
            .filter(|r| {
                let table = r.get("table").map(|t| t.as_str().map(str::to_string).unwrap_or_else(|| t.to_string()));
                table.is_some_and(|t| OUR_TABLES.contains(&t.as_str()))
            })
            .count();
    }
    Some(count as u32)
}

/// The names of the `inet` tables nftables holds.
fn nft_tables() -> Option<Vec<String>> {
    let out = run("nft", &["list", "tables", "inet"], LOOK_WAIT).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().strip_prefix("table inet ").map(|n| n.trim().to_string()))
            .collect(),
    )
}

fn groups() -> Option<Vec<(String, u32)>> {
    if !Path::new(CGROUP_ROOT).join("cgroup.controllers").exists() {
        // No unified hierarchy: none of ours can exist.
        return Some(Vec::new());
    }
    let mut found = Vec::new();
    for name in GROUPS {
        let dir = Path::new(CGROUP_ROOT).join(name);
        if dir.is_dir() {
            found.push((name.to_string(), processes_under(&dir)?));
        }
    }
    Some(found)
}

/// Processes in a control group and every group below it.
fn processes_under(dir: &Path) -> Option<u32> {
    let procs = std::fs::read_to_string(dir.join("cgroup.procs")).ok()?;
    let mut count = procs.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            count += processes_under(&entry.path())?;
        }
    }
    Some(count)
}

pub fn remove_split_table() -> Result<bool, String> {
    let out = run("nft", &["delete", "table", "inet", SPLIT_TABLE], LOOK_WAIT)?;
    if out.status.success() {
        return Ok(true);
    }
    match nft_tables() {
        Some(tables) if !tables.iter().any(|t| t == SPLIT_TABLE) => Ok(false),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

/// Our control groups that hold no process, deepest first, since a group
/// with a group inside it cannot be removed. A group still holding a
/// process is left: moving someone's program out of it is not ours to do.
pub fn remove_empty_groups() -> Result<u32, String> {
    fn prune(dir: &Path, removed: &mut u32) -> Result<(), String> {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                prune(&entry.path(), removed)?;
            }
        }
        if processes_under(dir) == Some(0) {
            std::fs::remove_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            *removed += 1;
        }
        Ok(())
    }
    let mut removed = 0;
    for name in GROUPS {
        let dir = Path::new(CGROUP_ROOT).join(name);
        if dir.is_dir() {
            prune(&dir, &mut removed)?;
        }
    }
    Ok(removed)
}

/// Tunnel interfaces that are up and are not ours: another VPN is the
/// commonest reason ours misbehaves.
pub fn other_vpns_up() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else { return Vec::new() };
    let mut found: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|name| !OUR_LINKS.contains(&name.as_str()) && name != "lo")
        .filter(|name| {
            let dir = Path::new("/sys/class/net").join(name);
            let uevent = std::fs::read_to_string(dir.join("uevent")).unwrap_or_default();
            let kind_of_tunnel = dir.join("tun_flags").exists()
                || uevent.lines().any(|l| l == "DEVTYPE=wireguard")
                || ["ppp", "ipsec", "vti", "xfrm", "wg", "tun", "utun"].iter().any(|p| name.starts_with(p));
            let up = std::fs::read_to_string(dir.join("flags"))
                .ok()
                .and_then(|f| u32::from_str_radix(f.trim().trim_start_matches("0x"), 16).ok())
                .is_some_and(|flags| flags & 0x1 != 0);
            kind_of_tunnel && up
        })
        .collect();
    found.sort();
    found
}

pub fn dns_mode() -> &'static str {
    if Path::new(RESOLVED_SOCKET).exists() {
        "systemd-resolved"
    } else {
        "resolv.conf"
    }
}

pub fn control_groups() -> bool {
    Path::new(CGROUP_ROOT).join("cgroup.controllers").exists()
}

/// The programs each protocol needs, and whether each is there.
pub fn programs(dirs: &Dirs) -> Vec<(String, bool)> {
    let mut out = vec![("xray".to_string(), dirs.bin.join("xray").is_file())];
    for name in ["wg", "openvpn", "charon-cmd", "nft", "ip", "resolvectl"] {
        out.push((name.to_string(), program(name).is_some()));
    }
    out
}
