//! Pointing the machine's DNS at the tunnel, and back.
//!
//! With everything routed into the tunnel, the resolvers the local
//! network handed out (a router, an ISP) are either unreachable or, worse,
//! reached in clear text and answered by whoever is on the path -- in a
//! censored country, with poisoned answers. So while a tunnel is up the
//! machine asks [`TUN_DNS`], through the tunnel.
//!
//! Two ways, by what the machine uses. When systemd-resolved answers the
//! machine's lookups, the tunnel's link gets the resolver, the catch-all
//! routing domain `~.` and the default route, which is what resolved
//! offers VPNs for this, and it goes away by itself with the link. When
//! it does not, `/etc/resolv.conf` is backed up and rewritten, and put
//! back at teardown -- only if it still says what we wrote, so a network
//! manager that rewrote it meanwhile is not overruled with a stale copy.
//!
//! Either way the change is owed in the ledger first, and a failure is
//! never an error: the tunnel stays up and `Up::dns_protected` says no.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed};
use crate::link;

/// The resolver the tunnel's lookups go to, as on Windows.
pub const TUN_DNS: &str = "1.1.1.1";

pub(crate) const RESOLV_CONF: &str = "/etc/resolv.conf";

/// Where the backup of `/etc/resolv.conf` is kept, in `Dirs::state`.
const BACKUP_FILE: &str = "resolv.conf.backup";

/// systemd-resolved's own socket, there only while it runs.
const RESOLVED_SOCKET: &str = "/run/systemd/resolve/io.systemd.Resolve";

/// Which of the two ways applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Way {
    Resolved,
    ResolvConf,
}

/// Whether the machine's lookups go through systemd-resolved: it is
/// running, and `/etc/resolv.conf` sends libc to its stub (or is one of
/// its own files). Resolved can run while a network manager writes
/// resolv.conf itself, and then settings given to resolved change nothing.
pub(crate) fn way_for(resolved_running: bool, resolv_conf: &str, link_target: Option<&Path>) -> Way {
    if !resolved_running {
        return Way::ResolvConf;
    }
    let managed_by_resolved = link_target.is_some_and(|t| t.to_string_lossy().contains("systemd/resolve"));
    let uses_stub = resolv_conf.lines().any(|l| {
        let mut words = l.split_whitespace();
        words.next() == Some("nameserver") && matches!(words.next(), Some("127.0.0.53" | "127.0.0.54"))
    });
    if managed_by_resolved || uses_stub {
        Way::Resolved
    } else {
        Way::ResolvConf
    }
}

fn current_way() -> Way {
    let running = Path::new(RESOLVED_SOCKET).exists() && cmd::find("resolvectl").is_some();
    let text = std::fs::read_to_string(RESOLV_CONF).unwrap_or_default();
    let target = std::fs::read_link(RESOLV_CONF).ok();
    way_for(running, &text, target.as_deref())
}

/// What we write into `/etc/resolv.conf`.
#[cfg(test)]
pub(crate) fn our_resolv_conf() -> String {
    our_resolv_conf_for(TUN_DNS)
}

/// What we write into `/etc/resolv.conf` to send lookups to `resolver`.
pub(crate) fn our_resolv_conf_for(resolver: &str) -> String {
    format!("# Written by Neoxify while connected; put back when it disconnects.\nnameserver {resolver}\n")
}

/// Points the machine's DNS at the tunnel on `link`. Returns what is now
/// owed, or `None` when it could not be done (nothing is owed then).
pub(crate) fn point_at(link_name: &str, state: &Path, ledger: &Ledger, budget: &Budget) -> Option<Owed> {
    point_at_resolver(link_name, TUN_DNS, state, ledger, budget)
}

/// [`point_at`] with a resolver of the profile's choosing (WireGuard's
/// `DNS =`). Anything but a plain IPv4 address is refused: it is written
/// into a file and handed to resolved as an argument, and only an IPv4
/// resolver is reachable through a tunnel that carries IPv4 alone.
pub(crate) fn point_at_resolver(
    link_name: &str,
    resolver: &str,
    state: &Path,
    ledger: &Ledger,
    budget: &Budget,
) -> Option<Owed> {
    resolver.parse::<std::net::Ipv4Addr>().ok()?;
    match current_way() {
        Way::Resolved => {
            let owed = Owed::ResolvedLink { link: link_name.to_string() };
            ledger.owe(owed.clone());
            let steps: [&[&str]; 3] =
                [&["dns", link_name, resolver], &["domain", link_name, "~."], &["default-route", link_name, "yes"]];
            for args in steps {
                let done = cmd::run("resolvectl", args, budget).map(|o| o.success).unwrap_or(false);
                if !done {
                    let _ = undo(&owed, &Budget::quick(cmd::TEARDOWN_CAP));
                    ledger.settle(&owed);
                    return None;
                }
            }
            // Answers cached from before the tunnel came from the network's
            // own resolver; best effort.
            let _ = cmd::run("resolvectl", &["flush-caches"], budget);
            Some(owed)
        }
        Way::ResolvConf => {
            let backup = state.join(BACKUP_FILE);
            let owed = rewrite_resolv_conf_with(Path::new(RESOLV_CONF), &backup, ledger, resolver).ok()?;
            Some(owed)
        }
    }
}

