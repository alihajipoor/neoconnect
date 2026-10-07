# Rewriting the split tunnel

Step 7 of `windows-service-rewrite.md`, and the largest single piece of
the service: 15,191 lines across nine files, 204 tests.

| file | lines | tests |
|---|---|---|
| `redirect.rs` | 5,047 | 83 |
| `owner.rs` | 3,536 | 51 |
| `proxy.rs` | 2,380 | 27 |
| `mod.rs` | 2,094 | 13 |
| `flows.rs` | 850 | 17 |
| `socks.rs` | 547 | 9 |
| `icon.rs` | 294 | 4 |
| `firewall.rs` | 223 | 0 |
| `divert.rs` | 220 | 0 |

## Why, and what this is not

Ali asked for the full rewrite and reaffirmed it after being shown the
argument against. That is settled; this document does not reopen it.

What it does do is make the rewrite safe, because the honest risk is
not that the new code is worse — it is that 204 tests encode behaviour
nobody remembers deciding, and a rewrite that reads better while
quietly dropping one of them ships a regression that looks like
progress. Two field bugs already recorded in these files were exactly
that shape: Custom mode silently not intercepting, and a tunnel the app
reported as absent while it held the machine's routes.

So the order of work is: freeze the boundary, understand what the tests
actually pin, then replace from the leaves inward.

## The frozen boundary

Everything outside `split_tunnel/` touches the subsystem through
exactly these items. A rewrite may change anything behind them and
nothing about them.

### `SplitTunnel`, called from `engines::Engines`

```rust
pub fn new() -> Self
pub fn start(&mut self, adapter_name: &str, node: Ipv4Addr, log_dir: &Path,
             limits: &crate::lifecycle::budget::Limits) -> Result<(), String>
pub fn stop(&mut self)
pub fn set_selection(&mut self, config: SplitTunnelConfig)
pub fn set_exits(&mut self, exits: Vec<(String, u16)>)
pub fn clear_exits(&mut self)
pub fn mode(&self) -> SplitTunnelMode
pub fn wants_passive_tunnel(&self) -> bool
pub fn wants_interception(&self) -> bool
pub fn is_running(&self) -> bool
pub fn complaint(&self) -> Option<String>
pub fn probe(&self) -> Result<(), String>
pub fn exit_placements(&self) -> (Option<String>, Vec<AppPlacement>)
pub fn restart_needed(&mut self) -> Vec<String>
pub fn stop_calls(&self) -> u32
```

`stop_calls` is a test observability hook, not production surface, and
is load-bearing anyway: `engines::mod.rs` tests assert on it because
`is_running()` cannot distinguish "never started" from "started and
stopped". Keep it.

`start` taking `&Limits` is recent. Cancellation and the deadline both
arrive through it, and the two long waits inside clamp against it — see
`windows-service-rewrite.md`.

### Module-level items

```rust
pub fn running_without_the_lock() -> bool        // mod.rs — pipe.rs status fallback
pub use policy::{Selection, SharedSelection}
pub use picker::running_apps
pub fn running_apps(session: Option<u32>) -> Vec<neoconnect_ipc::RunningApp>  // picker/mod.rs — pipe.rs
pub(crate) const firewall::RULE: &str            // net/firewall.rs, via `pub(crate) use net::firewall` — repair.rs
pub(crate) fn firewall::delete_rule()            // janitor.rs, repair.rs
```

`running_apps` moved from `owner.rs` to `picker.rs` (040f80f), and the
restructure moved `Selection` to `policy/` and the firewall module to
`net/`. What callers outside the subsystem see --
`split_tunnel::{Selection, SharedSelection, running_apps,
running_without_the_lock}` and `split_tunnel::firewall::{RULE,
delete_rule}` -- did not change, which is the boundary; only the
re-export lines did.

`running_without_the_lock` exists because `Status` must be answerable
while the engine lock is held; it is the split-tunnel half of the same
escape hatch `engines::os_visible_tunnel` provides. It must stay
lock-free.

`CUSTOM_MODE_RESOLVER` is **not** boundary: it is a private const in
`session/mod.rs` that `engines/dns.rs` only mentions in prose.

## Rules

Inherited from `windows-service-rewrite.md`, plus:

1. **The boundary above is frozen.** If a rewrite seems to need it
   changed, that is a finding to report, not a change to make.
