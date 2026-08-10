-- Transport belongs in the ProtocolConfig identity.
--
-- The old rule said a node may offer a protocol on a port exactly once.
-- That contradicts the reason the transport column was added: VLESS over
-- TLS and the same VLESS inside a WebSocket share one port and one
-- certificate on purpose, routed apart by request path, because a second
-- public port is a second thing for a censor to fingerprint.
--
-- The rule predates the column and was never revisited, so registering
-- the WebSocket config on a live node failed outright. It would have
-- failed identically on a fresh install through the installer.
--
-- DROP INDEX, not DROP CONSTRAINT. Prisma's @@unique is a plain unique
-- index here rather than a table constraint, and the first version of
-- this migration assumed otherwise -- it failed mid-deploy, which under
-- `migrate deploy` blocks every later migration until the failure is
-- resolved and took the API down with it. IF EXISTS so re-running is
-- safe on a database that already got past this point.

DROP INDEX IF EXISTS "protocol_configs_nodeId_protocol_listenPort_key";

CREATE UNIQUE INDEX IF NOT EXISTS "protocol_configs_nodeId_protocol_listenPort_transport_key"
  ON "protocol_configs" ("nodeId", "protocol", "listenPort", "transport");
