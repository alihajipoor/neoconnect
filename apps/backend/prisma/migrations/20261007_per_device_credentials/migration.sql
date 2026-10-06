-- Per-device VPN credentials (docs/per-device-credentials.md).
--
-- A ProtocolUser may now belong to one signed-in device (a
-- customer_sessions row) instead of to the whole subscription, so that
-- signing out on one device can revoke that device's credentials on the
-- nodes without touching the customer's other devices.
--
-- Additive and safe on a live database: one nullable column, two
-- indexes and a foreign key. Every existing row keeps sessionId NULL,
-- which is what "the subscription's shared credential" means -- exactly
-- what each row is today. Nothing is backfilled; a device is given
-- credentials of its own the next time it fetches them.
--
-- The unique index cannot fail on existing data: every existing row has
-- a NULL sessionId, and NULLs are distinct in Postgres.

ALTER TABLE "protocol_users" ADD COLUMN "sessionId" TEXT;

CREATE INDEX "protocol_users_sessionId_idx" ON "protocol_users"("sessionId");

CREATE UNIQUE INDEX "protocol_users_subscriptionId_routeId_sessionId_key" ON "protocol_users"("subscriptionId", "routeId", "sessionId");

-- SET NULL, not RESTRICT, and the reason is rollback.
--
-- The backend this replaces prunes signed-out and idle sessions on every
-- sign-in (customerSession.deleteMany in openSession) with no notion of
-- device credentials. Under RESTRICT, a rollback to it after a device had
-- fetched its own credentials made that prune fail the whole statement,
-- and sign-in returned 500 for that customer on every attempt -- with
-- nothing in the old code ever able to clear it.
--
-- This backend never deletes a session that still holds credentials: it
-- takes them off the nodes first (sign-out, the sweep), and every delete
-- of a session row is filtered on "holds no credentials". So SET NULL
-- can only fire under an older backend, and what it does there is the
-- least harmful thing available: the row stays, still metered, still
-- expiring with its subscription, as an extra shared credential. A
-- cascade would instead drop the row without telling the node -- a live
-- credential nothing could ever find again. See "Rollback" in
-- docs/per-device-credentials.md for cleaning those rows up afterwards.
ALTER TABLE "protocol_users" ADD CONSTRAINT "protocol_users_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "customer_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
