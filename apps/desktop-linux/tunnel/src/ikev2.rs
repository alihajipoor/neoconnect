//! IKEv2 through the distribution's strongSwan: `charon-cmd` with its
//! `kernel-libipsec` plugin, so the tunnel is a TUN interface like every
//! other engine's and not kernel IPsec policies that no route or firewall
//! rule of ours could name.
//!
//! What the nodes require (installer `install_ikev2`): the server proves
//! itself with a Let's Encrypt certificate for its host name, the client
//! with EAP-MSCHAPv2 whose identity is the username, an IPv4 virtual
//! address from the pool, and the whole IPv4 internet behind it. The
//! server never sends dead-peer detection, so ours does (`charon-cmd`
//! sends it every 30 seconds by itself) and the process exits when the
//! server stops answering, which is how a dead tunnel shows here.
//!
//! The configuration is our own `strongswan.conf`, root-only in
//! `Dirs::run` and handed over with `STRONGSWAN_CONF`, so nothing in
//! `/etc` is read or changed. It loads only the plugins this needs and in
//! particular not `resolve`, so strongSwan never rewrites resolv.conf: DNS
//! and routes are the helper's, as for every engine. The password goes in
//! on standard input, the one place `charon-cmd` reads it from without a
//! terminal; it is never on a command line or in a file.
//!
//! `kernel-libipsec` installs its own routes whatever `install_routes`
//! says: a default route into its TUN in a routing table and a rule
//! sending everything there. Both are pointed out of the way (a table of
//! ours, a rule ordered after the main table) so they never decide where a
//! packet goes, and the routes that do are ours, put in and taken out by
//! [`IkeTunnel::take_everything`] and [`IkeTunnel::release_everything`].
//!
//! Custom mode works as for the other engines (`split`): the TUN is an
//! ordinary interface, so the chosen apps are routed into it, or around
//! it, by their control group. Its name is only known once strongSwan has
//! made it, so the plan is completed then.

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, Ikev2Profile};

use crate::cmd::{self, Budget};
use crate::ledger::{Ledger, Owed, RouteSpec};
use crate::split::{self, Custom, Engine, Plan};
use crate::{dns, link, process, routes};
use crate::{Dirs, Limits, Problem, Proto, Shape, SplitState, Transport, Tunnel, TunnelHealth, Up};

/// The system program, found in the system directories only.
pub const PROGRAM: &str = "charon-cmd";
/// Our `strongswan.conf`, in `Dirs::run`. Its name is also how an
/// orphaned `charon-cmd` is known to be ours: no one else writes it.
pub const CONFIG_FILE: &str = "neoxify-ikev2.conf";
/// strongSwan's own log, written line by line (its standard output is
/// block-buffered when it is not a terminal, so it cannot be read live).
pub const LOG_FILE: &str = "ikev2.log";
/// What `charon-cmd` writes to its standard output and error: the
/// password prompt and anything it says before its log is open.
pub const OUT_FILE: &str = "ikev2.out";

/// The routing table and rule priority `kernel-libipsec` is given for the
/// routes it insists on adding. After the main table (32766) and the
/// `default` table (32767), so the rule is only reached by a packet the
/// machine has no route for at all, and never while ours are in. The
/// table number sits after WireGuard's 28280 and Custom mode's 28281 and
/// 28282; sharing one with Custom mode would have the flush of
/// strongSwan's leftovers empty Custom mode's table too.
pub const STRONGSWAN_TABLE: u32 = 28283;
pub const STRONGSWAN_RULE_PREF: u32 = 32900;

/// The interface names `kernel-libipsec` gives its TUN (`ipsec%d`; there
/// is no setting for it). Which one is ours is read from the process.
const TUN_PREFIX: &str = "ipsec";

/// The ports the server listens on. `charon-cmd` goes straight to 4500,
/// because `kernel-libipsec` carries ESP inside UDP, but the server may
/// still be asked on 500.
const IKE_PORT: u16 = 500;
const NAT_T_PORT: u16 = 4500;

/// What is offered, in order. The server's own first choices, then the
/// suite the Windows client is pinned to and the node accepts. No PFS
/// group on ESP: the first child SA is made in IKE_AUTH, where one would
/// be ignored, and the node never rekeys (`rekey_time = 0s`).
const IKE_PROPOSALS: [&str; 2] = ["aes256gcm16-prfsha384-ecp384", "aes256-sha256-modp2048"];
const ESP_PROPOSALS: [&str; 2] = ["aes256gcm16", "aes256-sha256"];

/// Plugins loaded and nothing else. `md4` and `des` are what EAP-MSCHAPv2
/// needs where OpenSSL's legacy provider is not there (Fedora); a plugin
/// that is not installed is skipped by strongSwan with a line in the log.
const PLUGINS: &str = "random nonce openssl pem pkcs1 pkcs8 x509 pubkey constraints kdf md4 des \
                       kernel-libipsec kernel-netlink socket-default eap-identity eap-mschapv2";

/// Where the distributions keep their plugins, and the two this needs
/// that are packaged apart from `charon-cmd`.
const PLUGIN_DIRS: [&str; 4] =
    ["/usr/lib/ipsec/plugins", "/usr/lib64/strongswan/plugins", "/usr/lib/strongswan/plugins", "/usr/lib64/ipsec/plugins"];
const NEEDED_PLUGINS: [&str; 2] = ["libstrongswan-kernel-libipsec.so", "libstrongswan-eap-mschapv2.so"];

/// The machine's trusted roots, one certificate per `.pem` file: Debian
/// and Ubuntu's `/etc/ssl/certs`, Fedora's extracted directory. strongSwan
/// reads no system store by itself, so each is handed over with `--cert`,
/// which takes a CA certificate as a trust anchor.
const ROOT_DIRS: [&str; 2] = ["/etc/ssl/certs", "/etc/pki/ca-trust/extracted/pem/directory-hash"];

