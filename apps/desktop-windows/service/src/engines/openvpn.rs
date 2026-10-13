//! OpenVPN via the official openvpn.exe.
//!
//! The certificate/key material is written inline (`<ca>`/`<cert>`/
//! `<key>` blocks) rather than as separate files, so there is exactly
//! one file to write and, more importantly, exactly one file to delete
//! on disconnect -- private keys never end up scattered across the
//! config directory.
//!
//! `windows-driver wintun` makes OpenVPN use the same Wintun driver the
//! Xray engine already needs, so the installer ships one TUN driver
//! dependency instead of also dragging in tap-windows6.
//!
//! Note on safety: an `.ovpn` supports `up`/`down` script directives,
//! which is real command execution -- and this process is LocalSystem.
//! That is why every PEM here is structurally validated before it gets
//! this far (see `neoconnect_ipc::ConnectProfile::validate`); a
//! certificate that could close its own `<ca>` block and open a
//! directive would otherwise be a straightforward SYSTEM compromise.
//!
//! `script-security 2` is required, not chosen. OpenVPN configures the
//! adapter's address by invoking `netsh.exe`, and at level 0 that call
//! is refused -- the tunnel authenticates, imports its routes, opens the
//! adapter, and then dies with "command failed: disallowed by
//! script-security setting". Level 0 was originally set here as a second
//! layer behind the validation above; it turned out to disable the
//! engine entirely rather than harden it.
//!
//! Losing that layer is acceptable because the config is generated
//! wholly by this service from values that are structurally validated
//! first: there is no path by which a directive reaches this file. It
//! would not be acceptable if any part of the config were caller-supplied
//! text.

use std::ffi::{c_void, OsStr};
use std::net::Ipv4Addr;
use std::path::Path;
use std::process::Child;

use windows_sys::Win32::Foundation::FreeLibrary;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

use neoconnect_ipc::OpenvpnProfile;

use super::route_table::{new_host_routes, OwedRoutes, RouteOps, RouteRow};
use crate::adapters::Uplink;
use super::{
    confirm_started, routing, run_hidden_capture, run_hidden_capture_within, spawn_hidden,
    write_config, Engines,
};
use crate::adapters;

const CONFIG_FILE: &str = "neoconnect.ovpn";
pub(super) const LOG_FILE: &str = "openvpn.log";

/// The largest encapsulated packet this client will put on the wire,
/// counted the way `mssfix ... mtu` counts it: outer IP header included.
///
/// Not 1500. A tunnel sized for the link it is measured on is sized for
/// a lab; the links this product exists to work on are narrower than
/// that. 1400 is the value a home PPPoE or mobile path routinely comes
/// out at, and every path wider than 1400 carries a 1400-byte packet
/// perfectly well -- so this is chosen to be right on the bad link
/// rather than optimal on the good one.
///
/// The cost of being wrong in the safe direction is about 7% more
/// per-packet header overhead. The cost of being wrong in the other
/// direction is a tunnel that says "connected" and loads nothing.
const LINK_BUDGET: u16 = 1400;

/// What OpenVPN adds around each tunnelled packet on UDP with
/// AES-256-GCM: 20 IPv4 + 8 UDP + 4 opcode/peer-id + 4 packet id +
/// 16 GCM tag. Subtracted from the budget to get the tun's own MTU, so
/// a full-size packet from the tun still fits inside it.
const UDP_ENCAP_OVERHEAD: u16 = 52;

/// Name of the Wintun adapter OpenVPN binds to.
///
/// Distinct from the one Xray creates ("neoconnect0"), so the two
/// engines can never contend for the same adapter when switching
/// between them.
pub const ADAPTER_NAME: &str = "Neoxify-OpenVPN";

/// How long `tapctl.exe create` gets.
///
/// Not the ordinary [`super::HELPER_BUDGET`], because this is not an
/// ordinary helper: it installs a network device, which means the
/// PnP subsystem, a driver load, and NDIS binding the new adapter into
/// the stack. The comment above already says "creating an adapter is
/// slow"; the budget did not act on it, and on a machine where that
/// sentence is true the connect failed with "could not create the
/// OpenVPN network adapter" for no reason but the clock.
///
/// A long budget costs nothing in the ordinary case, because the
/// ordinary creation is quick: about a second, measured on a Windows 11
/// guest that already had the driver. It is not paid only once, though
/// -- see [`ensure_adapter`] for what deletes the adapter between
/// sessions.
const ADAPTER_CREATE_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

/// What OpenVPN prints when the tunnel is actually up.
///
/// Its own words, at the end of its own start-up sequence: the TLS
/// handshake done, `PUSH_REPLY` received and applied, the adapter
/// addressed and whatever routes it was told to add added. Nothing
/// earlier in the log means the tunnel carries anything.
const TUNNEL_UP_MARK: &str = "Initialization Sequence Completed";

/// How long OpenVPN gets to reach [`TUNNEL_UP_MARK`].
///
/// This exists because the service used to return as soon as the process
/// had survived 1.5s, which is a liveness check and was documented as
/// one -- but the callers treat it as "connected". Two things went wrong
/// downstream of that.
///
/// **Custom mode failed for a reason that had nothing to do with it.**
/// `Engines::connect_inner` starts the split tunnel the moment this
/// returns, and `split_tunnel::start` waits ten seconds for the adapter
/// to hold an address. On the rig, OpenVPN had not finished its
/// handshake by then, so Custom mode reported that the tunnel adapter
/// "never came up with an address" while OpenVPN was still perfectly
/// well coming up. That is the whole of the `split_tunnel_active` never
/// arriving.
///
/// **And a full tunnel was reported connected before its routes
/// existed.** The pushed routes arrive with `PUSH_REPLY`; a customer
/// told "Connected" a second after the process started was told
/// something the service had not checked, which this project treats as
/// a product fault rather than a rough edge.
///
/// The number is a ceiling on a poll, not a sleep -- a tunnel that comes
/// up in two seconds returns in two seconds. It is deliberately larger
/// than the app's own 45s `REPLY_TIMEOUT` would allow a connect to be:
/// a handshake still in progress at 50s is one the customer has already
/// been told about, and the point of the ceiling is that the *service*
/// does not sit on the `Engines` lock for ever, which is what
/// the caller's cancellation token and the 50ms poll below are really for.
const TUNNEL_UP_WITHIN: std::time::Duration = std::time::Duration::from_secs(75);

