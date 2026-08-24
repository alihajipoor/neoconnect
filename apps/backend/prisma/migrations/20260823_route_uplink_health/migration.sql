-- A relay route had no health signal of its own. Both the panel and the
-- client read the ENTRY node's heartbeat, which says nothing about
-- whether the EXIT still holds the route's uplink credential.
--
-- On 2026-08-23 all thirteen relay routes were dead -- an Xray restart on
-- france-1 (2026-08-19) and finland1 (2026-08-20) wiped the hot-added
-- uplink users and nothing re-created them -- and every one of those
-- routes still reported ONLINE.
--
-- Nullable with no default: NULL means "never confirmed", which is
-- exactly the state every existing row is in until the re-assert sweep
-- runs, and is treated as unhealthy rather than as missing data.
ALTER TABLE "routes" ADD COLUMN "uplinkAssertedAt" TIMESTAMP(3);
ALTER TABLE "routes" ADD COLUMN "uplinkLastError" TEXT;