/// What to install, said so a customer can act on it. Shown as "... is
/// missing from the install".
pub(crate) const MISSING: &str = "strongSwan for Built-in (IKEv2) (the packages charon-cmd, \
     libcharon-extra-plugins and libcharon-extauth-plugins on Debian and Ubuntu; strongswan and \
     strongswan-libipsec on Fedora)";

/// How long the server gets to finish the exchange: a ceiling on a poll,
/// and the caller's deadline still bounds it. An unanswered server is
/// given up on by strongSwan itself well before this (see the retransmit
/// settings in [`build_config`]).
const TUNNEL_UP_WITHIN: Duration = Duration::from_secs(45);

/// How long a stopped `charon-cmd` gets to send the server its DELETE and
/// exit before it is killed. It took 0.2 s against a real node.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// strongSwan's word that the tunnel carries: the child SA, with its
/// traffic selectors, is in place. The IKE SA alone is not enough.
const CHILD_UP_MARK: &str = "CHILD_SA cmd{1} established";

pub(crate) struct IkeTunnel {
    up: Up,
    child: Option<Child>,
    ledger: Ledger,
    /// The host route to the server, and the routes into the tunnel.
    routes: Vec<RouteSpec>,
    /// strongSwan's rule, owed before it starts: one killed never takes it
    /// back.
    rules: Vec<Owed>,
    config_owed: Option<Owed>,
    dns: Option<Owed>,
    baseline: Option<(u64, u64)>,
    /// The TUN `kernel-libipsec` made, once known.
    iface: Option<String>,
    log: PathBuf,
    out: PathBuf,
    server: Ipv4Addr,
    signalled: bool,
    /// When the log was first seen ending on retransmits, for the age of
    /// a stale link. Cleared when the server answers again.
    unanswered_since: Option<Instant>,
    /// Custom mode: the shape, and the sorting when there is one. Its
    /// plan names the TUN once strongSwan has made it.
    custom: Custom,
}

/// The `strongswan.conf` for one connection. `log` is where strongSwan
/// writes its log line by line.
pub(crate) fn build_config(log: &Path) -> Result<String, Problem> {
    let path = log.to_string_lossy();
    if path.contains(['"', '\n', '\\', '}', '{']) {
        return Err(Problem::Failed("the IKEv2 log path cannot be written into strongSwan's settings".into()));
    }
    // Three tries two seconds apart, growing by half: about 16 s before an
    // unanswered server is given up on, at the start and when dead-peer
    // detection stops getting answers. strongSwan's own default is close
    // to three minutes, which no one waits through.
    Ok(format!(
        "# Written by Neoxify for one IKEv2 connection and deleted when it ends.\n\
         charon-cmd {{\n\
         \x20 load = {PLUGINS}\n\
         \x20 install_routes = no\n\
         \x20 install_virtual_ip = yes\n\
         \x20 routing_table = {STRONGSWAN_TABLE}\n\
         \x20 routing_table_prio = {STRONGSWAN_RULE_PREF}\n\
         \x20 retransmit_tries = 3\n\
         \x20 retransmit_timeout = 2.0\n\
         \x20 retransmit_base = 1.5\n\
         \x20 filelog {{\n\
         \x20   neoxify {{\n\
         \x20     path = \"{path}\"\n\
         \x20     default = 1\n\
         \x20     flush_line = yes\n\
         \x20   }}\n\
         \x20 }}\n\
         \x20 plugins {{\n\
         \x20   kernel-libipsec {{\n\
         \x20     allow_peer_ts = no\n\
         \x20   }}\n\
         \x20 }}\n\
         }}\n"
    ))
}

/// A host name `charon-cmd` can take as the identity to expect: letters,
/// digits, dots and hyphens, as `check_hostname` in the IPC layer allows.
fn plausible_host(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && !name.starts_with(['-', '.'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && name.parse::<Ipv4Addr>().is_err()
}

/// The arguments after `charon-cmd`. The server is dialled by address
/// (resolved by us, so strongSwan never looks it up through a DNS that by
/// then points into the tunnel) and checked by name: its certificate must
/// be for exactly the name we were given.
pub(crate) fn build_args(server: Ipv4Addr, name: &str, username: &str, roots: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = [
        "--debug",
        "0",
        "--host",
        &server.to_string(),
        "--remote-identity",
        name,
        "--identity",
        username,
        "--eap-identity",
        username,
        "--profile",
        "ikev2-eap",
        "--remote-ts",
        "0.0.0.0/0",
    ]
    .map(String::from)
    .to_vec();
    for p in IKE_PROPOSALS {
        args.extend(["--ike-proposal".to_string(), p.to_string()]);
    }
    for p in ESP_PROPOSALS {
        args.extend(["--esp-proposal".to_string(), p.to_string()]);
    }
    for root in roots {
        args.extend(["--cert".to_string(), root.to_string_lossy().into_owned()]);
    }
    args
}

/// The trusted roots from the first directory that has any.
pub(crate) fn trust_roots_in(dirs: &[&str]) -> Vec<PathBuf> {
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "pem") && p.is_file())
            .collect();
        if !found.is_empty() {
            found.sort();
            return found;
        }
    }
    Vec::new()
}

/// Whether the plugins packaged apart from `charon-cmd` are installed.
/// `None` when no plugin directory this knows is there at all: a layout
/// this has not seen is left to strongSwan to judge.
fn plugins_present() -> Option<bool> {
    let dir = PLUGIN_DIRS.iter().map(Path::new).find(|d| d.is_dir())?;
    Some(NEEDED_PLUGINS.iter().all(|p| dir.join(p).is_file()))
}

