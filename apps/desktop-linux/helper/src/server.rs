//! The control socket.
//!
//! The Windows wire contract, unchanged: one JSON `Request` per line in,
//! one JSON `Response` per line out, one connection per request (several
//! lines on one connection are served in turn, as on Windows). Anything
//! that changes the machine is run one at a time on the supervisor's
//! thread; the questions a stranded customer asks -- "am I tunnelled" and
//! "get me out" -- never queue behind a slow one. See [`dispatch`], whose
//! shape is the Windows service's `pipe::dispatch`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use neoconnect_ipc::{ConnectProfile, GamingPhase, Request, Response, TunnelHealth, NO_NETWORK};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::backend::Backend;
use crate::lifecycle::budget::ABANDONED;
use crate::lifecycle::client_watch::{self, PidWatch};
use crate::lifecycle::idle::{IdleTick, IdleWatch, IDLE_GRACE, IDLE_POLL};
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::peer::{Caller, Policy};
use crate::session::{nothing, Session};

/// Caps a single request line. A profile with three PEM blocks is a few
/// kilobytes; this leaves generous headroom while stopping a caller from
/// making the helper buffer without bound.
pub const MAX_REQUEST_BYTES: u64 = 512 * 1024;

/// How long `status` waits for the owning thread before answering from
/// what the machine shows instead. Far too short to be held up by a
/// connect.
const STATUS_LOCK_WAIT: Duration = Duration::from_secs(1);

/// How long `disconnect` waits for its hard stop before answering from
/// what the machine shows. Anything past this is something slow or stuck,
/// and a customer who pressed Disconnect meant it.
const DISCONNECT_LOCK_WAIT: Duration = Duration::from_secs(2);

/// How often the engine is asked whether it is still there. Windows waits
/// on a kernel handle; on Linux the tunnel crate answers from the engine
/// process and the link, and a second is what the Windows engine watch's
/// slice is.
const HEALTH_POLL: Duration = Duration::from_secs(1);

const SPLIT_TUNNEL_UNAVAILABLE: &str = "Custom mode is not available on Linux yet";
const IKEV2_UNAVAILABLE: &str = "IKEv2 is not available on Linux yet";
const REFUSED: &str =
    "only the Neoxify app, run by the person at this computer's screen or by a member of the neoxify group, may control the Neoxify helper";
const ANOTHER_USERS_SESSION: &str = "another user's Neoxify connection is active on this computer";

/// How long a connection may take to send each request line. The app
/// writes its request the moment it connects; a caller that sends nothing
/// is holding a descriptor, and is let go.
pub const REQUEST_WAIT: Duration = Duration::from_secs(5);

/// How many connections are served at once. The app uses one at a time,
/// a few when a status crosses a connect; this is far above that and far
/// below the unit's descriptor limit, so a flood of connections waits its
/// turn rather than leaving no descriptor for the `nft` and `ip` that a
/// teardown has to run.
pub const MAX_CONNECTIONS: usize = 256;

/// Who owns the live session: the caller whose Connect made it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Owner {
    uid: u32,
    /// The app's process, watched; `None` for root's tools, which are not.
    pid: Option<u32>,
}

/// Everything a connection handler needs. Cheap to clone.
#[derive(Clone)]
pub struct Shared {
    pub engines: Supervisor<Session>,
    pub ledger: Arc<Ledger>,
    pub backend: Arc<dyn Backend>,
    pub policy: Arc<Policy>,
    /// The last time the app asked anything.
    last_seen: Arc<Mutex<Instant>>,
    /// The session's owner. Only its Connect sets it, so another process
    /// that passes as the app -- a status poll, a second user's app --
    /// neither takes over the exit watch nor decides when the tunnel ends.
    owner: Arc<Mutex<Option<Owner>>>,
    /// The process being watched, so a second Connect from the same app
    /// does not produce a second watch.
    watched: Arc<Mutex<Option<u32>>>,
    slots: Arc<tokio::sync::Semaphore>,
}

impl Shared {
    pub fn new(engines: Supervisor<Session>, ledger: Arc<Ledger>, backend: Arc<dyn Backend>, policy: Arc<Policy>) -> Self {
        Self {
            engines,
            ledger,
            backend,
            policy,
            last_seen: Arc::new(Mutex::new(Instant::now())),
            owner: Arc::new(Mutex::new(None)),
            watched: Arc::new(Mutex::new(None)),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
        }
    }

    fn owner(&self) -> std::sync::MutexGuard<'_, Option<Owner>> {
        self.owner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn heard(&self) {
        if let Ok(mut seen) = self.last_seen.lock() {
            *seen = Instant::now();
        }
    }
}