/// Makes sure a Wintun adapter exists for OpenVPN to attach to.
///
/// openvpn.exe does not create its own adapter the way wireguard.exe
/// does -- it looks for an existing free one and fails outright with
/// "All wintun adapters on this system are currently in use or disabled"
/// if none is available. tapctl.exe (shipped in OpenVPN's own MSI) is
/// the supported way to create one.
///
/// Left in place after disconnect rather than deleted: creating an
/// adapter churns the network stack, and a dormant Wintun adapter costs
/// nothing.
///
/// That does not make this a no-op after the first connect, which this
/// comment used to claim. Measured on a Windows 11 guest:
/// `Neoxify-OpenVPN` was present while disconnected and gone within a
/// second of an Xray protocol starting, every time. Nothing in this
/// service deletes it outside uninstall, so the likely culprit is the
/// orphan sweep Xray's `wintun.dll` runs when it creates its own adapter
/// -- likely, not proven: the sweep's log line in `xray.log` names
/// `neoconnect0 1`, not this adapter. Either way, any OpenVPN connect
/// that follows an Xray session creates the adapter again. It took about
/// a second each time there, which is why this is recorded rather than
/// worked around.
///
/// The creation gets [`ADAPTER_CREATE_BUDGET`] rather than the ordinary
/// helper budget; the listing keeps the ordinary one, because listing is
/// a read.
fn ensure_adapter(engines: &Engines) -> Result<(), String> {
    let tapctl = engines.engine_path("tapctl.exe")?;

    let existing = run_hidden_capture(&tapctl, &[OsStr::new("list")])
        .map_err(|e| format!("could not list network adapters: {e}"))?;
    if existing.lines().any(|line| line.contains(ADAPTER_NAME)) {
        return Ok(());
    }

    match create_adapter(engines, &tapctl) {
        Ok(()) => Ok(()),
        // The one failure worth a second attempt, and the reason is a
        // driver that is not there rather than a call that was too slow.
        //
        // `tapctl create --hwid wintun` asks the PnP subsystem for a
        // device whose driver is in the driver store. On a machine that
        // has never run a Wintun-based VPN, nothing has put it there --
        // and tapctl does not install it. It fails with `DiInstallDevice
        // failed, error 0xe0000203` and prints nothing, which this
        // function has always reported as "tapctl returned nothing".
        //
        // Measured on a clean Windows 11 guest against `main`: the
        // failure arrives in **6.7 seconds**. That is the whole point.
        // [`ADAPTER_CREATE_BUDGET`] is sixty, so no budget was ever
        // reached and no budget could ever have helped -- this is an
        // error returned promptly, not a slow call being cut off. It
        // looked like the same first-run timeout the other engines had
        // because it appeared in the same run and on the same kind of
        // machine, and it is not.
        //
        // What made it invisible: Xray's `wintun.dll` installs the
        // driver on first use, so the moment a customer connects with
        // REALITY once, OpenVPN works for ever after. Every developer
        // machine, and every rig guest that had run Xray, was in that
        // state. The rig runs that measured the budgets above put
        // `reality` before `ovpn` deliberately to get past this, which
        // recorded the dependency without removing it -- and nothing in
        // the product enforces that order, because a customer picks a
        // protocol, not an installation sequence. A customer whose
        // network only passes OpenVPN never runs Xray at all.
        Err(e) if looks_like_a_missing_driver(&e) => {
            install_wintun_driver(engines)
                // The original failure, not this one. If the driver
                // could not be installed then the connect failed for the
                // reason it first said it did, and replacing that with a
                // message about a DLL would send whoever reads it after
                // the wrong thing.
                .map_err(|why| format!("{e} (and the Wintun driver could not be installed: {why})"))?;
            create_adapter(engines, &tapctl)
        }
        Err(e) => Err(e),
    }
}

/// One `tapctl create`, with the budget and the empty-output check.
fn create_adapter(engines: &Engines, tapctl: &Path) -> Result<(), String> {
    let _ = engines;
    let created = run_hidden_capture_within(
        tapctl,
        &[
            OsStr::new("create"),
            OsStr::new("--hwid"),
            OsStr::new("wintun"),
            OsStr::new("--name"),
            OsStr::new(ADAPTER_NAME),
        ],
        ADAPTER_CREATE_BUDGET,
    )
    .map_err(|e| format!("could not create the OpenVPN network adapter: {e}"))?;

    // tapctl prints the new adapter's GUID on success and nothing on
    // failure, so an empty result means it didn't work even though the
    // process itself exited.
    if created.trim().is_empty() {
        return Err("could not create the OpenVPN network adapter (tapctl returned nothing)".into());
    }
    Ok(())
}

/// Whether a `tapctl create` failure is the one a driver install fixes.
///
/// Deliberately narrow. The retry below installs a network driver, which
/// is not something to do speculatively on every failure -- a budget
/// overrun, a refusal, or a name collision are all real failures that a
/// driver install would not touch and would only delay.
///
/// Two shapes qualify, and they are the same event seen from two sides:
/// tapctl printing nothing (what this function's caller turns into
/// "returned nothing"), and the SetupAPI code itself if it ever reaches
/// us. `0xe0000203` is `ERROR_NO_DRIVER_SELECTED` -- PnP looked for a
/// driver for the `wintun` hardware id and there was not one.
fn looks_like_a_missing_driver(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("returned nothing") || m.contains("0xe0000203") || m.contains("no driver")
}

/// Puts the Wintun driver in the driver store, by asking the Wintun DLL
/// we already ship to create an adapter and then closing it.
///
/// # Why this, rather than installing a driver package
///
/// `wintun.dll` carries the driver inside it and installs it on first
/// use -- that is how Xray gets one without the installer ever shipping
/// an `.inf`. So the driver is already on the customer's disk; nothing
/// here downloads or adds anything the product did not already have. All
/// this does is trigger the same install Xray would have triggered, at
/// the moment OpenVPN needs it instead of whenever the customer happens
/// to choose REALITY.
///
/// The adapter created here is a throwaway with its own name, closed
/// immediately. It is deliberately **not** `ADAPTER_NAME`: OpenVPN's
/// adapter is created by `tapctl` and left in place between sessions,
/// and two different mechanisms creating a device with one name is how
/// you get an orphan that neither of them will clean up.
///
/// # The FFI
///
/// Two functions, both taking and returning pointers and integers.
/// There is no struct in this interface, which is the whole reason it is
/// safe to bind by hand -- `ras.rs` is this project's scar from a packed
/// struct whose wrong layout matched on size and corrupted memory
/// anyway, and none of that risk is present here.
fn install_wintun_driver(engines: &Engines) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let dll = engines.engine_path("wintun.dll")?;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    type CreateAdapter = unsafe extern "system" fn(*const u16, *const u16, *const u8) -> *mut c_void;
    type CloseAdapter = unsafe extern "system" fn(*mut c_void);

    let dll_wide = wide(dll.as_os_str());
    // SAFETY: `dll_wide` is a NUL-terminated wide string that outlives
    // the call. A failure returns null and is checked.
    let module = unsafe { LoadLibraryW(dll_wide.as_ptr()) };
    if module.is_null() {
        return Err(format!(
            "could not load {} ({})",
            dll.display(),
            std::io::Error::last_os_error()
        ));
    }

    // SAFETY: `module` is a live module handle and both names are
    // NUL-terminated. A missing export returns null and is checked
    // before it is transmuted to a function pointer.
    let create = unsafe { GetProcAddress(module, c"WintunCreateAdapter".as_ptr() as *const u8) };
    let close = unsafe { GetProcAddress(module, c"WintunCloseAdapter".as_ptr() as *const u8) };
    let (Some(create), Some(close)) = (create, close) else {
        // SAFETY: `module` came from LoadLibraryW and is not used again.
        unsafe { FreeLibrary(module) };
        return Err("wintun.dll does not export the adapter functions".into());
    };
    // SAFETY: these are the documented signatures of the two exports,
    // neither of which passes a struct by value.
    let create: CreateAdapter = unsafe { std::mem::transmute(create) };
    // SAFETY: as above.
    let close: CloseAdapter = unsafe { std::mem::transmute(close) };

    let name = wide(std::ffi::OsStr::new(DRIVER_INSTALL_ADAPTER));
    let kind = wide(std::ffi::OsStr::new("Neoxify"));
    // SAFETY: both strings are NUL-terminated and outlive the call; a
    // null GUID asks Wintun to choose one, which is what we want for a
    // device that exists for a few milliseconds.
    let adapter = unsafe { create(name.as_ptr(), kind.as_ptr(), std::ptr::null()) };
    let outcome = if adapter.is_null() {
        Err(format!("Wintun would not create an adapter ({})", std::io::Error::last_os_error()))
    } else {
        // SAFETY: `adapter` is a live handle from `create` and is not
        // used again. Closing it removes the device; the driver it
        // installed on the way stays in the driver store, which is the
        // entire purpose of this function.
        unsafe { close(adapter) };
        Ok(())
    };

    // SAFETY: `module` came from LoadLibraryW and nothing above holds a
    // pointer into it past this point -- the two function pointers are
    // not used again.
    unsafe { FreeLibrary(module) };
    outcome
}

