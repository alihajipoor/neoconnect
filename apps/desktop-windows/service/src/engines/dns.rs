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

/// What happened to the tunnel's own DNS rule on the session that is up
/// right now.
///
/// Three states rather than two, and the third is why this type exists.
/// Xray used to fail the whole connect when the rule would not install
/// and IKEv2 used to log and carry on, with neither comment
/// acknowledging the other -- an inconsistency rather than a decision.
/// Both are wrong in Iran for opposite reasons: refusing takes away a
/// tunnel from someone who may have no other protocol that connects,
/// and carrying on silently leaves the ISP's resolver answering first,
/// with a poisoned address, for exactly the domains the customer
/// connected in order to reach.
///
/// So the tunnel comes up and the complaint is carried in `status`, the
/// way `split_tunnel_problem` and `ipv6_blocked` already are. The app
/// then says what is and is not protected instead of guessing from the
/// protocol name.
///
/// [`NotRequested`] must never be reported as a problem. It is the
/// ordinary state for WireGuard, which installs its own DNS, and for
/// any Custom-mode tunnel, which deliberately leaves the machine's
/// lookups alone -- and this product's rule is that the app never
/// reports a state nothing verified, in either direction.
///
/// [`NotRequested`]: TunnelDns::NotRequested
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum TunnelDns {
    /// No rule was asked for. Not a complaint.
    #[default]
    NotRequested,
    /// Asked for and installed: every lookup on this machine goes to
    /// the tunnel's resolver.
    Forced,
    /// Asked for and refused, carrying why. The tunnel may well be
    /// carrying traffic; the machine's lookups are not pinned to it.
    Unforced(String),
}

impl TunnelDns {
    /// Whether the customer has to be told something is not protected.
    pub fn unprotected(&self) -> bool {
        matches!(self, Self::Unforced(_))
    }

    /// Why, for the cleanup log and a support conversation. Never shown
    /// to the customer -- it is English and it names cmdlets.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Unforced(e) => Some(e),
            Self::NotRequested | Self::Forced => None,
        }
    }
}

/// A courier, and only a courier.
///
/// The two engines that install this rule do it from free functions
/// several frames below any `Engines` value -- `xray::configure_adapter`
/// is called from both `install_routes` and `prepare_passive`, and
/// neither has one -- so there is nowhere to return the answer to.
/// `Engines::connect_inner` collects it from here at the end of the
/// connect and keeps it on the session, and **that field, not this
/// static, is what `status` reports.**
///
/// The distinction is load-bearing rather than tidy. A process-global
/// that `status` read directly is shared by every `Engines` in the
/// process, which is one on a customer's machine and several in a test
/// run -- and it produced exactly the failure this project distrusts
/// most: two tests that passed alone and failed together, because one
/// reset the state the other was reading. Per-session state cannot do
/// that, on a customer's machine either.
///
/// Nothing has to remember to reset it. [`clear`] is the teardown and
/// runs at service start, on every disconnect, and as the first thing
/// [`apply`] does -- so a stale answer cannot be picked up by the next
/// connect, and no call site can forget to clear one.
static TUNNEL_DNS: std::sync::Mutex<TunnelDns> = std::sync::Mutex::new(TunnelDns::NotRequested);

fn record_tunnel_dns(state: TunnelDns) {
    if let Ok(mut slot) = TUNNEL_DNS.lock() {
        *slot = state;
    }
}

/// What the last `force` on this process reported, for
/// `Engines::connect_inner` to collect onto the session.
pub(super) fn tunnel_dns() -> TunnelDns {
    TUNNEL_DNS
        .lock()
        .map(|slot| slot.clone())
        // A poisoned lock means a panic while this was held. Claiming
        // "forced" would be asserting something nothing verified, and
        // claiming "unforced" would put a warning in front of a
        // customer whose DNS is probably fine. Neither is honest, so
        // this says only that nothing is being asserted.
        .unwrap_or(TunnelDns::NotRequested)
}

/// Installs the tunnel's DNS rule and reports what happened.
///
/// **Returns no error on purpose.** This is the single entry point both
/// engines use, and its type is the mechanism that keeps them
/// consistent: there is no `Result` here for a caller to `?`, so
/// "refuse the connect because the DNS rule would not install" is not
/// an option either engine can take unilaterally again. See
/// [`TunnelDns`] for why that is the decision.
///
/// The failure is not swallowed -- it goes to the cleanup log for
/// support and into the status poll for the customer.
pub fn force(resolver: &str) -> TunnelDns {
    let state = match apply(resolver) {
        Ok(()) => TunnelDns::Forced,
        Err(e) => {
            crate::cleanup_log::note(
                "force the tunnel's DNS",
                &format!("{e}; the tunnel is up and the machine's lookups are not pinned to it"),
            );
            TunnelDns::Unforced(e)
        }
    };
    record_tunnel_dns(state.clone());
    state
}

