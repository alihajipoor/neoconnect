//! Client side of the Linux root helper, `neoxify-helper`.
//!
//! The same contract as the Windows app's service: one JSON `Request` per
//! line, one JSON `Response` per line, one connection per request, over a
//! Unix socket here where Windows uses a named pipe. The OS-free logic
//! (mapping a credential to a profile, the timeouts, the egress probes) is
//! copied from the Windows `vpn.rs` rather than shared, because that file
//! is the shipping Windows client and is not to be reshaped for this one.
//! What differs is the transport and where the local network tables are
//! read from: /proc and /sys instead of the IP Helper API.
//!
//! Nothing here is trusted by the helper. The profile carries credentials
//! only, never a path or command, and the helper validates every field.

use std::time::Duration;

use neoconnect_ipc::{
    ConnectProfile, GamingPhase, Ikev2Profile, OpenvpnProfile, Request, Response, ShadowsocksProfile,
    TrojanProfile, TunnelHealth, VlessTlsProfile, WireguardProfile, XrayProfile,
};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// Where the helper listens. Created by systemd (`RuntimeDirectory=` in the
/// unit), so it exists only while the helper does.
pub const SOCKET_PATH: &str = "/run/neoxify/helper.sock";

/// One item from `GET /customer/protocol-users`, passed through from the
/// frontend as-is. Mapping to a [`ConnectProfile`] happens here rather
/// than in TypeScript so there is a single place that knows how each
/// protocol's credentials are shaped.
#[derive(Debug, Deserialize)]
pub struct ProtocolUserPayload {
    protocol: String,
    credentials: serde_json::Value,
    connection: ConnectionInfo,
}

#[derive(Debug, Deserialize)]
pub struct ConnectionInfo {
    host: String,
    port: u16,
    /// How the protocol is carried. The same Protocol member is served
    /// raw over TCP and inside a WebSocket, so this cannot be inferred,
    /// and a wrong guess fails the handshake.
    ///
    /// Optional because nodes registered before the server grew this
    /// column report nothing, and every one of those is plain TCP.
    #[serde(default)]
    transport: Option<String>,
    #[serde(rename = "publicParams")]
    public_params: serde_json::Value,
}

fn field<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(|v| v.as_str()).ok_or_else(|| {
        format!("this connection is missing '{key}' -- ask support to re-provision it")
    })
}

impl ProtocolUserPayload {
    fn into_profile(self) -> Result<ConnectProfile, String> {
        match self.protocol.as_str() {
            "WIREGUARD" => Ok(ConnectProfile::Wireguard(WireguardProfile {
                private_key: field(&self.credentials, "privateKey")?.to_string(),
                address: field(&self.credentials, "address")?.to_string(),
                dns: self
                    .credentials
                    .get("dns")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                allowed_ips: field(&self.credentials, "allowedIPs")?.to_string(),
                server_public_key: field(&self.credentials, "serverPublicKey")?.to_string(),
                endpoint: field(&self.credentials, "endpoint")?.to_string(),
            })),
            "XRAY_VLESS_REALITY" => {
                // Unlike the other two, Xray's per-user credentials are
                // only {uuid, flow} -- the REALITY server parameters live
                // on the node's ProtocolConfig and arrive via
                // `connection.publicParams` (the field M12 added
                // precisely so a native client could build this config).
                let params = &self.connection.public_params;
                // `shortIds` is a list server-side; a client uses one.
                let short_id = params
                    .get("shortIds")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "this server's REALITY settings are missing 'shortIds' -- ask support to re-provision it"
                            .to_string()
                    })?;
                Ok(ConnectProfile::XrayVlessReality(XrayProfile {
                    uuid: field(&self.credentials, "uuid")?.to_string(),
                    flow: self
                        .credentials
                        .get("flow")
                        .and_then(|v| v.as_str())
                        .unwrap_or("xtls-rprx-vision")
                        .to_string(),
                    host: self.connection.host,
                    port: self.connection.port,
                    reality_public_key: field(params, "realityPublicKey")?.to_string(),
                    short_id: short_id.to_string(),
                    server_name: field(params, "serverName")?.to_string(),
                }))
            }
            "XRAY_VLESS_TLS" => {
                // No borrowed-certificate parameters to read: this
                // variant presents its own, so the only server-side thing
                // needed is the name to verify it against.
                //
                // No host fallback, here or in Trojan below. A wrong
                // SNI fails the certificate check outright, so guessing
                // would turn a fixable misconfiguration into a TLS
                // error with nothing pointing at the cause.
                let server_name = self
                    .connection
                    .public_params
                    .get("serverName")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "this server's TLS settings are missing 'serverName' -- ask support to re-provision it"
                            .to_string()
                    })?;
                // Only when the node says so. The path is not guessable
                // and a wrong one is answered by the fallback web page
                // rather than by the tunnel, which reads to a customer as
                // a server that is up but broken.
                let ws_path = if self.connection.transport.as_deref() == Some("WS") {
                    Some(
                        self.connection
                            .public_params
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or("/")
                            .to_string(),
                    )
                } else {
                    None
                };
                Ok(ConnectProfile::XrayVlessTls(VlessTlsProfile {
                    uuid: field(&self.credentials, "uuid")?.to_string(),
                    // Defaulting to Vision is right for TCP and wrong for
                    // WebSocket, so the default only applies when the
                    // server issued no flow at all -- which for a
                    // WebSocket credential it deliberately does, as an
                    // empty string rather than an absent field.
                    flow: self
                        .credentials
                        .get("flow")
                        .and_then(|v| v.as_str())
                        .unwrap_or(if ws_path.is_some() {
                            ""
                        } else {
                            "xtls-rprx-vision"
                        })
                        .to_string(),
                    host: self.connection.host.clone(),
                    port: self.connection.port,
                    server_name: server_name.to_string(),
                    ws_path,
                }))
            }
            "XRAY_TROJAN" => {
                // The certificate name lives on the node's ProtocolConfig
                // rather than in the per-user credentials, the same split
                // REALITY uses: the password is this customer's, the
                // domain is the server's.
                //
                // Refused when the node recorded no name, rather than
                // falling back to the host as this used to.
                //
                // The fallback was written to avoid an SNI-less
                // handshake, and it produced exactly that. Nodes are
                // registered by IP, and uTLS -- the stack xray.exe uses
                // for the "chrome" fingerprint -- drops an IP literal
                // from the extension entirely (hostnameInSNI in
                // utls@v1.8.3 returns "" for anything net.ParseIP
                // accepts). So the disguise became a Chrome-shaped
                // ClientHello carrying no server name at all, which is
                // about the loudest thing that can be sent to a filter,
                // and the certificate check then failed anyway: our
                // certificates are issued for names, and none of them
                // carries an IP SAN. The fallback could not have
                // connected on any node we run; it only made the
                // failure look like a network problem instead of a
                // missing field. Same refusal as VLESS+TLS below, and
                // the same wording the Android client uses.
                let params = &self.connection.public_params;
                let server_name = params
                    .get("serverName")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "this server's TLS settings are missing 'serverName' -- ask support to re-provision it"
                            .to_string()
                    })?
                    .to_string();
                Ok(ConnectProfile::XrayTrojan(TrojanProfile {
                    password: field(&self.credentials, "password")?.to_string(),
                    host: self.connection.host.clone(),
                    port: self.connection.port,
                    server_name,
                }))
            }
            "SHADOWSOCKS" => {
                // Both halves are required. The server key belongs to the
                // listener and the user key to this customer; either one
                // alone authenticates nobody, and Shadowsocks answers a
                // bad key with silence rather than a refusal, so the
                // failure would look like a dead server.
                let params = &self.connection.public_params;
                let server_key = params
                    .get("serverKey")
                    .and_then(|v| v.as_str())
                    .ok_or("this server is missing its Shadowsocks server key")?;
                let method = params
                    .get("method")
                    .and_then(|v| v.as_str())
                    .ok_or("this server is missing its Shadowsocks method")?;
                let user_key = field(&self.credentials, "userKey")?;
                Ok(ConnectProfile::Shadowsocks(ShadowsocksProfile {
                    host: self.connection.host.clone(),
                    port: self.connection.port,
                    method: method.to_string(),
                    password: format!("{server_key}:{user_key}"),
                }))
            }
            "OPENVPN" => Ok(ConnectProfile::Openvpn(OpenvpnProfile {
                cert_pem: field(&self.credentials, "certPem")?.to_string(),
                key_pem: field(&self.credentials, "keyPem")?.to_string(),
                ca_cert_pem: field(&self.credentials, "caCertPem")?.to_string(),
                endpoint: field(&self.credentials, "endpoint")?.to_string(),
                proto: self
                    .credentials
                    .get("proto")
                    .and_then(|v| v.as_str())
                    .unwrap_or("udp")
                    .to_string(),
                // A server-wide value, so it lives on the ProtocolConfig
                // rather than in the per-customer credentials. Absent for
                // servers that don't use tls-crypt, and for configs
                // registered before it was recorded.
                tls_crypt_key: self
                    .connection
                    .public_params
                    .get("tlsCryptKey")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })),
            "IKEV2" => {
                // The hostname, deliberately, and an error rather than a
                // fallback to `connection.host` when it is missing.
                // Windows validates the server's certificate against the
                // name it dialled, so dialling the IP fails with a
                // certificate error that says nothing about the real
                // cause -- and it fails at the very end of a slow
                // handshake. Failing here instead is both faster and
                // legible.
                let server = self
                    .connection
                    .public_params
                    .get("endpointHost")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty())
                    .ok_or(
                        "this server has no hostname recorded, and IKEv2 cannot be                          dialled by address -- ask support to re-register it",
                    )?;
                Ok(ConnectProfile::Ikev2(Ikev2Profile {
                    server: server.to_string(),
                    username: field(&self.credentials, "username")?.to_string(),
                    password: field(&self.credentials, "password")?.to_string(),
                }))
            }
            other => Err(format!("unsupported protocol {other}")),
        }
    }
}

