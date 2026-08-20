//! The control pipe.
//!
//! One JSON request per line, one JSON response per line. Connections
//! are handled one at a time on purpose: every operation here mutates
//! global machine state (routing table, tunnel adapters), so serializing
//! them is correctness, not a simplification. A second caller waits
//! rather than racing the first.

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

async fn dispatch(request: Request, engines: &Arc<Mutex<Engines>>) -> Response {
    let mut engines = engines.lock().await;
    match request {
        Request::Connect { profile } => match engines.connect(&profile) {
            Ok(()) => Response::Ok,
            Err(message) => Response::Error { message },
        },
        Request::Disconnect => match engines.disconnect() {
            Ok(()) => Response::Ok,
            Err(message) => Response::Error { message },
        },
        Request::Status => {
            let (connected, protocol, health) = engines.status();
            let split_tunnel_active = engines.split_tunnel_running();
            Response::State { connected, protocol, health, split_tunnel_active }
        }
        Request::ListRunningApps => Response::RunningApps {
            apps: crate::split_tunnel::running_apps()
                .into_iter()
                .map(|(path, name)| neoconnect_ipc::RunningApp { path, name })
                .collect(),
        },
        Request::ProbeSplitTunnel => match engines.probe_split_tunnel() {
            Ok(()) => Response::Ok,
            Err(message) => Response::Error { message },
        },
        Request::SetSplitTunnel { config } => match config.validate() {
            // The result matters now: turning Custom mode on or off
            // rebuilds the live tunnel, and a rebuild that fails must
            // reach the customer rather than reading as applied.
            Ok(()) => match engines.set_split_tunnel(config.enabled, config.apps, config.mode) {
                Ok(()) => Response::Ok,
                Err(message) => Response::Error { message },
            },
            Err(e) => Response::Error { message: e.to_string() },
        },
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
            // status() consults the OS, so this asks "is anything
            // actually tunnelling" rather than "did we start something".
            let (up, _, _) = engines.status();
            if !up {
                continue;
            }
            eprintln!("app silent for {IDLE_GRACE:?} with a tunnel up -- tearing it down");
            if let Err(err) = engines.disconnect() {
                eprintln!("app-gone cleanup: {err}");
            }
        }
    });
}
