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

## The 2026-11-06 capture (build `47914a7`): not proven

The third round ran against `main` at `47914a7` (desktop 0.9.57): a test
installer from **Build test installer (unsigned)** with the hold offered
and the test switches compiled in, on `Neoxify-Test`, captured at the NIC
with `pktmon --comp nics`, the leakers running. Tooling and raw results are
outside the repo, in `C:\Users\aliha\Claude\vm\tools\hold3` and
`C:\Users\aliha\Claude\vm\results\hold3`.

Two things differ from the earlier captures:

- **The guest has IPv6 now**, through VirtualBox NAT: TCP over IPv6
  completes and answers come back. The IPv6 checks ran on a live path, not
  only "packets sent". A real ISP's IPv6 path is still unverified.
- **The guest's wall clock cannot be trusted.** VirtualBox time sync was
  measured moving it 27% fast. Every log line was stamped with the guest's
  performance counter, the clock pktmon stamps frames with, and marker
  frames tied each capture to the logs (residuals 0.4 ms or less).

With the setting off, one forced drop per engine leaked in every gap (75 to
175 leaker frames, the first 0.45 to 0.70 s after the drop), with no hold
filter and the screen saying traffic goes out without Neoxify, which was
true. So the capture sees the leak.

**The hold held every engine drop.** 125 kills, stops and adapter disables
on Reality, TLS, Trojan, Shadowsocks, Stealth Web, OpenVPN UDP and
WireGuard: no leaker frame, no port 53 to another host and no IPv6 outside
the allowed set, from the drop to the next confined tunnel. It failed on
three other things: port 53 after any network change, the old network kept
open after a roam, and the screen running ahead of or behind the service's
release.

**Item 1, Xray: FAIL.**
- 75 kills that reconnected, 15 per protocol: every one held, no leak.
  `cleanup.log` shows the "tunnel adapter is gone" path in 12 of 76 kills,
  all held first. One TLS kill was a third quick death (the slow guest
  clock); the app let go of it as designed, with nothing out before.
- 15 disables of `neoconnect0` under a live xray.exe, 3 per protocol: no
  leak. Held by "the tunnel adapter is gone" every time, let go of only
  after the next confined tunnel, no "could not be named", no
  `tunnelNotPermitted`. **But** the status said the tunnel ended 0.37 to
  1.77 s after the disable command, over a second in 4 of 15, and the
  screen said "Connected" until then. The confinement stayed in, so
  nothing left.
- 10 network cuts of 30 s, 2 per protocol: **10 of 10 leaked port 53** to a
  resolver the guest is not configured with (a leaker's), over UDP and TCP,
  1 to 8 frames each, 2.4 to 4.2 s after the network came back. WFP at that
  moment shows "permit name lookups to anywhere (the resolvers could not be
  read)". The screen had the port-53 note. Nothing else left.
- Next confined tunnel: a median of 5.4 to 5.7 s after a kill (slowest
  39.1 s), 5.2 to 7.7 s after a cut's network came back, and 43.8 to
  63.6 s after a disable -- because after every disable (16 of 16) the
  redial on the same protocol failed after 38 to 40 s (`ipv6-block.log`:
  "neoconnect0 did not appear within 5s") and the ladder moved to another
  protocol. Not analysed yet.
- The refused-confinement item: unverified, as stated above.

**Item 1, WireGuard and OpenVPN UDP: FAIL.**
- WireGuard, 25 drops, no leak: 8 hard kills of wireguard.exe, 14 stops of
  the tunnel service, 3 adapter disables with wireguard.exe running. Each
  was held at once by the standing filters, with no "standing filters
  taken out" and no "could not be named".
- No stop took seconds on its own (the slowest `STOP_PENDING` of 10 was
  913 ms). The slow stop the second capture leaked on was emulated instead,
  by suspending wireguard.exe once the stop was pending: 3 stops pending
  4.7 s, no leak. A natural slow stop stays **unverified**.
- OpenVPN UDP, 10 drops, no leak: 8 kills of openvpn.exe and 2 disables of
  its adapter. After a disable the adapter was gone until the next
  Compatible connect, so both reconnects landed on Stealth HTTPS.
- 4 network cuts, 2 per engine: all leaked port 53 as above, 1 to 7 frames,
  2.4 to 4.0 s after the network came back.
- OpenVPN TCP: not run. No server offers it.
- 37 tunnel-up windows between drops: nothing outside the allowed set.

**Items 1b and 2: FAIL, on one screen item.**
- Standing over WireGuard: 116 filters in force before any drop. Exit IP =
  node, downloads 29 to 38 Mbps against 29 to 39 with the setting off. None
  after Disconnect, none with the setting turned off over a live tunnel
  (which stayed up). A failing connect of the customer's own (88 rungs, each
  dial sent to a documentation address by a page hook) left nothing
  blocked. The guest's firewall could not make it fail: its address rules
  do not stop wireguard-nt's UDP.
