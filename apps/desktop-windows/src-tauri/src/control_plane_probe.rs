//! Where a failed control-plane request failed: DNS, TCP or TLS.
//!
//! The app's API requests go through tauri-plugin-http, whose errors
//! reach JavaScript as reqwest's Display string -- "error sending request
//! for url (...)" -- with the cause dropped. So a refresh that could not
//! reach the control plane could say which addresses it tried and that
//! each one failed (endpoint-trace.ts), but not how: a poisoned DNS
//! answer, a blackholed IP and an SNI-filtered handshake all read the
//! same. Those three call for completely different responses -- new
//! names, new addresses, a new front -- so this goes back and asks, one
//! stage at a time, after a request has already failed.
//!
//! What it sends is what the failed request already sent to the same
//! addresses: a lookup, a TCP handshake, a TLS ClientHello with the same
//! name. No HTTP request, nothing a censor did not see a moment earlier.
//! What it returns is a class and a duration per address. Never the
//! resolved addresses, never an error string: the one fact taken from an
//! answer is whether it points into Iran's DNS block page. And none of it
//! once a connect has started: the app cancels the probe then, and it
//! begins no further step (`cancel_control_plane_probe`).
//!
//! One file, compiled into both the Windows and the mobile app (the
//! mobile crate includes it by path, as its UI includes the Windows
//! app's through the `@shared` alias), so the two cannot classify the
//! same failure differently.

use std::io;
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};

#[derive(serde::Deserialize, Debug, Clone)]
pub struct ProbeTarget {
    pub host: String,
    pub port: u16,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ProbeResult {
    /// One of: "ok", "dns", "dns-timeout", "blockpage", "tcp",
    /// "tcp-timeout", "tls", "tls-timeout", "cert". The first stage that
    /// failed, or "ok" if a TLS handshake completed. "error" if the probe
    /// itself crashed -- a fault here, saying nothing about the network.
    /// "cancelled" if a connect started first (`cancel_control_plane_probe`),
    /// which says nothing about the network either.
    /// "proxy" if the app's requests to the name go through a proxy
    /// (`http_proxied` in health_ip.rs), and nothing was probed: the stages
    /// the probe would measure are not the ones the request took.
    pub outcome: &'static str,
    /// From the start of the lookup to the verdict.
    pub ms: u32,
}

/// How long each stage may take. Per stage rather than overall, so a slow
/// lookup cannot use up the time that would have told a blackholed
/// address from a reset handshake.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub dns: Duration,
    pub tcp: Duration,
    pub tls: Duration,
}

/// Long enough for a working path from Iran, where a handshake to a
/// distant CDN edge can take a second or two; short enough that the
/// report it feeds goes out within a quarter of a minute.
const LIMITS: Limits = Limits {
    dns: Duration::from_secs(4),
    tcp: Duration::from_secs(4),
    tls: Duration::from_secs(4),
};

/// More than the endpoint list holds today, and a bound on how many
/// sockets one failed refresh can open.
pub const MAX_TARGETS: usize = 16;

/// Whether a probe should stop. Asked before each step that would send
/// something new.
pub type Cancelled = Arc<dyn Fn() -> bool + Send + Sync>;

/// Bumped by `cancel_control_plane_probe`. A probe remembers the value it
/// started under and stops once it has moved.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Cancelled by any `cancel_control_plane_probe` after this call.
fn cancelled_from_now() -> Cancelled {
    let started = GENERATION.load(Ordering::SeqCst);
    Arc::new(move || GENERATION.load(Ordering::SeqCst) != started)
}

#[tauri::command]
pub async fn probe_control_plane(targets: Vec<ProbeTarget>) -> Vec<ProbeResult> {
    let cancelled = cancelled_from_now();
    // Blocking sockets on blocking threads, as the latency probes do:
    // neither app has an async runtime of its own to spare, and a stage
    // that hangs to its limit must not hold Tauri's.
    tauri::async_runtime::spawn_blocking(move || {
        probe_unless_proxied(targets, LIMITS, cancelled, &crate::health_ip::http_proxied)
    })
    .await
    .unwrap_or_default()
}

