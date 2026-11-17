//! The daemon end to end over a real Unix socket, with a fake machine
//! behind it: framing, who may call, every request, supersede and cancel,
//! the engine-death path, the reconnect hold, Custom mode, Repair and the
//! Linux-only requests. Nothing here needs root or touches the network;
//! what a real tunnel does is for the VM.

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use neoconnect_ipc::{
    ConnectProfile, ExitProfile, GamingConfig, Ikev2Profile, ReconnectHold, ReconnectHoldProblem, Request,
    SplitTunnelConfig, SplitTunnelMode, SplitTunnelProblemCode, TunnelHealth, WireguardProfile, NO_NETWORK,
};
use neoxify_netguard::{Applied, Cidr4, Held, HoldPlan, Plan, Removal};
use neoxify_tunnel::{Dirs, Limits, Problem, Proto, Running, Shape, SplitState, Transport, Tunnel, Up};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::backend::Backend;
use crate::hold::{self, Arming, Hold, Release};
use crate::lifecycle::cancel::CancelToken;
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::machine::Survey;
use crate::peer::{Caller, Policy};
use crate::server::{self, Shared};
use crate::session::Session;
use neoconnect_ipc::Response;

/// What the fake machine has been asked to do, and how it answers.
struct World {
    connects: usize,
    hard_stops: usize,
    finishes: usize,
    removes: usize,
    last_plan: Option<Plan>,
    health: TunnelHealth,
    counters: Option<(u64, u64)>,
    visible: Option<String>,
    connect_takes: Duration,
    connect_fails: Option<Problem>,
    guard_fails: bool,
    no_way_out: bool,
    /// The table as the kernel holds it: put there by `guard_apply`,
    /// taken by `guard_remove`, or by a test standing in for someone
    /// else's `nft flush ruleset`.
    table: Option<Applied>,
    applies: usize,
    /// Whether the machine's DNS still points into the tunnel.
    dns_in_force: bool,
    /// The hold's table, in the same place: in when `hold_apply` put it
    /// there, gone when either other write replaced it.
    hold_in: Option<HoldPlan>,
    hold_applies: usize,
    hold_fails: bool,
    resolvers: Vec<IpAddr>,
    adopted: Vec<u32>,
    resolve: Option<Ipv4Addr>,
    /// Custom mode.
    last_shape: Option<Shape>,
    shape_now: Shape,
    reshape_fails: bool,
    split: Option<SplitState>,
    probe: Result<(), String>,
    running: Vec<Running>,
    running_for: Option<u32>,
    /// What the survey shows; the sweep cleans it.
    survey: Survey,
    sweeps: usize,
}

fn clean_survey() -> Survey {
    Survey {
        engines: Some(0),
        dns: Some(0),
        routes: Some(0),
        rules: Some(0),
        firewall: Some(false),
        split_table: Some(false),
        links: Some(Vec::new()),
        groups: Some(Vec::new()),
        owed: Some(0),
    }
}

impl Default for World {
    fn default() -> Self {
        Self {
            connects: 0,
            hard_stops: 0,
            finishes: 0,
            removes: 0,
            last_plan: None,
            health: TunnelHealth::Alive { age_secs: 1 },
            counters: Some((0, 0)),
            visible: None,
            connect_takes: Duration::ZERO,
            connect_fails: None,
            guard_fails: false,
            no_way_out: false,
            table: None,
            applies: 0,
            dns_in_force: true,
            hold_in: None,
            hold_applies: 0,
            hold_fails: false,
            resolvers: vec![IpAddr::V4(Ipv4Addr::new(198, 51, 100, 53))],
            adopted: Vec::new(),
            resolve: None,
            last_shape: None,
            shape_now: Shape::Full,
            reshape_fails: false,
            split: None,
            probe: Ok(()),
            running: Vec::new(),
            running_for: None,
            survey: clean_survey(),
            sweeps: 0,
        }
    }
}

type WorldRef = Arc<Mutex<World>>;

struct Fake(WorldRef);

struct FakeTunnel {
    up: Up,
    world: WorldRef,
}

impl Tunnel for FakeTunnel {
    fn up(&self) -> &Up {
        &self.up
    }
    fn health(&mut self) -> TunnelHealth {
        self.world.lock().unwrap().health
    }
    fn counters(&self) -> Option<(u64, u64)> {
        self.world.lock().unwrap().counters
    }
    fn dns_protected(&self) -> bool {
        self.up.dns_protected && self.world.lock().unwrap().dns_in_force
    }
    fn shape(&self) -> Shape {
        self.world.lock().unwrap().shape_now.clone()
    }
    fn reshape(&mut self, shape: &Shape, _limits: &Limits) -> Result<(), Problem> {
        let mut w = self.world.lock().unwrap();
        if w.reshape_fails {
            return Err(Problem::Failed("the kernel refused the rules".into()));
        }
        w.shape_now = shape.clone();
        Ok(())
    }
    fn split(&self) -> Option<SplitState> {
        let w = self.world.lock().unwrap();
        if w.shape_now.is_split() {
            w.split.clone()
        } else {
            None
        }
    }
    fn probe(&self, _limits: &Limits) -> Result<(), String> {
        self.world.lock().unwrap().probe.clone()
    }
    fn hard_stop(&mut self) {
        let mut w = self.world.lock().unwrap();
        w.hard_stops += 1;
        w.visible = None;
    }
    fn finish_stop(&mut self) {
        self.world.lock().unwrap().finishes += 1;
    }
}

