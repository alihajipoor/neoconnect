# Per-game exit selection

**Status:** the preference half is built and unit-tested; nothing has run
on a machine. The concurrent half is **not built** and is described here
so that the reason is on record rather than rediscovered.

**Owner:** Windows session. Touches `ipc/`, `service/src/split_tunnel/**`,
and two lines each in `service/src/pipe.rs`, `service/src/engines/mod.rs`,
`src-tauri/src/vpn.rs`, `src-tauri/src/lib.rs`.

---

## 1. What was asked for, and what is here

The gap against ExitLag is that it lets a customer activate several games
at once and give each its own region (KB72, KB76, KB101, KB269). Neoxify
carries every selected application on one tunnel and therefore one exit.
`docs/research/gaming-ip-reputation.md` already lists this as item 6 of
its gap table, with one word against it: **architectural**.

That word is correct, and this document is the evidence for it. What is
built instead is the intermediate: **per-game exit *preference*.** The
customer names an exit per game; the client connects to that exit when
the game is activated; the service reports, per application, whether it
is on the exit that was asked for. One tunnel, one exit at a time, no
concurrency.

---

## 2. Feasibility: why concurrent multi-exit is an engine change

The instinct is that this is a routing problem, so the routing layer is
where the work is. It is not. The routing layer is the *cheap* part.

### 2.1 `Origin.upstream` is not the seam

`flows::Origin` carries `upstream: Option<SocketAddrV4>`, which looks
like a per-flow egress override waiting to be used. It is not, and it is
not a vestige either: it is live, set at `redirect.rs` in the DNS branch,
and it means **"dial this address instead of the one the app asked
for"**. It changes the *destination*. The egress is chosen somewhere
else entirely.

### 2.2 The real seam is one pair of atomics

Every onward socket the relay creates is pinned in `proxy::connect_upstream`
and `proxy::bind_upstream`, both of which take a `&TunnelInterface`:

```rust
pub struct TunnelInterface {
    index: AtomicU32,
    address: AtomicU32,
}
```

One interface index, one source address, shared as an `Arc` into the
relays and the redirect loop, already swappable at runtime via `set` and
`clear`. Making this a *table* keyed by exit, with `Origin` carrying
which key to use, is a genuinely modest change — a few hundred lines,
mechanical, and testable.

**And it would buy nothing**, because there is only ever one tunnel for
the table to hold.

### 2.3 What actually blocks it

The service can hold exactly one engine, by construction:

```rust
enum Active { WireguardTunnel, Ikev2, Child { .. } }

mod session {
    pub(super) struct Slot(Option<Active>);
}
```

`Slot` is a newtype over a single `Option` in a private module with no
setter that empties it. The only way out is `Slot::end`, which takes the
`SplitTunnel` by `&mut` and stops it — and the module's own note says
why: *"Ending a session and stopping interception are one operation
because they cannot be allowed to be two."* That shape was built in
response to a field incident on 2026-08-23. With two engines, ending
either would tear down interception for both.

Below `Slot` sit the singletons, and they are the bulk of the work:

| Kind | Instances |
|---|---|
| Fixed adapter / tunnel / service names | `neoconnect`, `WireGuardTunnel$neoconnect`, `neoconnect0`, `Neoxify-OpenVPN`, `Neoxify` |
| Fixed config and log paths | `neoconnect.conf`, `xray-client.json`, `neoconnect.ovpn`, `xray.log`, `openvpn.log` |
| Fixed addresses | Xray's `TUN_GATEWAY` `198.18.0.1/30` |
| One routing metric | `PASSIVE_METRIC = 9999`; two passive defaults at the same metric is an unresolved tie |
| Machine-wide DNS | a process-global `TUNNEL_DNS` mutex, and one `.`-namespace NRPT rule under one comment tag |
| Machine-wide WFP | a single `Option<Ipv6Block>` on a process-scoped dynamic session |
| Split tunnel | one WinDivert loop pinned to one `(index, address)`; one route; one `netsh` rule name; one excluded node address |
| Housekeeping | a janitor that kills by image name under `exe_dir`, and rival-VPN detection that would report our own second adapter as a rival |

