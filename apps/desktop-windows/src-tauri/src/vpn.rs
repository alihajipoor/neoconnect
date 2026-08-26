//! Client side of the privileged helper service.
//!
//! This module used to run `wireguard.exe` directly via `runas`, which
//! meant a UAC prompt on every single Connect and a visible engine
//! process. It no longer touches an engine at all: it hands the
//! customer's credentials to the helper service over a local named pipe
//! and lets that service -- already running as LocalSystem, installed
//! once at install time -- do the privileged work silently.
//!
//! Nothing here is trusted by the service. The profile below carries
//! credentials only, never a path or command, and the service
//! re-validates every field before acting on it.

use std::time::Duration;

use neoconnect_ipc::{
    AppScope, ConnectProfile, Diagnostics, GamingConfig, GamingPhase, Ikev2Profile, OpenvpnProfile,
    RepairReport, Request, Response,
    ShadowsocksProfile, RunningApp, SplitTunnelConfig, SplitTunnelMode, TrojanProfile,
    TunnelHealth, VlessTlsProfile, WireguardProfile, XrayProfile,
    PIPE_NAME,
};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;

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

/// Sends one request and reads one response.
///
/// `security_qos_flags` is set to SECURITY_IDENTIFICATION: it stops the
/// process on the other end from impersonating this user's token if it
/// ever turns out not to be the service we expect. The service is
/// registered AutoStart so it owns the pipe name from boot, well before
/// any user process could squat it.
async fn call(request: &Request) -> Result<Response, String> {
    call_within(request, REPLY_TIMEOUT).await
}

/// How long an ordinary request may take to be answered.
///
/// Long enough that a connect, which tears an engine down and brings
/// another up, still answers inside it. Short enough that a customer
/// gets an error they can act on rather than a spinner that never ends.
const REPLY_TIMEOUT: Duration = Duration::from_secs(45);

/// The repair's own deadline, which has to be a different number.
///
/// **Derived, not chosen**, and the derivation is
/// [`neoconnect_ipc::REPAIR_WORST_CASE`] -- 735s, itemised there from
/// the service's own budget constants and asserted against them by a
/// test in `engines::repair`. The test below asserts this number covers
/// it, so the two cannot drift apart again.
///
/// They had drifted. The comment this replaces derived 195s as "nine
/// steps, each bounded by the fifteen-second helper budget", which was
/// arithmetic over a call graph nobody had counted: the pass makes 37
/// bounded spawns, not nine, and it spends 135s more in SCM poll loops
/// that spawn nothing at all. A clean machine with a leftover
/// `Neoxify-OpenVPN` adapter -- which is the ordinary state, because
/// that adapter is deliberately never deleted -- can reach 240s at full
/// budget with **nothing wrong on it**. The old number abandoned a
/// working repair, left the app with no report, and told the customer
/// nothing about a machine that had just been half-changed. This
/// feature exists for people whose networking is already broken, so
/// that is the worst direction to be wrong in.
///
/// The DNS change on this branch made the pass *cheaper*, not dearer,
/// and the saving is measurable rather than assumed: `dns::clear` and
/// `dns::clear_reporting` now ask the registry in-process and return
/// without a process when it reports zero rules of ours, which is the
/// answer on a clean machine. That removes both NRPT PowerShell spawns
/// from the clean path -- 15s + 60s -- taking a clean pass from 225s to
/// 150s at full budget. It removes nothing from the worst case, because
/// a machine that actually has rules to clear still reaches the
/// cmdlets. So the constant goes up despite the pass getting faster.
///
/// 750s rather than 735s: the spare 15s is one helper budget of slack
/// for the work on this path that has no budget at all -- three full
/// WFP filter enumerations, the ToolHelp process scans, the registry
/// sweeps and the report assembly.
///
/// It is a **backstop, not a target**. A clean machine's ten spawns
/// measure 3-5s in total on a developer workstation and about 48s on a
/// constrained guest; the 750s is what the code permits, and a customer
/// should never see it.
const REPAIR_TIMEOUT: Duration = Duration::from_secs(750);

