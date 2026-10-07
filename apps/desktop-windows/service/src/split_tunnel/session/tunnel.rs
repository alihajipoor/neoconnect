//! The tunnel a session runs over: waiting for its adapter, and the
//! route through it that a pinned socket can actually use.

use std::net::Ipv4Addr;
use std::path::Path;

use crate::adapters;
use crate::engines::routing::{self, InstalledRoutes};
use crate::split_tunnel::{health, net};

use crate::split_tunnel::log_file::append;

/// How long to wait for a tunnel adapter to appear and be given an
/// address after its engine starts.
///
/// The adapter and its address arrive separately, and a socket pinned to
/// an interface with no address of its own has nothing to use as a
/// source -- so both have to be there before the proxy is any use.
const ADAPTER_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The machine's IPv4 default routes, one line each.
///
/// `route print` rather than an API call because its data rows are
/// numbers and addresses in fixed columns -- readable regardless of the
/// Windows display language, which a parsed `netsh` heading would not
/// be. Only 0.0.0.0 destinations are kept: this is asked when a pinned
/// socket says a host is unreachable, and the default route is the one
/// that was supposed to carry it.
pub(super) fn default_routes() -> Vec<String> {
    let exe = std::path::PathBuf::from(r"C:\Windows\System32\route.exe");
    let Ok(out) = crate::engines::run_hidden_capture(&exe, &[std::ffi::OsStr::new("print"), std::ffi::OsStr::new("-4")])
    else {
        return vec!["could not read the routing table".to_string()];
    };
    out.lines()
        .map(str::trim)
        .filter(|line| line.starts_with("0.0.0.0"))
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}

