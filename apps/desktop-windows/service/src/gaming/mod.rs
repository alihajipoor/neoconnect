//! Gaming DNS mode: NRPT rules, a loopback DoH stub, and three checks
//! that decide what the app is allowed to say about them.
//!
//! # What this mode is, and what it is not
//!
//! It brings up **no adapter, no tunnel and no route**. A resolver we
//! run answers a curated list of a game's hostnames with the address of
//! our proxy and refuses everything else; the machine's own traffic path
//! is untouched, and so is its exit IP. That last part is not a caveat
//! to bury -- design §8.3 requires the app to say it in words, because
//! a customer who reads "on" as "my IP changed" has been misled by us.
//!
//! # Why it is not a `ConnectionState`
//!
//! There is no tunnel here, so there is nothing "Connected" could
//! truthfully mean. Gaming mode gets [`GamingPhase`] instead, and
//! `Active` is claimable only when all three of §8.3's checks pass:
//!
//! 1. every NRPT rule we installed is **present in the registry**,
//!    re-read rather than remembered;
//! 2. the canary hostname resolves to the proxy address and not to its
//!    real one;
//! 3. a TCP connect to that proxy address succeeds.
//!
//! Anything less is `Partial` with a `detail` naming the failure.
//! `Unknown` is its own state and is never folded into `Off`.
//!
//! # Why the state is a process-global
//!
//! It sits behind a `Mutex` here rather than inside `Engines`, for two
//! reasons. Everything that must sweep it -- service start, service
//! stop, uninstall, the idle watchdog -- reaches it without an
//! `Engines` value in hand, and gaming mode owns nothing `Engines`
//! owns: no engine process, no adapter, no route. The precedent is
//! `split_tunnel::running_without_the_lock`.
//!
//! **Lock order, and it matters:** the `Engines` lock is always taken
//! *before* this one, and nothing in this module ever takes the
//! `Engines` lock. That is what makes the mutual exclusion in
//! `pipe::dispatch` -- refuse to arm while a tunnel is up, refuse to
//! connect while gaming is armed -- a decision rather than a race.

pub mod dns_message;
pub mod stub;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use neoconnect_ipc::{GamingConfig, GamingPhase};

use crate::engines::dns;
use stub::{Stub, STUB_ADDR, STUB_PORT};

/// How long the canary lookup and the proxy connect may take.
///
/// Both run inside a status request, which the app polls. A check that
/// hangs would make the status surface itself the slow thing, and a
/// status nobody gets is worse than a `partial` nobody likes.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Whether gaming mode is armed, readable without taking the mutex.
///
/// For the one caller that must not block on it: the mutual-exclusion
/// check on the connect path, and the idle watchdog's cheap "is there
/// anything to tear down". A shadow of `SESSION.is_some()`, written at
/// the two places that set and clear it and nowhere else.
static ARMED: AtomicBool = AtomicBool::new(false);

/// What, if anything, is holding [`SESSION`] right now.
///
/// Read only by [`status`], and only when it could not take the mutex.
/// Without it the answer to "why can I not read the state" would have
/// to be guessed, and the two possible reasons are opposite: rules
/// going *up* is `arming`, rules coming *down* is not -- reporting an
/// arm while a teardown runs would put the mode's own switch out of
/// step with what the machine is doing.
static IN_FLIGHT: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(IDLE);
const IDLE: u8 = 0;
const ARMING: u8 = 1;
const DISARMING: u8 = 2;

/// Sets [`IN_FLIGHT`] for as long as it is alive, and clears it however
/// the operation ends -- including by panic, which is the point of it
/// being a guard rather than two assignments.
struct InFlight;

impl InFlight {
    fn arming() -> Self {
        IN_FLIGHT.store(ARMING, Ordering::SeqCst);
        Self
    }

