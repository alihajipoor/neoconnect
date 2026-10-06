# Per-device VPN credentials

Status: implemented on `claude/per-device-credentials`, backend only,
reviewed and revised (2026-10-06). Nothing end to end has run -- see
*What is unverified* at the bottom. The plan's device limit, which builds
on this, is `docs/device-slots.md`.

## The problem

Signing out on one device revokes that device's refresh session
(`CustomerSession`, 2026-10-05), but the VPN credentials the device was
handed are `ProtocolUser` rows keyed by **subscription**, shared by every
device the customer has. They stay valid on the nodes after sign-out, so
a signed-out device -- or anyone who copied its config -- keeps a
working tunnel. Revoking those shared rows on sign-out would cut off the
customer's other devices, which the owner does not want.

## The model

`ProtocolUser` gains a nullable `sessionId` (FK to `customer_sessions`):

- `sessionId = NULL` -- the subscription's **shared** credential, exactly
  what every row is today. Kept, and still provisioned by `provisionAll`,
  for the transition (below).
- `sessionId = <session>` -- a **device** credential: the same thing,
  issued to one signed-in device. Same `subscriptionId`, `routeId`,
  `nodeId`, protocol config and generator; a device row is only "more
  users" to the node.

`UNIQUE (subscriptionId, routeId, sessionId)` -- at most one device
credential per device per route. NULLs are distinct in Postgres, so the
shared rows are unaffected.

The foreign key is **`ON DELETE SET NULL`**, for rollback's sake (it was
RESTRICT in the first version of this branch). This backend never
deletes a session that still holds credentials: sign-out and the sweep
take them off the nodes first, and every delete of a session row is
filtered on "holds none". So SET NULL only ever fires under an *older*
backend, which prunes signed-out sessions on every sign-in without
knowing about credentials. RESTRICT made that prune fail and sign-in
return 500, permanently, for every customer it touched; CASCADE would
drop a live credential without telling its node. SET NULL leaves the row
as an extra shared credential -- still metered, still expiring with the
subscription. See *Rollback*.

Two more nullable columns, both NULL on existing rows:

- `provisionedAt` -- when a node first acked the credential. See *How a
  device gets its credentials*.
- `heldUntil` -- the device-limit backstop's hold (`docs/device-slots.md`);
  written only with `CONCURRENCY_CUT=enforce`.

Keyed by `subscriptionId` and so covering device rows without change:
usage accounting (`UsageRecord.subscriptionId`, `dataUsedBytes`), data
caps and quota suspension, expiry, renewal re-enable, admin enable and
disable of a subscription, plan and route revocation in `provisionAll`,
route and config deletion, and account deletion.

**Not** unchanged: the plan's device limit. With a shared credential,
WireGuard and OpenVPN limited themselves -- two devices on one key or
certificate fight over it -- and the old concurrency cut summed source
addresses per credential. With a credential per device both devices on
one route simply work. The limit is now judged per device: up front by
device slots, and node-side by the backstop, which runs in shadow mode by
default (`docs/device-slots.md`). Until apps implement slots and the
backstop is switched to enforce, a customer on an old app can use two
devices at once on WireGuard or OpenVPN where they could not before.

**The agent needs nothing.** Every provisioner adds and removes arbitrary
users per protocol by `externalUserId`; a device credential is generated
by the same `generateCredentials` and sent with the same `CREATE_USER` /
`DELETE_USER` payload.

## How a device gets its credentials

Lazily, on the fetch clients already make: `GET /customer/protocol-users`
(and `POST /customer/subscriptions/:id/route`). The access token carries
`sid`.

1. No `sid` (a token from before sessions existed): the old answer, the
   shared rows. Unchanged.
2. `sid` names a session that is not this customer's, or is revoked, or
   no longer exists: **401**. Access tokens live 15 minutes and are not
   checked against the session table, so without this a signed-out
   device could mint itself fresh credentials for a quarter of an hour.
3. Otherwise, for every ACTIVE subscription of an ACTIVE account, create
   the device's credential on every route the plan can be provisioned on
   now -- the same route set `provisionAll` uses, from the same helper.
   Then answer with one credential per (subscription, route): the
   device's own **once a node has confirmed it**, otherwise the shared
   row.

