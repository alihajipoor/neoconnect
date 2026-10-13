//! Whether a tunnel adapter's address can be used yet, and asking Windows
//! not to make it wait.
//!
//! # What was measured
//!
//! On the VM, against the released 0.9.48 (journal, 2026-10-11, P0-A):
//! after a Stealth or Compatible connect, the tunnel adapter's IPv4
//! address sat in duplicate-address detection's *Tentative* state for
//! 3.06-3.55 s from when it was set -- until 1.6 to 2.8 s after the
//! connect had already returned. Every connection the machine opened in
//! that time failed at once with WSAEHOSTUNREACH (10065), 36 to 53 of them
//! per run, and the app's own first health checks waited out their whole
//! timeout. In each of the five runs with the window, the last failure and
//! the first success fell inside the same ~100 ms poll as the address
//! turning *Preferred*. Both adapters, `neoconnect0` and
//! `Neoxify-OpenVPN`, had `DadTransmits=3`. WireGuard's has 0, was never
//! Tentative, and had no such window.
//!
//! The cause was tested, not only correlated. With `DadTransmits=0` set
//! on `Neoxify-OpenVPN` before the connect, the address was never
//! Tentative, nothing failed, and the app's first health check passed
//! 0.82 s after the connect returned; with 3 put back, the window came
//! back (Tentative for 3.55 s, 53 failures).
//!
//! The prediction had been WSAEADDRNOTAVAIL (10049). It was 10065 in every
//! run -- a code that otherwise reads as a routing fault, and on these
//! adapters in their first seconds was this instead.
//!
//! # Why switching detection off loses nothing here
//!
//! Duplicate-address detection asks the adapter's own link whether
//! anyone else holds the address. The link of each of these adapters is
//! the tunnel, and its address is ours to choose (Xray) or the server's
//! to assign (OpenVPN). A LAN that happens to use the same addresses is a
//! different link, which this adapter's detection never probes. So on our
//! adapters it only costs the wait.
//!
//! # What this module does
//!
//! * [`quiet`] asks for `DadTransmits=0` and no router discovery on the
//!   adapter's IPv4 interface, before the address is set -- Xray's
//!   adapter after it appears and before `netsh` addresses it, OpenVPN's
//!   before openvpn.exe starts.
//! * [`wait_preferred`] then waits for the address to be Preferred,
//!   because asking is not the same as it having taken. Neither half has
//!   been run in a real connect of this code. What was measured is
//!   OpenVPN's adapter with the setting made by hand (above), and a Wintun
//!   adapter of the elevated test's own, addressed by `netsh` as Xray's is
//!   (`wintun_address_preferred_within_100ms_after_dad_zero`, in the VM:
//!   Tentative for 2.95 s at Windows' default, Preferred at the first look
//!   after [`quiet`]). Capped at [`PREFERRED_WAIT`], after which the
//!   connect carries on and says so in cleanup.log -- an address that is
//!   late is not a failed connect, and the app checks the tunnel itself
//!   before it shows anything.

use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::NO_ERROR;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIpInterfaceEntry, GetUnicastIpAddressTable, InitializeIpInterfaceEntry,
    SetIpInterfaceEntry, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_TABLE,
};
use windows_sys::Win32::Networking::WinSock::{
    IpDadStateDeprecated, IpDadStateDuplicate, IpDadStatePreferred, IpDadStateTentative, AF_INET,
    RouterDiscoveryDisabled,
};

/// How long the address gets to turn Preferred before the connect
/// carries on without it.
///
/// Above the longest Tentative measured, 3.55 s with `DadTransmits=3`, so
/// that if the request to switch detection off did not take, the wait
/// still covers the window rather than ending just before it does. On an
/// adapter where it did take, the first poll answers.
pub const PREFERRED_WAIT: Duration = Duration::from_secs(4);

/// How often the address is looked at while waiting.
const POLL: Duration = Duration::from_millis(50);

