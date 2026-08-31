# Per-game exit selection

**Status:** the preference half is built and unit-tested, **and it now
has a picker** -- see section 9 for the exit identifier that unblocked
it. **The concurrent half described in section 2.4 is now built too** --
see section 10 for what that means and what it does not. Nothing in
either half has run on a machine: no rig time was available in any of
the sessions that built them, so every claim below is a unit test or a
structural argument, never an observed exit IP.

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

#### 2.4 The cheapest real path to concurrency, when it is wanted

> **Built.** This section is kept as the reasoning that led there;
> section 10 records what it actually became, including the two costs
> below turning out cheaper than they read here.

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
  same exit. **Built — see §5.1.** It was the sharpest open item in the
  client half.
### 5.1 Exit groups: a game's binaries go to one exit, or to none

The catalogue already emitted the group and the client threw it away.

`GameProfile.processNames` **is** the group — one row is one game, and
the catalogue's own note says so: *"One row therefore lists both, and the
client routes whichever are running."* Nothing was missing from the data.
What happened was that `CustomModeCard.addGame` resolved a profile's
names against running processes and appended the resulting paths to one
undifferentiated `SplitTunnelSettings.apps` list, at which point the fact
that `Rust.exe` and `RustClient.exe` are one game no longer existed
anywhere in the client. So the fix adds no catalogue field. It stops
discarding the one that was already there.

**Where the group lives now:** `SplitTunnelSettings.games`, a list of
`GameExitGroup { slug, displayName, names, exit }`. `names` is the
*catalogue's* list, not the paths that resolved — membership and
completeness are derived against the live `apps` selection every time
they are asked for. That is deliberate in both directions: a customer who
starts the missing binary and adds the game again gets a whole group with
no stale record to correct, and a customer who removes one binary by hand
loses the preference for the whole game rather than keeping a record
claiming it is whole.

**The exit is on the group and nowhere else.** There is no per-application
exit field anywhere in the client's persisted state, so a customer cannot
put a game's launcher and its client on two exits by hand — there is
nowhere to write it. That is the structural half of item 4, and it is
worth more than a warning, because a warning does not cover a state the
app persists and reloads.

#### The three rules, and they all fail toward *no preference*

`exitsForGames(groups, apps)` is the only producer of an `AppExit` in this
client. It takes the whole group list and the whole selection, so there is
no call shape that can hand it a single executable.

1. **No exit chosen, nothing emitted.** The overwhelmingly common case,
   and unchanged behaviour.

2. **A partial group gets no preference at all.** This is the hard case
   and the one that must not be answered with "place the ones you found
   and hope". `curatedNames()` resolves against *running* processes, so a
   launcher is routinely up while the game is not — which is the ordinary
   state of a machine at the moment somebody adds a game — and Vanguard's
   `vgc.exe` runs as a windowless service `vpn_list_running_apps` filters
   out entirely. Placing `Rust.exe` on Germany and letting `RustClient.exe`
   start later is the two-source-IP split, and **it does not need a second
   exit to happen**: the unselected binary is not carried at all, so it
   reaches the game's servers from the customer's own address in Iran
   while its sibling reaches them from the node.

3. **A binary claimed by two games that want different exits withholds
   both.** Not hypothetical: `RiotClientServices.exe`, `vgc.exe` and
   `vgm.exe` are each in both VALORANT and League of Legends,
   `Battle.net.exe` is in both the Battle.net row and World of Warcraft,
   and **61 executable names in the shipped catalogue appear in more than
   one entry** (`hl2.exe` in eleven Source titles, `dowser.exe` in eight
   Paradox-launcher titles). One process cannot leave from two places, so
   honouring either game places the shared binary away from the other game
   that also runs it — the same split with a second account attached.
   Withholding both is the only answer that splits neither.
   `sharedProcessNames()` and `entangledSlugs()` in
   `prisma/catalogue/index.ts` are the same computation, exported so the
   shape of the problem is pinned by a test rather than discovered by a
   customer.

Rule 3 is pairwise, not transitive. A sharing with B and B sharing with C
does not stop A and C differing, because no single process is claimed by
both, and the rule is about one executable being asked to leave from two
places.

#### What is structurally prevented, and what is only enforced

