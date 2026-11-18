//! `device_facts` on Windows: what the PC and its network are, for a
//! connect report's `details` (device_facts.rs has the shape).
//!
//! Each fact is read on its own and left out when the read fails, so a
//! locked-down registry key costs the model and nothing else. All of it is
//! local and fast -- the registry, two kernel32 calls and one adapter walk
//! -- and the whole answer is still held to a second
//! (`FACTS_TIME_LIMIT`), after which whatever is not in is left out.
//!
//! What is never read: the computer name, adapter names, Wi-Fi names, the
//! gateway's hardware address. The model comes from the BIOS keys, which
//! name the hardware, never the machine's owner.
//!
//! Not reported on Windows: `dataSaver` (no such setting), `metered`
//! (only through WinRT's connection profile, which describes whichever
//! network Windows calls the internet connection -- our own tunnel's, while
//! it is up), and `otherVpn` (the service's diagnostics hold that, behind
//! a round trip this must not wait for).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_MULTICAST,
    IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6};

use crate::device_facts::{dns_list, model_of, DeviceFacts, NetFacts};

/// The whole answer's limit. The contract asks for about a second.
const FACTS_TIME_LIMIT: Duration = Duration::from_millis(900);

#[tauri::command]
pub async fn device_facts() -> DeviceFacts {
    let read = tauri::async_runtime::spawn_blocking(read_facts);
    match tokio::time::timeout(FACTS_TIME_LIMIT, read).await {
        Ok(Ok(facts)) => facts.sanitized(),
        // Too slow, or the read panicked: what is certain without it.
        _ => DeviceFacts { os: Some("Windows".into()), ..Default::default() },
    }
}

fn read_facts() -> DeviceFacts {
    DeviceFacts {
        model: model(),
        os: Some("Windows".into()),
        os_version: os_version(),
        low_power: battery_saver(),
        data_saver: None,
        mem_free_mb: free_memory_mb(),
        net: network(),
    }
}

// ---- The device ---------------------------------------------------------

/// "Manufacturer Product" from the BIOS keys Windows copies out of SMBIOS.
fn model() -> Option<String> {
    let bios = windows_registry::LOCAL_MACHINE.open(r"HARDWARE\DESCRIPTION\System\BIOS").ok()?;
    model_of(bios.get_string("SystemManufacturer").ok(), bios.get_string("SystemProductName").ok())
}

/// "11 26100.2314": the marketing major, then build.revision. From the
/// registry rather than GetVersionEx, which lies to an unmanifested
/// process; CurrentMajorVersionNumber still says 10 on Windows 11, so the
/// major comes from the build.
fn os_version() -> Option<String> {
    let key = windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
    let build: u32 = key.get_string("CurrentBuildNumber").ok()?.trim().parse().ok()?;
    Some(windows_version(build, key.get_u32("UBR").ok()))
}

/// Windows 11 is build 22000 and later.
pub fn windows_version(build: u32, revision: Option<u32>) -> String {
    let major = if build >= 22_000 { 11 } else { 10 };
    match revision {
        Some(revision) => format!("{major} {build}.{revision}"),
        None => format!("{major} {build}"),
    }
}

/// Battery saver, from `SYSTEM_POWER_STATUS.SystemStatusFlag` (1 on).
fn battery_saver() -> Option<bool> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: a plain out-structure the call fills in.
    let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // SAFETY: `status` is a valid, writable SYSTEM_POWER_STATUS.
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return None;
    }
    Some(status.SystemStatusFlag == 1)
}

