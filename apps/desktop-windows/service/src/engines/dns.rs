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

/// Marks Gaming DNS mode's rules, which are a **different set** and must
/// never be confused with the tunnel's.
///
/// A separate tag rather than a separate namespace list, because
/// [`clear`] matches on the comment alone and runs unconditionally on
/// every disconnect -- and [`apply`] calls it first. Sharing a tag would
/// mean the tunnel's own connect path silently deleting the gaming
/// rules a moment after they were installed, and the customer being
/// told gaming mode was on with no rule behind it. The two features
/// sweep only their own.
const GAMING_NRPT_COMMENT: &str = "Neoxify gaming DNS";

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
        Ok(0) => {}
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
        }
        Err(e) => crate::cleanup_log::note("clear the tunnel DNS rule", &format!("registry fallback failed: {e}")),
    }
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
    clear_registry_rules_tagged(NRPT_COMMENT)
}

fn clear_registry_rules_tagged(tag: &str) -> Result<u32, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    remove_tagged_rules(
        &RegKey::predef(HKEY_LOCAL_MACHINE),
        &NRPT_REGISTRY_PATHS,
        tag,
    )
}

/// The removal itself, against whichever root it is given.
///
/// Split from its caller for one reason: what has to be *proved* here
/// is that a rule belonging to something else is left alone. Deleting
/// registry keys under a match is the kind of code that works and then
/// takes a neighbour's rule with it, and this service runs as
/// LocalSystem. The test below builds both kinds of rule under HKCU,
/// where it needs no elevation, and checks that exactly one survives.
///
/// `tag` is a parameter rather than the constant it used to be because
/// this service now owns two disjoint sets of NRPT rules -- the
/// tunnel's `.` rule and Gaming mode's namespace-scoped ones -- and
/// each sweep must remove only its own. One sweeper with a tag, rather
/// than a second copy of this function, so the "leave the neighbour's
/// rule alone" proof below covers both callers.
fn remove_tagged_rules(root: &winreg::RegKey, paths: &[&str], tag: &str) -> Result<u32, String> {
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
            if comment != tag {
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

// ---------------------------------------------------------------------
// Gaming DNS mode
//
// Namespace-scoped siblings of the three functions above, deliberately
// added alongside rather than folded into them. `apply(resolver)` and
// `clear()` keep their exact behaviour for the xray and ikev2 callers,
// which is the whole point: those run on every connect and disconnect,
// and re-signaturing them to take a namespace list would put a new
// argument on the one path in this service that a mistake strands a
// customer's DNS on.
// ---------------------------------------------------------------------

/// Points `namespaces` at `resolver`, one NRPT rule per suffix.
///
/// Never `-Namespace '.'`. A `.` rule captures every name the machine
/// resolves, which is what [`apply`] installs on purpose for a full
/// tunnel and what gaming mode must never install -- the stub answers
/// one game's hostnames and refuses everything else, so a `.` rule
/// would take the machine's whole resolver down to a stub that refuses
/// it. Rejected here as well as in `GamingConfig::validate`, because
/// this is the function that builds the command line.
///
/// Existing gaming rules are removed first so re-arming cannot stack
/// duplicates -- and only gaming rules, so a live tunnel's `.` rule is
/// untouched.
pub fn apply_gaming(namespaces: &[String], resolver: &str) -> Result<Vec<String>, String> {
    // Every value is checked *before* anything is removed. A config
    // that is about to be rejected must not first tear down the rules
    // that were working.
    let mut scoped = Vec::with_capacity(namespaces.len());
    for namespace in namespaces {
        scoped.push(scoped_namespace(namespace)?);
    }
    if scoped.is_empty() {
        return Err("a gaming profile with no DNS suffixes would install no rules".to_string());
    }
    // The resolver is ours and never customer-supplied, but it reaches
    // the same command line, so it is checked with the same alphabet.
    if !resolver
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ':')
    {
        return Err("the DNS stub address is not a plain IP address".to_string());
    }

    // Ours only -- a live tunnel's `.` rule is a different tag and is
    // left where it is.
    clear_gaming();

    // One PowerShell spawn for the whole set. `Add-DnsClientNrptRule`
    // takes a single namespace, so this is a loop inside the script
    // rather than a loop of spawns -- a dozen suffixes would otherwise
    // be a dozen process launches with the `Engines` lock held.
    let list = scoped
        .iter()
        .map(|n| format!("'{n}'"))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$ErrorActionPreference='Stop'; foreach ($ns in @({list})) {{ \
         Add-DnsClientNrptRule -Namespace $ns -NameServers '{resolver}' -Comment '{GAMING_NRPT_COMMENT}' }}"
    );
    powershell(&script)
        .map_err(|e| format!("could not install the gaming DNS rules: {e}"))?;
    Ok(scoped)
}

