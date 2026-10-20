# "Block the internet while reconnecting": what must be proven before it ships

The Windows kill switch (`service/src/engines/reconnect_hold.rs`, the
app's `lib/reconnect-hold.ts`) is built, unit-tested and checked against
the real filtering platform on CI (`wfp_accepts_the_hold_then_aborts`,
which now fails on CI rather than skipping). **None of it has carried a
packet.** Until every item below has passed in `Neoxify-Test`, recorded in
`docs/journal/log.md`, it stays off:

- `RECONNECT_HOLD_PROVEN = false` in `apps/desktop-windows/src/lib/reconnect-hold.ts`.
  Settings does not draw the switch, every connect sends
  `blockWhileReconnecting: false`, and no screen speaks of a hold.
  `reconnect-hold.wiring.test.ts` fails if the row is bound some other way
  or the release workflow sets the build flag.
- A VM build that offers it: run **Build test installer (unsigned)**
  (`build-test-installer.yml`) on the branch with **reconnect_hold**
  ticked. That sets `VITE_RECONNECT_HOLD=1` for that installer only.
- Flip the constant in a commit of its own, once all of this has passed.

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
   "connection lost" toast waits for the release.
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
