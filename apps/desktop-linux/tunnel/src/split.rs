//! Custom mode: the chosen apps one way, everything else the other.
//!
//! The chosen apps are kept in the control group `neoxify.split`
//! (`sorting`). An nftables table of ours, `inet neoxify_split`, marks
//! their packets in a `route` chain on the output hook, which makes the
//! kernel look the route up again with the mark; a policy rule sends the
//! mark to a routing table of ours:
//!
//! * only the chosen apps (`OnlySelected`): the engine comes up without
//!   taking the machine, and the table leads into the tunnel;
//! * everything except them (`AllExcept`): the engine takes the machine as
//!   it does without Custom mode, and the table leads out by the uplink.
//!
//! Before that rule, the main table is asked with its default and
//! half-default routes hidden, so the chosen apps still reach the local
//! network and our host routes either way.
//!
//! A socket picks its source address from the first route lookup, before
//! the mark exists, so a marked packet would leave its new interface with
//! the other one's address: the tunnel's server, or the uplink's router,
//! drops it. Masquerading on the new interface rewrites it, conntrack
//! puts it back on the replies, and the connection's mark is copied onto
//! those replies so reverse-path filtering judges them by the same route
//! (with `src_valid_mark` on the uplink when its filtering is strict; the
//! tunnel's own filtering is loose, as it carries replies for addresses
//! that are not its own).
//!
//! Lookups go through the tunnel whoever makes them, as on Windows: port
//! 53 gets a second mark of its own whose table always leads into the
//! tunnel, and a postrouting chain drops any port 53 that would still leave
//! by another interface. The tunnel carries IPv4 only, so IPv6 is refused
//! for what is meant to be in it: the chosen apps, or everything else.

use std::ffi::CString;
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use neoconnect_ipc::SplitTunnelProblemCode;
use serde_json::Value;

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::routes::{self, Uplink};
use crate::sorting::{self, Sorter, SPLIT_GROUP};
use crate::{link, Limits, Problem, Shape, SplitState};

pub(crate) const NFT_FAMILY: &str = "inet";
pub(crate) const NFT_TABLE: &str = "neoxify_split";
/// The mark on the chosen apps' packets, and their routing table.
pub(crate) const APP_MARK: u32 = 28281;
/// The mark on lookups, and their routing table, which leads into the
/// tunnel in both modes.
pub(crate) const DNS_MARK: u32 = 28282;
/// The three rules' priorities: before WireGuard's (28278), so a marked
/// packet is decided here whatever the engine.
pub(crate) const MAIN_PREF: u32 = 28275;
pub(crate) const APP_PREF: u32 = 28276;
pub(crate) const DNS_PREF: u32 = 28277;

/// The script is loaded from a file (`nft -f`), as this crate starts no
/// program with input on stdin.
const SCRIPT_FILE: &str = "neoxify-split.nft";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    OnlySelected,
    AllExcept,
}

/// The mode and the apps, or `None` for `Full`.
pub(crate) fn parts(shape: &Shape) -> Option<(Mode, &[String])> {
    match shape {
        Shape::Full => None,
        Shape::OnlySelected(apps) => Some((Mode::OnlySelected, apps)),
        Shape::AllExcept(apps) => Some((Mode::AllExcept, apps)),
    }
}

/// Whether the engine should take the whole machine for this shape.
pub(crate) fn takes_everything(shape: &Shape) -> bool {
    !matches!(shape, Shape::OnlySelected(_))
}

/// What Custom mode needs to know about the engine it sorts around.
#[derive(Debug, Clone)]
pub(crate) struct Plan {
    /// The tunnel interface.
    pub tunnel: String,
    /// The machine's own way out, for the chosen apps in `AllExcept`.
    pub uplink: Uplink,
    /// The engine's servers: their traffic is never re-sorted, whatever
    /// its port.
    pub servers: Vec<Ipv4Addr>,
    /// The mark on the engine's own packets (WireGuard), likewise.
    pub engine_mark: Option<u32>,
}