/// The name of the throwaway adapter created only to install the driver.
///
/// Distinct from [`ADAPTER_NAME`] and from Xray's `neoconnect0`, so that
/// a device this function fails to close cannot be mistaken for -- or
/// collide with -- an adapter either engine actually uses.
const DRIVER_INSTALL_ADAPTER: &str = "Neoxify-DriverSetup";

/// Removes the Wintun adapter this engine attaches to.
///
/// The opposite of [`ensure_adapter`], and deliberately *not* called on
/// disconnect -- creating an adapter churns the network stack, so a
/// dormant one is left in place between sessions (for as long as an Xray
/// session leaves it alone; see [`ensure_adapter`]).
///
/// Uninstall is the one moment where that reasoning inverts. An adapter
/// nothing created it can explain is left behind on a machine whose VPN
/// is gone: it shows up in the network connections list, it keeps
/// whatever routes were last installed on it alive, and there is no
/// longer any product on the machine that knows how to remove it. That
/// is a leftover a customer can only clear by hand, if they ever work
/// out what it is.
///
/// Best-effort: no adapter, no tapctl.exe, or a refusal all mean the
/// uninstall carries on.
pub fn delete_adapter(engines: &Engines) -> Result<(), String> {
    let tapctl = engines.engine_path("tapctl.exe")?;
    run_hidden_capture(
        &tapctl,
        &[OsStr::new("delete"), OsStr::new(ADAPTER_NAME)],
    )
    .map(|_| ())
    .map_err(|e| format!("could not remove the {ADAPTER_NAME} adapter: {e}"))
}

fn build_config(p: &OpenvpnProfile, passive: bool) -> Result<String, String> {
    let (host, port) = p
        .endpoint
        .rsplit_once(':')
        .ok_or_else(|| "endpoint must be host:port".to_string())?;

    // Only emitted when the server uses tls-crypt. Omitting it against a
    // server that does use it produces no error at all -- the server
    // cannot authenticate the control channel, so it drops the client's
    // packets and the log simply stops after the first send.
    let tls_crypt = match &p.tls_crypt_key {
        Some(key) => format!("<tls-crypt>\n{}\n</tls-crypt>\n", key.trim()),
        None => String::new(),
    };

    // Custom mode wants the tunnel up but routing nothing, so the
    // server's pushed `redirect-gateway` has to be ignored. `route-nopull`
    // is OpenVPN's own directive for exactly that: the tunnel and its
    // address still come up, no routes are installed, and the split
    // tunnel adds the one route it needs itself.
    let routing = if passive { "route-nopull\n" } else { "" };

    // Windows resolves names on every interface at once and takes the
    // first answer, so an ISP resolver can beat the tunnel's -- and in
    // Iran it answers filtered domains with an address that goes
    // nowhere. The customer sees "connected" while the sites they
    // installed a VPN for refuse to load.
    //
    // block-outside-dns is OpenVPN's own fix: it drops DNS leaving any
    // other adapter while the tunnel is up. Full tunnel only. In Custom
    // mode nothing is routed to the tunnel, and its filters would refuse
    // every lookup at the adapter it leaves by, before the redirect could
    // carry it in. Custom mode pins the machine's lookups with the NRPT
    // rule instead, once the redirect is up, as it does on every engine
    // (`Engines::start_split_tunnel`).
    //
    // Two tests asserted this before it was ever written, and could not
    // fail: the job that would have run them had never once got as far
    // as running a test.
    let dns = if passive { "" } else { "block-outside-dns\n" };

    // Custom mode keeps the server's address across OpenVPN's own restarts.
    //
    // A ping-restart looks `remote` up again unless told not to, through
    // the DNS Client like any other lookup. In Custom mode that lookup is
    // pinned to 1.1.1.1 by the NRPT rule and carried into the tunnel by
    // the redirect -- the tunnel that is down and restarting -- so it
    // times out, and with `resolv-retry infinite` OpenVPN never reconnects.
    // Only a server named by a hostname is exposed; the first lookup, at
    // connect, happens before the rule exists. A full tunnel is left as
    // it was.
    let keep_remote = if passive { "persist-remote-ip\n" } else { "" };

    // The tunnel's MTU, pinned, and the server's pushed value refused.
    //
    // This is the failure `MTU = 1420` in wireguard.rs already exists to
    // prevent, and OpenVPN had no equivalent at all. No node config sets
    // `tun-mtu`, so OpenVPN 2.6 pushes its own default of 1500 and the
    // client's tun comes up exactly as wide as the link underneath it.
    // Every full-size packet is then over the path MTU the moment
    // OpenVPN's ~52 bytes of UDP encapsulation go on -- and OpenVPN sets
    // DF on those datagrams, so the network drops them rather than
    // fragmenting.
    //
    // What makes it worth pinning rather than leaving to the network is
    // that the failure is size-dependent, not on/off. The handshake
    // completes, the adapter gets its address, ICMP crosses, DNS
    // answers -- and then anything carrying real data disappears. The
    // app is correctly reporting a tunnel that is up, and the customer
    // is looking at a browser that will not load a page.
    //
    // The three lines are one fix, and each covers a direction the
    // others cannot:
    //
    //   - `tun-mtu` bounds what this machine *sends*. The local stack
    //     will not put a packet larger than the tun's MTU into it, so
    //     this is what keeps our own uploads inside the budget.
    //   - `mssfix` bounds what the far end sends *back*. It rewrites the
    //     MSS option in the SYNs leaving through the tunnel, so remote
    //     servers never offer us segments too big to survive the return
    //     path. Set explicitly and in `mtu` units because its own
    //     default of 1492 is derived from a 1500-byte link -- which is
    //     the size that was black-holing.
    //   - `pull-filter` is what makes either of them stick. Without it
    //     the server's pushed 1500 simply replaces them.
    //
    // Non-TCP inner traffic is covered by `tun-mtu` outbound and, for
    // the return path, by the fact that nothing we carry generates
    // inbound datagrams larger than this: QUIC sizes its own at ~1200.
    //
    // Custom mode gets it too. The packets are the same size whether
    // one application is on the tunnel or all of them.
    let mtu = format!(
        "pull-filter ignore \"tun-mtu\"\n\
         tun-mtu {}\n\
         mssfix {} mtu\n",
        LINK_BUDGET - UDP_ENCAP_OVERHEAD,
        LINK_BUDGET,
    );

    Ok(format!(
        "client\n\
         {routing}\
         {mtu}\
         {dns}\
         dev tun\n\
         windows-driver wintun\n\
         dev-node {adapter}\n\
         proto {proto}\n\
         remote {host} {port}\n\
         resolv-retry infinite\n\
         nobind\n\
         persist-key\n\
         persist-tun\n\
         {keep_remote}\
         remote-cert-tls server\n\
         cipher AES-256-GCM\n\
         auth SHA256\n\
         verb 3\n\
         script-security 2\n\
         <ca>\n{ca}\n</ca>\n\
         <cert>\n{cert}\n</cert>\n\
         <key>\n{key}\n</key>\n\
         {tls_crypt}",
        adapter = ADAPTER_NAME,
        dns = dns,
        proto = p.proto,
        host = host,
        port = port,
        ca = p.ca_cert_pem.trim(),
        cert = p.cert_pem.trim(),
        key = p.key_pem.trim(),
        tls_crypt = tls_crypt,
    ))
}

