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
/// PowerShell itself failing -- is recorded, because it means the
/// cmdlets are not to be trusted on this machine.
///
/// The registry sweep runs either way, which it did not used to. A
/// clean `0` from PowerShell returned immediately, and a clean `0` is
/// what normal operation reports -- so the sweep, and with it the only
/// look this code ever takes at the Group Policy location, ran only on
/// the fallback path. A rule of ours sitting under
/// `SOFTWARE\Policies\...\DnsPolicyConfig` therefore survived every
/// ordinary disconnect, while the comment two definitions up said it
/// was ours to remove wherever it sits. It is a key enumeration over at
/// most a handful of subkeys; making it unconditional costs less than
/// the sentence explaining why it was not.
///
/// The fallback is not going anywhere either: the rig watched the
/// PowerShell removal exceed the 15s helper budget three times under
/// load, so "the cmdlets answered" is not something to build on.
pub fn clear() {
    let _ = clear_reporting();
}

/// What one NRPT clear did, for the caller that has to say so.
///
/// `clear()` above stays exactly as it was -- a call that returns
/// nothing and cannot fail -- because it runs on every connect and
/// disconnect and nothing there has anything to do with the answer.
/// `repair` needs the answer, and duplicating the removal to get it is
/// how a machine ends up with two implementations of the one teardown
/// that must not be wrong.
#[derive(Default)]
pub(super) struct DnsCleared {
    /// Rules removed by the cmdlets and by the registry sweep together.
    pub removed: u32,
    /// Set when the removal could not be verified -- PowerShell failed,
    /// or the registry delete refused. Never treated as clean.
    pub unverified: Option<String>,
}

pub(super) fn clear_reporting() -> DnsCleared {
    // Removal and verification in a single invocation, because this
    // runs with the `Engines` lock held on every connect and
    // disconnect: a second PowerShell spawn would double the latency of
    // the common case to guard against the rare one.
    let script = format!(
        "Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{NRPT_COMMENT}' }} | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue; \
         (Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{NRPT_COMMENT}' }} | Measure-Object).Count"
    );
    // The only verified-clean answer. Anything else says the cmdlets
    // did not do the job, which changes what the sweep below means but
    // not whether it runs.
    let mut cleared = DnsCleared::default();
    let cmdlets_reported_clean = match powershell(&script) {
        Ok(out) if out.trim() == "0" => true,
        Ok(out) => {
            crate::cleanup_log::note(
                "clear the tunnel DNS rule",
                &format!("PowerShell removal left {:?} rule(s) behind, falling back to the registry", out.trim()),
            );
            false
        }
        Err(e) => {
            crate::cleanup_log::note(
                "clear the tunnel DNS rule",
                &format!("PowerShell removal failed ({e}), falling back to the registry"),
            );
            false
        }
    };

    match clear_registry_rules() {
        // Nothing of ours in either location. On the normal path this is
        // the expected answer and says the cmdlets and the registry
        // agree; on the fallback path it says the verification was wrong
        // or unavailable rather than the removal. Clean either way, and
        // nothing to tell the DNS client about.
        Ok(0) => {
            // The cmdlets are the only witness that anything went, and
            // on this arm they either said "none left" (nothing to
            // report) or could not be believed (nothing to report
            // either, but not the same thing).
            if !cmdlets_reported_clean {
                cleared.unverified =
                    Some("the DNS cmdlets did not confirm the removal; the registry held no rules of ours".into());
            }
        }
        Ok(n) => {
            // Always recorded. Rules found here after a clean cmdlet
            // report are the interesting case -- they are rules
            // Get-DnsClientNrptRule does not enumerate, which in
            // practice means the Group Policy location -- and a support
            // conversation needs to know which of the two happened.
            crate::cleanup_log::note(
                "clear the tunnel DNS rule",
                &if cmdlets_reported_clean {
                    format!("removed {n} rule(s) from the registry that the cmdlets did not report")
                } else {
                    format!("removed {n} rule(s) directly from the registry")
                },
            );
            // Only when something actually went. The poke is two
            // process spawns on a path that runs on every connect and
            // every disconnect with the `Engines` lock held, and there
            // is nothing to reload when the registry was already as the
            // DNS client believes it to be.
            poke_resolver();
            cleared.removed = n;
        }
        Err(e) => {
            crate::cleanup_log::note("clear the tunnel DNS rule", &format!("registry fallback failed: {e}"));
            cleared.unverified = Some(e);
        }
    }
    cleared
}

/// How many NRPT rules of ours exist right now, without removing any.
///
/// For the diagnostics snapshot. Reads the registry directly rather than
/// asking `Get-DnsClientNrptRule`, for the reason the sweep exists at
/// all: a rule of ours under the Group Policy key is invisible to that
/// cmdlet, and a snapshot reporting zero while one sat there would send
/// support looking somewhere else.
pub(super) fn rule_count() -> u32 {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let root = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut count = 0u32;
    for path in NRPT_REGISTRY_PATHS {
        let Ok(parent) = root.open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for name in parent.enum_keys().filter_map(Result::ok) {
            let Ok(rule) = parent.open_subkey(&name) else {
                continue;
            };
            let comment: String = rule.get_value("Comment").unwrap_or_default();
            if comment == NRPT_COMMENT {
                count += 1;
            }
        }
    }
    count
}

