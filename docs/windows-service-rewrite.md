# Rewriting the Windows service

The privileged service is being rebuilt. This is the specification the
rewrite is written against and the standard it is held to.

## Why

Three customer reports, one root cause.

1. **Disconnect does nothing mid-connect.** The split-tunnel bring-up
   never reads the abandon flag and holds the engine lock for ~38s;
   `Request::Disconnect` waits 2s for that lock and then waits
   unbounded, with no unlocked fallback.
2. **The service will not die.** Stop waits on the same lock with no
   timeout, so it never reports `Stopped` and the process stays alive
   with the tunnel up. SCM recovery actions then restart it after a
   kill, by configuration.
3. **It strands the machine's networking.** The machine-wide NRPT `.`
   rule is registry-persistent and survives both a kill and a reboot.
   A dead engine left it installed while reporting "disconnected".

All three are the same shape: **blocking, uncancellable work holding a
single global lock inside async tasks, with cleanup written on happy
paths instead of in `Drop`.**

## The two bars

Set by the people using it, and everything here serves them.

1. **Disconnect completes in 1–2 seconds**, engines gone from the
   machine, networking back to normal.
2. **Closing the app leaves nothing running.** A customer who closes the
   window and sees a VPN still carrying traffic concludes the product is
   harmful, and they are not wrong to.

### What bar 1 rules out

Measured on a 4-vCPU Windows 11 guest, recorded in `engines/dns.rs`:

```text
powershell -NoProfile -Command 1                            4.4 -  6.5s
Get-DnsClientNrptRule | Measure-Object                      9.6 - 66.7s
the registry enumeration that replaces it                   32 -  237ms
the registry delete that replaces Remove-DnsClientNrptRule  48 -   64ms
```

**Starting PowerShell at all costs more than the entire disconnect
budget.** No teardown step on the fast path may launch a process, wait
for a service to deregister, or poll for a resource to disappear.

## Architecture

### Teardown is two phases

**Phase one — hard stop. Sub-second, unconditional, cannot fail.**

May not: launch a process, take a lock that another operation can hold,
wait for anything to disappear, or call PowerShell.

- `TerminateProcess` every engine child. No graceful shutdown; traffic
  stops when the process dies.
- Close the WFP engine handle and the WinDivert handle. Both are
  dynamic/handle-scoped, so the kernel reclaims the filters whether or
  not our code runs.
- Delete the NRPT rules by direct registry write.
- Ask the SCM to stop `WireGuardTunnel$neoconnect` and **do not wait**.
- Mark disconnected and answer the client.

Adapters vanish with their engine processes, and routes on a vanished
adapter go with them, so "networking back to normal" is complete at the
end of phase one.

**Except OpenVPN's**, which is kept between sessions on purpose (making
one is slow), so the server-pushed `0.0.0.0/1` and `128.0.0.0/1` routes
openvpn.exe added outlive the kill. Phase one therefore deletes those
two by destination with `route.exe` after killing OpenVPN. Before this
was noticed they were left to the thorough pass, which runs on an empty
slot after phase one and reached them only through the janitor's
PowerShell purge, seconds after the customer had been told their
networking was back.

**Phase two — reconcile. Background, never blocks a reply.**

Removing the tunnel service registration, purging routes on adapters
that outlive their engine, the janitor, and anything that genuinely
needs a cmdlet. If it takes 40 seconds nobody notices, because the
customer's internet returned in phase one.

### Liveness comes from the kernel, not a heartbeat

The service learns the app is gone by holding a handle to its process:
`GetNamedPipeClientProcessId` → `OpenProcess(SYNCHRONIZE)` → wait.

It signals immediately on a clean exit, a crash, or Task Manager. It
cannot be missed, cannot be starved by a busy worker, and cannot be
spoofed — unlike the 60s idle watchdog it replaces, whose `last_seen` is
refreshed by *any* local process opening the pipe, and the pipe ACL
grants authenticated users.

When it signals, phase one runs. That is bar 2.

### No global lock

State belongs to one owning task that receives commands over a channel.
Requests are messages, not lock acquisitions, so a disconnect is always
*received* even while a connect is in flight. Replaces the `Engines`
mutex that every current symptom depends on.

### Cancellation is a token, not an atomic

A `CancellationToken` passed into every stage, including the split
tunnel. Cancellation becomes something the type system carries rather
than something each author remembers to poll — which is how the split
tunnel came to ignore it across its entire 38-second window.

### Cleanup is RAII

Every system mutation gets a guard whose `Drop` reverts it, so it
unwinds on cancellation, on panic and on early return. `Ipv6Block`
already does this; it is the model.

### Budgets nest

