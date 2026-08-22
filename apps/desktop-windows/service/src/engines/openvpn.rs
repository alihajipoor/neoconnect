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
//!
//! `script-security 2` is required, not chosen. OpenVPN configures the
//! adapter's address by invoking `netsh.exe`, and at level 0 that call
//! is refused -- the tunnel authenticates, imports its routes, opens the
//! adapter, and then dies with "command failed: disallowed by
//! script-security setting". Level 0 was originally set here as a second
//! layer behind the validation above; it turned out to disable the
//! engine entirely rather than harden it.
//!
//! Losing that layer is acceptable because the config is generated
//! wholly by this service from values that are structurally validated
//! first: there is no path by which a directive reaches this file. It
//! would not be acceptable if any part of the config were caller-supplied
//! text.

use std::ffi::OsStr;
use std::process::Child;

use neoconnect_ipc::OpenvpnProfile;

use super::{confirm_started, routing, run_hidden_capture, spawn_hidden, write_config, Engines};
use crate::adapters;

const CONFIG_FILE: &str = "neoconnect.ovpn";
const LOG_FILE: &str = "openvpn.log";

/// The largest encapsulated packet this client will put on the wire,
/// counted the way `mssfix ... mtu` counts it: outer IP header included.
///
/// Not 1500. A tunnel sized for the link it is measured on is sized for
/// a lab; the links this product exists to work on are narrower than
/// that. 1400 is the value a home PPPoE or mobile path routinely comes
/// out at, and every path wider than 1400 carries a 1400-byte packet
/// perfectly well -- so this is chosen to be right on the bad link
/// rather than optimal on the good one.
///
/// The cost of being wrong in the safe direction is about 7% more
/// per-packet header overhead. The cost of being wrong in the other
/// direction is a tunnel that says "connected" and loads nothing.
const LINK_BUDGET: u16 = 1400;

/// What OpenVPN adds around each tunnelled packet on UDP with
/// AES-256-GCM: 20 IPv4 + 8 UDP + 4 opcode/peer-id + 4 packet id +
/// 16 GCM tag. Subtracted from the budget to get the tun's own MTU, so
/// a full-size packet from the tun still fits inside it.
const UDP_ENCAP_OVERHEAD: u16 = 52;

/// Name of the Wintun adapter OpenVPN binds to.
///
/// Distinct from the one Xray creates ("neoconnect0"), so the two
/// engines can never contend for the same adapter when switching
/// between them.
pub const ADAPTER_NAME: &str = "Neoxify-OpenVPN";

/// Makes sure a Wintun adapter exists for OpenVPN to attach to.
///
/// openvpn.exe does not create its own adapter the way wireguard.exe
/// does -- it looks for an existing free one and fails outright with
/// "All wintun adapters on this system are currently in use or disabled"
/// if none is available. tapctl.exe (shipped in OpenVPN's own MSI) is
/// the supported way to create one.
///
/// Left in place after disconnect rather than deleted: creating an
/// adapter is slow and churns the network stack, and a dormant Wintun
/// adapter costs nothing. That also makes this a no-op on every
/// connection after the first.
fn ensure_adapter(engines: &Engines) -> Result<(), String> {
    let tapctl = engines.engine_path("tapctl.exe")?;

    let existing = run_hidden_capture(&tapctl, &[OsStr::new("list")])
        .map_err(|e| format!("could not list network adapters: {e}"))?;
    if existing.lines().any(|line| line.contains(ADAPTER_NAME)) {
        return Ok(());
    }

    let created = run_hidden_capture(
        &tapctl,
        &[
            OsStr::new("create"),
            OsStr::new("--hwid"),
            OsStr::new("wintun"),
            OsStr::new("--name"),
            OsStr::new(ADAPTER_NAME),
        ],
    )
    .map_err(|e| format!("could not create the OpenVPN network adapter: {e}"))?;

    // tapctl prints the new adapter's GUID on success and nothing on
    // failure, so an empty result means it didn't work even though the
    // process itself exited.
    if created.trim().is_empty() {
        return Err("could not create the OpenVPN network adapter (tapctl returned nothing)".into());
    }
    Ok(())
}