/// The nftables script: pure. It declares, deletes and redefines our
/// table in one transaction, so a reload is never a moment without it.
pub(crate) fn ruleset(mode: Mode, plan: &Plan) -> String {
    let tun = &plan.tunnel;
    let group = SPLIT_GROUP;
    let mut s = String::new();
    s += &format!("table {NFT_FAMILY} {NFT_TABLE} {{}}\ndelete table {NFT_FAMILY} {NFT_TABLE}\n");
    s += &format!("table {NFT_FAMILY} {NFT_TABLE} {{\n");
    s += "\tset servers {\n\t\ttype ipv4_addr\n";
    if !plan.servers.is_empty() {
        let list: Vec<String> = plan.servers.iter().map(Ipv4Addr::to_string).collect();
        s += &format!("\t\telements = {{ {} }}\n", list.join(", "));
    }
    s += "\t}\n";

    // Marking, which re-routes. Loopback, the engine's own traffic and
    // multicast are never moved.
    s += "\tchain sort {\n\t\ttype route hook output priority mangle; policy accept;\n";
    s += "\t\toifname \"lo\" return\n";
    if let Some(mark) = plan.engine_mark {
        s += &format!("\t\tmeta mark {mark} return\n");
    }
    s += "\t\tip daddr @servers return\n";
    s += "\t\tip daddr { 224.0.0.0/4, 255.255.255.255 } return\n";
    // A packet the kernel sends for a connection on its own, with no
    // socket behind it -- the reset answering a late segment after the
    // program closed -- belongs to no control group, so it would take the
    // main table: out of the uplink, carrying the tunnel's address and
    // naming the destination (seen in the VM's capture). It goes the way
    // its connection was sorted instead.
    s += &format!("\t\tct mark {{ {APP_MARK}, {DNS_MARK} }} meta mark set ct mark return\n");
    s += &format!(
        "\t\tmeta nfproto ipv4 meta l4proto {{ tcp, udp }} th dport 53 meta mark set {DNS_MARK} ct mark set {DNS_MARK} return\n"
    );
    s += &format!(
        "\t\tmeta nfproto ipv4 socket cgroupv2 level 1 \"{group}\" meta mark set {APP_MARK} ct mark set {APP_MARK}\n"
    );
    s += "\t}\n";

    // Replies carry their connection's mark, for reverse-path filtering.
    s += "\tchain replies {\n\t\ttype filter hook prerouting priority mangle; policy accept;\n";
    s += &format!("\t\tct mark {{ {APP_MARK}, {DNS_MARK} }} meta mark set ct mark\n");
    s += "\t}\n";

    // IPv6 for what belongs in the tunnel.
    s += "\tchain ipv6 {\n\t\ttype filter hook output priority filter; policy accept;\n";
    s += "\t\tmeta nfproto != ipv6 accept\n\t\toifname \"lo\" accept\n";
    match mode {
        Mode::OnlySelected => s += &format!("\t\tsocket cgroupv2 level 1 \"{group}\" reject\n"),
        Mode::AllExcept => {
            s += &format!("\t\tsocket cgroupv2 level 1 \"{group}\" accept\n");
            s += "\t\ticmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept\n";
            s += "\t\tip6 daddr { fe80::/10, ff00::/8, fc00::/7 } accept\n";
            s += "\t\treject\n";
        }
    }
    s += "\t}\n";

    // Lookups leave by the tunnel or not at all. On postrouting, because
    // only there is the interface the one chosen after re-routing.
    s += "\tchain lookups {\n\t\ttype filter hook postrouting priority filter; policy accept;\n";
    s += &format!("\t\toifname {{ \"lo\", \"{tun}\" }} accept\n");
    if let Some(mark) = plan.engine_mark {
        s += &format!("\t\tmeta mark {mark} accept\n");
    }
    s += "\t\tip daddr @servers accept\n";
    s += "\t\tmeta l4proto { tcp, udp } th dport 53 drop\n";
    s += "\t}\n";

    // The source address of the interface a packet was moved to.
    s += "\tchain nat {\n\t\ttype nat hook postrouting priority srcnat; policy accept;\n";
    s += &format!("\t\toifname \"{tun}\" meta mark {{ {APP_MARK}, {DNS_MARK} }} masquerade\n");
    if mode == Mode::AllExcept {
        s += &format!("\t\toifname \"{}\" meta mark {APP_MARK} masquerade\n", plan.uplink.dev);
    }
    s += "\t}\n}\n";
    s
}

/// The three policy rules, as the arguments after `ip rule add`.
pub(crate) fn rule_args() -> [Vec<String>; 3] {
    let (app, dns) = (APP_MARK.to_string(), DNS_MARK.to_string());
    [
        ["pref", &MAIN_PREF.to_string(), "fwmark", &app, "table", "main", "suppress_prefixlength", "1"]
            .map(String::from)
            .to_vec(),
        ["pref", &APP_PREF.to_string(), "fwmark", &app, "table", &app].map(String::from).to_vec(),
        ["pref", &DNS_PREF.to_string(), "fwmark", &dns, "table", &dns].map(String::from).to_vec(),
    ]
}

/// The chosen apps' route: into the tunnel, or out by the uplink.
pub(crate) fn app_route(mode: Mode, plan: &Plan) -> RouteSpec {
    match mode {
        Mode::OnlySelected => RouteSpec {
            dest: "0.0.0.0/0".into(),
            dev: plan.tunnel.clone(),
            via: None,
            table: Some(APP_MARK),
            v6: false,
        },
        Mode::AllExcept => RouteSpec {
            dest: "0.0.0.0/0".into(),
            dev: plan.uplink.dev.clone(),
            via: plan.uplink.via.map(|v| v.to_string()),
            table: Some(APP_MARK),
            v6: false,
        },
    }
}

pub(crate) fn dns_route(plan: &Plan) -> RouteSpec {
    RouteSpec { dest: "0.0.0.0/0".into(), dev: plan.tunnel.clone(), via: None, table: Some(DNS_MARK), v6: false }
}

// ---------------------------------------------------------------------
// Kernel settings

/// Sets a `/proc/sys` value, owing the old one first. `None` when it was
/// already so: nothing is owed for a change that was not made.
pub(crate) fn set_sysctl(path: &Path, value: &str, ledger: &Ledger) -> Result<Option<Owed>, String> {
    let before = std::fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let before = before.trim().to_string();
    if before == value {
        return Ok(None);
    }
    let owed = Owed::Sysctl { path: path.to_path_buf(), before };
    ledger.owe(owed.clone());
    if let Err(e) = std::fs::write(path, value) {
        ledger.settle(&owed);
        return Err(format!("could not set {}: {e}", path.display()));
    }
    Ok(Some(owed))
}

