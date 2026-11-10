//! A server's door to the panel API: an API call sent to one of our VPN
//! servers by address, for when no name of ours answers.
//!
//! The API is reached by name, and names are what a filter poisons or
//! resets while the servers' own addresses stay reachable. Every server
//! already answers `/api` on its own address -- the mirror the apps reach
//! by name today -- under a certificate a public CA issued for one of our
//! names. A door is that same mirror reached without the name: the
//! server's address, the port, the SPKI pin of the key its certificate
//! carries there, and the server name to put in the hello, or none. The
//! backend learns each server's door by asking the server itself, and
//! hands it out with the server list the apps already keep
//! (`connection.door`; docs/reachability.md).
//!
//! The name sent, when there is one, is somebody else's on purpose, so
//! there is nothing for a certificate authority to vouch for here: the
//! server is accepted by pin alone, exactly as the relay of last resort
//! is (`pin_verifier` in relay_http.rs), and the handshake signature is
//! still checked against the pinned key. No CA, no hostname and no date
//! is consulted.
//!
//! When to use a door is the TypeScript side's decision
//! (src/lib/server-doors.ts). This file is how one call is sent, and it
//! is a command of its own, apart from `relay_request`: a door carries
//! the whole API, as the mirror by name does, where the relay carries a
//! short list of calls. What it will not do is leave `/api`, follow a
//! redirect, go through a proxy, or dial an address no server of ours can
//! be at.
//!
//! Every call is a connection of its own, as every request through the
//! HTTP plugin is: nothing is kept open to a server between calls. That
//! also makes one thing exact -- an error from before the handshake
//! finished (`DoorError::undelivered`) means no byte of the request was
//! sent, which is what lets a write be offered to the next door without
//! any chance of arriving twice.
//!
//! The mobile app compiles this file by path, as it does relay_http.rs.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, HOST};
use reqwest::Method;
use rustls::ClientConfig;

use crate::relay_http::{
    classify as classify_relay, dotted_quad, parse_pins, pin_verifier, read_response_within, refused_address,
    RelayError, RelayResponse, USER_AGENT,
};

/// What went wrong. Serialised as the string from `as_str`, which is what
/// the frontend receives as the command's rejection, and never carries
/// the address, the name or the pins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorError {
    /// The host is not a dotted IPv4 address a server can be at, the port
    /// is zero, or the server name is not a host name.
    BadDoor,
    /// The pins are not one to three distinct `sha256/` SPKI pins.
    BadPins,
    /// A method this does not send, a path that is not under `/api`, a
    /// header that cannot be sent as given, a body on a GET, or a body
    /// over `MAX_REQUEST_BODY`. Nothing was dialled.
    BadRequest,
    /// The server's key is not one of the pins: not this door any more,
    /// whatever answered at that address. Nothing was sent.
    PinMismatch,
    /// The TLS handshake failed for any other reason. Nothing was sent.
    Tls,
    /// No connection within the connect timeout, handshake included.
    /// Nothing was sent.
    ConnectTimeout,
    /// The connection was refused, reset or unroutable before the
    /// handshake finished. Nothing was sent.
    Connect,
    /// No complete answer within the caller's time.
    Timeout,
    /// The connection was cut after the request went out.
    Network,
    /// The answer is over `MAX_RESPONSE_BODY`.
    TooLarge,
    /// An answer this cannot read: an encoding it did not ask for, or a
    /// gzip body that does not inflate.
    BadResponse,
    /// A body that is not UTF-8, which nothing in the API returns.
    NotUtf8,
}

impl DoorError {
    pub fn as_str(self) -> &'static str {
        match self {
            DoorError::BadDoor => "door: bad-door",
            DoorError::BadPins => "door: bad-pins",
            DoorError::BadRequest => "door: bad-request",
            DoorError::PinMismatch => "door: pin-mismatch",
            DoorError::Tls => "door: tls",
            DoorError::ConnectTimeout => "door: connect-timeout",
            DoorError::Connect => "door: connect",
            DoorError::Timeout => "door: timeout",
            DoorError::Network => "door: network",
            DoorError::TooLarge => "door: too-large",
            DoorError::BadResponse => "door: bad-response",
            DoorError::NotUtf8 => "door: not-utf8",
        }
    }

    /// Whether the request is known not to have left this machine: it was
    /// refused here, or the connection never got as far as carrying it.
    ///
    /// Nothing in the command calls this. It is the rule written down
    /// where the errors are made, held to by the tests below; the side
    /// that acts on it is the frontend, which holds the same list
    /// (`UNDELIVERED` in src/lib/server-doors.ts) and has a test that
    /// reads this function to keep the two alike.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn undelivered(self) -> bool {
        matches!(
            self,
            DoorError::BadDoor
                | DoorError::BadPins
                | DoorError::BadRequest
                | DoorError::PinMismatch
                | DoorError::Tls
                | DoorError::ConnectTimeout
                | DoorError::Connect
        )
    }
}

