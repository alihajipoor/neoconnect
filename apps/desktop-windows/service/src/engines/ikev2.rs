//! IKEv2 through Windows' own VPN client.
//!
//! The odd engine out: nothing is bundled and no process is spawned.
//! Windows has spoken IKEv2 since 7, so this creates a RAS phonebook
//! entry and dials it, and the operating system owns the tunnel.
//!
//! That is why this lives in the service rather than the app. Creating
//! an all-user VPN connection and dialling it needs administrator
//! rights, and the app deliberately never has them -- the same reason
//! WireGuard's tunnel install goes through here.
//!
//! Everything is invoked with CREATE_NO_WINDOW. A PowerShell window
//! flashing on Connect would be as disqualifying as a permanent one.

use std::process::Command;
use std::ptr;

use super::ras;
use neoconnect_ipc::Ikev2Profile;

/// The phonebook entry's name.
///
/// Fixed rather than per-server: Windows shows this in its own VPN
/// settings and in the network flyout, so it should read as the product
/// rather than as a hostname. One entry is reconfigured in place on each
/// connect, which also stops a customer accumulating an entry per server
/// they have ever tried.
/// The RAS phonebook entry Windows knows this tunnel by. Public so the
/// rival-VPN check can exclude it: it is a VPN interface like any
/// other, and without this our own tunnel is reported as somebody
/// else's.
pub const ENTRY_NAME: &str = "Neoxify";

/// Brings up the tunnel.
///
/// Three details here are not preferences. Each was established by
/// dialling the real node and reading strongSwan's log beside Windows'
/// error, and each fails the connect outright if changed back.
///
/// The server address is the *hostname*, never the node's IP. Windows
/// validates the server's certificate against the name that was
/// dialled, and the node presents a Let's Encrypt certificate for its
/// DNS name.
/// The resolver the nodes push to IKEv2 clients (`dns =` in the swanctl
/// pool). Named here so the NRPT rule points at something the tunnel
/// already carries.
pub(super) const IKEV2_DNS: &str = "1.1.1.1";

