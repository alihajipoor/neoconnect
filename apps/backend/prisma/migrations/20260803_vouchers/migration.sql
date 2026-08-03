-- Vouchers: a code that grants a plan without payment.
--
-- Additive only. Two new tables and no change to any existing one, so
-- an older backend keeps working against this schema until it is
-- redeployed.

CREATE TABLE "vouchers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "maxRedemptions" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");
CREATE INDEX "vouchers_planId_idx" ON "vouchers"("planId");

ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "voucher_redemptions" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voucher_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voucher_redemptions_subscriptionId_key" ON "voucher_redemptions"("subscriptionId");
CREATE INDEX "voucher_redemptions_customerId_idx" ON "voucher_redemptions"("customerId");
-- One redemption per customer per code. The counter alone cannot say
-- this, and without it a single customer could drain an unlimited-use
-- voucher by redeeming it repeatedly.
CREATE UNIQUE INDEX "voucher_redemptions_voucherId_customerId_key" ON "voucher_redemptions"("voucherId", "customerId");

ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucherId_fkey"
    FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