impl std::fmt::Display for DoorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl serde::Serialize for DoorError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// A failure the relay's code names, in a door's words. Its three refusals
/// of a call (`BadBase`, `RefusedPath`, `BadRequest`) never come out of the
/// functions a door shares with it; they are mapped for completeness.
impl From<RelayError> for DoorError {
    fn from(err: RelayError) -> Self {
        match err {
            RelayError::BadBase => DoorError::BadDoor,
            RelayError::BadPins => DoorError::BadPins,
            RelayError::RefusedPath | RelayError::BadRequest => DoorError::BadRequest,
            RelayError::TooLarge => DoorError::TooLarge,
            RelayError::PinMismatch => DoorError::PinMismatch,
            RelayError::Tls => DoorError::Tls,
            RelayError::ConnectTimeout => DoorError::ConnectTimeout,
            RelayError::Timeout => DoorError::Timeout,
            RelayError::Network => DoorError::Network,
            RelayError::BadResponse => DoorError::BadResponse,
            RelayError::NotUtf8 => DoorError::NotUtf8,
        }
    }
}

/// The largest request body. The API's own limit on a JSON body is well
/// under this; the largest the apps send is a connection report with its
/// diagnostics.
pub const MAX_REQUEST_BODY: usize = 256 * 1024;

/// The largest answer, counted after decompression. Four times the
/// relay's: a door carries every call, the server list and the usage
/// history among them.
pub const MAX_RESPONSE_BODY: usize = 1024 * 1024;

const MAX_HEADER_VALUE: usize = 8 * 1024;
const MAX_PATH: usize = 2048;

/// For the TCP and TLS handshakes together, as the relay's is: long
/// enough for a server on a congested link, short enough that a door at
/// an address the network drops is given up on while the caller still has
/// time for the next.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// The most any one call may take, whatever the caller asks for.
const MAX_TIMEOUT: Duration = Duration::from_secs(20);

/// Loopback is allowed only in tests, which serve the door on 127.0.0.1.
const LOOPBACK_ALLOWED: bool = cfg!(test);

/// The methods the apps use against the API.
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The standard headers a call may carry, lower case. Beside them every
/// header of the app's own goes through (`x-neoxify-...`: the device's
/// label and platform, the network attestation, and whatever is added
/// next). Anything else is dropped, as the relay drops it: Host is set
/// here, and Cookie, Origin and the hop-by-hop headers have no business
/// on this path.
const FORWARDED_HEADERS: &[&str] = &["authorization", "content-type", "if-none-match", "accept", "accept-language"];
const OWN_HEADER_PREFIX: &str = "x-neoxify-";

/// Where a door is, how it is known, and what is said to it first.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Door {
    address: SocketAddrV4,
    pins: Vec<[u8; 32]>,
    /// The server name for the TLS hello, or none.
    sni: Option<String>,
}

/// The door, or why it is refused.
///
/// The host is read as the relay's base is (`dotted_quad`): the one
/// spelling of an IPv4 address every parser agrees on. Beyond the
/// addresses the relay refuses, the private ranges are refused too -- no
/// server of ours is at one, and a command that would dial them on a
/// page's word could be pointed at the customer's own router.
fn parse_door(host: &str, port: u16, pins: &[String], sni: Option<&str>) -> Result<Door, DoorError> {
    let ip = dotted_quad(host).ok_or(DoorError::BadDoor)?;
    if port == 0 || refused_address(ip, LOOPBACK_ALLOWED) || private_address(ip) {
        return Err(DoorError::BadDoor);
    }
    let pins = parse_pins(pins).map_err(|_| DoorError::BadPins)?;
    let sni = match sni {
        None => None,
        Some(name) if is_host_name(name) => Some(name.to_owned()),
        Some(_) => return Err(DoorError::BadDoor),
    };
    Ok(Door { address: SocketAddrV4::new(ip, port), pins, sni })
}

