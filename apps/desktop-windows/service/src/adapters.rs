//! Enumerating network adapters.
//!
//! Routing needs two facts that aren't available from the engines
//! themselves: the interface index of the TUN adapter Xray just created,
//! and the gateway/index of the physical link the machine is really
//! using.
//!
//! Both come from `GetAdaptersAddresses` rather than by parsing
//! `route print` or `netsh`, whose output is localised -- this has to
//! work on a Persian or Russian Windows install, not only an English
//! one.

use std::io;
use std::net::Ipv4Addr;

use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

use crate::engines::route_table::RouteRow;

#[derive(Debug, Clone)]
pub struct Adapter {
    pub index: u32,
    pub name: String,
    /// First IPv4 gateway, when the adapter has one. Adapters without a
    /// gateway can't carry off-link traffic, which is what distinguishes
    /// the real uplink from loopback, virtual and tunnel adapters.
    pub gateway: Option<Ipv4Addr>,
    /// The adapter's own IPv4 address, when it has one.
    ///
    /// Split tunnel needs it for two things: it is the source address a
    /// socket pinned to this interface will use, and excluding that
    /// address from the interception filter is what stops the proxy
    /// intercepting its own upstream traffic in a loop.
    pub ipv4: Option<Ipv4Addr>,
    pub is_up: bool,
    /// The driver's own description, e.g. "WireGuard Tunnel" or
    /// "TAP-Windows Adapter V9". FriendlyName is whatever the user
    /// renamed the connection to, so it cannot identify what a thing is;
    /// this can. Used to spot another VPN holding the routes.
    pub description: String,
}

/// Windows' own value for IfOperStatusUp.
const IF_OPER_STATUS_UP: i32 = 1;

fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: the caller guarantees a NUL-terminated wide string, which
    // is what GetAdaptersAddresses returns for these fields.
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

pub fn list() -> io::Result<Vec<Adapter>> {
    let family = AF_INET as u32;
    // GAA_FLAG_INCLUDE_GATEWAYS is required, not optional: without it
    // FirstGatewayAddress is null on every adapter and the machine looks
    // like it has no route to anywhere. That is exactly what happened --
    // enumeration returned correct names, indices and link state while
    // silently reporting no gateways at all.
    let flags = GAA_FLAG_INCLUDE_GATEWAYS
        | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER;

    // Sized by asking, because the adapter set can change between the
    // sizing call and the real one; retrying on overflow is the
    // documented pattern.
    //
    // Backed by u64 rather than u8 so the allocation is aligned for the
    // struct the API writes into it -- casting a byte buffer to a
    // pointer-containing struct would be unaligned and unsound.
    let mut size: u32 = 15_000;
    let mut buffer: Vec<u64> = Vec::new();
    for _ in 0..3 {
        buffer.resize((size as usize).div_ceil(8), 0);
        // SAFETY: the allocation is at least `size` bytes and 8-byte
        // aligned; the API writes a linked list within it.
        let ret = unsafe {
            GetAdaptersAddresses(
                family,
                flags,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut size,
            )
        };
        if ret == ERROR_SUCCESS {
            break;
        }
        if ret != ERROR_BUFFER_OVERFLOW {
            return Err(io::Error::from_raw_os_error(ret as i32));
        }
    }

    let mut adapters = Vec::new();
    let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !current.is_null() {
        // SAFETY: `current` points into `buffer` at a valid entry, which
        // the API laid out; Next is either another entry or null.
        let entry = unsafe { &*current };

        let mut gateway = None;
        let mut gw = entry.FirstGatewayAddress;
        while !gw.is_null() {
            // SAFETY: same linked-list guarantee as above.
            let g = unsafe { &*gw };
            if !g.Address.lpSockaddr.is_null() {
                // SAFETY: family was restricted to AF_INET, so a
                // gateway sockaddr here is a SOCKADDR_IN.
                let sa = unsafe { &*(g.Address.lpSockaddr as *const SOCKADDR_IN) };
                if sa.sin_family == AF_INET {
                    // SAFETY: reading the union's IPv4 representation,
                    // valid for an AF_INET sockaddr.
                    let octets = unsafe { sa.sin_addr.S_un.S_addr }.to_ne_bytes();
                    let addr = Ipv4Addr::from(octets);
                    if !addr.is_unspecified() {
                        gateway = Some(addr);
                        break;
                    }
                }
            }
            gw = g.Next;
        }

        // The adapter's own address, from the same walk. Unicast
        // addresses are a list because an adapter may hold several; the
        // first usable IPv4 is the one a socket pinned here would use.
        let mut ipv4 = None;
        let mut ua = entry.FirstUnicastAddress;
        while !ua.is_null() {
            // SAFETY: same linked-list guarantee as the gateway walk.
            let u = unsafe { &*ua };
            if !u.Address.lpSockaddr.is_null() {
                // SAFETY: family was restricted to AF_INET.
                let sa = unsafe { &*(u.Address.lpSockaddr as *const SOCKADDR_IN) };
                if sa.sin_family == AF_INET {
                    // SAFETY: reading the union's IPv4 representation.
                    let octets = unsafe { sa.sin_addr.S_un.S_addr }.to_ne_bytes();
                    let addr = Ipv4Addr::from(octets);
                    if !addr.is_unspecified() && !addr.is_loopback() {
                        ipv4 = Some(addr);
                        break;
                    }
                }
            }
            ua = u.Next;
        }

        adapters.push(Adapter {
            // SAFETY: reading a plain field of the union-typed anonymous
            // struct the API defines.
            index: unsafe { entry.Anonymous1.Anonymous.IfIndex },
            name: wide_to_string(entry.FriendlyName),
            description: wide_to_string(entry.Description),
            gateway,
            ipv4,
            is_up: entry.OperStatus == IF_OPER_STATUS_UP,
        });

        current = entry.Next;
    }

    Ok(adapters)
}

