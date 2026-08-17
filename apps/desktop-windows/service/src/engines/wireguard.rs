//! WireGuard via the official wireguard.exe.
//!
//! `/installtunnelservice` is the same mechanism the official WireGuard
//! for Windows client uses: it registers a Windows service for the
//! tunnel and auto-installs the WireGuardNT driver on first use. Because
//! this helper already runs as LocalSystem, that call needs no
//! elevation and produces no UAC prompt -- which is the entire reason
//! this service exists (the app used to shell out to it via `runas`,
//! prompting the user on every single Connect).

use std::ffi::OsStr;

use neoconnect_ipc::WireguardProfile;
use windows_service::service::ServiceAccess;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use super::{run_hidden, run_hidden_capture, write_config, Engines};

pub const TUNNEL_NAME: &str = "neoconnect";
const CONF_FILE: &str = "neoconnect.conf";

/// wireguard.exe derives the tunnel's service name from the config file
/// name, so this is fixed by CONF_FILE above, not chosen independently.
const TUNNEL_SERVICE_NAME: &str = "WireGuardTunnel$neoconnect";

/// Builds the tunnel config.
///
/// `passive` is Custom mode. It adds `Table = off`, wireguard.exe's own
/// directive for "create the interface but do not touch the routing
/// table" -- verified on this machine rather than taken on trust:
/// with `AllowedIPs = 0.0.0.0/0` and the directive present, the adapter
/// appeared and the system default route stayed on the physical link.
///
/// `AllowedIPs` is left as it is either way. It is cryptokey routing --
/// which destinations this peer is *allowed* to carry -- and the split
/// tunnel needs that to stay wide open. What it must not do is become
/// the machine's routing policy, and `Table = off` is exactly the line
/// between the two.
///
/// DNS is also dropped in passive mode. Setting a tunnel resolver would
/// point the whole machine's lookups at the VPN, which is a full-tunnel
/// behaviour arriving through a setting that promised the opposite.
fn build_conf(p: &WireguardProfile, passive: bool) -> String {
    let dns = if passive {
        String::new()
    } else {
        format!("DNS = {}\n", p.dns.as_deref().unwrap_or("1.1.1.1"))
    };
    let table = if passive { "Table = off\n" } else { "" };

    // MTU, explicitly, because leaving it out is not neutral. Measured on
    // a customer's machine 2026-08-17: the adapter came up at 1500, the
    // same as the Wi-Fi link underneath it, so every full-size packet was
    // over the path MTU once WireGuard's ~80 bytes of header went on.
    //
    // That failure is horrible to diagnose from the outside because it is
    // size-dependent, not on/off: the handshake completes, small requests
    // work, DNS works, and then large responses silently vanish. To the
    // customer some sites load and others hang forever, on a tunnel the
    // app is correctly reporting as connected.
    //
    // 1420 is WireGuard's own default for IPv4 over a 1500-byte link
    // (1500 - 20 IP - 8 UDP - 32 WireGuard) and matches what the nodes
    // already run on wg0, so both ends agree rather than negotiating
    // through loss.
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = {}\nMTU = 1420\n{dns}{table}\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\nEndpoint = {}\nPersistentKeepalive = 25\n",
        p.private_key,
        p.address,
        p.server_public_key,
        p.allowed_ips,
        p.endpoint,
    )
}

pub fn connect(
    engines: &Engines,
    profile: &WireguardProfile,
    passive: bool,
) -> Result<(), String> {
    let exe = engines.engine_path("wireguard.exe")?;
    let conf_path = engines.config_path(CONF_FILE);
    write_config(&conf_path, &build_conf(profile, passive))?;

    let status = run_hidden(&exe, &[OsStr::new("/installtunnelservice"), conf_path.as_os_str()])
        .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /installtunnelservice exited with {status}"));
    }
    Ok(())
}

pub fn disconnect(engines: &Engines) -> Result<(), String> {
    let exe = engines.engine_path("wireguard.exe")?;
    let status = run_hidden(&exe, &[OsStr::new("/uninstalltunnelservice"), OsStr::new(TUNNEL_NAME)])
        .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /uninstalltunnelservice exited with {status}"));
    }
    Ok(())
}

/// Best-effort teardown for the case where this service has no record of
/// a tunnel but one may still exist -- e.g. the service was restarted
/// while connected. Failure is not reported: "there was nothing to
/// remove" is the expected outcome most of the time.
pub fn remove_tunnel_if_present(engines: &Engines) {
    if !tunnel_is_running() {
        return;
    }
    let _ = disconnect(engines);
}

/// A handshake older than this means the peer has stopped answering.
///
/// WireGuard rehandshakes about every two minutes while traffic flows,
/// so three minutes is one missed cycle plus room for a link that is
/// merely idle. Shorter would flag healthy idle tunnels as dead.
const HANDSHAKE_STALE_AFTER_SECS: u64 = 180;

