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
- **"Connected" over a held machine.** After the adapter-gone check held
  a drop, the status still said connected: the screen said "Connected"
  while everything but Neoxify was refused, nothing reconnected, and after
  `NO_FOLLOW_UP` the hold let go into the clear, still under "Connected".
  A session whose tunnel adapter is gone is now said to have ended (with
  the hold on or off), and the app reads "holding, nothing landed" over a
  connected read as a drop.
- **WireGuard by hostname.** The standing filters let wireguard-nt's UDP
  through by the server's address alone, and the plan held only literals:
  a WireGuard endpoint named by a hostname would have had its own tunnel
  cut the moment it was armed, and a reconnect onto it could not dial
  under a hold. The service now resolves the endpoint at connect (as it
  does OpenVPN's) and before a reconnect dials; filters stand only for a
  plan that permits the server dialled; one it cannot name (no IPv4
  answer, an IPv6 server) is armed without standing, and a reconnect onto
  it lets go of the hold before it dials.
- **A refusal to stand was only in the log.** When WireGuard's filters
  could not stand, the status still said armed, then holding, as if the
  drop had been held from its first moment. The hold now says it went in
  late (`standing_refused`), and the screen and the "lost" notification
  say traffic may have gone out in that moment.

## The second 2026-10-20 capture (build `22d8cab`): not proven

Every forced drop on Reality, TLS, Trojan, Shadowsocks, Stealth Web and
OpenVPN UDP held, and every release path let go with no filter left. It
failed on:

- **WireGuard leaked when its tunnel ended slowly.** 3 of 7 stops of
  `WireGuardTunnel$neoconnect` took ~4.4 s, and all three leaked (151 to
  200 leaker frames at the NIC for 6 to 9 s); 1 of 1 adapter disable under
  a live wireguard.exe did too. The app's reconnect said the setting again
  (`vpn_set_reconnect_hold`) before the service had seen the end; arming the
  dying session found no adapter to name, disarmed it, and took out its 108
  standing filters. Now (`arm_live_session_for_reconnect_hold`,
  `arm_reconnect_hold`, `Hold::arm_for`): a session that is ending -- its
  process gone, its tunnel service at `STOP_PENDING` (now an ending, not
  "running"), its adapter gone -- is held, not armed; an armed session whose
  adapter cannot be named fails closed (held, one WFP transaction, never
  disarmed); and arming a standing session again never takes its filters
  out. A stop refused by a tunnel service already stopping is the stop under
  way, not a failed teardown. `every_path_that_takes_out_a_hold_or_a_confinement_is_one_of_these`
  lists every path that takes out a hold, standing filters or a confinement
  in the files that name one -- engines/mod.rs, hard_stop.rs,
  confinement.rs, reconnect_hold.rs (the hold's own closes and releases,
  `arm_dialling` among them), wireguard.rs and pipe.rs -- and shows the
  drop paths hold first; two 32-way tests race the slow stop and the
  adapter disable against the reconnect's first word. A static list, not a
  capture: it says which paths exist, not that any of them holds a packet.
- **The mid-session failover held silently.** The health check's ladder
  (`runLadder({ automatic: true })`) held for 25 to 84 s under "Checking
  connection..." alone, with no "lost" toast, on 5 of 5 runs. The service's
  word now decides the held words in every phase -- a pass dialling, the
  failover's ladder, a reconnect and the waits between its attempts, a pass
  waiting for a network, a drop, and a tunnel still shown up (degraded
  included) over a drop it holds -- and the failover's loss is said in held
  words once the service holds for it, then "back". The word is asked for as
  soon as the teardown that keeps the hold is answered, not at the next poll.
- **Smaller screen deviations, no leak:** "Couldn't connect." stood 1.3 to
  6.3 s between two attempts over a held machine (the held sentence now
  outranks it, and is not drawn in the error's colour); the blocked sentence
  outlived a Disconnect or Stop reconnecting by 1.0 to 1.25 s (dropped now on
  the release's reply), and a service restart by 2.5 s (a status read that
  goes unanswered is now said as "checking", never blocked nor not); the
  screen reader's region kept "...NOT protected" 0.8 s into a hold (it now
  lets go of stale words at once); and the switch confirmation said "not
  protected" over a held machine (it now says the block is in, and that
  Built-in (IKEv2) and Custom mode let go of it before they connect).

None of these fixes has carried a packet. Items 1, 1b, 2 and 5 below are to
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
   **(new)** WireGuard, both ways the second capture leaked: the tunnel
   service stopped from outside (`Stop-Service 'WireGuardTunnel$neoconnect'`,
   at least 7 times, so some take seconds -- `sc query` shows `STOP_PENDING`),
   and `Disable-NetAdapter` on its adapter with wireguard.exe running. No
   leak from the stop or the disable to the next tunnel; `reconnect-hold.log`
   shows no "standing filters taken out" before it, and `cleanup.log` no
   "not armed: the WIREGUARD tunnel's adapter could not be named".
   **(new, third round, unit test only)** An armed Xray or OpenVPN session
   whose confinement was refused at connect is now held when its adapter
   goes (`cleanup.log`: "held the drop: the tunnel adapter is gone"). The
   VM has no switch to refuse the confinement, so this is **unverified**
   against a capture.