/// Sends one request and reads one response, within the ordinary deadline.
async fn call(request: &Request) -> Result<Response, String> {
    call_within(request, REPLY_TIMEOUT).await
}

/// How long an ordinary request may take to be answered: long enough for a
/// connect, which tears an engine down and brings another up; short enough
/// that a customer gets an error rather than a spinner that never ends.
const REPLY_TIMEOUT: Duration = Duration::from_secs(45);

/// How long the helper gets to connect us at all. A socket that exists but
/// is never accepted on is a wedged helper, not a slow one.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

async fn call_within(request: &Request, reply_timeout: Duration) -> Result<Response, String> {
    // The wording of the failure is load-bearing: the interface's
    // `serviceGone` (desktop-windows src/lib/service-call.ts) matches
    // "Could not reach the Neoxify background service", and that is what
    // tells it the helper is not there rather than that a request failed.
    // A missing socket (the helper is stopped or not installed) and a
    // refused one (it died and left the file) are both that case.
    let stream = match tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(SOCKET_PATH)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            return Err(format!(
                "Could not reach the Neoxify background service ({e}). Try restarting the app, or reinstalling if this keeps happening."
            ))
        }
        Err(_) => {
            return Err(format!(
                "Could not reach the Neoxify background service (no answer within {}s). Try restarting the app, or reinstalling if this keeps happening.",
                CONNECT_TIMEOUT.as_secs()
            ))
        }
    };

    let mut encoded =
        serde_json::to_string(request).map_err(|e| format!("could not encode request: {e}"))?;
    encoded.push('\n');

    let mut reader = BufReader::new(stream);
    reader
        .get_mut()
        .write_all(encoded.as_bytes())
        .await
        .map_err(|e| format!("could not send request to the background service: {e}"))?;

    // Bounded, because an unbounded read is a hang with no way out: the
    // helper accepting the connection is no promise that it will answer,
    // and every piece of interface waiting on this would wait with it.
    let mut line = String::new();
    match tokio::time::timeout(reply_timeout, reader.read_line(&mut line)).await {
        Ok(Ok(0)) => {
            return Err("could not read the background service's reply: it closed the connection".into())
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(format!("could not read the background service's reply: {e}")),
        Err(_) => {
            return Err(format!(
                "The Neoxify background service did not answer within {}s. It may be stuck -- restarting the app usually clears it.",
                reply_timeout.as_secs()
            ))
        }
    }

    serde_json::from_str(line.trim())
        .map_err(|e| format!("could not decode the background service's reply: {e}"))
}

async fn call_expecting_ok(request: &Request) -> Result<(), String> {
    match call(request).await? {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        _ => Err("the background service returned an unexpected reply".into()),
    }
}

/// What the interface is told for a feature the Linux first version does
/// not carry. The interface hides these on Linux; this is the answer for a
/// path that reaches one anyway, in a sentence a person can read, never a
/// default that looks like it worked.
fn not_on_linux(what: &str) -> String {
    format!("{what} is not available in the Linux version of Neoxify yet.")
}

/// IKEv2 goes through the Windows system client, and Linux has no route for
/// it in the first version. Refused here, before the helper, so the refusal
/// is the same sentence whichever helper is installed.
fn refuse_unsupported(profile: &ConnectProfile) -> Result<(), String> {
    if matches!(profile, ConnectProfile::Ikev2(_)) {
        return Err(not_on_linux("IKEv2"));
    }
    Ok(())
}

/// One concurrent exit, as the frontend supplies it. Accepted so the
/// command keeps the Windows signature, and dropped: per-game exits ride on
/// Custom mode, which Linux does not have.
#[derive(Debug, Deserialize)]
pub struct ExitPayload {
    #[allow(dead_code)]
    exit: String,
    #[allow(dead_code)]
    payload: ProtocolUserPayload,
}

/// Brings a tunnel up through the helper. `exits` is accepted and dropped
/// (see [`ExitPayload`]); `block_while_reconnecting` is always sent as off,
/// because the reconnect hold is not in the Linux first version.
#[tauri::command]
pub async fn vpn_connect(
    payload: ProtocolUserPayload,
    exits: Option<Vec<ExitPayload>>,
    known_nodes: Option<Vec<String>>,
    block_while_reconnecting: Option<bool>,
) -> Result<(), String> {
    let _ = (exits, block_while_reconnecting);
    let profile = payload.into_profile()?;
    refuse_unsupported(&profile)?;
    call_expecting_ok(&Request::Connect {
        profile,
        exits: Vec::new(),
        known_nodes: known_nodes.unwrap_or_default(),
        block_while_reconnecting: false,
    })
    .await
}

#[tauri::command]
pub async fn vpn_disconnect() -> Result<(), String> {
    call_expecting_ok(&Request::Disconnect).await
}

/// With no reconnect hold, a reconnect's teardown is an ordinary one: the
/// same as `vpn_disconnect`, which is what Windows does with the setting
/// off.
#[tauri::command]
pub async fn vpn_disconnect_for_reconnect() -> Result<(), String> {
    call_expecting_ok(&Request::Disconnect).await
}

/// Nothing is ever held on Linux, so letting go of it always succeeds.
#[tauri::command]
pub async fn vpn_release_reconnect_hold() -> Result<(), String> {
    Ok(())
}

/// Switching the hold off is already true; switching it on is refused, so
/// the interface never shows a protection that is not there.
#[tauri::command]
pub async fn vpn_set_reconnect_hold(enabled: bool) -> Result<(), String> {
    if enabled {
        return Err(not_on_linux("Blocking the internet while reconnecting"));
    }
    Ok(())
}

/// Custom mode needs a per-application packet filter that Linux does not
/// have yet. Switching it off, or sending the default all-traffic setting
/// before a connect, is already the truth and succeeds; asking for it on
/// is refused.
#[tauri::command]
pub async fn vpn_set_split_tunnel(enabled: bool) -> Result<(), String> {
    if enabled {
        return Err(not_on_linux("Choosing which apps use the VPN"));
    }
    Ok(())
}

#[tauri::command]
pub async fn vpn_probe_split_tunnel() -> Result<(), String> {
    Err(not_on_linux("Choosing which apps use the VPN"))
}

#[tauri::command]
pub async fn vpn_exit_placements() -> Result<serde_json::Value, String> {
    Err(not_on_linux("Choosing an exit for each app"))
}

#[tauri::command]
pub async fn vpn_list_running_apps() -> Result<Vec<serde_json::Value>, String> {
    Err(not_on_linux("Choosing which apps use the VPN"))
}

#[tauri::command]
pub async fn vpn_repair() -> Result<serde_json::Value, String> {
    Err(not_on_linux("Repair my network"))
}

#[tauri::command]
pub async fn vpn_diagnostics() -> Result<serde_json::Value, String> {
    Err(not_on_linux("Diagnostics"))
}

/// The command to give a customer when the app cannot reach the helper:
/// on Linux that is the helper's unit, not a repair binary.
#[tauri::command]
pub fn repair_command_line() -> String {
    "sudo systemctl restart neoxify-helper".to_string()
}

