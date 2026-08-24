//! Blocking IPv6 for the duration of a full tunnel, because there is
//! nowhere to carry it.
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
    FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmProviderAdd0, FwpmSubLayerAdd0,
    FwpmTransactionAbort0, FwpmTransactionBegin0, FwpmTransactionCommit0, FWPM_ACTION0,
    FWPM_CONDITION_FLAGS, FWPM_CONDITION_IP_REMOTE_ADDRESS, FWPM_FILTER0, FWPM_FILTER_CONDITION0,
    FWPM_FILTER_FLAG_NONE, FWPM_LAYER_ALE_AUTH_CONNECT_V6, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    FWPM_PROVIDER0, FWPM_SESSION0, FWPM_SESSION_FLAG_DYNAMIC, FWPM_SUBLAYER0, FWP_ACTION_BLOCK,
    FWP_ACTION_PERMIT, FWP_ACTION_TYPE, FWP_CONDITION_FLAG_IS_LOOPBACK, FWP_CONDITION_VALUE0,
    FWP_CONDITION_VALUE0_0, FWP_MATCH_EQUAL, FWP_MATCH_FLAGS_ALL_SET, FWP_UINT32, FWP_UINT8,
    FWP_V6_ADDR_AND_MASK, FWP_V6_ADDR_MASK, FWP_VALUE0, FWP_VALUE0_0,
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
    let mut name = wide(SUBLAYER_NAME);
    let mut description = wide("Blocks IPv6 while a Neoxify full tunnel is up");

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
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            Scope::Loopback,
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit ::1 ({direction})"),
            layer,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            Scope::RemotePrefix(Ipv6Addr::LOCALHOST, 128),
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit link-local fe80::/10 ({direction})"),
            layer,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            Scope::RemotePrefix(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
        )?;
        add_filter(
            engine,
            &format!("Neoxify: permit multicast ff00::/8 ({direction})"),
            layer,
            FWP_ACTION_PERMIT,
            WEIGHT_PERMIT,
            Scope::RemotePrefix(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
        )?;
        add_filter(
            engine,
            &format!("Neoxify: block all {direction} (IPv6)"),
            layer,
            FWP_ACTION_BLOCK,
            WEIGHT_BLOCK,
            Scope::All,
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
enum Scope {
    /// Everything at the layer. No conditions at all, which is how a
    /// catch-all block is expressed in WFP.
    All,
    /// A remote address prefix, e.g. `fe80::/10`.
    RemotePrefix(Ipv6Addr, u8),
    /// Traffic Windows itself has identified as looping back, whatever
    /// address it carries.
    Loopback,
}

/// # Safety
/// Called only from [`add_everything`], inside an open transaction.
unsafe fn add_filter(
    engine: HANDLE,
    name: &str,
    layer: GUID,
    action: FWP_ACTION_TYPE,
    weight: u8,
    scope: Scope,
) -> Result<(), String> {
    let mut display_name = wide(name);
    let mut provider_key = PROVIDER_KEY;

    // Backs the condition's union pointer and must outlive the
    // FwpmFilterAdd0 call below, which is why it is declared here rather
    // than inside the match.
    let mut address = FWP_V6_ADDR_AND_MASK { addr: [0u8; 16], prefixLength: 0 };

    let condition: Option<FWPM_FILTER_CONDITION0> = match scope {
        Scope::All => None,
        Scope::RemotePrefix(prefix, length) => {
            address.addr = prefix.octets();
            address.prefixLength = length;
            Some(FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_V6_ADDR_MASK,
                    Anonymous: FWP_CONDITION_VALUE0_0 { v6AddrMask: &mut address },
                },
            })
        }
        Scope::Loopback => Some(FWPM_FILTER_CONDITION0 {
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
        }),
    };

    let mut conditions = condition.into_iter().collect::<Vec<_>>();

    let mut filter: FWPM_FILTER0 = std::mem::zeroed();
    filter.displayData.name = display_name.as_mut_ptr();
    filter.flags = FWPM_FILTER_FLAG_NONE;
    filter.providerKey = &mut provider_key;
    filter.layerKey = layer;
    filter.subLayerKey = SUBLAYER_KEY;
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
}