/// 10/8, 172.16/12, 192.168/16 and the carrier-grade 100.64/10.
fn private_address(address: Ipv4Addr) -> bool {
    let [a, b, _, _] = address.octets();
    address.is_private() || (a == 100 && (64..=127).contains(&b))
}

/// A host name as the backend records one (`isHostName` in the backend's
/// door.ts): lower-case labels of letters, digits and inner hyphens, 253
/// characters at most, with a letter somewhere so that it cannot be read
/// as an address.
fn is_host_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.bytes().any(|b| b.is_ascii_lowercase())
        && name.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 63
                && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
        })
}

/// The headers that go out, from those the caller gave: the fixed few and
/// the app's own, each once, each plain visible ASCII.
fn forwarded_headers(headers: &HashMap<String, String>) -> Result<HeaderMap, DoorError> {
    let mut forwarded = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if !FORWARDED_HEADERS.contains(&lower.as_str()) && !lower.starts_with(OWN_HEADER_PREFIX) {
            continue;
        }
        if value.len() > MAX_HEADER_VALUE || !value.bytes().all(|b| b == b'\t' || (0x20..0x7f).contains(&b)) {
            return Err(DoorError::BadRequest);
        }
        let name = HeaderName::from_bytes(lower.as_bytes()).map_err(|_| DoorError::BadRequest)?;
        let value = HeaderValue::from_str(value).map_err(|_| DoorError::BadRequest)?;
        if forwarded.insert(name, value).is_some() {
            return Err(DoorError::BadRequest);
        }
    }
    Ok(forwarded)
}

/// A call that has passed every check, ready to send.
#[derive(Debug)]
struct Call {
    door: Door,
    method: Method,
    url: reqwest::Url,
    /// The Host header: the name sent in the hello, or the address. With
    /// no port, which is how the backend asked when it learned this door
    /// (`probeDoor` in the backend's door-prober.ts).
    host: HeaderValue,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
}

impl Call {
    /// Every check, before anything touches the network: a call refused
    /// here opens no socket.
    #[allow(clippy::too_many_arguments)]
    fn checked(
        host: &str,
        port: u16,
        pins: &[String],
        sni: Option<&str>,
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<String>,
        timeout_ms: u64,
    ) -> Result<Call, DoorError> {
        let door = parse_door(host, port, pins, sni)?;
        if !METHODS.contains(&method) {
            return Err(DoorError::BadRequest);
        }
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| DoorError::BadRequest)?;
        let url = door_url(&door, path)?;
        let headers = forwarded_headers(headers)?;
        let body = match body {
            Some(body) if method == Method::GET && !body.is_empty() => return Err(DoorError::BadRequest),
            Some(body) if body.len() > MAX_REQUEST_BODY => return Err(DoorError::BadRequest),
            Some(body) if body.is_empty() && method == Method::GET => None,
            other => other,
        };
        let host = door.sni.clone().unwrap_or_else(|| door.address.ip().to_string());
        let host = HeaderValue::from_str(&host).map_err(|_| DoorError::BadDoor)?;
        let timeout = Duration::from_millis(timeout_ms.max(1)).min(MAX_TIMEOUT);
        Ok(Call { door, method, url, host, headers, body, timeout })
    }
}

/// `https://<name or address>:<port>/api<path>`, or why the path is
/// refused.
///
/// The path is relative to `/api` and may carry a query. It is checked
/// after the URL parser has had it, not before: the parser is what folds
/// `..`, in every spelling it accepts, and what it leaves must still be
/// under `/api/` on the same host and port. So no rule here has to list
/// those spellings. The name in the URL is only ever resolved to the
/// door's address (`ToTheDoor`).
fn door_url(door: &Door, path: &str) -> Result<reqwest::Url, DoorError> {
    if !path.starts_with('/')
        || path.len() > MAX_PATH
        || !path.bytes().all(|b| (0x21..0x7f).contains(&b) && b != b'#' && b != b'\\')
    {
        return Err(DoorError::BadRequest);
    }
    let host = door.sni.clone().unwrap_or_else(|| door.address.ip().to_string());
    let port = door.address.port();
    let url = reqwest::Url::parse(&format!("https://{host}:{port}/api{path}")).map_err(|_| DoorError::BadRequest)?;
    let same_place = url.host_str() == Some(host.as_str())
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none();
    if !same_place || !url.path().starts_with("/api/") || url.fragment().is_some() {
        return Err(DoorError::BadRequest);
    }
    Ok(url)
}

