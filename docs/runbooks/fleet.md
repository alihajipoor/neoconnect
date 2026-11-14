# Adding, retiring and replacing servers

One tool, `scripts/fleet/fleet`, run from Git Bash on the operator's PC.
It replaces the 67-step hand procedure of the November 2026 fleet
replacement, where something was forgotten on every pass.

It is a **checklist, not a script**. Every step has an id, a command and
a verify, and the next step does not start until the verify passes. A
run can stop anywhere and the same command picks it up again.

**Status: its reading side has run against the real fleet; nothing that
writes has.** On 2026-11-11 `status` ran for every server, `precheck`
against a built server (it stops before it starts anything), `add` and
`retire` under `--dry-run`, and the read-only pieces one by one against
live servers: the retire guards, `verify.sh`, the parity and fleet-form
checks, the maintenance audit, the image report, the dest audit, the
hop and plan parsers, the user counts. That run found four places where
a healthy server was read wrongly, all fixed and now tests built from
what the servers printed (`test/real-output.test.mjs`):

- a route rule on the relay box counted twice;
- the two IPv6 rules for Xray "missing" on every server that has them,
  because ip6tables prints the owner as a number;
- the API mirror sites called drift on every server, over a comment
  line and the order of two headers;
- the time unit chosen wrongly four times in ten, a command piped into
  `grep -q` under pipefail.

No `add`, `retire` or `replace` has run, and no step that changes a
host. The first one is a supervised run. Until then everything below
about what a step that writes "proves" describes what it checks, not
something that has been seen to work.

**2026-11-13/14, the first real runs** (finland-3 retired, finland-4
added) went step by step with `--only`, because the tool could not be
trusted to run through. What each needed by hand is now fixed in the
tool or the installer (next section). A run straight through, as one
command, has **not** happened yet; the next server is its first.

## One command

```bash
scripts/fleet/fleet add <name> <address> --region <cc-country> --yes
```

From an empty Ubuntu box to a server in the customer plans, with no
agent or person in the middle unless one of the stops below is hit.
`retire <name> --yes` and `replace <old> <address> --yes` the same.

**Every stop prints the exact line to continue**, naming the run
directory and never an address:

```bash
scripts/fleet/fleet continue ~/.neoxify/runs/add-<name>-<time> [--the-flag-it-names]
```

`continue` runs the command the run was started with (kept in the run
directory as `argv`). A decision given once (`--accept-held`,
`--hop no`, `--dest`, `--proven-elsewhere`, ...) stays with the run and
is never asked again; a plain re-run of the first command carries it
over too.

What can still stop a `--yes` run, each with its continue line:

| Stop | Why | To go on |
|---|---|---|
| a gate: `pre.verdict`, `add.inside-probe` | the address is held from inside | `--accept-held`, the owner's call |
| a gate: `add.zone-inside` | names under the node zone are rewritten inside | `--accept-blocked-zone` |
| a gate: `add.dest` | the disguise site fails its audit or the REALITY trial | `--dest <another site>:443` (`--accept-weak-dest` for WEAK only) |
| a gate: `add.canary-other` | WireGuard, OpenVPN or IKEv2 not proven on the server | prove them in the real app on the canary, then `--proven-elsewhere wireguard,openvpn,ikev2` |
| a gate: `retire.guard-plans` | a plan's default route is on the server | `--default-to <server>` (`fleet plan-check <name>` shows the verdict read-only, before any run) |
| `retire.guard-hop` | the server carries the relay hop | `fleet replace`, which moves it first |
| an owner step: `retire.dns-other` | names at a registrar the tool cannot edit (only when there are some) | delete them, then `--done retire.dns-other` |
| `add.firewall`, only with `--provider-firewall` | the owner said the provider has a firewall | open it, then `--done add.firewall` |
| `add.install` | the installer asks something the answers do not cover | answer in the box's session (`tmux attach -t nx`); the step keeps watching |
| any verify | something is really wrong | fix it, then the continue line |

The owner's lists at the end (`add.owner-after`, `retire.owner-after`,
`retire.delete-vps`) are printed and written to `owner-todo.txt` in the
run directory; they are not waited for.

