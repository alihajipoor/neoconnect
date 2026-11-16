use super::*;
use std::net::Ipv4Addr;

fn full() -> Plan {
    Plan {
        tunnel_ifaces: vec!["neoconnect0".into()],
        transports: vec![
            Transport { ip: Ipv4Addr::new(192, 0, 2, 7), port: 443, proto: Proto::Tcp },
            Transport { ip: Ipv4Addr::new(192, 0, 2, 7), port: 443, proto: Proto::Tcp },
            Transport { ip: Ipv4Addr::new(198, 51, 100, 9), port: 51820, proto: Proto::Udp },
        ],
        engine_fwmark: Some(28280),
        block_ipv6: true,
        confine_dns: true,
        confine_ipv4: true,
        lan: vec![
            Cidr4 { addr: Ipv4Addr::new(192, 168, 1, 23), prefix: 24 },
            Cidr4 { addr: Ipv4Addr::new(10, 0, 0, 0), prefix: 8 },
            Cidr4 { addr: Ipv4Addr::new(10, 1, 2, 0), prefix: 24 },
        ],
    }
}

/// The lines of one chain, trimmed.
fn chain(script: &str, name: &str) -> Vec<String> {
    let start = script.find(&format!("chain {name} {{")).unwrap_or_else(|| panic!("no chain {name}"));
    script[start..].lines().skip(1).take_while(|l| l.trim() != "}").map(|l| l.trim().to_string()).collect()
}

fn pos(lines: &[String], needle: &str) -> usize {
    lines.iter().position(|l| l.contains(needle)).unwrap_or_else(|| panic!("no line with {needle:?} in {lines:#?}"))
}

#[test]
fn replaces_any_earlier_table_in_one_transaction() {
    let s = ruleset(&full());
    let head: Vec<&str> = s.lines().take(3).collect();
    assert_eq!(head, ["table inet neoxify", "delete table inet neoxify", "table inet neoxify {"]);
    for hook in ["output", "input", "forward"] {
        assert!(s.contains(&format!("type filter hook {hook} priority 0; policy accept;")));
    }
}

#[test]
fn output_precedence_mirrors_the_windows_weights() {
    let out = chain(&ruleset(&full()), "output");
    let order = [
        "oifname \"lo\" accept",
        "oifname \"neoconnect0\" accept",
        "ip daddr 192.0.2.7 tcp dport 443 accept",
        "meta mark 0x00006e78 accept",
        "udp sport 68 udp dport 67 accept",
        "tcp dport 53 reject",
        "ip daddr { 192.168.1.0/24, 10.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } accept",
        "meta nfproto ipv4 meta l4proto tcp reject with tcp reset comment \"nx:ipv4\"",
        "nd-neighbor-solicit",
        "ip6 daddr { fe80::/10, ff00::/8 } udp dport 53 reject",
        "ip6 daddr { fe80::/10, ff00::/8 } accept",
        "meta nfproto ipv6 reject with icmpx type admin-prohibited comment \"nx:ipv6\"",
    ];
    let at: Vec<usize> = order.iter().map(|n| pos(&out, n)).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "out of order: {at:?}\n{out:#?}");
    // A duplicate transport is written once, and the UDP one is there.
    assert_eq!(out.iter().filter(|l| l.contains("192.0.2.7 tcp dport 443")).count(), 1);
    assert!(out.iter().any(|l| l == "ip daddr 198.51.100.9 udp dport 51820 accept comment \"nx:transport\""));
}

#[test]
fn inbound_drops_and_lets_answers_back() {
    let input = chain(&ruleset(&full()), "input");
    assert!(pos(&input, "ct state established,related accept") < pos(&input, "drop comment \"nx:ipv4\""));
    assert!(input.iter().any(|l| l == "ip saddr 198.51.100.9 udp sport 51820 accept comment \"nx:transport\""));
    assert!(input.iter().any(|l| l == "meta nfproto ipv6 drop comment \"nx:ipv6\""));
    assert!(!input.iter().any(|l| l.contains("reject")), "inbound is dropped, not answered");
    assert!(!input.iter().any(|l| l.contains("nx:dns")), "DNS confinement is outbound only");
}