impl Backend for Fake {
    fn connect(
        &self,
        _profile: &ConnectProfile,
        _exits: &[ExitProfile],
        _known_nodes: &[String],
        shape: &Shape,
        _dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem> {
        let (takes, fails) = {
            let mut w = self.0.lock().unwrap();
            w.connects += 1;
            w.last_shape = Some(shape.clone());
            (w.connect_takes, w.connect_fails.clone())
        };
        let until = Instant::now() + takes;
        while Instant::now() < until {
            if limits.cancel.load(Ordering::Acquire) {
                return Err(Problem::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if let Some(problem) = fails {
            return Err(problem);
        }
        let mut w = self.0.lock().unwrap();
        w.visible = Some("neoxify-wg".into());
        w.shape_now = shape.clone();
        Ok(Box::new(FakeTunnel {
            up: Up {
                protocol: "WIREGUARD".into(),
                ifaces: vec!["neoxify-wg".into()],
                transports: vec![Transport { ip: Ipv4Addr::new(192, 0, 2, 10), port: 51820, proto: Proto::Udp }],
                fwmark: Some(28280),
                dns_protected: true,
            },
            world: Arc::clone(&self.0),
        }))
    }
    fn way_out(&self, _profile: &ConnectProfile) -> Result<(), Problem> {
        if self.0.lock().unwrap().no_way_out {
            Err(Problem::NoNetwork)
        } else {
            Ok(())
        }
    }
    fn sweep_leftovers(&self, _dirs: &Dirs) -> Vec<String> {
        let mut w = self.0.lock().unwrap();
        w.sweeps += 1;
        let firewall = w.survey.firewall;
        w.survey = Survey { firewall, ..clean_survey() };
        Vec::new()
    }
    fn visible_tunnel(&self) -> Option<String> {
        self.0.lock().unwrap().visible.clone()
    }
    fn guard_apply(&self, plan: &Plan) -> Result<Applied, neoxify_netguard::Error> {
        let mut w = self.0.lock().unwrap();
        w.last_plan = Some(plan.clone());
        w.applies += 1;
        if w.guard_fails {
            return Err(neoxify_netguard::Error::NftMissing("nft was not found".into()));
        }
        let applied = Applied { ipv6_blocked: true, dns_confined: true, ipv4_confined: true };
        w.table = Some(applied);
        w.hold_in = None;
        Ok(applied)
    }
    fn guard_remove(&self) -> Result<Removal, neoxify_netguard::Error> {
        let mut w = self.0.lock().unwrap();
        w.removes += 1;
        w.table = None;
        w.hold_in = None;
        w.survey.firewall = Some(false);
        Ok(Removal::Removed)
    }
    fn guard_in_force(&self) -> Result<Option<Applied>, neoxify_netguard::Error> {
        Ok(self.0.lock().unwrap().table)
    }
    fn lan_prefixes(&self, _exclude_ifaces: &[&str]) -> Vec<Cidr4> {
        vec![Cidr4 { addr: Ipv4Addr::new(198, 51, 100, 0), prefix: 24 }]
    }
    fn hold_apply(&self, plan: &HoldPlan) -> Result<Held, neoxify_netguard::Error> {
        let mut w = self.0.lock().unwrap();
        w.hold_applies += 1;
        if w.hold_fails {
            return Err(neoxify_netguard::Error::Refused("the kernel said no".into()));
        }
        w.hold_in = Some(plan.clone());
        w.table = None;
        Ok(Held { dns_anywhere: plan.dns_anywhere })
    }
    fn machine_resolvers(&self) -> Vec<IpAddr> {
        self.0.lock().unwrap().resolvers.clone()
    }
    fn adopt_app(&self, pid: u32) -> Result<String, String> {
        self.0.lock().unwrap().adopted.push(pid);
        Ok("neoxify.app".into())
    }
    fn resolve_ipv4(&self, host: &str) -> Option<Ipv4Addr> {
        host.parse().ok().or(self.0.lock().unwrap().resolve)
    }
    fn running_processes(&self, uid: u32) -> Vec<Running> {
        let mut w = self.0.lock().unwrap();
        w.running_for = Some(uid);
        w.running.clone()
    }
    fn valid_app(&self, app: &str) -> Result<(), String> {
        if app.starts_with('/') && !app.contains('\n') {
            Ok(())
        } else {
            Err(format!("{app:?} is not a program's full path"))
        }
    }
    fn survey(&self, _dirs: &Dirs) -> Survey {
        self.0.lock().unwrap().survey.clone()
    }
    fn remove_split_table(&self) -> Result<bool, String> {
        Ok(false)
    }
    fn remove_empty_groups(&self) -> Result<u32, String> {
        Ok(0)
    }
}

struct Daemon {
    path: PathBuf,
    world: WorldRef,
    shared: Shared,
}

fn my_uid() -> u32 {
    // SAFETY: getuid cannot fail and touches no memory.
    unsafe { libc::getuid() }
}

async fn start_full(name: &str, world: World, policy: Policy, limits: Option<(Duration, Duration)>) -> Daemon {
    let dir = std::env::temp_dir().join(format!("nxh-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("helper.sock");
    let world = Arc::new(Mutex::new(world));
    let backend: Arc<dyn Backend> = Arc::new(Fake(Arc::clone(&world)));
    let ledger = Arc::new(Ledger::new());
    let dirs = Dirs { bin: dir.clone(), state: dir.clone(), run: dir.clone() };
    let hold = match limits {
        Some((longest, follow_up)) => Hold::with_limits(Arc::clone(&backend), longest, follow_up),
        None => Hold::new(Arc::clone(&backend)),
    };
    let session = Session::new(Arc::clone(&backend), dirs.clone(), Arc::clone(&ledger), Arc::clone(&hold));
    let engines = Supervisor::spawn(session, "test-session");
    let shared = Shared::new(engines, ledger, backend, Arc::new(policy), hold, dirs);
    let listener = server::bind(&path).expect("bind");
    let serving = shared.clone();
    tokio::spawn(async move { server::serve(listener, serving, std::future::pending()).await });
    Daemon { path, world, shared }
}

async fn start_with(name: &str, world: World, policy: Policy) -> Daemon {
    start_full(name, world, policy, None).await
}

async fn start(name: &str, world: World) -> Daemon {
    start_with(name, world, Policy::new(my_uid(), Vec::new())).await
}

impl Daemon {
    async fn ask_raw(&self, raw: &str) -> String {
        server::call(&self.path, raw).await.expect("the helper answered")
    }

    async fn ask(&self, request: &Request) -> Value {
        let raw = serde_json::to_string(request).unwrap();
        serde_json::from_str(&self.ask_raw(&raw).await).expect("a JSON reply")
    }

    async fn ask_json(&self, raw: &str) -> Value {
        serde_json::from_str(&self.ask_raw(raw).await).expect("a JSON reply")
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    async fn hold_state(&self) -> Value {
        self.ask(&Request::Status).await["reconnect_hold"].clone()
    }
}

fn wireguard() -> ConnectProfile {
    ConnectProfile::Wireguard(WireguardProfile {
        private_key: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=".into(),
        address: "10.77.0.8/32".into(),
        dns: None,
        allowed_ips: "0.0.0.0/0".into(),
        server_public_key: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=".into(),
        endpoint: "192.0.2.10:51820".into(),
    })
}

fn ikev2() -> ConnectProfile {
    ConnectProfile::Ikev2(Ikev2Profile { server: "vpn.example.com".into(), username: "u".into(), password: "p".into() })
}

fn connect() -> Request {
    Request::Connect { profile: wireguard(), exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: false }
}

/// A connect with the hold wanted, and the servers the app knows of.
fn connect_holding() -> Request {
    Request::Connect {
        profile: wireguard(),
        exits: Vec::new(),
        known_nodes: vec!["198.51.100.7".into(), "node.example.com".into()],
        block_while_reconnecting: true,
    }
}

fn custom(mode: SplitTunnelMode, apps: &[&str]) -> Request {
    Request::SetSplitTunnel {
        config: SplitTunnelConfig { enabled: true, mode, apps: apps.iter().map(|a| a.to_string()).collect(), ..Default::default() },
    }
}

/// Polls a condition for up to `within`.
async fn eventually(within: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if ready() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ready()
}

#[tokio::test]
async fn an_idle_helper_says_disconnected_and_says_it_verified_it() {
    let d = start("idle", World::default()).await;
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["status"], "state", "{state}");
    assert_eq!(state["connected"], false);
    assert_eq!(state["health"]["state"], "down");
    assert!(state.get("traffic").is_none() && state.get("session_secs").is_none(), "{state}");
}

#[tokio::test]
async fn a_malformed_request_is_answered_and_never_echoed() {
    let d = start("malformed", World::default()).await;
    for raw in [
        r#"{"type":"zzsecretzz"}"#,
        "zzsecretzz is not json",
        r#"{"type":"connect","profile":{"protocol":"zzsecretzz"}}"#,
        r#"{"type":"installUpdate","package":7,"zzsecretzz":1}"#,
    ] {
        let reply = d.ask_raw(raw).await;
        let parsed: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(parsed["status"], "error", "{reply}");
        assert!(!reply.contains("zzsecretzz"), "the input came back: {reply}");
    }
}

#[tokio::test]
async fn a_request_past_the_cap_is_refused_and_the_connection_closed() {
    let d = start("oversize", World::default()).await;
    let stream = tokio::net::UnixStream::connect(&d.path).await.unwrap();
    let (read, mut write) = stream.into_split();
    let big = vec![b'a'; (server::MAX_REQUEST_BYTES as usize) + 4096];
    tokio::spawn(async move {
        let _ = write.write_all(&big).await;
        let _ = write.write_all(b"\n").await;
    });
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), BufReader::new(read).read_line(&mut line))
        .await
        .expect("an answer")
        .unwrap();
    let parsed: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(parsed["status"], "error");
    assert!(parsed["message"].as_str().unwrap().contains("longer than"), "{parsed}");
}

#[tokio::test]
async fn a_caller_that_is_neither_root_nor_the_app_is_refused() {
    let d = start_with("refused", World::default(), Policy::new(u32::MAX, Vec::new())).await;
    let state = d.ask(&connect()).await;
    assert_eq!(state["status"], "error");
    assert!(state["message"].as_str().unwrap().contains("only the Neoxify app"), "{state}");
    assert_eq!(d.world().connects, 0, "a refused caller reached the engine");
}

/// A policy for `apps` under which this test's own user is the one at the
/// screen, by a seat file of the test's own making.
fn seated_policy(name: &str, apps: Vec<PathBuf>, seated: bool) -> Policy {
    let seats = std::env::temp_dir().join(format!("nxh-{}-{name}-seats", std::process::id()));
    let _ = std::fs::remove_dir_all(&seats);
    std::fs::create_dir_all(&seats).unwrap();
    if seated {
        std::fs::write(seats.join("seat0"), format!("IS_SEAT0=1\nACTIVE=2\nACTIVE_UID={}\n", my_uid())).unwrap();
    }
    let mut policy = Policy::new(u32::MAX, apps);
    policy.seats = seats;
    policy.group = "neoxify-test-group-that-does-not-exist".into();
    policy
}

#[tokio::test]
async fn the_app_is_served_to_the_user_at_the_screen() {
    let me = std::env::current_exe().unwrap();
    let d = start_with("app", World::default(), seated_policy("app", vec![me], true)).await;
    assert_eq!(d.ask(&Request::Status).await["status"], "state");
}

/// The executable is not enough: the app run by a user who is neither at
/// the screen nor in the group is refused, reaches nothing, and is told
/// in words a customer can act on how to be let in.
#[tokio::test]
async fn the_app_run_by_someone_not_at_the_screen_is_refused() {
    let me = std::env::current_exe().unwrap();
    let d = start_with("appaway", World::default(), seated_policy("appaway", vec![me], false)).await;
    let reply = d.ask(&connect()).await;
    assert_eq!(reply["status"], "error", "{reply}");
    let message = reply["message"].as_str().unwrap();
    assert!(message.contains("neoxify-test-group-that-does-not-exist") && message.contains("usermod -aG"), "{reply}");
    assert_eq!(d.world().connects, 0);
}

/// A connection that sends nothing is let go, and a refused one is let go
/// without being read: neither holds a descriptor for long.
#[tokio::test]
async fn a_silent_connection_is_let_go() {
    let d = start("silent", World::default()).await;
    let stream = tokio::net::UnixStream::connect(&d.path).await.unwrap();
    let mut line = String::new();
    let began = Instant::now();
    let read = tokio::time::timeout(server::REQUEST_WAIT + Duration::from_secs(3), BufReader::new(stream).read_line(&mut line))
        .await
        .expect("the helper kept a silent connection open");
    assert_eq!(read.unwrap(), 0, "{line}");
    assert!(began.elapsed() >= server::REQUEST_WAIT - Duration::from_millis(200));

    let d = start_with("silentrefused", World::default(), Policy::new(u32::MAX, Vec::new())).await;
    let stream = tokio::net::UnixStream::connect(&d.path).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line)).await.expect("no refusal").unwrap();
    assert!(line.contains("only the Neoxify app"), "{line}");
    line.clear();
    let read = tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line)).await.expect("not let go");
    assert_eq!(read.unwrap(), 0);
}

