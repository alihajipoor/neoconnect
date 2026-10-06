-- Run by CI against a freshly migrated, empty database (see ci.yml,
-- "Migrations apply ..."). Never against a real one: it writes rows.
--
-- What it proves: with the per-device migrations applied, the statement
-- the PREVIOUS backend runs on every sign-in -- pruning the customer's
-- signed-out and idle sessions, with no idea a session can own VPN
-- credentials -- still succeeds, and the credential survives as a
-- shared one (sessionId NULL) rather than being deleted. With the
-- foreign key's first version (ON DELETE RESTRICT) this statement
-- failed, and that backend's sign-in returned 500 for every customer it
-- touched. See docs/per-device-credentials.md, "Rollback".

INSERT INTO "nodes" ("id", "name", "region", "publicIp", "updatedAt")
  VALUES ('ci-node', 'ci-node', 'ci', 'ci-placeholder', now());
INSERT INTO "protocol_configs" ("id", "nodeId", "protocol", "listenPort", "publicParamsJson", "updatedAt")
  VALUES ('ci-config', 'ci-node', 'XRAY_VLESS_REALITY', 443, '{}', now());
INSERT INTO "routes" ("id", "name", "entryProtocolConfigId", "updatedAt")
  VALUES ('ci-route', 'ci-route', 'ci-config', now());
INSERT INTO "subscription_plans" ("id", "name", "durationDays", "priceUsd", "updatedAt")
  VALUES ('ci-plan', 'ci-plan', 30, 1, now());
INSERT INTO "customers" ("id", "email", "updatedAt")
  VALUES ('ci-customer', 'ci@example.invalid', now());
INSERT INTO "subscriptions" ("id", "customerId", "planId", "expireAt", "updatedAt")
  VALUES ('ci-subscription', 'ci-customer', 'ci-plan', now() + interval '30 days', now());

-- A device that signed out under the new backend, whose credential the
-- new backend had not yet taken off the node when the code was rolled
-- back.
INSERT INTO "customer_sessions" ("id", "customerId", "revokedAt")
  VALUES ('ci-session', 'ci-customer', now());
INSERT INTO "protocol_users"
  ("id", "subscriptionId", "routeId", "nodeId", "protocolConfigId", "protocol", "externalUserId", "credentialsJson", "updatedAt", "sessionId")
  VALUES ('ci-credential', 'ci-subscription', 'ci-route', 'ci-node', 'ci-config', 'XRAY_VLESS_REALITY', 'ci-external', 'ci', now(), 'ci-session');

-- The previous backend's sign-in pruning (CustomerAuthService.openSession
-- before per-device credentials), as Prisma issues it.
DELETE FROM "customer_sessions"
  WHERE "customerId" = 'ci-customer'
    AND ("revokedAt" IS NOT NULL OR "lastUsedAt" < now() - interval '30 days');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "protocol_users" WHERE "id" = 'ci-credential' AND "sessionId" IS NULL) THEN
    RAISE EXCEPTION 'rollback check: the credential was not kept as a shared one';
  END IF;
  IF EXISTS (SELECT 1 FROM "customer_sessions" WHERE "id" = 'ci-session') THEN
    RAISE EXCEPTION 'rollback check: the signed-out session was not pruned';
  END IF;
END $$;
