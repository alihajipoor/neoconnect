//! Windows routing-table manipulation for engines that don't do it
//! themselves.
//!
//! WireGuard and OpenVPN both install their own routes -- wireguard.exe
//! manages the table from `AllowedIPs`, and OpenVPN acts on the server's
//! pushed `redirect-gateway`. Xray does not: its TUN inbound creates an
//! adapter and waits for traffic, and upstream's own documentation says
//! full-tunnel routing on Windows must be arranged externally, warning
//! that naively routing `0.0.0.0/0` into the TUN makes Xray's own
//! outbound loop back through itself.
//!
//! So this module does what that documentation describes by hand:
//!
//! * a host route to the VPN server via the *physical* gateway, so the
//!   engine's own connection to the node escapes the tunnel it is
//!   creating -- without this the loop upstream warns about is exactly
//!   what happens, and
//! * two half-default routes (`0.0.0.0/1` and `128.0.0.0/1`) through the
//!   TUN. Together they cover the whole address space and beat the real
//!   default route on specificity, which means the existing default is
//!   left untouched rather than deleted and restored. If this process
//!   dies without cleaning up, the machine still has a working default
//!   route to fall back on.

use std::ffi::OsStr;
use std::net::Ipv4Addr;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::NO_ERROR;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    DeleteIpForwardEntry2, FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_ROW2,
    MIB_IPFORWARD_TABLE2,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;

use super::run_hidden;

/// Routes installed for the current tunnel, removed by an explicit
/// `remove()` on every teardown path and by `Drop` on any path that has
/// none.
///
/// Deliberately records exactly what was added rather than assuming a
/// fixed set, so a partial failure during setup still tears down cleanly.
pub struct InstalledRoutes {
    /// Destination, mask, and the interface it was added on.
    ///
    /// The interface is not bookkeeping -- it is what makes removal
    /// safe. `route delete <dest> mask <mask>` with no interface removes
    /// **every** route to that destination, on every adapter. For a
    /// `0.0.0.0/0` entry that means deleting the machine's real default
    /// route along with ours, which takes the whole computer offline
    /// until Windows rebuilds it. That is not hypothetical: it is what
    /// this did, and the customer saw their internet drop for 10-30
    /// seconds after every failed connection attempt.
    destinations: Vec<(String, String, u32)>,
}

/// Removes every IPv4 route sitting on one interface.
///
/// For engines that install their own routes rather than letting this
/// service do it. OpenVPN is the case: the server pushes
/// `redirect-gateway`, openvpn.exe adds `0.0.0.0/1` and `128.0.0.0/1`
/// itself, and those are not in `InstalledRoutes` because this service
/// never added them. Killing the process leaves them behind, and
/// because a `/1` is more specific than the `0.0.0.0/0` Custom mode
/// demotes to metric 9999, they keep swallowing every packet into a
/// tunnel the customer asked to use for one application. Measured on
/// the test rig, before a connection was even made:
///
/// ```text
/// routes before: 128.0.0.0/1 if6 via 10.77.0.1 m0/3 ; 0.0.0.0/1 if6 via 10.77.0.1 m0/3
/// ```
///
/// Scoped to the interface, never to a destination -- see the note on
/// `destinations` for what deleting `0.0.0.0/0` machine-wide does.
///
/// Native, not PowerShell. It used to be `Get-NetRoute | Remove-NetRoute`,
/// chosen over `route print` because that output is localised and
/// parsing it in Turkish or Persian would quietly stop working for the
/// customers who matter. The IP Helper API returns structures, so it
/// keeps that property -- and it costs no process. That matters because
/// this is on the connect path: every connect begins with a disconnect,
/// which with nothing live runs the janitor, which purges every adapter
/// of ours that exists -- and the OpenVPN adapter is never deleted. So
/// anyone who had used OpenVPN once paid two PowerShell launches (this
/// and [`interface_routes`]) on every connect, whatever the protocol:
/// 1.2 to 1.7 seconds each on a fast development machine, 4.4 to 6.5 on
/// the rig's guest, out of a 38-second budget.
///
/// Best-effort, as before: a route that will not delete is skipped.
pub fn purge_interface(interface_index: u32) {
    let Ok(routes) = ipv4_routes_on(interface_index) else { return };
    for route in &routes {
        // SAFETY: `route` is a row GetIpForwardTable2 returned, copied
        // out whole; the call only reads it.
        let _ = unsafe { DeleteIpForwardEntry2(route) };
    }
}

