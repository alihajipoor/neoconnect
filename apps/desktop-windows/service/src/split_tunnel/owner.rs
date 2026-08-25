//! Which application owns a local port.
//!
//! This is the question Custom mode exists to answer: a packet on the
//! wire carries no hint of the program that produced it, so redirecting
//! "only this game" means mapping the packet's source port back to a
//! process and then to an executable on disk.
//!
//! # Why the connection tables and not WinDivert's FLOW layer
//!
//! The spike proved the FLOW layer attributes reliably -- 224 flows, not
//! one unattributable, TCP and UDP alike. It was still the wrong choice
//! here, for a reason the spike could not show: FLOW events are
//! delivered on their own schedule relative to the NETWORK layer, so a
//! TCP SYN can reach the redirect loop before the event announcing the
//! flow it belongs to. The consequence is not a dropped packet, it is a
//! selected app's connection quietly going out unprotected while the UI
//! says Custom mode is on -- the same class of dishonesty as a false
//! "Connected".
//!
//! `GetExtendedTcpTable`/`GetExtendedUdpTable` have no such race. The
//! socket appears in the table when it is created, before anything is
//! sent, so a lookup at the moment the first packet arrives is
//! answerable -- *provided the socket is still open when it is made*.
//! The cost is a table walk, which is why the result is cached and the
//! refresh rate-limited below.
//!
//! That proviso used to read "always answerable", and it was measured
//! wrong. A socket closed immediately after its send is out of the
//! table before the redirect loop is handed the datagram, and no
//! rebuild can recover a row that no longer exists. That is not a race
//! this file can win by asking harder, and it is why
//! [`Selection::verdict_for_unattributed`] exists: the question moves
//! from "who owns this port" -- unanswerable -- to "what is the safe
//! thing to do when nobody does".

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::windows::ffi::OsStrExt;
use std::sync::{Arc, RwLock};

use neoconnect_ipc::SplitTunnelMode;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, HWND, NO_ERROR,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    GW_OWNER,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, SetTcpEntry, TCP_TABLE_OWNER_PID_ALL,
    UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// How long a table snapshot is trusted before being rebuilt.
///
/// Short enough that a port belonging to a process started moments ago
/// is found on the next attempt, long enough that a burst of new
/// connections does not turn into a burst of table walks.
const SNAPSHOT_TTL: Duration = Duration::from_millis(200);

/// The floor on how often a miss may force an early rebuild.
///
/// Without it, traffic to ports that genuinely have no owner -- and
/// there is always some -- would rebuild the table on every packet.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_millis(20);

/// The transport a port belongs to. Ports are per-protocol, so TCP 4000
/// and UDP 4000 are different sockets owned by possibly different apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Transport {
    Tcp,
    Udp,
}

/// Which address family a local port was opened in.
///
/// Kept apart rather than merged into one port -> pid map, even though
/// merging would be less code. Windows draws IPv4 and IPv6 ephemeral
/// ports from ranges that overlap, so TCP 51234 can be one process over
/// IPv4 and a different one over IPv6 at the same moment. A merged map
/// answers one of those two questions wrongly, and both wrong answers
/// are bad in the direction this feature cares about: attributing an
/// IPv6 flow to a selected app that does not own it stops traffic the
/// customer never asked to stop, and missing one leaves the leak open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    V4,
    V6,
}

/// The applications the customer chose to route through the tunnel.
///
/// Held as full paths, lowercased once at construction so matching is a
/// plain comparison rather than a case-insensitive scan per packet.
/// Paths, never process ids: the spike watched `chrome.exe` appear under
/// two different pids inside twenty seconds, and a customer who picks an
/// app means every process from that image, including ones that do not
/// exist yet.
/// A selection the redirect loop can be handed once and still see
/// later edits through.
///
/// The lock is read on every packet and written only when the customer
/// changes their choice, which is why it is an `RwLock`: the readers are
/// the hot path and they do not contend with each other.
pub type SharedSelection = Arc<RwLock<Selection>>;

#[derive(Debug, Default, Clone)]
pub struct Selection {
    paths: Vec<String>,
    /// Which way the list reads. Held here because `matches` is the hot
    /// path and the answer must not depend on a second lookup somewhere
    /// else that could disagree with it.
    mode: SplitTunnelMode,
}

impl Selection {
    pub fn new<I: IntoIterator<Item = String>>(paths: I, mode: SplitTunnelMode) -> Self {
        Self { paths: paths.into_iter().map(|p| p.to_lowercase()).collect(), mode }
    }

