//! Whether the tunnel is carrying traffic, asked over the exact path a
//! selected application's traffic takes.
//!
//! Moved out of `proxy.rs`, which relays and never needed any of this:
//! these functions open their own sockets, send their own bytes and
//! relay nothing. `mod.rs` asks both questions -- `probe` while choosing
//! a route shape, `prove_carries` for the verdict the app shows -- and
//! the only thing they share with the relay is how a socket is attached
//! to the tunnel, which stays there and is borrowed from here.

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

use super::proxy::{attach_to_tunnel, TunnelInterface};

/// Addresses used only to prove the tunnel carries traffic.
///
/// Two, because one being down or filtered is not evidence about the
/// tunnel. Both are anycast resolvers that answer on 443 from
/// essentially everywhere, so a refusal here really does say something
/// about the path rather than about the destination.
const PROBE_TARGETS: [(Ipv4Addr, u16); 2] =
    [(Ipv4Addr::new(1, 1, 1, 1), 443), (Ipv4Addr::new(8, 8, 8, 8), 443)];

/// Short on purpose: this runs inside the connect ladder, and a slow
/// answer costs the customer the same as a wrong one.
const PROBE_TIMEOUT: Duration = Duration::from_millis(3500);

/// Proves the tunnel is actually carrying traffic, over the exact path a
/// selected app's traffic takes.
///
/// This exists because Custom mode broke the app's own connection check
/// and the reason is structural, not a bug to patch: the check works by
/// requesting its own address and seeing the server's. In Custom mode
/// the app is not a selected app, so that request correctly goes out the
/// ordinary route -- and the check correctly reports the tunnel being
/// bypassed. Every protocol therefore "failed", the ladder walked all
/// five, and the customer was told it could not connect while the tunnel
/// was in fact up and working.
///
/// A socket pinned exactly as the proxy's are is the honest replacement,
/// for the path that actually matters rather than for the app's own
/// traffic, which deliberately does not use it.
///
/// **What a pass here does and does not mean.** It means a socket could
/// be attached to this tunnel and complete a TCP handshake through it,
/// which is what route selection needs to know and is why
/// `install_verified_route` uses this. It does **not** mean the node is
/// reachable: under Xray's own `tun` inbound the handshake is answered
/// by xray.exe's userspace stack, and nothing is sent afterwards for the
/// outbound to have to carry. This comment used to claim the opposite --
/// "proves the tunnel has a route to the internet and that the far end
/// answered" -- and the customer-facing verdict was built on that claim.
/// See `prove_carries` for the check that earns it.
pub fn probe(tunnel: &TunnelInterface) -> Result<(), String> {
    // No tunnel means the fail-open state: selected apps are going out
    // unprotected. Reporting that as reachable would be the exact
    // dishonesty this whole function exists to remove.
    let Some((index, address)) = tunnel.get() else {
        return Err("no tunnel is up, so nothing is being routed through one".into());
    };

    let mut last = String::new();
    for (target, port) in PROBE_TARGETS {
        match connect_pinned(target, port, index, address) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{target}:{port} {e}"),
        }
    }
    Err(format!("the tunnel did not carry a test connection ({last})"))
}

