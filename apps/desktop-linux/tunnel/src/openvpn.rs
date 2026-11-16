//! OpenVPN through the distribution's own `openvpn`, on interface
//! `neoxify-ovpn`.
//!
//! The config is the Windows service's (`service/src/engines/openvpn.rs`)
//! without what is Windows' alone (`windows-driver`, `dev-node`,
//! `block-outside-dns`): the same MTU pinning, the same inline keys in one
//! root-only file deleted at stop. OpenVPN on Linux addresses its tun and
//! adds the server-pushed `redirect-gateway def1` routes itself over
//! netlink, so it runs no scripts at all: `script-security 1` permits
//! only built-in programs, and the config names none.
//!
//! Its pushed half-defaults sit on its own tun and go with it when the
//! process dies. The host route to the server it adds on the uplink does
//! not, so the main table is read before it starts and again once it is
//! up, as the Windows service's `HostRouteWatch` does, and what it added
//! there is owed in the ledger and taken out at stop.

use std::io::{Read, Seek, SeekFrom};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, OpenvpnProfile};

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::routes::{Row, Uplink};
use crate::{dns, link, process, routes};
use crate::{Dirs, Limits, Problem, Proto, Transport, Tunnel, TunnelHealth, Up};

/// The system program, found in the system directories only.
pub const PROGRAM: &str = "openvpn";
/// The config's file name in `Dirs::run`. It holds the private key.
pub const CONFIG_FILE: &str = "neoxify.ovpn";
pub const LOG_FILE: &str = "openvpn.log";
pub const LINK: &str = link::OVPN_LINK;

/// The largest encapsulated packet put on the wire, outer IP header
/// included, and what OpenVPN adds around each packet on UDP with
/// AES-256-GCM. As on Windows, where a tun as wide as the link loaded
/// some sites and hung on others: 1400 is right on the narrow links this
/// product exists for and costs little on wide ones.
const LINK_BUDGET: u16 = 1400;
const UDP_ENCAP_OVERHEAD: u16 = 52;

/// OpenVPN's own words at the end of its start-up: handshake done,
/// `PUSH_REPLY` applied, tun addressed and routed. Nothing earlier in the
/// log means the tunnel carries anything.
const TUNNEL_UP_MARK: &str = "Initialization Sequence Completed";

/// How long OpenVPN gets to reach [`TUNNEL_UP_MARK`]: a ceiling on a
/// poll, not a sleep, and the caller's deadline still bounds it. As on
/// Windows.
const TUNNEL_UP_WITHIN: Duration = Duration::from_secs(75);

/// What OpenVPN logs each time it goes round again (a ping-restart, a TLS
/// error, a reset connection). Its last word on the link until
/// [`TUNNEL_UP_MARK`] follows it.
const RESTART_MARK: &str = "process restarting";

/// How much of the end of the log [`link_restarting`] reads. At `verb 3`
/// a tunnel that is up logs next to nothing.
const LOG_TAIL_BYTES: u64 = 16 * 1024;

/// The protocol OpenVPN dials its server with.
pub(crate) fn proto(p: &OpenvpnProfile) -> Result<Proto, Problem> {
    match p.proto.trim().to_ascii_lowercase().as_str() {
        "udp" | "udp4" => Ok(Proto::Udp),
        "tcp" | "tcp4" | "tcp-client" => Ok(Proto::Tcp),
        other => Err(Problem::Failed(format!("OpenVPN over \"{other}\" is not supported"))),
    }
}