| | |
|---|---|
| A customer hand-splitting a game | **Structural.** No per-application exit field exists to write one in. |
| The client emitting a subset of a group | **Structural.** `exitsForGames` iterates a group's own membership; there is no partial path through it. |
| A config that names two exits for one group | **Refused** at `SplitTunnelConfig::validate`, whoever sent it. |
| One application named twice with two exits | **Refused** at the same place — the same contradiction with the group filed off. |
| A group whose members are not all selected | **Dropped whole** by `Selection::with_exits`, independently of the client. |
| A game whose catalogue row lost half its binaries | **CI failure**, `scripts/check-exit-groups.sh`. |
| A game only partly added to Custom mode | **Warned, not prevented** — see below. |

The last row is the honest one. A partly-added game is still *carried*,
because refusing to carry it would take a working game away, and the split
it creates is the pre-existing behaviour of Custom mode rather than
something exit selection introduced. What changed is that the card now
says so, permanently, on the row rather than once in a notice the customer
scrolled past — `settings.customGameSplit` / `…SplitBody`, in en and fa.

#### Why `validate` refuses rather than failing open

Every other check on `exits` fails open, and §4.3 explains why: an
unsatisfiable preference is the ordinary case, and refusing would reject
the whole `SetSplitTunnel` and take the customer's app selection down with
it. A config naming two exits for one game is not unsatisfiable — it is
**self-contradictory**. No live egress, present or future, satisfies it,
and honouring any part of it is the signature itself. This client cannot
produce one, so one arriving means a sender that is broken or is not us,
and the safe reading of either is to act on none of it.

#### Composition with the two leak fixes

Unchanged, and for the same structural reason §4 gives. `preferred_exit`
still takes an `image_path`; the group rule runs entirely inside
`Selection::with_exits`, which is construction, not the packet path;
`decide` is still untouched; `FlowKey` still has no exit component and now
no group component either — a group is a fact about an application and a
catalogue row, never about a flow. The tests that pin all three still
pass unmodified, which is the evidence rather than the claim.

#### Costs, stated

- **A game with a windowless binary may never qualify for a per-game
  exit.** VALORANT's group includes `vgc.exe`, which the running-app list
  filters out, so VALORANT's group will normally be partial and will
  normally get no preference. That is the honest answer — nobody can say
  where a process they cannot see will egress — and it is a gap in
  process enumeration, not a reason to relax the rule.
- **No `optional: true` on a catalogue name.** It is the obvious escape
  hatch and it is the `prefixComplete` failure exactly: an operator
  marking a binary optional is writing a plausible subset, and a
  completeness claim nobody can re-derive is a completeness claim that
  will silently rot.
- **Most of the catalogue pays nothing.** 1,203 of 1,483 entries are a
  single executable, so for 81% of games a whole group is one running
  process.

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
- ~~**No exit vocabulary exists on the client yet, so no picker is
  built.**~~ **Resolved -- see section 9.** `RouteOption` now carries an
  opaque per-customer `exit` handle naming the machine a route egresses
  from, the client groups routes by it, and the connect path sends the
  landed route's handle as `egress`. `Unknown` is still reachable and is
  still the answer whenever nothing is intercepting.
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
| 8 | Multi-binary game added at its launcher, then fully started | while partial: no preference, both placements `noPreference`; after re-adding with everything running: **one** exit IP for every binary |
| 9 | Two games sharing a binary, two exits | neither honoured; every binary of both reports `noPreference` and one exit IP |

Row 8 is the one that cannot be faked by a unit test. The assertion is
not the placement string — it is `curl -4` from a socket pinned as
`Rust.exe` and again as `RustClient.exe`, and **the two answers being
byte-identical**. Two different answers is the ban risk, live.

Cases 6 and 7 are the leak-fix regressions and must be run **on an
unfixed build first** — the discipline `claude/split-tunnel-rig-verification`
established, because the unfixed build's own counters read `escaped=0`
straight through a leak of 25 datagrams. A build that shows zero without
that comparison is a machine being observed, not a fix being tested.

Case 3 is the one that cannot be faked by a status string and is the
reason the table asks for an exit IP in every row.

---

## 8. Open question for the owner -- answered

**Does a subscription get more than one exit at a time?**

