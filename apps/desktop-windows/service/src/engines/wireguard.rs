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
use std::time::{Duration, Instant};

use neoconnect_ipc::WireguardProfile;
use windows_service::service::{ServiceAccess, ServiceState};
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
    limits: &crate::lifecycle::budget::Limits,
) -> Result<(), String> {
    let exe = engines.engine_path("wireguard.exe")?;
    let conf_path = engines.config_path(CONF_FILE);
    write_config(&conf_path, &build_conf(profile, passive))?;

    // The name has to be free before this runs, or wireguard.exe never
    // returns. See clear_tunnel_service.
    //
    // A share of the connect's time rather than all of it. This is the
    // first stage, and `TUNNEL_SERVICE_GONE_WITHIN` is 45 seconds --
    // more than the whole connect budget -- so clamping alone would let
    // a tunnel service that is slow to stop spend every second the
    // connect had and leave the engine nothing, reporting that the
    // attempt ran out of time without ever having tried to connect.
    clear_tunnel_service(&limits.share(CLEARING_THE_DECKS_SHARE))?;

    // Clamped for the same reason as Xray's netsh: `HELPER_BUDGET`
    // reads the ambient cancellation but not the deadline, so a
    // wireguard.exe that wedges could carry a connect past the budget
    // and finish after the app had stopped listening.
    let status = super::run_hidden_within(
        &exe,
        &[OsStr::new("/installtunnelservice"), conf_path.as_os_str()],
        limits.clamp(super::HELPER_BUDGET),
    )
    .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /installtunnelservice exited with {status}"));
    }
    Ok(())
}

pub fn disconnect(engines: &Engines) -> Result<(), String> {
    // A teardown is not cancellable, and this is the one place that
    // tried to make it so.
    //
    // Reading the live token here looks right and is not:
    // `pipe::dispatch` cancels the running operation *before* it runs
    // the disconnect, so the token a disconnect would read is one it
    // just had cancelled on its own behalf. The teardown then aborted
    // itself at the first poll and reported failure -- caught by
    // `disconnecting_twice_is_cheap_and_quiet`, and precisely how a
    // machine ends up stranded with a tunnel service still running
    // while the app says disconnected.
    //
    // So this pass is given a token nothing can cancel. The customer is
    // not waiting on it: the hard stop already answered them inside
    // 900ms and asked the service to stop. This is the thorough pass
    // behind that, and its whole job is to establish that the thing is
    // actually gone. Disconnecting twice stays cheap for the real
    // reason rather than an accidental one -- the second call finds no
    // service to open and returns immediately.
    let uncancellable = crate::lifecycle::budget::Limits::new(
        crate::lifecycle::cancel::CancelToken::new(),
        TUNNEL_SERVICE_GONE_WITHIN,
    );
    let exe = engines.engine_path("wireguard.exe")?;
    let status = run_hidden(&exe, &[OsStr::new("/uninstalltunnelservice"), OsStr::new(TUNNEL_NAME)])
        .map_err(|e| format!("could not start wireguard.exe: {e}"))?;
    if !status.success() {
        return Err(format!("wireguard.exe /uninstalltunnelservice exited with {status}"));
    }
    // Asking is not the same as it having happened -- see
    // clear_tunnel_service. Without this, a disconnect returns while the
    // machine is still tunnelled, and the very next status poll
    // correctly reports it as connected.
    clear_tunnel_service(&uncancellable)
}