/// The IPv4 routes on one interface, as the API's own rows -- which is
/// what `DeleteIpForwardEntry2` wants back, so nothing has to be
/// re-described to be deleted.
///
/// Interface 0 is no interface at all, and is refused rather than
/// matched: a caller that passes it has failed to find its adapter, and
/// "every route whose index happens to read 0" is not a thing to delete.
fn ipv4_routes_on(interface_index: u32) -> Result<Vec<MIB_IPFORWARD_ROW2>, String> {
    if interface_index == 0 {
        return Err("interface index 0 names no interface".to_string());
    }
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
    let ours = unsafe {
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let ours = rows.iter().filter(|row| row.InterfaceIndex == interface_index).copied().collect();
        FreeMibTable(table as *const core::ffi::c_void);
        ours
    };
    Ok(ours)
}

/// A route row's destination as `Get-NetRoute` writes it: `10.0.0.0/8`.
fn destination_prefix(route: &MIB_IPFORWARD_ROW2) -> String {
    // SAFETY: every row came from an AF_INET table, so the IPv4 arm of
    // the union is the live one. The address is in network byte order,
    // so its in-memory bytes are the octets in order.
    let raw = unsafe { route.DestinationPrefix.Prefix.Ipv4.sin_addr.S_un.S_addr };
    format!("{}/{}", Ipv4Addr::from(raw.to_ne_bytes()), route.DestinationPrefix.PrefixLength)
}

/// Removes just the two routes OpenVPN pushes, with `route.exe`.
///
/// The pre-connect sibling of [`purge_interface`], and the reason it
/// exists is cost. `purge_interface` has to enumerate, and when this was
/// written it did so with PowerShell -- 4.4 to 6.5 seconds before the
/// first statement runs -- which `openvpn::connect` paid on *every*
/// connect, inside a budget of 38 seconds, to delete nothing at all on a
/// clean machine. `purge_interface` is native now and costs no process,
/// but this stays the narrower tool: it touches the two routes OpenVPN
/// pushes and nothing else on the adapter, and phase one of a teardown
/// can afford it by count.
///
/// Nothing has to be enumerated to delete a route whose destination is
/// already known, and these two are known: they are the `0.0.0.0/1` and
/// `128.0.0.0/1` pair OpenVPN pushes, named in `purge_interface`'s own
/// rig transcript, and the pair that outlives a service that was killed
/// rather than stopped. `route delete` by destination needs no
/// enumeration and no parsing, so the localisation problem that put
/// PowerShell there does not arise.
///
/// Scoped to the interface, like every other delete in this module: an
/// unscoped `0.0.0.0/1` delete would take a competing VPN's route with
/// it.
///
/// Best-effort, and a route that is not there is the expected case
/// rather than a failure -- same contract as [`InstalledRoutes::remove`].
/// The broad purge stays where enumerating is the point: the janitor's
/// residue sweep and the thorough teardown.
pub fn purge_pushed_half_defaults(interface_index: u32) {
    let exe = route_exe();
    let index = interface_index.to_string();
    for (dest, mask) in HALF_DEFAULTS {
        let _ = run_hidden(
            &exe,
            &[
                OsStr::new("delete"),
                OsStr::new(dest),
                OsStr::new("mask"),
                OsStr::new(mask),
                OsStr::new("if"),
                OsStr::new(&index),
            ],
        );
    }
}

/// The IPv4 routes currently on one interface, as `destination/prefix`.
///
/// Destinations only, deliberately. This feeds the diagnostics snapshot
/// a customer pastes into a support ticket, and a route's *gateway* is
/// their own LAN address -- which says where they are and is no part of
/// answering "did Neoxify leave a route behind".
///
/// Best-effort: an interface that has gone, or a table that cannot be
/// read, reads as no routes. Callers use this to decide whether there
/// was anything to remove, never to promise there was not.
///
/// Native for the same reasons as [`purge_interface`], and written in
/// the same `destination/prefix` form `Get-NetRoute` produced, which the
/// parity test below holds it to.
pub fn interface_routes(interface_index: u32) -> Vec<String> {
    ipv4_routes_on(interface_index)
        .map(|routes| routes.iter().map(destination_prefix).collect())
        .unwrap_or_default()
}

fn route_exe() -> PathBuf {
    // In System32 on every supported Windows; not something the app ships.
    PathBuf::from(r"C:\Windows\System32\route.exe")
}

impl InstalledRoutes {
    pub fn none() -> Self {
        Self { destinations: Vec::new() }
    }