pub fn connect(profile: &Ikev2Profile, passive: bool) -> Result<ras::Connection, String> {
    // The entry is removed first rather than updated --
    // Add-VpnConnection refuses when it exists, and -Force only
    // suppresses the prompt, not the conflict; a stale entry pointing at
    // a previous server would otherwise be dialled instead of this one.
    // That removal is now the first line of the script below rather
    // than a spawn of its own; see the note there.

    // Eap, not MSChapv2. Windows rejects MSChapv2 outright for this
    // tunnel type -- "IKEv2 tunnel type only supports Eap and Machine
    // certificate as authentication method", error 87 at creation time,
    // before a packet is sent. Naming Eap makes Windows write its own
    // EAP configuration, and the default it writes is EAP type 26,
    // which is EAP-MSCHAPv2: what the node actually expects.
    // Neither -SplitTunneling nor -RememberCredential is passed, and
    // that is the fix rather than an omission.
    //
    // Both are [switch] parameters. `-SplitTunneling $false` therefore
    // does not mean "off": it turns the switch *on* and leaves $false as
    // a stray positional argument, which then binds to whichever
    // parameter is next in line. Windows reports the resulting mess as
    // "conflicting PPP Tunnel types are specified. Using L2TP is
    // recommended", error 87 -- a message that names neither the
    // parameter nor the real problem, and points at a tunnel type we
    // never asked for.
    //
    // Omitting them is also semantically right: both default to false,
    // and false is what was wanted. Full tunnel, credentials not
    // persisted.
    //
    // Found by trying the variants one at a time on a clean Windows 11
    // (the whole command failed; dropping -SplitTunneling made it
    // succeed), because the error text ruled nothing out on its own.
    // `-SplitTunneling:$false` would work too -- the colon is what binds
    // a value to a switch -- but not passing it at all is harder to get
    // wrong the next time.
    // Named only for Custom mode, and naming it is what makes
    // Custom mode possible here at all: as a [switch], passing
    // -SplitTunneling turns it on, and on means Windows does not
    // claim the default route. That is the same passive shape
    // WireGuard gets from `Table = off` and Xray from installing no
    // routes -- unselected applications keep the normal route, and
    // the split tunnel installs the one route it needs itself.
    //
    // Read the note above before touching this. `-SplitTunneling
    // $false` does not mean off; it turns the switch on and leaves
    // $false to bind to whatever parameter comes next, which Windows
    // reports as a nonsensical complaint about L2TP. Off is not
    // naming it at all. `passive` is what selects it, in `entry_script`.

    // Without the IPsec configuration the connection never starts.
    // Windows' out-of-the-box IKEv2 proposals are 3DES or AES-CBC with
    // SHA1/SHA2 over MODP_1024 -- nothing else -- and a node configured
    // to anything modern answers every one of them with
    // NO_PROPOSAL_CHOSEN at IKE_SA_INIT. Pinning the suite here rather
    // than weakening the node is the right way round: MODP_1024 is
    // 1024-bit Diffie-Hellman, and adding it server-side would hand it
    // to every client rather than to the one that needed it.
    //
    // # One process, not three
    //
    // The removal, the creation and the IPsec configuration used to be
    // three separate `powershell` spawns. They are one script now, and
    // the reason is measured rather than tidiness.
    //
    // These are `VpnClient` cmdlets: CDXML wrappers over CIM, so every
    // spawn pays a PowerShell engine start *and* a module autoload *and*
    // a CIM session before it does any work -- and that cost dominates
    // the work itself, which is three small edits to a phonebook.
    //
    // Measured directly on the rig, a 4-vCPU Windows 11 guest, these
    // exact three cmdlets against the same phonebook, twice:
    //
    //     three spawns (what this used to do)   111.5s      165.8s
    //     the same three in one spawn            14.4s       45.3s
    //     worst single spawn of the three        58.5s      126.7s
    //
    // Seven-fold and nearly four-fold. The fixed cost is nearly all of
    // it, and it was being paid three times. Three of those end to end
    // is not a slow connect, it is a connect that cannot finish inside
    // the app's own 45s deadline on any machine having a bad minute --
    // and the rig's IKEv2 attempt failed at exactly the first of them,
    // "could not create the VPN entry: powershell did not finish
    // within 15s".
    //
    // Note what the second column also says: one spawn took 45.3s in
    // the worse run, which is past that same deadline. Collapsing three
    // into one is what makes this work on an ordinary bad day; it does
    // not make PowerShell an appropriate thing to have on a connect
    // path. The RAS API this file already binds for dialling
    // (`RasSetEntryPropertiesW`, see `super::ras`) is where the entry
    // creation belongs, and it is not attempted here because a wrong
    // struct layout there corrupts memory rather than failing -- the
    // 632 arm below is the scar from the last time.
    //
    // Collapsing them pays that fixed cost once. Each stage keeps its
    // own error, because "the entry could not be created" and "its
    // encryption could not be set" send a support conversation to
    // different places -- the stage name is written to stderr and read
    // back below. `[Console]::Error` rather than `Write-Error`, which
    // `$ErrorActionPreference='Stop'` would turn into a second
    // exception on the way out.
    //
    // The rollback that used to live in Rust lives in the script for the
    // same reason: doing it out here would be a fourth spawn, on the
    // failure path, on a machine that is already too slow.
    //
    // # And now no PowerShell at all, normally
    //
    // The entry is written straight into the phonebook -- see
    // [`write_entry`] -- in milliseconds, where the one-spawn script
    // measured 3.0s on a healthy Windows 11 guest (five runs, 3.03 to
    // 3.35s, nearly all of it PowerShell starting) and up to 45s on the
    // rig. The script is kept, unchanged, as the fallback: if the
    // phonebook cannot be written, or the dial refuses the written entry
    // with a phonebook-level error, the entry is made the old way and
    // dialled once more.
    let written = match write_entry(&profile.server, passive) {
        Ok(()) => true,
        Err(e) => {
            crate::cleanup_log::note(
                "write the IKEv2 entry",
                &format!("{e}; creating it with the VpnClient cmdlets instead"),
            );
            create_with_cmdlets(&profile.server, passive)?;
            false
        }
    };

    let dialled = match dial(&profile.username, &profile.password) {
        Err(code) if written && phonebook_refused(code) => {
            crate::cleanup_log::note(
                "dial the written IKEv2 entry",
                &format!("{}; recreating it with the VpnClient cmdlets", dial_error(code)),
            );
            create_with_cmdlets(&profile.server, passive)?;
            dial(&profile.username, &profile.password)
        }
        other => other,
    };

    match dialled {
        Ok(live) => {
            // Same exposure as every other protocol, despite Windows
            // owning this tunnel: strongSwan pushes 1.1.1.1 and Windows
            // applies it to the VPN interface, but "applied" is not
            // "exclusive" -- lookups still go to every interface at once
            // and the customer's ISP answers first. In Iran that answer
            // is poisoned for exactly the domains they connected to
            // reach.
            //
            // The resolver named here is the one the nodes push (see
            // `dns =` in the swanctl pool, installer/lib/agent.sh), so
            // this points at something already reachable through the
            // tunnel rather than introducing a second opinion.
            //
            // Not fatal on failure. The tunnel is up and carrying
            // traffic at this point, and refusing the connection over a
            // DNS rule would take away a working protocol from someone
            // who may have no other one that connects.
            //
            // That was right about the tunnel and wrong about the
            // silence. Xray used to take the opposite view for this
            // exact call -- fail the connect -- and neither comment
            // acknowledged the other, which made it an inconsistency
            // rather than a decision. Both engines call `dns::force`
            // now: it returns no error, so neither can fail a connect
            // over this again, and the failure reaches the customer
            // through `status` instead of only `stderr`. Carrying on
            // without saying so was the part that could not stand -- in
            // Iran the missing rule means the ISP resolver answers
            // first, with a poisoned address, for exactly the domains
            // they connected to reach.
            //
            // Both modes, and that is a change. This used to be `if
            // !passive`, on the reasoning that Custom mode is not where
            // most traffic goes so the whole machine's lookups should
            // not point down it -- and that the selected applications
            // "still resolve through the tunnel, because their DNS is
            // redirected with the rest of their traffic".
            //
            // The second half was wrong, and it is the half the first
            // half rested on. Custom mode's redirect only sees packets
            // the WinDivert filter admits, and that filter excludes
            // every RFC1918 range -- so on any network whose resolver is
            // the router, which is most of them, the lookup was never
            // redirected at all. It went to the ISP. Xray had this
            // right by forcing unconditionally; the two engines
            // disagreed and, once again, neither comment acknowledged
            // the other.
            //
            // The condition now lives in one place both engines call.
            // `dns::machine_wide_rule_wanted` carries the full argument,
            // including why this is not the over-reach it looks like.
            if super::dns::machine_wide_rule_wanted(passive) {
                super::dns::force(IKEV2_DNS);
            }
            // Handed to the caller to hold for the life of the session.
            // Dropping it hangs the tunnel up, which is what makes the
            // teardown one API call instead of a `rasdial.exe` spawn.
            Ok(live)
        }
        Err(code) => {
            // Tear the entry down again. Leaving a half-configured
            // connection in the customer's Windows VPN settings after a
            // failure is litter they did not ask for and cannot explain.
            let _ = remove_entry();
            Err(dial_error(code))
        }
    }
}