async fn call_within(request: &Request, reply_timeout: Duration) -> Result<Response, String> {
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut attempts = 0;
    let client = loop {
        match ClientOptions::new()
            .security_qos_flags(windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION)
            .open(PIPE_NAME)
        {
            Ok(client) => break client,
            // All pipe instances are momentarily busy -- the documented
            // way to handle this is to wait and retry, not to fail.
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempts < 10 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                return Err(format!(
                    "Could not reach the Neoxify background service ({e}). Try restarting the app, or reinstalling if this keeps happening."
                ))
            }
        }
    };

    let mut encoded =
        serde_json::to_string(request).map_err(|e| format!("could not encode request: {e}"))?;
    encoded.push('\n');

    let mut reader = BufReader::new(client);
    reader
        .get_mut()
        .write_all(encoded.as_bytes())
        .await
        .map_err(|e| format!("could not send request to the background service: {e}"))?;

    // Bounded, because an unbounded read here is a hang with no way out.
    //
    // The service accepting the connection is not a promise that it will
    // answer: it handles one request at a time on purpose, so a reply can
    // be waiting behind something slow, and a wedged handler means no
    // reply at all. Without a deadline that leaves this future pending
    // for the life of the process, and every piece of UI waiting on it
    // pending with it -- which is exactly what "the app is stuck on
    // Disconnecting and I can't click anything" is.
    //
    // How long is the caller's decision -- see REPLY_TIMEOUT and
    // REPAIR_TIMEOUT above for why there are two numbers.
    let mut line = String::new();
    match tokio::time::timeout(reply_timeout, reader.read_line(&mut line)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            return Err(format!("could not read the background service's reply: {e}"))
        }
        Err(_) => {
            return Err(format!(
                "The Neoxify background service did not answer within {}s.                  It may be stuck -- restarting the app usually clears it.",
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
        Response::State { .. }
        | Response::RunningApps { .. }
        | Response::Repaired { .. }
        | Response::Diagnostics { .. }
        | Response::Gaming { .. } => {
            Err("the background service returned an unexpected reply".into())
        }
    }
}

/// Runs the repair through the service, and hands back what it found.
///
/// Everything this does is done by the service, elevated; the app is
/// only the thing asking. When the service cannot be reached at all --
/// which is precisely the case the repair is most needed in -- this
/// returns the pipe error, and the app answers it by showing the
/// customer the elevated command to run instead. That fallback is the
/// whole reason `neoconnect-service.exe repair` exists as a command.
///
/// No `Ok` short-circuit: a repair whose steps failed still returns its
/// report, because which step is stuck decides what the customer does
/// next. Only an error the service itself raised is surfaced as one.
#[tauri::command]
pub async fn vpn_repair() -> Result<RepairReport, String> {
    match call_within(&Request::Repair, REPAIR_TIMEOUT).await? {
        Response::Repaired { report } => Ok(report),
        Response::Error { message } => Err(message),
        _ => Err("the background service returned an unexpected reply".into()),
    }
}

/// A redacted snapshot of what this product has on the machine, for
/// pasting into a support conversation.
///
/// Asked of the service because almost none of it is visible to an
/// unelevated process: the NRPT registry keys, the image path of a
/// process the app does not own, and the service control manager all
/// need rights the app deliberately does not have.
#[tauri::command]
pub async fn vpn_diagnostics() -> Result<Diagnostics, String> {
    match call(&Request::Diagnostics).await? {
        Response::Diagnostics { diagnostics } => Ok(*diagnostics),
        Response::Error { message } => Err(message),
        _ => Err("the background service returned an unexpected reply".into()),
    }
}

/// Where the helper service is installed, for the message shown when the
/// app cannot reach it.
///
/// Derived from this executable's own location rather than hardcoded:
/// the installer puts the app in `Neoxify\` and the service beside its
/// resources, and a per-user install puts both somewhere else entirely.
/// Telling a customer to run a command at a path that does not exist on
/// their machine is worse than telling them nothing -- it reads as the
/// product not knowing where it is.
#[tauri::command]
pub fn repair_command_line() -> String {
    let exe = std::env::current_exe().ok();
    let candidate = exe
        .as_ref()
        .and_then(|e| e.parent())
        .map(|dir| dir.join("resources").join("neoconnect-service.exe"))
        .filter(|p| p.exists());
    match candidate {
        Some(path) => format!("\"{}\" repair", path.display()),
        // The installed default, named plainly rather than guessed at
        // silently. If the file is not where this expects, the customer
        // still has the shape of the command and the name of the binary
        // to find.
        None => r#""C:\Program Files\Neoxify\resources\neoconnect-service.exe" repair"#.to_string(),
    }
}

#[tauri::command]
pub async fn vpn_connect(payload: ProtocolUserPayload) -> Result<(), String> {
    let profile = payload.into_profile()?;
    call_expecting_ok(&Request::Connect { profile }).await
}

#[tauri::command]
pub async fn vpn_disconnect() -> Result<(), String> {
    call_expecting_ok(&Request::Disconnect).await
}

/// Asks the service to prove the tunnel is carrying traffic, over a
/// socket pinned to it exactly as a selected app's traffic is.
///
/// The app's own egress check cannot answer this in Custom mode: the app
/// is not one of the selected apps, so its request leaves by the
/// ordinary route by design and correctly reports the tunnel bypassed.
/// Leaving it in charge meant every protocol "failed", the ladder walked
/// all five, and the customer was told it could not connect while the
/// tunnel was up and working.
#[tauri::command]
pub async fn vpn_probe_split_tunnel() -> Result<(), String> {
    call_expecting_ok(&Request::ProbeSplitTunnel).await
}

/// Tells the service which applications, if any, are the only ones whose
/// traffic should go through the tunnel.
///
/// Sent whenever the setting changes and again before every connect, so
/// the service never has to assume a previous selection survived a
/// restart -- it runs as a Windows service and can be restarted
/// independently of the app.
#[tauri::command]
pub async fn vpn_set_split_tunnel(
    enabled: bool,
    apps: Vec<String>,
    mode: SplitTunnelMode,
    // Defaulted so the command keeps its old shape for any caller that
    // does not send it, which is every caller that predates destination
    // scoping. An app and a service are updated separately here -- the
    // service is a Windows service with its own lifetime -- so both
    // directions of version skew have to be uneventful.
    #[allow(clippy::default_trait_access)] scopes: Option<Vec<AppScope>>,
) -> Result<(), String> {
    call_expecting_ok(&Request::SetSplitTunnel {
        config: SplitTunnelConfig {
            enabled,
            apps,
            mode,
            scopes: scopes.unwrap_or_default(),
        },
    })
    .await
}

/// The applications running right now, for the in-app picker.
///
/// Asked of the service because the app is not elevated: it can see
/// that a process exists but not the image path of one it does not own,
/// and the path is exactly what a selection is made of.
#[tauri::command]
pub async fn vpn_list_running_apps() -> Result<Vec<RunningApp>, String> {
    match call(&Request::ListRunningApps).await? {
        Response::RunningApps { apps } => {
            // The service lists every user-installed program it can see,
            // because that is all it *can* see: as LocalSystem in
            // session 0 it is cut off from the interactive desktop, and
            // EnumWindows there returns nothing of the customer's.
            //
            // Deciding what counts as "an app" happens here instead,
            // where the windows actually are. Without it the picker
            // showed background helpers, update services and telemetry
            // hosts -- reported, fairly, as "it shows all of Windows".
            let windowed = pids_with_windows();
            let mut visible: Vec<RunningApp> = apps
                .iter()
                .filter(|app| app.pids.iter().any(|pid| windowed.contains(pid)))
                .cloned()
                .collect();
            // Nothing qualifying means the question could not be
            // answered -- a locked session, or an enumeration that came
            // back empty -- not that the customer has no programs open.
            // Showing everything is untidy; showing nothing reads as
            // broken, and they would have no way to select an app at
            // all.
            if visible.is_empty() {
                return Ok(apps);
            }
            visible.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(visible)
        }
        Response::Error { message } => Err(message),
        // Anything else means the service answered a different question,
        // which is a bug rather than a condition to paper over.
        _ => Err("the helper service gave an unexpected answer".to_string()),
    }
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
}

/// How long to wait for a server to answer before calling it unreachable.
///
/// Generous enough that a genuinely distant server (Iran to Finland, say)
/// still measures rather than timing out, short enough that a dead one
/// does not hold up the whole list.
const LATENCY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2500);

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
    use tokio::net::TcpStream;

    // Concurrently, so the whole check costs one timeout rather than
    // two. It is taken on the connect path, and this screen has already
    // been paid for being patient there.
    let attempts = IPV6_PROBES.map(|(address, port)| async move {
        matches!(
            tokio::time::timeout(IPV6_PROBE_TIMEOUT, TcpStream::connect((address, port))).await,
            Ok(Ok(_))
        )
    });
    let [first, second] = attempts;
    let (first, second) = tokio::join!(first, second);
    first || second
}

