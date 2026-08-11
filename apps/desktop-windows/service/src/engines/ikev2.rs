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

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

use super::CREATE_NO_WINDOW;
use neoconnect_ipc::Ikev2Profile;

/// The phonebook entry's name.
///
/// Fixed rather than per-server: Windows shows this in its own VPN
/// settings and in the network flyout, so it should read as the product
/// rather than as a hostname. One entry is reconfigured in place on each
/// connect, which also stops a customer accumulating an entry per server
/// they have ever tried.
const ENTRY_NAME: &str = "Neoxify";

/// Brings up the tunnel.
///
/// The server address is the *hostname*, never the node's IP. Windows
/// validates the server's certificate against the name that was dialled,
/// and the node presents a Let's Encrypt certificate for its DNS name --
/// dialling the address fails with a certificate error that says nothing
/// useful about the cause.
pub fn connect(profile: &Ikev2Profile) -> Result<(), String> {
    // Removed first rather than updated. Add-VpnConnection refuses when
    // the entry exists, and -Force only suppresses the prompt, not the
    // conflict; a stale entry pointing at a previous server would
    // otherwise be dialled instead of this one.
    let _ = remove_entry();

    // MSChapv2 here means EAP-MSCHAPv2 on the wire, which is what the
    // node's strongSwan expects. The alternative spelling
    // (-AuthenticationMethod Eap) needs an EAP configuration XML blob
    // and buys nothing for username and password.
    let script = format!(
        "Add-VpnConnection -Name '{name}' -ServerAddress '{server}' \
         -TunnelType Ikev2 -AuthenticationMethod MSChapv2 \
         -EncryptionLevel Required -SplitTunneling $false \
         -RememberCredential $false -AllUserConnection -Force -PassThru | Out-Null",
        name = ENTRY_NAME,
        server = escape_single_quotes(&profile.server),
    );
    powershell(&script).map_err(|e| format!("could not create the VPN entry: {e}"))?;

    // rasdial rather than PowerShell for the dial itself: PowerShell has
    // no cmdlet that connects an entry and waits for the result, while
    // rasdial blocks until the tunnel is up or has failed, and returns a
    // non-zero code on failure. That is what makes a failed connect
    // observable here rather than something the app discovers later.
    let out = Command::new("rasdial")
        .args([ENTRY_NAME, &profile.username, &profile.password])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run rasdial: {e}"))?;

    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stdout);
        // Tear the entry down again. Leaving a half-configured
        // connection in the customer's Windows VPN settings after a
        // failure is litter they did not ask for and cannot explain.
        let _ = remove_entry();
        return Err(rasdial_error(&detail));
    }
    Ok(())
}

/// Hangs up and removes the entry.
///
/// Both, always. Disconnecting alone would leave "Neoxify" sitting in
/// the customer's Windows VPN list, dialable by hand, outliving the app.
pub fn disconnect() -> Result<(), String> {
    let _ = Command::new("rasdial")
        .args([ENTRY_NAME, "/disconnect"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output();
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

fn powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Turns rasdial's output into something a customer can act on.
///
/// Its error codes are the useful part -- the accompanying text is
/// generic -- and three of them mean genuinely different things that
/// deserve different advice. Anything unrecognised is passed through
/// rather than flattened, on the same reasoning as the app's error
/// handling: the raw detail survives to be read.
fn rasdial_error(output: &str) -> String {
    if output.contains("691") {
        return "The server rejected these credentials.".into();
    }
    if output.contains("809") {
        // The classic one for this protocol. 809 is "no response", which
        // on a censored network means UDP 500 and 4500 are being dropped
        // -- exactly what IKEv2 cannot survive and the stealth protocols
        // exist for.
        return "No response from the server. UDP is likely blocked on this network; \
                try a Stealth protocol instead."
            .into();
    }
    if output.contains("13801") || output.contains("13806") {
        return "The server's certificate was not accepted. This is a server-side \
                problem rather than anything to do with your account."
            .into();
    }
    let trimmed = output.trim();
    if trimmed.is_empty() {
        "The connection failed and Windows gave no reason.".into()
    } else {
        trimmed.to_string()
    }
}

/// Windows' phonebook name is single-quoted in the PowerShell above, so
/// a quote in a hostname would end the string early. Hostnames cannot
/// contain one, but the value arrives from the API rather than from a
/// constant, and a config-injection bug here runs as SYSTEM.
fn escape_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}