/// A connect is starting (`connectStarting` in control-plane-probe.ts):
/// every probe running stops before its next step.
///
/// The app has stopped waiting for the answer by then -- a path a connect
/// is replacing is not the network's -- so this is about traffic: the
/// probe begins no new lookup, TCP handshake or ClientHello alongside the
/// connect's. A step already under way runs to its end (a lookup in
/// the system resolver, a SYN the OS is still retrying, a ClientHello
/// already sent and waiting for an answer); none is started.
#[tauri::command]
pub fn cancel_control_plane_probe() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// `probe_all`, for the targets whose requests go where this machine's
/// resolver sends them. A target the app reaches through a proxy is
/// answered "proxy" and not probed.
///
/// The probe repeats the failed request's lookup, TCP handshake and
/// ClientHello from this machine. Through a proxy the request made none of
/// them: the proxy resolved the name and connected at its own end. A
/// lookup here that found Iran's block page was filed as the name's on
/// this network (`demoteName` in control-plane-probe.ts), and every race
/// after it held back a name the proxy reached -- the same mistake the
/// race's own look made (`http_proxied` in health_ip.rs). Nothing is sent
/// for such a target, and the report says a proxy was in the way, which
/// is itself worth knowing about a request that failed.
pub fn probe_unless_proxied(
    targets: Vec<ProbeTarget>,
    limits: Limits,
    cancelled: Cancelled,
    proxied: &dyn Fn(&str) -> bool,
) -> Vec<ProbeResult> {
    let targets: Vec<ProbeTarget> = targets.into_iter().take(MAX_TARGETS).collect();
    let through_proxy: Vec<bool> = targets.iter().map(|target| proxied(&target.host)).collect();
    let direct: Vec<ProbeTarget> = targets
        .into_iter()
        .zip(&through_proxy)
        .filter(|(_, &through)| !through)
        .map(|(target, _)| target)
        .collect();
    let mut probed = probe_all(direct, limits, cancelled).into_iter();
    through_proxy
        .into_iter()
        .map(|through| {
            if through {
                ProbeResult { outcome: "proxy", ms: 0 }
            } else {
                probed.next().unwrap_or(ProbeResult { outcome: "error", ms: 0 })
            }
        })
        .collect()
}

/// Probes every target at once, and answers in the order asked.
pub fn probe_all(targets: Vec<ProbeTarget>, limits: Limits, cancelled: Cancelled) -> Vec<ProbeResult> {
    let config = &shared_tls_config();
    let handles: Vec<_> = targets
        .into_iter()
        .take(MAX_TARGETS)
        .map(|target| {
            let config = Arc::clone(config);
            let cancelled = Arc::clone(&cancelled);
            std::thread::spawn(move || probe_one(&target.host, target.port, &config, limits, &*cancelled))
        })
        .collect();
    handles
        .into_iter()
        .map(|handle| {
            handle.join().unwrap_or(ProbeResult {
                outcome: "error",
                ms: 0,
            })
        })
        .collect()
}

/// `tls_config`, built once per process: it copies every root
/// certificate. Also what the Windows egress check's public-internet
/// probe verifies against (`vpn::probe_ipv4_egress`).
pub fn shared_tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    Arc::clone(CONFIG.get_or_init(|| Arc::new(tls_config())))
}

/// The certificates the app's own requests trust: tauri-plugin-http's
/// reqwest is built with webpki-roots, so a certificate this refuses is
/// one the failed request refused too.
fn tls_config() -> ClientConfig {
    let roots: RootCertStore = webpki_roots::TLS_SERVER_ROOTS.iter().cloned().collect();
    // An explicit provider rather than the process default, which panics
    // when none has been installed.
    ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports rustls's default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

pub fn probe_one(
    host: &str,
    port: u16,
    config: &Arc<ClientConfig>,
    limits: Limits,
    cancelled: &dyn Fn() -> bool,
) -> ProbeResult {
    let started = Instant::now();
    let verdict = |outcome: &'static str| ProbeResult {
        outcome,
        ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
    };

    if cancelled() {
        return verdict("cancelled");
    }
    let addrs = match resolve(host, port, limits.dns) {
        Resolved::Addrs(addrs) => addrs,
        Resolved::Failed => return verdict("dns"),
        Resolved::TimedOut => return verdict("dns-timeout"),
    };
    // Checked before connecting: the block page answers TCP, and a
    // handshake with it would be read as a TLS failure of ours.
    if addrs.iter().any(|addr| is_block_page(addr.ip())) {
        return verdict("blockpage");
    }

    if cancelled() {
        return verdict("cancelled");
    }
    let stream = match connect(&addrs, limits.tcp, cancelled) {
        Ok(stream) => stream,
        // First: a connect that stopped early stopped for this.
        Err(_) if cancelled() => return verdict("cancelled"),
        Err(err) if is_timeout(&err) => return verdict("tcp-timeout"),
        Err(_) => return verdict("tcp"),
    };

    // Dropping the stream closes it; no ClientHello goes out.
    if cancelled() {
        return verdict("cancelled");
    }
    match handshake(stream, host, config, limits.tls) {
        Ok(()) => verdict("ok"),
        Err(outcome) => verdict(outcome),
    }
}

