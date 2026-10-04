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
pub use owner::{running_apps, Selection, SharedSelection}
pub fn running_apps() -> Vec<neoconnect_ipc::RunningApp>  // owner.rs — pipe.rs
pub(crate) const firewall::RULE: &str            // repair.rs
pub(crate) fn firewall::delete_rule()            // janitor.rs, repair.rs
```

`running_without_the_lock` exists because `Status` must be answerable
while the engine lock is held; it is the split-tunnel half of the same
escape hatch `engines::os_visible_tunnel` provides. It must stay
lock-free.

`CUSTOM_MODE_RESOLVER` is **not** boundary: it is a private const in
`mod.rs` that `engines/dns.rs` only mentions in prose.

## Rules

Inherited from `windows-service-rewrite.md`, plus:

1. **The boundary above is frozen.** If a rewrite seems to need it
   changed, that is a finding to report, not a change to make.
2. **The 204 tests are the acceptance criteria.** A test may be moved
   or renamed. Deleting one requires saying, in the commit message,
   what behaviour it pinned and why that behaviour no longer exists.
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

## Target design

To be written once the per-file analyses are in. It is deliberately
not guessed here: the point of reading 15,000 lines first is that the
structural problems should come from the code rather than from an
opinion about how split tunnelling ought to look.
