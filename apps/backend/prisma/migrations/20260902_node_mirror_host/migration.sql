-- Hostname a node's API mirror is reachable on.
--
-- Nullable with no default and no backfill: a node without one simply
-- contributes no mirror entry to the endpoint bundle, which is the
-- correct behaviour for a node whose certificate covers no name we would
-- want a client to dial.
ALTER TABLE "nodes" ADD COLUMN "mirrorHost" TEXT;