2. **The tests are the acceptance criteria — and there are 215, not
   204.** The 204 inside `split_tunnel/` are the obvious ones. Eleven
   more live outside it and are easy to miss:

   | file | test |
   |---|---|
   | `engines/mod.rs` | `ending_a_session_stops_the_split_tunnel` |
   | `engines/mod.rs` | `ending_an_already_empty_session_still_stops_the_split_tunnel` |
   | `engines/mod.rs` | `a_helper_past_its_budget_is_killed_rather_than_waited_on` |
   | `engines/dns.rs` | `custom_mode_still_wants_the_machine_wide_rule` |
   | `engines/dns.rs` | `the_two_engines_that_force_dns_answer_the_same_way` |
   | `engines/dns.rs` | `both_engines_point_the_rule_at_the_same_resolver` |
   | `engines/ikev2.rs` | `split_tunneling_is_named_only_for_custom_mode` |
   | `engines/ikev2.rs` | `the_entry_script_is_structurally_sound_in_both_modes` |
   | `engines/routing.rs` | `every_recorded_route_carries_the_interface_it_was_added_on` |
   | `pipe.rs` | `the_status_poll_carries_whether_the_tunnel_s_dns_was_forced` |
   | `pipe.rs` | `dispatch` |

   The first two are the real behavioural constraint on `stop()`, and
   they are why `stop_calls` is boundary. The `dns.rs` three constrain
   what `wants_passive_tunnel` and `wants_interception` are allowed to
   mean — one of them exists because the two engines once disagreed and
   Custom mode got a machine-wide DNS rule on one protocol and not the
   other.

   A test may be moved or renamed. Deleting one requires saying, in the
   commit message, what behaviour it pinned and why that behaviour no
   longer exists.
3. **Every commit compiles and passes on `windows-latest`.** This crate
   does not build on the Mac, so CI is the only check, and
   `rustfmt --check` proves syntax only — never type-checking.
4. **Leaves before trunk.** `divert.rs` and `firewall.rs` are thin Win32
   wrappers with no tests; `mod.rs` is the orchestrator everything else
   hangs off. Replace in dependency order so each lands green alone.
5. **No `rustfmt` to format.** It follows `mod` declarations and will
   reformat the whole subtree; the house line width is wider than its
   default and CI does not enforce it.
6. **Cancellation stays a parameter.** It arrives as `&Limits` and is
   passed down. Reintroducing an ambient read here is the specific
   regression that let this subsystem ignore a disconnect for 38
   seconds.
7. **A teardown is never cancellable.** Same rule as the engines.

## Order

Dependency order, each green before the next:

1. `divert.rs`, `firewall.rs` — thin Win32, no tests, no dependents
   beyond the subsystem except `firewall::{RULE, delete_rule}`.
2. `icon.rs` — 4 tests, leaf.
3. `flows.rs` — the NAT/flow table. `proxy.rs` and `redirect.rs` both
   sit on it, so its shape constrains theirs.
4. `socks.rs` — 9 tests, narrow.
5. `proxy.rs` — the relay.
6. `owner.rs` — process identity and the selection.
7. `redirect.rs` — the WinDivert loop. Largest, most tests, most
   coupled; it goes late on purpose.
8. `mod.rs` — the orchestrator, last, because its shape falls out of
   what the others became.

## What the reading found

Four analyses, one per group of files. The headline is that the
*algorithms* are sound and hard-won — almost every odd-looking line
turns out to record a measured field bug — and the problem is that
five or six unrelated jobs share each file, so the invariants holding
them apart are prose rather than types.

### Files that are several modules each

`owner.rs` is five: the customer's policy object (`Selection`), CIDR
scope arithmetic, the port→pid→image cache, the settings-screen picker
(product names, icons, primary-binary scoring), and connection-table
mutation plus the escape audit. The file admits it — it carries two
separate `#[cfg(test)]` modules bridged by a `#[cfg(test)]` free
function hoisted to file scope because "the call sites are in the
second one". The picker half has no packet-path role at all, and its
doc comment is already stale because the visible-window filter it
describes moved to the Tauri client (a LocalSystem service in session
0 sees no windows).

`proxy.rs` is four: egress placement primitives, the exit table,
own-socket bookkeeping, and the relays — plus ~300 lines of tunnel
health verification (`probe`, `prove_carries`, `client_hello`,
`round_trip_pinned`) that relays nothing and is consumed by `mod.rs`
and the status poll.

### Invariants that should be types