/// Another user's app cannot replace the session one user made; the same
/// user can, and root's tools always can.
#[tokio::test]
async fn another_users_app_cannot_replace_a_live_session() {
    let d = start("otheruser", World::default()).await;
    let mut no_watch = None;
    let alice = Caller::App { pid: 4242, uid: 1000 };
    assert!(server::claim_session(&d.shared, &alice, &mut no_watch).is_none());
    d.shared.ledger.begin("WIREGUARD");
    let bob = Caller::App { pid: 4343, uid: 1001 };
    let refused = server::claim_session(&d.shared, &bob, &mut no_watch);
    assert!(
        matches!(&refused, Some(Response::Error { message }) if message.contains("another user")),
        "{refused:?}"
    );
    let alice_again = Caller::App { pid: 4244, uid: 1000 };
    assert!(server::claim_session(&d.shared, &alice_again, &mut no_watch).is_none());
    assert!(server::claim_session(&d.shared, &Caller::Trusted, &mut no_watch).is_none());
}

/// Every request the shared interface can send gets an answer it can
/// live with, with no tunnel up.
#[tokio::test]
async fn every_request_is_answered() {
    let d = start("every", World::default()).await;
    let off = SplitTunnelConfig::default();
    let on = SplitTunnelConfig { enabled: true, apps: vec!["/usr/bin/firefox".into()], ..Default::default() };
    let cases: Vec<(Request, &str, Option<&str>)> = vec![
        (Request::Status, "state", None),
        (Request::Disconnect, "ok", None),
        (Request::DisconnectForReconnect, "ok", None),
        (Request::ReleaseReconnectHold, "ok", None),
        (Request::SetReconnectHold { enabled: true }, "ok", None),
        (Request::SetReconnectHold { enabled: false }, "ok", None),
        (Request::WayOut { profile: wireguard() }, "ok", None),
        (Request::SetSplitTunnel { config: off }, "ok", None),
        (Request::SetSplitTunnel { config: on }, "ok", None),
        (Request::ProbeSplitTunnel, "error", Some("no tunnel")),
        (Request::SplitTunnelExits, "exitPlacements", None),
        (Request::ListRunningApps, "runningApps", None),
        (Request::Repair, "repaired", None),
        (Request::Diagnostics, "error", Some("linuxDiagnostics")),
        (Request::ArmGaming { config: GamingConfig::default() }, "error", Some("not part of Neoxify on Linux")),
        (Request::DisarmGaming, "ok", None),
        (Request::GamingStatus, "gaming", None),
    ];
    for (request, status, says) in cases {
        let label = format!("{request:?}");
        let reply = d.ask(&request).await;
        assert_eq!(reply["status"], status, "{label}: {reply}");
        if let Some(says) = says {
            assert!(reply["message"].as_str().unwrap_or("").contains(says), "{label}: {reply}");
        }
    }
}

