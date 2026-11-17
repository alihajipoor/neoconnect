//! The control socket.
//!
//! The Windows wire contract, unchanged: one JSON `Request` per line in,
//! one JSON `Response` per line out, one connection per request (several
//! lines on one connection are served in turn, as on Windows). A line
//! whose `type` is one of the Linux-only requests (`neoxify_linux_wire`)
//! is read as one of those instead and answered by [`dispatch_linux`].
//! Anything that changes the machine is run one at a time on the
//! supervisor's thread; the questions a stranded customer asks -- "am I
//! tunnelled" and "get me out" -- never queue behind a slow one. See
//! [`dispatch`], whose shape is the Windows service's `pipe::dispatch`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use neoconnect_ipc::{GamingPhase, ReconnectHoldProblem, RepairOutcome, Request, Response, TunnelHealth, NO_NETWORK};
use neoxify_linux_wire::{LinuxRequest, LinuxResponse, LINUX_REQUEST_TYPES};
use neoxify_tunnel::Dirs;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::backend::Backend;
use crate::hold::{Hold, Release};
use crate::lifecycle::budget::ABANDONED;
use crate::lifecycle::client_watch::{self, PidWatch};
use crate::lifecycle::idle::{IdleTick, IdleWatch, IDLE_GRACE, IDLE_POLL};
use crate::lifecycle::ledger::Ledger;
use crate::lifecycle::supervisor::Supervisor;
use crate::peer::{Caller, Policy};
use crate::session::{nothing, Session};
use crate::{custom, repair, update};

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

const REFUSED: &str =
    "only the Neoxify app, run by the person at this computer's screen or by a member of the neoxify group, may control the Neoxify helper";
const ANOTHER_USERS_SESSION: &str = "another user's Neoxify connection is active on this computer";
const DISCONNECT_LETS_GO: &str = "the customer disconnected";

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
    pub hold: Arc<Hold>,
    pub dirs: Dirs,
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
    /// An update is being copied and checked: a second waits for none.
    installing: Arc<AtomicBool>,
}

