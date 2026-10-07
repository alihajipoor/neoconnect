-- The entry half of a relay route's health. uplinkAssertedAt records the
-- EXIT node confirming the route's uplink credential; nothing recorded
-- the ENTRY node confirming its outbound, routing rule and (for a
-- WireGuard, OpenVPN or IKEv2 entry) policy route. A rejected
-- CONFIGURE_ROUTE was logged and the route kept reporting ONLINE.
--
-- Additive and safe on a live database: two nullable columns, NULL on
-- every existing row until the entry node next acks a CONFIGURE_ROUTE
-- (on its reconnect, or the 60 s sweep). The previous backend neither
-- reads nor writes them.
ALTER TABLE "routes" ADD COLUMN "entryAssertedAt" TIMESTAMP(3);
ALTER TABLE "routes" ADD COLUMN "entryLastError" TEXT;
