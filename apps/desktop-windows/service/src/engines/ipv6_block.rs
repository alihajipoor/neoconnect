//! Blocking IPv6 while a tunnel is up, because there is nowhere to
//! carry it.
//!
//! Two blocks live here, sharing one provider and one set of Win32
//! mechanics and differing only in scope:
//!
//! * [`Ipv6Block`] -- machine-wide, for a plain full tunnel. This is
//!   what the whole file below was written for and what the
//!   measurements describe.
//! * [`SelectedAppsIpv6Block`] -- scoped to the applications the
//!   customer chose, for Custom mode, which deliberately gets no
//!   machine-wide block. Added later; its own comment carries its
//!   argument, including why the same idea is **unsound for IPv4** and
//!   must not be tried there.
//!
//! # What was measured
//!
//! `split_tunnel/redirect.rs` fixed this for Custom mode in 0.9.27 and
//! said, in its header, that the fix covered only the redirect loop. It
//! was right to say so. Measured afterwards on client 0.9.25 against
//! germany-1 from a dual-stack Windows guest, with a packet capture
//! taken on the host side of the guest's vNIC -- outside anything the
//! client can influence -- with **plain full tunnel and split tunnel
//! off**:
//!
//! ```text
//! protocol                baseline (disconnected)   connected
//! OpenVPN                 13 clear v6 packets       14   LEAK
//! IKEv2                   13                        14   LEAK
//! Xray VLESS-REALITY      13                        smaller, non-zero   LEAK
//! WireGuard               13                         0   blocked
//! ```
//!
//! In every leaking case the app reported `connected: true` and the IPv4
//! exit address was the node's, so IPv4 was genuinely tunnelled while
//! IPv6 walked out of the physical NIC in clear text. That combination
//! is the worst one available: the customer is told they are protected,
//! and the evidence the app collects agrees, while an observer on their
//! own network reads their traffic.
//!
//! REALITY's smaller footprint is not partial protection and must not be
//! read as any. Xray captures DNS, so a name with only an `AAAA` record
//! fails to resolve and never produces a packet -- but raw IPv6 with a
//! literal address or a cached `AAAA` still egresses, and ICMPv6 and
//! inbound TCP 443 were both observed.
//!
//! # WireGuard was the only one that held, and not because of us
//!
//! The bundled `wireguard.exe` arms its own kill-switch. The capture
//! showed provider "WireGuard" owning a BLOCK filter named
//! `Block all outbound (IPv6)` at `FWPM_LAYER_ALE_AUTH_CONNECT_V6`, a
//! matching inbound one, and permits for NDP, DHCP, loopback, its own
//! TUN interface and its own service.
//!
//! So the mechanism was already proven on this product's own customers'
//! machines, by a component this product already ships. This module is
//! that mechanism, in our code, for the engines that do not bring one --
//! so that all eight protocols behave the same way instead of one of
//! them being accidentally safe.
//!
//! # Why blocking and not carrying
//!
//! The same answer `redirect.rs` gives, for the same reason, and it is
//! still not a client-side choice. **Every node is IPv4-only**: the
//! server configs carry no IPv6 addressing at all, no engine's tunnel
//! adapter is given a v6 address, and every route this client installs
//! is v4. There is nowhere to send a v6 packet.
//!
//! Blocking is therefore the interim, not the destination. The long-term
//! fix is IPv6 addressing on the nodes -- see `docs/journal/windows.md`
//! around line 5666 -- after which this module should carry v6 rather
//! than drop it, and the customer-facing string that goes with it should
//! go too.
//!
//! Until then the choice is between a silent leak and a stated gap, and
//! this project's answer is a stated gap: an IPv6-only destination stops
//! working while connected, which is visible, complainable-about and
//! recoverable. Being logged by an ISP in Iran is none of those. The app
//! says so in words -- `dash.fullTunnelIpv6Blocked` -- rather than
//! leaving the customer to discover it.
//!
//! # Why user-mode WFP, and what that can and cannot do
//!
//! Everything here is `fwpmu.h` (`fwpuclnt.dll`), from user mode, with no
//! driver. That is sufficient because user-mode WFP may add PERMIT and
//! BLOCK filters at the ALE layers; what it may *not* do is redirect,
//! which needs a kernel callout driver. Nothing here redirects.
//!
//! The structures are windows-sys generated bindings, deliberately.
//! `FWPM_FILTER0` is a nest of unions and this repository already paid
//! for hand-declaring a Windows structure once: three wrong RAS layouts
//! in a row, one of which dialled successfully and then killed the
//! service from inside RASAPI32. A wrong layout can match on size and
//! still corrupt memory.
//!
//! # The session is dynamic, which is the whole safety argument
//!
//! `FWPM_SESSION_FLAG_DYNAMIC` ties every object added through the
//! engine handle to the handle's lifetime. Closing it -- or the process
//! dying for any reason, including being killed -- removes the provider,
//! the sublayer and all the filters, because the kernel drops the
//! session when its last handle goes away rather than because any code
//! of ours ran. No boot-time filter, no persistent filter, nothing that
//! can outlive the service.
//!
//! That is not a nicety. A machine-wide IPv6 block left behind by a
//! crashed VPN client is a customer whose networking is broken with no
//! visible cause and no way to undo it, which is precisely the class of
//! leftover state being eliminated elsewhere in this client.
//!
//! # The residual gap
//!
//! ALE_AUTH_CONNECT_V6 classifies a flow when it is established, not
//! continuously. A v6 connection that was already open when the tunnel
//! came up is not re-examined and keeps running. New flows -- which is
//! everything a browser, a game or a resolver does from that point on --
//! are blocked. WireGuard's kill-switch has the same property.

use std::net::Ipv6Addr;
use std::path::{Path, PathBuf};

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{FWP_E_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmFreeMemory0,
    FwpmGetAppIdFromFileName0, FwpmProviderAdd0, FwpmSubLayerAdd0, FwpmTransactionAbort0,
    FwpmTransactionBegin0, FwpmTransactionCommit0, FWPM_ACTION0, FWPM_CONDITION_ALE_APP_ID,
    FWPM_CONDITION_FLAGS, FWPM_CONDITION_IP_REMOTE_ADDRESS, FWPM_FILTER0, FWPM_FILTER_CONDITION0,
    FWPM_FILTER_FLAG_NONE, FWPM_LAYER_ALE_AUTH_CONNECT_V6, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    FWPM_PROVIDER0, FWPM_SESSION0, FWPM_SESSION_FLAG_DYNAMIC, FWPM_SUBLAYER0, FWP_ACTION_BLOCK,
    FWP_ACTION_PERMIT, FWP_ACTION_TYPE, FWP_BYTE_BLOB, FWP_BYTE_BLOB_TYPE,
    FWP_CONDITION_FLAG_IS_LOOPBACK, FWP_CONDITION_VALUE0, FWP_CONDITION_VALUE0_0, FWP_MATCH_EQUAL,
    FWP_MATCH_FLAGS_ALL_SET, FWP_UINT32, FWP_UINT8, FWP_V6_ADDR_AND_MASK, FWP_V6_ADDR_MASK,
    FWP_VALUE0, FWP_VALUE0_0,
};
use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