/// Finds an adapter by the name Windows shows for it.
///
/// Retried by the caller: a TUN adapter takes a moment to appear after
/// its engine starts, so a single miss doesn't mean it will never exist.
pub fn find_by_name(name: &str) -> io::Result<Option<Adapter>> {
    Ok(list()?.into_iter().find(|a| a.name == name))
}

/// The adapter carrying real internet traffic.
///
/// Chosen as an up adapter that has a gateway and isn't one of ours --
/// a gateway is what makes an adapter capable of off-link traffic, which
/// rules out loopback and idle virtual adapters without needing to match
/// on vendor names.
///
/// The *first* such adapter, which is not necessarily the one Windows
/// sends anything by. Custom mode still uses it for its own bookkeeping;
/// a host route to a server should be placed with [`best_uplink_for`].
pub fn physical_uplink(exclude: &[&str]) -> io::Result<Option<Adapter>> {
    Ok(list()?
        .into_iter()
        .find(|a| a.is_up && a.gateway.is_some() && !exclude.contains(&a.name.as_str())))
}

/// Where traffic to one destination leaves the machine: an interface and
/// the next hop on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Uplink {
    pub index: u32,
    /// `0.0.0.0` when the route is on-link -- a PPP or PPPoE dial-up
    /// link, and some mobile dongles, have no gateway to name.
    pub next_hop: Ipv4Addr,
}

/// The adapter and next hop Windows itself would use to reach `dest`,
/// asked of Windows before the tunnel takes over.
///
/// Replaces "the first adapter with a gateway" for placing the host route
/// that keeps an engine's own connection off the tunnel. That rule picked
/// the wrong adapter on any machine with two that qualify -- Wi-Fi and
/// Ethernet both up, a VM host's virtual switch -- and refused a PPP
/// uplink outright, whose default route is on-link and whose gateway
/// therefore reads as 0.0.0.0. Real customers hit the second one: ten
/// desktop connects in fourteen days failed with "no network connection
/// with a gateway was found".
///
/// Falls back to the old rule when Windows has no answer, or when its
/// answer cannot be the uplink -- see [`choose_uplink`].
pub fn best_uplink_for(dest: Ipv4Addr, exclude: &[&str]) -> io::Result<Option<Uplink>> {
    let adapters = list()?;
    Ok(choose_uplink(&adapters, best_route_to(dest).ok(), dest, exclude))
}