And the rig has already said something about the appetite for this:
under `claude/split-tunnel-rig-verification`, **three of four engines
could not activate at all within their timeouts on a slow guest**.
Bringing two up concurrently makes that strictly worse.

### 2.4 The cheapest real path to concurrency, when it is wanted

Not two engines. **One Xray engine with several inbounds.**

`xray.rs::build_config_for` emits a single-element `outbounds` array
against a single `Outbound`. xray-core itself supports many outbounds
selected by routing rules keyed on `inboundTag` — and that is not
speculation here, it is the mechanism already proven on the node side
(`docs/journal/windows.md`, "The multi-exit design is proven at the
node": `ProtocolConfig.inboundTag` gives each inbound its own distinct
outbound, 11 of 12 relay routes confirmed by exit IP).

The client shape would be: N loopback SOCKS inbounds, each tagged to its
own outbound, each outbound a different exit node. The relay stops
pinning to an adapter and instead dials the SOCKS inbound for the flow's
chosen exit. `TunnelInterface` becomes a table of relay targets rather
than of interface indices.

Its costs, stated plainly:

- **Xray only.** WireGuard, OpenVPN and IKEv2 get one exit. That is a
  platform gap to state, not a reason to drop a protocol.
- The relay must speak SOCKS5, which it does not today.
- The backend must be willing to issue several exits on one subscription
  and the panel must be able to express that.

---

## 3. What is built

### 3.1 The wire

```rust
pub struct SplitTunnelConfig {
    pub enabled: bool,
    #[serde(default)] pub mode: SplitTunnelMode,
    pub apps: Vec<String>,
    #[serde(default)] pub scopes: Vec<AppScope>,
    #[serde(default)] pub exits: Vec<AppExit>,        // new
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egress: Option<String>,                        // new
}

pub struct AppExit { pub app: String, pub exit: String }
```

Both additive on exactly the terms `mode` and `scopes` were. No existing
field changed shape. An older app sends neither and gets what it had; a
newer app talking to an older service has both ignored, which carries
every application on the one exit — a narrowing of what the customer
asked for, never a change to what is carried. Both directions have a
test.