/// Binds the socket: its directory made 0755 and root's, a stale socket
/// from a crash removed, and the socket itself 0666 -- who may call is
/// decided per connection from the kernel's word (`peer`), not by mode.
pub fn bind(path: &Path) -> std::io::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755))?;
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    Ok(listener)
}

/// Serves until `stop` resolves, then returns; the caller tears down.
pub async fn serve(listener: UnixListener, shared: Shared, stop: impl std::future::Future<Output = ()>) {
    spawn_health_watch(shared.clone());
    spawn_idle_watchdog(shared.clone());
    tokio::pin!(stop);
    loop {
        // A slot before accepting, so a flood waits in the listen backlog
        // instead of taking every descriptor the helper has.
        let slot = tokio::select! {
            _ = &mut stop => return,
            slot = Arc::clone(&shared.slots).acquire_owned() => match slot {
                Ok(slot) => slot,
                Err(_) => return,
            },
        };
        tokio::select! {
            _ = &mut stop => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let shared = shared.clone();
                    tokio::spawn(async move {
                        let _slot = slot;
                        if let Err(err) = handle_connection(stream, shared).await {
                            eprintln!("neoxify-helper: connection error: {err}");
                        }
                    });
                }
                // A transient failure (out of descriptors) must not end
                // the daemon; a moment's pause stops it spinning.
                Err(err) => {
                    eprintln!("neoxify-helper: accept failed: {err}");
                    // The app cannot reach us now, which is not the app
                    // having gone: the idle watchdog must not take that
                    // silence for it. The process watch still sees an exit.
                    shared.heard();
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
        }
    }
}

async fn handle_connection(stream: UnixStream, shared: Shared) -> std::io::Result<()> {
    let (uid, pid) = match stream.peer_cred() {
        Ok(cred) => (Some(cred.uid()), cred.pid()),
        Err(_) => (None, None),
    };
    // The process is pinned before anything is read about it, so the
    // judgement below cannot be of a pid that was recycled meanwhile.
    let pinned = pid.and_then(|p| u32::try_from(p).ok()).and_then(|p| PidWatch::open(p).ok());
    let mut caller = match uid {
        Some(uid) => shared.policy.judge(uid, pid),
        None => Caller::Refused { who: "a caller whose credentials could not be read".into() },
    };
    if matches!(caller, Caller::App { .. }) && pinned.as_ref().is_some_and(|p| !p.still_running()) {
        caller = Caller::Refused { who: "a process that exited while it was being checked".into() };
    }
    let mut pinned = pinned;

    // Refused: answered at once and let go, without reading a byte, so a
    // refused caller holds nothing. What it may have sent is read for a
    // moment afterwards only so that closing does not cut off the answer.
    if let Caller::Refused { who } = &caller {
        if shared.policy.first_refusal(who) {
            eprintln!("neoxify-helper: refused a caller ({who})");
        }
        let mut stream = stream;
        let mut encoded = serde_json::to_string(&Response::Error { message: REFUSED.to_string() }).unwrap_or_default();
        encoded.push('\n');
        let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(encoded.as_bytes())).await;
        let _ = stream.shutdown().await;
        let mut sink = [0u8; 4096];
        let _ = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut sink)).await;
        return Ok(());
    }
    shared.heard();

    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read =
            match tokio::time::timeout(REQUEST_WAIT, (&mut reader).take(MAX_REQUEST_BYTES).read_until(b'\n', &mut line))
                .await
            {
                Ok(read) => read?,
                // Nothing, or no whole line, in time: let go.
                Err(_) => return Ok(()),
            };
        if read == 0 {
            return Ok(());
        }
        let too_long = line.last() != Some(&b'\n') && read as u64 >= MAX_REQUEST_BYTES;

        let response = if too_long {
            Response::Error { message: "malformed request: longer than the helper accepts".to_string() }
        } else {
            match serde_json::from_slice::<Request>(trim(&line)) {
                Ok(request @ Request::Connect { .. }) => match claim_session(&shared, &caller, &mut pinned) {
                    Some(refusal) => refusal,
                    None => dispatch(request, &shared).await,
                },
                Ok(request) => dispatch(request, &shared).await,
                Err(err) => Response::Error { message: malformed(&err) },
            }
        };

        let mut encoded = serde_json::to_string(&response)
            .unwrap_or_else(|_| r#"{"status":"error","message":"could not encode response"}"#.to_string());
        encoded.push('\n');
        reader.get_mut().write_all(encoded.as_bytes()).await?;
        reader.get_mut().flush().await?;
        // Again on the way out, so a long request counts as the app being
        // alive for its whole duration.
        shared.heard();
        if too_long {
            return Ok(());
        }
    }
}