/// Tells the DNS client to reload its policy and empties its cache.
///
/// `pub(super)` for `repair`, which runs it unconditionally rather than
/// only when a rule was removed. The cheap-path reasoning that keeps the
/// poke off the ordinary disconnect does not apply on a machine somebody
/// has had to ask for a repair on: there, a stale cached answer resolved
/// under a rule that is now gone is exactly the residue being chased.
pub(super) fn flush_and_reload() {
    poke_resolver();
}

/// Deletes every NRPT rule carrying our comment from the registry
/// directly, returning how many were removed.
///
/// This is the path that still works when PowerShell does not -- or
/// when its cmdlets claim success while the rule sits there, which is
/// exactly what the Group Policy location looks like from
/// `Get-DnsClientNrptRule`. Both locations, every time. Matching is on
/// the `Comment` value only, so rules belonging to anything else on the
/// machine are never touched.
fn clear_registry_rules() -> Result<u32, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    remove_tagged_rules(&RegKey::predef(HKEY_LOCAL_MACHINE), &NRPT_REGISTRY_PATHS)
}

/// The removal itself, against whichever root it is given.
///
/// Split from its caller for one reason: what has to be *proved* here
/// is that a rule belonging to something else is left alone. Deleting
/// registry keys under a match is the kind of code that works and then
/// takes a neighbour's rule with it, and this service runs as
/// LocalSystem. The test below builds both kinds of rule under HKCU,
/// where it needs no elevation, and checks that exactly one survives.
fn remove_tagged_rules(root: &winreg::RegKey, paths: &[&str]) -> Result<u32, String> {
    use winreg::enums::KEY_READ;

    let mut removed = 0u32;
    let mut failures: Vec<String> = Vec::new();
    for path in paths {
        // An absent parent key just means no rules of that kind exist.
        let Ok(parent) = root.open_subkey_with_flags(path, KEY_READ) else {
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
            match root.delete_subkey_all(format!(r"{path}\{name}")) {
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
        crate::cleanup_log::note(
            "signal the DNS client to reload policy",
            &format!("{e}; the registry is already clear and a reboot finalises it"),
        );
    }
    let ipconfig = Path::new(r"C:\Windows\System32\ipconfig.exe");
    if let Err(e) = super::run_hidden(ipconfig, &[OsStr::new("/flushdns")]) {
        crate::cleanup_log::note("flush the DNS cache", &e.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    /// The failure this fallback could introduce, rather than the one
    /// it fixes.
    ///
    /// Deleting registry keys that match something is how a cleanup
    /// ends up taking a neighbour's configuration with it, and this
    /// runs as LocalSystem against a table other VPN clients and
    /// domain-joined machines also write to. Removing somebody else's
    /// NRPT rule would break their name resolution in exactly the way
    /// this module exists to prevent -- with no clue pointing here.
    ///
    /// Built under HKCU so it needs no elevation and cannot touch the
    /// real table.
    ///
    /// Both locations, because the sweep is given both and the Group
    /// Policy one is the whole reason it now runs on the happy path: a
    /// rule of ours there is invisible to `Get-DnsClientNrptRule`, so
    /// nothing else would ever find it. A sweep that only really
    /// searched the first path would pass a one-path test.
    #[test]
    fn the_registry_fallback_removes_only_the_rules_we_tagged() {
        const LOCAL: &str = r"Software\Neoxify\nrpt-fallback-test\local";
        const POLICY: &str = r"Software\Neoxify\nrpt-fallback-test\policy";
        const ROOT: &str = r"Software\Neoxify\nrpt-fallback-test";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        for path in [LOCAL, POLICY] {
            let (parent, _) = hkcu.create_subkey(path).expect("should create the test key");
            let (ours, _) = parent.create_subkey("{ours}").expect("should create a rule");
            ours.set_value("Comment", &NRPT_COMMENT)
                .expect("should tag the rule");
            let (theirs, _) = parent.create_subkey("{theirs}").expect("should create a rule");
            theirs.set_value("Comment", &"Some other VPN")
                .expect("should tag the rule");
            // A rule with no Comment at all, which is what a plain
            // domain-policy entry looks like.
            parent.create_subkey("{untagged}").expect("should create a rule");
            drop(ours);
            drop(theirs);
            drop(parent);
        }

        let removed = remove_tagged_rules(&hkcu, &[LOCAL, POLICY]).expect("should not fail");
        assert_eq!(removed, 2, "one of ours was left behind in one of the two locations");

        for path in [LOCAL, POLICY] {
            let parent = hkcu
                .open_subkey_with_flags(path, KEY_READ)
                .expect("the parent key should survive");
            let left: Vec<String> = parent.enum_keys().filter_map(Result::ok).collect();
            assert_eq!(
                left,
                vec!["{theirs}".to_string(), "{untagged}".to_string()],
                "a rule that was not ours was removed from {path}"
            );
            drop(parent);
        }

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// An absent location is not a failure, which is what makes the
    /// unconditional sweep safe to run on every disconnect.
    ///
    /// The Group Policy key does not exist on a machine that is not
    /// domain-joined, and this now runs there twice per connection.
    #[test]
    fn a_location_that_does_not_exist_is_simply_no_rules() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let removed = remove_tagged_rules(
            &hkcu,
            &[r"Software\Neoxify\nrpt-no-such-key-here"],
        )
        .expect("an absent key must not be an error");
        assert_eq!(removed, 0);
    }
}
