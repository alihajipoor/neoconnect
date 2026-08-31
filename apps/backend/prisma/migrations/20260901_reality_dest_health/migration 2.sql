-- REALITY camouflage-destination health, reported by the agent on its
-- heartbeat.
--
-- All three are nullable and default to NULL on purpose: every existing
-- row, and every node running an agent older than v0.2.8, has simply not
-- said. "Not measured" and "unreachable" must stay distinguishable --
-- collapsing them would make the alert fire for the whole fleet the
-- moment this ships, before a single node has reported anything.
--
-- Additive only: no index, no default, no backfill. Adding a nullable
-- column with no default is metadata-only in Postgres, so this does not
-- rewrite the table and does not need the CONCURRENTLY treatment the
-- list-ordering indexes did.
ALTER TABLE "nodes" ADD COLUMN "realityDest" TEXT;
ALTER TABLE "nodes" ADD COLUMN "realityDestReachable" BOOLEAN;
ALTER TABLE "nodes" ADD COLUMN "realityDestCheckedAt" TIMESTAMP(3);
