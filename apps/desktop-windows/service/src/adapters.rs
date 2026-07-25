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

#[derive(Debug, Clone)]
pub struct Adapter {
    pub index: u32,
    pub name: String,
    /// First IPv4 gateway, when the adapter has one. Adapters without a
    /// gateway can't carry off-link traffic, which is what distinguishes
    /// the real uplink from loopback, virtual and tunnel adapters.
    pub gateway: Option<Ipv4Addr>,
    pub is_up: bool,
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

        adapters.push(Adapter {
            // SAFETY: reading a plain field of the union-typed anonymous
            // struct the API defines.
            index: unsafe { entry.Anonymous1.Anonymous.IfIndex },
            name: wide_to_string(entry.FriendlyName),
            gateway,
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
pub fn physical_uplink(exclude: &[&str]) -> io::Result<Option<Adapter>> {
    Ok(list()?
        .into_iter()
        .find(|a| a.is_up && a.gateway.is_some() && !exclude.contains(&a.name.as_str())))
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

    #[test]
    fn reports_nothing_for_an_adapter_that_does_not_exist() {
        assert!(find_by_name("definitely-not-an-adapter").unwrap().is_none());
    }
}