/// Backs `etc` up to `backup`, owes it, then writes ours over it.
#[cfg(test)]
pub(crate) fn rewrite_resolv_conf(etc: &Path, backup: &Path, ledger: &Ledger) -> std::io::Result<Owed> {
    rewrite_resolv_conf_with(etc, backup, ledger, TUN_DNS)
}

/// [`rewrite_resolv_conf`], naming `resolver`.
pub(crate) fn rewrite_resolv_conf_with(
    etc: &Path,
    backup: &Path,
    ledger: &Ledger,
    resolver: &str,
) -> std::io::Result<Owed> {
    let ours = our_resolv_conf_for(resolver);
    let symlink = std::fs::read_link(etc).ok();
    let existing = std::fs::read(etc);
    let existed = existing.is_ok() || symlink.is_some();
    if let Ok(bytes) = &existing {
        if let Some(dir) = backup.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::files::write_private(backup, bytes)?;
    }
    let owed = Owed::ResolvConf { backup: backup.to_path_buf(), symlink: symlink.clone(), existed, ours: ours.clone() };
    ledger.owe(owed.clone());
    // A symlink is replaced by a file, not written through: writing
    // through it would change resolved's or NetworkManager's own file.
    if let Err(e) = replace_or_rewrite(etc, ours.as_bytes()) {
        let _ = std::fs::remove_file(backup);
        ledger.settle(&owed);
        return Err(e);
    }
    Ok(owed)
}

/// Writes a world-readable file by renaming a new one over the old, so
/// a reader never sees it half written and a symlink is replaced rather
/// than followed.
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = temporary_beside(path);
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// [`replace_file`], or, where the file cannot be renamed over because it
/// is a mount point of its own (a container's bind-mounted
/// `/etc/resolv.conf`: the rename fails with EBUSY, or EXDEV across
/// filesystems), the same bytes written into the file in place. Never
/// through a symlink: that would change the file it points at, which is
/// resolved's or NetworkManager's.
pub(crate) fn replace_or_rewrite(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    match replace_file(path, bytes) {
        Err(e) if rename_blocked(&e) && std::fs::read_link(path).is_err() => {
            let mut file = std::fs::OpenOptions::new().write(true).truncate(true).open(path)?;
            file.write_all(bytes)?;
            file.sync_all()
        }
        other => other,
    }
}

/// EBUSY or EXDEV: the rename cannot be done here, though a write can.
fn rename_blocked(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EBUSY) | Some(libc::EXDEV))
}

fn temporary_beside(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".neoxify-tmp");
    path.with_file_name(name)
}

/// Undoes a DNS change. `Ok` when it is undone or there was nothing left
/// to undo; the text says what was found when that is worth a line.
pub(crate) fn undo(owed: &Owed, budget: &Budget) -> Result<Option<String>, String> {
    match owed {
        Owed::ResolvedLink { link: name } => {
            // Resolved forgets a link's settings when the link goes.
            if !link::exists(name) {
                return Ok(None);
            }
            match cmd::run("resolvectl", &["revert", name], budget) {
                Ok(out) if out.success => Ok(None),
                // It went while we asked.
                Ok(_) if !link::exists(name) => Ok(None),
                Ok(out) => Err(format!("resolvectl revert {name}: {}", out.complaint())),
                Err(e) => Err(format!("resolvectl revert {name}: {e}")),
            }
        }
        Owed::ResolvConf { backup, symlink, existed, ours } => {
            restore_resolv_conf(Path::new(RESOLV_CONF), backup, symlink.as_deref(), *existed, ours)
        }
        _ => Ok(None),
    }
}

/// Whether a DNS change made at connect is still in force.
pub(crate) fn still_in_force(owed: &Owed) -> bool {
    match owed {
        Owed::ResolvConf { ours, .. } => resolv_conf_is(Path::new(RESOLV_CONF), ours),
        // Resolved keeps a link's settings until the link goes, and a
        // tunnel whose link has gone is reported down by its engine.
        Owed::ResolvedLink { .. } => true,
        _ => false,
    }
}

/// `etc` is still the file we wrote: not a symlink, and word for word ours.
pub(crate) fn resolv_conf_is(etc: &Path, ours: &str) -> bool {
    std::fs::read_link(etc).is_err() && std::fs::read_to_string(etc).ok().as_deref() == Some(ours)
}

