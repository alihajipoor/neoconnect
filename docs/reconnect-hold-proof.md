# "Block the internet while reconnecting": what must be proven before it ships

The Windows kill switch (`service/src/engines/reconnect_hold.rs`, the
app's `lib/reconnect-hold.ts`) is built, unit-tested and checked against
the real filtering platform on CI (`wfp_accepts_the_hold_then_aborts`,
which fails rather than skips wherever the filtering engine will not open,
unless `NEOXIFY_SKIP_WFP_TESTS=1` is set off CI).

**Since desktop 0.9.59 it is offered as an opt-in beta**, off by default
and tagged Beta in Settings. The owner decided that on 2026-11-09, after
the fifth capture below showed no leak while held, with what the VM
could not prove stated there. It is not proven, and nothing may call it
proven, until the gaps listed under that capture are closed.

Before that, it stayed off until every item below had passed in
`Neoxify-Test`, recorded in `docs/journal/log.md`:

- `RECONNECT_HOLD_PROVEN = false` in `apps/desktop-windows/src/lib/reconnect-hold.ts`
  (true since 0.9.59). With it false, Settings does not draw the switch,
  every connect sends `blockWhileReconnecting: false`, and no screen
  speaks of a hold.
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

### What changed for those six (branch `claude/reconnect-hold-r4`)

Unit-tested, none of it has carried a packet:

1. **An empty resolver read keeps the resolvers in force**
   (`Plan::keeping_resolvers`): in `Hold::reread`, in
   `Engines::reconnect_hold_plan` (the resolvers of the plan in force), and
   in `Plan::widened_by` (the plan armed before, when the setting is said
   again over a link that is down). Port 53 to anywhere now comes only from
   a first read that found none, or a failed read with none held. Item 7 is
   restated below to match.
2. **The plan follows a new address**: the service registers
   `NotifyUnicastIpAddressChange`, and for 5 s after any address change
   (`FOLLOW_A_CHANGE_FOR`) every status read reads the network again,
   whatever the 10 s `REREAD_EVERY` says -- a roam's resolvers are written
   after its address, so one read at the change is not enough. A plan WFP
   refuses in that time is not tried at every read for the same change.
   The 10 s re-read stays as the backstop (and is all there is if the
   registration fails, which `cleanup.log` says).
3. **The app reads status every 500 ms while an armed tunnel is up**
   (`ARMED_LIVENESS_POLL_MS`; 1 s otherwise, and with the setting off). The
   adapter-gone check still runs only on a status read, so item 1's "within
   a second" is restated below as the first read after the adapter is gone.
4. **The reason stays for the gap**: once a read in a gap has said why
   nothing is held, a later "armed" in the same gap -- the next session
   armed as it comes up -- keeps that reason until the gap ends
   (`keptGapReason`, `holdInGap`); a new hold in the gap ends it.
5. **Disconnect says neither until its reply**: from the press, while the
   store says holding (or unanswered, or letting go), the headline is
   "Disconnecting... / Neoxify is closing the VPN connection." and the hold's
   words say nothing (`releaseAwaited`); the reply's `holdStore.released()`
   brings "You're not protected", true by then.
6. **The service says it is letting go before it does**: a new status word,
   `lettingGo` (`Report::LettingGo`), which the app says as neither blocked
   nor open. `hold_through_connect`'s two let-gos (a connect the hold does
   not cover, a WireGuard server it cannot name) and the service's stop set
   it, wait for one status read to have carried it -- at most 0.6 s
   (`LET_GO_SAID_WITHIN`), the pipe still answering on a stop -- and only
   then let go. The app reads every 400 ms in a gap now (was 2 s) and while
   it dials, so a read comes inside that. **A crash or a kill of the service
   cannot warn the app first**: there the screen says "blocked" until its
   next read finds the service gone (about 0.4 s in a gap), over traffic
   already leaving. That stays a gap, and the release note says so.

`thirty_two_let_goes_said_first_against_readers_and_disconnects` races 32
holds' let-gos against status readers and the customer's Disconnect: no
reader sees "not held" before "letting go", none sees "holding" after it,
and every WFP session is closed once. A unit test, not a capture.

## The 2026-11-09 capture (build `b8bf40a`): not proven