/// IKEv2 is one more profile for the tunnel crate now.
#[tokio::test]
async fn ikev2_is_dialled_like_any_other_profile() {
    let d = start("ikev2", World::default()).await;
    let reply = d
        .ask(&Request::Connect { profile: ikev2(), exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: false })
        .await;
    assert_eq!(reply["status"], "ok", "{reply}");
    assert_eq!(d.world().connects, 1);
}

#[tokio::test]
async fn way_out_says_no_network_in_the_words_the_app_matches() {
    let d = start("wayout", World { no_way_out: true, ..Default::default() }).await;
    let reply = d.ask(&Request::WayOut { profile: wireguard() }).await;
    assert_eq!(reply["message"], NO_NETWORK);
}

#[tokio::test]
async fn an_invalid_profile_is_refused_before_anything_runs() {
    let d = start("invalid", World::default()).await;
    let mut profile = wireguard();
    if let ConnectProfile::Wireguard(p) = &mut profile {
        p.endpoint = "192.0.2.10:51820\nup /bin/sh".into();
    }
    let reply = d
        .ask(&Request::Connect { profile, exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: false })
        .await;
    assert_eq!(reply["status"], "error");
    assert_eq!(d.world().connects, 0);
}

/// Up, with the leak protection planned from what the tunnel said, and
/// the status reporting it; then down, in both halves, table and all.
#[tokio::test]
async fn connect_status_and_disconnect() {
    let d = start("cycle", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    {
        let w = d.world();
        let plan = w.last_plan.clone().expect("netguard was applied");
        assert_eq!(plan.tunnel_ifaces, vec!["neoxify-wg".to_string()]);
        assert_eq!(plan.engine_fwmark, Some(28280));
        assert!(plan.block_ipv6 && plan.confine_dns && plan.confine_ipv4);
        assert_eq!(plan.transports.len(), 1);
        assert_eq!(plan.transports[0].ip, Ipv4Addr::new(192, 0, 2, 10));
        assert_eq!(plan.lan.len(), 1);
        assert_eq!(w.last_shape, Some(Shape::Full));
    }

    d.world().counters = Some((1_000, 100));
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], true, "{state}");
    assert_eq!(state["protocol"], "WIREGUARD");
    assert_eq!(state["health"]["state"], "alive");
    assert_eq!(state["ipv6_blocked"], true);
    assert_eq!(state["ipv4_confined"], true);
    assert_eq!(state["tunnel_dns_unprotected"], false);
    assert!(state.get("confinement_problem").is_none(), "{state}");
    assert!(state.get("reconnect_hold").is_none(), "the setting is off: {state}");
    assert_eq!(state["split_tunnel_active"], false);
    assert!(state["session_secs"].is_u64());
    assert_eq!(state["traffic"]["rx_bytes"], 0, "counted from the session's first reading");

    // A second reading a second later carries a rate.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    d.world().counters = Some((3_000, 300));
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["traffic"]["rx_bytes"], 2_000);
    assert!(state["traffic"]["rx_per_sec"].as_u64().is_some_and(|r| r > 0), "{state}");

    let removes_before = d.world().removes;
    let began = Instant::now();
    assert_eq!(d.ask(&Request::Disconnect).await["status"], "ok");
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(eventually(Duration::from_secs(5), || d.world().finishes == 1).await, "the thorough stop never ran");
    let w = d.world();
    assert_eq!(w.hard_stops, 1);
    assert!(w.removes > removes_before, "the table was left standing");
    drop(w);
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], false);
}

/// The Windows behaviour: leak protection failing does not take the
/// tunnel down; the status says it is up and not confined, and why.
#[tokio::test]
async fn a_tunnel_whose_leak_protection_failed_stays_up_and_says_so() {
    let d = start("guardfail", World { guard_fails: true, ..Default::default() }).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], true, "{state}");
    assert_eq!(state["ipv4_confined"], false);
    assert_eq!(state["ipv6_blocked"], false);
    assert!(state["confinement_problem"].as_str().unwrap().contains("nftables"), "{state}");
    assert!(d.world().removes >= 1, "a half-written table was not removed");
}

#[tokio::test]
async fn a_failed_connect_says_why_in_the_contract_s_words() {
    let d = start("connfail", World { connect_fails: Some(Problem::NoNetwork), ..Default::default() }).await;
    let reply = d.ask(&connect()).await;
    assert_eq!(reply["message"], NO_NETWORK);
    let d = start("connfail2", World { connect_fails: Some(Problem::TimedOut("the handshake".into())), ..Default::default() }).await;
    let reply = d.ask(&connect()).await;
    assert_eq!(reply["message"], "timed out waiting for the handshake");
}

/// A Disconnect pressed during a slow connect reaches it: the connect
/// gives up at once and says it was stopped, and the Disconnect answers
/// promptly. Nothing is left standing.
#[tokio::test]
async fn a_disconnect_cancels_a_running_connect() {
    let d = start("cancel", World { connect_takes: Duration::from_secs(30), ..Default::default() }).await;
    let path = d.path.clone();
    let connecting = tokio::spawn(async move {
        let raw = serde_json::to_string(&connect()).unwrap();
        server::call(&path, &raw).await.unwrap()
    });
    assert!(eventually(Duration::from_secs(5), || d.world().connects == 1).await);

    // A status meanwhile answers at once, from the ledger: busy.
    let began = Instant::now();
    let state = d.ask(&Request::Status).await;
    assert!(began.elapsed() < Duration::from_millis(900), "status queued behind the connect");
    assert_ne!(state["health"]["state"], "down", "a guess was given as verified: {state}");

    let began = Instant::now();
    let reply = d.ask(&Request::Disconnect).await;
    assert!(began.elapsed() < Duration::from_secs(5), "the disconnect took {:?}", began.elapsed());
    assert!(reply["status"] == "ok" || reply["status"] == "error", "{reply}");

    let answered = tokio::time::timeout(Duration::from_secs(5), connecting).await.expect("the connect never gave up").unwrap();
    let answered: Value = serde_json::from_str(&answered).unwrap();
    assert_eq!(answered["message"], crate::lifecycle::budget::ABANDONED);
    assert_eq!(d.world().hard_stops, 0, "no tunnel came up, so none was stopped");
}

