//! The relay of last resort: the app's own API calls, sent to a box in
//! Iran by address, for when every ordinary route to the control plane
//! has failed.
//!
//! The box is reached as `https://<IPv4>/api`, by address and with no
//! SNI, because a name is exactly what the filtering on those networks
//! acts on. With no name there is nothing for a certificate authority to
//! vouch for, so the box's certificate is self-signed and accepted by
//! SPKI pin alone: the SHA-256 of its SubjectPublicKeyInfo must be one of
//! the one to three pins its signed bundle entry carries (`kind:
//! "lastResort"`). No CA, no hostname, no expiry date is consulted, so a
//! clock that is wrong -- common on the phones -- cannot lock anyone
//! out. The handshake signature is still verified against that same
//! public key, so a certificate copied off the real box is worth nothing
//! without its private key.
//!
//! When to use it is the TypeScript side's decision. This file decides
//! only what may be sent, and the answer is narrow: a fixed list of
//! method and path pairs (`allowed_call`, the one authoritative copy), a
//! fixed set of headers (`forwarded_headers`), a small request body and a
//! bounded response. The command sits outside the HTTP plugin's
//! capability scope, so this is the whole of what a page in the webview
//! could have it do.
//!
//! Its errors are a short fixed vocabulary (`RelayError`) and never carry
//! the address, the URL or the pins: a support paste or a crash report
//! must not be the thing that hands the box to the people looking for it.
//!
//! The mobile app compiles this file by path (`apps/mobile/src-tauri/
//! src/lib.rs`), as it does `health_ip.rs`. Changes here ship in both
//! apps.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, ETAG};
use reqwest::Method;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme};

/// What went wrong, in words that say nothing about where the relay is.
///
/// Serialised as the string from `as_str` -- "relay: pin-mismatch" and so
/// on -- which is what the frontend receives as the command's rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayError {
    /// The base is not exactly `https://<dotted IPv4>[:port]/api`, or it
    /// names an address no relay can be at.
    BadBase,
    /// The pins are not one to three distinct `sha256/` SPKI pins.
    BadPins,
    /// The method and path are not on the list a relay may carry.
    RefusedPath,
    /// A header value that cannot be sent as it is, a header given twice,
    /// or a body on a GET.
    BadRequest,
    /// The request body or the response body is over its limit. No part
    /// of an oversized response is returned.
    TooLarge,
    /// The server's key is not one of the pins: not our relay, whatever
    /// answered at that address.
    PinMismatch,
    /// The TLS handshake failed for any other reason, including a
    /// handshake signature that does not verify against the pinned key.
    Tls,
    /// No connection within the connect timeout, handshake included.
    ConnectTimeout,
    /// No complete answer within the caller's time.
    Timeout,
    /// The connection failed, was cut, or went silent (a PING left
    /// unanswered, `KEEP_ALIVE_TIMEOUT`) without an answer.
    Network,
    /// An answer this cannot read: an encoding it did not ask for, or a
    /// gzip body that does not inflate.
    BadResponse,
    /// A body that is not UTF-8, which none of the allowed calls returns.
    NotUtf8,
}

impl RelayError {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayError::BadBase => "relay: bad-base",
            RelayError::BadPins => "relay: bad-pins",
            RelayError::RefusedPath => "relay: refused-path",
            RelayError::BadRequest => "relay: bad-request",
            RelayError::TooLarge => "relay: too-large",
            RelayError::PinMismatch => "relay: pin-mismatch",
            RelayError::Tls => "relay: tls",
            RelayError::ConnectTimeout => "relay: connect-timeout",
            RelayError::Timeout => "relay: timeout",
            RelayError::Network => "relay: network",
            RelayError::BadResponse => "relay: bad-response",
            RelayError::NotUtf8 => "relay: not-utf8",
        }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl serde::Serialize for RelayError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// An answer from the relay, shaped so the frontend can build a standard
/// `Response` from it.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayResponse {
    pub status: u16,
    /// Empty when the response had none, which is how the frontend's
    /// `Headers.get(...) ?? ""` already reads an absent header.
    pub content_type: String,
    /// For the calls that revalidate with `If-None-Match`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    pub body: String,
}

/// Every allowed call is a small JSON request; 16 KiB is several times
/// the largest of them (a registration with its proof-of-work solution).
pub const MAX_REQUEST_BODY: usize = 16 * 1024;

/// Every allowed answer is small JSON too; the largest is the signed
/// endpoint bundle. Counted after decompression, so a small gzip body
/// cannot make this process hold more than this.
pub const MAX_RESPONSE_BODY: usize = 256 * 1024;

/// How much larger than `MAX_RESPONSE_BODY` a gzip body may be on the
/// wire. Deflate can only grow incompressible data by a few bytes per
/// block, plus a header and trailer, so this keeps a body that inflates
/// to just under the limit from being refused for its compressed size.
const GZIP_SLACK: usize = 1024;

/// A bearer token or an attestation is well under this. Bounding each
/// value keeps a hostile page from making one request enormous.
const MAX_HEADER_VALUE: usize = 8 * 1024;

/// For the TCP and TLS handshakes together. Long enough for a box on a
/// congested Iranian link; short enough that a dead one is given up on
/// well inside the caller's time.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// The most any one call may take, whatever the caller asks for.
const MAX_TIMEOUT: Duration = Duration::from_secs(15);

/// The box closes a connection that has been idle for 30 seconds. Giving
/// one up at 20 means a pooled connection is almost never reused just as
/// the far end is closing it -- and `attempt` retries a GET once for the
/// rare time it is.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// While a call is open on an HTTP/2 connection and nothing has arrived
/// on it for this long, the box is sent a PING.
///
/// A connection can die without a word: a middlebox stops forwarding the
/// flow, or a phone moves from Wi-Fi to cellular and leaves it behind.
/// Nothing is reset, so nothing fails until the operating system gives
/// up retransmitting, which takes tens of seconds to minutes and on iOS
/// has no limit set by us at all. Over HTTP/2 every call shares the one
/// connection, so until then each call would be handed the dead one and
/// spend its whole time on it. An unanswered PING ends that within this
/// interval and `KEEP_ALIVE_TIMEOUT`, which is well inside a call's time,
/// and `attempt` then asks a GET again on a new connection.
///
/// No PING is sent while a connection sits idle in the pool: that would
/// keep a flow to the box alive, and visible, for no call at all. A dead
/// pooled connection is found by the first call that uses it instead.
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(2);

/// How long the box has to answer a PING: as long as a new connection
/// gets for its TCP and TLS handshakes together, which take two round
/// trips to the PING's one.
const KEEP_ALIVE_TIMEOUT: Duration = CONNECT_TIMEOUT;

/// The same identity the app's other requests present (tauri-plugin-
/// http's default, as in health_ip.rs), so the backend behind the box
/// sees one client, not two.
const USER_AGENT: &str = "tauri-plugin-http/2.5.9";

const PIN_PREFIX: &str = "sha256/";
const MAX_PINS: usize = 3;

/// How many relays keep a client, and so a connection pool, at once. A
/// bundle carries one to three. A page that asked for more would
/// otherwise grow this map without end; past the limit it is emptied,
/// which costs only fresh handshakes. Unlimited in tests, which run side
/// by side and each have a relay of their own that must not be evicted
/// between two of its calls.
const MAX_RELAYS: usize = if cfg!(test) { usize::MAX } else { 8 };

/// Loopback is allowed only in tests, which serve the relay on 127.0.0.1.
const LOOPBACK_ALLOWED: bool = cfg!(test);

/// Where a base points, or why it is refused.
///
/// Read off the text itself rather than through a URL parser, which
/// accepts an IPv4 address in decimal, octal and hex spellings and
/// normalises them: `192.0.2.010` would quietly become `192.0.2.8`, a
/// different server than the one the text appears to name. The backend
/// refuses the same spellings when the bundle entry is configured
/// (`lastResortProblem` in endpoints.service.ts); this is the client's
/// own copy of the rule, since the bundle's signature says who wrote an
/// entry, not that it is well formed.
pub fn parse_base(base: &str) -> Result<SocketAddrV4, RelayError> {
    parse_base_allowing(base, LOOPBACK_ALLOWED)
}

fn parse_base_allowing(base: &str, loopback: bool) -> Result<SocketAddrV4, RelayError> {
    let authority = base
        .strip_prefix("https://")
        .and_then(|rest| rest.strip_suffix("/api"))
        .ok_or(RelayError::BadBase)?;
    // Everything between the scheme and the path must be the address and
    // perhaps a port: any '@', '[', '/', '?', '#', '%' or space fails the
    // digit checks below, so userinfo, IPv6, extra path, query, fragment
    // and percent-encoding are all refused here without a rule each.
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => {
            let port = decimal(port, 5)
                .and_then(|port| u16::try_from(port).ok())
                .filter(|&port| port != 0)
                .ok_or(RelayError::BadBase)?;
            (host, port)
        }
        None => (authority, 443),
    };
    let address = dotted_quad(host).ok_or(RelayError::BadBase)?;
    if refused_address(address, loopback) {
        return Err(RelayError::BadBase);
    }
    Ok(SocketAddrV4::new(address, port))
}

/// A decimal number of one to `max_digits` digits with no leading zero
/// ("0" itself is fine).
fn decimal(text: &str, max_digits: usize) -> Option<u32> {
    if text.is_empty() || text.len() > max_digits || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse().ok()
}