/// Ours, and nobody else's.
///
/// A provider of our own is not decoration. The measurement that started
/// this had to tell our filters from `wireguard.exe`'s, and could only do
/// so because WireGuard registers a provider and names its filters. An
/// engineer looking at `netsh wfp show filters` on a customer's machine
/// deserves the same: every object below is stamped with this key and
/// carries a name beginning "Neoxify", so it is never mistaken for
/// another product's kill-switch -- or ours for theirs.
/// `pub(super)` so `repair` can sweep by it. Nothing outside this file
/// creates objects under this key; the repair only ever deletes.
pub(super) const PROVIDER_KEY: GUID = GUID::from_u128(0xa1e1f9c2_6b7d_4f4a_9c33_2d5b8e7a41d0);

/// A sublayer of our own, for the same reason and one more: filter
/// arbitration happens *within* a sublayer. Putting the block and its
/// permits in someone else's would make our outcome depend on their
/// weights.
pub(super) const SUBLAYER_KEY: GUID = GUID::from_u128(0xb2f2a0d3_7c8e_4a5b_8d44_3e6c9f8b52e1);

/// Same value `wireguard.exe` uses for its own sublayer. The number
/// decides the order sublayers are consulted in, not whether a block
/// wins -- a BLOCK in any sublayer blocks -- so this is about being
/// evaluated before something else permits, not about outranking anyone.
const SUBLAYER_WEIGHT: u16 = 0xFFFF;

/// Filter weights inside our sublayer.
///
/// `FWP_UINT8` weights are the relative form: within one sublayer the
/// highest-weight matching filter decides, so a PERMIT above a BLOCK
/// wins. The blocks sit at the bottom and catch everything the permits
/// did not claim. Neither block sets `FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT`,
/// which is what would let it veto the permits above it.
const WEIGHT_BLOCK: u8 = 0;
const WEIGHT_PERMIT: u8 = 12;

/// The names `netsh wfp show filters` will print. Kept as constants
/// because the log line quotes them: a support conversation that says
/// "look for the Neoxify sublayer" has to name the same string the
/// machine shows.
const PROVIDER_NAME: &str = "Neoxify";
const SUBLAYER_NAME: &str = "Neoxify IPv6 block";

const LOG_FILE: &str = "ipv6-block.log";

/// A machine-wide IPv6 block that lasts exactly as long as this value.
pub struct Ipv6Block {
    /// The WFP engine handle, kept as an integer rather than as
    /// `HANDLE`.
    ///
    /// `HANDLE` is `*mut c_void`, which is not `Send`, and this lives
    /// inside `Engines` -- which is held in a `tokio::sync::Mutex` and
    /// therefore has to cross await points. Storing the integer avoids
    /// asserting `Send` for a pointer by hand. The handle is not
    /// dereferenced anywhere; it is only ever handed straight back to
    /// the Fwpm functions.
    engine: isize,
    /// How many filters went in, for the log line on the way out. The
    /// two lines in `ipv6-block.log` naming the same count is the
    /// cheapest possible check that the teardown matched the setup.
    filters: usize,
    log: PathBuf,
}

impl Ipv6Block {
    /// Installs the block, or returns why it could not.
    ///
    /// Everything goes in inside one WFP transaction. That is not
    /// tidiness: a half-installed set is *worse than nothing*, because
    /// the ordering that fails first leaves the machine-wide BLOCK in
    /// place with the loopback, link-local and multicast permits
    /// missing -- which stops neighbour discovery and takes the local
    /// network down with it. Either all of it applies or none of it
    /// does.
    pub fn install(log_dir: &Path) -> Result<Self, String> {
        let log = log_dir.join(LOG_FILE);
        let engine = open_dynamic_session()?;

        match unsafe { build(engine) } {
            Ok(filters) => {
                note(
                    &log,
                    &format!(
                        "installed: {filters} filters in a dynamic session, \
                         provider {PROVIDER_NAME}, sublayer {SUBLAYER_NAME}"
                    ),
                );
                Ok(Self { engine: engine as isize, filters, log })
            }
            Err(e) => {
                // The session dies with the handle, so closing it here
                // undoes whatever did make it in before the failure --
                // including anything a failed transaction abort left
                // behind.
                unsafe { FwpmEngineClose0(engine) };
                note(&log, &format!("install failed: {e}"));
                Err(e)
            }
        }
    }

    /// Removes the block. Safe to call any number of times.
    ///
    /// Closing the engine handle is the removal: the filters, the
    /// sublayer and the provider all belong to the dynamic session and
    /// go with it. There is deliberately no per-filter delete loop --
    /// one that missed an entry would leave a block behind, and the
    /// whole point of the dynamic session is that no code of ours has to
    /// be correct for the cleanup to happen.
    pub fn remove(&mut self) {
        if self.engine == 0 {
            return;
        }
        let engine = std::mem::replace(&mut self.engine, 0) as HANDLE;
        let err = unsafe { FwpmEngineClose0(engine) };
        if err == 0 {
            note(&self.log, &format!("removed: {} filters, IPv6 restored", self.filters));
        } else {
            // Reported rather than swallowed, but not returned: a
            // disconnect must not fail because a log-worthy teardown
            // detail went wrong. The session still ends when this
            // process does.
            note(&self.log, &format!("removal reported {err:#010x}; session ends with the process"));
        }
    }
}