### The canary: no customer before every protocol is proven

The customer plans come last, after the server is proven through one
plan no customer can buy:

1. **build** and the **scripted proofs** (temporary users in the
   server's running Xray, from outside, from inside, through the relay);
2. `add.canary-routes`: the server's routes, direct **and** relay,
   into `Internal test` only (`--canary-plan` to name another). Refused
   if that plan is purchasable or a customer is on it;
3. `add.canary-open`: `isActive` on, only if it was off (`isPurchasable`
   is never sent; its value before is recorded), and one subscription
   for the test account (`TEST_DIRECT_EMAIL`, or `TEST_CANARY_EMAIL`);
4. `add.canary-provision`, `add.canary-e2e`: the panel issues that
   account its credentials, exactly as for a customer, and the five Xray
   protocols are dialled with them straight to the server and the four
   relay ones through the relay box, exit address matched;
5. `add.canary-other`: WireGuard, OpenVPN and IKEv2, dialled by the
   tool with their real clients and the test account's credentials
   issued through the canary (see *WireGuard, OpenVPN and IKEv2* below).
   A protocol that does not pass stops the run here, with the canary
   open, naming it. `--proven-elsewhere <p>` still records a proof made
   another way (the real app on the canary); it counts only for a
   protocol whose dial did not pass, and the run log says both;
6. `add.canary-close`: the test subscription the run made is deleted
   and `Internal test` gets back exactly the flags it had;
7. `add.plans`: the customer plans, smallest first, heartbeats and
   backend errors checked after each. It refuses to start while any
   step before it, canary included, has not passed.

### WireGuard, OpenVPN and IKEv2

`add.canary-other`, and `fleet prove <name>` on its own against a live
server, dial each of the three the server has, all at once, from the
panel host (where the Xray proofs dial from):

- the client is the real one (`wireguard-go` + `wg`, `openvpn`,
  strongSwan's `charon` with `swanctl`), with the credential the panel
  issued (`remote/panel/nx-dial.sh` builds the client config from it,
  in RAM, never printed);
- it runs in a throwaway container: its own network namespace on
  Docker's default bridge, `--cap-drop ALL` plus `NET_ADMIN` (and
  `NET_BIND_SERVICE` for IKEv2), `/dev/net/tun` only, read-only root,
  128 MB, half a CPU, 64 processes, a hard time limit, removed on any
  exit. Not `--privileged`, no host networking: the host's routes,
  firewall and resolver are never touched. WireGuard runs in userspace
  and IKEv2's ESP in charon's own libipsec, so no kernel module is asked
  for;
- proof is all of: the exit address `/health/ip` sees is the server's
  own, 256 KB down and 256 KB up through `/health/bulk`, and the
  server's own view of the session, read while the tunnel is held
  (`remote/node/session.sh`: the WireGuard peer's handshake and byte
  counters, this session's line in OpenVPN's status file, the IKEv2 SA
  of that EAP user), shows at least 256 KB each way. Nothing secret, no
  address, is printed;
- the client leaves as a real one does (IKEv2 DELETE, OpenVPN exit
  notify), so the server does not keep the session.

What stays on the panel host: one image, `nxf-dial:1` (about 160 MB,
Debian slim with the three clients), built the first time it is needed
(about 20 s to a few minutes) and reused; its build cache is pruned.
Nothing else: no container, volume or file outside `/dev/shm/nxf`, which
the end-of-run cleanup removes. All three take about a minute together
(OpenVPN is the slowest: its status file is written every 60 s at most).

Proven for real on 2026-11-14 against finland-4 (`fleet prove
finland-4`, client side only, nothing changed on the server): all three
exit-matched, 256 KB each way, the server's own view agreeing, in 50 s.

### One database dump per run

The first step of a run that writes to the database takes the dump
(`add.dump-node`, or `retire.dump`), records it in the run directory
(`dump.txt`, and `run_dump_file` in `state`), and every later step that
writes reuses it and says so. `--fresh-dump` takes a new one at the
next step that asks; `--use-dump /root/db-backups/<file>.sql.gz` makes a
dump this job already took (say, at the start of the session) the
run's one dump. A write query refuses to run while the run has none.

### --done never re-runs an action

`--done <step>[,<step>]` means "done another way". For an owner's step
the owner did it; for any other step it was done by hand or in an
earlier pass. Either way **only the step's verify runs**, never its
action, and the verify alone decides. (On 2026-11-14 `--done` on a
relay step re-ran it and took a second 62 MB dump.)

### Time

Every step prints `took Ns`. Every pass ends with a table of the steps
it ran and a total, and the whole run's table (every pass, every try)
is `timings.txt` in the run directory.

What the Finland runs took, read from their run logs (tool steps only;
the waits between `--only` calls, the inside test, the app proof and
the go-live plan edits are not in them):

- `add finland-4`: 24 min of step time over 35 min. Slowest:
  `add.install` 290 s, `add.e2e-direct` 115 s (two tries),
  `add.e2e-relay` 113 s, `add.reboot` 94 s, `add.inside-probe` 86 s
  (two tries), `add.packages` 70 s, `add.verify` 69 s (two tries),
  `add.renew-dry` 51 s (two tries). Two of the tries were the dead Xray.
- `retire finland-3`: 9 min of step time over 21 min. Slowest:
  `retire.plans` 151 s (five plans), `retire.offline` 73 s,
  `retire.hop` 69 s, `retire.relay-routes` 51 s.

The installer alone is five minutes, so a whole `add` is not a
five-minute job: about 20 to 25 minutes of steps when nothing fails,
plus the app proof of the three protocols until those are scripted.
Steps that could run side by side and do not yet: the five direct test
tunnels (one after another today), the tunnels from outside and from
inside (different hosts), the inside probe from the two inside boxes,
the reputation and reverse-DNS readouts. Nothing runs in parallel yet.

### Clean on every host, every time

Every pass ends -- passed, stopped, failed or interrupted -- by
shredding the scratch directory (`/dev/shm/nxf`) on every host it
reached, the admin token with it. The one thing kept is the panel
host's record of temporary test users while some may still be in an
Xray (`temp/`): the next pass needs their emails to take them out. The
tunnel test's port lock lives in that directory now, not loose in
`/dev/shm`.

### After the install: running and listening

`add.postfix` (`postinstall.sh`) and `add.verify` (`verify.sh`) now run
`engines.sh`: every engine's unit running, Xray listening on every
inbound port, nginx on 80, WireGuard and OpenVPN on their ports, IKEv2 on
500 and 4500 with its connections loaded. `postinstall.sh` also checks
that every file in `/var/log/xray` is nobody's. Its `fix` starts what
is down: Xray is restarted only when it is not running (nobody is on a
dead Xray), anything else is started, never restarted. The UDP-over-TCP
test counts only address lines, and fails outright when the server's
Xray is not running or nothing listens on the Shadowsocks port.

The installer itself now creates Xray's log files as nobody before its
config test (which runs as root and used to create `access.log`
root-owned), checks Xray is running a second after its restart, and
starts the IKEv2 loader unit instead of only enabling it
(`scripts/test-xray-logs.sh`).

No address and no name of ours is in this file or anywhere in
`scripts/fleet` (see `docs/node-address-hygiene.md`). They come from a
local file outside the repository, or from the database through the
panel host, and everything the tool prints is masked.

## Before the first run

```bash
mkdir -p ~/.neoxify && cp scripts/fleet/fleet.env.example ~/.neoxify/fleet.env
# fill it in: panel host, the three SSH keys, the two inside boxes, the DNS zones, two test accounts
```

The tool refuses to read that file from inside the repository. It needs
`ssh`, `tar` and `node` on the PC; `jq` and `python3` are only needed on
the hosts, which have them.

See any checklist without touching anything:

```bash
scripts/fleet/fleet steps add                      # ids and titles
scripts/fleet/fleet add <name> <ip> --region <r> --dry-run   # every command it would run
```

## The five commands

| Command | What it does | What a pass proves |
|---|---|---|
| `fleet precheck <ip>` | Tests an **empty** box from both boxes inside the watched country: 256 KB up and down on three ports. Reputation and reverse-DNS readout. | That data moves to that address from inside, per box and port: `PASS` or `HELD`. Not a TCP connect: a held range lets the connection open and stalls the upload. |
| `fleet add <name> <ip> --region <r>` | Empty Ubuntu box to a server in the plans: keys, OS, what the provider's image brought along, DNS, certificates, the disguise site, installer, fleet form, reboot test, inside probe, test tunnels, relay routes, the canary, customer plans, provisioning, monitoring. | Before anything is built on it: REALITY completes through the disguise site from outside. Before any customer has it: every Xray protocol exits on the new server's own address with 256 KB both ways, from outside and from inside, then the same with credentials the panel issued through `Internal test`; WireGuard, OpenVPN and IKEv2 proven (by the app, on the record) through that plan too. |
| `fleet retire <name>` | Names at once if the box is already gone. Then plans first, relay routes, block incident, agent, server row, key, DNS, relay hop entry, alerts, leftovers. Ends by saying the VPS can be deleted. | That nothing points at the server any more: no plan, no credential, no route, no name, no hop rule, no file on the panel host. Its row and usage history are kept. |
| `fleet replace <old> <ip>` | First of all: if the old box is already gone, its DNS names are deleted. Then `precheck`, `add` under the next free name, the relay hop moved if the old server carried it, each plan switched from old to new in one edit, then `retire`. | Both of the above, and that relay routes to the exits behind the hop still exit where they should after it moved. |
| `fleet continue <run dir> [flags]` | Picks a stopped run up again with the command line it was started with, plus the flags given now. | Nothing by itself. |
| `fleet plan-check <name>` | Read-only: the plan guard of `retire`, for real (a dry run asks the database nothing). | Whether `retire` would pass its plan guard now, and why not. |
| `fleet prove <name> [--plans <plan>]` | Dials the server's WireGuard, OpenVPN and IKEv2 with the test account's issued credentials (through that plan, or any), from a throwaway container on the panel host. Changes no server, plan or row. | Whether each of the three carries traffic to the server's own address, and what the server saw. |
| `fleet status [<name>]` | Read-only: heartbeat, agent, API door, plans, relay routes, customers' bytes, inside-probe readings, engine units, certificate days, DNS records. | Nothing: it is a readout. |

Useful flags: `--dry-run`, `--from <step>`, `--only <step>`, `--yes`
(do not ask before steps on a live host), `--done <step>` (done another
way: only its verify runs), `--waive <step>` (the owner decided to go on
although that step did not pass), `--fresh-dump`, `--use-dump <file>`,
`--proven-elsewhere <protocols>`, `--canary-plan <name>`,
`--provider-firewall`, `--peer <name>`, `--relay-set <set>`,
`--hop auto|yes|no`, `--plans "A,B"` (customer plans), `--no-relay`,
`--no-plans`, `--default-to <name>` (retire). `fleet --help` lists them.

`--from` and `--only` are for running a step again. They are not a way
past a step that never passed: `--from` refuses while any earlier step
is unproven, and the plans step refuses even under `--only`. The one
way past is `--waive`, which is written to the run log; the run then
ends as "complete EXCEPT" the waived steps, and what they prove is
unverified for that server.

### Kinds of step

- **auto**: runs by itself. The new box, or read-only work.
- **ask**: changes a live host other than the new box (the relay box,
  the hop server). Asks first.
- **owner**: only a person can do it. Says exactly what, then waits for
  `done`. A run with no terminal stops there instead and prints the
  continue line with `--done <step>`. The step's verify still has to
  pass. The owner's end-of-run lists are owner steps that do not wait.
- **gate**: a decision. Passes, or stops and prints the continue line
  with the flag that records the owner's decision to go on:
  `--accept-held`, `--accept-blocked-zone`, `--accept-weak-dest`,
  `--proven-elsewhere`, `--default-to`.

### Two steps of `add` that exist because of one build

Two servers were built by hand in November 2026 on Ubuntu 26.10, on a
provider image the installer had never seen. What each of them met is
now a step. `docs/installer-os-support.md` has the detail. Neither step
has run against a real box yet; what each reads has: the image report
and the dest audit with its control case, on one of those two servers.

**`add.image`** (after `add.mask-upgrades`, before `add.packages`).
That image arrived with ufw active on DROP policies, a hostname taken
from the dashboard label and put back by cloud-init at every boot, a
swap file of the provider's size, and a firmware timer that fails on a
virtual machine. The step runs the installer's own check on the box
(`installer/maintenance/provider-image.sh --apply`), which repairs only
what it finds, and passes when no `REPAIR` line is left. It comes
before the packages because `iptables-persistent` removes ufw and
leaves its DROP policies loaded. `add.inventory` prints the same lines
read-only first, with the interface's name and whether the box has a
global IPv6 address. `add.verify` and `add.reboot` ask again: the
hostname only shows whether it holds after a reboot.

**`add.dest`** (after `add.certs`, before the database dump, the token
and the installer). One of those servers was built on a disguise site
that refuses X25519. REALITY carried nothing, and the first test tunnel
found it with the site already written into the server's Xray config,
the panel's REALITY config and the server row. The step:

1. runs the installer's dest audit on the box. `BAD` stops the run
   (no flag gets past it), `WEAK` stops it unless `--accept-weak-dest`;
2. starts a throwaway Xray on the box with one REALITY inbound on 443
   and keys made for the minute, and dials it from the panel host with
   the same client the later proofs use. It has to exit on the box's
   own address with 256 KB both ways;
3. stops the throwaway inbound and shreds its files (it also ends by
   itself after ten minutes).

When it fails, nothing has been built on the site: run the same command
again with `--dest <another site>:443`. A `--dest` on a later pass is
taken only while the installer has not run.

What it does not show: that the site is reachable, or unblocked, from
where the customers are. The trial is dialled from the panel host.

## What stays manual, and why

| What | Why |
|---|---|
| Deleting the VPS, a provider firewall, reverse DNS, the root password | Only the owner has the provider account. |
| Re-signing the endpoint lists after a server is added or retired | The signing keys live on one machine and are never copied. Client releases come after this, never before. |
| Names at a registrar the tool has no access to | Listed, unmasked, in the run directory for the owner to delete. Do it the same day. |
| WireGuard, OpenVPN and IKEv2 on a real device and network | No longer manual on the server: `add.canary-other` dials all three with their real clients from the panel host (see above). Still not covered by any scripted proof: the apps' own code paths (the Windows service's WinTUN and RAS, Android's and iOS's tunnels), a censored network, IPv6. `--proven-elsewhere` stays for a proof made in the real app when the scripted dial cannot be used. |
| Customer bytes after 24 and 48 hours, per mobile and home network | Both inside boxes are datacentres. Only customers' own attempts show the networks they are on. |
| Website and promo locations | Public copy is the owner's. |

