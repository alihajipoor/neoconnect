//! Custom mode: route only the selected applications through the tunnel.
//!
//! The mechanism here is scoped host routes, chosen after the original
//! design was tried and failed. That design diverted the target's packets
//! with WinDivert, source-NAT'd them to the tunnel address, and re-injected
//! them with `WINDIVERT_ADDRESS.Network.interface_id` set to the WireGuard
//! adapter. `WinDivertSend` reported success for every packet and the
//! server received none of them: with `Table = off` there is no route to
//! the tunnel, and Windows routes a re-injected packet by its own lookup
//! rather than treating `interface_id` as a forced egress.
//!
//! What does work, verified end to end against a real node: bring the
//! tunnel up with `Table = off` so it installs no routes and hijacks
//! nothing, then add a `/32` route per destination pointing at the tunnel.
//! Traffic to those destinations crosses the tunnel and everything else
//! keeps using the normal internet.
//!
//! Two limits of this layer, both deliberate:
//!
//! * Routes are per **destination**, not per application. If another app
//!   talks to the same address it is tunnelled too. That is acceptable for
//!   a destination only one app uses and is not acceptable in general,
//!   because browsers, streaming and social apps share CDN addresses --
//!   so per-app precision needs the proxy layer on top of this, not this
//!   alone.
//! * It only knows about destinations it has been told about. Learning
//!   them from the selected app's connections is the caller's job.

use std::collections::HashSet;
use std::net::Ipv4Addr;

use super::routing::add_host_route;

/// Metric 1 so these win against the physical interface's default route
/// for their specific destination without disturbing anything else.
const ROUTE_METRIC: u32 = 1;

/// The scoped routes currently steering traffic into the tunnel.
///
/// Records exactly what it added so teardown removes exactly that, even
/// after a partial failure -- a leftover route pointing at a tunnel that
/// no longer exists is a black hole for that destination, which looks to
/// the customer like one site being permanently broken.
pub struct SplitTunnelRoutes {
    tunnel_ip: Ipv4Addr,
    interface_index: u32,
    installed: HashSet<Ipv4Addr>,
}

impl SplitTunnelRoutes {
    pub fn new(tunnel_ip: Ipv4Addr, interface_index: u32) -> Self {
        Self { tunnel_ip, interface_index, installed: HashSet::new() }
    }

    /// Routes one destination through the tunnel. Idempotent: a
    /// destination already routed is a no-op rather than a duplicate
    /// route, because the same address is seen repeatedly as the app
    /// opens new connections to it.
    pub fn add(&mut self, destination: Ipv4Addr) -> Result<(), String> {
        if self.installed.contains(&destination) {
            return Ok(());
        }
        // Refused rather than routed: these would either do nothing or
        // break local networking, and a bug upstream that produced one
        // should be visible instead of silently applied.
        if destination.is_loopback() || destination.is_broadcast() || destination.is_unspecified() {
            return Err(format!("refusing to route {destination} through the tunnel"));
        }

        add_host_route(
            &destination.to_string(),
            &self.tunnel_ip.to_string(),
            self.interface_index,
            ROUTE_METRIC,
        )?;
        self.installed.insert(destination);
        Ok(())
    }

    /// How many destinations are currently routed. Used by the caller to
    /// decide whether Custom mode is actually doing anything.
    pub fn len(&self) -> usize {
        self.installed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.installed.is_empty()
    }

    pub fn contains(&self, destination: &Ipv4Addr) -> bool {
        self.installed.contains(destination)
    }

    /// Best-effort teardown. A route that has already gone -- because the
    /// adapter disappeared with the engine -- is not a failure worth
    /// reporting; what matters is that none are left behind.
    pub fn remove_all(&mut self) {
        for destination in self.installed.drain() {
            let _ = super::routing::delete_host_route(&destination.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> SplitTunnelRoutes {
        SplitTunnelRoutes::new(Ipv4Addr::new(10, 66, 0, 99), 59)
    }

    #[test]
    fn refuses_addresses_that_would_break_local_networking() {
        // Routing loopback through a VPN would break every local service
        // on the machine, and it can only ever arrive here through a bug
        // upstream -- so it should surface, not be quietly applied.
        let mut routes = manager();
        assert!(routes.add(Ipv4Addr::LOCALHOST).is_err());
        assert!(routes.add(Ipv4Addr::UNSPECIFIED).is_err());
        assert!(routes.add(Ipv4Addr::BROADCAST).is_err());
        assert!(routes.is_empty(), "nothing should have been recorded");
    }

    #[test]
    fn a_refused_destination_is_not_recorded() {
        // If it were recorded, teardown would try to delete a route that
        // was never added, and -- worse -- a later legitimate attempt at
        // the same address would be skipped as already-present.
        let mut routes = manager();
        let _ = routes.add(Ipv4Addr::LOCALHOST);
        assert!(!routes.contains(&Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn teardown_empties_the_record() {
        let mut routes = manager();
        routes.installed.insert(Ipv4Addr::new(1, 1, 1, 1));
        routes.installed.insert(Ipv4Addr::new(8, 8, 8, 8));
        assert_eq!(routes.len(), 2);

        routes.remove_all();

        // Empty even though the underlying deletes are best-effort: the
        // record must not keep entries the manager will never retry, or
        // a reconnect would believe they are still installed.
        assert!(routes.is_empty());
    }
}