impl Shared {
    pub fn new(
        engines: Supervisor<Session>,
        ledger: Arc<Ledger>,
        backend: Arc<dyn Backend>,
        policy: Arc<Policy>,
        hold: Arc<Hold>,
        dirs: Dirs,
    ) -> Self {
        Self {
            engines,
            ledger,
            backend,
            policy,
            hold,
            dirs,
            last_seen: Arc::new(Mutex::new(Instant::now())),
            owner: Arc::new(Mutex::new(None)),
            watched: Arc::new(Mutex::new(None)),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
            installing: Arc::new(AtomicBool::new(false)),
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

    /// Runs `job` on the hold where blocking is allowed: letting go of it
    /// or putting it in runs `nft`.
    async fn with_hold<T: Send + 'static>(&self, job: impl FnOnce(&Hold) -> T + Send + 'static) -> Option<T> {
        let hold = Arc::clone(&self.hold);
        tokio::task::spawn_blocking(move || job(&hold)).await.ok()
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
                            crate::say!("neoxify-helper: connection error: {err}");
                        }
                    });
                }
                // A transient failure (out of descriptors) must not end
                // the daemon; a moment's pause stops it spinning.
                Err(err) => {
                    crate::say!("neoxify-helper: accept failed: {err}");
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

fn encode<T: Serialize>(reply: &T) -> String {
    serde_json::to_string(reply).unwrap_or_else(|_| r#"{"status":"error","message":"could not encode response"}"#.to_string())
}

/// The `type` of a request line, read before anything else so the two
/// contracts are told apart without parsing a line as the wrong one.
fn request_type(line: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Peek {
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    serde_json::from_slice::<Peek>(line).ok().and_then(|p| p.kind)
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
        None => Caller::Refused { who: "a caller whose credentials could not be read".into(), reply: None },
    };
    if matches!(caller, Caller::App { .. }) && pinned.as_ref().is_some_and(|p| !p.still_running()) {
        caller = Caller::Refused { who: "a process that exited while it was being checked".into(), reply: None };
    }
    let mut pinned = pinned;

    // Refused: answered at once and let go, without reading a byte, so a
    // refused caller holds nothing. What it may have sent is read for a
    // moment afterwards only so that closing does not cut off the answer.
    if let Caller::Refused { who, reply } = &caller {
        if shared.policy.first_refusal(who) {
            crate::say!("neoxify-helper: refused a caller ({who})");
        }
        let mut stream = stream;
        let message = reply.clone().unwrap_or_else(|| REFUSED.to_string());
        let mut encoded = encode(&Response::Error { message });
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

        let mut encoded = if too_long {
            encode(&Response::Error { message: "malformed request: longer than the helper accepts".to_string() })
        } else if request_type(trim(&line)).is_some_and(|t| LINUX_REQUEST_TYPES.contains(&t.as_str())) {
            match serde_json::from_slice::<LinuxRequest>(trim(&line)) {
                Ok(request) => dispatch_linux(request, &shared, &caller).await,
                Err(err) => encode(&Response::Error { message: malformed(&err) }),
            }
        } else {
            let response = match serde_json::from_slice::<Request>(trim(&line)) {
                Ok(request @ Request::Connect { .. }) => match claim_session(&shared, &caller, &mut pinned) {
                    Some(refusal) => refusal,
                    None => dispatch(request, &shared, &caller).await,
                },
                Ok(request) if changes_the_session(&request) => match not_the_owner(&shared, &caller) {
                    Some(refusal) => refusal,
                    None => dispatch(request, &shared, &caller).await,
                },
                Ok(request) => dispatch(request, &shared, &caller).await,
                Err(err) => Response::Error { message: malformed(&err) },
            };
            encode(&response)
        };
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
        Caller::Refused { reply, .. } => {
            return Some(Response::Error { message: reply.clone().unwrap_or_else(|| REFUSED.to_string()) })
        }
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
        // Custom mode sorts this user's programs and nobody else's.
        neoxify_tunnel::set_session_owner(Some(uid));
    }
    if let Some(watch) = pinned.take().filter(|w| Some(w.pid) == pid) {
        watch_the_app(shared, watch);
    }
    None
}

/// The requests that change or end a session in place. Each is refused
/// to another user while a session stands, as a Connect is: otherwise a
/// second account could turn off the owner's reconnect hold, reshape their
/// Custom mode, or tear their tunnel down while the owner is told it holds.
pub(crate) fn changes_the_session(request: &Request) -> bool {
    matches!(
        request,
        Request::Disconnect
            | Request::DisconnectForReconnect
            | Request::SetSplitTunnel { .. }
            | Request::SetReconnectHold { .. }
            | Request::ReleaseReconnectHold
            | Request::ProbeSplitTunnel
            | Request::Repair
    )
}

/// The refusal for a caller who is not the standing session's owner, or
/// `None` when they may go ahead: no session standing, their own, or root's
/// own tools.
pub(crate) fn not_the_owner(shared: &Shared, caller: &Caller) -> Option<Response> {
    let Caller::App { uid, .. } = caller else { return None };
    // A hold being held stands for the owner's session too: it is their
    // drop that the internet is blocked over.
    let session_standing =
        shared.ledger.live_protocol().is_some() || shared.ledger.is_connecting() || shared.hold.holding();
    let someone_else = shared.owner().is_some_and(|o| o.uid != *uid);
    (session_standing && someone_else).then(|| Response::Error { message: ANOTHER_USERS_SESSION.to_string() })
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
        crate::say!("neoxify-helper: {}", signal.reason());
        // Whatever it was doing is no longer wanted by anyone.
        shared.engines.supersede();
        shared.engines.cancel_running();
        let hold = Arc::clone(&shared.hold);
        let _ = shared.engines.run_detached(move |session: &mut Session, _| {
            // Nobody is left to reconnect: nothing is held for them.
            hold.release(Release::Asked("the app exited"));
            hold.disarm();
            if !session.has_session() && !session.owes_finish() {
                return;
            }
            let report = session.hard_stop();
            crate::say!("neoxify-helper: teardown after the app went away: {}", report.summary());
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

/// The hold's word in a status answered without the owning thread, tended
/// first as every status read tends it.
async fn hold_report(shared: &Shared) -> Option<neoconnect_ipc::ReconnectHold> {
    let live = shared.ledger.live_generation();
    shared
        .with_hold(move |hold| {
            hold.tend(live);
            hold.report(live)
        })
        .await
        .flatten()
}

/// The status answered without the owning thread: the record of a drop if
/// there is one, else what the machine shows, and never "disconnected" on
/// a look that proved nothing -- the app tells a customer their
/// connection was lost only on `Down`.
async fn status_without_the_thread(shared: &Shared) -> Response {
    let held = hold_report(shared).await;
    if shared.ledger.confirmed_drop().is_some() {
        return nothing(TunnelHealth::Down, held);
    }
    // A connect in flight has finished nothing: its link may be up before
    // its routes, DNS and leak protection, and it may yet be rolled back.
    // Not connected, and not verified either way.
    if shared.ledger.is_connecting() {
        return nothing(TunnelHealth::Unknown, held);
    }
    let backend = Arc::clone(&shared.backend);
    let Ok(seen) = tokio::task::spawn_blocking(move || backend.visible_tunnel()).await else {
        return Response::Error { message: "could not read the tunnel state".to_string() };
    };
    let Some(_iface) = seen else {
        return nothing(TunnelHealth::Unknown, held);
    };
    // An interface of ours with no session live is a stop still finishing
    // or a leftover, not a connection: WireGuard's link goes in the slow
    // half of a stop, up to 1.6 s after a Disconnect or a reconnect's
    // teardown has been answered, and the app polls the status in that
    // gap. The owning thread's own status says the same of it.
    if shared.ledger.live_generation().is_none() {
        return nothing(TunnelHealth::Unknown, held);
    }
    let guard = shared.ledger.guard();
    // Custom mode as the owning thread last read it back from the kernel,
    // as the leak protection is: "not active" here would be a claim nobody
    // checked, and the app tells the customer their apps are not sorted on it.
    let split = shared.ledger.split().unwrap_or_default();
    let (split_problem, split_code) = match split.problem {
        Some((sentence, code)) => (Some(sentence), Some(code)),
        None => (None, None),
    };
    Response::State {
        connected: true,
        protocol: shared.ledger.live_protocol(),
        health: TunnelHealth::Unknown,
        split_tunnel_active: split.active,
        split_tunnel_problem: split_problem,
        split_tunnel_restart_needed: split.restart_needed,
        ipv6_blocked: guard.as_ref().is_some_and(|g| g.ipv6_blocked),
        // Protected only on the session's own record; with none, unproven.
        tunnel_dns_unprotected: !guard.as_ref().is_some_and(|g| g.dns_protected),
        ipv4_confined: guard.as_ref().map(|g| g.ipv4_confined),
        confinement_problem: guard.and_then(|g| g.problem),
        reconnect_hold: held,
        traffic: None,
        split_tunnel_problem_code: split_code,
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

fn caller_uid(shared: &Shared, caller: &Caller) -> u32 {
    match caller {
        Caller::App { uid, .. } => *uid,
        _ => shared.policy.trusted_uid,
    }
}

/// The app's process, for the hold's group: once per process.
async fn adopt_caller(shared: &Shared, caller: &Caller) {
    if let Caller::App { pid, .. } = caller {
        let pid = *pid;
        shared.with_hold(move |hold| hold.adopt(pid)).await;
    }
}

pub async fn dispatch(request: Request, shared: &Shared, caller: &Caller) -> Response {
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
        // The same teardown, but for the reconnect hold. The customer's
        // lets go of it at once, here, without waiting for the owning
        // thread. A reconnect's holds the gap from before the engine stops,
        // when the session is armed, and keeps it through the teardown.
        request @ (Request::Disconnect | Request::DisconnectForReconnect) => {
            let for_reconnect = matches!(request, Request::DisconnectForReconnect);
            if for_reconnect {
                shared.hold.followed();
            } else {
                shared
                    .with_hold(|hold| {
                        hold.release(Release::Asked(DISCONNECT_LETS_GO));
                        hold.disarm();
                    })
                    .await;
            }
            // Cancel first, and before queueing anything: this reaches the
            // connect running now, and `supersede` the one still queued.
            engines.supersede();
            engines.cancel_running();
            let hold = Arc::clone(&shared.hold);
            let hard = engines.run(move |s: &mut Session, _| {
                if for_reconnect {
                    s.hold_for_reconnect();
                } else {
                    // Again on the owning thread, ahead of the hard stop: a
                    // drop the health watch held, or a connect this
                    // cancelled that armed one, since the release above.
                    hold.release(Release::Asked(DISCONNECT_LETS_GO));
                    hold.disarm();
                }
                s.hard_stop()
            });
            match tokio::time::timeout(DISCONNECT_LOCK_WAIT, hard).await {
                Ok(Ok(report)) => {
                    if !report.within_budget() || !report.all_succeeded() {
                        crate::say!("neoxify-helper: disconnect: {}", report.summary());
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
        Request::Connect { profile, exits, known_nodes, block_while_reconnecting } => {
            if let Err(e) = profile.validate() {
                return Response::Error { message: e.to_string() };
            }
            for exit in &exits {
                if let Err(e) = exit.profile.validate() {
                    return Response::Error { message: e.to_string() };
                }
            }
            // The setting as of this request, taken as it arrives rather
            // than when the connect runs: a `SetReconnectHold` that turned
            // it off after this was sent, but before it ran, still wins.
            if block_while_reconnecting {
                shared.hold.set_wanted(true);
                // A connect follows a drop being held for, if one is.
                shared.hold.followed();
                adopt_caller(shared, caller).await;
            } else {
                shared.with_hold(|hold| hold.turn_off()).await;
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
        Request::ReleaseReconnectHold => {
            shared.with_hold(|hold| hold.release(Release::Asked("the app let go of it"))).await;
            Response::Ok
        }
        // The setting changed. Off lets go and disarms at once; on arms the
        // live session, which needs the owning thread, behind whatever it
        // is doing. On is also how the app says, as its reconnect begins,
        // that one follows the drop being held for.
        Request::SetReconnectHold { enabled: true } => {
            shared.hold.set_wanted(true);
            shared.hold.followed();
            adopt_caller(shared, caller).await;
            let _ = engines.run_detached(|s: &mut Session, _| s.arm_live());
            Response::Ok
        }
        Request::SetReconnectHold { enabled: false } => {
            shared.with_hold(|hold| hold.turn_off()).await;
            Response::Ok
        }
        // Checked here with Linux's rules -- never the config's own
        // `validate()`, whose Windows rules refuse every Linux path -- and
        // applied on the owning thread, in place when a tunnel is up.
        Request::SetSplitTunnel { config } => {
            let backend = Arc::clone(&shared.backend);
            let shape = match custom::shape_of(&config, |app| backend.valid_app(app)) {
                Ok(shape) => shape,
                Err(message) => return Response::Error { message },
            };
            let egress = config.egress.clone().filter(|e| !e.trim().is_empty() && e.len() <= 128);
            let busy = Ledger::busy(ledger);
            engines
                .run(move |s: &mut Session, token| {
                    let _busy = busy;
                    match s.set_split(shape, egress, token) {
                        Ok(()) => Response::Ok,
                        Err(message) => Response::Error { message },
                    }
                })
                .await
                .unwrap_or_else(|_| gone())
        }
        Request::ProbeSplitTunnel => {
            let busy = Ledger::busy(ledger);
            engines
                .run(move |s: &mut Session, token| {
                    let _busy = busy;
                    match s.probe(token) {
                        Ok(()) => Response::Ok,
                        Err(message) => Response::Error { message },
                    }
                })
                .await
                .unwrap_or_else(|_| gone())
        }
        // No per-app exits on Linux: the egress the app named, and no
        // placements to report.
        Request::SplitTunnelExits => match engines.run(|s: &mut Session, _| s.egress()).await {
            Ok(egress) => Response::ExitPlacements { egress, apps: Vec::new() },
            Err(_) => gone(),
        },
        // The caller's own programs: one user's app does not list another's.
        Request::ListRunningApps => {
            let uid = caller_uid(shared, caller);
            let backend = Arc::clone(&shared.backend);
            match tokio::task::spawn_blocking(move || backend.running_processes(uid)).await {
                Ok(processes) => Response::RunningApps { apps: custom::group_running(processes) },
                Err(_) => Response::Error { message: "could not read the running programs".to_string() },
            }
        }
        Request::Repair => {
            shared
                .with_hold(|hold| {
                    hold.release(Release::Asked("Repair"));
                    hold.disarm();
                })
                .await;
            engines.supersede();
            engines.cancel_running();
            let busy = Ledger::busy(ledger);
            let (backend, dirs) = (Arc::clone(&shared.backend), shared.dirs.clone());
            engines
                .run(move |s: &mut Session, _| {
                    let _busy = busy;
                    let had = s.has_session();
                    let report = s.hard_stop();
                    s.finish();
                    let tunnel = if !report.all_succeeded() {
                        RepairOutcome::Failed { detail: report.summary() }
                    } else if had {
                        RepairOutcome::Fixed { detail: "disconnected the tunnel that was up".to_string() }
                    } else {
                        RepairOutcome::AlreadyClean
                    };
                    Response::Repaired { report: repair::clear(backend.as_ref(), &dirs, tunnel) }
                })
                .await
                .unwrap_or_else(|_| gone())
        }
        // The Windows shape names Windows' own machinery; the Linux app asks
        // for `linuxDiagnostics` instead.
        Request::Diagnostics => unavailable("this helper answers linuxDiagnostics; the Windows diagnostics do not apply on Linux"),
        Request::ArmGaming { .. } => unavailable("Gaming mode is a Windows feature and is not part of Neoxify on Linux"),
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

/// The Linux-only requests (`neoxify_linux_wire`). Errors are answered in
/// the shared shape so the app has one way to read a refusal.
pub async fn dispatch_linux(request: LinuxRequest, shared: &Shared, caller: &Caller) -> String {
    let error = |message: String| encode(&Response::Error { message });
    match request {
        LinuxRequest::UpdateSupport => match tokio::task::spawn_blocking(update::support).await {
            Ok((kind, reason)) => encode(&LinuxResponse::UpdateSupport { kind, version: crate::VERSION.to_string(), reason }),
            Err(_) => error("could not tell how this install was made".to_string()),
        },
        LinuxRequest::InstallUpdate { package, signature } => {
            let Caller::App { uid: owner, .. } = *caller else {
                return error("only the Neoxify app may install an update".to_string());
            };
            if shared.ledger.live_protocol().is_some() || shared.ledger.is_connecting() {
                return error("an update cannot be installed while connected; disconnect first".to_string());
            }
            if shared.installing.swap(true, Ordering::SeqCst) {
                return error("an update is already being installed".to_string());
            }
            let installing = Arc::clone(&shared.installing);
            let (backend, dir) = (Arc::clone(&shared.backend), shared.dirs.state.join("update"));
            let busy = Ledger::busy(&shared.ledger);
            // On the owning thread, so no connect can begin between the
            // check that no tunnel is up and the package manager starting.
            let answered = shared
                .engines
                .run(move |s: &mut Session, _| {
                    let _busy = busy;
                    if s.has_session() || backend.visible_tunnel().is_some() {
                        return Err("an update cannot be installed while connected; disconnect first".to_string());
                    }
                    let (kind, reason) = update::support();
                    let Some(kind) = kind else {
                        return Err(reason.unwrap_or_else(|| "this install cannot update itself".to_string()));
                    };
                    update::install(&dir, kind, &package, &signature, Some(owner))
                })
                .await;
            installing.store(false, Ordering::SeqCst);
            match answered {
                Ok(Ok(())) => encode(&LinuxResponse::UpdateStarted),
                Ok(Err(why)) => error(why),
                Err(_) => encode(&gone()),
            }
        }
        LinuxRequest::UpdateOutcome => {
            let dir = shared.dirs.state.join("update");
            match tokio::task::spawn_blocking(move || update::outcome(&dir, crate::VERSION, update::unit_active)).await {
                Ok(outcome) => encode(&LinuxResponse::UpdateOutcome { outcome }),
                Err(_) => error("could not read how the last update went".to_string()),
            }
        }
        LinuxRequest::LinuxDiagnostics => {
            let (backend, dirs) = (Arc::clone(&shared.backend), shared.dirs.clone());
            let live = shared.ledger.live_protocol().is_some();
            match tokio::task::spawn_blocking(move || repair::diagnostics(backend.as_ref(), &dirs, live, update::support().0)).await {
                Ok(diagnostics) => encode(&LinuxResponse::LinuxDiagnostics { diagnostics: Box::new(diagnostics) }),
                Err(_) => error("could not read the diagnostics".to_string()),
            }
        }
    }
}

/// Asks the engine about once a second whether it is still there, and on
/// a verified `Down` takes the session down (`Session::check_health`),
/// holding first if the customer asked for that. Not while a long job is
/// queued: a connect is replacing the session, and a thorough pass is
/// already tidying.
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
            let hold = Arc::clone(&shared.hold);
            let _ = shared.engines.run_detached(move |session: &mut Session, _| {
                // No app is left to reconnect, so a hold would hold the
                // machine for nobody.
                hold.release(Release::Failed(
                    ReconnectHoldProblem::Other,
                    format!("the app was silent for {}s, so the hold was let go of", IDLE_GRACE.as_secs()),
                ));
                hold.disarm();
                if !session.has_session() && !session.owes_finish() {
                    return;
                }
                crate::say!("neoxify-helper: the app has been silent for {IDLE_GRACE:?} with a tunnel up; tearing it down");
                let report = session.hard_stop();
                if !report.all_succeeded() {
                    crate::say!("neoxify-helper: {}", report.summary());
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
