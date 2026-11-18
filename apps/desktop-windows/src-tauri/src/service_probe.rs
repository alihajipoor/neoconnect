//! The service check's one request: `https://<host><path>`, step by step,
//! so each step is timed and a failure says which step it was
//! (docs/client-diagnostics.md, `details.services`).
//!
//! Resolve with the system resolver (inside the tunnel while it is up),
//! IPv4 answer first; connect to port 443; TLS with ordinary certificate
//! verification for the host; a minimal GET; read only the status line;
//! close. No redirect followed, no body kept, no cookie, no cache. "ok"
//! means a status line came back, whatever the status.
//!
//! Only a plain host name is accepted -- no scheme, port, address literal
//! or anything else -- and only a path that starts with "/". The targets
//! come from the server's fixed list; this refuses anything that could
//! make the probe a general-purpose fetch. Its error words are fixed
//! strings that name no host or address at all.
//!
//! Under the phones' engine and under Xray on Windows the TCP connect is
//! answered on the device, so `connectMs` says little there; it is
//! reported anyway.
//!
//! One file, compiled into both the Windows and the mobile app (the mobile
//! crate includes it by path, as it does control_plane_probe.rs, whose
//! TLS configuration -- webpki-roots through rustls, the same roots the
//! app's own requests trust -- this shares).

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection};

/// One target's result, in the wire shape of `details.services[]` less
/// the key and host, which the caller adds.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProbe {
    pub ok: bool,
    /// The step that failed, or "ok".
    pub stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls_ms: Option<u32>,
    /// From the request sent to the first byte of the answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_byte_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Where the name resolved to: the address connected to, or the one
    /// that would have been tried first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The whole probe's time, whatever the caller asks.
const MIN_BUDGET: Duration = Duration::from_millis(1_000);
const MAX_BUDGET: Duration = Duration::from_millis(30_000);

/// The server's bound on every duration.
const MS_MAX: u128 = 120_000;
/// The server's bound on `error`.
pub const ERROR_MAX: usize = 120;
pub const HOST_MAX: usize = 253;
pub const PATH_MAX: usize = 256;

#[tauri::command]
pub async fn probe_service(host: String, path: String, timeout_ms: u64) -> Result<ServiceProbe, String> {
    let host = plain_host(&host).ok_or_else(|| "not a plain host name".to_string())?;
    if !plain_path(&path) {
        return Err("not a plain path".into());
    }
    let budget = Duration::from_millis(timeout_ms).clamp(MIN_BUDGET, MAX_BUDGET);
    let config = crate::control_plane_probe::shared_tls_config();
    // Blocking sockets on a blocking thread, as the control-plane probe
    // does: a step that hangs to its limit must not hold Tauri's runtime.
    tauri::async_runtime::spawn_blocking(move || probe(&host, 443, &path, budget, &config))
        .await
        .map_err(|_| "the check stopped unexpectedly".to_string())
}

/// A host name and nothing else, lowercased: letters, digits and hyphens in
/// dot-separated labels, at least two of them, the last starting with a
/// letter (so never an IPv4 literal, in any of its spellings). A scheme, a
/// port, a path, user info, an IPv6 literal and a trailing dot are all
/// refused by the alphabet alone.
pub fn plain_host(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > HOST_MAX || !host.is_ascii() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let label_ok = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    if !labels.iter().all(label_ok) {
        return None;
    }
    let last = labels.last()?;
    if !last.as_bytes()[0].is_ascii_lowercase() {
        return None;
    }
    Some(host)
}

/// An origin-form path: starts with one "/", printable URL characters only
/// (so no space, CR or LF to split the request line), no fragment, no
/// backslash, no "." or ".." segment.
pub fn plain_path(path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("//") || path.len() > PATH_MAX {
        return false;
    }
    let allowed = |b: u8| b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?%".contains(&b);
    if !path.bytes().all(allowed) {
        return false;
    }
    let before_query = path.split('?').next().unwrap_or(path);
    !before_query.split('/').any(|segment| segment == "." || segment == "..")
}