    fn disarming() -> Self {
        IN_FLIGHT.store(DISARMING, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.store(IDLE, Ordering::SeqCst);
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

struct Session {
    config: GamingConfig,
    /// The suffixes as actually installed (`.battle.net`), which is
    /// what verify-present compares against and what the app is shown
    /// -- not what was asked for.
    installed: Vec<String>,
    stub: Option<Stub>,
}

/// One answer to "what is gaming mode doing", with the evidence.
#[derive(Debug, Clone)]
pub struct Report {
    pub state: GamingPhase,
    pub detail: Option<String>,
    pub rules_present: bool,
    pub canary_ok: bool,
    pub proxy_reachable: bool,
    pub namespaces: Vec<String>,
}

impl Report {
    fn off() -> Self {
        Self {
            state: GamingPhase::Off,
            detail: None,
            rules_present: false,
            canary_ok: false,
            proxy_reachable: false,
            namespaces: Vec::new(),
        }
    }

    /// The service could not answer. Deliberately not `off`: "we do not
    /// know" and "nothing is installed" are opposite facts, and telling
    /// a customer their rules are gone when they may not be is the
    /// worse of the two errors -- they would stop looking for the rule
    /// that is still pointing their DNS somewhere.
    fn unknown(detail: impl Into<String>) -> Self {
        Self {
            state: GamingPhase::Unknown,
            detail: Some(detail.into()),
            rules_present: false,
            canary_ok: false,
            proxy_reachable: false,
            namespaces: Vec::new(),
        }
    }
}

/// Whether gaming mode is armed right now.
pub fn is_armed() -> bool {
    ARMED.load(Ordering::SeqCst)
}

/// Turns gaming mode on and reports honestly on what it managed.
///
/// The caller is responsible for the half of mutual exclusion this
/// module cannot see -- that no tunnel is up. See `pipe::dispatch`.
///
/// Ordering: the stub binds **before** the rules are installed. The
/// reverse order opens a window in which every lookup for the game's
/// hostnames is pointed at a port nothing is listening on, and a bind
/// failure would leave rules behind for a stub that never existed.
pub fn arm(config: GamingConfig) -> Result<Report, String> {
    config.validate().map_err(|e| e.to_string())?;

    let _in_flight = InFlight::arming();
    // Held for the whole operation, not taken twice. Two arms racing
    // would otherwise both bind the stub -- one of them failing on the
    // one port NRPT can name -- and a status poll landing in the middle
    // would read a session that is half built. While it is held,
    // `status` reports `arming` rather than blocking; see there.
    let mut session = SESSION.lock().map_err(|_| poisoned())?;

    // Anything from a previous session goes first, rules and stub both.
    // Re-arming with a different game profile is an ordinary action and
    // must not stack rules or leave the old stub holding port 53.
    disarm_locked(&mut session);

    let bind = SocketAddr::from((STUB_ADDR, STUB_PORT));
    let stub = Stub::start(
        bind,
        &config.doh_url,
        &config.namespaces,
        &config.exclude_hostnames,
    )?;

    let installed = match dns::apply_gaming(&config.namespaces, &STUB_ADDR.to_string()) {
        Ok(installed) => installed,
        Err(err) => {
            // The stub has to come down with them. A listener on
            // 127.0.0.53:53 with no rule pointing at it is invisible
            // and harmless, but leaving it there means the next arm
            // cannot bind -- on the one port NRPT can name.
            stub.stop();
            dns::clear_gaming();
            return Err(err);
        }
    };
    // Answers Windows cached before the rules existed would fail the
    // canary for a reason that has nothing to do with the rules.
    dns::flush_cache();

    let built = Session {
        config,
        installed,
        stub: Some(stub),
    };
    let report = assess(&built);
    *session = Some(built);
    ARMED.store(true, Ordering::SeqCst);
    Ok(report)
}

/// Turns gaming mode off. Safe when nothing is armed.
///
/// Never returns an error for "there was nothing to do": every caller
/// is a cleanup path, and a cleanup that reports failure for a clean
/// machine trains the next person to ignore it.
pub fn disarm() -> Result<(), String> {
    let _in_flight = InFlight::disarming();
    let mut session = SESSION.lock().map_err(|_| poisoned())?;
    disarm_locked(&mut session);
    Ok(())
}

/// The teardown itself. Rules first, then the stub.
///
/// That order, and not the other, for the same reason the connect path
/// removes routes before killing an engine: while the rules are up, a
/// lookup that arrives has somewhere to go. Removing the stub first
/// would leave a window in which every game hostname is pointed at a
/// dead port -- which is not a refusal the resolver can report, it is
/// a timeout.
fn disarm_locked(session: &mut Option<Session>) {
    // Unconditional, exactly like `dns::clear` on the disconnect path,
    // and for the same reason: nothing tracked is not the same as
    // nothing installed. A service that was killed mid-session comes
    // back with `SESSION` empty and the customer's rules still in the
    // registry, and that state is precisely what this has to be able to
    // fix.
    dns::clear_gaming();
    ARMED.store(false, Ordering::SeqCst);
    if let Some(session) = session.take() {
        if let Some(stub) = session.stub {
            stub.stop();
        }
    }
}

/// Removes anything a previous life of this process left behind.
///
/// Called at service start, at service stop and at uninstall. There is
/// no session to end at start -- by definition nothing has asked for
/// anything yet -- so what this is really for is the registry: a
/// stranded NRPT rule points the game's lookups, and on the `.` rule
/// the whole machine's, at a stub that is not there. That is the
/// network-corruption complaint class already on record, and the
/// start-up sweep is the defence (§14 instrument #7).
///
/// Deliberately does **not** take the mutex or stop a stub, which is
/// why it is safe to call at any of those points and why none of them
/// need one: at service start nothing has been armed yet, at uninstall
/// this runs in the installer's own process where there is no stub to
/// find, and service stop calls [`disarm`] -- which does both -- rather
/// than this.
pub fn sweep_leftovers() {
    dns::clear_gaming();
    ARMED.store(false, Ordering::SeqCst);
}

/// The three checks, run now.
///
/// Answers `Unknown` rather than `Off` when the state cannot be read,
/// and never claims `Active` on remembered evidence.
pub fn status() -> Report {
    // `try_lock`, never `lock`. The only thing that holds this mutex
    // for any length of time is an arm or a disarm in progress, and a
    // status poll that queued behind one would be the same failure this
    // service's `Status` request already had to be rescued from: an
    // operation that does not return taking every later request with
    // it. `Arming` is not a fallback here, it is the accurate answer --
    // rules are being installed right now.
    match SESSION.try_lock() {
        Ok(session) => match session.as_ref() {
            None => Report::off(),
            Some(session) => assess(session),
        },
        Err(std::sync::TryLockError::WouldBlock) => match IN_FLIGHT.load(Ordering::SeqCst) {
            ARMING => Report {
                state: GamingPhase::Arming,
                detail: Some("Gaming mode is being set up.".to_string()),
                rules_present: false,
                canary_ok: false,
                proxy_reachable: false,
                namespaces: Vec::new(),
            },
            // A teardown in progress. Not `off` -- the rules may still
            // be in the registry for another moment -- and not
            // `arming`, which would show the switch moving the wrong
            // way. "Cannot tell right now, and here is why" is the
            // truth, and it resolves itself on the next poll.
            DISARMING => Report::unknown("Gaming mode is being turned off."),
            // The mutex is held by something that set no phase, which
            // is a bug rather than a state. Saying so beats guessing.
            _ => Report::unknown("Gaming mode's state is being changed."),
        },
        Err(std::sync::TryLockError::Poisoned(_)) => {
            Report::unknown("The background service could not read gaming mode's state.")
        }
    }
}

fn poisoned() -> String {
    "Gaming mode's state could not be read; restart the Neoxify service.".to_string()
}

/// Runs all three checks and decides what may be claimed.
///
/// Every check is run even when an earlier one has already failed. The
/// customer is shown which one broke, and stopping at the first would
/// mean a rules problem hid a resolver problem sitting behind it --
/// they would fix one thing, see the same warning, and have nothing new
/// to go on.
fn assess(session: &Session) -> Report {
    let mut failures: Vec<String> = Vec::new();

    // 1. Rules present. Re-read from the registry.
    let rules_present = match dns::gaming_rules_missing(&session.installed) {
        Ok(missing) if missing.is_empty() => true,
        Ok(missing) => {
            failures.push(format!(
                "the DNS rules for {} are not installed",
                missing.join(", ")
            ));
            false
        }
        Err(err) => {
            failures.push(format!("the DNS rules could not be checked ({err})"));
            false
        }
    };

    // 2. The canary.
    let (canary_ok, canary_failure) = check_canary(session);
    if let Some(why) = canary_failure {
        failures.push(why);
    }

    // 3. The proxy answers.
    let proxy_reachable = match stub::proxy_reachable(
        &session.config.proxy_ip,
        session.config.proxy_port,
        CHECK_TIMEOUT,
    ) {
        Ok(()) => true,
        Err(err) => {
            failures.push(format!("the game proxy is not answering ({err})"));
            false
        }
    };

    // Whatever the stub itself has been unable to do, carried into the
    // same sentence: a DoH endpoint that stopped answering is the
    // failure §14 instrument #6 exists to make sure we report rather
    // than paper over.
    if let Some(session_stub) = &session.stub {
        if let Some(err) = session_stub.policy.last_error() {
            let (_, _, failed) = session_stub.policy.counters();
            failures.push(format!("{failed} lookup(s) could not be resolved ({err})"));
        }
    }

    let state = if rules_present && canary_ok && proxy_reachable {
        GamingPhase::Active
    } else {
        GamingPhase::Partial
    };
    Report {
        state,
        detail: (!failures.is_empty()).then(|| failures.join("; ")),
        rules_present,
        canary_ok,
        proxy_reachable,
        namespaces: session.installed.clone(),
    }
}

/// Check 2: does the canary hostname come back as the proxy?
///
/// **Resolved through Windows** -- `std::net::ToSocketAddrs`, which is
/// `getaddrinfo` -- and deliberately not by querying the stub directly.
///
/// The stub-direct version would be easier and would work in a test
/// without administrator, but it cannot fail in the way this check
/// exists to catch. Asking our own stub proves our own stub answers
/// correctly, which we already know from its unit tests. What is
/// actually in doubt is everything *between* an application and the
/// stub: whether the NRPT rule is being honoured at all, whether
/// Windows' smart multi-homed resolution handed the name to the ISP
/// resolver first, and whether Windows' own DoH auto-upgrade took the
/// lookup somewhere else entirely (design §4.2.3, which is unmeasured
/// and is instrument #9). Going through `getaddrinfo` is the only way
/// this check can come back negative for any of those -- and a check
/// that cannot come back negative is the false pass this project keeps
/// finding.
///
/// IPv4 only, for the reason every exit-IP assertion here is: the nodes
/// have IPv6, `proxyIp` is an IPv4 address by validation, and a v6
/// answer counted as "not the proxy" would fake a total failure.
///
/// `getaddrinfo` has no timeout, so it runs on its own thread and the
/// wait is bounded here. A thread left behind on a lookup that never
/// returns is a leaked thread, not a wedged status poll.
fn check_canary(session: &Session) -> (bool, Option<String>) {
    let Some(canary) = session.config.canary_hostname.clone() else {
        // No canary configured means the check cannot be run, and a
        // check that was not run is not a check that passed.
        return (
            false,
            Some("no canary hostname was configured, so the redirect is unconfirmed".to_string()),
        );
    };
    let Ok(expected) = session.config.proxy_ip.parse::<Ipv4Addr>() else {
        return (false, Some("the proxy address is not an IPv4 address".to_string()));
    };

    let (tx, rx) = std::sync::mpsc::channel();
    let lookup = canary.clone();
    std::thread::spawn(move || {
        use std::net::ToSocketAddrs;
        // Port 0: irrelevant to the answer, and only there because
        // `ToSocketAddrs` resolves endpoints rather than names.
        let resolved = (lookup.as_str(), 0u16).to_socket_addrs().map(|addrs| {
            addrs
                .filter_map(|a| match a.ip() {
                    std::net::IpAddr::V4(v4) => Some(v4),
                    std::net::IpAddr::V6(_) => None,
                })
                .collect::<Vec<_>>()
        });
        let _ = tx.send(resolved);
    });

    match rx.recv_timeout(CHECK_TIMEOUT) {
        Ok(Ok(addresses)) if addresses.contains(&expected) => (true, None),
        Ok(Ok(addresses)) if addresses.is_empty() => (
            false,
            Some(format!("{canary} did not resolve to any IPv4 address")),
        ),
        Ok(Ok(addresses)) => (
            false,
            Some(format!(
                "{canary} resolved to {} instead of {expected} -- something else on this machine is answering it",
                addresses
                    .iter()
                    .map(|a| a.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        ),
        Ok(Err(err)) => (false, Some(format!("{canary} could not be resolved ({err})"))),
        Err(_) => (
            false,
            Some(format!("{canary} did not resolve within {CHECK_TIMEOUT:?}")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Unknown` must never be reachable by accident from the same
    /// shape as `Off`, and `Off` must claim nothing.
    #[test]
    fn off_and_unknown_are_different_answers() {
        let off = Report::off();
        assert_eq!(off.state, GamingPhase::Off);
        assert!(off.detail.is_none());
        assert!(!off.rules_present && !off.canary_ok && !off.proxy_reachable);

        let unknown = Report::unknown("the service did not answer");
        assert_eq!(unknown.state, GamingPhase::Unknown);
        assert_ne!(unknown.state, GamingPhase::Off);
        assert!(unknown.detail.is_some());
    }

    /// Nothing armed reports `off`, and reports it without touching the
    /// machine.
    #[test]
    fn status_with_nothing_armed_is_off() {
        assert!(!is_armed());
        assert_eq!(status().state, GamingPhase::Off);
    }

    /// A config the validator refuses must never reach the point where
    /// a rule is installed or a socket is bound.
    #[test]
    fn arming_with_a_root_namespace_is_refused_before_anything_is_installed() {
        let config = GamingConfig {
            doh_url: "https://fi1.neoxify.site/dns-query".into(),
            proxy_ip: "172.236.143.200".into(),
            proxy_port: 443,
            namespaces: vec![".".into()],
            exclude_hostnames: Vec::new(),
            canary_hostname: None,
        };
        let err = arm(config).unwrap_err();
        assert!(err.contains("every name on the machine"), "{err}");
        assert!(!is_armed());
    }

    /// A profile with no canary cannot be `active`. Saying so is the
    /// point: a check that was not run is not a check that passed.
    #[test]
    fn a_missing_canary_is_a_failed_check_not_a_skipped_one() {
        let session = Session {
            config: GamingConfig {
                doh_url: "https://fi1.neoxify.site/dns-query".into(),
                proxy_ip: "172.236.143.200".into(),
                proxy_port: 443,
                namespaces: vec!["blizzard.com".into()],
                exclude_hostnames: Vec::new(),
                canary_hostname: None,
            },
            installed: vec![".blizzard.com".into()],
            stub: None,
        };
        let (ok, why) = check_canary(&session);
        assert!(!ok);
        assert!(why.unwrap().contains("unconfirmed"));
    }
}