/// The client config, `remote` already resolved to `server`.
pub(crate) fn build_config(p: &OpenvpnProfile, server: Ipv4Addr, port: u16) -> Result<String, Problem> {
    let transport = match proto(p)? {
        Proto::Udp => "udp",
        Proto::Tcp => "tcp-client",
    };
    // Validated as PEM by the app's IPC layer already. None of them can
    // hold a '<', so one would be a block closing early and a directive
    // after it; refused again where it would be written.
    let pems = [&p.ca_cert_pem, &p.cert_pem, &p.key_pem];
    if pems.iter().chain(p.tls_crypt_key.as_ref().iter()).any(|s| s.contains('<')) {
        return Err(Problem::Failed("the OpenVPN profile's keys are malformed".into()));
    }
    // Omitted against a server that uses tls-crypt, the client is not
    // refused but ignored, and the log stops after the first send.
    let tls_crypt = match &p.tls_crypt_key {
        Some(key) => format!("<tls-crypt>\n{}\n</tls-crypt>\n", key.trim()),
        None => String::new(),
    };
    Ok(format!(
        "client\n\
         pull-filter ignore \"tun-mtu\"\n\
         tun-mtu {tun_mtu}\n\
         mssfix {LINK_BUDGET} mtu\n\
         dev {LINK}\n\
         dev-type tun\n\
         proto {transport}\n\
         remote {server} {port}\n\
         resolv-retry infinite\n\
         nobind\n\
         persist-key\n\
         persist-tun\n\
         remote-cert-tls server\n\
         cipher AES-256-GCM\n\
         auth SHA256\n\
         verb 3\n\
         script-security 1\n\
         <ca>\n{ca}\n</ca>\n\
         <cert>\n{cert}\n</cert>\n\
         <key>\n{key}\n</key>\n\
         {tls_crypt}",
        tun_mtu = LINK_BUDGET - UDP_ENCAP_OVERHEAD,
        ca = p.ca_cert_pem.trim(),
        cert = p.cert_pem.trim(),
        key = p.key_pem.trim(),
    ))
}

/// Whether the last thing OpenVPN logged about its link is a restart:
/// the Windows service's `link_reading` rule. Never "up" from the log:
/// the up-marker is OpenVPN's word that it set the tunnel up, not that
/// anything has crossed it since.
pub(crate) fn link_restarting(log_tail: &str) -> bool {
    match (log_tail.rfind(RESTART_MARK), log_tail.rfind(TUNNEL_UP_MARK)) {
        (Some(restart), Some(up)) => restart > up,
        (Some(_), None) => true,
        _ => false,
    }
}

fn read_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES))).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = file.take(LOG_TAIL_BYTES).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The host routes OpenVPN added, from two readings of the main table.
/// Without a first reading nothing on the uplink can be told from the
/// customer's own routes, so only a new route to the server is taken.
pub(crate) fn added_routes(before: Option<&[Row]>, after: &[Row], server: Ipv4Addr) -> Vec<RouteSpec> {
    match before {
        Some(before) => routes::new_host_routes(before, after),
        None => routes::new_host_routes(&[], after).into_iter().filter(|s| s.dest == format!("{server}/32")).collect(),
    }
}

fn teardown() -> Budget {
    Budget::quick(cmd::TEARDOWN_CAP)
}

pub(crate) struct OvpnTunnel {
    up: Up,
    child: Option<Child>,
    ledger: Ledger,
    /// Host routes OpenVPN added (or is expected to add) on the uplink.
    engine_routes: Vec<RouteSpec>,
    link_owed: Option<Owed>,
    config_owed: Option<Owed>,
    dns: Option<Owed>,
    baseline: Option<(u64, u64)>,
    log: PathBuf,
    /// When the log was first seen ending on a restart, for the age of a
    /// stale link. Cleared when it comes back up.
    restarting_since: Option<Instant>,
}

pub(crate) fn connect(
    profile: &ConnectProfile,
    known_nodes: &[String],
    dirs: &Dirs,
    limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    let ConnectProfile::Openvpn(p) = profile else {
        return Err(Problem::Failed(format!("{} is not OpenVPN", profile.protocol_name())));
    };
    let Some(exe) = cmd::find(PROGRAM) else {
        return Err(Problem::EngineMissing(PROGRAM.to_string()));
    };
    let (host, port) = crate::wireguard::split_endpoint(&p.endpoint)
        .ok_or_else(|| Problem::Failed("the OpenVPN endpoint is not host:port".into()))?;
    let transport_proto = proto(p)?;
    let budget = Budget::within(limits, Duration::from_secs(120));

    // Leftovers in the way: a tun by our name, stale host routes to the
    // servers the app knows.
    let _ = link::delete(LINK, &budget);
    routes::purge_stale(known_nodes, &budget);

    // The server by address, so OpenVPN never looks it up again through a
    // DNS that by then points into the tunnel; and the way out to it,
    // asked before anything of ours is routed.
    let server = routes::resolve_ipv4(&host, port, &budget)?;
    let uplink = routes::uplink_for(server, &budget)?;
    let config = build_config(p, server, port)?;

    let mut tunnel = OvpnTunnel {
        up: Up {
            protocol: profile.protocol_name().to_string(),
            ifaces: vec![LINK.to_string()],
            transports: vec![Transport { ip: server, port, proto: transport_proto }],
            fwmark: None,
            dns_protected: false,
        },
        child: None,
        ledger: Ledger::in_dir(&dirs.state),
        engine_routes: Vec::new(),
        link_owed: None,
        config_owed: None,
        dns: None,
        baseline: None,
        log: dirs.run.join(LOG_FILE),
        restarting_since: None,
    };
    // From here an early return drops `tunnel`, which undoes what it did.
    tunnel.bring_up(&exe, &config, server, &uplink, dirs, &budget)?;
    Ok(Box::new(tunnel))
}

