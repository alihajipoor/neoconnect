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

use super::run_hidden;

/// Routes installed for the current tunnel, removed on drop-equivalent
/// (an explicit `remove()` call from disconnect).
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
pub fn purge_interface(interface_index: u32) {
    // PowerShell rather than route.exe because this has to enumerate
    // first, and `route print` is localised -- parsing it in Turkish or
    // Persian is how this would quietly stop working for exactly the
    // customers who matter. Get-NetRoute returns objects, so it does not
    // care what language the machine speaks.
    let script = format!(
        "Get-NetRoute -InterfaceIndex {interface_index} -AddressFamily IPv4          -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false          -ErrorAction SilentlyContinue"
    );
    let _ = run_hidden(
        &PathBuf::from("powershell"),
        &[
            OsStr::new("-NoProfile"),
            OsStr::new("-NonInteractive"),
            OsStr::new("-Command"),
            OsStr::new(&script),
        ],
    );
}

/// The IPv4 routes currently on one interface, as `destination/prefix`.
///
/// Destinations only, deliberately. This feeds the diagnostics snapshot
/// a customer pastes into a support ticket, and a route's *gateway* is
/// their own LAN address -- which says where they are and is no part of
/// answering "did Neoxify leave a route behind".
///
/// Best-effort: an interface that has gone, or a PowerShell that will
/// not run, reads as no routes. Callers use this to decide whether there
/// was anything to remove, never to promise there was not.
pub fn interface_routes(interface_index: u32) -> Vec<String> {
    // Same reasoning as `purge_interface`: `route print` is localised
    // and Get-NetRoute returns objects, so this does not depend on what
    // language the machine speaks.
    let script = format!(
        "Get-NetRoute -InterfaceIndex {interface_index} -AddressFamily IPv4 \
         -ErrorAction SilentlyContinue | ForEach-Object {{ $_.DestinationPrefix }}"
    );
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    let Ok(out) = super::capture_hidden(command, super::HELPER_BUDGET) else {
        return Vec::new();
    };
    out.stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
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
/// `split_tunnel::install_verified_route`.
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
