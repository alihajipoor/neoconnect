//! Whether the app's own names resolve to public addresses on this
//! network: one cheap look, for a request the relay of last resort may
//! carry (relay_http.rs; `namesFailHere` in src/lib/names-check.ts).
//!
//! On a network that answers for our names with an address of its own --
//! a block page on a private address, a sinkhole -- every request by name
//! hangs until its connection deadline, ten seconds and more, before the
//! relay gets its turn. This look says so in a second and a half at most,
//! and the app goes to the relay then instead of waiting those deadlines
//! out. Where any name resolves to a public address it changes nothing:
//! the request by name runs exactly as it did. What the classes add up to
//! is the frontend's to say (`namesFailHere`); this file only reports
//! them.
//!
//! Asked of the system resolver, which is what the HTTP plugin's own
//! lookup asks: the names are the ones the request is being raced over,
//! looked up here a second or so before the race would have asked for the
//! last of them. Only a class per name leaves this file. No address is
//! returned, kept or logged.
//!
//! The Windows app's file, and the mobile app's by path (apps/mobile/
//! src-tauri/src/lib.rs), as relay_http.rs is. Changes here ship in both.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::health_ip::{http_proxied, plain_hostname};

/// All the time one look may take, however many names it is given. The
/// frontend's `NAMES_CHECK_MS` is this number (names-check.test.ts reads
/// this line).
const NAMES_CHECK_CAP: Duration = Duration::from_millis(1_500);

/// The most names one look is given. Each is a thread until the resolver
/// answers it; the app's list is a dozen or so.
const MAX_NAMES: usize = 64;

/// What this network's resolver says about one name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NameClass {
    /// At least one of its addresses is a public one: a request to the
    /// name may be answered there.
    Public,
    /// It resolves, and to nothing public: see `is_public`.
    NotPublic,
    /// The resolver gave no address before the cap: an error, an empty
    /// answer, or no reply yet.
    NoAnswer,
    /// Nothing this machine's resolver says would tell where a request to
    /// it goes: an address literal or this machine's own name, which are
    /// not names the network answers for; something that is not a
    /// hostname; or a name whose requests go through a proxy, which
    /// resolves it at its own end (`http_proxied` in health_ip.rs).
    Unknown,
}

/// Whether `address` is one a server on the internet can be reached at.
///
/// Not public: private (10/8, 172.16/12, 192.168/16; fc00::/7), loopback,
/// link-local, the carriers' shared space (100.64/10) and the unspecified
/// address. Those are what a resolver that will not answer for a name
/// answers instead. An IPv4 address inside IPv6 -- mapped, or behind the
/// NAT64 prefix a carrier's DNS64 wraps it in -- is read as the IPv4
/// address it is.
///
/// Everything else is public, deliberately including 198.18.0.0/15: other
/// VPN and proxy tools answer every name from that block ("fake-ip") and
/// carry the connection themselves, so a name that resolves there is one
/// that works.
pub fn is_public(address: IpAddr) -> bool {
    match address.to_canonical() {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => match nat64_inner(v6) {
            Some(v4) => public_v4(v4),
            None => public_v6(v6),
        },
    }
}

fn public_v4(address: Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();
    let shared = first == 100 && (second & 0xC0) == 64;
    !(address.is_private() || address.is_loopback() || address.is_link_local() || address.is_unspecified() || shared)
}

fn public_v6(address: Ipv6Addr) -> bool {
    let first = address.segments()[0];
    let unique_local = (first & 0xFE00) == 0xFC00;
    let link_local = (first & 0xFFC0) == 0xFE80;
    !(address.is_loopback() || address.is_unspecified() || unique_local || link_local)
}

/// The IPv4 address inside one under the well-known NAT64 prefix,
/// 64:ff9b::/96.
fn nat64_inner(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = address.segments();
    if s[0] != 0x64 || s[1] != 0xFF9B || s[2..6] != [0, 0, 0, 0] {
        return None;
    }
    Some(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8))
}