/// Writes an owed setting back. One whose interface has gone took the
/// setting with it.
pub(crate) fn undo_sysctl(path: &Path, before: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::write(path, before).map_err(|e| format!("could not put {} back: {e}", path.display()))
}

fn conf(dev: &str, key: &str) -> PathBuf {
    Path::new("/proc/sys/net/ipv4/conf").join(dev).join(key)
}

fn read_number(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

// ---------------------------------------------------------------------
// The session

/// Custom mode in force around one engine. Everything it changed is owed
/// in the ledger first; dropping it undoes all of it.
pub(crate) struct Split {
    mode: Mode,
    plan: Plan,
    ledger: Ledger,
    run: PathBuf,
    routes: Vec<RouteSpec>,
    rules: Vec<Owed>,
    table: Option<Owed>,
    sysctls: Vec<Owed>,
    sorter: Option<Sorter>,
}

fn check_apps(apps: &[String]) -> Result<(), Problem> {
    for app in apps {
        sorting::valid_app(app).map_err(|e| Problem::Failed(format!("Custom mode cannot use one of the apps: {e}")))?;
    }
    Ok(())
}

impl Split {
    pub(crate) fn install(shape: &Shape, plan: Plan, ledger: &Ledger, run: &Path, budget: &Budget) -> Result<Split, Problem> {
        let Some((mode, apps)) = parts(shape) else {
            return Err(Problem::Failed("Custom mode was asked for without a list of apps".into()));
        };
        check_apps(apps)?;
        if !sorting::unified() {
            return Err(Problem::Failed(sorting::NO_UNIFIED.into()));
        }
        if cmd::find("nft").is_none() {
            return Err(Problem::EngineMissing("nft".into()));
        }
        sorting::ensure_group(SPLIT_GROUP).map_err(Problem::Failed)?;
        // Before this session's rules go in: anything an earlier session or
        // a crashed helper left in the group would be routed as one of this
        // session's chosen apps.
        sorting::evict_all();

        let mut split = Split {
            mode,
            plan,
            ledger: ledger.clone(),
            run: run.to_path_buf(),
            routes: Vec::new(),
            rules: Vec::new(),
            table: None,
            sysctls: Vec::new(),
            sorter: None,
        };
        // From here an early return drops `split`, which undoes it.
        split.loosen_tunnel();
        split.filtering_for(mode)?;
        for spec in [dns_route(&split.plan), app_route(mode, &split.plan)] {
            routes::add(&spec, true, &split.ledger, budget)
                .map_err(|e| e.problem(&format!("add Custom mode's route in table {}", spec.table.unwrap_or(0))))?;
            split.routes.push(spec);
        }
        for args in rule_args() {
            let owed = Owed::Rule { args: args.clone(), v6: false };
            split.ledger.owe(owed.clone());
            let mut all = vec!["-4", "rule", "add"];
            all.extend(args.iter().map(String::as_str));
            match cmd::ip(&all, budget) {
                Ok(_) => split.rules.push(owed),
                Err(e) => {
                    split.ledger.settle(&owed);
                    return Err(e.problem("add Custom mode's routing rule"));
                }
            }
        }
        split.load_table(budget)?;
        split.sorter = Some(Sorter::start(apps).map_err(Problem::Failed)?);
        Ok(split)
    }

    /// The tunnel answers for addresses that are not its own (the
    /// masqueraded connections), so its reverse-path filtering is made
    /// loose. Not owed: the setting belongs to the interface and goes
    /// with it.
    fn loosen_tunnel(&self) {
        let _ = std::fs::write(conf(&self.plan.tunnel, "rp_filter"), "2");
    }

    /// With strict reverse-path filtering on the uplink, replies to the
    /// chosen apps (`AllExcept`) come in where the main table would not
    /// send their source; the kernel is told to judge them by their mark.
    fn filtering_for(&mut self, mode: Mode) -> Result<(), Problem> {
        if mode != Mode::AllExcept {
            return Ok(());
        }
        let dev = &self.plan.uplink.dev;
        let strict = read_number(&conf("all", "rp_filter")).unwrap_or(0).max(read_number(&conf(dev, "rp_filter")).unwrap_or(0)) == 1;
        let marks_count = read_number(&conf("all", "src_valid_mark")) == Some(1);
        if strict && !marks_count {
            if let Some(owed) = set_sysctl(&conf(dev, "src_valid_mark"), "1", &self.ledger).map_err(Problem::Failed)? {
                self.sysctls.push(owed);
            }
        }
        Ok(())
    }

    fn load_table(&mut self, budget: &Budget) -> Result<(), Problem> {
        let owed = Owed::NftTable { family: NFT_FAMILY.into(), name: NFT_TABLE.into() };
        self.ledger.owe(owed.clone());
        self.table = Some(owed);
        let _ = std::fs::create_dir_all(&self.run);
        let path = self.run.join(SCRIPT_FILE);
        crate::files::write_private(&path, ruleset(self.mode, &self.plan).as_bytes())
            .map_err(|e| Problem::Failed(format!("could not write Custom mode's firewall rules: {e}")))?;
        let path_arg = path.to_string_lossy().into_owned();
        let loaded = cmd::run("nft", &["-f", &path_arg], budget);
        let _ = std::fs::remove_file(&path);
        match loaded {
            Ok(out) if out.success => Ok(()),
            Ok(out) => Err(Problem::Failed(format!("the firewall refused Custom mode's rules: {}", out.complaint()))),
            Err(e) => Err(e.problem("load Custom mode's firewall rules")),
        }
    }

    /// A new list or mode with everything else left as it is. The chosen
    /// apps' route is replaced in one step and the table in one
    /// transaction, so there is no moment between the two shapes.
    pub(crate) fn reshape(&mut self, shape: &Shape, budget: &Budget) -> Result<(), Problem> {
        let Some((mode, apps)) = parts(shape) else {
            return Err(Problem::Failed("Custom mode was asked for without a list of apps".into()));
        };
        check_apps(apps)?;
        if mode != self.mode {
            let old = app_route(self.mode, &self.plan);
            let new = app_route(mode, &self.plan);
            self.filtering_for(mode)?;
            routes::add(&new, true, &self.ledger, budget).map_err(|e| e.problem("change Custom mode's route"))?;
            if new != old {
                self.ledger.settle(&Owed::Route(old.clone()));
                self.routes.retain(|r| *r != old);
            }
            self.routes.push(new);
            let before = self.mode;
            self.mode = mode;
            if let Err(problem) = self.load_table(budget) {
                // Back to the earlier mode's route; the earlier table is
                // still loaded, as a refused transaction changes nothing.
                self.mode = before;
                let back = app_route(before, &self.plan);
                if routes::add(&back, true, &self.ledger, budget).is_ok() {
                    self.ledger.settle(&Owed::Route(app_route(mode, &self.plan)));
                    self.routes.retain(|r| *r != app_route(mode, &self.plan));
                    self.routes.push(back);
                }
                return Err(problem);
            }
        }
        if let Some(sorter) = &self.sorter {
            sorter.set_apps(apps);
        }
        Ok(())
    }

    /// What the kernel holds now, read back.
    pub(crate) fn state(&self) -> SplitState {
        let budget = Budget::quick(Duration::from_secs(3));
        let restart_needed = self.sorter.as_ref().map(Sorter::restart_needed).unwrap_or_default();
        if !link::exists(&self.plan.tunnel) {
            return SplitState {
                active: false,
                problem: Some((
                    "the tunnel interface went away, so the chosen apps are on the ordinary connection".into(),
                    SplitTunnelProblemCode::AdapterGone,
                )),
                restart_needed,
            };
        }
        let mut missing = Vec::new();
        let table = cmd::run("nft", &["-j", "list", "table", NFT_FAMILY, NFT_TABLE], &budget);
        if !table.is_ok_and(|out| out.success && table_in_force(&out.stdout)) {
            missing.push("firewall table");
        }
        if !cmd::ip(&["-j", "-4", "rule", "show"], &budget).is_ok_and(|json| rules_in_force(&json)) {
            missing.push("routing rules");
        }
        for spec in [app_route(self.mode, &self.plan), dns_route(&self.plan)] {
            let table = spec.table.unwrap_or(0).to_string();
            let shown = cmd::ip(&["-j", "-4", "route", "show", "table", &table], &budget);
            if !shown.is_ok_and(|json| table_routes_via(&json, &spec.dev)) {
                missing.push("routing table");
                break;
            }
        }
        let problem = (!missing.is_empty()).then(|| {
            (format!("Custom mode is not fully in place (missing: {})", missing.join(", ")), SplitTunnelProblemCode::Other)
        });
        SplitState { active: missing.is_empty(), problem, restart_needed }
    }

    /// The fast half: the table, the rules and the routes out, so every
    /// program is back on the engine's own shape at once.
    pub(crate) fn hard_stop(&mut self) {
        let budget = Budget::quick(cmd::TEARDOWN_CAP);
        if let Some(sorter) = &self.sorter {
            sorter.stop();
        }
        if let Some(owed) = self.table.take() {
            match delete_table(&budget) {
                Ok(()) => self.ledger.settle(&owed),
                Err(_) => self.table = Some(owed),
            }
        }
        let mut kept = Vec::new();
        for owed in std::mem::take(&mut self.rules).into_iter().rev() {
            match crate::cleanup::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => kept.push(owed),
            }
        }
        kept.reverse();
        self.rules = kept;
        for spec in std::mem::take(&mut self.routes) {
            if routes::remove(&spec, &self.ledger, &budget).is_err() {
                self.routes.push(spec);
            }
        }
    }

    /// The thorough half: the processes back where they were, the kernel
    /// settings back, and anything the fast half could not remove.
    pub(crate) fn finish_stop(&mut self) {
        self.hard_stop();
        if let Some(mut sorter) = self.sorter.take() {
            sorter.finish();
        }
        for owed in std::mem::take(&mut self.sysctls) {
            if let Owed::Sysctl { path, before } = &owed {
                match undo_sysctl(path, before) {
                    Ok(()) => self.ledger.settle(&owed),
                    Err(_) => self.sysctls.push(owed),
                }
            }
        }
    }
}

