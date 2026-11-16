//! The daemon end to end over a real Unix socket, with a fake machine
//! behind it: framing, who may call, every request, supersede and cancel,
//! the engine-death path. Nothing here needs root or touches the network;
//! what a real tunnel does is for the VM.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use neoconnect_ipc::{
    ConnectProfile, ExitProfile, GamingConfig, Ikev2Profile, Request, SplitTunnelConfig, TunnelHealth, WireguardProfile,
    NO_NETWORK,
};
use neoxify_netguard::{Applied, Cidr4, Plan, Removal};
use neoxify_tunnel::{Dirs, Limits, Problem, Proto, Transport, Tunnel, Up};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::backend::Backend;
use crate::lifecycle::cancel::CancelToken;
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::peer::{Caller, Policy};
use neoconnect_ipc::Response;
use crate::server::{self, Shared};
use crate::session::Session;

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
        _dirs: &Dirs,
        limits: &Limits,
    ) -> Result<Box<dyn Tunnel>, Problem> {
        let (takes, fails) = {
            let mut w = self.0.lock().unwrap();
            w.connects += 1;
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
        self.0.lock().unwrap().visible = Some("neoxify-wg".into());
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
        Ok(applied)
    }
    fn guard_remove(&self) -> Result<Removal, neoxify_netguard::Error> {
        let mut w = self.0.lock().unwrap();
        w.removes += 1;
        w.table = None;
        Ok(Removal::Removed)
    }
    fn guard_in_force(&self) -> Result<Option<Applied>, neoxify_netguard::Error> {
        Ok(self.0.lock().unwrap().table)
    }
    fn lan_prefixes(&self, _exclude_ifaces: &[&str]) -> Vec<Cidr4> {
        vec![Cidr4 { addr: Ipv4Addr::new(198, 51, 100, 0), prefix: 24 }]
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

async fn start_with(name: &str, world: World, policy: Policy) -> Daemon {
    let dir = std::env::temp_dir().join(format!("nxh-{}-{name}", std::process::id()));
    let path = dir.join("helper.sock");
    let world = Arc::new(Mutex::new(world));
    let backend: Arc<dyn Backend> = Arc::new(Fake(Arc::clone(&world)));
    let ledger = Arc::new(Ledger::new());
    let dirs = Dirs { bin: dir.clone(), state: dir.clone(), run: dir.clone() };
    let engines = Supervisor::spawn(Session::new(Arc::clone(&backend), dirs, Arc::clone(&ledger)), "test-session");
    let shared = Shared::new(engines, ledger, backend, Arc::new(policy));
    let listener = server::bind(&path).expect("bind");
    let serving = shared.clone();
    tokio::spawn(async move { server::serve(listener, serving, std::future::pending()).await });
    Daemon { path, world, shared }
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

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
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

fn connect() -> Request {
    Request::Connect { profile: wireguard(), exits: Vec::new(), known_nodes: Vec::new(), block_while_reconnecting: false }
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
    for raw in [r#"{"type":"zzsecretzz"}"#, "zzsecretzz is not json", r#"{"type":"connect","profile":{"protocol":"zzsecretzz"}}"#] {
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
/// the screen nor in the group is refused, and reaches nothing.
#[tokio::test]
async fn the_app_run_by_someone_not_at_the_screen_is_refused() {
    let me = std::env::current_exe().unwrap();
    let d = start_with("appaway", World::default(), seated_policy("appaway", vec![me], false)).await;
    let reply = d.ask(&connect()).await;
    assert_eq!(reply["status"], "error", "{reply}");
    assert!(reply["message"].as_str().unwrap().contains("only the Neoxify app"), "{reply}");
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
/// live with: Ok where it calls defensively, a plain refusal where it asks
/// for something Linux does not have.
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
        (Request::SetReconnectHold { enabled: false }, "ok", None),
        (Request::SetReconnectHold { enabled: true }, "error", Some("not available on Linux")),
        (Request::WayOut { profile: wireguard() }, "ok", None),
        (Request::SetSplitTunnel { config: off }, "ok", None),
        (Request::SetSplitTunnel { config: on }, "error", Some("not available on Linux")),
        (Request::ProbeSplitTunnel, "error", Some("not available on Linux")),
        (Request::SplitTunnelExits, "error", Some("not available on Linux")),
        (Request::ListRunningApps, "error", Some("not available on Linux")),
        (Request::Repair, "error", Some("not available on Linux")),
        (Request::Diagnostics, "error", Some("not available on Linux")),
        (Request::ArmGaming { config: GamingConfig::default() }, "error", Some("not available on Linux")),
        (Request::DisarmGaming, "ok", None),
        (Request::GamingStatus, "gaming", None),
        (
            Request::Connect {
                profile: ConnectProfile::Ikev2(Ikev2Profile {
                    server: "vpn.example.com".into(),
                    username: "u".into(),
                    password: "p".into(),
                }),
                exits: Vec::new(),
                known_nodes: Vec::new(),
                block_while_reconnecting: false,
            },
            "error",
            Some("IKEv2 is not available on Linux yet"),
        ),
    ];
    for (request, status, says) in cases {
        let label = format!("{request:?}");
        let reply = d.ask(&request).await;
        assert_eq!(reply["status"], status, "{label}: {reply}");
        if let Some(says) = says {
            assert!(reply["message"].as_str().unwrap_or("").contains(says), "{label}: {reply}");
        }
    }
    assert_eq!(d.world().connects, 0, "IKEv2 reached the engine");
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
    assert!(state.get("reconnect_hold").is_none());
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

    let mut owner = as_the_app(&python, &d.path, &connect(), 3.0);
    assert!(eventually(Duration::from_secs(10), || d.world().connects == 1).await, "the app's connect never ran");
    assert!(eventually(Duration::from_secs(5), || d.shared.ledger.live_protocol().is_some()).await);

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
