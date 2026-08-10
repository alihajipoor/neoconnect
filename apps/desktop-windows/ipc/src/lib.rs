//! Wire contract between the Neoxify desktop app and its privileged
//! helper service, plus the validation every field must survive before
//! the service will act on it.
//!
//! # Why validation lives here
//!
//! The service runs as LocalSystem. Anything it writes into an engine
//! config file is therefore attacker-interesting: an OpenVPN `.ovpn`
//! supports `up`/`down` script directives, so a single unescaped newline
//! in a value like `endpoint` would be arbitrary command execution as
//! SYSTEM. The types below are deliberately the *only* way to ask the
//! service to do anything, and [`ConnectProfile::validate`] is called on
//! the service side before any file is written -- never trusting that
//! the caller already checked, because the caller is just whoever
//! managed to open the pipe.
//!
//! Note what is *not* in this protocol: any executable path, engine
//! name, or command line. The service resolves engine binaries from its
//! own installation directory only. A client that is fully compromised
//! can still only ask for "connect me with these credentials", never
//! "run this program as SYSTEM".

use serde::{Deserialize, Serialize};

/// Name of the named pipe the service listens on. Shared so the two
/// sides can't disagree about it.
pub const PIPE_NAME: &str = r"\\.\pipe\neoconnect-service";

/// Requests the app can make of the service. One JSON object per line.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    /// Tear down whatever is currently up (if anything), then bring up
    /// this profile. Deliberately not "connect only if disconnected" --
    /// switching servers is a normal action and the service owning the
    /// teardown ordering is more reliable than the UI sequencing it.
    Connect { profile: ConnectProfile },
    Disconnect,
    Status,
    /// Replaces the Custom-mode selection: which applications, if any,
    /// are the only ones whose traffic goes through the tunnel.
    ///
    /// Separate from `Connect` so the customer can change their mind
    /// without dropping a live session, and sent on connect as well so
    /// the service never has to assume a previous setting survived a
    /// restart.
    SetSplitTunnel { config: SplitTunnelConfig },
    /// Asks the service to prove the tunnel is carrying traffic, using a
    /// socket pinned to it exactly as a selected app's traffic is.
    ///
    /// Needed because the app's own egress check cannot answer this once
    /// Custom mode is on: the app is not a selected app, so its request
    /// correctly leaves by the ordinary route and correctly reports the
    /// tunnel as bypassed.
    ProbeSplitTunnel,
}

/// Custom mode, as the app expresses it.
///
/// `enabled` and an empty `apps` is a real, reachable state -- the
/// customer turned the toggle on and has not chosen anything yet. It
/// must not be read as "tunnel everything": that is the opposite of what
/// the toggle promises, and it would arrive as a surprise full tunnel.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitTunnelConfig {
    pub enabled: bool,
    /// Absolute paths to executables. Paths rather than process names,
    /// because a name matches whatever happens to be called that, and
    /// paths rather than process ids, because a modern application is
    /// several processes and the set changes while it runs.
    pub apps: Vec<String>,
}

/// The most applications one customer can select.
///
/// Not a technical limit -- matching is a hash lookup either way -- but a
/// bound on a list that arrives over IPC and is held in memory by a
/// LocalSystem service.
const MAX_SELECTED_APPS: usize = 64;