impl Drop for Split {
    fn drop(&mut self) {
        self.finish_stop();
    }
}

pub(crate) fn delete_table(budget: &Budget) -> Result<(), String> {
    match cmd::run("nft", &["delete", "table", NFT_FAMILY, NFT_TABLE], budget) {
        Ok(out) if out.success => Ok(()),
        Ok(out) if out.complaint().contains("No such file or directory") => Ok(()),
        Ok(out) => Err(out.complaint()),
        Err(cmd::RunError::Missing(_)) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------
// Reading back

/// Whether `nft -j list table inet neoxify_split` shows the sorting: the
/// route chain on output with the group's mark rule, the lookups chain
/// dropping port 53, and the masquerade.
pub(crate) fn table_in_force(json: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(json) else { return false };
    let Some(items) = parsed["nftables"].as_array() else { return false };
    let chain_on = |name: &str, hook: &str| {
        items.iter().any(|i| i["chain"]["name"] == name && i["chain"]["hook"] == hook && i["chain"]["table"] == NFT_TABLE)
    };
    let rule_in = |chain: &str, needles: &[&str]| {
        items.iter().filter(|i| i["rule"]["chain"] == chain && i["rule"]["table"] == NFT_TABLE).any(|i| {
            let text = i["rule"]["expr"].to_string();
            needles.iter().all(|n| text.contains(n))
        })
    };
    chain_on("sort", "output")
        && chain_on("lookups", "postrouting")
        && chain_on("nat", "postrouting")
        && rule_in("sort", &["cgroupv2", &APP_MARK.to_string()])
        && rule_in("sort", &["53", &DNS_MARK.to_string()])
        && rule_in("lookups", &["\"drop\""])
        && rule_in("nat", &["masquerade"])
}

/// Whether `ip -j -4 rule show` holds our three rules.
pub(crate) fn rules_in_force(json: &str) -> bool {
    let Ok(Value::Array(rules)) = serde_json::from_str::<Value>(json) else { return false };
    let table_of = |r: &Value| match &r["table"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let has = |pref: u32, table: &str| {
        rules.iter().any(|r| r["priority"].as_u64() == Some(pref as u64) && table_of(r) == table && r.get("fwmark").is_some())
    };
    has(MAIN_PREF, "main") && has(APP_PREF, &APP_MARK.to_string()) && has(DNS_PREF, &DNS_MARK.to_string())
}

/// Whether a routing table's listing has a default route on `dev`.
pub(crate) fn table_routes_via(json: &str, dev: &str) -> bool {
    routes::parse_rows(json).iter().any(|r| r.dst == "default" && r.dev.as_deref() == Some(dev))
}

/// Our rules if a helper that died left them, by priority and table.
pub(crate) fn leftover_rules(json: &str) -> Vec<u32> {
    let Ok(Value::Array(rules)) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut out: Vec<u32> = rules
        .iter()
        .filter_map(|r| {
            let pref = r["priority"].as_u64()? as u32;
            let table = match &r["table"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return None,
            };
            let ours = (pref == MAIN_PREF && table == "main")
                || (pref == APP_PREF && table == APP_MARK.to_string())
                || (pref == DNS_PREF && table == DNS_MARK.to_string());
            (ours && r.get("fwmark").is_some()).then_some(pref)
        })
        .collect();
    out.dedup();
    out
}

/// After a crash: the table and the rules. The routes carry our protocol
/// and go with every other route of ours; the groups stay.
pub(crate) fn sweep(budget: &Budget) -> Vec<String> {
    let mut lines = Vec::new();
    if cmd::run("nft", &["list", "table", NFT_FAMILY, NFT_TABLE], budget).is_ok_and(|o| o.success) {
        match delete_table(budget) {
            Ok(()) => lines.push(format!("removed the leftover firewall table {NFT_FAMILY} {NFT_TABLE}")),
            Err(e) => lines.push(format!("could not remove the leftover firewall table {NFT_FAMILY} {NFT_TABLE}: {e}")),
        }
    }
    let Ok(text) = cmd::ip(&["-j", "-4", "rule", "show"], budget) else { return lines };
    let all = rule_args();
    for pref in leftover_rules(&text) {
        let Some(args) = all.iter().find(|a| a[1] == pref.to_string()) else { continue };
        let mut cmdline = vec!["-4", "rule", "del"];
        cmdline.extend(args.iter().map(String::as_str));
        match cmd::ip(&cmdline, budget) {
            Ok(_) => lines.push(format!("removed a leftover Custom mode routing rule (priority {pref})")),
            Err(e) if e.already_gone() => {}
            Err(e) => lines.push(format!("could not remove a leftover Custom mode routing rule (priority {pref}): {e}")),
        }
    }
    lines
}

// ---------------------------------------------------------------------
// The probe

/// Where the probe connects: two anycast resolvers' HTTPS ports, as on
/// Windows, so one provider's outage is not read as the tunnel's.
const PROBE_TARGETS: [(Ipv4Addr, u16); 2] = [(Ipv4Addr::new(1, 1, 1, 1), 443), (Ipv4Addr::new(8, 8, 8, 8), 443)];
const PROBE_EACH: Duration = Duration::from_secs(5);

/// Does a connection made on the tunnel interface itself get an answer
/// from the internet? The socket is bound to the interface
/// (`SO_BINDTODEVICE`), so it cannot leave any other way whatever the
/// routes say. Xray's tun completes a TCP handshake itself before it has
/// dialled anything, so a handshake proves nothing there: a request is
/// sent and only bytes coming back count.
pub(crate) fn probe(iface: &str, limits: &Limits) -> Result<(), String> {
    let budget = Budget::within(limits, Duration::from_secs(12));
    let mut why = Vec::new();
    for (ip, port) in PROBE_TARGETS {
        match probe_one(iface, ip, port, &budget) {
            Ok(()) => return Ok(()),
            Err(e) => why.push(format!("{ip}: {e}")),
        }
        if budget.check().is_err() {
            break;
        }
    }
    Err(format!("nothing answered through the tunnel ({})", why.join("; ")))
}

fn probe_one(iface: &str, ip: Ipv4Addr, port: u16, budget: &Budget) -> Result<(), String> {
    let until = Instant::now() + PROBE_EACH;
    let name = CString::new(iface).map_err(|_| "bad interface name".to_string())?;
    let last = || std::io::Error::last_os_error().to_string();
    // SAFETY: plain socket calls on a descriptor this function owns; every
    // pointer passed is to a live local of the size given.
    unsafe {
        let raw = libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0);
        if raw < 0 {
            return Err(last());
        }
        let fd = OwnedFd::from_raw_fd(raw);
        let bytes = name.as_bytes_with_nul();
        if libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_BINDTODEVICE,
            bytes.as_ptr().cast(),
            bytes.len() as libc::socklen_t,
        ) != 0
        {
            return Err(format!("could not bind to {iface}: {}", last()));
        }
        let addr = libc::sockaddr_in {
            sin_family: libc::AF_INET as libc::sa_family_t,
            sin_port: port.to_be(),
            sin_addr: libc::in_addr { s_addr: u32::from_ne_bytes(ip.octets()) },
            sin_zero: [0; 8],
        };
        let rc = libc::connect(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        );
        if rc != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(last());
        }
        wait_for(&fd, libc::POLLOUT, until, budget)?;
        let mut err: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        libc::getsockopt(fd.as_raw_fd(), libc::SOL_SOCKET, libc::SO_ERROR, (&mut err as *mut libc::c_int).cast(), &mut len);
        if err != 0 {
            return Err(std::io::Error::from_raw_os_error(err).to_string());
        }
        // Plain HTTP on the HTTPS port: both answer it with something (an
        // error page or a TLS alert), which is all the probe needs.
        let request = b"HEAD / HTTP/1.1\r\nHost: probe.invalid\r\nConnection: close\r\n\r\n";
        if libc::send(fd.as_raw_fd(), request.as_ptr().cast(), request.len(), libc::MSG_NOSIGNAL) < 0 {
            return Err(last());
        }
        wait_for(&fd, libc::POLLIN, until, budget)?;
        let mut buf = [0u8; 64];
        let got = libc::recv(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0);
        if got > 0 {
            Ok(())
        } else if got == 0 {
            Err("closed with no answer".into())
        } else {
            Err(last())
        }
    }
}