/// Where duplicate-address detection has got to with one address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dad {
    /// Still being checked. Windows will not use it as a source yet.
    Tentative,
    /// Someone else on the link holds it.
    Duplicate,
    /// Usable, but no longer preferred for new connections.
    Deprecated,
    /// Usable.
    Preferred,
    /// Anything else Windows reports.
    Invalid,
}

impl Dad {
    fn from_raw(raw: i32) -> Self {
        [
            (IpDadStateTentative, Dad::Tentative),
            (IpDadStateDuplicate, Dad::Duplicate),
            (IpDadStateDeprecated, Dad::Deprecated),
            (IpDadStatePreferred, Dad::Preferred),
        ]
        .into_iter()
        .find_map(|(value, state)| (value == raw).then_some(state))
        .unwrap_or(Dad::Invalid)
    }
}

/// One IPv4 address an interface holds, and its detection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Held {
    pub address: Ipv4Addr,
    pub dad: Dad,
}

/// Whether `expected` is on the interface and usable -- for Xray, whose
/// address is ours to choose.
///
/// Listed is not enough. Windows lists the address from the moment it is
/// set, Tentative included, and the wait this replaces returned on that.
pub fn address_ready(held: &[Held], expected: Ipv4Addr) -> bool {
    held.iter().any(|h| h.address == expected && h.dad == Dad::Preferred)
}

/// Whether the interface holds an address it can use that is not a
/// self-assigned link-local one -- for OpenVPN, whose address the server
/// pushes, so it is not known here in advance.
pub fn some_address_ready(held: &[Held]) -> bool {
    held.iter().any(|h| h.dad == Dad::Preferred && !h.address.is_link_local() && !h.address.is_unspecified())
}

/// The interface table and the address table, for one adapter -- a trait
/// so that what is asked of Windows can be checked against a recording.
pub trait InterfaceOps {
    /// The adapter's IPv4 interface row, as Windows reports it.
    fn ipv4_row(&self, index: u32) -> Result<MIB_IPINTERFACE_ROW, String>;
    /// Writes the row back.
    fn set_ipv4_row(&self, row: &MIB_IPINTERFACE_ROW) -> Result<(), String>;
    /// Every IPv4 address the adapter holds, with its detection state.
    fn ipv4_held(&self, index: u32) -> Result<Vec<Held>, String>;
}

/// The machine's own tables.
pub struct SystemInterfaces;

impl InterfaceOps for SystemInterfaces {
    fn ipv4_row(&self, index: u32) -> Result<MIB_IPINTERFACE_ROW, String> {
        // SAFETY: all-zero is a valid MIB_IPINTERFACE_ROW, and
        // InitializeIpInterfaceEntry only writes its defaults into it.
        let mut row: MIB_IPINTERFACE_ROW = unsafe { std::mem::zeroed() };
        unsafe { InitializeIpInterfaceEntry(&mut row) };
        row.Family = AF_INET;
        row.InterfaceIndex = index;
        // SAFETY: `row` is a live local with the family and index the
        // call keys by; it fills in the rest.
        let rc = unsafe { GetIpInterfaceEntry(&mut row) };
        if rc != NO_ERROR {
            return Err(format!("GetIpInterfaceEntry failed for interface {index} ({rc})"));
        }
        Ok(row)
    }

    fn set_ipv4_row(&self, row: &MIB_IPINTERFACE_ROW) -> Result<(), String> {
        let mut row = *row;
        // SAFETY: `row` is a complete row read back from Windows; the call
        // only reads it, though its signature takes it mutably.
        let rc = unsafe { SetIpInterfaceEntry(&mut row) };
        if rc != NO_ERROR {
            return Err(format!("SetIpInterfaceEntry failed for interface {} ({rc})", row.InterfaceIndex));
        }
        Ok(())
    }