> **Yes, and it already did.** `ProtocolUsersService.provisionAll`
> provisions a subscription on every route its plan allows and the
> client holds all of them at once, so the credentials for several
> exits were already on the customer machine before this was asked. No
> commercial decision turned out to be needed and no backend change was
> made. See section 10.1. What follows is the question as it stood.

**Still open, and deliberately not decided in code.** What section 9
shipped is *preference*, applied on connect: one session, one tunnel,
one exit. The API says so (the comment on the field in
`RoutesService.listAvailableForPlan`), the picker says so on the card
(`settings.customExitOneAtATime`, en and fa), and nothing in either
implies two exits can be live together. Whichever way the answer goes,
nothing here has to be undone -- the concurrent version in section 2.4
adds engine work, it does not change the identifier.

Everything above is client-side and works with the exits a customer
already has. The concurrent version in §2.4 needs the backend to issue
several exits on one subscription, and that is a commercial decision
about what a plan includes, not a technical one. The recommendation is
that per-game *preference* ships first regardless, because it delivers
the customer-visible benefit — pick an exit per game, activate the game,
land on that exit — without it.

---

## 9. The exit identifier

### 9.1 Why the backend withheld one, and what that turned out to mean

`RoutesService.listAvailableForPlan` never exposed a relay's exit, and
the code says why in two places rather than one:

* the `select` is explicit rather than an `include`, because a plain
  `include` returns the raw `Route` row and that row carries
  `uplinkCredentialsJson` -- **the relay's shared exit-node secret**;
* the endpoint comment adds that only the *entry* endpoint is published,
  "per the same reasoning that keeps `uplinkCredentialsJson` out of this
  response -- and the entry is what the client connects to anyway".

So the withholding was **not** a considered opsec position on naming
exits. It was one narrow, correct refusal -- a credential -- plus the
observation that the exit was not needed for the only thing the endpoint
did, which was drive a location picker. Nothing anywhere argued that a
customer must not be able to tell two exits apart, because nothing had
ever wanted to.

That reading matters, because it decides the shape of the answer. Had
the reason been "never name which machine a relayed route egresses
from", a plain exit id would have been off the table. Had it been "it was
simply never needed", a plain exit id would have been fine. The reason
turned out to be the second -- **and a plain exit id is still the wrong
answer**, for a reason that comes from somewhere else entirely:
`docs/node-address-hygiene.md` and the enumerability measurement behind
it. On identical infrastructure, the operator who publishes its node list
is flagged `is_vpn` and the operator who does not is clean; Neoxify
measures clean today precisely because nothing of ours is
machine-readable. A stable global exit id is a fleet identifier -- anyone
with two accounts, or anyone aggregating what clients send, could count
the exits and join sightings of one exit across unrelated customers.

### 9.2 What was built

`RouteOption.exit` -- an **opaque, per-customer, keyed digest** of the
node a route egresses from:

```
key    = HMAC-SHA256(EXIT_HANDLE_SECRET, "neoxify:exit-handle:v1")
handle = base64url(HMAC-SHA256(key, customerId + " " + exitNodeId)[0..16])
```

The node is `route.exitProtocolConfig.nodeId` for a relayed route and
`route.entryProtocolConfig.nodeId` for a direct one -- in both cases the
machine whose address the far end actually sees.

| Property | Why it is needed |
|---|---|
| Comparable | "these two games are on the same exit", by string equality, which is the whole of what the client and the service do with it |
| Stable | a preference saved last month still names the same exit |
| Not reversible | holds no address, hostname or node id, and cannot be recomputed without the secret |
| Salted per customer | two customers' handles for one machine differ, so they cannot be joined and the fleet cannot be counted across accounts |
| Absent by default | no secret configured means `null`, so no picker and every placement `Unknown` -- exactly the behaviour that shipped before |

`EXIT_HANDLE_SECRET` is generated by the installer, falls back to
`CREDENTIALS_ENCRYPTION_KEY` under its own derivation label so an
existing deployment is not left with a dead feature, and **must stay
stable**: rotating it renames every exit. That degrades in the safe
direction -- a stale handle cannot collide with a fresh one, so it can
produce `Fallback` and never a false `OnPreferred` -- and costs the
customer a re-pick.

### 9.3 The client half

* `exit-options.ts` groups the route list by handle. Two protocols on
  one node, and a relay whose exit leg is a node also reachable
  directly, all fold into **one** option. An exit reached only through
  relays is marked `hidden` and is never labelled with the relay's own
  node name -- that name is the *entry*, and borrowing it would tell a
  customer their traffic appears from Iran when it appears from Germany.