    pub fn mode(&self) -> SplitTunnelMode {
        self.mode
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// Whether an executable path is one the customer selected.
    pub fn matches(&self, image_path: &str) -> bool {
        let lowered = image_path.to_lowercase();
        self.paths.iter().any(|p| *p == lowered)
    }

    /// Whether this application's traffic belongs in the tunnel.
    ///
    /// The direction is applied here rather than to the tunnel's shape,
    /// and that is deliberate. Building a *full* tunnel and pushing the
    /// chosen applications out of it is the obvious reading of
    /// "everything except these", and it does not work: a packet
    /// captured on the tunnel adapter and re-injected towards this
    /// machine is sent down the tunnel instead of to the proxy, and
    /// arrives nowhere. Measured, four retransmits, no reply and no
    /// drop:
    ///
    /// ```text
    /// ip: 10.77.0.3.40001 > 192.168.88.10.64129: Flags [S]
    /// ```
    ///
    /// Keeping the tunnel passive in both directions and inverting the
    /// *match* instead means every packet that is carried takes the one
    /// path already known to work. What the customer asked for is the
    /// same either way: with `AllExcept` everything is lifted into the
    /// tunnel except the applications they named, which are simply
    /// never redirected and so keep the ordinary connection.
    pub fn should_tunnel(&self, image_path: &str) -> bool {
        match self.mode {
            SplitTunnelMode::OnlySelected => self.matches(image_path),
            SplitTunnelMode::AllExcept => !self.matches(image_path),
        }
    }

    /// What to do with traffic whose owning program cannot be seen.
    ///
    /// Opposite answers for opposite directions, and both are the safe
    /// one. Tunnelling only named applications means an unknown owner is
    /// left alone, because redirecting traffic whose origin is unknown
    /// is how a split tunnel becomes a full one. Tunnelling everything
    /// *except* named applications means an unknown owner is carried,
    /// because leaving it out is how it becomes a leak.
    ///
    /// **This is no longer the whole answer for a datagram**, and
    /// callers deciding about one must use
    /// [`Self::verdict_for_unattributed`] instead. It survives because
    /// two callers really do only need the boolean: the IPv6 packet
    /// whose ports could not be read at all, which has no transport to
    /// key a finer rule on, and this function's own place inside that
    /// finer rule.
    pub fn tunnel_when_owner_unknown(&self) -> bool {
        matches!(self.mode, SplitTunnelMode::AllExcept)
    }

    /// What to do with a packet nobody can be shown to have sent.
    ///
    /// # Why "leave it alone" was not safe enough
    ///
    /// [`Self::tunnel_when_owner_unknown`] answers this in `AllExcept`
    /// and gets it right: carry it, because leaving it out is the leak.
    /// In `OnlySelected` it answers "leave it alone", on the reasoning
    /// that redirecting traffic of unknown origin turns a split tunnel
    /// into a full one. That reasoning is sound and the outcome was
    /// still a leak, because of one shape it did not account for.
    ///
    /// A UDP socket that is closed microseconds after its send is
    /// already out of the Windows UDP endpoint table by the time the
    /// redirect loop is handed the datagram. There is no row naming the
    /// owner and no rebuild can produce one -- the fact is gone, not
    /// late. So a *selected* application's datagram arrives with no
    /// owner, is answered "leave it alone", and egresses in clear text
    /// carrying the customer's real address while the app says Custom
    /// mode is on.
    ///
    /// Measured on the rig, twice: a selected program sending 15
    /// datagrams from 15 sockets, each closed microseconds after the
    /// send, put 13 and 14 of them respectively on the wire
    /// unredirected. Reproducible, and not a race retrying wins.
    ///
    /// # Why refusing, and not carrying
    ///
    /// Carrying it would send a non-selected application's traffic out
    /// of the node -- the customer asked for the opposite, and for
    /// someone whose account is judged by the address it connects from,
    /// silently moving their traffic onto a VPN address is its own kind
    /// of harm. Refusing is the same answer this feature already gives
    /// IPv6 and already gives a lookup it cannot carry: a stated gap in
    /// place of a silent leak. A one-shot datagram that does not arrive
    /// is visible, complainable-about and recoverable. Being logged by
    /// an ISP in Iran is none of those.
    ///
    /// # Why this does not take the customer's internet down
    ///
    /// The refusal is deliberately the narrowest thing that closes the
    /// hole, and every clause below is a clause that keeps ordinary
    /// traffic working:
    ///
    /// * **`AllExcept` is untouched.** It carries an unknown owner, has
    ///   no leak of this shape, and nothing here changes it.
    /// * **TCP is untouched.** A TCP socket cannot be gone before its
    ///   SYN is classified -- it has to stay open to receive the
    ///   handshake -- so this shape is UDP-only, and TCP keeps failing
    ///   open exactly as before.
    /// * **Only destinations that are the internet.** Loopback, RFC1918,
    ///   link-local, multicast and broadcast are the local network. A
    ///   datagram to one of them is not a privacy leak, and refusing it
    ///   would break mDNS, LLMNR, SSDP, WS-Discovery and DHCP -- one-shot
    ///   senders every one of them, which is precisely the shape that
    ///   would be caught.
    /// * **Only an owner that could not be found at all.** A live socket
    ///   is in the table from the moment it is created, so anything
    ///   still holding its socket -- which is every QUIC client, every
    ///   game, every long-running connection -- is attributed and
    ///   decided on its merits. Chrome went from 219 plaintext UDP/443
    ///   datagrams to 0 under the existing code precisely because a real
    ///   QUIC client holds its socket open; none of that reaches here.
    ///
    /// What is left, and it is the honest cost of this change, is a
    /// non-selected application's *one-shot* UDP to the internet, which
    /// is refused while Custom mode is on. That is a real behavioural
    /// change and it is deliberate: the alternative is that the same
    /// datagram from a selected application leaves in the clear, and
    /// this loop cannot tell the two apart. The feature fails open
    /// everywhere else; here it fails closed, because failing open here
    /// is the leak itself.
    ///
    /// Callers pass the destination rather than having it reached for,
    /// so the rule can be tested without a packet and so the WinDivert
    /// filter -- which excludes the same addresses in the kernel -- and
    /// this cannot drift apart into disagreeing about one destination.
    pub fn verdict_for_unattributed(
        &self,
        transport: Transport,
        destination: IpAddr,
    ) -> Unattributed {
        if self.tunnel_when_owner_unknown() {
            return Unattributed::Carry;
        }
        let is_internet = match destination {
            IpAddr::V4(addr) => is_public_v4(addr),
            IpAddr::V6(addr) => is_public_v6(addr),
        };
        if matches!(transport, Transport::Udp) && is_internet {
            Unattributed::Refuse
        } else {
            Unattributed::LeaveAlone
        }
    }
}

/// What to do with a packet whose owning program cannot be seen.
///
/// Three answers rather than the boolean this used to be, because the
/// two the boolean could express were both wrong for one case -- see
/// [`Selection::verdict_for_unattributed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unattributed {
    /// Put it in the tunnel. `AllExcept`, where an unknown owner is one
    /// of the many rather than one of the few.
    Carry,
    /// Send it out untouched, as before.
    LeaveAlone,
    /// Swallow it. The only answer that is neither of the two the
    /// redirect loop can otherwise give, and the one that closes the
    /// fire-and-forget leak.
    Refuse,
}

/// Caches the two connection tables and the image path of each process
/// seen in them.
pub struct OwnerLookup {
    tcp: HashMap<u16, u32>,
    udp: HashMap<u16, u32>,
    /// The same two tables for IPv6. Queried on every rebuild rather
    /// than only when an IPv6 packet turns up: the rebuild is what the
    /// 200ms snapshot budget is spent on, and a second pair of table
    /// walks there is far cheaper than discovering mid-packet that the
    /// snapshot cannot answer and having to walk again.
    tcp6: HashMap<u16, u32>,
    udp6: HashMap<u16, u32>,
    built_at: Instant,
    last_refresh: Instant,
    /// Only successful resolutions live here -- see image_for_port.
    images: HashMap<u32, String>,
}

impl OwnerLookup {
    pub fn new() -> Self {
        // Far enough in the past that the first lookup builds rather
        // than trusting an empty snapshot.
        let stale = Instant::now() - SNAPSHOT_TTL * 2;
        Self {
            tcp: HashMap::new(),
            udp: HashMap::new(),
            tcp6: HashMap::new(),
            udp6: HashMap::new(),
            built_at: stale,
            last_refresh: stale,
            images: HashMap::new(),
        }
    }

    /// The executable behind a local port, or `None` if the port has no
    /// owner this can see.
    ///
    /// A miss triggers at most one rebuild, then answers from the fresh
    /// snapshot -- so a socket created microseconds ago is still found,
    /// without a hot loop for ports that will never be found.
    pub fn image_for_port(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.built_at.elapsed() > SNAPSHOT_TTL {
            self.rebuild();
        }
        let mut pid = self.pid_for(family, transport, port);
        if pid.is_none() && self.last_refresh.elapsed() > MIN_REFRESH_INTERVAL {
            self.rebuild();
            pid = self.pid_for(family, transport, port);
        }
        let pid = pid?;

        // Resolved once per process rather than per connection: an
        // image path cannot change while a process lives, and a busy
        // browser opens far more connections than processes.
        //
        // Only *successful* lookups are cached, and that is the whole
        // point. Caching a failure was a real bug: `OpenProcess` can
        // fail transiently, the entry then survives for as long as the
        // process is in the connection table, and every later
        // connection from it resolves to "unknown" and is left
        // untunnelled. Reported exactly that way -- Chrome quietly
        // stopped using the VPN and only came back after restarting
        // it, because restarting is what finally retired the poisoned
        // process id.
        if !self.images.contains_key(&pid) {
            if let Some(path) = image_path(pid) {
                self.images.insert(pid, path);
            }
        }
        self.images.get(&pid).map(String::as_str)
    }

    /// The same answer as [`Self::image_for_port`], for a port that is
    /// opening a connection right now, where a miss is not allowed to
    /// stand on a snapshot taken moments ago.
    ///
    /// The rate limit above exists so that ports which genuinely have no
    /// owner cannot turn every packet into a table walk. That is right
    /// for the general case and wrong for a TCP SYN, because of what a
    /// miss costs: with `OnlySelected` an unknown owner means "leave it
    /// alone", the SYN goes out unredirected, **and the far end answers
    /// it**. The connection is then established outside the tunnel for
    /// good -- there is no retransmit to have a second go at, and a
    /// browser keeps that socket alive and reuses it for minutes.
    ///
    /// Measured on this machine with Custom mode on and Edge selected: a
    /// page opened six seconds after the redirect started reported the
    /// customer's own address, over a socket created after the switch,
    /// while sibling connections made in the same second went through
    /// the tunnel. That is what the rate limit buys, and it is not worth
    /// it: a SYN is a small share of packets and each one costs at most
    /// one extra walk.
    pub fn image_for_new_connection(
        &mut self,
        family: Family,
        transport: Transport,
        port: u16,
    ) -> Option<&str> {
        if self.pid_for(family, transport, port).is_none() {
            self.rebuild();
        }
        self.image_for_port(family, transport, port)
    }