`exit` is an **opaque identifier**. The service never resolves it to an
address, a node or a route; it compares it for equality against `egress`
and does nothing else with it. That is deliberate twice over: it keeps
the service from acquiring an opinion about which exits exist (the
backend's fact, which changes without the service being told), and it
keeps node addresses out of this protocol — see
`docs/node-address-hygiene.md`.

### 3.2 Why the client supplies `egress`

The service can see which adapter is up and which address is on it.
Neither says which *node* the far end egresses from. On a relayed route
they are different machines.

That distinction is the whole point of the field. A relayed route
presents the **exit** node's address to whatever the customer connects
to; the relay's address is never seen by the far end. An identifier
taken from the entry would be silently wrong for exactly the routes
where the customer's choice matters most. The client dialled the route
and is the only side holding that fact.

### 3.3 The four answers

```rust
pub enum ExitPlacement {
    NoPreference,
    OnPreferred,
    Fallback { preferred: String },
    Unknown   { preferred: String },
}
```

Four rather than a boolean, following `Scoped` and `Unattributed`.
`Unknown` is the one that earns its place: with no live session, or no
egress named, reporting `OnPreferred` claims a match nobody established
and reporting `Fallback` claims a mismatch nobody established. Neither
is a thing this product says.

Read via `Request::SplitTunnelExits` → `Response::ExitPlacements`, its
own round trip rather than another field on `Status`, because the status
poll runs continuously and this answer costs a walk of the selection.

### 3.4 The honesty coupling

`SplitTunnel::exit_placements` reports the egress **only while a session
is actually intercepting** — not while Custom mode is on in settings,
not because the client named one last time, not because a tunnel is up.
Without that gate this is a surface that reports a request as an
observation, which is the same class of claim as a "Connected" indicator
that nothing checked.

`set_selection` *replaces* the egress rather than merging it. A config
naming none means the client is not asserting one now, and keeping the
old value would report a stale exit for a tunnel that may have been
rebuilt against a different node.

---

## 4. How it composes with the two leak fixes

The short version: **`decide` is unchanged.** Not "carefully adjusted" —
unchanged. Neither leak fix can regress through a code path that does
not exist.

The reason it is unchanged is structural rather than lucky. The existing
two axes both answer **whether** a packet is carried:

- `should_tunnel(image)` — is this application's traffic ours?
- `destination_scope(image, dst)` — and is *this packet* of it?

The exit axis answers **where** a flow that is already carried leaves
from. It cannot narrow, cannot widen, and cannot turn a carried packet
into an uncarried one or the reverse. With one live egress there is
nothing to select between, so the packet path never asks.

That leaves two specific compositions to state, because both are how the
*next* version of this feature would break them.

### 4.1 Against `verdict_for_unattributed`

The refusal of an ownerless UDP datagram to a public destination
deliberately inverts fail-open. An exit preference belongs to an
application; a packet nobody can be shown to have sent has no
application, so it can never acquire one. `preferred_exit` takes an
`image_path`, exactly as `destination_scope` does, and that signature is
the enforcement rather than a convention.

**The trap in the multi-exit version** is to give an unattributed
datagram a *default exit* and send it there. Choosing where to send a
packet means having already decided to carry it — which is precisely the
fire-and-forget leak (13 of 15 datagrams in the clear on one rig run, 14
on the next). So:

> **Exit selection must sit strictly downstream of the carry decision.**
> `Origin` is built only after `selected` is true. That is the correct
> attachment point for a future `Origin.exit`, and it is already where
> the code puts it.

Two tests hold this: one asserts the refusal is byte-for-byte identical
with and without preferences configured, one drives a real dead-socket
datagram through `decide` with preferences present and requires `Drop`.

### 4.2 Against the flow-keyed leave-alone cache

`Tables.direct` is keyed on the whole `FlowKey` — transport, client
port, destination, destination port. **It must not grow an exit
component.** The cache records "this flow is not carried", which is a
fact about an application and a peer and is true whichever exit the
session happens to be on. Adding an exit would multiply the entries a
chatty socket produces and push the table toward its overflow path for a
distinction that does not exist.

This is now the *third* feature that key is load-bearing for. The
journal already notes that re-keying it on the port breaks the leak fix
and destination scoping together; it now breaks this as well, and there
is a test that says so.

### 4.3 Fail-open on the new axis

Deliberate and total, in three places:

1. **Validation.** An `egress` that matches no preference is not an
   error. Refusing it would reject the whole `SetSplitTunnel` request
   and take the customer's app selection down with it — over a
   preference that is merely unsatisfiable right now, which is the
   ordinary case every time they connect somewhere else.
2. **Routing.** An application whose preferred exit is not live is
   carried on the live one. A game that keeps working from the wrong
   address beats a game that stops.
3. **Reporting.** The mismatch is surfaced as `Fallback` with the exit
   that was asked for, so the app can offer to reconnect there rather
   than silently doing nothing.

---

## 5. Ban-safety

`docs/design/ban-safety.md` mechanism 5 records, for Blizzard's legacy
Diablo II, that where an address is shared a restriction *"will affect
all users of the IP address"* and support cannot lift it. Its conclusion
is that blast radius is a design input and that concentrating gaming
traffic onto one "clean" exit is actively bad.

Per-game exits spread that risk, and that is an argument **for** this
feature rather than an incidental benefit.

Three constraints from the same document that this design does not
contradict, and one it defers:

- **No automatic selection.** Choosing an exit from reputation data is a
  separate decision with its own evidence problem. Nothing here does it,
  and `AppExit`'s own note says so, so a later reader does not mistake
  the plumbing for permission.
- **All-or-nothing per game** (mechanism 3). Two games on two exits is
  fine; one game's launcher and client on two exits is the two-source-IP
  signature. Preferences are keyed on the executable, so a game whose
  launcher and client are separate binaries needs *both* pointed at the
  same exit. **The catalogue must emit them as a group.** This is the
  sharpest open item in the client half.
- **Region defaults near the player** (mechanism 7). Region/entitlement
  mismatch is publisher-documented and is triggered by apparent region,
  not by the address being a datacenter address. A picker that invites a
  distant exit for a *game* has to say why that differs from picking one
  for browsing. UI work, not service work.
- **Deferred:** `gaming-mode.md` §5.5's per-profile `failClosed` is
  still unbuilt, and §5.4 says a destination filter must not change
  mid-session. The same argument applies to an exit: switching one
  mid-session is an impossible-travel signature. Today an exit changes
  only by reconnecting, which is a session boundary, so the hazard does
  not arise — **but a future "switch exit without dropping" feature
  reintroduces it and must not be built without reading §5.4.**

---

## 6. Limits, stated

- **`OnlySelected` only.** Under `AllExcept` the named applications are
  the ones deliberately not carried, so they have no egress and a
  preference for one would be an invention — the same rule `with_scopes`
  applies. "Everything except these" has no vocabulary for naming the
  applications that *are* carried, so there is nothing to hang a
  preference on.
- **One honoured preference per session.** If two activated games prefer
  two different exits, one gets `OnPreferred` and the other `Fallback`.
  That is the feature's ceiling until §2.4 is built, and it is reported
  rather than hidden.
- **Nothing here verifies the node.** The service reports which exit the
  client *dialled* and whether interception is live. Whether that is the
  address the far end sees is a fact about the node, and the only ground
  truth for it is an exit-IP check made through the tunnel.
- **Not run on a machine.** See §7.

---

## 7. Rig procedure

Not executed — no rig time was available in this session. The unit tests
prove routing logic, not behaviour on a machine, and this project's
standard for the latter is an exit IP that matches the chosen node, not
a status string.

Ground truth for each case is `curl -4 https://api.ipify.org` (or
equivalent) issued **from a socket pinned exactly as a selected
application's is**, i.e. through `ProbeSplitTunnel`'s path, and the
answer compared against the chosen node's address. Two standing traps
from `gaming-mode.md` §14 apply: **force IPv4** (nodes have v6 and a v6
answer fakes a total failure), and `urllib` cannot speak SOCKS.

| # | Case | Expected |
|---|---|---|
| 1 | Game prefers the exit the client connected to | exit IP == that node; placement `onPreferred` |
| 2 | Game has no preference | exit IP == session's node; placement `noPreference` |
| 3 | Game prefers an exit the client did not connect to | **traffic still flows**, exit IP == session's node, placement `fallback` naming the other |
| 4 | Two games, two different preferences, one session | both carried; one `onPreferred`, one `fallback` |
| 5 | Custom mode on, no session started | `egress: null`, every preference `unknown` |
| 6 | Preferences configured, dead-socket UDP burst | 0 datagrams on the vNIC capture; `refused_unattributed` climbs |
| 7 | Preferences configured, one port to two peers | leave-alone verdict for one peer does not answer for the other |

Cases 6 and 7 are the leak-fix regressions and must be run **on an
unfixed build first** — the discipline `claude/split-tunnel-rig-verification`
established, because the unfixed build's own counters read `escaped=0`
straight through a leak of 25 datagrams. A build that shows zero without
that comparison is a machine being observed, not a fix being tested.

Case 3 is the one that cannot be faked by a status string and is the
reason the table asks for an exit IP in every row.

---

## 8. Open question for the owner

**Does a subscription get more than one exit at a time?**

Everything above is client-side and works with the exits a customer
already has. The concurrent version in §2.4 needs the backend to issue
several exits on one subscription, and that is a commercial decision
about what a plan includes, not a technical one. The recommendation is
that per-game *preference* ships first regardless, because it delivers
the customer-visible benefit — pick an exit per game, activate the game,
land on that exit — without it.
