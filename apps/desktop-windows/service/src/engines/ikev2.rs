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
const IKEV2_DNS: &str = "1.1.1.1";

pub fn connect(profile: &Ikev2Profile, passive: bool) -> Result<(), String> {
    // Removed first rather than updated. Add-VpnConnection refuses when
    // the entry exists, and -Force only suppresses the prompt, not the
    // conflict; a stale entry pointing at a previous server would
    // otherwise be dialled instead of this one.
    let _ = remove_entry();

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
    // naming it at all.
    let split = if passive { " -SplitTunneling" } else { "" };
    let script = format!(
        "Add-VpnConnection -Name '{name}' -ServerAddress '{server}' \
         -TunnelType Ikev2 -AuthenticationMethod Eap \
         -EncryptionLevel Required -AllUserConnection -Force{split} -PassThru | Out-Null",
        name = ENTRY_NAME,
        split = split,
        server = escape_single_quotes(&profile.server),
    );
    powershell(&script).map_err(|e| format!("could not create the VPN entry: {e}"))?;

    // Without this the connection never starts. Windows' out-of-the-box
    // IKEv2 proposals are 3DES or AES-CBC with SHA1/SHA2 over MODP_1024
    // -- nothing else -- and a node configured to anything modern
    // answers every one of them with NO_PROPOSAL_CHOSEN at IKE_SA_INIT.
    // Pinning the suite here rather than weakening the node is the
    // right way round: MODP_1024 is 1024-bit Diffie-Hellman, and adding
    // it server-side would hand it to every client rather than to the
    // one that needed it.
    let suite = format!(
        "Set-VpnConnectionIPsecConfiguration -ConnectionName '{name}' -AllUserConnection \
         -AuthenticationTransformConstants SHA256128 -CipherTransformConstants AES256 \
         -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -DHGroup Group14 \
         -PfsGroup None -Force | Out-Null",
        name = ENTRY_NAME,
    );
    if let Err(e) = powershell(&suite) {
        let _ = remove_entry();
        return Err(format!("could not configure the VPN entry's encryption: {e}"));
    }

    match dial(&profile.username, &profile.password) {
        Ok(()) => {
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
            // Full tunnel only. In Custom mode this tunnel is not where
            // most traffic goes, so pointing the whole machine's lookups
            // down it would be wrong for every application the customer
            // did not select. The selected ones still resolve through the
            // tunnel, because their DNS is redirected with the rest of
            // their traffic -- the same reasoning as WireGuard dropping
            // its DNS in passive mode.
            if !passive {
                if let Err(e) = super::dns::apply(IKEV2_DNS) {
                    eprintln!("ikev2: {e}");
                }
            }
            Ok(())
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

/// Dials the entry, returning the RAS error code on failure.
///
/// `RasDialW` with a null notifier blocks until the tunnel is up or has
/// failed, which is what makes a failed connect observable here rather
/// than something the app discovers later. See [`super::ras`] for why
/// `rasdial.exe` cannot do this job.
fn dial(username: &str, password: &str) -> Result<(), u32> {
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
    if code != 0 {
        // A handle can come back even on failure, and leaking it would
        // hold a RAS port open for the life of the service.
        if !connection.is_null() {
            unsafe { ras::ras_hang_up(connection) };
        }
        return Err(code);
    }
    Ok(())
}

/// Hangs up and removes the entry.
///
/// Both, always. Disconnecting alone would leave "Neoxify" sitting in
/// the customer's Windows VPN list, dialable by hand, outliving the app.
pub fn disconnect() -> Result<(), String> {
    // rasdial is fine for hanging up: the 703 that rules it out for
    // dialling is an EAP credential prompt, and there is nothing to
    // prompt for when tearing one down.
    let mut hangup = Command::new("rasdial");
    hangup.args([ENTRY_NAME, "/disconnect"]);
    let _ = super::capture_hidden(hangup, super::HELPER_BUDGET);
    remove_entry()
}

/// Whether the entry is currently connected.
///
/// Asked of Windows rather than remembered, so a tunnel dropped by the
/// OS -- or by the customer through the network flyout -- is not
/// reported as up.
pub fn is_connected() -> bool {
    let script = format!(
        "(Get-VpnConnection -Name '{ENTRY_NAME}' -AllUserConnection -ErrorAction SilentlyContinue).ConnectionStatus"
    );
    matches!(powershell(&script), Ok(out) if out.trim().eq_ignore_ascii_case("Connected"))
}

fn remove_entry() -> Result<(), String> {
    let script = format!(
        "Remove-VpnConnection -Name '{ENTRY_NAME}' -AllUserConnection -Force -ErrorAction SilentlyContinue"
    );
    powershell(&script).map(|_| ())
}

/// Runs a PowerShell one-liner, hidden and bounded.
///
/// Bounded because every caller here runs with the `Engines` lock held,
/// and `is_connected` is on the status path -- a PowerShell that never
/// returned would make the one question a customer must always be able
/// to ask unanswerable. See [`super::HELPER_BUDGET`].
fn powershell(script: &str) -> Result<String, String> {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let out = super::capture_hidden(command, super::HELPER_BUDGET).map_err(|e| e.to_string())?;
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
fn dial_error(code: u32) -> String {
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