    fn pid_for(&self, family: Family, transport: Transport, port: u16) -> Option<u32> {
        match (family, transport) {
            (Family::V4, Transport::Tcp) => self.tcp.get(&port).copied(),
            (Family::V4, Transport::Udp) => self.udp.get(&port).copied(),
            (Family::V6, Transport::Tcp) => self.tcp6.get(&port).copied(),
            (Family::V6, Transport::Udp) => self.udp6.get(&port).copied(),
        }
    }

    fn rebuild(&mut self) {
        if let Some(table) = tcp_table() {
            self.tcp = table;
        }
        if let Some(table) = udp_table() {
            self.udp = table;
        }
        if let Some(table) = tcp6_table() {
            self.tcp6 = table;
        }
        if let Some(table) = udp6_table() {
            self.udp6 = table;
        }
        let now = Instant::now();
        self.built_at = now;
        self.last_refresh = now;

        // Processes that have gone are dropped rather than accumulating
        // for the life of the connection. Windows reuses process ids, so
        // a stale entry is not merely wasted memory -- it would answer
        // for whatever took the id next.
        let live: std::collections::HashSet<u32> = self
            .tcp
            .values()
            .chain(self.udp.values())
            .chain(self.tcp6.values())
            .chain(self.udp6.values())
            .copied()
            .collect();
        self.images.retain(|pid, _| live.contains(pid));
    }
}

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

    // MIB_TCPTABLE_OWNER_PID: a u32 count followed by that many
    // 6 x u32 rows. Read field by field rather than by casting to the
    // generated struct, whose trailing array is declared with length 1
    // and would make an indexed read into the rest of the table
    // out of bounds.
    const ROW_WORDS: usize = 6;
    const LOCAL_PORT: usize = 2;
    const OWNING_PID: usize = 5;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Local port -> owning process id, for every IPv4 UDP socket.
fn udp_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;

    // MIB_UDPTABLE_OWNER_PID rows are {dwLocalAddr, dwLocalPort, dwOwningPid}.
    const ROW_WORDS: usize = 3;
    const LOCAL_PORT: usize = 1;
    const OWNING_PID: usize = 2;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
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

    // MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
    // dwState, dwOwningPid -- fourteen 32-bit words in all.
    const ROW_WORDS: usize = 14;
    const LOCAL_PORT: usize = 5;
    const OWNING_PID: usize = 13;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
}

/// Local port -> owning process id, for every IPv6 UDP socket.
fn udp6_table() -> Option<HashMap<u16, u32>> {
    let bytes = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedUdpTable(buf, size, 0, AF_INET6 as u32, UDP_TABLE_OWNER_PID, 0) }
    })?;

    // MIB_UDP6ROW_OWNER_PID rows are {ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, dwOwningPid}.
    const ROW_WORDS: usize = 7;
    const LOCAL_PORT: usize = 5;
    const OWNING_PID: usize = 6;
    Some(parse_table(&bytes, ROW_WORDS, LOCAL_PORT, OWNING_PID))
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

/// Turns a raw `MIB_*TABLE_OWNER_PID` buffer into a port -> pid map.
fn parse_table(
    words: &[u32],
    row_words: usize,
    port_offset: usize,
    pid_offset: usize,
) -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    let Some(&count) = words.first() else {
        return map;
    };

    for row in 0..count as usize {
        let base = 1 + row * row_words;
        let Some(&raw_port) = words.get(base + port_offset) else {
            break;
        };
        let Some(&pid) = words.get(base + pid_offset) else {
            break;
        };
        // dwLocalPort holds the port in network byte order in its low
        // half, so the bytes come out swapped on a little-endian host.
        map.insert((raw_port as u16).swap_bytes(), pid);
    }
    map
}

