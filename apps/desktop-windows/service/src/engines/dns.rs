//! Making the tunnel's resolver the only one Windows will use.
//!
//! Setting DNS on a tunnel adapter is a preference, not an answer.
//! Windows resolves names on every interface at once and takes whichever
//! replies first -- "smart multi-homed name resolution" -- so a
//! customer's ISP resolver, a few milliseconds away, beats ours across a
//! tunnel almost every time.
//!
//! In Iran that resolver answers filtered domains with a poisoned
//! address, so the browser is handed the wrong destination *before* any
//! routing happens and the tunnel never sees the request. Reported on
//! 2026-08-17 as connected-but-YouTube-will-not-open, with Telegram
//! working throughout because Telegram does not ask Windows.
//!
//! An NRPT rule is what actually settles it, and is what WireGuard's own
//! client uses -- which is why WireGuard never showed the fault while
//! every other protocol did.

use std::process::Command;

/// Marks the rules this service owns, so cleanup removes ours and leaves
/// anything else on the machine alone.
const NRPT_COMMENT: &str = "Neoxify tunnel DNS";

/// Routes every name through `resolver` for the life of the tunnel.
///
/// Namespace "." matches every name. Existing rules of ours are cleared
/// first so reconnecting cannot stack duplicates.
pub fn apply(resolver: &str) -> Result<(), String> {
    clear();
    let script = format!(
        "Add-DnsClientNrptRule -Namespace '.' -NameServers '{resolver}' -Comment '{NRPT_COMMENT}' -ErrorAction Stop"
    );
    powershell(&script)
        .map(|_| ())
        .map_err(|e| format!("could not force tunnel DNS: {e}"))
}

/// Where the DNS client keeps NRPT rules, relative to HKLM.
///
/// The first is where `Add-DnsClientNrptRule` writes local rules -- the
/// ones this service creates. The second is the Group Policy location;
/// nothing of ours should ever be there, but a rule carrying our
/// comment is ours to remove wherever it sits, and checking an absent
/// key costs nothing.
const NRPT_REGISTRY_PATHS: [&str; 2] = [
    r"SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig",
    r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig",
];

/// Removes our rules, and verifies they are actually gone.
///
/// Safe to call when none exist, and called unconditionally on every
/// disconnect and at service start: a rule surviving a crash points the
/// whole machine's lookups at a resolver it can no longer reach, which
/// presents as "no website loads at all" long after the VPN is gone --
/// a worse fault than the one this module exists to fix. In Iran that
/// resolver is blocked outside the tunnel, so a stranded rule takes the
/// whole machine's DNS with it until the customer resets Windows
/// networking by hand. That is the field report this verifies against.
///
/// The old version ran one PowerShell removal and believed it. Now the
/// same invocation reports how many of our rules remain, and anything
/// other than a clean zero -- rules left, unparseable output, or
/// PowerShell itself failing -- falls back to deleting the rule
/// straight out of the registry, which needs nothing but this process
/// and the registry API.
pub fn clear() {
    // Removal and verification in a single invocation, because this
    // runs with the `Engines` lock held on every connect and
    // disconnect: a second PowerShell spawn would double the latency of
    // the common case to guard against the rare one.
    let script = format!(
        "Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{NRPT_COMMENT}' }} | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue; \
         (Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{NRPT_COMMENT}' }} | Measure-Object).Count"
    );
    match powershell(&script) {
        // The only verified-clean answer. Everything else falls through
        // to the registry.
        Ok(out) if out.trim() == "0" => return,
        Ok(out) => eprintln!(
            "nrpt cleanup: PowerShell removal left rules behind (reported {:?}), falling back to the registry",
            out.trim()
        ),
        Err(e) => eprintln!(
            "nrpt cleanup: PowerShell removal failed ({e}), falling back to the registry"
        ),
    }

    match clear_registry_rules() {
        // Nothing of ours in either location: the verification above
        // was wrong or unavailable, not the removal. Clean either way.
        Ok(0) => {}
        Ok(n) => {
            eprintln!("nrpt cleanup: removed {n} rule(s) directly from the registry");
            poke_resolver();
        }
        Err(e) => eprintln!("nrpt cleanup: registry fallback failed: {e}"),
    }
}

/// Deletes every NRPT rule carrying our comment from the registry
/// directly, returning how many were removed.
///
/// This is the path that still works when PowerShell does not -- or
/// when its cmdlets claim success while the rule sits there. Matching
/// is on the `Comment` value only, so rules belonging to anything else
/// on the machine are never touched.
fn clear_registry_rules() -> Result<u32, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut removed = 0u32;
    let mut failures: Vec<String> = Vec::new();
    for path in NRPT_REGISTRY_PATHS {
        // An absent parent key just means no rules of that kind exist.
        let Ok(parent) = hklm.open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        // Collected first: deleting while enumerating shifts the
        // indices under the iterator and skips siblings.
        let rule_keys: Vec<String> = parent.enum_keys().filter_map(Result::ok).collect();
        for name in rule_keys {
            let Ok(rule) = parent.open_subkey(&name) else {
                continue;
            };
            let comment: String = rule.get_value("Comment").unwrap_or_default();
            if comment != NRPT_COMMENT {
                continue;
            }
            drop(rule);
            match hklm.delete_subkey_all(format!(r"{path}\{name}")) {
                Ok(()) => removed += 1,
                Err(e) => failures.push(format!(r"{path}\{name}: {e}")),
            }
        }
    }
    if failures.is_empty() {
        Ok(removed)
    } else {
        Err(format!(
            "removed {removed}, could not remove {}",
            failures.join("; ")
        ))
    }
}

/// Tells the DNS client its policy changed, after the registry was
/// edited behind its back.
///
/// The NRPT is cached in the DNS client's memory, so deleting the
/// registry key alone leaves the stale rule live until something makes
/// the service re-read it. Restarting Dnscache is refused -- it is a
/// protected service -- and `gpupdate /force` re-applies every machine
/// policy to poke one table. The PARAMCHANGE control is the narrow,
/// documented signal for "your parameters changed, reload them", and
/// the cache flush after it discards answers resolved under the old
/// rule.
///
/// Best-effort: if the poke fails the registry is already safe, and a
/// reboot finalises what the running DNS client would not pick up.
fn poke_resolver() {
    use std::ffi::OsStr;
    use std::path::Path;

    // Absolute, like every System32 helper this service runs: a
    // service's PATH is not the user's.
    let sc = Path::new(r"C:\Windows\System32\sc.exe");
    if let Err(e) = super::run_hidden(
        sc,
        &[OsStr::new("control"), OsStr::new("dnscache"), OsStr::new("paramchange")],
    ) {
        eprintln!("nrpt cleanup: could not signal the DNS client to reload policy ({e}); a reboot finalises the cleanup");
    }
    let ipconfig = Path::new(r"C:\Windows\System32\ipconfig.exe");
    if let Err(e) = super::run_hidden(ipconfig, &[OsStr::new("/flushdns")]) {
        eprintln!("nrpt cleanup: could not flush the DNS cache ({e})");
    }
}

/// Runs a PowerShell one-liner, hidden and bounded.
///
/// Bounded because this runs with the `Engines` lock held, on both the
/// connect and the disconnect path. A PowerShell that never returns
/// would take every other request with it, `status` included -- see
/// [`super::HELPER_BUDGET`].
fn powershell(script: &str) -> Result<String, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let out = super::capture_hidden(command, super::HELPER_BUDGET).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout)
}
