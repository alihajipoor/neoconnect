//! WireGuard through the kernel: interface `neoxify-wg`, configured with
//! `ip` and `wg`, routed by firewall mark.
//!
//! This is wg-quick's method without wg-quick. wg-quick rewrites
//! `/etc/resolv.conf` through `resolvconf` and writes its own nftables
//! rules, both of which would fight the helper's DNS module and netguard,
//! so the same steps are taken here one by one, each owed in the ledger
//! before it is made:
//!
//! * the link, with only WireGuard's own keys handed to `wg setconf` from
//!   a root-only file that is deleted straight after;
//! * the profile's IPv4 address and MTU 1420, then up;
//! * `fwmark 28280` on the engine's own packets, a default route into the
//!   link in table 28280, and two rules: the main table first with its
//!   default routes suppressed (so the local network and our host routes
//!   still apply), then everything not marked into table 28280. The
//!   engine's own marked packets fall through to the main table and leave
//!   by the uplink, which is what keeps them out of their own tunnel.
//!
//! There is never a real default route of ours in the main table, so a
//! tunnel that dies leaves the machine's routing exactly as it was once
//! the two rules go.

use std::net::Ipv4Addr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use neoconnect_ipc::{ConnectProfile, WireguardProfile};

use crate::cmd::{self, Budget, IpError};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::{dns, link, routes};
use crate::{Dirs, Limits, Problem, Proto, Transport, Tunnel, TunnelHealth, Up};

pub const LINK: &str = link::WG_LINK;

/// The mark on the engine's own packets, and the routing table that
/// carries everything else into the tunnel. One number for both, as
/// wg-quick does, so a rule can never name one and not the other.
pub const FWMARK: u32 = 28280;

/// The two rules' priorities. Fixed rather than left to the kernel so the
/// sweep can tell ours from anyone else's; below the main table's 32766,
/// and the suppressing rule first, as wg-quick orders them.
pub const SUPPRESS_PREF: u32 = 28278;
pub const TUNNEL_PREF: u32 = 28279;

/// The key file `wg setconf` reads, in `Dirs::run`. It holds the private
/// key and lives only for the length of that one call.
pub const KEY_FILE: &str = "neoxify-wg.conf";

/// WireGuard's own default for IPv4 over a 1500-byte link (1500 - 20 IP -
/// 8 UDP - 32 WireGuard) and what the nodes run on wg0. Left at the
/// link's 1500, full-size packets go over the path MTU once WireGuard's
/// header is on, and the tunnel loads some sites and hangs on others
/// (measured on a Windows customer's machine, 2026-08-17).
pub const MTU: &str = "1420";

/// A handshake older than this means the peer has stopped answering.
/// WireGuard rehandshakes about every two minutes while traffic flows,
/// so three minutes is one missed cycle plus room for an idle link. As on
/// Windows.
const HANDSHAKE_STALE_AFTER_SECS: u64 = 180;

/// Plural: `wg` rejects the singular with usage on stderr and nothing on
/// stdout, which would read as "no peers" (learned on Windows).
const HANDSHAKES_SUBCOMMAND: &str = "latest-handshakes";

/// The two policy rules, as the arguments after `ip rule add` (the same
/// ones delete them).
pub(crate) fn rule_args() -> [Vec<String>; 2] {
    let mark = FWMARK.to_string();
    [
        ["pref", &SUPPRESS_PREF.to_string(), "table", "main", "suppress_prefixlength", "0"].map(String::from).to_vec(),
        ["pref", &TUNNEL_PREF.to_string(), "not", "fwmark", &mark, "table", &mark].map(String::from).to_vec(),
    ]
}

/// The tunnel's IPv4 address with its prefix, from the profile's
/// `Address`, which may also list an IPv6 one. Our servers are IPv4
/// only, so an IPv6 address would only give the machine a source address
/// with nowhere to go; it is left out, and netguard blocks global IPv6.
pub(crate) fn ipv4_address(address: &str) -> Option<String> {
    address.split(',').map(str::trim).find_map(|entry| {
        let (host, prefix) = entry.split_once('/').unwrap_or((entry, "32"));
        let ip: Ipv4Addr = host.parse().ok()?;
        let prefix: u8 = prefix.parse().ok().filter(|p| *p <= 32)?;
        Some(format!("{ip}/{prefix}"))
    })
}