/// One API call through a server's door.
///
/// `host`, `port`, `pins` and `sni` are a door as the API handed it out
/// with the server list; `path` is relative to `/api`; `timeout_ms` is
/// the caller's budget, capped at twenty seconds. Resolves with the HTTP
/// answer whatever its status -- never following a redirect -- and
/// rejects with one of `DoorError`'s strings when there was none.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn door_request(
    host: String,
    port: u16,
    pins: Vec<String>,
    sni: Option<String>,
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<RelayResponse, DoorError> {
    let call = Call::checked(
        &host,
        port,
        &pins,
        sni.as_deref(),
        &method,
        &path,
        &headers.unwrap_or_default(),
        body,
        timeout_ms,
    )?;
    exchange(call).await
}

/// Resolves every name to the door's address and nothing else.
///
/// When a door has a server name, the URL carries that name so that it
/// goes into the TLS hello, and it is somebody else's: looked up for
/// real, the request would go to them. This is the only resolver the
/// door's client has, so no lookup leaves the machine and no connection
/// goes anywhere but the address the door names.
struct ToTheDoor(SocketAddr);

impl reqwest::dns::Resolve for ToTheDoor {
    fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let address = self.0;
        Box::pin(async move { Ok(Box::new(std::iter::once(address)) as reqwest::dns::Addrs) })
    }
}

/// rustls with the ring provider, verifying the server by pin
/// (`pin_verifier` in relay_http.rs).
///
/// TLS 1.2 as well as 1.3: a door is whatever the server already
/// presents, and the pin and the handshake signature are checked the same
/// way under both. HTTP/1.1 only, which is what the backend asked for
/// when it learned the door: offered h2, a TLS inbound hands the
/// connection to a different socket behind it, and nothing has checked
/// that one. The server name is sent only when the door has one. No
/// session resumption: a resumed session skips the certificate, and with
/// it the pin.
fn door_tls_config(door: &Door) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = pin_verifier(door.pins.clone(), &provider, Arc::default());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.enable_sni = door.sni.is_some();
    config.resumption = rustls::client::Resumption::disabled();
    config
}

fn door_client(door: &Door) -> Result<reqwest::Client, DoorError> {
    reqwest::Client::builder()
        .use_preconfigured_tls(door_tls_config(door))
        .dns_resolver(Arc::new(ToTheDoor(SocketAddr::V4(door.address))))
        // A proxy would be handed the server's address, and a name to
        // look up for itself.
        .no_proxy()
        // A redirect is the answer, not an instruction: following one
        // would take the request somewhere the pins say nothing about.
        .redirect(reqwest::redirect::Policy::none())
        // The socket is IPv4, as the address is.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .connect_timeout(CONNECT_TIMEOUT)
        // A connection of its own for every call; see the top of the file.
        .pool_max_idle_per_host(0)
        .http1_only()
        .https_only(true)
        .referer(false)
        // Inflated here, under the size limit (`read_response_within`).
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .user_agent(USER_AGENT)
        .build()
        // The TLS backend is the only part of this that can be refused.
        .map_err(|_| DoorError::Tls)
}

async fn exchange(call: Call) -> Result<RelayResponse, DoorError> {
    let client = door_client(&call.door)?;
    let mut request = client
        .request(call.method, call.url)
        .headers(call.headers)
        .header(HOST, call.host)
        .header(ACCEPT_ENCODING, "gzip")
        // Covers the whole call, body included; the connect timeout sits
        // inside it.
        .timeout(call.timeout);
    if let Some(body) = call.body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|err| classify(&err))?;
    Ok(read_response_within(response, MAX_RESPONSE_BODY).await?)
}

