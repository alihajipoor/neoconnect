//! The routing table: where the engine's own connection leaves, and the
//! routes that put everything else into the tunnel.
//!
//! The shape mirrors Windows so the shared interface's assumptions hold:
//! a /32 host route to each server through the uplink, so the engine's
//! own connection never enters its own tunnel, and two half-defaults
//! (`0.0.0.0/1`, `128.0.0.0/1`) into the tunnel, which beat the
//! machine's default route by being more specific without replacing it.
//! There is never a real default route of ours, so a tunnel that dies
//! leaves the machine's own default route exactly where it was.
//!
//! Every route here is added with protocol [`ROUTE_PROTO`], so ours can
//! be told from anyone else's in the kernel's own table, and every one
//! is owed in the ledger before it is added.

use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;

use crate::cmd::{self, Budget, IpError, Stop};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::link;
use crate::Problem;

/// The routing protocol number our routes carry (`proto 98`). Not one
/// iproute2 names, so the kernel shows it as the number, and nothing else
/// on a desktop uses it. `ip route show proto 98` is then exactly ours.
pub const ROUTE_PROTO: &str = "98";

/// The two halves of the address space that together take everything
/// without being a default route.
pub const HALF_DEFAULTS: [&str; 2] = ["0.0.0.0/1", "128.0.0.0/1"];

/// One row of `ip -j route` output, as far as we need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    /// `default`, an address, or a prefix, as `ip` writes it.
    pub dst: String,
    pub gateway: Option<String>,
    pub dev: Option<String>,
    pub protocol: Option<String>,
    /// Absent for `main` in a single-table listing.
    pub table: Option<String>,
    pub metric: u64,
    /// `unicast` when `ip` does not say: it names only the other kinds.
    pub kind: String,
}

pub(crate) fn parse_rows(json: &str) -> Vec<Row> {
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    rows.iter()
        .filter_map(|r| {
            let text = |key: &str| r[key].as_str().map(str::to_string);
            let protocol = match &r["protocol"] {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
            let table = match &r["table"] {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
            Some(Row {
                dst: text("dst")?,
                gateway: text("gateway"),
                dev: text("dev"),
                protocol,
                table,
                metric: r["metric"].as_u64().unwrap_or(0),
                kind: text("type").unwrap_or_else(|| "unicast".to_string()),
            })
        })
        .collect()
}

/// Where traffic to one address leaves the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Uplink {
    pub dev: String,
    /// `None` when the route is on the link itself -- a PPP uplink, or a
    /// server on the local network.
    pub via: Option<Ipv4Addr>,
}

/// The decision behind [`uplink_for`], on facts already gathered.
///
/// The kernel's own answer for the server is taken unless it leads into
/// one of our interfaces (a tunnel not yet gone) or loopback. Then the
/// lowest-metric default route of the main table that is not ours. No
/// gateway is fine (an on-link route is a way out); no route at all is
/// no network.
pub(crate) fn choose_uplink(answer: Option<&Row>, defaults: &[Row]) -> Option<Uplink> {
    let usable = |row: &Row| {
        row.kind == "unicast"
            && row.dev.as_deref().is_some_and(|dev| dev != "lo" && !link::OURS.contains(&dev))
    };
    let pick = |row: &Row| Uplink {
        dev: row.dev.clone().unwrap_or_default(),
        via: row.gateway.as_deref().and_then(|g| g.parse().ok()),
    };
    if let Some(row) = answer.filter(|r| usable(r)) {
        return Some(pick(row));
    }
    defaults.iter().filter(|r| r.dst == "default" && usable(r)).min_by_key(|r| r.metric).map(pick)
}

/// The way out to `server`, asked of the kernel (`ip route get`) before
/// anything of ours is routed.
pub(crate) fn uplink_for(server: Ipv4Addr, budget: &Budget) -> Result<Uplink, Problem> {
    let answer = match cmd::ip(&["-j", "-4", "route", "get", &server.to_string()], budget) {
        Ok(text) => parse_rows(&text).into_iter().next(),
        // "Network is unreachable": no route at all, which the defaults
        // below will confirm.
        Err(IpError::Refused(_)) => None,
        Err(IpError::Run(e)) => return Err(e.problem("ask the kernel for a route")),
    };
    let defaults = match cmd::ip(&["-j", "-4", "route", "show", "table", "main", "default"], budget) {
        Ok(text) => parse_rows(&text),
        Err(IpError::Refused(_)) => Vec::new(),
        Err(IpError::Run(e)) => return Err(e.problem("read the routing table")),
    };
    choose_uplink(answer.as_ref(), &defaults).ok_or(Problem::NoNetwork)
}

/// The server's IPv4 address. A literal is taken as it is; a name is
/// looked up off this thread, so a cancel or the deadline ends the wait
/// rather than the resolver's own timeout.
pub(crate) fn resolve_ipv4(host: &str, port: u16, budget: &Budget) -> Result<Ipv4Addr, Problem> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    let (tx, rx) = mpsc::channel();
    let owned = host.to_string();
    std::thread::spawn(move || {
        let _ = tx.send((owned.as_str(), port).to_socket_addrs().map(|a| a.collect::<Vec<_>>()));
    });
    loop {
        match rx.recv_timeout(cmd::POLL) {
            Ok(Ok(addrs)) => {
                return addrs
                    .into_iter()
                    .find_map(|a| match a.ip() {
                        IpAddr::V4(v4) => Some(v4),
                        IpAddr::V6(_) => None,
                    })
                    .ok_or_else(|| Problem::Failed(format!("{host} has no IPv4 address to route around the tunnel")));
            }
            Ok(Err(e)) => return Err(Problem::Failed(format!("could not resolve {host}: {e}"))),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Problem::Failed(format!("could not resolve {host}")));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                budget.check().map_err(|stop| stop.problem(&format!("the address of {host}")))?;
            }
        }
    }
}