* **`decide` is a 393-line policy ladder whose ordering is the safety
  property.** Eight sequential early returns; the rule that every
  refusal precedes the only `Origin` that acquires an exit is held by
  layout plus one test. One place in the file does enforce it properly
  — `exit_for`'s signature, where "the signature is the enforcement" —
  and that is the shape the rest should take.
* **The `MIB_*_OWNER_PID` row layout is hand-decoded six times**, with
  the port byte-swap open-coded seven times. The file documents the
  hazard itself: passing `AF_INET6` to the IPv4 reader "would parse
  address bytes as a port and return a plausible number for the wrong
  socket". Three hand-written parsers of one layout is three chances
  at exactly that.
* **"Is this the internet" exists in three places** kept in step by
  hand: `is_public_v4`, the WinDivert filter string, and a literal
  list in two tests. Drift would report "a number that looks like a
  leak and is really a disagreement between two lists".
* **Lock poisoning is handled two different ways** with nothing saying
  which applies where. Every method on `Nat` uses `.lock().unwrap()`,
  so one panic in any relay thread poisons the mutex and every
  subsequent packet panics the redirect loop.
* **`Redirect::activated` is a field that lies until `start` runs**, so
  both construction sites carry a comment saying so.
* **`RUNNING` is a hand-maintained shadow of `active.is_some()`**, its
  invariant stated as prose: written "at the two places that set and
  clear it and nowhere else".

### Lifecycle

`start` is 286 lines doing eight jobs, with teardown-on-failure
written out by hand at four exit paths — and `InstalledRoutes` has no
`Drop` while `Allowance` and the IPv6 block do, so one function runs
two cleanup disciplines and the dangerous one is the manual one.
`stop` is a hand-ordered ten-step sequence where four steps carry a
comment explaining why *that position*, and nothing in the types
enforces any of it; `Active`'s field order does not match, so drop
order would be wrong.

**Relay connections are not owned.** Each accepted TCP connection gets
a detached thread running `pump`, which sets no timeouts and never
reads the stop flag, and `Relays::stop` does not close those sockets.
They do end — the upstream is always pinned to the tunnel or to a local
inbound, so engine teardown breaks them — but teardown depends on the
far end breaking rather than on us closing anything. A rewrite should
own them and close them.

### Performance, where it is visible to a customer

* **The hot path allocates per packet.** `Selection`'s doc says paths
  are "lowercased once at construction so matching is a plain
  comparison rather than a case-insensitive scan per packet".
  `matches` then calls `to_lowercase()` — a heap allocation — and
  scans a `Vec<String>` linearly. `destination_scope` and
  `preferred_exit` each lowercase again: three allocations per packet
  for one string.
* **`icon.rs` claims a cache that does not exist.** Its doc says icons
  "are base64'd once and cached"; there is no cache anywhere. Every
  `ListRunningApps` re-runs `SHGetFileInfoW`, `GetDIBits` and a full
  hand-written PNG encode per product, and `running_apps` does two
  complete version-resource file reads per process on the machine.
* **The same packet is parsed up to three times** — once on the
  dispatcher for worker affinity, then again in `handle_packet`, then
  again in `handle_ipv6` — because `Job` carries only the raw bytes.

### What has no test behind it