fn free_memory_mb() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: a plain out-structure the call fills in.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status` is valid and writable, its length set as the API asks.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    Some(status.ullAvailPhys / (1024 * 1024))
}

// ---- The network --------------------------------------------------------

/// One adapter as the decision needs it. Its names are read only to tell
/// ours and other VPNs apart, and never leave this module.
#[derive(Debug, Clone, Default)]
pub struct Adapter {
    pub if_type: u32,
    pub up: bool,
    /// Ours or another product's tunnel: never the network underneath.
    pub tunnel: bool,
    pub metric4: u32,
    pub metric6: u32,
    pub gateway4: bool,
    pub gateway6: bool,
    pub v4: Vec<Ipv4Addr>,
    pub v6: Vec<Ipv6Addr>,
    pub dns: Vec<IpAddr>,
}

/// IANA ifType values (ipifcons.h).
const IF_TYPE_ETHERNET: u32 = 6;
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_WIFI: u32 = 71;
const IF_TYPE_WWAN_GSM: u32 = 243;
const IF_TYPE_WWAN_CDMA: u32 = 244;

/// What the contract calls the adapter's type.
pub fn net_type(if_type: u32) -> &'static str {
    match if_type {
        IF_TYPE_WIFI => "wifi",
        IF_TYPE_ETHERNET => "ethernet",
        IF_TYPE_WWAN_GSM | IF_TYPE_WWAN_CDMA => "cellular",
        _ => "other",
    }
}

/// Whether an adapter can be the physical network: Wi-Fi, Ethernet, mobile
/// broadband, or a dial-up/PPPoE link. Never a tunnel (131), a software
/// adapter (53, which is what Wintun is), or loopback (24).
fn can_be_underlying(if_type: u32) -> bool {
    matches!(if_type, IF_TYPE_ETHERNET | IF_TYPE_PPP | IF_TYPE_WIFI | IF_TYPE_WWAN_GSM | IF_TYPE_WWAN_CDMA)
}

/// The network the tunnel rides on: of the adapters that are up, can be
/// physical, are not a tunnel and have a default gateway, the one Windows
/// prefers -- the lowest interface metric, IPv4 first. Not Windows' best
/// route, which while a tunnel of ours is up is the tunnel.
pub fn underlying(adapters: &[Adapter]) -> Option<&Adapter> {
    let candidates = || adapters.iter().filter(|a| a.up && !a.tunnel && can_be_underlying(a.if_type));
    candidates()
        .filter(|a| a.gateway4)
        .min_by_key(|a| a.metric4)
        .or_else(|| candidates().filter(|a| a.gateway6).min_by_key(|a| a.metric6))
}

/// The `net` facts from an adapter list that was read. "none" only when no
/// adapter at all is up with a gateway -- not when the walk failed, which
/// leaves `net` out (`network`).
pub fn net_facts(adapters: &[Adapter]) -> NetFacts {
    let Some(chosen) = underlying(adapters) else {
        let any_way_out = adapters.iter().any(|a| a.up && (a.gateway4 || a.gateway6));
        return NetFacts {
            // Something has a gateway but none of it is a network we can
            // name: saying "none" would be untrue.
            kind: Some(if any_way_out { "unknown" } else { "none" }.into()),
            ..Default::default()
        };
    };
    let ipv4 = chosen.gateway4 && chosen.v4.iter().any(|a| usable_v4(*a));
    let ipv6 = chosen.gateway6 && chosen.v6.iter().any(|a| global_v6(*a));
    let dns: Vec<String> = chosen
        .dns
        .iter()
        .filter(|server| !server.is_loopback() && !site_local_default(server))
        .map(|server| server.to_string())
        .collect();
    let dns = dns_list(&dns);
    NetFacts {
        kind: Some(net_type(chosen.if_type).into()),
        ipv4: Some(ipv4),
        ipv6: Some(ipv6),
        dns: (!dns.is_empty()).then_some(dns),
        ..Default::default()
    }
}

/// Not an APIPA address, which is what an adapter holds when DHCP failed.
fn usable_v4(addr: Ipv4Addr) -> bool {
    !addr.is_unspecified() && !addr.is_loopback() && !addr.is_link_local()
}

/// 2000::/3: an address that reaches the internet, not a link-local or ULA.
fn global_v6(addr: Ipv6Addr) -> bool {
    addr.segments()[0] & 0xe000 == 0x2000
}

/// The fec0:0:0:ffff::1-3 defaults Windows fills in for an adapter with no
/// IPv6 resolver, which answer nowhere.
fn site_local_default(server: &IpAddr) -> bool {
    matches!(server, IpAddr::V6(v6) if v6.segments()[0] & 0xffc0 == 0xfec0)
}

/// The same driver families the service calls another VPN
/// (`looks_like_vpn` in service/src/adapters.rs), plus our IKEv2
/// connection's name: a tunnel is never the network beneath it.
fn is_tunnel(friendly_name: &str, description: &str) -> bool {
    const MARKERS: &[&str] = &[
        "wireguard", "tap-win", "tap-nordvpn", "openvpn", "kerio", "anyconnect", "fortinet", "fortissl",
        "check point", "softether", "hamachi", "zerotier", "tailscale", "proton", "mullvad", "expressvpn",
        "nordlynx", "surfshark", "psiphon", "wintun",
    ];
    let description = description.to_ascii_lowercase();
    // `ENTRY_NAME` in service/src/engines/ikev2.rs: the RAS connection
    // IKEv2 dials, a PPP adapter by that name while it is up.
    friendly_name.eq_ignore_ascii_case("Neoxify") || MARKERS.iter().any(|m| description.contains(m))
}

/// `net`, or nothing when the adapters could not be read.
fn network() -> Option<NetFacts> {
    Some(net_facts(&read_adapters()?))
}

/// Windows' own value for IfOperStatusUp.
const IF_OPER_STATUS_UP: i32 = 1;
const ERROR_SUCCESS: u32 = 0;
const ERROR_BUFFER_OVERFLOW: u32 = 111;

fn read_adapters() -> Option<Vec<Adapter>> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
    // As in service/src/adapters.rs: sized by asking, retried when the set
    // grew in between, and backed by u64 so the list is aligned.
    let mut size: u32 = 15_000;
    let mut buffer: Vec<u64> = Vec::new();
    let mut listed = false;
    for _ in 0..3 {
        buffer.resize((size as usize).div_ceil(8), 0);
        // SAFETY: the allocation is at least `size` bytes and 8-byte
        // aligned; the API writes a linked list within it.
        let ret = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC),
                flags,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            )
        };
        if ret == ERROR_SUCCESS {
            listed = true;
            break;
        }
        if ret != ERROR_BUFFER_OVERFLOW {
            return None;
        }
    }
    if !listed {
        return None;
    }

    let mut adapters = Vec::new();
    let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !current.is_null() {
        // SAFETY: `current` points into `buffer` at an entry the API laid
        // out; Next is another entry or null.
        let entry = unsafe { &*current };
        let mut adapter = Adapter {
            if_type: entry.IfType,
            up: entry.OperStatus == IF_OPER_STATUS_UP,
            tunnel: is_tunnel(&wide_to_string(entry.FriendlyName), &wide_to_string(entry.Description)),
            metric4: entry.Ipv4Metric,
            metric6: entry.Ipv6Metric,
            ..Default::default()
        };
        let mut gateway = entry.FirstGatewayAddress;
        while !gateway.is_null() {
            // SAFETY: the same linked-list guarantee.
            let g = unsafe { &*gateway };
            match socket_address_ip(g.Address.lpSockaddr) {
                Some(IpAddr::V4(v4)) if !v4.is_unspecified() => adapter.gateway4 = true,
                Some(IpAddr::V6(v6)) if !v6.is_unspecified() => adapter.gateway6 = true,
                _ => {}
            }
            gateway = g.Next;
        }
        let mut unicast = entry.FirstUnicastAddress;
        while !unicast.is_null() {
            // SAFETY: the same linked-list guarantee.
            let u = unsafe { &*unicast };
            match socket_address_ip(u.Address.lpSockaddr) {
                Some(IpAddr::V4(v4)) => adapter.v4.push(v4),
                Some(IpAddr::V6(v6)) => adapter.v6.push(v6),
                None => {}
            }
            unicast = u.Next;
        }
        let mut dns = entry.FirstDnsServerAddress;
        while !dns.is_null() {
            // SAFETY: the same linked-list guarantee.
            let d = unsafe { &*dns };
            if let Some(server) = socket_address_ip(d.Address.lpSockaddr) {
                adapter.dns.push(server);
            }
            dns = d.Next;
        }
        adapters.push(adapter);
        current = entry.Next;
    }
    Some(adapters)
}

fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: a NUL-terminated wide string, which is what
    // GetAdaptersAddresses returns for these fields.
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

/// The address in a sockaddr the API wrote, IPv4 or IPv6.
fn socket_address_ip(sa: *const SOCKADDR) -> Option<IpAddr> {
    if sa.is_null() {
        return None;
    }
    // SAFETY: non-null, written by GetAdaptersAddresses; every sockaddr
    // begins with its family.
    let family = unsafe { (*sa).sa_family };
    match family {
        AF_INET => {
            // SAFETY: the family says SOCKADDR_IN.
            let octets = unsafe { (*(sa as *const SOCKADDR_IN)).sin_addr.S_un.S_addr }.to_ne_bytes();
            Some(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        AF_INET6 => {
            // SAFETY: the family says SOCKADDR_IN6.
            let bytes = unsafe { (*(sa as *const SOCKADDR_IN6)).sin6_addr.u.Byte };
            Some(IpAddr::V6(Ipv6Addr::from(bytes)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_types_map_to_the_contracts_words() {
        assert_eq!(net_type(71), "wifi");
        assert_eq!(net_type(6), "ethernet");
        assert_eq!(net_type(243), "cellular");
        assert_eq!(net_type(244), "cellular");
        assert_eq!(net_type(23), "other");
        assert_eq!(net_type(53), "other");
    }

    #[test]
    fn version_strings() {
        assert_eq!(windows_version(26100, Some(2314)), "11 26100.2314");
        assert_eq!(windows_version(22000, None), "11 22000");
        assert_eq!(windows_version(19045, Some(5371)), "10 19045.5371");
    }

    fn wifi() -> Adapter {
        Adapter {
            if_type: 71,
            up: true,
            metric4: 35,
            metric6: 35,
            gateway4: true,
            v4: vec![Ipv4Addr::new(192, 0, 2, 10)],
            v6: vec!["fe80::1".parse().unwrap()],
            dns: vec!["192.0.2.1".parse().unwrap(), "fec0:0:0:ffff::1".parse().unwrap()],
            ..Default::default()
        }
    }

    /// Our own tunnel holds the default route with the lowest metric; the
    /// answer is still the Wi-Fi under it, with the Wi-Fi's resolver.
    #[test]
    fn the_network_under_our_tunnel_is_reported_not_the_tunnel() {
        let tunnel = Adapter {
            if_type: 53,
            up: true,
            tunnel: true,
            metric4: 1,
            gateway4: true,
            v4: vec![Ipv4Addr::new(198, 51, 100, 2)],
            dns: vec!["198.51.100.1".parse().unwrap()],
            ..Default::default()
        };
        // A TAP adapter says it is Ethernet; its description says otherwise.
        let tap = Adapter { if_type: 6, tunnel: true, metric4: 2, ..tunnel.clone() };
        let adapters = vec![tunnel, tap, wifi()];
        let net = net_facts(&adapters);
        assert_eq!(net.kind.as_deref(), Some("wifi"));
        assert_eq!(net.ipv4, Some(true));
        assert_eq!(net.ipv6, Some(false));
        assert_eq!(net.dns, Some(vec!["192.0.2.1".to_owned()]));
    }

    #[test]
    fn the_preferred_uplink_wins_and_ipv6_needs_a_global_address_and_a_gateway() {
        let ethernet = Adapter {
            if_type: 6,
            metric4: 5,
            gateway6: true,
            v6: vec!["2001:db8::10".parse().unwrap()],
            dns: vec!["2001:db8::53".parse().unwrap()],
            ..wifi()
        };
        let down = Adapter { up: false, metric4: 0, ..wifi() };
        let net = net_facts(&[wifi(), ethernet, down]);
        assert_eq!(net.kind.as_deref(), Some("ethernet"));
        assert_eq!(net.ipv6, Some(true));
        assert_eq!(net.dns, Some(vec!["2001:db8::53".to_owned()]));
    }

    /// "none" only when nothing is up with a gateway; an APIPA address is
    /// not IPv4 connectivity.
    #[test]
    fn no_network_and_no_dhcp() {
        assert_eq!(net_facts(&[]).kind.as_deref(), Some("none"));
        let only_tunnel = Adapter { if_type: 53, up: true, tunnel: true, gateway4: true, ..Default::default() };
        assert_eq!(net_facts(&[only_tunnel]).kind.as_deref(), Some("unknown"));
        let apipa = Adapter { v4: vec![Ipv4Addr::new(169, 254, 3, 4)], ..wifi() };
        assert_eq!(net_facts(&[apipa]).ipv4, Some(false));
    }

    #[test]
    fn tunnels_are_told_apart_by_driver_and_our_connection_name() {
        assert!(is_tunnel("Ethernet 3", "TAP-Windows Adapter V9"));
        assert!(is_tunnel("Neoxify", "WAN Miniport (IKEv2)"));
        assert!(is_tunnel("x", "Wintun Userspace Tunnel"));
        assert!(!is_tunnel("Wi-Fi", "Intel(R) Wi-Fi 6 AX201 160MHz"));
        assert!(!is_tunnel("vEthernet (External)", "Hyper-V Virtual Ethernet Adapter"));
    }

    /// This PC's own answer, printed: the reads work and stay in bounds.
    #[test]
    fn reads_this_machine() {
        let facts = read_facts().sanitized();
        println!("  {}", serde_json::to_string(&facts).unwrap());
        assert_eq!(facts.os.as_deref(), Some("Windows"));
        assert!(facts.os_version.is_some());
        assert!(facts.mem_free_mb.is_some());
    }
}