/// The full path of a running process's executable.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than the fuller access
/// right on purpose: it is the least this needs, and it is the one that
/// works against protected processes, which some anti-cheat-guarded
/// games are.
/// The applications running right now, for the picker to offer.
///
/// Deduplicated by path, because a modern application is many processes
/// and a list with chrome.exe in it eleven times is not a list. Sorted
/// by name so the order does not shuffle between refreshes.
///
/// Filtered to what a person would recognise as a program: anything
/// under the Windows system directories is the operating system going
/// about its business, and offering it invites a customer to route
/// their own machinery through a VPN. The path is what a selection is
/// actually made of -- see `Selection` -- so the path is returned, with
/// the file name alongside only for display.
/// The applications a customer would actually recognise, grouped one
/// entry per product.
///
/// Two things decide what appears here, and the previous version had
/// neither. It listed every process whose image was not under System32,
/// which is a definition of "not a Windows binary" rather than of "an
/// app" -- so background helpers, update services and telemetry hosts
/// filled the list -- and it listed each executable separately, so one
/// product appeared two or three times under names nobody recognises.
///
/// A **visible window with a title** is what a person means by "an app
/// that is open". Everything without one is exactly the noise being
/// complained about.
///
/// Grouping is by the product name recorded in the executable itself,
/// falling back to the install directory when there is none. That is
/// what puts `Discord.exe` and `Update.exe` under a single "Discord".
pub fn running_apps() -> Vec<neoconnect_ipc::RunningApp> {
    let mut by_product: HashMap<String, (String, Vec<String>, Vec<u32>)> = HashMap::new();

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return Vec::new();
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set, and
    // setting it is what the API uses to version the struct.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if let Some(path) = image_path(pid) {
            if is_user_application(&path) {
                let (key, label) = product_of(&path);
                let slot = by_product
                    .entry(key)
                    .or_insert_with(|| (label, Vec::new(), Vec::new()));
                let lowered = path.to_lowercase();
                if !slot.1.iter().any(|p| p.to_lowercase() == lowered) {
                    slot.1.push(path);
                }
                slot.2.push(pid);
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };

    // Every sibling goes with the group, so choosing one product routes
    // all of it -- but siblings that are not running are unknown here,
    // which is why the group is built from what the product is rather
    // than from what happens to be on screen.
    let mut apps: Vec<neoconnect_ipc::RunningApp> = by_product
        .into_values()
        .filter_map(|(name, mut paths, pids)| {
            paths.sort();
            // The executable a person associates with the product, not
            // whichever sorts first. Microsoft Edge ships an
            // `elevation_service.exe` that sorts before `msedge.exe`,
            // and taking the first put a service's icon and path under
            // the name "Microsoft Edge".
            //
            // The closest match to the product's own name wins: it is
            // what publishers name their main binary after, and the one
            // whose icon is the product's.
            let path = pick_primary(&name, &paths)?;
            // Taken from the executable shown, which is the one whose
            // icon a person associates with the product.
            let icon = super::icon::icon_png_base64(&path);
            Some(neoconnect_ipc::RunningApp { path, name, paths, icon, pids })
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

/// The executable that best represents a product.
///
/// Scored rather than guessed: an exact stem match first, then one that
/// contains the product's letters, then the shortest name -- helpers are
/// almost always the longer, more qualified ones
/// (`elevation_service`, `crashpad_handler`, `Update`).
fn pick_primary(product: &str, paths: &[String]) -> Option<String> {
    let wanted: String = product
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    paths
        .iter()
        .min_by_key(|path| {
            let stem: String = std::path::Path::new(path.as_str())
                .file_stem()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let rank = if stem == wanted {
                0
            } else if !wanted.is_empty() && (wanted.contains(&stem) || stem.contains(&wanted)) {
                1
            } else {
                2
            };
            (rank, stem.len())
        })
        .cloned()
}

/// Process ids that own a visible, titled, top-level window.
///
/// The closest thing Windows offers to "this is an application the
/// person can see". Owned windows and tool windows are skipped: a
/// splash screen or a tray tooltip is not an app someone chose to open.
fn pids_with_windows() -> std::collections::HashSet<u32> {
    let mut set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // SAFETY: `set` outlives the enumeration, which is synchronous, and
    // the callback only ever touches it through this pointer.
    unsafe {
        EnumWindows(Some(collect_window_pid), &mut set as *mut _ as isize);
    }
    set
}

unsafe extern "system" fn collect_window_pid(window: HWND, param: isize) -> i32 {
    // SAFETY: the pointer is the &mut HashSet handed to EnumWindows.
    let set = unsafe { &mut *(param as *mut std::collections::HashSet<u32>) };

    // SAFETY: `window` is supplied by the enumeration and valid here.
    unsafe {
        if IsWindowVisible(window) == 0 || GetWindowTextLengthW(window) == 0 {
            return 1;
        }
        // A window owned by another one is a dialog or a splash, not the
        // application itself.
        if !GetWindow(window, GW_OWNER).is_null() {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid != 0 {
            set.insert(pid);
        }
    }
    1
}

/// A grouping key and a display name for whatever product owns this
/// executable.
///
/// The product name inside the binary is the only thing that reliably
/// ties several executables together -- file names do not (`Update.exe`
/// is a dozen different products) and neither do directories, since a
/// launcher and the program it launches often sit in different folders
/// under one install root.
fn product_of(path: &str) -> (String, String) {
    // The friendly name first: "Notepad" rather than "Microsoft(R)
    // Windows(R) Operating System", which is what ProductName says for
    // every accessory Windows ships.
    let description = version_string(path, "FileDescription");

    if let Some(product) = product_name(path) {
        let trimmed = product.trim();
        // Some publishers put the platform in ProductName rather than
        // the program, and Microsoft puts it on everything from Notepad
        // to Explorer. Grouping on that collapses a dozen unrelated
        // accessories into one entry -- measured here as a single
        // "Windows Operating System" holding nine executables, which a
        // customer selecting it would have tunnelled all of.
        //
        // Those are not one product to anybody using them, so they are
        // kept apart and named individually.
        if !trimmed.is_empty() && !is_platform_product(trimmed) {
            let label = description.unwrap_or_else(|| trimmed.to_string());
            return (trimmed.to_lowercase(), label);
        }
        if !trimmed.is_empty() {
            let label = description.unwrap_or_else(|| file_label(path));
            // Keyed by the executable, so each accessory stands alone.
            return (path.to_lowercase(), label);
        }
    }
    if let Some(label) = description {
        return (path.to_lowercase(), label);
    }
    // No version block: fall back to the folder, which at least keeps
    // one program's pieces together, and show the file name.
    let file = std::path::Path::new(path);
    let label = file
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let key = file
        .parent()
        .map(|d| d.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| label.to_lowercase());
    (key, label)
}

/// Whether this names the platform rather than the program.
///
/// Windows stamps one ProductName across everything it ships, so it is
/// a grouping key that means "made by the OS" rather than "the same
/// application".
fn is_platform_product(product: &str) -> bool {
    let lowered = product.to_lowercase();
    lowered.contains("operating system") || lowered == "microsoft windows"
}

/// The last path segment without its extension, for a display name of
/// last resort.
fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// `ProductName` from the executable's version resource.
fn product_name(path: &str) -> Option<String> {
    version_string(path, "ProductName")
}

/// One named string from an executable's version resource.
fn version_string(path: &str, field: &str) -> Option<String> {
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a valid null-terminated wide string.
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: the buffer is `size` bytes, which is what the call asked
    // for above.
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr() as *mut _) } == 0 {
        return None;
    }

    // The translation table says which language block the strings are
    // in. Assuming one is how this returns nothing for half the
    // machines it runs on.
    let mut lang_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut lang_len: u32 = 0;
    let translation: Vec<u16> = std::ffi::OsStr::new("\\VarFileInfo\\Translation")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: buffer came from GetFileVersionInfoW; the out params are
    // owned here.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            translation.as_ptr(),
            &mut lang_ptr,
            &mut lang_len,
        )
    };
    if ok == 0 || lang_ptr.is_null() || lang_len < 4 {
        return None;
    }
    // SAFETY: the block is at least one 4-byte language/codepage pair.
    let (language, codepage) = unsafe {
        let pair = lang_ptr as *const u16;
        (*pair, *pair.add(1))
    };

    let query = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\{field}");
    let query: Vec<u16> = std::ffi::OsStr::new(&query)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut value: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut chars: u32 = 0;
    // SAFETY: as above.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            query.as_ptr(),
            &mut value,
            &mut chars,
        )
    };
    if ok == 0 || value.is_null() || chars == 0 {
        return None;
    }
    // SAFETY: `chars` UTF-16 units, trailing null included.
    let text = unsafe { std::slice::from_raw_parts(value as *const u16, chars as usize) };
    let text = String::from_utf16_lossy(text);
    Some(text.trim_end_matches('\0').to_string())
}

/// Whether this is a program a customer would recognise, rather than a
/// part of Windows.
fn is_user_application(path: &str) -> bool {
    let lowered = path.to_lowercase();
    if !lowered.ends_with(".exe") {
        return false;
    }
    // Excluded rather than merely sorted last: a customer who routes
    // svchost through a VPN has not made a choice, they have made a
    // mistake, and an offered list is where that starts.
    const SYSTEM: [&str; 4] = [
        r"\windows\system32\",
        r"\windows\syswow64\",
        r"\windows\winsxs\",
        r"\windows\servicing\",
    ];
    if SYSTEM.iter().any(|dir| lowered.contains(dir)) {
        return false;
    }

    // Traps rather than choices, and each one was really offered.
    //
    // `msedgewebview2.exe` is this application's own window: Tauri runs
    // on WebView2, so it is always in the list, and it sits one letter
    // away from the browser somebody actually means. A tester picked
    // from this list, opened Edge, and reported that Custom mode did
    // nothing -- correctly, because Edge was never what got selected.
    // Edge itself is absent unless it happens to be running, which is
    // what makes the near-miss so easy.
    //
    // The other two are the app and the service. Routing the client
    // that manages the tunnel through its own tunnel is not a setting
    // anybody wants, and the redirect excludes the service anyway --
    // so offering them can only mislead.
    const NEVER_OFFER: [&str; 3] = [
        "msedgewebview2.exe",
        "neoconnect-desktop.exe",
        "neoconnect-service.exe",
    ];
    let file_name = std::path::Path::new(&lowered)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    !NEVER_OFFER.contains(&file_name.as_str())
}