fn wait_for(fd: &OwnedFd, events: libc::c_short, until: Instant, budget: &Budget) -> Result<(), String> {
    loop {
        budget.check().map_err(|stop| match stop {
            cmd::Stop::Cancelled => "cancelled".to_string(),
            cmd::Stop::TimedOut => "no answer in time".to_string(),
        })?;
        if Instant::now() >= until {
            return Err("no answer in time".into());
        }
        let mut pfd = libc::pollfd { fd: fd.as_raw_fd(), events, revents: 0 };
        // SAFETY: one pollfd, owned by this frame.
        let rc = unsafe { libc::poll(&mut pfd, 1, cmd::POLL.as_millis() as libc::c_int) };
        if rc < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e.to_string());
        }
        if rc > 0 {
            return Ok(());
        }
    }
}

// ---------------------------------------------------------------------
// Engines

/// Custom mode's part of an engine: the shape in force, the sorting when
/// there is one, and what it needs to install one.
pub(crate) struct Custom {
    pub shape: Shape,
    pub split: Option<Split>,
    pub plan: Plan,
    pub ledger: Ledger,
    pub run: PathBuf,
    /// Whether the engine can move between `Full` and Custom mode with
    /// the engine left running. OpenVPN cannot: its server pushes the
    /// routes that take the machine, and they are its own.
    pub across_full: bool,
}