/// Round-trip time to a server, measured by how long a TCP connection
/// takes to establish.
///
/// TCP rather than ICMP on purpose. ICMP echo needs raw sockets (so,
/// administrator) or the Win32 IcmpSendEcho API, and is widely filtered
/// -- including by exactly the sort of network a customer in a censored
/// region is on. A TCP handshake against the port the VPN actually
/// listens on is both privilege-free and a truer measure: it tests the
/// path that matters rather than a different protocol that may be
/// deprioritised or dropped.
///
/// Returns None rather than a sentinel number when the server does not
/// answer, so the UI can show "--" instead of inventing a value.
#[tauri::command]
pub async fn measure_latency(host: String, port: u16) -> Option<u32> {
    use tokio::net::TcpStream;

    // TCP and ICMP are raced rather than tried in turn.
    //
    // A TCP connect can only ever succeed against a TCP listener, so for
    // WireGuard (51820/udp) and OpenVPN (1194/udp) it always fails --
    // and running it first meant waiting out the full timeout before
    // even starting the ICMP that would answer. Measured at 2661ms for
    // both UDP protocols against 176ms for Xray on 443/tcp, so their
    // rows sat on "--" for about three seconds and read as broken.
    //
    // Whichever answers first is the answer: both measure the same path,
    // and neither can report a number without the far end responding.
    let tcp = async {
        let started = std::time::Instant::now();
        // Resolution is inside the measurement on purpose: a customer
        // waiting to connect waits for that too.
        match tokio::time::timeout(LATENCY_TIMEOUT, TcpStream::connect((host.as_str(), port))).await
        {
            Ok(Ok(_stream)) => Some(started.elapsed().as_millis() as u32),
            Ok(Err(_)) | Err(_) => None,
        }
    };

    let icmp_host = host.clone();
    let icmp = async move {
        tokio::task::spawn_blocking(move || icmp_latency(&icmp_host))
            .await
            .ok()
            .flatten()
    };

    tokio::pin!(tcp);
    tokio::pin!(icmp);

    // Take the first *successful* answer. A method failing says nothing
    // about the host -- ICMP is filtered on plenty of networks, and TCP
    // cannot work against a UDP port -- so a failure must not cancel the
    // other side.
    //
    // The guards are per-branch, and have to be: a single shared counter
    // disabled neither branch in particular, so once one side failed the
    // loop could come back round and poll that finished future again,
    // which is not allowed. Latent rather than observed -- a live probe
    // against the node returns a number for every port either way -- but
    // it is real, and cheap to close.
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
            // Both branches disabled: neither method could measure it.
            else => return None,
        }
    }
}