/// A name's class from what the resolver gave for it. Public if any of it
/// is: a request tries every address, and may be answered at that one.
pub fn class_of(found: &[IpAddr]) -> NameClass {
    if found.is_empty() {
        NameClass::NoAnswer
    } else if found.iter().any(|address| is_public(*address)) {
        NameClass::Public
    } else {
        NameClass::NotPublic
    }
}

/// Whether `host` is this machine under its own name, which the hosts
/// file answers and no network does.
fn own_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

/// The system resolver's answer for `host`; empty when it has none.
fn system_lookup(host: &str) -> Vec<IpAddr> {
    (host, 0).to_socket_addrs().map(|found| found.map(|address| address.ip()).collect()).unwrap_or_default()
}

/// Every host's class, in the order given, within `cap` in all.
///
/// The lookups run side by side, each on a thread of its own: the system
/// resolver cannot be interrupted, so one still out at the cap is
/// abandoned, not waited for, and its name is `NoAnswer`. `lookup` and
/// `proxied` are handed in so this can be shown without a network.
fn classify_names(hosts: &[String], cap: Duration, lookup: fn(&str) -> Vec<IpAddr>, proxied: fn(&str) -> bool) -> Vec<NameClass> {
    let deadline = Instant::now() + cap;
    let mut classes = vec![NameClass::NoAnswer; hosts.len()];
    let (sender, receiver) = mpsc::channel();
    let mut asked = 0usize;
    for (i, host) in hosts.iter().enumerate() {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
        if host.parse::<IpAddr>().is_ok() || own_name(&host) || !plain_hostname(&host) || proxied(&host) {
            classes[i] = NameClass::Unknown;
            continue;
        }
        let sender = sender.clone();
        std::thread::spawn(move || {
            // Nobody listening any more is the cap, already passed.
            let _ = sender.send((i, lookup(&host)));
        });
        asked += 1;
    }
    drop(sender);
    while asked > 0 {
        let left = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(left) {
            Ok((i, found)) => {
                classes[i] = class_of(&found);
                asked -= 1;
            }
            Err(_) => break,
        }
    }
    classes
}