/// Why strongSwan gave up, from its log, as the sentence the app sorts.
/// The wording follows the Windows engine's (`dial_error`) so a customer
/// is told the same thing on both: a refused password and a refused
/// certificate are not a server that did not answer, and neither may read
/// as one (no "timed out", "refused" or "handshake" in either).
pub(crate) fn failure_from_log(log: &str) -> Problem {
    let has = |needle: &str| log.contains(needle);
    // Only the two packaged apart; `md4` and `des` are expected to be
    // absent where OpenSSL provides them.
    if has("plugin 'kernel-libipsec' failed to load") || has("plugin 'eap-mschapv2' failed to load") {
        return Problem::EngineMissing(MISSING.to_string());
    }
    if has("EAP-MS-CHAPv2 failed") || has("EAP_MSCHAPV2 method failed") || has("received EAP_FAILURE") {
        return Problem::Failed("The server rejected these credentials.".into());
    }
    if has("no trusted ")
        || has("no issuer certificate found")
        || has("constraint check failed")
        || has("certificate was revoked")
        || has("certificate status is not available")
    {
        return Problem::Failed(
            "The server's certificate was not accepted. This is a server-side problem rather than \
             anything to do with your account."
                .into(),
        );
    }
    if has("NO_PROPOSAL_CHOSEN") {
        return Problem::Failed("The server accepted none of the ciphers this app offers for IKEv2.".into());
    }
    // The server let us in and then ended it: what a refused account looks
    // like when the node tears the SA down rather than saying why (628 on
    // Windows).
    if has("received AUTHENTICATION_FAILED") {
        return Problem::Failed(
            "The server ended the connection, usually because the credentials were not accepted. \
             If this keeps happening, try another server."
                .into(),
        );
    }
    // strongSwan's own "giving up" is often not in the file: `charon-cmd`
    // ends itself with SIGKILL when the exchange fails, and the last lines
    // can go with it. A server that never sent a single packet back is
    // what that looks like.
    if has("peer not responding") || has("giving up after") || (has("initiating IKE_SA") && !has("received packet")) {
        return Problem::TimedOut(
            "the IKEv2 server to answer on UDP 500 and 4500 (UDP is likely blocked on this network; \
             try a Stealth protocol instead)"
                .into(),
        );
    }
    Problem::Failed("IKEv2 stopped before the tunnel came up".into())
}

/// The interface behind the TUN descriptor a process holds, from the
/// kernel's own account of it (`iff:` in the descriptor's fdinfo). Sure
/// even when another `ipsec` interface already exists.
pub(crate) fn tun_of(pid: u32) -> Option<String> {
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    for fd in fds.filter_map(|e| e.ok()) {
        if std::fs::read_link(fd.path()).ok().as_deref() != Some(Path::new("/dev/net/tun")) {
            continue;
        }
        let info = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{}", fd.file_name().to_string_lossy())).ok()?;
        if let Some(name) = tun_from_fdinfo(&info) {
            return Some(name);
        }
    }
    None
}

pub(crate) fn tun_from_fdinfo(info: &str) -> Option<String> {
    info.lines()
        .find_map(|l| l.strip_prefix("iff:"))
        .map(|n| n.trim().to_string())
        .filter(|n| n.starts_with(TUN_PREFIX) && n.len() < 16 && !n.contains('/'))
}

/// Whether a `/proc/<pid>/environ` (entries separated by NUL) hands
/// strongSwan the configuration `conf` -- or, with `None`, any file by our
/// configuration's name.
pub(crate) fn environ_names(environ: &[u8], conf: Option<&Path>) -> bool {
    environ.split(|b| *b == 0).filter_map(|e| std::str::from_utf8(e).ok()).any(|e| {
        let Some(path) = e.strip_prefix("STRONGSWAN_CONF=") else { return false };
        match conf {
            Some(conf) => Path::new(path) == conf,
            None => Path::new(path).file_name().is_some_and(|n| n == CONFIG_FILE),
        }
    })
}

/// Every `charon-cmd` reading our configuration: `conf` exactly, or any
/// file by our configuration's name. Another `charon-cmd` on the machine,
/// the customer's own, is never ours to touch.
fn ours_running(conf: Option<&Path>) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    let me = std::process::id();
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .filter(|pid| *pid != me)
        .filter(|pid| {
            let name = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
            let named = name.as_deref().and_then(|p| p.file_name()).and_then(|n| n.to_str());
            matches!(named, Some(n) if n == PROGRAM || n.starts_with("charon-cmd "))
        })
        .filter(|pid| std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|env| environ_names(&env, conf)))
        .collect()
}

/// Our IKEv2 interface, when the kernel shows one up: for the status
/// answer while the session's owner is busy.
pub(crate) fn visible_link() -> Option<String> {
    ours_running(None).into_iter().filter_map(tun_of).find(|name| link::is_up(name) == Some(true))
}

/// strongSwan's rule, as the arguments after `ip rule del` (v4 and v6:
/// it makes both).
fn rule_owed() -> [Owed; 2] {
    let args = ["pref", &STRONGSWAN_RULE_PREF.to_string(), "table", &STRONGSWAN_TABLE.to_string()]
        .map(String::from)
        .to_vec();
    [Owed::Rule { args: args.clone(), v6: false }, Owed::Rule { args, v6: true }]
}

/// Empties strongSwan's table. Its routes into the TUN go with the TUN;
/// the "throw" route it adds for the server does not.
fn flush_table(budget: &Budget) {
    let table = STRONGSWAN_TABLE.to_string();
    let _ = cmd::ip(&["-4", "route", "flush", "table", &table], budget);
    let _ = cmd::ip(&["-6", "route", "flush", "table", &table], budget);
}