impl OvpnTunnel {
    fn bring_up(
        &mut self,
        exe: &Path,
        config: &str,
        server: Ipv4Addr,
        uplink: &Uplink,
        dirs: &Dirs,
        budget: &Budget,
    ) -> Result<(), Problem> {
        let _ = std::fs::create_dir_all(&dirs.run);
        let path = dirs.run.join(CONFIG_FILE);
        let owed = Owed::File { path: path.clone() };
        self.ledger.owe(owed.clone());
        self.config_owed = Some(owed);
        crate::files::write_private(&path, config.as_bytes())
            .map_err(|e| Problem::Failed(format!("could not write the OpenVPN config: {e}")))?;

        let owed = Owed::Link { name: LINK.to_string() };
        self.ledger.owe(owed.clone());
        self.link_owed = Some(owed);

        // The table before, and the server's host route owed ahead: OpenVPN
        // adds it early, and a helper killed before the connect returns must
        // still leave a record of it. Only when it is not there already --
        // one already on the table is not OpenVPN's to add, nor ours to take.
        let before = routes::main_table(budget);
        if let Some(rows) = &before {
            if !routes::has_host_route(rows, server, uplink) {
                let spec = RouteSpec::host(server, uplink);
                self.ledger.owe(Owed::EngineRoute(spec.clone()));
                self.engine_routes.push(spec);
            }
        }

        let config_arg = path.to_string_lossy().into_owned();
        let child = process::spawn(exe, &["--config", &config_arg], &self.log)
            .map_err(|e| Problem::Failed(format!("could not start OpenVPN: {e}")))?;
        let child = self.child.insert(child);
        let waited = process::confirm_started(child, "OpenVPN", &self.log, budget)
            .and_then(|()| wait_until_up(child, &self.log, budget));

        // What OpenVPN added, whether or not it finished: a connect that
        // fails or is cancelled after the pushed routes went in must still
        // take them out.
        if let Some(after) = routes::main_table(budget).or_else(|| routes::main_table(&teardown())) {
            let ahead = std::mem::take(&mut self.engine_routes);
            let added = added_routes(before.as_deref(), &after, server);
            for spec in &added {
                self.ledger.owe(Owed::EngineRoute(spec.clone()));
            }
            // Owed ahead and never added: struck off, not deleted.
            for spec in ahead.iter().filter(|s| !added.contains(s)) {
                self.ledger.settle(&Owed::EngineRoute(spec.clone()));
            }
            self.engine_routes = added;
        }
        waited?;

        if !link::exists(LINK) {
            return Err(Problem::Failed(format!("OpenVPN said it was up but its interface ({LINK}) is not there")));
        }
        self.baseline = link::counters(LINK);

        // DNS once OpenVPN's routes lead into the tunnel, and not before.
        self.dns = dns::point_at(LINK, &dirs.state, &self.ledger, budget);
        self.up.dns_protected = self.dns.is_some();
        Ok(())
    }

    fn kill(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
        }
    }

    fn remove_engine_routes(&mut self, budget: &Budget) {
        for spec in std::mem::take(&mut self.engine_routes) {
            match routes::delete_engines(&spec, budget) {
                Ok(()) => self.ledger.settle(&Owed::EngineRoute(spec)),
                Err(_) => self.engine_routes.push(spec),
            }
        }
    }
}

/// Waits for OpenVPN to say its tunnel is up. Ends early, with its last
/// words, if it exits; ends on cancel and on the deadline.
fn wait_until_up(child: &mut Child, log: &Path, budget: &Budget) -> Result<(), Problem> {
    let capped = Budget::quick(TUNNEL_UP_WITHIN);
    loop {
        if std::fs::read_to_string(log).is_ok_and(|l| l.contains(TUNNEL_UP_MARK)) {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(Problem::Failed(format!(
                    "OpenVPN stopped before the tunnel came up ({status}): {}",
                    process::log_tail(log)
                )));
            }
            Ok(None) => {}
            Err(e) => return Err(Problem::Failed(format!("could not check whether OpenVPN was still running: {e}"))),
        }
        budget.check().map_err(|stop| stop.problem("OpenVPN to finish connecting"))?;
        if capped.expired() {
            return Err(Problem::Failed(format!(
                "OpenVPN did not finish connecting within {}s: {}",
                TUNNEL_UP_WITHIN.as_secs(),
                process::log_tail(log)
            )));
        }
        budget.nap();
    }
}