/// Puts one configured suffix into the form NRPT wants, and refuses
/// anything that could escape the quoting around it.
///
/// The alphabet is the second line of defence behind
/// `GamingConfig::validate` -- see the threat note on `check_hostname`
/// in the ipc crate. This runs as SYSTEM and the value is interpolated
/// into a command line, so it is re-checked at the point of use rather
/// than trusted because a caller checked it earlier.
fn scoped_namespace(namespace: &str) -> Result<String, String> {
    let bare = namespace
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if bare.is_empty() {
        return Err(
            "a gaming DNS rule cannot be scoped to \".\" -- that would capture every name on this machine"
                .to_string(),
        );
    }
    if !bare
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!("{namespace:?} is not a plain DNS suffix"));
    }
    if bare.contains("..") || bare.starts_with('-') || bare.ends_with('-') || bare.len() > 253 {
        return Err(format!("{namespace:?} is not a well-formed DNS suffix"));
    }
    // The leading dot is NRPT's suffix form: ".battle.net" matches the
    // domain and everything under it, "battle.net" matches only the
    // exact name. A game's hostnames are subdomains, so the suffix form
    // is the one that is ever useful here.
    Ok(format!(".{bare}"))
}

/// Removes gaming's rules, and only gaming's.
///
/// Same shape as [`clear`] and for the same reason: a stranded NRPT
/// rule points lookups at a stub that is no longer listening, which
/// presents as "the game will not launch and I don't know why" long
/// after Neoxify is closed. Called when disarming, from the idle
/// watchdog, at service start, at service stop and at uninstall.
///
/// Namespace-scoped rules land in the same two registry locations the
/// `.` rule does, so the sweep is given both -- which is what §14
/// instrument #7 asks to be proved.
pub fn clear_gaming() {
    let script = format!(
        "Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{GAMING_NRPT_COMMENT}' }} | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue; \
         (Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{GAMING_NRPT_COMMENT}' }} | Measure-Object).Count"
    );
    let cmdlets_reported_clean = match powershell(&script) {
        Ok(out) if out.trim() == "0" => true,
        Ok(out) => {
            crate::cleanup_log::note(
                "clear the gaming DNS rules",
                &format!(
                    "PowerShell removal left {:?} rule(s) behind, falling back to the registry",
                    out.trim()
                ),
            );
            false
        }
        Err(e) => {
            crate::cleanup_log::note(
                "clear the gaming DNS rules",
                &format!("PowerShell removal failed ({e}), falling back to the registry"),
            );
            false
        }
    };

    match clear_registry_rules_tagged(GAMING_NRPT_COMMENT) {
        Ok(0) => {}
        Ok(n) => {
            crate::cleanup_log::note(
                "clear the gaming DNS rules",
                &if cmdlets_reported_clean {
                    format!("removed {n} rule(s) from the registry that the cmdlets did not report")
                } else {
                    format!("removed {n} rule(s) directly from the registry")
                },
            );
            poke_resolver();
        }
        Err(e) => crate::cleanup_log::note(
            "clear the gaming DNS rules",
            &format!("registry fallback failed: {e}"),
        ),
    }
}

/// Which of `namespaces` are **not** in the registry right now.
///
/// Check 1 of design §8.3, and the one this module did not previously
/// have: `clear` verifies *removal*, and nothing verified presence.
/// Re-read every time rather than remembered, because "we ran the
/// cmdlet and it did not error" is exactly the evidence this project
/// has repeatedly found to be worthless -- the rig watched the same
/// cmdlets exceed their budget and report success three times.
///
/// An empty result means every rule is there. A non-empty one names the
/// missing suffixes, which is what the customer is shown.
pub fn gaming_rules_missing(namespaces: &[String]) -> Result<Vec<String>, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let present = tagged_rule_namespaces(
        &RegKey::predef(HKEY_LOCAL_MACHINE),
        &NRPT_REGISTRY_PATHS,
        GAMING_NRPT_COMMENT,
    )?;
    Ok(namespaces
        .iter()
        .filter(|wanted| {
            let wanted = wanted.trim_start_matches('.').to_ascii_lowercase();
            !present
                .iter()
                .any(|have| have.trim_start_matches('.').to_ascii_lowercase() == wanted)
        })
        .cloned()
        .collect())
}