/// The decision behind [`best_uplink_for`], on facts already gathered.
///
/// Windows' best route is taken unless it is one of three things that
/// cannot be the way out: a route on one of our own adapters (a tunnel
/// not yet torn down), a host route to the destination itself (one an
/// earlier session left, whose gateway may be from another network), or
/// a route on an adapter that is not up. Then the first adapter with a
/// gateway, as before.
pub fn choose_uplink(
    adapters: &[Adapter],
    best: Option<RouteRow>,
    dest: Ipv4Addr,
    exclude: &[&str],
) -> Option<Uplink> {
    let usable = best.filter(|route| {
        let leftover = route.is_host() && route.dest == dest;
        let adapter = adapters.iter().find(|a| a.index == route.if_index);
        !leftover && adapter.is_some_and(|a| a.is_up && !exclude.contains(&a.name.as_str()))
    });
    if let Some(route) = usable {
        return Some(Uplink { index: route.if_index, next_hop: route.next_hop });
    }
    adapters
        .iter()
        .find(|a| a.is_up && a.gateway.is_some() && !exclude.contains(&a.name.as_str()))
        .and_then(|a| a.gateway.map(|gateway| Uplink { index: a.index, next_hop: gateway }))
}

/// `GetBestRoute2` toward one IPv4 address.
fn best_route_to(dest: Ipv4Addr) -> Result<RouteRow, String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetBestRoute2, MIB_IPFORWARD_ROW2};
    use windows_sys::Win32::Networking::WinSock::SOCKADDR_INET;

    // SAFETY: all-zero is a valid value for these plain-data structures;
    // the destination's family and address are set below, and the two
    // outputs are written by the call.
    let mut destination: SOCKADDR_INET = unsafe { std::mem::zeroed() };
    destination.si_family = AF_INET;
    // The IPv4 arm, which the family above names. The address is stored
    // in network byte order, which is its octets in memory order.
    destination.Ipv4.sin_addr.S_un.S_addr = u32::from_ne_bytes(dest.octets());
    let mut route: MIB_IPFORWARD_ROW2 = unsafe { std::mem::zeroed() };
    let mut source: SOCKADDR_INET = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is to a live local of the declared type; a
    // null interface LUID and index 0 ask about every interface.
    let rc = unsafe {
        GetBestRoute2(std::ptr::null(), 0, std::ptr::null(), &destination, 0, &mut route, &mut source)
    };
    if rc != 0 {
        return Err(format!("GetBestRoute2 found no route to {dest} ({rc})"));
    }
    Ok(crate::engines::route_table::row_from(&route))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against whatever adapters this machine actually has. The
    /// point isn't a fixed expectation -- it's that enumeration returns
    /// real data and that uplink selection picks something plausible,
    /// which is the part routing depends on being correct.
    #[test]
    fn finds_the_real_uplink() {
        let all = list().expect("enumeration should succeed");
        assert!(!all.is_empty(), "no adapters found at all");
        for a in &all {
            println!("  {:>3} up={} gw={:?} {}", a.index, a.is_up, a.gateway, a.name);
        }

        let uplink = physical_uplink(&["neoconnect0"]).expect("lookup should succeed");
        let uplink = uplink.expect("a machine running this test has internet");

        assert!(uplink.is_up);
        assert!(uplink.gateway.is_some(), "uplink must have a gateway to route through");
        assert!(uplink.index != 0, "interface index must be usable in a route command");
        println!("uplink: {} idx={} gw={:?}", uplink.name, uplink.index, uplink.gateway);
    }

    /// Windows' own answer on this machine: an adapter that is up and
    /// carries the route to the internet.
    #[test]
    fn finds_the_best_uplink_toward_a_public_address() {
        let uplink = best_uplink_for(Ipv4Addr::new(1, 1, 1, 1), &["neoconnect0"])
            .expect("lookup should succeed")
            .expect("a machine running this test has internet");
        let adapter = list().unwrap().into_iter().find(|a| a.index == uplink.index).expect("an adapter that exists");
        assert!(adapter.is_up);
        println!("uplink: {} idx={} next hop={}", adapter.name, uplink.index, uplink.next_hop);
    }

    fn adapter(index: u32, name: &str, gateway: Option<Ipv4Addr>) -> Adapter {
        Adapter {
            index,
            name: name.to_string(),
            gateway,
            ipv4: Some(Ipv4Addr::new(10, 0, index as u8, 2)),
            is_up: true,
            description: String::new(),
        }
    }

    /// The API row a PPP link's default route comes back as: on-link,
    /// next hop 0.0.0.0. The old rule threw that adapter away for having
    /// no gateway, and the connect failed with "no network connection
    /// with a gateway was found".
    #[test]
    fn best_uplink_accepts_on_link_zero_next_hop() {
        use windows_sys::Win32::NetworkManagement::IpHelper::MIB_IPFORWARD_ROW2;
        // SAFETY: all-zero is a valid row: destination 0.0.0.0/0, next hop
        // 0.0.0.0, and the AF_INET family set below.
        let mut raw: MIB_IPFORWARD_ROW2 = unsafe { std::mem::zeroed() };
        raw.InterfaceIndex = 23;
        raw.DestinationPrefix.Prefix.si_family = AF_INET;
        raw.NextHop.si_family = AF_INET;
        let route = crate::engines::route_table::row_from(&raw);
        assert_eq!(route.next_hop, Ipv4Addr::UNSPECIFIED);
        assert_eq!(route.prefix, 0);

        let dialup = adapter(23, "Broadband Connection", None);
        assert_eq!(
            choose_uplink(&[dialup], Some(route), Ipv4Addr::new(203, 0, 113, 7), &["neoconnect0"]),
            Some(Uplink { index: 23, next_hop: Ipv4Addr::UNSPECIFIED })
        );
    }

    /// Two adapters with gateways -- Ethernet and Wi-Fi both up -- and
    /// Windows sends by the second. The old rule took the first.
    #[test]
    fn uplink_is_the_best_route_not_the_first_adapter() {
        let ethernet = adapter(5, "Ethernet", Some(Ipv4Addr::new(192, 0, 2, 1)));
        let wifi = adapter(9, "Wi-Fi", Some(Ipv4Addr::new(198, 51, 100, 1)));
        let best = RouteRow { dest: Ipv4Addr::UNSPECIFIED, prefix: 0, if_index: 9, next_hop: Ipv4Addr::new(198, 51, 100, 1), metric: 0 };
        assert_eq!(
            choose_uplink(&[ethernet, wifi], Some(best), Ipv4Addr::new(203, 0, 113, 7), &["neoconnect0"]),
            Some(Uplink { index: 9, next_hop: Ipv4Addr::new(198, 51, 100, 1) })
        );
    }

    /// The three answers that cannot be the way out, each falling back to
    /// the first adapter with a gateway: our own tunnel, a host route to
    /// the server that an earlier session left, and no answer at all.
    #[test]
    fn a_leftover_host_route_or_our_own_adapter_is_not_the_uplink() {
        let server = Ipv4Addr::new(203, 0, 113, 7);
        let ethernet = adapter(5, "Ethernet", Some(Ipv4Addr::new(192, 0, 2, 1)));
        let tunnel = adapter(30, "neoconnect0", None);
        let first = Some(Uplink { index: 5, next_hop: Ipv4Addr::new(192, 0, 2, 1) });
        let adapters = [ethernet, tunnel];

        let through_tunnel = RouteRow { dest: Ipv4Addr::UNSPECIFIED, prefix: 1, if_index: 30, next_hop: Ipv4Addr::new(198, 18, 0, 1), metric: 0 };
        assert_eq!(choose_uplink(&adapters, Some(through_tunnel), server, &["neoconnect0"]), first);

        let leftover = RouteRow::host(server, 5, Ipv4Addr::new(192, 0, 2, 254), 0);
        assert_eq!(choose_uplink(&adapters, Some(leftover), server, &["neoconnect0"]), first);

        assert_eq!(choose_uplink(&adapters, None, server, &["neoconnect0"]), first);
        assert_eq!(choose_uplink(&[], None, server, &["neoconnect0"]), None, "offline is no uplink");
    }

    #[test]
    fn reports_nothing_for_an_adapter_that_does_not_exist() {
        assert!(find_by_name("definitely-not-an-adapter").unwrap().is_none());
    }
}