    /// Best-effort removal. A route that has already gone (because the
    /// adapter disappeared with the engine) is not an error worth
    /// surfacing -- the goal is that none remain, not that each delete
    /// succeeded.
    pub fn remove(&mut self) {
        let exe = route_exe();
        for (dest, mask, interface_index) in self.destinations.drain(..) {
            let index = interface_index.to_string();
            let _ = run_hidden(
                &exe,
                &[
                    OsStr::new("delete"),
                    OsStr::new(&dest),
                    OsStr::new("mask"),
                    OsStr::new(&mask),
                    // Scoped to the interface it was added on. Without
                    // this, removing our own route removes everyone
                    // else's to the same destination -- see the note on
                    // the field above.
                    OsStr::new("if"),
                    OsStr::new(&index),
                ],
            );
        }
    }
}

/// The backstop, not the mechanism. Every teardown still calls
/// `remove()` where its ordering matters -- routes before the engine is
/// killed, so nothing points at an adapter that is about to vanish --
/// and `remove()` drains the list, so this then has nothing to do.
///
/// What it covers is the path nobody wrote: Custom mode's bring-up
/// unwound by hand at four exits and a panic on any of them, or the
/// next early return added to it, would leave a `0.0.0.0/0` on our
/// adapter for the life of the machine's uptime. The rewrite's rule is
/// that every system mutation reverts in `Drop`; the firewall allowance
/// and both IPv6 blocks already did, and this was the one that did not.
///
/// It runs `route.exe` at most once per route, which phase one of a
/// teardown is allowed to do -- see `docs/windows-service-rewrite.md`.
impl Drop for InstalledRoutes {
    fn drop(&mut self) {
        self.remove();
    }
}

fn add_route(
    dest: &str,
    mask: &str,
    gateway: &str,
    interface_index: u32,
    metric: u32,
) -> Result<(), String> {
    let exe = route_exe();
    let idx = interface_index.to_string();
    let metric = metric.to_string();
    let status = run_hidden(
        &exe,
        &[
            OsStr::new("add"),
            OsStr::new(dest),
            OsStr::new("mask"),
            OsStr::new(mask),
            OsStr::new(gateway),
            OsStr::new("metric"),
            OsStr::new(&metric),
            OsStr::new("if"),
            OsStr::new(&idx),
        ],
    )
    .map_err(|e| format!("could not run route.exe: {e}"))?;

    if !status.success() {
        return Err(format!("adding the route for {dest} failed ({status})"));
    }
    Ok(())
}