The whole picker half of `owner.rs`, all of `icon.rs`'s GDI path
(including the mask-vs-alpha rule its doc says is "only obvious once
every icon has come out blank"), `start`, `stop`'s ordering, `probe`,
`complaint`, and the `Limits` cancellation and deadline paths. Every
one of those has a bug story recorded in prose with nothing pinning it.

Two tests are `#[ignore]`d with a documented wrong premise, and they
matter: the property Custom mode's honesty rests on — that a pinned
socket does not fall back to the ordinary route — had **no running
test**. Its only evidence was a customer log quoted in a comment. A
rewrite must not read those names as coverage.

**It has one now** (`net/pin.rs` since the restructure; written in
`proxy.rs`,
`a_socket_pinned_to_an_interface_with_no_route_fails_instead_of_falling_back`).
The ignored tests pinned to an index that names nothing, which Windows
treats as no pin. Pinned instead to loopback -- a real adapter with no
route to the internet -- a connect to a public resolver fails at once
with WSAENETUNREACH, where the same connect unpinned succeeds. Measured
on Windows on 2026-10-04 before it was written as a test. It proves the
stack honours the pin; it is not a capture of a tunnel going away
under a live game, which is still unverified.

### Possible defects found, and what became of them

Logged first rather than fixed, because each needed its own
verification. Each has since had it:

* `OwnerLookup::rebuild` marks a snapshot fresh even when all four
  table walks failed. **A decision, now written down** (7113163): the
  alternative walks a failing API on every packet, and a SYN does not
  pay for it because it walks again on any miss.
* `parse_table` keys on port alone, so two rows sharing a local port
  resolve to whichever came last. **Real, and fixed** (7113163).
  Checked against a live table first: one listener sat beside forty-odd
  TIME_WAIT rows on its port, each with owner pid 0, so the table's
  order decided whether the port had an owner. A row with no owner no
  longer replaces one with an owner. Two *different* live owners on one
  port remain ambiguous by port alone -- separating them needs the
  local address, which no caller passes yet.
* `last_seen` is refreshed only by outbound packets. **Left as it is,
  with the reasoning recorded** (c7af95d): TCP acknowledges, and no
  one-directional UDP flow outliving sixty seconds has been observed;
  the fix would put a write on the hottest path in the subsystem.

One found this way was fixed before the list was written: `expire_idle`
swept `forward` by port alone while ports are only unique per
transport, so an expiring UDP flow retired a live TCP flow sharing its
number.

## Where it stands

Every finding above has been acted on or deliberately declined, each
in its own commit on `claude/service-rewrite`, each with the full
service suite passing **on Windows** -- this work was the first done
on a Windows machine since 2026-08-30, so `cargo test` ran locally
rather than only in CI.

| Finding | Commit |
|---|---|
| `firewall.rs`: both sources by name, not by slice | 5337095 |
| `icon.rs`: the cache the header claimed; the mask rule tested | ab3467f |
| `flows.rs`: the NAT field that duplicated its key | c7af95d |
| `socks.rs`: a 64KB allocation per exit datagram; truncation | 37e951c |
| `proxy.rs`: relayed connections not owned, not closed by stop | 5b2da61, eb181a7 |
| `proxy.rs`: health verification is not relaying | 32ae978 (`health.rs`) |
| `owner.rs`: three allocations per packet for one string | bd52eda |
| `owner.rs`: one row layout hand-decoded six times | deae091 |
| `owner.rs`: the picker has no packet-path role | 040f80f (`picker.rs`) |
| "Is this the internet" in three places | 71c8a1b |
| `Nat` lock poisoning | cc48a42 |
| `Redirect::activated` lies until `start` | e36a0ca |
| The same packet parsed more than once | 4a844c2 |
| `decide`: the refusal-before-exit ordering held by layout | 5ed0c29 |
| `InstalledRoutes` had no `Drop`; four manual unwinds | 51339ac |
| `RUNNING` a hand-kept shadow of `active` | b311629 |

**A finding nobody had made, worth knowing before touching any socket
here.** The relay's stop fix first shut a `try_clone` of each socket.
On Windows a cloned handle (`WSADuplicateSocket`) was measured losing
sight of its connection while the original kept carrying it: with 32
relays stopping at once, 8 to 20 left a connection open, every run. A
single-relay test passed every time. The fix (eb181a7) shares one
handle by `Arc` everywhere in the relay, `pump` included -- `pump` had
split every relayed socket with `try_clone` long before this work. The
lesson for anything here that tears down: test it with many instances
at once, not one.

### The restructure

The target design below, done on `claude/split-tunnel-restructure`
(2026-10-07, off the 0.9.45 release candidate `bb3679a`), one commit
per step, each compiling and passing the whole suite on Windows. The
moves changed no behaviour. The four that are not moves -- the
selection set, the `Drop`s, drop-order teardown and the typed ladder
-- came after the code they change had stopped moving, except the
selection set, which landed as soon as `policy/` existed.

| Step | Commit |
|---|---|
| `divert.rs`, `firewall.rs` -> `net/` (boundary path kept by re-export) | 199e9ce |
| `picker.rs`, `icon.rs` -> `picker/` | dba1057 |
| `flows.rs` -> `flows/` | 81bf6b0 |
| `owner.rs` -> `policy/` (pure; a test holds it so) and `tables/` | 6c99d13 |
| `Selection`'s paths in a set: `matches` is a hash lookup, its doc true | f7c1233 |
| `proxy.rs`, `socks.rs` -> `relay/`; pinning -> `net/pin.rs` | cbe0eb7 |
| `redirect.rs` -> `intercept/` (`decide`, `packet`, `stats` split out) | 3e0787b |
| the running session out of `mod.rs` -> `session/`, `worker.rs`, `log_file.rs` | ff0960c |
| every part of a session releases itself in `Drop` (`Running`, `Relays`, a shared `Worker` for the three session threads) | 39f98e5 |
| a session is torn down in drop order; `start`'s four hand-written unwinds gone | 3129e8b |
| `decide`'s ladder carries its order in types | 785c9d0 |

What `split_tunnel/` is now, one job per module:

| Module | Job |
|---|---|
| `mod.rs` | `SplitTunnel` -- the frozen boundary -- and the slot holding a session |
| `policy/` | `Selection`, scopes, the verdict vocabularies, `is_public_*`. Pure |
| `tables/` | one typed reader of the `MIB_*_OWNER_PID` tables; owner cache; reset and audit |
| `picker/` | `running_apps`, product names, icons |
| `net/` | `divert`, `firewall`, `pin` -- the thin Windows layer |
| `flows/` | the NAT and flow tables |
| `relay/` | the relays and the connections they own; exits; own sockets; SOCKS5 |
| `health.rs` | tunnel verification, which relays nothing |
| `intercept/` | the WinDivert loop; `decide` (the ladder), `packet`, `stats` |
| `session/` | one running session: `Parts` and its `Windows` implementation, the bring-up, logger, watchdog, convergence, the tunnel and route |
| `worker.rs`, `log_file.rs` | the stoppable thread and the log file both the session and the relay use |

**How teardown works now.** `Session`'s first eight fields are declared
in exactly the order `stop` used to run by hand -- watchdog,
interception, convergence, relays, allowance, logger, route, IPv6
block -- and each releases itself in `Drop`, so `SplitTunnel::stop` is
`drop(self.active.take())`. A bring-up that fails releases what it
holds in the order the old unwinds did (relays, IPv6 block, allowance,
route), kept by declaring those locals ahead of the relays: locals drop
in reverse declaration order. A panic after interception or the relays
began used to strand them; the unwind now stops them, releasing what
came after the relays newest first (convergence, logger, interception)
and then the same four. The three orders differ; what all three keep is
that the packet loop stops before the relays it sends to and the
per-app IPv6 block outlasts the loop. That is the first of two
behaviour changes, both on paths no customer has hit; the second is
under "The review round" below.

Nothing calls a part's release by name any more, and the session tests
use stand-ins, so `Parts` bounds the route, relays, allowance, IPv6
block and interception by `Drop`: deleting one of those five impls is a
compile error, as deleting the `stop()` or `remove()` the old `stop`
called was. Emptying one still compiles.

**How the ladder works now.** Seven rungs, one function each, each
taking the previous rung's token by value; a token's fields are private
to the ladder and each is built in one place. Skipping or reordering a
rung is a type error. The DNS rung builds its `Origin` with `exit: None`
and holds no `Carry`; only the last rung can name an exit. The `decide`
tests are unchanged.

**What is tested that was not.** `stop`'s ordering and the bring-up's
release order on each failing step, listed above as untested, now have
tests against stand-in parts (`session/fake.rs`): the real relays,
logger and `Worker`, stand-ins for the route, allowance, IPv6 block,
interception and the threads that touch real tables or adapters. One of
them brings up and drops 32 sessions at once and requires every part
released once and in order, every object handed to a thread released --
so no thread is left running -- and every relay port, TCP and UDP,
closed; half of those sessions are carrying a TCP connection and a UDP
flow through their real relays when they are dropped (see the review
round below for what that found). A panic at each infallible step of
the bring-up has a test of its own. Each session test was made to fail
by the mistake it guards against -- a field moved, a declaration moved,
a `Worker` that does not join, relays dropped without being stopped or
without closing what they carry -- before it was trusted. `start`,
`probe` and `complaint` against the real Windows layer still have no
test, and neither does the real `intercept::Running`'s `Drop`: only the
ignored live test reaches it.

Test counts on Windows, `cargo test --workspace`: service 478 passed /
6 ignored before, 485 / 6 after (seven new: policy purity, the stack
path edge, two `Worker`, three session); ipc 58; desktop 44 / 5.
Split-tunnel tests: 239 before, 246 after. No test was deleted; the
existing ones moved with their code, and the `decide` tests did not
change at all. After the review round: service 487 / 6, split-tunnel
248 (245 / 3).

#### The review round

Two adversarial reviews found nothing high or medium. The lows, each
fixed in its own commit with the suite green on Windows:

| Finding | Commit |
|---|---|
| Deleting a part's `Drop` compiled and passed every test (the session tests use stand-ins); `routing.rs` still called the route's `Drop` a backstop | 96d9637 |
| `relay::start` under thread exhaustion panicked with the acceptor already detached on `0.0.0.0` -- pre-existing; now an error, and the partial relay is stopped | 8e79e07 |
| The release order on a panic after interception started was neither written down nor tested | 5942b53 |
| The 32-session test carried no connection, probed only the TCP port, and its comment put the failing unwinds among the teardowns when they ran among the bring-ups | 43f2ae1 |
| Comments and docs still pointing at `owner.rs`, `proxy.rs` and `redirect.rs` paths, two of them audit claims | the commit adding this table |

The second behaviour change is 8e79e07: a relay the OS will not give
its threads now fails the bring-up with "could not start the local
relay: ..." instead of panicking.

**Found while making the 32-session test carry connections, and not
changed:** when the relays stop, both ends of a carried TCP connection
see it close at once, but the relay's two copy threads stay in their
reads until each end closes its socket in answer -- 16 of 16 still
there twenty seconds after the drop with both ends held open, gone
within milliseconds once they let go. Present since the relay began
owning its connections (eb181a7); the `Drop` comment said the threads
unblock on the shutdown, and now says what was measured. An application
and a server answer a close by closing, so ordinarily this costs one
round trip. How long a thread lingers when the far end never answers --
the upstream pinned to a tunnel that has already gone -- is unmeasured.
Waking them -- cancelling a read blocked in another thread, or putting
the copy loops on a timeout -- is a teardown change on the data path,
and wants the rig rather than a unit test.

Not done here: the restructure's history has seven commits (6c99d13 to
ed31fc8) that fail the `check-exit-groups.sh` CI step, fixed at
e6e8362. Making each commit pass means rewriting published history and
every hash this document cites, so it is left to the merge: squash, or
fold e6e8362 into 6c99d13 then.