fn image_path(pid: u32) -> Option<String> {
    // SAFETY: a plain call; a failure returns a null handle.
    let process: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }

    let mut buffer = [0u16; 32_768];
    let mut len = buffer.len() as u32;
    // SAFETY: the buffer is valid for `len` wide characters and the API
    // writes at most that many, updating `len` with what it wrote.
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
    // SAFETY: `process` came from OpenProcess and is not used again.
    unsafe { CloseHandle(process) };

    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule, spelled out as a table, because every cell of it is a
    /// decision somebody could reasonably make differently and three of
    /// them are the difference between a leak and an outage.
    ///
    /// `Refuse` appears exactly once: `OnlySelected`, UDP, a destination
    /// on the internet. That single cell is the fire-and-forget leak.
    /// Every other cell keeps the behaviour that shipped, and the test
    /// asserts them by name rather than trusting the one that changed to
    /// have stayed in its lane.
    #[test]
    fn only_a_datagram_to_the_internet_with_no_owner_is_refused() {
        let internet = IpAddr::V4("203.0.113.9".parse().unwrap());
        let only = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::OnlySelected);
        let except = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::AllExcept);

        assert_eq!(
            only.verdict_for_unattributed(Transport::Udp, internet),
            Unattributed::Refuse,
            "the measured leak: a datagram nobody owns, going to the internet, in the \
             mode where an unknown owner used to mean leave it alone"
        );
        assert_eq!(
            only.verdict_for_unattributed(Transport::Tcp, internet),
            Unattributed::LeaveAlone,
            "TCP keeps failing open -- a TCP socket cannot be gone before its SYN is \
             classified, so this shape does not arise there"
        );
        assert_eq!(
            except.verdict_for_unattributed(Transport::Udp, internet),
            Unattributed::Carry,
            "everything-except carries an unknown owner; leaving it out is the leak there"
        );
        assert_eq!(
            except.verdict_for_unattributed(Transport::Tcp, internet),
            Unattributed::Carry,
        );
    }

    /// The clauses that keep a customer's machine on its own network.
    ///
    /// Refusing these would not close any leak -- a datagram that never
    /// leaves the local network cannot tell an ISP anything -- and it
    /// would break mDNS, LLMNR, SSDP, WS-Discovery and DHCP, every one
    /// of which is a one-shot sender and therefore exactly the shape
    /// that would be caught. "Blocked too broadly" here means the
    /// customer's printer and their television stop being found, which
    /// is a far worse day than the leak.
    ///
    /// The list is the same one `is_public_v4`/`is_public_v6` answer and
    /// the same one the WinDivert filter excludes in the kernel, which
    /// is why the destination is passed in rather than reached for: the
    /// three cannot drift into disagreeing about one address.
    #[test]
    fn the_local_network_is_never_refused() {
        let only = Selection::new([r"C:\Games\game.exe".to_string()], SplitTunnelMode::OnlySelected);
        for local in [
            "127.0.0.1",     // loopback
            "10.1.2.3",      // RFC1918
            "172.16.0.5",    // RFC1918
            "192.168.1.1",   // RFC1918, and the router
            "169.254.10.1",  // link-local
            "224.0.0.251",   // mDNS
            "239.255.255.250", // SSDP
            "255.255.255.255", // broadcast, and DHCP
        ] {
            let address = IpAddr::V4(local.parse().unwrap());
            assert_eq!(
                only.verdict_for_unattributed(Transport::Udp, address),
                Unattributed::LeaveAlone,
                "{local} is the local network, not the internet"
            );
        }

        for local in ["::1", "fe80::1", "fd00::1", "ff02::fb"] {
            let address = IpAddr::V6(local.parse().unwrap());
            assert_eq!(
                only.verdict_for_unattributed(Transport::Udp, address),
                Unattributed::LeaveAlone,
                "{local} is the local network, not the internet"
            );
        }

        assert_eq!(
            only.verdict_for_unattributed(
                Transport::Udp,
                IpAddr::V6("2001:db8:6ec5::1".parse().unwrap())
            ),
            Unattributed::Refuse,
            "a global v6 address is the internet and leaks the same way v4 does"
        );
    }

    #[test]
    fn selection_matching_ignores_case() {
        // Windows paths are case-insensitive, and the path the customer
        // picked through a file dialog will not always be cased the same
        // way as the one the process reports.
        let selection = Selection::new([r"C:\Games\Valorant\VALORANT.exe".to_string()], SplitTunnelMode::OnlySelected);
        assert!(selection.matches(r"c:\games\valorant\valorant.exe"));
        assert!(selection.matches(r"C:\GAMES\VALORANT\VALORANT.EXE"));
        assert!(!selection.matches(r"C:\Games\Other\VALORANT.exe"));
    }

    #[test]
    fn an_empty_selection_matches_nothing() {
        // The state Custom mode starts in. Matching everything here
        // would tunnel the whole machine the moment the toggle went on
        // with no apps chosen -- the opposite of what it promises.
        let selection = Selection::default();
        assert!(selection.is_empty());
        assert!(!selection.matches(r"C:\Windows\explorer.exe"));
    }

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
        let map = parse_table(&words, 3, 1, 2);
        assert_eq!(map.get(&0x1110), Some(&4242));
        assert_eq!(map.get(&80), Some(&777));
    }

    #[test]
    fn a_truncated_table_does_not_panic() {
        // The count is what the API reported; the buffer is what
        // actually arrived. Trusting the former over the latter would
        // read past the end, in a service running as LocalSystem.
        let words = vec![10, 0, 1, 2];
        let map = parse_table(&words, 3, 1, 2);
        assert_eq!(map.len(), 1);
    }

    /// Runs against this machine's real connection tables. The point is
    /// not a fixed expectation but that the walk returns real data and
    /// resolves to real executables -- the part every redirect decision
    /// depends on being correct.
    #[test]
    fn resolves_a_real_listening_port_to_a_real_executable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let mut lookup = OwnerLookup::new();
        let image = lookup.image_for_port(Family::V4, Transport::Tcp, port);

        let image = image.expect("the test's own listening port must have an owner");
        assert!(
            image.to_lowercase().contains(".exe"),
            "expected an executable path, got {image}"
        );
        println!("port {port} -> {image}");
    }

    /// The socket that opens inside the rate limiter's window, which is
    /// the one a browser opens and the one that used to escape.
    ///
    /// Measured on this machine, three consecutive Custom-mode starts
    /// with a browser selected: 4 of 47, 9 of 60 and 8 of 55 new TCP
    /// connections were not in the snapshot the loop already held. Every
    /// one of them was found by rebuilding, and under the old lookup
    /// every one of them would have gone out untunnelled for good.
    ///
    /// The two lookups here run microseconds apart, which is what puts
    /// the second one inside `MIN_REFRESH_INTERVAL` and makes this the
    /// case being tested rather than an ordinary hit.
    #[test]
    fn a_socket_created_after_the_snapshot_is_still_attributed() {
        let mut lookup = OwnerLookup::new();

        // Builds the snapshot and marks it freshly refreshed.
        let warm = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let _ = lookup.image_for_port(Family::V4, Transport::Tcp, warm.local_addr().unwrap().port());

        // Opened after that snapshot was taken, so it cannot be in it.
        let fresh = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = fresh.local_addr().unwrap().port();

        assert!(
            lookup.image_for_new_connection(Family::V4, Transport::Tcp, port).is_some(),
            "a new connection's owner must be resolved even when the snapshot was just rebuilt"
        );
    }
}

/// The TCP state that tells Windows to tear a connection down.
const MIB_TCP_STATE_DELETE_TCB: u32 = 12;

/// The state of a connection that is actually carrying traffic.
///
/// Named because two separate places now turn on it -- the reset below
/// and the escape audit -- and a bare `5` in either of them reads like a
/// magic number rather than like the one state where a remote address in
/// the table means anything. In every other state the row's remote
/// fields are zero or provisional.
const MIB_TCP_STATE_ESTAB: u32 = 5;