impl SplitTunnelConfig {
    /// Checks the selection before the service acts on it.
    ///
    /// These paths never reach a config file, so this is not the
    /// injection defence the profile validation is. It is a sanity
    /// check: a relative path or a directory cannot be matched against
    /// what a running process reports, so accepting one would mean a
    /// selection that silently never applies.
    pub fn validate(&self) -> Checked {
        if self.apps.len() > MAX_SELECTED_APPS {
            return Err(reject("apps", "selects too many applications"));
        }
        for app in &self.apps {
            // Deliberately not `check_single_line`, which allows only
            // printable ASCII. That is right for values written into a
            // config file and wrong here: a customer whose Windows
            // username or game folder is in Persian, Russian or Chinese
            // has a perfectly ordinary path this would reject. Control
            // characters are still refused, since nothing legitimate has
            // them and a path is compared against what a process
            // reports.
            if app.is_empty() || app.len() > 32_767 {
                return Err(reject("apps", "is not a usable path"));
            }
            if app.chars().any(|c| c.is_control()) {
                return Err(reject("apps", "contains control characters"));
            }
            let looks_absolute = app.as_bytes().get(1) == Some(&b':') || app.starts_with(r"\\");
            if !looks_absolute {
                return Err(reject("apps", "must be a full path to an executable"));
            }
            if !app.to_lowercase().ends_with(".exe") {
                return Err(reject("apps", "must name an executable"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Response {
    Ok,
    /// Reports what is actually running, re-derived from live process /
    /// service state rather than from a remembered flag, so a
    /// crashed-engine case surfaces as disconnected instead of lying.
    ///
    /// `connected` answers "is an engine up", which is a weaker claim
    /// than most callers assume; `health` answers "is the far end
    /// actually answering". Both are reported because they genuinely
    /// differ: a WireGuard tunnel whose peer never replies has
    /// `connected: true` and `health: NeverHandshaked`, and calling that
    /// state "Connected" is what told customers they were protected when
    /// they were not.
    State {
        connected: bool,
        protocol: Option<String>,
        #[serde(default)]
        health: TunnelHealth,
        /// Whether Custom mode is actually intercepting right now, as
        /// opposed to being switched on in the app's settings.
        ///
        /// Reported because the two genuinely differ: turning the toggle
        /// on mid-session does not retrofit itself onto a tunnel that
        /// was brought up to carry everything, and the customer needs to
        /// be told that rather than left believing only their game is
        /// being routed.
        #[serde(default)]
        split_tunnel_active: bool,
    },
    Error { message: String },
}

/// Whether the far end is answering, separate from whether an engine is
/// running locally.
///
/// Deliberately has an explicit "unknown" rather than defaulting to
/// either healthy or broken: for protocols or situations where no
/// trustworthy evidence is available, saying so lets the UI stay quiet
/// instead of inventing reassurance or alarm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TunnelHealth {
    /// Positive evidence the peer is responding.
    Alive { age_secs: u64 },
    /// It responded once but has gone quiet.
    Stale { age_secs: u64 },
    /// An engine is up but the peer has never responded: wrong key,
    /// unreachable host, or a blocked port.
    NeverHandshaked,
    /// Nothing is running, so there is nothing to assess.
    Down,
    #[default]
    Unknown,
}

/// The credentials for one connection, in exactly the shape the backend
/// already returns them (see
/// `apps/backend/src/modules/protocol-users/generate-credentials.ts`) --
/// the app passes them through rather than reshaping, so there is one
/// less place for the two to drift.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "protocol", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectProfile {
    Wireguard(WireguardProfile),
    #[serde(rename = "XRAY_VLESS_REALITY")]
    XrayVlessReality(XrayProfile),
    #[serde(rename = "XRAY_VLESS_TLS")]
    XrayVlessTls(VlessTlsProfile),
    #[serde(rename = "XRAY_TROJAN")]
    XrayTrojan(TrojanProfile),
    Shadowsocks(ShadowsocksProfile),
    Openvpn(OpenvpnProfile),
}

/// Shadowsocks 2022.
///
/// No certificate and no server name, unlike every other Xray-carried
/// profile here: the protocol encrypts from the first byte and presents
/// no handshake at all, so there is nothing to verify and nothing to
/// name.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowsocksProfile {
    pub host: String,
    pub port: u16,
    /// Always a blake3-aes-*-gcm variant. xray-core refuses chacha20 on
    /// a multi-user inbound, and multi-user is what lets a customer be
    /// added without restarting the engine for everyone else.
    pub method: String,
    /// The two pre-shared keys joined as "serverKey:userKey". Joined by
    /// the caller rather than stored that way, so rotating the server's
    /// half does not invalidate every credential already issued.
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireguardProfile {
    pub private_key: String,
    pub address: String,
    pub dns: Option<String>,
    pub allowed_ips: String,
    pub server_public_key: String,
    pub endpoint: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XrayProfile {
    pub uuid: String,
    pub flow: String,
    /// Host and port of the node's Xray inbound, from the `connection`
    /// field M12 added to `GET /customer/protocol-users`.
    pub host: String,
    pub port: u16,
    pub reality_public_key: String,
    pub short_id: String,
    pub server_name: String,
}

/// VLESS over ordinary TLS.
///
/// The same account as the REALITY variant reached a different way: the
/// server presents its own certificate instead of borrowing one, so
/// there is no public key or shortId to carry and the client simply
/// verifies the name it was told to expect. Structurally this is the
/// Trojan profile with a UUID in place of a password, which is exactly
/// what the two protocols differ by.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VlessTlsProfile {
    pub uuid: String,
    pub flow: String,
    pub host: String,
    pub port: u16,
    /// The name to expect on the certificate, and the SNI to send.
    pub server_name: String,
    /// Set when this inbound is carried inside a WebSocket rather than
    /// raw over TCP.
    ///
    /// The same protocol is served both ways -- that is what the
    /// server's `transport` column exists to express -- so the client
    /// cannot infer the stream shape and a wrong guess fails the
    /// handshake. `None` means TCP, which is what every node registered
    /// before the column existed serves.
    #[serde(default)]
    pub ws_path: Option<String>,
}

/// Trojan over TLS.
///
/// Shorter than the REALITY profile because there is less to describe:
/// the server presents an ordinary certificate for a real domain, so
/// there are no borrowed-certificate parameters to carry -- only which
/// name to expect on it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrojanProfile {
    /// The shared secret. On a wrong one the server answers exactly like
    /// the web server it imitates, which is the entire disguise.
    pub password: String,
    pub host: String,
    pub port: u16,
    /// The name to expect on the certificate, and the SNI to send. Kept
    /// separate from `host` because a node is reached by address while
    /// its certificate is issued for a domain.
    pub server_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenvpnProfile {
    pub cert_pem: String,
    pub key_pem: String,
    pub ca_cert_pem: String,
    pub endpoint: String,
    pub proto: String,
    /// The server's tls-crypt key, when it uses one.
    ///
    /// Optional because a server configured without tls-crypt is valid,
    /// but when the server does use it a client lacking the key isn't
    /// rejected -- it's silently ignored, and the connection just never
    /// completes with nothing in the log after the initial send.
    pub tls_crypt_key: Option<String>,
}

#[derive(Debug)]
pub struct ValidationError(pub String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ValidationError {}

type Checked = Result<(), ValidationError>;

fn reject(field: &str, why: &str) -> ValidationError {
    ValidationError(format!("{field}: {why}"))
}

/// Single-line config values: anything that will be written as
/// `Key = value` or as one whitespace-separated `.ovpn` directive.
/// A control character here is the injection primitive, so the check is
/// a whitelist of printable ASCII rather than a blacklist of the
/// characters we happened to think of.
fn check_single_line(field: &str, value: &str, max_len: usize) -> Checked {
    if value.is_empty() {
        return Err(reject(field, "must not be empty"));
    }
    if value.len() > max_len {
        return Err(reject(field, "is unreasonably long"));
    }
    if !value.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
        return Err(reject(field, "contains control or non-ASCII characters"));
    }
    Ok(())
}

/// `host:port`, `ip:port`, or a bracketed IPv6 form. Kept strict because
/// this string is written straight into an `Endpoint =` / `remote` line.
fn check_endpoint(field: &str, value: &str) -> Checked {
    check_single_line(field, value, 300)?;
    let (host, port) = value
        .rsplit_once(':')
        .ok_or_else(|| reject(field, "must be host:port"))?;
    if host.is_empty() {
        return Err(reject(field, "has an empty host"));
    }
    if port.parse::<u16>().is_err() {
        return Err(reject(field, "has an invalid port"));
    }
    let host_body = host.trim_start_matches('[').trim_end_matches(']');
    if !host_body
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
    {
        return Err(reject(field, "has an invalid host"));
    }
    Ok(())
}

/// Base64-ish secrets (WireGuard keys, REALITY short IDs). Restricting
/// the alphabet means these can never carry a delimiter, whatever
/// format they end up embedded in.
fn check_key_like(field: &str, value: &str, max_len: usize) -> Checked {
    if value.is_empty() {
        return Err(reject(field, "must not be empty"));
    }
    if value.len() > max_len {
        return Err(reject(field, "is unreasonably long"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
    {
        return Err(reject(field, "contains characters that aren't valid in a key"));
    }
    Ok(())
}

/// PEM blocks are the one place multi-line input is legitimate, so they
/// get structural validation instead of a newline ban: every line must
/// be either a `-----BEGIN/END ...-----` marker or base64 body. That
/// makes it impossible to smuggle an `.ovpn` directive (or a closing
/// `</cert>` tag) through a certificate field.
fn check_pem(field: &str, value: &str) -> Checked {
    if value.len() > 100_000 {
        return Err(reject(field, "is unreasonably long"));
    }
    let mut saw_begin = false;
    let mut saw_end = false;
    for line in value.lines() {
        let line = line.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        // OpenVPN writes a `#`-commented header above its static keys
        // ("# 2048 bit OpenVPN static key"). Comments are inert wherever
        // these blocks get embedded, and a line that tried to carry a
        // real directive would still have to pass the base64 check below.
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with("-----BEGIN ") && line.ends_with("-----") {
            saw_begin = true;
            continue;
        }
        if line.starts_with("-----END ") && line.ends_with("-----") {
            saw_end = true;
            continue;
        }
        if !line
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        {
            return Err(reject(field, "contains a line that isn't a PEM header or base64"));
        }
    }
    if !saw_begin || !saw_end {
        return Err(reject(field, "is not a well-formed PEM block"));
    }
    Ok(())
}

/// Comma-separated CIDR list, e.g. `0.0.0.0/0, ::/0`.
fn check_cidr_list(field: &str, value: &str) -> Checked {
    check_single_line(field, value, 2000)?;
    if !value
        .chars()
        .all(|c| c.is_ascii_hexdigit() || matches!(c, '.' | ':' | '/' | ',' | ' '))
    {
        return Err(reject(field, "contains characters that aren't valid in a CIDR list"));
    }
    Ok(())
}

impl ConnectProfile {
    /// Must be called by the service before writing any config file.
    pub fn validate(&self) -> Checked {
        match self {
            ConnectProfile::Wireguard(p) => {
                check_key_like("privateKey", &p.private_key, 100)?;
                check_key_like("serverPublicKey", &p.server_public_key, 100)?;
                check_cidr_list("address", &p.address)?;
                check_cidr_list("allowedIPs", &p.allowed_ips)?;
                check_endpoint("endpoint", &p.endpoint)?;
                if let Some(dns) = &p.dns {
                    check_cidr_list("dns", dns)?;
                }
                Ok(())
            }
            ConnectProfile::XrayVlessReality(p) => {
                // Xray's config is JSON, so serde escaping already makes
                // structural injection impossible -- these checks are
                // about rejecting nonsense early with a clear message
                // rather than letting xray.exe fail opaquely.
                check_key_like("uuid", &p.uuid, 64)?;
                check_single_line("flow", &p.flow, 64)?;
                check_endpoint("host", &format!("{}:{}", p.host, p.port))?;
                check_key_like("realityPublicKey", &p.reality_public_key, 128)?;
                check_key_like("shortId", &p.short_id, 64)?;
                check_single_line("serverName", &p.server_name, 300)?;
                Ok(())
            }
            ConnectProfile::XrayVlessTls(p) => {
                check_key_like("uuid", &p.uuid, 64)?;
                check_single_line("flow", &p.flow, 64)?;
                check_endpoint("host", &format!("{}:{}", p.host, p.port))?;
                // Not optional the way it arguably is for REALITY, where a
                // missing name only weakens the disguise. Here the
                // certificate is verified against it, so an empty one
                // cannot connect at all -- reject it with a message rather
                // than as a TLS error from xray.exe.
                check_single_line("serverName", &p.server_name, 300)?;
                if p.server_name.trim().is_empty() {
                    return Err(reject("serverName", "is required to verify the server's certificate"));
                }
                Ok(())
            }
            ConnectProfile::XrayTrojan(p) => {
                // The password is a base64url secret from the control
                // plane, so it is key-like: no separators, no spaces.
                // Checking it here means a mangled credential is rejected
                // with a clear message rather than becoming a connection
                // that simply never authenticates -- which, for Trojan,
                // is indistinguishable from the server being a plain web
                // server, and so gives the customer nothing to go on.
                check_key_like("password", &p.password, 128)?;
                check_endpoint("host", &format!("{}:{}", p.host, p.port))?;
                check_single_line("serverName", &p.server_name, 300)?;
                Ok(())
            }
            ConnectProfile::Shadowsocks(p) => {
                check_endpoint("host", &format!("{}:{}", p.host, p.port))?;
                // Constrained rather than free text: this value picks a
                // cipher inside xray, and only the blake3-aes-gcm family
                // works on a multi-user inbound. Rejecting anything else
                // here turns an operator's typo into a clear message
                // instead of an engine that starts and authenticates
                // nobody.
                if p.method != "2022-blake3-aes-256-gcm" && p.method != "2022-blake3-aes-128-gcm" {
                    return Err(reject("method", "must be a 2022-blake3-aes-*-gcm cipher"));
                }
                // "serverKey:userKey" -- two base64 keys joined by a
                // colon, so this is not key-like as a whole. Both halves
                // are checked separately, since a missing half is the
                // realistic failure and Shadowsocks answers a bad key
                // with silence rather than an error.
                let (server_key, user_key) = p
                    .password
                    .split_once(':')
                    .ok_or_else(|| reject("password", "must be serverKey:userKey"))?;
                check_key_like("serverKey", server_key, 128)?;
                check_key_like("userKey", user_key, 128)?;
                Ok(())
            }
            ConnectProfile::Openvpn(p) => {
                check_pem("certPem", &p.cert_pem)?;
                check_pem("keyPem", &p.key_pem)?;
                check_pem("caCertPem", &p.ca_cert_pem)?;
                check_endpoint("endpoint", &p.endpoint)?;
                if p.proto != "udp" && p.proto != "tcp" {
                    return Err(reject("proto", "must be udp or tcp"));
                }
                // Same structural check as the certificates: an OpenVPN
                // static key is a BEGIN/END block wrapping hex, so it
                // can't smuggle a directive out of its inline tag.
                if let Some(key) = &p.tls_crypt_key {
                    check_pem("tlsCryptKey", key)?;
                }
                Ok(())
            }
        }
    }

    pub fn protocol_name(&self) -> &'static str {
        match self {
            ConnectProfile::Wireguard(_) => "WIREGUARD",
            ConnectProfile::XrayVlessReality(_) => "XRAY_VLESS_REALITY",
            ConnectProfile::XrayVlessTls(_) => "XRAY_VLESS_TLS",
            ConnectProfile::XrayTrojan(_) => "XRAY_TROJAN",
            ConnectProfile::Shadowsocks(_) => "SHADOWSOCKS",
            ConnectProfile::Openvpn(_) => "OPENVPN",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wg(mutate: impl FnOnce(&mut WireguardProfile)) -> ConnectProfile {
        let mut p = WireguardProfile {
            private_key: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=".into(),
            address: "10.77.0.8/32".into(),
            dns: Some("1.1.1.1".into()),
            allowed_ips: "0.0.0.0/0, ::/0".into(),
            server_public_key: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=".into(),
            endpoint: "203.0.113.5:51888".into(),
        };
        mutate(&mut p);
        ConnectProfile::Wireguard(p)
    }

    fn ss(mutate: impl FnOnce(&mut ShadowsocksProfile)) -> ConnectProfile {
        let mut p = ShadowsocksProfile {
            host: "203.0.113.5".into(),
            port: 23456,
            method: "2022-blake3-aes-256-gcm".into(),
            password: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=:1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE="
                .into(),
        };
        mutate(&mut p);
        ConnectProfile::Shadowsocks(p)
    }

    #[test]
    fn accepts_a_real_shadowsocks_profile() {
        assert!(ss(|_| {}).validate().is_ok());
    }

    /// Shadowsocks answers a bad key with silence rather than a refusal,
    /// so a half-formed password produces a server that looks dead. It
    /// has to be rejected here, where there is still something to say.
    #[test]
    fn rejects_a_password_missing_its_server_half() {
        let err = ss(|p| p.password = "onlyonekey".into()).validate().unwrap_err();
        assert!(err.to_string().contains("serverKey:userKey"), "{err}");
    }

    #[test]
    fn rejects_an_empty_half() {
        assert!(ss(|p| p.password = ":justtheuserkey".into()).validate().is_err());
        assert!(ss(|p| p.password = "justtheserverkey:".into()).validate().is_err());
    }

    /// Only the blake3-aes-gcm family works on a multi-user inbound.
    /// chacha20 parses everywhere else and fails only here, so an
    /// operator copying a config from elsewhere would otherwise get an
    /// engine that starts and authenticates nobody.
    #[test]
    fn rejects_a_cipher_the_server_cannot_run_multi_user() {
        assert!(ss(|p| p.method = "2022-blake3-chacha20-poly1305".into())
            .validate()
            .is_err());
        assert!(ss(|p| p.method = "aes-256-gcm".into()).validate().is_err());
    }

    #[test]
    fn names_shadowsocks_for_the_service_log() {
        assert_eq!(ss(|_| {}).protocol_name(), "SHADOWSOCKS");
    }

    #[test]
    fn accepts_a_real_wireguard_profile() {
        assert!(wg(|_| {}).validate().is_ok());
    }

    #[test]
    fn rejects_newline_injection_in_endpoint() {
        // The attack this whole module exists for: smuggling an extra
        // config directive in through a credential value.
        let profile = wg(|p| p.endpoint = "203.0.113.5:51888\nPostUp = calc.exe".into());
        assert!(profile.validate().is_err());
    }

    #[test]
    fn rejects_endpoint_without_port() {
        assert!(wg(|p| p.endpoint = "203.0.113.5".into()).validate().is_err());
    }

    #[test]
    fn rejects_endpoint_with_bad_port() {
        assert!(wg(|p| p.endpoint = "203.0.113.5:99999".into()).validate().is_err());
    }

    #[test]
    fn rejects_key_containing_a_delimiter() {
        assert!(wg(|p| p.private_key = "abc\"def".into()).validate().is_err());
    }

    #[test]
    fn rejects_empty_required_field() {
        assert!(wg(|p| p.private_key = String::new()).validate().is_err());
    }

    fn ovpn(mutate: impl FnOnce(&mut OpenvpnProfile)) -> ConnectProfile {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAJ\n-----END CERTIFICATE-----";
        let mut p = OpenvpnProfile {
            cert_pem: pem.into(),
            key_pem: "-----BEGIN PRIVATE KEY-----\nMIIBkTCB\n-----END PRIVATE KEY-----".into(),
            ca_cert_pem: pem.into(),
            endpoint: "203.0.113.5:1194".into(),
            proto: "udp".into(),
            tls_crypt_key: Some(
                "-----BEGIN OpenVPN Static key V1-----\n1a2b3c4d\n-----END OpenVPN Static key V1-----".into(),
            ),
        };
        mutate(&mut p);
        ConnectProfile::Openvpn(p)
    }

    #[test]
    fn accepts_a_real_openvpn_profile() {
        assert!(ovpn(|_| {}).validate().is_ok());
    }

    #[test]
    fn rejects_pem_smuggling_an_ovpn_script_directive() {
        // `up` in an .ovpn runs a command; escaping the inline <cert>
        // block would be remote code execution as SYSTEM.
        let profile = ovpn(|p| {
            p.ca_cert_pem =
                "-----BEGIN CERTIFICATE-----\nMIIBkTCB\n</ca>\nscript-security 2\nup calc.exe\n-----END CERTIFICATE-----"
                    .into();
        });
        assert!(profile.validate().is_err());
    }

    #[test]
    fn rejects_non_pem_certificate() {
        assert!(ovpn(|p| p.ca_cert_pem = "just some text".into()).validate().is_err());
    }

    #[test]
    fn rejects_unknown_openvpn_proto() {
        assert!(ovpn(|p| p.proto = "sctp".into()).validate().is_err());
    }

    #[test]
    fn accepts_a_real_openvpn_static_key_with_its_comment_header() {
        // Exactly what `openvpn --genkey secret` writes -- the leading
        // `#` lines would otherwise fail the base64 check and make every
        // real key look malformed.
        let profile = ovpn(|p| {
            p.tls_crypt_key = Some(
                "#\n# 2048 bit OpenVPN static key\n#\n-----BEGIN OpenVPN Static key V1-----\n\
                 34e1557afbf97d687a1ca2c03de937e0\n-----END OpenVPN Static key V1-----\n"
                    .into(),
            );
        });
        assert!(profile.validate().is_ok(), "{:?}", profile.validate());
    }

    #[test]
    fn still_rejects_a_directive_hidden_among_comments() {
        let profile = ovpn(|p| {
            p.tls_crypt_key = Some(
                "#\n-----BEGIN OpenVPN Static key V1-----\nabc\n</tls-crypt>\nup calc.exe\n-----END OpenVPN Static key V1-----"
                    .into(),
            );
        });
        assert!(profile.validate().is_err());
    }

    #[test]
    fn accepts_a_real_xray_profile() {
        let profile = ConnectProfile::XrayVlessReality(XrayProfile {
            uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301".into(),
            flow: "xtls-rprx-vision".into(),
            host: "203.0.113.5".into(),
            port: 443,
            reality_public_key: "3Qc9mF_kJz8xN2pQrStUvWxYz0123456789abcdefgh".into(),
            short_id: "0123abcd".into(),
            server_name: "example.com".into(),
        });
        assert!(profile.validate().is_ok());
    }
}