/// The host routes openvpn.exe adds on the uplink, found by reading the
/// table before it starts and again once it says the tunnel is up.
///
/// openvpn.exe does not report what it routed, and its `redirect-gateway`
/// puts a host route to the server -- and with `bypass-dhcp`, one to the
/// DHCP server -- on the physical adapter, where nothing of ours would
/// otherwise ever remove it. See `InstalledRoutes::adopted`.
pub(super) struct HostRouteWatch {
    /// The table before openvpn.exe started. `None` when it could not be
    /// read, in which case nothing on the uplink can be told apart from
    /// the customer's own routes and only routes to the server itself
    /// are taken.
    before: Option<Vec<RouteRow>>,
    /// The adapter openvpn.exe's `net_gateway` is expected on, and the
    /// gateway itself.
    uplink: Option<Uplink>,
    /// The server's address, when the profile names it as one.
    remote: Option<Ipv4Addr>,
    /// The uplink's DHCP server, which `bypass-dhcp` routes around the
    /// tunnel, when its lease came from one.
    dhcp_server: Option<Ipv4Addr>,
    /// Our own adapters, whose routes are never the uplink's.
    ours: Vec<u32>,
}

impl HostRouteWatch {
    pub(super) fn begin(
        ops: &dyn RouteOps,
        uplink: Option<Uplink>,
        remote: Option<Ipv4Addr>,
        dhcp_server: Option<Ipv4Addr>,
        ours: Vec<u32>,
    ) -> Self {
        Self { before: ops.rows().ok(), uplink, remote, dhcp_server, ours }
    }

    /// Owes the routes openvpn.exe is about to add that can be named before
    /// it starts, and returns them. Called just before it is started.
    ///
    /// `redirect-gateway` adds the server's host route, and `bypass-dhcp`
    /// the DHCP server's, early in the connect, through the uplink's
    /// gateway. They used to be owed only once the connect returned, so a
    /// service killed, crashed or stopped in between left both with no
    /// record: the server's waited for the next connect's known-node
    /// purge, and the DHCP server's stayed until a reboot. Owed now, the
    /// janitor at the next start removes them like Xray's.
    ///
    /// Only what was not there before -- a route already on the table is
    /// not openvpn.exe's to add, and owing it would have a crash take the
    /// customer's -- and nothing when the table could not be read or the
    /// uplink is unknown. Keyed by the gateway the uplink was found
    /// through; openvpn.exe finds its own `net_gateway`, and where the two
    /// differ the route is owed under the wrong key and still only owed
    /// from the moment the connect returns, as before.
    pub(super) fn owe_ahead(&self, owed: &OwedRoutes) -> Vec<RouteRow> {
        let (Some(before), Some(uplink)) = (&self.before, self.uplink) else { return Vec::new() };
        let ahead: Vec<RouteRow> = [self.remote, self.dhcp_server]
            .into_iter()
            .flatten()
            .map(|dest| RouteRow::host(dest, uplink.index, uplink.next_hop, 0))
            .filter(|row| !before.iter().any(|old| old.same_route(row)))
            .collect();
        for row in &ahead {
            owed.owe(*row);
        }
        ahead
    }

    /// After a connect that came up: strikes off what was owed ahead and
    /// never added. What was added stays owed, and the session owns it.
    pub(super) fn settle_unused(owed: &OwedRoutes, ahead: &[RouteRow], added: &[RouteRow]) {
        for row in ahead.iter().filter(|row| !added.iter().any(|a| a.same_route(row))) {
            owed.settle(row);
        }
    }

    /// After a connect that failed, when openvpn.exe has ended and no
    /// session will exist to remove anything: deletes what it added and
    /// what was owed ahead, each struck off once gone and owed until then,
    /// so one that will not delete is the next start's to remove.
    pub(super) fn give_back(ops: &dyn RouteOps, owed: &OwedRoutes, ahead: &[RouteRow], added: &[RouteRow]) {
        let unadded = ahead.iter().filter(|row| !added.iter().any(|a| a.same_route(row)));
        for row in added.iter().chain(unadded) {
            owed.owe(*row);
            if ops.delete(row).is_ok() {
                owed.settle(row);
            }
        }
    }

    /// What was added since [`Self::begin`]: new host routes added through
    /// `NETMGMT` on the uplink through its gateway (`new_host_routes`), and
    /// any new one added that way to the server on an adapter that is not
    /// ours. The second is a guard on the first -- if the uplink was
    /// guessed wrongly, the route that matters most is still found.
    pub(super) fn added(&self, ops: &dyn RouteOps) -> Vec<RouteRow> {
        let Ok(after) = ops.rows() else { return Vec::new() };
        let mut added = match (&self.before, self.uplink) {
            (Some(before), Some(uplink)) => new_host_routes(before, &after, uplink.index, uplink.next_hop),
            _ => Vec::new(),
        };
        let before = self.before.as_deref().unwrap_or(&[]);
        if let Some(remote) = self.remote {
            let to_server = |r: &&RouteRow| r.is_host() && r.netmgmt && r.dest == remote && !self.ours.contains(&r.if_index);
            for row in after.iter().filter(to_server) {
                let known = before.iter().chain(added.iter()).any(|old| old.same_route(row));
                if !known {
                    added.push(*row);
                }
            }
        }
        added
    }
}