/// The sweep's part for IKEv2, after a helper that died: orphaned
/// engines started with our configuration (the TUN goes with them), then
/// strongSwan's rule and table, which a killed `charon-cmd` leaves.
pub(crate) fn sweep(dirs: &Dirs, budget: &Budget) -> Vec<String> {
    let mut lines = Vec::new();
    for pid in ours_running(Some(&dirs.run.join(CONFIG_FILE))) {
        match process::kill_pid(pid) {
            Ok(()) => lines.push(format!("stopped a leftover IKEv2 engine (process {pid})")),
            Err(why) => lines.push(format!("could not stop a leftover IKEv2 engine (process {pid}): {why}")),
        }
    }
    // Ours by number only while no IKEv2 of ours runs: a sweep is never
    // run beside a live session, and the engines were just stopped.
    for owed in rule_owed() {
        let Owed::Rule { args, v6 } = &owed else { continue };
        let mut list = vec![if *v6 { "-6" } else { "-4" }, "rule", "list"];
        list.extend(args.iter().map(String::as_str));
        let present = cmd::ip(&list, budget).is_ok_and(|out| !out.trim().is_empty());
        if !present {
            continue;
        }
        let family = if *v6 { "IPv6" } else { "IPv4" };
        match crate::cleanup::undo(&owed, budget) {
            Ok(_) => lines.push(format!("removed strongSwan's leftover {family} routing rule ({})", args.join(" "))),
            Err(why) => lines.push(format!("could not remove strongSwan's leftover routing rule: {why}")),
        }
    }
    let table = STRONGSWAN_TABLE.to_string();
    let left = cmd::ip(&["-4", "route", "show", "table", &table], budget).is_ok_and(|o| !o.trim().is_empty());
    if left {
        flush_table(budget);
        lines.push(format!("emptied strongSwan's leftover routing table {table}"));
    }
    lines
}

fn teardown() -> Budget {
    Budget::quick(cmd::TEARDOWN_CAP)
}

pub(crate) fn connect(
    profile: &ConnectProfile,
    known_nodes: &[String],
    shape: &Shape,
    dirs: &Dirs,
    limits: &Limits,
) -> Result<Box<dyn Tunnel>, Problem> {
    let ConnectProfile::Ikev2(p) = profile else {
        return Err(Problem::Failed(format!("{} is not IKEv2", profile.protocol_name())));
    };
    check_profile(p)?;
    let Some(exe) = cmd::find(PROGRAM) else {
        return Err(Problem::EngineMissing(MISSING.to_string()));
    };
    if plugins_present() == Some(false) {
        return Err(Problem::EngineMissing(MISSING.to_string()));
    }
    let roots = trust_roots_in(&ROOT_DIRS);
    if roots.is_empty() {
        return Err(Problem::EngineMissing("the system's trusted root certificates (ca-certificates)".into()));
    }
    let budget = Budget::within(limits, Duration::from_secs(120));

    // Leftovers in the way: an engine of ours from a helper that died,
    // stale host routes to the servers the app knows.
    let config = dirs.run.join(CONFIG_FILE);
    for pid in ours_running(Some(&config)) {
        let _ = process::kill_pid(pid);
    }
    routes::purge_stale(known_nodes, &budget);

    // The server by address and the way out to it, asked before anything
    // of ours is routed.
    let server = routes::resolve_ipv4(&p.server, IKE_PORT, &budget)?;
    let uplink = routes::uplink_for(server, &budget)?;

    let ledger = Ledger::in_dir(&dirs.state);
    let plan = Plan { tunnel: String::new(), uplink: uplink.clone(), servers: vec![server], engine_mark: None };
    let custom = Custom::new(shape, plan, &ledger, &dirs.run, true);
    let mut tunnel = IkeTunnel {
        up: Up {
            protocol: profile.protocol_name().to_string(),
            ifaces: Vec::new(),
            transports: vec![
                Transport { ip: server, port: IKE_PORT, proto: Proto::Udp },
                Transport { ip: server, port: NAT_T_PORT, proto: Proto::Udp },
            ],
            fwmark: None,
            dns_protected: false,
        },
        child: None,
        ledger,
        routes: Vec::new(),
        rules: Vec::new(),
        config_owed: None,
        dns: None,
        baseline: None,
        iface: None,
        log: dirs.run.join(LOG_FILE),
        out: dirs.run.join(OUT_FILE),
        server,
        signalled: false,
        unanswered_since: None,
        custom,
    };
    // From here an early return drops `tunnel`, which undoes what it did.
    tunnel.bring_up(&exe, p, &roots, &uplink, dirs, &budget)?;
    Ok(Box::new(tunnel))
}

/// What the IPC layer checks already, checked again where it matters: the
/// name and the username go on a command line, the password down a pipe
/// that ends at the first newline.
fn check_profile(p: &Ikev2Profile) -> Result<(), Problem> {
    if !plausible_host(&p.server) {
        return Err(Problem::Failed("the IKEv2 server must be a host name, not an address".into()));
    }
    let line = |s: &str, max: usize| !s.is_empty() && s.len() <= max && !s.contains(['\n', '\r', '\0']);
    if !line(&p.username, 128) || !line(&p.password, 256) {
        return Err(Problem::Failed("the IKEv2 sign-in details are malformed".into()));
    }
    Ok(())
}