/// How long the tunnel service is given to go away.
///
/// It normally goes in well under a second: `/uninstalltunnelservice`
/// returned in 0.03s and the stop lands on the next poll. Ten seconds
/// was chosen as "room for a machine under load", and the rig found the
/// machine that reading did not cover -- a 4-vCPU guest at a 30% CPU
/// execution cap took longer than that to stop one service, and the
/// disconnect came back with the sentence below.
///
/// That is worse than a slow disconnect, and the reason is one function
/// away: `Engines::connect_inner` begins with `self.disconnect()?`. A
/// teardown that reports failure therefore **fails the next connect
/// too**, and the customer's second attempt is refused because their
/// first one was still tidying up. The error even tells them to wait and
/// try again, which is the right advice for a fault that should not have
/// been raised.
///
/// Forty-five seconds instead. This is not a process budget -- nothing
/// is spawned, it is an SCM poll -- so the argument about one wedged
/// child making the service deaf does not apply. On the connect path
/// the loop reads the caller's token on every pass, so a customer
/// pressing Disconnect ends it immediately whatever the ceiling says;
/// on the teardown path nothing can cancel it, deliberately, and the
/// ceiling is the only bound there is. What is left is only: how long
/// before "the service is still stopping" becomes "the service is never
/// stopping". Forty-five seconds is generous for the first and still
/// well short of the second.
pub(super) const TUNNEL_SERVICE_GONE_WITHIN: Duration = Duration::from_secs(45);

/// How much of a connect may go on waiting for the *previous* tunnel
/// service to stop.
///
/// Not a second ceiling on the same thing -- it is a share, applied only
/// on the connect path. [`TUNNEL_SERVICE_GONE_WITHIN`] still answers
/// "when does still-stopping become never-stopping", and a teardown,
/// where this wait is the only thing running, still gets all 45 seconds
/// of it.
///
/// A connect is in a different position: it has 38 seconds for
/// everything, and this stage runs before any of the work the customer
/// actually asked for. Ten seconds covers the normal case by about three
/// hundred times -- `/uninstalltunnelservice` was measured returning in
/// 0.03s with the stop landing on the next poll -- and when it is not
/// enough, the error already says the useful thing: wait a few seconds
/// and connect again. That is a better answer than spending the whole
/// budget and reporting that time ran out.
const CLEARING_THE_DECKS_SHARE: Duration = Duration::from_secs(10);

/// How often the service manager is asked whether it has gone yet.
const TUNNEL_SERVICE_POLL: Duration = Duration::from_millis(250);

/// Makes sure the tunnel service name is free, stopping the service
/// ourselves if wireguard.exe's own request did not take.
///
/// This is the fix for the worst failure this service has had, and the
/// mechanism is worth writing down because none of it is visible from
/// wireguard.exe's exit code.
///
/// `/installtunnelservice` returns while the tunnel service it created
/// is still START_PENDING -- it does not wait for it to reach RUNNING.
/// `/uninstalltunnelservice` then returns in 0.03s having sent a stop
/// control and called DeleteService. A service in START_PENDING cannot
/// accept a stop, so the stop is refused and only the delete takes: the
/// service finishes starting, reaches RUNNING marked-for-delete, and
/// nothing is left that will ever stop it. The next
/// `/installtunnelservice` finds the name still taken and spins in an
/// unbounded OpenService loop waiting for it to free -- forever, because
/// the process holding it is running and nobody has asked it to stop.
///
/// Measured in isolation on this machine, with an inert config that
/// installs no routes: install, uninstall, install again, and the second
/// install had not returned ninety seconds later while the first
/// service still read RUNNING. In the field the same sequence held the
/// `Engines` lock for 25 minutes with the customer fully tunnelled and
/// no request, not even `status`, getting an answer.
///
/// So the stop is issued from here, where it can be repeated until the
/// service is actually in a state that accepts it, and the wait is ours
/// and bounded rather than wireguard.exe's and endless.
/// `pub(super)` for `repair`, which has to be able to clear a stranded
/// tunnel service on a machine where `wireguard.exe` is not usable at
/// all -- a killed service, a half-removed install, or the
/// START_PENDING-then-marked-for-delete state described above, where
/// asking wireguard.exe again is precisely what hangs.
/// Ask the SCM to stop the tunnel service, and return without waiting.
///
/// The fast half of a teardown. [`clear_tunnel_service`] does the
/// thorough version -- it polls until the service is actually gone,
/// bounded at [`TUNNEL_SERVICE_GONE_WITHIN`], 45 seconds -- and that
/// wait is correct for the background pass but ruinous on the path a
/// customer is watching. `wireguard.exe /installtunnelservice` has been
/// seen holding the engine lock for twenty-five minutes in the field,
/// with every request behind it unanswered while the customer sat
/// tunnelled with no way out.
///
/// Stopping the service is what severs the tunnel; whether its entry has
/// finished disappearing from the SCM is a question for phase two, and
/// the service-start sweep removes it on the next boot regardless.
///
/// Never an error worth failing a teardown over. A service that is
/// already gone, or that was never installed because this session used a
/// different engine, is the normal case rather than a fault.
pub(super) fn request_stop_without_waiting() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|err| format!("could not reach the service manager: {err}"))?;

    let service = match manager.open_service(TUNNEL_SERVICE_NAME, ServiceAccess::STOP) {
        Ok(service) => service,
        // Not installed. Nothing to stop, which is success.
        Err(_) => return Ok(()),
    };

    // The result is deliberately not inspected beyond reporting it. A
    // stop sent to a service that is already stopping returns an error
    // saying so, and that is not something the customer's disconnect
    // should be held up by or told about.
    match service.stop() {
        Ok(_) => Ok(()),
        Err(err) => Err(format!("the tunnel service did not accept a stop: {err}")),
    }
}