/// Four decimal numbers from 0 to 255, dot-separated, none with a
/// leading zero -- the one spelling a reader and every parser agree on.
fn dotted_quad(host: &str) -> Option<Ipv4Addr> {
    let mut octets = [0u8; 4];
    let mut parts = host.split('.');
    for octet in &mut octets {
        *octet = u8::try_from(decimal(parts.next()?, 3)?).ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(Ipv4Addr::from(octets))
}

/// Addresses that cannot be a relay on the internet: "this network",
/// loopback (outside tests), link-local, multicast and broadcast. A base
/// naming one is a mistake or an attempt to have this command reach
/// something on the customer's own machine or segment.
fn refused_address(address: Ipv4Addr, loopback: bool) -> bool {
    let [a, b, _, _] = address.octets();
    a == 0
        || (a == 127 && !loopback)
        || (a == 169 && b == 254)
        || (224..=239).contains(&a)
        || address == Ipv4Addr::BROADCAST
}

/// The pins as the SHA-256 digests they name, or why they are refused.
///
/// Each is `sha256/` and the standard, padded base64 of 32 bytes -- what
/// `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der |
/// openssl dgst -sha256 -binary | base64` prints. A non-canonical
/// spelling (stray bits in the last character) is refused rather than
/// read, as the backend refuses it: the digest computed here is compared
/// as bytes, so it would match, but a pin no reviewer can compare by eye
/// against the operator's own output should not be accepted silently. A
/// repeated pin is refused because it reads as a standby key that does
/// not exist.
pub fn parse_pins(pins: &[String]) -> Result<Vec<[u8; 32]>, RelayError> {
    if pins.is_empty() || pins.len() > MAX_PINS {
        return Err(RelayError::BadPins);
    }
    let mut digests: Vec<[u8; 32]> = Vec::with_capacity(pins.len());
    for pin in pins {
        let encoded = pin.strip_prefix(PIN_PREFIX).ok_or(RelayError::BadPins)?;
        if encoded.len() != 44 {
            return Err(RelayError::BadPins);
        }
        // STANDARD requires canonical padding and refuses stray trailing
        // bits, so one digest has exactly one accepted spelling.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| RelayError::BadPins)?;
        let digest: [u8; 32] = bytes.try_into().map_err(|_| RelayError::BadPins)?;
        if digests.contains(&digest) {
            return Err(RelayError::BadPins);
        }
        digests.push(digest);
    }
    Ok(digests)
}

/// Calls with no data in the path, relative to `/api`, by method.
const POST_PATHS: &[&str] = &[
    "/login-challenge",
    "/customer-auth/login",
    "/customer-auth/register",
    "/customer-auth/refresh",
    "/customer-auth/social",
    "/customer-auth/social/exchange",
    "/customer-auth/verify-email-code",
    "/customer-auth/resend-verification",
    "/customer-auth/forgot-password",
    "/customer-auth/reset-password-code",
];
const GET_PATHS: &[&str] = &[
    "/customer/me",
    "/customer/subscriptions",
    "/customer/protocol-users",
    "/health",
    "/endpoints/bundle",
    "/endpoints/bundle2",
];

/// Whether the relay may carry `method` to `path` (relative to `/api`).
///
/// The one authoritative copy of the list; the frontend's is a mirror,
/// for deciding what to offer, and this is what decides. It is what a
/// customer needs to sign in and get connected when nothing else
/// answers -- sign-in and its recovery, the account, the subscriptions
/// and their routes, and the endpoint bundle that may name a better way
/// in -- and nothing else: no account deletion, no support tickets, no
/// payments.
///
/// Matched exactly, so a query string, a trailing slash, a doubled or
/// encoded slash, or a `..` is simply not on the list. None of the app's
/// callers of these paths sends a query. The two paths that carry data
/// carry a subscription id, which must have the shape of a UUID.
pub fn allowed_call(method: &str, path: &str) -> bool {
    match method {
        "GET" => GET_PATHS.contains(&path) || subscription_call(path, "/routes"),
        "POST" => POST_PATHS.contains(&path) || subscription_call(path, "/route"),
        _ => false,
    }
}

/// `/customer/subscriptions/<uuid><tail>`.
fn subscription_call(path: &str, tail: &str) -> bool {
    path.strip_prefix("/customer/subscriptions/")
        .and_then(|rest| rest.strip_suffix(tail))
        .is_some_and(is_uuid)
}

/// The 8-4-4-4-12 hex shape of a UUID, in either case.
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// The headers a call may carry, lower case. Four standard ones -- the
/// app sets Authorization, Content-Type and If-None-Match on these calls
/// today, and Accept-Language is allowed for a caller that names the
/// customer's language -- and the three of the app's own that the
/// backend reads on them: `X-Neoxify-Device-Platform` and
/// `X-Neoxify-Device-Label` on sign-in, social sign-in and refresh
/// (device-identity.ts), and `X-Neoxify-Network` on the route list
/// (network-identity.ts).
const FORWARDED_HEADERS: &[&str] = &[
    "authorization",
    "content-type",
    "if-none-match",
    "accept-language",
    "x-neoxify-device-platform",
    "x-neoxify-device-label",
    "x-neoxify-network",
];

/// The headers that go out, from those the caller gave.
///
/// Anything not in `FORWARDED_HEADERS` is dropped, not refused: the
/// frontend builds its headers for every route at once, and a header
/// this does not forward is one the relay does not need. That includes
/// Host -- the request's Host is always the address, as reqwest derives
/// it -- and Cookie, Origin and every hop-by-hop header. A forwarded
/// header given twice (in two casings) is refused rather than one copy
/// picked, and so is a value that is not plain visible ASCII.
pub fn forwarded_headers(headers: &HashMap<String, String>) -> Result<HeaderMap, RelayError> {
    let mut forwarded = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        let Some(&known) = FORWARDED_HEADERS.iter().find(|known| **known == lower) else {
            continue;
        };
        if value.len() > MAX_HEADER_VALUE {
            return Err(RelayError::BadRequest);
        }
        // `HeaderValue::from_str` lets bytes past ASCII through, and how a
        // server reads those depends on the server. The app's own headers
        // are ASCII by construction (`encodeDeviceLabel` percent-encodes a
        // label that is not), so anything else is refused.
        if !value.bytes().all(|b| b == b'\t' || (0x20..0x7f).contains(&b)) {
            return Err(RelayError::BadRequest);
        }
        let value = HeaderValue::from_str(value).map_err(|_| RelayError::BadRequest)?;
        if forwarded.insert(HeaderName::from_static(known), value).is_some() {
            return Err(RelayError::BadRequest);
        }
    }
    Ok(forwarded)
}

/// The body that goes out. A GET carries none (an empty one is the same
/// as none), and a POST's is at most `MAX_REQUEST_BODY` bytes.
pub fn checked_body(method: &str, body: Option<String>) -> Result<Option<String>, RelayError> {
    match body {
        None => Ok(None),
        Some(body) if method == "GET" => {
            if body.is_empty() {
                Ok(None)
            } else {
                Err(RelayError::BadRequest)
            }
        }
        Some(body) if body.len() > MAX_REQUEST_BODY => Err(RelayError::TooLarge),
        Some(body) => Ok(Some(body)),
    }
}

/// A call that has passed every check, ready to send.
struct Call {
    address: SocketAddrV4,
    pins: Vec<[u8; 32]>,
    method: Method,
    url: reqwest::Url,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
}

impl Call {
    /// Every check, before anything touches the network: a call refused
    /// here opens no socket.
    fn checked(
        base: &str,
        pins: &[String],
        method: &str,
        path: &str,
        headers: &HashMap<String, String>,
        body: Option<String>,
        timeout_ms: u64,
    ) -> Result<Call, RelayError> {
        let address = parse_base(base)?;
        let pins = parse_pins(pins)?;
        if !allowed_call(method, path) {
            return Err(RelayError::RefusedPath);
        }
        let headers = forwarded_headers(headers)?;
        let body = checked_body(method, body)?;
        // Built from the parsed address, not the text, so what is dialled
        // is exactly what was checked. Port 443 drops out of the URL and
        // so out of Host, as it would from any browser.
        let url = reqwest::Url::parse(&format!("https://{address}/api{path}")).map_err(|_| RelayError::BadBase)?;
        let method = if method == "GET" { Method::GET } else { Method::POST };
        let timeout = Duration::from_millis(timeout_ms.max(1)).min(MAX_TIMEOUT);
        Ok(Call { address, pins, method, url, headers, body, timeout })
    }
}