/// Why a probe stopped, each with its stage and its words. Fixed words:
/// nothing from the network, the resolver or the host goes into them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    DnsFailed,
    DnsTimeout,
    ConnectRefused,
    ConnectReset,
    ConnectTimeout,
    ConnectLocal,
    ConnectFailed,
    TlsTimeout,
    TlsCertificate,
    TlsCutOff,
    TlsFailed,
    HttpSend,
    HttpTimeout,
    HttpClosed,
    HttpNotHttp,
}

impl Failure {
    #[cfg(test)]
    pub const ALL: [Failure; 15] = [
        Failure::DnsFailed,
        Failure::DnsTimeout,
        Failure::ConnectRefused,
        Failure::ConnectReset,
        Failure::ConnectTimeout,
        Failure::ConnectLocal,
        Failure::ConnectFailed,
        Failure::TlsTimeout,
        Failure::TlsCertificate,
        Failure::TlsCutOff,
        Failure::TlsFailed,
        Failure::HttpSend,
        Failure::HttpTimeout,
        Failure::HttpClosed,
        Failure::HttpNotHttp,
    ];

    pub fn stage(self) -> &'static str {
        use Failure::*;
        match self {
            DnsFailed | DnsTimeout => "dns",
            ConnectRefused | ConnectReset | ConnectTimeout | ConnectLocal | ConnectFailed => "connect",
            TlsTimeout | TlsCertificate | TlsCutOff | TlsFailed => "tls",
            HttpSend | HttpTimeout | HttpClosed | HttpNotHttp => "http",
        }
    }

    pub fn words(self) -> &'static str {
        use Failure::*;
        match self {
            DnsFailed => "the name did not resolve",
            DnsTimeout => "the name lookup timed out",
            ConnectRefused => "the connection was refused",
            ConnectReset => "the connection was reset",
            ConnectTimeout => "the connection timed out",
            ConnectLocal => "this device refused the connection",
            ConnectFailed => "the connection failed",
            TlsTimeout => "the secure handshake timed out",
            TlsCertificate => "the certificate did not verify for this name",
            TlsCutOff => "the secure handshake was cut off",
            TlsFailed => "the secure handshake failed",
            HttpSend => "the request could not be sent",
            HttpTimeout => "no answer to the request in time",
            HttpClosed => "the connection closed before an answer",
            HttpNotHttp => "the answer was not HTTP",
        }
    }
}