/// How each of `hosts` resolves on this network, in the order given: see
/// `NameClass`. A second and a half at most, whatever the resolver does.
///
/// For the names of the API addresses a request is about to be sent to.
/// Rejects only for a list longer than the app's could be; the caller
/// reads that, like any failure of this command, as nothing known.
#[tauri::command]
pub async fn names_resolve_public(hosts: Vec<String>) -> Result<Vec<NameClass>, String> {
    if hosts.len() > MAX_NAMES {
        return Err("too many names".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || classify_names(&hosts, NAMES_CHECK_CAP, system_lookup, http_proxied))
        .await
        .map_err(|_| "could not resolve".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(text: &str) -> IpAddr {
        IpAddr::V4(text.parse().unwrap())
    }

    fn v6(text: &str) -> IpAddr {
        IpAddr::V6(text.parse().unwrap())
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    fn direct(_: &str) -> bool {
        false
    }

    #[test]
    fn what_a_resolver_answers_instead_of_a_name_is_not_public() {
        for text in [
            "10.10.34.35",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "127.0.0.1",
            "127.8.8.8",
            "169.254.10.10",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
        ] {
            assert!(!is_public(v4(text)), "{text} is not a public address");
        }
        for text in ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1"] {
            assert!(!is_public(v6(text)), "{text} is not a public address");
        }
    }

    #[test]
    fn everything_else_is_public() {
        for text in [
            "1.1.1.1",
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.255.255",
            "100.63.255.255",
            "100.128.0.1",
            "169.253.1.1",
            "203.0.113.7",
        ] {
            assert!(is_public(v4(text)), "{text} is a public address");
        }
        for text in ["2606:4700::1111", "2a01:4f8::1", "fec0::1", "fb00::1"] {
            assert!(is_public(v6(text)), "{text} is a public address");
        }
    }

    /// Other tools' "fake-ip" answers: the name works, through them.
    #[test]
    fn the_fake_ip_block_counts_as_public() {
        assert!(is_public(v4("198.18.0.5")));
        assert!(is_public(v4("198.19.255.254")));
    }

    #[test]
    fn an_ipv4_address_inside_ipv6_is_read_as_itself() {
        assert!(!is_public(v6("::ffff:10.10.34.35")));
        assert!(is_public(v6("::ffff:1.1.1.1")));
        assert!(!is_public(v6("64:ff9b::10.10.34.35")));
        assert!(!is_public(v6("64:ff9b::192.168.0.1")));
        assert!(is_public(v6("64:ff9b::1.1.1.1")));
        // Not the NAT64 prefix, only near it.
        assert!(is_public(v6("64:ff9b:1::10.10.34.35")));
    }

    #[test]
    fn a_name_is_public_if_any_of_its_addresses_is() {
        assert_eq!(class_of(&[]), NameClass::NoAnswer);
        assert_eq!(class_of(&[v4("10.10.34.35")]), NameClass::NotPublic);
        assert_eq!(class_of(&[v4("10.10.34.35"), v6("fd00::1")]), NameClass::NotPublic);
        assert_eq!(class_of(&[v4("10.10.34.35"), v6("2606:4700::1111")]), NameClass::Public);
        assert_eq!(class_of(&[v4("1.1.1.1"), v4("192.168.0.1")]), NameClass::Public);
    }

    #[test]
    fn each_name_gets_its_own_class_in_the_order_given() {
        fn lookup(host: &str) -> Vec<IpAddr> {
            match host {
                "real.test" => vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))],
                "poisoned.test" => vec![IpAddr::V4(Ipv4Addr::new(10, 10, 34, 35))],
                _ => Vec::new(),
            }
        }
        let classes = classify_names(
            &names(&["poisoned.test", "real.test", "gone.test", "poisoned.test"]),
            Duration::from_secs(5),
            lookup,
            direct,
        );
        assert_eq!(classes, [NameClass::NotPublic, NameClass::Public, NameClass::NoAnswer, NameClass::NotPublic]);
    }

    /// The resolver is never asked about any of these, so the lookup here
    /// would give them away by answering.
    #[test]
    fn what_is_not_a_name_the_network_answers_for_is_unknown() {
        fn lookup(_: &str) -> Vec<IpAddr> {
            vec![IpAddr::V4(Ipv4Addr::new(10, 10, 34, 35))]
        }
        let classes = classify_names(
            &names(&["192.168.1.10", "203.0.113.7", "[2606:4700::1111]", "localhost", "api.localhost", "not a name", ""]),
            Duration::from_secs(5),
            lookup,
            direct,
        );
        assert!(classes.iter().all(|class| *class == NameClass::Unknown), "{classes:?}");
    }

    #[test]
    fn a_name_whose_requests_go_through_a_proxy_is_unknown() {
        fn lookup(_: &str) -> Vec<IpAddr> {
            vec![IpAddr::V4(Ipv4Addr::new(10, 10, 34, 35))]
        }
        fn proxied(host: &str) -> bool {
            host == "proxied.test"
        }
        let classes = classify_names(&names(&["proxied.test", "direct.test"]), Duration::from_secs(5), lookup, proxied);
        assert_eq!(classes, [NameClass::Unknown, NameClass::NotPublic]);
    }

    /// One resolver call that never comes back holds up nothing: the look
    /// ends at its cap, with what the others said.
    #[test]
    fn a_lookup_still_out_at_the_cap_is_no_answer() {
        fn lookup(host: &str) -> Vec<IpAddr> {
            if host == "slow.test" {
                std::thread::sleep(Duration::from_secs(3));
            }
            vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))]
        }
        let started = Instant::now();
        let classes = classify_names(&names(&["slow.test", "quick.test"]), Duration::from_millis(200), lookup, direct);
        assert_eq!(classes, [NameClass::NoAnswer, NameClass::Public]);
        assert!(started.elapsed() < Duration::from_millis(1_500), "took {:?}", started.elapsed());
    }

    #[test]
    fn the_class_reaches_the_frontend_by_its_kebab_name() {
        let text = serde_json::to_string(&[NameClass::Public, NameClass::NotPublic, NameClass::NoAnswer, NameClass::Unknown]).unwrap();
        assert_eq!(text, r#"["public","not-public","no-answer","unknown"]"#);
    }
}
