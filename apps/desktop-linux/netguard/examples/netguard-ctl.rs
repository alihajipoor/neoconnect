//! A thin command line over the crate, so the network-namespace proof
//! (`tests/netns-proof.sh`) drives the very code the helper calls.
//!
//!   netguard-ctl apply [--tunnel IF]... [--transport IP:PORT/tcp|udp]...
//!                      [--fwmark N] [--lan auto|CIDR]... [--ipv6] [--dns] [--ipv4]
//!   netguard-ctl ruleset <same options>
//!   netguard-ctl in-force
//!   netguard-ctl remove
//!   netguard-ctl hold [--tunnel IF]... [--server IP]... [--fwmark N] [--app-group PATH]
//!                     [--resolver IP|machine]... [--dns-anywhere] [--lan auto|CIDR]...
//!   netguard-ctl hold-ruleset <same options>
//!   netguard-ctl held
//!   netguard-ctl resolvers

use neoxify_netguard::{
    apply, apply_hold, hold_in_force, hold_ruleset, in_force, lan_prefixes, machine_resolvers, remove, ruleset, Applied,
    Cidr4, Held, HoldPlan, Plan, Proto, Transport,
};
use std::process::exit;

fn die(msg: &str) -> ! {
    eprintln!("netguard-ctl: {msg}");
    exit(2)
}

fn show(a: Applied) -> String {
    format!("ipv6_blocked={} dns_confined={} ipv4_confined={}", a.ipv6_blocked, a.dns_confined, a.ipv4_confined)
}

fn plan(args: &[String]) -> Plan {
    let mut plan = Plan::default();
    let mut lan_auto = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().cloned().unwrap_or_else(|| die(&format!("{arg} needs a value")));
        match arg.as_str() {
            "--tunnel" => plan.tunnel_ifaces.push(value()),
            "--transport" => {
                let v = value();
                let (addr, proto) = v.split_once('/').unwrap_or_else(|| die("transport is IP:PORT/tcp|udp"));
                let (ip, port) = addr.split_once(':').unwrap_or_else(|| die("transport is IP:PORT/tcp|udp"));
                plan.transports.push(Transport {
                    ip: ip.parse().unwrap_or_else(|_| die("bad transport address")),
                    port: port.parse().unwrap_or_else(|_| die("bad transport port")),
                    proto: if proto == "udp" { Proto::Udp } else { Proto::Tcp },
                });
            }
            "--fwmark" => plan.engine_fwmark = Some(value().parse().unwrap_or_else(|_| die("bad mark"))),
            "--lan" => {
                let v = value();
                if v == "auto" {
                    lan_auto = true;
                } else {
                    let (a, p) = v.split_once('/').unwrap_or_else(|| die("lan is CIDR"));
                    plan.lan.push(Cidr4 {
                        addr: a.parse().unwrap_or_else(|_| die("bad lan")),
                        prefix: p.parse().unwrap_or_else(|_| die("bad lan")),
                    });
                }
            }
            "--ipv6" => plan.block_ipv6 = true,
            "--dns" => plan.confine_dns = true,
            "--ipv4" => plan.confine_ipv4 = true,
            other => die(&format!("unknown option {other}")),
        }
    }
    if lan_auto {
        let exclude: Vec<&str> = plan.tunnel_ifaces.iter().map(String::as_str).collect();
        plan.lan.extend(lan_prefixes(&exclude));
    }
    plan
}

fn hold_plan(args: &[String]) -> HoldPlan {
    let mut plan = HoldPlan::default();
    let mut lan_auto = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().cloned().unwrap_or_else(|| die(&format!("{arg} needs a value")));
        match arg.as_str() {
            "--tunnel" => plan.tunnel_ifaces.push(value()),
            "--server" => plan.servers.push(value().parse().unwrap_or_else(|_| die("bad server address"))),
            "--fwmark" => plan.engine_fwmark = Some(value().parse().unwrap_or_else(|_| die("bad mark"))),
            "--app-group" => plan.app_group = Some(value()),
            "--resolver" => match value().as_str() {
                "machine" => plan.resolvers.extend(machine_resolvers()),
                v => plan.resolvers.push(v.parse().unwrap_or_else(|_| die("bad resolver address"))),
            },
            "--dns-anywhere" => plan.dns_anywhere = true,
            "--lan" => {
                let v = value();
                if v == "auto" {
                    lan_auto = true;
                } else {
                    let (a, p) = v.split_once('/').unwrap_or_else(|| die("lan is CIDR"));
                    plan.lan.push(Cidr4 {
                        addr: a.parse().unwrap_or_else(|_| die("bad lan")),
                        prefix: p.parse().unwrap_or_else(|_| die("bad lan")),
                    });
                }
            }
            other => die(&format!("unknown option {other}")),
        }
    }
    if lan_auto {
        let exclude: Vec<&str> = plan.tunnel_ifaces.iter().map(String::as_str).collect();
        plan.lan.extend(lan_prefixes(&exclude));
    }
    plan
}

fn show_held(h: Held) -> String {
    format!("dns_anywhere={}", h.dns_anywhere)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else { die("apply | ruleset | in-force | remove | hold | hold-ruleset | held | resolvers") };
    match cmd.as_str() {
        "ruleset" => print!("{}", ruleset(&plan(&args[1..]))),
        "apply" => match apply(&plan(&args[1..])) {
            Ok(a) => println!("applied {}", show(a)),
            Err(e) => {
                println!("error {e}");
                exit(1)
            }
        },
        "in-force" => match in_force() {
            Ok(Some(a)) => println!("in-force {}", show(a)),
            Ok(None) => println!("none"),
            Err(e) => {
                println!("error {e}");
                exit(1)
            }
        },
        "remove" => match remove() {
            Ok(r) => println!("{r:?}"),
            Err(e) => {
                println!("error {e}");
                exit(1)
            }
        },
        "hold-ruleset" => print!("{}", hold_ruleset(&hold_plan(&args[1..]))),
        "hold" => match apply_hold(&hold_plan(&args[1..])) {
            Ok(h) => println!("held {}", show_held(h)),
            Err(e) => {
                println!("error {e}");
                exit(1)
            }
        },
        "held" => match hold_in_force() {
            Ok(Some(h)) => println!("held {}", show_held(h)),
            Ok(None) => println!("none"),
            Err(e) => {
                println!("error {e}");
                exit(1)
            }
        },
        "resolvers" => {
            for ip in machine_resolvers() {
                println!("{ip}");
            }
        }
        other => die(&format!("unknown command {other}")),
    }
}