/// Deliberately does **not** disable Nagle, unlike every relayed
/// connection. Nagle governs when queued application data is released,
/// and this socket never writes a byte: it completes a handshake and is
/// dropped. Setting the option here would cost a syscall inside the
/// connect ladder -- where `PROBE_TIMEOUT` is deliberately short because
/// a slow answer costs the customer as much as a wrong one -- and change
/// nothing observable.
fn connect_pinned(
    target: Ipv4Addr,
    port: u16,
    index: u32,
    source: Ipv4Addr,
) -> Result<(), String> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    attach_to_tunnel(&socket, index, source).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&SocketAddr::from((target, port)).into(), PROBE_TIMEOUT)
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ *
 * Proving the tunnel carries traffic, as opposed to proving a socket
 * can be attached to it.
 *
 * `probe` above answers the second question, and route selection is the
 * right consumer for it: it is asking whether a route shape works at
 * all, and a completed TCP handshake settles that.
 *
 * It is not enough to put "You're protected" on a customer's screen, for
 * two reasons that compound.
 *
 * **The handshake need never leave the machine.** Xray on Windows runs
 * its own `tun` inbound -- a userspace TCP stack inside xray.exe (see
 * `engines/xray.rs`). The SYN this probe emits is answered by that
 * stack, not by 1.1.1.1. It completes as soon as xray.exe is running
 * with a live Wintun adapter, whether or not the VLESS session to the
 * node exists, and since the old probe sent zero bytes the outbound was
 * never asked to carry anything. For the kernel tunnels -- WireGuard,
 * OpenVPN, IKEv2 -- the SYN really does traverse the tunnel, so the hole
 * is narrower there but the check is still weaker than it reads.
 *
 * **REALITY does not refuse an unknown SNI; it proxies to the decoy.**
 * A node whose `dest` was changed while a client holds a stale
 * `serverName` hands that client's connection straight to a third-party
 * website. The outer TLS keeps succeeding and looks perfectly healthy
 * while the customer's traffic goes nowhere. Any far-end
 * misconfiguration produces the same shape, so a check that stops at TCP
 * cannot tell a working node from a broken one.
 *
 * What distinguishes them is **bytes coming back from the destination**.
 * Both probe targets are DNS-over-HTTPS resolvers, so a ClientHello sent
 * to them is answered with a TLS record. Nothing local can forge that:
 * xray's userspace stack will ACK a SYN, but it has no ServerHello to
 * invent, and a REALITY session handed to a decoy fails client-side
 * before any payload is relayed. So the connection is closed with
 * nothing read, and this check comes back negative -- which is the
 * behaviour the old one could not produce.
 * ------------------------------------------------------------------ */

/// Total budget for one target: connect, write, and read a reply.
///
/// Kept equal to `PROBE_TIMEOUT` rather than added to it. This runs
/// inside the connect ladder and on every health poll, and a check that
/// doubles the time a customer waits has traded one complaint for
/// another.
const CARRY_TIMEOUT: Duration = PROBE_TIMEOUT;

