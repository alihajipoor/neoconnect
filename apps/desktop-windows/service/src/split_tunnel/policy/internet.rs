//! Whether a destination is the internet, or somewhere a split tunnel
//! leaves alone.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Whether an IPv4 destination is out on the internet, rather than
/// somewhere a split tunnel deliberately leaves alone.
///
/// The exclusions are deliberately the *same set* the kernel filter
/// carries (see `redirect::filter_for`), and keeping them in step is the
/// whole point rather than a tidiness argument. The filter decides what
/// the redirect loop is ever allowed to see; this decides what the audit
/// is allowed to call an escape. If the two drifted apart the audit
/// would report a stream of "escapes" the loop was never given a chance
/// to carry -- a number that looks like a leak and is really a
/// disagreement between two lists, which is exactly the sort of false
/// alarm this project has already decided is worse than saying nothing.
pub fn is_public_v4(addr: Ipv4Addr) -> bool {
    let o = addr.octets();
    !(addr.is_unspecified()
        || addr.is_loopback()
        // Multicast, the reserved space above it, and the all-ones
        // broadcast, in one comparison -- as in the filter.
        || o[0] >= 224
        || o[0] == 10
        || (o[0] == 172 && (16..32).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 169 && o[1] == 254))
}

/// The same question for IPv6, and necessarily a weaker answer.
///
/// There is no RFC1918 to carve out: a home IPv6 network numbers its own
/// devices out of the global prefix its ISP delegates, so a LAN
/// neighbour on a `2000::/3` address is indistinguishable here from the
/// internet. What can be excluded is only what is genuinely not the
/// internet -- loopback, the unspecified address, multicast, unique-local
/// and link-local -- which mirrors the IPv6 half of the filter for the
/// same reason the IPv4 version mirrors the IPv4 half.
///
/// An IPv4-mapped address is IPv4 traffic wearing a v6 shape, and is
/// answered by the IPv4 rules so the two cannot disagree about one
/// destination written two ways.
pub fn is_public_v6(addr: Ipv6Addr) -> bool {
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let first = addr.segments()[0];
    !(addr.is_unspecified()
        || addr.is_loopback()
        || addr.is_multicast()
        // fc00::/7, unique-local.
        || first & 0xfe00 == 0xfc00
        // fe80::/10, link-local.
        || first & 0xffc0 == 0xfe80)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_test_matches_what_the_kernel_filter_hands_over() {
        // These are the same list seen from opposite ends -- see
        // is_public_v4. Every address the filter string in redirect.rs
        // excludes must be excluded here too, or the audit reports
        // escapes for traffic the loop was never given.
        for local in [
            "0.0.0.0",
            "127.0.0.1",
            "10.4.4.4",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "169.254.10.10",
            "224.0.0.251",
            "255.255.255.255",
        ] {
            assert!(!is_public_v4(local.parse().unwrap()), "{local} must not count as public");
        }
        // The near misses, which is where an off-by-one range would
        // show: 172.15 and 172.32 are outside RFC1918, and 192.169 is
        // not 192.168. 203.0.113.10 stands in for a node address --
        // redacted, see docs/node-address-hygiene.md.
        for public in
            ["1.1.1.1", "8.8.8.8", "203.0.113.10", "172.15.0.1", "172.32.0.1", "192.169.0.1"]
        {
            assert!(is_public_v4(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn the_ipv6_test_leaves_the_local_network_alone() {
        for local in ["::", "::1", "fe80::1", "fd00::950d:8fd1:26eb:d4a", "ff02::fb", "fc00::5"] {
            assert!(!is_public_v6(local.parse().unwrap()), "{local} must not count as public");
        }
        for public in ["2607:f8b0:400a:809::200e", "2001:db8:6ec5::1"] {
            assert!(is_public_v6(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn an_ipv4_mapped_address_is_answered_by_the_ipv4_rules() {
        // One destination written two ways must not get two answers, or
        // a LAN address wearing a v6 shape becomes an escape.
        assert!(!is_public_v6("::ffff:192.168.1.20".parse().unwrap()));
        assert!(is_public_v6("::ffff:8.8.8.8".parse().unwrap()));
    }
}
