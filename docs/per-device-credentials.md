# Per-device VPN credentials

Status: implemented on `claude/per-device-credentials`, backend only.
Nothing end to end has run -- see *What is unverified* at the bottom.

## The problem

Signing out on one device revokes that device's refresh session
(`CustomerSession`, 2026-10-05), but the VPN credentials the device was
handed are `ProtocolUser` rows keyed by **subscription**, shared by every
device the customer has. They stay valid on the nodes after sign-out, so
a signed-out device -- or anyone who copied its config -- keeps a
working tunnel. Revoking those shared rows on sign-out would cut off the
customer's other devices, which the owner does not want.

## The model

`ProtocolUser` gains one nullable column, `sessionId` (FK to
`customer_sessions`):

- `sessionId = NULL` -- the subscription's **shared** credential, exactly
  what every row is today. Kept, and still provisioned by `provisionAll`,
  for the transition (below).
- `sessionId = <session>` -- a **device** credential: the same thing,
  issued to one signed-in device. Same `subscriptionId`, `routeId`,
  `nodeId`, protocol config and generator; a device row is only "more
  users" to the node.

`UNIQUE (subscriptionId, routeId, sessionId)` -- at most one device
credential per device per route. NULLs are distinct in Postgres, so the
shared rows are unaffected. `ON DELETE RESTRICT` on the FK: a session row
cannot disappear while it still owns credentials, because a cascade would
drop the row without telling the node and SetNull would silently turn a
device credential into a shared one. Both are worse than a refused delete.

Everything keyed by `subscriptionId` already covers device rows without
change: usage accounting (`UsageRecord.subscriptionId`, `dataUsedBytes`,
"DATA USED"), data caps and quota suspension, expiry, renewal re-enable,
admin enable/disable of a subscription, the concurrency limit (summed per
subscription, across nodes), plan/route revocation in `provisionAll`,
route and config deletion, account deletion, and the 60 s re-assert.

**The agent needs nothing.** Every provisioner adds and removes arbitrary
users per protocol by `externalUserId`; a device credential is generated
by the same `generateCredentials` and sent with the same `CREATE_USER` /
`DELETE_USER` payload (including `transport` and `inboundTag`).

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
3. Otherwise, for every ACTIVE subscription, create the device's
   credential on every route the plan can be provisioned on now -- the
   same route set `provisionAll` gives the shared credential, from the
   same helper. Then answer with the device's rows,
   **filling any gap with the shared row for that (subscription, route)**
   -- a non-ACTIVE subscription (no device rows are created for those,
   so a suspension cannot be undone by fetching), or a route where
   creating the device credential failed.

The gap-filling is what keeps the change safe to ship: if anything about
device provisioning fails -- a WireGuard pool full, a config missing its
params -- the device gets what it would have got yesterday, and a warning
is logged.

`provisionAll` still creates only the shared set. Its revocation half
covers every row of the subscription, so a route a plan drops is taken
from every device too; a route a plan gains reaches each device on that
device's next fetch.

Clients need **no change**. They already replace their whole cached
credential list on each fetch (`refreshConnectionConfig`, at most every
10 minutes before connecting, and on every app load), and they clear it
on sign-out. The first fetch after the deploy moves each device onto its
own credentials.

Serialised per customer (one in-process lock -- there is one backend
instance, as `LoginGuardService` already assumes), so two simultaneous
fetches from one device do not race; the unique index is the backstop.
WireGuard address allocation is serialised per protocol config, since
lazy provisioning makes concurrent allocation an everyday event rather
than a rare one, and two peers on one address break the older one.

## Limits and scaling

Credentials on a node become subscriptions x devices x routes.

- **Device cap.** At most `CUSTOMER_DEVICE_CREDENTIAL_LIMIT` (default
  **5**) sessions per customer hold device credentials. A sixth device
  evicts the credentials of the least recently refreshed one; that
  device gets a fresh set on its next fetch. Without a cap, a scripted
  sign-in loop could exhaust a node's WireGuard pool.