    fn ipv4_held(&self, index: u32) -> Result<Vec<Held>, String> {
        let mut table: *mut MIB_UNICASTIPADDRESS_TABLE = std::ptr::null_mut();
        // SAFETY: `table` is an out parameter the call fills with a buffer
        // it allocates, freed below with the matching FreeMibTable.
        let rc = unsafe { GetUnicastIpAddressTable(AF_INET, &mut table) };
        if rc != NO_ERROR || table.is_null() {
            return Err(format!("GetUnicastIpAddressTable failed ({rc})"));
        }
        // SAFETY: on success `table` points at a header followed by
        // `NumEntries` rows, valid until FreeMibTable. Every row is
        // AF_INET, so the IPv4 arm of the address union is the live one,
        // and its bytes in memory are the octets in order.
        let held = unsafe {
            let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
            let held = rows
                .iter()
                .filter(|row| row.InterfaceIndex == index)
                .map(|row| Held {
                    address: Ipv4Addr::from(row.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes()),
                    dad: Dad::from_raw(row.DadState),
                })
                .collect();
            FreeMibTable(table as *const core::ffi::c_void);
            held
        };
        Ok(held)
    }
}

/// The row with detection off and router discovery off, and nothing else
/// changed.
///
/// The same two settings wireguard-windows makes on its own adapter
/// (`tunnel/addressconfig.go`), which matches the `DadTransmits=0` P0-A
/// read on WireGuard's.
///
/// `SitePrefixLength` is zeroed because Windows can report one for IPv4
/// that `SetIpInterfaceEntry` then refuses with ERROR_INVALID_PARAMETER;
/// wireguard-windows' `winipcfg` clears it on read for the same reason.
pub fn without_dad(mut row: MIB_IPINTERFACE_ROW) -> MIB_IPINTERFACE_ROW {
    row.DadTransmits = 0;
    row.RouterDiscoveryBehavior = RouterDiscoveryDisabled;
    row.SitePrefixLength = 0;
    row
}

/// Whether the row already has detection and router discovery off.
fn is_quiet(row: &MIB_IPINTERFACE_ROW) -> bool {
    row.DadTransmits == 0 && row.RouterDiscoveryBehavior == RouterDiscoveryDisabled
}

/// Asks Windows not to run duplicate-address detection or router
/// discovery on one of our adapters' IPv4 interface.
///
/// Read and written back whole, because that is the only way the API
/// takes a change; anything that wrote the same row between the two
/// calls would be undone. Nothing of ours does, and the two calls are
/// back to back. An adapter that already has both off is not written to.
pub fn quiet(ops: &dyn InterfaceOps, index: u32) -> Result<(), String> {
    let row = ops.ipv4_row(index)?;
    if is_quiet(&row) {
        return Ok(());
    }
    ops.set_ipv4_row(&without_dad(row))
}

/// How a wait for a Preferred address ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Waited {
    Preferred,
    /// The cap passed first; what the adapter held at the last look.
    StillTentative(Vec<Held>),
    /// The adapter's addresses could not be read at all.
    Unreadable(String),
    /// Somebody pressed Disconnect.
    Abandoned,
}

/// Waits until `ready` says the adapter's addresses are usable, for at
/// most `cap` (and never past what the connect has left).
pub fn wait_preferred(
    ops: &dyn InterfaceOps,
    index: u32,
    ready: impl Fn(&[Held]) -> bool,
    cap: Duration,
    limits: &crate::lifecycle::budget::Limits,
) -> Waited {
    let deadline = Instant::now() + limits.clamp(cap);
    loop {
        let held = match ops.ipv4_held(index) {
            Ok(held) => held,
            Err(why) => return Waited::Unreadable(why),
        };
        if ready(&held) {
            return Waited::Preferred;
        }
        if limits.cancelled() {
            return Waited::Abandoned;
        }
        if Instant::now() >= deadline {
            return Waited::StillTentative(held);
        }
        std::thread::sleep(POLL);
    }
}