/// Routes every name through `resolver` for the life of the tunnel.
///
/// Namespace "." matches every name. Existing rules of ours are cleared
/// first so reconnecting cannot stack duplicates.
///
/// Private: [`force`] is what engines call, so that the choice about
/// what a failure means is made once here rather than once per engine.
fn apply(resolver: &str) -> Result<(), String> {
    clear();
    let script = format!(
        "Add-DnsClientNrptRule -Namespace '.' -NameServers '{resolver}' -Comment '{NRPT_COMMENT}' -ErrorAction Stop"
    );
    // `CMDLET_BUDGET`, not `HELPER_BUDGET`. Same CIM-backed `DnsClient`
    // module as `Get-DnsClientNrptRule`, and this exact call was
    // measured on the rig at 10.0s, 16.3s, 43.9s and 55.1s across two
    // runs -- so the old 15s bound was inside the range of the thing it
    // bounded, and which side it landed on was luck. When it expires the
    // connect fails, so the coin toss was between a customer getting a
    // tunnel and being told their DNS could not be forced.
    //
    // Note what this does NOT fix, because no budget here can: the two
    // slowest of those four readings are past the app's own 45s
    // deadline. The rule this installs is what stops an ISP resolver
    // answering first, which in Iran means answering with a poisoned
    // address.
    //
    // What happens when it expires is settled now, and not here: the
    // caller is [`force`], the tunnel comes up either way, and the
    // customer is told their lookups are not pinned. Xray used to fail
    // the connect and IKEv2 used to log and continue; see [`TunnelDns`]
    // for why neither was right.
    powershell(&script, super::CMDLET_BUDGET)
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
/// The registry is no longer the fallback. It is the first thing asked
/// and, in every ordinary case, the only thing asked -- see
/// [`clear_within`]. The cmdlets are what runs when the registry could
/// not answer.
pub fn clear() {
    // The rule is going away, so what this service can claim about the
    // machine's lookups goes with it. Reset here rather than at the
    // callers because this runs at service start, on every disconnect
    // and as the first thing `apply` does -- which makes it the one
    // place a stale complaint cannot survive.
    record_tunnel_dns(TunnelDns::NotRequested);
    let _ = clear_within(super::HELPER_BUDGET);
}

/// How long the NRPT cmdlets get on the *repair* path, as opposed to the
/// connect and disconnect path.
///
/// [`super::HELPER_BUDGET`] is 15s, and that number is right for what it
/// bounds: helpers that run with the `Engines` lock held on every
/// connect and disconnect, where the measured worst case is under a
/// second and the budget exists so one wedged child cannot make the
/// service deaf to `status` and `disconnect`. Nothing about that
/// reasoning is being weakened here -- `clear()` above still uses it.
///
/// It is the wrong number for this call. `Get-DnsClientNrptRule` is a
/// CIM-backed cmdlet in the `DnsClient` module, so a cold invocation
/// pays PowerShell start-up *and* module and CIM-session load, twice in
/// the one script; the rig watched exactly that exceed 15s three times
/// on a constrained guest. Sixty seconds is chosen because it is four
/// times the old budget -- comfortably past a cold CIM load on a machine
/// under load -- while staying short enough that a customer watching a
/// repair does not conclude it has hung, and short enough that the
/// unbounded-wait failure this whole budget mechanism exists to prevent
/// is still prevented.
///
/// It can be this much longer only because the caller is different.
/// `repair` is a one-shot operation the customer deliberately started
/// and is waiting on; there is no `status` poll behind it whose latency
/// this would become.
const REPAIR_CMDLET_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

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
    clear_within(REPAIR_CMDLET_BUDGET)
}