/// A minimal but genuine TLS 1.2+ ClientHello for `cloudflare-dns.com`.
///
/// Genuine matters. A random blob would be answered with a TLS `alert`
/// record, which is still a record and would therefore still pass -- a
/// check that cannot fail, which is the recurring defect in this
/// codebase. A well-formed ClientHello draws a `handshake` record from a
/// working path and nothing at all from a broken one.
///
/// The SNI is a real Cloudflare name because the target is 1.1.1.1;
/// 8.8.8.8 answers a ClientHello for it regardless, since a name it does
/// not serve still produces a record.
fn client_hello() -> Vec<u8> {
    const SNI: &[u8] = b"cloudflare-dns.com";

    // server_name extension: list length, type 0 (host_name), name.
    let mut server_name = Vec::new();
    server_name.extend_from_slice(&((SNI.len() + 3) as u16).to_be_bytes());
    server_name.push(0);
    server_name.extend_from_slice(&(SNI.len() as u16).to_be_bytes());
    server_name.extend_from_slice(SNI);

    let mut extensions = Vec::new();
    // server_name
    extensions.extend_from_slice(&0x0000u16.to_be_bytes());
    extensions.extend_from_slice(&(server_name.len() as u16).to_be_bytes());
    extensions.extend_from_slice(&server_name);
    // supported_versions: TLS 1.3, TLS 1.2
    extensions.extend_from_slice(&0x002bu16.to_be_bytes());
    extensions.extend_from_slice(&5u16.to_be_bytes());
    extensions.push(4);
    extensions.extend_from_slice(&0x0304u16.to_be_bytes());
    extensions.extend_from_slice(&0x0303u16.to_be_bytes());
    // supported_groups: x25519, secp256r1
    extensions.extend_from_slice(&0x000au16.to_be_bytes());
    extensions.extend_from_slice(&6u16.to_be_bytes());
    extensions.extend_from_slice(&4u16.to_be_bytes());
    extensions.extend_from_slice(&0x001du16.to_be_bytes());
    extensions.extend_from_slice(&0x0017u16.to_be_bytes());
    // signature_algorithms: ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256
    extensions.extend_from_slice(&0x000du16.to_be_bytes());
    extensions.extend_from_slice(&6u16.to_be_bytes());
    extensions.extend_from_slice(&4u16.to_be_bytes());
    extensions.extend_from_slice(&0x0403u16.to_be_bytes());
    extensions.extend_from_slice(&0x0804u16.to_be_bytes());

    let mut body = Vec::new();
    // client_version: TLS 1.2, as TLS 1.3 requires on the wire.
    body.extend_from_slice(&0x0303u16.to_be_bytes());
    // random. Fixed rather than sampled: nothing here is cryptographic,
    // the session is abandoned after one record, and a probe with no
    // entropy source is one fewer thing that can fail.
    body.extend_from_slice(&[0x4e; 32]);
    // session_id: empty.
    body.push(0);
    // cipher_suites: TLS_AES_128_GCM_SHA256, TLS_ECDHE_RSA_AES_128_GCM_SHA256
    body.extend_from_slice(&4u16.to_be_bytes());
    body.extend_from_slice(&0x1301u16.to_be_bytes());
    body.extend_from_slice(&0xc02fu16.to_be_bytes());
    // compression_methods: null only.
    body.extend_from_slice(&[1, 0]);
    body.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
    body.extend_from_slice(&extensions);

    let mut handshake = Vec::new();
    handshake.push(1); // client_hello
    let len = body.len();
    handshake.extend_from_slice(&[(len >> 16) as u8, (len >> 8) as u8, len as u8]);
    handshake.extend_from_slice(&body);

    let mut record = Vec::new();
    record.push(0x16); // handshake
    record.extend_from_slice(&0x0301u16.to_be_bytes());
    record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
    record.extend_from_slice(&handshake);
    record
}

/// Whether the first bytes off the wire are the start of a TLS record a
/// real server sent.
///
/// Deliberately narrow. `handshake` (0x16) is what a working path
/// returns; `alert` (0x15) is accepted too, because a server that
/// dislikes the ClientHello still had to receive it and reply, which is
/// the fact being established. Anything else -- an HTTP error page from
/// a captive portal, a decoy site's response, a truncated read -- is
/// not evidence that the intended destination answered.
///
/// The version check is what keeps this from accepting arbitrary bytes:
/// a record whose type byte happens to be 0x16 but whose version is not
/// a TLS one is not a TLS record.
fn looks_like_tls(reply: &[u8]) -> bool {
    let [kind, major, minor, ..] = reply else {
        return false;
    };
    matches!(kind, 0x16 | 0x15) && *major == 0x03 && matches!(minor, 0x00..=0x04)
}

/// Proves the tunnel carried a request *and brought back an answer*.
///
/// The verdict the app turns into "You're protected" in Custom mode. See
/// the comment block above for why a completed handshake is not enough
/// on its own.
pub fn prove_carries(tunnel: &TunnelInterface) -> Result<(), String> {
    // No tunnel means the fail-open state: selected apps are going out
    // unprotected. Reporting that as carrying traffic would be the exact
    // dishonesty this whole function exists to remove.
    let Some((index, address)) = tunnel.get() else {
        return Err("no tunnel is up, so nothing is being routed through one".into());
    };

    let mut last = String::new();
    for (target, port) in PROBE_TARGETS {
        match round_trip_pinned(target, port, index, address) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{target}:{port} {e}"),
        }
    }
    Err(format!("the tunnel did not carry a test connection ({last})"))
}

