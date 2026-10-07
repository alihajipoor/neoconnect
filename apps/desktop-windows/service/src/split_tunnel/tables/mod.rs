//! The machine's connection tables, read one way.
//!
//! `GetExtendedTcpTable` and `GetExtendedUdpTable` hand back raw
//! `MIB_*_OWNER_PID` buffers. This directory reads them through one
//! typed reader -- [`Layout`] and [`Row`] below -- and answers three
//! questions with what it reads: who owns a local port (`owner`), which
//! processes are running a given executable (`process`), and which
//! established connections a session should close or report
//! (`connections`).

mod connections;
mod owner;
mod process;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

pub use connections::{escaped_connections, reset_selected_connections, ResetOutcome};
pub use owner::OwnerLookup;
pub use process::{image_path, pids_running_images, still_running};

/// Local port -> owning process id, for every IPv4 TCP connection.
///
/// Sized by asking first: the table changes between the two calls often
/// enough that a single guess is not safe, which is why the API is
/// documented as a retry loop.
fn tcp_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or valid for `*size` bytes.
        unsafe {
            GetExtendedTcpTable(
                buf,
                size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        }
    })?;
    Some(parse_table(&bytes, Layout::Tcp4))
}

/// Local port -> owning process id, for every IPv4 UDP socket.
fn udp_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;
    Some(parse_table(&bytes, Layout::Udp4))
}