impl Tunnel for OvpnTunnel {
    fn up(&self) -> &Up {
        &self.up
    }

    /// `Down` when the process has exited or its tun is gone. `Stale`
    /// while its log says it is restarting, aged from when that was first
    /// seen. Otherwise `Unknown`, as Windows reports OpenVPN: a running
    /// process is not evidence the server answers.
    fn health(&mut self) -> TunnelHealth {
        match self.child.as_mut().map(|c| c.try_wait()) {
            None | Some(Ok(Some(_))) => return TunnelHealth::Down,
            Some(Err(_)) => return TunnelHealth::Unknown,
            Some(Ok(None)) => {}
        }
        if Path::new("/sys/class/net").is_dir() && !link::exists(LINK) {
            return TunnelHealth::Down;
        }
        if link_restarting(&read_tail(&self.log)) {
            let since = *self.restarting_since.get_or_insert_with(Instant::now);
            TunnelHealth::Stale { age_secs: since.elapsed().as_secs() }
        } else {
            self.restarting_since = None;
            TunnelHealth::Unknown
        }
    }

    fn counters(&self) -> Option<(u64, u64)> {
        let (rx, tx) = link::counters(LINK)?;
        let (rx0, tx0) = self.baseline.unwrap_or((0, 0));
        Some((rx.saturating_sub(rx0), tx.saturating_sub(tx0)))
    }

    /// The engine killed first: its tun is not persistent, so the kernel
    /// removes it, and the pushed routes on it, as the process dies. The
    /// routes on the tun are flushed anyway in case it lingers, then the
    /// host routes OpenVPN put on the uplink, which a killed OpenVPN never
    /// takes back. `ip` calls only.
    fn hard_stop(&mut self) {
        let budget = teardown();
        self.kill();
        if link::exists(LINK) {
            let _ = cmd::ip(&["-4", "route", "flush", "dev", LINK], &budget);
        }
        self.remove_engine_routes(&budget);
    }

    fn finish_stop(&mut self) {
        let budget = teardown();
        self.kill();
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.remove_engine_routes(&budget);
        if let Some(owed) = self.dns.take() {
            match dns::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => self.dns = Some(owed),
            }
        }
        if let Some(owed) = self.link_owed.take() {
            match link::delete(LINK, &budget) {
                Ok(()) => self.ledger.settle(&owed),
                Err(_) => self.link_owed = Some(owed),
            }
        }
        if let Some(owed) = self.config_owed.take() {
            if let Owed::File { path } = &owed {
                match std::fs::remove_file(path) {
                    Ok(()) => self.ledger.settle(&owed),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.ledger.settle(&owed),
                    Err(_) => self.config_owed = Some(owed),
                }
            }
        }
    }
}

impl Drop for OvpnTunnel {
    fn drop(&mut self) {
        self.hard_stop();
        self.finish_stop();
    }
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

    fn config() -> String {
        build_config(&profile(), Ipv4Addr::new(203, 0, 113, 5), 1194).unwrap()
    }

    #[test]
    fn the_windows_config_without_what_is_windows_alone() {
        let c = config();
        for gone in ["windows-driver", "dev-node", "block-outside-dns", "route-nopull"] {
            assert!(!c.contains(gone), "{gone}");
        }
        assert!(c.contains("\ndev neoxify-ovpn\n"));
        assert!(c.contains("\ndev-type tun\n"));
        assert!(c.contains("\nremote 203.0.113.5 1194\n"));
        assert!(c.contains("\nproto udp\n"));
        assert!(c.contains("<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----"));
    }

    #[test]
    fn it_runs_no_scripts() {
        let c = config();
        assert!(c.contains("\nscript-security 1\n"));
        for directive in ["\nup ", "\ndown ", "route-up", "ipchange", "client-connect", "learn-address"] {
            assert!(!c.contains(directive), "{directive}");
        }
    }