* The picker lives on the Custom mode card, writes to
  `GameExitGroup.exit` and nowhere else, and is offered only under
  `OnlySelected` and only when the route list can name an exit at all.
* `Dashboard` sends `egress` **after** a candidate comes up, taken from
  the route the ladder *landed* on rather than the one on screen -- those
  come apart routinely, and an egress from the intended route would tell
  a customer their game is on the exit they chose while it is somewhere
  else. Every push before that names none.
* The card shows the four answers unchanged. `Unknown` stays reachable
  and is what a customer sees before connecting, because the service
  gates the egress on interception being live.

### 9.4 What is still not proven

The end-to-end path is proven over a real HTTP round trip against a real
Nest server (`exit-identity-delivery.spec.ts`), including that no exit
node's address, hostname or id appears in the payload. **No database was
reachable** for this work, so that spec runs against a Prisma stand-in
that applies `select` the way Prisma does -- which pins the projection,
the layer the analogous past bug lived in, but not the query itself.

Nothing has been run on a machine or against a node. Whether two routes
sharing a handle really egress from one address is a fact about the
fleet, and section 7's table is still the only thing that would
establish it.

---

## 10. Concurrent exits, as built

Section 2.4 proposed one Xray process with several tagged inbounds and
called it "the cheapest real path to concurrency". That is what was
built. This section records the shape it took, the two questions section
2.4 left open and how they turned out, and what is still unproven.

### 10.1 The two open questions, answered

**"The relay must speak SOCKS5, which it does not today."** The relay in
that sentence is the *desktop client's own* split-tunnel relay in
`service/src/split_tunnel/proxy.rs`, not a relay node — a distinction
worth stating because the phrase reads both ways and the two answers are
very different. A survey of `agent/**`, `apps/backend/**` and
`installer/**` finds **no SOCKS anywhere on the node side**: every match
is the substring inside "shadowsocks". The node's Xray speaks exactly
two outbound protocols, `freedom` and `vless`+REALITY, and its inbounds
are seven fixed tags in a shell-templated config.

So this was **client-side work and needed no node change at all**. It is
`split_tunnel/socks.rs`: a SOCKS5 client with CONNECT and UDP ASSOCIATE,
no authentication, IPv4 only, tested against a real socket rather than a
mock.

**"The backend must be willing to issue several exits on one
subscription."** It already was, and had been for longer than the
question was open. `ProtocolUsersService.provisionAll` provisions a
subscription on **every route its plan allows**, and its own note says
the client holds all of them at once so it can fail over without asking
the server. One route is at most one exit, but a subscription holds many
routes — so the credentials for three concurrent exits were already on
the customer's machine. Nothing was added to the backend, no endpoint
was called that was not called before, and no production node was
touched.

What *was* missing was the vocabulary: no way for a customer to say
"these two routes are the same place". That is section 9's salted exit
handle, built in parallel by another session, and the two halves compose
without either being reshaped.

### 10.2 The shape

One Xray process. The primary outbound stays `outbounds[0]` and stays
tagged `proxy`, and there is deliberately **no routing rule matching
`tun-in`** — so everything with no preference, and all DNS, takes
exactly the path it took before this existed. With no extra exits the
generated config is byte-identical to the old one, which is asserted
rather than assumed.

Each additional exit adds three things that only ever address each
other:

| | |
|---|---|
| inbound `exit-N-in` | SOCKS5, `127.0.0.1`, `udp: true`, sniffing off |
| outbound `exit-N-out` | that exit's node |
| rule | `inboundTag: [exit-N-in] -> outboundTag: exit-N-out` |