/// Established connections belonging to selected applications, closed so
/// they are rebuilt through the tunnel.
///
/// Without this, switching Custom mode on does nothing for anything
/// already running. A connection is routed once, when it is created, and
/// an application that is already open keeps using the ones it has:
/// measured here, a socket opened beforehand still reported the ordinary
/// exit address thirty seconds later and never moved.
///
/// For a browser that is the whole complaint. Someone selects it, looks
/// at a page showing their address, and sees no change -- because the
/// page is being fetched down a connection that predates the decision.
/// Telegram reconnects promptly and appears to work immediately, which
/// is why the two were reported so differently.
///
/// Only *selected* applications are touched, and only established
/// connections. Resetting a connection is something applications handle
/// routinely -- it is what happens when a network changes -- and the
/// alternative is a feature that silently does not apply until every
/// program is restarted.
///
/// # What is deliberately left alone
///
/// Connections the redirect is already carrying, which is what `carried`
/// answers. This is not an optimisation. The reset runs once inline and
/// then rescans every few hundred milliseconds for the length of the
/// activation window, and a connection an application rebuilt after the
/// first pass is, by the second pass, indistinguishable by remote
/// address from one that predates activation -- so without this the loop
/// closes the very connections it just arranged. Measured on the rig
/// with *no* selected process running before activation and dialling
/// started only after `split_tunnel_active`: "activation reset settled
/// after 12 rescan(s): 30 connection(s) closed in total". All thirty had
/// been carried successfully. A selected application got three seconds
/// of churn for nothing.
///
/// The NAT table is the only thing that can tell the two apart. A
/// carried flow is keyed on the application's own local port and the
/// real destination -- the rewrite happens on the wire, not in the
/// socket, so the connection table still shows the pre-rewrite address
/// the table was keyed on. The escape audit turns on exactly the same
/// question for exactly the same reason; see
/// [`escaped_connections`].
///
/// `carried` must not disturb what it reads. Pass
/// [`super::flows::Nat::has_flow`], never `lookup_flow` -- the latter
/// refreshes `last_seen`, and a rescan loop asking about every
/// established connection twice a second would keep every entry alive
/// forever and stop `expire_idle` retiring anything.
///
/// Connections to the LAN, to loopback and to the node itself. Closing
/// those is pure harm and buys nothing, because none of them would ever
/// have been redirected: the kernel filter excludes every one of those
/// destinations before the redirect loop is given a packet, so a
/// connection to a printer, a NAS or the machine's own services is not
/// a connection that is missing out on the tunnel -- it is one the
/// tunnel was never for. The node's own address is worse than pointless:
/// it is the tunnel, and in `AllExcept` it would be closed on every
/// activation.
///
/// Neoxify's own connections, for the same reason plus a sharper one.
/// In `AllExcept` the service and the app are "selected" by default --
/// nobody thinks to exclude the VPN client -- so without this the reset
/// would close the app's link to its own API every time Custom mode came
/// on, which is the 0.9.22 bug arriving through a different door. It
/// matters more now that this runs repeatedly rather than once.
///
/// What one pass of the reset managed, and what it could not.
#[derive(Debug, Default)]
pub struct ResetOutcome {
    pub closed: usize,
    /// Rows `SetTcpEntry` refused, described well enough to act on.
    ///
    /// These used to be swallowed: the return value was checked, and a
    /// failure simply did not increment the count. That made a refusal
    /// indistinguishable from a row that was never a candidate, which
    /// matters more now that the reset runs repeatedly -- a connection
    /// that cannot be closed is one the loop will keep failing to close
    /// for the whole window, and the log would show only a number that
    /// did not move.
    pub failures: Vec<String>,
}

/// Returns what was closed and what refused to close, for the log.
pub fn reset_selected_connections(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> ResetOutcome {
    // SAFETY: `row` is a correctly shaped MIB_TCPROW; the call only
    // reads it.
    reset_with(selection, node, own_images, carried, &|row| unsafe {
        SetTcpEntry(row.as_mut_ptr() as *mut _)
    })
}

/// The reset with the one thing that touches the machine handed in.
///
/// Split out only so it can be tested. `reset_selected_connections`
/// walks this machine's real connection table -- there is no other kind
/// -- so a test that exercised the real closer would tear down whatever
/// the developer or the build agent happened to have open. With the
/// closer stubbed, the classification can be checked against real rows
/// without a single `SetTcpEntry`.
fn reset_with(
    selection: &Selection,
    node: Ipv4Addr,
    own_images: &[String],
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
    close: &dyn Fn(&mut [u32; 5]) -> u32,
) -> ResetOutcome {
    let mut outcome = ResetOutcome::default();
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return outcome;
    };

    let Some(&count) = words.first() else {
        return outcome;
    };

    // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    // remote port, owning pid -- six DWORDs.
    const ROW: usize = 6;
    let mut images: HashMap<u32, Option<String>> = HashMap::new();

    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        let (state, pid) = (fields[0], fields[5]);

        // Only connections that actually carry traffic. A listener has
        // no peer to re-route and killing one would stop a program
        // accepting connections, which is not what was asked for.
        if state != MIB_TCP_STATE_ESTAB {
            continue;
        }

        // Where the far end is, decided before the more expensive
        // question of who owns the row.
        let remote = Ipv4Addr::from(fields[3].to_ne_bytes());
        let remote_port = (fields[4] as u16).swap_bytes();

        // The node is the tunnel itself; everything else excluded here
        // is a destination the kernel filter would never have handed to
        // the redirect loop anyway. Closing them would break a printer,
        // a NAS or a local service to gain exactly nothing.
        if remote == node || !is_public_v4(remote) {
            continue;
        }

        // Already in the tunnel, so closing it would undo this
        // function's own work -- see the doc comment. Asked before the
        // owner is resolved, because this is a hash lookup under a
        // mutex and `image_path` opens a process handle.
        let local_port = (fields[2] as u16).swap_bytes();
        if carried(Transport::Tcp, local_port, remote, remote_port) {
            continue;
        }

        let image = images
            .entry(pid)
            .or_insert_with(|| image_path(pid))
            .clone();
        let Some(image) = image else { continue };
        // Never Neoxify's own. In AllExcept the app and the service are
        // carried by default, and closing the app's link to its own API
        // on every activation is the 0.9.22 failure arriving by another
        // route.
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // MIB_TCPROW is the same five leading fields without the pid.
        let mut set = [MIB_TCP_STATE_DELETE_TCB, fields[1], fields[2], fields[3], fields[4]];
        let ret = close(&mut set);
        if ret == NO_ERROR {
            outcome.closed += 1;
        } else {
            // Said out loud rather than swallowed. A connection that
            // will not close is one that goes on carrying the
            // customer's traffic outside the tunnel, and it is the
            // single most useful thing this function can report: the
            // count alone cannot tell "there was nothing to close" from
            // "Windows refused every attempt".
            outcome
                .failures
                .push(format!("could not close {image} -> {remote}:{remote_port} (error {ret})"));
        }
    }
    outcome
}

/// Whether an IPv4 destination is out on the internet, rather than
/// somewhere a split tunnel deliberately leaves alone.
///
/// The exclusions are deliberately the *same set* the kernel filter
/// carries (see `redirect::filter_for`), and keeping them in step is the
/// whole point rather than a tidiness argument. The filter decides what
/// the redirect loop is ever allowed to see; this decides what the audit
/// is allowed to call an escape. If the two drifted apart the audit
/// would report a stream of "escapes" the loop was never given a chance
/// to carry -- a number that looks like a leak and is really a
/// disagreement between two lists, which is exactly the sort of false
/// alarm this project has already decided is worse than saying nothing.
pub fn is_public_v4(addr: Ipv4Addr) -> bool {
    let o = addr.octets();
    !(addr.is_unspecified()
        || addr.is_loopback()
        // Multicast, the reserved space above it, and the all-ones
        // broadcast, in one comparison -- as in the filter.
        || o[0] >= 224
        || o[0] == 10
        || (o[0] == 172 && (16..32).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 169 && o[1] == 254))
}