Every stage deadline must fit inside its parent's. Today OpenVPN's 75s
and Xray's 60s sit inside the app's 45s reply deadline, which
*guarantees* the retry that clears the abandon flag a disconnect just
set.

**Resolved by clamping, not by lowering the constants** — and the
distinction matters enough to write down, because lowering them is the
obvious move and it is wrong.

`lifecycle::budget::Limits` carries the cancellation token and the
operation's deadline as one argument, built once at the boundary in
`Engines::connect` from `CONNECT_BUDGET` (38s, seven under the app's
45). Every wait asks `clamp` for the shorter of its own ceiling and
what the operation has left. A ceiling therefore means "what this
stage may spend when it is the only thing running"; the deadline is
what it actually gets.

Lowering the constants instead would say "OpenVPN gets 40 seconds" in
a world where it may be the third stage of a connect with six seconds
left — and it leaves the same mistake available to whatever ceiling is
added next. The per-stage `fits_inside` check cannot see the real
failure anyway, which is stages that each fit and overrun in sequence:
a WireGuard connect is 45s of service-gone wait, then 15 installing,
then a split tunnel whose own ceilings total 46.

`budget.rs` keeps a test asserting the three ceilings still overrun,
so that removing the clamping and tuning the numbers fails loudly.

**What made the budget binding was removing PowerShell, not
clamping harder.** `dns::force` is invoked from `xray::connect` and
`ikev2::connect` and does not take `Limits`, so its 35-second
`CMDLET_BUDGET` used to sit on top of the 38 the clamped stages share
-- a connect could reach about seventy seconds.

It was deliberately never clamped. Running out of time there means the
tunnel comes up with the machine's lookups unpinned, which in Iran
means an ISP resolver answering with a poisoned address: worse than a
slow connect, and not a trade this product should make for
punctuality. So the call was made fast instead. `dns::apply` writes the
rule to the registry in 48-64ms where `Add-DnsClientNrptRule` measured
10.0s, 16.3s, 43.9s and 55.1s, and there is no budget pressure left to
resolve.

### The connect path no longer spawns PowerShell

For WireGuard, OpenVPN and all four Xray protocols it is now free of
it entirely. What each of them used to pay:

* `dns::force` -> the registry writer above. Every protocol paid this.
* `openvpn::connect`'s route purge -> `route.exe` by destination
  instead of `Get-NetRoute | Remove-NetRoute`, which had to enumerate
  and so cost 4.4-6.5s per connect to usually delete nothing.
* Xray's adapter setup was already `netsh.exe`, which is native.

**IKEv2 is the exception and is left alone on purpose.**
`ikev2::connect` still runs three cmdlets in one invocation to create
the RAS entry, measured at 14.4s at best. Replacing it means writing a
phonebook entry by hand -- about forty INI fields including generated
GUIDs and timestamps, plus the IPsec configuration -- or binding
`RasSetEntryPropertiesW` and its large version-dependent `RASENTRY`.
A malformed entry cannot be dialled at all, it affects one protocol of
five, and the measured cost is a tenth of what the DNS rule was. The
cost-benefit says stop here.

The PowerShell that remains is on paths where nobody is waiting: the
DNS fallback when the registry refuses, `clear_with_cmdlets`, gaming
mode, the janitor's residue sweep, the thorough teardown, and
diagnostics.

### What is still not bounded by the connect budget

Audited rather than assumed, by listing every deadline in `engines/`
and `split_tunnel/` and checking each against the reply path. Every
engine wait clamps. Two that look like gaps are not: `BIND_RETRY_FOR`
(6s) is in `proxy::bind_pending`, which is per-flow on the data path,
and `redirect::ACTIVATION_GRACE` (3s) runs inside a spawned thread, so
the constructor returns before it.

`HELPER_BUDGET` was the one real residual and is now closed. Helper
processes go through `run_hidden`, bounded at 15 seconds and reading
the ambient cancellation every 50ms but not the *deadline* -- so a
wedged `netsh` or `wireguard.exe` could carry a connect 15 seconds
past its budget and finish after the app had stopped listening. Both
call sites that could do it had the operation's limits in reach, so
each takes `limits.clamp(HELPER_BUDGET)`: Xray's `configure_adapter`,
which runs `netsh` twice, and WireGuard's `/installtunnelservice`.

The generic primitive is deliberately left ambient. Threading `Limits`
into `capture_hidden` would reach DNS, routing, repair, the janitor
and the firewall, none of which has a cancellation decision to make,
and for them the ambient read is the right answer: a process started
inside a cancelled operation should abort, always. Clamping at the two
sites that know about the deadline gets the benefit without the
ceremony.