/// Round-trip time by ICMP echo, for endpoints that do not answer TCP.
///
/// Uses Windows' IcmpSendEcho rather than a raw socket: raw ICMP needs
/// administrator, which this app deliberately does not have (the whole
/// reason the privileged helper service exists), while this API is
/// available to any process.
///
/// Returns None when the host does not answer -- ICMP is filtered on
/// plenty of networks, and "we could not measure this" has to stay
/// distinguishable from a number, since the UI shows "--" for it rather
/// than inventing one.
fn icmp_latency(host: &str) -> Option<u32> {
    use std::net::{IpAddr, ToSocketAddrs};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY,
    };

    // The endpoint may be a hostname; ICMP needs an address. Port is
    // irrelevant here and only satisfies the resolver.
    let addr = (host, 0u16)
        .to_socket_addrs()
        .ok()?
        .find_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            // IcmpSendEcho is IPv4-only; Icmp6SendEcho2 would be needed for
            // v6, which no node uses today.
            IpAddr::V6(_) => None,
        })?;

    unsafe {
        let handle = IcmpCreateFile();
        if handle.is_null() {
            return None;
        }

        let payload = [0u8; 32];
        // Reply buffer must hold the reply struct plus the echoed payload;
        // Microsoft's guidance is to add 8 bytes of slack for an error
        // message the API may append.
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];

        let replies = IcmpSendEcho(
            handle,
            u32::from_ne_bytes(addr.octets()),
            payload.as_ptr() as *const _,
            payload.len() as u16,
            std::ptr::null_mut(),
            reply.as_mut_ptr() as *mut _,
            reply.len() as u32,
            LATENCY_TIMEOUT.as_millis() as u32,
        );
        IcmpCloseHandle(handle);

        if replies == 0 {
            return None;
        }
        let echo = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        // Status 0 is IP_SUCCESS; anything else is a failure reply whose
        // RoundTripTime means nothing.
        if echo.Status != 0 {
            return None;
        }
        Some(echo.RoundTripTime)
    }
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
        } => Ok(VpnStatus {
            connected,
            protocol,
            health,
            split_tunnel_active,
            split_tunnel_problem,
            ipv6_blocked,
            tunnel_dns_unprotected,
            split_tunnel_restart_needed,
        }),
        Response::Error { message } => Err(message),
        Response::Ok
        | Response::RunningApps { .. }
        | Response::Repaired { .. }
        | Response::Diagnostics { .. }
        | Response::Gaming { .. } => {
            Err("the background service returned an unexpected reply".into())
        }
    }
}