/// Creates the entry with the VpnClient cmdlets: the way it was always
/// made, kept as the fallback behind [`write_entry`]. See the long note
/// in [`connect`] for why it is one script and what it costs.
fn create_with_cmdlets(server: &str, passive: bool) -> Result<(), String> {
    let script = entry_script(&escape_single_quotes(server), passive);
    // `CMDLET_BUDGET`, not `HELPER_BUDGET`: see the measurements on that
    // constant. This is the one call on this path whose expiry fails the
    // connect, and it has no `status` poll behind it.
    powershell_within(&script, super::CMDLET_BUDGET).map(|_| ()).map_err(|e| {
        // The entry may or may not exist depending on which stage went;
        // the script removes it itself on the second, and on the first
        // there is nothing to remove. Belt and braces here would be a
        // further spawn on a machine that just proved it cannot afford
        // one.
        if let Some(rest) = e.strip_prefix("encryption: ") {
            format!("could not configure the VPN entry's encryption: {rest}")
        } else if let Some(rest) = e.strip_prefix("create: ") {
            format!("could not create the VPN entry: {rest}")
        } else {
            // No stage marker, so this is the budget expiring or
            // PowerShell itself failing rather than a cmdlet refusing.
            format!("could not create the VPN entry: {e}")
        }
    })
}

/// Whether a dial failure is RAS refusing the *phonebook entry* -- the
/// ones a hand-written entry could cause and the cmdlets' entry would
/// not -- rather than the tunnel failing.
///
/// 621 cannot open the phonebook, 622 cannot load it, 623 cannot find
/// the entry, 624 cannot write it, 625 corrupt phonebook, 627 a key
/// missing from the entry. Anything else -- the server, credentials,
/// the network -- would fail the same way with the cmdlets' entry, and
/// retrying it would only double the wait.
fn phonebook_refused(code: u32) -> bool {
    matches!(code, 621..=625 | 627)
}

/// Dials the entry, returning the RAS error code on failure.
///
/// `RasDialW` with a null notifier blocks until the tunnel is up or has
/// failed, which is what makes a failed connect observable here rather
/// than something the app discovers later. See [`super::ras`] for why
/// `rasdial.exe` cannot do this job.
fn dial(username: &str, password: &str) -> Result<ras::Connection, u32> {
    let mut params = ras::dial_params();
    ras::set_field(&mut params.szEntryName, ENTRY_NAME);
    ras::set_field(&mut params.szUserName, username);
    ras::set_field(&mut params.szPassword, password);

    // Null extensions, which is the documented simple form and is what
    // this passed originally. The crash that came out of it was never
    // about extensions: it was RASDIALPARAMSW being declared with
    // natural alignment instead of packed(4), which put two fields four
    // bytes off and dropped the trailing pointer while still adding up
    // to the size RAS validates. See [`super::ras`].
    let mut connection = ptr::null_mut();
    // SAFETY: `params` is the generated RASDIALPARAMSW with its own
    // `size_of` in `dwSize`, and it outlives the call; a null phonebook
    // means the system phonebook, which is where -AllUserConnection put
    // the entry; a null notifier makes the call synchronous.
    let code = unsafe {
        ras::ras_dial(
            ptr::null_mut(),
            ptr::null(),
            &mut params,
            0,
            ptr::null(),
            &mut connection,
        )
    };
    // Owned from here on, whether the dial worked or not: a handle can
    // come back even on failure, and leaking it would hold a RAS port
    // open for the life of the service. Dropping it hangs it up.
    let live = ras::Connection::from_raw(connection);

    if code != 0 {
        return Err(code);
    }

    // A success with no handle should not happen, but if RAS ever does
    // it, there is nothing to hang up later and saying so is better than
    // reporting a tunnel this service cannot take down.
    live.ok_or(0)
}

/// Hangs up and removes the entry.
///
/// Both, always. Disconnecting alone would leave "Neoxify" sitting in
/// the customer's Windows VPN list, dialable by hand, outliving the app.
///
/// Skipped outright when the phonebook proves there is no entry. This is
/// called from the untracked arm of `Engines::disconnect`, which every
/// connect runs first to clear the decks -- whatever the protocol -- so
/// it used to launch `rasdial.exe` and a PowerShell `Remove-VpnConnection`
/// on every connect of every customer, almost none of whom have ever
/// used IKEv2: 1.3 to 1.8 seconds on a fast development machine with no
/// phonebook at all, for nothing. A RAS connection needs its entry, and
/// no path here removes the entry before hanging up, so an entry proven
/// absent means nothing to hang up either -- the same reasoning
/// [`is_connected`] already relies on, through the same conclusive
/// check.
pub fn disconnect() -> Result<(), String> {
    disconnect_unless_absent(entry_definitely_absent(), || {
        // rasdial is fine for hanging up: the 703 that rules it out for
        // dialling is an EAP credential prompt, and there is nothing to
        // prompt for when tearing one down.
        let mut hangup = Command::new("rasdial");
        hangup.args([ENTRY_NAME, "/disconnect"]);
        let _ = super::capture_hidden(hangup, super::HELPER_BUDGET);
        remove_entry()
    })
}

/// The decision, apart from the processes it would launch, so it can be
/// tested without launching them. Only proven absence skips the
/// teardown; "could not tell" tears down, as it always did.
fn disconnect_unless_absent(
    definitely_absent: bool,
    teardown: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if definitely_absent {
        return Ok(());
    }
    teardown()
}

/// Whether the entry is currently connected.
///
/// Asked of Windows rather than remembered, so a tunnel dropped by the
/// OS -- or by the customer through the network flyout -- is not
/// reported as up.
pub fn is_connected() -> bool {
    connection_state() == Some(true)
}

