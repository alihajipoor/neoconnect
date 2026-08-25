//! The control pipe.
//!
//! One JSON request per line, one JSON response per line. Anything that
//! changes the machine is handled one at a time on purpose: every such
//! operation mutates global state (routing table, tunnel adapters), so
//! serializing them is correctness, not a simplification. A second
//! caller waits rather than racing the first.
//!
//! The two requests that change nothing -- asking what state the machine
//! is in, and listing running applications -- deliberately do not queue
//! behind them, and Disconnect will not wait forever for its turn. That
//! is not an optimisation. Serializing everything meant one operation
//! that failed to return took every later request with it, and the
//! requests lost that way were exactly the ones a customer stranded
//! inside a tunnel needs: "am I tunnelled" and "get me out". See
//! [`dispatch`].

use std::sync::Arc;
use std::time::{Duration, Instant};

use neoconnect_ipc::{Request, Response, PIPE_NAME};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::Mutex;

use crate::engines::Engines;
use crate::security::{SecurityDescriptor, PIPE_SDDL};

/// Caps a single request line. A profile with three PEM blocks is a few
/// kilobytes; this leaves generous headroom while stopping an
/// unauthenticated-ish caller from making the service buffer without
/// bound.
const MAX_REQUEST_BYTES: u64 = 512 * 1024;

fn create_pipe_server(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    let sd = SecurityDescriptor::from_sddl(PIPE_SDDL)?;
    let mut attrs = sd.attributes();
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first);
    // SAFETY: `attrs` points at a descriptor owned by `sd`, which is
    // alive until this function returns; the pipe copies what it needs
    // during creation.
    unsafe { opts.create_with_security_attributes_raw(name, &mut attrs as *mut _ as *mut std::ffi::c_void) }
}

pub async fn serve(engines: Arc<Mutex<Engines>>) -> std::io::Result<()> {
    serve_on(PIPE_NAME, engines).await
}

/// How long the tunnel outlives the app before being torn down.
///
/// Measured from the last request, not from a connection being open:
/// the app opens a fresh pipe connection per request and closes it
/// immediately (see vpn.rs `call`), so "a client is connected" is true
/// only for milliseconds at a time and is not a signal about anything.
///
/// Getting that wrong shipped a real regression in 0.9.6 -- tearing down
/// on the connection closing meant the tunnel died a few seconds after
/// it came up, which customers reported as connecting and then losing it
/// immediately.
///
/// Sixty seconds because the app polls status every few seconds while it
/// is open, so silence for a minute means it is genuinely gone rather
/// than between polls. Long enough to be sure, short enough that nobody
/// is left tunnelled for long by an app that vanished.
const IDLE_GRACE: Duration = Duration::from_secs(60);

/// How often the idle check runs.
const IDLE_POLL: Duration = Duration::from_secs(10);

/// Split out from [`serve`] so tests can drive the real server on a
/// throwaway pipe name instead of the production one -- everything
/// below this point, including the ACL, is the shipping code path.
pub async fn serve_on(name: &str, engines: Arc<Mutex<Engines>>) -> std::io::Result<()> {
    let mut server = create_pipe_server(name, true)?;
    // Last time the app asked this service anything. The tunnel is torn
    // down when the app has been silent long enough to be considered
    // gone -- which is the fix for the worst failure this service had:
    // closing the app left the tunnel up, holding the default route at a
    // lower metric than the customer's real link, while the app --
    // having forgotten it -- offered no way to disconnect.
    let last_seen = Arc::new(Mutex::new(Instant::now()));
    spawn_idle_watchdog(Arc::clone(&engines), Arc::clone(&last_seen));

    loop {
        server.connect().await?;
        let connected = server;
        // Create the next instance before handling this one so a client
        // reconnecting immediately after a disconnect never finds the
        // pipe missing.
        server = create_pipe_server(name, false)?;

        let engines = Arc::clone(&engines);
        let last_seen = Arc::clone(&last_seen);
        tokio::spawn(async move {
            *last_seen.lock().await = Instant::now();
            if let Err(err) = handle_connection(connected, engines).await {
                eprintln!("connection error: {err}");
            }
            // Marked again on the way out, so a long-running request
            // counts as the app being alive for its whole duration.
            *last_seen.lock().await = Instant::now();
        });
    }
}