#[derive(Debug, serde::Serialize)]
pub struct VpnStatus {
    /// An engine is running. Weaker than it sounds -- see `health`.
    connected: bool,
    protocol: Option<String>,
    /// Whether the far end is actually answering. Carried separately
    /// because `connected` alone was being shown to customers as
    /// "Connected" while no traffic was flowing.
    health: TunnelHealth,
    /// Whether Custom mode is intercepting right now.
    ///
    /// Distinct from the setting being switched on: turning it on
    /// mid-session cannot retrofit itself onto a tunnel that was brought
    /// up to carry everything. The UI reads this rather than its own
    /// toggle so it never claims only one app is being routed while the
    /// whole machine is.
    #[serde(rename = "splitTunnelActive")]
    split_tunnel_active: bool,
    /// What Custom mode's packet counters say is going wrong, if
    /// anything -- already phrased for the customer by the service.
    ///
    /// Carried all the way to the UI because this is the only signal
    /// taken from the path a chosen application's traffic actually
    /// travels. Everything else here describes the tunnel, and a tunnel
    /// can be perfectly healthy while the redirect in front of it drops
    /// every packet. That combination is what a tester saw for three
    /// sessions while the app told him it was connected.
    #[serde(rename = "splitTunnelProblem", skip_serializing_if = "Option::is_none")]
    split_tunnel_problem: Option<String>,
    /// Whether the service is holding IPv6 down for this session.
    ///
    /// Carried to the UI because the customer is told about it in
    /// words. Every node is IPv4-only, so a full tunnel has nowhere to
    /// put IPv6 and blocks it instead of letting it leave in the clear
    /// -- and a gap the customer knows about is the whole difference
    /// between this and the leak it replaced.
    #[serde(rename = "ipv6Blocked")]
    ipv6_blocked: bool,
    /// Whether this session asked for the tunnel's DNS rule and did not
    /// get it.
    ///
    /// Carried as a fact, not as a sentence, unlike `split_tunnel_problem`
    /// above it: this one is put in front of customers in Iran, and an
    /// English sentence arriving over the pipe cannot be translated by
    /// the app that renders it. The wording is in `i18n.tsx` in both
    /// languages.
    ///
    /// `false` is not a claim that DNS is protected -- see the field's
    /// documentation in the IPC crate and `engines::dns::TunnelDns`.
    #[serde(rename = "tunnelDnsUnprotected")]
    tunnel_dns_unprotected: bool,
    /// Applications the customer selected while they were already
    /// running, as bare file names.
    ///
    /// Carried as facts rather than as a sentence, for the same reason
    /// `tunnel_dns_unprotected` above it is: the customers this feature
    /// exists for read Persian, and a sentence built in the service
    /// arrives in a language the app cannot change. The app turns this
    /// list into wording from `i18n.tsx`.
    ///
    /// Empty for everyone who selected their game before opening it,
    /// which is the order the app's own copy recommends.
    #[serde(rename = "splitTunnelRestartNeeded")]
    split_tunnel_restart_needed: Vec<String>,
    /// Whether IPv4 outside the tunnel is refused on this PC while it is
    /// up, as the service read it from the session: `null` where that does
    /// not apply (Custom mode, WireGuard) or the service is older, and the
    /// UI says nothing then; `false` is a full tunnel that is not confined
    /// (a failed or released confinement, or IKEv2 by choice), which the UI
    /// says in words (`i18n.tsx`).
    #[serde(rename = "ipv4Confined")]
    ipv4_confined: Option<bool>,
    /// Why not, in English, for support -- never shown as the warning.
    #[serde(rename = "confinementProblem", skip_serializing_if = "Option::is_none")]
    confinement_problem: Option<String>,
    /// "Block the internet while reconnecting": `{"state":"armed"}`,
    /// `{"state":"holding","held_secs":n}`, or `{"state":"notHeld",
    /// "problem":...}` -- facts the UI words in both languages. Absent
    /// when the setting is off or nothing is armed, or from an older
    /// service.
    #[serde(rename = "reconnectHold", skip_serializing_if = "Option::is_none")]
    reconnect_hold: Option<neoconnect_ipc::ReconnectHold>,
    /// What the tunnel's adapter has carried this session, from Windows'
    /// own counters: `rx_bytes`, `tx_bytes`, and `rx_per_sec`,
    /// `tx_per_sec`, `window_ms` once measured. Absent whenever it was not
    /// read -- the UI shows no number then, never a zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    traffic: Option<neoconnect_ipc::TunnelTraffic>,
    /// Which problem `split_tunnel_problem` is, as a code the UI words in
    /// both languages ("injectionRefused", "noReplies", "noAppTraffic",
    /// "adapterGone", or "other" from a newer service, for which the UI
    /// shows the service's own sentence). Absent with no problem.
    #[serde(rename = "splitTunnelProblemCode", skip_serializing_if = "Option::is_none")]
    split_tunnel_problem_code: Option<neoconnect_ipc::SplitTunnelProblemCode>,
    /// How long the live session's engine has been up, in whole seconds:
    /// the session timer for a tunnel this window did not bring up. Absent
    /// with no session, or from an older service -- never a guess.
    #[serde(rename = "sessionSecs", skip_serializing_if = "Option::is_none")]
    session_secs: Option<u64>,
}

/// Public IPv6 addresses used to ask whether IPv6 still leaves this
/// machine.
///
/// Literal addresses, which is the entire point: a hostname is resolved
/// by Windows and may come back with an `A` record, so reaching it
/// proves nothing about which family carried the packets. A connection
/// to a literal IPv6 address either goes over IPv6 or does not happen.
///
/// Two operators rather than two addresses at one, because a single
/// filtered anycast address would otherwise read as "this machine has no
/// IPv6" -- which silently turns the check off, and a check that cannot
/// come back positive is the failure this whole change exists to
/// correct. Both are public resolvers with a TCP listener on 443
/// (DNS-over-HTTPS), so a completed handshake is a genuine round trip.
const IPV6_PROBES: [(&str, u16); 2] =
    [("2606:4700:4700::1111", 443), ("2001:4860:4860::8888", 443)];

/// Long enough for a real round trip on a slow path, short enough that
/// nothing the customer is waiting on notices. Nothing blocks on this.
const IPV6_PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

/// Whether a public IPv6 destination can still be reached from here.
///
/// Exists because the app's egress check cannot ask this. That check
/// compares the address `/health/ip` saw before and after connecting,
/// which is an IPv4 conversation on every node we run -- so a machine
/// leaking IPv6 beside a perfectly good IPv4 tunnel reads as protected.
/// Measured exactly that way on OpenVPN, IKEv2 and Xray VLESS-REALITY.
///
/// Native rather than a `fetch` from the frontend, and not for
/// tidiness. The app's HTTP permission is scoped to `*.neoxify.site`, so
/// a request to any probe address would be refused by Tauri's own ACL
/// before a packet was sent -- giving a check that always answers "no
/// IPv6" and can never fail. A socket has no such scope, and a completed
/// TCP handshake is stronger evidence than an HTTP response anyway:
/// packets left and came back.
///
/// True means IPv6 reached the internet. While connected that is a leak,
/// because every Neoxify node is IPv4-only and there is no tunnel those
/// packets could have taken. The frontend compares it against the same
/// answer taken *before* connecting, so a machine with no IPv6 at all --
/// the common case -- is never reported as anything.
#[tauri::command]
pub async fn probe_ipv6_egress() -> bool {
    any_reaches(IPV6_PROBES, IPV6_PROBE_TIMEOUT).await
}

/// Public IPv4 addresses used to ask whether this machine reaches the
/// internet at all, independently of our own API, each with the name it
/// serves a certificate for.
///
/// The same two operators as `IPV6_PROBES`, for the same reasons:
/// literal addresses, so the family is not up to the resolver (and no
/// lookup has to work through the tunnel first), and two of them, so one
/// filtered anycast address does not decide the answer. Both are
/// DNS-over-HTTPS resolvers, so each completes a TLS handshake for its
/// name on 443 from essentially everywhere.
const IPV4_PROBES: [(std::net::Ipv4Addr, &str); 2] = [
    (std::net::Ipv4Addr::new(1, 1, 1, 1), "one.one.one.one"),
    (std::net::Ipv4Addr::new(8, 8, 8, 8), "dns.google"),
];

/// For the TCP handshake and the TLS one together. Longer than the IPv6
/// probe: this one is asked through a tunnel, from Iran to a node and out
/// again, and it needs two round trips to the far end where that one
/// needs one. A slow-but-working path must not read as a dead one.
const IPV4_PROBE_TIMEOUT: Duration = Duration::from_millis(5000);