/// A Connect makes its caller the session's owner, and the app's process
/// the one watched. Refused while another user's session is live or being
/// made: one person's tunnel is not another's to replace.
pub(crate) fn claim_session(shared: &Shared, caller: &Caller, pinned: &mut Option<PidWatch>) -> Option<Response> {
    let (uid, pid) = match caller {
        Caller::App { pid, uid } => (*uid, Some(*pid)),
        Caller::Trusted => (shared.policy.trusted_uid, None),
        Caller::Refused { .. } => return Some(Response::Error { message: REFUSED.to_string() }),
    };
    {
        let mut owner = shared.owner();
        let session_standing = shared.ledger.live_protocol().is_some() || shared.ledger.is_connecting();
        let someone_else = owner.is_some_and(|o| o.uid != uid);
        // Root's own tools may always act: they are root's to run.
        if session_standing && someone_else && !matches!(caller, Caller::Trusted) {
            return Some(Response::Error { message: ANOTHER_USERS_SESSION.to_string() });
        }
        *owner = Some(Owner { uid, pid });
    }
    if let Some(watch) = pinned.take().filter(|w| Some(w.pid) == pid) {
        watch_the_app(shared, watch);
    }
    None
}

fn trim(line: &[u8]) -> &[u8] {
    let end = line.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(0, |i| i + 1);
    let start = line.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(end);
    &line[start..end]
}

/// What a request that did not parse is told. Never the input, nor
/// serde's message, which quotes pieces of it ("unknown variant `...`"):
/// an error is the one thing that crosses back, and reflecting a caller's
/// bytes into it is a needless way to leak.
fn malformed(err: &serde_json::Error) -> String {
    let kind = match err.classify() {
        serde_json::error::Category::Io => "unreadable",
        serde_json::error::Category::Syntax => "not valid JSON",
        serde_json::error::Category::Data => "not a request this helper understands",
        serde_json::error::Category::Eof => "incomplete",
    };
    format!("malformed request: {kind} (line {}, column {})", err.line(), err.column())
}

/// Watch the session owner's process, once per process, and take its
/// tunnel down when it exits. Without a pidfd (a kernel before 5.3) the
/// idle watchdog stands in.
fn watch_the_app(shared: &Shared, watch: PidWatch) {
    let pid = watch.pid;
    let newly_seen = shared.watched.lock().map(|mut w| w.replace(pid) != Some(pid)).unwrap_or(false);
    if !newly_seen {
        return;
    }
    let shared = shared.clone();
    tokio::spawn(async move {
        let signal = watch.exited().await;
        if let Ok(mut watched) = shared.watched.lock() {
            if *watched == Some(pid) {
                *watched = None;
            }
        }
        if !client_watch::tears_down(client_watch::shutting_down()) {
            return;
        }
        // Only the owner's exit ends the session: another connect has
        // made someone else its owner since.
        {
            let mut owner = shared.owner();
            if !matches!(*owner, Some(o) if o.pid == Some(pid)) {
                return;
            }
            *owner = None;
        }
        eprintln!("neoxify-helper: {}", signal.reason());
        // Whatever it was doing is no longer wanted by anyone.
        shared.engines.supersede();
        shared.engines.cancel_running();
        let _ = shared.engines.run_detached(|session: &mut Session, _| {
            if !session.has_session() && !session.owes_finish() {
                return;
            }
            let report = session.hard_stop();
            eprintln!("neoxify-helper: teardown after the app went away: {}", report.summary());
            session.finish();
        });
    });
}

/// Queues the thorough stop behind the reply, marked busy so a status
/// meanwhile answers without waiting behind it.
fn queue_finish(shared: &Shared) {
    let busy = Ledger::busy(&shared.ledger);
    let _ = shared.engines.run_detached(move |session: &mut Session, _| {
        let _busy = busy;
        session.finish();
    });
}

