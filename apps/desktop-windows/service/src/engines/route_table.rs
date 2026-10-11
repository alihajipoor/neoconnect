//! The IPv4 routing table as plain rows, and the two things this service
//! does to it on an adapter that is not ours.
//!
//! Every other route this service touches sits on one of its own
//! adapters, and those are handled by interface in `routing`: the
//! adapter goes away with the engine, or its routes are purged by
//! interface index. A host route to the node is different. It sits on the
//! *physical* adapter -- Xray's because `routing::install_full_tunnel`
//! puts it there, OpenVPN's because `redirect-gateway` makes openvpn.exe
//! add one -- and nothing that cleans up our adapters ever looks there.
//! Measured on the VM: after two Compatible sessions, a /32 to each of
//! the two nodes was still on the guest's Ethernet adapter, and the next
//! Stealth connect's health check to one of those nodes' mirrors went
//! around the tunnel, was read as the tunnel being bypassed, and moved the
//! customer off a server that was working.
//!
//! So routes on someone else's adapter are described here as rows that
//! can be compared, diffed and written down, and changed only through
//! [`RouteOps`] -- a trait, so that the decisions about which row to add
//! or delete can be tested against a recorded table instead of the
//! machine running the tests.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    DeleteIpForwardEntry2, FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;

/// One IPv4 route, as far as this service needs to know it.
///
/// The first four fields are what Windows keys a route by: two routes
/// with the same destination, prefix, interface and next hop are the same
/// route. The metric is carried for adding one, and is not part of that
/// identity -- see [`RouteRow::same_route`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RouteRow {
    pub dest: Ipv4Addr,
    pub prefix: u8,
    pub if_index: u32,
    /// `0.0.0.0` for an on-link route, which is what a PPP or PPPoE
    /// uplink's default route looks like: there is no gateway to name,
    /// the far end of the link is the next hop.
    pub next_hop: Ipv4Addr,
    pub metric: u32,
}

impl RouteRow {
    /// A host route: one address, on one interface, through one next hop.
    pub fn host(dest: Ipv4Addr, if_index: u32, next_hop: Ipv4Addr, metric: u32) -> Self {
        Self { dest, prefix: 32, if_index, next_hop, metric }
    }

    pub fn is_host(&self) -> bool {
        self.prefix == 32
    }

    /// Whether `other` is the same route as Windows counts them.
    ///
    /// The metric is left out on purpose. Windows will not hold two
    /// routes that differ only in metric -- the second add is refused as
    /// already existing -- so a row read back with a different metric
    /// than the one written is still that row, and deleting by it must
    /// still find it.
    pub fn same_route(&self, other: &RouteRow) -> bool {
        self.dest == other.dest
            && self.prefix == other.prefix
            && self.if_index == other.if_index
            && self.next_hop == other.next_hop
    }

    /// The netmask `route.exe` wants for this prefix.
    pub fn mask(&self) -> Ipv4Addr {
        let bits = u32::from(self.prefix.min(32));
        Ipv4Addr::from(if bits == 0 { 0 } else { u32::MAX << (32 - bits) })
    }
}

/// The host routes on one interface.
pub fn host_routes_on(rows: &[RouteRow], if_index: u32) -> Vec<RouteRow> {
    rows.iter().filter(|r| r.is_host() && r.if_index == if_index).copied().collect()
}

/// The host routes that appeared on `if_index` between two readings of
/// the table.
///
/// What OpenVPN's `redirect-gateway` adds is learned this way, because
/// openvpn.exe does not say: the table is read before it starts and again
/// once it reports the tunnel up, and what is new on the uplink is what it
/// added. Restricted to host routes on that one interface so that nothing
/// else the machine did in those seconds -- a route on another adapter, a
/// prefix of any other length, the tunnel's own half-defaults -- is taken
/// for OpenVPN's and later deleted as ours.
pub fn new_host_routes(before: &[RouteRow], after: &[RouteRow], if_index: u32) -> Vec<RouteRow> {
    host_routes_on(after, if_index)
        .into_iter()
        .filter(|row| !before.iter().any(|old| old.same_route(row)))
        .collect()
}