/// Whether the public IPv4 internet answers from here, right now.
///
/// Asked only when none of our own endpoints gave `/health/ip` an
/// address -- see `egress.ts`. That has two very different causes. The
/// tunnel may be black-holing everything, which is the case the egress
/// check exists to catch; or our control plane may be down or unreachable
/// from the node while the tunnel carries everything else perfectly well.
/// Read as the first, the second used to mark every connected customer
/// "degraded" at once and send the automatic ladder round to tear their
/// working tunnels down.
///
/// **A completed TLS handshake, with the certificate verified -- not a
/// TCP handshake.** The first version of this asked for a TCP handshake,
/// and under every Xray protocol that answers itself: xray.exe's `tun`
/// inbound is a userspace TCP stack (gVisor) that completes the
/// three-way handshake locally and only then hands the connection to the
/// outbound (xray-core v26.1.23, `proxy/tun/stack_gvisor.go`). So the
/// probe said yes whenever xray.exe was running, node reachable or not,
/// and a node blocked mid-session -- the commonest failure in Iran --
/// read as "our API is down" instead of a dead tunnel: no strike, no
/// failover, "Connected, not confirmed" over a measured negative. The
/// service's Custom-mode check learned the same lesson
/// (`split_tunnel::health::prove_carries`). A verified certificate for
/// `one.one.one.one` or `dns.google` is something only the real far end
/// can produce, so a yes now means bytes made the round trip.
///
/// A yes still does not say traffic flowed *through the tunnel* -- the
/// address comparison is the only thing that says that -- so the
/// frontend treats it as "no verdict", never as proof.
#[tauri::command]
pub async fn probe_ipv4_egress() -> bool {
    let targets = IPV4_PROBES.map(|(address, name)| (std::net::SocketAddr::from((address, 443)), name));
    let config = crate::control_plane_probe::shared_tls_config();
    // Blocking sockets on a blocking thread, as the control-plane probe
    // does: a handshake that hangs to its limit must not hold Tauri's
    // runtime.
    tauri::async_runtime::spawn_blocking(move || any_answers_tls(&targets, IPV4_PROBE_TIMEOUT, &config))
        .await
        .unwrap_or(false)
}

/// Whether any of `targets` completes a TLS handshake, certificate
/// verified for the name paired with it, within `limit`. All at once, so
/// the whole check costs one limit rather than one per target, and the
/// first yes answers without waiting for the rest.
pub(crate) fn any_answers_tls(
    targets: &[(std::net::SocketAddr, &'static str)],
    limit: Duration,
    config: &std::sync::Arc<rustls::ClientConfig>,
) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    for &(address, name) in targets {
        let tx = tx.clone();
        let config = std::sync::Arc::clone(config);
        // A thread that cannot be started is one target with no answer,
        // not a failed check.
        let _ = std::thread::Builder::new()
            .name("neoxify-egress-probe".into())
            .spawn(move || {
                let _ = tx.send(answers_tls(address, name, &config, limit));
            });
    }
    drop(tx);
    // Ends at the first yes, or once every thread has said no -- each is
    // bounded by `limit`. The threads still running after a yes finish
    // on their own within it.
    rx.iter().any(|answered| answered)
}

/// One target: a TCP handshake, then a TLS one with whatever is left.
fn answers_tls(
    address: std::net::SocketAddr,
    name: &str,
    config: &std::sync::Arc<rustls::ClientConfig>,
    limit: Duration,
) -> bool {
    let started = std::time::Instant::now();
    let Ok(stream) = std::net::TcpStream::connect_timeout(&address, limit) else {
        return false;
    };
    let remaining = limit.saturating_sub(started.elapsed());
    !remaining.is_zero() && crate::control_plane_probe::handshake(stream, name, config, remaining).is_ok()
}

/// Whether either of two literal addresses completes a TCP handshake in
/// time. Concurrently, so the whole check costs one timeout rather than
/// two.
///
/// Used by the IPv6 probe only. A completed TCP handshake says nothing
/// about the far end once a userspace stack can answer it -- see
/// `probe_ipv4_egress` for Xray's -- so this is not a test of whether
/// traffic gets through a tunnel.
async fn any_reaches(probes: [(&'static str, u16); 2], timeout: Duration) -> bool {
    use tokio::net::TcpStream;

    let attempts = probes.map(|(address, port)| async move {
        matches!(
            tokio::time::timeout(timeout, TcpStream::connect((address, port))).await,
            Ok(Ok(_))
        )
    });
    let [first, second] = attempts;
    let (first, second) = tokio::join!(first, second);
    first || second
}


/// How long one reachability probe gets.
///
/// Short on purpose. This runs against every candidate at once before
/// anything is dialled, and its whole value is being over before a
/// customer notices. A filtered endpoint in Iran does not refuse -- it
/// blackholes -- so the timeout *is* the answer for the blocked case,
/// and every extra second is a second added to every connect.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1200);

/// Whether a TCP endpoint will complete a handshake right now.
///
/// The ladder used to find this out by dialling: spawn the engine,
/// install routes, wait out a settle budget, fail, tear down, try the
/// next. On a filtered network that is tens of seconds per dead
/// protocol, in series, which is why people try three or four and
/// decide the app is broken.
///
/// A TCP handshake answers the same question -- can this machine reach
/// this port at all -- for a fraction of the cost and with nothing to
/// clean up afterwards, and dozens can run at once.
///
/// **It only answers for TCP-carried protocols.** WireGuard, OpenVPN
/// and IKEv2 are UDP, and a TCP connect against them always fails
/// whether the network is filtered or not. Callers must not read a
/// `false` here as evidence about those -- see `probeable()` on the
/// client side, which is what decides who gets asked.
///
/// A completed handshake is also not proof the tunnel will carry
/// traffic: DPI can allow the handshake and drop the stream, which is
/// the `NOT_CARRYING_TRAFFIC` outcome. This narrows the field; it does
/// not settle it.
#[tauri::command]
pub async fn probe_tcp(host: String, port: u16) -> bool {
    use tokio::net::TcpStream;
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect((host.as_str(), port))).await,
        Ok(Ok(_))
    )
}

/// Generous enough that a distant server still measures, short enough that
/// a dead one does not hold up the list.
const LATENCY_TIMEOUT: Duration = Duration::from_millis(2500);

/// Round-trip time to a server: a TCP handshake against its port, raced
/// with one ICMP echo from the system's `ping`.
///
/// TCP alone can never answer for WireGuard or OpenVPN, which listen on
/// UDP, so their rows would always read "--". Windows races ICMP for the
/// same reason. Here it is the distribution's `ping`, which sends an echo
/// without privileges through a ping socket; where it is missing or ICMP
/// is filtered, that side simply has no answer. Whichever succeeds first
/// is the number; None when neither does, so the interface shows "--"
/// rather than an invented value.
#[tauri::command]
pub async fn measure_latency(host: String, port: u16) -> Option<u32> {
    use tokio::net::TcpStream;

    let tcp = async {
        let started = std::time::Instant::now();
        match tokio::time::timeout(LATENCY_TIMEOUT, TcpStream::connect((host.as_str(), port))).await {
            Ok(Ok(_stream)) => Some(started.elapsed().as_millis() as u32),
            Ok(Err(_)) | Err(_) => None,
        }
    };
    let icmp = ping_latency(host.clone());
    tokio::pin!(tcp);
    tokio::pin!(icmp);

    // The first successful answer wins; a failure on one side must not
    // cancel the other. Per-branch guards so a finished future is never
    // polled again.
    let mut tcp_done = false;
    let mut icmp_done = false;
    loop {
        tokio::select! {
            result = &mut tcp, if !tcp_done => {
                if result.is_some() { return result; }
                tcp_done = true;
            }
            result = &mut icmp, if !icmp_done => {
                if result.is_some() { return result; }
                icmp_done = true;
            }
            else => return None,
        }
    }
}

/// One echo through `ping`, to the host's first IPv4 address (every node is
/// IPv4-only). None for no reply, no `ping`, or no address.
async fn ping_latency(host: String) -> Option<u32> {
    let address = tokio::net::lookup_host((host.as_str(), 0))
        .await
        .ok()?
        .find_map(|a| match a.ip() {
            std::net::IpAddr::V4(v4) => Some(v4),
            std::net::IpAddr::V6(_) => None,
        })?;
    let wait = LATENCY_TIMEOUT.as_secs().max(1).to_string();
    let child = tokio::process::Command::new("ping")
        .args(["-n", "-c", "1", "-W", &wait])
        .arg(address.to_string())
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(LATENCY_TIMEOUT + Duration::from_millis(500), child).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    ping_time(&String::from_utf8_lossy(&output.stdout))
}

/// The `time=` of a ping reply, rounded to whole milliseconds, at least 1:
/// a reply is never zero, and the interface reads 0 as no number.
fn ping_time(output: &str) -> Option<u32> {
    let rest = &output[output.find("time=")? + 5..];
    let number: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let ms: f64 = number.parse().ok()?;
    ms.is_finite().then(|| (ms.round() as u32).max(1))
}

#[tauri::command]
pub async fn vpn_status() -> Result<VpnStatus, String> {
    match call(&Request::Status).await? {
        Response::State {
            connected,
            protocol,
            health,
            split_tunnel_active,
            split_tunnel_problem,
            ipv6_blocked,
            tunnel_dns_unprotected,
            split_tunnel_restart_needed,
            ipv4_confined,
            confinement_problem,
            reconnect_hold,
            traffic,
            split_tunnel_problem_code,
            session_secs,
        } => Ok(VpnStatus {
            connected,
            protocol,
            health,
            split_tunnel_active,
            split_tunnel_problem,
            ipv6_blocked,
            tunnel_dns_unprotected,
            split_tunnel_restart_needed,
            ipv4_confined,
            confinement_problem,
            reconnect_hold,
            traffic,
            split_tunnel_problem_code,
            session_secs,
        }),
        Response::Error { message } => Err(message),
        _ => Err("the background service returned an unexpected reply".into()),
    }
}

/// Gaming mode is not in the Linux first version.
#[tauri::command]
pub async fn gaming_arm() -> Result<GamingStatus, String> {
    Err(not_on_linux("Gaming mode"))
}

/// Nothing can be armed on Linux, so disarming always succeeds: the
/// interface calls this defensively, and failing would report a problem
/// with a state that is already right.
#[tauri::command]
pub async fn gaming_disarm() -> Result<(), String> {
    Ok(())
}

/// Off, and truly so: no rule of ours can exist on Linux. Not `unknown`,
/// which would say nothing could be confirmed.
#[tauri::command]
pub async fn gaming_status() -> Result<GamingStatus, String> {
    Ok(GamingStatus {
        state: GamingPhase::Off,
        detail: None,
        rules_present: false,
        canary_ok: false,
        proxy_reachable: false,
        namespaces: Vec::new(),
    })
}

// --- The local network tables ------------------------------------------
//
// Read from /proc/net/route, /proc/net/arp and /sys/class/net, which any
// user can read, so the app needs no privilege for them. /proc/net/route is
// the main routing table only; WireGuard's own table (28280) is not in it,
// so the physical gateway stays visible under a WireGuard tunnel.

/// Our own interfaces, by the names the helper gives them (Xray's tun,
/// WireGuard's, OpenVPN's). A route on one of them is never a way out.
const OUR_INTERFACES: [&str; 3] = ["neoconnect0", "neoxify-wg", "neoxify-ovpn"];

/// One IPv4 route from /proc/net/route. Addresses are kept as the kernel
/// prints them: the network-order bytes read as a host integer, so masking
/// and comparing work directly and `to_ne_bytes` gives the octets back.
#[derive(Debug, Clone, PartialEq)]
struct Route {
    interface: String,
    destination: u32,
    gateway: u32,
    mask: u32,
    metric: u32,
}

const RTF_UP: u32 = 0x0001;
const RTF_REJECT: u32 = 0x0200;

fn parse_routes(text: &str) -> Vec<Route> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 8 {
                return None;
            }
            let hex = |s: &str| u32::from_str_radix(s, 16).ok();
            let flags = hex(f[3])?;
            if flags & RTF_UP == 0 || flags & RTF_REJECT != 0 {
                return None;
            }
            Some(Route {
                interface: f[0].to_string(),
                destination: hex(f[1])?,
                gateway: hex(f[2])?,
                metric: f[6].parse().ok()?,
                mask: hex(f[7])?,
            })
        })
        .collect()
}