impl RouteSpec {
    /// A host route to `server` through `uplink`.
    pub(crate) fn host(server: Ipv4Addr, uplink: &Uplink) -> Self {
        Self {
            dest: format!("{server}/32"),
            dev: uplink.dev.clone(),
            via: uplink.via.map(|v| v.to_string()),
            table: None,
            v6: false,
        }
    }

    /// A route straight into a tunnel interface.
    pub(crate) fn into_link(dest: &str, dev: &str) -> Self {
        Self { dest: dest.to_string(), dev: dev.to_string(), via: None, table: None, v6: false }
    }

    /// The arguments after `ip` that name exactly this route.
    fn args(&self, verb: &str) -> Vec<String> {
        let mut args = Vec::new();
        if self.v6 {
            args.push("-6".to_string());
        }
        args.extend(["route".to_string(), verb.to_string(), self.dest.clone()]);
        if let Some(via) = &self.via {
            args.extend(["via".to_string(), via.clone()]);
        }
        args.extend(["dev".to_string(), self.dev.clone()]);
        if let Some(table) = self.table {
            args.extend(["table".to_string(), table.to_string()]);
        }
        args.extend(["proto".to_string(), ROUTE_PROTO.to_string()]);
        args
    }

    pub(crate) fn add_args(&self) -> Vec<String> {
        self.args("add")
    }

    /// `replace` rather than `add` for a host route: one with our
    /// protocol to the same server can only be a leftover of ours.
    pub(crate) fn replace_args(&self) -> Vec<String> {
        self.args("replace")
    }

    pub(crate) fn del_args(&self) -> Vec<String> {
        self.args("del")
    }
}

fn run_ip(args: &[String], budget: &Budget) -> Result<String, IpError> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cmd::ip(&refs, budget)
}

/// Owes the route, then adds it. A route that would not go in is struck
/// off again: nothing is owed for a change that was never made.
pub(crate) fn add(spec: &RouteSpec, replace: bool, ledger: &Ledger, budget: &Budget) -> Result<(), IpError> {
    let owed = Owed::Route(spec.clone());
    ledger.owe(owed.clone());
    let args = if replace { spec.replace_args() } else { spec.add_args() };
    match run_ip(&args, budget) {
        Ok(_) => Ok(()),
        Err(e) => {
            if !route_present(spec) {
                ledger.settle(&owed);
            }
            Err(e)
        }
    }
}