/// Substrings that identify another VPN's adapter, matched against the
/// driver description.
///
/// Deliberately not "anything virtual". Hyper-V, VirtualBox, VMware and
/// Docker all install permanently-present virtual adapters, and naming
/// one of those as a conflict would tell a developer to uninstall their
/// tooling to use a VPN -- so the list is VPN vendors and VPN driver
/// families only, and everything else is left alone.
const VPN_DRIVER_MARKERS: &[&str] = &[
    "wireguard",
    // "tap-win" rather than "tap-windows": the driver a customer
    // actually has is as likely to read "NW TAP-Win32 Adapter V9.21",
    // which the longer marker matched no part of.
    "tap-win",
    "tap-nordvpn",
    "openvpn",
    "kerio",
    "anyconnect",
    "fortinet",
    "fortissl",
    "check point",
    "softether",
    "hamachi",
    "zerotier",
    "tailscale",
    "proton",
    "mullvad",
    "expressvpn",
    "nordlynx",
    "surfshark",
    "psiphon",
    "wintun",
];

/// Other VPN adapters that are currently up, by friendly name.
///
/// Only ones that are UP and carrying an address: a VPN that is merely
/// installed is not a conflict, and saying it is would be crying wolf on
/// most Windows machines. On the customer whose machine prompted this,
/// Kerio and a TAP adapter were both present and both disconnected --
/// neither was the problem, and neither should have been named.
///
/// `ours` is excluded by friendly name, since our own tunnel is up by
/// the time anything asks this.
pub fn other_vpns_up(ours: &[&str]) -> io::Result<Vec<String>> {
    Ok(list()?
        .into_iter()
        .filter(|a| a.is_up && a.ipv4.is_some())
        .filter(|a| !ours.iter().any(|o| a.name.eq_ignore_ascii_case(o)))
        .filter(|a| {
            let d = a.description.to_ascii_lowercase();
            VPN_DRIVER_MARKERS.iter().any(|m| d.contains(m))
        })
        .map(|a| a.name)
        .collect())
}