impl IkeTunnel {
    fn bring_up(
        &mut self,
        exe: &Path,
        p: &Ikev2Profile,
        roots: &[PathBuf],
        uplink: &routes::Uplink,
        dirs: &Dirs,
        budget: &Budget,
    ) -> Result<(), Problem> {
        // The host route first: harmless before the engine runs, and in
        // place before anything is routed into the tunnel.
        let spec = RouteSpec::host(self.server, uplink);
        routes::add(&spec, true, &self.ledger, budget)
            .map_err(|e| e.problem(&format!("add the host route to the server through {}", uplink.dev)))?;
        self.routes.push(spec);

        let _ = std::fs::create_dir_all(&dirs.run);
        let path = dirs.run.join(CONFIG_FILE);
        let owed = Owed::File { path: path.clone() };
        self.ledger.owe(owed.clone());
        self.config_owed = Some(owed);
        crate::files::write_private(&path, build_config(&self.log)?.as_bytes())
            .map_err(|e| Problem::Failed(format!("could not write the IKEv2 settings: {e}")))?;
        // strongSwan opens its log itself; made root-only here first, since
        // it names the server and the account.
        crate::files::write_private(&self.log, b"")
            .map_err(|e| Problem::Failed(format!("could not create the IKEv2 log: {e}")))?;

        for owed in rule_owed() {
            self.ledger.owe(owed.clone());
            self.rules.push(owed);
        }

        let child = spawn(exe, &build_args(self.server, &p.server, &p.username, roots), &path, &self.out, &p.password)
            .map_err(|e| Problem::Failed(format!("could not start strongSwan: {e}")))?;
        let child = self.child.insert(child);
        let waited = wait_until_up(child, &self.log, &self.out, budget);
        if let Err(problem) = waited {
            return Err(problem);
        }

        // Which TUN is ours, from the process that holds it.
        let pid = child.id();
        let iface = tun_of(pid)
            .ok_or_else(|| Problem::Failed("strongSwan said it was up but holds no tunnel interface".into()))?;
        if !link::exists(&iface) {
            return Err(Problem::Failed(format!("strongSwan said it was up but its interface ({iface}) is not there")));
        }
        if link::ipv4_addresses(&iface, budget).is_empty() {
            return Err(Problem::Failed(format!(
                "the server gave no address for the tunnel interface ({iface})"
            )));
        }
        self.up.ifaces = vec![iface.clone()];
        self.iface = Some(iface.clone());
        self.baseline = link::counters(&iface);
        self.custom.plan.tunnel = iface.clone();

        if split::takes_everything(&self.custom.shape) {
            self.take_everything(budget)?;
        }
        self.custom.install(budget)?;

        // DNS once a route leads into the tunnel, and not before. 1.1.1.1,
        // as Windows forces for IKEv2 and as the node's pool hands out.
        self.dns = dns::point_at(&iface, &dirs.state, &self.ledger, budget);
        self.up.dns_protected = self.dns.is_some();
        Ok(())
    }

    fn remove_routes(&mut self, budget: &Budget) {
        for spec in std::mem::take(&mut self.routes) {
            if routes::remove(&spec, &self.ledger, budget).is_err() {
                self.routes.push(spec);
            }
        }
    }

    /// Asks `charon-cmd` to stop: on SIGINT it sends the server a DELETE,
    /// so the node frees the session at once, takes back its rule and
    /// exits. Once only.
    fn signal_stop(&mut self) {
        if self.signalled {
            return;
        }
        if let Some(child) = self.child.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = cmd::run("kill", &["-INT", &child.id().to_string()], &teardown());
            }
        }
        self.signalled = true;
    }
}

impl Engine for IkeTunnel {
    /// Everything into the tunnel: the two half-defaults on our TUN, more
    /// specific than any default route and never replacing one. Custom
    /// mode with only the chosen apps leaves these out and routes by
    /// control group instead.
    fn take_everything(&mut self, budget: &Budget) -> Result<(), Problem> {
        let Some(iface) = self.iface.clone() else {
            return Err(Problem::Failed("the IKEv2 tunnel interface is not known".into()));
        };
        for half in routes::HALF_DEFAULTS {
            let spec = RouteSpec::into_link(half, &iface);
            if self.routes.contains(&spec) {
                continue;
            }
            routes::add(&spec, false, &self.ledger, budget)
                .map_err(|e| e.problem(&format!("route {half} into the tunnel")))?;
            self.routes.push(spec);
        }
        Ok(())
    }

    /// The routes into the tunnel out again, leaving the host route to the
    /// server. Whatever would not go stays owed.
    fn release_everything(&mut self, budget: &Budget) {
        let Some(iface) = self.iface.clone() else { return };
        let (into, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.routes).into_iter().partition(|s| s.dev == iface);
        self.routes = rest;
        for spec in into {
            if routes::remove(&spec, &self.ledger, budget).is_err() {
                self.routes.push(spec);
            }
        }
    }

    fn custom(&mut self) -> &mut Custom {
        &mut self.custom
    }
}

/// Starts `charon-cmd` in a session of its own, with no terminal, so the
/// password it asks for is read from standard input (glibc's `getpass`
/// falls back to it when there is no `/dev/tty`), and the password is
/// written there and the pipe closed. Its own session also keeps a signal
/// meant for the helper from reaching it halfway through a teardown.
fn spawn(exe: &Path, args: &[String], conf: &Path, out: &Path, password: &str) -> std::io::Result<Child> {
    crate::files::write_private(out, b"")?;
    let out_file = std::fs::OpenOptions::new().append(true).open(out)?;
    let err_file = out_file.try_clone()?;
    // `setsid` execs in place when the caller is not a group leader, so the
    // child's process is `charon-cmd` itself and can be signalled and
    // waited for directly.
    let mut command = match cmd::find("setsid") {
        Some(setsid) => {
            let mut c = Command::new(setsid);
            c.arg(exe);
            c
        }
        None => {
            use std::os::unix::process::CommandExt;
            let mut c = Command::new(exe);
            c.process_group(0);
            c
        }
    };
    let mut child = command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("STRONGSWAN_CONF", conf)
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::from(err_file))
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let written = stdin.write_all(password.as_bytes()).and_then(|()| stdin.write_all(b"\n"));
        drop(stdin);
        if let Err(e) = written {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    }
    Ok(child)
}