/// The clear itself, against whichever cmdlet budget it is given.
///
/// Split from its two callers for one reason: the connect/disconnect
/// path and the repair path have genuinely different tolerances for a
/// slow helper, and before this split they shared one that suited the
/// first and quietly broke the second. See [`REPAIR_CMDLET_BUDGET`].
///
/// # Why the registry is asked first
///
/// This used to spawn PowerShell unconditionally and treat the registry
/// as a fallback. That is the wrong way round, and the rig proved it:
/// the 0825 verification run watched this blow its 15s budget on *every
/// single disconnect*, not occasionally. Giving it longer would have
/// been giving it more time to be slow in.
///
/// Two facts settle the order.
///
/// **The registry is the store, not a workaround.** NRPT rules live in
/// the two keys in [`NRPT_REGISTRY_PATHS`], `Add-DnsClientNrptRule`
/// writes to the first of them, and the sweep below reads both. That
/// makes what is read here a strict *superset* of what
/// `Get-DnsClientNrptRule` can enumerate -- the Group Policy location is
/// invisible to that cmdlet, which is the documented reason the sweep
/// exists at all. So a zero from the registry is not a guess that the
/// cmdlets would have said zero too; it is a better-informed answer than
/// the cmdlets could give.
///
/// **On most calls there is nothing to remove.** `clear` runs at service
/// start, on every disconnect, *and* at the top of [`apply`] on every
/// connect. Only the disconnect has a rule to clear. Every other call
/// was paying a PowerShell start plus two CDXML/CIM module loads to be
/// told what an in-process registry read answers in microseconds. That
/// is the "called when it has nothing to do" half of the defect.
///
/// The measured half, from the same rig -- a 4-vCPU Windows 11 guest,
/// a fresh process per row, the spread across two runs at different
/// levels of contention:
///
/// ```text
///   powershell -NoProfile -Command 1                          4.4 -  6.5s
///   Get-DnsClientNrptRule | Measure-Object                     9.6 - 66.7s
///   the script below, which runs Get-DnsClientNrptRule TWICE  11.5 - 71.3s
///   the registry enumeration this now does instead            32 - 237ms
///   the registry delete that replaces Remove-DnsClientNrptRule  48 - 64ms
///   poke_resolver(), which is still needed either way          0.7 - 0.9s
/// ```
///
/// Three orders of magnitude, and the cheap side is also the side that
/// sees more. That is the whole argument.
///
/// Nothing is given up by the reordering. The cmdlets' only unique
/// contribution was telling the DNS client its policy changed, and
/// [`poke_resolver`] already does that on the registry path -- it has
/// to, because that path has always been able to run alone.
///
/// What is *added* is verification that does not depend on the thing
/// being verified: the count is re-read from the registry after the
/// delete rather than believed from the deleter's own report.
/// One tag's worth of NRPT rules, and where to look for them.
///
/// Exists because there are two disjoint sets -- the tunnel's `.` rule
/// and Gaming mode's namespace-scoped ones -- and the teardown for them
/// is the same teardown. It was previously written twice, and the second
/// copy is why `clear_gaming` still carried the unconditional-PowerShell
/// defect after `clear` was fixed: the fix landed in one copy and there
/// was nothing to make the other follow. One implementation with a tag,
/// so a correction cannot land in half of it again.
///
/// `root` and `paths` are fields rather than constants so the ordering
/// below can be proved under HKCU, where a test needs no elevation and
/// cannot touch the real policy table -- the same reason
/// [`remove_tagged_rules`] and [`count_tagged_rules`] take a root.
struct Sweep<'a> {
    root: &'a winreg::RegKey,
    paths: &'a [&'a str],
    /// The `Comment` value that marks a rule as this sweep's.
    tag: &'a str,
    /// What the cleanup log calls this operation.
    what: &'static str,
}