/// Gaming DNS mode's state, in the shape the frontend reads.
///
/// Hand-renamed field by field, exactly as [`VpnStatus`] is: the wire
/// format between the app and the service is snake_case Rust, and the
/// names the React side is written against are these. Getting one wrong
/// is a field that silently reads `undefined`, which in a status
/// surface means a check quietly counted as failed -- or worse, as
/// passed.
///
/// `state` is deliberately not a connection state. Gaming mode brings
/// up no tunnel, so there is nothing "Connected" could truthfully mean,
/// and `unknown` is its own value that must never be shown as `off` --
/// see design §8.3.
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

/// Every reply the three gaming commands can get, in one place.
///
/// A `Gaming` reply is the only success: `Ok` would mean the service
/// answered a different question, and there is no state to report from
/// it. Refused rather than defaulted to `off`, because "the service
/// said something unexpected" is the `unknown` case and the caller has
/// to be able to tell it from "nothing is armed".
fn gaming_reply(response: Response) -> Result<GamingStatus, String> {
    match response {
        Response::Gaming {
            state,
            detail,
            rules_present,
            canary_ok,
            proxy_reachable,
            namespaces,
        } => Ok(GamingStatus {
            state,
            detail,
            rules_present,
            canary_ok,
            proxy_reachable,
            namespaces,
        }),
        Response::Error { message } => Err(message),
        Response::Ok
        | Response::State { .. }
        | Response::RunningApps { .. }
        | Response::Repaired { .. }
        | Response::Diagnostics { .. } => {
            Err("the background service returned an unexpected reply".into())
        }
    }
}

/// Turns Gaming DNS mode on: a loopback DoH stub plus namespace-scoped
/// DNS policy rules for the game's hostnames.
///
/// Brings up no tunnel and no adapter, and does not change this
/// machine's exit IP -- which the UI is required to say in words.
///
/// The reply carries the three checks rather than a bare success,
/// because "the rules were installed" and "the game's lookups are
/// actually reaching us" are different facts and only the second one is
/// worth showing a customer.
#[tauri::command]
pub async fn gaming_arm(config: GamingConfig) -> Result<GamingStatus, String> {
    gaming_reply(call(&Request::ArmGaming { config }).await?)
}

/// Turns Gaming DNS mode off and removes its DNS policy rules.
///
/// Safe when nothing is armed. Worth calling even then: the rules
/// outlive this process, so a previous life that ended badly is
/// something only a sweep can find.
#[tauri::command]
pub async fn gaming_disarm() -> Result<(), String> {
    call_expecting_ok(&Request::DisarmGaming).await
}