/// [`wait_preferred`] as a connect wants it: carries on past an address
/// that is late or unreadable, saying so in cleanup.log, and stops only
/// for Disconnect.
pub fn settle(
    ops: &dyn InterfaceOps,
    index: u32,
    adapter: &str,
    ready: impl Fn(&[Held]) -> bool,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<(), String> {
    let started = Instant::now();
    match wait_preferred(ops, index, ready, PREFERRED_WAIT, limits) {
        Waited::Preferred => Ok(()),
        Waited::Abandoned => Err(super::ABANDONED.to_string()),
        Waited::StillTentative(held) => {
            crate::cleanup_log::note(
                "wait for the tunnel address to be usable",
                &format!(
                    "{adapter}: not usable after {} ms ({held:?}); carrying on",
                    started.elapsed().as_millis()
                ),
            );
            Ok(())
        }
        Waited::Unreadable(why) => {
            crate::cleanup_log::note("wait for the tunnel address to be usable", &format!("{adapter}: {why}"));
            Ok(())
        }
    }
}

/// [`quiet`] as a connect wants it: a refusal is written down and the
/// connect goes on to wait out detection instead.
pub fn quiet_or_note(ops: &dyn InterfaceOps, index: u32, adapter: &str) {
    if let Err(why) = quiet(ops, index) {
        crate::cleanup_log::note("switch off address detection on the tunnel adapter", &format!("{adapter}: {why}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use windows_sys::Win32::Networking::WinSock::RouterDiscoveryDhcp;

    const TUN: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);

    fn held(address: Ipv4Addr, dad: Dad) -> Held {
        Held { address, dad }
    }

    /// The window P0-A measured: the address is listed from the moment
    /// netsh sets it, but Windows will not use it until detection is done.
    /// Today's wait returned as soon as it was listed.
    #[test]
    fn tentative_address_is_not_ready() {
        assert!(!address_ready(&[held(TUN, Dad::Tentative)], TUN));
        assert!(address_ready(&[held(TUN, Dad::Preferred)], TUN));
        assert!(!address_ready(&[held(Ipv4Addr::new(169, 254, 3, 4), Dad::Preferred)], TUN), "another address");
        assert!(!address_ready(&[held(TUN, Dad::Duplicate)], TUN));
        assert!(!address_ready(&[], TUN));
    }

    /// OpenVPN's address is the server's to push, so any usable one will
    /// do -- but not a self-assigned link-local one, and not one still
    /// being checked.
    #[test]
    fn openvpn_address_is_ready_only_once_one_is_preferred() {
        let pushed = Ipv4Addr::new(10, 8, 0, 6);
        assert!(!some_address_ready(&[held(pushed, Dad::Tentative)]));
        assert!(!some_address_ready(&[held(Ipv4Addr::new(169, 254, 3, 4), Dad::Preferred)]));
        assert!(some_address_ready(&[held(Ipv4Addr::new(169, 254, 3, 4), Dad::Preferred), held(pushed, Dad::Preferred)]));
        assert!(!some_address_ready(&[]));
    }

    /// Records every row written, and serves addresses from a script: the
    /// n-th look gets the n-th entry, and the last entry from then on.
    struct Recording {
        row: MIB_IPINTERFACE_ROW,
        written: Mutex<Vec<MIB_IPINTERFACE_ROW>>,
        script: Vec<Vec<Held>>,
        looks: Mutex<usize>,
    }

    impl Recording {
        fn with_row(row: MIB_IPINTERFACE_ROW) -> Self {
            Self { row, written: Mutex::new(Vec::new()), script: vec![Vec::new()], looks: Mutex::new(0) }
        }
        fn with_script(script: Vec<Vec<Held>>) -> Self {
            Self { script, ..Self::with_row(windows_default(7)) }
        }
        fn looks(&self) -> usize {
            *self.looks.lock().unwrap()
        }
    }

    impl InterfaceOps for Recording {
        fn ipv4_row(&self, index: u32) -> Result<MIB_IPINTERFACE_ROW, String> {
            assert_eq!(index, self.row.InterfaceIndex, "asked about the wrong interface");
            Ok(self.row)
        }
        fn set_ipv4_row(&self, row: &MIB_IPINTERFACE_ROW) -> Result<(), String> {
            self.written.lock().unwrap().push(*row);
            Ok(())
        }
        fn ipv4_held(&self, _index: u32) -> Result<Vec<Held>, String> {
            let mut looks = self.looks.lock().unwrap();
            let entry = self.script[(*looks).min(self.script.len() - 1)].clone();
            *looks += 1;
            Ok(entry)
        }
    }

    /// An IPv4 interface row as Windows hands one back for a fresh Wintun
    /// adapter: detection on (3 probes), router discovery by DHCP, and a
    /// site prefix length Windows will not take back for IPv4.
    fn windows_default(index: u32) -> MIB_IPINTERFACE_ROW {
        // SAFETY: all-zero is a valid MIB_IPINTERFACE_ROW.
        let mut row: MIB_IPINTERFACE_ROW = unsafe { std::mem::zeroed() };
        row.Family = AF_INET;
        row.InterfaceIndex = index;
        row.DadTransmits = 3;
        row.RouterDiscoveryBehavior = RouterDiscoveryDhcp;
        row.SitePrefixLength = 64;
        row.NlMtu = 1500;
        row.Metric = 5;
        row.UseAutomaticMetric = 1;
        row.RetransmitTime = 1000;
        row
    }

    #[test]
    fn adapter_params_request_zero_dad_and_no_router_discovery() {
        let ops = Recording::with_row(windows_default(31));
        quiet(&ops, 31).unwrap();

        let written = ops.written.lock().unwrap();
        assert_eq!(written.len(), 1, "exactly one write of the interface row");
        let row = written[0];
        assert_eq!(row.Family, AF_INET);
        assert_eq!(row.InterfaceIndex, 31);
        assert_eq!(row.DadTransmits, 0, "detection off");
        assert_eq!(row.RouterDiscoveryBehavior, RouterDiscoveryDisabled, "router discovery off");
        assert_eq!(row.SitePrefixLength, 0, "Windows refuses an IPv4 row that carries one");
        // Everything else as Windows reported it.
        assert_eq!(row.NlMtu, 1500);
        assert_eq!(row.Metric, 5);
        assert_eq!(row.UseAutomaticMetric, 1);
        assert_eq!(row.RetransmitTime, 1000);
    }

    /// OpenVPN's adapter is kept between sessions, so from its second
    /// connect it already has both off and nothing need be written.
    #[test]
    fn an_adapter_already_quiet_is_not_written_to() {
        let mut row = windows_default(31);
        row.DadTransmits = 0;
        row.RouterDiscoveryBehavior = RouterDiscoveryDisabled;
        let ops = Recording::with_row(row);
        quiet(&ops, 31).unwrap();
        assert!(ops.written.lock().unwrap().is_empty());
    }

    fn limits() -> crate::lifecycle::budget::Limits {
        crate::lifecycle::budget::Limits::new(crate::lifecycle::cancel::CancelToken::new(), Duration::from_secs(60))
    }

    /// Tentative for three looks, then Preferred: the wait is still
    /// there at the fourth.
    #[test]
    fn the_wait_lasts_until_the_address_is_preferred() {
        let tentative = vec![held(TUN, Dad::Tentative)];
        let ops = Recording::with_script(vec![tentative.clone(), tentative.clone(), tentative, vec![held(TUN, Dad::Preferred)]]);
        let waited = wait_preferred(&ops, 7, |h| address_ready(h, TUN), Duration::from_secs(5), &limits());
        assert_eq!(waited, Waited::Preferred);
        assert_eq!(ops.looks(), 4, "returned before the address was usable");
    }

    /// An address that never turns usable: the wait ends at its cap and
    /// says what it last saw, rather than claiming the address is ready.
    #[test]
    fn the_wait_ends_at_its_cap_and_says_what_it_saw() {
        let ops = Recording::with_script(vec![vec![held(TUN, Dad::Tentative)]]);
        let started = Instant::now();
        let waited = wait_preferred(&ops, 7, |h| address_ready(h, TUN), Duration::from_millis(300), &limits());
        assert_eq!(waited, Waited::StillTentative(vec![held(TUN, Dad::Tentative)]));
        assert!(started.elapsed() >= Duration::from_millis(300), "gave up before its cap");
        assert!(started.elapsed() < Duration::from_secs(2), "ran past its cap");
    }

    /// Disconnect ends the wait, and is not mistaken for a late address.
    #[test]
    fn a_disconnect_ends_the_wait() {
        let ops = Recording::with_script(vec![vec![held(TUN, Dad::Tentative)]]);
        let token = crate::lifecycle::cancel::CancelToken::new();
        token.cancel();
        let limits = crate::lifecycle::budget::Limits::new(token, Duration::from_secs(60));
        assert_eq!(wait_preferred(&ops, 7, |h| address_ready(h, TUN), Duration::from_secs(5), &limits), Waited::Abandoned);
    }

    /// A Wintun adapter of our own for the elevated test below, with a
    /// session open on it so that its link is up, as Xray's is. Closing
    /// the adapter removes it, so dropping this removes the device even
    /// when the test fails part-way.
    struct TestAdapter {
        close_session: unsafe extern "system" fn(*mut core::ffi::c_void),
        close_adapter: unsafe extern "system" fn(*mut core::ffi::c_void),
        session: *mut core::ffi::c_void,
        adapter: *mut core::ffi::c_void,
        index: u32,
    }

    impl TestAdapter {
        fn create(name: &str) -> Self {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
            type Create = unsafe extern "system" fn(*const u16, *const u16, *const u8) -> *mut core::ffi::c_void;
            type Start = unsafe extern "system" fn(*mut core::ffi::c_void, u32) -> *mut core::ffi::c_void;
            type Close = unsafe extern "system" fn(*mut core::ffi::c_void);
            let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();

            let dll = std::env::var_os("NEOX_WINTUN_DLL").expect("set NEOX_WINTUN_DLL to the path of wintun.dll");
            // SAFETY: a NUL-terminated wide path that outlives the call;
            // the module is never freed, which a test process can afford.
            let module = unsafe { LoadLibraryW(wide(&dll).as_ptr()) };
            assert!(!module.is_null(), "could not load {dll:?}: {}", std::io::Error::last_os_error());
            // SAFETY: the documented exports of wintun.dll, none of which
            // passes a struct by value; a missing one is null and panics.
            let (create, start, end, close) = unsafe {
                let get = |export: &std::ffi::CStr| {
                    GetProcAddress(module, export.as_ptr() as *const u8).unwrap_or_else(|| panic!("{export:?} not exported"))
                };
                (
                    std::mem::transmute::<_, Create>(get(c"WintunCreateAdapter")),
                    std::mem::transmute::<_, Start>(get(c"WintunStartSession")),
                    std::mem::transmute::<_, Close>(get(c"WintunEndSession")),
                    std::mem::transmute::<_, Close>(get(c"WintunCloseAdapter")),
                )
            };
            let name_wide = wide(std::ffi::OsStr::new(name));
            let kind = wide(std::ffi::OsStr::new("Neoxify"));
            // SAFETY: NUL-terminated strings outliving the call; a null
            // GUID gives a fresh device, so nothing persisted for an
            // earlier one applies.
            let adapter = unsafe { create(name_wide.as_ptr(), kind.as_ptr(), std::ptr::null()) };
            assert!(!adapter.is_null(), "Wintun would not create {name}: {}", std::io::Error::last_os_error());
            // SAFETY: a live adapter handle; 4 MiB is a valid ring size.
            let session = unsafe { start(adapter, 0x40_0000) };
            let mut made = Self { close_session: end, close_adapter: close, session, adapter, index: 0 };
            assert!(!session.is_null(), "could not open a session on {name}");
            let deadline = Instant::now() + Duration::from_secs(10);
            made.index = loop {
                if let Ok(Some(found)) = crate::adapters::find_by_name(name) {
                    break found.index;
                }
                assert!(Instant::now() < deadline, "{name} never appeared");
                std::thread::sleep(Duration::from_millis(50));
            };
            made
        }

        /// Sets the address the way `xray::configure_address` does, and
        /// returns when netsh does.
        fn address(&self, name: &str, address: Ipv4Addr) {
            let status = std::process::Command::new(r"C:\Windows\System32\netsh.exe")
                .args(["interface", "ipv4", "set", "address", &format!("name={name}"), "static", &address.to_string(), "255.255.255.252"])
                .status()
                .expect("netsh ran");
            assert!(status.success(), "netsh could not address {name}: {status}");
        }
    }

    impl Drop for TestAdapter {
        fn drop(&mut self) {
            // SAFETY: both handles came from wintun.dll and are not used
            // again; ending the session before closing is its documented
            // order.
            unsafe {
                if !self.session.is_null() {
                    (self.close_session)(self.session);
                }
                (self.close_adapter)(self.adapter);
            }
        }
    }

    /// Every look at one address from the moment netsh returned until it
    /// was Preferred or `limit` passed: (milliseconds, state).
    fn watch(index: u32, address: Ipv4Addr, limit: Duration) -> Vec<(u128, Option<Dad>)> {
        let started = Instant::now();
        let mut looks = Vec::new();
        loop {
            let state = SystemInterfaces.ipv4_held(index).unwrap().into_iter().find(|h| h.address == address).map(|h| h.dad);
            looks.push((started.elapsed().as_millis(), state));
            if state == Some(Dad::Preferred) || started.elapsed() >= limit {
                return looks;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// On a real Wintun adapter, with Windows' own default and then with
    /// [`quiet`] first. Elevated, so run by hand:
    ///
    /// ```text
    /// set NEOX_WINTUN_DLL=C:\path\to\wintun.dll
    /// neoconnect_service-<hash>.exe --ignored --exact \
    ///   engines::readiness::tests::wintun_address_preferred_within_100ms_after_dad_zero --nocapture
    /// ```
    ///
    /// The control half has to see the window first -- an adapter left
    /// at the default Tentative after netsh returns -- or the second half
    /// would pass on a machine where there was nothing to switch off.
    /// Adds and removes two adapters named `Neoxify-DadControl` and
    /// `Neoxify-DadQuiet` with addresses in 198.18.0.8/29, clear of the
    /// tunnel's own 198.18.0.0/30.
    #[test]
    #[ignore = "needs elevation and wintun.dll (NEOX_WINTUN_DLL); adds and removes two adapters"]
    fn wintun_address_preferred_within_100ms_after_dad_zero() {
        let control_name = "Neoxify-DadControl";
        let control_address = Ipv4Addr::new(198, 18, 0, 9);
        let control = TestAdapter::create(control_name);
        let row = SystemInterfaces.ipv4_row(control.index).unwrap();
        println!("control: index {} DadTransmits {} RetransmitTime {} ms", control.index, row.DadTransmits, row.RetransmitTime);
        control.address(control_name, control_address);
        let looks = watch(control.index, control_address, Duration::from_secs(8));
        println!("control: first {:?}, last {:?}, {} looks", looks.first(), looks.last(), looks.len());
        assert_eq!(looks[0].1, Some(Dad::Tentative), "the control never showed the window, so this test proves nothing here");
        drop(control);

        let quiet_name = "Neoxify-DadQuiet";
        let quiet_address = Ipv4Addr::new(198, 18, 0, 13);
        let adapter = TestAdapter::create(quiet_name);
        quiet(&SystemInterfaces, adapter.index).expect("Windows took the row");
        let row = SystemInterfaces.ipv4_row(adapter.index).unwrap();
        println!("quiet: index {} DadTransmits {} RouterDiscovery {}", adapter.index, row.DadTransmits, row.RouterDiscoveryBehavior);
        assert_eq!(row.DadTransmits, 0);
        assert_eq!(row.RouterDiscoveryBehavior, RouterDiscoveryDisabled);
        adapter.address(quiet_name, quiet_address);
        let looks = watch(adapter.index, quiet_address, Duration::from_secs(8));
        println!("quiet: first {:?}, last {:?}, {} looks", looks.first(), looks.last(), looks.len());
        let (at, state) = *looks.last().unwrap();
        assert_eq!(state, Some(Dad::Preferred), "never usable");
        assert!(at < 100, "Preferred only after {at} ms");
        assert!(looks.iter().all(|(_, s)| *s != Some(Dad::Tentative)), "Tentative with detection off: {looks:?}");
    }
}
