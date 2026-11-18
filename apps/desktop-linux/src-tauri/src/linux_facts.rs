//! `device_facts` on Linux: what the machine and its network are, for a
//! connect report's `details` (device_facts.rs has the shape,
//! docs/client-diagnostics.md the fields).
//!
//! All of it is read from files -- /etc/os-release, DMI in sysfs,
//! /proc/meminfo, the kernel's route and address tables, resolv.conf --
//! each on its own and left out when it cannot be read. Nothing here runs
//! a program or asks the helper. The whole answer is still held to a
//! second (`FACTS_TIME_LIMIT`), after which only `os` is sent.
//!
//! What is never read or never leaves: the host name, interface names
//! (read here only to tell tunnels from the network beneath them), Wi-Fi
//! names, hardware addresses. The model comes from DMI's vendor and
//! product strings, which name the hardware, never its owner.
//!
//! Not reported on Linux: `lowPower` and `dataSaver` (no setting every
//! distribution shares), `metered` (only NetworkManager knows, over D-Bus),
//! `otherVpn` (the helper's diagnostics hold that), and `net.dns` while a
//! tunnel of ours is up: the helper has then pointed the machine's
//! resolver configuration at the tunnel, and what is left cannot be told
//! apart from the tunnel's own resolver.

use std::net::{IpAddr, Ipv6Addr};
use std::path::Path;
use std::time::Duration;

use crate::device_facts::{bounded_text, dns_list, model_of, DeviceFacts, NetFacts};

/// The whole answer's limit. The contract asks for about a second.
const FACTS_TIME_LIMIT: Duration = Duration::from_millis(900);

const OS_RELEASE: &str = "/etc/os-release";
const OS_RELEASE_FALLBACK: &str = "/usr/lib/os-release";
const DMI_VENDOR: &str = "/sys/class/dmi/id/sys_vendor";
const DMI_PRODUCT: &str = "/sys/class/dmi/id/product_name";
const MEMINFO: &str = "/proc/meminfo";
const ROUTE_V4: &str = "/proc/net/route";
const ROUTE_V6: &str = "/proc/net/ipv6_route";
const ADDRESSES_V6: &str = "/proc/net/if_inet6";
const SYS_NET: &str = "/sys/class/net";
const RESOLV_CONF: &str = "/etc/resolv.conf";
/// systemd-resolved's list of the upstream servers behind its stub.
const RESOLVED_UPSTREAMS: &str = "/run/systemd/resolve/resolv.conf";

/// The first line of what the helper writes over /etc/resolv.conf while
/// connected (`our_resolv_conf_for` in tunnel/src/dns.rs).
const OUR_RESOLV_CONF_MARK: &str = "Written by Neoxify while connected";

#[tauri::command]
pub async fn device_facts() -> DeviceFacts {
    let read = tauri::async_runtime::spawn_blocking(read_facts);
    match tokio::time::timeout(FACTS_TIME_LIMIT, read).await {
        Ok(Ok(facts)) => facts.sanitized(),
        // Too slow, or the read panicked: what is certain without it.
        _ => DeviceFacts { os: Some("Linux".into()), ..Default::default() },
    }
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn read_facts() -> DeviceFacts {
    DeviceFacts {
        model: model_of(read(DMI_VENDOR), read(DMI_PRODUCT)),
        os: Some("Linux".into()),
        os_version: read(OS_RELEASE).or_else(|| read(OS_RELEASE_FALLBACK)).and_then(|text| os_version(&text)),
        low_power: None,
        data_saver: None,
        mem_free_mb: read(MEMINFO).and_then(|text| mem_available_mb(&text)),
        net: network(),
    }
}

// ---- The machine ---------------------------------------------------------

/// "Ubuntu 24.04": os-release's NAME (or ID when there is no NAME), then
/// VERSION_ID when there is one -- a rolling release has none.
pub fn os_version(os_release: &str) -> Option<String> {
    let name = os_release_value(os_release, "NAME")
        .filter(|n| !n.trim().is_empty())
        .or_else(|| os_release_value(os_release, "ID"))
        .filter(|n| !n.trim().is_empty())?;
    let joined = match os_release_value(os_release, "VERSION_ID").filter(|v| !v.trim().is_empty()) {
        Some(version) => format!("{} {}", name.trim(), version.trim()),
        None => name,
    };
    bounded_text(Some(joined), crate::device_facts::OS_VERSION_MAX)
}

/// One `KEY=value` of os-release, unquoted as the shell would: double or
/// single quotes around the value, a backslash before a quote, `$`, a
/// backquote or a backslash.
pub fn os_release_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.trim().split_once('=')?;
        (k.trim() == key).then(|| unquote(v.trim()))
    })
}