pub(super) fn clear_tunnel_service(limits: &crate::lifecycle::budget::Limits) -> Result<(), String> {
    // One pass always runs, even on a spent budget: the early returns
    // below are the cheap-and-quiet case -- no service to open means the
    // name is already free -- and refusing before asking would turn the
    // common case into a failure.
    let budget = limits.clamp(TUNNEL_SERVICE_GONE_WITHIN);
    let deadline = Instant::now() + budget;
    loop {
        let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        else {
            // Nothing can be asked, so nothing can be promised. Saying
            // so by returning is better than looping until the deadline
            // to report a failure that is really "the service manager
            // is unreachable" -- and the install that follows is bounded
            // by HELPER_BUDGET regardless.
            return Ok(());
        };
        let Ok(service) = manager.open_service(
            TUNNEL_SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
        ) else {
            // The name is free, which is the whole point.
            return Ok(());
        };

        // Only when it can be accepted. A stop sent at START_PENDING is
        // refused, and being refused is exactly how the machine got
        // into this state in the first place.
        if matches!(service.query_status(), Ok(status) if status.current_state == ServiceState::Running)
        {
            let _ = service.stop();
        }
        drop(service);

        // With a ceiling this long, a customer who has pressed
        // Disconnect must not queue behind the rest of it. Reported as
        // the abandonment rather than as a WireGuard fault, because that
        // is what happened.
        if limits.cancelled() {
            return Err(super::ABANDONED.to_string());
        }
        if Instant::now() >= deadline {
            // A spent budget is not WireGuard's fault and must not read
            // as it: the stage that happens to notice the clock ran out
            // is an accident of ordering.
            if budget.is_zero() {
                return Err(super::OUT_OF_TIME.to_string());
            }
            return Err(format!(
                "the previous WireGuard tunnel was still shutting down after {}s. \
                 Waiting a few seconds and connecting again usually clears it.",
                budget.as_secs()
            ));
        }
        std::thread::sleep(TUNNEL_SERVICE_POLL);
    }
}

/// Best-effort teardown for the case where this service has no record of
/// a tunnel but one may still exist -- e.g. the service was restarted
/// while connected. Failure is not reported: "there was nothing to
/// remove" is the expected outcome most of the time.
pub fn remove_tunnel_if_present(engines: &Engines) {
    // Registered, not running: a tunnel service whose process died is
    // still `StartAutomatic`, and comes back at the next boot unless it
    // is removed here.
    if !tunnel_service_registered() {
        return;
    }
    let _ = disconnect(engines);
}