fn routes() -> Option<Vec<Route>> {
    std::fs::read_to_string("/proc/net/route").ok().map(|t| parse_routes(&t))
}

/// The route the kernel would pick for `target` from the main table: the
/// longest prefix, then the lowest metric.
fn best_route(routes: &[Route], target: std::net::Ipv4Addr) -> Option<&Route> {
    let raw = u32::from_ne_bytes(target.octets());
    routes
        .iter()
        .filter(|r| raw & r.mask == r.destination & r.mask)
        .max_by(|a, b| {
            a.mask
                .count_ones()
                .cmp(&b.mask.count_ones())
                .then(b.metric.cmp(&a.metric))
        })
}

fn as_address(raw: u32) -> std::net::Ipv4Addr {
    std::net::Ipv4Addr::from(raw.to_ne_bytes())
}

/// The hardware address /proc/net/arp holds for `ip`, if the entry is
/// complete (flag 0x2) and not all zeros.
fn arp_mac(arp: &str, ip: std::net::Ipv4Addr) -> Option<String> {
    let wanted = ip.to_string();
    arp.lines().skip(1).find_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || f[0] != wanted {
            return None;
        }
        let flags = u32::from_str_radix(f[2].trim_start_matches("0x"), 16).ok()?;
        let mac = f[3].to_lowercase();
        (flags & 0x2 != 0 && mac != "00:00:00:00:00:00").then_some(mac)
    })
}

/// A stable identifier for the network this machine is on: the default
/// gateway's MAC, which tells apart two networks that both hand out
/// 192.168.1.x behind 192.168.1.1, as the gateway's address does not.
/// Failover remembers which protocol worked per network by it.
///
/// None when it cannot be told -- no gateway, an on-link route such as a
/// live Xray or OpenVPN tunnel's halves of the table, or no ARP entry --
/// and the caller treats that as one shared unknown network rather than an
/// invented identity.
#[tauri::command]
pub fn network_fingerprint() -> Option<String> {
    let routes = routes()?;
    let route = best_route(&routes, std::net::Ipv4Addr::new(1, 1, 1, 1))?;
    if route.gateway == 0 {
        return None;
    }
    let arp = std::fs::read_to_string("/proc/net/arp").ok()?;
    arp_mac(&arp, as_address(route.gateway))
}

/// Whether an interface is up. `operstate` says "up" for most links, and
/// "unknown" for some that are working (PPP, some drivers), which then
/// count when the kernel flags them up and running.
fn interface_up(name: &str) -> bool {
    let base = std::path::Path::new("/sys/class/net").join(name);
    let state = std::fs::read_to_string(base.join("operstate")).unwrap_or_default();
    match state.trim() {
        "up" => true,
        "unknown" => std::fs::read_to_string(base.join("flags"))
            .ok()
            .and_then(|f| u32::from_str_radix(f.trim().trim_start_matches("0x"), 16).ok())
            .is_some_and(|flags| flags & 0x1 != 0 && flags & 0x40 != 0),
        _ => false,
    }
}

/// An interface a way out may leave by: up, and not one of ours.
fn usable_interface(up: bool, name: &str) -> bool {
    up && !OUR_INTERFACES.contains(&name)
}

/// Whether this machine has a way out to the internet right now. Asked of
/// the helper first (`Request::WayOut`, the very rule a connect is refused
/// by); for a helper that does not answer in time, the app's own reading:
/// the best route toward a public address on an up interface that is not
/// ours, or a default route on one.
#[tauri::command]
pub async fn network_way_out(payload: Option<ProtocolUserPayload>) -> bool {
    if let Some(profile) = payload.and_then(|payload| payload.into_profile().ok()) {
        if let Some(said) = way_out_said(call_within(&Request::WayOut { profile }, WAY_OUT_REPLY_TIMEOUT).await) {
            return said;
        }
    }
    local_way_out()
}

const WAY_OUT_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// The helper's answer to `Request::WayOut`: `Ok` a way out; its
/// no-network words none; anything else says nothing, and the app reads
/// the tables itself.
fn way_out_said(answer: Result<Response, String>) -> Option<bool> {
    match answer {
        Ok(Response::Ok) => Some(true),
        Ok(Response::Error { message }) if message == neoconnect_ipc::NO_NETWORK => Some(false),
        _ => None,
    }
}

fn local_way_out() -> bool {
    let Some(routes) = routes() else {
        return false;
    };
    way_out_from(&routes, |name| usable_interface(interface_up(name), name))
}

/// The decision behind [`local_way_out`], on routes already read.
fn way_out_from(routes: &[Route], usable: impl Fn(&str) -> bool) -> bool {
    if best_route(routes, std::net::Ipv4Addr::new(1, 1, 1, 1)).is_some_and(|r| usable(&r.interface)) {
        return true;
    }
    routes.iter().filter(|r| r.mask == 0).any(|r| usable(&r.interface))
}