/// Local port -> owning process id, for every IPv6 TCP connection.
///
/// A separate call rather than a parameter on [`tcp_table`] because the
/// row layout differs, not just the family: `MIB_TCP6ROW_OWNER_PID`
/// carries 16-byte addresses and a scope id for each end, so the port
/// and pid sit at different offsets. Passing `AF_INET6` to the IPv4
/// reader would parse address bytes as a port and return a plausible
/// number for the wrong socket -- the same class of mistake the IPv4
/// reader avoids by not casting to the generated struct.
fn tcp6_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or valid for `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    })?;
    Some(parse_table(&bytes, Layout::Tcp6))
}

/// Local port -> owning process id, for every IPv6 UDP socket.
fn udp6_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET6 as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;
    Some(parse_table(&bytes, Layout::Udp6))
}

/// Runs the size-then-fetch dance both table APIs require.
fn query_table<F>(mut call: F) -> Option<Vec<u32>>
where
    F: FnMut(*mut std::ffi::c_void, *mut u32) -> u32,
{
    let mut size: u32 = 0;
    let ret = call(std::ptr::null_mut(), &mut size);
    if ret != ERROR_INSUFFICIENT_BUFFER {
        return None;
    }

    for _ in 0..3 {
        // u32-backed so the buffer is aligned for the DWORD fields read
        // out of it below.
        let mut buffer: Vec<u32> = vec![0; (size as usize).div_ceil(4)];
        let ret = call(buffer.as_mut_ptr() as *mut _, &mut size);
        if ret == NO_ERROR {
            return Some(buffer);
        }
        if ret != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
    }
    None
}

/// The four `MIB_*ROW_OWNER_PID` layouts, and where each field sits in
/// them.
///
/// These rows used to be decoded by hand at six call sites, each with
/// its own row width, its own offsets and its own port byte-swap. The
/// hazard that invites is the one the IPv6 reader's comment names --
/// the wrong layout for a family "would parse address bytes as a port
/// and return a plausible number for the wrong socket" -- and six
/// hand-written decoders are six chances at it. Now each layout is
/// written down once, here, and a caller asks for a field by name.
///
/// Read field by field rather than by casting to the generated structs,
/// whose trailing arrays are declared with length 1 and would make an
/// indexed read into the rest of the table out of bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// `MIB_TCPROW_OWNER_PID`: dwState, dwLocalAddr, dwLocalPort,
    /// dwRemoteAddr, dwRemotePort, dwOwningPid.
    Tcp4,
    /// `MIB_UDPROW_OWNER_PID`: dwLocalAddr, dwLocalPort, dwOwningPid.
    Udp4,
    /// `MIB_TCP6ROW_OWNER_PID`: ucLocalAddr[16], dwLocalScopeId,
    /// dwLocalPort, ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
    /// dwState, dwOwningPid.
    Tcp6,
    /// `MIB_UDP6ROW_OWNER_PID`: ucLocalAddr[16], dwLocalScopeId,
    /// dwLocalPort, dwOwningPid.
    Udp6,
}

impl Layout {
    /// The row's width in 32-bit words.
    const fn words(self) -> usize {
        match self {
            Layout::Tcp4 => 6,
            Layout::Udp4 => 3,
            Layout::Tcp6 => 14,
            Layout::Udp6 => 7,
        }
    }
}

/// One row of a connection table, borrowed from the buffer it arrived in.
#[derive(Clone, Copy)]
struct Row<'a> {
    layout: Layout,
    /// Exactly `layout.words()` long -- `rows` hands out nothing shorter.
    fields: &'a [u32],
}

/// A port as these tables store it: network byte order in the low half
/// of a DWORD, so its bytes come out swapped on a little-endian host.
/// Getting it wrong yields a plausible port rather than an obvious
/// failure, which is why it is done here and nowhere else.
fn table_port(word: u32) -> u16 {
    (word as u16).swap_bytes()
}

impl Row<'_> {
    fn local_port(&self) -> u16 {
        table_port(match self.layout {
            Layout::Tcp4 => self.fields[2],
            Layout::Udp4 => self.fields[1],
            Layout::Tcp6 | Layout::Udp6 => self.fields[5],
        })
    }

    fn pid(&self) -> u32 {
        // Last in every layout.
        self.fields[self.layout.words() - 1]
    }

    /// The connection state. UDP has none.
    fn state(&self) -> Option<u32> {
        match self.layout {
            Layout::Tcp4 => Some(self.fields[0]),
            Layout::Tcp6 => Some(self.fields[12]),
            Layout::Udp4 | Layout::Udp6 => None,
        }
    }

    /// The far end. UDP has none.
    ///
    /// An address is already a network-order byte sequence, so a DWORD's
    /// own bytes are its octets in order -- unlike a port.
    fn remote(&self) -> Option<(IpAddr, u16)> {
        match self.layout {
            Layout::Tcp4 => Some((
                IpAddr::V4(Ipv4Addr::from(self.fields[3].to_ne_bytes())),
                table_port(self.fields[4]),
            )),
            Layout::Tcp6 => {
                let mut octets = [0u8; 16];
                for (i, word) in self.fields[6..10].iter().enumerate() {
                    octets[i * 4..i * 4 + 4].copy_from_slice(&word.to_ne_bytes());
                }
                Some((IpAddr::V6(Ipv6Addr::from(octets)), table_port(self.fields[11])))
            }
            Layout::Udp4 | Layout::Udp6 => None,
        }
    }
}

/// The rows of a raw `MIB_*TABLE_OWNER_PID` buffer: a u32 count, then
/// that many rows.
///
/// The count is what the API reported and the buffer is what actually
/// arrived, so iteration stops at the first row the buffer does not hold
/// in full. Trusting the count would read past the end, in a service
/// running as LocalSystem.
fn rows(words: &[u32], layout: Layout) -> impl Iterator<Item = Row<'_>> {
    let count = words.first().copied().unwrap_or(0) as usize;
    let width = layout.words();
    (0..count)
        .map_while(move |row| words.get(1 + row * width..1 + (row + 1) * width))
        .map(move |fields| Row { layout, fields })
}

/// Turns a raw `MIB_*TABLE_OWNER_PID` buffer into a port -> pid map.
fn parse_table(words: &[u32], layout: Layout) -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    for row in rows(words, layout) {
        let (port, pid) = (row.local_port(), row.pid());
        // Several rows can share a local port, and keyed on the port
        // alone the last one used to win. The common case is TIME_WAIT:
        // Windows lists those rows with owner pid 0, and a busy port
        // routinely has dozens of them beside the one live socket that
        // owns it -- measured on a development machine, one listener
        // and forty-odd TIME_WAIT rows on the same port. Whichever came
        // last decided, and pid 0 has no image, so the live owner read
        // as nobody. For a SYN under OnlySelected that is a connection
        // left outside the tunnel for its whole life.
        //
        // So a row with no owner never replaces one with an owner. Two
        // *different* live owners on one port remain ambiguous by port
        // alone -- telling them apart needs the local address, which
        // the callers do not pass yet -- and keep the old rule.
        if pid == 0 && map.get(&port).is_some_and(|&known| known != 0) {
            continue;
        }
        map.insert(port, pid);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_rows_are_read_at_the_right_offsets() {
        // Two UDP rows: {localAddr, localPort, pid}. The port is stored
        // network-order in the low half of its DWORD, which is the
        // detail worth a test -- getting it wrong yields plausible
        // nonsense (port 4416 for 4113) rather than an obvious failure.
        let words = vec![
            2, // dwNumEntries
            0x0100_007F,
            0x1110_u32.swap_bytes() >> 16,
            4242,
            0x0000_0000,
            0x0050_u32.swap_bytes() >> 16,
            777,
        ];
        let map = parse_table(&words, Layout::Udp4);
        assert_eq!(map.get(&0x1110), Some(&4242));
        assert_eq!(map.get(&80), Some(&777));
    }

    /// A TIME_WAIT row is owned by pid 0, and a busy port carries many
    /// of them next to its one live socket. Whichever row came last used
    /// to decide -- so the order of the table, not the owner, chose
    /// whether the port had one.
    #[test]
    fn a_row_with_no_owner_does_not_hide_the_live_one_on_its_port() {
        let port = |p: u32| p.swap_bytes() >> 16;
        let words = vec![
            4, // dwNumEntries
            0x0100_007F, port(49303), 0,    // TIME_WAIT before the owner
            0x0100_007F, port(49303), 2688, // the live socket
            0x0100_007F, port(49303), 0,    // TIME_WAIT after it
            0x0100_007F, port(50000), 0,    // a port with nothing but TIME_WAIT
        ];
        let map = parse_table(&words, Layout::Udp4);
        assert_eq!(map.get(&49303), Some(&2688), "the live owner must survive rows on either side");
        // Nothing better is known, so the zero stands: it resolves to no
        // image, which is the honest answer for a port nobody holds.
        assert_eq!(map.get(&50000), Some(&0));
    }

    /// Both TCP layouts, field by field. The IPv6 row is the one the old
    /// comment warned about: read with the IPv4 offsets it produces a
    /// plausible port from address bytes, so every field is checked
    /// against a value that could not have come from anywhere else.
    #[test]
    fn each_tcp_layout_is_read_at_its_own_offsets() {
        let port = |p: u32| p.swap_bytes() >> 16;
        let v4 = vec![
            1, // dwNumEntries
            5, // dwState: ESTABLISHED
            u32::from_ne_bytes([127, 0, 0, 1]),
            port(50123),
            u32::from_ne_bytes([203, 0, 113, 9]),
            port(443),
            4242,
        ];
        let row = rows(&v4, Layout::Tcp4).next().expect("one row");
        assert_eq!(row.state(), Some(5));
        assert_eq!(row.local_port(), 50123);
        assert_eq!(row.remote(), Some((IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9)), 443)));
        assert_eq!(row.pid(), 4242);

        let remote: Ipv6Addr = "2001:db8::1:2".parse().unwrap();
        let o = remote.octets();
        let word = |i: usize| u32::from_ne_bytes([o[i], o[i + 1], o[i + 2], o[i + 3]]);
        let v6 = vec![
            1, // dwNumEntries
            0xAAAA_AAAA, 0xAAAA_AAAA, 0xAAAA_AAAA, 0xAAAA_AAAA, // ucLocalAddr
            7,           // dwLocalScopeId
            port(50124), // dwLocalPort
            word(0), word(4), word(8), word(12), // ucRemoteAddr
            9,           // dwRemoteScopeId
            port(8443),  // dwRemotePort
            2,           // dwState: SYN_SENT
            31337,       // dwOwningPid
        ];
        let row = rows(&v6, Layout::Tcp6).next().expect("one row");
        assert_eq!(row.state(), Some(2));
        assert_eq!(row.local_port(), 50124);
        assert_eq!(row.remote(), Some((IpAddr::V6(remote), 8443)));
        assert_eq!(row.pid(), 31337);

        // A UDP row has neither, and saying so is the answer rather
        // than a zero that reads as a real state or a real address.
        let udp = vec![1, 0, port(53), 99];
        let row = rows(&udp, Layout::Udp4).next().expect("one row");
        assert_eq!((row.state(), row.remote(), row.local_port(), row.pid()), (None, None, 53, 99));
    }

    #[test]
    fn a_truncated_table_does_not_panic() {
        // The count is what the API reported; the buffer is what
        // actually arrived. Trusting the former over the latter would
        // read past the end, in a service running as LocalSystem.
        let words = vec![10, 0, 1, 2];
        let map = parse_table(&words, Layout::Udp4);
        assert_eq!(map.len(), 1);
    }
}
