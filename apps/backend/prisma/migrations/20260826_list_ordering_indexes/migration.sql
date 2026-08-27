-- Indexes for the columns the paged list routes order by.
--
-- The pagination pass of 2026-08-26 windowed eight list routes and was
-- explicit that it had not finished the job: "a `take` bounds the
-- response, not the scan". Every one of those routes orders by a column,
-- and Postgres has to produce that order before it can hand back the
-- first `take` rows -- so `?take=100` was still sorting the whole table,
-- and the `count()` beside it was a second pass over the same rows. The
-- 18.7x that pass measured was bytes on the wire, not database work.
--
-- Two of the eight already matched an index (`support_tickets` on
-- [status, lastMessageAt], `game_profiles` on [isActive, sortOrder]).
-- These are the other six.
--
-- Two of the statements below are composites that REPLACE a bare
-- single-column index rather than joining it. That is safe and is not a
-- loss: an equality predicate on the leading column of a btree leaves
-- the remaining columns free to supply the ordering, so
-- (status, issuedAt) answers everything (status) answered and orders as
-- well. Keeping both would only add write amplification.
--
-- On the DESC: for these queries it is documentation rather than a
-- speed-up. Postgres scans a btree backwards just as cheaply, and every
-- column here is NOT NULL so the NULLS FIRST/LAST difference cannot
-- bite. It is written the way the query sorts so the two cannot drift.
--
-- ---------------------------------------------------------------------
-- APPLYING THIS TO THE LIVE DATABASE -- READ BEFORE `migrate deploy`
-- ---------------------------------------------------------------------
-- A plain CREATE INDEX takes an ACCESS EXCLUSIVE lock and blocks reads
-- AND writes on the table for the whole build. On `customers`,
-- `subscriptions` and `protocol_users` that is the customer-facing API
-- stalling, and `protocol_users` is the largest of the three.
--
-- CREATE INDEX CONCURRENTLY does not take that lock, but it cannot run
-- inside a transaction block -- and a multi-statement script sent over
-- Postgres' simple query protocol, which is how a migration file is
-- applied, IS an implicit transaction. So CONCURRENTLY cannot live in
-- this file.
--
-- It does not need to. Every statement here is `IF NOT EXISTS` /
-- `IF EXISTS`, so the intended production sequence is:
--
--   1. Run `concurrent.sql` (next to this file) by hand against
--      production, one statement at a time, with psql. No table is
--      locked against reads or writes at any point.
--   2. Then run `prisma migrate deploy` as normal. Every statement
--      below finds its work already done, does nothing, and the
--      migration is recorded as applied. No lock is ever taken.
--
-- On a fresh install step 1 never happens, the tables are empty, and
-- these build instantly -- so the installer path stays correct without
-- anyone having to know about any of this.
--
-- Creates come before drops deliberately: there is no moment at which
-- the query the dropped index served has nothing to use.

-- CreateIndex
-- `GET /customers` -- `orderBy: { createdAt: "desc" }`, no filter.
CREATE INDEX IF NOT EXISTS "customers_createdAt_idx" ON "customers"("createdAt" DESC);

-- CreateIndex
-- `GET /subscriptions` -- `orderBy: { createdAt: "desc" }`, no filter.
CREATE INDEX IF NOT EXISTS "subscriptions_createdAt_idx" ON "subscriptions"("createdAt" DESC);

-- CreateIndex
-- `GET /protocol-users` -- `orderBy: { createdAt: "desc" }`. Its `nodeId`
-- filter is optional and nothing in the repo passes it, so the bare
-- column is the right index; the existing UNIQUE(nodeId, protocol,
-- externalUserId) cannot supply this order because `protocol` sits
-- between the two columns that matter.
CREATE INDEX IF NOT EXISTS "protocol_users_createdAt_idx" ON "protocol_users"("createdAt" DESC);

-- CreateIndex
-- `GET /invoices` -- `orderBy: { issuedAt: "desc" }`, unfiltered form.
CREATE INDEX IF NOT EXISTS "invoices_issuedAt_idx" ON "invoices"("issuedAt" DESC);

-- CreateIndex
-- `GET /invoices?status=...` -- the panel's status tabs. Supersedes the
-- bare (status) index dropped below.
CREATE INDEX IF NOT EXISTS "invoices_status_issuedAt_idx" ON "invoices"("status", "issuedAt" DESC);

-- CreateIndex
-- `GET /billing/payments` -- `orderBy: { createdAt: "desc" }`, no filter.
CREATE INDEX IF NOT EXISTS "payment_transactions_createdAt_idx" ON "payment_transactions"("createdAt" DESC);

-- CreateIndex
-- `GET /vouchers` (admin) -- `orderBy: { createdAt: "desc" }`, no filter.
CREATE INDEX IF NOT EXISTS "vouchers_createdAt_idx" ON "vouchers"("createdAt" DESC);

-- CreateIndex
-- `GET /resellers/me/vouchers` -- always filters on `issuedByAdminId` and
-- orders by `createdAt desc`. Supersedes the bare (issuedByAdminId)
-- index dropped below.
CREATE INDEX IF NOT EXISTS "vouchers_issuedByAdminId_createdAt_idx" ON "vouchers"("issuedByAdminId", "createdAt" DESC);

-- DropIndex
-- Both are strict prefixes of a composite created above.
DROP INDEX IF EXISTS "invoices_status_idx";

-- DropIndex
DROP INDEX IF EXISTS "vouchers_issuedByAdminId_idx";
