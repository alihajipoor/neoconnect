//! Brings one tunnel up from a saved Connect request, holds it, and takes
//! it down: the live check of this crate, run as root on a test machine.
//!
//!   up <connect.json> [seconds] [only|except <app>...]
//!   up --sweep
//!
//! The file is the JSON of one `Request::Connect`. Without `seconds` (or
//! with 0) the tunnel is held until Enter. `only` and `except` bring it up
//! in Custom mode with the apps that follow. `NEOXIFY_BIN` names the
//! directory holding `xray` (default `/usr/lib/neoxify`); state and
//! scratch go under `NEOXIFY_TEST_DIR` (default `/tmp/neoxify-up`).
//! Nothing that identifies the server or the account is printed: the
//! transports are counted, not listed.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use neoconnect_ipc::Request;
use neoxify_tunnel::{connect, sweep_leftovers, visible_tunnel, way_out, Dirs, Limits, Shape};

fn limits(secs: u64) -> Limits {
    Limits { deadline: Instant::now() + Duration::from_secs(secs), cancel: Arc::new(AtomicBool::new(false)) }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(file) = args.next() else {
        eprintln!("usage: up <connect.json> [seconds] [only|except <app>...]");
        std::process::exit(2);
    };
    let hold: Option<u64> = args.next().and_then(|s| s.parse().ok()).filter(|s| *s > 0);
    let shape = match args.next().as_deref() {
        Some("only") => Shape::OnlySelected(args.collect()),
        Some("except") => Shape::AllExcept(args.collect()),
        _ => Shape::Full,
    };
    let sweep_only = file == "--sweep";

    let base = PathBuf::from(std::env::var("NEOXIFY_TEST_DIR").unwrap_or_else(|_| "/tmp/neoxify-up".into()));
    let dirs = Dirs {
        bin: PathBuf::from(std::env::var("NEOXIFY_BIN").unwrap_or_else(|_| "/usr/lib/neoxify".into())),
        state: base.join("state"),
        run: base.join("run"),
    };
    std::fs::create_dir_all(&dirs.state).unwrap();
    std::fs::create_dir_all(&dirs.run).unwrap();
    if sweep_only {
        // What the helper does at its start, after one that was killed.
        for line in sweep_leftovers(&dirs) {
            println!("sweep: {line}");
        }
        return;
    }

    let text = std::fs::read_to_string(&file).expect("read the request");
    let Request::Connect { profile, exits, known_nodes, .. } = serde_json::from_str(&text).expect("a Connect request")
    else {
        eprintln!("not a Connect request");
        std::process::exit(2);
    };
    for app in match &shape {
        Shape::OnlySelected(a) | Shape::AllExcept(a) => a.as_slice(),
        Shape::Full => &[],
    } {
        if let Err(why) = neoxify_tunnel::valid_app(app) {
            eprintln!("not an app identity: {why}");
            std::process::exit(2);
        }
    }

    for line in sweep_leftovers(&dirs) {
        println!("sweep: {line}");
    }
    println!("way out: {:?}", way_out(&profile));

    let started = Instant::now();
    let mut tunnel = match connect(&profile, &exits, &known_nodes, &shape, &dirs, &limits(60)) {
        Ok(t) => t,
        Err(problem) => {
            println!("connect failed after {:?}: {problem}", started.elapsed());
            for line in sweep_leftovers(&dirs) {
                println!("sweep after failure: {line}");
            }
            std::process::exit(1);
        }
    };
    let up = tunnel.up().clone();
    println!(
        "up in {:?}: protocol={} ifaces={:?} transports={} fwmark={:?} dns_protected={}",
        started.elapsed(),
        up.protocol,
        up.ifaces,
        up.transports.len(),
        up.fwmark,
        up.dns_protected
    );
    println!("visible: {:?}", visible_tunnel());
    println!("shape: {:?}", tunnel.shape());
    println!("split: {:?}", tunnel.split());
    println!("probe: {:?}", tunnel.probe(&limits(15)));
    println!("READY");

    match hold {
        Some(seconds) => {
            for _ in 0..seconds {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        None => {
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
        }
    }

    println!("split before stop: {:?}", tunnel.split());
    println!("health: {:?}", tunnel.health());
    println!("counters (rx, tx): {:?}", tunnel.counters());
    let stopping = Instant::now();
    tunnel.hard_stop();
    println!("hard stop took {:?}", stopping.elapsed());
    tunnel.finish_stop();
    println!("finish stop took {:?}", stopping.elapsed());
    println!("health after stop: {:?}", tunnel.health());
    drop(tunnel);
    println!("visible after stop: {:?}", visible_tunnel());
    for line in sweep_leftovers(&dirs) {
        println!("sweep after stop (should be empty): {line}");
    }
}