/// Brings OpenVPN up, and returns it with the host routes it added on
/// the uplink for the session to own.
pub fn connect(
    engines: &Engines,
    profile: &OpenvpnProfile,
    passive: bool,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<(Child, Vec<RouteRow>), String> {
    let exe = engines.engine_path("openvpn.exe")?;
    engines.engine_path("wintun.dll")?;
    ensure_adapter(engines)?;

    // Anything left on this adapter from a previous run goes now.
    // Teardown purges these too, but a service that was killed rather
    // than stopped never got to, and the pushed `0.0.0.0/1` and
    // `128.0.0.0/1` routes then outlive every later session -- silently
    // overriding Custom mode, because a /1 beats the demoted default.
    //
    // By destination rather than by enumeration. This used to call
    // `purge_interface`, which spawns PowerShell because enumerating is
    // what it is for -- so a connect on a clean machine paid 4.4 to 6.5
    // seconds, out of 38, to delete nothing. The two destinations are
    // known, `route.exe` deletes them without looking anything up, and
    // a route that is not there is the expected case.
    //
    // And address detection off, before openvpn.exe addresses the
    // adapter: an address is checked under the setting it was added with,
    // and that check was the 1.6-2.8 s after a Compatible connect in which
    // every connection failed. See `readiness`. The adapter is kept
    // between sessions, so from the second connect on it is already off
    // and nothing is written.
    let tunnel_index = adapters::find_by_name(ADAPTER_NAME).ok().flatten().map(|adapter| adapter.index);
    if let Some(index) = tunnel_index {
        routing::purge_pushed_half_defaults(index);
        super::readiness::quiet_or_note(&super::readiness::SystemInterfaces, index, ADAPTER_NAME);
    }

    let config_path = engines.config_path(CONFIG_FILE);
    write_config(&config_path, &build_config(profile, passive)?)?;

    let exe_dir = exe
        .parent()
        .ok_or_else(|| "could not resolve the engine directory".to_string())?;

    // Custom mode refuses the pushed routes (`route-nopull`), so there is
    // nothing to watch for.
    let watch = (!passive).then(|| {
        let remote = profile.endpoint.rsplit_once(':').and_then(|(host, _)| host.parse().ok());
        let uplink = super::uplink_toward(remote);
        let dhcp_server = uplink.and_then(|u| {
            adapters::list().ok()?.into_iter().find(|a| a.index == u.index)?.dhcp_server
        });
        HostRouteWatch::begin(&*engines.route_ops, uplink, remote, dhcp_server, super::our_interfaces())
    });

    let owed = engines.owed_routes();
    let ahead = watch.as_ref().map(|w| w.owe_ahead(&owed)).unwrap_or_default();
    let log_path = engines.config_path(LOG_FILE);
    let child = match spawn_hidden(
        &exe,
        &[OsStr::new("--config"), config_path.as_os_str()],
        exe_dir,
        &log_path,
    ) {
        Ok(child) => child,
        Err(e) => {
            HostRouteWatch::give_back(&*engines.route_ops, &owed, &ahead, &[]);
            return Err(format!("could not start openvpn.exe: {e}"));
        }
    };

    let up = confirm_started(child, "OpenVPN", &log_path)
        .and_then(|child| wait_until_up(child, &log_path, limits))
        .and_then(|child| wait_until_usable(child, tunnel_index, limits));
    let added = watch.map(|w| w.added(&*engines.route_ops)).unwrap_or_default();
    match up {
        Ok(child) => {
            HostRouteWatch::settle_unused(&owed, &ahead, &added);
            // No NRPT rule here. A full tunnel's DNS is the pushed one
            // behind `block-outside-dns`; Custom mode's rule goes in once
            // the redirect is up to carry the lookups
            // (`Engines::start_split_tunnel`). It used to go in here,
            // seconds before that, pinning them to 1.1.1.1 with nothing to
            // carry them.
            Ok((child, added))
        }
        Err(e) => {
            // openvpn.exe has ended on every path that reaches here, so
            // nothing is left to put these back -- and no session will
            // exist to remove them. A connect that is cancelled after the
            // pushed routes went in, but before OpenVPN said it was done,
            // used to leave them behind.
            HostRouteWatch::give_back(&*engines.route_ops, &owed, &ahead, &added);
            Err(e)
        }
    }
}

/// Waits until OpenVPN says its tunnel is up, rather than until it has
/// merely survived starting.
///
/// Polls three things, and every one of them can end the wait:
///
/// * the log reaching [`TUNNEL_UP_MARK`] -- success;
/// * the process exiting -- failure, with its own last words attached,
///   which is what turns "OpenVPN did not connect" into something a
///   customer or a support conversation can act on;
/// * the operation being abandoned -- somebody pressed Disconnect while
///   this was running, and that must not wait out the ceiling.
///
/// Reading the log is how the answer is obtained because it is the only
/// place OpenVPN states it. The adapter holding an address is a
/// consequence, not the event: it can be addressed before `PUSH_REPLY`
/// has been applied, so waiting on the address would go back to
/// reporting a tunnel that is not yet carrying anything.
fn wait_until_up(
    mut child: Child,
    log_path: &std::path::Path,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<Child, String> {
    // The ceiling stays a ceiling; the connect's remaining time is
    // what actually bounds this when it runs last. Reported below as
    // the budget that was really applied, because "did not connect
    // within 75s" after giving up at 20 is a lie to whoever reads it.
    let budget = limits.clamp(TUNNEL_UP_WITHIN);
    if budget.is_zero() {
        let _ = child.kill();
        super::reap(&mut child);
        return Err(super::OUT_OF_TIME.to_string());
    }
    let deadline = std::time::Instant::now() + budget;
    loop {
        let log = std::fs::read_to_string(log_path).unwrap_or_default();
        if log.contains(TUNNEL_UP_MARK) {
            return Ok(child);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "OpenVPN stopped before the tunnel came up ({status}): {}",
                    tail(&log)
                ));
            }
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                return Err(format!("could not check whether OpenVPN was still running: {e}"));
            }
        }
        if limits.cancelled() {
            let _ = child.kill();
            super::reap(&mut child);
            return Err(super::ABANDONED.to_string());
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            super::reap(&mut child);
            return Err(format!(
                "OpenVPN did not finish connecting within {}s: {}",
                budget.as_secs(),
                tail(&log)
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Once OpenVPN says it is up, waits until the address it gave the adapter
/// is one Windows will use.
///
/// OpenVPN's log line comes while the address is still being checked:
/// on 0.9.48 it stayed Tentative until 1.6-2.8 s after the connect had
/// returned. With detection switched off before the start this answers at
/// the first look; if that did not take, it waits for at most
/// `readiness::PREFERRED_WAIT` and then carries on, saying so in
/// cleanup.log. Only Disconnect fails it, and then openvpn.exe is stopped
/// here as `wait_until_up` stops it, so that the caller's arm for a failed
/// connect gives the routes back.
///
/// Any usable address, because the server pushes it and it is not known
/// here in advance -- see `readiness::some_address_ready`.
fn wait_until_usable(
    mut child: Child,
    tunnel_index: Option<u32>,
    limits: &crate::lifecycle::budget::Limits,
) -> Result<Child, String> {
    let index = tunnel_index.or_else(|| adapters::find_by_name(ADAPTER_NAME).ok().flatten().map(|a| a.index));
    let Some(index) = index else { return Ok(child) };
    match super::readiness::settle(
        &super::readiness::SystemInterfaces,
        index,
        ADAPTER_NAME,
        super::readiness::some_address_ready,
        limits,
    ) {
        Ok(()) => Ok(child),
        Err(e) => {
            let _ = child.kill();
            super::reap(&mut child);
            Err(e)
        }
    }
}

/// What OpenVPN logs each time it goes round again: a ping-restart after
/// the server went quiet, a TLS error, a reset connection -- every soft
/// or hard restart ends its line with this. Its last word on the link
/// until [`TUNNEL_UP_MARK`] follows it.
const RESTART_MARK: &str = "process restarting";

/// How much of the end of the log [`link_reading`] reads. At `verb 3` a
/// tunnel that is up logs next to nothing, so its last restart or
/// completion is well inside this; one that is not is logging little else.
const LOG_TAIL_BYTES: u64 = 16 * 1024;

/// What OpenVPN's own log says about its link, for Custom mode's DNS pin
/// (`dns::PinWatch`).
///
/// `No` while the last thing it logged about the link is a restart, and
/// `Unknown` otherwise. Never `Yes`: [`TUNNEL_UP_MARK`] is OpenVPN's word
/// that it set the tunnel up, not that anything has crossed it since --
/// what puts the pin back is the split tunnel's probe getting a reply.
pub(super) fn link_reading(log_tail: &str) -> super::dns::Carrying {
    match (log_tail.rfind(RESTART_MARK), log_tail.rfind(TUNNEL_UP_MARK)) {
        (Some(restart), Some(up)) if restart > up => super::dns::Carrying::No,
        (Some(_), None) => super::dns::Carrying::No,
        _ => super::dns::Carrying::Unknown,
    }
}

/// The end of the session's log, as [`link_reading`] wants it: the last
/// [`LOG_TAIL_BYTES`], or nothing if it cannot be read.
pub(super) fn log_tail(engines: &Engines) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(engines.config_path(LOG_FILE)) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES))).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = file.take(LOG_TAIL_BYTES).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The last few lines of an engine log, for an error message.
fn tail(log: &str) -> String {
    let lines: Vec<&str> = log.lines().rev().take(6).collect();
    if lines.is_empty() {
        return "no output".to_string();
    }
    lines.into_iter().rev().collect::<Vec<_>>().join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> OpenvpnProfile {
        OpenvpnProfile {
            cert_pem: "-----BEGIN CERTIFICATE-----\nQ0VSVA==\n-----END CERTIFICATE-----".into(),
            key_pem: "-----BEGIN PRIVATE KEY-----\nS0VZ\n-----END PRIVATE KEY-----".into(),
            ca_cert_pem: "-----BEGIN CERTIFICATE-----\nQ0E=\n-----END CERTIFICATE-----".into(),
            endpoint: "203.0.113.5:1194".into(),
            proto: "udp".into(),
            tls_crypt_key: Some(
                "-----BEGIN OpenVPN Static key V1-----\ndeadbeef\n-----END OpenVPN Static key V1-----".into(),
            ),
        }
    }

    #[test]
    fn custom_mode_refuses_the_servers_pushed_routes() {
        // OpenVPN is told where to route by the server, so unlike the
        // other engines the passive behaviour cannot come from omitting
        // something -- route-nopull has to be added, or the pushed
        // redirect-gateway takes the default route and Custom mode
        // silently becomes a full tunnel.
        assert!(build_config(&profile(), true).unwrap().contains("route-nopull"));
        assert!(!build_config(&profile(), false).unwrap().contains("route-nopull"));
    }

    /// Custom mode keeps the server's address across OpenVPN's own
    /// restarts instead of looking its name up again.
    ///
    /// Custom mode now pins the machine's lookups to 1.1.1.1, and the
    /// redirect carries them into the tunnel. A ping-restart re-resolves
    /// `remote` unless told not to, and that lookup -- through the DNS
    /// Client like any other -- then went into the very tunnel that was
    /// down and restarting; with `resolv-retry infinite` OpenVPN waited on
    /// it for ever, where before W2 it went to the router and the
    /// reconnect worked. Only a server named by a hostname is exposed, which
    /// the installer allows. The first lookup, at connect, happens before
    /// the rule exists.
    #[test]
    fn custom_mode_keeps_the_servers_address_across_its_own_restarts() {
        let named = OpenvpnProfile { endpoint: "vpn.example.test:1194".into(), ..profile() };
        assert!(build_config(&named, true).unwrap().contains("\npersist-remote-ip\n"));
        // A full tunnel is as it was: its DNS is the pushed one, and nothing
        // of Custom mode's applies.
        assert!(!build_config(&named, false).unwrap().contains("persist-remote-ip"));
    }

    /// `connect` installs no NRPT rule. A full tunnel's DNS is the pushed
    /// one behind `block-outside-dns`; Custom mode's rule goes in once the
    /// redirect carries the lookups (`Engines::start_split_tunnel`, held
    /// there by its own test). Installed here, once OpenVPN said it was up
    /// and seconds before the redirect, it pinned them to 1.1.1.1 with
    /// nothing yet to carry them, and they left by the physical adapter in
    /// clear text. Held from the source.
    #[test]
    fn connect_installs_no_dns_rule() {
        let source = include_str!("openvpn.rs");
        let start = source.find("pub fn connect(").unwrap();
        let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
        assert!(!body.contains("dns::force("), "Custom mode's rule goes in before the redirect can carry it");
    }

    /// Detection goes off on OpenVPN's adapter before openvpn.exe starts,
    /// because openvpn.exe addresses it as it comes up and an address is
    /// checked under the setting it was added with. This is the change
    /// P0-A tested: `DadTransmits=0` on this adapter ahead of the connect
    /// took away the window in which every connection failed, and 3 put
    /// back brought it back. Then, once OpenVPN says it is up, the wait is
    /// for an address that is usable, not for the log line alone -- inside
    /// the chain that decides `up`, so a Disconnect during it reaches the
    /// arm that gives the routes back.
    #[test]
    fn detection_is_switched_off_before_openvpn_starts_and_waited_out_after() {
        let source = include_str!("openvpn.rs");
        let body_of = |signature: &str| {
            let start = source.find(signature).unwrap_or_else(|| panic!("{signature} is gone"));
            &source[start..start + source[start..].find("\n}\n").unwrap()]
        };
        let body = body_of("pub fn connect(");
        let quiet = body.find("readiness::quiet_or_note(").expect("detection is never switched off");
        let spawned = body.find("spawn_hidden(").expect("openvpn.exe is started");
        assert!(quiet < spawned, "detection must go off before openvpn.exe can address the adapter");
        let up = body.find("let up = ").expect("the chain that decides whether the tunnel came up");
        let decided = body[up..].find("match up {").map(|at| up + at).expect("the decision");
        let chain = &body[up..decided];
        let logged = chain.find("wait_until_up(").expect("waits for OpenVPN's word");
        let usable = chain.find("wait_until_usable(").expect("a tunnel that came up is not waited on for a usable address");
        assert!(logged < usable, "the address is waited on after OpenVPN says it is up");

        let wait = body_of("fn wait_until_usable(");
        assert!(wait.contains("readiness::settle("), "the wait never asks whether the address is Preferred");
        assert!(wait.contains("readiness::some_address_ready"), "the wait asks the wrong question");
        assert!(wait.contains("child.kill()"), "a Disconnect during the wait must stop openvpn.exe");
    }

    #[test]
    fn every_config_pins_the_mtu_and_refuses_the_pushed_one() {
        // The three lines are one fix and only work together: pinning
        // tun-mtu without the pull-filter is silently undone by the
        // server's pushed 1500, and lowering tun-mtu without mssfix
        // leaves TCP clamped at OpenVPN's own 1492 default -- which is
        // derived from a 1500-byte link and is the size that was
        // black-holing in the first place.
        //
        // Asserted for passive as well: a packet is the same size
        // whether one application is on the tunnel or all of them, and
        // Custom mode is where a customer is most likely to read the
        // failure as "the app I selected is broken".
        for passive in [false, true] {
            let conf = build_config(&profile(), passive).unwrap();
            assert!(
                conf.contains("pull-filter ignore \"tun-mtu\""),
                "passive={passive}: the server's pushed tun-mtu must be refused"
            );
            assert!(
                conf.contains("tun-mtu 1348"),
                "passive={passive}: tun-mtu must be pinned below the link budget"
            );
            assert!(
                conf.contains("mssfix 1400 mtu"),
                "passive={passive}: TCP must be clamped to the same budget, in the same units"
            );
        }
    }

    #[test]
    fn the_pinned_mtu_leaves_room_for_our_own_encapsulation() {
        // The arithmetic, rather than the two literals above, so a
        // future change to the budget cannot quietly produce a tun wider
        // than the packets it is supposed to fit inside.
        let conf = build_config(&profile(), false).unwrap();
        let tun: u16 = conf
            .lines()
            .find_map(|l| l.strip_prefix("tun-mtu "))
            .expect("tun-mtu is set")
            .parse()
            .expect("tun-mtu is a number");
        assert!(
            tun + UDP_ENCAP_OVERHEAD <= LINK_BUDGET,
            "a full-size packet from the tun ({tun}) plus encapsulation \
             ({UDP_ENCAP_OVERHEAD}) must fit the budget ({LINK_BUDGET})"
        );
    }

    #[test]
    fn splits_endpoint_into_openvpn_remote_syntax() {
        // OpenVPN wants `remote <host> <port>`, space-separated -- not
        // the host:port form every other engine here takes.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("remote 203.0.113.5 1194"));
    }

    #[test]
    fn inlines_all_three_pem_blocks() {
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("<ca>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<cert>\n-----BEGIN CERTIFICATE-----"));
        assert!(conf.contains("<key>\n-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn allows_openvpn_to_configure_the_adapter() {
        // OpenVPN shells out to netsh to set the tunnel address. At
        // script-security 0 that is refused and the connection dies
        // immediately after opening the adapter -- see the module doc for
        // why losing that layer is acceptable here.
        assert!(build_config(&profile(), false).unwrap().contains("script-security 2"));
    }

    #[test]
    fn uses_the_shared_wintun_driver() {
        assert!(build_config(&profile(), false).unwrap().contains("windows-driver wintun"));
    }

    /// The failure that earns a driver install, and the ones that do not.
    ///
    /// Measured on a clean Windows 11 guest against `main`: OpenVPN as
    /// the **first** protocol on a machine with no Wintun driver failed
    /// in 6.7s with exactly the message asserted below, while the same
    /// call on the same guest minutes later -- after Xray had installed
    /// the driver -- connected in 11.8s with an exit IP at the node.
    ///
    /// The negative half is the half that matters. Installing a network
    /// driver is not a reasonable response to any failure that is not
    /// this one: a budget overrun means the machine is slow, a name
    /// collision means the adapter is already there, and a refusal means
    /// something else is wrong. Retrying those behind a driver install
    /// would turn one clear failure into a slower, stranger one.
    #[test]
    fn only_a_missing_driver_earns_a_second_attempt() {
        assert!(
            looks_like_a_missing_driver(
                "could not create the OpenVPN network adapter (tapctl returned nothing)"
            ),
            "the message the rig actually produced has to be recognised"
        );
        assert!(
            looks_like_a_missing_driver("DiInstallDevice failed, error 0xe0000203"),
            "SetupAPI's own code for 'no driver selected', if it ever reaches us"
        );

        // The control rows: real failures that a driver install cannot
        // help, and must not be retried behind one.
        for other in [
            "could not create the OpenVPN network adapter: timed out after 60s",
            "could not create the OpenVPN network adapter: access is denied",
            "could not list network adapters: the system cannot find the file specified",
        ] {
            assert!(
                !looks_like_a_missing_driver(other),
                "{other:?} must not trigger a driver install"
            );
        }
    }

    /// The throwaway adapter must not share a name with anything real.
    ///
    /// Two mechanisms creating a device with one name is how an orphan
    /// appears that neither of them will clean up -- and this product
    /// has already shipped a leftover adapter a customer could only
    /// remove by hand.
    #[test]
    fn the_driver_install_adapter_collides_with_nothing() {
        assert_ne!(DRIVER_INSTALL_ADAPTER, ADAPTER_NAME);
        assert_ne!(DRIVER_INSTALL_ADAPTER, "neoconnect0");
    }

    #[test]
    fn binds_to_its_own_adapter_rather_than_whatever_is_free() {
        // Without naming an adapter, OpenVPN searches for any free
        // Wintun device and fails when Xray is holding the only one.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("dev-node Neoxify-OpenVPN"));
    }

    #[test]
    fn includes_the_tls_crypt_key_when_the_server_uses_one() {
        // Omitting this against a tls-crypt server is invisible: the
        // server drops the client's packets rather than rejecting them,
        // so the connection hangs with an empty log.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----"));
        assert!(conf.contains("</tls-crypt>"));
    }

    #[test]
    fn omits_the_tls_crypt_block_when_the_server_has_no_key() {
        let mut p = profile();
        p.tls_crypt_key = None;
        assert!(!build_config(&p, false).unwrap().contains("tls-crypt"));
    }

    #[test]
    fn a_full_tunnel_shuts_out_every_other_resolver() {
        // The fault this exists for: Windows asks all interfaces at once
        // and takes the first answer, so an ISP resolver beats ours and
        // in Iran answers filtered domains with a poisoned address. The
        // customer sees "connected" while blocked sites refuse to load.
        let conf = build_config(&profile(), false).unwrap();
        assert!(conf.contains("block-outside-dns"), "full tunnel must claim DNS");
    }

    /// No `block-outside-dns` in Custom mode: its filters refuse port 53
    /// on every adapter but the tunnel, before the redirect can carry a
    /// lookup in, and nothing is routed to the tunnel in this mode. The
    /// machine's lookups are pinned by the NRPT rule instead -- see the
    /// next test.
    #[test]
    fn custom_mode_does_not_block_dns_outside_the_tunnel() {
        let conf = build_config(&profile(), true).unwrap();
        assert!(!conf.contains("block-outside-dns"), "custom mode must not claim DNS");
    }

    /// What Custom mode's DNS pin reads from OpenVPN's own log: a restart
    /// that has not been followed by the tunnel coming up again is a link
    /// that is down. In OpenVPN 2.6's own words, at `verb 3`.
    #[test]
    fn a_restart_not_followed_by_the_tunnel_coming_up_reads_as_not_carrying() {
        use super::super::dns::Carrying;
        const UP: &str = "2026-10-11 14:00:01 Initialization Sequence Completed\n";
        const QUIET: &str = "2026-10-11 14:20:11 [server] Inactivity timeout (--ping-restart), restarting\n\
                             2026-10-11 14:20:11 SIGUSR1[soft,ping-restart] received, process restarting\n\
                             2026-10-11 14:20:11 Restart pause, 5 second(s)\n";
        const TLS: &str = "2026-10-11 14:21:16 TLS Error: TLS key negotiation failed to occur within 60 seconds\n\
                           2026-10-11 14:21:16 SIGUSR1[soft,tls-error] received, process restarting\n";

        assert_eq!(link_reading(UP), Carrying::Unknown, "up is OpenVPN's word, not a measurement of traffic");
        assert_eq!(link_reading(&format!("{UP}{QUIET}")), Carrying::No);
        assert_eq!(link_reading(&format!("{UP}{QUIET}{TLS}")), Carrying::No);
        assert_eq!(link_reading(&format!("{UP}{QUIET}{UP}")), Carrying::Unknown, "it came back by itself");
        assert_eq!(link_reading(""), Carrying::Unknown);
    }

    /// Read from the end, and only so much of it: a status poll reads this
    /// for as long as the session lasts.
    #[test]
    fn only_the_end_of_the_log_is_read() {
        use super::super::dns::Carrying;
        let dir = std::env::temp_dir().join(format!("neoconnect-openvpn-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let engines = Engines::new(dir.clone(), dir.clone());
        let filler = "2026-10-11 14:30:00 Data Channel: cipher 'AES-256-GCM'\n".repeat(1_000);

        std::fs::write(dir.join(LOG_FILE), format!("SIGUSR1[soft,ping-restart] received, process restarting\n{filler}")).unwrap();
        let tail = log_tail(&engines);
        assert!(tail.len() as u64 <= LOG_TAIL_BYTES);
        assert_eq!(link_reading(&tail), Carrying::Unknown, "a restart that far back is not this poll's business");

        std::fs::write(dir.join(LOG_FILE), format!("{filler}SIGUSR1[soft,ping-restart] received, process restarting\n")).unwrap();
        assert_eq!(link_reading(&log_tail(&engines)), Carrying::No);

        std::fs::remove_file(dir.join(LOG_FILE)).unwrap();
        assert_eq!(log_tail(&engines), "", "no log, nothing read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The watch's guard: when the uplink was guessed as the wrong
    /// adapter, the route that matters -- the one to the server -- is
    /// still taken, and nothing on our own adapters ever is.
    #[test]
    fn the_watch_takes_the_route_to_the_server_wherever_it_landed_but_never_on_ours() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let table = FakeRoutes::with(&[]);
        // Guessed uplink 14; our OpenVPN adapter is 30.
        let watch = HostRouteWatch::begin(&*table, Some(Uplink { index: 14, next_hop: gateway }), Some(server), None, vec![30]);
        let on_other_adapter = RouteRow::host(server, 9, gateway, 0);
        let on_ours = RouteRow::host(server, 30, Ipv4Addr::new(10, 8, 0, 1), 0);
        let unrelated = RouteRow::host(Ipv4Addr::new(198, 51, 100, 9), 9, gateway, 0);
        table.gain(on_other_adapter);
        table.gain(on_ours);
        table.gain(unrelated);

        assert_eq!(watch.added(&*table), vec![on_other_adapter]);
    }

    /// A table that could not be read beforehand cannot tell OpenVPN's
    /// routes from the customer's, so only the route to the server is
    /// taken -- never every host route on the uplink.
    #[test]
    fn a_watch_that_saw_nothing_before_takes_only_the_route_to_the_server() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let customers = RouteRow::host(Ipv4Addr::new(198, 51, 100, 9), 14, gateway, 0);
        let pushed = RouteRow::host(server, 14, gateway, 0);
        let table = FakeRoutes::with(&[customers, pushed]);
        let watch = HostRouteWatch { before: None, uplink: Some(Uplink { index: 14, next_hop: gateway }), remote: Some(server), dhcp_server: None, ours: Vec::new() };

        assert_eq!(watch.added(&*table), vec![pushed]);
    }

    /// Only what openvpn.exe could have added is taken: a host route added
    /// through `NETMGMT`, through the uplink's own gateway, which is where
    /// `redirect-gateway` puts the server's route and the `bypass-dhcp`
    /// one.
    ///
    /// The watch spans the whole connect, and the machine goes on changing
    /// in that time. The uplink taking a new address -- a DHCP renewal
    /// that moved it, or Wi-Fi roaming to another network on the same
    /// adapter -- makes Windows add a local and a broadcast /32 for it on
    /// that very adapter. Taken as OpenVPN's, they were deleted at
    /// Disconnect and owed in the ledger, which replays them by key on
    /// every idle status poll and at the next start: Windows' own routes,
    /// on the customer's active adapter.
    #[test]
    fn the_watch_never_takes_a_route_windows_made_or_one_through_another_gateway() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let table = FakeRoutes::with(&[]);
        let watch = HostRouteWatch::begin(&*table, Some(Uplink { index: 14, next_hop: gateway }), Some(server), None, vec![30]);

        let pushed = RouteRow::host(server, 14, gateway, 0);
        let bypass_dhcp = RouteRow::host(Ipv4Addr::new(192, 0, 2, 254), 14, gateway, 0);
        // What Windows adds for a new address on the uplink: on-link, and
        // protocol `LOCAL`.
        let windows = |dest| RouteRow { netmgmt: false, ..RouteRow::host(dest, 14, Ipv4Addr::UNSPECIFIED, 256) };
        let new_address = windows(Ipv4Addr::new(198, 51, 100, 23));
        let new_broadcast = windows(Ipv4Addr::new(198, 51, 100, 255));
        // Added through `NETMGMT`, but not through the gateway openvpn.exe
        // uses.
        let elsewhere = RouteRow::host(Ipv4Addr::new(198, 18, 7, 7), 14, Ipv4Addr::new(192, 0, 2, 9), 0);
        for row in [pushed, new_address, new_broadcast, bypass_dhcp, elsewhere] {
            table.gain(row);
        }

        assert_eq!(watch.added(&*table), vec![pushed, bypass_dhcp]);
    }

    fn ledger_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("neoconnect-openvpn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The server's and the DHCP server's routes are owed before
    /// openvpn.exe starts, so a service killed, crashed or stopped while it
    /// is still connecting leaves nothing the next start cannot remove.
    ///
    /// openvpn.exe adds both early in its connect, and they used to be
    /// owed only once the connect returned. The janitor at the next start
    /// kills the orphaned openvpn.exe, but had no record of its routes: the
    /// server's waited for the next connect's known-node purge, and the
    /// DHCP server's stayed until a reboot.
    #[test]
    fn the_routes_openvpn_will_add_are_owed_before_it_starts() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let dhcp = Ipv4Addr::new(192, 0, 2, 254);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let default = RouteRow { prefix: 0, ..RouteRow::host(Ipv4Addr::UNSPECIFIED, 14, gateway, 25) };
        let table = FakeRoutes::with(&[default]);
        let dir = ledger_dir("ahead");
        let owed = OwedRoutes::in_dir(&dir);
        let uplink = Some(Uplink { index: 14, next_hop: gateway });

        let watch = HostRouteWatch::begin(&*table, uplink, Some(server), Some(dhcp), Vec::new());
        let ahead = watch.owe_ahead(&owed);
        // openvpn.exe adds both, and then the service is killed: nothing
        // of this life runs again.
        table.gain(RouteRow::host(server, 14, gateway, 0));
        table.gain(RouteRow::host(dhcp, 14, gateway, 0));

        // The next life's janitor.
        super::super::janitor::settle_owed_routes(&OwedRoutes::in_dir(&dir), &*table);
        assert_eq!(table.table(), vec![default], "the pushed routes outlived the service; owed ahead: {ahead:?}");
        assert!(owed.read().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Nothing is owed ahead that was there before -- such a route is not
    /// openvpn.exe's to add, and deleting it on a crash would take the
    /// customer's -- and nothing ahead stays owed once the connect is up
    /// without it.
    #[test]
    fn owed_ahead_is_only_what_was_not_there_and_is_settled_if_never_added() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let dhcp = Ipv4Addr::new(192, 0, 2, 254);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let customers = RouteRow::host(dhcp, 14, gateway, 0);
        let table = FakeRoutes::with(&[customers]);
        let dir = ledger_dir("ahead-settled");
        let owed = OwedRoutes::in_dir(&dir);

        let watch = HostRouteWatch::begin(&*table, Some(Uplink { index: 14, next_hop: gateway }), Some(server), Some(dhcp), Vec::new());
        let ahead = watch.owe_ahead(&owed);
        let pushed = RouteRow::host(server, 14, gateway, 0);
        assert_eq!(ahead, vec![pushed], "the DHCP route was there before, and is not openvpn.exe's");
        assert_eq!(owed.read(), vec![pushed]);

        // Up, and the server's route was added through another gateway
        // than the one expected: what was owed ahead is struck off.
        table.gain(RouteRow::host(server, 14, Ipv4Addr::new(192, 0, 2, 9), 0));
        let added = watch.added(&*table);
        HostRouteWatch::settle_unused(&owed, &ahead, &added);
        assert!(owed.read().is_empty(), "a route never added is still owed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A connect that failed removes what openvpn.exe added and what was
    /// owed ahead, and owes whatever will not delete for the next start.
    /// It used to delete what was added and owe nothing, so a refused
    /// delete left the route behind with no record of it.
    #[test]
    fn a_failed_connect_gives_back_its_routes_or_owes_them() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let gateway = Ipv4Addr::new(192, 0, 2, 1);
        let pushed = RouteRow::host(server, 14, gateway, 0);
        let bypass = RouteRow::host(Ipv4Addr::new(192, 0, 2, 254), 14, gateway, 0);
        let dir = ledger_dir("give-back");
        let owed = OwedRoutes::in_dir(&dir);

        let table = FakeRoutes::with(&[pushed, bypass]);
        owed.owe(pushed);
        HostRouteWatch::give_back(&*table, &owed, &[pushed], &[pushed, bypass]);
        assert!(table.table().is_empty());
        assert!(owed.read().is_empty());

        let table = FakeRoutes::with(&[pushed, bypass]);
        table.refuses_deletes();
        owed.owe(pushed);
        HostRouteWatch::give_back(&*table, &owed, &[pushed], &[pushed, bypass]);
        assert_eq!(owed.read(), vec![pushed, bypass], "a route the failed connect left is not owed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guard for a wrongly guessed uplink takes the server's route
    /// wherever it landed -- but never one Windows made itself.
    #[test]
    fn the_guard_for_the_server_route_never_takes_one_windows_made() {
        use super::super::route_table::fake::FakeRoutes;
        let server = Ipv4Addr::new(203, 0, 113, 5);
        let table = FakeRoutes::with(&[]);
        let watch = HostRouteWatch::begin(&*table, None, Some(server), None, Vec::new());
        table.gain(RouteRow { netmgmt: false, ..RouteRow::host(server, 9, Ipv4Addr::UNSPECIFIED, 256) });

        assert!(watch.added(&*table).is_empty());
    }
}