fn build_config(p: &OpenvpnProfile, passive: bool) -> Result<String, String> {
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

    // Custom mode wants the tunnel up but routing nothing, so the
    // server's pushed `redirect-gateway` has to be ignored. `route-nopull`
    // is OpenVPN's own directive for exactly that: the tunnel and its
    // address still come up, no routes are installed, and the split
    // tunnel adds the one route it needs itself.
    let routing = if passive { "route-nopull\n" } else { "" };

    // Windows resolves names on every interface at once and takes the
    // first answer, so an ISP resolver can beat the tunnel's -- and in
    // Iran it answers filtered domains with an address that goes
    // nowhere. The customer sees "connected" while the sites they
    // installed a VPN for refuse to load.
    //
    // block-outside-dns is OpenVPN's own fix: it drops DNS leaving any
    // other adapter while the tunnel is up. Full tunnel only -- in
    // Custom mode most applications are deliberately off the tunnel,
    // and seizing the machine's resolver would push their lookups
    // through a tunnel they are not using.
    //
    // Two tests asserted this before it was ever written, and could not
    // fail: the job that would have run them had never once got as far
    // as running a test.
    let dns = if passive { "" } else { "block-outside-dns\n" };

    // The tunnel's MTU, pinned, and the server's pushed value refused.
    //
    // This is the failure `MTU = 1420` in wireguard.rs already exists to
    // prevent, and OpenVPN had no equivalent at all. No node config sets
    // `tun-mtu`, so OpenVPN 2.6 pushes its own default of 1500 and the
    // client's tun comes up exactly as wide as the link underneath it.
    // Every full-size packet is then over the path MTU the moment
    // OpenVPN's ~52 bytes of UDP encapsulation go on -- and OpenVPN sets
    // DF on those datagrams, so the network drops them rather than
    // fragmenting.
    //
    // What makes it worth pinning rather than leaving to the network is
    // that the failure is size-dependent, not on/off. The handshake
    // completes, the adapter gets its address, ICMP crosses, DNS
    // answers -- and then anything carrying real data disappears. The
    // app is correctly reporting a tunnel that is up, and the customer
    // is looking at a browser that will not load a page.
    //
    // Measured against a 1400-byte link, which is ordinary for PPPoE and
    // mobile and common in Iran: see the table in the commit. `mssfix`
    // is set explicitly and in the same units, because its own default
    // (1492) is derived from a 1500-byte link and would keep letting
    // oversized TCP through after tun-mtu was lowered. `pull-filter`
    // is not optional -- without it the server's pushed 1500 replaces
    // everything here.
    //
    // Custom mode gets it too. The packets are the same size whether
    // one application is on the tunnel or all of them.
    let mtu = format!(
        "pull-filter ignore \"tun-mtu\"\n\
         tun-mtu {}\n\
         mssfix {} mtu\n",
        LINK_BUDGET - UDP_ENCAP_OVERHEAD,
        LINK_BUDGET,
    );

    Ok(format!(
        "client\n\
         {routing}\
         {mtu}\
         {dns}\
         dev tun\n\
         windows-driver wintun\n\
         dev-node {adapter}\n\
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
         script-security 2\n\
         <ca>\n{ca}\n</ca>\n\
         <cert>\n{cert}\n</cert>\n\
         <key>\n{key}\n</key>\n\
         {tls_crypt}",
        adapter = ADAPTER_NAME,
        dns = dns,
        proto = p.proto,
        host = host,
        port = port,
        ca = p.ca_cert_pem.trim(),
        cert = p.cert_pem.trim(),
        key = p.key_pem.trim(),
        tls_crypt = tls_crypt,
    ))
}