impl Custom {
    pub(crate) fn new(shape: &Shape, plan: Plan, ledger: &Ledger, run: &Path, across_full: bool) -> Self {
        Custom { shape: shape.clone(), split: None, plan, ledger: ledger.clone(), run: run.to_path_buf(), across_full }
    }

    /// At connect, once the engine is up and before DNS is pointed at it.
    pub(crate) fn install(&mut self, budget: &Budget) -> Result<(), Problem> {
        if self.shape.is_split() {
            self.split = Some(Split::install(&self.shape, self.plan.clone(), &self.ledger, &self.run, budget)?);
        }
        Ok(())
    }

    pub(crate) fn state(&self) -> Option<SplitState> {
        self.split.as_ref().map(Split::state)
    }

    pub(crate) fn hard_stop(&mut self) {
        if let Some(split) = self.split.as_mut() {
            split.hard_stop();
        }
    }

    pub(crate) fn finish_stop(&mut self) {
        if let Some(mut split) = self.split.take() {
            split.finish_stop();
        }
    }
}

/// What each engine does to take, or stop taking, the whole machine's
/// traffic -- the one thing that differs between them in Custom mode.
pub(crate) trait Engine {
    fn take_everything(&mut self, budget: &Budget) -> Result<(), Problem>;
    fn release_everything(&mut self, budget: &Budget);
    fn custom(&mut self) -> &mut Custom;
}