/// Waits for strongSwan to say the child SA is in place. Ends early, with
/// the reason sorted from its log, when it exits; ends on cancel and on
/// the deadline.
fn wait_until_up(child: &mut Child, log: &Path, out: &Path, budget: &Budget) -> Result<(), Problem> {
    let capped = Budget::quick(TUNNEL_UP_WITHIN);
    loop {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if text.contains(CHILD_UP_MARK) {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let both = format!("{}\n{}", std::fs::read_to_string(out).unwrap_or_default(), text);
                process::log_last_words("strongSwan", log);
                process::log_last_words("strongSwan (output)", out);
                return Err(match failure_from_log(&both) {
                    Problem::Failed(why) if why == "IKEv2 stopped before the tunnel came up" => {
                        Problem::Failed(format!("{why} ({status})"))
                    }
                    other => other,
                });
            }
            Ok(None) => {}
            Err(e) => return Err(Problem::Failed(format!("could not check whether strongSwan was still running: {e}"))),
        }
        budget.check().map_err(|stop| stop.problem("the IKEv2 server to finish connecting"))?;
        if capped.expired() {
            process::log_last_words("strongSwan", log);
            return Err(Problem::TimedOut("the IKEv2 server to finish connecting".into()));
        }
        budget.nap();
    }
}

/// The end of a log, for `health`.
fn read_tail(path: &Path, bytes: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(bytes))).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = file.take(bytes).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Whether the last thing strongSwan said about the server is that it is
/// asking again: retransmits after the last answer, while dead-peer
/// detection decides. It exits on its own about 16 s later if no answer
/// comes.
pub(crate) fn link_unanswered(log_tail: &str) -> bool {
    match (log_tail.rfind("retransmit "), log_tail.rfind("received packet")) {
        (Some(retry), Some(answer)) => retry > answer,
        (Some(_), None) => true,
        _ => false,
    }
}

impl Tunnel for IkeTunnel {
    fn up(&self) -> &Up {
        &self.up
    }

    fn shape(&self) -> Shape {
        self.custom.shape.clone()
    }

    fn reshape(&mut self, shape: &Shape, limits: &Limits) -> Result<(), Problem> {
        split::reshape(self, shape, limits)
    }

    fn split(&self) -> Option<SplitState> {
        self.custom.state()
    }

    fn probe(&self, limits: &Limits) -> Result<(), String> {
        match self.iface.as_deref() {
            Some(iface) => split::probe(iface, limits),
            None => Err("the IKEv2 tunnel interface is not known".into()),
        }
    }

    /// `Down` when `charon-cmd` has exited (it does when the server stops
    /// answering dead-peer detection or deletes the session) or its TUN is
    /// gone, or the server is routed into the tunnel itself. `Stale` while
    /// it is retransmitting to a server that has stopped answering.
    /// Otherwise `Unknown`: a running process is not evidence the server
    /// carries anything.
    fn health(&mut self) -> TunnelHealth {
        match self.child.as_mut().map(|c| c.try_wait()) {
            None | Some(Ok(Some(_))) => return TunnelHealth::Down,
            Some(Err(_)) => return TunnelHealth::Unknown,
            Some(Ok(None)) => {}
        }
        let Some(iface) = self.iface.clone() else { return TunnelHealth::Down };
        if Path::new("/sys/class/net").is_dir() && !link::exists(&iface) {
            return TunnelHealth::Down;
        }
        if routes::leads_into(self.server, &iface) {
            eprintln!("neoxify-helper: the IKEv2 server is now routed into its own tunnel (its way out went away)");
            return TunnelHealth::Down;
        }
        if link_unanswered(&read_tail(&self.log, 4096)) {
            let since = *self.unanswered_since.get_or_insert_with(Instant::now);
            TunnelHealth::Stale { age_secs: since.elapsed().as_secs() }
        } else {
            self.unanswered_since = None;
            TunnelHealth::Unknown
        }
    }

    fn dns_protected(&self) -> bool {
        self.dns.as_ref().is_some_and(dns::still_in_force)
    }

    fn counters(&self) -> Option<(u64, u64)> {
        let (rx, tx) = link::counters(self.iface.as_deref()?)?;
        let (rx0, tx0) = self.baseline.unwrap_or((0, 0));
        Some((rx.saturating_sub(rx0), tx.saturating_sub(tx0)))
    }

    /// The routes into the tunnel out first, so traffic is back on the
    /// machine's own route at once, then `charon-cmd` asked to stop (it
    /// sends the server its DELETE and exits within a fraction of a
    /// second), then the host route. `ip` and one `kill` only.
    fn hard_stop(&mut self) {
        let budget = teardown();
        self.custom.hard_stop();
        self.release_everything(&budget);
        self.signal_stop();
        self.remove_routes(&budget);
    }