async fn handle_connection(stream: NamedPipeServer, engines: Arc<Mutex<Engines>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    loop {
        line.clear();
        let read = (&mut reader).take(MAX_REQUEST_BYTES).read_line(&mut line).await?;
        if read == 0 {
            return Ok(());
        }

        let response = match serde_json::from_str::<Request>(line.trim()) {
            Ok(request) => dispatch(request, &engines).await,
            // Deliberately does not echo the input back -- an error
            // message is the one thing that crosses back to a caller,
            // and reflecting unparsed bytes into it is a needless way to
            // leak state.
            Err(err) => Response::Error { message: format!("malformed request: {err}") },
        };

        let mut encoded = serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"status":"error","message":"could not encode response"}"#.to_string()
        });
        encoded.push('\n');
        reader.get_mut().write_all(encoded.as_bytes()).await?;
        reader.get_mut().flush().await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::{ConnectProfile, WireguardProfile};
    use std::path::PathBuf;
    use tokio::net::windows::named_pipe::ClientOptions;

    /// Starts the real server on a throwaway pipe name and returns it.
    /// `exe_dir` deliberately points somewhere with no engine binaries,
    /// so a connect attempt fails at the engine-resolution guard instead
    /// of actually reconfiguring this machine's network.
    async fn start_server(name: &'static str) -> Arc<Mutex<Engines>> {
        let empty_dir = PathBuf::from(std::env::temp_dir()).join("neoconnect-test-no-engines");
        let engines = Arc::new(Mutex::new(Engines::new(empty_dir.clone(), empty_dir)));
        let serving = Arc::clone(&engines);
        tokio::spawn(async move {
            let _ = serve_on(name, serving).await;
        });
        // Give the server a moment to create the first pipe instance.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        engines
    }

    async fn round_trip(name: &str, raw_request: &str) -> String {
        let client = ClientOptions::new().open(name).expect("pipe should be connectable");
        let mut reader = BufReader::new(client);
        reader
            .get_mut()
            .write_all(format!("{raw_request}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        line
    }

    #[tokio::test]
    async fn reports_disconnected_state_over_a_real_pipe() {
        // Exercises the whole shipping path: ACL construction, pipe
        // creation, framing, deserialization, dispatch, reply.
        let name = r"\\.\pipe\neoconnect-test-status";
        start_server(name).await;
        let reply = round_trip(name, r#"{"type":"status"}"#).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "state");
        assert_eq!(parsed["connected"], false);
    }

    /// The failure this file's per-request locking exists for.
    ///
    /// A rapid `setSplitTunnel` + `connect` burst left
    /// `wireguard.exe /installtunnelservice` in an unbounded retry loop
    /// with the `Engines` lock held, and every request behind it went
    /// unanswered for 25 minutes -- including a plain
    /// `{"type":"status"}`, which touches nothing at all. The customer
    /// was fully tunnelled throughout and the app could not so much as
    /// tell them so, let alone disconnect.
    ///
    /// Holding the lock here stands in for that operation. The answer is
    /// thinner than the locked one -- see `engines::os_visible_tunnel`
    /// for what it can and cannot say -- but it arrives, which is the
    /// whole point.
    #[tokio::test]
    async fn status_is_answered_while_an_operation_holds_the_lock() {
        let name = r"\\.\pipe\neoconnect-test-status-while-busy";
        let engines = start_server(name).await;
        let held = engines.lock().await;

        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            round_trip(name, r#"{"type":"status"}"#),
        )
        .await
        .expect("status must not queue behind whatever holds the lock");
        drop(held);

        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "state");
    }

    #[tokio::test]
    async fn rejects_a_malformed_request_without_dropping_the_connection() {
        let name = r"\\.\pipe\neoconnect-test-malformed";
        start_server(name).await;
        let reply = round_trip(name, "not json at all").await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(parsed["message"].as_str().unwrap().contains("malformed"));
    }

    #[tokio::test]
    async fn refuses_a_profile_carrying_a_config_injection() {
        // End-to-end version of the ipc-crate unit test: proves
        // validation is actually wired into the request path, not just
        // available to call.
        let name = r"\\.\pipe\neoconnect-test-injection";
        start_server(name).await;
        let profile = ConnectProfile::Wireguard(WireguardProfile {
            private_key: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=".into(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=".into(),
            endpoint: "203.0.113.5:51888\nPostUp = calc.exe".into(),
        });
        let request = serde_json::to_string(&Request::Connect { profile }).unwrap();
        let reply = round_trip(name, &request).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(parsed["message"].as_str().unwrap().contains("endpoint"));
    }

    /// Disarm, then read the state back, over the real pipe.
    ///
    /// One test rather than two on purpose. Gaming state is a
    /// process-global -- it has to be, since service start, service
    /// stop, uninstall and the idle watchdog all sweep it without an
    /// `Engines` value in hand -- so two tests touching it in parallel
    /// race each other, and the first version of this pair did: the
    /// status read landed while a disarm held the mutex and correctly
    /// answered "being turned off". Sequencing them tests the thing
    /// that actually matters, which is the state *after* a disarm.
    ///
    /// Disarming when nothing is armed must also succeed: every caller
    /// of it is a cleanup path -- the idle watchdog, the window
    /// closing, service stop -- and a cleanup that reports failure on a
    /// clean machine is one people learn to ignore.
    #[tokio::test]
    async fn disarming_leaves_gaming_mode_reporting_off() {
        let name = r"\\.\pipe\neoconnect-test-gaming-lifecycle";
        start_server(name).await;

        let reply = round_trip(name, r#"{"type":"disarmGaming"}"#).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "ok", "{parsed}");

        let reply = round_trip(name, r#"{"type":"gamingStatus"}"#).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "gaming");
        assert_eq!(parsed["state"], "off");
        assert_eq!(parsed["rules_present"], false);
        assert_eq!(parsed["canary_ok"], false);
        assert_eq!(parsed["proxy_reachable"], false);
        assert!(parsed["namespaces"].as_array().unwrap().is_empty());
        // `off` claims nothing, so it carries no detail to explain.
        assert!(parsed.get("detail").is_none() || parsed["detail"].is_null());
    }

    /// Validation is wired into the request path, not merely available
    /// to call -- and the `.` rejection in particular, since a `.` rule
    /// installed by a gaming profile is the whole-machine DNS outage
    /// this feature must not be able to cause.
    #[tokio::test]
    async fn refuses_a_gaming_profile_scoped_to_the_root_namespace() {
        let name = r"\\.\pipe\neoconnect-test-gaming-root";
        start_server(name).await;
        let request = r#"{"type":"armGaming","config":{"dohUrl":"https://fi1.neoxify.site/dns-query","proxyIp":"1.2.3.4","proxyPort":443,"namespaces":["."]}}"#;
        let reply = round_trip(name, request).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(
            parsed["message"]
                .as_str()
                .unwrap()
                .contains("every name on the machine"),
            "{parsed}"
        );
    }

    /// The same for a namespace carrying a shell metacharacter, which
    /// would otherwise reach a PowerShell command line in a process
    /// running as SYSTEM.
    #[tokio::test]
    async fn refuses_a_gaming_namespace_that_could_reach_the_shell() {
        let name = r"\\.\pipe\neoconnect-test-gaming-injection";
        start_server(name).await;
        let request = r#"{"type":"armGaming","config":{"dohUrl":"https://fi1.neoxify.site/dns-query","proxyIp":"1.2.3.4","proxyPort":443,"namespaces":["blizzard.com'; calc; #"]}}"#;
        let reply = round_trip(name, request).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(parsed["message"].as_str().unwrap().contains("namespaces"), "{parsed}");
    }

    #[tokio::test]
    async fn reports_a_missing_engine_binary_clearly() {
        let name = r"\\.\pipe\neoconnect-test-missing-engine";
        start_server(name).await;
        let profile = ConnectProfile::Wireguard(WireguardProfile {
            private_key: "GMSgBTYpH7yC6bV88xblWmViQlk+bHxiTDsdsi+WgXI=".into(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=".into(),
            endpoint: "203.0.113.5:51888".into(),
        });
        let request = serde_json::to_string(&Request::Connect { profile }).unwrap();
        let reply = round_trip(name, &request).await;
        let parsed: serde_json::Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert!(parsed["message"].as_str().unwrap().contains("wireguard.exe"));
    }
}

/// How long `status` waits for the lock before answering from what
/// Windows says instead.
///
/// Long enough to ride out an ordinary status ahead of it in the queue
/// -- one costs about half a second, most of it `Get-VpnConnection` --
/// and far too short to be held up by a connect.
const STATUS_LOCK_WAIT: Duration = Duration::from_secs(1);

/// How long `disconnect` waits for the lock before asking whatever holds
/// it to give up.
///
/// A connect takes about two and a half seconds end to end on this
/// machine, so anything past this is either something slow or something
/// stuck -- and in both cases a customer who has pressed Disconnect
/// meant it. Abandoning the operation in flight is the right reading of
/// the request, not a compromise: they want out of the tunnel, not the
/// connection attempt finished first.
const DISCONNECT_LOCK_WAIT: Duration = Duration::from_secs(2);

/// One request, one answer.
///
/// The lock is taken per request rather than for the whole function, and
/// the two requests that must never be starved by it take it on their
/// own terms. That is the fix for the failure this file's serialization
/// note did not anticipate: serializing is still correct, but it means
/// one operation that does not return takes every later request with it,
/// and the two that were lost that way -- "am I tunnelled" and "get me
/// out" -- are exactly the two a stranded customer needs.
async fn dispatch(request: Request, engines: &Arc<Mutex<Engines>>) -> Response {
    match request {
        // Answered whether or not an operation is in flight. See
        // `engines::os_visible_tunnel` for what the unlocked answer can
        // and cannot say.
        Request::Status => {
            let Ok(mut engines) = tokio::time::timeout(STATUS_LOCK_WAIT, engines.lock()).await
            else {
                let (connected, protocol, health) = crate::engines::os_visible_tunnel();
                return Response::State {
                    connected,
                    protocol,
                    health,
                    split_tunnel_active: crate::split_tunnel::running_without_the_lock(),
                    // The counters live behind the lock, so there is
                    // nothing to report rather than nothing wrong.
                    split_tunnel_problem: None,
                    // Same reason, and the same rule: whether a block is
                    // installed is only knowable behind the lock, so
                    // this says "we are not asserting one" rather than
                    // guessing from the protocol name.
                    ipv6_blocked: false,
                };
            };
            let (connected, protocol, health) = engines.status();
            let split_tunnel_active = engines.split_tunnel_running();
            let split_tunnel_problem = engines.split_tunnel_complaint();
            let ipv6_blocked = engines.ipv6_blocked();
            Response::State {
                connected,
                protocol,
                health,
                split_tunnel_active,
                split_tunnel_problem,
                ipv6_blocked,
            }
        }
        // Nothing here touches the machine, so there is no reason for
        // the app's picker to go blank while a connect runs.
        Request::ListRunningApps => Response::RunningApps {
            apps: crate::split_tunnel::running_apps(),
        },
        Request::Disconnect => {
            let mut engines = match tokio::time::timeout(DISCONNECT_LOCK_WAIT, engines.lock()).await
            {
                Ok(engines) => engines,
                Err(_) => {
                    crate::engines::abandon_current_operation();
                    engines.lock().await
                }
            };
            crate::engines::begin_operation();
            match engines.disconnect() {
                Ok(()) => Response::Ok,
                Err(message) => Response::Error { message },
            }
        }
        Request::Connect { profile } => {
            let mut engines = engines.lock().await;
            // Mutual exclusion with gaming mode, and it is refused
            // rather than resolved.
            //
            // Custom mode redirects *every* UDP/53 packet on the
            // machine to 1.1.1.1 for as long as it runs, which would
            // swallow the loopback stub whole -- and a full tunnel
            // installs a `.` NRPT rule, which outranks nothing but
            // certainly changes what the game's lookups do. Either way
            // the two features would be quietly fighting over the same
            // resolver.
            //
            // Tearing gaming mode down on the customer's behalf was the
            // alternative and is worse: they asked for one thing and
            // would silently lose another, with the app showing no
            // trace of having done it. Saying so costs one tap.
            if crate::gaming::is_armed() {
                return Response::Error {
                    message: "Gaming mode is on, and a VPN connection cannot run alongside it. \
                              Turn Gaming mode off first."
                        .to_string(),
                };
            }
            crate::engines::begin_operation();
            match engines.connect(&profile) {
                Ok(()) => Response::Ok,
                Err(message) => Response::Error { message },
            }
        }
        // The `Engines` lock is held across the arm, and that is the
        // other half of the mutual exclusion above: `Connect` cannot
        // start while this runs, and this cannot start while a
        // `Connect` runs, so "is a tunnel up" is a fact for the whole
        // of the decision rather than a value that was true a moment
        // ago. See the lock-order note in `gaming`.
        Request::ArmGaming { config } => {
            if let Err(e) = config.validate() {
                return Response::Error { message: e.to_string() };
            }
            let mut engines = engines.lock().await;
            crate::engines::begin_operation();
            let (tunnel_up, protocol, _) = engines.status();
            if tunnel_up {
                return Response::Error {
                    message: format!(
                        "A {} connection is running, and Gaming mode cannot run alongside it. Disconnect first.",
                        protocol.unwrap_or_else(|| "VPN".to_string())
                    ),
                };
            }
            match crate::gaming::arm(config) {
                Ok(report) => gaming_response(report),
                Err(message) => Response::Error { message },
            }
        }
        Request::DisarmGaming => {
            let _engines = engines.lock().await;
            match crate::gaming::disarm() {
                Ok(()) => Response::Ok,
                Err(message) => Response::Error { message },
            }
        }
        // Deliberately does not take the `Engines` lock, for the same
        // reason `Status` does not queue behind it: this is the request
        // that tells a customer whether their game's DNS is actually
        // being redirected, and it is worth nothing if it can be
        // starved by whatever is slow at the time.
        Request::GamingStatus => gaming_response(crate::gaming::status()),
        Request::ProbeSplitTunnel => {
            let engines = engines.lock().await;
            crate::engines::begin_operation();
            match engines.probe_split_tunnel() {
                Ok(()) => Response::Ok,
                Err(message) => Response::Error { message },
            }
        }
        Request::SetSplitTunnel { config } => match config.validate() {
            // The result matters now: turning Custom mode on or off
            // rebuilds the live tunnel, and a rebuild that fails must
            // reach the customer rather than reading as applied.
            Ok(()) => {
                let mut engines = engines.lock().await;
                crate::engines::begin_operation();
                match engines.set_split_tunnel(config.enabled, config.apps, config.mode) {
                    Ok(()) => Response::Ok,
                    Err(message) => Response::Error { message },
                }
            }
            Err(e) => Response::Error { message: e.to_string() },
        },
    }
}

/// Turns a gaming report into the wire response.
///
/// One place, so the arm path and the status path can never disagree
/// about what the three checks were -- the arm reply is the first thing
/// the app puts on screen, and a state it derived differently from the
/// poll that follows a second later would show as the mode flickering.
fn gaming_response(report: crate::gaming::Report) -> Response {
    Response::Gaming {
        state: report.state,
        detail: report.detail,
        rules_present: report.rules_present,
        canary_ok: report.canary_ok,
        proxy_reachable: report.proxy_reachable,
        namespaces: report.namespaces,
    }
}

/// Tears the tunnel down once the app has stopped talking to us.
///
/// Polls rather than reacting to a connection closing, because the app
/// does not hold one open -- every request is its own short-lived
/// connection, so "connected" is not a state this service can observe.
/// What it can observe is silence.
fn spawn_idle_watchdog(engines: Arc<Mutex<Engines>>, last_seen: Arc<Mutex<Instant>>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            if last_seen.lock().await.elapsed() < IDLE_GRACE {
                continue;
            }
            let mut engines = engines.lock().await;
            crate::engines::begin_operation();

            // Gaming mode first, and outside the tunnel check below --
            // which is the whole point.
            //
            // This watchdog keys on `status()` reporting a tunnel, and
            // a gaming session reports none: no engine, no adapter, no
            // route. So the `if !up { continue }` a few lines down
            // would skip every gaming session forever, and an app that
            // crashed or was killed would leave namespace-scoped NRPT
            // rules on the machine pointing at a stub inside a service
            // nobody is talking to. That is the same class of leftover
            // as a tunnel outliving its app, only quieter: the game
            // stops launching and nothing on screen suggests why.
            //
            // Decided deliberately: gaming rules must not outlive the
            // app. The `Engines` lock is held here, which is the lock
            // order gaming's own mutex is always taken under.
            if crate::gaming::is_armed() {
                eprintln!("app silent for {IDLE_GRACE:?} with gaming mode armed -- disarming it");
                if let Err(err) = crate::gaming::disarm() {
                    crate::cleanup_log::note(
                        "disarm gaming mode after the app went away",
                        &err,
                    );
                }
            }

            // status() consults the OS, so this asks "is anything
            // actually tunnelling" rather than "did we start something".
            let (up, _, _) = engines.status();
            if !up {
                continue;
            }
            eprintln!("app silent for {IDLE_GRACE:?} with a tunnel up -- tearing it down");
            if let Err(err) = engines.disconnect() {
                crate::cleanup_log::note("tear the tunnel down after the app went away", &err);
            }
        }
    });
}