#[cfg(test)]
mod vpn_detection_tests {
    use super::*;

    fn looks_like_vpn(description: &str) -> bool {
        let d = description.to_ascii_lowercase();
        VPN_DRIVER_MARKERS.iter().any(|m| d.contains(m))
    }

    #[test]
    fn recognises_the_drivers_customers_actually_have() {
        // Every one of these was seen on a real customer machine or is a
        // vendor whose client is common in Iran.
        for d in [
            "WireGuard Tunnel",
            "TAP-Windows Adapter V9",
            "NW TAP-Win32 Adapter V9.21",
            "Kerio Virtual Network Adapter",
            "Cisco AnyConnect Virtual Miniport Adapter",
            "TAP-NordVPN Windows Adapter V9",
        ] {
            assert!(looks_like_vpn(d), "{d} should be recognised as a VPN adapter");
        }
    }

    #[test]
    fn leaves_developer_tooling_alone() {
        // The failure that would matter most: naming one of these tells a
        // developer to uninstall their tooling to use a VPN, and if the
        // hint ever became a refusal it would lock them out entirely.
        for d in [
            "Hyper-V Virtual Ethernet Adapter",
            "VirtualBox Host-Only Ethernet Adapter",
            "VMware Virtual Ethernet Adapter for VMnet8",
            "Realtek PCIe GbE Family Controller",
            "802.11n USB Wireless LAN Card",
            "Npcap Loopback Adapter",
        ] {
            assert!(!looks_like_vpn(d), "{d} must NOT be treated as a rival VPN");
        }
    }
}
