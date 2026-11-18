-- Client diagnostics (docs/client-diagnostics.md): richer reports from the
-- apps, a fixed-list service check, and a bundle a customer chooses to
-- send. Additive.
--
-- * A new ClientAttemptKind, SERVICE_CHECK. Added on its own statement and
--   used by nothing in this migration: Postgres forbids using a new enum
--   value in the transaction that created it, and Prisma wraps a
--   migration in one. Appended, so nothing already stored is reordered.
-- * Two nullable columns on client_attempts: the device session the
--   report's token named, and the validated details object. The previous
--   backend neither reads nor writes them.
-- * One new table, customer_diagnostics, which the previous backend never
--   touches; it cascades with the customer like customer_sessions.
--
-- Safe to apply while the API is serving, and safe for the previous
-- backend to run against.

ALTER TYPE "ClientAttemptKind" ADD VALUE IF NOT EXISTS 'SERVICE_CHECK';

ALTER TABLE "client_attempts" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "client_attempts" ADD COLUMN "detailsJson" JSONB;

CREATE TABLE "customer_diagnostics" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "note" TEXT,
    "bundleJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_diagnostics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_diagnostics_customerId_createdAt_idx" ON "customer_diagnostics"("customerId", "createdAt");
CREATE INDEX "customer_diagnostics_createdAt_idx" ON "customer_diagnostics"("createdAt");

ALTER TABLE "customer_diagnostics" ADD CONSTRAINT "customer_diagnostics_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