fn unquote(value: &str) -> String {
    let quoted = value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')));
    let inner = if quoted { &value[1..value.len() - 1] } else { value };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// `MemAvailable` of /proc/meminfo, in MB: what can be had without
/// swapping, the same measure as Windows' available physical memory.
pub fn mem_available_mb(meminfo: &str) -> Option<u64> {
    meminfo.lines().find_map(|line| {
        let rest = line.strip_prefix("MemAvailable:")?;
        let mut words = rest.split_whitespace();
        let amount: u64 = words.next()?.parse().ok()?;
        match words.next() {
            Some("kB") | None => Some(amount / 1024),
            _ => None,
        }
    })
}

// ---- The network ---------------------------------------------------------

/// A default route as the decision needs it. The interface name is read
/// only to tell tunnels apart and to find the interface's own files; it
/// never leaves this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultRoute {
    pub iface: String,
    pub metric: u32,
}

/// `RTF_UP` and `RTF_REJECT` in a route's flags.
const RTF_UP: u32 = 0x0001;
const RTF_REJECT: u32 = 0x0200;

/// The IPv4 default routes in /proc/net/route (the main table): hex
/// destination and mask both zero, up, not a reject route.
pub fn ipv4_defaults(route: &str) -> Vec<DefaultRoute> {
    route
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 8 || fields[0] == "Iface" || fields[0] == "*" {
                return None;
            }
            let dest = u32::from_str_radix(fields[1], 16).ok()?;
            let flags = u32::from_str_radix(fields[3], 16).ok()?;
            let metric: u32 = fields[6].parse().ok()?;
            let mask = u32::from_str_radix(fields[7], 16).ok()?;
            let default = dest == 0 && mask == 0 && flags & RTF_UP != 0 && flags & RTF_REJECT == 0;
            default.then(|| DefaultRoute { iface: fields[0].to_string(), metric })
        })
        .collect()
}

/// The IPv6 default routes in /proc/net/ipv6_route: `::/0`, up, not a
/// reject route and not on loopback (where the kernel keeps its
/// unreachable entries).
pub fn ipv6_defaults(route: &str) -> Vec<DefaultRoute> {
    route
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 {
                return None;
            }
            let all_zero = fields[0].len() == 32 && fields[0].bytes().all(|b| b == b'0');
            let prefix = u32::from_str_radix(fields[1], 16).ok()?;
            let metric = u32::from_str_radix(fields[5], 16).ok()?;
            let flags = u32::from_str_radix(fields[8], 16).ok()?;
            let iface = fields[9];
            let default =
                all_zero && prefix == 0 && flags & RTF_UP != 0 && flags & RTF_REJECT == 0 && iface != "lo";
            default.then(|| DefaultRoute { iface: iface.to_string(), metric })
        })
        .collect()
}

/// A tunnel, never the network beneath it: ours -- the Xray tun
/// `neoconnect0`, `neoxify-wg`, `neoxify-ovpn` (tunnel/src/link.rs) and
/// strongSwan's `ipsec%d` for IKEv2 (tunnel/src/ikev2.rs) -- and the
/// names other VPNs and point-to-point links commonly take.
pub fn is_tunnel(iface: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "neoconnect", "neoxify", "ipsec", "tun", "tap", "wg", "ppp", "vti", "tailscale", "nordlynx", "zt",
    ];
    PREFIXES.iter().any(|p| iface.starts_with(p))
}

/// The tunnels of ours, by name, whose presence means the helper has
/// pointed the machine's DNS at a tunnel.
fn is_ours(iface: &str) -> bool {
    iface.starts_with("neoconnect") || iface.starts_with("neoxify") || iface.starts_with("ipsec")
}

/// The network the tunnel rides on: the non-tunnel interface holding the
/// IPv4 default route with the lowest metric, or failing that the IPv6
/// one. `Err` is the contract's word when there is none: "none" when there
/// is no default route at all, "unknown" when only tunnels hold one.
pub fn uplink<'a>(v4: &'a [DefaultRoute], v6: &'a [DefaultRoute]) -> Result<&'a str, &'static str> {
    let best = |routes: &'a [DefaultRoute]| {
        routes.iter().filter(|r| !is_tunnel(&r.iface)).min_by_key(|r| r.metric).map(|r| r.iface.as_str())
    };
    match best(v4).or_else(|| best(v6)) {
        Some(iface) => Ok(iface),
        None if v4.is_empty() && v6.is_empty() => Err("none"),
        None => Err("unknown"),
    }
}