pub fn connect(
    engines: &Engines,
    profile: &OpenvpnProfile,
    passive: bool,
) -> Result<Child, String> {
    let exe = engines.engine_path("openvpn.exe")?;
    engines.engine_path("wintun.dll")?;
    ensure_adapter(engines)?;

    // Anything left on this adapter from a previous run goes now.
    // Teardown purges these too, but a service that was killed rather
    // than stopped never got to, and the pushed `0.0.0.0/1` and
    // `128.0.0.0/1` routes then outlive every later session -- silently
    // overriding Custom mode, because a /1 beats the demoted default.
    // Cheap, and a no-op on a clean machine.
    if let Ok(Some(adapter)) = adapters::find_by_name(ADAPTER_NAME) {
        routing::purge_interface(adapter.index);
    }

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_config(profile, passive)?)?;

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
    fn custom_mode_refuses_the_servers_pushed_routes() {
        // OpenVPN is told where to route by the server, so unlike the
        // other engines the passive behaviour cannot come from omitting
        // something -- route-nopull has to be added, or the pushed
        // redirect-gateway takes the default route and Custom mode
        // silently becomes a full tunnel.
        assert!(build_config(&profile(), true).unwrap().contains("route-nopull"));
        assert!(!build_config(&profile(), false).unwrap().contains("route-nopull"));
    }

    #[test]
    fn every_config_pins_the_mtu_and_refuses_the_pushed_one() {
        // The three lines are one fix and only work together: pinning
        // tun-mtu without the pull-filter is silently undone by the
        // server's pushed 1500, and lowering tun-mtu without mssfix
        // leaves TCP clamped at OpenVPN's own 1492 default -- which is
        // derived from a 1500-byte link and is the size that was
        // black-holing in the first place.
        //
        // Asserted for passive as well: a packet is the same size
        // whether one application is on the tunnel or all of them, and
        // Custom mode is where a customer is most likely to read the
        // failure as "the app I selected is broken".
        for passive in [false, true] {
            let conf = build_config(&profile(), passive).unwrap();
            assert!(
                conf.contains("pull-filter ignore \"tun-mtu\""),
                "passive={passive}: the server's pushed tun-mtu must be refused"
            );
            assert!(
                conf.contains("tun-mtu 1348"),
                "passive={passive}: tun-mtu must be pinned below the link budget"
            );
            assert!(
                conf.contains("mssfix 1400 mtu"),
                "passive={passive}: TCP must be clamped to the same budget, in the same units"
            );
        }
    }

    #[test]
    fn the_pinned_mtu_leaves_room_for_our_own_encapsulation() {
        // The arithmetic, rather than the two literals above, so a
        // future change to the budget cannot quietly produce a tun wider
        // than the packets it is supposed to fit inside.
        let conf = build_config(&profile(), false).unwrap();
        let tun: u16 = conf
            .lines()
            .find_map(|l| l.strip_prefix("tun-mtu "))
            .expect("tun-mtu is set")
            .parse()
            .expect("tun-mtu is a number");
        assert!(
            tun + UDP_ENCAP_OVERHEAD <= LINK_BUDGET,
            "a full-size packet from the tun ({tun}) plus encapsulation \
             ({UDP_ENCAP_OVERHEAD}) must fit the budget ({LINK_BUDGET})"
        );
    }

    #[test]
    fn splits_endpoint_into_openvpn_remote_syntax() {
        // OpenVPN wants `remote <host> <port>`, space-separated -- not
        // the host:port form every other engine here takes.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("remote 203.0.113.5 1194"));
    }

    #[test]
    fn inlines_all_three_pem_blocks() {
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("<ca>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<cert>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<key>\n-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn allows_openvpn_to_configure_the_adapter() {
        // OpenVPN shells out to netsh to set the tunnel address. At
        // script-security 0 that is refused and the connection dies
        // immediately after opening the adapter -- see the module doc for
        // why losing that layer is acceptable here.
        assert!(build_config(&profile(), false).unwrap().contains("script-security 2"));
    }

    #[test]
    fn uses_the_shared_wintun_driver() {
        assert!(build_config(&profile(), false).unwrap().contains("windows-driver wintun"));
    }

    #[test]
    fn binds_to_its_own_adapter_rather_than_whatever_is_free() {
        // Without naming an adapter, OpenVPN searches for any free
        // Wintun device and fails when Xray is holding the only one.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("dev-node Neoxify-OpenVPN"));
    }

    #[test]
    fn includes_the_tls_crypt_key_when_the_server_uses_one() {
        // Omitting this against a tls-crypt server is invisible: the
        // server drops the client's packets rather than rejecting them,
        // so the connection hangs with an empty log.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----"));
        assert!(conf.contains("</tls-crypt>"));
    }

    #[test]
    fn omits_the_tls_crypt_block_when_the_server_has_no_key() {
        let mut p = profile();
        p.tls_crypt_key = None;
        assert!(!build_config(&p, false).unwrap().contains("tls-crypt"));
    }

    #[test]
    fn a_full_tunnel_shuts_out_every_other_resolver() {
        // The fault this exists for: Windows asks all interfaces at once
        // and takes the first answer, so an ISP resolver beats ours and
        // in Iran answers filtered domains with a poisoned address. The
        // customer sees "connected" while blocked sites refuse to load.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("block-outside-dns"), "full tunnel must claim DNS");
    }

    #[test]
    fn custom_mode_leaves_the_machines_dns_alone() {
        // Most applications are deliberately NOT on the tunnel in Custom
        // mode, and seizing the machine's DNS would push their lookups
        // through a tunnel they are not using.
        let conf = build_config(&profile(), true).unwrap();
        assert!(!conf.contains("block-outside-dns"), "custom mode must not claim DNS");
    }
}
