//! The local network, as the machine's own interfaces are on it. The rules
//! are Windows' (`confinement.rs`, `lan_prefixes`): up, not ours, not
//! another VPN's, private (RFC 1918), each prefix once, and a prefix wider
//! than /16 narrowed to the /24 around the address, because a /8 on-link
//! is a misconfiguration that would otherwise hand a large slice of
//! addresses a way around the tunnel.

use crate::script::normalise;
use crate::Cidr4;
use serde_json::Value;
use std::net::Ipv4Addr;

const WIDEST_LAN: u8 = 16;

/// Name prefixes of other VPNs' interfaces whose link type does not give
/// them away: a TAP device is plain Ethernet to the kernel. Windows reads
/// the driver description for the same reason.
const VPN_NAME_PREFIXES: [&str; 7] = ["tun", "tap", "wg", "tailscale", "zt", "nordlynx", "proton"];

fn is_rfc1918(addr: Ipv4Addr) -> bool {
    let o = addr.octets();
    o[0] == 10 || (o[0] == 172 && (16..32).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// The prefixes in the output of `ip -j -4 addr show up`.
pub(crate) fn parse(json: &str, exclude: &[&str]) -> Vec<Cidr4> {
    let mut lan = Vec::new();
    let Ok(Value::Array(links)) = serde_json::from_str::<Value>(json) else { return lan };
    for link in &links {
        let name = link.get("ifname").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || exclude.contains(&name) {
            continue;
        }
        // "none" is a layer-3 device: tun, WireGuard, another VPN.
        let link_type = link.get("link_type").and_then(Value::as_str).unwrap_or("");
        if matches!(link_type, "loopback" | "none") {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if VPN_NAME_PREFIXES.iter().any(|p| lower.starts_with(p)) {
            continue;
        }
        let flags = link.get("flags").and_then(Value::as_array);
        if let Some(flags) = flags {
            if !flags.iter().any(|f| f.as_str() == Some("UP")) {
                continue;
            }
        }
        let Some(addrs) = link.get("addr_info").and_then(Value::as_array) else { continue };
        for a in addrs {
            if a.get("family").and_then(Value::as_str) != Some("inet") {
                continue;
            }
            let Some(addr) = a.get("local").and_then(Value::as_str).and_then(|s| s.parse::<Ipv4Addr>().ok()) else {
                continue;
            };
            let Some(len) = a.get("prefixlen").and_then(Value::as_u64).filter(|l| *l <= 32) else { continue };
            if !is_rfc1918(addr) {
                continue;
            }
            let len = len as u8;
            let prefix = normalise(Cidr4 { addr, prefix: if len < WIDEST_LAN { 24 } else { len } });
            if !lan.contains(&prefix) {
                lan.push(prefix);
            }
        }
    }
    lan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(a: [u8; 4], p: u8) -> Cidr4 {
        Cidr4 { addr: Ipv4Addr::from(a), prefix: p }
    }

    #[test]
    fn keeps_private_on_link_drops_public_ours_vpns_and_down() {
        let json = r#"[
          {"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP","LOWER_UP"],"link_type":"loopback",
           "addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8}]},
          {"ifindex":2,"ifname":"enp0s3","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"192.168.1.23","prefixlen":24}]},
          {"ifindex":3,"ifname":"wlp2s0","flags":["BROADCAST","MULTICAST","UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"192.168.1.40","prefixlen":24},
                        {"family":"inet","local":"10.20.30.40","prefixlen":8}]},
          {"ifindex":4,"ifname":"docker0","flags":["UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"172.17.0.1","prefixlen":16}]},
          {"ifindex":5,"ifname":"neoconnect0","flags":["UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"10.8.0.6","prefixlen":24}]},
          {"ifindex":6,"ifname":"mytun","flags":["POINTOPOINT","UP"],"link_type":"none",
           "addr_info":[{"family":"inet","local":"10.9.0.2","prefixlen":24}]},
          {"ifindex":7,"ifname":"tap0","flags":["UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"10.10.0.2","prefixlen":24}]},
          {"ifindex":8,"ifname":"wwan0","flags":["UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"100.70.1.2","prefixlen":10},
                        {"family":"inet","local":"198.51.100.9","prefixlen":24}]},
          {"ifindex":9,"ifname":"eth9","flags":["BROADCAST"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"10.0.0.5","prefixlen":24}]},
          {"ifindex":10,"ifname":"eth10","flags":["UP"],"link_type":"ether",
           "addr_info":[{"family":"inet","local":"169.254.10.1","prefixlen":16},
                        {"family":"inet6","local":"fe80::1","prefixlen":64}]}
        ]"#;
        assert_eq!(
            parse(json, &["neoconnect0"]),
            vec![c([192, 168, 1, 0], 24), c([10, 20, 30, 0], 24), c([172, 17, 0, 0], 16)]
        );
    }

    #[test]
    fn garbage_names_no_lan() {
        assert!(parse("", &[]).is_empty());
        assert!(parse("{}", &[]).is_empty());
        assert!(parse(r#"[{"ifname":"eth0","addr_info":[{"family":"inet","local":"10.0.0.1"}]}]"#, &[]).is_empty());
    }
}
