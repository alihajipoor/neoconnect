-- One row per signed-in device, so signing out ends that device's
-- session and no other.
--
-- Signing out used to bump customers.tokenVersion, which revokes every
-- refresh token the customer holds: a sign-out on a phone signed the
-- desktop out too. Refresh tokens now carry this row's id and need it
-- unrevoked; tokenVersion still ends every session at once where that
-- is intended (password change, account deletion).
--
-- Entirely additive and safe to apply while the API is serving. Tokens
-- issued before it carry no session id and keep working until they
-- expire; their next refresh moves them onto a row of their own.

CREATE TABLE "customer_sessions" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_sessions_customerId_idx" ON "customer_sessions"("customerId");

ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
