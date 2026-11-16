//! Undoing what the ledger says is owed, and the sweep after a helper
//! that died.

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed};
use crate::{dns, link, process, routes, Dirs};

/// Undoes one owed change. `Ok(Some(line))` when it was undone but there
/// is something worth saying; `Err` when it is still there.
pub(crate) fn undo(owed: &Owed, budget: &Budget) -> Result<Option<String>, String> {
    match owed {
        Owed::Route(spec) => routes::delete(spec, budget).map(|_| None).map_err(|e| e.to_string()),
        Owed::EngineRoute(spec) => routes::delete_engines(spec, budget).map(|_| None).map_err(|e| e.to_string()),
        Owed::Rule { args, v6 } => {
            let mut all: Vec<&str> = Vec::new();
            if *v6 {
                all.push("-6");
            }
            all.extend(["rule", "del"]);
            all.extend(args.iter().map(String::as_str));
            match cmd::ip(&all, budget) {
                Ok(_) => Ok(None),
                Err(e) if e.already_gone() => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        Owed::ResolvedLink { .. } | Owed::ResolvConf { .. } => dns::undo(owed, budget),
        Owed::Link { name } => link::delete(name, budget).map(|_| None).map_err(|e| e.to_string()),
        Owed::File { path } => match std::fs::remove_file(path) {
            Ok(()) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// A plain description of an owed change, for a line of the sweep.
pub(crate) fn describe(owed: &Owed) -> String {
    match owed {
        Owed::Route(spec) | Owed::EngineRoute(spec) => format!("the route to {} on {}", spec.dest, spec.dev),
        Owed::Rule { args, .. } => format!("the routing rule \"{}\"", args.join(" ")),
        Owed::ResolvedLink { link } => format!("the DNS settings on {link}"),
        Owed::ResolvConf { .. } => format!("{}", dns::RESOLV_CONF),
        Owed::Link { name } => format!("the interface {name}"),
        Owed::File { path } => format!("{}", path.display()),
    }
}

/// Undoes everything the ledger owes, in rank order, striking off what
/// went. One line per thing.
pub(crate) fn replay(ledger: &Ledger, budget: &Budget) -> Vec<String> {
    let mut owed = ledger.read();
    owed.sort_by_key(Owed::rank);
    let mut lines = Vec::new();
    for item in owed {
        match undo(&item, budget) {
            Ok(note) => {
                ledger.settle(&item);
                lines.push(format!("put back {}", describe(&item)));
                if let Some(note) = note {
                    lines.push(note);
                }
            }
            Err(why) => lines.push(format!("could not put back {}: {why}", describe(&item))),
        }
    }
    lines
}

/// The sweep behind `sweep_leftovers`. Engines first, so nothing is
/// still feeding a link while it is taken away; then the ledger; then
/// what the kernel still marks as ours whatever the ledger says.
pub(crate) fn sweep(dirs: &Dirs) -> Vec<String> {
    let budget = Budget::quick(cmd::TEARDOWN_CAP);
    let mut lines = Vec::new();

    let xray = dirs.bin.join(crate::xray::PROGRAM);
    for pid in process::running_from(&xray) {
        match process::kill_pid(pid) {
            Ok(()) => lines.push(format!("stopped a leftover Xray engine (process {pid})")),
            Err(why) => lines.push(format!("could not stop a leftover Xray engine (process {pid}): {why}")),
        }
    }

    // OpenVPN is the distribution's, so it is matched by the config it
    // reads, which only we write, rather than by its program.
    let ovpn_config = dirs.run.join(crate::openvpn::CONFIG_FILE);
    for pid in process::running_with_arg(crate::openvpn::PROGRAM, &ovpn_config) {
        match process::kill_pid(pid) {
            Ok(()) => lines.push(format!("stopped a leftover OpenVPN engine (process {pid})")),
            Err(why) => lines.push(format!("could not stop a leftover OpenVPN engine (process {pid}): {why}")),
        }
    }

    lines.extend(replay(&Ledger::in_dir(&dirs.state), &budget));
    lines.extend(routes::sweep_ours(&budget));
    lines.extend(crate::wireguard::sweep_rules(&budget));

    for name in link::OURS {
        if !link::exists(name) {
            continue;
        }
        match link::delete(name, &budget) {
            Ok(()) => lines.push(format!("removed the leftover interface {name}")),
            Err(e) => lines.push(format!("could not remove the leftover interface {name}: {e}")),
        }
    }

    // The engines' logs too: they name the server, and a crash is exactly
    // when the tunnel's own stop never ran to delete them.
    for file in [
        crate::xray::CONFIG_FILE,
        crate::openvpn::CONFIG_FILE,
        crate::wireguard::KEY_FILE,
        crate::xray::LOG_FILE,
        crate::openvpn::LOG_FILE,
    ] {
        let config = dirs.run.join(file);
        if !config.exists() {
            continue;
        }
        match std::fs::remove_file(&config) {
            Ok(()) => lines.push(format!("deleted a leftover engine file ({})", config.display())),
            Err(e) => lines.push(format!("could not delete a leftover engine file ({}): {e}", config.display())),
        }
    }
    lines
}