pub(crate) fn restore_resolv_conf(
    etc: &Path,
    backup: &Path,
    symlink: Option<&Path>,
    existed: bool,
    ours: &str,
) -> Result<Option<String>, String> {
    let now_link = std::fs::read_link(etc).ok();
    let now = std::fs::read_to_string(etc).ok();
    let still_ours = now_link.is_none() && now.as_deref() == Some(ours);
    if !still_ours {
        let _ = std::fs::remove_file(backup);
        return Ok(Some(format!(
            "{} was rewritten by something else while connected; left as it is",
            etc.display()
        )));
    }
    let result = if let Some(target) = symlink {
        std::fs::remove_file(etc).and_then(|_| std::os::unix::fs::symlink(target, etc))
    } else if existed {
        std::fs::read(backup).and_then(|bytes| replace_or_rewrite(etc, &bytes))
    } else {
        std::fs::remove_file(etc)
    };
    match result {
        Ok(()) => {
            let _ = std::fs::remove_file(backup);
            Ok(None)
        }
        Err(e) => Err(format!("could not put {} back: {e}", etc.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_is_used_only_when_it_answers_the_machines_lookups() {
        let stub = "nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n";
        let nm = "# Generated by NetworkManager\nnameserver 192.0.2.1\n";
        let stub_link = Path::new("../run/systemd/resolve/stub-resolv.conf");
        assert_eq!(way_for(true, stub, Some(stub_link)), Way::Resolved);
        assert_eq!(way_for(true, stub, None), Way::Resolved);
        assert_eq!(way_for(true, nm, None), Way::ResolvConf, "resolved running beside a written file");
        assert_eq!(way_for(false, stub, Some(stub_link)), Way::ResolvConf, "resolved not running");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neoxify-dns-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_rewritten_file_is_put_back_as_it_was() {
        let dir = scratch("file");
        let etc = dir.join("resolv.conf");
        let original = "nameserver 192.0.2.1\nsearch example.com\n";
        std::fs::write(&etc, original).unwrap();
        let ledger = Ledger::in_dir(&dir);
        let owed = rewrite_resolv_conf(&etc, &dir.join(BACKUP_FILE), &ledger).unwrap();
        assert_eq!(std::fs::read_to_string(&etc).unwrap(), our_resolv_conf());
        assert_eq!(ledger.read(), vec![owed.clone()], "owed while it is ours");
        let Owed::ResolvConf { backup, symlink, existed, ours } = &owed else { panic!() };
        assert_eq!(restore_resolv_conf(&etc, backup, symlink.as_deref(), *existed, ours), Ok(None));
        assert_eq!(std::fs::read_to_string(&etc).unwrap(), original);
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlink_is_replaced_not_written_through_and_comes_back() {
        let dir = scratch("link");
        let target = dir.join("stub-resolv.conf");
        std::fs::write(&target, "nameserver 127.0.0.53\n").unwrap();
        let etc = dir.join("resolv.conf");
        std::os::unix::fs::symlink(&target, &etc).unwrap();
        let ledger = Ledger::in_dir(&dir);
        let owed = rewrite_resolv_conf(&etc, &dir.join(BACKUP_FILE), &ledger).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "nameserver 127.0.0.53\n", "the target is untouched");
        let Owed::ResolvConf { backup, symlink, existed, ours } = &owed else { panic!() };
        restore_resolv_conf(&etc, backup, symlink.as_deref(), *existed, ours).unwrap();
        assert_eq!(std::fs::read_link(&etc).unwrap(), target);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_someone_else_rewrote_is_left_alone() {
        let dir = scratch("other");
        let etc = dir.join("resolv.conf");
        std::fs::write(&etc, "nameserver 192.0.2.1\n").unwrap();
        let ledger = Ledger::in_dir(&dir);
        let owed = rewrite_resolv_conf(&etc, &dir.join(BACKUP_FILE), &ledger).unwrap();
        std::fs::write(&etc, "nameserver 198.51.100.53\n").unwrap();
        let Owed::ResolvConf { backup, symlink, existed, ours } = &owed else { panic!() };
        let said = restore_resolv_conf(&etc, backup, symlink.as_deref(), *existed, ours).unwrap();
        assert!(said.is_some());
        assert_eq!(std::fs::read_to_string(&etc).unwrap(), "nameserver 198.51.100.53\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A DHCP client rewriting the file mid-session is seen, so the status
    /// stops saying DNS is protected.
    #[test]
    fn a_file_rewritten_mid_session_is_no_longer_ours() {
        let dir = scratch("midsession");
        let etc = dir.join("resolv.conf");
        std::fs::write(&etc, "nameserver 192.0.2.1\n").unwrap();
        let ledger = Ledger::in_dir(&dir);
        let owed = rewrite_resolv_conf(&etc, &dir.join(BACKUP_FILE), &ledger).unwrap();
        let Owed::ResolvConf { ours, .. } = &owed else { panic!() };
        assert!(resolv_conf_is(&etc, ours));
        std::fs::write(&etc, "nameserver 192.0.2.1\n").unwrap();
        assert!(!resolv_conf_is(&etc, ours));
        std::fs::remove_file(&etc).unwrap();
        std::os::unix::fs::symlink(dir.join(BACKUP_FILE), &etc).unwrap();
        assert!(!resolv_conf_is(&etc, ours), "a symlink is never ours");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