- **WireGuard pool.** The installer only supports a /24: 253 peers per
  WireGuard config. Today one per subscription; now up to 5 per customer
  plus the shared one. When the pool is full, creation fails and that
  device falls back to the shared credential (logged). This is the first
  limit that will bite; widening the subnet is an installer and node
  change, not part of this work.
- **OpenVPN.** Revocation is a ccd `disable` file per CN, never cleaned
  up -- one small file per revoked device credential. The address pool is
  per connection, not per user.
- **IKEv2.** Each add/remove rewrites the secrets file and reloads; cost
  grows linearly with users. The pool is per connection.
- **Re-assert.** Every ACTIVE row is re-sent to its node every 60 s; the
  sweep grows by the same multiple.

## Sign-out

`POST /customer-auth/logout` marks the session revoked, then removes each
of its device credentials (`DELETE_USER` to the node, row deleted). A
failure on one is logged and does not fail the sign-out; the hourly
sweep retries. Other devices' rows are untouched.

If the logout request never reaches the server (filtered network, the
client gives up after 8 s), nothing is revoked at that moment: the
device clears its own cache, and the credentials are reclaimed by the
idle rule below once nothing uses them.

Ending sessions in bulk -- password reset, password change, an admin
setting a password -- now also revokes those sessions and their device
credentials. A password change keeps the caller's own session (and so
its tunnel) and ends the others; before, it opened a new session for the
caller, which would have orphaned the caller's device credentials.

## Reclaiming dead sessions' credentials

An hourly sweep (`device-credentials`) removes the device credentials of
sessions that are:

- revoked (a sign-out whose node command failed, or a bulk end), or
- idle: not refreshed for 30 days **and** no usage reported on any of
  their credentials for 30 days,

and then deletes those session rows. Sign-in's existing pruning of dead
sessions now skips any that still own credentials.

Usage counts as liveness on purpose. Refresh tokens live 7 days, and a
device can keep connecting on cached credentials long after its refresh
token is dead -- an always-on Android tunnel that never opens the app,
or a client whose control plane is filtered. Pruning on refresh alone
would cut those devices off a month in. **This is a trade-off for the
owner to confirm:** a device that neither refreshes nor carries traffic
for 30 days loses its credentials and needs a sign-in.

## Transition and the shared credentials

Migration `20261007_per_device_credentials` is additive: one nullable
column, an index, a unique index and an FK. Every existing row becomes a
shared credential (`sessionId` NULL) with no data written. No backfill
creates anything: devices move onto their own credentials as they fetch.

Phase 1 (this change): shared credentials stay valid and are still
provisioned. **Sign-out therefore does not yet cut off a copy of the
shared credentials** -- anything a device held before its first fetch
after the deploy, or a client too old or too offline to fetch. It does
cut off everything issued to the device after that.

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

1. Backend (migration applies at container start). No client release,
   no agent release, no node change.
2. Clients pick it up on their next fetch.

Rollback: the previous backend ignores the column and keeps serving the
shared rows; device rows already provisioned stay valid on the nodes and
in the re-assert sweep (it reads every ACTIVE row) -- harmless, but they
would no longer be revoked on sign-out until this is redeployed.

## Found on the way, not changed here

- Account deletion (`CustomersService.remove` and `deleteOwnAccount`),
  quota/expiry suspension (`UsageService.disableProtocolUsers`) and the
  concurrency disconnect (`ConcurrencyService`) send `DELETE_USER` /
  `DISABLE_USER` / `ENABLE_USER` without `transport` or `inboundTag`.
  `ProtocolUsersService.remove`/`setEnabled` send both. On a node that
  serves one protocol on more than one inbound (relay entries, VLESS
  over TCP and WS) the agent applies an untagged command to the default
  inbound, so those paths can miss the customer's real one. True of
  shared and device credentials alike.
- An admin setting a customer's status to DISABLED does not touch their
  credentials at all (nor does refresh check it). Device provisioning
  does refuse to create new credentials for a DISABLED account, but
  existing ones -- shared and device -- keep working.

## What is unverified

Everything end to end. No node has received a device credential, no
client has connected with one, no sign-out has been seen to remove one
from a node, and the migration has not been applied to a database. The
backend unit tests and typecheck are the only evidence.