/// The resolver to point the machine at: the profile's first IPv4 one,
/// else 1.1.1.1 as on Windows.
pub(crate) fn resolver(dns: Option<&str>) -> String {
    dns.and_then(|d| d.split(',').map(str::trim).find(|s| s.parse::<Ipv4Addr>().is_ok()))
        .unwrap_or(dns::TUN_DNS)
        .to_string()
}

/// `host:port` (or `[host]:port`) split.
pub(crate) fn split_endpoint(endpoint: &str) -> Option<(String, u16)> {
    let (host, port) = endpoint.trim().rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

/// What `wg setconf` is given: WireGuard's own keys only. `Address`,
/// `DNS` and `MTU` are wg-quick's additions and `wg` refuses them. The
/// endpoint is written as the address resolved before the tunnel came up,
/// so the engine never looks its server up through the tunnel's DNS.
pub(crate) fn build_setconf(p: &WireguardProfile, endpoint: Ipv4Addr, port: u16) -> Result<String, Problem> {
    for (field, value) in
        [("private key", &p.private_key), ("server public key", &p.server_public_key), ("allowed IPs", &p.allowed_ips)]
    {
        // Validated by the app's IPC layer already; a line break here would
        // be a second directive, so it is refused again where it matters.
        if value.chars().any(|c| c.is_control()) {
            return Err(Problem::Failed(format!("the WireGuard profile's {field} is malformed")));
        }
    }
    let allowed = if p.allowed_ips.trim().is_empty() { "0.0.0.0/0" } else { p.allowed_ips.trim() };
    Ok(format!(
        "[Interface]\nPrivateKey = {}\n\n[Peer]\nPublicKey = {}\nEndpoint = {endpoint}:{port}\nAllowedIPs = {allowed}\nPersistentKeepalive = 25\n",
        p.private_key.trim(),
        p.server_public_key.trim(),
    ))
}

/// `wg show <link> latest-handshakes`, judged as on Windows: no peer line
/// says nothing, zero is never, and an age past three minutes is stale.
pub(crate) fn parse_handshake(out: &str, now: u64) -> TunnelHealth {
    let latest =
        out.lines().filter_map(|line| line.split('\t').nth(1)).filter_map(|s| s.trim().parse::<u64>().ok()).max();
    match latest {
        None => TunnelHealth::Unknown,
        Some(0) => TunnelHealth::NeverHandshaked,
        Some(ts) => {
            // Saturating: a clock step must not turn into a huge age.
            let age = now.saturating_sub(ts);
            if age <= HANDSHAKE_STALE_AFTER_SECS {
                TunnelHealth::Alive { age_secs: age }
            } else {
                TunnelHealth::Stale { age_secs: age }
            }
        }
    }
}

/// The kernel's ways of saying it has no WireGuard.
fn module_missing(why: &str) -> bool {
    ["Unknown device type", "Operation not supported", "not supported"].iter().any(|w| why.contains(w))
}

fn teardown() -> Budget {
    Budget::quick(cmd::TEARDOWN_CAP)
}

pub(crate) struct WgTunnel {
    up: Up,
    ledger: Ledger,
    link_owed: Option<Owed>,
    /// The rules added, in the order added.
    rules: Vec<Owed>,
    routes: Vec<RouteSpec>,
    dns: Option<Owed>,
    key_owed: Option<Owed>,
    baseline: Option<(u64, u64)>,
}

pub(crate) fn connect(
    profile: &ConnectProfile,
    known_nodes: &[String],
    dirs: &Dirs,
    limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    let ConnectProfile::Wireguard(p) = profile else {
        return Err(Problem::Failed(format!("{} is not WireGuard", profile.protocol_name())));
    };
    if cmd::find("wg").is_none() {
        return Err(Problem::EngineMissing("wg".to_string()));
    }
    let (host, port) =
        split_endpoint(&p.endpoint).ok_or_else(|| Problem::Failed("the WireGuard endpoint is not host:port".into()))?;
    let address = ipv4_address(&p.address)
        .ok_or_else(|| Problem::Failed("the WireGuard profile has no IPv4 address for the tunnel".into()))?;
    let budget = Budget::within(limits, Duration::from_secs(60));

    // Leftovers in the way: a link by our name (the add would fail), and
    // stale host routes to the servers the app knows.
    let _ = link::delete(LINK, &budget);
    routes::purge_stale(known_nodes, &budget);

    // The server's address, and that there is a way out to it, asked
    // before anything of ours is routed.
    let server = routes::resolve_ipv4(&host, port, &budget)?;
    routes::uplink_for(server, &budget)?;
    let setconf = build_setconf(p, server, port)?;

    let mut tunnel = WgTunnel {
        up: Up {
            protocol: profile.protocol_name().to_string(),
            ifaces: vec![LINK.to_string()],
            transports: vec![Transport { ip: server, port, proto: Proto::Udp }],
            fwmark: Some(FWMARK),
            dns_protected: false,
        },
        ledger: Ledger::in_dir(&dirs.state),
        link_owed: None,
        rules: Vec::new(),
        routes: Vec::new(),
        dns: None,
        key_owed: None,
        baseline: None,
    };
    // From here an early return drops `tunnel`, which undoes what it did.
    tunnel.bring_up(&setconf, &address, &resolver(p.dns.as_deref()), dirs, &budget)?;
    Ok(Box::new(tunnel))
}

impl WgTunnel {
    fn bring_up(&mut self, setconf: &str, address: &str, resolver: &str, dirs: &Dirs, budget: &Budget) -> Result<(), Problem> {
        // The link.
        let owed = Owed::Link { name: LINK.to_string() };
        self.ledger.owe(owed.clone());
        self.link_owed = Some(owed);
        match cmd::ip(&["link", "add", "dev", LINK, "type", "wireguard"], budget) {
            Ok(_) => {}
            Err(IpError::Refused(why)) if module_missing(&why) => {
                return Err(Problem::EngineMissing("the WireGuard kernel module".to_string()));
            }
            Err(e) => return Err(e.problem(&format!("create the WireGuard interface ({LINK})"))),
        }

        // The keys, from a root-only file that exists for one call.
        let _ = std::fs::create_dir_all(&dirs.run);
        let key_file = dirs.run.join(KEY_FILE);
        let owed = Owed::File { path: key_file.clone() };
        self.ledger.owe(owed.clone());
        self.key_owed = Some(owed);
        crate::files::write_private(&key_file, setconf.as_bytes())
            .map_err(|e| Problem::Failed(format!("could not write the WireGuard keys: {e}")))?;
        let key_arg = key_file.to_string_lossy().into_owned();
        let set = cmd::run("wg", &["setconf", LINK, &key_arg], budget);
        self.delete_key_file();
        match set {
            Ok(out) if out.success => {}
            Ok(out) => return Err(Problem::Failed(format!("WireGuard did not accept its configuration: {}", out.complaint()))),
            Err(e) => return Err(e.problem("configure WireGuard")),
        }

        // Address, MTU, up, read back.
        cmd::ip(&["link", "set", "dev", LINK, "mtu", MTU], budget)
            .map_err(|e| e.problem(&format!("set the MTU of {LINK}")))?;
        link::address_and_up(LINK, address, budget).map_err(|e| e.problem(&format!("address {LINK}")))?;
        if !link::ipv4_addresses(LINK, budget).iter().any(|a| a == address) {
            return Err(Problem::Failed(format!("the tunnel interface ({LINK}) did not take its address")));
        }
        self.baseline = link::counters(LINK);

        // The engine's own packets marked, so the rules below pass them by.
        match cmd::run("wg", &["set", LINK, "fwmark", &FWMARK.to_string()], budget) {
            Ok(out) if out.success => {}
            Ok(out) => return Err(Problem::Failed(format!("could not mark WireGuard's packets: {}", out.complaint()))),
            Err(e) => return Err(e.problem("mark WireGuard's packets")),
        }

        // Without this the kernel's reverse-path check cannot use the mark
        // and may drop the server's replies on a machine with strict
        // rp_filter. wg-quick sets it the same way and leaves it set, as
        // here: it changes nothing for packets that carry no mark.
        let _ = std::fs::write("/proc/sys/net/ipv4/conf/all/src_valid_mark", "1");

        // Table 28280's one route, then the rules that send traffic to it.
        let spec = RouteSpec {
            dest: "0.0.0.0/0".to_string(),
            dev: LINK.to_string(),
            via: None,
            table: Some(FWMARK),
            v6: false,
        };
        routes::add(&spec, false, &self.ledger, budget)
            .map_err(|e| e.problem(&format!("route into {LINK} in table {FWMARK}")))?;
        self.routes.push(spec);
        for args in rule_args() {
            let owed = Owed::Rule { args: args.clone(), v6: false };
            self.ledger.owe(owed.clone());
            let mut all = vec!["-4", "rule", "add"];
            all.extend(args.iter().map(String::as_str));
            match cmd::ip(&all, budget) {
                Ok(_) => self.rules.push(owed),
                Err(e) => {
                    self.ledger.settle(&owed);
                    return Err(e.problem("add the tunnel's routing rule"));
                }
            }
        }

        // DNS last, once a route leads into the tunnel.
        self.dns = dns::point_at_resolver(LINK, resolver, &dirs.state, &self.ledger, budget);
        self.up.dns_protected = self.dns.is_some();
        Ok(())
    }

    fn delete_key_file(&mut self) {
        if let Some(owed) = self.key_owed.take() {
            if let Owed::File { path } = &owed {
                match std::fs::remove_file(path) {
                    Ok(()) => self.ledger.settle(&owed),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.ledger.settle(&owed),
                    Err(_) => self.key_owed = Some(owed),
                }
            }
        }
    }

    fn remove_rules(&mut self, budget: &Budget) {
        // Reverse order: the rule into the tunnel goes first, so there is
        // never a moment when only it remains without the suppressing one.
        let mut kept = Vec::new();
        for owed in std::mem::take(&mut self.rules).into_iter().rev() {
            match crate::cleanup::undo(&owed, budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => kept.push(owed),
            }
        }
        kept.reverse();
        self.rules = kept;
    }

    fn remove_routes(&mut self, budget: &Budget) {
        for spec in std::mem::take(&mut self.routes) {
            if routes::remove(&spec, &self.ledger, budget).is_err() {
                self.routes.push(spec);
            }
        }
    }

    fn remove_link(&mut self, budget: &Budget) {
        if let Some(owed) = self.link_owed.take() {
            match link::delete(LINK, budget) {
                Ok(()) => self.ledger.settle(&owed),
                Err(_) => self.link_owed = Some(owed),
            }
        }
    }
}

impl Tunnel for WgTunnel {
    fn up(&self) -> &Up {
        &self.up
    }

    /// From the latest handshake, as on Windows. `Down` only when the link
    /// is gone; a `wg` that cannot be asked is `Unknown`.
    fn health(&mut self) -> TunnelHealth {
        if std::path::Path::new("/sys/class/net").is_dir() && !link::exists(LINK) {
            return TunnelHealth::Down;
        }
        let out = match cmd::run("wg", &["show", LINK, HANDSHAKES_SUBCOMMAND], &Budget::quick(Duration::from_secs(3))) {
            Ok(out) if out.success => out.stdout,
            _ => return TunnelHealth::Unknown,
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        parse_handshake(&out, now)
    }

    fn dns_protected(&self) -> bool {
        self.dns.as_ref().is_some_and(dns::still_in_force)
    }

    fn counters(&self) -> Option<(u64, u64)> {
        let (rx, tx) = link::counters(LINK)?;
        let (rx0, tx0) = self.baseline.unwrap_or((0, 0));
        Some((rx.saturating_sub(rx0), tx.saturating_sub(tx0)))
    }

    /// The rules first: with them gone nothing is looked up in table
    /// 28280 and traffic is back on the main table at once. Then the
    /// route. `ip` calls only.
    ///
    /// The link is NOT deleted here. Deleting a WireGuard device makes
    /// the kernel wait for its workers, which was measured at up to 1.6 s
    /// in the VM, and a disconnect that slow was answered as a failure
    /// though the customer's traffic had been back on their own network
    /// since the rules went. With the rules and the route gone the link
    /// carries nothing, so it waits for the thorough half.
    fn hard_stop(&mut self) {
        let budget = teardown();
        self.remove_rules(&budget);
        self.remove_routes(&budget);
    }

    fn finish_stop(&mut self) {
        let budget = teardown();
        self.remove_rules(&budget);
        self.remove_routes(&budget);
        if let Some(owed) = self.dns.take() {
            match dns::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => self.dns = Some(owed),
            }
        }
        self.remove_link(&budget);
        self.delete_key_file();
    }
}

impl Drop for WgTunnel {
    fn drop(&mut self) {
        self.hard_stop();
        self.finish_stop();
    }
}

/// Our two rules if a helper that died left them, found by priority and
/// table so nobody else's rule is taken. For the sweep.
pub(crate) fn leftover_rules(json: &str) -> Vec<u32> {
    let Ok(serde_json::Value::Array(rules)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let mark = FWMARK.to_string();
    rules
        .iter()
        .filter_map(|r| {
            let pref = r["priority"].as_u64()? as u32;
            let table = match &r["table"] {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => return None,
            };
            let ours = (pref == TUNNEL_PREF && table == mark) || (pref == SUPPRESS_PREF && table == "main");
            ours.then_some(pref)
        })
        .collect()
}

pub(crate) fn sweep_rules(budget: &Budget) -> Vec<String> {
    let Ok(text) = cmd::ip(&["-j", "-4", "rule", "show"], budget) else { return Vec::new() };
    let mut lines = Vec::new();
    for pref in leftover_rules(&text) {
        // Deleted by its full description, never by priority alone: a
        // priority can be shared, and the other rule is not ours.
        let [suppress, tunnel] = rule_args();
        let args = if pref == SUPPRESS_PREF { suppress } else { tunnel };
        let mut all = vec!["-4", "rule", "del"];
        all.extend(args.iter().map(String::as_str));
        match cmd::ip(&all, budget) {
            Ok(_) => lines.push(format!("removed a leftover WireGuard routing rule (priority {pref})")),
            Err(e) if e.already_gone() => {}
            Err(e) => lines.push(format!("could not remove a leftover WireGuard routing rule (priority {pref}): {e}")),
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> WireguardProfile {
        WireguardProfile {
            private_key: "cHJpdmF0ZQ==".into(),
            address: "10.66.0.5/32".into(),
            dns: Some("1.1.1.1".into()),
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: "cHVibGlj".into(),
            endpoint: "203.0.113.5:51820".into(),
        }
    }

    #[test]
    fn setconf_holds_only_wireguards_own_keys() {
        let conf = build_setconf(&profile(), Ipv4Addr::new(203, 0, 113, 5), 51820).unwrap();
        assert!(conf.contains("PrivateKey = cHJpdmF0ZQ=="));
        assert!(conf.contains("PublicKey = cHVibGlj"));
        assert!(conf.contains("Endpoint = 203.0.113.5:51820"));
        assert!(conf.contains("AllowedIPs = 0.0.0.0/0"));
        assert!(conf.contains("PersistentKeepalive = 25"));
        // wg-quick's own keys: `wg setconf` refuses every one of them.
        for key in ["Address", "DNS", "MTU", "Table", "PostUp"] {
            assert!(!conf.contains(&format!("{key} =")), "{key}");
        }
    }

    #[test]
    fn the_endpoint_is_written_as_the_resolved_address() {
        let named = WireguardProfile { endpoint: "node.example.com:51820".into(), ..profile() };
        let conf = build_setconf(&named, Ipv4Addr::new(192, 0, 2, 7), 51820).unwrap();
        assert!(conf.contains("Endpoint = 192.0.2.7:51820"));
        assert!(!conf.contains("example.com"));
    }

    #[test]
    fn a_line_break_in_a_key_is_refused() {
        let bad = WireguardProfile { private_key: "abc\nPostUp = id".into(), ..profile() };
        assert!(build_setconf(&bad, Ipv4Addr::new(192, 0, 2, 7), 51820).is_err());
    }

    #[test]
    fn only_the_ipv4_address_is_put_on_the_link() {
        assert_eq!(ipv4_address("10.66.0.5/32").as_deref(), Some("10.66.0.5/32"));
        assert_eq!(ipv4_address("fd00::5/128, 10.66.0.5/24").as_deref(), Some("10.66.0.5/24"));
        assert_eq!(ipv4_address("10.66.0.5").as_deref(), Some("10.66.0.5/32"));
        assert_eq!(ipv4_address("fd00::5/128"), None);
        assert_eq!(ipv4_address("10.66.0.5/40"), None);
    }

    #[test]
    fn dns_is_the_profiles_resolver_or_cloudflares() {
        assert_eq!(resolver(Some("9.9.9.9")), "9.9.9.9");
        assert_eq!(resolver(Some("2606:4700::1111, 9.9.9.9")), "9.9.9.9");
        assert_eq!(resolver(None), "1.1.1.1");
        assert_eq!(resolver(Some("")), "1.1.1.1");
    }

    #[test]
    fn endpoints_split_at_the_last_colon() {
        assert_eq!(split_endpoint("203.0.113.5:51820"), Some(("203.0.113.5".into(), 51820)));
        assert_eq!(split_endpoint("node.example.com:443"), Some(("node.example.com".into(), 443)));
        assert_eq!(split_endpoint("203.0.113.5"), None);
        assert_eq!(split_endpoint(":51820"), None);
    }

    // Ported from the Windows service's handshake tests.
    #[test]
    fn handshake_health_follows_the_windows_rules() {
        let now = 1_000_000;
        assert_eq!(parse_handshake("", now), TunnelHealth::Unknown);
        assert_eq!(parse_handshake("cHVibGlj\t0\n", now), TunnelHealth::NeverHandshaked);
        assert_eq!(parse_handshake(&format!("cHVibGlj\t{}\n", now - 30), now), TunnelHealth::Alive { age_secs: 30 });
        assert_eq!(parse_handshake(&format!("cHVibGlj\t{}\n", now - 180), now), TunnelHealth::Alive { age_secs: 180 });
        assert_eq!(parse_handshake(&format!("cHVibGlj\t{}\n", now - 181), now), TunnelHealth::Stale { age_secs: 181 });
        // A clock stepped backwards is not a dead tunnel.
        assert_eq!(parse_handshake(&format!("cHVibGlj\t{}\n", now + 50), now), TunnelHealth::Alive { age_secs: 0 });
        assert_eq!(HANDSHAKES_SUBCOMMAND, "latest-handshakes");
    }

    #[test]
    fn the_rules_send_unmarked_traffic_to_the_tunnel_after_the_local_network() {
        let [suppress, tunnel] = rule_args();
        assert_eq!(suppress, ["pref", "28278", "table", "main", "suppress_prefixlength", "0"]);
        assert_eq!(tunnel, ["pref", "28279", "not", "fwmark", "28280", "table", "28280"]);
        assert!(SUPPRESS_PREF < TUNNEL_PREF, "the main table is asked first");
    }

    #[test]
    fn only_our_rules_are_leftovers() {
        // `ip -j -4 rule show` with ours in, captured shape from iproute2 6.1.
        let json = r#"[{"priority":0,"src":"all","table":"local"},{"priority":28278,"src":"all","table":"main","suppress_prefixlen":0},{"priority":28279,"not":null,"src":"all","fwmark":"0x6e78","table":"28280"},{"priority":28279,"src":"all","table":"51820"},{"priority":32766,"src":"all","table":"main"},{"priority":32767,"src":"all","table":"default"}]"#;
        assert_eq!(leftover_rules(json), vec![28278, 28279]);
        assert!(leftover_rules("[]").is_empty());
        assert!(leftover_rules("garbage").is_empty());
    }
}