/// Host routes to one of our own servers on an adapter that is not ours.
///
/// What the stale purge at the top of every connect removes: a host route
/// to a node is only ever on the physical adapter because a session of
/// ours put it there -- Xray's routing, or OpenVPN's `redirect-gateway` --
/// and by the time a connect runs, that session has been torn down. Any
/// left are what releases up to 0.9.48 left after every Compatible
/// session, and what a killed service leaves before the ledger existed.
///
/// Narrow on purpose: host routes only, only to the addresses given, and
/// never on our own adapters, whose routes are purged by interface.
pub fn stale_node_routes(rows: &[RouteRow], nodes: &[Ipv4Addr], ours: &[u32]) -> Vec<RouteRow> {
    rows.iter()
        .filter(|r| r.is_host() && nodes.contains(&r.dest) && !ours.contains(&r.if_index))
        .copied()
        .collect()
}

/// The routing table, and the two changes this service makes to rows on
/// an adapter that is not its own.
///
/// `Send + Sync` and taking `&self` because one of these is shared, as an
/// `Arc`, by the engine state and every `InstalledRoutes` that may have to
/// remove a row from a teardown on whichever thread runs it.
pub trait RouteOps: Send + Sync {
    /// Every IPv4 route on the machine.
    fn rows(&self) -> Result<Vec<RouteRow>, String>;
    /// Adds the route. Refused when the same route already exists, as
    /// Windows refuses it.
    fn add(&self, route: &RouteRow) -> Result<(), String>;
    /// Deletes every row that is [`RouteRow::same_route`] as this one. A
    /// route that is not there is not an error: the goal is that it is
    /// gone, not that this call was the one that removed it.
    fn delete(&self, route: &RouteRow) -> Result<(), String>;
}

/// The machine's own table.
pub struct SystemRoutes;

/// The machine's table, as the shared handle the engines hold.
pub fn system() -> Arc<dyn RouteOps> {
    Arc::new(SystemRoutes)
}

impl RouteOps for SystemRoutes {
    fn rows(&self) -> Result<Vec<RouteRow>, String> {
        Ok(raw_ipv4_table()?.iter().map(row_from).collect())
    }

    /// With `route.exe`, as every route this service has ever added was
    /// added, so the metric means what it has always meant here.
    fn add(&self, route: &RouteRow) -> Result<(), String> {
        super::routing::add_route(
            &route.dest.to_string(),
            &route.mask().to_string(),
            &route.next_hop.to_string(),
            route.if_index,
            route.metric,
        )
    }

    /// Native, and by enumeration: the rows `GetIpForwardTable2` returns
    /// are exactly what `DeleteIpForwardEntry2` wants back, so nothing has
    /// to be re-described to be deleted, and no process is started --
    /// which is what lets the teardowns that may not launch PowerShell,
    /// or more than three `route.exe`, remove these too.
    fn delete(&self, route: &RouteRow) -> Result<(), String> {
        if route.if_index == 0 {
            return Err("interface index 0 names no interface".to_string());
        }
        let mut failed = None;
        for raw in raw_ipv4_table()?.iter().filter(|raw| row_from(raw).same_route(route)) {
            // SAFETY: `raw` is a row GetIpForwardTable2 returned, copied
            // out whole; the call only reads it.
            let rc = unsafe { DeleteIpForwardEntry2(raw) };
            // Gone between the read and the delete is gone.
            if rc != NO_ERROR && rc != ERROR_NOT_FOUND {
                failed = Some(rc);
            }
        }
        match failed {
            Some(rc) => Err(format!("DeleteIpForwardEntry2 failed for {}/{} ({rc})", route.dest, route.prefix)),
            None => Ok(()),
        }
    }
}