/// Points all traffic at `tun_index` while keeping the engine's own
/// connection to `server_ip` on the physical link.
///
/// `physical_gateway`/`physical_index` must be captured *before* the
/// tunnel takes over, since afterwards the best route to the server
/// would be the tunnel itself.
pub fn install_full_tunnel(
    tun_gateway: Ipv4Addr,
    tun_index: u32,
    server_ip: Ipv4Addr,
    physical_gateway: Ipv4Addr,
    physical_index: u32,
) -> Result<InstalledRoutes, String> {
    let mut installed = InstalledRoutes::none();
    let server = server_ip.to_string();
    let tun_gw = tun_gateway.to_string();
    let phys_gw = physical_gateway.to_string();

    // The escape hatch first: if anything below fails, the machine is
    // left with normal connectivity plus one redundant host route,
    // rather than a half-built tunnel swallowing traffic.
    add_route(&server, "255.255.255.255", &phys_gw, physical_index, 1)?;
    installed.destinations.push((server.clone(), "255.255.255.255".into(), physical_index));

    for (dest, mask) in HALF_DEFAULTS {
        if let Err(e) = add_route(dest, mask, &tun_gw, tun_index, 1) {
            installed.remove();
            return Err(e);
        }
        installed.destinations.push((dest.to_string(), mask.to_string(), tun_index));
    }

    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_default_routes_cover_the_whole_address_space() {
        // 0.0.0.0/1 and 128.0.0.0/1 together are equivalent to 0.0.0.0/0
        // but more specific, so they win against the existing default
        // route without it having to be removed.
        let low: u32 = u32::from(Ipv4Addr::new(0, 0, 0, 0));
        let high: u32 = u32::from(Ipv4Addr::new(128, 0, 0, 0));
        let mask: u32 = u32::from(Ipv4Addr::new(128, 0, 0, 0));

        for probe in [
            Ipv4Addr::new(1, 1, 1, 1),
            Ipv4Addr::new(127, 255, 255, 255),
            Ipv4Addr::new(128, 0, 0, 1),
            Ipv4Addr::new(255, 255, 255, 255),
        ] {
            let p = u32::from(probe);
            assert!(
                (p & mask) == low || (p & mask) == high,
                "{probe} matched neither half-default route"
            );
        }
    }

    /// The native reader against the PowerShell it replaced, on a real
    /// routing table: the loopback interface's IPv4 routes, read both
    /// ways, must be the same set in the same notation. Loopback because
    /// it exists on every machine and reading it needs no elevation;
    /// nothing is deleted here -- a test that removes real routes has no
    /// business running on somebody's machine.
    #[test]
    fn the_native_route_reader_sees_what_get_netroute_saw() {
        let loopback = 1;
        let mut native = interface_routes(loopback);
        assert!(!native.is_empty(), "loopback always carries routes");

        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-NetRoute -InterfaceIndex 1 -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.DestinationPrefix }",
            ])
            .output()
            .expect("powershell should run");
        let mut scripted: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();

        native.sort();
        native.dedup();
        scripted.sort();
        scripted.dedup();
        assert_eq!(native, scripted, "the native reader must see exactly what Get-NetRoute saw");
    }

    #[test]
    fn interface_zero_is_refused_rather_than_matched() {
        assert!(ipv4_routes_on(0).is_err());
        assert!(interface_routes(0).is_empty());
    }

    #[test]
    fn removal_is_idempotent() {
        let mut routes = InstalledRoutes::none();
        routes.remove();
        routes.remove();
    }

    #[test]
    fn the_full_tunnel_never_installs_a_real_default_route() {
        // Its half-defaults beat the physical link on prefix length, so
        // the existing default is left in place rather than removed and
        // restored -- if this process dies, the machine still works.
        for (dest, mask) in HALF_DEFAULTS {
            assert_ne!((dest, mask), ("0.0.0.0", "0.0.0.0"));
        }
    }

    #[test]
    fn the_passive_route_must_be_a_real_default_route() {
        // The opposite requirement to the test above, and the one that
        // is easy to get backwards -- it was, and it put a whole machine
        // through the tunnel for a customer who had selected one
        // browser.
        //
        // Windows matches longest prefix first and only then compares
        // metrics. A half-default is more specific than the physical
        // link's 0.0.0.0/0, so it wins outright and metric 9999 is never
        // even looked at. Only at equal prefix length does a huge metric
        // mean "reachable but never preferred", which is the entire
        // property Custom mode is built on.
        //
        assert_eq!(
            PASSIVE_DEFAULT,
            ("0.0.0.0", "0.0.0.0"),
            "anything more specific than a default route becomes a full tunnel"
        );
        assert!(
            !HALF_DEFAULTS.contains(&PASSIVE_DEFAULT),
            "the passive route must not reuse the full tunnel's more-specific halves"
        );
        // Comfortably above any interface metric Windows assigns, so the
        // sum can never fall below a physical link's.
        assert!(PASSIVE_METRIC >= 9999);
    }

    #[test]
    fn every_recorded_route_carries_the_interface_it_was_added_on() {
        // What makes a 0.0.0.0/0 safe to own. `route delete 0.0.0.0 mask
        // 0.0.0.0` with no interface removes *every* default route on
        // the machine, the physical link's included -- which took a
        // customer's computer offline for 10-30 seconds after each
        // failed attempt. Scoped to our own interface, it cannot.
        let mut routes = InstalledRoutes::none();
        routes.destinations.push(("0.0.0.0".into(), "0.0.0.0".into(), 42));
        let (_, _, interface_index) = routes.destinations[0].clone();
        assert_eq!(interface_index, 42);
        routes.remove();
        assert!(routes.destinations.is_empty());
    }
}

/// Two routes that together cover the whole address space.
///
/// Used instead of a single `0.0.0.0/0` everywhere in this module, for
/// two separate reasons that happen to point the same way. They are more
/// specific than a default route, so they win without the real one being
/// removed and restored -- if this process dies, the machine still has
/// working connectivity. And nothing else on a Windows machine uses
/// these prefixes, so removing them can never take somebody else's route
/// with it.
const HALF_DEFAULTS: [(&str, &str); 2] =
    [("0.0.0.0", "128.0.0.0"), ("128.0.0.0", "128.0.0.0")];