/// The `wg show` subcommand that reports per-peer handshake times.
///
/// Named as a constant so the plural is stated once and guarded by a
/// test. The singular reads more naturally and is wrong: wg.exe rejects
/// it, writes usage to stderr, and prints nothing to stdout -- which the
/// parser then reads as "no peers" and reports as Unknown for every
/// tunnel, working or not.
const HANDSHAKES_SUBCOMMAND: &str = "latest-handshakes";

/// Whether the far end is actually answering, as opposed to whether we
/// managed to create an interface.
///
/// This is the distinction the UI was missing. WireGuard is UDP and does
/// no session setup at connect time, so `wireguard.exe` happily creates a
/// tunnel service whose peer is unreachable, whose key is wrong, or whose
/// port is blocked -- and every local check (service exists, interface
/// up) still says yes. Reporting that as "Connected" tells someone they
/// are protected when they are not.
///
/// `latest-handshake` cannot be faked locally: a non-zero value means the
/// server completed a cryptographic handshake with us. That makes it the
/// one piece of real evidence available, so it is what this reports on.
pub fn handshake_health(engines: &Engines) -> HandshakeHealth {
    let Ok(exe) = engines.engine_path("wg.exe") else {
        return HandshakeHealth::Unknown;
    };

    // `wg show <iface> latest-handshakes` prints "<peer>\t<unix seconds>",
    // one line per peer. Zero means "never handshaked since the interface
    // came up", which is precisely the failed-connection case.
    //
    // The subcommand is plural. Singular is not an alias: wg.exe rejects
    // it, prints usage to stderr, and writes nothing to stdout -- which
    // parsed as "no peers" and reported Unknown for every tunnel,
    // healthy or not. Unit tests could not catch that, since they feed
    // the parser text directly; only running it against a real interface
    // showed it.
    let out = match run_hidden_capture(
        &exe,
        &[OsStr::new("show"), OsStr::new(TUNNEL_NAME), OsStr::new(HANDSHAKES_SUBCOMMAND)],
    ) {
        Ok(out) => out,
        Err(_) => return HandshakeHealth::Unknown,
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    parse_handshake(&out, now)
}

/// Split out from the process call so the decision itself can be tested.
/// This is the judgement that decides whether a customer is told they are
/// protected, so it should not only be exercisable by having a real
/// tunnel up.
fn parse_handshake(out: &str, now: u64) -> HandshakeHealth {
    let latest = out
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .filter_map(|secs| secs.trim().parse::<u64>().ok())
        .max();

    match latest {
        // No peer line at all -- the interface is not there in the way we
        // expect, so claiming anything about the peer would be invention.
        None => HandshakeHealth::Unknown,
        Some(0) => HandshakeHealth::NeverHandshaked,
        Some(ts) => {
            // Saturating: a clock adjustment must not wrap into a huge
            // age and report a healthy tunnel as dead.
            let age = now.saturating_sub(ts);
            if age <= HANDSHAKE_STALE_AFTER_SECS {
                HandshakeHealth::Alive { age_secs: age }
            } else {
                HandshakeHealth::Stale { age_secs: age }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> WireguardProfile {
        WireguardProfile {
            private_key: "cHJpdmF0ZQ==".into(),
            address: "10.66.0.5/32".into(),
            dns: Some("1.1.1.1".into()),
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: "cHVibGlj".into(),
            endpoint: "203.0.113.5:51820".into(),
        }
    }

    #[test]
    fn a_full_tunnel_config_installs_routes_and_sets_dns() {
        let conf = build_conf(&profile(), false);
        assert!(!conf.contains("Table = off"), "the default must still capture routing");
        assert!(conf.contains("DNS = 1.1.1.1"));
    }

    #[test]
    fn every_config_pins_the_mtu_below_the_link() {
        // Omitting MTU is not neutral. Measured on a customer's machine
        // 2026-08-17: the adapter came up at 1500, matching the Wi-Fi
        // link under it, so full-size packets exceeded the path MTU once
        // WireGuard's header was added. Size-dependent breakage is the
        // worst kind to report -- the handshake succeeds, DNS resolves,
        // small requests work, and large responses vanish, so the
        // customer sees "some sites don't load" on a tunnel that is
        // genuinely connected.
        //
        // Both modes, because Custom mode gives up the routing table but
        // still carries packets through the same interface.
        for passive in [false, true] {
            let conf = build_conf(&profile(), passive);
            assert!(conf.contains("MTU = 1420"), "passive={passive}: MTU must be pinned");
        }
    }

    #[test]
    fn custom_mode_keeps_the_interface_and_gives_up_the_routing_table() {
        // The distinction Custom mode rests on. AllowedIPs stays wide
        // open -- it is cryptokey routing, "what this peer may carry" --
        // while Table = off stops that becoming the machine's routing
        // policy. Verified on a real machine before this was written:
        // with both present, the adapter appeared and the system default
        // route stayed on the physical link.
        let conf = build_conf(&profile(), true);
        assert!(conf.contains("Table = off"));
        assert!(conf.contains("AllowedIPs = 0.0.0.0/0"), "the peer must still accept everything");
    }

    #[test]
    fn custom_mode_leaves_the_machines_dns_alone() {
        // Pointing every lookup at the VPN resolver is a full-tunnel
        // behaviour. Arriving through a setting that promises the
        // opposite would send the whole machine's browsing history to
        // the node for a customer who selected one game.
        let conf = build_conf(&profile(), true);
        assert!(!conf.contains("DNS ="));
    }

    const NOW: u64 = 1_700_000_000;

    /// Guards the actual command, which the parser tests cannot: they
    /// feed text in directly, so they passed for a build that asked
    /// wg.exe the wrong question and never got an answer.
    #[test]
    fn the_handshakes_subcommand_is_the_plural_one_wg_accepts() {
        assert_eq!(HANDSHAKES_SUBCOMMAND, "latest-handshakes");
    }

    #[test]
    fn a_recent_handshake_means_the_peer_is_answering() {
        let out = "abc123=\t{}\n".replace("{}", &(NOW - 30).to_string());
        assert_eq!(parse_handshake(&out, NOW), HandshakeHealth::Alive { age_secs: 30 });
    }

    /// The case this whole milestone exists for: wireguard.exe created
    /// the tunnel, every local check says "up", and the server has never
    /// replied. Reporting this as connected is what told customers they
    /// were protected when they were not.
    #[test]
    fn a_zero_timestamp_means_the_server_never_replied() {
        assert_eq!(parse_handshake("abc123=\t0\n", NOW), HandshakeHealth::NeverHandshaked);
    }

    #[test]
    fn a_handshake_older_than_the_window_is_stale() {
        let out = format!("abc123=\t{}\n", NOW - 600);
        assert_eq!(parse_handshake(&out, NOW), HandshakeHealth::Stale { age_secs: 600 });
    }

    /// WireGuard rehandshakes about every two minutes, so an idle-but-fine
    /// tunnel must not be flagged.
    #[test]
    fn a_tunnel_between_rehandshakes_is_still_alive() {
        let out = format!("abc123=\t{}\n", NOW - 150);
        assert_eq!(parse_handshake(&out, NOW), HandshakeHealth::Alive { age_secs: 150 });
    }

    #[test]
    fn no_peer_line_is_unknown_rather_than_a_guess() {
        assert_eq!(parse_handshake("", NOW), HandshakeHealth::Unknown);
        assert_eq!(parse_handshake("garbage without a tab", NOW), HandshakeHealth::Unknown);
    }

    /// A clock that jumped backwards must not turn a live tunnel into a
    /// wrapped, enormous age that reads as long-dead.
    #[test]
    fn a_timestamp_in_the_future_does_not_wrap_into_stale() {
        let out = format!("abc123=\t{}\n", NOW + 500);
        assert_eq!(parse_handshake(&out, NOW), HandshakeHealth::Alive { age_secs: 0 });
    }

    /// Multiple peers can be listed; the tunnel is alive if any of them
    /// answered recently.
    #[test]
    fn the_most_recent_peer_decides() {
        let out = format!("old=\t0\nnew=\t{}\n", NOW - 10);
        assert_eq!(parse_handshake(&out, NOW), HandshakeHealth::Alive { age_secs: 10 });
    }
}

/// What the peer's handshake says about the tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeHealth {
    /// The server answered recently. The tunnel is genuinely carrying.
    Alive { age_secs: u64 },
    /// It answered once, but not lately -- the server or the path died.
    Stale { age_secs: u64 },
    /// The interface exists but the server has never answered: wrong key,
    /// unreachable host, or a blocked port. The case that used to render
    /// as "Connected".
    NeverHandshaked,
    /// wg.exe missing or unreadable output. Reported as its own state
    /// rather than guessed either way.
    Unknown,
}

/// Asks the service manager whether the tunnel service exists at all.
/// Opening it is enough -- a tunnel service that exists is one
/// wireguard.exe created and has not torn down.
///
/// Note this says nothing about whether the tunnel works; see
/// [`handshake_health`] for that.
pub fn tunnel_is_running() -> bool {
    let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
        return false;
    };
    manager.open_service(TUNNEL_SERVICE_NAME, ServiceAccess::QUERY_STATUS).is_ok()
}