### Refused on purpose

The tool will not do these, and says so when asked:

- **Retire, replace or add the relay box.** Its Xray holds routes that
  exist nowhere else, and a mistake cannot be undone from outside.
- **Make a new entry set on the relay box.** That generates keys there
  and rewrites its Xray config. The tool only uses a set that is already
  free (retiring a server frees its set); with none free it stops.
- **Restart the relay box's Xray, or load its nftables file.** Hop rules
  change one at a time by handle; the file is edited by line and only
  checked.
- **Delete a server row.** That deletes its usage history in the same
  transaction.
- **Change sshd authentication** on any box, or put a credential on the
  sign-in box.
- **Send a plan an empty route list**, or a list that differs from what
  the checklist computed.
- **Restart an engine on a server that has customers.** The repair
  steps of `add` (`add.postfix`, `add.parity`) can be reached again
  with `--only` long after the build. Once a plan holds the server they
  only check, and say what is left for a person.
- **Treat a server as gone because SSH failed.** Gone means no answer
  on three tries *and* not ONLINE in the panel. ONLINE with no answer
  (a server this PC has no key for) stops the run with its names
  untouched.
- **Change a relay route while the relay box's agent is away.** The
  rows would change and the relay's running Xray would not.

### What is automated on the relay box

Reading its state; deleting relay routes through the API (the agent
removes rule and outbound from the running process); creating relay
routes on a free entry set; adding, repointing and removing hop rules
(live by handle, file by line); temporary test users added and removed
through Xray's own API, and counted before and after, because that Xray
is never restarted and a user that was missed would stay for good; a
temporary test client beside its Xray.
Its Xray process id is recorded at the start of every run and checked
at the end.