    // Ported from the Windows service: the MTU is pinned and the pushed
    // one refused, or full-size packets vanish on narrow links.
    #[test]
    fn the_mtu_is_pinned_and_the_pushed_one_refused() {
        let c = config();
        assert!(c.contains("pull-filter ignore \"tun-mtu\"\n"));
        assert!(c.contains("\ntun-mtu 1348\n"));
        assert!(c.contains("\nmssfix 1400 mtu\n"));
    }

    #[test]
    fn a_key_that_could_close_its_block_is_refused() {
        let bad = OpenvpnProfile { key_pem: "-----BEGIN PRIVATE KEY-----\n</key>\nup /bin/sh".into(), ..profile() };
        assert!(build_config(&bad, Ipv4Addr::new(203, 0, 113, 5), 1194).is_err());
    }

    #[test]
    fn tcp_and_udp_are_named_as_openvpn_wants_them() {
        let tcp = OpenvpnProfile { proto: "tcp".into(), ..profile() };
        assert_eq!(proto(&tcp), Ok(Proto::Tcp));
        assert!(build_config(&tcp, Ipv4Addr::new(203, 0, 113, 5), 443).unwrap().contains("\nproto tcp-client\n"));
        assert_eq!(proto(&profile()), Ok(Proto::Udp));
        assert!(proto(&OpenvpnProfile { proto: "icmp".into(), ..profile() }).is_err());
    }

    // Ported from the Windows service's `link_reading` tests.
    #[test]
    fn a_restart_after_the_last_completion_is_a_link_not_carrying() {
        const QUIET: &str = "2026-10-11 14:20:11 [server] Inactivity timeout (--ping-restart), restarting\n\
                             2026-10-11 14:20:11 SIGUSR1[soft,ping-restart] received, process restarting\n";
        assert!(link_restarting(QUIET));
        assert!(link_restarting("Initialization Sequence Completed\nSIGUSR1[soft,ping-restart] received, process restarting\n"));
        assert!(!link_restarting("SIGUSR1[soft,ping-restart] received, process restarting\nInitialization Sequence Completed\n"));
        assert!(!link_restarting("Initialization Sequence Completed\n"));
        assert!(!link_restarting(""));
    }

    #[test]
    fn the_host_routes_openvpn_added_are_found_and_nothing_else() {
        // `ip -j -4 route show table main` before and after on Ubuntu 24.04,
        // with documentation ranges substituted in.
        let before = routes::parse_rows(
            r#"[{"dst":"default","gateway":"10.0.2.2","dev":"enp0s3","protocol":"dhcp","metric":100,"flags":[]},{"dst":"10.0.2.0/24","dev":"enp0s3","protocol":"kernel","scope":"link","prefsrc":"10.0.2.15","flags":[]}]"#,
        );
        let after = routes::parse_rows(
            r#"[{"dst":"0.0.0.0/1","gateway":"10.8.0.1","dev":"neoxify-ovpn","flags":[]},{"dst":"default","gateway":"10.0.2.2","dev":"enp0s3","protocol":"dhcp","metric":100,"flags":[]},{"dst":"10.0.2.0/24","dev":"enp0s3","protocol":"kernel","scope":"link","prefsrc":"10.0.2.15","flags":[]},{"dst":"10.8.0.0/24","dev":"neoxify-ovpn","protocol":"kernel","scope":"link","prefsrc":"10.8.0.2","flags":[]},{"dst":"128.0.0.0/1","gateway":"10.8.0.1","dev":"neoxify-ovpn","flags":[]},{"dst":"203.0.113.5","gateway":"10.0.2.2","dev":"enp0s3","flags":[]},{"dst":"198.51.100.7","gateway":"10.0.2.2","dev":"enp0s3","protocol":"98","flags":[]}]"#,
        );
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let added = added_routes(Some(&before), &after, server);
        assert_eq!(added.len(), 1, "{added:?}");
        assert_eq!(added[0].dest, "203.0.113.5/32");
        assert_eq!(added[0].via.as_deref(), Some("10.0.2.2"));
        assert_eq!(added[0].dev, "enp0s3");
        // No first reading: only the route to the server is taken.
        assert_eq!(added_routes(None, &after, server), added);
        // The one owed ahead matches the one found, so it is kept, not settled.
        let uplink = Uplink { dev: "enp0s3".into(), via: Some(Ipv4Addr::new(10, 0, 2, 2)) };
        assert_eq!(RouteSpec::host(server, &uplink), added[0]);
        assert!(routes::has_host_route(&after, server, &uplink));
        assert!(!routes::has_host_route(&before, server, &uplink));
    }
}
