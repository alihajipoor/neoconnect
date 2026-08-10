//! Round-trip time to a server, for the location picker.
//!
//! The picker calls `measure_latency` for every route and shows "--"
//! when it returns nothing. On Android it showed "--" for every server,
//! always -- not because the servers were slow or unreachable, but
//! because this command only existed in the Windows client, so every
//! call rejected and the catch turned it into a blank.
//!
//! TCP rather than ICMP, for the same reason the desktop client gives:
//! ICMP needs privileges the app does not have, and is widely filtered
//! by exactly the networks a censored customer is on. A TCP handshake
//! is privilege-free and measures the path that actually matters.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// Long enough that a genuinely distant server still measures, short
/// enough that a dead one does not hold up the list. Matches the
/// desktop client so the two do not disagree about the same server.
const TIMEOUT: Duration = Duration::from_millis(2500);

/// The port every node answers TLS on, used when the route's own port
/// cannot be measured. See `probe` for why that happens.
const TLS_FALLBACK_PORT: u16 = 443;

#[tauri::command]
pub async fn measure_latency(host: String, port: u16) -> Option<u32> {
    // Blocking sockets on a blocking thread. This app has no async
    // runtime of its own, and holding Tauri's while a dead server times
    // out for 2.5s would stall every other command behind it -- with a
    // dozen routes measured at once, that is the whole UI.
    tauri::async_runtime::spawn_blocking(move || probe(&host, port))
        .await
        .ok()
        .flatten()
}

fn probe(host: &str, port: u16) -> Option<u32> {
    // WireGuard listens on 51820/udp and OpenVPN on 1194/udp, and a TCP
    // connect can only ever succeed against a TCP listener -- so for
    // those two the route's own port always fails, and measuring it
    // alone would leave them permanently blank while every Xray row
    // showed a number. The desktop client races ICMP to cover this,
    // using an API that only exists on Windows.
    //
    // The node answers TLS regardless of which protocol the row is for,
    // and it is the same machine over the same path, so its handshake
    // time is the honest answer to "how far away is this server". Only
    // used as a fallback, so a protocol with a real TCP port is still
    // measured on that port.
    connect_ms(host, port).or_else(|| {
        if port == TLS_FALLBACK_PORT {
            None
        } else {
            connect_ms(host, TLS_FALLBACK_PORT)
        }
    })
}

fn connect_ms(host: &str, port: u16) -> Option<u32> {
    let started = Instant::now();
    // Resolution is inside the measurement deliberately: a customer
    // waiting to connect waits for that too, so excluding it would
    // report a number nobody experiences.
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    TcpStream::connect_timeout(&addr, TIMEOUT).ok()?;
    Some(started.elapsed().as_millis() as u32)
}