/// The same question, keeping "could not ask" apart from "no".
///
/// `None` when PowerShell failed or ran out of time. [`is_connected`]
/// reads that as not connected, which is the right default for the
/// callers deciding whether there is anything to tear down -- and the
/// wrong one for telling a customer their tunnel is gone. The untracked
/// arm of `Engines::status` uses this so that it only says `Down` when
/// Windows actually answered.
pub fn connection_state() -> Option<bool> {
    // The cheap half, and on most machines the whole answer.
    //
    // This is reached from `status()`'s untracked arm, which is the
    // *idle* case -- so the app's status poll came through here every
    // time, spawning a PowerShell process to ask about a tunnel that
    // was not there. Measured at 511ms on a warm CI runner; a
    // customer's machine with an antivirus in the path is worse, and
    // `Status` is the one request the service goes out of its way to
    // keep answerable.
    if entry_definitely_absent() {
        return Some(false);
    }
    let script = format!(
        "(Get-VpnConnection -Name '{ENTRY_NAME}' -AllUserConnection -ErrorAction SilentlyContinue).ConnectionStatus"
    );
    powershell(&script).ok().map(|out| out.trim().eq_ignore_ascii_case("Connected"))
}

/// Where Windows keeps all-user RAS entries.
///
/// Absolute, like every System32 helper this service runs and for the
/// same reason: a service's environment is not the user's, so the path
/// is written out rather than assembled from `%PROGRAMDATA%`.
const ALL_USER_PHONEBOOK: &str =
    r"C:\ProgramData\Microsoft\Network\Connections\Pbk\rasphone.pbk";

/// Whether this service's RAS entry provably does not exist.
///
/// `-AllUserConnection` writes entries to one INI file, as
/// `[entry name]` sections -- established on Windows CI rather than
/// recalled: the file did not exist at all before `Add-VpnConnection`
/// ran and was 2892 bytes with our section in it afterwards.
///
/// Three cases, and the distinction is the whole safety of this:
///
/// * The file is missing. There are no all-user entries, so ours is not
///   among them. Conclusive.
/// * The file is there without our section. Ours does not exist.
///   Conclusive.
/// * Anything else -- a read that failed for any other reason -- is
///   *not* evidence of absence, and falls through to the cmdlet.
///
/// Answering "absent" wrongly is the expensive direction. It reports
/// not-connected while tunnelled, which on 2026-08-17 left a customer
/// with a tunnel they could not see, no Disconnect button to end it,
/// and no other VPN able to work while ours held the routes. That is
/// what put the cmdlet call here in the first place, so the fast path
/// only ever claims absence from the two cases that establish it.
///
/// What this does not cover: an entry removed while its connection
/// somehow survives. No path in this service produces that -- the
/// entry is removed during teardown, after the hang-up -- and the
/// cmdlet would be no better placed to notice.
fn entry_definitely_absent() -> bool {
    match std::fs::read_to_string(ALL_USER_PHONEBOOK) {
        Ok(phonebook) => !phonebook.contains(&format!("[{ENTRY_NAME}]")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// Whether the entry exists at all, connected or not.
///
/// Different from [`is_connected`], and the difference is what `repair`
/// is for: an entry left sitting in the customer's Windows VPN list is
/// dialable by hand and outlives the app, so it counts as residue even
/// while nothing is dialled through it.
///
/// A `None` answer means the question could not be asked -- PowerShell
/// refused, or the RAS cmdlets are not available -- which is reported as
/// unknown rather than as absent.
pub(super) fn entry_present() -> Option<bool> {
    let script = format!(
        "if (Get-VpnConnection -Name '{ENTRY_NAME}' -AllUserConnection -ErrorAction SilentlyContinue) \
         {{ 'yes' }} else {{ 'no' }}"
    );
    match powershell(&script) {
        Ok(out) if out.trim() == "yes" => Some(true),
        Ok(out) if out.trim() == "no" => Some(false),
        _ => None,
    }
}

/// Removes the entry: by editing the phonebook, or with the cmdlet when
/// the file cannot be edited.
pub(super) fn remove_entry() -> Result<(), String> {
    match rewrite_phonebook(None) {
        Ok(()) => Ok(()),
        Err(_) => {
            let script = format!(
                "Remove-VpnConnection -Name '{ENTRY_NAME}' -AllUserConnection -Force -ErrorAction SilentlyContinue"
            );
            powershell(&script).map(|_| ())
        }
    }
}

/// Writes our entry into the all-user phonebook directly, replacing any
/// previous one and leaving every other entry in the file alone.
///
/// # Why this is safe to do by hand
///
/// The phonebook is an INI file, and the section below is not composed
/// from documentation: it is what `Add-VpnConnection` and
/// `Set-VpnConnectionIPsecConfiguration`, run exactly as
/// [`entry_script`] runs them, wrote on a Windows 11 guest -- captured in
/// both modes and pinned in [`entry_section`]. The struct route
/// (`RasSetEntryPropertiesW`) is still avoided for the reason the note in
/// [`connect`] gives: a wrong layout there corrupts memory. A wrong line
/// here fails the dial with a phonebook error, which [`connect`] answers
/// by making the entry the old way.
fn write_entry(server: &str, passive: bool) -> Result<(), String> {
    // The server lands on a `PhoneNumber=` line. A line break or a
    // bracket in it would write a key or a section of its own, so it is
    // refused rather than escaped; the cmdlet fallback takes such a name
    // as a quoted argument instead.
    if server.is_empty() || server.chars().any(|c| c.is_control() || c == '[' || c == ']') {
        return Err(format!("server name {server:?} cannot go in a phonebook line"));
    }
    rewrite_phonebook(Some(&entry_section(server, passive, &EntryStamp::now())))
}

/// Replaces our section of the phonebook with `section`, or removes it
/// when `section` is `None`. Written to a temporary file beside it and
/// renamed over it, so a failure part-way leaves the old phonebook --
/// with the customer's own entries -- intact.
fn rewrite_phonebook(section: Option<&str>) -> Result<(), String> {
    let path = std::path::Path::new(ALL_USER_PHONEBOOK);
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if section.is_none() {
                return Ok(());
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("could not create the phonebook folder: {e}"))?;
            }
            String::new()
        }
        Err(e) => return Err(format!("could not read the phonebook: {e}")),
    };
    let mut updated = without_section(&existing, ENTRY_NAME);
    if let Some(section) = section {
        if !updated.is_empty() && !updated.ends_with("\r\n\r\n") {
            updated.push_str(if updated.ends_with("\r\n") { "\r\n" } else { "\r\n\r\n" });
        }
        updated.push_str(section);
    } else if updated == existing {
        return Ok(());
    }
    let temp = path.with_extension("pbk.neoxify-tmp");
    std::fs::write(&temp, updated.as_bytes())
        .map_err(|e| format!("could not write the phonebook: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not replace the phonebook: {e}")
    })
}