### What this did not do

* **`start`'s eight jobs.** `Session::start` is still the one function
  that brings a session up, and its sequence is unchanged step for step
  -- deliberately, because a different bring-up sequence cannot be
  checked without a VPN session and the rig. What changed is that it
  no longer unwinds by hand.
* **Anything against real packets.** All of the above is proven by
  unit tests on Windows and by reading. No change here has carried a
  game's traffic through a real tunnel since it was made, and per
  `CLAUDE.md` that stays **unverified** until a capture says otherwise.
  That now includes the whole restructure: Custom mode and gaming mode
  in the VM are owed before it merges.

## Target design

Follows from the above, and the rule is one job per module:

1. **`policy/`** — `Selection`, scopes, the three verdict vocabularies.
   Pure, no Windows, fully testable off-platform. Paths stored
   pre-lowercased in a set, so `matches` is a hash lookup and the
   doc comment becomes true.
2. **`tables/`** — one typed reader for the `MIB_*_OWNER_PID` layouts,
   replacing six hand-decodes, plus the port→pid→image cache.
3. **`picker/`** — `running_apps`, product naming, icons. Settings-screen
   presentation, off the packet path entirely, with the cache its doc
   already claims.
4. **`net/`** — `divert`, `firewall`, pinning primitives: the thin
   Windows layer.
5. **`flows/`** — the NAT table, unchanged in shape; it is the one file
   whose single responsibility is already clean.
6. **`relay/`** — the relays and owned connection lifetimes. Tunnel
   health verification moves out to its own module; it is not relaying.
7. **`intercept/`** — the WinDivert loop, with `decide` restructured so
   the ladder's ordering is carried by types the way `exit_for` already
   does.
8. **`session/`** — `start`/`stop` as RAII acquisition in order, so
   teardown is drop order rather than a hand-written sequence, and the
   four manual unwind paths disappear.

`SplitTunnel` stays exactly as the boundary above defines it.

All eight are done -- see "The restructure" under "Where it stands"
for the commits and what each module now holds. One thing the list
did not foresee: `session/` takes its parts from a `Parts` trait, the
shape `lifecycle::teardown::HardStopSteps` already has, so that the
drop order can be tested without Windows.