/// Every namespace carried by a rule with `tag`, across both locations.
///
/// `Name` is the REG_MULTI_SZ the DNS client stores an NRPT rule's
/// namespaces in; a rule created by `Add-DnsClientNrptRule` has exactly
/// one, but the format allows several and reading them all costs
/// nothing.
fn tagged_rule_namespaces(
    root: &winreg::RegKey,
    paths: &[&str],
    tag: &str,
) -> Result<Vec<String>, String> {
    use winreg::enums::KEY_READ;

    let mut found = Vec::new();
    let mut looked = false;
    for path in paths {
        let Ok(parent) = root.open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        looked = true;
        for name in parent.enum_keys().filter_map(Result::ok) {
            let Ok(rule) = parent.open_subkey(&name) else {
                continue;
            };
            let comment: String = rule.get_value("Comment").unwrap_or_default();
            if comment != tag {
                continue;
            }
            match rule.get_value::<Vec<String>, _>("Name") {
                Ok(namespaces) => found.extend(namespaces.into_iter().filter(|n| !n.is_empty())),
                // A rule of ours with no readable namespace is not a
                // rule we can claim is in place.
                Err(e) => {
                    return Err(format!(r"could not read {path}\{name}\Name: {e}"));
                }
            }
        }
    }
    if !looked {
        // Neither location exists at all. On a real machine the local
        // one is always there once any NRPT rule has ever been made, so
        // this is "we could not look", not "there is nothing" -- and
        // the difference decides whether a customer is told `partial`
        // or `active`.
        return Err("neither DNS policy location could be read".to_string());
    }
    Ok(found)
}