- A hostname endpoint (`wg-gate.neoxify.test` in the guest's hosts file):
  the standing filters permit the resolved address, the tunnel carries at
  21 to 25 Mbps, and a drop redials under the hold with no leak.
- `refuse-standing`: "not standing" in the log and no filters while up. The
  drop was held late (`standing_refused`); the screen gave the held sentence
  with the late note, and the "lost" toast its late words. No leaker frame
  in that moment.
- `unname-wireguard-server`: armed without standing. The reconnect let go
  before it dialled (`tunnelNotPermitted` on status and screen) and
  WireGuard came up. The 32 leaker frames between the let-go and
  WireGuard's own block are the stated cost. **Fail:** 1.3 s after the
  let-go the reason left the screen, and from 2.8 to 4.3 s after it the
  screen said "checking whether other connections ... are blocked" with no
  hold filter in force. Nothing leaked then: WireGuard's own block was up.
- Item 2: every engine dialled and carried under the hold, exit IP = node,
  no leak frame: WireGuard-NT at 17 to 19 Mbps (18.3 before the drop),
  Reality, TLS, Trojan, Shadowsocks and Stealth Web at 32 to 38, OpenVPN UDP
  at 16.1. OpenVPN TCP not run (no server). Built-in (IKEv2) is not covered,
  by design.

**Items 3 and 4: PARTIAL.** Let go with no filter left on: the tunnel
proved; the customer's Disconnect (mid-reconnect, the pill's Stop
connecting); Stop reconnecting; the episode's budget (3 passes, 138 s); a
third quick death (no leaker frame over its three holds); the plan stopping
(simulated in the page); a sign-out; the setting turned off mid-hold; IKEv2
and Custom mode (each let go before it dialled); Repair; the app killed; the
service restarted; a reboot (shutdown closed the app first, so the
boot-time sweep had nothing to do); and a "not confirmed" landing (Xray let
go 0.77 s after its first confined read, WireGuard 13 ms after its first
fresh handshake). Item 4: the app frozen after a drop was let go after
121 s with "no reconnect followed" and no leaker frame in the hold; a
5-minute cut held 310 s and let go after the tunnel was back; the 40-minute
limit, shortened to 150 s by a VM switch, let go at 151 s. Not passed:

- The attempts limit: not run. It cannot be reached: one pass is 88 rungs,
  about 40 s even when every connect fails at once, so the 120 s budget
  always ends the episode first.
- Gaming mode: not run. Its control is disabled while reconnecting, so no
  customer can turn it on mid-hold.
- The device limit: unverified. Only the app's path for the error's words
  was made, not the slot API's own refusal.
- A "not confirmed" landing whose confinement is refused, held until
  Disconnect: could not be made, unverified.
- The 5-minute cut leaked 2 port-53 frames 4.1 to 4.6 s after the network
  came back, the same cause as item 1.
- Seen, not judged: after a sign-out the still-running pass held again for
  2.7 s until the sign-out's teardown, and after a service restart the
  continuing reconnect held again 13 s later.

None of these gaps is one this file accepts as unverifiable on the VM (a
real IPv6 path, a censored network, a physical laptop, the refused
confinement).

**Item 5: FAIL, on timing; no leaker frame while any hold was in.** Passed:
a held drop with the window behind (held sentence at +1.23 s, the held
"lost" toast, "back" at the release), and no claim of traffic going out
over a hold in ~100 earlier kills read again; the third quick death; the
failover with its node blocked in the guest's firewall (held sentence
under "Checking connection..." from 0.63 s after the hold went in to the
release, then "back"); between attempts (never "Couldn't connect."); Stop
reconnecting; the switch confirmation; a failover whose every rung fails
(made by page-hook errors, not the firewall); the IKEv2 rung let go
partway; the `role=status` region; 1.5 s of nothing, then "checking"; and
no release before the next tunnel was up and confined. Failed:

- **Disconnect mid-hold:** at the press the held sentence went and
  "DISCONNECTING You're not protected" stood up to 0.30 s before the
  service let go (1.5 s before its reply). Nothing left in that time.
- **Service restarted mid-hold:** "blocked" stood 1.7 to 1.8 s after the
  stop had taken the hold out, while 34 leaker frames left the NIC.
- **A WireGuard rung let go partway** (`unname-wireguard-server`):
  "blocked" stood 0.41 s after the let-go, with 7 leaker frames.