/// Host routes this service has put, or taken over, on an adapter that is
/// not its own, and has not yet removed -- written down in the config
/// directory so that a later life of the service can remove them.
///
/// A route on our own adapter needs no such record: the Xray adapter goes
/// away with the engine and takes its routes with it, and the janitor
/// purges the OpenVPN adapter by interface. A route on the physical
/// adapter outlives all of that. `InstalledRoutes` removes it on every
/// teardown that runs, but a service that is killed, crashes or is
/// upgraded mid-session runs none, and until now that route stayed until
/// the machine rebooted -- `hard_stop` said as much. With this file, the
/// janitor at the next start removes it.
///
/// Written *before* the route is added and settled only *after* it is
/// deleted, so there is no moment at which the route exists and the
/// record of it does not.
///
/// Best-effort, like every log here: a file that cannot be written must
/// never fail the connect it describes. The second net is the stale-route
/// purge every connect makes against the nodes the app knows.
pub struct OwedRoutes {
    path: PathBuf,
}

/// The ledger's file name in the config directory.
const OWED_FILE: &str = "owed-routes.json";

/// One lock for every read-modify-write of a ledger, so two sessions
/// ending on two threads cannot each write back a list missing the
/// other's change. There is one `Engines` on a customer's machine, but a
/// teardown can run on a watch thread's behalf, and the tests run
/// thirty-two at once.
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

/// What settling the ledger did.
#[derive(Debug, Default)]
pub struct Replayed {
    /// Routes deleted (or already gone) and struck off.
    pub removed: Vec<RouteRow>,
    /// Routes that would not delete, and why. Still owed.
    pub failed: Vec<String>,
}

impl OwedRoutes {
    pub fn in_dir(config_dir: &Path) -> Self {
        Self { path: config_dir.join(OWED_FILE) }
    }

    /// Everything owed. A file that is missing reads as nothing owed, and
    /// so does one that cannot be parsed: a ledger is a list of things to
    /// try to delete, and refusing to start over a corrupt one would cost
    /// the customer more than the routes it could no longer name.
    pub fn read(&self) -> Vec<RouteRow> {
        let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read_unlocked()
    }

    /// Records a route as owed. Called before the route is added.
    pub fn owe(&self, route: RouteRow) {
        let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut owed = self.read_unlocked();
        if !owed.iter().any(|r| r.same_route(&route)) {
            owed.push(route);
        }
        self.write_unlocked(&owed);
    }

    /// Strikes a route off. Called after it is deleted.
    pub fn settle(&self, route: &RouteRow) {
        let _guard = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut owed = self.read_unlocked();
        let before = owed.len();
        owed.retain(|r| !r.same_route(route));
        if owed.len() != before {
            self.write_unlocked(&owed);
        }
    }

    /// Deletes every owed route, each by its own interface and next hop,
    /// and strikes off the ones that went.
    ///
    /// Scoped exactly as it was recorded, never by destination alone: the
    /// same node address may be routed by something else on another
    /// adapter or through another gateway, and that route is not ours to
    /// take. A route that is no longer there -- the machine rebooted, or
    /// the adapter went -- deletes as nothing and is struck off too.
    pub fn replay(&self, ops: &dyn RouteOps) -> Replayed {
        let mut replayed = Replayed::default();
        for route in self.read() {
            match ops.delete(&route) {
                Ok(()) => {
                    self.settle(&route);
                    replayed.removed.push(route);
                }
                Err(why) => replayed.failed.push(format!("{}/{}: {why}", route.dest, route.prefix)),
            }
        }
        replayed
    }