The three hop steps (`add.hop`, `retire.hop`, `move.hop`) look before
they change, so one that stopped halfway is finished by running it
again. Each ends by checking the hop server itself (table loaded, the
same as the file it loads at boot, unit enabled, forwarding on) and by
dialling a relay tunnel to **every** exit behind the hop, because the
table that was reloaded carries them all.

## Traps

Each of these cost time once. The tool handles them; they are here for
whoever reads a failed step.

- A connect-only reachability check stays green on a held address range. Only bytes count.
- An empty `allowedRouteIds` revokes every subscriber on the plan.
- Plans are edited one at a time, smallest first, with every heartbeat checked after each: a long edit once made the backend drop an agent's stream in silence.
- Credentials are revoked by the plan's list, not by disabling a route.
- A relay route to a dead exit is **deleted** through the API, not disabled: a disabled route keeps its rule in the relay's running Xray and keeps its entry set taken.
- The agent is stopped before a server is set DISABLED, and its key is cleared after: otherwise its next sign-in flips it back.
- A dead server's DNS names go at once. A released address goes to a stranger, who can get a certificate for any name still pointing at it.
- The installer is answered one prompt at a time. Fed a prepared stream, answers land on the wrong prompts.
- A disguise site can speak TLS 1.3 and HTTP/2 with a valid certificate and still refuse X25519, and then REALITY carries nothing. The audit proves X25519 by a handshake of its own, and `add.dest` dials REALITY for real before the installer runs.
- `--accept-weak-dest` answers the installer's question about a weak disguise. Its question about a site REALITY cannot use is worded differently and is never answered for it.
- A provider's image is not always bare: ufw on DROP, a brand word in the hostname that cloud-init restores at boot, the provider's own swap file. Removing ufw leaves its chains loaded, and saving the firewall rules then keeps them for good.
- The interface is not always `eth0`, and a box may have no IPv6 at all. Rules are written for the interface the default route names, and IPv6 is closed for Xray either way.
- The installer's admin token lives 15 minutes and is not refreshed: packages and certificates are done before it starts.
- The panel will not issue a credential on a route outside the subscription's plan, so tunnels are proven before the plan edit with temporary users in the server's running Xray.
- One certificate per name: two of our names on one certificate are published together in the public logs.
- WireGuard and OpenVPN publish the address, never a name. Names are poisoned where the customers are.
- Shadowsocks UDP dies silently on an IPv4-only config without the UDP-over-TCP carve-out. Checked on every build.
- `ssh host bash -s < script` loses the rest of the script to the first `docker exec -i`. Scripts are copied and run as files.
- A tar from Windows carries the PC's user id and no execute bits.
- The server that carries the relay hop cannot be retired until the hop has moved: `retire` refuses, `replace` moves it first.
- After every backend deploy the relay box's agent has to dial in again. `fleet status <relay>` checks that the name it uses still gets through from inside, and the two steps that change relay routes refuse until it reports.
- A hop move repoints the relay's rules one at a time and can stop after any of them. The new server's table is therefore built from the rules through the old server *and* the new one, and "nothing to move" is said only when the relay's file agrees with its live rules.
- An exit the relay reaches only through the hop cannot pass the straight-from-inside tunnels. That step then reports and passes, and the proof from inside is the relay tunnels through the hop.
- A panel-issued proof with a protocol missing is a failure, not a pass: both test accounts must hold credentials on the new server.