/// The probe, on any port: the command always asks 443; the tests ask
/// loopback servers.
pub fn probe(host: &str, port: u16, path: &str, budget: Duration, config: &Arc<ClientConfig>) -> ServiceProbe {
    let deadline = Instant::now() + budget;
    let mut result = ServiceProbe {
        ok: false,
        stage: "dns",
        dns_ms: None,
        connect_ms: None,
        tls_ms: None,
        first_byte_ms: None,
        status: None,
        address: None,
        error: None,
    };
    let fail = |mut result: ServiceProbe, failure: Failure| {
        result.ok = false;
        result.stage = failure.stage();
        result.error = Some(bounded_error(failure.words()));
        result
    };

    // DNS.
    let started = Instant::now();
    let addrs = match resolve(host, port, remaining(deadline)) {
        Ok(addrs) => addrs,
        Err(failure) => return fail(result, failure),
    };
    result.dns_ms = Some(ms(started));
    // IPv4 first: a device with IPv6 addressing and no IPv6 route fails an
    // IPv6 connect, and the answer would blame the target.
    let mut ordered: Vec<SocketAddr> = addrs.iter().filter(|a| a.is_ipv4()).copied().collect();
    ordered.extend(addrs.iter().filter(|a| a.is_ipv6()));
    result.address = ordered.first().map(|a| a.ip().to_string());

    // Connect.
    let started = Instant::now();
    let mut stream = match connect(&ordered, deadline) {
        Ok(stream) => stream,
        Err(err) => return fail(result, connect_failure(&err)),
    };
    result.connect_ms = Some(ms(started));
    if let Ok(peer) = stream.peer_addr() {
        result.address = Some(peer.ip().to_string());
    }

    // TLS.
    let started = Instant::now();
    let mut conn = match handshake(&mut stream, host, config, deadline) {
        Ok(conn) => conn,
        Err(failure) => return fail(result, failure),
    };
    result.tls_ms = Some(ms(started));

    // HTTP: the request, then the status line and nothing more.
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Neoxify-check\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    let mut tls = rustls::Stream::new(&mut conn, &mut stream);
    let _ = tls.sock.set_write_timeout(Some(remaining(deadline).max(Duration::from_millis(1))));
    if tls.write_all(request.as_bytes()).and_then(|_| tls.flush()).is_err() {
        return fail(result, Failure::HttpSend);
    }
    let sent = Instant::now();
    let answer = read_status_line(&mut tls, deadline, |at| result.first_byte_ms = Some(ms_between(sent, at)));
    conn.send_close_notify();
    let _ = conn.complete_io(&mut stream);
    match answer {
        Ok(status) => {
            result.ok = true;
            result.stage = "ok";
            result.status = Some(status);
            result
        }
        Err(failure) => fail(result, failure),
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn ms(since: Instant) -> u32 {
    since.elapsed().as_millis().min(MS_MAX) as u32
}

fn ms_between(from: Instant, to: Instant) -> u32 {
    to.saturating_duration_since(from).as_millis().min(MS_MAX) as u32
}

/// The words, held to the server's bound on whole characters.
pub fn bounded_error(words: &str) -> String {
    words.chars().take(ERROR_MAX).collect()
}

/// The system resolver with a deadline it does not have of its own; a
/// lookup still running then is abandoned on its thread.
fn resolve(host: &str, port: u16, limit: Duration) -> Result<Vec<SocketAddr>, Failure> {
    if limit.is_zero() {
        return Err(Failure::DnsTimeout);
    }
    let (tx, rx) = mpsc::channel();
    let host = host.to_owned();
    std::thread::spawn(move || {
        let _ = tx.send((host.as_str(), port).to_socket_addrs().map(|it| it.collect::<Vec<_>>()));
    });
    match rx.recv_timeout(limit) {
        Ok(Ok(addrs)) if !addrs.is_empty() => Ok(addrs),
        Ok(_) => Err(Failure::DnsFailed),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(Failure::DnsTimeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(Failure::DnsFailed),
    }
}

/// Each address in turn, sharing the deadline; the first one's error is
/// the answer, as it is the one a request would have used.
fn connect(addrs: &[SocketAddr], deadline: Instant) -> io::Result<TcpStream> {
    let mut first_error: Option<io::Error> = None;
    for addr in addrs {
        let left = remaining(deadline);
        if left.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(addr, left) {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                first_error.get_or_insert(err);
            }
        }
    }
    Err(first_error.unwrap_or_else(|| io::Error::from(io::ErrorKind::TimedOut)))
}

pub fn connect_failure(err: &io::Error) -> Failure {
    match crate::control_plane_probe::classify_connect_error(err) {
        "local" => Failure::ConnectLocal,
        "tcp-timeout" => Failure::ConnectTimeout,
        _ => match err.kind() {
            io::ErrorKind::ConnectionRefused => Failure::ConnectRefused,
            io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted => Failure::ConnectReset,
            _ => Failure::ConnectFailed,
        },
    }
}

pub fn tls_failure(err: &io::Error) -> Failure {
    match crate::control_plane_probe::classify_tls_error(err) {
        "tls-timeout" => Failure::TlsTimeout,
        "cert" => Failure::TlsCertificate,
        _ => match err.kind() {
            io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::BrokenPipe => Failure::TlsCutOff,
            _ => Failure::TlsFailed,
        },
    }
}

fn handshake(
    stream: &mut TcpStream,
    host: &str,
    config: &Arc<ClientConfig>,
    deadline: Instant,
) -> Result<ClientConnection, Failure> {
    let name = ServerName::try_from(host.to_owned()).map_err(|_| Failure::TlsFailed)?;
    let mut conn = ClientConnection::new(Arc::clone(config), name).map_err(|_| Failure::TlsFailed)?;
    while conn.is_handshaking() {
        let left = remaining(deadline);
        if left.is_zero() {
            return Err(Failure::TlsTimeout);
        }
        let _ = stream.set_read_timeout(Some(left));
        let _ = stream.set_write_timeout(Some(left));
        match conn.complete_io(stream) {
            Ok((0, 0)) if conn.is_handshaking() => return Err(Failure::TlsCutOff),
            Ok(_) => {}
            Err(err) => return Err(tls_failure(&err)),
        }
    }
    Ok(conn)
}

/// Reads until the end of the first line, at most a small buffer's worth,
/// and returns its status. `first_byte` is told when the first byte came.
pub fn read_status_line<R: ReadWithTimeout>(
    reader: &mut R,
    deadline: Instant,
    mut first_byte: impl FnMut(Instant),
) -> Result<u16, Failure> {
    let mut line: Vec<u8> = Vec::with_capacity(64);
    let mut buf = [0u8; 256];
    loop {
        let left = remaining(deadline);
        if left.is_zero() {
            return Err(Failure::HttpTimeout);
        }
        reader.set_timeout(left);
        match reader.read(&mut buf) {
            Ok(0) => return Err(if line.is_empty() { Failure::HttpClosed } else { Failure::HttpNotHttp }),
            Ok(n) => {
                if line.is_empty() {
                    first_byte(Instant::now());
                }
                line.extend_from_slice(&buf[..n]);
                if let Some(end) = line.iter().position(|&b| b == b'\n') {
                    return parse_status_line(&line[..end]).ok_or(Failure::HttpNotHttp);
                }
                if line.len() > 512 {
                    return Err(Failure::HttpNotHttp);
                }
            }
            Err(err) if matches!(err.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => {
                return Err(Failure::HttpTimeout)
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(if line.is_empty() { Failure::HttpClosed } else { Failure::HttpNotHttp }),
        }
    }
}

/// A reader whose next read can be held to a time.
pub trait ReadWithTimeout: Read {
    fn set_timeout(&mut self, limit: Duration);
}

impl ReadWithTimeout for rustls::Stream<'_, ClientConnection, TcpStream> {
    fn set_timeout(&mut self, limit: Duration) {
        let _ = self.sock.set_read_timeout(Some(limit));
    }
}

/// "HTTP/1.1 204 No Content" -> 204. Any three-digit status counts.
pub fn parse_status_line(line: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let mut parts = line.splitn(3, ' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    code.parse().ok().filter(|status| (100..=999).contains(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};

    fn config() -> Arc<ClientConfig> {
        crate::control_plane_probe::shared_tls_config()
    }

    #[test]
    fn only_a_plain_host_name_is_probed() {
        assert_eq!(plain_host("www.example.com").as_deref(), Some("www.example.com"));
        assert_eq!(plain_host("WWW.Example.COM").as_deref(), Some("www.example.com"));
        assert_eq!(plain_host("mmg.example.net").as_deref(), Some("mmg.example.net"));
        assert_eq!(plain_host("x-1.example.com").as_deref(), Some("x-1.example.com"));
        for bad in [
            "",
            "https://www.example.com",
            "www.example.com:443",
            "www.example.com/",
            "www.example.com/path",
            "user@www.example.com",
            "www.example.com.",
            ".example.com",
            "localhost",
            "192.0.2.1",
            "0x7f.1",
            "1.2.3.4.5",
            "[2001:db8::1]",
            "2001:db8::1",
            "www.exa mple.com",
            "www.-example.com",
            "www.example-.com",
            "www.example.com\r\nX: y",
            "wwẃ.example.com",
            "www..example.com",
        ] {
            assert_eq!(plain_host(bad), None, "{bad:?}");
        }
        let long_label = format!("{}.example.com", "a".repeat(64));
        assert_eq!(plain_host(&long_label), None);
        let long_name = format!("{}example.com", "abcdefghi.".repeat(25));
        assert!(long_name.len() > HOST_MAX);
        assert_eq!(plain_host(&long_name), None);
    }

    #[test]
    fn only_a_plain_path_is_asked_for() {
        for good in ["/", "/generate_204", "/cdn-cgi/trace", "/a/b?x=1&y=%20"] {
            assert!(plain_path(good), "{good:?}");
        }
        for bad in [
            "",
            "generate_204",
            "//www.example.net/",
            "/a b",
            "/a\r\nHost: www.example.net",
            "/a#frag",
            "/a\\b",
            "/../etc",
            "/a/./b",
            "https://www.example.com/",
        ] {
            assert!(!plain_path(bad), "{bad:?}");
        }
        assert!(!plain_path(&format!("/{}", "a".repeat(PATH_MAX))));
    }

    #[test]
    fn the_command_refuses_before_it_sends_anything() {
        let answer = |host: &str, path: &str| {
            tauri::async_runtime::block_on(probe_service(host.into(), path.into(), 3_000))
        };
        assert!(answer("https://www.example.com", "/").is_err());
        assert!(answer("192.0.2.1", "/").is_err());
        assert!(answer("www.example.com:8443", "/").is_err());
        assert!(answer("www.example.com", "x").is_err());
    }

    /// Fixed words, inside the server's bound, and nothing that could be a
    /// host or address.
    #[test]
    fn every_error_is_short_and_names_nothing() {
        for failure in Failure::ALL {
            let words = failure.words();
            assert!(words.chars().count() <= ERROR_MAX, "{failure:?}");
            assert!(!words.contains('.') && !words.contains(':') && !words.contains('/'), "{failure:?}");
        }
        assert_eq!(bounded_error(&"é".repeat(200)).chars().count(), ERROR_MAX);
    }

    #[test]
    fn each_failure_belongs_to_its_stage() {
        let stage = |f: Failure| f.stage();
        assert_eq!(stage(Failure::DnsFailed), "dns");
        assert_eq!(stage(Failure::DnsTimeout), "dns");
        assert_eq!(stage(Failure::ConnectRefused), "connect");
        assert_eq!(stage(Failure::ConnectLocal), "connect");
        assert_eq!(stage(Failure::TlsCertificate), "tls");
        assert_eq!(stage(Failure::TlsCutOff), "tls");
        assert_eq!(stage(Failure::HttpTimeout), "http");
        assert_eq!(stage(Failure::HttpNotHttp), "http");
        for failure in Failure::ALL {
            assert!(["dns", "connect", "tls", "http"].contains(&failure.stage()), "{failure:?}");
        }
        assert_eq!(connect_failure(&io::Error::from(io::ErrorKind::ConnectionRefused)), Failure::ConnectRefused);
        assert_eq!(connect_failure(&io::Error::from(io::ErrorKind::PermissionDenied)), Failure::ConnectLocal);
        assert_eq!(connect_failure(&io::Error::from(io::ErrorKind::TimedOut)), Failure::ConnectTimeout);
        assert_eq!(connect_failure(&io::Error::from(io::ErrorKind::ConnectionReset)), Failure::ConnectReset);
        let cert = io::Error::new(
            io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName),
        );
        assert_eq!(tls_failure(&cert), Failure::TlsCertificate);
        assert_eq!(tls_failure(&io::Error::from(io::ErrorKind::ConnectionReset)), Failure::TlsCutOff);
        assert_eq!(tls_failure(&io::Error::from(io::ErrorKind::WouldBlock)), Failure::TlsTimeout);
    }

    #[test]
    fn status_lines() {
        assert_eq!(parse_status_line(b"HTTP/1.1 204 No Content\r"), Some(204));
        assert_eq!(parse_status_line(b"HTTP/1.1 302 Found"), Some(302));
        assert_eq!(parse_status_line(b"HTTP/1.0 403"), Some(403));
        assert_eq!(parse_status_line(b"HTTP/1.1 20 OK"), None);
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH"), None);
        assert_eq!(parse_status_line(b"HTTP/1.1 abc"), None);
        assert_eq!(parse_status_line(b""), None);
    }

    /// An in-memory answer, to read the status line without a server.
    struct Canned(io::Cursor<Vec<u8>>);
    impl Read for Canned {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl ReadWithTimeout for Canned {
        fn set_timeout(&mut self, _: Duration) {}
    }

    #[test]
    fn reads_the_status_line_and_no_further() {
        let far = Instant::now() + Duration::from_secs(5);
        let mut seen = false;
        let mut answer = Canned(io::Cursor::new(b"HTTP/1.1 200 OK\r\nSet-Cookie: a=b\r\n\r\nbody".to_vec()));
        assert_eq!(read_status_line(&mut answer, far, |_| seen = true), Ok(200));
        assert!(seen);
        let mut empty = Canned(io::Cursor::new(Vec::new()));
        assert_eq!(read_status_line(&mut empty, far, |_| {}), Err(Failure::HttpClosed));
        let mut garbage = Canned(io::Cursor::new(b"hello\n".to_vec()));
        assert_eq!(read_status_line(&mut garbage, far, |_| {}), Err(Failure::HttpNotHttp));
        let mut endless = Canned(io::Cursor::new(vec![b'x'; 2_000]));
        assert_eq!(read_status_line(&mut endless, far, |_| {}), Err(Failure::HttpNotHttp));
    }

    /// RFC 6761 reserves .invalid: it never resolves.
    #[test]
    fn a_name_that_does_not_resolve_stops_at_dns() {
        let result = probe("neoxify-probe-test.invalid", 443, "/", Duration::from_secs(5), &config());
        assert!(!result.ok);
        assert_eq!(result.stage, "dns", "{result:?}");
        assert_eq!(result.dns_ms, None);
        assert_eq!(result.address, None);
        assert!(result.error.is_some());
    }

    #[test]
    fn a_refused_connection_stops_at_connect_with_the_address() {
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let result = probe("localhost", port, "/", Duration::from_secs(5), &config());
        assert_eq!(result.stage, "connect", "{result:?}");
        assert!(result.dns_ms.is_some());
        assert_eq!(result.connect_ms, None);
        // IPv4 first.
        assert_eq!(result.address.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn a_handshake_cut_off_stops_at_tls() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });
        let result = probe("localhost", port, "/", Duration::from_secs(5), &config());
        server.join().unwrap();
        assert_eq!(result.stage, "tls", "{result:?}");
        assert!(result.connect_ms.is_some());
        assert_eq!(result.tls_ms, None);
    }

    /// The budget holds a handshake nobody answers.
    #[test]
    fn a_silent_server_runs_out_the_budget_at_tls() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1_500));
            drop(stream);
        });
        let started = Instant::now();
        let result = probe("localhost", port, "/", Duration::from_millis(500), &config());
        assert!(started.elapsed() < Duration::from_millis(1_400), "{:?}", started.elapsed());
        server.join().unwrap();
        assert_eq!(result.stage, "tls", "{result:?}");
        assert_eq!(result.error.as_deref(), Some(Failure::TlsTimeout.words()));
    }

    /// Against a real target, by hand, from the network it runs on:
    ///
    /// ```text
    /// cargo test -p neoconnect-desktop --lib live_probe_service -- --ignored --nocapture
    /// ```
    ///
    /// `NEOXIFY_SERVICE_PROBE=host/path` names another target; the default
    /// is the list's own control target.
    #[test]
    #[ignore]
    fn live_probe_service() {
        let target = std::env::var("NEOXIFY_SERVICE_PROBE").unwrap_or_else(|_| "www.cloudflare.com/cdn-cgi/trace".into());
        let (host, path) = target.split_once('/').map(|(h, p)| (h.to_owned(), format!("/{p}"))).unwrap();
        let result = tauri::async_runtime::block_on(probe_service(host, path, 8_000)).unwrap();
        println!(
            "  ok={} stage={} dns={:?} connect={:?} tls={:?} firstByte={:?} status={:?} error={:?}",
            result.ok,
            result.stage,
            result.dns_ms,
            result.connect_ms,
            result.tls_ms,
            result.first_byte_ms,
            result.status,
            result.error
        );
        assert!(result.ok, "{result:?}");
    }
}
