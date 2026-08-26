//! A SOCKS5 client, just enough of one to hand a flow to a local Xray
//! inbound.
//!
//! # Why this exists
//!
//! Everywhere else in this feature, an onward socket is placed on the
//! tunnel by pinning it to an interface (`IP_UNICAST_IF`) and binding
//! its source address -- see [`super::proxy::TunnelInterface`]. That
//! mechanism can only ever name **one** egress, because there is only
//! one tunnel adapter and one address on it.
//!
//! Concurrent per-game exits need several. The design that gets them
//! without a second engine (`docs/design/per-game-exits.md` §2.4) is one
//! Xray process with several tagged inbounds, each routed to its own
//! outbound and therefore its own node. Those inbounds speak SOCKS5,
//! so the relay has to as well: instead of pinning a socket to an
//! adapter, it opens an ordinary loopback socket and *asks* for the
//! destination.
//!
//! # What is implemented, and what deliberately is not
//!
//! Only what the local inbound offers and the relay needs:
//!
//! * **No authentication.** The inbound is bound to loopback and is
//!   addressed only by this service; a credential would be a secret
//!   shared between two halves of one program. The greeting therefore
//!   offers exactly one method and refuses anything but "none" in
//!   reply -- a server asking for a password is not the server this
//!   relay meant to reach, and continuing would be talking to something
//!   unidentified.
//! * **IPv4 destinations only.** The relay decides about IPv4 flows;
//!   `redirect.rs` blocks a selected application's IPv6 outright rather
//!   than carrying it. Names never reach here either -- the relay has
//!   an address by the time it dials, because the application it is
//!   carrying already resolved one.
//! * **No BIND.** Nothing in this relay accepts an inbound connection
//!   on a flow's behalf.
//!
//! # Timeouts
//!
//! Every read has one. A handshake against a loopback port answers in
//! microseconds or never, and "never" is what happens when Xray is
//! starting, has already exited, or was reconfigured out from under
//! this flow. Without a timeout that is a relay thread parked forever
//! on a socket nobody will answer.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, UdpSocket};
use std::time::Duration;

/// The only version this speaks.
const VERSION: u8 = 5;
/// "No authentication required", offered and required.
const AUTH_NONE: u8 = 0;
const CMD_CONNECT: u8 = 1;
const CMD_UDP_ASSOCIATE: u8 = 3;
const ATYP_IPV4: u8 = 1;
const ATYP_DOMAIN: u8 = 3;
const ATYP_IPV6: u8 = 4;
const REPLY_SUCCESS: u8 = 0;

/// How long the loopback handshake may take.
///
/// Generous for a local socket by orders of magnitude, and short enough
/// that a flow whose inbound is not there fails while the application
/// is still willing to retry rather than after it has given up.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(4);

/// The loopback address every exit inbound listens on. Held here rather
/// than taken from a caller: an exit inbound reachable off loopback is
/// an open proxy on the customer's machine, and that is a property this
/// module should not accept an argument about.
pub const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

fn protocol_error(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("SOCKS5: {what}"))
}

/// Greets the server and requires "no authentication" back.
fn greet(stream: &mut TcpStream) -> io::Result<()> {
    stream.write_all(&[VERSION, 1, AUTH_NONE])?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply)?;
    if reply[0] != VERSION {
        return Err(protocol_error("the server is not speaking SOCKS5"));
    }
    if reply[1] != AUTH_NONE {
        // Includes 0xFF, "no acceptable methods". Either way the thing
        // on the other end is not the inbound this relay wrote.
        return Err(protocol_error("the server wants an authentication method we do not offer"));
    }
    Ok(())
}