## Recovering a half-done run

Runs live in `~/.neoxify/runs/<command>-<name>-<time>/`:

- `run.log`: everything every step printed, with an **`UNDO` line beside each change** saying how to take it back.
- `state`: what the run recorded (the new names, chosen ports, ids).
- `done`: the steps that passed.
- `waived`: the steps the owner chose to go on without (`--waive`).
- `argv`: the command line `fleet continue` runs again.
- `dump.txt`: the run's one database dump.
- `timings`, `timings.txt`: how long every step took, every try.
- `owner-todo.txt`: what is left for the owner.

When a step fails, nothing after it has run.

1. Read the last lines of `run.log`. Fix the cause.
2. Run the **continue line the stop printed** (or the same command again). It skips what is done and resumes at the failed step.
3. To run one step again: `--only <step>`. To go back and redo from a step: `--from <step>` (refused while a step before it has not passed).
4. If a step cannot pass and the owner decides to go on: `--waive <step>`. The log records it and the run never reads as fully proven.
5. To abandon an `add` before the plans step: nothing has reached a customer. Run the `UNDO` lines from the bottom up, then `fleet retire <name>` for what the installer registered (the server row cannot be deleted, only disabled).
6. To abandon after the plans step: `fleet retire <name>`.

One database dump per run, taken before its first database write and
named in the log; later steps reuse it (*One database dump per run*,
above). A write query refuses to run while the run has none.