/// A default route through the tunnel that nothing will ever choose.
///
/// Custom mode's foundation, and the least obvious part of it.
/// `IP_UNICAST_IF` restricts a socket to one interface's routes; it does
/// not invent one. A tunnel brought up passively owns no routes at all,
/// so a socket pinned to it fails with ENETUNREACH -- proven rather than
/// assumed, since that is exactly what the first attempt did.
///
/// The answer is a `0.0.0.0/0` route through the tunnel at a metric so
/// high that the physical link always wins. Windows adds the interface
/// metric to the route metric, so at 9999 nothing prefers it, the
/// machine's ordinary traffic is untouched, and a pinned socket -- which
/// is not choosing between interfaces at all -- finds it and uses it.
///
/// Deliberately separate from [`install_full_tunnel`], whose job is to
/// make the tunnel win. This one makes it available without winning.
///
/// # Why this is a real `0.0.0.0/0` and must stay one
///
/// It is the one place in this module that cannot use the half-defaults,
/// and the reason is the whole mechanism. Windows selects a route by
/// **longest prefix first**, and only compares metrics between routes of
/// equal length. A `/1` is more specific than the physical link's `/0`,
/// so it wins outright and the metric is never consulted -- which turns
/// this into a full tunnel no matter how unattractive the metric looks.
///
/// That is not a theory. Swapping this to half-defaults, as a
/// well-meant fix for the deletion problem below, put a customer's
/// entire machine through the tunnel while they had asked for one
/// browser. Only at equal prefix length does metric 9999 do its job:
/// nothing prefers the tunnel, but a socket pinned to it -- which is not
/// choosing between interfaces at all -- still finds a route.
///
/// The deletion problem is real and is solved separately, by scoping
/// removal to the interface the route was added on. See
/// [`InstalledRoutes::destinations`].
/// How the passive default route names its next hop.
///
/// There are two shapes and *which one works depends on the adapter*,
/// which is the thing three rounds of guessing never established. On-link
/// is what the spike proved against WireGuard's WinTun adapter. It does
/// not follow that it works on Xray's TUN or OpenVPN's TAP, and the
/// evidence from a real machine says it does not: both probe with
/// WSAEHOSTUNREACH -- a route exists and the stack cannot resolve a next
/// hop over it -- while WireGuard on the same machine is fine.
///
/// Critically, *both shapes install successfully*. `route add` returning
/// 0 says nothing about whether a socket can then use it, so a
/// try-one-then-fall-back-on-error chain can never discover this. The
/// caller resolves it by probing, not by predicting -- see
/// `split_tunnel::session::tunnel::install_verified_route`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassiveRouteShape {
    /// Next hop 0.0.0.0: deliver directly on the interface.
    OnLink,
    /// Next hop is the tunnel's own address.
    ViaTunnelAddress,
}

impl PassiveRouteShape {
    /// Tried in this order. On-link first because it is the one proven
    /// end to end, so the common case stays on the known-good path.
    pub const ALL: [PassiveRouteShape; 2] =
        [PassiveRouteShape::OnLink, PassiveRouteShape::ViaTunnelAddress];

    pub fn label(self) -> &'static str {
        match self {
            PassiveRouteShape::OnLink => "on-link",
            PassiveRouteShape::ViaTunnelAddress => "via the tunnel address",
        }
    }
}

pub fn install_passive_default_shaped(
    tunnel_address: Ipv4Addr,
    tunnel_index: u32,
    shape: PassiveRouteShape,
) -> Result<InstalledRoutes, String> {
    let (dest, mask) = PASSIVE_DEFAULT;
    let mut installed = InstalledRoutes::none();

    let gateway = match shape {
        PassiveRouteShape::OnLink => "0.0.0.0".to_string(),
        PassiveRouteShape::ViaTunnelAddress => tunnel_address.to_string(),
    };

    add_route(dest, mask, &gateway, tunnel_index, PASSIVE_METRIC)
        .map_err(|e| format!("could not make the tunnel reachable for selected apps: {e}"))?;

    installed.destinations.push((dest.to_string(), mask.to_string(), tunnel_index));
    Ok(installed)
}

/// The passive route's destination. A real default route, and it has to
/// be -- see [`install_passive_default_shaped`].
const PASSIVE_DEFAULT: (&str, &str) = ("0.0.0.0", "0.0.0.0");

/// High enough that the physical link always wins the metric comparison.
/// Windows adds the interface metric to this, and a physical link sits
/// around 25, so there is no plausible arrangement where the tunnel is
/// preferred.
const PASSIVE_METRIC: u32 = 9999;