/// One API call through the relay of last resort.
///
/// `base` and `pins` are a verified bundle entry's `url` and `pins`;
/// `path` is relative to `/api`; `timeout_ms` is the caller's budget,
/// capped at fifteen seconds. Resolves with the HTTP answer whatever its
/// status -- a 401 or a 302 is an answer, and is returned as one, never
/// followed -- and rejects with one of `RelayError`'s strings when there
/// was none.
#[tauri::command]
pub async fn relay_request(
    base: String,
    pins: Vec<String>,
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<RelayResponse, RelayError> {
    let call = Call::checked(&base, &pins, &method, &path, &headers.unwrap_or_default(), body, timeout_ms)?;
    exchange(call).await
}

/// A pooled client for one relay, and a count of the TLS handshakes it
/// has made -- each one a new connection, since session resumption is
/// off (`pinned_tls_config`).
struct Relay {
    client: reqwest::Client,
    handshakes: Arc<AtomicU64>,
}

type RelayKey = (SocketAddrV4, Vec<[u8; 32]>);

/// The key a relay is kept under. The same pins in another order are the
/// same relay.
fn relay_key(address: SocketAddrV4, pins: &[[u8; 32]]) -> RelayKey {
    let mut pins = pins.to_vec();
    pins.sort_unstable();
    (address, pins)
}

/// Every relay this process has a client for.
fn relays() -> MutexGuard<'static, HashMap<RelayKey, Arc<Relay>>> {
    static RELAYS: OnceLock<Mutex<HashMap<RelayKey, Arc<Relay>>>> = OnceLock::new();
    // A panic elsewhere while holding the lock leaves a map that is still
    // whole: every write to it is a single insert, remove or clear.
    RELAYS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The client for this address and pin set: one per process, so calls
/// share its connections. Over HTTP/2, which the box speaks, that is one
/// connection for every call, and a call after the first costs no
/// handshake at all -- on a network where each handshake to a foreign
/// address is a fresh chance to be cut.
fn relay_for(address: SocketAddrV4, pins: &[[u8; 32]]) -> Result<Arc<Relay>, RelayError> {
    let key = relay_key(address, pins);
    let mut relays = relays();
    if let Some(relay) = relays.get(&key) {
        return Ok(Arc::clone(relay));
    }
    let relay = Arc::new(build_relay(key.1.clone())?);
    remember(&mut relays, key, Arc::clone(&relay), MAX_RELAYS);
    Ok(relay)
}

/// Adds a relay to the map, emptying it first if it is full.
fn remember<V>(relays: &mut HashMap<RelayKey, V>, key: RelayKey, value: V, limit: usize) {
    if relays.len() >= limit {
        relays.clear();
    }
    relays.insert(key, value);
}

/// Takes a relay out of the map, so the next call to it builds a new
/// client and dials a new connection -- but only if it is still the one
/// there. A call that ran out of time alongside another may find the
/// other has already replaced it, and the replacement is kept.
fn forget<V>(relays: &mut HashMap<RelayKey, Arc<V>>, key: &RelayKey, relay: &Arc<V>) {
    if relays.get(key).is_some_and(|known| Arc::ptr_eq(known, relay)) {
        relays.remove(key);
    }
}

fn build_relay(pins: Vec<[u8; 32]>) -> Result<Relay, RelayError> {
    let handshakes = Arc::new(AtomicU64::new(0));
    let tls = pinned_tls_config(pins, Arc::clone(&handshakes));
    let client = reqwest::Client::builder()
        // reqwest takes this as it is, ALPN list included, and only
        // recognises it if it is the same rustls it was built with: a
        // mismatch fails `build` below rather than falling back to
        // anything that verifies differently.
        .use_preconfigured_tls(tls)
        // A proxy would see the relay's address and is exactly what this
        // path exists to do without.
        .no_proxy()
        // A redirect is the answer, not an instruction: the box only ever
        // forwards to the API, and following one would take a request
        // somewhere the pins say nothing about.
        .redirect(reqwest::redirect::Policy::none())
        // The host is an IPv4 literal, so nothing is resolved; this keeps
        // the socket IPv4 as well, as health_ip.rs does.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        // Only while a call is open on the connection: reqwest leaves
        // `http2_keep_alive_while_idle` off, which is what is wanted (see
        // `KEEP_ALIVE_INTERVAL`).
        .http2_keep_alive_interval(KEEP_ALIVE_INTERVAL)
        .http2_keep_alive_timeout(KEEP_ALIVE_TIMEOUT)
        .https_only(true)
        .referer(false)
        // The response is inflated here, under the size limit, whatever
        // another crate in the build enables in reqwest.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .user_agent(USER_AGENT)
        .build()
        // The TLS backend is the only part of this that can be refused.
        .map_err(|_| RelayError::Tls)?;
    Ok(Relay { client, handshakes })
}

/// rustls with the ring provider, TLS 1.3 only, verifying the server by
/// pin (`PinVerifier`), offering HTTP/2 first.
///
/// No SNI: the URL's host is an address, which rustls never puts in the
/// extension, and `enable_sni` is off as well so that stays true however
/// the name is handed over. No session resumption either: a resumed
/// session skips the certificate entirely, and a ticket links one
/// connection to the next for anyone holding the box's keys. It also
/// makes every new connection call the verifier, which is how `attempt`
/// can tell a reused connection from a new one.
fn pinned_tls_config(pins: Vec<[u8; 32]>, handshakes: Arc<AtomicU64>) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(PinVerifier {
        pins,
        algorithms: provider.signature_verification_algorithms,
        handshakes,
    });
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("ring supports TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config.enable_sni = false;
    config.resumption = rustls::client::Resumption::disabled();
    config
}

/// Accepts a server whose leaf certificate's public key is one of the
/// pins, and then only if it proves it holds the matching private key.
#[derive(Debug)]
struct PinVerifier {
    pins: Vec<[u8; 32]>,
    algorithms: WebPkiSupportedAlgorithms,
    handshakes: Arc<AtomicU64>,
}

impl ServerCertVerifier for PinVerifier {
    /// Only the leaf matters. Intermediates are ignored whether or not
    /// any were sent -- there is no chain to build -- and so is the name,
    /// which is an address chosen by us, and the validity dates.
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.handshakes.fetch_add(1, Ordering::SeqCst);
        let digest = spki_sha256(end_entity).ok_or(rustls::Error::InvalidCertificate(CertificateError::BadEncoding))?;
        if self.pins.contains(&digest) {
            Ok(ServerCertVerified::assertion())
        } else {
            // Reserved by rustls for a verifier's own refusals, so it is
            // how `classify` tells a wrong key from any other TLS failure.
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }

    /// The pin says which key; this says the server has it. Without it, a
    /// copy of the box's certificate -- which it hands to anyone who
    /// connects -- would pass.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// SHA-256 over the certificate's DER SubjectPublicKeyInfo, outer
/// SEQUENCE included -- the pin's definition.
///
/// Read with webpki, the parser rustls then checks the handshake
/// signature with, so the key that was pinned and the key that signed
/// are found the same way. A second parser here would be a chance for a
/// crafted certificate to show this one a pinned key and the other its
/// own.
fn spki_sha256(cert: &CertificateDer<'_>) -> Option<[u8; 32]> {
    let parsed = webpki::EndEntityCert::try_from(cert).ok()?;
    let spki = parsed.subject_public_key_info();
    ring::digest::digest(&ring::digest::SHA256, spki.as_ref()).as_ref().try_into().ok()
}

/// Sends the call and reads the answer, as `attempt` does, and leaves no
/// connection in doubt behind it.
///
/// A call that ran out of time may have done so on a connection that has
/// gone silent before any PING could say so -- a budget shorter than
/// `KEEP_ALIVE_INTERVAL` ends first. Over HTTP/2 that connection is the
/// one every call shares, and the pool hands it out again as fresh each
/// time a call takes it, so the next call would wait out a PING on it
/// before a GET could be asked again, and a POST would simply fail. So
/// the relay's client is dropped after a timeout, and the next call dials
/// a new connection. Calls already under way keep the old client until
/// they finish. When the box was only slow, that costs one handshake.
async fn exchange(call: Call) -> Result<RelayResponse, RelayError> {
    let deadline = Instant::now() + call.timeout;
    let relay = relay_for(call.address, &call.pins)?;
    let answer = attempt(&relay, &call, deadline).await;
    if answer == Err(RelayError::Timeout) {
        forget(&mut relays(), &relay_key(call.address, &call.pins), &relay);
    }
    answer
}

/// Sends the call, retrying a GET once if a pooled connection turns out
/// to be dead, and reads the answer.
///
/// The retry is for one failure only: the request went out on a
/// connection that was already open, and the connection died before any
/// answer. That is a connection the box closed while it sat in the pool,
/// or one that went silent under it (`KEEP_ALIVE_INTERVAL`) -- not a
/// verdict on the network -- and a GET can safely be asked again. A POST
/// cannot: the box may have passed it on before the connection died, and
/// a second sign-in or registration is not the same as the first. (hyper
/// itself already resends a request, POST included, that it found a
/// pooled connection closed before writing -- one it knows never left
/// this machine.)
///
/// "Already open" is known from the handshake count: no handshake during
/// the attempt means no new connection, and an error that is not a
/// connect error means the request was dispatched -- so it went out on a
/// reused one. A handshake by a concurrent call makes this say no, which
/// only ever means not retrying.
async fn attempt(relay: &Relay, call: &Call, deadline: Instant) -> Result<RelayResponse, RelayError> {
    let handshakes = relay.handshakes.load(Ordering::SeqCst);
    let response = match send(relay, call, remaining(deadline)?).await {
        Ok(response) => response,
        Err(err)
            if call.method == Method::GET
                && died_on_reused_connection(&err)
                && relay.handshakes.load(Ordering::SeqCst) == handshakes =>
        {
            send(relay, call, remaining(deadline)?).await.map_err(|err| classify(&err))?
        }
        Err(err) => return Err(classify(&err)),
    };
    read_response(response).await
}

/// What is left of the caller's time, or `Timeout` if nothing is.
fn remaining(deadline: Instant) -> Result<Duration, RelayError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or(RelayError::Timeout)
}

async fn send(relay: &Relay, call: &Call, timeout: Duration) -> Result<reqwest::Response, reqwest::Error> {
    let mut request = relay
        .client
        .request(call.method.clone(), call.url.clone())
        .headers(call.headers.clone())
        // Asked for explicitly and inflated in `read_response`, where the
        // size limit applies to what it inflates to.
        .header(ACCEPT_ENCODING, "gzip")
        // Covers the whole call, body included; the connect timeout sits
        // inside it.
        .timeout(timeout);
    if let Some(body) = &call.body {
        request = request.body(body.clone());
    }
    request.send().await
}

/// The request was dispatched and nothing came back: not a failure to
/// connect, not the caller's time running out, not a TLS refusal. A
/// connection that went silent counts (`went_silent`): that is the
/// connection lost, not the call's time spent.
fn died_on_reused_connection(err: &reqwest::Error) -> bool {
    err.is_request()
        && !err.is_connect()
        && (!err.is_timeout() || went_silent(err))
        && cause::<rustls::Error>(err).is_none()
}

/// Whether hyper gave the connection up because a PING went unanswered
/// (`KEEP_ALIVE_TIMEOUT`).
///
/// hyper reports that as a timeout of its own, so reqwest's `is_timeout`
/// says yes to it as it does to the call's own time running out. They
/// are told apart by whose error it is: the call's time and the connect
/// timeout are reqwest's, and on a client hyper has no other timeout
/// than the PING's.
fn went_silent(err: &reqwest::Error) -> bool {
    cause::<hyper::Error>(err).is_some_and(hyper::Error::is_timeout)
}

/// Which `RelayError` a reqwest failure is. Looks only at the error's
/// kind and causes, never its text, which carries the URL.
fn classify(err: &reqwest::Error) -> RelayError {
    match cause::<rustls::Error>(err) {
        Some(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure)) => {
            return RelayError::PinMismatch
        }
        Some(_) => return RelayError::Tls,
        None => {}
    }
    // Ahead of the timeouts: an unanswered PING is the connection failing
    // while the caller still had time, which is what `Network` says.
    if went_silent(err) {
        return RelayError::Network;
    }
    match (err.is_timeout(), err.is_connect()) {
        (true, true) => RelayError::ConnectTimeout,
        (true, false) => RelayError::Timeout,
        (false, _) => RelayError::Network,
    }
}

/// The error of type `T` behind a failure, if there is one.
///
/// An `io::Error`'s `source` skips the error it wraps, and that is where
/// rustls's is: tokio-rustls wraps it in one `io::Error` and the TLS
/// connector wraps that in another (seen as `Custom { kind: Other,
/// error: Custom { kind: InvalidData, error: InvalidCertificate(..) } }`).
/// So every `io::Error` on the way down is opened rather than stepped
/// over.
fn cause<'a, T: std::error::Error + 'static>(err: &'a (dyn std::error::Error + 'static)) -> Option<&'a T> {
    let mut next = Some(err);
    while let Some(err) = next {
        if let Some(found) = err.downcast_ref::<T>() {
            return Some(found);
        }
        next = match err.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            Some(wrapped) => Some(wrapped as &(dyn std::error::Error + 'static)),
            None => err.source(),
        };
    }
    None
}

/// The answer, whole or not at all.
async fn read_response(mut response: reqwest::Response) -> Result<RelayResponse, RelayError> {
    let status = response.status().as_u16();
    let headers = response.headers();
    let content_type = header_text(headers, &CONTENT_TYPE).unwrap_or_default();
    let etag = header_text(headers, &ETAG);
    let gzip = gzipped(headers)?;

    let limit = if gzip { MAX_RESPONSE_BODY + GZIP_SLACK } else { MAX_RESPONSE_BODY };
    // Refused before reading a byte when the server says how much is
    // coming; counted as it arrives when it does not.
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(RelayError::TooLarge);
    }
    let mut raw = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| classify(&err))? {
        if raw.len() + chunk.len() > limit {
            return Err(RelayError::TooLarge);
        }
        raw.extend_from_slice(&chunk);
    }
    // A 304 or a 204 says gzip and carries nothing to inflate.
    let bytes = if gzip && !raw.is_empty() { inflate(&raw)? } else { raw };
    let body = String::from_utf8(bytes).map_err(|_| RelayError::NotUtf8)?;
    Ok(RelayResponse { status, content_type, etag, body })
}

/// A header's value as text, if it is present and plain ASCII.
fn header_text(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_owned)
}

/// Whether the body is gzip. Only gzip was asked for, so any other
/// encoding -- or two of them -- is an answer this cannot read.
fn gzipped(headers: &HeaderMap) -> Result<bool, RelayError> {
    let mut values = headers.get_all(CONTENT_ENCODING).iter();
    let Some(value) = values.next() else {
        return Ok(false);
    };
    if values.next().is_some() {
        return Err(RelayError::BadResponse);
    }
    let value = value.to_str().map_err(|_| RelayError::BadResponse)?.trim();
    if value.eq_ignore_ascii_case("gzip") || value.eq_ignore_ascii_case("x-gzip") {
        Ok(true)
    } else if value.is_empty() || value.eq_ignore_ascii_case("identity") {
        Ok(false)
    } else {
        Err(RelayError::BadResponse)
    }
}

