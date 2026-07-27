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
    ConnectProfile, OpenvpnProfile, Request, Response, TunnelHealth, WireguardProfile, XrayProfile,
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
    #[serde(rename = "publicParams")]
    public_params: serde_json::Value,
}

fn field<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("this connection is missing '{key}' -- ask support to re-provision it"))
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

    let mut encoded = serde_json::to_string(request).map_err(|e| format!("could not encode request: {e}"))?;
    encoded.push('\n');

    let mut reader = BufReader::new(client);
    reader
        .get_mut()
        .write_all(encoded.as_bytes())
        .await
        .map_err(|e| format!("could not send request to the background service: {e}"))?;

    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("could not read the background service's reply: {e}"))?;

    serde_json::from_str(line.trim()).map_err(|e| format!("could not decode the background service's reply: {e}"))
}

async fn call_expecting_ok(request: &Request) -> Result<(), String> {
    match call(request).await? {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        Response::State { .. } => Err("the background service returned an unexpected reply".into()),
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

#[derive(Debug, serde::Serialize)]
pub struct VpnStatus {
    /// An engine is running. Weaker than it sounds -- see `health`.
    connected: bool,
    protocol: Option<String>,
    /// Whether the far end is actually answering. Carried separately
    /// because `connected` alone was being shown to customers as
    /// "Connected" while no traffic was flowing.
    health: TunnelHealth,
}

/// How long to wait for a server to answer before calling it unreachable.
///
/// Generous enough that a genuinely distant server (Iran to Finland, say)
/// still measures rather than timing out, short enough that a dead one
/// does not hold up the whole list.
const LATENCY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2500);

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
        match tokio::time::timeout(LATENCY_TIMEOUT, TcpStream::connect((host.as_str(), port))).await {
            Ok(Ok(_stream)) => Some(started.elapsed().as_millis() as u32),
            Ok(Err(_)) | Err(_) => None,
        }
    };

    let icmp_host = host.clone();
    let icmp = async move {
        tokio::task::spawn_blocking(move || icmp_latency(&icmp_host)).await.ok().flatten()
    };

    tokio::pin!(tcp);
    tokio::pin!(icmp);

    // Take the first *successful* answer. A method failing says nothing
    // about the host -- ICMP is filtered on plenty of networks, and TCP
    // cannot work against a UDP port -- so a failure must not cancel the
    // other side.
    let mut remaining = 2;
    loop {
        tokio::select! {
            result = &mut tcp, if remaining > 0 => {
                if result.is_some() { return result; }
                remaining -= 1;
            }
            result = &mut icmp, if remaining > 0 => {
                if result.is_some() { return result; }
                remaining -= 1;
            }
            else => return None,
        }
        if remaining == 0 {
            return None;
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
    let addr = (host, 0u16).to_socket_addrs().ok()?.find_map(|a| match a.ip() {
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
        Response::State { connected, protocol, health } => Ok(VpnStatus { connected, protocol, health }),
        Response::Error { message } => Err(message),
        Response::Ok => Err("the background service returned an unexpected reply".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(protocol: &str, credentials: serde_json::Value, public_params: serde_json::Value) -> ProtocolUserPayload {
        ProtocolUserPayload {
            protocol: protocol.into(),
            credentials,
            connection: ConnectionInfo { host: "203.0.113.5".into(), port: 443, public_params },
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
    fn maps_xray_pulling_reality_params_from_the_connection_field() {
        // The whole reason `connection` exists: these values are not in
        // the per-user credentials for this protocol.
        let profile = payload(
            "XRAY_VLESS_REALITY",
            serde_json::json!({ "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "flow": "xtls-rprx-vision" }),
            serde_json::json!({
                "realityPublicKey": "3Qc9mFkJz8xN2pQrStUvWxYz0123456789abcdefgh",
                "shortIds": ["0123abcd"],
                "serverName": "www.microsoft.com",
                "dest": "www.microsoft.com:443"
            }),
        )
        .into_profile()
        .expect("should map");
        match &profile {
            ConnectProfile::XrayVlessReality(p) => {
                assert_eq!(p.short_id, "0123abcd");
                assert_eq!(p.server_name, "www.microsoft.com");
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
        for (label, port) in [("XRAY/tcp", 443u16), ("WIREGUARD/udp", 51820), ("OPENVPN/udp", 1194)] {
            let started = std::time::Instant::now();
            let result = super::measure_latency("204.168.161.100".into(), port).await;
            println!("{label:>14} port {port:<6} -> {result:?}  (took {}ms)", started.elapsed().as_millis());
        }
    }
}
