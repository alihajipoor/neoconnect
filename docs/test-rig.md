# The Windows test rig

A disposable Windows VM for exercising the client against real nodes.

The code refers to "the rig" constantly — measured timings, field bugs,
the `NEOX_*` environment variables the live split-tunnel test reads —
and has never had a document saying what it is or how to build one.
This is that document.

## Why a virtual machine and not the development machine

This client installs a kernel driver, takes the default route, and
writes a machine-wide NRPT rule into the registry. That last one is the
dangerous part: the rule is registry-persistent, applies to every
lookup the machine makes, and points them at a resolver that only
exists while the tunnel does. A rule left behind takes **all** DNS down
until somebody removes it by hand — the failure the janitor, the
start-up reconcile and `dns::clear`'s verification all exist to prevent,
and the one a customer describes as "the VPN broke my internet".

Testing that on the machine you work from means one bad run costs you
your connection. In a VM it costs a snapshot revert.

Snapshots are the real argument. They make it safe to test the paths
nobody dares exercise on bare metal:

* kill `neoconnect-service` with Task Manager mid-connect and see what
  survives
* pull the network while a tunnel is up
* reboot while connected, which is the path `PRESHUTDOWN` exists for
* let a connect fail on every protocol and confirm the machine is left
  clean

Take a snapshot called `clean` immediately after setup and revert to it
between runs.

## Shape

| | |
|---|---|
| Guest | Windows 11, x64 |
| Hypervisor | Hyper-V (built into Windows Pro) or VMware Workstation |
| Networking | **Bridged**, not NAT — see below |
| Memory | 4 GB is enough; 8 GB if Visual Studio goes on it |
| Snapshot | `clean`, taken before the client is ever installed |

**Bridged networking, deliberately.** With NAT the guest's traffic is
translated by the host, so a tunnel inside the guest is carried over the
host's connection and sees a second layer of address translation. That
is survivable for TCP and awkward for the UDP protocols — WireGuard and
OpenVPN both behave differently behind double NAT, which is exactly the
kind of difference that produces a bug report nobody can reproduce.
Bridged gives the guest its own address on the LAN and removes the
question.

## What the rig cannot tell you

Worth stating plainly, because a green run here is not the same as a
green run on a customer's machine.

**Timing fidelity is approximate.** Several budgets in this service are
tuned to measured numbers: the 900ms hard stop, the 38-second connect
budget, the 1200ms reachability probe. A virtual network stack and a
shared CPU do not reproduce those conditions faithfully. The rig proves
*correctness* — that the right thing happens — not that it happens
within the time a real machine would take.

**Driver loading can differ.** WinDivert is a signed kernel driver.
Hyper-V with memory integrity (HVCI) enabled blocks some drivers that
load fine without it. If the split tunnel fails to start in the guest
and works elsewhere, check that first rather than the code.

**Filtering is not reproduced at all.** The rig sits on an ordinary
connection. It cannot tell you whether a protocol survives Iranian DPI,
which is the question that matters most and the one only real customers
on real ISPs can answer.

## Remote access

Set this up so the rig can be driven without sitting at it.

Windows ships OpenSSH Server as an optional feature. In an elevated
PowerShell inside the guest:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Public keys for an administrator account go in
`C:\ProgramData\ssh\administrators_authorized_keys`, **not** the usual
`~/.ssh/authorized_keys` — Windows ignores the latter for accounts in
the Administrators group, which is the single most common reason key
authentication silently falls back to a password prompt. The file also
needs its ACL tightened or sshd refuses it:

```powershell
icacls C:\ProgramData\ssh\administrators_authorized_keys `
  /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

Then from the development machine, `ssh Administrator@<guest-ip>`
should land without a password prompt.

## What to run on it

### The verification a release needs

Not automated, because each step is a judgement about what the machine
looks like afterwards.

1. **Connect.** Confirm the app reports connected, a site loads, and the
   reported IP is the node's.
2. **DNS, while connected.** `Get-DnsClientNrptRule` should show one
   rule with the Neoxify comment, pointing at the tunnel's resolver.
3. **Disconnect.** Within a second or two. Then confirm `Get-Process
   xray,openvpn,wireguard` returns nothing, `Get-NetAdapter` shows no
   tunnel adapter, and `Get-DnsClientNrptRule` shows no Neoxify rule.
4. **Browse.** The real test of step 3: ordinary sites must load.
5. **Disconnect mid-connect.** Start a connect to a node that will not
   answer, press Disconnect while it is still trying, and repeat step 3.
6. **Close the app while connected.** The service should notice the
   client process is gone and tear down without being asked. Repeat
   step 3.
7. **Reboot while connected.** On the way back up, nothing should be
   tunnelled and step 3 should hold. This is what `PRESHUTDOWN` and the
   start-up reconcile exist for.

Revert to `clean` between runs, or the state left by one test becomes
the starting condition of the next.

### The live split-tunnel test

`live_custom_mode_blocks_ipv6_and_keeps_carrying_ipv4` in
`split_tunnel/intercept/mod.rs` (`redirect.rs` until the 2026-10-07
restructure) is `#[ignore]`d and has never run. It is the
only end-to-end proof Custom mode has — everything else is a unit test
over buffers. It needs administrator, real IPv6, and five variables:

```powershell
$env:NEOX_LOCAL_ADDR = "<the guest's LAN address>"
$env:NEOX_LOCAL_IF   = "<its interface index, from Get-NetAdapter>"
$env:NEOX_V4_URL     = "<a v4-only URL>"
$env:NEOX_V6_URL     = "<a v6-only URL>"
$env:NEOX_DUAL_URL   = "<a dual-stack URL>"
cargo test -p neoconnect-service live_custom_mode -- --ignored --nocapture
```

Two other tests are `#[ignore]`d with a documented wrong premise --
`the_probe_fails_rather_than_falling_back_to_the_normal_route` in
`split_tunnel/health.rs` and
`a_socket_pinned_to_a_nonexistent_interface_cannot_connect` in
`split_tunnel/net/pin.rs` (both in `proxy.rs` once). The comment says
the same assumption has been written against Windows twice and been
wrong both times. **Do not treat those two names as coverage.** The
property Custom mode's honesty rests on, that a pinned socket does not
fall back to the ordinary route, has had one running test since
2026-10-04 -- `a_socket_pinned_to_an_interface_with_no_route_fails_instead_of_falling_back`
in `net/pin.rs`, pinned to loopback. It proves the stack honours a pin;
it is not a capture of a tunnel going away under a live application,
which is still unverified.

## Building on the rig

A Windows machine can finally compile the service locally, which CI has
been the only way to do:

```powershell
cd apps\desktop-windows
cargo check --workspace --all-targets
cargo test --workspace
```

This matters more than convenience. `rustfmt --check` proves syntax and
nothing else, so every type error in this crate has cost a full CI cycle
to discover. A local `cargo check` turns that into seconds.