/// What the contract calls the interface's type. `wireless` is whether
/// sysfs has a `wireless` (or `phy80211`) entry for it, `arp_type` the
/// text of its `type` file (1 is Ethernet).
pub fn net_kind(iface: &str, wireless: bool, arp_type: Option<&str>) -> &'static str {
    if wireless {
        "wifi"
    } else if iface.starts_with("wwan") {
        "cellular"
    } else if arp_type.map(str::trim) == Some("1") {
        "ethernet"
    } else {
        "other"
    }
}

/// `IFA_F_DADFAILED` and `IFA_F_TENTATIVE`: an address not usable yet.
const IFA_F_DADFAILED: u32 = 0x08;
const IFA_F_TENTATIVE: u32 = 0x40;

/// Whether /proc/net/if_inet6 gives `iface` a usable global IPv6 address:
/// global scope, in 2000::/3 (not a ULA), not tentative or failed.
pub fn has_global_v6(if_inet6: &str, iface: &str) -> bool {
    if_inet6.lines().any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 || fields[5] != iface {
            return false;
        }
        let (Some(addr), Ok(scope), Ok(flags)) =
            (hex_v6(fields[0]), u32::from_str_radix(fields[3], 16), u32::from_str_radix(fields[4], 16))
        else {
            return false;
        };
        scope == 0 && addr.segments()[0] & 0xe000 == 0x2000 && flags & (IFA_F_DADFAILED | IFA_F_TENTATIVE) == 0
    })
}

fn hex_v6(hex: &str) -> Option<Ipv6Addr> {
    if hex.len() != 32 {
        return None;
    }
    u128::from_str_radix(hex, 16).ok().map(Ipv6Addr::from)
}

/// The `nameserver` addresses of a resolv.conf, in order.
pub fn nameservers(resolv_conf: &str) -> Vec<String> {
    resolv_conf
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("nameserver")).then(|| words.next()).flatten().map(str::to_string)
        })
        .collect()
}

/// The machine's own upstream resolvers. When /etc/resolv.conf sends
/// lookups to systemd-resolved's stub, the upstreams are in resolved's
/// own list (`resolved`); otherwise /etc/resolv.conf names them. Loopback
/// is dropped (a local cache says nothing about the network), then the
/// shared filter: IP literals, no hardware-derived IPv6, at most four.
/// Nothing when the file is the one the helper writes while connected.
pub fn resolvers(etc: &str, resolved: Option<&str>) -> Vec<String> {
    if etc.contains(OUR_RESOLV_CONF_MARK) {
        return Vec::new();
    }
    let own = nameservers(etc);
    let stub = own.iter().any(|s| s == "127.0.0.53" || s == "127.0.0.54");
    let listed = if stub { resolved.map(nameservers).unwrap_or_default() } else { own };
    let not_loopback: Vec<String> = listed
        .into_iter()
        .filter(|s| !s.split('%').next().unwrap_or("").parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()))
        .collect();
    dns_list(&not_loopback)
}

/// A name that cannot climb out of /sys/class/net.
fn plausible(iface: &str) -> bool {
    !iface.is_empty() && iface.len() < 16 && !iface.contains('/') && iface != "." && iface != ".."
}

/// Whether a tunnel of ours is up: an interface by one of our names.
fn our_tunnel_present() -> bool {
    match std::fs::read_dir(SYS_NET) {
        Ok(entries) => entries.flatten().any(|e| is_ours(&e.file_name().to_string_lossy())),
        // Not knowing is treated as up: the resolvers are then left out.
        Err(_) => true,
    }
}