    fn read_unlocked(&self) -> Vec<RouteRow> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Written whole to a temporary file and renamed over the ledger, so
    /// a crash mid-write leaves the old list rather than half a new one.
    /// An empty list removes the file: nothing owed is the ordinary state
    /// and should leave nothing behind in the config directory.
    fn write_unlocked(&self, owed: &[RouteRow]) {
        if owed.is_empty() {
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        let Ok(text) = serde_json::to_vec_pretty(owed) else { return };
        let temporary = self.path.with_extension("json.tmp");
        if std::fs::write(&temporary, text).is_ok() && std::fs::rename(&temporary, &self.path).is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

/// Every IPv4 route on the machine, as the API's own rows.
pub(super) fn raw_ipv4_table() -> Result<Vec<MIB_IPFORWARD_ROW2>, String> {
    let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
    // SAFETY: `table` is an out parameter the call fills with a buffer it
    // allocates, freed below with the matching FreeMibTable.
    let rc = unsafe { GetIpForwardTable2(AF_INET, &mut table) };
    if rc != NO_ERROR || table.is_null() {
        return Err(format!("GetIpForwardTable2 failed ({rc})"));
    }
    // SAFETY: on success `table` points at a header followed by
    // `NumEntries` rows -- the declared `[_; 1]` is the C idiom for a
    // trailing array -- and they stay valid until FreeMibTable.
    let rows = unsafe {
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize).to_vec();
        FreeMibTable(table as *const core::ffi::c_void);
        rows
    };
    Ok(rows)
}

/// One API row as a [`RouteRow`].
pub(super) fn row_from(route: &MIB_IPFORWARD_ROW2) -> RouteRow {
    // SAFETY: every row this is given came from an AF_INET table (or was
    // built as one), so the IPv4 arm of both unions is the live one. The
    // addresses are in network byte order, so their in-memory bytes are
    // the octets in order.
    let (dest, hop) = unsafe {
        (
            route.DestinationPrefix.Prefix.Ipv4.sin_addr.S_un.S_addr,
            route.NextHop.Ipv4.sin_addr.S_un.S_addr,
        )
    };
    RouteRow {
        dest: Ipv4Addr::from(dest.to_ne_bytes()),
        prefix: route.DestinationPrefix.PrefixLength,
        if_index: route.InterfaceIndex,
        next_hop: Ipv4Addr::from(hop.to_ne_bytes()),
        metric: route.Metric,
    }
}

/// A routing table in memory, which records every change asked of it.
#[cfg(test)]
pub(crate) mod fake {
    use super::{RouteOps, RouteRow};
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Op {
        Add(RouteRow),
        Delete(RouteRow),
    }

    #[derive(Default)]
    pub struct FakeRoutes {
        table: Mutex<Vec<RouteRow>>,
        log: Mutex<Vec<Op>>,
    }

    impl FakeRoutes {
        pub fn with(rows: &[RouteRow]) -> Arc<Self> {
            Arc::new(Self { table: Mutex::new(rows.to_vec()), log: Mutex::default() })
        }

        /// What the table holds now.
        pub fn table(&self) -> Vec<RouteRow> {
            self.table.lock().unwrap().clone()
        }

        /// Every change asked of it, in order.
        pub fn log(&self) -> Vec<Op> {
            self.log.lock().unwrap().clone()
        }

        /// A route appearing that nobody asked this for -- what
        /// openvpn.exe adding one looks like from here.
        pub fn gain(&self, row: RouteRow) {
            self.table.lock().unwrap().push(row);
        }
    }

    impl RouteOps for FakeRoutes {
        fn rows(&self) -> Result<Vec<RouteRow>, String> {
            Ok(self.table())
        }

        fn add(&self, route: &RouteRow) -> Result<(), String> {
            self.log.lock().unwrap().push(Op::Add(*route));
            let mut table = self.table.lock().unwrap();
            if table.iter().any(|r| r.same_route(route)) {
                return Err(format!("adding the route for {} failed (the object already exists)", route.dest));
            }
            table.push(*route);
            Ok(())
        }

        fn delete(&self, route: &RouteRow) -> Result<(), String> {
            self.log.lock().unwrap().push(Op::Delete(*route));
            self.table.lock().unwrap().retain(|r| !r.same_route(route));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> Ipv4Addr {
        Ipv4Addr::new(a, b, c, d)
    }

    /// What OpenVPN's adoption rests on: of everything that changed in the
    /// table while openvpn.exe connected, only the host routes it put on
    /// the uplink are its own.
    ///
    /// The tunnel's half-default on its own adapter changed too, and must
    /// not be counted -- it is OpenVPN's and goes with the adapter's purge
    /// -- and the default route that was there before is the customer's.
    #[test]
    fn host_route_diff_finds_only_new_slash32s_on_the_uplink() {
        let gateway = v4(192, 0, 2, 1);
        let default = RouteRow { dest: v4(0, 0, 0, 0), prefix: 0, if_index: 14, next_hop: gateway, metric: 25 };
        let node = RouteRow::host(v4(203, 0, 113, 7), 14, gateway, 0);
        let half = RouteRow { dest: v4(0, 0, 0, 0), prefix: 1, if_index: 20, next_hop: v4(10, 77, 0, 1), metric: 0 };

        let before = [default];
        let after = [default, node, half];

        assert_eq!(new_host_routes(&before, &after, 14), vec![node]);
        assert!(new_host_routes(&before, &after, 20).is_empty(), "a /1 is not a host route");
        assert!(
            new_host_routes(&after, &after, 14).is_empty(),
            "a host route that was there before is not one the engine added"
        );
    }

    /// What the purge at the top of a connect may take: a host route to a
    /// node the app knows, on an adapter that is not ours. A host route to
    /// any other address is the customer's; a prefix of any other length
    /// is not a leftover of ours; and a route on our own adapter is the
    /// adapter purge's.
    #[test]
    fn stale_purge_hits_only_slash32s_to_known_nodes_off_our_adapters() {
        let gateway = v4(192, 0, 2, 1);
        let known = v4(203, 0, 113, 7);
        let stale = RouteRow::host(known, 14, gateway, 0);
        let stale_other_gateway = RouteRow::host(known, 9, v4(198, 18, 5, 1), 0);
        let unknown = RouteRow::host(v4(198, 51, 100, 9), 14, gateway, 0);
        let on_ours = RouteRow::host(known, 30, v4(10, 8, 0, 1), 0);
        let wider = RouteRow { dest: known, prefix: 31, if_index: 14, next_hop: gateway, metric: 0 };
        let rows = [stale, unknown, on_ours, wider, stale_other_gateway];

        assert_eq!(stale_node_routes(&rows, &[known], &[30]), vec![stale, stale_other_gateway]);
        assert!(stale_node_routes(&rows, &[], &[30]).is_empty(), "nothing known, nothing taken");
    }

    #[test]
    fn host_routes_on_one_interface_are_only_the_slash32s_there() {
        let gateway = v4(192, 0, 2, 1);
        let rows = [
            RouteRow::host(v4(203, 0, 113, 7), 14, gateway, 1),
            RouteRow::host(v4(203, 0, 113, 8), 9, gateway, 1),
            RouteRow { dest: v4(10, 0, 0, 0), prefix: 8, if_index: 14, next_hop: gateway, metric: 1 },
        ];
        assert_eq!(host_routes_on(&rows, 14), vec![rows[0]]);
    }

    /// The identity a delete is matched by. A different next hop is a
    /// different route -- someone else's, possibly -- while a different
    /// metric is the same route read back.
    #[test]
    fn the_same_route_ignores_the_metric_and_nothing_else() {
        let a = RouteRow::host(v4(203, 0, 113, 7), 14, v4(192, 0, 2, 1), 1);
        assert!(a.same_route(&RouteRow { metric: 35, ..a }));
        assert!(!a.same_route(&RouteRow { next_hop: v4(192, 0, 2, 254), ..a }));
        assert!(!a.same_route(&RouteRow { if_index: 9, ..a }));
        assert!(!a.same_route(&RouteRow { prefix: 31, ..a }));
    }

    #[test]
    fn masks_are_the_ones_route_exe_expects() {
        let row = |prefix| RouteRow { dest: v4(0, 0, 0, 0), prefix, if_index: 1, next_hop: v4(0, 0, 0, 0), metric: 1 };
        assert_eq!(row(32).mask(), v4(255, 255, 255, 255));
        assert_eq!(row(1).mask(), v4(128, 0, 0, 0));
        assert_eq!(row(0).mask(), v4(0, 0, 0, 0));
        assert_eq!(row(24).mask(), v4(255, 255, 255, 0));
    }

    /// The native reader against the one `routing` already proves against
    /// `Get-NetRoute`: the loopback interface's routes, read both ways.
    /// Loopback because every machine has it and reading it needs no
    /// elevation. Nothing is changed.
    #[test]
    fn the_system_table_reads_what_the_interface_reader_reads() {
        let mut rows: Vec<String> = SystemRoutes
            .rows()
            .expect("the table should read")
            .iter()
            .filter(|r| r.if_index == 1)
            .map(|r| format!("{}/{}", r.dest, r.prefix))
            .collect();
        let mut by_interface = super::super::routing::interface_routes(1);
        rows.sort();
        rows.dedup();
        by_interface.sort();
        by_interface.dedup();
        assert!(!rows.is_empty(), "loopback always carries routes");
        assert_eq!(rows, by_interface);
    }

    #[test]
    fn deleting_on_interface_zero_is_refused_rather_than_matched() {
        let row = RouteRow::host(v4(203, 0, 113, 7), 0, v4(192, 0, 2, 1), 1);
        assert!(SystemRoutes.delete(&row).is_err());
    }

    /// The recording table behaves as Windows does on the two points the
    /// tests above it rely on: an identical route is refused, and a
    /// delete of a route that is not there succeeds.
    #[test]
    fn the_fake_table_refuses_a_duplicate_and_forgives_a_missing_delete() {
        let row = RouteRow::host(v4(203, 0, 113, 7), 14, v4(192, 0, 2, 1), 1);
        let table = fake::FakeRoutes::with(&[row]);
        assert!(table.add(&row).is_err());
        assert!(table.delete(&row).is_ok());
        assert!(table.delete(&row).is_ok());
        assert!(table.table().is_empty());
    }
}

#[cfg(test)]
mod ledger_tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neoconnect-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn route(last: u8) -> RouteRow {
        RouteRow::host(Ipv4Addr::new(203, 0, 113, last), 14, Ipv4Addr::new(192, 0, 2, 1), 1)
    }

    /// Owed routes survive the process -- which is the whole point of
    /// writing them down -- and are struck off one at a time.
    #[test]
    fn ledger_round_trips() {
        let dir = dir("round-trip");
        let first = OwedRoutes::in_dir(&dir);
        first.owe(route(7));
        first.owe(route(8));
        first.owe(route(7));

        // A second handle on the same directory, as the next life of the
        // service would open it.
        let later = OwedRoutes::in_dir(&dir);
        assert_eq!(later.read(), vec![route(7), route(8)], "owed once each, in order");

        later.settle(&route(7));
        assert_eq!(first.read(), vec![route(8)]);
        later.settle(&route(8));
        assert!(first.read().is_empty());
        assert!(!dir.join(OWED_FILE).exists(), "nothing owed leaves no file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing written yet, and something unreadable, both mean nothing
    /// owed -- and the ledger still works afterwards.
    #[test]
    fn missing_or_corrupt_ledger_reads_as_empty() {
        let dir = dir("corrupt");
        let owed = OwedRoutes::in_dir(&dir);
        assert!(owed.read().is_empty(), "no file is nothing owed");

        std::fs::write(dir.join(OWED_FILE), b"{ this is not a ledger").unwrap();
        assert!(owed.read().is_empty(), "an unreadable file is nothing owed, not a failure");

        owed.owe(route(9));
        assert_eq!(owed.read(), vec![route(9)], "a corrupt ledger is replaced, not appended to");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Thirty-two writers on one ledger at once, as the concurrent
    /// teardown tests produce: every route owed is read back, and every
    /// one settled is gone. A read-modify-write without the lock loses
    /// some of them.
    #[test]
    fn concurrent_owes_and_settles_lose_nothing() {
        let dir = dir("concurrent");
        let threads: Vec<_> = (0..32u8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || OwedRoutes::in_dir(&dir).owe(route(i)))
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let owed = OwedRoutes::in_dir(&dir);
        assert_eq!(owed.read().len(), 32, "a concurrent write lost an owed route");

        let threads: Vec<_> = (0..32u8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || OwedRoutes::in_dir(&dir).settle(&route(i)))
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert!(owed.read().is_empty(), "a concurrent settle was undone by another");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
