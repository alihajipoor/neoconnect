-- Selling a plan through StoreKit on iPhone.
--
-- Apple rejected 1.0 under guideline 3.1.1, and the resolution is that
-- an iPhone customer buys through In-App Purchase rather than on the
-- web. Everyone else -- web, Windows, Android -- is unchanged, and
-- Apple takes no commission on them because those transactions never
-- touch the App Store.
--
-- Both changes are additive and safe to apply while the API is running.
-- The new enum value is appended rather than inserted: Postgres orders
-- enum values by creation and existing rows sort by that order.

ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'APPLE_IAP';

-- Nullable, so every existing plan keeps working untouched and is
-- simply absent from the iOS purchase list until an operator maps it.
-- Unique because a StoreKit transaction names a product and the server
-- has to turn that back into exactly one plan before granting anything.
ALTER TABLE "subscription_plans" ADD COLUMN "appleProductId" TEXT;

CREATE UNIQUE INDEX "subscription_plans_appleProductId_key"
  ON "subscription_plans" ("appleProductId");