enum Resolved {
    Addrs(Vec<SocketAddr>),
    Failed,
    TimedOut,
}

/// The system resolver, which is what the failed request used, with a
/// deadline it does not have of its own. A lookup still running at the
/// deadline is abandoned on its thread; its answer goes nowhere.
fn resolve(host: &str, port: u16, limit: Duration) -> Resolved {
    let (tx, rx) = mpsc::channel();
    let host = host.to_owned();
    std::thread::spawn(move || {
        let _ = tx.send((host.as_str(), port).to_socket_addrs().map(|it| it.collect::<Vec<_>>()));
    });
    match rx.recv_timeout(limit) {
        Ok(Ok(addrs)) if !addrs.is_empty() => Resolved::Addrs(addrs),
        Ok(_) => Resolved::Failed,
        Err(mpsc::RecvTimeoutError::Timeout) => Resolved::TimedOut,
        Err(mpsc::RecvTimeoutError::Disconnected) => Resolved::Failed,
    }
}

/// Iran's DNS block page, as `isKnownBlockPage` in
/// endpoint-bundle-store.ts has it: the /24, because more than one
/// address in it has been seen for different names on one network.
/// Also as an IPv4-mapped IPv6 address, which some resolvers and
/// NAT64 setups hand back for the same answer.
pub fn is_block_page(ip: IpAddr) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return false,
        },
    };
    let [a, b, c, _] = v4.octets();
    (a, b, c) == (10, 10, 34)
}

/// IPv4 first, then IPv6, sharing one deadline. A device with IPv6
/// addressing and no IPv6 route fails an IPv6 connect at once, and
/// trying it first would report a reachable server as "tcp". The verdict
/// on failure is the first address's: that is the one the request would
/// have used.
fn connect(addrs: &[SocketAddr], limit: Duration, cancelled: &dyn Fn() -> bool) -> io::Result<TcpStream> {
    let mut ordered: Vec<&SocketAddr> = addrs.iter().filter(|a| a.is_ipv4()).collect();
    ordered.extend(addrs.iter().filter(|a| a.is_ipv6()));
    let deadline = Instant::now() + limit;
    let mut first_error: Option<io::Error> = None;
    for addr in ordered {
        let remaining = deadline.saturating_duration_since(Instant::now());
        // Each further address is a new handshake.
        if remaining.is_zero() || cancelled() {
            break;
        }
        match TcpStream::connect_timeout(addr, remaining) {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                first_error.get_or_insert(err);
            }
        }
    }
    Err(first_error.unwrap_or_else(|| io::Error::from(io::ErrorKind::TimedOut)))
}

/// A blocking socket that hits its read timeout says WouldBlock on Unix
/// and TimedOut on Windows; both are "it did not answer in time".
fn is_timeout(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
}

/// A TLS handshake to `host` -- the same name the request presents, so an
/// SNI filter sees exactly what it saw then. Nothing is sent after it.
///
/// `Ok` only once the server's certificate has verified for `host`, which
/// nothing on this machine can produce: also why the egress check's
/// public-internet probe uses it (`vpn::probe_ipv4_egress`).
pub fn handshake(
    mut stream: TcpStream,
    host: &str,
    config: &Arc<ClientConfig>,
    limit: Duration,
) -> Result<(), &'static str> {
    let name = ServerName::try_from(host.to_owned()).map_err(|_| "tls")?;
    let mut conn = ClientConnection::new(Arc::clone(config), name).map_err(|_| "tls")?;
    let deadline = Instant::now() + limit;
    while conn.is_handshaking() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("tls-timeout");
        }
        let _ = stream.set_read_timeout(Some(remaining));
        let _ = stream.set_write_timeout(Some(remaining));
        conn.complete_io(&mut stream).map_err(|err| classify_tls_error(&err))?;
    }
    conn.send_close_notify();
    let _ = conn.complete_io(&mut stream);
    Ok(())
}