    fn finish_stop(&mut self) {
        let budget = teardown();
        self.custom.finish_stop();
        self.signal_stop();
        if let Some(mut child) = self.child.take() {
            let grace = Budget::quick(EXIT_GRACE);
            while matches!(child.try_wait(), Ok(None)) && !grace.expired() {
                grace.nap();
            }
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        self.remove_routes(&budget);
        // strongSwan takes its rule back when it exits cleanly; a killed one
        // does not. Its table's "throw" route outlives either.
        for owed in std::mem::take(&mut self.rules) {
            match crate::cleanup::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => self.rules.push(owed),
            }
        }
        flush_table(&budget);
        if let Some(owed) = self.dns.take() {
            match dns::undo(&owed, &budget) {
                Ok(_) => self.ledger.settle(&owed),
                Err(_) => self.dns = Some(owed),
            }
        }
        // The logs name the server and the account; nothing reads them once
        // the engine is gone.
        let _ = std::fs::remove_file(&self.log);
        let _ = std::fs::remove_file(&self.out);
        if let Some(owed) = self.config_owed.take() {
            if let Owed::File { path } = &owed {
                match std::fs::remove_file(path) {
                    Ok(()) => self.ledger.settle(&owed),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.ledger.settle(&owed),
                    Err(_) => self.config_owed = Some(owed),
                }
            }
        }
    }
}