#[tauri::command]
pub async fn gaming_status() -> Result<GamingStatus, String> {
    gaming_reply(call(&Request::GamingStatus).await?)
}

#[cfg(test)]
mod gaming_contract {
    use super::*;

    /// The names the React side is written against, pinned.
    ///
    /// Worth a test rather than a comment because this is the one place
    /// the two halves of the feature are built in parallel against a
    /// written-down shape, and a renamed field does not fail to compile
    /// -- it reads as `undefined` in the webview. On a surface whose
    /// entire job is to say which of three checks failed, an
    /// `undefined` boolean is a check silently counted as failed, or
    /// worse, as passed.
    #[test]
    fn the_field_names_reaching_the_webview_are_the_agreed_ones() {
        let status = GamingStatus {
            state: GamingPhase::Partial,
            detail: Some("the game proxy is not answering".into()),
            rules_present: true,
            canary_ok: true,
            proxy_reachable: false,
            namespaces: vec![".blizzard.com".into()],
        };
        let json: serde_json::Value = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "partial");
        assert_eq!(json["detail"], "the game proxy is not answering");
        assert_eq!(json["rulesPresent"], true);
        assert_eq!(json["canaryOk"], true);
        assert_eq!(json["proxyReachable"], false);
        assert_eq!(json["namespaces"][0], ".blizzard.com");
        // Exactly these six, so a field added here without the React
        // side knowing is caught rather than shipped.
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 6, "{json}");
    }

    /// `unknown` must survive the trip as itself. Folding it into `off`
    /// would tell a customer their DNS rules are gone at exactly the
    /// moment nothing can confirm they are.
    #[test]
    fn unknown_does_not_arrive_as_off() {
        let status = GamingStatus {
            state: GamingPhase::Unknown,
            detail: None,
            rules_present: false,
            canary_ok: false,
            proxy_reachable: false,
            namespaces: Vec::new(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "unknown");
        assert!(json.get("detail").is_none(), "an absent detail is omitted, not null");
    }

    /// The app's half of the repair-deadline contract.
    ///
    /// `REPAIR_WORST_CASE` is what the service says its pass can cost;
    /// this is the app agreeing to wait that long. They were kept apart
    /// once and the app's number ended up at less than a third of the
    /// service's, which turns a repair that is still working into "the
    /// background service did not answer" -- on a machine whose
    /// networking is already broken and which has just been half
    /// changed.
    #[test]
    fn the_repair_deadline_covers_what_the_service_says_it_can_cost() {
        assert!(
            REPAIR_TIMEOUT >= neoconnect_ipc::REPAIR_WORST_CASE,
            "the repair deadline ({}s) abandons a pass the service says can take {}s",
            REPAIR_TIMEOUT.as_secs(),
            neoconnect_ipc::REPAIR_WORST_CASE.as_secs()
        );
        // And it is still a different number from the ordinary one --
        // the reason this constant exists at all.
        assert!(REPAIR_TIMEOUT > REPLY_TIMEOUT);
    }

    /// A service that answered a different question is an error, never
    /// a state -- least of all `off`, which would read as "gaming mode
    /// is not on" when the truth is "we do not know".
    #[test]
    fn an_unexpected_reply_is_an_error_rather_than_a_state() {
        assert!(gaming_reply(Response::Ok).is_err());
        assert!(gaming_reply(Response::RunningApps { apps: Vec::new() }).is_err());
        assert_eq!(
            gaming_reply(Response::Error { message: "nope".into() }).unwrap_err(),
            "nope"
        );
    }
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
            serde_json::json!({ "serverName": "fi1.neoxify.site" }),
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
            serde_json::json!({ "serverName": "fi1.neoxify.site" }),
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
                "serverName": "www.speedtest.net",
                "dest": "www.speedtest.net:443"
            }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::XrayVlessReality(p) => {
                assert_eq!(p.short_id, "0123abcd");
                assert_eq!(p.server_name, "www.speedtest.net");
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
            serde_json::json!({ "endpointHost": "sg1.neoxify.site" }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::Ikev2(p) => assert_eq!(p.server, "sg1.neoxify.site"),
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
mod latency_probe {
    /// Not a unit test: a live probe against the real node, run by hand
    /// with `cargo test latency_probe -- --nocapture --ignored`, to find
    /// out why one protocol's row shows no latency while the others on
    /// the same host do.
    #[tokio::test]
    #[ignore]
    async fn measures_every_protocol_port_on_fi1() {
        // fi1's ports as of 2026-08-11. Two of these are defaults and
        // are on their way out: WireGuard and OpenVPN are moving to
        // random high ports per node, because 51820 and 1194 identify
        // the protocol to anyone scanning. Update them here when fi1
        // moves, or this probe quietly measures closed ports and reports
        // every protocol as unreachable. Nothing outside this ignored
        // test reads them -- the connect path takes the port from the
        // API.
        for (label, port) in [
            ("XRAY/tcp", 443u16),
            ("WIREGUARD/udp", 51820),
            ("OPENVPN/udp", 1194),
        ] {
            let started = std::time::Instant::now();
            let result = super::measure_latency("204.168.161.100".into(), port).await;
            println!(
                "{label:>14} port {port:<6} -> {result:?}  (took {}ms)",
                started.elapsed().as_millis()
            );
        }
    }
}

/// A stable identifier for the network this machine is currently on.
///
/// Failover remembers which protocol worked so the next connect starts
/// with it instead of walking the list again. That memory has to be
/// per-network to be worth anything: the whole point is that the answer
/// differs between a home connection where everything works and a
/// filtered one where only a disguised transport does. Remembered
/// globally, moving between the two would mean a wrong first attempt
/// every time -- precisely the delay it exists to remove.
///
/// The default gateway's MAC is the identifier, because it distinguishes
/// two networks that both hand out 192.168.1.x, which its IP does not.
///
/// Returns None when it cannot be determined -- no gateway, or ARP
/// fails. Callers treat that as one shared unknown network rather than
/// inventing an identity, since a fabricated one would attach the memory
/// to the wrong place.
#[tauri::command]
pub fn network_fingerprint() -> Option<String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetBestRoute, SendARP, MIB_IPFORWARDROW,
    };

    unsafe {
        // Asking for the route to a public address gets the default
        // route without walking the whole table and re-implementing
        // Windows' own metric comparison.
        let mut route: MIB_IPFORWARDROW = std::mem::zeroed();
        let probe = u32::from_ne_bytes([1, 1, 1, 1]);
        if GetBestRoute(probe, 0, &mut route) != 0 {
            return None;
        }

        // Zero means the destination is on-link -- a point-to-point
        // adapter with no next hop to ARP for, which is what a live VPN
        // tunnel looks like. Nothing stable to fingerprint.
        let gateway = route.dwForwardNextHop;
        if gateway == 0 {
            return None;
        }

        let mut mac = [0u8; 6];
        let mut mac_len: u32 = mac.len() as u32;
        if SendARP(gateway, 0, mac.as_mut_ptr() as *mut _, &mut mac_len) != 0 || mac_len == 0 {
            return None;
        }

        Some(
            mac[..mac_len.min(6) as usize]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(":"),
        )
    }
}

/// Process ids owning a visible, titled, top-level window.
///
/// The nearest thing Windows offers to "the customer can see this". A
/// window owned by another is a dialog or a splash screen, so it does
/// not make its process an application in its own right.
fn pids_with_windows() -> std::collections::HashSet<u32> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
        GW_OWNER,
    };

    unsafe extern "system" fn collect(window: HWND, param: isize) -> i32 {
        // SAFETY: the pointer is the &mut HashSet passed to EnumWindows.
        let set = unsafe { &mut *(param as *mut std::collections::HashSet<u32>) };
        // SAFETY: `window` comes from the enumeration and is valid here.
        unsafe {
            if IsWindowVisible(window) == 0 || GetWindowTextLengthW(window) == 0 {
                return 1;
            }
            if !GetWindow(window, GW_OWNER).is_null() {
                return 1;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if pid != 0 {
                set.insert(pid);
            }
        }
        1
    }

    let mut set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // SAFETY: `set` outlives this synchronous enumeration.
    unsafe { EnumWindows(Some(collect), &mut set as *mut _ as isize) };
    set
}