1b. **(new) Standing under WireGuard.** With the setting on and a
   WireGuard tunnel up: `netsh wfp show filters` shows the hold's filters
   in force before any drop, the tunnel carries as before (exit IP = node,
   a sustained download at its usual speed), and they go on Disconnect and
   with the setting off. A connect of the customer's own over it (another
   location) leaves nothing blocked if it fails.
   **(new)** The same with a WireGuard endpoint named by a hostname (a
   test credential whose endpoint is a name that resolves to the node):
   the standing filters permit the resolved address (`netsh wfp show
   filters`), the tunnel carries at its usual speed, and a reconnect onto
   it dials under the hold. Then force a refusal -- an endpoint name with
   no IPv4 answer, or the hold's filters refused -- and check what the
   screen says at the drop: "blocked" with the note that the block went in
   a moment after the tunnel closed, the "lost" toast in its late words,
   and `reconnect-hold.log` saying "not standing". A reconnect onto a
   server the plan cannot name lets go of the hold before it dials
   (`tunnelNotPermitted`), and the WireGuard tunnel still comes up.

   **How to make these on the VM (guest-only; nothing on any server):**
   - *A hostname endpoint.* The page hook answers the app's credential
     request with the WireGuard credential's endpoint host replaced by a
     name under `.test` (for example `wg-gate.neoxify.test`, port unchanged),
     and the guest's `C:\Windows\System32\drivers\etc\hosts` maps that name
     to the node. The service names it with getaddrinfo and wireguard.exe
     resolves it the same way, so both read the hosts file. Remove the line
     and the hook's answer afterwards. Never commit the node's address.
   - *A forced refusal.* The test installer built with **reconnect_hold**
     ticked also compiles in the service's test switches
     (`reconnect_hold::TestSwitches`; `NEOXIFY_RECONNECT_HOLD_TEST=1` is set
     at compile time by `build-test-installer.yml` and by nothing else --
     `reconnect-hold.wiring.test.ts` holds the release workflow and CI to
     that, and a build without it reads no file). From an elevated shell in
     the guest, write one switch per line to
     `%ProgramData%\Neoxify\reconnect-hold-test.txt`:
     - `refuse-standing`: every install of filters to stand under a tunnel is
       refused, as WFP refusing them would be -- armed without them, the drop
       held late, "not standing" in `reconnect-hold.log`;
     - `unname-wireguard-server`: the WireGuard server is never named for the
       hold, as a name with no IPv4 answer would not be, while wireguard.exe
       still dials it -- armed without standing, and a reconnect onto it lets
       go of the hold before it dials (`tunnelNotPermitted`).

     The file is read each time the switch is asked, so set it before the
     connect (or the setting turned on) that is to be refused, and delete it
     afterwards. Filters already standing are never taken out by a switch
     turned on under them.
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
   restarted; a reboot while holding. **(new, third round)** A tunnel that
   lands "not confirmed" (no baseline taken) is let go of only once it is
   confined or its handshake is fresh -- at once if a status shows that,
   else within two status reads -- and stays held otherwise until
   Disconnect.
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
   has said, nothing is said for 1.5 s (the room kept empty), then
   "checking whether other connections ... are blocked" -- at a short
   reconnect whose answer comes sooner, the sentence changes once, to
   "blocked", never "checking" then "blocked". A loss notification whose
   answer has not come says "hasn't yet confirmed". And the hold is never let go of before the next tunnel is up
   and confined (the service log's "let go of after Ns" against the
   capture).
   **(new, second capture)** The mid-session failover (the node blocked by
   the guest's firewall): the held sentence under "Checking connection..."
   from the hold's first second to the release, and the "lost" toast in held
   words, then "back". Between two failed attempts the held sentence stays
   (never "Couldn't connect."). After Disconnect and Stop reconnecting it goes
   with the release's reply, not a status later. With the service restarted
   mid-hold: "isn't answering ... checking", never "blocked" nor "going out
   without Neoxify". The screen reader's region (`role=status`) never holds
   the degraded "NOT protected" line, or any other, once the screen has moved
   on. The switch confirmation while held says the block is in, and for
   Built-in (IKEv2) or Custom mode that it is let go of before they connect.
   **(new, third round)** With the window behind: a failover whose every
   rung fails (every node blocked in the guest's firewall) says "lost" in
   held words, then -- once its teardown has let go of the hold, never
   before (the capture) -- "VPN connection lost ... not protected". A
   failover the hold is let go of partway (a WireGuard rung with
   `unname-wireguard-server`, or an IKEv2 rung) shows the reason under
   "Checking connection..." from the moment the service says it, and sends
   a plain "lost" toast after the held one. A one-second re-check of the
   state is not spoken again by the screen reader.
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
