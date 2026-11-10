-- The lock-free way to apply 20261110_usage_records_protocol_user_index to
-- a database with live customers on it. Prisma never runs this file; see
-- 20260826_list_ordering_indexes/concurrent.sql for why, and for the
-- INVALID-index trap if the build fails.
--
-- Run the statement on its own (psql -c, or psql -f; never inside
-- BEGIN/COMMIT), then `npx prisma migrate deploy`, which finds the index
-- present and records the migration as applied.
--
-- Production: applied 2026-11-10, built in 9 s, indisvalid = true.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_records_protocolUserId_idx" ON "usage_records"("protocolUserId");