The fourth round ran against `claude/reconnect-hold-r4` at `b8bf40a`
(desktop 0.9.57): a test installer from **Build test installer
(unsigned)** with the hold offered and the test switches compiled in (its
log shows both build flags), on `Neoxify-Test`, captured at the NIC with
`pktmon --comp nics`, the leakers running. Every log line and screen read
carries the guest's performance counter, tied to each capture by marker
frames. Germany throughout; its exit IP matched the node. The tooling is
the third round's, fixed where the results say. Tooling and raw results
are outside the repo, in `C:\Users\aliha\Claude\vm\tools\hold3` and
`C:\Users\aliha\Claude\vm\results\hold4`.

The installer matched the run's `sha256sums.txt`, and the installed
service and app carry timestamps from inside that run. They were not
hashed against the package itself (no 7-Zip on the host). The app did not
update itself during the round. Every location's Compatible is OpenVPN
UDP, so OpenVPN TCP still has no server.

With the setting off, one forced drop per engine leaked in every gap (97
to 132 leaker frames, the first 0.16 to 1.14 s after the drop), with no
hold filter, `block=false` on the connect, nothing in
`reconnect-hold.log`, and the screen saying traffic goes out without
Neoxify. So the capture sees the leak.

**The hold held every engine drop, and every failure of the third round
passed.** 123 kills, stops and adapter disables and 14 network cuts of
30 s on Reality, TLS, Trojan, Shadowsocks, Stealth Web, OpenVPN UDP and
WireGuard sent no leaker frame, no port 53 to another host and no IPv6
outside the allowed set, from the drop to the next confined tunnel. It
failed on three new things: a WireGuard "not confirmed" landing let go on
the third read, not the second; a stall of the whole guest that the
service took for the app going silent, after which a reconnect ran unheld
and leaked; and two screen timings in a failover.

**Item 1, Xray: PASS.**
- 75 kills, 15 per protocol: no leak. `cleanup.log` shows the "tunnel
  adapter is gone" path in 21 of them, all held first. Next confined
  tunnel a median of 5.7 to 5.9 s after a kill (5.2 to 8.0 s).
- 16 disables of `neoconnect0` under a live xray.exe (3 per protocol, 4
  on TLS): no leak. Each was held by "the tunnel adapter is gone" and let
  go of only after the next confined tunnel; no "could not be named", no
  `tunnelNotPermitted`. The restated measure passed: no status read after
  `Disable-NetAdapter` returned said connected. The first "ended" read came
  0.01 to 0.34 s after it returned (once 0.79 s, when reads before it
  returned had already said so).