/// Sends a request and reads the reply's bound address.
fn request(stream: &mut TcpStream, command: u8, target: SocketAddrV4) -> io::Result<SocketAddrV4> {
    let mut message = Vec::with_capacity(10);
    message.extend_from_slice(&[VERSION, command, 0, ATYP_IPV4]);
    message.extend_from_slice(&target.ip().octets());
    message.extend_from_slice(&target.port().to_be_bytes());
    stream.write_all(&message)?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head)?;
    if head[0] != VERSION {
        return Err(protocol_error("the reply is not SOCKS5"));
    }
    if head[1] != REPLY_SUCCESS {
        // Mapped rather than reported as a number, because these
        // surface in the split-tunnel log where a bare `reply 5` tells
        // whoever is reading it nothing.
        let reason = match head[1] {
            1 => "general failure",
            2 => "not allowed",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command not supported",
            8 => "address type not supported",
            _ => "unknown failure",
        };
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("SOCKS5: the exit refused the request ({reason})"),
        ));
    }
    // The bound address. Its length depends on the type, and it has to
    // be consumed whether or not the caller wants it, or the stream
    // starts mid-field.
    let bound = match head[3] {
        ATYP_IPV4 => {
            let mut rest = [0u8; 6];
            stream.read_exact(&mut rest)?;
            SocketAddrV4::new(
                Ipv4Addr::new(rest[0], rest[1], rest[2], rest[3]),
                u16::from_be_bytes([rest[4], rest[5]]),
            )
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len)?;
            let mut rest = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut rest)?;
            // A name cannot be dialled from here -- see the module note
            // on why nothing resolves in this relay -- and it is only
            // ever the *bound* address, which UDP ASSOCIATE below
            // replaces with loopback anyway.
            SocketAddrV4::new(LOOPBACK, u16::from_be_bytes([rest[len[0] as usize], rest[len[0] as usize + 1]]))
        }
        ATYP_IPV6 => {
            let mut rest = [0u8; 18];
            stream.read_exact(&mut rest)?;
            SocketAddrV4::new(LOOPBACK, u16::from_be_bytes([rest[16], rest[17]]))
        }
        _ => return Err(protocol_error("the reply names an address type that does not exist")),
    };
    Ok(bound)
}

/// Opens a TCP connection to `target` through the SOCKS5 inbound on
/// `port`.
///
/// The returned stream is the application's connection: everything
/// written to it reaches `target` from the exit that inbound is routed
/// to. Read and write timeouts are cleared before it is handed back,
/// because a carried connection may legitimately be idle for as long as
/// the application keeps it.
pub fn connect(port: u16, target: SocketAddrV4) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::V4(SocketAddrV4::new(LOOPBACK, port)),
        HANDSHAKE_TIMEOUT,
    )?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    greet(&mut stream)?;
    request(&mut stream, CMD_CONNECT, target)?;
    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(stream)
}

/// A UDP association with a SOCKS5 inbound.
///
/// # Why the TCP stream is held
///
/// It is not vestigial and it must not be dropped. In SOCKS5 the
/// control connection *is* the association's lifetime: the server
/// releases the relay port when it closes. Holding it is what keeps the
/// flow's datagrams being carried, so it lives here for exactly as long
/// as the flow does.
pub struct UdpAssociation {
    /// The socket the relay's datagrams actually travel on.
    socket: UdpSocket,
    /// Where the server said to send them. Held for the `connect`
    /// below and for a reader tracing a flow in the log.
    #[allow(dead_code)]
    relay: SocketAddrV4,
    /// The association's lifetime. See the type note.
    _control: TcpStream,
}

impl UdpAssociation {
    /// Opens an association with the inbound on `port`.
    pub fn open(port: u16) -> io::Result<Self> {
        let mut control = TcpStream::connect_timeout(
            &SocketAddr::V4(SocketAddrV4::new(LOOPBACK, port)),
            HANDSHAKE_TIMEOUT,
        )?;
        control.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        control.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
        greet(&mut control)?;
        // All-zero: this relay does not know which source address it
        // will send from until it has bound one, and the inbound is on
        // loopback where the question does not arise.
        let bound = request(&mut control, CMD_UDP_ASSOCIATE, SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))?;