/// The same question for IPv6, and necessarily a weaker answer.
///
/// There is no RFC1918 to carve out: a home IPv6 network numbers its own
/// devices out of the global prefix its ISP delegates, so a LAN
/// neighbour on a `2000::/3` address is indistinguishable here from the
/// internet. What can be excluded is only what is genuinely not the
/// internet -- loopback, the unspecified address, multicast, unique-local
/// and link-local -- which mirrors the IPv6 half of the filter for the
/// same reason the IPv4 version mirrors the IPv4 half.
///
/// An IPv4-mapped address is IPv4 traffic wearing a v6 shape, and is
/// answered by the IPv4 rules so the two cannot disagree about one
/// destination written two ways.
pub fn is_public_v6(addr: Ipv6Addr) -> bool {
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let first = addr.segments()[0];
    !(addr.is_unspecified()
        || addr.is_loopback()
        || addr.is_multicast()
        // fc00::/7, unique-local.
        || first & 0xfe00 == 0xfc00
        // fe80::/10, link-local.
        || first & 0xffc0 == 0xfe80)
}

/// One row of the machine's TCP tables, in the shape the audit needs.
///
/// Separate from the `port -> pid` maps [`OwnerLookup`] builds, because
/// those deliberately throw away the two things the audit turns on: the
/// connection's state, and where its far end is.
struct TcpConnection {
    state: u32,
    local_port: u16,
    remote: IpAddr,
    remote_port: u16,
    pid: u32,
}

/// Every IPv4 TCP row, with its state and remote end intact.
fn tcp_connections_v4() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    let Some(&count) = words.first() else {
        return Vec::new();
    };

    // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    // remote port, owning pid -- six DWORDs.
    const ROW: usize = 6;
    let mut rows = Vec::new();
    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        rows.push(TcpConnection {
            state: fields[0],
            // A port sits network-order in the low half of its DWORD; an
            // address is already a network-order byte sequence, so the
            // DWORD's own bytes are the octets in order.
            local_port: (fields[2] as u16).swap_bytes(),
            remote: IpAddr::V4(Ipv4Addr::from(fields[3].to_ne_bytes())),
            remote_port: (fields[4] as u16).swap_bytes(),
            pid: fields[5],
        });
    }
    rows
}

/// Every IPv6 TCP row.
///
/// Walked as well as the IPv4 table, and that is the point rather than
/// completeness for its own sake: a selected app's IPv6 is *blocked*
/// while Custom mode runs, so any established v6 connection it still
/// holds predates the switch and is living entirely outside the tunnel,
/// with nothing in the counters able to say so.
fn tcp_connections_v6() -> Vec<TcpConnection> {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: as above.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return Vec::new();
    };
    let Some(&count) = words.first() else {
        return Vec::new();
    };

    // MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId,
    // dwLocalPort, ucRemoteAddr[16], dwRemoteScopeId, dwRemotePort,
    // dwState, dwOwningPid -- fourteen 32-bit words.
    const ROW: usize = 14;
    let mut rows = Vec::new();
    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        let mut octets = [0u8; 16];
        for (i, word) in fields[6..10].iter().enumerate() {
            octets[i * 4..i * 4 + 4].copy_from_slice(&word.to_ne_bytes());
        }
        rows.push(TcpConnection {
            state: fields[12],
            local_port: (fields[5] as u16).swap_bytes(),
            remote: IpAddr::V6(Ipv6Addr::from(octets)),
            remote_port: (fields[11] as u16).swap_bytes(),
            pid: fields[13],
        });
    }
    rows
}

/// A connection living outside the tunnel that should be inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Escape {
    pub image: String,
    pub remote: IpAddr,
    pub remote_port: u16,
    pub local_port: u16,
}