/// What a failed handshake says about the path.
///
/// A certificate that does not verify is kept apart from every other
/// failure: the handshake *completed* at the network level, so nothing
/// on the path dropped it -- something answered for the name with a
/// certificate that is not ours. Everything else (a reset, a close, an
/// alert) is "tls", which on these networks is usually SNI filtering.
pub fn classify_tls_error(err: &io::Error) -> &'static str {
    if is_timeout(err) {
        return "tls-timeout";
    }
    let rustls_error = err.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>());
    match rustls_error {
        Some(rustls::Error::InvalidCertificate(_)) => "cert",
        _ => "tls",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};

    /// Short, so a test that waits for a limit does not wait long.
    const FAST: Limits = Limits {
        dns: Duration::from_secs(5),
        tcp: Duration::from_secs(5),
        tls: Duration::from_millis(400),
    };

    fn config() -> Arc<ClientConfig> {
        Arc::new(tls_config())
    }

    #[test]
    fn block_page_is_the_slash_24_and_nothing_else() {
        assert!(is_block_page(IpAddr::V4(Ipv4Addr::new(10, 10, 34, 34))));
        assert!(is_block_page(IpAddr::V4(Ipv4Addr::new(10, 10, 34, 35))));
        assert!(!is_block_page(IpAddr::V4(Ipv4Addr::new(10, 10, 35, 34))));
        assert!(!is_block_page(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_block_page(IpAddr::V6(Ipv4Addr::new(10, 10, 34, 34).to_ipv6_mapped())));
        assert!(!is_block_page(IpAddr::V6(Ipv4Addr::new(10, 10, 35, 34).to_ipv6_mapped())));
    }

    /// An address literal resolves without a lookup, so this exercises
    /// the check in place without needing the block page to answer.
    #[test]
    fn an_answer_in_the_block_page_is_reported_as_such_without_connecting() {
        let result = probe_one("10.10.34.34", 443, &config(), FAST, &|| false);
        assert_eq!(result.outcome, "blockpage");
    }

    /// RFC 6761 reserves .invalid: it never resolves.
    #[test]
    fn a_name_that_does_not_resolve_fails_at_dns() {
        let result = probe_one("neoxify-probe-test.invalid", 443, &config(), FAST, &|| false);
        assert!(result.outcome.starts_with("dns"), "{result:?}");
    }

    /// A port nothing listens on. Asserted by stage, not exact outcome:
    /// how fast a refused loopback connect fails differs between Windows
    /// editions, and what matters is that it is a TCP failure.
    #[test]
    fn a_refused_connection_fails_at_tcp() {
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let result = probe_one("127.0.0.1", port, &config(), FAST, &|| false);
        assert!(result.outcome.starts_with("tcp"), "{result:?}");
    }

    /// TCP completes and the far end hangs up on the ClientHello -- the
    /// shape of an SNI filter that resets.
    #[test]
    fn a_handshake_cut_off_fails_at_tls() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });
        let result = probe_one("localhost", port, &config(), FAST, &|| false);
        server.join().unwrap();
        assert_eq!(result.outcome, "tls", "{result:?}");
    }

    /// TCP completes and nothing ever answers the ClientHello -- the
    /// shape of an SNI filter that blackholes.
    #[test]
    fn a_handshake_nobody_answers_times_out_at_tls() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1_500));
            drop(stream);
        });
        let result = probe_one("localhost", port, &config(), FAST, &|| false);
        server.join().unwrap();
        assert_eq!(result.outcome, "tls-timeout", "{result:?}");
        assert!(result.ms >= 300, "{result:?}");
    }

    #[test]
    fn a_certificate_that_does_not_verify_is_not_a_network_failure() {
        let cert = io::Error::new(
            io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        );
        assert_eq!(classify_tls_error(&cert), "cert");
        let alert = io::Error::new(
            io::ErrorKind::InvalidData,
            rustls::Error::AlertReceived(rustls::AlertDescription::HandshakeFailure),
        );
        assert_eq!(classify_tls_error(&alert), "tls");
        assert_eq!(classify_tls_error(&io::Error::from(io::ErrorKind::ConnectionReset)), "tls");
        assert_eq!(classify_tls_error(&io::Error::from(io::ErrorKind::TimedOut)), "tls-timeout");
        assert_eq!(classify_tls_error(&io::Error::from(io::ErrorKind::WouldBlock)), "tls-timeout");
    }

    /// Against real servers, by hand:
    ///
    /// ```text
    /// NEOXIFY_PROBE_LIVE=host:port,host:port \
    ///   cargo test -p neoconnect-desktop --lib live_probe -- --ignored --nocapture
    /// ```
    ///
    /// Ignored because its answer depends on the network it runs on. The
    /// names come from the environment so that none is committed
    /// (docs/node-address-hygiene.md).
    #[test]
    #[ignore]
    fn live_probe() {
        let targets: Vec<ProbeTarget> = std::env::var("NEOXIFY_PROBE_LIVE")
            .unwrap_or_default()
            .split(',')
            .filter_map(|t| {
                let (host, port) = t.trim().rsplit_once(':')?;
                Some(ProbeTarget {
                    host: host.to_owned(),
                    port: port.parse().ok()?,
                })
            })
            .collect();
        assert!(!targets.is_empty(), "set NEOXIFY_PROBE_LIVE=host:port,...");
        for (target, result) in targets.iter().zip(probe_all(targets.clone(), LIMITS, Arc::new(|| false))) {
            println!("{}:{} -> {} in {}ms", target.host, target.port, result.outcome, result.ms);
        }
    }

    /// Answers line up with questions, and there is a ceiling on how many
    /// sockets one call can open.
    #[test]
    fn answers_in_order_and_caps_the_count() {
        let targets: Vec<ProbeTarget> = (0..MAX_TARGETS + 4)
            .map(|i| ProbeTarget {
                host: if i % 2 == 0 { "10.10.34.1".into() } else { "neoxify-probe-test.invalid".into() },
                port: 443,
            })
            .collect();
        let results = probe_all(targets, FAST, Arc::new(|| false));
        assert_eq!(results.len(), MAX_TARGETS);
        for (i, result) in results.iter().enumerate() {
            if i % 2 == 0 {
                assert_eq!(result.outcome, "blockpage");
            } else {
                assert!(result.outcome.starts_with("dns"), "{result:?}");
            }
        }
    }

    /// A target the app's requests reach through a proxy is not probed:
    /// nothing connects to it, and it is never "blockpage", whatever this
    /// machine's resolver says. The others are probed as before, and the
    /// answers still line up with the questions.
    #[test]
    fn a_target_reached_through_a_proxy_is_not_probed() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = |host: &str, port: u16| ProbeTarget { host: host.into(), port };
        let targets = vec![
            target("127.0.0.1", port),
            target("10.10.34.34", 443),
            target("10.10.34.35", 443),
        ];
        let proxied = |host: &str| host != "10.10.34.35";
        let results = probe_unless_proxied(targets, FAST, Arc::new(|| false), &proxied);
        assert_eq!(results.iter().map(|r| r.outcome).collect::<Vec<_>>(), ["proxy", "proxy", "blockpage"]);
        assert_eq!(listener.accept().map(|_| ()).unwrap_err().kind(), io::ErrorKind::WouldBlock);

        // With no proxy, the same targets are probed.
        let targets = vec![target("10.10.34.34", 443), target("10.10.34.35", 443)];
        let results = probe_unless_proxied(targets, FAST, Arc::new(|| false), &|_| false);
        assert_eq!(results.iter().map(|r| r.outcome).collect::<Vec<_>>(), ["blockpage", "blockpage"]);
    }

    /// The app's cancel reaches a probe begun before it, and not one
    /// begun after.
    #[test]
    fn a_cancel_stops_the_probes_already_running_and_no_later_one() {
        let before = cancelled_from_now();
        assert!(!before());
        cancel_control_plane_probe();
        assert!(before());
        assert!(!cancelled_from_now()());
    }

    /// Cancelled before it starts: no lookup, no connection, for any
    /// target.
    #[test]
    fn a_probe_cancelled_before_it_starts_opens_nothing() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let targets = vec![
            ProbeTarget {
                host: "127.0.0.1".into(),
                port,
            },
            ProbeTarget {
                host: "neoxify-probe-test.invalid".into(),
                port: 443,
            },
        ];
        let results = probe_all(targets, FAST, Arc::new(|| true));
        assert_eq!(results.iter().map(|r| r.outcome).collect::<Vec<_>>(), ["cancelled", "cancelled"]);
        assert_eq!(listener.accept().map(|_| ()).unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }

    /// A connect that starts once the probe's TCP handshake is up stops it
    /// before the ClientHello: the server receives nothing.
    #[test]
    fn a_cancel_after_tcp_sends_no_client_hello() {
        use std::io::Read;
        use std::sync::Mutex;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted: Mutex<Option<TcpStream>> = Mutex::new(None);
        // Cancelled from the moment the probe's connection has arrived.
        // Waits a little for it at each check, so the answer does not
        // depend on how fast the loopback handshake lands.
        let cancelled = || {
            let mut slot = accepted.lock().unwrap();
            if slot.is_some() {
                return true;
            }
            let until = Instant::now() + Duration::from_millis(300);
            while Instant::now() < until {
                if let Ok((stream, _)) = listener.accept() {
                    *slot = Some(stream);
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        };

        let result = probe_one("127.0.0.1", port, &config(), FAST, &cancelled);
        assert_eq!(result.outcome, "cancelled", "{result:?}");

        let mut stream = accepted.lock().unwrap().take().expect("the TCP handshake completed");
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let mut buf = [0u8; 512];
        let read = stream.read(&mut buf);
        assert!(!matches!(read, Ok(n) if n > 0), "the probe sent data after it was cancelled: {read:?}");
    }
}