The device's own credential replaces the shared one only after a node
has acked its `CREATE_USER` (or a re-assert of it) -- `provisionedAt`.
Creating the row and enqueueing the command is not the node having it: a
node whose control stream is down (three nodes have done this, for days
-- journal, 2026-08-30) leaves the command queued while still serving
the users it already has, and a connected node runs commands one at a
time behind the re-assert. Handing the device its new credential at that
point swapped a working tunnel for a dead one, and clients dial whatever
they were handed. Gated rather than offering both: clients key
credentials by route and need not try a second one, and a failed dial
costs a timeout and a wrong per-ISP data point. A device row with no
shared row beside it is handed out unconfirmed -- there is nothing that
works to keep.

So the first fetch after the deploy normally answers with the shared
rows, and a later fetch (clients refresh before connecting once their
list is ten minutes old, and on every app load) with the device's own.

Gap-filling with the shared row also covers a non-ACTIVE subscription
(no device rows are created for those, so fetching cannot undo a
suspension) and a route where creating the device credential failed. If
a rollback left more than one shared row for a route, the oldest is
used.

Guards on creating:

- **Rate.** At most 10 devices of one customer may receive their first
  set per hour. The device cap bounds how many sets exist, not how fast
  they churn; a sign-in loop made a full set (and evicted one) per new
  session -- an OpenVPN RSA keygen on the event loop, a ccd file, an IKEv2
  secrets reload and an `agent_commands` row each. Past the rate the
  device gets the shared credentials.
- **Status.** `create()` refuses a device credential for a subscription
  that is not ACTIVE, so a suspension, expiry or account deletion landing
  mid-fetch cannot be undone by it.
- **Serialisation.** One in-process lock per customer (one backend
  instance, as `LoginGuardService` already assumes): two fetches from one
  device do not race, a sign-out does not interleave with a fetch, and
  account deletion (admin and self-service) runs under the same lock, so
  a fetch cannot mint a credential between deletion's read and its
  transaction. WireGuard address allocation is serialised per protocol
  config.

`provisionAll` creates only the shared set. Its revocation half covers
every row of the subscription, so a route a plan drops is taken from
every device too; a route a plan gains reaches each device on that
device's next fetch.

Clients need **no change** for this. They already replace their whole
cached credential list on each fetch (`refreshConnectionConfig`) and
clear it on sign-out.

## Limits and scaling

Credentials on a node become subscriptions x devices x routes.

