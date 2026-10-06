-- Per-device VPN credentials (docs/per-device-credentials.md).
--
-- A ProtocolUser may now belong to one signed-in device (a
-- customer_sessions row) instead of to the whole subscription, so that
-- signing out on one device can revoke that device's credentials on the
-- nodes without touching the customer's other devices.
--
-- Additive and safe on a live database: one nullable column, two indexes
-- and a foreign key. Every existing row keeps sessionId NULL, which is
-- what "the subscription's shared credential" means -- exactly what each
-- row is today. Nothing is backfilled; a device is given credentials of
-- its own the next time it fetches them.
--
-- The unique index cannot fail on existing data: every existing row has
-- a NULL sessionId, and NULLs are distinct in Postgres.

ALTER TABLE "protocol_users" ADD COLUMN "sessionId" TEXT;

CREATE INDEX "protocol_users_sessionId_idx" ON "protocol_users"("sessionId");

CREATE UNIQUE INDEX "protocol_users_subscriptionId_routeId_sessionId_key" ON "protocol_users"("subscriptionId", "routeId", "sessionId");

-- RESTRICT: a session must give its credentials back (DELETE_USER to the
-- node) before its row can go. A cascade would drop credentials without
-- telling the node; SET NULL would turn a device credential into a
-- shared one.
ALTER TABLE "protocol_users" ADD CONSTRAINT "protocol_users_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "customer_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
