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
    destinations: Vec<(String, String)>,
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
        for (dest, mask) in self.destinations.drain(..) {
            let _ = run_hidden(
                &exe,
                &[
                    OsStr::new("delete"),
                    OsStr::new(&dest),
                    OsStr::new("mask"),
                    OsStr::new(&mask),
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
    installed.destinations.push((server.clone(), "255.255.255.255".into()));

    for (dest, mask) in [("0.0.0.0", "128.0.0.0"), ("128.0.0.0", "128.0.0.0")] {
        if let Err(e) = add_route(dest, mask, &tun_gw, tun_index, 1) {
            installed.remove();
            return Err(e);
        }
        installed.destinations.push((dest.to_string(), mask.to_string()));
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
}

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
pub fn install_passive_default(
    tunnel_address: Ipv4Addr,
    tunnel_index: u32,
) -> Result<InstalledRoutes, String> {
    const METRIC: u32 = 9999;
    let mut installed = InstalledRoutes::none();

    // The tunnel's own address as next hop is what the Xray path already
    // does successfully. Point-to-point adapters are sometimes happier
    // with an unspecified next hop, so that is tried second rather than
    // failing the whole feature on a formality.
    let by_self =
        add_route("0.0.0.0", "0.0.0.0", &tunnel_address.to_string(), tunnel_index, METRIC);
    if by_self.is_err() {
        add_route("0.0.0.0", "0.0.0.0", "0.0.0.0", tunnel_index, METRIC)
            .map_err(|e| format!("could not make the tunnel reachable for selected apps: {e}"))?;
    }

    installed.destinations.push(("0.0.0.0".into(), "0.0.0.0".into()));
    Ok(installed)
}