impl Sweep<'_> {
    fn tunnel(root: &winreg::RegKey) -> Sweep<'_> {
        Sweep {
            root,
            paths: &NRPT_REGISTRY_PATHS,
            tag: NRPT_COMMENT,
            what: "clear the tunnel DNS rule",
        }
    }

    fn gaming(root: &winreg::RegKey) -> Sweep<'_> {
        Sweep {
            root,
            paths: &NRPT_REGISTRY_PATHS,
            tag: GAMING_NRPT_COMMENT,
            what: "clear the gaming DNS rules",
        }
    }

    /// The clear itself, against whichever cmdlet budget its caller
    /// closes over.
    ///
    /// `cmdlets` is injected rather than called directly for two
    /// reasons. The connect/disconnect path and the repair path have
    /// genuinely different tolerances for a slow helper, and before the
    /// split they shared one that suited the first and quietly broke the
    /// second -- see [`REPAIR_CMDLET_BUDGET`]. And a test can see
    /// *whether* the closure ran: the claim this function makes is not
    /// about what the registry returns, it is that on the ordinary call
    /// no process is spawned at all, and a spy is the only way to assert
    /// the absence of a spawn without timing it.
    ///
    /// # Why the registry is asked first
    ///
    /// This used to spawn PowerShell unconditionally and treat the
    /// registry as a fallback. That is the wrong way round, and the rig
    /// proved it: the 0825 verification run watched this blow its 15s
    /// budget on *every single disconnect*, not occasionally. Giving it
    /// longer would have been giving it more time to be slow in.
    ///
    /// Two facts settle the order.
    ///
    /// **The registry is the store, not a workaround.** NRPT rules live
    /// in the two keys in [`NRPT_REGISTRY_PATHS`],
    /// `Add-DnsClientNrptRule` writes to the first of them, and the
    /// sweep below reads both. That makes what is read here a strict
    /// *superset* of what `Get-DnsClientNrptRule` can enumerate -- the
    /// Group Policy location is invisible to that cmdlet, which is the
    /// documented reason the sweep exists at all. So a zero from the
    /// registry is not a guess that the cmdlets would have said zero
    /// too; it is a better-informed answer than the cmdlets could give.
    ///
    /// **On most calls there is nothing to remove.** The tunnel sweep
    /// runs at service start, on every disconnect, *and* at the top of
    /// [`apply`] on every connect; the gaming sweep runs at service
    /// start, at service stop, at uninstall, from the idle watchdog and
    /// on every disarm. Only a teardown that follows a matching arm has
    /// a rule to clear. Every other call was paying a PowerShell start
    /// plus two CDXML/CIM module loads to be told what an in-process
    /// registry read answers in microseconds. That is the "called when
    /// it has nothing to do" half of the defect.
    ///
    /// The measured half, from the rig -- a 4-vCPU Windows 11 guest, a
    /// fresh process per row, the spread across two runs at different
    /// levels of contention:
    ///
    /// ```text
    ///   powershell -NoProfile -Command 1                          4.4 -  6.5s
    ///   Get-DnsClientNrptRule | Measure-Object                     9.6 - 66.7s
    ///   the script below, which runs Get-DnsClientNrptRule TWICE  11.5 - 71.3s
    ///   the registry enumeration this now does instead            32 - 237ms
    ///   the registry delete that replaces Remove-DnsClientNrptRule  48 - 64ms
    ///   poke_resolver(), which is still needed either way          0.7 - 0.9s
    /// ```
    ///
    /// Three orders of magnitude, and the cheap side is also the side
    /// that sees more. That is the whole argument.
    ///
    /// Nothing is given up by the reordering. The cmdlets' only unique
    /// contribution was telling the DNS client its policy changed, and
    /// [`poke_resolver`] already does that on the registry path -- it
    /// has to, because that path has always been able to run alone.
    ///
    /// What is *added* is verification that does not depend on the thing
    /// being verified: the count is re-read from the registry after the
    /// delete rather than believed from the deleter's own report.
    fn clear_within<F>(&self, cmdlets: F) -> DnsCleared
    where
        F: FnOnce(&Self, DnsCleared) -> DnsCleared,
    {
        let mut cleared = DnsCleared::default();

        // Look before spawning anything.
        match count_tagged_rules(self.root, self.paths, self.tag) {
            // Nothing of ours in either location. This is the answer on
            // every connect and at every service start, and it is now
            // reached without a process.
            Ok(0) => return cleared,
            Ok(_) => {}
            // "Could not look" is not "there is nothing", and the two
            // must never be collapsed -- that is how a rule survives a
            // disconnect and takes the machine's DNS with it. Fall
            // through to the cmdlets, which are then the only witness
            // available.
            Err(e) => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("the DNS policy registry could not be read ({e}); asking the cmdlets instead"),
                );
                return cmdlets(self, cleared);
            }
        }

        // There is at least one, and this is where it lives. In-process,
        // so no budget applies and nothing can wedge; and it reaches the
        // Group Policy location, which the cmdlets cannot.
        match remove_tagged_rules(self.root, self.paths, self.tag) {
            Ok(n) if n > 0 => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("removed {n} rule(s) from the registry"),
                );
                // The registry was edited behind the DNS client's back,
                // so it has to be told. Only when something actually
                // went: there is nothing to reload when the table was
                // already as the DNS client believes it to be.
                poke_resolver();
                cleared.removed = n;
            }
            // Counted a moment ago and gone now. Nothing to do and
            // nothing to complain about -- but nothing was removed by us
            // either.
            Ok(_) => {}
            Err(e) => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("the registry removal failed ({e}); falling back to the cmdlets"),
                );
                return cmdlets(self, cleared);
            }
        }

        // Verified by re-reading, not by trusting the delete that just
        // ran.
        match count_tagged_rules(self.root, self.paths, self.tag) {
            Ok(0) => cleared,
            // Still there. Whatever the registry delete did, it did not
            // finish the job, so the cmdlets get their turn after all --
            // which is the case that justifies keeping them at all.
            Ok(left) => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("{left} rule(s) of ours are still in the registry; asking the cmdlets"),
                );
                cmdlets(self, cleared)
            }
            Err(e) => {
                cleared.unverified = Some(e);
                cleared
            }
        }
    }

    /// The cmdlet removal, for when the registry could not answer or
    /// could not finish.
    ///
    /// This is the old `clear_within` body, unchanged in what it does
    /// and moved only in when it runs. It is no longer the ordinary
    /// path, and the budget it is given is the caller's.
    fn clear_with_cmdlets(
        &self,
        budget: std::time::Duration,
        mut cleared: DnsCleared,
    ) -> DnsCleared {
        // Removal and verification in a single invocation, because this
        // runs with the `Engines` lock held on every connect and
        // disconnect: a second PowerShell spawn would double the latency
        // of the common case to guard against the rare one.
        let tag = self.tag;
        let script = format!(
            "Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{tag}' }} | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue; \
             (Get-DnsClientNrptRule | Where-Object {{ $_.Comment -eq '{tag}' }} | Measure-Object).Count"
        );
        // The only verified-clean answer. Anything else says the cmdlets
        // did not do the job, which changes what the sweep below means
        // but not whether it runs.
        let cmdlets_reported_clean = match powershell(&script, budget) {
            Ok(out) if out.trim() == "0" => true,
            Ok(out) => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("PowerShell removal left {:?} rule(s) behind, falling back to the registry", out.trim()),
                );
                false
            }
            Err(e) => {
                crate::cleanup_log::note(
                    self.what,
                    &format!("PowerShell removal failed ({e}), falling back to the registry"),
                );
                false
            }
        };

        match remove_tagged_rules(self.root, self.paths, self.tag) {
            // Nothing of ours in either location. On the normal path
            // this is the expected answer and says the cmdlets and the
            // registry agree; on the fallback path it says the
            // verification was wrong or unavailable rather than the
            // removal. Clean either way, and nothing to tell the DNS
            // client about.
            Ok(0) => {
                // The cmdlets are the only witness that anything went,
                // and on this arm they either said "none left" (nothing
                // to report) or could not be believed (nothing to report
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
                // practice means the Group Policy location -- and a
                // support conversation needs to know which of the two
                // happened.
                crate::cleanup_log::note(
                    self.what,
                    &if cmdlets_reported_clean {
                        format!("removed {n} rule(s) from the registry that the cmdlets did not report")
                    } else {
                        format!("removed {n} rule(s) directly from the registry")
                    },
                );
                // Only when something actually went. The poke is two
                // process spawns on a path that runs on every connect
                // and every disconnect with the `Engines` lock held, and
                // there is nothing to reload when the registry was
                // already as the DNS client believes it to be.
                poke_resolver();
                // `+=`, not `=`. This function can be entered with rules
                // already removed by the registry pass in
                // `clear_within`, and `repair` reports this number to a
                // customer -- a second removal overwriting the first
                // would understate what was actually cleaned off their
                // machine.
                cleared.removed += n;
            }
            Err(e) => {
                crate::cleanup_log::note(self.what, &format!("registry fallback failed: {e}"));
                cleared.unverified = Some(e);
            }
        }
        cleared
    }
}