/// Which `DoorError` a failure to send is: the relay's reading of it
/// (`classify` in relay_http.rs, by the error's kind and causes, never its
/// text), with one more distinction. A connection that failed before it
/// was made is `Connect`, apart from one cut after the request went out:
/// only the first leaves it certain that nothing was sent.
fn classify(err: &reqwest::Error) -> DoorError {
    match classify_relay(err) {
        RelayError::Network if err.is_connect() => DoorError::Connect,
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_http::tests::{header_set, http, pin_of, Seen, Step, TestKey, TestRelay, JSON};
    use std::net::TcpListener;

    const NAME: &str = "www.example.org";

    /// A door on 127.0.0.1: the relay's test server, which is HTTP/1.1
    /// over TLS with a fresh key, asked the way a door is.
    struct TestDoor {
        relay: TestRelay,
        port: u16,
    }

    impl TestDoor {
        fn start(script: Vec<Vec<Step>>) -> Self {
            Self::over(TestRelay::start(script))
        }

        fn over(relay: TestRelay) -> Self {
            let port = relay.base.trim_start_matches("https://127.0.0.1:").trim_end_matches("/api").parse().unwrap();
            TestDoor { relay, port }
        }

        fn pin(&self) -> String {
            self.relay.pin.clone()
        }

        fn call(&self, sni: Option<&str>, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<RelayResponse, DoorError> {
            self.call_pinned(vec![self.pin()], sni, method, path, headers, body)
        }

        fn call_pinned(
            &self,
            pins: Vec<String>,
            sni: Option<&str>,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<&str>,
        ) -> Result<RelayResponse, DoorError> {
            ask("127.0.0.1", self.port, pins, sni, method, path, headers, body)
        }

        fn finish(self) -> Seen {
            self.relay.finish().0
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ask(
        host: &str,
        port: u16,
        pins: Vec<String>,
        sni: Option<&str>,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<RelayResponse, DoorError> {
        tauri::async_runtime::block_on(door_request(
            host.to_string(),
            port,
            pins,
            sni.map(str::to_string),
            method.to_string(),
            path.to_string(),
            Some(header_set(headers)),
            body.map(str::to_string),
            5_000,
        ))
    }

    fn ok() -> Vec<Step> {
        vec![Step::Answer(http("200 OK", &[JSON], b"{\"status\":\"ok\"}"))]
    }

    // ---- The pin and the server name, over real TLS on loopback ------

    #[test]
    fn answers_through_the_pin_under_the_given_server_name() {
        let door = TestDoor::start(vec![ok()]);
        let answer = door.call(Some(NAME), "GET", "/health", &[], None).unwrap();
        let seen = door.finish();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.content_type, "application/json");
        assert_eq!(answer.body, "{\"status\":\"ok\"}");
        // The name given, in the hello and as the Host, and nothing of
        // the address in either.
        assert_eq!(seen.sni, vec![Some(NAME.to_string())]);
        assert_eq!(seen.alpn, vec![vec!["http/1.1".to_string()]]);
        assert_eq!(seen.requests.len(), 1);
        let request = &seen.requests[0];
        assert_eq!((request.method.as_str(), request.target.as_str()), ("GET", "/api/health"));
        assert_eq!(request.header("host"), Some(NAME));
        assert_eq!(request.header("user-agent"), Some(USER_AGENT));
    }

    #[test]
    fn sends_no_server_name_when_the_door_has_none() {
        let door = TestDoor::start(vec![ok()]);
        let answer = door.call(None, "GET", "/health", &[], None);
        let seen = door.finish();
        assert_eq!(answer.map(|a| a.status), Ok(200));
        assert_eq!(seen.sni, vec![None]);
        assert_eq!(seen.requests[0].header("host"), Some("127.0.0.1"));
    }

    #[test]
    fn refuses_a_server_whose_key_is_not_pinned_and_sends_it_nothing() {
        for sni in [Some(NAME), None] {
            let door = TestDoor::start(vec![ok()]);
            let others = vec![pin_of(&[1; 32]), TestKey::fresh().pin()];
            let answer = door.call_pinned(others, sni, "POST", "/customer/vouchers/redeem", &[], Some("{}"));
            let seen = door.finish();
            assert_eq!(answer, Err(DoorError::PinMismatch));
            assert!(seen.requests.is_empty(), "a request went out to an unpinned server: {seen:?}");
        }
    }

    #[test]
    fn the_previous_pin_opens_the_door_as_the_current_one_does() {
        let door = TestDoor::start(vec![ok()]);
        let renewed = pin_of(&[9; 32]);
        let answer = door.call_pinned(vec![renewed, door.pin()], Some(NAME), "GET", "/health", &[], None);
        assert_eq!(answer.map(|a| a.status), Ok(200));
        door.finish();
    }

    /// The certificate is the real server's -- its key pinned -- but
    /// whoever answers holds a different private key. The pin matches;
    /// the handshake signature cannot.
    #[test]
    fn refuses_a_copied_certificate_without_its_key() {
        let real = TestKey::fresh();
        let impostor = TestKey::fresh();
        let door = TestDoor::over(TestRelay::start_with(real.certificate(), &impostor, &[&rustls::version::TLS13], vec![ok()]));
        assert_eq!(door.pin(), real.pin());
        let answer = door.call(Some(NAME), "GET", "/health", &[], None);
        let seen = door.finish();
        assert_eq!(answer, Err(DoorError::Tls));
        assert!(seen.requests.is_empty(), "{seen:?}");
    }

    /// The test certificate is self-signed, names nobody and expired in
    /// 2001: none of that is consulted, under either TLS version.
    #[test]
    fn opens_a_door_that_only_speaks_tls_1_2() {
        let key = TestKey::fresh();
        let door = TestDoor::over(TestRelay::start_with(key.certificate(), &key, &[&rustls::version::TLS12], vec![ok()]));
        assert_eq!(door.call(Some(NAME), "GET", "/health", &[], None).map(|a| a.status), Ok(200));
        door.finish();
    }

    #[test]
    fn carries_a_write_with_its_headers_and_a_query() {
        let door = TestDoor::start(vec![
            vec![Step::Answer(http("201 Created", &[JSON], b"{}"))],
            vec![Step::Answer(http("200 OK", &[JSON], b"[]"))],
        ]);
        let headers = [
            ("Authorization", "Bearer token"),
            ("Content-Type", "application/json"),
            ("X-Neoxify-Device-Platform", "windows"),
            ("X-Neoxify-Something-New", "1"),
            ("Cookie", "session=1"),
            ("Host", "elsewhere.example"),
            ("Origin", "tauri://localhost"),
        ];
        let sent = door.call(Some(NAME), "PATCH", "/customer/me", &headers, Some("{\"a\":1}"));
        let read = door.call(Some(NAME), "GET", "/customer/usage?days=7&tz=UTC", &[], None);
        let seen = door.finish();
        assert_eq!(sent.map(|a| a.status), Ok(201));
        assert_eq!(read.map(|a| a.body), Ok("[]".to_string()));
        // A connection each.
        assert_eq!(seen.connections, 2);
        let write = &seen.requests[0];
        assert_eq!((write.method.as_str(), write.target.as_str()), ("PATCH", "/api/customer/me"));
        assert_eq!(write.body, b"{\"a\":1}");
        assert_eq!(write.header("authorization"), Some("Bearer token"));
        assert_eq!(write.header("x-neoxify-device-platform"), Some("windows"));
        assert_eq!(write.header("x-neoxify-something-new"), Some("1"));
        assert_eq!(write.header("cookie"), None);
        assert_eq!(write.header("origin"), None);
        assert_eq!(write.header("host"), Some(NAME));
        assert_eq!(seen.requests[1].target, "/api/customer/usage?days=7&tz=UTC");
    }

    #[test]
    fn returns_a_redirect_without_following_it() {
        let door = TestDoor::start(vec![vec![Step::Answer(http("302 Found", &[("Location", "/api/health")], b""))]]);
        let answer = door.call(Some(NAME), "GET", "/customer/me", &[], None);
        let seen = door.finish();
        assert_eq!(answer.map(|a| a.status), Ok(302));
        assert_eq!(seen.requests.len(), 1);
    }

    /// A port nothing listens on: refused before any handshake, which is
    /// `Connect` and not `Network` -- the difference that lets a write go
    /// on to the next door.
    #[test]
    fn a_refused_connection_is_known_not_to_have_carried_the_request() {
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };
        let answer = ask("127.0.0.1", port, vec![pin_of(&[2; 32])], Some(NAME), "POST", "/customer/vouchers/redeem", &[], Some("{}"));
        assert_eq!(answer, Err(DoorError::Connect));
        assert!(DoorError::Connect.undelivered());
    }

    /// The server takes the request and hangs up: the request went out,
    /// so this is not one of the failures a write may be sent again after.
    #[test]
    fn a_connection_cut_after_the_request_is_not_undelivered() {
        let door = TestDoor::start(vec![vec![Step::HangUp]]);
        let answer = door.call(Some(NAME), "POST", "/customer/vouchers/redeem", &[], Some("{}"));
        let seen = door.finish();
        assert_eq!(answer, Err(DoorError::Network));
        assert!(!DoorError::Network.undelivered());
        assert_eq!(seen.requests.len(), 1);
    }

    // ---- What is refused before anything is dialled ------------------

    fn check(host: &str, port: u16, sni: Option<&str>, method: &str, path: &str, body: Option<&str>) -> Result<Call, DoorError> {
        Call::checked(host, port, &[pin_of(&[3; 32])], sni, method, path, &HashMap::new(), body.map(str::to_string), 5_000)
    }

    #[test]
    fn refuses_an_address_no_server_can_be_at() {
        for host in [
            "",
            "example.org",
            "0.0.0.0",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "100.64.0.1",
            "169.254.169.254",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.010",
            "192.0.2",
            "3221225994",
            "[2001:db8::1]",
            "2001:db8::1",
            "192.0.2.10:443",
            "192.0.2.10/api",
        ] {
            assert_eq!(check(host, 2053, None, "GET", "/health", None).map(|_| ()), Err(DoorError::BadDoor), "{host:?}");
        }
        assert_eq!(check("192.0.2.10", 0, None, "GET", "/health", None).map(|_| ()), Err(DoorError::BadDoor));
        // Loopback is the one exception, and only in a test build.
        assert!(LOOPBACK_ALLOWED);
        assert!(check("192.0.2.10", 2053, None, "GET", "/health", None).is_ok());
        assert!(check("172.32.0.1", 2053, None, "GET", "/health", None).is_ok());
        assert!(check("100.128.0.1", 2053, None, "GET", "/health", None).is_ok());
    }

    #[test]
    fn refuses_a_server_name_that_is_not_a_host_name() {
        for name in [
            "",
            "192.0.2.10",
            "WWW.example.org",
            "www.example.org.",
            ".example.org",
            "www..example.org",
            "-www.example.org",
            "www-.example.org",
            "www.example.org:443",
            "www.example.org/x",
            "user@example.org",
            "www example.org",
            "ex\u{e4}mple.org",
        ] {
            assert_eq!(
                check("192.0.2.10", 2053, Some(name), "GET", "/health", None).map(|_| ()),
                Err(DoorError::BadDoor),
                "{name:?}"
            );
        }
        let long = format!("{}.org", "a".repeat(64));
        assert_eq!(check("192.0.2.10", 2053, Some(&long), "GET", "/health", None).map(|_| ()), Err(DoorError::BadDoor));
        assert!(check("192.0.2.10", 2053, Some("a-b.example.org"), "GET", "/health", None).is_ok());
    }

    #[test]
    fn keeps_every_call_under_api_on_the_doors_own_host() {
        for sni in [Some(NAME), None] {
            for path in [
                "",
                "health",
                "/../health",
                "/customer/../../health",
                "/%2e%2e/health",
                "/customer/%2E%2E/%2e%2e/x",
                "/..",
                "/health#x",
                "/hea lth",
                "/health\\..\\x",
                "/he\u{e4}lth",
                "/health\r\nHost: elsewhere.example",
            ] {
                assert_eq!(
                    check("192.0.2.10", 2053, sni, "GET", path, None).map(|_| ()),
                    Err(DoorError::BadRequest),
                    "{path:?}"
                );
            }
        }
        let long = format!("/{}", "a".repeat(MAX_PATH));
        assert_eq!(check("192.0.2.10", 2053, None, "GET", &long, None).map(|_| ()), Err(DoorError::BadRequest));

        let named = check("192.0.2.10", 2053, Some(NAME), "GET", "/customer/usage?days=7", None).unwrap();
        assert_eq!(named.url.as_str(), "https://www.example.org:2053/api/customer/usage?days=7");
        assert_eq!(named.host, NAME);
        let bare = check("192.0.2.10", 443, None, "GET", "//health", None).unwrap();
        assert_eq!(bare.url.as_str(), "https://192.0.2.10/api//health");
        assert_eq!(bare.host, "192.0.2.10");
        // Folded by the parser, and still under /api.
        let folded = check("192.0.2.10", 2053, None, "GET", "/customer/../health", None).unwrap();
        assert_eq!(folded.url.path(), "/api/health");
    }

    #[test]
    fn sends_only_the_methods_and_bodies_the_api_takes() {
        for method in ["get", "HEAD", "OPTIONS", "CONNECT", "TRACE", "", "GET "] {
            assert_eq!(
                check("192.0.2.10", 2053, None, method, "/health", None).map(|_| ()),
                Err(DoorError::BadRequest),
                "{method:?}"
            );
        }
        for method in METHODS {
            assert!(check("192.0.2.10", 2053, None, method, "/health", None).is_ok(), "{method}");
        }
        assert_eq!(check("192.0.2.10", 2053, None, "GET", "/health", Some("{}")).map(|_| ()), Err(DoorError::BadRequest));
        assert!(check("192.0.2.10", 2053, None, "GET", "/health", Some("")).unwrap().body.is_none());
        let limit = "a".repeat(MAX_REQUEST_BODY);
        assert!(check("192.0.2.10", 2053, None, "POST", "/client-attempts", Some(&limit)).is_ok());
        let over = "a".repeat(MAX_REQUEST_BODY + 1);
        assert_eq!(
            check("192.0.2.10", 2053, None, "POST", "/client-attempts", Some(&over)).map(|_| ()),
            Err(DoorError::BadRequest)
        );
    }

    #[test]
    fn refuses_pins_as_the_relay_does() {
        let call = |pins: &[String]| {
            Call::checked("192.0.2.10", 2053, pins, None, "GET", "/health", &HashMap::new(), None, 5_000).map(|_| ())
        };
        assert_eq!(call(&[]), Err(DoorError::BadPins));
        assert_eq!(call(&["sha256/short".to_string()]), Err(DoorError::BadPins));
        assert_eq!(call(&[pin_of(&[1; 32]), pin_of(&[1; 32])]), Err(DoorError::BadPins));
        assert_eq!(call(&[pin_of(&[1; 32]), pin_of(&[2; 32])]), Ok(()));
    }

    #[test]
    fn refuses_a_header_it_cannot_send_as_given() {
        let call = |pairs: &[(&str, &str)]| forwarded_headers(&header_set(pairs)).map(|_| ());
        assert_eq!(call(&[("Authorization", "Bearer a\r\nX: y")]), Err(DoorError::BadRequest));
        assert_eq!(call(&[("X-Neoxify-Device-Label", "caf\u{e9}")]), Err(DoorError::BadRequest));
        assert_eq!(call(&[("authorization", "a"), ("Authorization", "b")]), Err(DoorError::BadRequest));
        assert_eq!(call(&[("X-Neoxify-Bad Name", "1")]), Err(DoorError::BadRequest));
        let long = "a".repeat(MAX_HEADER_VALUE + 1);
        assert_eq!(call(&[("Authorization", &long)]), Err(DoorError::BadRequest));
        assert_eq!(call(&[("Cookie", "a\r\nb"), ("Accept", "application/json")]), Ok(()));
    }

    #[test]
    fn opens_no_connection_for_a_call_it_refuses() {
        let door = TestDoor::start(vec![]);
        let pin = door.pin();
        assert_eq!(ask("127.0.0.1", door.port, vec![pin.clone()], Some(NAME), "GET", "/../x", &[], None), Err(DoorError::BadRequest));
        assert_eq!(ask("127.0.0.1", door.port, vec![pin.clone()], Some("Not A Name"), "GET", "/health", &[], None), Err(DoorError::BadDoor));
        assert_eq!(ask("127.0.0.1", door.port, vec![], Some(NAME), "GET", "/health", &[], None), Err(DoorError::BadPins));
        assert_eq!(ask("127.0.0.1", door.port, vec![pin], Some(NAME), "HEAD", "/health", &[], None), Err(DoorError::BadRequest));
        let seen = door.finish();
        assert_eq!(seen.connections, 0);
    }

    #[test]
    fn errors_serialise_to_their_fixed_strings_and_say_whether_anything_was_sent() {
        let all = [
            (DoorError::BadDoor, "door: bad-door", true),
            (DoorError::BadPins, "door: bad-pins", true),
            (DoorError::BadRequest, "door: bad-request", true),
            (DoorError::PinMismatch, "door: pin-mismatch", true),
            (DoorError::Tls, "door: tls", true),
            (DoorError::ConnectTimeout, "door: connect-timeout", true),
            (DoorError::Connect, "door: connect", true),
            (DoorError::Timeout, "door: timeout", false),
            (DoorError::Network, "door: network", false),
            (DoorError::TooLarge, "door: too-large", false),
            (DoorError::BadResponse, "door: bad-response", false),
            (DoorError::NotUtf8, "door: not-utf8", false),
        ];
        for (err, text, undelivered) in all {
            assert_eq!(serde_json::to_string(&err).unwrap(), format!("\"{text}\""));
            assert_eq!(err.undelivered(), undelivered, "{text}");
        }
    }
}