- **Device cap.** At most `CUSTOMER_DEVICE_CREDENTIAL_LIMIT` (default
  **10**, owner decision 2026-10-06; at most 50) sessions per customer
  hold device credentials. A hidden safety cap for the nodes, not a
  customer-facing rule and not the plan's device limit. Passed through in
  `infra/docker-compose.prod.yml`; empty means the default. Past it, the
  next device's first set evicts the device longest out of use: a
  signed-out session first, then by the later of its last refresh and the
  last traffic on its credentials (the sweep's liveness). The evicted
  device's plan slot is released too. Eviction happens before the new set
  is created.
- **WireGuard pool.** The installer only supports a /24: 253 peers per
  WireGuard config, shared by shared and device credentials. A device
  credential may not take the last quarter (63 addresses): those are kept
  for shared credentials, which have nothing to fall back to. A device
  refused an address gets the shared credential, like any other failure
  to create one. `provisionAll` no longer throws for one route it cannot
  provision (logged at error, reported in `failed`), so a full pool cannot
  abort a payment's other routes or its invoice. Widening the subnet is an
  installer and node change, not part of this work.
- **OpenVPN.** Revocation is a ccd `disable` file per CN, never cleaned
  up -- one small file per revoked device credential.
- **IKEv2.** Every add, remove *and re-assert* rewrites the whole secrets
  file and reloads every secret (`swanctl --load-creds --clear`), one
  command at a time on the node's command loop. So the 60 s re-assert on
  an IKEv2 node costs about rows-squared, and device credentials multiply
  it by up to (1 + devices) squared. Fixing that is an agent change (see
  *Known, deferred*).
- **Re-assert.** Every live row is re-sent to its node every 60 s. "Live"
  excludes rows of a signed-out session (on their way off the node) and
  rows the backstop holds.

## Sign-out

`POST /customer-auth/logout` marks the session revoked, then removes each
of its device credentials (`DELETE_USER` to the node -- with the address,
for WireGuard, so the node clears the peer's speed cap -- then the row),
then releases its plan slot. A failure on one credential is logged and
does not fail the sign-out; the hourly sweep retries, and the re-assert
no longer puts a signed-out device's credential back in the meantime.
Other devices' rows are untouched.

If the logout request never reaches the server (filtered network, the
client gives up after 8 s), nothing is revoked at that moment: the
device clears its own cache, and the credentials are reclaimed by the
idle rule below once nothing uses them.

Ending sessions in bulk -- password reset, password change, an admin
setting a password -- revokes those sessions **in the same transaction as
the password**, then takes their device credentials back and releases
their slots (best effort; the sweep finishes it, since the sessions are
already revoked). Which sessions hold credentials is read under the
customer lock, so a device in the middle of its first fetch is not
missed. A password change keeps the caller's session (and so its
tunnel). A reset does **not** cut off a copy of the shared credentials --
see *Transition*.

## Reclaiming dead sessions' credentials

An hourly sweep (`device-credentials`) removes the device credentials of
sessions that are:

- revoked (a sign-out whose node command failed, or a bulk end), or
- idle: not refreshed for 30 days **and** no usage reported on any of
  their credentials for 30 days,

and then deletes those session rows. Sign-in's pruning of dead sessions
skips any that still own credentials.

Usage counts as liveness on purpose. Refresh tokens live 7 days, and a
device can keep connecting on cached credentials long after its refresh
token is dead -- an always-on Android tunnel that never opens the app,
or a client whose control plane is filtered. The owner confirmed the
30-day idle reclaim (2026-10-06): a device that neither refreshes nor
carries traffic for 30 days loses its credentials and needs a sign-in.

## Transition and the shared credentials

Phase 1 (this change, confirmed by the owner 2026-10-06): shared
credentials stay valid and are still provisioned. **Sign-out and password
reset therefore do not yet cut off a copy of the shared credentials** --
anything a device held before its own were confirmed, or a client too
old or too offline to fetch. They do cut off everything issued to the
device itself.

Phase 2 (not done; an owner decision): stop provisioning shared rows and
revoke the existing ones. Preconditions:

- No tokens without `sid` remain (refresh TTL 7 days from 2026-10-05, so
  from about 2026-10-12).
- No traffic on shared rows for a period the owner chooses. Measure with
  named columns only, e.g.
  `SELECT u."reportedAt", u."bytesUp", u."bytesDown" FROM usage_records u
   JOIN protocol_users p ON p.id = u."protocolUserId"
   WHERE p."sessionId" IS NULL AND u."reportedAt" > now() - interval '7 days';`
- The trial/voucher/redeem responses, which return the shared rows they
  just created, are changed to return nothing credential-shaped (clients
  refetch the list anyway).

Revoking shared credentials disconnects any client still dialling them
with a stale cache and no route to the control plane -- the exact
customer the credential cache exists for. That is why it is a separate,
deliberate step.

## Deploy order

1. Backend. Migrations apply at container start, in order:
   `20261007_per_device_credentials` (sessionId, provisionedAt, indexes,
   FK), `20261008_concurrency_holds` (heldUntil),
   `20261008_session_labels` (customer_sessions.label, platform). All
   additive. No client release, no agent release, no node change.
2. Clients pick per-device credentials up on their next fetch. Device
   slots need app releases (`docs/device-slots.md`).

## Rollback

Rolling the code back does not roll the database back. The previous
backend works against the migrated schema (`src/migration-safety.spec.ts`
pins that pending migrations drop, rename and tighten nothing, and that
the FK is SET NULL). What a rollback leaves behind:

- **Device rows are served to every device.** The previous backend's
  `GET /customer/protocol-users` has no notion of devices and returns
  every row of the customer. Nothing breaks; credentials just stop being
  per device until the roll-forward.
- **Device rows are never revoked on sign-out** while the old code runs,
  and its sign-in pruning turns a signed-out session's rows into shared
  ones (the SET NULL). After rolling forward, find shared rows that
  duplicate an older shared row on the same route --
  `SELECT p.id, p."subscriptionId", p."routeId", p."createdAt" FROM
  protocol_users p WHERE p."sessionId" IS NULL AND EXISTS (SELECT 1 FROM
  protocol_users q WHERE q."sessionId" IS NULL AND q."subscriptionId" =
  p."subscriptionId" AND q."routeId" = p."routeId" AND q."createdAt" <
  p."createdAt");` -- and remove each through the admin API
  (`DELETE /protocol-users/:id`, which tells the node). Devices are
  handed the oldest shared row in the meantime, so this is cleanup, not
  an outage.
- **Holds are not honoured** (the old re-assert ignores `heldUntil`).
  Only matters with `CONCURRENCY_CUT=enforce`.
- **Unknown sweep job.** The old processor logs "unknown sweep job name"
  for the repeatable `device-credentials` job once an hour. Harmless;
  remove the job from Redis if it is noisy.

## Found on the way, now fixed

All on this branch, each with tests:

- Deletion, quota/expiry suspension and the concurrency cut sent user
  commands without `transport` or `inboundTag`, so on a multi-inbound
  node (VLESS over TCP and WS, relay entries) they could miss the real
  inbound and be acked while the credential kept working. One helper now
  targets every path (`command-target.ts`), including the relay uplink's
  delete.
- A plan speed-cap edit sent `UPDATE_USER` with no credentials: the
  agent never applies caps on it, and Xray's remove-then-create dropped
  every Xray customer on the plan until the next re-assert. It now sends
  `CREATE_USER` with credentials to live WireGuard/OpenVPN rows only.
- The concurrency cooldown replayed a captured list, re-creating
  credentials revoked in the meantime (sign-out, eviction, password
  change, suspension) with no row behind them. Replaced: see
  `docs/device-slots.md`, *The backstop*.
- Every Xray user's session count was reported once per inbound and
  summed. The backend now ignores Xray's session counts altogether
  (their 60 s tail held the phone after a clean switch) and goes by
  bytes; it takes the max per credential for the engines it still
  counts.
- Plaintext credentials were kept in `agent_commands` forever. They are
  removed from a command's payload once it is acked or failed.

## Known, deferred

Low-severity review findings not fixed here, and why:

- **DISABLED accounts keep their credentials.** An admin setting a
  customer to DISABLED touches no credentials, and `refresh` does not
  check status. Fixing it means deciding what disabling does to a live
  tunnel and what re-enabling restores (re-enabling every DISABLED row
  would also undo per-row admin disables). An owner decision, not a
  quiet change. Device provisioning already refuses DISABLED accounts.
- **OpenVPN revocation lives only in a ccd file.** A node whose ccd
  directory is lost (rebuild, restore) accepts every revoked certificate
  again, with no row behind it. The fix is a revocation table re-asserted
  on reconnect, or `ccd-exclusive` on the nodes (a node change needing
  the owner's approval). Per-device credentials make revocation routine,
  so this matters more than it did; it is not new.
- **IKEv2 re-assert cost is quadratic.** An agent change (skip the reload
  for an unchanged user within 30 s of the last one) and an agent
  release. Documented under *Limits*.
- **Xray counted once per inbound in the agent.** The backend takes the
  max, which is enough; counting once per Xray process is an agent
  release.
- **WireGuard and OpenVPN no longer self-limit across devices** for apps
  that do not claim slots, while the backstop is in shadow mode. Not
  "fixed" by keeping shared credentials on those routes for finite-limit
  plans: that would give up sign-out revocation on WireGuard and OpenVPN
  for every plan but Ultimate. The coordinator accepted the shadow period
  (2026-10-06); device slots carry the rule for new apps.
- **Old `agent_commands` rows still hold plaintext credentials.** New
  ones are stripped on ack. The old ones need a one-off
  `UPDATE agent_commands SET "payloadJson" = "payloadJson" - 'credentials'
  WHERE status IN ('ACKED','FAILED') AND "payloadJson" ? 'credentials';`
  run by the owner at a quiet moment -- not a start-up migration, because
  it rewrites a large table while the backend waits to start.
- **`packages/proto/agent.proto` still calls WireGuard and OpenVPN
  self-limiting.** Its generated `agent.pb.go` cannot be regenerated on
  this machine (no protoc), and the two should not drift. Comment only.
- **Clearing a plan's speed cap cannot be expressed**, and an OpenVPN
  client already connected keeps its old cap until it reconnects. Both
  are agent behaviour, older than this branch.
- **`switchRoute` and payments call `provisionAll` outside the customer
  lock.** Shared-credential creation racing account deletion is older
  than this branch and far rarer than lazy device provisioning was.

## What is unverified

Everything end to end. No node has received a device credential, no
client has connected with one, no sign-out has been seen to remove one
from a node, and no ack has been seen to set `provisionedAt`. The
evidence is the backend unit tests, typecheck and lint, a local boot of
the built backend (the module graph resolves), and CI's new migration
step: every migration applied in order to an **empty** Postgres 16, the
result matched `schema.prisma` exactly (FK delete rule included), and
the previous backend's sign-in pruning ran against it with a signed-out
session owning a credential -- the prune succeeded and the credential
was kept as a shared one (`test/sql/rollback-check.sql`). The migrations
have not been applied to a database holding real data. Also unproven: that Windows' built-in
IKEv2 and iOS's NEVPNManager profile pick up new credentials on the next
connect rather than reusing stored ones.