impl Drop for Ipv6Block {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Opens the filtering engine with a session that cannot outlive us.
fn open_dynamic_session() -> Result<HANDLE, String> {
    open_dynamic_session_named(SUBLAYER_NAME, "Blocks IPv6 while a Neoxify full tunnel is up")
}

/// The same, named for whichever of the two blocks is opening it, so a
/// support engineer reading `netsh wfp show state` sees which feature
/// owns the session rather than one generic string for both.
fn open_dynamic_session_named(session_name: &str, purpose: &str) -> Result<HANDLE, String> {
    let mut name = wide(session_name);
    let mut description = wide(purpose);

    let mut session: FWPM_SESSION0 = unsafe { std::mem::zeroed() };
    session.displayData.name = name.as_mut_ptr();
    session.displayData.description = description.as_mut_ptr();
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;

    let mut engine: HANDLE = std::ptr::null_mut();
    // Null credentials: the service is already LocalSystem, so it
    // authenticates as itself. Null session key and process id let WFP
    // fill them in.
    let err = unsafe {
        FwpmEngineOpen0(
            std::ptr::null(),
            RPC_C_AUTHN_WINNT,
            std::ptr::null(),
            &session,
            &mut engine,
        )
    };
    if err != 0 {
        return Err(format!(
            "the Windows Filtering Platform would not open a session ({err:#010x}), \
             so IPv6 could not be blocked"
        ));
    }
    Ok(engine)
}

/// Registers the provider and sublayer and adds every filter, inside one
/// transaction. Returns how many filters were added.
///
/// # Safety
/// `engine` must be a live handle from [`open_dynamic_session`].
unsafe fn build(engine: HANDLE) -> Result<usize, String> {
    let err = FwpmTransactionBegin0(engine, 0);
    if err != 0 {
        return Err(format!("could not begin a filtering transaction ({err:#010x})"));
    }

    match add_everything(engine) {
        Ok(filters) => {
            let err = FwpmTransactionCommit0(engine);
            if err != 0 {
                FwpmTransactionAbort0(engine);
                return Err(format!("the IPv6 block could not be committed ({err:#010x})"));
            }
            Ok(filters)
        }
        Err(e) => {
            FwpmTransactionAbort0(engine);
            Err(e)
        }
    }
}

/// # Safety
/// Called only from [`build`], inside an open transaction.
unsafe fn add_everything(engine: HANDLE) -> Result<usize, String> {
    add_provider(engine)?;
    add_sublayer(engine)?;

    // The set, and why it is this set.
    //
    // It is deliberately the same shape the WireGuard provider installs,
    // because that shape is the one already proven on customer machines
    // -- the measurement that started this file read it off a live
    // capture. Two machine-wide blocks, one per direction, and permits
    // above them for the traffic that is not "the internet".
    //
    // Loopback appears twice on purpose. `::1` is the address form and
    // is what a person reading `netsh wfp show filters` expects to see;
    // the `FWP_CONDITION_FLAG_IS_LOOPBACK` form is what WireGuard uses
    // and catches the case the address form misses -- a socket looping
    // back through one of the machine's *own global* addresses, which is
    // still local traffic and still indistinguishable from the internet
    // by address alone.
    //
    // Link-local and multicast are what keeps the LAN working. Neighbour
    // discovery, router advertisements, duplicate-address detection and
    // DHCPv6 are all ICMPv6 or UDP to `fe80::/10` and `ff00::/8`
    // addresses, so permitting those two ranges covers everything
    // WireGuard enumerates by ICMPv6 type and DHCPv6 port. Without them
    // the block does not merely stop internet IPv6, it stops the machine
    // being able to speak to its own router.
    //
    // What is left for the blocks is global unicast -- `2000::/3` and
    // anything else routable -- which is exactly the traffic the capture
    // saw leaving in clear text.
    // Paired with the word for the direction rather than compared
    // against the layer constant afterwards: `GUID` in windows-sys has
    // no `PartialEq`, and inventing one by comparing fields is exactly
    // the sort of hand-rolled Windows detail this file avoids.
    let layers = [
        (FWPM_LAYER_ALE_AUTH_CONNECT_V6, "outbound"),
        (FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6, "inbound"),
    ];

    let mut filters = 0usize;
    for (layer, direction) in layers {
        add_filter(
            engine,
            &format!("Neoxify: permit loopback IPv6 ({direction})"),
            layer,
            SUBLAYER_KEY,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            &[Scope::Loopback],
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit ::1 ({direction})"),
            layer,
            SUBLAYER_KEY,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            &[Scope::RemotePrefix(Ipv6Addr::LOCALHOST, 128)],
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit link-local fe80::/10 ({direction})"),
            layer,
            SUBLAYER_KEY,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            &[Scope::RemotePrefix(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10)],
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit multicast ff00::/8 ({direction})"),
            layer,
            SUBLAYER_KEY,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            &[Scope::RemotePrefix(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8)],
        )?;
        add_filter(
            engine,
            &format!("Neoxify: block all {direction} (IPv6)"),
            layer,
            SUBLAYER_KEY,
            FWP_ACTION_BLOCK,
            WEIGHT_BLOCK,
            &[],
        )?;
        filters += 5;
    }
    Ok(filters)
}

/// # Safety
/// Called only from [`add_everything`].
unsafe fn add_provider(engine: HANDLE) -> Result<(), String> {
    let mut name = wide(PROVIDER_NAME);
    let mut description = wide("Neoxify VPN");

    let mut provider: FWPM_PROVIDER0 = std::mem::zeroed();
    provider.providerKey = PROVIDER_KEY;
    provider.displayData.name = name.as_mut_ptr();
    provider.displayData.description = description.as_mut_ptr();
    // No FWPM_PROVIDER_FLAG_PERSISTENT: this provider belongs to the
    // dynamic session and must disappear with it.
    provider.flags = 0;

    let err = FwpmProviderAdd0(engine, &provider, std::ptr::null_mut());
    // Tolerated, and reachable: a provider registered persistently by an
    // older build, or by a second engine handle, is still usable.
    if err == 0 || err == FWP_E_ALREADY_EXISTS as u32 {
        return Ok(());
    }
    Err(format!("could not register the Neoxify filtering provider ({err:#010x})"))
}

/// # Safety
/// Called only from [`add_everything`].
unsafe fn add_sublayer(engine: HANDLE) -> Result<(), String> {
    let mut name = wide(SUBLAYER_NAME);
    let mut description = wide("Full-tunnel IPv6 block; removed on disconnect");
    let mut provider_key = PROVIDER_KEY;

    let mut sublayer: FWPM_SUBLAYER0 = std::mem::zeroed();
    sublayer.subLayerKey = SUBLAYER_KEY;
    sublayer.displayData.name = name.as_mut_ptr();
    sublayer.displayData.description = description.as_mut_ptr();
    // Not FWPM_SUBLAYER_FLAG_PERSISTENT, for the same reason as the
    // provider.
    sublayer.flags = 0;
    sublayer.providerKey = &mut provider_key;
    sublayer.weight = SUBLAYER_WEIGHT;

    let err = FwpmSubLayerAdd0(engine, &sublayer, std::ptr::null_mut());
    if err == 0 || err == FWP_E_ALREADY_EXISTS as u32 {
        return Ok(());
    }
    Err(format!("could not create the Neoxify filtering sublayer ({err:#010x})"))
}

/// What a filter matches on.
///
/// A filter is given a *slice* of these and every one of them has to
/// hold, because WFP ANDs conditions on different fields together. That
/// is what lets the split-tunnel block below say "this application, and
/// this address range" in one filter -- see [`SelectedAppsIpv6Block`].
/// Repeating the same field would OR instead, which nothing here wants.
enum Scope {
    /// A remote address prefix, e.g. `fe80::/10`.
    RemotePrefix(Ipv6Addr, u8),
    /// Traffic Windows itself has identified as looping back, whatever
    /// address it carries.
    Loopback,
    /// One executable, as WFP identifies executables: the normalised
    /// device path blob from [`AppId`].
    ///
    /// The pointer is borrowed. Its owner has to outlive the
    /// `FwpmFilterAdd0` call, which is why [`AppId`] is a guard held by
    /// the caller rather than something built here.
    App(*const FWP_BYTE_BLOB),
}

/// # Safety
/// Called only from inside an open transaction. Every `Scope::App` in
/// `scopes` must point at a blob that is still alive.
unsafe fn add_filter(
    engine: HANDLE,
    name: &str,
    layer: GUID,
    sublayer: GUID,
    action: FWP_ACTION_TYPE,
    weight: u8,
    scopes: &[Scope],
) -> Result<(), String> {
    let mut display_name = wide(name);
    let mut provider_key = PROVIDER_KEY;

    // Backs the address conditions' union pointers and must outlive the
    // FwpmFilterAdd0 call below, which is why it is declared here rather
    // than inside the loop. Reserved up front so that pushing into it
    // cannot reallocate and leave an earlier condition pointing at freed
    // memory -- the whole reason this is a separate buffer at all.
    let mut addresses: Vec<FWP_V6_ADDR_AND_MASK> = Vec::with_capacity(scopes.len());

    let mut conditions: Vec<FWPM_FILTER_CONDITION0> = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let condition = match scope {
            Scope::RemotePrefix(prefix, length) => {
                addresses.push(FWP_V6_ADDR_AND_MASK {
                    addr: prefix.octets(),
                    prefixLength: *length,
                });
                let address = addresses.last_mut().expect("just pushed");
                FWPM_FILTER_CONDITION0 {
                    fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                    matchType: FWP_MATCH_EQUAL,
                    conditionValue: FWP_CONDITION_VALUE0 {
                        r#type: FWP_V6_ADDR_MASK,
                        Anonymous: FWP_CONDITION_VALUE0_0 { v6AddrMask: address },
                    },
                }
            }
            Scope::Loopback => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_FLAGS,
                // ALL_SET rather than EQUAL: the field is a bitmask carrying
                // several unrelated facts about the flow, and equality would
                // only match a flow that was loopback and nothing else.
                matchType: FWP_MATCH_FLAGS_ALL_SET,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT32,
                    // By value, not by pointer -- FWP_UINT32 lives in the
                    // union itself, so there is nothing here to keep alive.
                    Anonymous: FWP_CONDITION_VALUE0_0 { uint32: FWP_CONDITION_FLAG_IS_LOOPBACK },
                },
            },
            Scope::App(blob) => FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_ALE_APP_ID,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_BYTE_BLOB_TYPE,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        byteBlob: *blob as *mut FWP_BYTE_BLOB,
                    },
                },
            },
        };
        conditions.push(condition);
    }

    let mut filter: FWPM_FILTER0 = std::mem::zeroed();
    filter.displayData.name = display_name.as_mut_ptr();
    filter.flags = FWPM_FILTER_FLAG_NONE;
    filter.providerKey = &mut provider_key;
    filter.layerKey = layer;
    filter.subLayerKey = sublayer;
    filter.weight = FWP_VALUE0 { r#type: FWP_UINT8, Anonymous: FWP_VALUE0_0 { uint8: weight } };
    filter.numFilterConditions = conditions.len() as u32;
    // Null rather than an empty Vec's dangling pointer. WFP will not
    // read it with a count of zero, but handing a driver a fabricated
    // address to not-read is not a habit worth having.
    filter.filterCondition =
        if conditions.is_empty() { std::ptr::null_mut() } else { conditions.as_mut_ptr() };
    filter.action = FWPM_ACTION0 { r#type: action, Anonymous: std::mem::zeroed() };

    let err = FwpmFilterAdd0(engine, &filter, std::ptr::null_mut(), std::ptr::null_mut());
    if err != 0 {
        return Err(format!("could not add the filter \"{name}\" ({err:#010x})"));
    }
    Ok(())
}

/// A NUL-terminated UTF-16 buffer for a Win32 display string.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Best-effort, like every other log in this service: a line that cannot
/// be written must never affect the connection it describes.
fn note(path: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Whether a profile needs this block installed.
///
/// WireGuard is exempt, and deliberately so. `wireguard.exe` arms its own
/// WFP kill-switch -- the capture that produced this module read
/// provider "WireGuard" owning `Block all outbound (IPv6)` at the same
/// layer this one uses -- and it was the one protocol of the four
/// measured that did not leak. Adding a second provider blocking the
/// same traffic buys nothing and costs clarity: whoever debugs a
/// customer's filtering table next would find two kill-switches and have
/// to work out which one was responsible for what.
///
/// Every other engine gets it, including all five Xray protocols, which
/// share one code path and one adapter and therefore one gap.
pub fn needed_for(profile: &neoconnect_ipc::ConnectProfile) -> bool {
    use neoconnect_ipc::ConnectProfile as P;
    match profile {
        P::Wireguard(_) => false,
        P::Openvpn(_)
        | P::Ikev2(_)
        | P::XrayVlessReality(_)
        | P::XrayVlessTls(_)
        | P::XrayTrojan(_)
        | P::Shadowsocks(_) => true,
    }
}

// ---------------------------------------------------------------------
// Custom mode's half of the same problem.
// ---------------------------------------------------------------------

/// A sublayer for the Custom-mode filters, separate from the full-tunnel
/// one above.
///
/// Separate because the two are separate features with separate
/// lifetimes -- `block_ipv6_if_needed` deliberately installs nothing
/// while Custom mode is on, so they never coexist, and an engineer
/// reading `netsh wfp show filters` on a customer's machine should be
/// able to tell from the sublayer name which of the two they are looking
/// at. The provider is shared: there is one Neoxify.
///
/// `pub(super)` for the same reason [`SUBLAYER_KEY`] is: `repair` has to
/// delete *both* sublayers before the shared provider can be
/// deregistered, because a provider with objects still referencing it
/// refuses rather than cascading. Sweeping only one of the two would
/// leave the other pinning the provider forever.
pub(super) const SPLIT_SUBLAYER_KEY: GUID =
    GUID::from_u128(0xc3a3b1e4_8d9f_4b6c_9e55_4f7dab9c63f2);

const SPLIT_SUBLAYER_NAME: &str = "Neoxify Custom-mode IPv6 block";

const SPLIT_LOG_FILE: &str = "ipv6-block-custom.log";

/// The normalised application identifier WFP matches executables by.
///
/// `FwpmGetAppIdFromFileName0` turns `C:\...\chrome.exe` into the NT
/// device path form the kernel actually compares against
/// (`\device\harddiskvolume3\...`), allocating the blob itself. A guard
/// rather than a bare pointer because the blob has to outlive every
/// `FwpmFilterAdd0` that references it and then be handed back to
/// `FwpmFreeMemory0` -- and the failure mode of getting that wrong is a
/// filter pointing at freed memory inside the filtering engine.
struct AppId {
    blob: *mut FWP_BYTE_BLOB,
    /// Kept for the log line, which names what could not be resolved.
    path: String,
}

impl AppId {
    /// Resolves one path, or says why it could not be.
    ///
    /// A missing file is the common failure -- a customer's selection
    /// outlives the program they uninstalled -- and it is not fatal to
    /// anything: a program that is not there cannot leak.
    fn resolve(path: &str) -> Result<Self, String> {
        let wide_path = wide(path);
        let mut blob: *mut FWP_BYTE_BLOB = std::ptr::null_mut();
        // SAFETY: `wide_path` is a live NUL-terminated UTF-16 buffer for
        // the duration of the call, and `blob` is an owned out-pointer.
        let err = unsafe { FwpmGetAppIdFromFileName0(wide_path.as_ptr(), &mut blob) };
        if err != 0 || blob.is_null() {
            return Err(format!("{path} ({err:#010x})"));
        }
        Ok(Self { blob, path: path.to_string() })
    }
}

impl Drop for AppId {
    fn drop(&mut self) {
        if self.blob.is_null() {
            return;
        }
        let mut blob = std::mem::replace(&mut self.blob, std::ptr::null_mut());
        // SAFETY: `blob` came from FwpmGetAppIdFromFileName0 and has not
        // been freed before -- the pointer is taken, so a second drop
        // sees null and returns above.
        unsafe {
            FwpmFreeMemory0(&mut blob as *mut *mut FWP_BYTE_BLOB as *mut *mut std::ffi::c_void)
        };
    }
}

/// An IPv6 block scoped to the applications the customer chose to
/// tunnel, lasting exactly as long as this value.
///
/// # Why this exists when the redirect loop already blocks IPv6
///
/// It blocks the same traffic, and it is not redundant, because the two
/// answer the question "who sent this?" in ways that fail differently.
///
/// `redirect::handle_ipv6` is handed a packet and has to work backwards
/// to the program that sent it, through the machine's UDP and TCP
/// endpoint tables. That lookup can come back empty. Two measured ways
/// to get there:
///
/// * A socket closed microseconds after its send. Windows drops the row
///   naming the owner when the socket closes, and the loop is handed the
///   packet afterwards. Measured on the rig over IPv4, 13 and 14 of 15
///   datagrams escaped; nothing about the mechanism is IPv4-specific.
/// * A socket younger than the lookup's 20ms snapshot interval, which
///   every socket is when it sends its first packet.
///
/// The first of those used to mean the packet was **left alone** and
/// went out in clear text, and 0.9.32 closed that:
/// `Selection::verdict_for_unattributed` now refuses an unattributable
/// datagram in `OnlySelected` rather than passing it through, on both
/// families. That refusal is deliberately the narrowest thing that
/// closes the hole, and what it does not cover is what this type is
/// still for:
///
/// * **TCP.** The refusal is UDP-only, because a TCP socket has to stay
///   open to receive the handshake and so cannot be gone before its SYN
///   is classified. What it *can* be is younger than the refresh floor
///   above -- and an escaping v6 SYN is the worse case of the two, since
///   the far end answers it and the connection is then established in
///   the clear.
/// * **Anything the loop never sees.** A filter that refuses at
///   `connect()` acts before a packet exists, so it does not depend on
///   the loop being handed the packet, on the driver being loaded, or
///   on the lookup being reached at all.
///
/// Read the two together. Neither is a substitute for the other, and
/// this type installing cleanly is not a reason to relax the loop.
///
/// A WFP filter at `FWPM_LAYER_ALE_AUTH_CONNECT_V6` has no lookup to
/// lose. The kernel classifies in the calling thread, inside the sending
/// process, at `connect()` or at the first `sendto` to a new remote
/// endpoint -- before a packet exists and while the socket certainly
/// does. The owner is not inferred; it is the caller.
///
/// # Why the same trick does **not** work for IPv4, and must not be tried
///
/// This is the whole reason the blanket "block what the redirect could
/// not attribute" proposal was dropped, and it is written down here so
/// nobody re-derives it the expensive way.
///
/// ALE classifies at connect time with the address the *application*
/// asked for. The Custom-mode redirect rewrites the destination much
/// later, at `FWPM_LAYER_OUTBOUND_IPPACKET_V4`, which is where WinDivert
/// registers its callout -- documented order for a client open is
/// `ALE_AUTH_CONNECT` -> `OUTBOUND_TRANSPORT` -> `OUTBOUND_IPPACKET`.
/// So at ALE, a connection that will be correctly carried and one that
/// will escape are the *same event*: selected application, public
/// destination. Nothing distinguishes them, at any layer user mode can
/// reach -- app identity exists only at the ALE layers, and every ALE
/// layer runs before the rewrite. A destination-scoped block would
/// therefore refuse exactly the connections Custom mode exists to carry.
///
/// Mullvad and Windscribe both escape this, and both do it the same way:
/// a signed kernel callout at `ALE_BIND_REDIRECT` / `ALE_CONNECT_REDIRECT`
/// rewrites the **local** address at connect time, so their block filters
/// can key on local address (Mullvad) or local interface LUID
/// (Windscribe) instead of on the remote one. This client's redirect
/// leaves the source address alone by design -- see `redirect.rs` -- so
/// even that discriminator does not exist here.
///
/// IPv6 is the one case with no such ambiguity, and that is the entire
/// argument for this type: **no IPv6 is ever redirected**. Every v6
/// packet from a selected application is meant to be blocked, so there
/// is nothing for the filter to confuse it with.
///
/// # What is deliberately left to the loop
///
/// The scope mirrors `redirect::filter_for`'s IPv6 half exactly, rather
/// than being an independently reasoned set. Two blocks disagreeing
/// about what counts as "the LAN" would be worse than either alone.
///
/// * Outbound only. The loop is outbound-only, and blocking inbound
///   would take away a selected app's incoming v6 connections, which
///   Custom mode has never claimed to touch.
/// * `OnlySelected` only. In "everything except these" the loop's own
///   answer for an unknown owner is already *block*, so there is no
///   gap of this shape to close, and expressing that mode in WFP would
///   mean a machine-wide block with per-app holes -- a far larger blast
///   radius for no measured gain.
/// * Applications the customer did not choose are untouched. Every
///   filter installed here, permit and block alike, carries an
///   `ALE_APP_ID` condition, so this sublayer has no opinion at all
///   about any other program on the machine.
///
/// # The IPv4-mapped permit is load-bearing
///
/// `::/64` is permitted, and it is not there for `::1`. A dual-stack
/// socket's IPv4 traffic is classified at the **V6** ALE layer carrying
/// an IPv4-mapped address (`::ffff:a.b.c.d`), which Microsoft documents
/// explicitly. Without that permit this block would refuse a selected
/// application's IPv4 as well -- which is to say, it would break Custom
/// mode outright for the traffic Custom mode is for.
pub struct SelectedAppsIpv6Block {
    engine: isize,
    filters: usize,
    log: PathBuf,
}

impl SelectedAppsIpv6Block {
    /// Installs the block for `paths`, or returns why it could not.
    ///
    /// Caller-gated to `OnlySelected` -- see the type comment. An empty
    /// `paths` installs nothing and is an error, because a session with
    /// no selection never reaches here.
    pub fn install(paths: &[String], log_dir: &Path) -> Result<Self, String> {
        let log = log_dir.join(SPLIT_LOG_FILE);
        if paths.is_empty() {
            return Err("no applications selected".into());
        }

        // Before the engine is opened, so a selection that resolves to
        // nothing costs nothing. Failures are collected rather than
        // returned: a customer whose list holds one uninstalled program
        // must still get the block for the others.
        let mut app_ids = Vec::with_capacity(paths.len());
        let mut unresolved = Vec::new();
        for path in paths {
            match AppId::resolve(path) {
                Ok(id) => app_ids.push(id),
                Err(e) => unresolved.push(e),
            }
        }
        for failure in &unresolved {
            note(&log, &format!("could not identify an application to WFP: {failure}"));
        }
        if app_ids.is_empty() {
            return Err("none of the selected applications could be identified to WFP".into());
        }

        let engine = open_dynamic_session_named(
            SPLIT_SUBLAYER_NAME,
            "Blocks IPv6 for the apps Neoxify Custom mode carries",
        )?;

        // SAFETY: `engine` is live, and every `AppId` in `app_ids`
        // outlives the call -- the Vec is dropped after it returns.
        match unsafe { build_split(engine, &app_ids) } {
            Ok(filters) => {
                note(
                    &log,
                    &format!(
                        "installed: {filters} filters for {} app(s) in a dynamic session, \
                         provider {PROVIDER_NAME}, sublayer {SPLIT_SUBLAYER_NAME}",
                        app_ids.len()
                    ),
                );
                Ok(Self { engine: engine as isize, filters, log })
            }
            Err(e) => {
                // Closing the handle ends the dynamic session, which
                // undoes anything that did make it in. See
                // `Ipv6Block::install`.
                unsafe { FwpmEngineClose0(engine) };
                note(&log, &format!("install failed: {e}"));
                Err(e)
            }
        }
    }

    /// Removes the block. Safe to call any number of times.
    ///
    /// Closing the engine handle is the removal, for the same reason it
    /// is in [`Ipv6Block::remove`]: the filters, the sublayer and the
    /// provider registration belong to the dynamic session. Nothing here
    /// has to run for a crashed or killed service to leave a customer's
    /// IPv6 exactly as it found it.
    pub fn remove(&mut self) {
        if self.engine == 0 {
            return;
        }
        let engine = std::mem::replace(&mut self.engine, 0) as HANDLE;
        let err = unsafe { FwpmEngineClose0(engine) };
        if err == 0 {
            note(&self.log, &format!("removed: {} filters, IPv6 restored", self.filters));
        } else {
            note(
                &self.log,
                &format!("removal reported {err:#010x}; session ends with the process"),
            );
        }
    }
}

impl Drop for SelectedAppsIpv6Block {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Registers the provider and sublayer and adds every filter, inside one
/// transaction. Returns how many filters were added.
///
/// One transaction for the same reason [`build`] uses one, with the
/// direction of the danger reversed: a half-installed set here could
/// leave a selected application's BLOCK in place with the permit that
/// keeps its **IPv4** working missing, which would look to the customer
/// like Custom mode having killed the program's networking outright.
///
/// # Safety
/// `engine` must be a live handle, and every blob in `app_ids` must
/// outlive the call.
unsafe fn build_split(engine: HANDLE, app_ids: &[AppId]) -> Result<usize, String> {
    let err = FwpmTransactionBegin0(engine, 0);
    if err != 0 {
        return Err(format!("could not begin a filtering transaction ({err:#010x})"));
    }

    match add_split_filters(engine, app_ids) {
        Ok(filters) => {
            let err = FwpmTransactionCommit0(engine);
            if err != 0 {
                FwpmTransactionAbort0(engine);
                return Err(format!("the Custom-mode IPv6 block could not be committed ({err:#010x})"));
            }
            Ok(filters)
        }
        Err(e) => {
            FwpmTransactionAbort0(engine);
            Err(e)
        }
    }
}

/// What each selected application is permitted, above its block.
///
/// Read straight off `redirect::filter_for`'s IPv6 clause, which hands
/// the loop only what lies strictly between `::ffff:ffff:ffff:ffff` and
/// `fc00::`, and blocks only within that. Everything outside it is what
/// the loop passes through untouched:
///
/// * `::/64` -- the unspecified address, `::1`, and the IPv4-mapped
///   range. The last of those is the important one; see the type
///   comment.
/// * `fc00::/7` + `fe00::/8` + `ff00::/8` -- exactly `>= fc00::`, which
///   is unique-local, link-local and multicast. The LAN.
///
/// Written as three prefixes rather than one range because WFP matches
/// prefixes, not ranges, and the three together cover the range with
/// nothing over and nothing missing.
const SPLIT_PERMITTED: [(Ipv6Addr, u8); 4] = [
    (Ipv6Addr::UNSPECIFIED, 64),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe00, 0, 0, 0, 0, 0, 0, 0), 8),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

/// How many filters one selected application costs.
pub const SPLIT_FILTERS_PER_APP: usize = SPLIT_PERMITTED.len() + 2;

/// # Safety
/// Called only from [`build_split`], inside an open transaction, with
/// blobs that outlive the call.
unsafe fn add_split_filters(engine: HANDLE, app_ids: &[AppId]) -> Result<usize, String> {
    add_provider(engine)?;
    add_split_sublayer(engine)?;

    let mut filters = 0usize;
    for app in app_ids {
        // A name a person can find in `netsh wfp show filters` and match
        // against the list in the app's own settings screen.
        let label = std::path::Path::new(&app.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| app.path.clone());

        add_filter(
            engine,
            &format!("Neoxify: permit loopback IPv6 for {label} (custom mode)"),
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            SPLIT_SUBLAYER_KEY,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            &[Scope::App(app.blob), Scope::Loopback],
        )?;
        filters += 1;

        for (prefix, length) in SPLIT_PERMITTED {
            add_filter(
                engine,
                &format!("Neoxify: permit {prefix}/{length} for {label} (custom mode)"),
                FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                SPLIT_SUBLAYER_KEY,
                FWP_ACTION_PERMIT,
                WEIGHT_PERMIT,
                &[Scope::App(app.blob), Scope::RemotePrefix(prefix, length)],
            )?;
            filters += 1;
        }

        // The block itself. No address condition: everything the loop
        // would have carried is everything the permits above did not
        // claim, and expressing that as "what is left" rather than as a
        // second copy of the same ranges is what keeps the two
        // definitions from drifting apart.
        add_filter(
            engine,
            &format!("Neoxify: block outbound IPv6 for {label} (custom mode)"),
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            SPLIT_SUBLAYER_KEY,
            FWP_ACTION_BLOCK,
            WEIGHT_BLOCK,
            &[Scope::App(app.blob)],
        )?;
        filters += 1;
    }
    // The count is accumulated from what actually went in rather than
    // computed, because that is the number the log line and the teardown
    // both quote. This ties it back to the arithmetic the test asserts,
    // so the two cannot drift if a filter is added to the loop above and
    // the constant is forgotten.
    debug_assert_eq!(
        filters,
        app_ids.len() * SPLIT_FILTERS_PER_APP,
        "SPLIT_FILTERS_PER_APP no longer describes what this loop adds"
    );
    Ok(filters)
}

/// # Safety
/// Called only from [`add_split_filters`].
unsafe fn add_split_sublayer(engine: HANDLE) -> Result<(), String> {
    let mut name = wide(SPLIT_SUBLAYER_NAME);
    let mut description = wide("Per-app IPv6 block for Custom mode; removed when it stops");
    let mut provider_key = PROVIDER_KEY;

    let mut sublayer: FWPM_SUBLAYER0 = std::mem::zeroed();
    sublayer.subLayerKey = SPLIT_SUBLAYER_KEY;
    sublayer.displayData.name = name.as_mut_ptr();
    sublayer.displayData.description = description.as_mut_ptr();
    sublayer.flags = 0;
    sublayer.providerKey = &mut provider_key;
    sublayer.weight = SUBLAYER_WEIGHT;

    let err = FwpmSubLayerAdd0(engine, &sublayer, std::ptr::null_mut());
    if err == 0 || err == FWP_E_ALREADY_EXISTS as u32 {
        return Ok(());
    }
    Err(format!("could not create the Neoxify Custom-mode filtering sublayer ({err:#010x})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use neoconnect_ipc::{
        ConnectProfile, Ikev2Profile, OpenvpnProfile, ShadowsocksProfile, TrojanProfile,
        VlessTlsProfile, WireguardProfile, XrayProfile,
    };

    /// The gate, spelled out per protocol.
    ///
    /// The compile-time half of this guarantee is the exhaustive match
    /// in `needed_for`: a ninth protocol will fail to build rather than
    /// silently default to "no block", which is how a leak gets
    /// reintroduced by someone who never read this file. This test is
    /// the other half -- that the eight we have are sorted the way the
    /// measurement says they should be.
    ///
    /// Note there are five Xray protocols and one Xray code path. They
    /// share an engine, an adapter and therefore a gap, so they are
    /// listed individually here rather than trusted to be equivalent.
    #[test]
    fn every_engine_but_wireguard_needs_the_block() {
        let wireguard = ConnectProfile::Wireguard(WireguardProfile {
            private_key: String::new(),
            address: "10.77.0.8/32".into(),
            dns: None,
            allowed_ips: "0.0.0.0/0".into(),
            server_public_key: String::new(),
            endpoint: "203.0.113.1:51820".into(),
        });
        assert!(
            !needed_for(&wireguard),
            "wireguard.exe arms its own WFP kill-switch; a second one only confuses the table"
        );

        let xray = XrayProfile {
            uuid: String::new(),
            flow: String::new(),
            host: "203.0.113.1".into(),
            port: 443,
            reality_public_key: String::new(),
            short_id: String::new(),
            server_name: "www.example.com".into(),
        };
        let vless_tls = VlessTlsProfile {
            uuid: String::new(),
            flow: String::new(),
            host: "203.0.113.1".into(),
            port: 443,
            server_name: "www.example.com".into(),
            ws_path: None,
        };
        let trojan = TrojanProfile {
            password: String::new(),
            host: "203.0.113.1".into(),
            port: 443,
            server_name: "www.example.com".into(),
        };

        for profile in [
            ConnectProfile::Openvpn(OpenvpnProfile {
                cert_pem: String::new(),
                key_pem: String::new(),
                ca_cert_pem: String::new(),
                endpoint: "203.0.113.1:1194".into(),
                proto: "udp".into(),
                tls_crypt_key: None,
            }),
            ConnectProfile::Ikev2(Ikev2Profile {
                server: "node.example.com".into(),
                username: String::new(),
                password: String::new(),
            }),
            ConnectProfile::XrayVlessReality(xray),
            // The WebSocket variant is the same struct with a path set,
            // and takes the same Xray path, so it is covered by the TLS
            // case above rather than duplicated.
            ConnectProfile::XrayVlessTls(vless_tls),
            ConnectProfile::XrayTrojan(trojan),
            ConnectProfile::Shadowsocks(ShadowsocksProfile {
                host: "203.0.113.1".into(),
                port: 8388,
                method: "2022-blake3-aes-128-gcm".into(),
                password: String::new(),
            }),
        ] {
            assert!(needed_for(&profile), "{profile:?} leaked IPv6 when it was measured");
        }
    }

    /// Hands the real filter set to the real filtering engine, and then
    /// throws it away.
    ///
    /// This is here because "it compiles" proves nothing about a Win32
    /// structure. WFP validates a filter when it is added -- the layer,
    /// the sublayer, the weight's data type, every condition's field key
    /// and value type -- and it does that validation *inside* the
    /// transaction, before anything is committed. So aborting afterwards
    /// exercises `FwpmEngineOpen0`, the provider, the sublayer and all
    /// ten `FwpmFilterAdd0` calls against the actual operating system
    /// while never filtering a single packet.
    ///
    /// What it does **not** prove is that IPv6 stops. Nothing that runs
    /// on a build machine can prove that; only the packet capture in
    /// this file's header can, and that experiment has to be re-run on
    /// the rig. This test exists to catch the other failure -- a
    /// structure WFP rejects, or worse, accepts wrongly -- which is the
    /// one that would otherwise be found by a customer.
    ///
    /// Skipped rather than failed where the engine cannot be opened at
    /// all: adding filters needs administrator rights, and a developer
    /// machine without them must not report a red test for a permission
    /// it was never going to have.
    #[test]
    fn wfp_accepts_the_whole_filter_set_then_it_is_aborted() {
        let Ok(engine) = open_dynamic_session() else {
            eprintln!("skipped: the filtering engine would not open (needs administrator)");
            return;
        };

        let result = unsafe {
            let begun = FwpmTransactionBegin0(engine, 0);
            if begun != 0 {
                FwpmEngineClose0(engine);
                eprintln!("skipped: no filtering transaction ({begun:#010x})");
                return;
            }
            let result = add_everything(engine);
            // Unconditionally, and before the assertion below, so a
            // failing assertion cannot leave a transaction open. Closing
            // the handle would end the dynamic session anyway, which is
            // the second layer of the same guarantee.
            FwpmTransactionAbort0(engine);
            FwpmEngineClose0(engine);
            result
        };

        match result {
            Ok(filters) => assert_eq!(
                filters, 10,
                "five filters per layer, two layers -- see add_everything"
            ),
            Err(e) => panic!("the Windows Filtering Platform rejected our filter set: {e}"),
        }
    }

    /// The prefixes are written as `Ipv6Addr`s and handed to WFP as raw
    /// octets, so this pins the two that keep the LAN alive. A wrong
    /// byte here is a block that takes out neighbour discovery, which
    /// presents as "the whole network died when I connected".
    #[test]
    fn lan_prefixes_are_the_ones_wfp_will_see() {
        let link_local = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0).octets();
        assert_eq!(link_local[0], 0xfe);
        assert_eq!(link_local[1], 0x80);

        let multicast = Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0).octets();
        assert_eq!(multicast[0], 0xff);

        assert_eq!(Ipv6Addr::LOCALHOST.octets()[15], 1);
    }

    // -----------------------------------------------------------------
    // The Custom-mode per-app block.
    // -----------------------------------------------------------------

    /// Whether an address falls inside one of the prefixes
    /// [`SPLIT_PERMITTED`] carves out.
    ///
    /// Written here rather than borrowed from anywhere, because the
    /// point of the test below is to check the *table*, and a helper
    /// that shared code with the thing under test would agree with it
    /// by construction.
    fn permitted_by_the_app_block(addr: Ipv6Addr) -> bool {
        SPLIT_PERMITTED.iter().any(|(prefix, length)| {
            let addr = addr.octets();
            let prefix = prefix.octets();
            let whole = (*length / 8) as usize;
            if addr[..whole] != prefix[..whole] {
                return false;
            }
            match length % 8 {
                0 => true,
                bits => {
                    let mask = 0xffu8 << (8 - bits);
                    addr[whole] & mask == prefix[whole] & mask
                }
            }
        })
    }

    /// The one address range `redirect::filter_for` hands to the loop,
    /// as it writes it:
    ///
    /// ```text
    /// ipv6.DstAddr > 0:0:0:0:ffff:ffff:ffff:ffff and ipv6.DstAddr < fc00::
    /// ```
    ///
    /// Duplicated as a pair of bounds because the loop's copy lives in a
    /// string compiled by the WinDivert driver and cannot be evaluated
    /// from here. If that string is ever changed, this pair has to
    /// change with it -- which is the whole reason the test below exists
    /// in this shape rather than as a list of addresses somebody once
    /// thought were LAN.
    fn the_loop_would_block(addr: Ipv6Addr) -> bool {
        let low: Ipv6Addr = "0:0:0:0:ffff:ffff:ffff:ffff".parse().expect("literal");
        let high: Ipv6Addr = "fc00::".parse().expect("literal");
        addr > low && addr < high
    }

    /// The permits and the loop's own filter must partition the address
    /// space between them, with nothing over and nothing missing.
    ///
    /// This is the test that matters most in this file, and the reason
    /// is the third case in the table. A dual-stack socket's **IPv4**
    /// traffic is classified at the IPv6 ALE layer carrying an
    /// IPv4-mapped address, so a block that forgot `::/64` would refuse
    /// a selected application's IPv4 -- which is to say it would break
    /// the feature it is meant to protect, on exactly the machines that
    /// have IPv6 at all, and it would do it silently.
    ///
    /// It can fail: dropping any entry from `SPLIT_PERMITTED`, or
    /// writing `/8` where `/7` belongs on `fc00::`, moves at least one
    /// of these addresses to the wrong side. The boundary rows are there
    /// so an off-by-one in a prefix length cannot pass.
    #[test]
    fn the_permits_are_exactly_what_the_loop_leaves_alone() {
        let cases: [(&str, &str); 13] = [
            ("::", "the unspecified address"),
            ("::1", "loopback"),
            ("::ffff:1.2.3.4", "IPv4-mapped -- a dual-stack socket's IPv4"),
            ("0:0:0:0:ffff:ffff:ffff:ffff", "the top of ::/64, which the loop excludes"),
            ("0:0:0:1::", "one past it, which the loop does take"),
            ("2001:db8::1", "ordinary global unicast"),
            ("2606:4700:4700::1111", "a real public resolver"),
            ("fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "one below fc00::"),
            ("fc00::1", "unique-local, low end"),
            ("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique-local, top end"),
            ("fe80::1", "link-local"),
            ("ff02::1", "all-nodes multicast"),
            ("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "the top of the space"),
        ];

        for (text, why) in cases {
            let addr: Ipv6Addr = text.parse().expect("a literal in this test is malformed");
            assert_eq!(
                permitted_by_the_app_block(addr),
                !the_loop_would_block(addr),
                "{text} ({why}): the WFP permits and the redirect loop's filter disagree \
                 about whether this address is the internet"
            );
        }
    }

    /// The table is a partition, not merely a cover: the control case
    /// for the test above.
    ///
    /// Without this, a `SPLIT_PERMITTED` of `[(::, 0)]` -- permit
    /// everything -- would still have to fail the test above, but only
    /// on the blocked rows. This says the *shape* is right: at least one
    /// address is permitted and at least one is not, so a table that
    /// degenerated in either direction is caught by name rather than by
    /// a row happening to be in the list.
    #[test]
    fn the_app_block_neither_permits_nor_blocks_everything() {
        assert!(
            permitted_by_the_app_block("fe80::1".parse().unwrap()),
            "a block that refuses link-local takes out neighbour discovery"
        );
        assert!(
            !permitted_by_the_app_block("2001:db8::1".parse().unwrap()),
            "a block that permits global unicast is not a block"
        );
    }

    /// `FwpmGetAppIdFromFileName0` against real paths, with a control.
    ///
    /// Runs without administrator rights -- it is a path normalisation,
    /// not a filtering operation -- which makes it the one part of the
    /// per-app block that can be proven on a build machine. What it
    /// proves is narrow and worth stating: that the blob comes back
    /// non-empty for a file that exists, that it is the NT device path
    /// rather than the DOS path handed in, and that a path which does
    /// not exist is refused rather than silently producing a blob that
    /// would match nothing.
    ///
    /// That last case is the control. Without it, a version of
    /// `AppId::resolve` that ignored the return code and handed WFP a
    /// null pointer would pass everything above it.
    #[test]
    fn an_app_id_is_the_device_path_and_a_missing_file_is_refused() {
        let real = r"C:\Windows\System32\cmd.exe";
        let id = AppId::resolve(real).expect("cmd.exe exists on every Windows machine");
        // SAFETY: the blob is live for as long as `id` is.
        let bytes = unsafe {
            std::slice::from_raw_parts((*id.blob).data, (*id.blob).size as usize)
        };
        assert!(!bytes.is_empty(), "an app id with no bytes would match nothing");

        // WFP normalises to a NUL-terminated UTF-16 device path.
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|word| *word != 0)
            .collect();
        let normalised = String::from_utf16_lossy(&words).to_lowercase();
        assert!(
            normalised.starts_with(r"\device\"),
            "expected an NT device path, got {normalised:?} -- if this ever holds the DOS \
             path instead, every filter here silently matches nothing"
        );
        assert!(
            normalised.ends_with(r"\cmd.exe"),
            "the normalised path lost the file it names: {normalised:?}"
        );

        let missing = r"C:\Windows\System32\neoxify-no-such-program.exe";
        assert!(
            AppId::resolve(missing).is_err(),
            "a path that does not exist must be refused, or the block is installed \
             for an application WFP will never recognise"
        );
    }

    /// Hands the real per-app filter set to the real filtering engine,
    /// and then throws it away -- the same trade
    /// [`wfp_accepts_the_whole_filter_set_then_it_is_aborted`] makes,
    /// for the same reason.
    ///
    /// What it proves is that WFP accepts `FWPM_CONDITION_ALE_APP_ID` as
    /// a `FWP_BYTE_BLOB_TYPE` beside an address condition on the same
    /// filter, at `FWPM_LAYER_ALE_AUTH_CONNECT_V6`, in our sublayer, at
    /// these weights. Every one of those is validated inside the
    /// transaction, before anything is committed.
    ///
    /// What it does **not** prove is that a selected application's IPv6
    /// stops. Only a packet capture on the rig can say that; see the
    /// note in `docs/journal/windows.md`.
    #[test]
    fn wfp_accepts_the_per_app_filter_set_then_it_is_aborted() {
        let apps = [
            r"C:\Windows\System32\cmd.exe".to_string(),
            // A second one, because the per-app loop is where a shared
            // buffer would be reused wrongly and one application is not
            // enough to show it.
            r"C:\Windows\System32\ping.exe".to_string(),
        ];
        let app_ids: Vec<AppId> = apps
            .iter()
            .map(|path| AppId::resolve(path).expect("a stock Windows binary"))
            .collect();

        let Ok(engine) = open_dynamic_session_named(SPLIT_SUBLAYER_NAME, "test") else {
            eprintln!("skipped: the filtering engine would not open (needs administrator)");
            return;
        };

        let result = unsafe {
            let begun = FwpmTransactionBegin0(engine, 0);
            if begun != 0 {
                FwpmEngineClose0(engine);
                eprintln!("skipped: no filtering transaction ({begun:#010x})");
                return;
            }
            let result = add_split_filters(engine, &app_ids);
            FwpmTransactionAbort0(engine);
            FwpmEngineClose0(engine);
            result
        };

        match result {
            Ok(filters) => assert_eq!(
                filters,
                apps.len() * SPLIT_FILTERS_PER_APP,
                "one block and one permit per carved-out prefix, per application"
            ),
            Err(e) => {
                panic!("the Windows Filtering Platform rejected the per-app filter set: {e}")
            }
        }
    }
}