#[test]
fn forward_holds_containers_to_the_same_policy() {
    let fwd = chain(&ruleset(&full()), "forward");
    assert!(pos(&fwd, "iifname \"neoconnect0\" accept") < pos(&fwd, "nx:dns"));
    assert!(pos(&fwd, "oifname \"neoconnect0\" accept") < pos(&fwd, "nx:dns"));
    assert!(pos(&fwd, "nx:dns") < pos(&fwd, "nx:lan"));
    assert!(pos(&fwd, "nx:lan") < pos(&fwd, "comment \"nx:ipv4\""));
    assert!(fwd.iter().any(|l| l.contains("meta nfproto ipv6 reject")));
}

#[test]
fn a_flag_off_leaves_its_rules_out() {
    let none = Plan { tunnel_ifaces: vec!["neoconnect0".into()], ..Plan::default() };
    let s = ruleset(&none);
    for tag in ["nx:ipv4", "nx:ipv6", "nx:dns", "nx:lan", "nx:engine", "nx:transport"] {
        assert!(!s.contains(&format!("\"{tag}\"")), "{tag} present with every flag off:\n{s}");
    }
    assert!(!s.contains("reject") && !s.contains("drop"), "nothing refused with every flag off:\n{s}");

    let only_v6 = ruleset(&Plan { block_ipv6: true, ..none.clone() });
    assert!(only_v6.contains("\"nx:ipv6\"") && !only_v6.contains("\"nx:ipv4\"") && !only_v6.contains("\"nx:dns\""));
    // The router's link-local resolver is refused with the IPv6 block alone.
    assert!(only_v6.contains("udp dport 53 reject with icmpx type admin-prohibited comment \"nx:ipv6-dns\""));

    let only_dns = ruleset(&Plan { confine_dns: true, ..none.clone() });
    assert!(only_dns.contains("\"nx:dns\"") && !only_dns.contains("\"nx:ipv4\"") && !only_dns.contains("\"nx:ipv6\""));

    let only_v4 = ruleset(&Plan { confine_ipv4: true, ..none.clone() });
    assert!(only_v4.contains("\"nx:ipv4\"") && !only_v4.contains("\"nx:dns\"") && !only_v4.contains("\"nx:ipv6\""));
    // With no LAN known, the plumbing is still reachable.
    assert!(only_v4.contains("ip daddr { 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } accept"));

    let no_tunnel = ruleset(&Plan::default());
    assert!(!no_tunnel.contains("nx:tunnel"), "an empty set is an nft syntax error");
}

#[test]
fn several_tunnels_are_one_set() {
    let s = ruleset(&Plan { tunnel_ifaces: vec!["neoxify-wg".into(), "neoconnect0".into()], ..Plan::default() });
    assert!(s.contains("oifname { \"neoxify-wg\", \"neoconnect0\" } accept comment \"nx:tunnel\""));
}

#[test]
fn interface_names_cannot_carry_nft_syntax() {
    for good in ["neoconnect0", "neoxify-wg", "neoxify-ovpn", "eth0.100", "a_b", "abcdefghijklmno"] {
        assert!(script::valid_iface(good), "{good}");
    }
    for bad in [
        "",
        "abcdefghijklmnop",
        "a b",
        "a/b",
        "a\"b",
        "x\" accept comment \"",
        "{ \"lo\" }",
        "a;b",
        "a\nb",
        ".",
        "..",
        "eth\u{e9}",
    ] {
        assert!(!script::valid_iface(bad), "{bad:?}");
        let plan = Plan { tunnel_ifaces: vec![bad.into()], block_ipv6: true, ..Plan::default() };
        assert!(validate(&plan).is_err(), "{bad:?} not refused");
        assert!(!ruleset(&plan).contains("nx:tunnel"), "{bad:?} reached the script");
    }
}