/// Removes the tunnel service without going through wireguard.exe.
///
/// The last resort in `repair`, and only reached when the ordinary path
/// -- `/uninstalltunnelservice` followed by [`clear_tunnel_service`] --
/// has already been tried and the service is still registered. That
/// happens for two reasons worth separating: wireguard.exe is not
/// usable (a half-removed install, a deleted resources directory), or it
/// ran and the name is still taken.
///
/// Stop then delete, in that order and both bounded, because a
/// `DeleteService` on a running service only *marks* it for deletion --
/// which is the exact state that stranded customers in 0.9.24, with a
/// tunnel service RUNNING marked-for-delete and nothing left that would
/// ever stop it.
///
/// This does not remove the WireGuardNT adapter the service created;
/// Windows removes that with the service. Nor does it touch any other
/// `WireGuardTunnel$...` service: the name is the one derived from our
/// own config file, so an official WireGuard client's tunnels are not
/// ours to end.
pub(super) fn force_remove_tunnel_service() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("the service manager could not be reached: {e}"))?;
    let Ok(service) = manager.open_service(
        TUNNEL_SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) else {
        // Already gone, which is the outcome this is for.
        return Ok(());
    };

    let deadline = Instant::now() + TUNNEL_SERVICE_GONE_WITHIN;
    loop {
        match service.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => break,
            // Only when it can be accepted -- a stop sent at
            // START_PENDING is refused, and being refused is how a
            // machine gets into this state.
            Ok(status) if status.current_state == ServiceState::Running => {
                let _ = service.stop();
            }
            Ok(_) => {}
            // It cannot be interrogated any more, which for our purposes
            // is indistinguishable from it having gone.
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            // Deleted anyway. A marked-for-delete service that is still
            // running is a worse state than a stopped one, but it is not
            // a worse state than the one we found -- and it goes at the
            // next boot rather than never.
            let _ = service.delete();
            return Err(format!(
                "the WireGuard tunnel service would not stop within {}s; it is marked for removal \
                 and will be gone after a restart",
                TUNNEL_SERVICE_GONE_WITHIN.as_secs()
            ));
        }
        std::thread::sleep(TUNNEL_SERVICE_POLL);
    }

    service
        .delete()
        .map_err(|e| format!("the WireGuard tunnel service could not be removed: {e}"))
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

    /// The liveness bug, as a table. A registered service is not a
    /// running tunnel: a tunnel service whose process died stays
    /// registered in `Stopped`, and reading that as "up" is how a dead
    /// WireGuard tunnel would have been reported connected indefinitely.
    #[test]
    fn a_stopped_tunnel_service_is_not_a_running_tunnel() {
        assert!(!counts_as_running(&ScmView::NotRegistered));
        assert!(!counts_as_running(&ScmView::Stopped(None)));
        assert!(!counts_as_running(&ScmView::Stopped(Some(1))));
        assert!(counts_as_running(&ScmView::Running(Some(4242))));
        assert!(counts_as_running(&ScmView::Running(None)));
        // Still stopping, or not readable: not proof of down, so not
        // reported as down.
        assert!(counts_as_running(&ScmView::Pending));
        assert!(counts_as_running(&ScmView::Unreadable));
    }

    /// On a machine without our tunnel service, both questions say no --
    /// and removing it is the registration question, so a stopped one is
    /// still removed. Asked of the real service manager.
    #[test]
    fn with_no_tunnel_service_installed_nothing_is_running_or_registered() {
        if tunnel_service_registered() {
            // A developer machine with a live tunnel; nothing to assert.
            return;
        }
        assert!(!tunnel_is_running());
        assert_eq!(scm_view(), ScmView::NotRegistered);
    }

    /// The watch on the tunnel service, end to end against a real
    /// process: the service manager is scripted, the process it names is
    /// a real one, and killing that process has to be noticed within the
    /// slice -- not on the next status poll.
    #[test]
    fn a_tunnel_service_whose_process_dies_is_noticed_promptly() {
        use crate::lifecycle::engine_watch::{watch, Gone};
        use std::os::windows::process::CommandExt;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        let mut process = std::process::Command::new(r"C:\Windows\System32\ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawning ping");
        let pid = process.id();

        // Starting, then running as `pid`, then -- once the process has
        // been killed -- still "running" for a few looks (the manager is
        // not instant), then stopped with an exit code.
        let killed = Arc::new(AtomicBool::new(false));
        let seen_killed = Arc::clone(&killed);
        let mut looks_after_kill = 0;
        let mut looks = 0;
        let query = move || {
            looks += 1;
            if looks < 3 {
                return ScmView::Pending;
            }
            if !seen_killed.load(Ordering::SeqCst) {
                return ScmView::Running(Some(pid));
            }
            looks_after_kill += 1;
            if looks_after_kill < 3 {
                ScmView::Running(Some(pid))
            } else {
                ScmView::Stopped(Some(1066))
            }
        };

        let reports: Arc<Mutex<Vec<Gone>>> = Arc::default();
        let into = Arc::clone(&reports);
        let guard = watch(
            9,
            "test-wg",
            Box::new(ServiceLiveness::with_query(query)),
            Arc::new(move |g: Gone| into.lock().unwrap().push(g)),
        )
        .expect("starting a watch");

        // Long enough to have reached Running and be waiting on the
        // process; nothing must be reported while it is alive.
        std::thread::sleep(Duration::from_millis(600));
        assert!(reports.lock().unwrap().is_empty(), "reported a live tunnel service as gone");

        killed.store(true, Ordering::SeqCst);
        let killed_at = Instant::now();
        process.kill().unwrap();
        let _ = process.wait();

        let deadline = Instant::now() + Duration::from_secs(5);
        while reports.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let reports = reports.lock().unwrap();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert_eq!(reports[0].generation, 9);
        assert_eq!(reports[0].detail, Some(1066), "the service's own exit code");
        assert!(
            reports[0].at.saturating_duration_since(killed_at) < Duration::from_secs(2),
            "noticed {:?} after the process died",
            reports[0].at.saturating_duration_since(killed_at)
        );
        drop(guard);
    }

    /// A tunnel service that is removed outright -- not stopped, gone --
    /// is an ending too.
    #[test]
    fn a_tunnel_service_that_disappears_is_gone() {
        use crate::lifecycle::engine_watch::{Liveness, Look};
        let mut liveness = ServiceLiveness::with_query(|| ScmView::NotRegistered);
        assert!(matches!(liveness.look(), Look::Gone(None)));
        let mut liveness = ServiceLiveness::with_query(|| ScmView::Pending);
        assert!(matches!(liveness.look(), Look::Again), "a starting service is not an ending");
    }

    /// Only "no such service" is an absent service. Every other reason
    /// the manager would not open it is a question that went unanswered,
    /// and used to be read as a definite ending -- the engine watch
    /// reporting a live tunnel gone, and `tunnel_is_running` answering
    /// `false` over it.
    #[test]
    fn only_a_service_that_does_not_exist_is_not_registered() {
        let open_failed = |code: i32| view_of_open_error(&windows_service::Error::Winapi(std::io::Error::from_raw_os_error(code)));
        assert_eq!(open_failed(1060), ScmView::NotRegistered, "ERROR_SERVICE_DOES_NOT_EXIST");
        for code in [
            5,    // ERROR_ACCESS_DENIED
            6,    // ERROR_INVALID_HANDLE
            8,    // ERROR_NOT_ENOUGH_MEMORY
            123,  // ERROR_INVALID_NAME
            1053, // ERROR_SERVICE_REQUEST_TIMEOUT
            1072, // ERROR_SERVICE_MARKED_FOR_DELETE
            1115, // ERROR_SHUTDOWN_IN_PROGRESS
        ] {
            let view = open_failed(code);
            assert_eq!(view, ScmView::Unreadable, "error {code}");
            assert!(counts_as_running(&view), "error {code} read as a tunnel that is down");
        }
        assert_eq!(
            view_of_open_error(&windows_service::Error::ArgumentHasNulByte("service name")),
            ScmView::Unreadable
        );
    }

    /// The same at the watch: a manager that cannot be asked, once or for
    /// a while, is not an ending, and the process already held goes on
    /// being waited on.
    #[test]
    fn a_tunnel_service_that_cannot_be_opened_is_not_gone() {
        use crate::lifecycle::engine_watch::{Liveness, Look};
        let mut liveness = ServiceLiveness::with_query(|| ScmView::Unreadable);
        for _ in 0..3 {
            assert!(matches!(liveness.look(), Look::Again), "an unanswered question was taken for an ending");
        }
        assert!(liveness.may_return(), "a stopped tunnel service can be started again without us");
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

/// Whether the tunnel service is registered at all, running or not.
///
/// The question for everything that *removes* it -- the untracked arm of
/// a disconnect, repair, the diagnostics snapshot -- because a
/// registered service is residue whatever state it is in: it is
/// `StartAutomatic`, so a stopped one comes back up at the next boot.
pub fn tunnel_service_registered() -> bool {
    !matches!(scm_view(), ScmView::NotRegistered)
}

/// Whether the tunnel is up, as far as the service manager can say.
///
/// This used to be [`tunnel_service_registered`] under this name -- it
/// asked whether the service could be *opened*, never whether it was
/// running. A tunnel service whose process died stays registered, in
/// `Stopped`, so `status` went on answering `connected: true` for a
/// WireGuard tunnel that no longer existed, and the session was never
/// torn down: its DNS confinement, pinned to the dead adapter, went on
/// blocking plain DNS for the whole machine until the customer pressed
/// Disconnect. Read from the code rather than measured -- the VM run
/// that found the Xray case did not kill a WireGuard tunnel.
///
/// Note this says nothing about whether the tunnel works; see
/// [`handshake_health`] for that.
pub fn tunnel_is_running() -> bool {
    counts_as_running(&scm_view())
}

/// The rule, apart from the service manager so it can be tested.
///
/// Anything short of `Stopped` counts, deliberately including the
/// pending states and a status that could not be read. A tunnel that is
/// still stopping may still be carrying traffic for a moment, and "I
/// could not ask" is not "it is down" -- answering down there would be a
/// tunnel state nothing verified, in the direction that tells a customer
/// with a live tunnel that they have none.
pub(super) fn counts_as_running(view: &ScmView) -> bool {
    match view {
        ScmView::NotRegistered | ScmView::Stopped(_) => false,
        ScmView::Running(_) | ScmView::Pending | ScmView::Unreadable => true,
    }
}

/// What the service manager says about the tunnel service, reduced to
/// what liveness needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ScmView {
    /// No such service: never installed, or removed.
    NotRegistered,
    /// Registered, and its status could not be read.
    Unreadable,
    /// Stopped, with the service's own exit code when it set one.
    Stopped(Option<i64>),
    /// Starting, stopping, pausing or continuing.
    Pending,
    /// Running, with its process id when the manager gave one.
    Running(Option<u32>),
}

