//! What the device and its network are, for a connect report's `details`
//! (docs/client-diagnostics.md, `details.device` and `details.net`).
//!
//! The one shape every platform answers `device_facts` with. Compiled into
//! the Windows app, and into the mobile VPN plugin by path, which reads the
//! Kotlin and Swift answers through `DeviceFacts::from_value` -- so a phone
//! and a PC cannot put the same fact on the wire two ways.
//!
//! Every field is optional and left out when the platform cannot tell. A
//! field is never guessed: an unknown network type is left out, not
//! "wifi". And nothing here names a place the customer went: the only
//! addresses are the device's own DNS server settings, and the only name
//! is Android's Private DNS host, which is a setting too.

use serde::Serialize;
use serde_json::Value;

/// The answer to `device_facts`. Serialized camelCase, `None` left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFacts {
    /// Manufacturer and model, e.g. "samsung SM-S918B" or "iPhone16,2".
    /// Never a host or computer name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// "Android", "iOS", "Windows" or "Linux".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// e.g. "14", "18.1", "11 26100.2314".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    /// Battery saver, Low Power Mode, power save mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_power: Option<bool>,
    /// Android's Data Saver, iOS's Low Data Mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_saver: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_free_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net: Option<NetFacts>,
}

/// The network the tunnel rides on -- never the tunnel's own interface.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetFacts {
    /// "wifi", "cellular", "ethernet", "other", "none" or "unknown".
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<bool>,
    /// Another app's VPN is up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_vpn: Option<bool>,
    /// The underlying network's resolvers: IP literals only, at most four.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns: Option<Vec<String>>,
    /// "off", "auto", "host" or "unknown" (Android's Private DNS).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_dns: Option<String>,
    /// The Private DNS host the customer typed into their settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_dns_host: Option<String>,
}

/// The server's bounds (`details.device`, `details.net` in the doc).
pub const MODEL_MAX: usize = 64;
pub const OS_VERSION_MAX: usize = 48;
pub const MEM_FREE_MB_MAX: u64 = 1_048_576;
pub const DNS_MAX: usize = 4;
pub const PRIVATE_DNS_HOST_MAX: usize = 128;

const OSES: &[&str] = &["Android", "iOS", "Windows", "Linux"];
const NET_TYPES: &[&str] = &["wifi", "cellular", "ethernet", "other", "none", "unknown"];
const PRIVATE_DNS_MODES: &[&str] = &["off", "auto", "host", "unknown"];

impl DeviceFacts {
    /// A platform plugin's answer, read field by field: a field of the
    /// wrong type is dropped on its own, and does not take the rest with
    /// it the way a derived `Deserialize` would. Anything not in the shape
    /// is ignored. Sanitized on the way out. The phones' reader: the
    /// Windows app builds its answer directly.
    #[allow(dead_code)]
    pub fn from_value(value: Value) -> DeviceFacts {
        let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |v: &Value, key: &str| v.get(key).and_then(Value::as_bool);
        let net = value.get("net").filter(|n| n.is_object()).map(|n| NetFacts {
            kind: text(n, "type"),
            metered: flag(n, "metered"),
            ipv4: flag(n, "ipv4"),
            ipv6: flag(n, "ipv6"),
            other_vpn: flag(n, "otherVpn"),
            dns: n
                .get("dns")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
            private_dns: text(n, "privateDns"),
            private_dns_host: text(n, "privateDnsHost"),
        });
        DeviceFacts {
            model: text(&value, "model"),
            os: text(&value, "os"),
            os_version: text(&value, "osVersion"),
            low_power: flag(&value, "lowPower"),
            data_saver: flag(&value, "dataSaver"),
            // A whole number, or a float with nothing after the point
            // (a JavaScript-style number from a bridge that has only one).
            mem_free_mb: value.get("memFreeMb").and_then(|m| {
                m.as_u64().or_else(|| m.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0).map(|f| f as u64))
            }),
            net,
        }
        .sanitized()
    }

    /// Held to the server's bounds, so nothing the server would reject --
    /// and so lose the whole report with it -- leaves the device. Strings
    /// are trimmed and cut to length, closed sets keep only their members,
    /// `dns` keeps IP literals only.
    pub fn sanitized(self) -> DeviceFacts {
        DeviceFacts {
            model: bounded_text(self.model, MODEL_MAX),
            os: self.os.filter(|os| OSES.contains(&os.as_str())),
            os_version: bounded_text(self.os_version, OS_VERSION_MAX),
            low_power: self.low_power,
            data_saver: self.data_saver,
            mem_free_mb: self.mem_free_mb.map(|mb| mb.min(MEM_FREE_MB_MAX)),
            net: self.net.map(NetFacts::sanitized).filter(|net| *net != NetFacts::default()),
        }
    }
}

impl NetFacts {
    fn sanitized(self) -> NetFacts {
        NetFacts {
            kind: self.kind.filter(|kind| NET_TYPES.contains(&kind.as_str())),
            metered: self.metered,
            ipv4: self.ipv4,
            ipv6: self.ipv6,
            other_vpn: self.other_vpn,
            dns: self.dns.map(|list| dns_list(&list)).filter(|list| !list.is_empty()),
            private_dns: self.private_dns.filter(|mode| PRIVATE_DNS_MODES.contains(&mode.as_str())),
            private_dns_host: bounded_text(self.private_dns_host, PRIVATE_DNS_HOST_MAX)
                .filter(|host| host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')),
        }
    }
}

/// Resolver addresses as the server takes them: IP literals, each once,
/// in the canonical spelling, at most four. Never one that names the
/// router's hardware (`names_hardware`).
pub fn dns_list<S: AsRef<str>>(list: &[S]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for entry in list {
        let raw = entry.as_ref().trim();
        let raw = raw.split('%').next().unwrap_or(raw);
        let Ok(ip) = raw.parse::<std::net::IpAddr>() else { continue };
        if ip.is_unspecified() || names_hardware(&ip) {
            continue;
        }
        let spelled = ip.to_string();
        if !kept.contains(&spelled) {
            kept.push(spelled);
        }
        if kept.len() == DNS_MAX {
            break;
        }
    }
    kept
}

/// An IPv6 resolver that is link-local (fe80::/10, what home routers
/// commonly advertise as themselves) or whose interface ID is EUI-64 (ff:fe
/// in its middle, built from a MAC). Either can carry the router's
/// hardware address, the gateway fingerprint that is never sent.
fn names_hardware(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(_) => false,
        std::net::IpAddr::V6(v6) => {
            let octets = v6.octets();
            (v6.segments()[0] & 0xffc0) == 0xfe80 || (octets[11] == 0xff && octets[12] == 0xfe)
        }
    }
}