impl Drop for IkeTunnel {
    fn drop(&mut self) {
        self.hard_stop();
        self.finish_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_load_only_what_is_needed_and_leave_dns_and_routes_alone() {
        let c = build_config(Path::new("/run/neoxify/private/ikev2.log")).unwrap();
        assert!(c.starts_with("# Written by Neoxify"));
        assert!(c.contains("charon-cmd {\n"));
        assert!(c.contains("kernel-libipsec"));
        assert!(c.contains("eap-mschapv2"));
        // `resolve` would rewrite resolv.conf; `updown` would run scripts.
        for absent in [" resolve", "updown", "stroke", "vici"] {
            assert!(!c.contains(absent), "{absent}");
        }
        assert!(c.contains("routing_table = 28283\n"));
        // After the main table, so strongSwan's rule never decides a route.
        assert!(c.contains("routing_table_prio = 32900\n"));
        assert!(STRONGSWAN_RULE_PREF > 32767);
        assert!(c.contains("path = \"/run/neoxify/private/ikev2.log\"\n"));
        assert!(c.contains("flush_line = yes\n"));
        assert_eq!(c.matches('{').count(), c.matches('}').count());
    }

    #[test]
    fn a_log_path_that_could_break_out_of_the_settings_is_refused() {
        assert!(build_config(Path::new("/run/x\"\n  load = resolve")).is_err());
        assert!(build_config(Path::new("/run/x}")).is_err());
    }

    #[test]
    fn the_server_is_dialled_by_address_and_checked_by_name_and_no_password_is_an_argument() {
        let roots = vec![PathBuf::from("/etc/ssl/certs/ISRG_Root_X1.pem")];
        let args = build_args(Ipv4Addr::new(192, 0, 2, 7), "vpn.example.com", "nx-0123456789abcdef", &roots);
        let joined = args.join(" ");
        assert!(joined.contains("--host 192.0.2.7 --remote-identity vpn.example.com"));
        assert!(joined.contains("--identity nx-0123456789abcdef --eap-identity nx-0123456789abcdef"));
        assert!(joined.contains("--profile ikev2-eap"));
        assert!(joined.contains("--remote-ts 0.0.0.0/0"));
        assert!(joined.contains("--ike-proposal aes256gcm16-prfsha384-ecp384 --ike-proposal aes256-sha256-modp2048"));
        assert!(joined.contains("--esp-proposal aes256gcm16 --esp-proposal aes256-sha256"));
        assert!(joined.ends_with("--cert /etc/ssl/certs/ISRG_Root_X1.pem"));
        assert!(!joined.contains("password"));
    }

    #[test]
    fn only_a_host_name_is_dialled() {
        assert!(plausible_host("vpn.example.com"));
        assert!(!plausible_host("192.0.2.7"));
        assert!(!plausible_host("--host"));
        assert!(!plausible_host("a b"));
        assert!(!plausible_host(""));
        let p = |server: &str, password: &str| Ikev2Profile {
            server: server.into(),
            username: "nx-0123456789abcdef".into(),
            password: password.into(),
        };
        assert!(check_profile(&p("vpn.example.com", "secret")).is_ok());
        assert!(check_profile(&p("198.51.100.4", "secret")).is_err());
        assert!(check_profile(&p("vpn.example.com", "two\nlines")).is_err());
        assert!(check_profile(&p("vpn.example.com", "")).is_err());
    }

    // Lines from strongSwan 5.9.13 against a real node, server and account
    // replaced with documentation values.
    const REFUSED_PASSWORD: &str = "09[IKE] authentication of 'vpn.example.com' with RSA_EMSA_PKCS1_SHA2_256 successful\n\
        14[IKE] server requested EAP_MSCHAPV2 authentication (id 0x35)\n\
        12[IKE] EAP-MS-CHAPv2 failed with error ERROR_AUTHENTICATION_FAILURE: '(null)'\n\
        12[IKE] EAP_MSCHAPV2 method failed\n\
        12[ENC] generating INFORMATIONAL request 4 [ N(AUTH_FAILED) ]\n";
    const NO_ANSWER: &str = "08[IKE] initiating IKE_SA cmd[1] to 192.0.2.1\n\
        09[IKE] retransmit 1 of request with message ID 0\n\
        10[IKE] retransmit 2 of request with message ID 0\n\
        11[IKE] giving up after 2 retransmits\n\
        11[IKE] establishing IKE_SA failed, peer not responding\n";
    const BAD_CERT: &str = "11[CFG]   using certificate \"CN=vpn.example.com\"\n\
        11[CFG] no issuer certificate found for \"CN=vpn.example.com\"\n\
        11[CFG] no trusted RSA public key found for 'vpn.example.com'\n\
        11[ENC] generating INFORMATIONAL request 2 [ N(AUTH_FAILED) ]\n";
    const UP: &str = "12[IKE] IKE_SA cmd[1] established between 10.0.2.15[nx]...192.0.2.7[vpn.example.com]\n\
        12[CFG] selected proposal: ESP:AES_GCM_16_256/NO_EXT_SEQ\n\
        12[IKE] CHILD_SA cmd{1} established with SPIs 33bd32e9_i c5ad88e3_o and TS 10.68.0.2/32 === 0.0.0.0/0\n";

    #[test]
    fn each_failure_is_told_apart_from_the_log() {
        assert_eq!(failure_from_log(REFUSED_PASSWORD), Problem::Failed("The server rejected these credentials.".into()));
        assert!(matches!(failure_from_log(NO_ANSWER), Problem::TimedOut(_)));
        // The same, as the file reads when `charon-cmd` killed itself
        // before writing its last lines (observed on 5.9.13).
        let cut_short = "03[IKE] initiating IKE_SA cmd[1] to 192.0.2.1\n\
            03[NET] sending packet: from 10.0.2.15[50237] to 192.0.2.1[4500] (924 bytes)\n\
            13[IKE] retransmit 3 of request with message ID 0\n";
        assert!(matches!(failure_from_log(cut_short), Problem::TimedOut(_)));
        let cert = failure_from_log(BAD_CERT).to_string();
        assert!(cert.contains("certificate was not accepted"), "{cert}");
        assert!(matches!(
            failure_from_log("00[LIB] plugin 'kernel-libipsec' failed to load: not found\n"),
            Problem::EngineMissing(_)
        ));
        assert_eq!(failure_from_log(""), Problem::Failed("IKEv2 stopped before the tunnel came up".into()));
        // The plugin list names every plugin, and one that is merely
        // optional failing to load is not strongSwan missing.
        let listed = "00[LIB] plugin 'md4' failed to load: not found\n\
            00[LIB] loaded plugins: charon-cmd random nonce openssl kernel-libipsec eap-mschapv2\n";
        assert!(matches!(failure_from_log(&format!("{listed}{NO_ANSWER}")), Problem::TimedOut(_)));
        assert!(UP.contains(CHILD_UP_MARK));
        assert!(!REFUSED_PASSWORD.contains(CHILD_UP_MARK));
    }

    // The app sorts these sentences by their words
    // (`src/lib/connection-errors.ts`): only the unanswered server may read
    // as one that did not answer, and none may read as an expired plan.
    #[test]
    fn the_sentences_sort_as_the_app_expects() {
        let unreachable = ["timed out", "timeout", "unreachable", "refused", "no route", "network is down", "handshake"];
        let inactive = ["suspended", "expired", "not active", "inactive", "quota", "concurrent"];
        for log in [REFUSED_PASSWORD, BAD_CERT, "08[IKE] received AUTHENTICATION_FAILED notify error\n"] {
            let s = failure_from_log(log).to_string().to_lowercase();
            assert!(!unreachable.iter().any(|w| s.contains(w)), "{s}");
            assert!(!inactive.iter().any(|w| s.contains(w)), "{s}");
        }
        let s = failure_from_log(NO_ANSWER).to_string().to_lowercase();
        assert!(s.contains("timed out"), "{s}");
        let missing = Problem::EngineMissing(MISSING.into()).to_string();
        assert!(missing.contains("missing from the install") && missing.contains("charon-cmd"), "{missing}");
    }

    #[test]
    fn our_tun_is_read_from_the_descriptor_not_guessed() {
        let info = "pos:\t0\nflags:\t02004002\nmnt_id:\t26\nino:\t1068\niff:\tipsec1\n";
        assert_eq!(tun_from_fdinfo(info).as_deref(), Some("ipsec1"));
        assert_eq!(tun_from_fdinfo("iff:\tneoconnect0\n"), None);
        assert_eq!(tun_from_fdinfo("pos:\t0\n"), None);
    }

    #[test]
    fn an_engine_is_ours_only_when_it_reads_our_settings() {
        let conf = Path::new("/run/neoxify/private/neoxify-ikev2.conf");
        let env = b"PATH=/usr/sbin:/usr/bin\0STRONGSWAN_CONF=/run/neoxify/private/neoxify-ikev2.conf\0";
        assert!(environ_names(env, Some(conf)));
        assert!(environ_names(env, None));
        assert!(!environ_names(b"STRONGSWAN_CONF=/etc/strongswan.conf\0", Some(conf)));
        assert!(!environ_names(b"STRONGSWAN_CONF=/etc/strongswan.conf\0", None));
        assert!(!environ_names(b"PATH=/usr/bin\0", None));
        assert!(!environ_names(b"", Some(conf)));
    }

    #[test]
    fn retransmits_after_the_last_answer_are_a_server_gone_quiet() {
        let quiet = "09[IKE] sending DPD request\n09[NET] received packet: from a to b\n\
                     10[IKE] sending DPD request\n10[IKE] retransmit 1 of request with message ID 7\n";
        assert!(link_unanswered(quiet));
        assert!(!link_unanswered("10[IKE] retransmit 1 of request\n11[NET] received packet: from a to b\n"));
        assert!(!link_unanswered(""));
    }

    #[test]
    fn roots_come_from_the_first_directory_that_has_any() {
        let dir = std::env::temp_dir().join(format!("neoxify-roots-{}", std::process::id()));
        let empty = dir.join("empty");
        let full = dir.join("full");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("b.pem"), "x").unwrap();
        std::fs::write(full.join("a.pem"), "x").unwrap();
        std::fs::write(full.join("ca-certificates.crt"), "x").unwrap();
        let (e, f) = (empty.to_string_lossy().into_owned(), full.to_string_lossy().into_owned());
        let roots = trust_roots_in(&["/nonexistent/neoxify", &e, &f]);
        assert_eq!(roots, vec![full.join("a.pem"), full.join("b.pem")]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
