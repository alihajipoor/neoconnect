# "Block the internet while reconnecting": what must be proven before it ships

The Windows kill switch (`service/src/engines/reconnect_hold.rs`, the
app's `lib/reconnect-hold.ts`) is built, unit-tested and checked against
the real filtering platform on CI (`wfp_accepts_the_hold_then_aborts`,
which fails rather than skips wherever the filtering engine will not open,
unless `NEOXIFY_SKIP_WFP_TESTS=1` is set off CI). Until every item below
has passed in `Neoxify-Test`, recorded in `docs/journal/log.md`, it stays
off:

- `RECONNECT_HOLD_PROVEN = false` in `apps/desktop-windows/src/lib/reconnect-hold.ts`.
  Settings does not draw the switch, every connect sends
  `blockWhileReconnecting: false`, and no screen speaks of a hold.
  `reconnect-hold.wiring.test.ts` fails if the row is bound some other way
  or the release workflow sets the build flag.
- A VM build that offers it: run **Build test installer (unsigned)**
  (`build-test-installer.yml`) on the branch with **reconnect_hold**
  ticked. That sets `VITE_RECONNECT_HOLD=1` for that installer only.
- Flip the constant in a commit of its own, once all of this has passed.

## The 2026-10-20 capture: not proven, and what changed since

The first full run (build `0c78963`) passed the dial, carry and release
gates on every engine but failed four:

- **Xray leaked at the drop** in 4 of ~14 kills (0.39 to 0.43 s after the
  kill): the status poll's "tunnel adapter is gone" check let go of the
  confinement before the engine watch's report put the hold in. Now every
  path that lets go of the confinement on a drop -- the watch's report,
  the poll finding the engine dead, the adapter-gone check -- installs the
  hold first (one WFP transaction, under the hold's lock, so whichever
  comes second waits and finds it in). A report the engine contradicts
  lets go of its hold only after the confinement is back, and not if a
  newer drop has been held since.
- **The app let go on one contradictory status** (connected, holding, not
  confined, 0.5 s after a drop) and the whole reconnect ran fail-open. The
  service now says when a tunnel has `landed` under the hold (a session
  that came up after the drop, armed); the app lets go from status alone
  only on two reads a second apart, each showing a landed tunnel that is
  confined (or, WireGuard, has a fresh handshake), with no pass running.
- **WireGuard leaked at the drop** (+0.22 to +0.64 s): wireguard.exe's own
  kill-switch filters die with it, before any watch can act. An armed
  WireGuard session now keeps the hold's filters *standing* in force for as
  long as it is up; its drop is held with nothing to install.
- **The screen said "going out without Neoxify" while the service held**
  (0.25 to 0.5 s at each reconnect's start, 2.3 s after a network cut),
  and a "not protected" toast came 0.3 s before a release: both read a
  stale "armed". The read that finds a drop now brings the hold's state
  too, and the screen and the notifications read one source
  (`gapTraffic`): before the service has said, they say neither.

A review of those fixes found more, also fixed and also not yet carried
a packet:

- **The hold went at the reconnect's first word.** The app says the
  setting again as its reconnect begins, which arms the live session --
  and after the adapter-gone check held a drop, the live session was the
  dropped one, its adapter gone. Arming it found nothing to name and let go
  of the hold, so the reconnect ran fail-open under "Stopped blocking the
  internet so the new connection could carry traffic". The session whose
  drop is held is now never armed again.

None of these fixes has carried a packet. Items 1, 2 and 5 below are to
be run again for every engine, with the additions marked **(new)**.

## Method

As the 2026-10-05 entry in the journal: `pktmon start --capture --comp nics`
inside the guest (the NIC miniport, below WFP and WinDivert), the app's
text read over DevTools on the same clock, tooling in
`C:\Users\aliha\Claude\vm\tools` (`nic-leaks.ps1`, `leak-test.ps1`,
`dns-bound.ps1`). Every check once with the setting **off** first, to show
the capture sees the leak the hold is meant to stop. Background leakers
running throughout: a browser tab polling a public host, a `curl` loop to
a fixed IPv4 address, a UDP sender to a public port 53 and 443, an IPv6
ping to a documentation-range address.

A drop is made by killing the engine (`taskkill /f` on xray.exe,
openvpn.exe, or stopping `WireGuardTunnel$neoconnect`), and, separately,
by cutting the guest's network for 30 s.

`netsh wfp show filters` before, during and after each run: the hold's
filters are named `Neoxify reconnect hold: ...`, in their own sublayer.

## Checklist (all with the setting on unless it says otherwise)

1. **Nothing leaves during the gap.** From the drop to the next tunnel,
   per engine (Xray Reality, Xray TLS, Trojan, Shadowsocks, OpenVPN UDP and
   TCP, WireGuard): no packet from the leakers at the NIC except DHCP, the
   LAN, Neoxify's own programs, Neoxify's servers, and port 53 **to the
   adapter's configured resolvers only**. A UDP or TCP flow to any other
   host on port 53 is refused (the narrowed permit). IPv6: nothing sent
   but link-local, multicast and a configured IPv6 resolver.
   **(new)** At least 15 kills per Xray protocol, with `cleanup.log`
   showing the "tunnel adapter is gone" path taken in some: no leak in
   any. WireGuard killed hard (`taskkill /f` on the tunnel service's
   wireguard.exe), not only stopped: no leak from the first moment.
   **(new)** The tunnel adapter taken away under a live engine:
   `Disable-NetAdapter -Name neoconnect0 -Confirm:$false` with xray.exe
   running, then let the app reconnect on its own. No leak from the
   disable to the next tunnel; `reconnect-hold.log` shows the hold put in
   by "the tunnel adapter is gone" and nothing let go of before the next
   tunnel is up (no "could not be named", no `tunnelNotPermitted` on
   screen); the status says the tunnel ended within a second of the
   disable, not "Connected".
1b. **(new) Standing under WireGuard.** With the setting on and a
   WireGuard tunnel up: `netsh wfp show filters` shows the hold's filters
   in force before any drop, the tunnel carries as before (exit IP = node,
   a sustained download at its usual speed), and they go on Disconnect and
   with the setting off. A connect of the customer's own over it (another
   location) leaves nothing blocked if it fails.
2. **Every engine dials under the hold and its tunnel carries** -- above
   all **WireGuard-NT**, whose kernel socket WFP may not attribute to
   wireguard.exe (it is let through by the server's address; prove it).
   Exit IP through the tunnel matches the node. A protocol that cannot
   dial under the hold is a dropped protocol and fails this gate.
3. **The hold lets go on every path, and leaves no filter behind.**
   `netsh wfp show filters` shows none of ours after each: the tunnel
   proved (app's release); the customer's Disconnect; Stop reconnecting;
   the episode giving up (attempts, budget); a **third quick death**; the
   plan stopping (notEntitled) and the device limit; a sign-out; Gaming
   mode turned on; the setting turned off mid-hold; a connect it does not
   cover (IKEv2, Custom mode); Repair; the app killed; the service
   restarted; a reboot while holding.
4. **The backstop.** With the app frozen right after a drop (suspend the
   process in Process Explorer before its reconnect starts): the service
   lets go after `NO_FOLLOW_UP` (120 s), and `reconnect-hold.log` says
   "no reconnect followed". With the app not frozen and the network cut
   for 5 minutes: the hold stays (the app's "a reconnect follows" is
   heard) and lets go only when the tunnel is back or after 40 minutes.
5. **What the screen says matches the capture.** While holding:
   "Other connections on this computer are blocked..." and nothing says
   traffic goes out without Neoxify. After a drop nothing reconnects
   (third quick death, plan stopped): "still blocked ... until Neoxify
   lifts the block" for at most a few seconds, then "VPN connection lost",
   whose "going out without Neoxify" is then true at the NIC. The
   "connection lost" toast waits for the release. **(new)** At no moment,
   frame by frame, does the screen or a toast say traffic goes out without
   Neoxify while the capture shows the hold blocking; before the service
   has said, the sentence is "checking whether other connections ... are
   blocked". And the hold is never let go of before the next tunnel is up
   and confined (the service log's "let go of after Ns" against the
   capture).
6. **The LAN while held, and after roaming.** A LAN host (the VirtualBox
   gateway, a share on the host-only network) answers while held. Then
   change the guest's network during a long wait (switch the adapter to
   another NAT network or host-only subnet): within ~10 s the new LAN's
   hosts answer and the new network's resolver is permitted; the old
   LAN's is not.
7. **Resolvers unread.** With DNS removed from every non-tunnel adapter
   (static, no servers): the status says `dns_anywhere`, the app shows
   the port-53 note, and the capture shows port 53 to anywhere permitted
   -- the stated broad rule, nothing wider.
8. **Off is off.** Setting off (the default), each drop above leaves the
   machine fail-open exactly as before: no hold, no filter, no note --
   and in a release build there is no switch at all.

Not provable on the VM: a real IPv6 path (this PC has none; a leak shows
only as packets sent), a censored network, and a physical laptop roaming
between real Wi-Fi networks. Those stay **unverified** and are said so in
the release note if it ships before they are measured.
