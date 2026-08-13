-- Plisio as a second crypto provider, alongside NowPayments.
--
-- Added rather than swapped: NowPayments enforces a per-currency minimum
-- that sits above the cheapest plan, so a $3.99 subscription could not be
-- paid in crypto at all -- which, for the audience that can only pay in
-- crypto, means it could not be bought. Both providers run until a real
-- Plisio payment is proven end to end, and existing PaymentTransaction
-- rows still reference NOWPAYMENTS regardless.

-- Appended, never inserted among the existing values: Postgres orders an
-- enum by value creation and existing rows sort by that order, so
-- inserting in the middle would reorder every query sorting on it.
--
-- Only ADDs the value; nothing here writes it. Postgres forbids using a
-- new enum value in the transaction that created it, and Prisma wraps a
-- migration in one.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PLISIO';

-- Deliberately no IPN-secret column to match NowPayments'. Plisio signs
-- its callbacks with the API key itself, so a second secret would be a
-- field that must always be left blank -- and a blank required-looking
-- field is how someone concludes the integration is half-configured.
ALTER TABLE "payment_settings" ADD COLUMN IF NOT EXISTS "plisioEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payment_settings" ADD COLUMN IF NOT EXISTS "plisioApiKeyEncrypted" TEXT;