Loopback because the split tunnel's WinDivert filter ends in `not
loopback`, so the relay's hop into Xray is invisible to the loop that
would otherwise capture it and feed it back to itself. SOCKS5 because it
is the one inbound xray-core offers that carries both TCP and UDP and
lets the caller name a destination per connection — a second TUN inbound
would need a second adapter, address range and route metric, which is
the singleton problem 2.3 describes; a dokodemo-door inbound has one
fixed destination and cannot carry a game to the several addresses it
talks to.

`udp: true` is not optional. Games are predominantly UDP, and an inbound
without it accepts the TCP handshake and silently drops every datagram —
a game that connects, shows a server list and never updates.

### 10.3 What section 2.3's blockers turned into

Nothing. That is the point of the design and it is worth being explicit,
because the list in 2.3 is long enough to look like it must still apply
somewhere.

`session::Slot` still holds one `Active`. There is still one adapter,
one `neoconnect0`, one `198.18.0.1/30`, one `PASSIVE_METRIC`, one
process-global DNS mutex, one machine-wide IPv6 WFP block, one WinDivert
loop pinned to one `(interface, address)`, and one janitor killing by
image name. **None of them is touched.** What changed is only what
xray-core does with a connection after it arrives, which is what its
routing table is for.

### 10.4 The routing seam

2.2 identified `TunnelInterface` — two atomics holding one interface
index and one source address — as the real seam, and predicted that
making it a table keyed by exit would be "a few hundred lines,
mechanical, and testable". That turned out to be right in shape and
wrong in kind: the table is not of interface indices, because a
concurrent exit is not an adapter.

`proxy::ExitRelays` holds `exit identifier -> loopback port`, written
when an engine starts and cleared when it stops, never edited in
between. `flows::Origin` gains `exit: Option<u8>`, an index into it.

An index rather than the identifier because `Origin` is `Copy` and is
held per live flow; a `String` would make it neither and would allocate
on the packet path. The index is meaningful only because the table is
fixed for a session's life — so preferences, which *are* mutable
mid-session, live on `Selection` and say which exit an application
wants, while `ExitRelays` says which exits exist. Separately mutable
precisely so the index a flow holds cannot come to mean a different node
underneath it.

### 10.5 The invariants, and how each survived

**A game's binaries never split across exits.** Untouched and still
structural: the group rules live in `Selection::with_exits` and
`exitsForGames`, both of which are construction rather than the packet
path. Re-proven by mutation — removing the partial-group rule fails
`a_partly_selected_group_gets_no_preference_at_all` and
`a_partly_selected_group_does_not_disturb_a_whole_one`.

One new hazard did appear here and is worth recording because it is
invisible from the rules above. A SOCKS5 hop that fails **must not fall
back to the tunnel adapter.** Every other fail-open in this feature is
safe because it happens to the whole selection at once — an exit is
either in `ExitRelays` or it is not, so every binary of every game moves
together. A per-connection fallback is not that: it would fire for one
connection of one binary while its siblings stayed on the exit, which is
the two-source-address signature rebuilt at runtime, below every check
that prevents it. So the connection fails instead, the application
retries, and if the inbound is genuinely gone the engine's teardown
clears the whole table and moves every game back together.

**`FlowKey` must not grow another component.** It did not, and the guard
is now a destructuring with no `..` in `flows.rs`, so a fifth field is a
compile error (`E0027: pattern does not mention field ...`) rather than
a test that happens to fail. That is the only instrument that catches
the mistake in the form it would arrive in: somebody adds `exit` because
a flow's exit feels like part of its identity, every existing test still
passes because every existing flow has `None`, and nothing says
otherwise until a customer's table overflows.

**Exit selection sits strictly downstream of the carry decision.** The
attachment point is the one 4.1 named: `Origin.exit`, built after every
`return` in `decide` that refuses, drops or leaves a packet alone.
`exit_for` takes an `image_path`, so an unattributed packet has no image
to pass and therefore no exit to acquire.

The one carried packet with no application behind it is a DNS query —
carried whoever makes it — and it takes `exit: None` explicitly. That is
a real limit stated plainly: a game's lookups go through the session's
exit, not the game's. A per-game resolver is a second feature with its
own evidence problem.

Proven by two mutations. Giving the ownerless DNS branch a default exit
fails `a_carried_lookup_takes_the_session_exit_and_not_a_games`. Moving
exit selection upstream of the refusal — the literal trap 4.1 describes
— turns the ownerless datagram from `Drop` into `Redirect` and fails
three tests including `an_unattributed_datagram_never_acquires_an_exit`.

**Both leak fixes.** `decide`'s refusal path and the flow-keyed
leave-alone cache are unchanged. A test asserts the refusal is the same
verdict with a live exit table and without, which is what catches the
other direction: a `verdict_for_unattributed` that started answering
`Carry` because an exit was available.

**No per-application exit in persisted state.** Untouched;
`split-tunnel.invariants.ts` still holds. Re-proven on this tree by
adding an optional `appExits?: AppExit[]` to `SplitTunnelSettings`,
which fails three assertions with `Type 'false' does not satisfy the
constraint 'true'`.

**Exit handles stay keyed and per-customer salted.** Not weakened,
because nothing here touches the backend or invents an identifier. The
handle produced by section 9 travels through `ExitProfile.exit` and
`AppExit.exit` and is compared for equality; the service never resolves
it to an address, a node or a route, and no address, hostname, node id,
ordering or count is added to anything a client receives. The only new
log line names a loopback port and the destination the *application*
asked for.

### 10.6 The ceiling

Three, from the owner: *"they cant choose more than 3 apps at the same
time"*, read as three **games** rather than three executables, because a
game is routinely several binaries and they all leave from one exit or
from none. What is counted everywhere is therefore **distinct exits**,
which is the same number as distinct placed games — six entries across
three games is three exits and is within the limit.

Four places, and they are not redundant:

| Where | What it does | Why there |
|---|---|---|
| The picker | a fourth exit is offered but disabled and says why | a limit met as an error afterwards is a limit that was not stated |
| `exitsForGames` | over the ceiling, withholds **every** preference | trimming means choosing winners by list position |
| `SplitTunnelConfig::validate` | refuses | this client cannot produce such a config |
| `ExitRelays::set` | truncates | the engine is already up; refusing here means a live session with no exits |

The two client layers withhold rather than trim for the same reason
`validate` refuses rather than failing open: there is no way to honour
part of it that the app could then report honestly. The wire order is
the order a customer happened to add games in, which they were never
told was load-bearing, and reporting `OnPreferred` for games picked by
list position is a placement nobody decided being reported as one
somebody did.

An exit another placed game already uses costs no extra concurrent exit
and stays choosable — which is also how a customer gets out of the limit
without unpicking anything.

### 10.7 Xray only, stated

A customer using concurrent exits is on one of the Xray-carried
protocols. WireGuard, OpenVPN and IKEv2 get one exit, and that is a
**platform gap to state, not a protocol to drop** — every transport
still matters for a censored network.

Said in three places that must agree:
`ConnectProfile::carries_concurrent_exits` (the service, which drops
what it cannot carry), `carriesConcurrentExits` in
`src/lib/concurrent-exits.ts` (the client, which does not send it), and
`settings.customExitXrayOnly` in en and fa (the customer, who is told
which of the two they are getting rather than left to infer it).

`settings.customExitOneAtATime` was removed. It said one connection
leaves from one exit, which is still true on the other three protocols
and is no longer true on Xray, and a string that is half wrong is worse
than two strings that are each right.

### 10.8 What is still unproven

**Nothing has run on a machine.** No rig time was available. The
section 7 procedure stands unexecuted, and its row 8 — `curl -4` from a
socket pinned as each of a game's binaries, with the two answers
required to be byte-identical — is still the assertion that matters
most and the one no unit test can fake.

Specifically not observed:

- **Two exit IPs at once.** The whole point of the feature, and the
  claim this document is not making. What is proven is that the config
  xray-core is handed names two inbounds, two outbounds and two rules,
  that the relay speaks the protocol those inbounds speak, and that a
  flow carries the index of the exit it asked for. Whether xray-core
  then egresses those two flows from two nodes has not been watched.
- **UDP ASSOCIATE against xray-core itself.** The association is tested
  against a real socket running a SOCKS5 server written for the test.
  xray-core's own inbound may differ in ways a hand-written server does
  not reveal — the reply's bound address, in particular, is the field
  most likely to surprise.
- **Three engines' worth of load.** 2.3 notes that under
  `claude/split-tunnel-rig-verification` three of four engines could not
  activate at all within their timeouts on a slow guest. This adds
  inbounds rather than engines, so the comparison is not direct, but
  three concurrent outbounds to three nodes is more work than one and
  nobody has measured it.
- **The free-port race.** Each exit inbound's port is bound and released
  before xray-core is started, so something can take it in between. It
  is bounded and loud — Xray refuses to start on a port it cannot bind,
  and `confirm_started` turns that into a failed connect — but it has
  not been seen happening.