/// `phonebook` without the `[name]` section: from its header line up to,
/// not including, the next line that opens a section. Line endings are
/// kept as they were.
fn without_section(phonebook: &str, name: &str) -> String {
    let header = format!("[{name}]");
    let mut out = String::with_capacity(phonebook.len());
    let mut skipping = false;
    for line in phonebook.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.starts_with('[') {
            skipping = trimmed.eq_ignore_ascii_case(&header);
        }
        if !skipping {
            out.push_str(line);
        }
    }
    out
}

/// The per-entry values Windows generates: when it was written, a
/// dial-parameters id and the entry's GUID.
struct EntryStamp {
    low: i32,
    high: i32,
    dial_params_uid: u32,
    guid: [u8; 16],
}

impl EntryStamp {
    fn now() -> Self {
        use std::hash::{BuildHasher, Hasher};
        // FILETIME: 100ns intervals since 1601, which Windows writes as
        // two signed 32-bit halves (`LowDateTime=-1913900400`).
        const UNIX_TO_FILETIME_SECS: u64 = 11_644_473_600;
        let since_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let filetime = (since_unix.as_secs() + UNIX_TO_FILETIME_SECS) * 10_000_000
            + u64::from(since_unix.subsec_nanos() / 100);
        // Randomness without a dependency: `RandomState` is keyed from
        // the OS's random source for every instance. A GUID only has to
        // be unique among this machine's entries, which this is.
        let random = || {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u64(filetime);
            hasher.finish()
        };
        let mut guid = [0u8; 16];
        guid[..8].copy_from_slice(&random().to_le_bytes());
        guid[8..].copy_from_slice(&random().to_le_bytes());
        Self {
            low: filetime as u32 as i32,
            high: (filetime >> 32) as u32 as i32,
            // Windows' own values were seven digits; any value unique to
            // this entry serves, since credentials are passed to every
            // dial rather than stored against it.
            dial_params_uid: (random() % 9_000_000 + 1_000_000) as u32,
            guid,
        }
    }
}