/// Deletes the route, then strikes it off. Already gone counts as gone.
pub(crate) fn remove(spec: &RouteSpec, ledger: &Ledger, budget: &Budget) -> Result<(), IpError> {
    delete(spec, budget)?;
    ledger.settle(&Owed::Route(spec.clone()));
    Ok(())
}

/// Deletes the route, without touching the ledger.
pub(crate) fn delete(spec: &RouteSpec, budget: &Budget) -> Result<(), IpError> {
    match run_ip(&spec.del_args(), budget) {
        Ok(_) => Ok(()),
        Err(e) if e.already_gone() => Ok(()),
        // The interface it sat on is gone, and the route with it.
        Err(_) if !link::exists(&spec.dev) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Deletes a route an engine added itself, which carries the engine's
/// protocol rather than ours: by destination, gateway and device, as
/// [`purge_stale`] does. Already gone counts as gone.
pub(crate) fn delete_engines(spec: &RouteSpec, budget: &Budget) -> Result<(), IpError> {
    let mut args = vec!["route".to_string(), "del".to_string(), spec.dest.clone()];
    if let Some(via) = &spec.via {
        args.extend(["via".to_string(), via.clone()]);
    }
    args.extend(["dev".to_string(), spec.dev.clone()]);
    if let Some(table) = spec.table {
        args.extend(["table".to_string(), table.to_string()]);
    }
    match run_ip(&args, budget) {
        Ok(_) => Ok(()),
        Err(e) if e.already_gone() => Ok(()),
        Err(_) if !link::exists(&spec.dev) => Ok(()),
        Err(e) => Err(e),
    }
}

/// The main table's IPv4 routes now, or `None` when it cannot be read.
pub(crate) fn main_table(budget: &Budget) -> Option<Vec<Row>> {
    cmd::ip(&["-j", "-4", "route", "show", "table", "main"], budget).ok().map(|text| parse_rows(&text))
}

/// The host routes an engine added on the machine's own interfaces
/// between two readings of the main table: /32 routes that were not there
/// before, on an interface that is not ours, not carrying our protocol.
/// What OpenVPN's `redirect-gateway` puts on the uplink to reach its
/// server, which a killed OpenVPN never takes back -- the Windows
/// service's `HostRouteWatch`, on the Linux table.
pub(crate) fn new_host_routes(before: &[Row], after: &[Row]) -> Vec<RouteSpec> {
    let host = |r: &Row| r.dst.strip_suffix("/32").unwrap_or(&r.dst).parse::<Ipv4Addr>().ok();
    let same = |a: &Row, b: &Row| host(a) == host(b) && a.gateway == b.gateway && a.dev == b.dev;
    after
        .iter()
        .filter(|r| r.kind == "unicast" && host(r).is_some())
        .filter(|r| r.dev.as_deref().is_some_and(|d| !link::OURS.contains(&d)))
        .filter(|r| r.protocol.as_deref() != Some(ROUTE_PROTO))
        .filter(|r| !before.iter().any(|b| same(b, r)))
        .map(|r| RouteSpec {
            dest: format!("{}/32", host(r).unwrap_or(Ipv4Addr::UNSPECIFIED)),
            dev: r.dev.clone().unwrap_or_default(),
            via: r.gateway.clone(),
            table: None,
            v6: false,
        })
        .collect()
}

/// Whether the table already holds a host route to `dest` through
/// `uplink`, by any protocol.
pub(crate) fn has_host_route(rows: &[Row], dest: Ipv4Addr, uplink: &Uplink) -> bool {
    let via = uplink.via.map(|v| v.to_string());
    rows.iter().any(|r| {
        r.dst.strip_suffix("/32").unwrap_or(&r.dst).parse::<Ipv4Addr>().ok() == Some(dest)
            && r.dev.as_deref() == Some(uplink.dev.as_str())
            && r.gateway == via
    })
}

/// Whether the kernel holds this exact route now. A failed look says no:
/// it is used only to decide whether a failed add may be struck off, and
/// the sweep's protocol match catches anything that was wrongly struck.
fn route_present(spec: &RouteSpec) -> bool {
    let mut args = Vec::new();
    if spec.v6 {
        args.push("-6".to_string());
    }
    args.extend(["-j", "route", "show", "exact", &spec.dest, "dev", &spec.dev].map(String::from));
    if let Some(table) = spec.table {
        args.extend(["table".to_string(), table.to_string()]);
    }
    args.extend(["proto".to_string(), ROUTE_PROTO.to_string()]);
    run_ip(&args, &Budget::quick(cmd::TEARDOWN_CAP)).map(|text| !parse_rows(&text).is_empty()).unwrap_or(false)
}

/// Host routes an earlier session left to the servers the app knows,
/// which would otherwise send the next session's health check (or any
/// other traffic to that server) around the tunnel.
///
/// Narrow on purpose: a /32 in the main table to one of `nodes`, not on
/// one of our interfaces, and added by us or by a VPN client of the same
/// era (`proto 98`, `boot` -- what `ip route add` and OpenVPN write --
/// or `static`). Never one the kernel or DHCP made.
pub(crate) fn stale_node_routes(rows: &[Row], nodes: &[Ipv4Addr]) -> Vec<RouteSpec> {
    rows.iter()
        .filter(|r| {
            let host = r.dst.strip_suffix("/32").unwrap_or(&r.dst);
            let to_node = host.parse::<Ipv4Addr>().is_ok_and(|ip| nodes.contains(&ip));
            let by_us_or_a_vpn = matches!(r.protocol.as_deref(), Some("98" | "boot" | "static"));
            let foreign_dev = r.dev.as_deref().is_some_and(|d| !link::OURS.contains(&d));
            to_node && by_us_or_a_vpn && foreign_dev && r.kind == "unicast"
        })
        .map(|r| RouteSpec {
            dest: format!("{}/32", r.dst.strip_suffix("/32").unwrap_or(&r.dst)),
            dev: r.dev.clone().unwrap_or_default(),
            via: r.gateway.clone(),
            table: None,
            v6: false,
        })
        .collect()
}

/// Removes [`stale_node_routes`] for `known` (whatever in it is an IPv4
/// literal). Returns one line per route removed or refused.
pub(crate) fn purge_stale(known: &[String], budget: &Budget) -> Vec<String> {
    let nodes: Vec<Ipv4Addr> = known.iter().filter_map(|n| n.trim().parse().ok()).collect();
    if nodes.is_empty() {
        return Vec::new();
    }
    let Ok(text) = cmd::ip(&["-j", "-4", "route", "show", "table", "main"], budget) else { return Vec::new() };
    let mut lines = Vec::new();
    for spec in stale_node_routes(&parse_rows(&text), &nodes) {
        // Deleted without our protocol: the row may have been OpenVPN's.
        let mut args = vec!["route".to_string(), "del".to_string(), spec.dest.clone()];
        if let Some(via) = &spec.via {
            args.extend(["via".to_string(), via.clone()]);
        }
        args.extend(["dev".to_string(), spec.dev.clone()]);
        match run_ip(&args, budget) {
            Ok(_) => lines.push(format!("removed a leftover host route to {} on {}", spec.dest, spec.dev)),
            Err(e) if e.already_gone() => {}
            Err(e) => lines.push(format!("could not remove a leftover host route to {}: {e}", spec.dest)),
        }
    }
    lines
}

/// Every route in any table that carries our protocol, IPv4 and IPv6.
/// For the sweep: whatever the ledger lost, the kernel still marks.
pub(crate) fn sweep_ours(budget: &Budget) -> Vec<String> {
    let mut lines = Vec::new();
    for v6 in [false, true] {
        let family = if v6 { "-6" } else { "-4" };
        let Ok(text) = cmd::ip(&["-j", family, "route", "show", "table", "all", "proto", ROUTE_PROTO], budget) else {
            continue;
        };
        for row in parse_rows(&text) {
            let Some(dev) = row.dev.clone() else { continue };
            let table = row.table.as_deref().filter(|t| *t != "main").and_then(|t| t.parse().ok());
            let dest = if row.dst.contains('/') || row.dst == "default" {
                row.dst.clone()
            } else if v6 {
                format!("{}/128", row.dst)
            } else {
                format!("{}/32", row.dst)
            };
            let spec = RouteSpec { dest, dev, via: row.gateway.clone(), table, v6 };
            match run_ip(&spec.del_args(), budget) {
                Ok(_) => lines.push(format!("removed a leftover route to {} on {}", spec.dest, spec.dev)),
                Err(e) if e.already_gone() => {}
                Err(e) => lines.push(format!("could not remove a leftover route to {}: {e}", spec.dest)),
            }
        }
    }
    lines
}

/// Whether there is a way out toward `probe`, from the routing table
/// alone. `Ok(false)` only when the kernel answered and there is none;
/// a table that could not be read says nothing.
pub(crate) fn way_out_to(probe: Ipv4Addr) -> Result<bool, Stop> {
    let budget = Budget::quick(Duration::from_secs(3));
    match uplink_for(probe, &budget) {
        Ok(_) => Ok(true),
        Err(Problem::NoNetwork) => Ok(false),
        Err(Problem::Cancelled) => Err(Stop::Cancelled),
        Err(_) => Err(Stop::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from Ubuntu 24.04 (iproute2 6.1) in a VirtualBox guest on
    // NAT, with the documentation ranges substituted in.
    const ROUTE_GET: &str = r#"[{"dst":"203.0.113.5","gateway":"10.0.2.2","dev":"enp0s3","prefsrc":"10.0.2.15","flags":[],"uid":0,"cache":[]}]"#;
    const ROUTE_GET_ON_LINK: &str = r#"[{"dst":"10.0.2.3","dev":"enp0s3","prefsrc":"10.0.2.15","flags":[],"uid":0,"cache":[]}]"#;
    const ROUTE_GET_INTO_TUNNEL: &str = r#"[{"dst":"203.0.113.5","dev":"neoconnect0","prefsrc":"198.18.0.1","flags":[],"uid":0,"cache":[]}]"#;
    const DEFAULTS: &str = r#"[{"dst":"default","gateway":"192.0.2.1","dev":"wlp2s0","protocol":"dhcp","prefsrc":"192.0.2.40","metric":600,"flags":[]},{"dst":"default","gateway":"10.0.2.2","dev":"enp0s3","protocol":"dhcp","prefsrc":"10.0.2.15","metric":100,"flags":[]}]"#;
    const MAIN: &str = r#"[{"dst":"default","gateway":"10.0.2.2","dev":"enp0s3","protocol":"dhcp","prefsrc":"10.0.2.15","metric":100,"flags":[]},{"dst":"10.0.2.0/24","dev":"enp0s3","protocol":"kernel","scope":"link","prefsrc":"10.0.2.15","metric":100,"flags":[]},{"dst":"203.0.113.5","gateway":"10.0.2.2","dev":"enp0s3","protocol":"98","flags":[]},{"dst":"198.51.100.7","gateway":"10.0.2.2","dev":"enp0s3","protocol":"boot","flags":[]},{"dst":"198.51.100.8","gateway":"10.0.2.2","dev":"enp0s3","protocol":"dhcp","flags":[]},{"dst":"0.0.0.0/1","dev":"neoconnect0","protocol":"98","scope":"link","flags":[]},{"type":"blackhole","dst":"198.51.100.9","protocol":"boot","flags":[]}]"#;

    fn one(json: &str) -> Row {
        parse_rows(json).into_iter().next().unwrap()
    }

    #[test]
    fn the_kernels_answer_is_the_way_out() {
        let up = choose_uplink(Some(&one(ROUTE_GET)), &[]).unwrap();
        assert_eq!(up, Uplink { dev: "enp0s3".into(), via: Some(Ipv4Addr::new(10, 0, 2, 2)) });
    }

    #[test]
    fn an_on_link_answer_is_a_way_out_with_no_gateway() {
        let up = choose_uplink(Some(&one(ROUTE_GET_ON_LINK)), &[]).unwrap();
        assert_eq!(up, Uplink { dev: "enp0s3".into(), via: None });
    }

    #[test]
    fn our_own_tunnel_is_never_the_way_out() {
        let defaults = parse_rows(DEFAULTS);
        let up = choose_uplink(Some(&one(ROUTE_GET_INTO_TUNNEL)), &defaults).unwrap();
        assert_eq!(up.dev, "enp0s3", "the lowest-metric default that is not ours");
        assert_eq!(choose_uplink(Some(&one(ROUTE_GET_INTO_TUNNEL)), &[]), None, "nothing else: no network");
    }

    #[test]
    fn no_route_at_all_is_no_network() {
        assert_eq!(choose_uplink(None, &[]), None);
        let blackhole = parse_rows(r#"[{"type":"blackhole","dst":"default","flags":[]}]"#);
        assert_eq!(choose_uplink(None, &blackhole), None, "a blackhole is not a way out");
    }

    #[test]
    fn route_arguments_name_exactly_the_route_and_carry_our_protocol() {
        let host = RouteSpec::host(
            Ipv4Addr::new(203, 0, 113, 5),
            &Uplink { dev: "enp0s3".into(), via: Some(Ipv4Addr::new(10, 0, 2, 2)) },
        );
        assert_eq!(
            host.add_args(),
            ["route", "add", "203.0.113.5/32", "via", "10.0.2.2", "dev", "enp0s3", "proto", "98"]
        );
        assert_eq!(
            host.del_args(),
            ["route", "del", "203.0.113.5/32", "via", "10.0.2.2", "dev", "enp0s3", "proto", "98"]
        );
        let half = RouteSpec::into_link("0.0.0.0/1", "neoconnect0");
        assert_eq!(half.add_args(), ["route", "add", "0.0.0.0/1", "dev", "neoconnect0", "proto", "98"]);
        let wg = RouteSpec { dest: "::/0".into(), dev: "neoxify-wg".into(), via: None, table: Some(28280), v6: true };
        assert_eq!(wg.del_args(), ["-6", "route", "del", "::/0", "dev", "neoxify-wg", "table", "28280", "proto", "98"]);
    }

    #[test]
    fn only_our_and_vpn_host_routes_to_known_nodes_are_stale() {
        let rows = parse_rows(MAIN);
        let nodes = [
            Ipv4Addr::new(203, 0, 113, 5),
            Ipv4Addr::new(198, 51, 100, 7),
            Ipv4Addr::new(198, 51, 100, 8),
            Ipv4Addr::new(198, 51, 100, 9),
        ];
        let stale: Vec<String> = stale_node_routes(&rows, &nodes).into_iter().map(|s| s.dest).collect();
        assert_eq!(stale, ["203.0.113.5/32", "198.51.100.7/32"], "never DHCP's, never a blackhole");
        assert!(stale_node_routes(&rows, &[Ipv4Addr::new(192, 0, 2, 99)]).is_empty(), "never an unknown address");
    }

    #[test]
    fn rows_parse_with_numeric_protocols_and_tables() {
        let rows = parse_rows(r#"[{"dst":"default","dev":"neoxify-wg","table":"28280","protocol":"98","flags":[]},{"dst":"default","dev":"x","table":28280,"protocol":98,"flags":[]}]"#);
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.table.as_deref(), Some("28280"));
            assert_eq!(row.protocol.as_deref(), Some("98"));
        }
    }

    #[test]
    fn a_literal_resolves_without_a_lookup() {
        let budget = Budget::quick(Duration::from_millis(1));
        assert_eq!(resolve_ipv4("203.0.113.5", 443, &budget), Ok(Ipv4Addr::new(203, 0, 113, 5)));
    }
}