/// Established connections belonging to applications whose traffic is
/// supposed to be carried, which the redirect is not carrying.
///
/// # Why this exists at all
///
/// Every number in `redirect::Stats` is counted from inside the packet
/// loop, which means all of them are blind in the same direction: they
/// can only describe packets the loop was given. A connection that
/// escaped -- because its SYN raced the owner lookup, because it was
/// established before Custom mode came on, or because it is IPv6 and was
/// blocked rather than carried -- produces no packet the loop will ever
/// count. `seen`, `matched` and `redirected` all read healthy while it
/// carries the customer's traffic out in the clear. That is the failure
/// this feature has now shipped three separate versions of, and the
/// counters structurally cannot report it.
///
/// So this asks the other question, from the other side: not what the
/// loop did, but what the machine is actually holding open. The
/// connection tables know about every socket whether or not a packet of
/// its was ever intercepted, so a flow that got away is visible here and
/// nowhere else.
///
/// # What it deliberately does not report
///
/// * Rows whose owning process cannot be resolved. In `AllExcept` an
///   unresolvable owner is supposed to be tunnelled, so skipping it
///   under-reports -- but calling a connection an escape without being
///   able to name the program that made it produces a number nobody can
///   act on, and this file's history says an alarm nobody can act on is
///   worse than silence.
/// * Anything belonging to Neoxify itself. The relay's own onward
///   sockets are established to exactly the public destinations the
///   customer's apps asked for and have no NAT entry of their own, so
///   without this every carried flow would be counted twice: once as
///   itself and once as its own escape.
/// * The node, the LAN, loopback and the relay's own two ports -- none
///   of which the redirect was ever supposed to carry.
///
/// `carried` answers whether the redirect already holds a flow. It is
/// passed in rather than reached for, so this stays testable without a
/// NAT table and so the caller can guarantee the read does not disturb
/// the table's idle timers -- see `Nat::has_flow`.
///
/// This is **observation only**. Nothing here closes, drops or rewrites
/// anything: it produces a count and a list for the log, and every
/// decision about what to do with them is made elsewhere.
pub fn escaped_connections(
    selection: &Selection,
    own_images: &[String],
    node: Ipv4Addr,
    proxy_ports: (u16, u16),
    carried: &dyn Fn(Transport, u16, Ipv4Addr, u16) -> bool,
) -> Vec<Escape> {
    let mut images: HashMap<u32, Option<String>> = HashMap::new();
    let mut escapes = Vec::new();

    for row in tcp_connections_v4().into_iter().chain(tcp_connections_v6()) {
        // Only a connection that is carrying traffic. In every other
        // state the remote fields are zero or provisional, so there is
        // nothing to classify and nothing that has leaked yet.
        if row.state != MIB_TCP_STATE_ESTAB {
            continue;
        }

        // The relay's own ports, on either end of the row. The proxy's
        // listening side and the app's connection into it are both
        // ordinary TCP connections on this machine, and would otherwise
        // read as traffic that got away from the very thing carrying it.
        if row.local_port == proxy_ports.0
            || row.local_port == proxy_ports.1
            || row.remote_port == proxy_ports.0
            || row.remote_port == proxy_ports.1
        {
            continue;
        }

        match row.remote {
            // The node is the tunnel itself. Everything else excluded
            // here is the local network a split tunnel exists to leave
            // alone.
            IpAddr::V4(addr) if addr == node || !is_public_v4(addr) => continue,
            IpAddr::V6(addr) if !is_public_v6(addr) => continue,
            _ => {}
        }

        let image = images.entry(row.pid).or_insert_with(|| image_path(row.pid)).clone();
        let Some(image) = image else { continue };
        if own_images.iter().any(|own| image.eq_ignore_ascii_case(own)) {
            continue;
        }
        if !selection.should_tunnel(&image) {
            continue;
        }

        // A carried flow is keyed on the app's own port and the real
        // destination, which is what the connection table still shows:
        // the rewrite happens on the wire, not in the socket, so the
        // stack's idea of where this connection is going is the
        // pre-rewrite address the NAT table was keyed on.
        //
        // There is no v6 half to ask. The NAT table is IPv4 only, so an
        // established v6 connection belonging to a carried application
        // is an escape by construction -- which is the honest reading of
        // the 0.9.27 decision to block rather than carry, not a fault in
        // it.
        if let IpAddr::V4(addr) = row.remote {
            if carried(Transport::Tcp, row.local_port, addr, row.remote_port) {
                continue;
            }
        }

        escapes.push(Escape {
            image,
            remote: row.remote,
            remote_port: row.remote_port,
            local_port: row.local_port,
        });
    }

    escapes
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[test]
    fn the_public_test_matches_what_the_kernel_filter_hands_over() {
        // These are the same list seen from opposite ends -- see
        // is_public_v4. Every address the filter string in redirect.rs
        // excludes must be excluded here too, or the audit reports
        // escapes for traffic the loop was never given.
        for local in [
            "0.0.0.0",
            "127.0.0.1",
            "10.4.4.4",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "169.254.10.10",
            "224.0.0.251",
            "255.255.255.255",
        ] {
            assert!(!is_public_v4(local.parse().unwrap()), "{local} must not count as public");
        }
        // The near misses, which is where an off-by-one range would
        // show: 172.15 and 172.32 are outside RFC1918, and 192.169 is
        // not 192.168.
        for public in
            ["1.1.1.1", "8.8.8.8", "38.60.249.229", "172.15.0.1", "172.32.0.1", "192.169.0.1"]
        {
            assert!(is_public_v4(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn the_ipv6_test_leaves_the_local_network_alone() {
        for local in ["::", "::1", "fe80::1", "fd00::950d:8fd1:26eb:d4a", "ff02::fb", "fc00::5"] {
            assert!(!is_public_v6(local.parse().unwrap()), "{local} must not count as public");
        }
        for public in ["2607:f8b0:400a:809::200e", "2001:db8:6ec5::1"] {
            assert!(is_public_v6(public.parse().unwrap()), "{public} must count as public");
        }
    }

    #[test]
    fn an_ipv4_mapped_address_is_answered_by_the_ipv4_rules() {
        // One destination written two ways must not get two answers, or
        // a LAN address wearing a v6 shape becomes an escape.
        assert!(!is_public_v6("::ffff:192.168.1.20".parse().unwrap()));
        assert!(is_public_v6("::ffff:8.8.8.8".parse().unwrap()));
    }

    /// The audit against this machine's real tables, with a selection
    /// that carries nothing.
    ///
    /// Not an assertion about a number -- that depends on whatever
    /// happens to be running -- but about the one property that holds
    /// whatever is running: an empty `OnlySelected` selection tunnels
    /// nothing, so nothing can have escaped from it. A non-zero answer
    /// would mean the classification is wrong, not that the machine is
    /// leaking.
    #[test]
    fn nothing_escapes_a_selection_that_carries_nothing() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        assert!(escapes.is_empty(), "found {escapes:?}");
    }

    /// The opposite direction, which is what shows the walk returns real
    /// rows rather than nothing at all.
    ///
    /// `AllExcept` with an empty list means everything is supposed to be
    /// carried, and `carried` here says nothing is -- so every
    /// established public connection this machine holds should come
    /// back. The count is not asserted, because a build agent may hold
    /// none; what is asserted is that whatever comes back is well formed
    /// and passes the classification it claims to have passed.
    #[test]
    fn the_walk_returns_rows_that_are_what_they_claim_to_be() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| false,
        );
        println!("{} established connection(s) outside a nothing-carried tunnel", escapes.len());
        for escape in escapes.iter().take(5) {
            println!("{} -> {}:{}", escape.image, escape.remote, escape.remote_port);
            assert!(escape.image.to_lowercase().ends_with(".exe"), "{escape:?}");
            assert_ne!(escape.remote_port, 0, "{escape:?}");
            match escape.remote {
                IpAddr::V4(addr) => assert!(is_public_v4(addr), "{escape:?}"),
                IpAddr::V6(addr) => assert!(is_public_v6(addr), "{escape:?}"),
            }
        }
    }

    #[test]
    fn the_reset_leaves_a_machine_alone_when_nothing_is_selected() {
        // Against this machine's real connection table, which is the
        // only way to run it. An empty OnlySelected list carries
        // nothing, so nothing may be closed -- and this test exists
        // because the cost of being wrong about that is other people's
        // connections dying on a developer's desktop.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::OnlySelected);
        let outcome = reset_selected_connections(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
        );
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// The convergence loop's own connections, which it used to close.
    ///
    /// `AllExcept` with an empty exclusion list selects everything on
    /// the machine, which is the widest the reset can ever be asked to
    /// be. With `carried` saying every flow is already in the tunnel,
    /// the correct number of closures is zero -- that is the whole
    /// claim. Before the predicate existed the same call closed every
    /// established public connection on the machine, which is what the
    /// rig measured as thirty closures across twelve rescans with
    /// nothing stale to close.
    ///
    /// Run through `reset_with` with the closer stubbed, so a
    /// regression fails the assertion instead of tearing down the
    /// developer's connections to prove it.
    #[test]
    fn a_flow_the_redirect_already_holds_is_not_reset() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| true,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        assert_eq!(attempts.get(), 0, "a carried flow was handed to SetTcpEntry");
        assert_eq!(outcome.closed, 0);
        assert!(outcome.failures.is_empty(), "{:?}", outcome.failures);
    }

    /// The other direction, which is what stops the test above passing
    /// because the walk found nothing.
    ///
    /// Same selection, same stub closer, `carried` saying nothing is in
    /// the tunnel. Whatever this machine holds open to the public
    /// internet should now be a candidate. The count is not asserted --
    /// a build agent may legitimately hold none -- but it is printed,
    /// and if it is non-zero then the assertion above means something.
    #[test]
    fn without_the_predicate_the_same_walk_finds_candidates() {
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let attempts = std::cell::Cell::new(0usize);

        let outcome = reset_with(
            &selection,
            Ipv4Addr::new(203, 0, 113, 7),
            &[],
            &|_, _, _, _| false,
            &|_| {
                attempts.set(attempts.get() + 1);
                NO_ERROR
            },
        );

        println!("{} connection(s) would have been closed", attempts.get());
        assert_eq!(outcome.closed, attempts.get());
    }

    #[test]
    fn a_flow_the_redirect_already_holds_is_not_an_escape() {
        // The predicate the whole audit turns on, said with a stub
        // rather than a live NAT table so the test states the rule
        // instead of restating the table's implementation.
        let selection = Selection::new(Vec::new(), SplitTunnelMode::AllExcept);
        let escapes = escaped_connections(
            &selection,
            &[],
            Ipv4Addr::new(203, 0, 113, 7),
            (19999, 19998),
            &|_, _, _, _| true,
        );
        // Every IPv4 row is claimed as carried, so only IPv6 rows -- for
        // which there is no NAT table to ask -- may remain.
        assert!(
            escapes.iter().all(|e| matches!(e.remote, IpAddr::V6(_))),
            "an IPv4 flow the NAT table holds must not be an escape: {escapes:?}"
        );
    }
}