pub(super) fn scm_view() -> ScmView {
    use windows_service::service::ServiceExitCode;
    let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) else {
        // Nothing can be asked. Treated as unreadable rather than as
        // absent, for the reason `counts_as_running` gives.
        return ScmView::Unreadable;
    };
    let service = match manager.open_service(TUNNEL_SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(service) => service,
        Err(e) => return view_of_open_error(&e),
    };
    match service.query_status() {
        Ok(status) => match status.current_state {
            ServiceState::Stopped => ScmView::Stopped(match status.exit_code {
                ServiceExitCode::Win32(0) => None,
                ServiceExitCode::Win32(code) | ServiceExitCode::ServiceSpecific(code) => {
                    Some(i64::from(code))
                }
            }),
            ServiceState::Running => ScmView::Running(status.process_id),
            _ => ScmView::Pending,
        },
        Err(_) => ScmView::Unreadable,
    }
}

/// What a failure to open the tunnel service says about it.
///
/// Only `ERROR_SERVICE_DOES_NOT_EXIST` means there is no such service.
/// Everything else -- a manager too busy to answer, access refused, a
/// handle that could not be allocated -- is the question going
/// unanswered, and reading that as "not registered" turned a failed
/// query into a definite ending: the engine watch reported the tunnel
/// gone and the status poll answered `connected: false` over a tunnel
/// that was up. "Could not ask" is not "down".
fn view_of_open_error(error: &windows_service::Error) -> ScmView {
    const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
    match error {
        windows_service::Error::Winapi(e) if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
            ScmView::NotRegistered
        }
        _ => ScmView::Unreadable,
    }
}