/// Installs the passive default route in whichever shape the tunnel
/// actually works with.
///
/// Three rounds were spent predicting this and all three were wrong,
/// because the prediction is unfalsifiable from where it was made:
/// `route add` succeeds for both shapes, so an install that "worked"
/// tells you nothing about whether a socket can use it. WireGuard was
/// fine on on-link and every Xray and OpenVPN attempt failed with
/// WSAEHOSTUNREACH on the same machine, which is the signature of a
/// route the stack has but cannot resolve a next hop over.
///
/// So this stops predicting. It installs a shape, opens a real pinned
/// socket to a real host -- the same probe the ladder uses, over the
/// exact path a selected app's traffic takes -- and keeps the first
/// shape that carries it.
///
/// If none do, the first shape is reinstalled and the session continues.
/// That is deliberately no worse than the previous behaviour: the app's
/// own probe still decides whether to keep this protocol, and failing
/// the session here would turn a tunnel that works on a network where
/// the probe hosts happen to be blocked into a protocol that can never
/// be selected.
pub(super) fn install_verified_route(
    tunnel_address: Ipv4Addr,
    tunnel_index: u32,
    tunnel: &net::pin::TunnelInterface,
    log_path: &Path,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<InstalledRoutes, String> {
    let mut last_error = String::new();

    for shape in routing::PassiveRouteShape::ALL {
        // Each shape is probed against two targets at 3.5 seconds each,
        // so the pair of them is fourteen seconds of the bring-up. The
        // check sits at the top of the loop rather than inside the probe
        // because a connect that is over has no reason to try the second
        // shape at all -- and it is over for either reason: somebody
        // pressed Disconnect, or the first shape's fourteen seconds were
        // the last the connect had. Twenty-eight seconds of probing is
        // more than the whole budget, so without this the second shape
        // was work nobody would read the answer to.
        limits.check().map_err(|s| s.to_string())?;
        let mut installed =
            match routing::install_passive_default_shaped(tunnel_address, tunnel_index, shape) {
                Ok(installed) => installed,
                Err(e) => {
                    last_error = e;
                    continue;
                }
            };

        match health::probe(tunnel) {
            Ok(()) => {
                append(log_path, &format!("route {}: carries traffic", shape.label()));
                return Ok(installed);
            }
            Err(e) => {
                append(log_path, &format!("route {}: no traffic ({e})", shape.label()));
                last_error = e;
                installed.remove();
            }
        }
    }

    // Nothing carried, on either shape, to either probe target. Say so
    // with the state that would explain it -- and then refuse.
    //
    // This used to install the on-link shape anyway and carry on, and
    // that was the wrong call in the worst possible way. A tester's log
    // showed it happening against three different nodes in one sitting:
    //
    // ```text
    // route on-link: no traffic (8.8.8.8:443 timed out)
    // route via the tunnel address: no traffic (...)
    // no route shape carried traffic (...)
    // probe FAILED: the tunnel did not carry a test connection
    // ```
    //
    // Custom mode started every time. His chosen browser was then
    // redirected into a tunnel already proven dead, and when the engine
    // dropped, the deliberate fail-open sent it out on the ordinary
    // route -- so he watched his own address come back with Custom mode
    // switched on, and reported the feature as broken. It was not: the
    // tunnel was.
    //
    // Refusing turns that into a failed candidate, which the connect
    // ladder handles by trying the next protocol. Same reasoning as the
    // IKEv2 refusal above it: giving somebody an unprotected app while
    // the switch says otherwise is the same shape of lie as a false
    // "Connected", and it is worth a failed connection to avoid.
    append(log_path, &format!("no route shape carried traffic ({last_error})"));
    for line in default_routes() {
        append(log_path, &format!("  route  {line}"));
    }
    for line in adapter_diagnostics(tunnel_index) {
        append(log_path, &format!("  adapter  {line}"));
    }

    Err(format!(
        "Custom mode did not start: this tunnel is not carrying traffic ({last_error}).          Your chosen apps would have used the ordinary connection without telling you."
    ))
}

/// What the tunnel adapter actually looks like to Windows.
///
/// Logged only when every route shape has failed, because that is the
/// point at which the remaining question is about the adapter rather
/// than the routing table -- whether the address being bound is really
/// on it, and whether it is the kind of interface that needs a next hop
/// resolved at all.
fn adapter_diagnostics(index: u32) -> Vec<String> {
    match adapters::list() {
        Ok(list) => list
            .into_iter()
            .filter(|a| a.index == index)
            .map(|a| {
                format!(
                    "{} index {} ipv4 {:?}",
                    a.name, a.index, a.ipv4
                )
            })
            .collect(),
        Err(e) => vec![format!("could not enumerate adapters: {e}")],
    }
}

/// Waits for an adapter to exist *and* to have an address.
pub(super) fn wait_for_addressed_adapter(
    name: &str,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<adapters::Adapter, String> {
    // Ten seconds is this wait's own ceiling and the longest single one
    // in the bring-up; what the connect has left is the real bound, and
    // by the time the split tunnel starts the engines have already spent
    // most of it.
    let deadline = std::time::Instant::now() + limits.clamp(ADAPTER_WAIT);
    loop {
        // Up to ten seconds, and the longest single wait in the
        // bring-up. Uninterruptible before this.
        limits.check().map_err(|s| s.to_string())?;
        match adapters::find_by_name(name) {
            Ok(Some(adapter))
                if adapter
                    .ipv4
                    .is_some_and(|ip| net::pin::can_attach(adapter.index, ip))
                    || (adapter.ipv4.is_some() && std::time::Instant::now() >= deadline) =>
            {
                return Ok(adapter)
            }
            Ok(_) if std::time::Instant::now() < deadline => {}
            Ok(_) => {
                return Err(format!(
                    "the tunnel adapter ({name}) never came up with an address, so \
                     selected apps had nowhere to send their traffic"
                ))
            }
            Err(e) => return Err(format!("could not enumerate network adapters: {e}")),
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No adapter on any machine is called this, so the wait below can
    /// only end by cancellation or by running out of time.
    const NO_SUCH_ADAPTER: &str = "Neoxify-test-adapter-that-does-not-exist";

    /// The longest single wait in Custom mode's bring-up, up to ten
    /// seconds, must give way to a Disconnect. This is the path the
    /// rewrite notes list as untested: a split tunnel that ignored the
    /// abandon flag for its whole bring-up is how Disconnect once did
    /// nothing for thirty-eight seconds.
    #[test]
    fn a_cancelled_connect_stops_waiting_for_the_adapter() {
        let token = crate::lifecycle::cancel::CancelToken::new();
        let limits = crate::lifecycle::budget::Limits::new(token.clone(), std::time::Duration::from_secs(30));
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            token.cancel();
        });
        let began = std::time::Instant::now();
        let outcome = wait_for_addressed_adapter(NO_SUCH_ADAPTER, &limits);
        let took = began.elapsed();
        canceller.join().unwrap();
        assert!(outcome.is_err(), "a cancelled wait must not produce an adapter");
        assert!(took < std::time::Duration::from_secs(3), "the wait outlived its cancellation: {took:?}");
    }

    /// And it fits inside what the connect has left, not only inside its
    /// own ten-second ceiling -- the clamping the rewrite chose over
    /// lowering constants.
    #[test]
    fn the_adapter_wait_ends_when_the_connect_runs_out_of_time() {
        let limits = crate::lifecycle::budget::Limits::new(
            crate::lifecycle::cancel::CancelToken::new(),
            std::time::Duration::from_millis(400),
        );
        let began = std::time::Instant::now();
        let outcome = wait_for_addressed_adapter(NO_SUCH_ADAPTER, &limits);
        let took = began.elapsed();
        assert!(outcome.is_err());
        assert!(took < std::time::Duration::from_secs(3), "waited past the connect's budget: {took:?}");
    }
}