- 10 network cuts, 2 per protocol (the third round's failure): no port 53
  to any host but the configured resolvers, the status never
  `dns_anywhere`, no port-53 note on screen. WFP at cut+5.5 s and at
  net-on+0.3 s names the three configured resolvers, with no "to anywhere"
  filter. Next confined tunnel 6.4 to 7.5 s after net-on.
- IPv6: nothing outside link-local, multicast and the configured resolver
  in 101 drop windows and 93 tunnel-up windows (VirtualBox NAT's path).
- Frames to hosts outside the allowed set (66 on Trojan, 31 on
  Shadowsocks) came only from neoconnect-desktop.exe, by the WFP audit,
  under the hold's program permit.
- Still, after every disable (16 of 16), the redial on the same protocol
  fails ("neoconnect0 did not appear within 5s") and the ladder moves on,
  so the next tunnel takes 44.5 to 47.9 s. Not looked into.
- The refused-confinement item: unverified, as stated above.

**Item 1, WireGuard and OpenVPN UDP: PARTIAL, only because OpenVPN TCP
has no server.**
- WireGuard, 24 drops, no leak: 8 hard kills of the tunnel's
  wireguard.exe, 8 stops of the tunnel service, 3 emulated slow stops, 3
  adapter disables with wireguard.exe running, 2 cuts. 116 hold filters
  stood before each drop. No "standing filters taken out", no "could not
  be named".
- **A natural slow stop happened this time.** `sc query` showed
  `STOP_PENDING` in 8 of 8 stops, 0.14 to 3.3 s; two pended for seconds
  (2.5 and 3.3 s). No leak. The third round's open item is closed.
- The 3 disables were held by "the tunnel adapter is gone", and no read
  after the disable said connected.
- OpenVPN UDP, 12 drops, no leak: 8 kills of openvpn.exe, 2 adapter
  disables (held by "the tunnel adapter is gone", the first read "ended"
  at +0.04 and +0.13 s, both reconnects landing on Stealth HTTPS) and 2
  cuts.
- The 4 cuts: no port 53 elsewhere, never `dns_anywhere`, WFP naming the
  resolvers at cut+5.5 s and net-on+0.3 s. Next tunnel 6.1 to 9.1 s after
  net-on.
- 0 frames outside the allowed set in 48,131 drop-window frames; 34
  tunnel-up windows between drops clean.
- OpenVPN TCP: not run. No location offers it.

**Items 1b and 2: PASS.**
- Standing over WireGuard: 120 hold filters with the tunnel up, exit IP =
  node, 27.9 to 39.0 Mbps against 33.1 to 41.2 with the setting off. None
  after Disconnect; none with the setting turned off over a live tunnel,
  which stayed up. A failing connect of the customer's own to Finland
  (every rung sent to a documentation address by a page hook) said
  "Couldn't connect." and left nothing blocked.
- A hostname endpoint: the standing filters permit the resolved address,
  23 to 29 Mbps, and a drop redialled wholly under the hold at 25.7 Mbps,
  no leak.
- `refuse-standing`: no filters while up, "not standing" in the logs. The
  drop was held late (+0.34 s), no leaker frame; the held sentence with
  the late note at +1.08 s, the "lost" toast in its late words.
- `unname-wireguard-server` (the third round's failure): `lettingGo` on
  status at +3.30 and +3.41 s, then the let-go, and no "blocked" read
  after it. The reason (`tunnelNotPermitted`) stayed through the next
  session's "armed" until "protected", never "checking". WireGuard came
  up, exit IP = node. 18 and 31 leaker frames left between the let-go and
  WireGuard's own block: the stated cost. In the second run the drop
  itself was held late too, with no standing filters: 10 leaker frames in
  the 0.45 s before the hold, which the late note says.
- Item 2: every engine dialled and carried under the hold, exit IP = node:
  WireGuard-NT 23.7 to 25.7 Mbps (23.5 before the drop), Reality 37.6 to
  38.6, TLS 31.9, Trojan 34.3, Shadowsocks 33.7, Stealth Web 39.3, OpenVPN
  UDP 16.6 to 24.9 Mbit/s at the NIC (17.5 before). No leaker frame in
  any setting-on capture; the only frames outside the allowed set were the
  app's own (audit). OpenVPN TCP not run.
- Not isolated: WFP gives the WireGuard-NT flow to wireguard.exe here, and
  WireGuard's own permit matched it, so whether the hold's address permit
  alone would carry it is not shown.
- Seen, not the hold: 5 of 11 runs had one download chunk stall 20 to
  60 s after the reconnect; a setting-off control stalled the same way.

**Items 3 and 4: FAIL.** Let go with no filter left on: the tunnel proved;
the customer's Disconnect; Stop reconnecting; the budget (2 passes,
110 s); a third quick death (let go 0.84 s after its third hold, no
leaker frame over its three holds); the plan stopping (page hook); a
sign-out (no password typed; the session restored from backup); the
setting turned off mid-hold; IKEv2 (let go 0.8 s before its connect);
Custom mode; Repair; the app killed; the service restarted (`lettingGo`
0.12 s after `Stop-Service`, let go at 0.36 s); a reboot (shutdown closed
the app first; no filter after boot); and an Xray "not confirmed" landing
(let go 1.07 s after its first landed and confined read, never before).
Item 4: the page frozen after a drop was let go at 124 s with "no
reconnect followed", no leaker frame in the hold; the whole app process
frozen was let go at 63 s with "the app went silent" (the pipe's 60 s
idle grace comes first when the process is frozen); a 5-minute cut held
318 s with the resolvers kept and let go once the tunnel was back, no
leaker frame and no port 53 elsewhere; the 40-minute limit, shortened to
150 s by a VM switch, let go at 150 s. Failed:

- **A WireGuard "not confirmed" landing let go on the third read, not
  within two.** The first and second fresh-handshake reads came 0.90 s
  apart by reply, under `RELEASE_READS_APART_MS` (1 s), while a holding
  app reads every 1 s. The safe side; no leak.
- **A stall of the whole guest let go of the hold, and the reconnect
  after it ran unheld.** In the first try at the 5-minute cut (Reality)
  the guest stalled about 72 s (VirtualBox: heartbeat flat, cause
  unknown). The service's idle watchdog times the app's silence on a
  clock that counted the stall. It ticked before the app's first request
  after the stall was served and let go with "the app went silent", which
  also disarms. The episode's next connect asked for the hold, found
  nothing held and dialled without one: 94 leaker frames between the
  network coming back and the confinement. The screen said "Waiting for a
  network connection ... not protected", which was true. Then for 2.8 s,
  over the confined tunnel with nothing held, it said "checking whether
  ... blocked": after this let-go the status carries no hold at all, so no
  reason was kept. A laptop's sleep may do the same: unverified.

Not passed, not failed:

- The attempts limit: not run. It cannot be reached. A pass is now about
  130 rungs, 54 to 65 s even when every connect fails at once; 6 passes in
  120 s would need under 10.6 s each.
- Gaming mode: not run. Its switch is disabled while reconnecting, and the
  service refuses to arm it (`GAMING_DNS_ARMABLE=false`).
- The device limit: unverified. Only the app's path for the error's words
  was made, not the slot API's own refusal.
- A "not confirmed" landing whose confinement is refused, held until
  Disconnect: unverified (no switch).
- A reboot by hard reset while holding: not run.
- Seen: Custom mode's let-go went ahead after `LET_GO_SAID_WITHIN` with no
  read having carried `lettingGo`, because reads came about 1 s apart
  during that connect, not 400 ms. After a sign-out the running pass held
  again for 6.6 s until the sign-out's teardown, and after a service
  restart the continuing reconnect held again 11 s later, as in the third
  round.

None of these gaps is one this file accepts as unverifiable on the VM.

**Item 5: FAIL, on two screen timings; no leaker frame while any hold was
in force** (13 captures). Passed: a held drop with the window behind (the
hold at +0.39 s, "blocked" at +1.09 s and never "checking" first, the held
"lost" toast, "back", the release after the confinement, no leaker frame
in the hold or the 8 s after); the third quick death and the plan stopping
("still blocked" within 0.02 s, then "lost" and the toast at the release's
reply); **Disconnect mid-hold** ("Disconnecting... Neoxify is closing the
VPN connection." from the press to the reply, "not protected" 3 ms after
the reply and 1.04 s after the let-go); Stop reconnecting ("not protected"
10 ms after the reply); **the service stopped mid-hold** (a `lettingGo`
read, then the let-go; "blocked" gone on that read, the first leaker frame
0.19 to 0.33 s later, then "isn't answering"); the service killed
("blocked" stood 0.16 s after the kill, the stated gap, with no frame out
in that time); **a WireGuard rung let go partway** (`lettingGo` at
+94.50 s, the let-go at +94.58, "blocked" gone at +94.51, the first
leaker frame at +94.80; the reason kept through "armed" to "Connected",
never "checking"; a plain toast after the held one); the switch
confirmation and the `role=status` region; and no release before the next
tunnel was up and confined. Failed:

- **"Isn't answering" in a failover.** With the node blocked in the
  guest's firewall, the failover reached an IKEv2 rung and the hold was
  let go of correctly, said first. But a status read sent while the IKEv2
  connect was on the wire timed out after 6 s, and the screen said
  "service isn't answering ... checking whether ... blocked" in place of
  the reason, with no hold in force: 0.41 s in one run, and again in a
  second.
- **"Blocked" after a failover's own teardown let go.** In a failover
  whose every rung failed (every node blocked in the guest's firewall,
  plus page-hook errors), the teardown sent a plain Disconnect. The
  service let go on receipt without saying `lettingGo`, and the screen
  said "blocked" for 0.42 s after the let-go while 15 leaker frames left.
  That traffic is the intended fail-open once the failover gives up; the
  words were wrong.

Not reached: "1.5 s of nothing, then 'checking'" and the "hasn't yet
confirmed" toast. Every hold was read within 1.1 s, so the screen went
straight to "blocked".

Seen, not judged:
- The `notCovered` reason ("goes out without Neoxify until the VPN is
  back") stood 3.2 s over a WireGuard tunnel with its standing filters,
  until the tunnel was proved. No leak. That is the kept reason doing what
  fix 4 asks, but the words were not true by then.
- After a service restart the restarted service held nothing and the
  screen said traffic goes out. True at the NIC, but the second capture's
  line says never "going out without Neoxify" after a restart. The item
  should say what is right once the restarted service answers.
- 37 frames to public resolvers on port 443 inside one hold, with the
  audit off. Elsewhere the audit gives such frames to the app.
- The held sentence blanked for 0.2 to 0.9 s at IKEv2 rungs the service
  did not let go for. Nothing was claimed then.
- After a drop the headline "Connected, You're protected" stood 0.2 to
  1.3 s past the first read that said the tunnel ended, with the held
  sentence already showing.

**Items 6 to 8: PASS.**
- 6, the LAN while held: the VirtualBox gateway answered ping and TCP in
  all 28 rounds; port 53 went only to the configured resolvers.
- 6, the roam (restated: within about a second), to another NAT network
  with other resolvers: the new-plan line came 0.42 s after the new
  address, and its WFP dump permits the new LAN and its two resolvers
  only. The new gateway answered from +0.82 s. After the new address, no
  ping or TCP to the old LAN, and 2 lookups to the old resolver at +0.23 s,
  then none. Back again: the plan followed the new address, no lookup to
  the old resolvers, and 2 ICMP frames to the old LAN within 0.6 s (the
  audit shows a plan read on the old lease permitting them for that
  instant). 35 WFP dumps, each within about 0.2 s of its new-plan line.
  The 3 cable-out plans dropped the LAN, kept the resolvers and had no "to
  anywhere"; 0 of 1,195 status and screen lines said `dns_anywhere`. No
  leaker frame from the drop to the release (227 s).
- 7, restated: DNS removed before the connect gave `dns_anywhere` on all
  72 status reads, the port-53 note on screen, 3 "name lookups to
  anywhere" filters, and port 53 to anywhere at the NIC, nothing wider.
  Removed mid-hold: never `dns_anywhere`, no note, the resolvers in force
  kept, no port 53 elsewhere. The removal takes two steps; a read between
  them found only the IPv6 resolver, so the IPv4 one left the list for
  about 52 s (still reachable through the LAN permit).
- 8, off is off: with the setting off, a 30 s cut under Xray, a
  `neoconnect0` disable, a WireGuard adapter disable and a WireGuard cut
  leaked as before (433, 1,063, 117 and 82 leaker frames), with no hold
  filter in any dump, `block=false` on every connect, no hold in status or
  log, and no hold words. That a release build has no switch was read from
  the code and the wiring test, not run. The 0.9.57 release installer was
  not put on the guest (the host holds only 0.9.47's).
- Seen, not judged: a page-hook IKEv2 rung never dialled, and the hold
  stayed on.

The guest stalled five times in the round (18 s to about 8 minutes,
heartbeat flat, no bugcheck, cause unknown; one hard reset). One of them
found the watchdog fault above; the others only voided or delayed runs.

**What has to change before the next capture** (from a read-only
diagnosis of these logs and the code):

1. **Two reads half a second apart.** `RELEASE_READS_APART_MS` = 500. A
   holding app reads every 1 s (`LIVENESS_POLL_MS`), and reply times vary
   by a tenth of a second, so two reads a second apart can measure 0.9 s.
   500 ms is still above the duplicate reads that arrive within 0.1 s of
   each other. Proof: the WireGuard "not confirmed" landing 5 or more
   times, `vpn_release_reconnect_hold` after the second "alive" read each
   time.
2. **A machine stall is not the app going silent.** `spawn_idle_watchdog`
   (pipe.rs) checks `last_seen.elapsed()` on `Instant`, which counted the
   stall. Time each sleep; a tick that took more than twice `IDLE_POLL` is
   a stall: reset `last_seen` and carry on. Better still, report that
   let-go as `notHeld` with a reason, so the gap keeps it and the screen
   does not say "checking" over nothing. Whether a laptop's sleep does the
   same depends on whether `Instant` counts suspended time: unverified.
   Proof: pause the VM about 75 s (`VBoxManage controlvm pause`) during a
   held cut: no "the app went silent", the hold lasts through net-on, no
   leaker frame. The whole-app freeze must still let go at about 60 s.
3. **A slow read during a connect is not "isn't answering".**
   `holdStore.unanswered()`, from `serviceStatus()`'s error path in
   Dashboard.tsx, checks whether a connect is running when the 6 s timeout
   fires, not when the read was sent, and it overwrites a `notHeld`
   reason. Record at send whether a connect was on the wire, and skip
   `unanswered()` -- unless the service is gone -- if one was, or one
   started or ended since. Proof: both failovers again with no "isn't
   answering"; a service stop and a kill still say it.
4. **The app's own teardown says neither until its reply.** The
   failover's failed-pass teardown is a plain `serviceDisconnect()`, which
   sets no "disconnecting" state by design. The service's Disconnect lets
   go on receipt without `lettingGo` (the fourth-round fix covered
   `hold_through_connect` and the stop only). Before the invoke, move
   holding or unanswered to letting go, and ignore "holding" reads until
   the reply. That needs a new store method: `lettingGo()` sets
   `lettingGoSent`, which only a connect's end clears. The alternative is
   the service waiting for one read on Disconnect too (up to 0.6 s). The
   log's reason, "the customer disconnected", is wrong for an app
   teardown. Proof: the all-rungs-fail failover 3 or more times, no
   "blocked" after the let-go line, "not protected" only after the reply;
   the customer's Disconnect still says "Disconnecting...".

**Also open, and needed before this file can say proven.** None of these
is in the list the VM cannot prove, and three rounds have not run them:

- OpenVPN TCP has no server in any location. Proving it needs a location
  that offers it (a node change, the owner's), or the owner deciding that
  items 1 and 2 ship stated unproven for OpenVPN TCP in the release note.
  It is not dropped quietly.
- The attempts limit and Gaming mode cannot be reached mid-hold by a
  customer. The checklist should say so, or a VM switch should make them
  reachable.
- The device limit's refusal from the slot API itself has not been made.
- Smaller: the redial failing after a `neoconnect0` disable, Custom mode's
  1 s reads during its connect (so `lettingGo` went unsaid), and the
  "seen, not judged" screen lines under item 5. The round's own screen
  check misread the teardown case above as a customer's press; the
  tooling needs that fixed.

The next capture runs items 3, 4 and 5 again in full, with a paused VM
during a held cut, and one kill and one cut per engine for item 1 to show
nothing else moved.

## The second 2026-11-09 capture (build `de9ffbb`): no leak, shipped as a beta

Round five reran only round four's failures, plus one kill per engine as
a smoke check. It used `claude/reconnect-hold-r5` at `de9ffbb` (desktop
0.9.58 plus the four round-four fixes: reads 500 ms apart, the
unanswered rule judged when a read is sent, the watchdog's stall
check, and the teardown's let-go word), from **Build test installer
(unsigned)** run 42693220216. The method was round four's. Defender in
the guest, with real-time protection on, scanned both installers clean
before the install. (A first rebuild had been flagged by its machine
learning and was not used; Defender was not changed.) The tooling is in
`C:\Users\aliha\Claude\vm\tools\hold5b`, and the raw results in
`C:\Users\aliha\Claude\vm\results\hold5b`.

**No leaker frame while any hold was in force, in any run.**

- **Smoke.** The Xray taskkill held 0.59 s after the kill, reconfined,
  and let go after 13 s. The WireGuard hard kill held 112 standing
  filters and let go after 8 s. Neither had leaker frames, traffic
  outside the tunnel, or DNS sent elsewhere.
- **Not-confirmed WireGuard (item 2).** Of 8 kills, 6 landed not
  confirmed. Five of those let go on the second fresh read, with the
  reads 0.89 to 1.03 s apart. One let go on the 20th read, 25 s after
  landing. That is the safe direction, and the cause is not established.
- **Machine stall (item 3).** Unverified. `VBoxManage controlvm pause`
  freezes the guest's clock as well: 75 s of pause moved the guest
  counter 1.8 s, so the watchdog's stall path never ran. The hold stood
  throughout. A frozen app was let go after 66 s with "the app went
  silent", as designed.
- **Words (item 5).** The failover case (`fo`) had two
  "Neoxify's service isn't answering" frames over a service that was
  answering:
  - 2 s from a read sent during a 28 s split-tunnel change;
  - 0.25 s from a pipe that stayed busy for its whole second of retries
    during a connect, which the app read as the service being gone.

  Both were fixed in `643631c` (a call of ours that holds the service's
  thread now excuses an unanswered read, and a busy pipe now says busy).
  That is unit-tested only. The other cases got the right words:
  `foall`, a stopped service, a killed service, three failed failovers,
  and the customer's Disconnect.

Shipped in 0.9.59 as an opt-in beta. Still unproven:

- the words fix on the VM;
- the 25 s outlier;
- a real machine stall and laptop sleep (the round-four leak's cause,
  fixed in code). If the stall path fails, the hold lets go, which is
  how the app behaves with the setting off;
- a real IPv6 path, a censored network, and a physical laptop;
- OpenVPN TCP, which has no server;
- the attempts limit and Gaming mode mid-hold;
- the device limit's refusal from the slot API;
- refused confinement.

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
   screen); the status says the tunnel ended at the first status read after
   the adapter is gone, not "Connected" -- the app reads every 500 ms while
   an armed tunnel is up. **(restated, fourth round)** This said "within a
   second of the disable". `Disable-NetAdapter` itself takes 0.4 to 0.7 s,
   and the adapter-gone check runs only on a status read (it was every
   second, and the status said the tunnel ended 0.37 to 1.77 s after the
   command), so the measure is the read: no read after the adapter is gone
   may still say connected.
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
   **(new, fourth round)** The three timing failures of the third capture,
   frame by frame against the service log:
   - Disconnect mid-hold: from the press to the reply, "Disconnecting...
     Neoxify is closing the VPN connection." -- neither "blocked" nor "not
     protected" -- then "You're not protected", never before the service's
     let-go line.
   - The service stopped mid-hold (`Stop-Service`): the status says
     `lettingGo` (`reconnect-hold.log`: "letting go" before "let go of"), the
     screen says neither, and no "blocked" stands after the let-go line.
     Then "isn't answering ... checking". A kill of the service process
     cannot warn first: run it once and record how long "blocked" stood
     after the kill (expected: up to one 400 ms gap read), as the stated
     gap.
   - A WireGuard rung let go partway (`unname-wireguard-server`): `lettingGo`
     before the let-go (no "blocked" after it), then the reason, and the
     reason kept through the next session's "armed" until the tunnel is
     proved -- never "checking whether other connections ... are blocked"
     after `tunnelNotPermitted`.
6. **The LAN while held, and after roaming.** A LAN host (the VirtualBox
   gateway, a share on the host-only network) answers while held. Then
   change the guest's network during a long wait (switch the adapter to
   another NAT network or host-only subnet): within ~10 s the new LAN's
   hosts answer and the new network's resolver is permitted; the old
   LAN's is not.
   **(restated, fourth round)** Within about a second of the new address
   (`NotifyUnicastIpAddressChange`, then every status read for 5 s), not
   10 s: the old LAN's frames and lookups to the old resolvers end within
   1 s of the new address, with a WFP dump at each "new plan" log line. And
   the cable-out moments keep the old resolvers -- no `dns_anywhere` on
   status or screen, no port 53 to a resolver the guest is not configured
   with.
7. **Resolvers unread.** With DNS removed from every non-tunnel adapter
   (static, no servers) **before the connect**: the status says
   `dns_anywhere`, the app shows the port-53 note, and the capture shows
   port 53 to anywhere permitted -- the stated broad rule, nothing wider.
   **(restated, fourth round)** The third capture removed DNS mid-hold. A
   read that finds no resolvers while some are in force now keeps those
   (that is what a network cut reads: an adapter that is down is skipped,
   and every cut opened port 53 to anywhere that way), so mid-hold it no
   longer says `dns_anywhere`. Removed before the connect, the first read
   finds none and the broad rule is said; removed mid-hold, check the
   opposite: the resolvers in force stay, and nothing is said about port
   53 to anywhere.
8. **Off is off.** Setting off (the default), each drop above leaves the
   machine fail-open exactly as before: no hold, no filter, no note --
   and in a release build there is no switch at all.

Not provable on the VM: a real IPv6 path (this PC has none; a leak shows
only as packets sent), a censored network, and a physical laptop roaming
between real Wi-Fi networks. Those stay **unverified** and are said so in
the release note if it ships before they are measured.