/// The tunnel sweep against the real policy table.
fn clear_within(budget: std::time::Duration) -> DnsCleared {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    Sweep::tunnel(&hklm).clear_within(|sweep, cleared| sweep.clear_with_cmdlets(budget, cleared))
}

/// How many NRPT rules of ours exist right now, without removing any.
///
/// For the diagnostics snapshot. Reads the registry directly rather than
/// asking `Get-DnsClientNrptRule`, for the reason the sweep exists at
/// all: a rule of ours under the Group Policy key is invisible to that
/// cmdlet, and a snapshot reporting zero while one sat there would send
/// support looking somewhere else.
pub(super) fn rule_count() -> u32 {
    // A snapshot reports a number, so "could not look" collapses to
    // zero here and always did. [`clear_within`] must not collapse it,
    // which is why it calls the tri-state form below instead.
    registry_rule_count(NRPT_COMMENT).unwrap_or(0)
}

/// How many rules carrying `tag` the registry holds, or why it could not
/// be asked.
///
/// The distinction [`rule_count`] does not need and [`clear_within`]
/// cannot do without. An unreadable policy table and an empty one look
/// identical in a `u32`, and treating the first as the second would skip
/// a removal that was needed -- stranding an NRPT rule pointed at a
/// resolver that is about to become unreachable, which is the exact
/// field failure this module exists to prevent.
///
/// Follows [`tagged_rule_namespaces`]: if *neither* location can be
/// opened, nothing was looked at, and that is an error rather than a
/// zero. One location missing is ordinary -- the Group Policy key does
/// not exist on a machine that has never had one.
fn registry_rule_count(tag: &str) -> Result<u32, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    count_tagged_rules(&RegKey::predef(HKEY_LOCAL_MACHINE), &NRPT_REGISTRY_PATHS, tag)
}

