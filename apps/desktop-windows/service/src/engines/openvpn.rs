//! OpenVPN via the official openvpn.exe.
//!
//! The certificate/key material is written inline (`<ca>`/`<cert>`/
//! `<key>` blocks) rather than as separate files, so there is exactly
//! one file to write and, more importantly, exactly one file to delete
//! on disconnect -- private keys never end up scattered across the
//! config directory.
//!
//! `windows-driver wintun` makes OpenVPN use the same Wintun driver the
//! Xray engine already needs, so the installer ships one TUN driver
//! dependency instead of also dragging in tap-windows6.
//!
//! Note on safety: an `.ovpn` supports `up`/`down` script directives,
//! which is real command execution -- and this process is LocalSystem.
//! That is why every PEM here is structurally validated before it gets
//! this far (see `neoconnect_ipc::ConnectProfile::validate`); a
//! certificate that could close its own `<ca>` block and open a
//! directive would otherwise be a straightforward SYSTEM compromise.
//! `script-security` is left at its default of 0, which disables those
//! directives outright, as a second independent layer.

use std::ffi::OsStr;
use std::process::Child;

use neoconnect_ipc::OpenvpnProfile;

use super::{confirm_started, spawn_hidden, write_config, Engines};

const CONFIG_FILE: &str = "neoconnect.ovpn";
const LOG_FILE: &str = "openvpn.log";

fn build_config(p: &OpenvpnProfile) -> Result<String, String> {
    let (host, port) = p
        .endpoint
        .rsplit_once(':')
        .ok_or_else(|| "endpoint must be host:port".to_string())?;

    // Only emitted when the server uses tls-crypt. Omitting it against a
    // server that does use it produces no error at all -- the server
    // cannot authenticate the control channel, so it drops the client's
    // packets and the log simply stops after the first send.
    let tls_crypt = match &p.tls_crypt_key {
        Some(key) => format!("<tls-crypt>\n{}\n</tls-crypt>\n", key.trim()),
        None => String::new(),
    };

    Ok(format!(
        "client\n\
         dev tun\n\
         windows-driver wintun\n\
         proto {proto}\n\
         remote {host} {port}\n\
         resolv-retry infinite\n\
         nobind\n\
         persist-key\n\
         persist-tun\n\
         remote-cert-tls server\n\
         cipher AES-256-GCM\n\
         auth SHA256\n\
         verb 3\n\
         script-security 0\n\
         <ca>\n{ca}\n</ca>\n\
         <cert>\n{cert}\n</cert>\n\
         <key>\n{key}\n</key>\n\
         {tls_crypt}",
        proto = p.proto,
        host = host,
        port = port,
        ca = p.ca_cert_pem.trim(),
        cert = p.cert_pem.trim(),
        key = p.key_pem.trim(),
        tls_crypt = tls_crypt,
    ))
}

pub fn connect(engines: &Engines, profile: &OpenvpnProfile) -> Result<Child, String> {
    let exe = engines.engine_path("openvpn.exe")?;
    engines.engine_path("wintun.dll")?;

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_config(profile)?)?;

    let exe_dir = exe
        .parent()
        .ok_or_else(|| "could not resolve the engine directory".to_string())?;

    let log_path = engines.config_path(LOG_FILE);
    let child = spawn_hidden(
        &exe,
        &[OsStr::new("--config"), config_path.as_os_str()],
        exe_dir,
        &log_path,
    )
    .map_err(|e| format!("could not start openvpn.exe: {e}"))?;

    confirm_started(child, "OpenVPN", &log_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> OpenvpnProfile {
        OpenvpnProfile {
            cert_pem: "-----BEGIN CERTIFICATE-----\nQ0VSVA==\n-----END CERTIFICATE-----".into(),
            key_pem: "-----BEGIN PRIVATE KEY-----\nS0VZ\n-----END PRIVATE KEY-----".into(),
            ca_cert_pem: "-----BEGIN CERTIFICATE-----\nQ0E=\n-----END CERTIFICATE-----".into(),
            endpoint: "203.0.113.5:1194".into(),
            proto: "udp".into(),
            tls_crypt_key: Some(
                "-----BEGIN OpenVPN Static key V1-----\ndeadbeef\n-----END OpenVPN Static key V1-----".into(),
            ),
        }
    }

    #[test]
    fn splits_endpoint_into_openvpn_remote_syntax() {
        // OpenVPN wants `remote <host> <port>`, space-separated -- not
        // the host:port form every other engine here takes.
        let conf = build_config(&profile()).unwrap();
        assert!(conf.contains("remote 203.0.113.5 1194"));
    }

    #[test]
    fn inlines_all_three_pem_blocks() {
        let conf = build_config(&profile()).unwrap();
        assert!(conf.contains("<ca>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<cert>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<key>\n-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn keeps_script_directives_disabled() {
        // Second layer behind PEM validation -- see the module doc.
        assert!(build_config(&profile()).unwrap().contains("script-security 0"));
    }

    #[test]
    fn uses_the_shared_wintun_driver() {
        assert!(build_config(&profile()).unwrap().contains("windows-driver wintun"));
    }

    #[test]
    fn includes_the_tls_crypt_key_when_the_server_uses_one() {
        // Omitting this against a tls-crypt server is invisible: the
        // server drops the client's packets rather than rejecting them,
        // so the connection hangs with an empty log.
        let conf = build_config(&profile()).unwrap();
        assert!(conf.contains("<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----"));
        assert!(conf.contains("</tls-crypt>"));
    }

    #[test]
    fn omits_the_tls_crypt_block_when_the_server_has_no_key() {
        let mut p = profile();
        p.tls_crypt_key = None;
        assert!(!build_config(&p).unwrap().contains("tls-crypt"));
    }
}