/// Our phonebook section, as Windows writes it.
///
/// Captured on a Windows 11 guest from the cmdlets [`entry_script`]
/// runs, in both modes, and reproduced line for line. Five lines vary:
/// the stamp's three values, which Windows generates per entry, and
/// `IpPrioritizeRemote` / `Ipv6PrioritizeRemote` -- 1 for a full tunnel,
/// 0 when `-SplitTunneling` is named (Custom mode), which is the whole of
/// what that switch changes here.
///
/// The lines that matter most, so nobody "tidies" them:
///
/// * `CustomIPSecPolicies` is the cipher suite from
///   `Set-VpnConnectionIPsecConfiguration` -- AES256, SHA256, DH group
///   14, no PFS. Without it Windows offers its 1024-bit defaults and the
///   node answers NO_PROPOSAL_CHOSEN; see [`connect`].
/// * `CustomAuthKey=26` and its `CustomAuthData` are EAP-MSCHAPv2, what
///   the node expects; see [`connect`] on why Eap and not MSChapv2.
/// * `PhoneNumber` is the server's *hostname*, which the node's
///   certificate is validated against.
/// * `PowershellCreatedProfile=1` is kept because the captured entry had
///   it; an entry that differs from the cmdlets' in any way nobody
///   measured is not one this should ship.
fn entry_section(server: &str, passive: bool, stamp: &EntryStamp) -> String {
    let prioritize_remote = if passive { 0 } else { 1 };
    let guid: String = stamp.guid.iter().map(|b| format!("{b:02X}")).collect();
    let lines = [
        format!("[{ENTRY_NAME}]"),
        "Encoding=1".into(),
        "PBVersion=8".into(),
        "Type=2".into(),
        "AutoLogon=0".into(),
        "UseRasCredentials=1".into(),
        format!("LowDateTime={}", stamp.low),
        format!("HighDateTime={}", stamp.high),
        format!("DialParamsUID={}", stamp.dial_params_uid),
        format!("Guid={guid}"),
        "VpnStrategy=7".into(),
        "ExcludedProtocols=0".into(),
        "LcpExtensions=1".into(),
        "DataEncryption=256".into(),
        "SwCompression=0".into(),
        "NegotiateMultilinkAlways=0".into(),
        "SkipDoubleDialDialog=0".into(),
        "DialMode=0".into(),
        "OverridePref=15".into(),
        "RedialAttempts=3".into(),
        "RedialSeconds=60".into(),
        "IdleDisconnectSeconds=0".into(),
        "RedialOnLinkFailure=1".into(),
        "CallbackMode=0".into(),
        "CustomDialDll=".into(),
        "CustomDialFunc=".into(),
        "CustomRasDialDll=".into(),
        "ForceSecureCompartment=0".into(),
        "DisableIKENameEkuCheck=0".into(),
        "AuthenticateServer=0".into(),
        "ShareMsFilePrint=1".into(),
        "BindMsNetClient=1".into(),
        "SharedPhoneNumbers=0".into(),
        "GlobalDeviceSettings=0".into(),
        "PrerequisiteEntry=".into(),
        "PrerequisitePbk=".into(),
        "PreferredPort=VPN2-0".into(),
        "PreferredDevice=WAN Miniport (IKEv2)".into(),
        "PreferredBps=0".into(),
        "PreferredHwFlow=0".into(),
        "PreferredProtocol=0".into(),
        "PreferredCompression=0".into(),
        "PreferredSpeaker=0".into(),
        "PreferredMdmProtocol=0".into(),
        "PreviewUserPw=1".into(),
        "PreviewDomain=1".into(),
        "PreviewPhoneNumber=0".into(),
        "ShowDialingProgress=1".into(),
        "ShowMonitorIconInTaskBar=1".into(),
        "CustomAuthKey=26".into(),
        "CustomAuthData=314442431A00000008000000010000000000000000000000".into(),
        "AuthRestrictions=128".into(),
        format!("IpPrioritizeRemote={prioritize_remote}"),
        "IpInterfaceMetric=0".into(),
        "IpHeaderCompression=0".into(),
        "IpAddress=0.0.0.0".into(),
        "IpDnsAddress=0.0.0.0".into(),
        "IpDns2Address=0.0.0.0".into(),
        "IpWinsAddress=0.0.0.0".into(),
        "IpWins2Address=0.0.0.0".into(),
        "IpAssign=1".into(),
        "IpNameAssign=1".into(),
        "IpDnsFlags=0".into(),
        "IpNBTFlags=1".into(),
        "TcpWindowSize=0".into(),
        "UseFlags=2".into(),
        "IpSecFlags=0".into(),
        "IpDnsSuffix=".into(),
        "Ipv6Assign=1".into(),
        "Ipv6Address=::".into(),
        "Ipv6PrefixLength=0".into(),
        format!("Ipv6PrioritizeRemote={prioritize_remote}"),
        "Ipv6InterfaceMetric=0".into(),
        "Ipv6NameAssign=1".into(),
        "Ipv6DnsAddress=::".into(),
        "Ipv6Dns2Address=::".into(),
        "Ipv6Prefix=0000000000000000".into(),
        "Ipv6InterfaceId=0000000000000000".into(),
        "DisableClassBasedDefaultRoute=0".into(),
        "DisableMobility=0".into(),
        "NetworkOutageTime=1800".into(),
        "IDI=".into(),
        "IDR=".into(),
        "ImsConfig=0".into(),
        "IdiType=0".into(),
        "IdrType=0".into(),
        "ProvisionType=0".into(),
        "PreSharedKey=".into(),
        "CacheCredentials=0".into(),
        "NumCustomPolicy=1".into(),
        "CustomIPSecPolicies=020000000400000003000000050000000200000000000000".into(),
        "NumEku=0".into(),
        "UseMachineRootCert=0".into(),
        "Disable_IKEv2_Fragmentation=0".into(),
        "PlumbIKEv2TSAsRoutes=0".into(),
        "NumServers=0".into(),
        "RouteVersion=1".into(),
        "NumRoutes=0".into(),
        "NumNrptRules=0".into(),
        "AutoTiggerCapable=0".into(),
        "NumAppIds=0".into(),
        "NumClassicAppIds=0".into(),
        "SecurityDescriptor=".into(),
        "ApnInfoProviderId=".into(),
        "ApnInfoUsername=".into(),
        "ApnInfoPassword=".into(),
        "ApnInfoAccessPoint=".into(),
        "ApnInfoAuthentication=1".into(),
        "ApnInfoCompression=0".into(),
        "DeviceComplianceEnabled=0".into(),
        "DeviceComplianceSsoEnabled=0".into(),
        "DeviceComplianceSsoEku=".into(),
        "DeviceComplianceSsoIssuer=".into(),
        "FlagsSet=0".into(),
        "Options=0".into(),
        "DisableDefaultDnsSuffixes=0".into(),
        "NumTrustedNetworks=0".into(),
        "NumDnsSearchSuffixes=0".into(),
        "PowershellCreatedProfile=1".into(),
        "ProxyFlags=0".into(),
        "ProxySettingsModified=0".into(),
        "ProvisioningAuthority=".into(),
        "AuthTypeOTP=0".into(),
        "GREKeyDefined=0".into(),
        "NumPerAppTrafficFilters=0".into(),
        "AlwaysOnCapable=0".into(),
        "DeviceTunnel=0".into(),
        "PrivateNetwork=0".into(),
        "ManagementApp=".into(),
        String::new(),
        "NETCOMPONENTS=".into(),
        "ms_msclient=1".into(),
        "ms_server=1".into(),
        String::new(),
        "MEDIA=rastapi".into(),
        "Port=VPN2-0".into(),
        "Device=WAN Miniport (IKEv2)".into(),
        String::new(),
        "DEVICE=vpn".into(),
        format!("PhoneNumber={server}"),
        "AreaCode=".into(),
        "CountryCode=0".into(),
        "CountryID=0".into(),
        "UseDialingRules=0".into(),
        "Comment=".into(),
        "FriendlyName=".into(),
        "LastSelectedPhone=0".into(),
        "PromoteAlternates=0".into(),
        "TryNextAlternateOnFail=1".into(),
        String::new(),
    ];
    lines.join("\r\n") + "\r\n"
}