/// Inflates a gzip body, stopping one byte past the limit: a few
/// kilobytes that inflate to gigabytes cost no more than the limit.
fn inflate(compressed: &[u8]) -> Result<Vec<u8>, RelayError> {
    let mut inflated = Vec::new();
    flate2::read::GzDecoder::new(compressed)
        .take(MAX_RESPONSE_BODY as u64 + 1)
        .read_to_end(&mut inflated)
        .map_err(|_| RelayError::BadResponse)?;
    if inflated.len() > MAX_RESPONSE_BODY {
        return Err(RelayError::TooLarge);
    }
    Ok(inflated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread::JoinHandle;

    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::server::{ClientHello, ResolvesServerCert, ServerConfig, ServerConnection};
    use rustls::sign::CertifiedKey;
    use rustls::StreamOwned;

    // ---- Validation -------------------------------------------------

    #[test]
    fn accepts_a_dotted_ipv4_base_with_or_without_a_port() {
        assert_eq!(parse_base("https://192.0.2.10/api"), Ok("192.0.2.10:443".parse().unwrap()));
        assert_eq!(parse_base("https://198.51.100.7:8443/api"), Ok("198.51.100.7:8443".parse().unwrap()));
        assert_eq!(parse_base("https://203.0.113.0/api"), Ok("203.0.113.0:443".parse().unwrap()));
        assert_eq!(parse_base("https://203.0.113.255:65535/api"), Ok("203.0.113.255:65535".parse().unwrap()));
        assert_eq!(parse_base("https://203.0.113.9:1/api"), Ok("203.0.113.9:1".parse().unwrap()));
    }

    #[test]
    fn refuses_every_other_spelling_of_a_base() {
        for base in [
            "",
            "http://192.0.2.10/api",
            "HTTPS://192.0.2.10/api",
            "https://192.0.2.10",
            "https://192.0.2.10/",
            "https://192.0.2.10/api/",
            "https://192.0.2.10/v2/api",
            "https://192.0.2.10/api?",
            "https://192.0.2.10/api?x=1",
            "https://192.0.2.10/api#",
            "https://192.0.2.10/api#x",
            "https://user:secret@192.0.2.10/api",
            "https://user@192.0.2.10/api",
            "https://@192.0.2.10/api",
            "https://[2001:db8::1]/api",
            "https://[::ffff:192.0.2.10]/api",
            "https://relay.example.com/api",
            // The spellings a URL parser reads as some other address.
            "https://3221225994/api",
            "https://0xc0.0.2.10/api",
            "https://192.0.2.010/api",
            "https://192.0.2.0010/api",
            "https://192.0.2/api",
            "https://192.2/api",
            "https://192.0.2.10./api",
            "https://192.0.2.1%30/api",
            "https://192.0.2.256/api",
            "https://192.0.2.10.1/api",
            "https://192.0.2.-1/api",
            "https://192.0.2.+1/api",
            "https:// 192.0.2.10/api",
            "https://192.0.2.10\\api",
            // Ports.
            "https://192.0.2.10:/api",
            "https://192.0.2.10:0/api",
            "https://192.0.2.10:00/api",
            "https://192.0.2.10:0443/api",
            "https://192.0.2.10:65536/api",
            "https://192.0.2.10:443:443/api",
            "https://192.0.2.10:+443/api",
            "https://192.0.2.10:x/api",
        ] {
            assert_eq!(parse_base(base), Err(RelayError::BadBase), "{base:?} should be refused");
        }
    }

    #[test]
    fn refuses_addresses_no_relay_can_be_at() {
        for base in [
            "https://0.0.0.0/api",
            "https://0.1.2.3/api",
            "https://127.0.0.1/api",
            "https://127.255.255.254:8443/api",
            "https://169.254.0.1/api",
            "https://169.254.169.254/api",
            "https://224.0.0.1/api",
            "https://239.255.255.250/api",
            "https://255.255.255.255/api",
        ] {
            assert_eq!(parse_base_allowing(base, false), Err(RelayError::BadBase), "{base:?} should be refused");
        }
        // Loopback is the one exception, and only in a test build.
        assert!(parse_base_allowing("https://127.0.0.1:8443/api", true).is_ok());
        assert!(parse_base_allowing("https://169.254.0.1/api", true).is_err());
        assert!(LOOPBACK_ALLOWED);
    }

    fn pin_of(bytes: &[u8; 32]) -> String {
        format!("{PIN_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[test]
    fn accepts_one_to_three_distinct_pins() {
        let pins: Vec<String> = (1..=3).map(|i| pin_of(&[i; 32])).collect();
        assert_eq!(parse_pins(&pins[..1]), Ok(vec![[1; 32]]));
        assert_eq!(parse_pins(&pins), Ok(vec![[1; 32], [2; 32], [3; 32]]));
    }

    #[test]
    fn refuses_pins_that_are_not_sha256_spki_pins() {
        let good = pin_of(&[7; 32]);
        // 0xfb encodes as "+/v7", so its URL-safe spelling differs.
        let url_safe = pin_of(&[0xfb; 32]).replace('+', "-").replace('/', "_").replacen("sha256_", "sha256/", 1);
        let encoded = good.strip_prefix(PIN_PREFIX).unwrap().to_string();
        // The last data character of 32 bytes carries two unused bits;
        // setting one gives another spelling of the same digest.
        let non_canonical = {
            let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut chars: Vec<char> = good.chars().collect();
            let at = chars.len() - 2;
            chars[at] = alphabet.chars().nth(alphabet.find(chars[at]).unwrap() ^ 1).unwrap();
            chars.into_iter().collect::<String>()
        };
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("none", vec![]),
            ("four", (1..=4).map(|i| pin_of(&[i; 32])).collect()),
            ("no prefix", vec![encoded.clone()]),
            ("upper-case prefix", vec![format!("SHA256/{encoded}")]),
            ("sha1 prefix", vec![format!("sha1/{encoded}")]),
            ("one character short", vec![good[..good.len() - 1].to_string()]),
            ("one character long", vec![format!("{good}=")]),
            ("base64url", vec![url_safe]),
            ("not base64", vec![format!("{}!{}", &good[..10], &good[11..])]),
            ("33 bytes", vec![format!("{PIN_PREFIX}{}", "A".repeat(44))]),
            ("non-canonical", vec![non_canonical]),
            ("repeated", vec![good.clone(), good.clone()]),
            ("padded with space", vec![format!(" {good}")]),
            ("bad after good", vec![good.clone(), "sha256/short".to_string()]),
        ];
        for (name, pins) in cases {
            assert_eq!(parse_pins(&pins), Err(RelayError::BadPins), "{name}: {pins:?}");
        }
        // The standard spelling of that digest is fine.
        assert!(parse_pins(&[pin_of(&[0xfb; 32])]).is_ok());
    }

    const SUBSCRIPTION: &str = "3f2b8c1e-9a4d-4e6f-8b0a-1c2d3e4f5a6b";

    #[test]
    fn allows_exactly_the_listed_calls() {
        for path in POST_PATHS {
            assert!(allowed_call("POST", path), "POST {path}");
            assert!(!allowed_call("GET", path), "GET {path}");
        }
        for path in GET_PATHS {
            assert!(allowed_call("GET", path), "GET {path}");
            assert!(!allowed_call("POST", path), "POST {path}");
        }
        let routes = format!("/customer/subscriptions/{SUBSCRIPTION}/routes");
        let route = format!("/customer/subscriptions/{SUBSCRIPTION}/route");
        assert!(allowed_call("GET", &routes));
        assert!(allowed_call("POST", &route));
        assert!(!allowed_call("POST", &routes));
        assert!(!allowed_call("GET", &route));
        // The list itself, so a change to it is a change to this test.
        assert_eq!(POST_PATHS.len(), 10);
        assert_eq!(GET_PATHS.len(), 6);
    }

    #[test]
    fn refuses_everything_else() {
        for (method, path) in [
            ("GET", ""),
            ("GET", "/"),
            ("get", "/health"),
            ("Get", "/health"),
            ("HEAD", "/health"),
            ("PUT", "/customer/me"),
            ("DELETE", "/customer/me"),
            ("PATCH", "/customer/me"),
            ("OPTIONS", "/health"),
            ("GET", "/health/"),
            ("GET", "/health?"),
            ("GET", "/health?x=1"),
            ("GET", "/health#x"),
            ("GET", "/api/health"),
            ("GET", "//health"),
            ("GET", "health"),
            ("GET", "/health/ip"),
            ("GET", "/customer/me/"),
            ("GET", "/customer/../health"),
            ("GET", "/customer%2Fme"),
            ("GET", "/endpoints/bundle3"),
            ("GET", "/customer/gaming-profile"),
            ("GET", "/customer/support/tickets"),
            ("POST", "/customer-auth/logout"),
            ("POST", "/customer-auth/verify-email"),
            ("POST", "/customer-auth/change-password"),
            ("POST", "/customer/vpn/claim"),
            ("POST", "/customer/subscriptions"),
            ("POST", "/customer-auth/login/"),
            ("POST", "/customer-auth/login?next=x"),
        ] {
            assert!(!allowed_call(method, path), "{method} {path} should be refused");
        }
    }

    #[test]
    fn a_subscription_id_must_have_the_shape_of_a_uuid() {
        let call = |id: &str| allowed_call("GET", &format!("/customer/subscriptions/{id}/routes"));
        assert!(call(SUBSCRIPTION));
        assert!(call(&SUBSCRIPTION.to_ascii_uppercase()));
        for id in [
            "",
            "1",
            &SUBSCRIPTION[1..],
            &format!("{SUBSCRIPTION}0"),
            &SUBSCRIPTION.replace('-', ""),
            &SUBSCRIPTION.replacen('-', "x", 1),
            &SUBSCRIPTION.replacen('3', "g", 1),
            &format!("{}/{}", &SUBSCRIPTION[..17], &SUBSCRIPTION[18..]),
            "../../../customer/me/../xxxxxxxxxxxx",
            "3f2b8c1e-9a4d-4e6f-8b0a-1c2d3e4f5a6b/x",
            "3f2b8c1e-9a4d-4e6f-8b0a-1c2d3e4f5a6%62",
        ] {
            assert!(!call(id), "{id:?} should be refused");
        }
        assert!(!allowed_call("GET", &format!("/customer/subscriptions/{SUBSCRIPTION}/routes/x")));
        assert!(!allowed_call("GET", &format!("/customer/subscriptions/{SUBSCRIPTION}/routes?x=1")));
        assert!(!allowed_call("GET", &format!("/customer/subscriptions//{SUBSCRIPTION}/routes")));
    }

    fn header_set(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
    }

    #[test]
    fn forwards_only_the_fixed_headers() {
        let forwarded = forwarded_headers(&header_set(&[
            ("Authorization", "Bearer a.b.c"),
            ("content-type", "application/json"),
            ("If-None-Match", "W/\"7\""),
            ("Accept-Language", "fa"),
            ("X-Neoxify-Device-Platform", "windows"),
            ("x-neoxify-device-label", "Surface%20Pro"),
            ("X-Neoxify-Network", "att.v1.sig"),
            ("Host", "connect.example.com"),
            ("Cookie", "session=1"),
            ("Origin", "tauri://localhost"),
            ("X-Forwarded-For", "203.0.113.5"),
            ("Accept-Encoding", "br"),
            ("Content-Length", "99999"),
            ("Transfer-Encoding", "chunked"),
            ("Connection", "upgrade"),
            ("Proxy-Authorization", "Basic x"),
            ("User-Agent", "something"),
            ("X-Neoxify-Something-Else", "1"),
        ]))
        .unwrap();
        let mut names: Vec<&str> = forwarded.keys().map(|n| n.as_str()).collect();
        names.sort_unstable();
        let mut expected = FORWARDED_HEADERS.to_vec();
        expected.sort_unstable();
        assert_eq!(names, expected);
        assert_eq!(forwarded["authorization"], "Bearer a.b.c");
        assert_eq!(forwarded["if-none-match"], "W/\"7\"");
        assert_eq!(forwarded["x-neoxify-device-label"], "Surface%20Pro");
        assert!(forwarded_headers(&HashMap::new()).unwrap().is_empty());
    }

    #[test]
    fn refuses_a_forwarded_header_it_cannot_send_as_given() {
        for pairs in [
            vec![("Authorization", "Bearer a\r\nX-Injected: 1")],
            vec![("Authorization", "Bearer a\nb")],
            vec![("Accept-Language", "fa\0")],
            vec![("X-Neoxify-Device-Label", "\u{0645}\u{0646}")],
            vec![("Authorization", "Bearer a"), ("authorization", "Bearer b")],
        ] {
            assert_eq!(forwarded_headers(&header_set(&pairs)), Err(RelayError::BadRequest), "{pairs:?}");
        }
        let long = "a".repeat(MAX_HEADER_VALUE + 1);
        assert_eq!(forwarded_headers(&header_set(&[("Authorization", &long)])), Err(RelayError::BadRequest));
        let longest = "a".repeat(MAX_HEADER_VALUE);
        assert!(forwarded_headers(&header_set(&[("Authorization", &longest)])).is_ok());
        // A header that is dropped anyway is not inspected.
        assert!(forwarded_headers(&header_set(&[("Cookie", "a\r\nb")])).is_ok());
    }

    #[test]
    fn caps_the_request_body_and_keeps_gets_bodiless() {
        let at_limit = "x".repeat(MAX_REQUEST_BODY);
        assert_eq!(checked_body("POST", Some(at_limit.clone())), Ok(Some(at_limit)));
        assert_eq!(checked_body("POST", Some("x".repeat(MAX_REQUEST_BODY + 1))), Err(RelayError::TooLarge));
        assert_eq!(checked_body("POST", None), Ok(None));
        assert_eq!(checked_body("GET", None), Ok(None));
        assert_eq!(checked_body("GET", Some(String::new())), Ok(None));
        assert_eq!(checked_body("GET", Some("{}".into())), Err(RelayError::BadRequest));
        // Bytes, not characters: two-byte characters reach the limit at
        // half the count.
        let wide = "\u{0645}".repeat(MAX_REQUEST_BODY / 2 + 1);
        assert_eq!(checked_body("POST", Some(wide)), Err(RelayError::TooLarge));
    }

    #[test]
    fn errors_serialise_to_their_fixed_strings_and_nothing_else() {
        let all = [
            (RelayError::BadBase, "relay: bad-base"),
            (RelayError::BadPins, "relay: bad-pins"),
            (RelayError::RefusedPath, "relay: refused-path"),
            (RelayError::BadRequest, "relay: bad-request"),
            (RelayError::TooLarge, "relay: too-large"),
            (RelayError::PinMismatch, "relay: pin-mismatch"),
            (RelayError::Tls, "relay: tls"),
            (RelayError::ConnectTimeout, "relay: connect-timeout"),
            (RelayError::Timeout, "relay: timeout"),
            (RelayError::Network, "relay: network"),
            (RelayError::BadResponse, "relay: bad-response"),
            (RelayError::NotUtf8, "relay: not-utf8"),
        ];
        for (error, text) in all {
            assert_eq!(serde_json::to_value(error).unwrap(), serde_json::Value::String(text.into()));
            assert_eq!(error.to_string(), text);
            // A fixed word after the prefix: nothing from the call.
            let word = text.strip_prefix("relay: ").unwrap();
            assert!(word.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "{text}");
        }
    }

    #[test]
    fn the_response_serialises_in_the_shape_the_frontend_reads() {
        let with = RelayResponse {
            status: 200,
            content_type: "application/json".into(),
            etag: Some("\"1\"".into()),
            body: "{}".into(),
        };
        assert_eq!(
            serde_json::to_value(&with).unwrap(),
            serde_json::json!({ "status": 200, "contentType": "application/json", "etag": "\"1\"", "body": "{}" }),
        );
        let without = RelayResponse { etag: None, ..with };
        assert_eq!(
            serde_json::to_value(&without).unwrap(),
            serde_json::json!({ "status": 200, "contentType": "application/json", "body": "{}" }),
        );
    }

    #[test]
    fn a_full_map_of_relays_is_emptied_before_the_next() {
        let key = |n: u8| (SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, n), 443), vec![[n; 32]]);
        let mut map = HashMap::new();
        for n in 0..3 {
            remember(&mut map, key(n), n, 3);
        }
        assert_eq!(map.len(), 3);
        remember(&mut map, key(9), 9, 3);
        assert_eq!(map.into_iter().collect::<Vec<_>>(), vec![(key(9), 9)]);
    }

    #[test]
    fn forgets_a_relay_only_if_it_is_still_the_one_kept() {
        let key = relay_key(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 1), 443), &[[2; 32], [1; 32]]);
        // The key does not depend on the order the pins came in.
        assert_eq!(key, relay_key(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 1), 443), &[[1; 32], [2; 32]]));
        let old = Arc::new(1);
        let replacement = Arc::new(1);
        let mut map = HashMap::from([(key.clone(), Arc::clone(&replacement))]);
        // The client that timed out is no longer the one kept: the
        // replacement a concurrent call made stays.
        forget(&mut map, &key, &old);
        assert!(Arc::ptr_eq(&map[&key], &replacement));
        forget(&mut map, &key, &replacement);
        assert!(map.is_empty());
        // Forgetting what is not there is nothing.
        forget(&mut map, &key, &replacement);
        assert!(map.is_empty());
    }

    /// A certificate made by `openssl req -x509 -newkey ec -pkeyopt
    /// ec_paramgen_curve:P-256` (its key discarded; it expired the day
    /// after it was made, 2026-10-11), and the pin printed for it by the
    /// exact pipeline the operator runs:
    ///
    /// ```text
    /// openssl x509 -in c.pem -pubkey -noout | openssl pkey -pubin -outform der \
    ///   | openssl dgst -sha256 -binary | base64
    /// ```
    ///
    /// So the pin this computes is the one the bundle will carry.
    const OPENSSL_CERT: &str = "MIIBjjCCATOgAwIBAgIUNtXwxljPP3nsRc8oxNkEqJFjzzAwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRcmVsYXktdGVzdC12ZWN0b3IwHhcNMjYxMDEwMTU0NzI4WhcNMjYxMDExMTU0NzI4WjAcMRowGAYDVQQDDBFyZWxheS10ZXN0LXZlY3RvcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAtnsaWQkpCObRByRPiHFESBJTs0QkBQHZSyLK6u6Jfl7TRE5c9WzoqcrSQ7Kp5QNNtfBKga2TXpX1PuC3VXXDCjUzBRMB0GA1UdDgQWBBRMIlrvJsovTwBx3kNJdaQ1CwwxWTAfBgNVHSMEGDAWgBRMIlrvJsovTwBx3kNJdaQ1CwwxWTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCUQsxs+2gDtCzA6pOQoRbm2oHOTUefKZ/h1khgqdxYjgIhAK4Usi8ZjYGdrru602L8VHzg+3t8ZpWjQLa2dB3+XgLs";
    const OPENSSL_PIN: &str = "sha256/3rjtrrC7NzphMMzn3VhX0dR33yywpjyXxQ+bHhx4FFo=";

    #[test]
    fn computes_the_pin_openssl_prints() {
        let der = base64::engine::general_purpose::STANDARD.decode(OPENSSL_CERT).unwrap();
        let digest = spki_sha256(&CertificateDer::from(der)).expect("a parseable certificate");
        assert_eq!(pin_of(&digest), OPENSSL_PIN);
        assert_eq!(parse_pins(&[OPENSSL_PIN.to_string()]), Ok(vec![digest]));
    }

    // ---- A test relay -----------------------------------------------

    /// DER: a tag, a length, the contents.
    fn der(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
        let content = parts.concat();
        let mut out = vec![tag];
        match content.len() {
            len if len < 0x80 => out.push(len as u8),
            len if len <= 0xff => out.extend_from_slice(&[0x81, len as u8]),
            len => out.extend_from_slice(&[0x82, (len >> 8) as u8, len as u8]),
        }
        out.extend_from_slice(&content);
        out
    }

    const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
    const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
    const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];

    /// A fresh P-256 key, generated for one test and never written down.
    struct TestKey {
        pkcs8: Vec<u8>,
        pair: EcdsaKeyPair,
    }

    impl TestKey {
        fn fresh() -> Self {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap().as_ref().to_vec();
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &pkcs8, &rng).unwrap();
            TestKey { pkcs8, pair }
        }

        /// Its SubjectPublicKeyInfo, encoded here rather than read back by
        /// the code under test, so the pin below is computed independently.
        fn spki(&self) -> Vec<u8> {
            let algorithm = der(0x30, &[&der(0x06, &[OID_EC_PUBLIC_KEY]), &der(0x06, &[OID_P256])]);
            der(0x30, &[&algorithm, &der(0x03, &[&[0u8], self.pair.public_key().as_ref()])])
        }

        fn pin(&self) -> String {
            let digest = ring::digest::digest(&ring::digest::SHA256, &self.spki());
            pin_of(digest.as_ref().try_into().unwrap())
        }

        /// A self-signed v3 certificate for this key -- and an expired
        /// one, valid only during 2000, because the relay must not care.
        fn certificate(&self) -> CertificateDer<'static> {
            let rng = SystemRandom::new();
            let algorithm = der(0x30, &[&der(0x06, &[OID_ECDSA_SHA256])]);
            let name = der(0x30, &[&der(0x31, &[&der(0x30, &[&der(0x06, &[OID_COMMON_NAME]), &der(0x0c, &[b"relay test only"])])])]);
            let validity = der(0x30, &[&der(0x17, &[b"000101000000Z"]), &der(0x17, &[b"010101000000Z"])]);
            let tbs = der(
                0x30,
                &[
                    &der(0xa0, &[&der(0x02, &[&[2u8]])]),
                    &der(0x02, &[&[0x01u8, 0x23, 0x45, 0x67]]),
                    &algorithm,
                    &name,
                    &validity,
                    &name,
                    &self.spki(),
                ],
            );
            let signature = self.pair.sign(&rng, &tbs).unwrap();
            CertificateDer::from(der(0x30, &[&tbs, &algorithm, &der(0x03, &[&[0u8], signature.as_ref()])]))
        }

        fn private_key(&self) -> PrivateKeyDer<'static> {
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.pkcs8.clone()))
        }
    }

    #[derive(Debug, Default, Clone)]
    struct SeenRequest {
        method: String,
        target: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl SeenRequest {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
        }
    }

    /// What the test relay saw.
    #[derive(Debug, Default)]
    struct Seen {
        /// The SNI of each ClientHello; `None` when there was none.
        sni: Vec<Option<String>>,
        /// The ALPN protocols each ClientHello offered.
        alpn: Vec<Vec<String>>,
        connections: usize,
        requests: Vec<SeenRequest>,
    }

    /// Hands out the one certificate, noting what each ClientHello said.
    #[derive(Debug)]
    struct Recorder {
        certified: Arc<CertifiedKey>,
        seen: Arc<Mutex<Seen>>,
    }

    impl ResolvesServerCert for Recorder {
        fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
            let mut seen = self.seen.lock().unwrap();
            seen.sni.push(hello.server_name().map(str::to_owned));
            let offered = hello
                .alpn()
                .map(|offered| offered.map(|p| String::from_utf8_lossy(p).into_owned()).collect())
                .unwrap_or_default();
            seen.alpn.push(offered);
            Some(Arc::clone(&self.certified))
        }
    }

    /// A server config presenting `cert`, signing with `signer`. The two
    /// are normally the same key; `serves_a_copied_certificate...` makes
    /// them differ, which `CertifiedKey::new` allows on purpose.
    fn server_config(
        cert: CertificateDer<'static>,
        signer: &TestKey,
        versions: &[&'static rustls::SupportedProtocolVersion],
        alpn: &[&[u8]],
        seen: Arc<Mutex<Seen>>,
    ) -> Arc<ServerConfig> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let signing = provider.key_provider.load_private_key(signer.private_key()).unwrap();
        let certified = Arc::new(CertifiedKey::new(vec![cert], signing));
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Recorder { certified, seen }));
        config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
        Arc::new(config)
    }

    /// What the test relay does with one request.
    enum Step {
        /// Writes these bytes back.
        Answer(Vec<u8>),
        /// Reads the request and closes the connection without a word --
        /// what a box does that timed the connection out as it arrived.
        HangUp,
    }

    /// An HTTP/1.1 relay on 127.0.0.1 with a fresh key, following a
    /// script: one list of steps per connection, connections in order.
    struct TestRelay {
        base: String,
        pin: String,
        seen: Arc<Mutex<Seen>>,
        thread: JoinHandle<TcpListener>,
    }

    impl TestRelay {
        fn start(script: Vec<Vec<Step>>) -> Self {
            let key = TestKey::fresh();
            Self::start_with(key.certificate(), &key, &[&rustls::version::TLS13], script)
        }

        fn start_with(
            cert: CertificateDer<'static>,
            signer: &TestKey,
            versions: &[&'static rustls::SupportedProtocolVersion],
            script: Vec<Vec<Step>>,
        ) -> Self {
            let seen = Arc::new(Mutex::new(Seen::default()));
            // HTTP/1.1 only here; HTTP/2 has a test of its own below.
            let config = server_config(cert.clone(), signer, versions, &[b"http/1.1"], Arc::clone(&seen));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let thread_seen = Arc::clone(&seen);
            let thread = std::thread::spawn(move || {
                for steps in script {
                    let Some(tcp) = accept_within(&listener, Duration::from_secs(10)) else {
                        break;
                    };
                    thread_seen.lock().unwrap().connections += 1;
                    serve_connection(tcp, &config, steps, &thread_seen);
                }
                listener
            });
            let digest = spki_sha256(&cert).unwrap();
            TestRelay { base: format!("https://127.0.0.1:{port}/api"), pin: pin_of(&digest), seen, thread }
        }

        /// What the relay saw once its script is done, and whether yet
        /// another connection was waiting that the script had no use for.
        fn finish(self) -> (Seen, bool) {
            let listener = self.thread.join().unwrap();
            listener.set_nonblocking(true).unwrap();
            let another = listener.accept().is_ok();
            let seen = std::mem::take(&mut *self.seen.lock().unwrap());
            (seen, another)
        }

        fn call(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<RelayResponse, RelayError> {
            self.call_pinned(vec![self.pin.clone()], method, path, headers, body)
        }

        fn call_pinned(
            &self,
            pins: Vec<String>,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<&str>,
        ) -> Result<RelayResponse, RelayError> {
            tauri::async_runtime::block_on(relay_request(
                self.base.clone(),
                pins,
                method.to_string(),
                path.to_string(),
                Some(header_set(headers)),
                body.map(str::to_string),
                5_000,
            ))
        }
    }

    fn accept_within(listener: &TcpListener, limit: Duration) -> Option<TcpStream> {
        listener.set_nonblocking(true).ok()?;
        let until = Instant::now() + limit;
        while Instant::now() < until {
            if let Ok((tcp, _)) = listener.accept() {
                tcp.set_nonblocking(false).ok()?;
                return Some(tcp);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    fn serve_connection(tcp: TcpStream, config: &Arc<ServerConfig>, steps: Vec<Step>, seen: &Mutex<Seen>) {
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
        let conn = ServerConnection::new(Arc::clone(config)).unwrap();
        let mut reader = BufReader::new(StreamOwned::new(conn, tcp));
        for step in steps {
            let Some(request) = read_request(&mut reader) else {
                break;
            };
            seen.lock().unwrap().requests.push(request);
            match step {
                Step::Answer(bytes) => {
                    let stream = reader.get_mut();
                    if stream.write_all(&bytes).and_then(|()| stream.flush()).is_err() {
                        break;
                    }
                }
                Step::HangUp => break,
            }
        }
        let stream = reader.get_mut();
        stream.conn.send_close_notify();
        let _ = stream.flush();
    }

    /// One HTTP/1.1 request, head and Content-Length body.
    fn read_request(reader: &mut impl BufRead) -> Option<SeenRequest> {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let mut parts = line.trim_end().splitn(3, ' ');
        let method = parts.next()?.to_string();
        let target = parts.next()?.to_string();
        let mut headers = Vec::new();
        let mut length = 0;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).ok()?;
            let header = header.trim_end_matches(['\r', '\n']);
            if header.is_empty() {
                break;
            }
            let (name, value) = header.split_once(':')?;
            let (name, value) = (name.trim().to_ascii_lowercase(), value.trim().to_string());
            if name == "content-length" {
                length = value.parse().ok()?;
            }
            headers.push((name, value));
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).ok()?;
        Some(SeenRequest { method, target, headers, body })
    }

    /// An HTTP/1.1 response with a Content-Length.
    fn http(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        [head.as_bytes(), body].concat()
    }

    /// The same, chunked, so the size is only known as it arrives.
    fn http_chunked(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nTransfer-Encoding: chunked\r\n").into_bytes();
        for (name, value) in headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        for chunk in body.chunks(16 * 1024) {
            out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            out.extend_from_slice(chunk);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    const JSON: (&str, &str) = ("Content-Type", "application/json");

    // ---- End to end -------------------------------------------------

    #[test]
    fn answers_through_the_right_pin_with_no_sni() {
        let relay = TestRelay::start(vec![
            vec![Step::Answer(http("200 OK", &[JSON, ("ETag", "W/\"42\"")], b"{\"status\":\"ok\"}"))],
            // The control's handshake, below.
            vec![Step::HangUp],
        ]);
        let answer = relay.call("GET", "/health", &[], None).unwrap();

        // Control: a client that does send a name is seen sending it, so
        // the `None` below is the relay client's doing and not something
        // this test relay cannot see.
        let address = parse_base(&relay.base).unwrap();
        let mut config = pinned_tls_config(parse_pins(&[relay.pin.clone()]).unwrap(), Arc::default());
        config.enable_sni = true;
        let mut control = rustls::ClientConnection::new(Arc::new(config), ServerName::try_from("relay.example").unwrap()).unwrap();
        let mut tcp = TcpStream::connect(address).unwrap();
        while control.is_handshaking() {
            control.complete_io(&mut tcp).unwrap();
        }
        control.send_close_notify();
        let _ = control.complete_io(&mut tcp);

        let (seen, another) = relay.finish();
        assert_eq!(
            answer,
            RelayResponse {
                status: 200,
                content_type: "application/json".into(),
                etag: Some("W/\"42\"".into()),
                body: "{\"status\":\"ok\"}".into(),
            },
        );
        // No name at all in the relay client's ClientHello; the control's
        // name in the control's.
        assert_eq!(seen.sni, vec![None, Some("relay.example".to_string())]);
        // HTTP/2 offered first.
        assert_eq!(seen.alpn[0], vec!["h2".to_string(), "http/1.1".to_string()]);
        assert_eq!(seen.requests.len(), 1);
        let request = &seen.requests[0];
        assert_eq!((request.method.as_str(), request.target.as_str()), ("GET", "/api/health"));
        assert!(!another);
    }

    #[test]
    fn any_one_of_the_pins_will_do() {
        let relay = TestRelay::start(vec![vec![Step::Answer(http("200 OK", &[JSON], b"{}"))]]);
        let standby = pin_of(&[9; 32]);
        let answer = relay.call_pinned(vec![standby, relay.pin.clone()], "GET", "/health", &[], None);
        assert_eq!(answer.map(|a| a.status), Ok(200));
        relay.finish();
    }

    #[test]
    fn refuses_a_server_whose_key_is_not_pinned() {
        let relay = TestRelay::start(vec![vec![Step::Answer(http("200 OK", &[JSON], b"{}"))]]);
        let others = vec![pin_of(&[1; 32]), TestKey::fresh().pin()];
        let answer = relay.call_pinned(others, "GET", "/health", &[], None);
        let (seen, _) = relay.finish();
        assert_eq!(answer, Err(RelayError::PinMismatch));
        assert!(seen.requests.is_empty(), "a request went out to an unpinned server: {seen:?}");
    }

    /// The certificate is the real relay's -- its key pinned -- but the
    /// server holds a different private key, as anyone who copied the
    /// certificate off the box would. The pin matches; the handshake
    /// signature cannot, and that alone must refuse it.
    #[test]
    fn refuses_a_copied_certificate_without_its_key() {
        let real = TestKey::fresh();
        let impostor = TestKey::fresh();
        let relay = TestRelay::start_with(
            real.certificate(),
            &impostor,
            &[&rustls::version::TLS13],
            vec![vec![Step::Answer(http("200 OK", &[JSON], b"{}"))]],
        );
        assert_eq!(relay.pin, real.pin());
        let answer = relay.call("GET", "/health", &[], None);
        let (seen, _) = relay.finish();
        assert_eq!(answer, Err(RelayError::Tls));
        assert!(seen.requests.is_empty(), "{seen:?}");
    }

    #[test]
    fn refuses_a_server_that_only_speaks_tls_1_2() {
        let key = TestKey::fresh();
        let relay = TestRelay::start_with(
            key.certificate(),
            &key,
            &[&rustls::version::TLS12],
            vec![vec![Step::Answer(http("200 OK", &[JSON], b"{}"))]],
        );
        assert_eq!(relay.call("GET", "/health", &[], None), Err(RelayError::Tls));
        relay.finish();
    }

    #[test]
    fn returns_a_redirect_without_following_it() {
        // To this same relay, so a client that followed it would come back
        // here on a new connection -- and wait for an answer that never
        // comes, rather than return the 302.
        let relay = TestRelay::start(vec![vec![Step::Answer(http("302 Found", &[("Location", "/api/elsewhere")], b""))]]);
        let answer = relay.call("GET", "/health", &[], None);
        let (seen, another) = relay.finish();
        assert_eq!(answer.map(|a| (a.status, a.body)), Ok((302, String::new())));
        assert_eq!(seen.requests.len(), 1, "{seen:?}");
        assert!(!another);
    }

    #[test]
    fn sends_the_forwarded_headers_and_nothing_it_was_told_to_drop() {
        let relay = TestRelay::start(vec![vec![Step::Answer(http("200 OK", &[JSON], b"{}"))]]);
        let port = relay.base.trim_start_matches("https://127.0.0.1:").trim_end_matches("/api").to_string();
        let answer = relay.call(
            "POST",
            "/customer-auth/refresh",
            &[
                ("Content-Type", "application/json"),
                ("X-Neoxify-Device-Platform", "windows"),
                ("Host", "connect.example.com"),
                ("Cookie", "session=1"),
                ("X-Forwarded-For", "203.0.113.5"),
                ("Accept-Encoding", "br"),
            ],
            Some("{\"refreshToken\":\"r\"}"),
        );
        let (seen, _) = relay.finish();
        assert_eq!(answer.map(|a| a.status), Ok(200));
        let request = &seen.requests[0];
        assert_eq!((request.method.as_str(), request.target.as_str()), ("POST", "/api/customer-auth/refresh"));
        assert_eq!(request.body, b"{\"refreshToken\":\"r\"}");
        assert_eq!(request.header("host"), Some(format!("127.0.0.1:{port}").as_str()));
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(request.header("x-neoxify-device-platform"), Some("windows"));
        assert_eq!(request.header("accept-encoding"), Some("gzip"));
        assert_eq!(request.header("user-agent"), Some(USER_AGENT));
        for dropped in ["cookie", "x-forwarded-for", "origin", "authorization"] {
            assert_eq!(request.header(dropped), None, "{dropped}");
        }
        assert_eq!(request.headers.iter().filter(|(n, _)| n == "host").count(), 1);
    }

    #[test]
    fn inflates_a_gzip_answer() {
        let json = format!("{{\"routes\":[{}]}}", vec!["{\"id\":\"x\"}"; 2_000].join(","));
        let relay = TestRelay::start(vec![vec![Step::Answer(http(
            "200 OK",
            &[JSON, ("Content-Encoding", "gzip")],
            &gzip(json.as_bytes()),
        ))]]);
        let answer = relay.call("GET", &format!("/customer/subscriptions/{SUBSCRIPTION}/routes"), &[], None);
        let (seen, _) = relay.finish();
        assert_eq!(answer.map(|a| a.body), Ok(json));
        assert_eq!(seen.requests[0].header("accept-encoding"), Some("gzip"));
    }

    #[test]
    fn takes_a_body_of_exactly_the_limit() {
        let body = "x".repeat(MAX_RESPONSE_BODY);
        let relay = TestRelay::start(vec![
            vec![Step::Answer(http("200 OK", &[], body.as_bytes()))],
            vec![Step::Answer(http("200 OK", &[("Content-Encoding", "gzip")], &gzip(body.as_bytes())))],
        ]);
        assert_eq!(relay.call("GET", "/endpoints/bundle", &[], None).map(|a| a.body.len()), Ok(MAX_RESPONSE_BODY));
        // A fresh connection for the second: the first closed after its answer.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(relay.call("GET", "/endpoints/bundle2", &[], None).map(|a| a.body.len()), Ok(MAX_RESPONSE_BODY));
        relay.finish();
    }

    #[test]
    fn refuses_an_answer_over_the_limit_however_it_comes() {
        let over = vec![b'x'; MAX_RESPONSE_BODY + 1];
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("declared", http("200 OK", &[], &over)),
            ("chunked", http_chunked("200 OK", &[], &over)),
            // A few hundred bytes that inflate past the limit.
            ("inflated", http("200 OK", &[("Content-Encoding", "gzip")], &gzip(&over))),
        ];
        for (name, response) in cases {
            let relay = TestRelay::start(vec![vec![Step::Answer(response)]]);
            assert_eq!(relay.call("GET", "/endpoints/bundle", &[], None), Err(RelayError::TooLarge), "{name}");
            relay.finish();
        }
    }

    #[test]
    fn refuses_an_answer_it_cannot_read() {
        let cases: Vec<(&str, Vec<u8>, RelayError)> = vec![
            ("not utf-8", http("200 OK", &[], &[0xff, 0xfe, 0x00]), RelayError::NotUtf8),
            ("not gzip", http("200 OK", &[("Content-Encoding", "gzip")], b"plain"), RelayError::BadResponse),
            ("brotli", http("200 OK", &[("Content-Encoding", "br")], b"x"), RelayError::BadResponse),
            (
                "gzip twice",
                http("200 OK", &[("Content-Encoding", "gzip"), ("Content-Encoding", "gzip")], &gzip(&gzip(b"{}"))),
                RelayError::BadResponse,
            ),
        ];
        for (name, response, expected) in cases {
            let relay = TestRelay::start(vec![vec![Step::Answer(response)]]);
            assert_eq!(relay.call("GET", "/health", &[], None), Err(expected), "{name}");
            relay.finish();
        }
    }

    /// Inflating stops one byte past the limit rather than running to the
    /// end and then measuring, which is what keeps a small body that
    /// inflates to gigabytes from being held in memory. Shown by damage
    /// placed past the limit: a missing gzip trailer is found only by a
    /// reader that gets to the end, so stopping early says "too large"
    /// where reading everything would say "unreadable".
    #[test]
    fn stops_inflating_at_the_limit() {
        let mut bomb = gzip(&vec![0; MAX_RESPONSE_BODY * 8]);
        bomb.truncate(bomb.len() - 8);
        // Two megabytes of zeros, in about two kilobytes.
        assert!(bomb.len() < 4 * 1024, "{}", bomb.len());
        assert_eq!(inflate(&bomb), Err(RelayError::TooLarge));
        // The same damage inside the limit is found.
        let mut small = gzip(b"{}");
        small.truncate(small.len() - 8);
        assert_eq!(inflate(&small), Err(RelayError::BadResponse));
        assert_eq!(inflate(&gzip(b"{}")), Ok(b"{}".to_vec()));
    }

    /// The box closes a pooled connection just as a GET goes out on it.
    /// The GET is asked once more, on a new connection, and the caller
    /// sees only the answer.
    #[test]
    fn asks_a_get_again_when_a_reused_connection_dies() {
        let relay = TestRelay::start(vec![
            vec![Step::Answer(http("200 OK", &[JSON], b"\"first\"")), Step::HangUp],
            vec![Step::Answer(http("200 OK", &[JSON], b"\"second\""))],
        ]);
        assert_eq!(relay.call("GET", "/customer/me", &[], None).map(|a| a.body), Ok("\"first\"".into()));
        // Time for the connection to go back into the pool.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(relay.call("GET", "/customer/me", &[], None).map(|a| a.body), Ok("\"second\"".into()));
        let (seen, another) = relay.finish();
        assert_eq!(seen.connections, 2);
        assert_eq!(seen.requests.iter().map(|r| r.target.as_str()).collect::<Vec<_>>(), ["/api/customer/me"; 3]);
        assert!(!another, "asked more than once more");
    }

    /// The same failure for a POST is reported, not retried: the box may
    /// have passed the first one on.
    #[test]
    fn never_asks_a_post_again() {
        let relay = TestRelay::start(vec![vec![
            Step::Answer(http("200 OK", &[JSON], b"{}")),
            Step::HangUp,
        ]]);
        let challenge = |relay: &TestRelay| relay.call("POST", "/login-challenge", &[JSON], Some("{\"scope\":\"login\"}"));
        assert_eq!(challenge(&relay).map(|a| a.status), Ok(200));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(challenge(&relay), Err(RelayError::Network));
        // Long enough for a retry's connection to have arrived.
        std::thread::sleep(Duration::from_millis(300));
        let (seen, another) = relay.finish();
        assert_eq!(seen.connections, 1);
        assert_eq!(seen.requests.len(), 2);
        assert!(!another, "the POST was sent again");
    }

    /// A GET whose connection is new and dies is not a stale pooled
    /// connection, and is reported as it is.
    #[test]
    fn does_not_ask_again_when_a_new_connection_dies() {
        let relay = TestRelay::start(vec![vec![Step::HangUp]]);
        assert_eq!(relay.call("GET", "/customer/me", &[], None), Err(RelayError::Network));
        std::thread::sleep(Duration::from_millis(300));
        let (seen, another) = relay.finish();
        assert_eq!(seen.requests.len(), 1);
        assert!(!another, "a GET on a fresh connection was retried");
    }

    /// The same, for a new connection that follows an earlier one to the
    /// same relay. That is where a resumed TLS session would skip the
    /// verifier -- and with it the handshake count `attempt` reads -- and
    /// make a new connection look like a reused one.
    #[test]
    fn a_second_connection_is_new_too() {
        let relay = TestRelay::start(vec![
            vec![Step::Answer(http("200 OK", &[JSON, ("Connection", "close")], b"{}"))],
            vec![Step::HangUp],
        ]);
        assert_eq!(relay.call("GET", "/customer/me", &[], None).map(|a| a.status), Ok(200));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(relay.call("GET", "/customer/me", &[], None), Err(RelayError::Network));
        std::thread::sleep(Duration::from_millis(300));
        let (seen, another) = relay.finish();
        assert_eq!((seen.connections, seen.requests.len()), (2, 2));
        // Both connections showed their certificate.
        assert_eq!(seen.sni.len(), 2);
        assert!(!another, "a GET on a fresh connection was retried");
    }

    #[test]
    fn opens_no_connection_for_a_call_it_refuses() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("https://127.0.0.1:{}/api", listener.local_addr().unwrap().port());
        let pin = pin_of(&[3; 32]);
        let call = |pins: Vec<String>, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>| {
            tauri::async_runtime::block_on(relay_request(
                base.clone(),
                pins,
                method.into(),
                path.into(),
                Some(header_set(headers)),
                body.map(str::to_string),
                2_000,
            ))
        };
        assert_eq!(call(vec![pin.clone()], "DELETE", "/customer/me", &[], None), Err(RelayError::RefusedPath));
        assert_eq!(call(vec![pin.clone()], "GET", "/health?x=1", &[], None), Err(RelayError::RefusedPath));
        assert_eq!(call(vec![], "GET", "/health", &[], None), Err(RelayError::BadPins));
        assert_eq!(call(vec![pin.clone()], "GET", "/health", &[("Authorization", "a\r\nb")], None), Err(RelayError::BadRequest));
        let big = "x".repeat(MAX_REQUEST_BODY + 1);
        assert_eq!(call(vec![pin.clone()], "POST", "/customer-auth/login", &[], Some(&big)), Err(RelayError::TooLarge));
        assert_eq!(
            tauri::async_runtime::block_on(relay_request(
                base.replace("127.0.0.1", "127.0.0.01"),
                vec![pin],
                "GET".into(),
                "/health".into(),
                None,
                None,
                2_000,
            )),
            Err(RelayError::BadBase),
        );
        assert_eq!(listener.accept().map(|_| ()).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }

    /// Accepts TCP and never says a word: the caller's time runs out
    /// first when it is short, and the connect timeout when it is not.
    fn silent_listener() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let base = format!("https://127.0.0.1:{}/api", listener.local_addr().unwrap().port());
        let thread = std::thread::spawn(move || {
            if let Some(tcp) = accept_within(&listener, Duration::from_secs(10)) {
                std::thread::sleep(CONNECT_TIMEOUT + Duration::from_secs(2));
                drop(tcp);
            }
        });
        (base, thread)
    }

    #[test]
    fn gives_up_at_the_callers_time() {
        let (base, _thread) = silent_listener();
        let started = Instant::now();
        let answer = tauri::async_runtime::block_on(relay_request(
            base,
            vec![pin_of(&[4; 32])],
            "GET".into(),
            "/health".into(),
            None,
            None,
            500,
        ));
        assert_eq!(answer, Err(RelayError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[test]
    fn gives_up_on_a_handshake_at_the_connect_timeout() {
        let (base, _thread) = silent_listener();
        let started = Instant::now();
        let answer = tauri::async_runtime::block_on(relay_request(
            base,
            vec![pin_of(&[5; 32])],
            "GET".into(),
            "/health".into(),
            None,
            None,
            60_000,
        ));
        assert_eq!(answer, Err(RelayError::ConnectTimeout));
        let took = started.elapsed();
        assert!(took >= CONNECT_TIMEOUT - Duration::from_millis(100) && took < CONNECT_TIMEOUT + Duration::from_secs(2), "{took:?}");
    }

    /// An HTTP/2 relay on 127.0.0.1, which is what the box is: TLS 1.3,
    /// h2 by ALPN, one connection shared by every call. Each answer's body
    /// names the connection that gave it, counting from 1.
    ///
    /// Its first connection answers `first_connection_answers` requests
    /// (every one, when `None`) and then goes silent: it takes the next
    /// request and from then on neither answers it nor reads another
    /// frame, PINGs included, while holding the connection open. That is
    /// a flow a middlebox has stopped forwarding, or one a phone left
    /// behind on another network, seen from the client's end -- nothing
    /// arrives, and nothing says so. Every later connection answers
    /// everything.
    struct H2Relay {
        base: String,
        pin: String,
        seen: Arc<Mutex<Seen>>,
        negotiated: Arc<Mutex<Vec<Option<Vec<u8>>>>>,
    }

    impl H2Relay {
        fn start(first_connection_answers: Option<usize>) -> Self {
            let key = TestKey::fresh();
            let seen = Arc::new(Mutex::new(Seen::default()));
            let config = server_config(key.certificate(), &key, &[&rustls::version::TLS13], &[b"h2", b"http/1.1"], Arc::clone(&seen));
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("https://127.0.0.1:{}/api", listener.local_addr().unwrap().port());
            let negotiated: Arc<Mutex<Vec<Option<Vec<u8>>>>> = Arc::default();
            let server_negotiated = Arc::clone(&negotiated);
            let server_seen = Arc::clone(&seen);
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let acceptor = tokio_rustls::TlsAcceptor::from(config);
                let mut silent_after = first_connection_answers;
                loop {
                    let Ok((tcp, _)) = listener.accept().await else { return };
                    let index = {
                        let mut seen = server_seen.lock().unwrap();
                        seen.connections += 1;
                        seen.connections
                    };
                    // Only the first connection ever goes silent.
                    let silent_after = silent_after.take();
                    let Ok(tls) = acceptor.accept(tcp).await else { continue };
                    server_negotiated.lock().unwrap().push(tls.get_ref().1.alpn_protocol().map(<[u8]>::to_vec));
                    let seen = Arc::clone(&server_seen);
                    tauri::async_runtime::spawn(async move {
                        let Ok(mut connection) = h2::server::handshake(tls).await else { return };
                        let mut answered = 0;
                        while let Some(Ok((request, mut respond))) = connection.accept().await {
                            seen.lock().unwrap().requests.push(SeenRequest {
                                method: request.method().to_string(),
                                target: request.uri().path().to_string(),
                                ..Default::default()
                            });
                            if silent_after == Some(answered) {
                                // Neither the connection nor the stream is
                                // polled again, and neither is dropped,
                                // which would reset or close it: the test
                                // process ends first.
                                std::future::pending::<()>().await;
                            }
                            answered += 1;
                            let head = http::Response::builder().status(200).header("content-type", "application/json").body(()).unwrap();
                            let Ok(mut body) = respond.send_response(head, false) else { return };
                            let _ = body.send_data(bytes::Bytes::from(format!("{{\"connection\":{index}}}")), true);
                        }
                    });
                }
            });
            let pin = pin_of(&spki_sha256(&key.certificate()).unwrap());
            H2Relay { base, pin, seen, negotiated }
        }

        fn call(&self, method: &str, path: &str, body: Option<&str>, timeout_ms: u64) -> Result<RelayResponse, RelayError> {
            tauri::async_runtime::block_on(relay_request(
                self.base.clone(),
                vec![self.pin.clone()],
                method.into(),
                path.into(),
                None,
                body.map(str::to_string),
                timeout_ms,
            ))
        }

        fn targets(&self) -> Vec<String> {
            self.seen.lock().unwrap().requests.iter().map(|r| format!("{} {}", r.method, r.target)).collect()
        }
    }

    fn from_connection(n: usize) -> String {
        format!("{{\"connection\":{n}}}")
    }

    /// The box speaks HTTP/2, and that is what is used: one connection,
    /// negotiated by ALPN, carrying every call -- the pooled client is
    /// one per relay, not one per call.
    #[test]
    fn speaks_http2_and_keeps_one_connection_for_every_call() {
        let relay = H2Relay::start(None);
        for _ in 0..3 {
            let answer = relay.call("GET", "/customer/subscriptions", None, 5_000);
            assert_eq!(answer.map(|a| (a.status, a.body)), Ok((200, from_connection(1))));
        }
        assert_eq!(*relay.negotiated.lock().unwrap(), vec![Some(b"h2".to_vec())]);
        let seen = relay.seen.lock().unwrap();
        assert_eq!(seen.connections, 1, "{seen:?}");
        assert_eq!(seen.requests.len(), 3);
        assert_eq!(seen.sni, vec![None]);
    }

    /// The shared connection goes silent between two calls, with no
    /// reset to say so. The next GET on it does not spend its whole time
    /// waiting: a PING goes unanswered, the connection is given up, and
    /// the GET is asked again on a new one -- and the call after that
    /// does not go back to the dead one.
    #[test]
    fn asks_a_get_again_when_a_reused_connection_goes_silent() {
        let relay = H2Relay::start(Some(1));
        assert_eq!(relay.call("GET", "/customer/me", None, 5_000).map(|a| a.body), Ok(from_connection(1)));
        let started = Instant::now();
        let answer = relay.call("GET", "/customer/subscriptions", None, 15_000);
        let took = started.elapsed();
        assert_eq!(answer.map(|a| a.body), Ok(from_connection(2)));
        // Given up on within one PING interval and one PING timeout, plus
        // the new connection's handshake; not at the end of the call's time.
        assert!(took < KEEP_ALIVE_INTERVAL + KEEP_ALIVE_TIMEOUT + Duration::from_secs(2), "{took:?}");
        assert_eq!(relay.call("GET", "/customer/me", None, 5_000).map(|a| a.body), Ok(from_connection(2)));
        assert_eq!(relay.seen.lock().unwrap().connections, 2);
        assert_eq!(
            relay.targets(),
            [
                "GET /api/customer/me",
                "GET /api/customer/subscriptions",
                "GET /api/customer/subscriptions",
                "GET /api/customer/me"
            ],
        );
    }

    /// The same silence under a POST is reported as the connection's
    /// failure, not as the caller's time running out, and the POST is not
    /// asked again: the box has it, and may have passed it on. The dead
    /// connection is not used for the call after.
    #[test]
    fn never_asks_a_post_again_on_a_connection_gone_silent() {
        let relay = H2Relay::start(Some(1));
        assert_eq!(relay.call("GET", "/customer/me", None, 5_000).map(|a| a.body), Ok(from_connection(1)));
        let started = Instant::now();
        assert_eq!(relay.call("POST", "/login-challenge", Some("{\"scope\":\"login\"}"), 15_000), Err(RelayError::Network));
        assert!(started.elapsed() < KEEP_ALIVE_INTERVAL + KEEP_ALIVE_TIMEOUT + Duration::from_secs(2), "{:?}", started.elapsed());
        assert_eq!(relay.call("GET", "/customer/me", None, 5_000).map(|a| a.body), Ok(from_connection(2)));
        assert_eq!(relay.seen.lock().unwrap().connections, 2);
        assert_eq!(relay.targets(), ["GET /api/customer/me", "POST /api/login-challenge", "GET /api/customer/me"]);
    }

    /// A call whose own time runs out before any PING has gone unanswered
    /// still leaves its connection in doubt, and the next call dials a new
    /// one rather than wait on it. With a budget shorter than the PING
    /// interval plus its timeout, waiting would mean failing too.
    #[test]
    fn a_call_that_ran_out_of_time_leaves_its_connection_behind() {
        let relay = H2Relay::start(Some(1));
        assert_eq!(relay.call("GET", "/customer/me", None, 5_000).map(|a| a.body), Ok(from_connection(1)));
        // Over before the first PING is even due.
        assert!(Duration::from_millis(800) < KEEP_ALIVE_INTERVAL);
        assert_eq!(relay.call("GET", "/customer/me", None, 800), Err(RelayError::Timeout));
        assert_eq!(relay.call("GET", "/customer/me", None, 2_000).map(|a| a.body), Ok(from_connection(2)));
        assert_eq!(relay.seen.lock().unwrap().connections, 2);
    }
}