Smaller: "Connected" stood 0.87 s over the third quick death's hold before
the app read the drop, and a dialog already open kept its plain words 0.5
to 0.7 s into a hold. Not run: the plan stopping under a capture, and the
"hasn't yet confirmed" toast (no gap brought the toast before the
service's word).

**Items 6 to 8: FAIL, on the roam.**
- 6, the LAN while held: the VirtualBox gateway answered ping and TCP every
  second, port 53 went only to the configured resolver, nothing else left.
- 6, the roam (cable out 1.5 s, the adapter moved to another NAT network
  with other resolvers, then back): the end state was right. The new LAN
  answered 7.3 s after the new address, its resolvers were permitted, and
  after the next re-read nothing went to the old network. Before that, two
  faults. Each cable-out read found no resolvers, so port 53 was open to
  anywhere (said on status and screen) until the next re-read, and lookups
  to resolvers the network did not have left both ways. And a new plan at the reconnect's connect, read
  0.23 s before the new address, kept the old network for 6.3 s: ping and
  TCP to the old gateway and 51 lookups to the old IPv6 resolver left the
  NIC until the 10 s re-read.
- 7, resolvers unread: pass. Static IPv4 with no servers and IPv6 router
  discovery off (static alone kept DHCP's resolvers): `dns_anywhere` 3.4 s
  later, the port-53 note 0.07 s after that, and port 53 to anywhere at the
  NIC, nothing wider.
- 8, off is off: a 30 s cut, an adapter disable under xray and a WireGuard
  kill with the setting off left no hold filter, no hold in status or log
  and no hold words, and leaked as before (85, 1152 and 93 leaker frames).
  That a release build has no switch was read from the code and the wiring
  test, not run. The 0.9.57 release installer was not put on the guest.

**What has to change before the next capture** (from a read-only
diagnosis of these logs and the code):

1. **An empty resolver read must not open port 53.** `adapters::dns_servers`
   skips adapters that are down, so during a cut it returns an empty list,
   not "unread", and `Plan::with_dns([])` means `dns_anywhere`. Three
   places build that plan: `Engines::reconnect_hold_plan`
   (`unwrap_or_default()`), `Hold::reread` (it keeps the held resolvers only
   when the read failed) and `Plan::widened_by` (it keeps the new, empty
   list). An empty read should keep the resolvers in force; `dns_anywhere`
   should come only from a first read that found none, or a failed read.
   Item 7 then removes DNS before the connect, or is restated. Proof: the
   same cuts and the roam with no port 53 to an unconfigured host, the
   status never `dns_anywhere`, and WFP at cut+5 s and net-on+0.5 s naming
   the resolvers.
2. **The plan must follow a new address.** The 6.3 s was `Hold::replan` from
   `hold_through_connect`, read 0.23 s before the new address, and nothing
   read again until `REREAD_EVERY` (10 s); `tend` runs only on status reads.
   That this read saw the old lease fits the frames but is unproven (no WFP
   dump from that moment). Re-read on `NotifyUnicastIpAddressChange`, with
   the 10 s re-read as the backstop (smallest version: `REREAD_EVERY` = 1 s).
   Proof: a WFP dump at each new-plan log line, and the old LAN's frames
   ending within 1 s of the new address.
3. **A disable's "within a second" cannot be met at a 1 s read.** The
   adapter-gone check runs only in `Engines::status()`, on the app's 1 s
   read (`LIVENESS_POLL_MS`), and `Disable-NetAdapter` itself takes 0.4 to
   0.7 s. The hold came in on that read every time; no defect in the hold.
   Read status every 500 ms while an armed tunnel is up, or restate the item
   as "the first status read after the adapter is gone".
4. **The reason after `tunnelNotPermitted` must stay.** `arm_dialling` arms
   the new WireGuard session and, for a new generation, clears `problem`, so
   the status says armed; in a gap `gapTraffic` turns armed into
   "unconfirmed", and 1.5 s later the screen says "checking". Once a gap's
   read has said `notHeld`, a later armed in that gap should keep the reason
   until the episode ends (the gap word, `Dashboard.tsx`).
5. **Disconnect says neither until the release.** The press sets
   "disconnecting", whose headline (`connection-evidence.ts`) is always "not
   protected", and `HoldScene` has no disconnecting flag. The service lets go
   on receipt (+0.30 s) and replies after its teardown (+1.5 s), so keeping
   "blocked" until the reply would be 1.2 s stale. Say neither from the press
   until `holdStore.released()` on the reply, under a neutral headline.
6. **Tell the app before letting go.** The app learns of a let-go at its
   next read: every 2 s in a gap, every 400 ms while dialling. Reading every
   400 ms in a gap cuts the stale time to about 0.5 s. The closing fix: on a
   stop, the service answers status "shutting down" and waits for one read
   (at most about 0.6 s) before its teardown; in `hold_through_connect` it
   reports a letting-go state the app says as neither, waits for one read,
   then lets go. A crash or a kill of the service cannot warn the app first;
   that stays a gap, stated in the release note.

Also open: why the redial on the same protocol fails after a `neoconnect0`
disable, and what item 3 should say for the attempts limit and Gaming mode,
which no customer can reach mid-hold. The next capture runs item 1 (kills
and cuts, every engine), 1b's `unname-wireguard-server`, item 5's three
failures and item 6 again, with a WFP dump at each new plan.

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