/// The one script `connect` runs, built where it can be tested.
///
/// Extracted for exactly one reason: it is a PowerShell program
/// assembled by string formatting in another language, it now carries
/// control flow, and a syntax error in it would fail every IKEv2
/// connect with a message about PowerShell rather than about the VPN.
/// The test below parses what this returns.
///
/// `server` must already be escaped -- see [`escape_single_quotes`].
fn entry_script(server: &str, passive: bool) -> String {
    format!(
        "$ErrorActionPreference='Stop'; \
         Remove-VpnConnection -Name '{name}' -AllUserConnection -Force -ErrorAction SilentlyContinue; \
         try {{ \
           Add-VpnConnection -Name '{name}' -ServerAddress '{server}' \
             -TunnelType Ikev2 -AuthenticationMethod Eap \
             -EncryptionLevel Required -AllUserConnection -Force{split} -PassThru | Out-Null \
         }} catch {{ [Console]::Error.WriteLine('create: ' + $_.Exception.Message); exit 11 }}; \
         try {{ \
           Set-VpnConnectionIPsecConfiguration -ConnectionName '{name}' -AllUserConnection \
             -AuthenticationTransformConstants SHA256128 -CipherTransformConstants AES256 \
             -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -DHGroup Group14 \
             -PfsGroup None -Force | Out-Null \
         }} catch {{ \
           Remove-VpnConnection -Name '{name}' -AllUserConnection -Force -ErrorAction SilentlyContinue; \
           [Console]::Error.WriteLine('encryption: ' + $_.Exception.Message); exit 12 \
         }}",
        name = ENTRY_NAME,
        split = if passive { " -SplitTunneling" } else { "" },
    )
}

/// Runs a PowerShell one-liner, hidden and bounded.
///
/// Bounded because every caller here runs with the `Engines` lock held,
/// and `is_connected` is on the status path -- a PowerShell that never
/// returned would make the one question a customer must always be able
/// to ask unanswerable. See [`super::HELPER_BUDGET`].
fn powershell(script: &str) -> Result<String, String> {
    powershell_within(script, super::HELPER_BUDGET)
}

/// The same, against a budget the caller chooses.
///
/// Only [`connect`] passes anything else. The three callers that stay on
/// [`super::HELPER_BUDGET`] stay there deliberately: `is_connected`
/// answers `status`, where latency is the customer's, and
/// `entry_present` and `remove_entry` are on the repair path, whose own
/// deadline is derived from budget arithmetic one layer up.
fn powershell_within(script: &str, budget: std::time::Duration) -> Result<String, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let out = super::capture_hidden(command, budget).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout)
}

/// Turns a RAS error code into something a customer can act on.
///
/// Four codes mean genuinely different things and deserve different
/// advice. Anything else falls back to Windows' own wording, which is
/// generic but accurate and already translated -- better than a
/// sentence invented here for a code nobody has ever seen.
pub(super) fn dial_error(code: u32) -> String {
    match code {
        691 => "The server rejected these credentials.".into(),
        // The classic one for this protocol. 809 is "no response",
        // which on a censored network means UDP 500 and 4500 are being
        // dropped -- exactly what IKEv2 cannot survive and the stealth
        // protocols exist for.
        809 => "No response from the server. UDP is likely blocked on this network; \
                try a Stealth protocol instead."
            .into(),
        13801 | 13806 => "The server's certificate was not accepted. This is a server-side \
                          problem rather than anything to do with your account."
            .into(),
        // What a refused password actually looks like here, rather than
        // the 691 the documentation implies: the node answers an
        // EAP-MSCHAPv2 failure by tearing the SA down, and Windows
        // reports that as the remote having hung up. Observed against
        // the real node with a username that did not exist.
        628 => "The server ended the connection, usually because the credentials were \
                refused. If this keeps happening, try another server."
            .into(),
        // Ours, never the customer's. 632 is RAS refusing the size of a
        // structure we passed it, which can only be a mistake in this
        // build -- so the message says so rather than dressing it up as
        // a network problem the customer could act on.
        //
        // Should be unreachable now that the structures come from
        // windows-sys rather than being hand-declared (see
        // engines/ras.rs), and the layouts are pinned by tests. Kept
        // because "unreachable" and "unreached" are different things,
        // and the alternative to a clear message here is a customer
        // being told their network is at fault.
        632 => "Built-in (IKEv2) could not start because of a bug in the app, not a problem \
                with your account or your network. Please report this; every other protocol \
                is unaffected in the meantime."
            .into(),
        other => ras::error_text(other)
            .unwrap_or_else(|| format!("The connection failed (Windows error {other}).")),
    }
}