/// Trimmed, cut to `max` characters (never inside one), and left out when
/// nothing is left.
pub fn bounded_text(text: Option<String>, max: usize) -> Option<String> {
    let text = text?;
    let trimmed: String = text.trim().chars().filter(|c| !c.is_control()).take(max).collect();
    let trimmed = trimmed.trim_end().to_owned();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_full_answer_round_trips_in_the_wire_spelling() {
        let facts = DeviceFacts::from_value(json!({
            "model": "samsung SM-S918B", "os": "Android", "osVersion": "14",
            "lowPower": false, "dataSaver": true, "memFreeMb": 2048,
            "net": { "type": "cellular", "metered": true, "ipv4": true, "ipv6": false, "otherVpn": false,
                     "dns": ["192.0.2.53", "2001:db8::53"], "privateDns": "host", "privateDnsHost": "dns.example.net" }
        }));
        assert_eq!(
            serde_json::to_value(&facts).unwrap(),
            json!({
                "model": "samsung SM-S918B", "os": "Android", "osVersion": "14",
                "lowPower": false, "dataSaver": true, "memFreeMb": 2048,
                "net": { "type": "cellular", "metered": true, "ipv4": true, "ipv6": false, "otherVpn": false,
                         "dns": ["192.0.2.53", "2001:db8::53"], "privateDns": "host", "privateDnsHost": "dns.example.net" }
            })
        );
    }

    /// What a platform cannot tell is not on the wire at all: no nulls, no
    /// empty `net`.
    #[test]
    fn what_is_missing_is_left_out() {
        assert_eq!(serde_json::to_value(DeviceFacts::default()).unwrap(), json!({}));
        let facts = DeviceFacts::from_value(json!({ "os": "iOS", "net": { "dns": [] } }));
        assert_eq!(serde_json::to_value(&facts).unwrap(), json!({ "os": "iOS" }));
        assert_eq!(DeviceFacts::from_value(Value::Null), DeviceFacts::default());
    }

    /// One field of the wrong type costs that field, not the answer.
    #[test]
    fn a_wrong_field_drops_alone() {
        let facts = DeviceFacts::from_value(json!({
            "model": 7, "os": "Android", "lowPower": "yes", "memFreeMb": 512.0,
            "net": { "type": "vpn", "ipv4": true, "privateDns": "strict", "privateDnsHost": "not a host" },
            "hostname": "my-laptop"
        }));
        assert_eq!(
            serde_json::to_value(&facts).unwrap(),
            json!({ "os": "Android", "memFreeMb": 512, "net": { "ipv4": true } })
        );
        let fraction = DeviceFacts::from_value(json!({ "memFreeMb": 512.5 }));
        assert_eq!(fraction.mem_free_mb, None);
        let negative = DeviceFacts::from_value(json!({ "memFreeMb": -1 }));
        assert_eq!(negative.mem_free_mb, None);
    }

    #[test]
    fn held_to_the_servers_bounds() {
        let facts = DeviceFacts {
            model: Some(format!("  {}  ", "m".repeat(100))),
            os_version: Some("é".repeat(60)),
            mem_free_mb: Some(u64::MAX),
            os: Some("android".into()),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(facts.model.as_deref().map(|m| m.chars().count()), Some(MODEL_MAX));
        assert_eq!(facts.os_version.as_deref().map(|v| v.chars().count()), Some(OS_VERSION_MAX));
        assert_eq!(facts.mem_free_mb, Some(MEM_FREE_MB_MAX));
        // The set is spelled exactly.
        assert_eq!(facts.os, None);
        assert_eq!(bounded_text(Some("   ".into()), 10), None);
    }

    /// IP literals only, each once, four at most: never a name.
    #[test]
    fn dns_keeps_four_ip_literals() {
        let list = dns_list(&[
            "192.0.2.1",
            "resolver.example.com",
            "192.0.2.1",
            "0.0.0.0",
            "fe80::1%12",
            "2001:DB8::1",
            "198.51.100.7",
            "198.51.100.8",
        ]);
        assert_eq!(list, ["192.0.2.1", "2001:db8::1", "198.51.100.7", "198.51.100.8"]);
    }

    /// A router's link-local resolver, and any IPv6 one built from a MAC,
    /// would carry the gateway's hardware address: dropped.
    #[test]
    fn dns_never_carries_the_routers_hardware() {
        let list = dns_list(&[
            "fe80::1a2b:3cff:fe4d:5e6f%7",
            "fe80::1",
            "febf::1",
            "2001:db8:0:1:1a2b:3cff:fe4d:5e6f",
            "fd00::1a2b:3cff:fe4d:5e6f",
            "2001:db8::53",
            "192.0.2.1",
        ]);
        assert_eq!(list, ["2001:db8::53", "192.0.2.1"]);
    }
}