/// The status answered without the owning thread: the record of a drop if
/// there is one, else what the machine shows, and never "disconnected" on
/// a look that proved nothing -- the app tells a customer their
/// connection was lost only on `Down`.
async fn status_without_the_thread(shared: &Shared) -> Response {
    if shared.ledger.confirmed_drop().is_some() {
        return nothing(TunnelHealth::Down);
    }
    // A connect in flight has finished nothing: its link may be up before
    // its routes, DNS and leak protection, and it may yet be rolled back.
    // Not connected, and not verified either way.
    if shared.ledger.is_connecting() {
        return nothing(TunnelHealth::Unknown);
    }
    let backend = Arc::clone(&shared.backend);
    let Ok(seen) = tokio::task::spawn_blocking(move || backend.visible_tunnel()).await else {
        return Response::Error { message: "could not read the tunnel state".to_string() };
    };
    let Some(_iface) = seen else {
        return nothing(TunnelHealth::Unknown);
    };
    let guard = shared.ledger.guard();
    Response::State {
        connected: true,
        protocol: shared.ledger.live_protocol(),
        health: TunnelHealth::Unknown,
        split_tunnel_active: false,
        split_tunnel_problem: None,
        split_tunnel_restart_needed: Vec::new(),
        ipv6_blocked: guard.as_ref().is_some_and(|g| g.ipv6_blocked),
        // Protected only on the session's own record; with none, unproven.
        tunnel_dns_unprotected: !guard.as_ref().is_some_and(|g| g.dns_protected),
        ipv4_confined: guard.as_ref().map(|g| g.ipv4_confined),
        confinement_problem: guard.and_then(|g| g.problem),
        reconnect_hold: None,
        // Not read without the owning thread: nothing rather than a guess.
        traffic: None,
        split_tunnel_problem_code: None,
        session_secs: None,
    }
}

/// Only reachable while the helper is stopping.
fn gone() -> Response {
    Response::Error { message: "the service is shutting down".to_string() }
}

fn unavailable(what: &str) -> Response {
    Response::Error { message: what.to_string() }
}

pub async fn dispatch(request: Request, shared: &Shared) -> Response {
    let engines = &shared.engines;
    let ledger = &shared.ledger;
    match request {
        Request::Status => {
            // Not queued at all behind a long job: the answer after the
            // wait would be this one anyway.
            if ledger.is_busy() {
                return status_without_the_thread(shared).await;
            }
            let answered =
                tokio::time::timeout(STATUS_LOCK_WAIT, engines.run(|s: &mut Session, _| s.status(Instant::now()))).await;
            match answered {
                Ok(Ok((state, owes))) => {
                    if owes {
                        queue_finish(shared);
                    }
                    state
                }
                _ => status_without_the_thread(shared).await,
            }
        }
        Request::Disconnect | Request::DisconnectForReconnect => {
            // Cancel first, and before queueing anything: this reaches the
            // connect running now, and `supersede` the one still queued.
            engines.supersede();
            engines.cancel_running();
            let hard = engines.run(|s: &mut Session, _| s.hard_stop());
            match tokio::time::timeout(DISCONNECT_LOCK_WAIT, hard).await {
                Ok(Ok(report)) => {
                    if !report.within_budget() || !report.all_succeeded() {
                        eprintln!("neoxify-helper: disconnect: {}", report.summary());
                    }
                    queue_finish(shared);
                    if report.all_succeeded() {
                        Response::Ok
                    } else {
                        Response::Error { message: report.summary() }
                    }
                }
                Ok(Err(_)) => gone(),
                Err(_) => {
                    // The hard stop is queued and the cancellation is
                    // already unwinding whatever is ahead of it. The state
                    // decides the answer: a tunnel still visible makes the
                    // error true; none makes "disconnected" honest.
                    queue_finish(shared);
                    let still_tunnelled = if ledger.confirmed_drop().is_some() {
                        false
                    } else {
                        let backend = Arc::clone(&shared.backend);
                        tokio::task::spawn_blocking(move || backend.visible_tunnel().is_some()).await.unwrap_or(true)
                    };
                    if still_tunnelled {
                        Response::Error {
                            message: "the tunnel is still shutting down; it will be torn down in a moment".to_string(),
                        }
                    } else {
                        Response::Ok
                    }
                }
            }
        }
        Request::Connect { profile, exits, known_nodes, block_while_reconnecting: _ } => {
            if matches!(profile, ConnectProfile::Ikev2(_)) {
                return unavailable(IKEV2_UNAVAILABLE);
            }
            if let Err(e) = profile.validate() {
                return Response::Error { message: e.to_string() };
            }
            for exit in &exits {
                if let Err(e) = exit.profile.validate() {
                    return Response::Error { message: e.to_string() };
                }
            }
            // Taken as the connect is queued and checked when it starts: a
            // Disconnect in between means nothing is dialled.
            let wanted = engines.generation();
            let busy = Ledger::connecting(ledger);
            engines
                .run(move |s: &mut Session, token| {
                    let _busy = busy;
                    if wanted.superseded() {
                        return Response::Error { message: ABANDONED.to_string() };
                    }
                    match s.connect(&profile, &exits, &known_nodes, token) {
                        Ok(()) => Response::Ok,
                        Err(message) => Response::Error { message },
                    }
                })
                .await
                .unwrap_or_else(|_| gone())
        }
        // The routing table only, so answered without the owning thread.
        // A lookup that could not run says nothing, as on Windows: the
        // app's wait then dials, and the connect decides.
        Request::WayOut { profile } => {
            let backend = Arc::clone(&shared.backend);
            match tokio::task::spawn_blocking(move || backend.way_out(&profile)).await {
                Ok(Err(neoxify_tunnel::Problem::NoNetwork)) => Response::Error { message: NO_NETWORK.to_string() },
                _ => Response::Ok,
            }
        }
        // The reconnect hold is not in the first version. Letting go of
        // one, or turning the setting off, is always true with nothing
        // held; turning it on is refused so the app does not believe it.
        Request::ReleaseReconnectHold => Response::Ok,
        Request::SetReconnectHold { enabled: false } => Response::Ok,
        Request::SetReconnectHold { enabled: true } => {
            unavailable("Blocking the internet while reconnecting is not available on Linux yet")
        }
        // Sent before every connect: off is what Linux already does. Not
        // validated, because nothing here acts on it -- and the Windows
        // rules for an app's path would refuse every Linux path anyway.
        Request::SetSplitTunnel { config } if !config.enabled => Response::Ok,
        Request::SetSplitTunnel { .. } => unavailable(SPLIT_TUNNEL_UNAVAILABLE),
        Request::ProbeSplitTunnel | Request::SplitTunnelExits | Request::ListRunningApps => {
            unavailable(SPLIT_TUNNEL_UNAVAILABLE)
        }
        Request::Repair => unavailable("Repair is not available on Linux yet"),
        Request::Diagnostics => unavailable("Diagnostics are not available on Linux yet"),
        Request::ArmGaming { .. } => unavailable("Gaming mode is not available on Linux yet"),
        // Called defensively on every teardown: nothing is armed, so
        // there is nothing to undo.
        Request::DisarmGaming => Response::Ok,
        // The honest state: off, with every check false because none ran.
        Request::GamingStatus => Response::Gaming {
            state: GamingPhase::Off,
            detail: None,
            rules_present: false,
            canary_ok: false,
            proxy_reachable: false,
            namespaces: Vec::new(),
        },
    }
}