        // Bound to loopback rather than to the tunnel. This socket
        // never leaves the machine -- the hop that does is Xray's own
        // outbound, which it pins to the physical link itself.
        let socket = UdpSocket::bind(SocketAddrV4::new(LOOPBACK, 0))?;

        // A server may answer with an unspecified address, meaning
        // "the one you are already talking to". Sending datagrams to
        // 0.0.0.0 reaches nothing, so that case is resolved here to
        // the address the control connection is on.
        let relay = if bound.ip().is_unspecified() {
            SocketAddrV4::new(LOOPBACK, bound.port())
        } else {
            bound
        };
        // The relay port belongs to this association, so refusing
        // everything else costs nothing and means a stray datagram
        // cannot be delivered to a game as though its server had sent
        // it.
        socket.connect(SocketAddr::V4(relay))?;
        Ok(Self { socket, relay, _control: control })
    }

    /// Bounds how long a read blocks, so a relay thread notices its
    /// flow has been retired.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.socket.set_read_timeout(timeout)
    }

    /// Sends one datagram to `target` through the association.
    ///
    /// The header is rebuilt per datagram rather than cached, because
    /// one UDP flow reaches several peers and the destination is part
    /// of every datagram in SOCKS5 rather than a property of the
    /// association. That is also what lets a game talk to a lobby and
    /// a match server through one of these.
    pub fn send_to(&self, datagram: &[u8], target: SocketAddrV4) -> io::Result<usize> {
        let mut framed = Vec::with_capacity(datagram.len() + 10);
        // RSV RSV FRAG. Fragmentation is not supported by anything
        // worth speaking to and is refused on receipt below.
        framed.extend_from_slice(&[0, 0, 0, ATYP_IPV4]);
        framed.extend_from_slice(&target.ip().octets());
        framed.extend_from_slice(&target.port().to_be_bytes());
        framed.extend_from_slice(datagram);
        let sent = self.socket.send(&framed)?;
        // Reported as the payload the caller handed over, not the
        // framed length. A caller comparing the two would otherwise
        // see a short write on every datagram.
        Ok(sent.saturating_sub(framed.len() - datagram.len()))
    }

    /// Receives one datagram, stripping the SOCKS5 header.
    ///
    /// Returns the peer that sent it, which the caller needs because a
    /// carried UDP flow's replies are rewritten to look as though they
    /// came from the address the application asked for.
    pub fn recv_from(&self, buffer: &mut [u8]) -> io::Result<(usize, SocketAddrV4)> {
        let mut framed = vec![0u8; buffer.len() + 262];
        let len = self.socket.recv(&mut framed)?;
        let framed = &framed[..len];
        if framed.len() < 10 {
            return Err(protocol_error("a datagram arrived too short to hold a header"));
        }
        if framed[2] != 0 {
            // A fragment cannot be reassembled here and passing one on
            // would hand an application half a packet as though it
            // were whole.
            return Err(protocol_error("a fragmented datagram arrived"));
        }
        let (from, header_len) = match framed[3] {
            ATYP_IPV4 => (
                SocketAddrV4::new(
                    Ipv4Addr::new(framed[4], framed[5], framed[6], framed[7]),
                    u16::from_be_bytes([framed[8], framed[9]]),
                ),
                10,
            ),
            ATYP_DOMAIN => {
                let name_len = framed[4] as usize;
                let header_len = 5 + name_len + 2;
                if framed.len() < header_len {
                    return Err(protocol_error("a datagram claims a name longer than itself"));
                }
                // The caller rewrites the return leg from the flow's
                // own record of where the application was dialling, so
                // a name here changes nothing it does.
                (
                    SocketAddrV4::new(
                        LOOPBACK,
                        u16::from_be_bytes([framed[header_len - 2], framed[header_len - 1]]),
                    ),
                    header_len,
                )
            }
            ATYP_IPV6 => {
                if framed.len() < 22 {
                    return Err(protocol_error("a datagram is too short for the address it claims"));
                }
                (SocketAddrV4::new(LOOPBACK, u16::from_be_bytes([framed[20], framed[21]])), 22)
            }
            _ => return Err(protocol_error("a datagram names an address type that does not exist")),
        };
        let payload = &framed[header_len..];
        let copied = payload.len().min(buffer.len());
        buffer[..copied].copy_from_slice(&payload[..copied]);
        Ok((copied, from))
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// A SOCKS5 server that does the handshake and then echoes.
    ///
    /// Deliberately a real socket rather than a mock: the thing worth
    /// testing here is bytes on a wire in the right order, and a mock
    /// of this module's own understanding of the protocol would agree
    /// with it however wrong it was.
    fn fake_server() -> (u16, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind((LOOPBACK, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let tx = tx.clone();
                thread::spawn(move || {
                    let mut greeting = [0u8; 3];
                    if stream.read_exact(&mut greeting).is_err() {
                        return;
                    }
                    let _ = tx.send(greeting.to_vec());
                    if stream.write_all(&[VERSION, AUTH_NONE]).is_err() {
                        return;
                    }
                    let mut head = [0u8; 4];
                    if stream.read_exact(&mut head).is_err() {
                        return;
                    }
                    let mut rest = [0u8; 6];
                    if stream.read_exact(&mut rest).is_err() {
                        return;
                    }
                    let mut request = head.to_vec();
                    request.extend_from_slice(&rest);
                    let _ = tx.send(request);
                    if head[1] == CMD_UDP_ASSOCIATE {
                        // Bind a relay socket and answer with its port.
                        let relay = UdpSocket::bind((LOOPBACK, 0)).unwrap();
                        let relay_port = relay.local_addr().unwrap().port();
                        let mut reply = vec![VERSION, REPLY_SUCCESS, 0, ATYP_IPV4];
                        reply.extend_from_slice(&LOOPBACK.octets());
                        reply.extend_from_slice(&relay_port.to_be_bytes());
                        if stream.write_all(&reply).is_err() {
                            return;
                        }
                        // Echo framed datagrams back verbatim, which is
                        // what a server routing them somewhere and
                        // getting an answer would look like.
                        let mut buffer = [0u8; 2048];
                        while let Ok((len, from)) = relay.recv_from(&mut buffer) {
                            let _ = relay.send_to(&buffer[..len], from);
                        }
                    } else {
                        let mut reply = vec![VERSION, REPLY_SUCCESS, 0, ATYP_IPV4];
                        reply.extend_from_slice(&[127, 0, 0, 1]);
                        reply.extend_from_slice(&0u16.to_be_bytes());
                        if stream.write_all(&reply).is_err() {
                            return;
                        }
                        let mut buffer = [0u8; 1024];
                        while let Ok(len) = stream.read(&mut buffer) {
                            if len == 0 || stream.write_all(&buffer[..len]).is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (port, rx)
    }

    #[test]
    fn the_greeting_offers_exactly_one_method_and_it_is_none() {
        let (port, rx) = fake_server();
        let _stream = connect(port, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443)).unwrap();
        let greeting = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(greeting, vec![VERSION, 1, AUTH_NONE]);
    }

    #[test]
    fn connect_asks_for_the_destination_the_application_wanted() {
        let (port, rx) = fake_server();
        let target = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 27015);
        let _stream = connect(port, target).unwrap();
        let _greeting = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let request = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(request[0], VERSION);
        assert_eq!(request[1], CMD_CONNECT);
        assert_eq!(request[3], ATYP_IPV4);
        assert_eq!(&request[4..8], &[203, 0, 113, 5]);
        assert_eq!(u16::from_be_bytes([request[8], request[9]]), 27015);
    }

    #[test]
    fn a_connected_stream_carries_bytes_both_ways() {
        let (port, _rx) = fake_server();
        let mut stream =
            connect(port, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443)).unwrap();
        stream.write_all(b"hello").unwrap();
        let mut buffer = [0u8; 5];
        stream.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"hello");
    }

    /// A server that wants a password is not the inbound this relay
    /// wrote, and continuing would be talking to something
    /// unidentified on the customer's own machine.
    #[test]
    fn a_server_demanding_authentication_is_refused() {
        let listener = TcpListener::bind((LOOPBACK, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut greeting = [0u8; 3];
                let _ = stream.read_exact(&mut greeting);
                // 2 == username/password.
                let _ = stream.write_all(&[VERSION, 2]);
                thread::sleep(Duration::from_millis(200));
            }
        });
        let error = connect(port, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443))
            .expect_err("an authenticating server must be refused");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_refusal_from_the_exit_is_reported_as_a_refusal() {
        let listener = TcpListener::bind((LOOPBACK, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut greeting = [0u8; 3];
                let _ = stream.read_exact(&mut greeting);
                let _ = stream.write_all(&[VERSION, AUTH_NONE]);
                let mut request = [0u8; 10];
                let _ = stream.read_exact(&mut request);
                let mut reply = vec![VERSION, 4, 0, ATYP_IPV4];
                reply.extend_from_slice(&[0, 0, 0, 0]);
                reply.extend_from_slice(&0u16.to_be_bytes());
                let _ = stream.write_all(&reply);
                thread::sleep(Duration::from_millis(200));
            }
        });
        let error = connect(port, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443))
            .expect_err("a refused destination must not look like a connection");
        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
        assert!(error.to_string().contains("host unreachable"), "{error}");
    }

    #[test]
    fn a_udp_association_carries_a_datagram_and_strips_the_header() {
        let (port, rx) = fake_server();
        let association = UdpAssociation::open(port).unwrap();
        let target = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 27015);
        association.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        association.send_to(b"ping", target).unwrap();

        let mut buffer = [0u8; 64];
        let (len, from) = association.recv_from(&mut buffer).unwrap();
        assert_eq!(&buffer[..len], b"ping", "the header must not reach the application");
        assert_eq!(from, target, "the peer has to survive the round trip");

        let _greeting = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let request = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(request[1], CMD_UDP_ASSOCIATE);
    }

    /// One socket, several peers, which is the ordinary shape of a game
    /// and the thing a per-association destination could not express.
    #[test]
    fn one_association_reaches_several_peers() {
        let (port, _rx) = fake_server();
        let association = UdpAssociation::open(port).unwrap();
        association.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let peers = [
            SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 27015),
            SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 9), 7777),
        ];
        for (i, peer) in peers.iter().enumerate() {
            association.send_to(format!("to{i}").as_bytes(), *peer).unwrap();
            let mut buffer = [0u8; 64];
            let (len, from) = association.recv_from(&mut buffer).unwrap();
            assert_eq!(&buffer[..len], format!("to{i}").as_bytes());
            assert_eq!(from, *peer, "each datagram must report its own peer");
        }
    }

    /// `send_to` reports the payload it was handed, not the framed
    /// length, or every caller comparing the two sees a short write.
    #[test]
    fn a_send_reports_the_payload_length() {
        let (port, _rx) = fake_server();
        let association = UdpAssociation::open(port).unwrap();
        let sent = association
            .send_to(b"0123456789", SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 1))
            .unwrap();
        assert_eq!(sent, 10);
    }

    #[test]
    fn nothing_reaches_a_port_with_no_inbound_on_it() {
        // Bound and dropped, so the port is almost certainly free and
        // is certainly not a SOCKS5 inbound.
        let taken = TcpListener::bind((LOOPBACK, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        drop(taken);
        connect(port, SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 5), 443))
            .expect_err("a dead port must not produce a stream");
        assert!(
            UdpAssociation::open(port).is_err(),
            "a dead port must not produce an association"
        );
    }
}
