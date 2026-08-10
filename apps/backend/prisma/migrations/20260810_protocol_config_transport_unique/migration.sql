-- Transport belongs in the ProtocolConfig identity.
--
-- The old constraint said a node may offer a protocol on a port exactly
-- once. That contradicts the reason the transport column was added:
-- VLESS over TLS and the same VLESS inside a WebSocket share one port
-- and one certificate on purpose, routed apart by request path, because
-- a second public port is a second thing for a censor to fingerprint.
--
-- The constraint predates the column and was never revisited, so
-- registering the WebSocket config on a live node failed outright. It
-- would have failed identically on a fresh install through the
-- installer.

ALTER TABLE "protocol_configs"
  DROP CONSTRAINT "protocol_configs_nodeId_protocol_listenPort_key";

ALTER TABLE "protocol_configs"
  ADD CONSTRAINT "protocol_configs_nodeId_protocol_listenPort_transport_key"
  UNIQUE ("nodeId", "protocol", "listenPort", "transport");