/// The `Tunnel::reshape` of every engine. The engine takes the machine
/// before anything that relies on it changes, and lets it go only after;
/// on an error what was changed is put back.
pub(crate) fn reshape<E: Engine>(engine: &mut E, to: &Shape, limits: &Limits) -> Result<(), Problem> {
    if let Some((_, apps)) = parts(to) {
        check_apps(apps)?;
    }
    let from = engine.custom().shape.clone();
    if &from == to {
        return Ok(());
    }
    if from.is_split() != to.is_split() && !engine.custom().across_full {
        return Err(Problem::Failed("turning Custom mode on or off needs a reconnect with this protocol".into()));
    }
    let budget = Budget::within(limits, Duration::from_secs(30));
    let (had, want) = (takes_everything(&from), takes_everything(to));
    if want && !had {
        engine.take_everything(&budget)?;
    }
    let custom = engine.custom();
    let result = if to.is_split() {
        match custom.split.as_mut() {
            Some(split) => split.reshape(to, &budget),
            None => Split::install(to, custom.plan.clone(), &custom.ledger, &custom.run, &budget).map(|split| {
                custom.split = Some(split);
            }),
        }
    } else {
        custom.finish_stop();
        Ok(())
    };
    if let Err(problem) = result {
        if want && !had {
            engine.release_everything(&budget);
        }
        return Err(problem);
    }
    if had && !want {
        engine.release_everything(&budget);
    }
    engine.custom().shape = to.clone();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            tunnel: "neoconnect0".into(),
            uplink: Uplink { dev: "enp0s3".into(), via: Some(Ipv4Addr::new(10, 0, 2, 2)) },
            servers: vec![Ipv4Addr::new(203, 0, 113, 5), Ipv4Addr::new(198, 51, 100, 9)],
            engine_mark: None,
        }
    }

    #[test]
    fn the_script_replaces_our_table_in_one_go_and_touches_no_other() {
        let s = ruleset(Mode::OnlySelected, &plan());
        assert!(s.starts_with("table inet neoxify_split {}\ndelete table inet neoxify_split\ntable inet neoxify_split {\n"));
        assert!(!s.contains("table inet neoxify {"), "never the leak-protection table");
        assert!(!s.contains("flush ruleset"));
        assert!(s.contains("elements = { 203.0.113.5, 198.51.100.9 }"));
    }

    #[test]
    fn the_chosen_apps_are_marked_and_lookups_always_go_into_the_tunnel() {
        for mode in [Mode::OnlySelected, Mode::AllExcept] {
            let s = ruleset(mode, &plan());
            assert!(s.contains("type route hook output priority mangle"), "{mode:?}: a route chain re-routes");
            assert!(s.contains("socket cgroupv2 level 1 \"neoxify.split\" meta mark set 28281 ct mark set 28281"));
            let dns = s.find("th dport 53 meta mark set 28282").unwrap();
            let apps = s.find("meta mark set 28281").unwrap();
            assert!(dns < apps, "{mode:?}: a lookup is a lookup before it is an app's packet");
            assert!(s.find("ip daddr @servers return").unwrap() < dns, "the engine's own traffic is never moved");
            let restore = s.find("ct mark { 28281, 28282 } meta mark set ct mark return").unwrap();
            assert!(restore < dns, "{mode:?}: a packet with no socket goes the way its connection was sorted");
            assert!(s.contains("oifname { \"lo\", \"neoconnect0\" } accept"));
            assert!(s.contains("meta l4proto { tcp, udp } th dport 53 drop"));
            assert!(s.contains("type filter hook postrouting priority filter"), "judged after re-routing");
            assert!(s.contains("oifname \"neoconnect0\" meta mark { 28281, 28282 } masquerade"));
        }
    }

    #[test]
    fn each_mode_refuses_ipv6_for_what_belongs_in_the_tunnel() {
        let only = ruleset(Mode::OnlySelected, &plan());
        assert!(only.contains("socket cgroupv2 level 1 \"neoxify.split\" reject"));
        assert!(!only.contains("enp0s3"), "the uplink is not named when nothing is sent out by it");
        let except = ruleset(Mode::AllExcept, &plan());
        assert!(except.contains("socket cgroupv2 level 1 \"neoxify.split\" accept"));
        assert!(except.contains("nd-neighbor-solicit"), "neighbour discovery keeps working");
        assert!(except.contains("\t\treject\n"));
        assert!(except.contains("oifname \"enp0s3\" meta mark 28281 masquerade"));
    }

    #[test]
    fn wireguards_own_packets_are_left_alone() {
        let wg = Plan { tunnel: "neoxify-wg".into(), engine_mark: Some(28280), ..plan() };
        let s = ruleset(Mode::AllExcept, &wg);
        assert!(s.contains("meta mark 28280 return"));
        assert!(s.contains("meta mark 28280 accept"));
        assert!(!ruleset(Mode::AllExcept, &plan()).contains("28280"));
    }

    /// The scripts as `nft` will be handed them, written where
    /// `NEOXIFY_WRITE_RULESETS` says, for `nft -c -f` on a test machine.
    #[test]
    fn rulesets_for_the_firewall_to_check() {
        let Some(dir) = std::env::var_os("NEOXIFY_WRITE_RULESETS") else { return };
        let wg = Plan { tunnel: "neoxify-wg".into(), engine_mark: Some(28280), ..plan() };
        for (name, mode, plan) in [
            ("only", Mode::OnlySelected, plan()),
            ("except", Mode::AllExcept, plan()),
            ("wg-except", Mode::AllExcept, wg),
        ] {
            std::fs::write(Path::new(&dir).join(format!("{name}.nft")), ruleset(mode, &plan)).unwrap();
        }
    }

    #[test]
    fn no_servers_is_an_empty_set_not_a_broken_one() {
        let s = ruleset(Mode::OnlySelected, &Plan { servers: vec![], ..plan() });
        assert!(s.contains("set servers {\n\t\ttype ipv4_addr\n\t}"));
    }

    #[test]
    fn the_rules_come_before_wireguards_and_keep_the_local_network() {
        let [main, app, dns] = rule_args();
        assert_eq!(main, ["pref", "28275", "fwmark", "28281", "table", "main", "suppress_prefixlength", "1"]);
        assert_eq!(app, ["pref", "28276", "fwmark", "28281", "table", "28281"]);
        assert_eq!(dns, ["pref", "28277", "fwmark", "28282", "table", "28282"]);
        assert!(DNS_PREF < crate::wireguard::SUPPRESS_PREF);
    }

    #[test]
    fn the_apps_route_leads_the_way_the_mode_says() {
        let into = app_route(Mode::OnlySelected, &plan());
        assert_eq!(into.add_args(), ["route", "add", "0.0.0.0/0", "dev", "neoconnect0", "table", "28281", "proto", "98"]);
        let around = app_route(Mode::AllExcept, &plan());
        assert_eq!(
            around.add_args(),
            ["route", "add", "0.0.0.0/0", "via", "10.0.2.2", "dev", "enp0s3", "table", "28281", "proto", "98"]
        );
        assert_eq!(dns_route(&plan()).dev, "neoconnect0");
    }

    #[test]
    fn our_rules_are_read_back_and_nobody_elses() {
        // `ip -j -4 rule show` with ours and WireGuard's in, iproute2 6.1.
        let json = r#"[{"priority":0,"src":"all","table":"local"},{"priority":28275,"src":"all","fwmark":"0x6e79","table":"main","suppress_prefixlen":1},{"priority":28276,"src":"all","fwmark":"0x6e79","table":"28281"},{"priority":28277,"src":"all","fwmark":"0x6e7a","table":"28282"},{"priority":28278,"src":"all","table":"main","suppress_prefixlen":0},{"priority":32766,"src":"all","table":"main"}]"#;
        assert!(rules_in_force(json));
        assert_eq!(leftover_rules(json), vec![28275, 28276, 28277]);
        let without = r#"[{"priority":0,"src":"all","table":"local"},{"priority":28276,"src":"all","table":"28281"},{"priority":32766,"src":"all","table":"main"}]"#;
        assert!(!rules_in_force(without));
        assert!(leftover_rules(without).is_empty(), "a rule with no mark is not ours");
        assert!(!rules_in_force("garbage"));
    }

    #[test]
    fn a_routing_table_is_read_back() {
        let json = r#"[{"dst":"default","dev":"neoconnect0","protocol":"98","scope":"link","flags":[]}]"#;
        assert!(table_routes_via(json, "neoconnect0"));
        assert!(!table_routes_via(json, "enp0s3"));
        assert!(!table_routes_via("[]", "neoconnect0"));
    }

    #[test]
    fn the_table_is_read_back_from_nfts_own_listing() {
        let json = include_str!("../testdata/split-table.json");
        assert!(table_in_force(json));
        assert!(!table_in_force(r#"{"nftables":[{"metainfo":{"version":"1.0.9"}}]}"#));
        assert!(!table_in_force("garbage"));
    }

    #[test]
    fn a_setting_is_owed_only_when_changed_and_put_back() {
        let dir = std::env::temp_dir().join(format!("neoxify-sysctl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("src_valid_mark");
        std::fs::write(&path, "0\n").unwrap();
        let ledger = Ledger::in_dir(&dir);
        let owed = set_sysctl(&path, "1", &ledger).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1");
        assert_eq!(ledger.read(), vec![owed.clone()]);
        assert_eq!(set_sysctl(&path, "1", &ledger).unwrap(), None, "already so: nothing more owed");
        let Owed::Sysctl { path: p, before } = &owed else { panic!() };
        assert_eq!(before, "0");
        undo_sysctl(p, before).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0");
        assert_eq!(undo_sysctl(&dir.join("gone"), "0"), Ok(()), "an interface that went took its setting");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