/// A connect still queued when the Disconnect arrives never dials.
#[tokio::test]
async fn a_disconnect_supersedes_a_queued_connect() {
    let d = start("supersede", World::default()).await;
    let (release, parked) = std::sync::mpsc::channel::<()>();
    let busy = d.shared.engines.run(move |_: &mut Session, _: &CancelToken| {
        let _ = parked.recv_timeout(Duration::from_secs(30));
    });
    let path = d.path.clone();
    let connecting = tokio::spawn(async move {
        let raw = serde_json::to_string(&connect()).unwrap();
        server::call(&path, &raw).await.unwrap()
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let path = d.path.clone();
    let disconnecting = tokio::spawn(async move { server::call(&path, r#"{"type":"disconnect"}"#).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    release.send(()).unwrap();
    busy.await.unwrap();

    let answered: Value = serde_json::from_str(&connecting.await.unwrap()).unwrap();
    assert_eq!(answered["message"], crate::lifecycle::budget::ABANDONED);
    let _ = disconnecting.await.unwrap();
    assert_eq!(d.world().connects, 0, "a superseded connect dialled");
}

/// The engine dies on its own: within a couple of seconds the helper has
/// taken the session down -- both halves and the table -- and the status
/// says it dropped, verified, as the Windows ledger does.
#[tokio::test]
async fn an_engine_that_dies_is_taken_down_and_reported() {
    let d = start("death", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    let removes_before = d.world().removes;
    d.world().health = TunnelHealth::Down;

    assert!(
        eventually(Duration::from_secs(5), || {
            let w = d.world();
            w.hard_stops == 1 && w.finishes == 1
        })
        .await,
        "the dead session was not torn down"
    );
    assert!(d.world().removes > removes_before, "the table outlived the tunnel");
    assert_eq!(d.world().hold_applies, 0, "held with the setting off");
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], false, "{state}");
    assert_eq!(state["health"]["state"], "down");
    assert!(d.shared.ledger.confirmed_drop().is_some());

    // A new connect forgets the drop.
    d.world().health = TunnelHealth::Alive { age_secs: 0 };
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert!(d.shared.ledger.confirmed_drop().is_none());
    assert_eq!(d.ask(&Request::Status).await["connected"], true);
}

/// Connecting again replaces the session: the old one is stopped in full
/// before the new one is dialled.
#[tokio::test]
async fn a_second_connect_replaces_the_first() {
    let d = start("replace", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    let w = d.world();
    assert_eq!((w.connects, w.hard_stops, w.finishes), (2, 1, 1));
}

/// A status while the owning thread is busy with something else comes
/// back from the machine's own look, never as a verified "down".
#[tokio::test]
async fn status_is_answered_while_the_owning_thread_is_busy() {
    let d = start("busy", World { visible: Some("neoconnect0".into()), ..Default::default() }).await;
    let (release, parked) = std::sync::mpsc::channel::<()>();
    let busy = d.shared.engines.run(move |_: &mut Session, _: &CancelToken| {
        let _ = parked.recv_timeout(Duration::from_secs(30));
    });
    let began = Instant::now();
    let state = d.ask(&Request::Status).await;
    assert!(began.elapsed() < Duration::from_secs(3));
    assert_eq!(state["connected"], true, "{state}");
    assert_eq!(state["health"]["state"], "unknown");
    d.world().visible = None;
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], false);
    assert_eq!(state["health"]["state"], "unknown", "a look that proved nothing was answered as down");
    release.send(()).unwrap();
    busy.await.unwrap();
}

/// One request from a python3 process standing in for the app (allowed by
/// its executable exactly as /usr/bin/neoxify is), which then lives on for
/// `linger` seconds before exiting.
const AS_THE_APP: &str = "import socket,sys,time\ns=socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\ns.sendall(sys.argv[2].encode()+b'\\n')\nprint(s.makefile().readline(),flush=True)\ns.close()\ntime.sleep(float(sys.argv[3]))\n";

fn as_the_app(python: &PathBuf, socket: &PathBuf, request: &Request, linger: f32) -> std::process::Child {
    std::process::Command::new(python)
        .arg("-c")
        .arg(AS_THE_APP)
        .arg(socket)
        .arg(serde_json::to_string(request).unwrap())
        .arg(linger.to_string())
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("python3")
}

/// The app that connected exits: its tunnel comes down, both halves and
/// the table, without waiting for the idle watchdog. Another process that
/// passes as the app and only asks the status is not the session's owner:
/// its exit leaves the tunnel alone.
#[tokio::test]
async fn the_app_exiting_takes_its_tunnel_down() {
    let Ok(python) = std::fs::canonicalize("/usr/bin/python3") else {
        eprintln!("skipped: no python3 to stand in for the app");
        return;
    };
    let d = start_with("appgone", World::default(), Policy::new(my_uid(), vec![python.clone()])).await;

    let mut owner = as_the_app(&python, &d.path, &connect_holding(), 3.0);
    assert!(eventually(Duration::from_secs(10), || d.world().connects == 1).await, "the app's connect never ran");
    assert!(eventually(Duration::from_secs(5), || d.shared.ledger.live_protocol().is_some()).await);
    assert_eq!(d.world().adopted.len(), 1, "the app wanting the hold was not put in its group");

    let mut other = as_the_app(&python, &d.path, &Request::Status, 0.0);
    let _ = tokio::task::spawn_blocking(move || other.wait()).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(d.world().hard_stops, 0, "a status poller's exit took the owner's tunnel down");

    let _ = tokio::task::spawn_blocking(move || owner.wait()).await;
    assert!(
        eventually(Duration::from_secs(5), || {
            let w = d.world();
            w.hard_stops == 1 && w.finishes == 1
        })
        .await,
        "the tunnel outlived the app"
    );
    let w = d.world();
    assert!(w.hold_in.is_none() && w.table.is_none(), "the app's exit left a table: nobody is left to reconnect");
    drop(w);
    assert_eq!(d.ask(&Request::Status).await["connected"], false);
}

/// A status asked while a connect runs says not connected, even once the
/// link is visible: nothing past the link is in yet.
#[tokio::test]
async fn a_status_during_a_connect_is_not_connected() {
    let d = start(
        "midconnect",
        World { connect_takes: Duration::from_secs(3), visible: Some("neoxify-wg".into()), ..Default::default() },
    )
    .await;
    let path = d.path.clone();
    let connecting = tokio::spawn(async move {
        let raw = serde_json::to_string(&connect()).unwrap();
        server::call(&path, &raw).await.unwrap()
    });
    assert!(eventually(Duration::from_secs(5), || d.world().connects == 1).await);
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], false, "{state}");
    assert_ne!(state["health"]["state"], "down", "{state}");
    let answered: Value = serde_json::from_str(&connecting.await.unwrap()).unwrap();
    assert_eq!(answered["status"], "ok");
}

/// Something else flushes the ruleset under a live tunnel: the table is
/// put back. And when it cannot be, the status stops claiming it.
#[tokio::test]
async fn a_table_flushed_by_someone_else_is_put_back_or_reported_gone() {
    let d = start("flushed", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert_eq!(d.world().applies, 1);
    d.world().table = None;
    assert!(eventually(Duration::from_secs(5), || d.world().applies == 2).await, "the table was not put back");
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["ipv6_blocked"], true, "{state}");

    d.world().guard_fails = true;
    d.world().table = None;
    assert!(eventually(Duration::from_secs(5), || d.world().applies == 3).await);
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], true, "{state}");
    assert_eq!(state["ipv6_blocked"], false, "{state}");
    assert_eq!(state["ipv4_confined"], false, "{state}");
    assert!(state["confinement_problem"].as_str().unwrap().contains("removed by something else"), "{state}");
}