/// Asks the engine about once a second whether it is still there, and on
/// a verified `Down` takes the session down (`Session::check_health`).
/// Not while a long job is queued: a connect is replacing the session, and
/// a thorough pass is already tidying.
fn spawn_health_watch(shared: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(HEALTH_POLL).await;
            if shared.ledger.is_busy() {
                continue;
            }
            match shared.engines.run(|s: &mut Session, _| s.check_health()).await {
                Ok(true) => queue_finish(&shared),
                Ok(false) => {}
                Err(_) => return,
            }
        }
    });
}

/// Tears the tunnel down once the app has stopped talking to us. The
/// backstop for what the process watch cannot see (`lifecycle::idle`).
fn spawn_idle_watchdog(shared: Shared) {
    tokio::spawn(async move {
        let mut watch = IdleWatch::default();
        loop {
            let slept_from = Instant::now();
            tokio::time::sleep(IDLE_POLL).await;
            let said = match shared.last_seen.lock() {
                Ok(mut seen) => watch.tick(slept_from.elapsed(), &mut seen, Instant::now()),
                Err(_) => continue,
            };
            if said != IdleTick::Silent {
                continue;
            }
            let _ = shared.engines.run_detached(|session: &mut Session, _| {
                if !session.has_session() && !session.owes_finish() {
                    return;
                }
                eprintln!("neoxify-helper: the app has been silent for {IDLE_GRACE:?} with a tunnel up; tearing it down");
                let report = session.hard_stop();
                if !report.all_succeeded() {
                    eprintln!("neoxify-helper: {}", report.summary());
                }
                session.finish();
            });
        }
    });
}

/// One request to a running helper, for `neoxify-helper ctl` and tests.
pub async fn call(path: &Path, request_json: &str) -> std::io::Result<String> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(format!("{}\n", request_json.trim()).as_bytes()).await?;
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    Ok(line.trim_end().to_string())
}

/// The socket's production path.
pub fn socket_path() -> PathBuf {
    PathBuf::from(crate::SOCKET)
}
