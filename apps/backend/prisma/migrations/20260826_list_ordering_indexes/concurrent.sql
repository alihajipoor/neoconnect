-- The lock-free way to apply 20260826_list_ordering_indexes to a
-- database that has live customers on it.
--
-- Prisma never runs this file. It is deliberately not named
-- `migration.sql`, because Prisma applies a migration script over
-- Postgres' simple query protocol, which executes a multi-statement
-- string as one implicit transaction -- and CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. So this is a hand-run script
-- and `migration.sql` is the transactional equivalent for fresh
-- installs.
--
-- HOW TO RUN IT -- one statement at a time, not as a file:
--
--   Each statement must arrive on its own. `psql -f` is fine (psql sends
--   statements individually, so there is no implicit transaction), but
--   do NOT wrap it in BEGIN/COMMIT and do NOT paste the whole file into
--   a client that batches. If in doubt, run them one by one:
--
--     psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ...'
--
-- Then, and only then:
--
--     npx prisma migrate deploy
--
--   which will find every index already present, do nothing, and record
--   the migration as applied.
--
-- IF ONE OF THESE FAILS -- this is the trap, read it:
--
--   A failed CONCURRENTLY build leaves an INVALID index behind. It is
--   not used by the planner, but it IS maintained on every write, and
--   `IF NOT EXISTS` will happily skip past it forever. Check for them
--   before re-running:
--
--     SELECT i.relname
--       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
--      WHERE NOT x.indisvalid;
--
--   and drop any that turn up with DROP INDEX CONCURRENTLY IF EXISTS
--   before trying again.
--
-- CONCURRENTLY takes longer and needs two table scans, and it will wait
-- out any long-running transaction that is already open. It does not
-- block reads or writes while it waits. Run it when nothing is holding a
-- long transaction, and expect it to be slow rather than to fail.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_createdAt_idx" ON "customers"("createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_createdAt_idx" ON "subscriptions"("createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "protocol_users_createdAt_idx" ON "protocol_users"("createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoices_issuedAt_idx" ON "invoices"("issuedAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoices_status_issuedAt_idx" ON "invoices"("status", "issuedAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_transactions_createdAt_idx" ON "payment_transactions"("createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vouchers_createdAt_idx" ON "vouchers"("createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vouchers_issuedByAdminId_createdAt_idx" ON "vouchers"("issuedByAdminId", "createdAt" DESC);

-- Only after the two composites above exist and are valid. Dropping
-- concurrently as well, because a plain DROP INDEX takes an ACCESS
-- EXCLUSIVE lock on the table -- brief, but on the customer-facing path.
DROP INDEX CONCURRENTLY IF EXISTS "invoices_status_idx";

DROP INDEX CONCURRENTLY IF EXISTS "vouchers_issuedByAdminId_idx";