/// `net`, or nothing when the IPv4 route table could not be read.
fn network() -> Option<NetFacts> {
    let v4 = ipv4_defaults(&read(ROUTE_V4)?);
    // No ipv6_route at all is a kernel without IPv6.
    let v6 = read(ROUTE_V6).map(|text| ipv6_defaults(&text)).unwrap_or_default();
    let iface = match uplink(&v4, &v6) {
        Ok(iface) if plausible(iface) => iface,
        Ok(_) => return Some(NetFacts { kind: Some("unknown".into()), ..Default::default() }),
        Err(word) => return Some(NetFacts { kind: Some(word.into()), ..Default::default() }),
    };
    let dir = Path::new(SYS_NET).join(iface);
    let wireless = dir.join("wireless").exists() || dir.join("phy80211").exists();
    let arp_type = std::fs::read_to_string(dir.join("type")).ok();
    let ipv6 = v6.iter().any(|r| r.iface == iface)
        && read(ADDRESSES_V6).is_some_and(|text| has_global_v6(&text, iface));
    let dns = if our_tunnel_present() {
        Vec::new()
    } else {
        read(RESOLV_CONF).map(|etc| resolvers(&etc, read(RESOLVED_UPSTREAMS).as_deref())).unwrap_or_default()
    };
    Some(NetFacts {
        kind: Some(net_kind(iface, wireless, arp_type.as_deref()).into()),
        ipv4: Some(v4.iter().any(|r| r.iface == iface)),
        ipv6: Some(ipv6),
        dns: (!dns.is_empty()).then_some(dns),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_release_names_the_distribution_and_version() {
        let ubuntu = "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\n";
        assert_eq!(os_version(ubuntu).as_deref(), Some("Ubuntu 24.04"));
        let fedora = "NAME='Fedora Linux'\nVERSION_ID=40\nID=fedora\n";
        assert_eq!(os_version(fedora).as_deref(), Some("Fedora Linux 40"));
        // A rolling release has no VERSION_ID.
        let arch = "NAME=\"Arch Linux\"\nID=arch\nBUILD_ID=rolling\n";
        assert_eq!(os_version(arch).as_deref(), Some("Arch Linux"));
        // ID when there is no NAME; comments and blank lines ignored.
        let bare = "# a comment\n\nID=debian\nVERSION_ID=\"12\"\n";
        assert_eq!(os_version(bare).as_deref(), Some("debian 12"));
        let escaped = "NAME=\"Some \\\"Quoted\\\" OS\"\n";
        assert_eq!(os_version(escaped).as_deref(), Some("Some \"Quoted\" OS"));
        assert_eq!(os_version("VERSION_ID=1\n"), None);
        assert_eq!(os_version(""), None);
    }

    #[test]
    fn free_memory_from_mem_available() {
        let meminfo = "MemTotal:       16303428 kB\nMemFree:          912344 kB\nMemAvailable:    8388608 kB\n";
        assert_eq!(mem_available_mb(meminfo), Some(8192));
        assert_eq!(mem_available_mb("MemTotal: 1 kB\n"), None);
    }

    /// DMI placeholders are not a model.
    #[test]
    fn dmi_placeholders_are_dropped() {
        let s = |t: &str| Some(t.to_owned());
        assert_eq!(model_of(s("To Be Filled By O.E.M.\n"), s("To Be Filled By O.E.M.\n")), None);
        assert_eq!(model_of(s("System manufacturer\n"), s("System Product Name\n")), None);
        assert_eq!(model_of(s("Default string\n"), s("Default string\n")), None);
        assert_eq!(model_of(s("Default string\n"), s("Example Board X1\n")), s("Example Board X1"));
        assert_eq!(model_of(s("ExampleCorp\n"), s("Laptop 14\n")), s("ExampleCorp Laptop 14"));
    }

    const ROUTE_HEADER: &str =
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n";

    /// Our tunnel holds a default with the lowest metric; the physical
    /// default beneath it is the uplink.
    #[test]
    fn the_uplink_is_never_a_tunnel() {
        let route = format!(
            "{ROUTE_HEADER}\
             neoconnect0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0\n\
             wlp2s0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0\n\
             enp3s0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
             enp3s0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n\
             *\t00000000\t00000000\t0201\t0\t0\t0\t00000000\t0\t0\t0\n"
        );
        let v4 = ipv4_defaults(&route);
        assert_eq!(v4.len(), 3);
        assert_eq!(uplink(&v4, &[]), Ok("enp3s0"));
        // With only the tunnel's default, nothing can be named.
        let only_tunnel: Vec<DefaultRoute> = v4.iter().filter(|r| is_tunnel(&r.iface)).cloned().collect();
        assert_eq!(uplink(&only_tunnel, &[]), Err("unknown"));
        for name in ["neoxify-wg", "neoxify-ovpn", "ipsec0", "tun0", "wg0", "ppp0", "tap1"] {
            assert!(is_tunnel(name), "{name}");
        }
        assert!(!is_tunnel("eth0"));
    }

    #[test]
    fn no_default_route_is_none() {
        let route = format!("{ROUTE_HEADER}enp3s0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n");
        let v4 = ipv4_defaults(&route);
        assert!(v4.is_empty());
        assert_eq!(uplink(&v4, &[]), Err("none"));
    }

    /// The kernel's unreachable ::/0 on loopback is not a way out; an
    /// IPv6-only uplink is found by its own default.
    #[test]
    fn ipv6_defaults_skip_loopback_rejects() {
        let zero = "00000000000000000000000000000000";
        let gateway = "fe800000000000000000000000000001";
        let table = format!(
            "{zero} 00 {zero} 00 {zero} ffffffff 00000001 00000000 00200200 lo\n\
             {zero} 00 {zero} 00 {gateway} 00000400 00000001 00000000 00450003 eth0\n\
             20010db8000000000000000000000000 40 {zero} 00 {zero} 00000100 00000001 00000000 00000001 eth0\n"
        );
        let v6 = ipv6_defaults(&table);
        assert_eq!(v6, [DefaultRoute { iface: "eth0".into(), metric: 0x400 }]);
        assert_eq!(uplink(&[], &v6), Ok("eth0"));
    }

    #[test]
    fn global_ipv6_from_if_inet6() {
        let text = "fe800000000000000000000000000001 02 40 20 80 eth0\n\
                    fd000000000000000000000000000001 02 40 00 80 eth0\n\
                    20010db8000000000000000000000001 03 40 00 80 wlan0\n\
                    20010db8000000000000000000000002 02 40 00 c0 eth1\n\
                    00000000000000000000000000000001 01 80 10 80 lo\n";
        // eth0 has only link-local and a ULA.
        assert!(!has_global_v6(text, "eth0"));
        assert!(has_global_v6(text, "wlan0"));
        // Tentative: not usable yet.
        assert!(!has_global_v6(text, "eth1"));
        assert!(!has_global_v6(text, "lo"));
    }

    #[test]
    fn interface_types() {
        assert_eq!(net_kind("wlp2s0", true, Some("1\n")), "wifi");
        assert_eq!(net_kind("enp3s0", false, Some("1\n")), "ethernet");
        assert_eq!(net_kind("wwan0", false, Some("1\n")), "cellular");
        assert_eq!(net_kind("wwan0", false, Some("65534\n")), "cellular");
        assert_eq!(net_kind("ib0", false, Some("32\n")), "other");
        assert_eq!(net_kind("x0", false, None), "other");
    }

    /// The stub's address sends the read to resolved's upstream list;
    /// comments, loopback and a router's link-local entry are dropped.
    #[test]
    fn resolvers_behind_the_stub() {
        let etc = "# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch example.com\n";
        let upstreams = "# This is /run/systemd/resolve/resolv.conf\n\
                         nameserver 192.0.2.1\n\
                         nameserver fe80::1%wlp2s0\n\
                         ; nameserver 192.0.2.99\n\
                         nameserver 2001:db8::53\n";
        assert_eq!(resolvers(etc, Some(upstreams)), ["192.0.2.1", "2001:db8::53"]);
        // The stub with no upstream list: nothing, never the stub itself.
        assert!(resolvers(etc, None).is_empty());
    }

    #[test]
    fn resolvers_from_a_plain_resolv_conf() {
        let etc = "# Generated by NetworkManager\nsearch example.com\nnameserver 198.51.100.7\nnameserver 127.0.0.1\nnameserver ::1\n#nameserver 192.0.2.5\nnameserver 198.51.100.8\n";
        assert_eq!(resolvers(etc, Some("nameserver 192.0.2.250\n")), ["198.51.100.7", "198.51.100.8"]);
        let five = "nameserver 192.0.2.1\nnameserver 192.0.2.2\nnameserver 192.0.2.3\nnameserver 192.0.2.4\nnameserver 192.0.2.5\n";
        assert_eq!(resolvers(five, None).len(), 4);
    }

    /// What the helper writes while connected names the tunnel's resolver,
    /// not the machine's: nothing is reported from it.
    #[test]
    fn never_the_tunnels_resolver() {
        let ours = "# Written by Neoxify while connected; put back when it disconnects.\nnameserver 1.1.1.1\n";
        assert!(resolvers(ours, None).is_empty());
        assert!(is_ours("neoconnect0") && is_ours("neoxify-wg") && is_ours("ipsec0"));
        assert!(!is_ours("eth0"));
    }
}