**Every wait that can delay a connect reply is now bounded by the
connect's own clock.** That is an audited statement, not an assumed
one -- see the list above for the two that look like exceptions and
are not.

### Cancellation is a parameter, except once

Threaded explicitly through the whole connect path. One ambient reader
is kept deliberately: `wait_within`, the floor of `capture_hidden`,
which DNS, routing, repair, the janitor and the firewall all sit on.
Those authors have no cancellation decision to make — a process started
inside a cancelled operation should abort, always — and threading a
token through every one of them would be ceremony that adds no choice.

**A teardown is never cancellable.** Cancellation is what *leads* to a
teardown, so a teardown that honours it undoes its own purpose. This
was learned the hard way: giving wireguard's teardown a boundary read
of the live token made a disconnect abort its own teardown and report
failure, because `pipe::dispatch` cancels the running operation before
it runs the disconnect. That is the stranded-networking complaint,
manufactured by the mechanism meant to prevent it.

## Rules

1. **The IPC contract is frozen.** Shipped clients speak it. Every
   `Request`/`Response` variant and field keeps its shape and meaning.
2. **The existing tests are the acceptance criteria.** Roughly 340 of
   them encode real incidents — a WinDivert filter that would not
   compile, a redactor that returned a constant, timeout arithmetic that
   must keep adding up. They are the executable specification. A module
   is not rewritten until its tests pass against the new code, and a
   test is changed only when the behaviour it pins is *deliberately*
   changing, in a commit that says so.
3. **Fail open.** Unchanged, and it is a product decision, not an
   oversight: people in Iran are worse served by a machine locked down
   safely than by one that reaches the internet.
4. **No PowerShell on the connect or disconnect path.** Registry and
   Win32 first; cmdlets are allowed in repair and in phase two.

   The rule is about PowerShell specifically, and the measurement is
   why: 4.4 to 6.5 seconds are spent before its first statement runs.
   A small native executable is a different cost class -- phase one
   runs `route.exe delete` at most three times, because the record of
   which routes were installed dies with the session and nothing later
   can remove them. Where an API exists it still wins: IKEv2 hangs up
   through `RasHangUpW` rather than `rasdial.exe`, and the NRPT rules
   go by registry write rather than by cmdlet.
5. **Nothing blocking inside an async task.** `spawn_blocking` or an
   owning thread.
6. **Every commit compiles on `windows-latest`.** It cannot be compiled
   anywhere else — there is no Windows machine on this project since
   2026-08-30, and `windivert-sys` links `WinDivert.lib` at build time,
   so even the test binary fails to link off Windows. CI is the only
   verification that exists. Branches must be named `claude/**` or
   `rig/**` for it to run.

## Order

Bottom-up, each landing green before the next starts.

1. ~~Foundation — cancellation, process supervision, RAII guard traits~~
2. ~~IPC and the pipe server — contract preserved exactly~~
3. ~~Service lifecycle — SCM, kernel liveness, two-phase stop~~
4. Engine state machine — *cancellation and budgets threaded; the
   state machine proper is still the slot type it was*
5. The five engines — *entry points take `Limits`; internals untouched*
6. DNS, routing, IPv6 block, janitor, repair — *done as targeted cost
   removal rather than wholesale rewrite: these modules are heavily
   tested and the measured problem in them was PowerShell, not
   structure.* The NRPT rule is written to the registry and verified by
   `registry_rule_count`, so a rule this service creates is provably
   one its sweep can remove. OpenVPN's pre-connect purge names its two
   destinations to `route.exe`. `ikev2::is_connected` answers the idle
   status poll from the phonebook file rather than a process. See "the
   connect path no longer spawns PowerShell" above for what is left and
   why.
7. Split tunnel — the largest, and the one with the most tests.
   *Already takes `Limits` and clamps its two long waits, so the
   bring-up can no longer outlive the connect; the rewrite itself is
   still ahead.*
8. Gaming mode

Steps 4, 5 and 7 were taken partly and out of order on purpose: the
cancellation and budget work cuts across all three, and doing it once
across the call path was cheaper than doing it three times as each
module came up for rewrite. What remains in each is its own structure,
not its deadlines.

## What this does not fix

The control plane. Windows clients fail to reach the API far more often
than Android ones — 160 `CONTROL_PLANE_UNREACHABLE` against 107
successes in 30 days, where Android is 43 against 323 — and each one
burns a 6s timeout before the tunnel is even attempted. That is a large
part of "slow to connect" and it is a **separate defect** in the
endpoint list or the client's HTTP path. `client_attempts.apiEndpoint`
is NULL on every one of those rows, so the telemetry cannot yet say
which endpoint failed. Fix the telemetry first.