/// Windows' phonebook name is single-quoted in the PowerShell above, so
/// a quote in a hostname would end the string early. Hostnames cannot
/// contain one, but the value arrives from the API rather than from a
/// constant, and a config-injection bug here runs as SYSTEM.
fn escape_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only proven absence may skip the hang-up and the entry removal.
    /// "Could not tell" has to tear down: answering absent wrongly is
    /// the direction that once left a customer with a tunnel they could
    /// not see -- see `entry_definitely_absent`.
    #[test]
    fn only_a_proven_absence_skips_the_teardown() {
        let mut ran = false;
        assert!(disconnect_unless_absent(true, || {
            ran = true;
            Ok(())
        })
        .is_ok());
        assert!(!ran, "a provably absent entry launches nothing");

        let mut ran = false;
        let outcome = disconnect_unless_absent(false, || {
            ran = true;
            Err("teardown result".to_string())
        });
        assert!(ran, "anything short of proof still tears down");
        assert_eq!(outcome, Err("teardown result".to_string()), "and its result is what is returned");
    }


    /// The script is a PowerShell program written by string formatting
    /// in another language, and it now carries control flow. A stray
    /// brace in it would fail *every* IKEv2 connect with a message about
    /// PowerShell, on every machine, healthy or not -- a far worse
    /// failure than the slow one this shape was adopted to fix.
    ///
    /// Balanced braces are checked here because that is what a Rust test
    /// can check; the script was also put through PowerShell's own
    /// parser (`Parser::ParseInput`) in both variants when it was
    /// written, which is what a rig can check and a unit test cannot.
    #[test]
    fn the_entry_script_is_structurally_sound_in_both_modes() {
        for passive in [false, true] {
            let script = entry_script("vpn.example.net", passive);
            let opens = script.matches('{').count();
            let closes = script.matches('}').count();
            assert_eq!(opens, closes, "unbalanced braces (passive={passive}): {script}");
            assert!(!script.contains('\n'), "the script must stay one -Command line");

            // Both stages must keep their own marker, because the Rust
            // side reads them back to decide which error the customer is
            // shown.
            assert!(script.contains("[Console]::Error.WriteLine('create: "));
            assert!(script.contains("[Console]::Error.WriteLine('encryption: "));
            // And the second stage must still undo the first, which is
            // the rollback that used to live in Rust.
            assert_eq!(script.matches("Remove-VpnConnection").count(), 2);
        }
    }

    /// `-SplitTunneling` is a `[switch]`: naming it turns it on. Custom
    /// mode needs it named and a full tunnel needs it absent, and the
    /// long note in `connect` exists because passing `$false` turns it
    /// *on* and corrupts the rest of the command line.
    #[test]
    fn split_tunneling_is_named_only_for_custom_mode() {
        assert!(!entry_script("vpn.example.net", false).contains("-SplitTunneling"));
        assert!(entry_script("vpn.example.net", true).contains("-Force -SplitTunneling"));
    }

    /// This value arrives from the API and reaches a command line that
    /// runs as SYSTEM.
    #[test]
    fn a_quote_in_a_hostname_cannot_end_the_string_early() {
        assert_eq!(escape_single_quotes("a'b"), "a''b");
        let script = entry_script(&escape_single_quotes("evil'; calc; #"), false);
        assert!(script.contains("'evil''; calc; #'"), "{script}");
    }

    fn stamp() -> EntryStamp {
        EntryStamp { low: -1_913_900_400, high: 31_282_399, dial_params_uid: 6_394_593, guid: [0xAB; 16] }
    }

    /// Lines copied from the section `Add-VpnConnection` and
    /// `Set-VpnConnectionIPsecConfiguration` wrote on a Windows 11 guest.
    /// The ones a hand-written entry would get wrong first: the cipher
    /// suite, the EAP type, the device, and the server on the line the
    /// certificate is checked against.
    #[test]
    fn the_written_section_matches_what_windows_wrote() {
        let section = entry_section("vpn.example.net", false, &stamp());
        for line in [
            "[Neoxify]",
            "CustomIPSecPolicies=020000000400000003000000050000000200000000000000",
            "NumCustomPolicy=1",
            "CustomAuthKey=26",
            "CustomAuthData=314442431A00000008000000010000000000000000000000",
            "VpnStrategy=7",
            "PreferredDevice=WAN Miniport (IKEv2)",
            "Device=WAN Miniport (IKEv2)",
            "PhoneNumber=vpn.example.net",
            "LowDateTime=-1913900400",
            "HighDateTime=31282399",
            "DialParamsUID=6394593",
            "Guid=ABABABABABABABABABABABABABABABAB",
        ] {
            assert!(section.contains(&format!("{line}\r\n")), "missing {line:?}");
        }
        assert_eq!(section.lines().filter(|l| l.starts_with('[')).count(), 1);
    }

    /// The whole of what `-SplitTunneling` changed in the captured
    /// entries: two lines, 1 for a full tunnel and 0 for Custom mode.
    #[test]
    fn custom_mode_changes_only_the_two_prioritize_remote_lines() {
        let full = entry_section("vpn.example.net", false, &stamp());
        let custom = entry_section("vpn.example.net", true, &stamp());
        let differing: Vec<_> = full.lines().zip(custom.lines()).filter(|(a, b)| a != b).collect();
        assert_eq!(
            differing,
            [("IpPrioritizeRemote=1", "IpPrioritizeRemote=0"), ("Ipv6PrioritizeRemote=1", "Ipv6PrioritizeRemote=0")]
        );
    }

    /// The customer's own VPN entries share this file. Replacing ours
    /// must not touch theirs, whichever side of ours they sit on.
    #[test]
    fn only_our_section_is_removed() {
        let book = "[Work]\r\nPhoneNumber=a\r\n\r\n\
                    [Neoxify]\r\nPhoneNumber=b\r\n\r\nNETCOMPONENTS=\r\nms_server=1\r\n\r\n\
                    [Home]\r\nPhoneNumber=c\r\n";
        assert_eq!(
            without_section(book, "Neoxify"),
            "[Work]\r\nPhoneNumber=a\r\n\r\n[Home]\r\nPhoneNumber=c\r\n"
        );
        assert_eq!(without_section("[Work]\r\nx=1\r\n", "Neoxify"), "[Work]\r\nx=1\r\n");
    }

    /// A line break or bracket in the server would write a key or a
    /// section of its own. Refused, so the quoted cmdlet path takes it.
    #[test]
    fn a_server_that_could_write_its_own_line_is_refused() {
        for server in ["a\r\nPhoneNumber=b", "x]\r\n[Other", "", "a\nb"] {
            assert!(write_entry(server, false).is_err(), "{server:?}");
        }
    }

    #[test]
    fn only_phonebook_errors_retry_with_the_cmdlets() {
        for code in [621, 622, 623, 624, 625, 627] {
            assert!(phonebook_refused(code), "{code}");
        }
        // Credentials, server and network failures would fail the same
        // way with the cmdlets' entry.
        for code in [626, 628, 691, 703, 800, 809, 13801, 13806] {
            assert!(!phonebook_refused(code), "{code}");
        }
    }
}
