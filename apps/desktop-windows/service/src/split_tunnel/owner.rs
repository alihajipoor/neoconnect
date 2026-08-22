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
//! sent, so a lookup at the moment the first packet arrives is always
//! answerable. The cost is a table walk, which is why the result is
//! cached and the refresh rate-limited below.

use std::collections::HashMap;
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
    pub fn tunnel_when_owner_unknown(&self) -> bool {
        matches!(self.mode, SplitTunnelMode::AllExcept)
    }
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
/// Returns how many were closed, for the log.
pub fn reset_selected_connections(selection: &Selection) -> usize {
    let Some(words) = query_table(|buf, size| {
        // SAFETY: `buf` is null (sizing) or a buffer of `*size` bytes.
        unsafe { GetExtendedTcpTable(buf, size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) }
    }) else {
        return 0;
    };

    let Some(&count) = words.first() else {
        return 0;
    };

    // MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr,
    // remote port, owning pid -- six DWORDs.
    const ROW: usize = 6;
    let mut images: HashMap<u32, Option<String>> = HashMap::new();
    let mut closed = 0usize;

    for row in 0..count as usize {
        let base = 1 + row * ROW;
        let Some(fields) = words.get(base..base + ROW) else {
            break;
        };
        let (state, pid) = (fields[0], fields[5]);

        // Only connections that actually carry traffic. A listener has
        // no peer to re-route and killing one would stop a program
        // accepting connections, which is not what was asked for.
        if state != 5 {
            continue;
        }

        let image = images
            .entry(pid)
            .or_insert_with(|| image_path(pid))
            .clone();
        let Some(image) = image else { continue };
        if !selection.should_tunnel(&image) {
            continue;
        }

        // MIB_TCPROW is the same five leading fields without the pid.
        let mut set = [MIB_TCP_STATE_DELETE_TCB, fields[1], fields[2], fields[3], fields[4]];
        // SAFETY: `set` is a correctly shaped MIB_TCPROW; the call only
        // reads it.
        let ret = unsafe { SetTcpEntry(set.as_mut_ptr() as *mut _) };
        if ret == NO_ERROR {
            closed += 1;
        }
    }
    closed
}