/// The machine's ways out, as a string that changes when they do: every
/// IPv4 default route's interface and next hop, with the addresses that
/// interface holds. The empty string is no way out; None, that the tables
/// could not be read. What the dashboard watches under a live tunnel
/// (`lib/uplink-watch.ts`), so a dropped link or a roam is re-verified.
///
/// Default routes only, so Xray's and OpenVPN's halves of the table and the
/// host route to the server are not in it.
#[tauri::command]
pub fn network_uplinks() -> Option<String> {
    let routes = routes()?;
    let defaults: Vec<(String, u32)> =
        routes.iter().filter(|r| r.mask == 0).map(|r| (r.interface.clone(), r.gateway)).collect();
    let addresses = interface_addresses()?;
    Some(uplink_fingerprint(&defaults, &addresses))
}

/// `(interface, address)` of every IPv4 address on the machine, from
/// getifaddrs.
fn interface_addresses() -> Option<Vec<(String, std::net::Ipv4Addr)>> {
    let mut out = Vec::new();
    // SAFETY: getifaddrs fills `head` with a list we own until
    // freeifaddrs; each node is read only while the list is alive, and its
    // name and address pointers are checked for null before use.
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 {
            return None;
        }
        let mut node = head;
        while !node.is_null() {
            let entry = &*node;
            if !entry.ifa_addr.is_null()
                && !entry.ifa_name.is_null()
                && i32::from((*entry.ifa_addr).sa_family) == libc::AF_INET
            {
                let sin = &*(entry.ifa_addr as *const libc::sockaddr_in);
                let address = std::net::Ipv4Addr::from(sin.sin_addr.s_addr.to_ne_bytes());
                let name = std::ffi::CStr::from_ptr(entry.ifa_name).to_string_lossy().into_owned();
                out.push((name, address));
            }
            node = entry.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    Some(out)
}

/// The ways out as one string, the same whatever order the tables list
/// them in: `interface>next hop@address+address`, joined by commas.
/// Addresses on interfaces with no default route change nothing.
fn uplink_fingerprint(routes: &[(String, u32)], addresses: &[(String, std::net::Ipv4Addr)]) -> String {
    let mut ways: Vec<String> = routes
        .iter()
        .map(|(name, next_hop)| {
            let mut held: Vec<std::net::Ipv4Addr> = addresses
                .iter()
                .filter(|(on, a)| on == name && !a.is_unspecified())
                .map(|(_, a)| *a)
                .collect();
            held.sort();
            held.dedup();
            let held: Vec<String> = held.iter().map(|a| a.to_string()).collect();
            format!("{name}>{}@{}", as_address(*next_hop), held.join("+"))
        })
        .collect();
    ways.sort();
    ways.dedup();
    ways.join(",")
}

/// Gaming mode's state, in the shape the frontend reads (the Windows
/// names, so the shared interface reads it unchanged).
#[derive(Debug, serde::Serialize)]
pub struct GamingStatus {
    /// `off` | `arming` | `active` | `partial` | `unknown`.
    state: GamingPhase,
    /// Which check failed, in words, when `state` is not `active`.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// Check 1: every NRPT rule the service installed is present in the
    /// registry right now.
    #[serde(rename = "rulesPresent")]
    rules_present: bool,
    /// Check 2: the canary hostname resolves to the proxy address.
    #[serde(rename = "canaryOk")]
    canary_ok: bool,
    /// Check 3: a TCP connect to the proxy succeeds.
    #[serde(rename = "proxyReachable")]
    proxy_reachable: bool,
    /// The suffixes actually scoped right now -- what is installed, not
    /// what was asked for.
    namespaces: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(
        protocol: &str,
        credentials: serde_json::Value,
        public_params: serde_json::Value,
    ) -> ProtocolUserPayload {
        ProtocolUserPayload {
            protocol: protocol.into(),
            credentials,
            connection: ConnectionInfo {
                host: "203.0.113.5".into(),
                port: 443,
                transport: None,
                public_params,
            },
        }
    }

    #[test]
    fn maps_a_wireguard_protocol_user() {
        let profile = payload(
            "WIREGUARD",
            serde_json::json!({
                "privateKey": "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=",
                "address": "10.77.0.8/32",
                "dns": "1.1.1.1",
                "allowedIPs": "0.0.0.0/0, ::/0",
                "serverPublicKey": "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=",
                "endpoint": "203.0.113.5:51888"
            }),
            serde_json::json!({}),
        )
        .into_profile()
        .expect("should map");
        assert_eq!(profile.protocol_name(), "WIREGUARD");
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn maps_a_trojan_protocol_user() {
        let profile = payload(
            "XRAY_TROJAN",
            serde_json::json!({ "password": "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRg" }),
            serde_json::json!({ "serverName": "vpn.example.com" }),
        )
        .into_profile()
        .expect("should map");
        assert_eq!(profile.protocol_name(), "XRAY_TROJAN");
        assert!(profile.validate().is_ok());
    }

    /// The certificate name is the server's, not the customer's, so it
    /// comes from the node's config. This used to fall back to the host
    /// on the theory that a wrong name beats no name -- but the host is
    /// an IP, uTLS omits an IP literal from SNI altogether, and the
    /// certificate check fails against it regardless. The fallback
    /// produced the conspicuous handshake it was meant to prevent, so a
    /// node missing this field is now a refusal the customer can report.
    #[test]
    fn trojan_without_a_server_name_is_rejected() {
        let err = payload(
            "XRAY_TROJAN",
            serde_json::json!({ "password": "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRg" }),
            serde_json::json!({}),
        )
        .into_profile()
        .expect_err("should refuse");
        assert!(err.contains("serverName"), "unhelpful message: {err}");
    }

    #[test]
    fn trojan_without_a_password_is_rejected() {
        // Silently connecting with an empty password would be
        // indistinguishable from the server being a plain web server,
        // leaving the customer nothing to act on.
        assert!(
            payload("XRAY_TROJAN", serde_json::json!({}), serde_json::json!({}))
                .into_profile()
                .is_err()
        );
    }

    #[test]
    fn maps_a_vless_over_tls_protocol_user() {
        let profile = payload(
            "XRAY_VLESS_TLS",
            serde_json::json!({ "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "flow": "xtls-rprx-vision" }),
            serde_json::json!({ "serverName": "vpn.example.com" }),
        )
        .into_profile()
        .expect("should map");
        assert_eq!(profile.protocol_name(), "XRAY_VLESS_TLS");
        assert!(profile.validate().is_ok());
    }

    /// The certificate is checked against this name, so guessing
    /// produces a TLS failure with nothing pointing at the missing
    /// field -- exactly the shape of bug that made Trojan unusable from
    /// the app. Trojan now refuses for the same reason; see
    /// trojan_without_a_server_name_is_rejected.
    #[test]
    fn vless_over_tls_without_a_server_name_is_rejected() {
        assert!(payload(
            "XRAY_VLESS_TLS",
            serde_json::json!({ "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }),
            serde_json::json!({}),
        )
        .into_profile()
        .is_err());
    }

    #[test]
    fn maps_xray_pulling_reality_params_from_the_connection_field() {
        // The whole reason `connection` exists: these values are not in
        // the per-user credentials for this protocol.
        //
        // The camouflage name here was www.microsoft.com, copied from a
        // node that had it. It is the one domain this project knows to
        // be a bad choice -- endpoint security software intercepts it,
        // and REALITY then fails with "received real certificate" (see
        // docs/detection-resistance.md) -- so it does not belong in a
        // fixture people copy from.
        let profile = payload(
            "XRAY_VLESS_REALITY",
            serde_json::json!({ "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "flow": "xtls-rprx-vision" }),
            serde_json::json!({
                "realityPublicKey": "3Qc9mFkJz8xN2pQrStUvWxYz0123456789abcdefgh",
                "shortIds": ["0123abcd"],
                "serverName": "www.example.org",
                "dest": "www.example.org:443"
            }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::XrayVlessReality(p) => {
                assert_eq!(p.short_id, "0123abcd");
                assert_eq!(p.server_name, "www.example.org");
                assert_eq!(p.host, "203.0.113.5");
                assert_eq!(p.port, 443);
            }
            _ => panic!("wrong variant"),
        }
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn reports_a_misconfigured_server_clearly() {
        // A node whose ProtocolConfig was registered without its REALITY
        // params -- exactly the class of misconfiguration that produced
        // an opaque failure in the field before.
        let err = payload(
            "XRAY_VLESS_REALITY",
            serde_json::json!({ "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }),
            serde_json::json!({}),
        )
        .into_profile()
        .expect_err("should fail");
        assert!(err.contains("shortIds"), "unhelpful message: {err}");
    }

    /// Shadowsocks is the one profile whose secret is assembled rather
    /// than passed through: the server's half lives on the node's config
    /// and the customer's half in their credentials, and the engine wants
    /// them joined. Neither half alone authenticates anyone, and the
    /// protocol answers a bad key with silence rather than a refusal --
    /// so a mistake here does not surface as an error, it surfaces as a
    /// server that appears to be down.
    #[test]
    fn maps_shadowsocks_by_joining_the_server_and_user_keys() {
        let profile = payload(
            "SHADOWSOCKS",
            serde_json::json!({ "userKey": "dXNlcmtleWJhc2U2NHZhbHVlMDEyMzQ1Njc4OQ" }),
            serde_json::json!({
                "serverKey": "c2VydmVya2V5YmFzZTY0dmFsdWUwMTIzNDU2Nzg5",
                "method": "2022-blake3-aes-256-gcm"
            }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::Shadowsocks(p) => {
                assert_eq!(
                    p.password,
                    "c2VydmVya2V5YmFzZTY0dmFsdWUwMTIzNDU2Nzg5:dXNlcmtleWJhc2U2NHZhbHVlMDEyMzQ1Njc4OQ",
                    "the two halves must be joined server-first"
                );
            }
            _ => panic!("wrong variant"),
        }
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn shadowsocks_without_the_server_half_is_rejected() {
        let err = payload(
            "SHADOWSOCKS",
            serde_json::json!({ "userKey": "dXNlcmtleWJhc2U2NHZhbHVlMDEyMzQ1Njc4OQ" }),
            serde_json::json!({ "method": "2022-blake3-aes-256-gcm" }),
        )
        .into_profile()
        .expect_err("should fail");
        assert!(err.contains("server key"), "unhelpful message: {err}");
    }

    /// tls-crypt is the one OpenVPN value that is the server's rather
    /// than the customer's, so it comes from the node's config. Getting
    /// it wrong is not loud: a server using tls-crypt does not reject a
    /// client that omits the key, it ignores the client entirely, and the
    /// connection just never completes.
    #[test]
    fn maps_openvpn_pulling_the_tls_crypt_key_from_the_node() {
        const PEM: &str = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQ==\n-----END CERTIFICATE-----\n";
        const KEY: &str = "-----BEGIN OpenVPN Static key V1-----\nabcdef0123456789\n-----END OpenVPN Static key V1-----\n";
        let profile = payload(
            "OPENVPN",
            serde_json::json!({
                "certPem": PEM, "keyPem": PEM, "caCertPem": PEM,
                "endpoint": "203.0.113.5:1194", "proto": "udp"
            }),
            serde_json::json!({ "tlsCryptKey": KEY }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::Openvpn(p) => {
                assert_eq!(p.tls_crypt_key.as_deref(), Some(KEY));
                assert_eq!(p.proto, "udp");
            }
            _ => panic!("wrong variant"),
        }
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn maps_an_ikev2_protocol_user_from_the_recorded_hostname() {
        let profile = payload(
            "IKEV2",
            serde_json::json!({ "username": "cust-4f89", "password": "Zm9vYmFyYmF6cXV4MTIz" }),
            serde_json::json!({ "endpointHost": "ikev2.example.com" }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::Ikev2(p) => assert_eq!(p.server, "ikev2.example.com"),
            _ => panic!("wrong variant"),
        }
        assert!(profile.validate().is_ok());
    }

    /// Windows checks the server's certificate against whatever was
    /// dialled, and the node presents one for its hostname. Falling back
    /// to `connection.host` would therefore turn a missing field into a
    /// certificate error at the very end of a slow handshake, naming
    /// neither the address nor the real cause -- so the absence is
    /// refused here, where it can still be explained.
    #[test]
    fn ikev2_refuses_to_fall_back_to_the_address() {
        let err = payload(
            "IKEV2",
            serde_json::json!({ "username": "cust-4f89", "password": "Zm9vYmFyYmF6cXV4MTIz" }),
            serde_json::json!({}),
        )
        .into_profile()
        .expect_err("should fail");
        assert!(err.contains("hostname"), "unhelpful message: {err}");
    }

    #[test]
    fn rejects_a_protocol_the_service_cannot_run() {
        let err = payload("XRAY_VMESS", serde_json::json!({}), serde_json::json!({}))
            .into_profile()
            .expect_err("should fail");
        assert!(err.contains("unsupported protocol"));
    }
}

#[cfg(test)]
mod ipv4_egress_probe_tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::time::Instant;

    const LIMIT: Duration = Duration::from_millis(1_000);

    fn config() -> std::sync::Arc<rustls::ClientConfig> {
        crate::control_plane_probe::shared_tls_config()
    }

    /// A listener on loopback, and what its one accepted connection does.
    fn peer(behaviour: impl FnOnce(TcpStream) + Send + 'static) -> (SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let address = listener.local_addr().expect("addr");
        let server = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                behaviour(stream);
            }
        });
        (address, server)
    }

    /// What xray.exe's `tun` inbound does when the node cannot be
    /// reached: its userspace stack has already completed the TCP
    /// handshake, the outbound never connects, and nothing comes back.
    /// The probe this replaced asked only for that handshake, so it said
    /// yes -- and a dead Xray tunnel read as "our API is down".
    #[test]
    fn a_handshake_answered_and_then_silent_is_not_the_internet() {
        let (address, server) = peer(|mut stream| {
            // Takes the ClientHello and says nothing, until the probe
            // gives up and closes.
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut sink = [0u8; 2048];
            while matches!(std::io::Read::read(&mut stream, &mut sink), Ok(n) if n > 0) {}
        });

        let started = Instant::now();
        assert!(!any_answers_tls(&[(address, "one.one.one.one")], LIMIT, &config()));
        assert!(started.elapsed() < LIMIT + Duration::from_millis(1_500), "bounded by its limit");
        server.join().unwrap();

        // Control: the question the old probe asked, of the same kind of
        // peer, is answered yes. That is the false "the internet works".
        let (address, server) = peer(|stream| {
            std::thread::sleep(Duration::from_millis(200));
            drop(stream);
        });
        let port = address.port();
        let old = tauri::async_runtime::block_on(any_reaches([("127.0.0.1", port), ("127.0.0.1", port)], LIMIT));
        assert!(old, "a bare TCP handshake passes against a peer that never answers");
        server.join().unwrap();
    }

    /// The outbound failing fast instead: the connection is closed with
    /// nothing sent.
    #[test]
    fn a_peer_that_hangs_up_is_not_the_internet() {
        let (address, server) = peer(drop);
        assert!(!any_answers_tls(&[(address, "one.one.one.one")], LIMIT, &config()));
        server.join().unwrap();
    }

    /// Bytes came back, but not from the named server: a captive portal,
    /// a block page, a decoy site. Only a certificate that verifies for
    /// the name counts.
    #[test]
    fn an_answer_that_is_not_the_named_server_is_not_the_internet() {
        let (address, server) = peer(|mut stream| {
            let mut hello = [0u8; 2048];
            let _ = std::io::Read::read(&mut stream, &mut hello);
            let _ = std::io::Write::write_all(&mut stream, b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        });
        assert!(!any_answers_tls(&[(address, "dns.google")], LIMIT, &config()));
        server.join().unwrap();
    }

    /// Nothing listening at all.
    #[test]
    fn a_refused_connection_is_not_the_internet() {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port();
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        assert!(!any_answers_tls(&[(address, "one.one.one.one")], LIMIT, &config()));
    }

    /// Against the real resolvers, by hand:
    ///
    /// ```text
    /// cargo test -p neoconnect-desktop --lib live_ipv4_egress_probe -- --ignored --nocapture
    /// ```
    ///
    /// Prints, per target, what the old criterion (a TCP handshake) and
    /// the new one (a verified TLS handshake) say from wherever it runs.
    /// On a working network both are yes. Through a tunnel whose far end
    /// is dead, the second must be no. Ignored because its answer
    /// depends on the network it runs on.
    #[test]
    #[ignore]
    fn live_ipv4_egress_probe() {
        let config = config();
        for (address, name) in IPV4_PROBES {
            let target = SocketAddr::from((address, 443));
            let tcp = TcpStream::connect_timeout(&target, IPV4_PROBE_TIMEOUT).is_ok();
            let started = Instant::now();
            let tls = any_answers_tls(&[(target, name)], IPV4_PROBE_TIMEOUT, &config);
            println!("{target} ({name}): tcp handshake {tcp}, verified tls {tls} in {}ms", started.elapsed().as_millis());
        }
        let started = Instant::now();
        let verdict = tauri::async_runtime::block_on(probe_ipv4_egress());
        println!("probe_ipv4_egress: {verdict} in {}ms", started.elapsed().as_millis());
    }
}

#[cfg(test)]
mod linux_tests {
    use super::*;
    use std::net::Ipv4Addr;

    /// As /proc/net/route prints an address: the network-order bytes read
    /// as a host integer, in hex.
    fn hex(a: [u8; 4]) -> String {
        format!("{:08X}", u32::from_ne_bytes(a))
    }

    fn route_table(rows: &[(&str, [u8; 4], [u8; 4], u32, u32, [u8; 4])]) -> String {
        let mut text = String::from("Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n");
        for (iface, dest, gw, flags, metric, mask) in rows {
            text.push_str(&format!(
                "{iface}\t{}\t{}\t{flags:04X}\t0\t0\t{metric}\t{}\t0\t0\t0\n",
                hex(*dest),
                hex(*gw),
                hex(*mask)
            ));
        }
        text
    }

    #[test]
    fn the_default_route_is_found_and_its_gateway_read_back() {
        let table = route_table(&[
            ("eth0", [0, 0, 0, 0], [192, 0, 2, 1], 0x3, 100, [0, 0, 0, 0]),
            ("eth0", [192, 0, 2, 0], [0, 0, 0, 0], 0x1, 100, [255, 255, 255, 0]),
        ]);
        let routes = parse_routes(&table);
        let best = best_route(&routes, Ipv4Addr::new(1, 1, 1, 1)).expect("a route");
        assert_eq!(best.interface, "eth0");
        assert_eq!(as_address(best.gateway), Ipv4Addr::new(192, 0, 2, 1));
    }

    /// Xray's two halves of the table beat the default route on prefix
    /// length, and have no gateway: a live tunnel, nothing to fingerprint.
    #[test]
    fn the_tunnels_halves_win_and_carry_no_gateway() {
        let table = route_table(&[
            ("eth0", [0, 0, 0, 0], [192, 0, 2, 1], 0x3, 100, [0, 0, 0, 0]),
            ("neoconnect0", [0, 0, 0, 0], [0, 0, 0, 0], 0x1, 0, [128, 0, 0, 0]),
            ("neoconnect0", [128, 0, 0, 0], [0, 0, 0, 0], 0x1, 0, [128, 0, 0, 0]),
        ]);
        let routes = parse_routes(&table);
        let best = best_route(&routes, Ipv4Addr::new(1, 1, 1, 1)).expect("a route");
        assert_eq!(best.interface, "neoconnect0");
        assert_eq!(best.gateway, 0);
        // And the machine still has a way out: the default on eth0.
        assert!(way_out_from(&routes, |name| usable_interface(true, name)));
    }

    #[test]
    fn the_lower_metric_wins_between_equal_prefixes() {
        let table = route_table(&[
            ("wlan0", [0, 0, 0, 0], [198, 51, 100, 1], 0x3, 600, [0, 0, 0, 0]),
            ("eth0", [0, 0, 0, 0], [192, 0, 2, 1], 0x3, 100, [0, 0, 0, 0]),
        ]);
        let routes = parse_routes(&table);
        assert_eq!(best_route(&routes, Ipv4Addr::new(1, 1, 1, 1)).unwrap().interface, "eth0");
    }

    #[test]
    fn a_route_that_is_down_or_a_reject_is_not_a_route() {
        let table = route_table(&[
            ("eth0", [0, 0, 0, 0], [192, 0, 2, 1], 0x2, 100, [0, 0, 0, 0]),
            ("lo", [0, 0, 0, 0], [0, 0, 0, 0], 0x201, 100, [0, 0, 0, 0]),
        ]);
        assert!(parse_routes(&table).is_empty());
    }

    #[test]
    fn no_way_out_on_a_down_or_own_interface() {
        let table = route_table(&[("eth0", [0, 0, 0, 0], [192, 0, 2, 1], 0x3, 100, [0, 0, 0, 0])]);
        let routes = parse_routes(&table);
        assert!(!way_out_from(&routes, |name| usable_interface(false, name)));
        assert!(!way_out_from(&[], |_| true));
        for ours in OUR_INTERFACES {
            assert!(!usable_interface(true, ours), "{ours}");
        }
    }

    #[test]
    fn the_gateways_mac_comes_from_a_complete_arp_entry_only() {
        let arp = "IP address       HW type     Flags       HW address            Mask     Device\n\
                   192.0.2.1        0x1         0x2         52:54:00:12:35:02     *        eth0\n\
                   192.0.2.9        0x1         0x0         00:00:00:00:00:00     *        eth0\n";
        assert_eq!(arp_mac(arp, Ipv4Addr::new(192, 0, 2, 1)).as_deref(), Some("52:54:00:12:35:02"));
        assert_eq!(arp_mac(arp, Ipv4Addr::new(192, 0, 2, 9)), None);
        assert_eq!(arp_mac(arp, Ipv4Addr::new(192, 0, 2, 7)), None);
    }

    #[test]
    fn uplinks_change_with_the_address_and_not_with_order_or_the_tunnel() {
        let gw = u32::from_ne_bytes([192, 0, 2, 1]);
        let routes = [("eth0".to_string(), gw)];
        let home = uplink_fingerprint(&routes, &[("eth0".into(), Ipv4Addr::new(192, 0, 2, 20))]);
        assert_eq!(home, "eth0>192.0.2.1@192.0.2.20");
        let elsewhere = uplink_fingerprint(&routes, &[("eth0".into(), Ipv4Addr::new(192, 0, 2, 57))]);
        assert_ne!(home, elsewhere);
        let with_tunnel = uplink_fingerprint(
            &routes,
            &[("neoconnect0".into(), Ipv4Addr::new(198, 18, 0, 1)), ("eth0".into(), Ipv4Addr::new(192, 0, 2, 20))],
        );
        assert_eq!(home, with_tunnel);
        assert_eq!(uplink_fingerprint(&[], &[("eth0".into(), Ipv4Addr::new(192, 0, 2, 20))]), "");
    }

    #[test]
    fn a_ping_reply_is_read_to_whole_milliseconds() {
        let out = "PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.\n64 bytes from 192.0.2.1: icmp_seq=1 ttl=64 time=12.6 ms\n";
        assert_eq!(ping_time(out), Some(13));
        assert_eq!(ping_time("64 bytes from 192.0.2.1: icmp_seq=1 ttl=64 time=0.041 ms"), Some(1));
        assert_eq!(ping_time("1 packets transmitted, 0 received, 100% packet loss"), None);
    }

    #[test]
    fn ikev2_is_refused_with_a_sentence_and_the_rest_pass() {
        let ikev2 = ConnectProfile::Ikev2(Ikev2Profile {
            server: "vpn.example.com".into(),
            username: "u".into(),
            password: "p".into(),
        });
        let err = refuse_unsupported(&ikev2).unwrap_err();
        assert!(err.contains("IKEv2") && err.contains("Linux"), "{err}");
        let shadowsocks = ConnectProfile::Shadowsocks(ShadowsocksProfile {
            host: "192.0.2.5".into(),
            port: 443,
            method: "2022-blake3-aes-128-gcm".into(),
            password: "a:b".into(),
        });
        assert!(refuse_unsupported(&shadowsocks).is_ok());
    }

    /// The interface decides the helper is gone by this exact wording
    /// (`serviceGone` in desktop-windows src/lib/service-call.ts).
    #[tokio::test]
    async fn a_missing_helper_reads_as_the_service_being_gone() {
        if std::path::Path::new(SOCKET_PATH).exists() {
            return; // a helper is installed here; nothing to prove
        }
        let err = call(&Request::Status).await.unwrap_err();
        assert!(err.starts_with("Could not reach the Neoxify background service ("), "{err}");
        let shared = include_str!("../../../desktop-windows/src/lib/service-call.ts");
        assert!(shared.contains("\"Could not reach the Neoxify background service\""));
    }

    #[test]
    fn what_cannot_be_armed_is_reported_off_not_unknown() {
        let status = tauri::async_runtime::block_on(gaming_status()).unwrap();
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "off");
        assert!(tauri::async_runtime::block_on(gaming_disarm()).is_ok());
        assert!(tauri::async_runtime::block_on(vpn_release_reconnect_hold()).is_ok());
        assert!(tauri::async_runtime::block_on(vpn_set_split_tunnel(false)).is_ok());
        assert!(tauri::async_runtime::block_on(vpn_set_split_tunnel(true)).is_err());
    }
}
