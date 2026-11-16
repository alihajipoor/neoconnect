//! Network interfaces, read from `/sys/class/net` and changed with `ip`.

use std::path::PathBuf;

use crate::cmd::{self, Budget, IpError};

/// Every interface name this client ever makes. Nothing else is ours to
/// delete, and none of these may be taken as the way out.
pub const OURS: [&str; 3] = [XRAY_LINK, WG_LINK, OVPN_LINK];

/// The Xray tun inbound's interface, named as on Windows so the shared
/// interface's assumptions hold.
pub const XRAY_LINK: &str = "neoconnect0";
pub const WG_LINK: &str = "neoxify-wg";
pub const OVPN_LINK: &str = "neoxify-ovpn";

/// `IFF_UP` in the interface's flags.
const IFF_UP: u32 = 0x1;

fn sys(name: &str) -> PathBuf {
    PathBuf::from("/sys/class/net").join(name)
}

/// A name the kernel would accept and that cannot climb out of sysfs.
fn plausible(name: &str) -> bool {
    !name.is_empty() && name.len() < 16 && !name.contains('/') && name != "." && name != ".."
}

pub fn exists(name: &str) -> bool {
    plausible(name) && sys(name).exists()
}

/// Whether the kernel shows the interface administratively up. `None`
/// when that cannot be read.
pub fn is_up(name: &str) -> Option<bool> {
    if !plausible(name) {
        return None;
    }
    let text = std::fs::read_to_string(sys(name).join("flags")).ok()?;
    let flags = u32::from_str_radix(text.trim().trim_start_matches("0x"), 16).ok()?;
    Some(flags & IFF_UP != 0)
}

/// Bytes received and sent, as the kernel counts them.
pub fn counters(name: &str) -> Option<(u64, u64)> {
    if !plausible(name) {
        return None;
    }
    let read = |what: &str| -> Option<u64> {
        std::fs::read_to_string(sys(name).join("statistics").join(what)).ok()?.trim().parse().ok()
    };
    Some((read("rx_bytes")?, read("tx_bytes")?))
}

/// Deletes the interface. One that is not there is not an error.
pub fn delete(name: &str, budget: &Budget) -> Result<(), IpError> {
    if !exists(name) {
        return Ok(());
    }
    match cmd::ip(&["link", "del", "dev", name], budget) {
        Ok(_) => Ok(()),
        Err(e) if e.already_gone() || !exists(name) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Gives the interface its address (replacing nothing else on it: the
/// address is set with `replace`, which is a no-op when it is held
/// already) and brings it up.
pub fn address_and_up(name: &str, cidr: &str, budget: &Budget) -> Result<(), IpError> {
    cmd::ip(&["addr", "replace", cidr, "dev", name], budget)?;
    cmd::ip(&["link", "set", "dev", name, "up"], budget)?;
    Ok(())
}

/// The IPv4 addresses on an interface, read back from the kernel.
pub fn ipv4_addresses(name: &str, budget: &Budget) -> Vec<String> {
    let Ok(text) = cmd::ip(&["-j", "-4", "addr", "show", "dev", name], budget) else { return Vec::new() };
    parse_addresses(&text)
}

pub(crate) fn parse_addresses(json: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(links)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    links
        .iter()
        .flat_map(|l| l["addr_info"].as_array().cloned().unwrap_or_default())
        .filter_map(|a| Some(format!("{}/{}", a["local"].as_str()?, a["prefixlen"].as_u64()?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_could_leave_sysfs_are_never_read() {
        assert!(!exists("../../etc"));
        assert!(!exists(""));
        assert!(counters("a/b").is_none());
        assert!(OURS.iter().all(|n| plausible(n)));
    }

    #[test]
    fn reads_addresses_from_ip_json() {
        // `ip -j -4 addr show dev neoconnect0`, captured on Ubuntu 24.04.
        let json = r#"[{"ifindex":5,"ifname":"neoconnect0","flags":["POINTOPOINT","MULTICAST","NOARP","UP","LOWER_UP"],"mtu":1500,"qdisc":"fq_codel","operstate":"UNKNOWN","group":"default","txqlen":500,"link_type":"none","addr_info":[{"family":"inet","local":"198.18.0.1","prefixlen":30,"scope":"global","label":"neoconnect0","valid_life_time":4294967295,"preferred_life_time":4294967295}]}]"#;
        assert_eq!(parse_addresses(json), vec!["198.18.0.1/30".to_string()]);
        assert!(parse_addresses("[]").is_empty());
        assert!(parse_addresses("garbage").is_empty());
    }
}