/// The count itself, against whichever root it is given.
///
/// Split from its caller so the tri-state can be proved under HKCU,
/// where a test needs no elevation and cannot touch the real policy
/// table -- the same reason [`remove_tagged_rules`] is split. What has
/// to be proved is not the arithmetic but the `Err` arm: a caller that
/// reads "could not look" as "nothing there" skips a removal that was
/// needed, and a stranded `.` rule takes the machine's DNS with it.
fn count_tagged_rules(root: &winreg::RegKey, paths: &[&str], tag: &str) -> Result<u32, String> {
    use winreg::enums::KEY_READ;

    let mut count = 0u32;
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
            if comment == tag {
                count += 1;
            }
        }
    }
    if !looked {
        return Err("neither DNS policy location could be read".to_string());
    }
    Ok(count)
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
    // `HELPER_BUDGET`, not `REPAIR_CMDLET_BUDGET`: that longer budget is
    // justified only by its caller -- a one-shot repair the customer
    // started and is waiting on, with no `status` poll behind it. Gaming
    // mode applies and clears on the session path, where there is, so it
    // takes the same 15s bound as every other helper that runs with the
    // `Engines` lock held.
    powershell(&script, super::HELPER_BUDGET)
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
///
/// "Same shape as `clear`" is now literally true rather than a
/// resemblance: both go through [`Sweep::clear_within`]. Until this
/// change it was a copy of `clear`'s *old* body and still spawned
/// PowerShell unconditionally -- so on a machine where gaming mode had
/// never been armed, service start, service stop, uninstall and every
/// tick of the idle watchdog each paid a `Get-DnsClientNrptRule` (9.6s
/// to 66.7s on the rig's guest, run twice in the one script) to be told
/// there was nothing to remove. Three of those five callers hold the
/// `Engines` lock.
///
/// The `Err`/`Ok(0)` distinction matters more here than for the tunnel,
/// not less. Gaming installs one rule per namespace, so an unreadable
/// policy table read as a clean zero strands a *set* of suffix rules
/// pointed at a DoH stub that stops listening the moment the session
/// ends -- and the customer's symptom is that some specific games stop
/// resolving while everything else works, which is the hardest possible
/// thing to trace back to here.
///
/// `HELPER_BUDGET`, not `REPAIR_CMDLET_BUDGET`, on the rare path that
/// still reaches the cmdlets: the longer budget is justified only by its
/// caller -- a one-shot repair the customer started and is waiting on,
/// with no `status` poll behind it. Gaming mode applies and clears on
/// the session path, where there is one, so it takes the same 15s bound
/// as every other helper that runs with the `Engines` lock held.
pub fn clear_gaming() {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let _ = Sweep::gaming(&hklm)
        .clear_within(|sweep, cleared| sweep.clear_with_cmdlets(super::HELPER_BUDGET, cleared));
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
fn powershell(script: &str, budget: std::time::Duration) -> Result<String, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let out = super::capture_hidden(command, budget).map_err(|e| e.to_string())?;
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

    /// The count `clear_within` now decides on, and the only thing it
    /// is allowed to be wrong about is nothing.
    ///
    /// A count that included a neighbour's rule would send the sweep
    /// after somebody else's DNS configuration; a count that missed one
    /// of ours would skip a removal and strand a `.` rule pointed at a
    /// resolver that is about to become unreachable. Both locations are
    /// given, because the whole reason the registry is trusted over the
    /// cmdlets is that it can see the Group Policy one.
    #[test]
    fn the_registry_count_sees_both_locations_and_only_our_rules() {
        const LOCAL: &str = r"Software\Neoxify\nrpt-count\local";
        const POLICY: &str = r"Software\Neoxify\nrpt-count\policy";
        const ROOT: &str = r"Software\Neoxify\nrpt-count";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        for (path, entries) in [
            (LOCAL, vec![("{a}", NRPT_COMMENT), ("{b}", "Some other VPN")]),
            (POLICY, vec![("{c}", NRPT_COMMENT), ("{d}", GAMING_NRPT_COMMENT)]),
        ] {
            let (parent, _) = hkcu.create_subkey(path).expect("should create the test key");
            for (key, comment) in entries {
                let (rule, _) = parent.create_subkey(key).unwrap();
                rule.set_value("Comment", &comment).unwrap();
            }
        }

        // Two of ours, one per location. The other VPN's rule and
        // gaming mode's rule are both left out of the count -- gaming's
        // especially, because the two sets are disjoint on purpose and
        // a tunnel disconnect must never sweep them together.
        assert_eq!(
            count_tagged_rules(&hkcu, &[LOCAL, POLICY], NRPT_COMMENT),
            Ok(2)
        );
        assert_eq!(
            count_tagged_rules(&hkcu, &[LOCAL, POLICY], GAMING_NRPT_COMMENT),
            Ok(1)
        );

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// The arm the whole reordering rests on.
    ///
    /// `clear_within` returns without spawning PowerShell when this
    /// answers `Ok(0)`, so an unreadable table answering `Ok(0)` instead
    /// of `Err` would silently turn every disconnect into a no-op --
    /// which is worse than the slow path it replaced, not better.
    /// A missing Group Policy key alone is ordinary and must still count
    /// as having looked.
    #[test]
    fn an_unreadable_policy_table_is_an_error_rather_than_a_clean_zero() {
        const LOCAL: &str = r"Software\Neoxify\nrpt-count-partial\local";
        const ROOT: &str = r"Software\Neoxify\nrpt-count-partial";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        // Neither location exists: nothing was looked at.
        assert!(count_tagged_rules(
            &hkcu,
            &[
                r"Software\Neoxify\nrpt-count-none\local",
                r"Software\Neoxify\nrpt-count-none\policy"
            ],
            NRPT_COMMENT
        )
        .is_err());

        // One exists and is empty: that is a real, verified zero.
        let (_, _) = hkcu.create_subkey(LOCAL).expect("should create the test key");
        assert_eq!(
            count_tagged_rules(
                &hkcu,
                &[LOCAL, r"Software\Neoxify\nrpt-count-partial\policy"],
                NRPT_COMMENT
            ),
            Ok(0)
        );

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// A `Sweep` over a private HKCU tree, with a closure that records
    /// whether the cmdlet path was reached.
    ///
    /// Returns `(reached_the_cmdlets, cleared)`. The closure is a spy
    /// and does nothing else: what is under test is *when* it runs, and
    /// running the real cmdlet path in a unit test would spawn
    /// PowerShell -- which is the very thing these tests exist to
    /// establish does not happen.
    fn sweep_spy(paths: &[&str], tag: &str) -> (bool, DnsCleared) {
        use std::cell::Cell;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let reached = Cell::new(false);
        let sweep = Sweep {
            root: &hkcu,
            paths,
            tag,
            what: "a test sweep",
        };
        let cleared = sweep.clear_within(|_, cleared| {
            reached.set(true);
            cleared
        });
        (reached.get(), cleared)
    }

    /// Trap #7's other half, and the defect `clear_gaming` still had
    /// after `clear` was fixed.
    ///
    /// The gaming sweep runs at service start, at service stop, at
    /// uninstall, from the idle watchdog and on every disarm -- and on a
    /// machine where gaming mode was never armed, every one of those
    /// finds nothing. Until this test the code spawned PowerShell to be
    /// told so, twice per script, at 9.6-66.7s a call on the rig's
    /// guest, with the `Engines` lock held on three of the five callers.
    ///
    /// Asserting on the *absence of a spawn* is the whole point, and it
    /// cannot be done by timing: a fast machine passes a timing test
    /// with the spawn still there. The spy closure makes it a fact
    /// rather than a measurement. Invert the ordering in
    /// [`Sweep::clear_within`] -- call `cmdlets` before looking at the
    /// registry, which is what this function used to do -- and this
    /// fails on the first assertion.
    #[test]
    fn a_registry_that_says_zero_reaches_no_cmdlet_for_either_tag() {
        const LOCAL: &str = r"Software\Neoxify\nrpt-sweep-empty\local";
        const POLICY: &str = r"Software\Neoxify\nrpt-sweep-empty\policy";
        const ROOT: &str = r"Software\Neoxify\nrpt-sweep-empty";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);

        // Both locations exist and hold rules -- but none of them ours,
        // which is what a machine running some other VPN looks like.
        for path in [LOCAL, POLICY] {
            let (parent, _) = hkcu.create_subkey(path).expect("should create the test key");
            let (theirs, _) = parent.create_subkey("{theirs}").expect("should create a rule");
            theirs
                .set_value("Comment", &"Some other VPN")
                .expect("should tag the rule");
        }

        for tag in [NRPT_COMMENT, GAMING_NRPT_COMMENT] {
            let (reached, cleared) = sweep_spy(&[LOCAL, POLICY], tag);
            assert!(
                !reached,
                "{tag}: a verified-empty registry still spawned the cmdlets"
            );
            assert_eq!(cleared.removed, 0);
            assert!(cleared.unverified.is_none(), "{tag}: reported unverified");
        }

        // And the neighbour's rules are all still there.
        for path in [LOCAL, POLICY] {
            let parent = hkcu.open_subkey_with_flags(path, KEY_READ).unwrap();
            let left: Vec<String> = parent.enum_keys().filter_map(Result::ok).collect();
            assert_eq!(left, vec!["{theirs}".to_string()], "{path} was disturbed");
        }

        let _ = hkcu.delete_subkey_all(ROOT);
    }

    /// The distinction that must not collapse, proved at the sweep
    /// rather than at the counter.
    ///
    /// [`an_unreadable_policy_table_is_an_error_rather_than_a_clean_zero`]
    /// proves `count_tagged_rules` returns `Err`. That is necessary and
    /// not sufficient: a sweep is free to `unwrap_or(0)` it, and one
    /// that did would return silently having removed nothing -- which
    /// for gaming mode strands a whole set of suffix rules pointed at a
    /// DoH stub that stops listening when the session ends, and presents
    /// as "some games stopped resolving" with nothing pointing here.
    ///
    /// So this asserts on the consequence: when the registry cannot be
    /// read, the cmdlets are reached, because they are then the only
    /// witness available. Replace the `Err` arm in
    /// [`Sweep::clear_within`] with `Ok(0)`-like behaviour and this
    /// fails for both tags.
    #[test]
    fn a_registry_that_cannot_be_read_reaches_the_cmdlets_for_either_tag() {
        for tag in [NRPT_COMMENT, GAMING_NRPT_COMMENT] {
            let (reached, _) = sweep_spy(
                &[
                    r"Software\Neoxify\nrpt-sweep-no-such-key\local",
                    r"Software\Neoxify\nrpt-sweep-no-such-key\policy",
                ],
                tag,
            );
            assert!(
                reached,
                "{tag}: an unreadable policy table was treated as a clean zero"
            );
        }
    }

    /// The honesty guard on the new status field, in the direction that
    /// actually costs something.
    ///
    /// `NotRequested` is the ordinary state for WireGuard, which
    /// installs its own DNS, and for every Custom-mode tunnel, which
    /// deliberately leaves the machine's lookups alone. Neither is a
    /// complaint, and reporting one would put a red line about poisoned
    /// answers in front of a customer whose DNS is fine -- this
    /// product's rule that the app never reports a state nothing
    /// verified cuts in both directions.
    ///
    /// `Forced` is not a complaint either. Only a rule that was asked
    /// for and refused is.
    #[test]
    fn only_a_rule_that_was_asked_for_and_refused_is_a_complaint() {
        assert!(!TunnelDns::NotRequested.unprotected());
        assert!(!TunnelDns::Forced.unprotected());
        assert!(TunnelDns::Unforced("powershell did not finish".into()).unprotected());

        // The detail is for the log, never for the customer -- but it
        // has to survive to reach the log at all.
        assert_eq!(TunnelDns::NotRequested.detail(), None);
        assert_eq!(TunnelDns::Forced.detail(), None);
        assert_eq!(
            TunnelDns::Unforced("powershell did not finish".into()).detail(),
            Some("powershell did not finish")
        );
    }

    /// One location absent is ordinary; the other one being empty is a
    /// real, verified zero and must still spawn nothing.
    ///
    /// The Group Policy key does not exist on a machine that is not
    /// domain-joined, which is most of them. If a missing location
    /// counted as "could not look", the cheap path would never be taken
    /// on the machines it was written for.
    #[test]
    fn a_missing_group_policy_location_is_still_a_verified_zero() {
        const LOCAL: &str = r"Software\Neoxify\nrpt-sweep-partial\local";
        const ROOT: &str = r"Software\Neoxify\nrpt-sweep-partial";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(ROOT);
        let (_, _) = hkcu.create_subkey(LOCAL).expect("should create the test key");

        for tag in [NRPT_COMMENT, GAMING_NRPT_COMMENT] {
            let (reached, _) = sweep_spy(
                &[LOCAL, r"Software\Neoxify\nrpt-sweep-partial\policy"],
                tag,
            );
            assert!(!reached, "{tag}: an absent Group Policy key forced a spawn");
        }

        let _ = hkcu.delete_subkey_all(ROOT);
    }
}