#[test]
fn plans_that_would_permit_everything_are_refused() {
    assert!(validate(&full()).is_ok());
    assert!(validate(&Plan { engine_fwmark: Some(0), ..full() }).is_err());
    let unspecified = Transport { ip: Ipv4Addr::UNSPECIFIED, port: 443, proto: Proto::Tcp };
    assert!(validate(&Plan { transports: vec![unspecified], ..full() }).is_err());
    let wide = Cidr4 { addr: Ipv4Addr::new(0, 0, 0, 0), prefix: 0 };
    assert!(validate(&Plan { lan: vec![wide], ..full() }).is_err());
    // An unread LAN is not checked: it is not written either.
    assert!(validate(&Plan { lan: vec![wide], confine_ipv4: false, ..full() }).is_ok());
    assert!(!ruleset(&Plan { engine_fwmark: Some(0), ..full() }).contains("meta mark"));
}

/// The shape `nft -j list table inet neoxify` prints, cut down to what the
/// read-back looks at.
fn listing(rules: &[(&str, &str, &str)]) -> String {
    let mut items = vec![
        r#"{"metainfo":{"version":"1.0.9","json_schema_version":1}}"#.to_string(),
        r#"{"table":{"family":"inet","name":"neoxify","handle":1}}"#.to_string(),
    ];
    for hook in ["output", "input", "forward"] {
        items.push(format!(
            r#"{{"chain":{{"family":"inet","table":"neoxify","name":"{hook}","handle":1,"type":"filter","hook":"{hook}","prio":0,"policy":"accept"}}}}"#
        ));
    }
    for (chain, comment, verdict) in rules {
        let verdict = match *verdict {
            "reject" => r#"{"reject":{"type":"icmpx","expr":"admin-prohibited"}}"#,
            "drop" => r#"{"drop":null}"#,
            _ => r#"{"accept":null}"#,
        };
        items.push(format!(
            r#"{{"rule":{{"family":"inet","table":"neoxify","chain":"{chain}","handle":9,"comment":"{comment}","expr":[{{"match":{{"op":"==","left":{{"meta":{{"key":"nfproto"}}}},"right":"ipv4"}}}},{verdict}]}}}}"#
        ));
    }
    format!(r#"{{"nftables":[{}]}}"#, items.join(","))
}

#[test]
fn readback_claims_only_what_the_kernel_holds() {
    let all = listing(&[
        ("output", "nx:ipv4", "reject"),
        ("input", "nx:ipv4", "drop"),
        ("forward", "nx:ipv4", "reject"),
        ("output", "nx:ipv6", "reject"),
        ("input", "nx:ipv6", "drop"),
        ("forward", "nx:ipv6", "reject"),
        ("output", "nx:dns", "reject"),
        ("forward", "nx:dns", "reject"),
    ]);
    assert_eq!(readback(&all), Ok(Applied { ipv6_blocked: true, dns_confined: true, ipv4_confined: true }));

    // A tag on a permit is no refusal; a refusal missing from one hook is
    // no guarantee.
    let partial = listing(&[
        ("output", "nx:ipv4", "accept"),
        ("input", "nx:ipv4", "drop"),
        ("forward", "nx:ipv4", "reject"),
        ("output", "nx:ipv6", "reject"),
        ("forward", "nx:ipv6", "reject"),
        ("output", "nx:dns", "reject"),
        ("forward", "nx:dns", "reject"),
    ]);
    assert_eq!(readback(&partial), Ok(Applied { ipv6_blocked: false, dns_confined: true, ipv4_confined: false }));

    assert_eq!(readback(&listing(&[])), Ok(Applied::default()));
    assert!(readback("not json").is_err());
}