fn round_trip_pinned(
    target: Ipv4Addr,
    port: u16,
    index: u32,
    source: Ipv4Addr,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let started = Instant::now();
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    attach_to_tunnel(&socket, index, source).map_err(|e| e.to_string())?;
    socket
        .connect_timeout(&SocketAddr::from((target, port)).into(), CARRY_TIMEOUT)
        .map_err(|e| format!("connect: {e}"))?;

    // Whatever is left of the budget, never zero -- a zero timeout on a
    // Windows socket means "block forever", which is how a check with a
    // deadline becomes one without.
    let remaining = CARRY_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "connect used the whole budget".to_string())?;
    socket.set_write_timeout(Some(remaining)).map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(remaining)).map_err(|e| e.to_string())?;

    let mut stream: TcpStream = socket.into();
    stream.write_all(&client_hello()).map_err(|e| format!("send: {e}"))?;

    // Five bytes is a whole TLS record header and all this needs; the
    // rest of the handshake is of no interest and reading it would only
    // cost time on a slow link.
    let mut header = [0u8; 5];
    let mut filled = 0;
    while filled < header.len() {
        match stream.read(&mut header[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("read: {e}")),
        }
    }

    if looks_like_tls(&header[..filled]) {
        return Ok(());
    }
    // Named precisely, because this is the case the old probe could not
    // see: the connection was made and the far end sent nothing back
    // that the destination could have sent. That is what a tunnel
    // terminating in a decoy site, or in xray's own userspace stack,
    // looks like from here.
    Err(format!(
        "the tunnel completed a connection but carried no reply from {target} ({filled} byte(s))"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn the_probe_refuses_to_pass_when_no_tunnel_is_up() {
        // The fail-open state: selected apps are going out unprotected.
        // Reporting that as reachable would let the ladder settle on a
        // "connection" carrying nothing through the tunnel -- the exact
        // false-Connected this project keeps having to remove.
        let error = probe(&TunnelInterface::default()).expect_err("no tunnel means no proof");
        assert!(error.contains("no tunnel"), "got {error}");
    }

    #[test]
    fn proving_carriage_refuses_to_pass_when_no_tunnel_is_up() {
        // The same fail-open guard as above, on the stricter check --
        // written out rather than assumed, because this is the one whose
        // verdict becomes "You're protected".
        let error =
            prove_carries(&TunnelInterface::default()).expect_err("no tunnel means no proof");
        assert!(error.contains("no tunnel"), "got {error}");
    }

    #[test]
    fn a_completed_connection_that_answers_nothing_is_not_proof() {
        // The whole point of the stricter probe, exercised against a
        // listener that behaves exactly as the failure modes do: it
        // accepts the connection and never sends a byte.
        //
        // That is what xray-core's own `tun` inbound does when its
        // outbound cannot be dialled -- it has already ACKed the SYN
        // locally -- and it is what a REALITY session handed to a decoy
        // site produces, because the client aborts before any payload is
        // relayed. The old probe passed both. This is the control that
        // shows it: `looks_like_tls` on what such a peer sends back is
        // false, so `round_trip_pinned` cannot return Ok.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepted = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            // Read the ClientHello so the write side cannot fail, then
            // hang up without answering.
            let mut sink = [0u8; 1024];
            let _ = std::io::Read::read(&mut stream, &mut sink);
            drop(stream);
        });

        // Loopback, unpinned: the interface machinery is not what is
        // under test here and cannot be stood up in a unit test.
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        std::io::Write::write_all(&mut stream, &client_hello()).expect("send");
        stream.set_read_timeout(Some(Duration::from_secs(2))).expect("timeout");
        let mut header = [0u8; 5];
        let filled = std::io::Read::read(&mut stream, &mut header).unwrap_or(0);
        accepted.join().expect("listener");

        assert_eq!(filled, 0, "a silent peer must not send anything");
        assert!(!looks_like_tls(&header[..filled]), "silence is not a TLS reply");
    }

    #[test]
    fn only_a_tls_record_from_the_far_end_counts_as_a_reply() {
        // The other half of the same guard, and the reason it is written
        // as a table: a check that accepts anything is the recurring
        // defect this file keeps producing. Each rejected case is a real
        // thing that arrives on port 443 through a broken path.
        assert!(looks_like_tls(&[0x16, 0x03, 0x03, 0x00, 0x5a]), "a TLS 1.2 handshake record");
        assert!(looks_like_tls(&[0x16, 0x03, 0x01, 0x00, 0x2a]), "a TLS 1.0-framed record");
        assert!(looks_like_tls(&[0x15, 0x03, 0x03, 0x00, 0x02]), "an alert is still a reply");

        assert!(!looks_like_tls(&[]), "nothing came back");
        assert!(!looks_like_tls(&[0x16, 0x03]), "a truncated read is not a record");
        // A captive portal or a decoy site answering HTTP: "HTTP/1.1".
        assert!(!looks_like_tls(b"HTTP/1"), "an HTTP response is not a TLS record");
        // The type byte alone must not carry the decision.
        assert!(!looks_like_tls(&[0x16, 0x09, 0x09, 0x00, 0x01]), "0x16 with no TLS version");
        assert!(!looks_like_tls(&[0x17, 0x03, 0x03, 0x00, 0x01]), "application data unprompted");
    }

    #[test]
    fn the_client_hello_is_one_well_formed_tls_record() {
        // Not cosmetic. A malformed blob would draw an `alert` record,
        // which `looks_like_tls` accepts -- so the check would pass on
        // any path that reaches a TLS server at all and would have
        // nothing to say about whether it reached the right one. Worse,
        // it would still pass through a decoy, which is the failure this
        // exists to catch.
        let hello = client_hello();
        assert_eq!(hello[0], 0x16, "handshake record");
        assert_eq!(&hello[1..3], &[0x03, 0x01], "record version TLS 1.0, as TLS 1.3 requires");

        let record_len = u16::from_be_bytes([hello[3], hello[4]]) as usize;
        assert_eq!(record_len, hello.len() - 5, "the record header must describe the record");

        assert_eq!(hello[5], 0x01, "client_hello");
        let handshake_len = ((hello[6] as usize) << 16) | ((hello[7] as usize) << 8) | hello[8] as usize;
        assert_eq!(handshake_len, hello.len() - 9, "the handshake header likewise");

        // Small enough to leave in one segment on any path, which is
        // what keeps this cheap on a slow censored link.
        assert!(hello.len() < 512, "the ClientHello is {} bytes", hello.len());
    }

    #[test]
    #[ignore = "u32::MAX is not a reliable stand-in for an unreachable interface -- see the comment"]
    fn the_probe_fails_rather_than_falling_back_to_the_normal_route() {
        // Pinned to an interface that does not exist, so there should be
        // no route to reach anything.
        //
        // Ignored because the premise is not a guarantee. This is the
        // second time this same test has been written against an assumed
        // Windows behaviour and been wrong: first `setsockopt` was
        // expected to reject a bogus index and did not, and now `connect`
        // over one is observed to succeed on a real machine -- an invalid
        // index appears to leave the socket unconstrained rather than
        // constrained to nothing.
        //
        // The property itself does hold for indices that name a real
        // adapter, which is the only case production has. The evidence is
        // a customer's own log: on one machine, at one moment, sockets
        // pinned to the Xray and OpenVPN adapters failed with
        // WSAEHOSTUNREACH while a socket pinned to the WireGuard adapter
        // connected. If pinning were being ignored, all three would have
        // gone out the physical link and all three would have succeeded.
        //
        // Left in place rather than deleted so the next person does not
        // write it a third time.
        let error = probe(&TunnelInterface::new(u32::MAX, Ipv4Addr::new(10, 66, 0, 3)))
            .expect_err("nothing can be reached");
        assert!(error.contains("did not carry"), "got {error}");
    }
}