The installer step is the one that cannot be repeated: a box that is
already enrolled is never installed over. If it stopped on a question
the checklist has no answer for, it says which, and waits while someone
answers it in the box's own session.

## Tests

```bash
node --test scripts/fleet/test/*.test.mjs
```

- the ordered step ids of every command, from a real `--dry-run` against a fixture file: a step that disappears fails the test (`expected-steps.json`);
- a dry run calls no `ssh`, `scp`, `curl` or `tar`, and prints nothing address-like (`fleet dns ... --dry-run` included);
- the engine on a toy checklist: a failed verify stops the run, `--from` and `--only` do not get past an unproven step, `--waive` is recorded;
- the one-command run (`onerun.test.mjs`): `--done` on a step that is not the owner's runs only its verify, a stop prints the continue line and the gate's flag, every step is timed with a total, one dump per run reused and `--fresh-dump`, no step dumps by itself, an unset second key is a stop, the canary refuses a purchasable plan or one a customer is on, WireGuard/OpenVPN/IKEv2 unproven stop the run before the customer plans, `--proven-elsewhere`, the canary closed only with its flags exactly as before, the canary plan takes relay routes too, the UDP-over-TCP count ignores dig's error line, `engines.sh` against stand-ins (a dead Xray, an IKEv2 loader never started, IKEv2 with nothing loaded), `fleet continue`;
- what the riskiest steps decide once the hosts have answered, with the hosts replaced by stand-ins and fixture files (`steps.test.mjs`): the three hop steps run once and run again after stopping halfway, when a server counts as gone, the panel-issued proof with a protocol missing;
- plan-list arithmetic, DNS record matching and the hop edits, as pure functions, with a hop move that stopped halfway and is run again;
- the jq programs that run on the panel host (skipped where `jq` is missing; CI has it);
- the bare-box sink and probe against each other on loopback;
- `add.dest` and `add.image` with the box's answers replaced by stand-ins: a `BAD` site never reaches the trial, a failed trial fails the step and is still stopped, `--accept-weak-dest` is no way past `BAD`;
- the installer's image repairs against stand-ins for `iptables` and `ufw` (`image.test.mjs`): ufw's chains go policies first, an active ufw is not torn down by a save, `/etc/hosts` and `/etc/fstab` rewritten on fixtures, Ubuntu 26.10 accepted, and no interface name written anywhere in the installer, this tool or the agent;
- what real servers printed on the first read-only run, addresses and names replaced (`real-output.test.mjs`): Xray's rule listing and user counts, ip6tables' numeric owner, the mirror sites as they stand on the fleet, the hop server's hand-edited table, and a unit listing that outlives the `grep -q` reading it.

The dest audit has a control case of its own, with no network: two TLS
servers on loopback, one that refuses X25519.

```bash
bash installer/maintenance/reality-dest-audit.sh --self-test-local
```

None of that is a server. See *Status* at the top.