/// Drops cached answers, so a check does not read a name Windows
/// resolved before the rules existed.
///
/// Narrower than [`poke_resolver`], which also signals the DNS client
/// to re-read its policy from the registry. Nothing is needed here:
/// `Add-DnsClientNrptRule` goes through the DNS client itself, so the
/// rule is already live -- what is stale is the answer cache in front
/// of it, and a canary that read a pre-arm cached address would fail
/// for a reason that has nothing to do with the rules.
pub fn flush_cache() {
    use std::ffi::OsStr;
    use std::path::Path;

    let ipconfig = Path::new(r"C:\Windows\System32\ipconfig.exe");
    if let Err(e) = super::run_hidden(ipconfig, &[OsStr::new("/flushdns")]) {
        crate::cleanup_log::note("flush the DNS cache", &e.to_string());
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

        let removed =
            remove_tagged_rules(&hkcu, &[LOCAL, POLICY], NRPT_COMMENT).expect("should not fail");
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
            NRPT_COMMENT,
        )
        .expect("an absent key must not be an error");
        assert_eq!(removed, 0);
    }

    /// Trap #1, and the reason the two features carry different tags.
    ///
    /// `clear()` runs unconditionally on every disconnect *and* is the
    /// first thing `apply()` does, so if gaming rules shared the
    /// tunnel's comment the ordinary connect path would delete them a
    /// moment after they were installed -- leaving a customer told
    /// gaming mode was on with no rule behind it, and no error anywhere
    /// to say otherwise.
    #[test]
    fn the_tunnel_sweep_and_the_gaming_sweep_leave_each_other_alone() {
        const PATH: &str = r"Software\Neoxify\nrpt-tag-isolation\local";
        const ROOT: &str = r"Software\Neoxify\nrpt-tag-isolation";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        let (parent, _) = hkcu.create_subkey(PATH).expect("should create the test key");
        for (key, comment) in [
            ("{tunnel}", NRPT_COMMENT),
            ("{gaming-a}", GAMING_NRPT_COMMENT),
            ("{gaming-b}", GAMING_NRPT_COMMENT),
        ] {
            let (rule, _) = parent.create_subkey(key).expect("should create a rule");
            rule.set_value("Comment", &comment).expect("should tag it");
        }
        drop(parent);

        // Sweeping the tunnel's rules must take exactly one.
        let removed = remove_tagged_rules(&hkcu, &[PATH], NRPT_COMMENT).expect("should not fail");
        assert_eq!(removed, 1);
        let parent = hkcu.open_subkey_with_flags(PATH, KEY_READ).unwrap();
        let left: Vec<String> = parent.enum_keys().filter_map(Result::ok).collect();
        assert_eq!(
            left,
            vec!["{gaming-a}".to_string(), "{gaming-b}".to_string()],
            "a disconnect deleted the gaming rules"
        );
        drop(parent);

        // And the gaming sweep takes the other two and nothing else.
        let (parent, _) = hkcu.create_subkey(PATH).unwrap();
        let (rule, _) = parent.create_subkey("{tunnel}").unwrap();
        rule.set_value("Comment", &NRPT_COMMENT).unwrap();
        drop(rule);
        drop(parent);
        let removed =
            remove_tagged_rules(&hkcu, &[PATH], GAMING_NRPT_COMMENT).expect("should not fail");
        assert_eq!(removed, 2);
        let parent = hkcu.open_subkey_with_flags(PATH, KEY_READ).unwrap();
        let left: Vec<String> = parent.enum_keys().filter_map(Result::ok).collect();
        assert_eq!(
            left,
            vec!["{tunnel}".to_string()],
            "disarming gaming mode deleted the tunnel's rule"
        );
        drop(parent);

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// Verify-present, against the REG_MULTI_SZ the DNS client actually
    /// stores namespaces in.
    #[test]
    fn reads_back_the_namespaces_of_the_rules_we_tagged() {
        const PATH: &str = r"Software\Neoxify\nrpt-present\local";
        const ROOT: &str = r"Software\Neoxify\nrpt-present";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        let (parent, _) = hkcu.create_subkey(PATH).expect("should create the test key");
        for (key, comment, namespace) in [
            ("{a}", GAMING_NRPT_COMMENT, ".blizzard.com"),
            ("{b}", GAMING_NRPT_COMMENT, ".battle.net"),
            // The tunnel's own rule, which must not be counted as a
            // gaming namespace.
            ("{c}", NRPT_COMMENT, "."),
        ] {
            let (rule, _) = parent.create_subkey(key).unwrap();
            rule.set_value("Comment", &comment).unwrap();
            rule.set_value("Name", &vec![namespace.to_string()]).unwrap();
        }
        drop(parent);

        let mut found = tagged_rule_namespaces(&hkcu, &[PATH], GAMING_NRPT_COMMENT)
            .expect("the key exists, so this must not error");
        found.sort();
        assert_eq!(found, vec![".battle.net", ".blizzard.com"]);

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// "We could not look" must not read as "there is nothing there".
    /// That difference decides whether the customer is told `active` or
    /// `partial`, and defaulting it to "clean" is how a check becomes
    /// one that can never fail.
    #[test]
    fn a_location_that_cannot_be_read_is_an_error_not_an_empty_answer() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        assert!(tagged_rule_namespaces(
            &hkcu,
            &[r"Software\Neoxify\nrpt-present-no-such-key"],
            GAMING_NRPT_COMMENT
        )
        .is_err());
    }

    /// The command line this builds runs as SYSTEM.
    #[test]
    fn a_namespace_is_re_checked_where_the_command_is_built() {
        assert_eq!(scoped_namespace("Blizzard.com").unwrap(), ".blizzard.com");
        assert_eq!(scoped_namespace(".battle.net.").unwrap(), ".battle.net");
        for hostile in [".", "", "  .  ", "a.com'; calc; #", "a.com`ncalc", "a.com|calc", "a..com"]
        {
            assert!(
                scoped_namespace(hostile).is_err(),
                "{hostile:?} would have reached the command line"
            );
        }
    }

    /// The rejection with a reason, at the layer that builds the
    /// command rather than only at the layer that parses the request.
    #[test]
    fn the_root_namespace_is_refused_before_any_command_is_run() {
        let err = apply_gaming(&[".".to_string()], "127.0.0.53").unwrap_err();
        assert!(err.contains("every name on this machine"), "{err}");
    }
}