/// The tunnel service as a [`Liveness`], for the engine watch.
///
/// wireguard.exe runs each tunnel as its own service process, which is
/// what dies when the tunnel does -- and the WireGuardNT adapter and the
/// kill-switch filters go with it. So once the service manager says
/// `Running` this waits on that process, by a handle opened from the pid
/// the manager reports; until then, and between a process ending and the
/// manager marking the service stopped, it asks again.
///
/// The service manager is asked on every look, not only when there is
/// nothing to wait on. A slice is a second, so that is one query a
/// second, and it is what makes a pid reused between the process exiting
/// and the handle being opened harmless: the manager says `Stopped` on
/// the next look whatever the handle is waiting on.
///
/// `query` is the service manager in the service ([`scm_view`], by way
/// of `Engines`) and a script in tests.
///
/// [`Liveness`]: crate::lifecycle::engine_watch::Liveness
pub(super) struct ServiceLiveness<Q> {
    query: Q,
    held: Option<(u32, crate::lifecycle::engine_watch::OwnedHandle)>,
}

impl<Q: FnMut() -> ScmView> ServiceLiveness<Q> {
    pub(super) fn with_query(query: Q) -> Self {
        Self { query, held: None }
    }
}

impl<Q: FnMut() -> ScmView + Send + 'static> crate::lifecycle::engine_watch::Liveness for ServiceLiveness<Q> {
    fn look(&mut self) -> crate::lifecycle::engine_watch::Look {
        use crate::lifecycle::engine_watch::{open_process, Look};
        let held_alive = self.held.as_ref().is_some_and(|(_, h)| !h.is_signalled());
        match (self.query)() {
            ScmView::NotRegistered => Look::Gone(None),
            ScmView::Stopped(code) => Look::Gone(code),
            ScmView::Running(Some(pid)) => match &self.held {
                Some((held, handle)) if *held == pid => {
                    if held_alive {
                        Look::WaitOn(handle.raw())
                    } else {
                        // Our handle says the process ended and the
                        // manager has not caught up. A moment, not a wait.
                        Look::Again
                    }
                }
                _ => match open_process(pid) {
                    Ok(handle) => {
                        let raw = handle.raw();
                        self.held = Some((pid, handle));
                        Look::WaitOn(raw)
                    }
                    // Gone between the query and the open, or not ours to
                    // open. The next look asks the manager again.
                    Err(_) => Look::Again,
                },
            },
            // Mid-transition, or the manager could not say. Keep waiting
            // on the process already held if it is still there; there is
            // nothing to conclude from a state that is passing through.
            ScmView::Running(None) | ScmView::Pending | ScmView::Unreadable => match &self.held {
                Some((_, handle)) if held_alive => Look::WaitOn(handle.raw()),
                _ => Look::Again,
            },
        }
    }

    /// A stopped service can be started again without us -- by the
    /// manager's recovery actions, or by anyone allowed to start it -- so
    /// a `Stopped` seen once is checked before it is believed.
    fn may_return(&self) -> bool {
        true
    }
}