/// The machine's DNS rewritten under a live tunnel is reported, not
/// covered by what was true at connect.
#[tokio::test]
async fn dns_rewritten_mid_session_is_reported_unprotected() {
    let d = start("dnsgone", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert_eq!(d.ask(&Request::Status).await["tunnel_dns_unprotected"], false);
    d.world().dns_in_force = false;
    let mut reported = false;
    for _ in 0..50 {
        if d.ask(&Request::Status).await["tunnel_dns_unprotected"] == true {
            reported = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reported, "DNS stayed reported as protected");
    assert_eq!(d.shared.ledger.guard().map(|g| g.dns_protected), Some(false), "the busy-path record was not updated");
}

// ---------------------------------------------------------------------
// The reconnect hold.
// ---------------------------------------------------------------------

/// The whole episode: armed while up; the engine dies and the hold goes
/// in in place of the confinement -- never a moment with no table; a
/// connect under it carries and is confined over it; `landed` until the
/// app lets go, and the confinement stays when it does.
#[tokio::test]
async fn a_drop_is_held_and_a_reconnect_lands_under_it() {
    let d = start("holdcycle", World::default()).await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    assert_eq!(d.hold_state().await["state"], "armed");

    let removes_before = d.world().removes;
    d.world().health = TunnelHealth::Down;
    assert!(eventually(Duration::from_secs(5), || d.world().hold_in.is_some()).await, "the drop was not held");
    assert!(eventually(Duration::from_secs(5), || d.world().finishes == 1).await);
    {
        let w = d.world();
        assert_eq!(w.removes, removes_before, "the table was removed before the hold: a moment with no rules");
        let plan = w.hold_in.clone().unwrap();
        for link in hold::OUR_LINKS {
            assert!(plan.tunnel_ifaces.iter().any(|i| i == link), "{link} not in {plan:?}");
        }
        assert!(plan.servers.contains(&Ipv4Addr::new(198, 51, 100, 7)), "a known node: {plan:?}");
        assert!(plan.servers.contains(&Ipv4Addr::new(192, 0, 2, 10)), "the session's own server: {plan:?}");
        assert_eq!(plan.servers.len(), 2, "a name was looked up, or a server repeated: {plan:?}");
        assert_eq!(plan.engine_fwmark, Some(hold::WIREGUARD_MARK));
        assert_eq!(plan.resolvers, vec![IpAddr::V4(Ipv4Addr::new(198, 51, 100, 53))]);
        assert!(!plan.dns_anywhere);
        assert_eq!(plan.lan.len(), 1);
    }
    let held = d.hold_state().await;
    assert_eq!(held["state"], "holding", "{held}");
    assert!(held.get("landed").is_none() && held.get("standing_refused").is_none(), "{held}");

    d.world().health = TunnelHealth::Alive { age_secs: 0 };
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    {
        let w = d.world();
        assert!(w.hold_in.is_none() && w.table.is_some(), "the new tunnel was not confined over the hold");
    }
    let held = d.hold_state().await;
    assert_eq!(held["state"], "holding");
    assert_eq!(held["landed"], true, "{held}");

    assert_eq!(d.ask(&Request::ReleaseReconnectHold).await["status"], "ok");
    assert_eq!(d.hold_state().await["state"], "armed");
    assert!(d.world().table.is_some(), "letting go of the hold took the live tunnel's confinement");
}

/// The app's own reconnect holds from before the engine stops; a plain
/// Disconnect lets go at once.
#[tokio::test]
async fn a_reconnect_holds_and_a_disconnect_lets_go() {
    let d = start("holdrecon", World::default()).await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    assert_eq!(d.ask(&Request::DisconnectForReconnect).await["status"], "ok");
    assert!(d.world().hold_in.is_some(), "a reconnect's teardown was not held");
    assert_eq!(d.hold_state().await["state"], "holding");

    assert_eq!(d.ask(&Request::Disconnect).await["status"], "ok");
    let w = d.world();
    assert!(w.hold_in.is_none() && w.table.is_none(), "the customer's Disconnect left the machine held");
    drop(w);
    assert!(d.hold_state().await.is_null(), "a Disconnect is not a problem to report");
}

/// Turning the setting off lets go; turning it on arms the live session.
#[tokio::test]
async fn the_setting_lets_go_and_arms() {
    let d = start("holdsetting", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert!(d.hold_state().await.is_null());
    assert_eq!(d.ask(&Request::SetReconnectHold { enabled: true }).await["status"], "ok");
    assert!(eventually(Duration::from_secs(3), || d.shared.hold.armed_for(d.shared.ledger.live_generation().unwrap_or(0))).await);
    assert_eq!(d.hold_state().await["state"], "armed");

    assert_eq!(d.ask(&Request::DisconnectForReconnect).await["status"], "ok");
    assert!(d.world().hold_in.is_some());
    assert_eq!(d.ask(&Request::SetReconnectHold { enabled: false }).await["status"], "ok");
    assert!(d.world().hold_in.is_none(), "turned off, still held");
}

/// A hold that will not go in fails open: the confinement goes as it
/// would without the setting, and the status says why.
#[tokio::test]
async fn a_hold_that_will_not_go_in_fails_open_and_says_so() {
    let d = start("holdrefused", World { hold_fails: true, ..Default::default() }).await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    d.world().health = TunnelHealth::Down;
    assert!(eventually(Duration::from_secs(5), || d.world().finishes == 1).await);
    let w = d.world();
    assert!(w.table.is_none() && w.hold_in.is_none(), "a table was left with nothing held");
    drop(w);
    let held = d.hold_state().await;
    assert_eq!(held["state"], "notHeld", "{held}");
    assert_eq!(held["problem"], "filtersRefused");
}

/// A connect the hold does not cover -- IKEv2, Custom mode -- lets go of
/// it before that one dials; a server named by a name is resolved and
/// put in the plan first.
#[tokio::test]
async fn a_connect_under_the_hold_widens_it_or_lets_go() {
    let d = start("holdwiden", World { resolve: Some(Ipv4Addr::new(203, 0, 113, 9)), ..Default::default() }).await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    assert_eq!(d.ask(&Request::DisconnectForReconnect).await["status"], "ok");
    d.world().connect_fails = Some(Problem::TimedOut("the handshake".into()));
    let mut named = wireguard();
    if let ConnectProfile::Wireguard(p) = &mut named {
        p.endpoint = "wg.example.com:51820".into();
    }
    let reply = d
        .ask(&Request::Connect { profile: named, exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: true })
        .await;
    assert_eq!(reply["status"], "error");
    let plan = d.world().hold_in.clone().expect("a failed rung let go of the hold");
    assert!(plan.servers.contains(&Ipv4Addr::new(203, 0, 113, 9)), "the dialled server was not permitted: {plan:?}");

    d.world().connect_fails = None;
    let reply = d
        .ask(&Request::Connect { profile: ikev2(), exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: true })
        .await;
    assert_eq!(reply["status"], "ok");
    assert!(d.world().hold_in.is_none(), "IKEv2 was dialled under the hold");
    let held = d.hold_state().await;
    assert_eq!(held["state"], "notHeld", "{held}");
    assert_eq!(held["problem"], "notCovered");
}

/// The backstops: a drop nothing follows is let go of; so is one that
/// holds past the longest with no tunnel.
#[tokio::test]
async fn a_hold_nothing_follows_or_that_holds_too_long_is_let_go() {
    let d = start_full(
        "holdexpire",
        World::default(),
        Policy::new(my_uid(), Vec::new()),
        Some((Duration::from_secs(3600), Duration::from_millis(300))),
    )
    .await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    d.world().health = TunnelHealth::Down;
    assert!(eventually(Duration::from_secs(5), || d.world().hold_in.is_some()).await);
    assert!(eventually(Duration::from_secs(5), || d.world().hold_in.is_none()).await, "an unfollowed hold stayed");
    let held = d.hold_state().await;
    assert_eq!(held["problem"], "other", "{held}");

    let world: WorldRef = Arc::new(Mutex::new(World::default()));
    let hold = Hold::with_limits(Arc::new(Fake(Arc::clone(&world))), Duration::from_millis(200), Duration::from_secs(3600));
    hold.set_wanted(true);
    assert!(hold.arm(7, Arming { ifaces: vec!["neoconnect0".into()], servers: vec![Ipv4Addr::new(192, 0, 2, 1)] }));
    assert!(hold.engage(7, "test"));
    hold.followed();
    std::thread::sleep(Duration::from_millis(250));
    hold.tend(None);
    assert!(!hold.holding());
    assert!(matches!(hold.report(None), Some(ReconnectHold::NotHeld { problem: ReconnectHoldProblem::TimedOut, .. })));
}

/// A let-go the app cannot predict is said in a status first.
#[test]
fn a_let_go_is_said_before_it_is_made() {
    let world: WorldRef = Arc::new(Mutex::new(World::default()));
    let hold = Hold::new(Arc::new(Fake(Arc::clone(&world))));
    hold.set_wanted(true);
    hold.arm(3, Arming::default());
    assert!(hold.engage(3, "test"));
    let letting = Arc::clone(&hold);
    let waiter = std::thread::spawn(move || {
        letting.let_go_once_said(Release::Failed(ReconnectHoldProblem::NotCovered, "x".into()), Duration::from_secs(5))
    });
    let mut said = false;
    for _ in 0..100 {
        if hold.report(None) == Some(ReconnectHold::LettingGo) {
            said = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(said, "the status never said it was letting go");
    assert!(waiter.join().unwrap());
    assert!(world.lock().unwrap().hold_in.is_none());
    // The app is moved into its group once per process.
    hold.adopt(42);
    hold.adopt(42);
    assert_eq!(world.lock().unwrap().adopted, vec![42]);
}

/// Resolvers read as none keep the ones held, and with none ever read
/// port 53 is open to anywhere, which the status says.
#[test]
fn unread_resolvers_are_said_and_a_network_going_down_keeps_them() {
    let world: WorldRef = Arc::new(Mutex::new(World { resolvers: Vec::new(), ..Default::default() }));
    let hold = Hold::new(Arc::new(Fake(Arc::clone(&world))));
    hold.set_wanted(true);
    hold.arm(5, Arming::default());
    assert!(hold.engage(5, "test"));
    assert!(matches!(hold.report(None), Some(ReconnectHold::Holding { dns_anywhere: true, .. })));
    assert!(world.lock().unwrap().hold_in.as_ref().unwrap().dns_anywhere);
}

// ---------------------------------------------------------------------
// Custom mode.
// ---------------------------------------------------------------------

/// The shape reaches the connect; no machine-wide table stands in Custom
/// mode and the status says so honestly; the kernel's word on the
/// sorting is reported.
#[tokio::test]
async fn custom_mode_connects_split_without_a_machine_wide_table() {
    let d = start(
        "custom",
        World {
            split: Some(SplitState {
                active: true,
                problem: Some(("no app traffic yet".into(), SplitTunnelProblemCode::NoAppTraffic)),
                restart_needed: vec!["firefox".into()],
            }),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(d.ask(&custom(SplitTunnelMode::OnlySelected, &["/usr/bin/firefox"])).await["status"], "ok");
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    {
        let w = d.world();
        assert_eq!(w.last_shape, Some(Shape::OnlySelected(vec!["/usr/bin/firefox".into()])));
        assert_eq!(w.applies, 0, "a machine-wide table went in under Custom mode");
        assert!(w.table.is_none());
    }
    let state = d.ask(&Request::Status).await;
    assert_eq!(state["connected"], true);
    assert_eq!(state["ipv4_confined"], false);
    assert_eq!(state["ipv6_blocked"], false);
    assert!(state.get("confinement_problem").is_none(), "{state}");
    assert_eq!(state["split_tunnel_active"], true);
    assert_eq!(state["split_tunnel_problem_code"], "noAppTraffic");
    assert_eq!(state["split_tunnel_restart_needed"][0], "firefox");
    assert!(state.get("reconnect_hold").is_none(), "Custom mode is not held: {state}");

    // Its drop is not held.
    d.world().health = TunnelHealth::Down;
    assert!(eventually(Duration::from_secs(5), || d.world().finishes == 1).await);
    assert_eq!(d.world().hold_applies, 0);
}

/// Changed while connected: applied in place; off puts the confinement
/// back; a change the tunnel refuses leaves the earlier state and says why.
#[tokio::test]
async fn custom_mode_changes_in_place_or_keeps_the_earlier_state() {
    let d = start("reshape", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    assert!(d.world().table.is_some());

    assert_eq!(d.ask(&custom(SplitTunnelMode::AllExcept, &["/usr/bin/curl"])).await["status"], "ok");
    {
        let w = d.world();
        assert_eq!(w.shape_now, Shape::AllExcept(vec!["/usr/bin/curl".into()]));
        assert!(w.table.is_none(), "the machine-wide table stayed under Custom mode");
        assert_eq!(w.connects, 1, "the tunnel was redialled for a change it can make in place");
    }
    assert_eq!(d.ask(&Request::Status).await["ipv4_confined"], false);

    d.world().reshape_fails = true;
    let reply = d.ask(&custom(SplitTunnelMode::OnlySelected, &["/usr/bin/zed"])).await;
    assert_eq!(reply["status"], "error");
    assert!(reply["message"].as_str().unwrap().contains("refused the rules"), "{reply}");
    assert_eq!(d.world().shape_now, Shape::AllExcept(vec!["/usr/bin/curl".into()]), "a refused change changed something");

    d.world().reshape_fails = false;
    assert_eq!(d.ask(&Request::SetSplitTunnel { config: SplitTunnelConfig::default() }).await["status"], "ok");
    assert!(d.world().table.is_some(), "the confinement did not come back with Custom mode off");
    assert_eq!(d.ask(&Request::Status).await["ipv4_confined"], true);
}

#[tokio::test]
async fn custom_mode_is_checked_with_linux_rules_and_answers_its_questions() {
    let d = start(
        "customask",
        World {
            running: vec![
                Running { pid: 10, app: "/usr/lib/firefox/firefox".into(), name: "firefox".into() },
                Running { pid: 11, app: "/usr/lib/firefox/firefox".into(), name: "firefox".into() },
            ],
            probe: Err("the tunnel did not answer".into()),
            ..Default::default()
        },
    )
    .await;
    let reply = d.ask(&custom(SplitTunnelMode::OnlySelected, &["firefox"])).await;
    assert_eq!(reply["status"], "error", "a bare name passed: {reply}");

    let apps = d.ask(&Request::ListRunningApps).await;
    assert_eq!(apps["apps"].as_array().unwrap().len(), 1, "{apps}");
    assert_eq!(apps["apps"][0]["pids"], serde_json::json!([10, 11]));
    assert_eq!(d.world().running_for, Some(my_uid()), "another user's programs were listed");

    assert_eq!(d.ask(&connect()).await["status"], "ok");
    let probe = d.ask(&Request::ProbeSplitTunnel).await;
    assert_eq!(probe["message"], "the tunnel did not answer");
    let with_egress = Request::SetSplitTunnel {
        config: SplitTunnelConfig {
            enabled: true,
            apps: vec!["/usr/bin/curl".into()],
            egress: Some("Germany".into()),
            ..Default::default()
        },
    };
    assert_eq!(d.ask(&with_egress).await["status"], "ok");
    let exits = d.ask(&Request::SplitTunnelExits).await;
    assert_eq!(exits["egress"], "Germany", "{exits}");
    assert_eq!(exits["apps"], serde_json::json!([]));
}

// ---------------------------------------------------------------------
// Repair and the Linux-only requests.
// ---------------------------------------------------------------------

/// Repair disconnects first, looks before it acts, and reports each step
/// in order from what it found.
#[tokio::test]
async fn repair_disconnects_and_reports_what_it_found() {
    let d = start("repair", World::default()).await;
    assert_eq!(d.ask(&connect_holding()).await["status"], "ok");
    d.world().survey = Survey { engines: Some(1), links: Some(vec!["neoxify-wg".into()]), ..clean_survey() };
    let reply = d.ask(&Request::Repair).await;
    assert_eq!(reply["status"], "repaired", "{reply}");
    let steps = reply["report"]["steps"].as_array().unwrap();
    let ids: Vec<&str> = steps.iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["tunnel", "engines", "dns", "routes", "firewall", "links", "groups"]);
    assert_eq!(steps[0]["outcome"], "fixed", "{reply}");
    assert_eq!(steps[1]["outcome"], "fixed");
    assert_eq!(steps[2]["outcome"], "alreadyClean");
    assert_eq!(steps[5]["outcome"], "fixed");
    assert!(steps.iter().all(|s| s["label"].as_str().is_some_and(|l| !l.is_empty())));
    let w = d.world();
    assert_eq!(w.hard_stops, 1);
    assert!(w.sweeps >= 1);
    assert!(w.table.is_none() && w.hold_in.is_none());
    drop(w);
    assert_eq!(d.ask(&Request::Status).await["connected"], false);
}

#[tokio::test]
async fn the_linux_requests_are_told_apart_and_answered() {
    let d = start("linux", World::default()).await;
    let diag = d.ask_json(r#"{"type":"linuxDiagnostics"}"#).await;
    assert_eq!(diag["status"], "linuxDiagnostics", "{diag}");
    assert_eq!(diag["diagnostics"]["helperVersion"], "0.2.0");
    assert_eq!(diag["diagnostics"]["ourLinks"].as_array().unwrap().len(), 3);
    assert!(diag["diagnostics"]["recentLog"].is_array());

    let support = d.ask_json(r#"{"type":"updateSupport"}"#).await;
    assert_eq!(support["status"], "updateSupport", "{support}");
    assert_eq!(support["version"], "0.2.0");
    assert!(support["kind"].is_null(), "a test binary claimed to be the installed helper: {support}");
    assert!(support["reason"].as_str().is_some_and(|r| !r.is_empty()));

    let outcome = d.ask_json(r#"{"type":"updateOutcome"}"#).await;
    assert_eq!(outcome["outcome"]["state"], "none", "{outcome}");

    // Root's own tools are not the app: an install is refused, and so it is
    // with a tunnel up whoever asks.
    let refused = d.ask_json(r#"{"type":"installUpdate","package":"/tmp/x.deb","signature":"x"}"#).await;
    assert_eq!(refused["status"], "error");
    assert!(refused["message"].as_str().unwrap().contains("only the Neoxify app"), "{refused}");
}

#[tokio::test]
async fn an_install_is_refused_while_connected() {
    let d = start("installup", World::default()).await;
    assert_eq!(d.ask(&connect()).await["status"], "ok");
    let request = neoxify_linux_wire::LinuxRequest::InstallUpdate { package: "/tmp/x.deb".into(), signature: "x".into() };
    let reply = server::dispatch_linux(request, &d.shared, &Caller::App { pid: 1, uid: 1000 }).await;
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["status"], "error");
    assert!(reply["message"].as_str().unwrap().contains("disconnect first"), "{reply}");
}
