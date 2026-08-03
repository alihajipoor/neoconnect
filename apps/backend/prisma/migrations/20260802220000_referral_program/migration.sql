-- Referral programme.
--
-- Hand-written rather than generated: the dev database was not running
-- when this landed. It matches the models in schema.prisma exactly and
-- is applied by `prisma migrate deploy` like any other.

-- CreateEnum
CREATE TYPE "ReferralRewardReason" AS ENUM ('LOYAL_FRIEND', 'SEVERAL_FRIENDS');

-- AlterTable: who invited this customer, set once at signup.
ALTER TABLE "customers" ADD COLUMN "referredByCustomerId" TEXT;

-- CreateIndex
CREATE INDEX "customers_referredByCustomerId_idx" ON "customers"("referredByCustomerId");

-- AddForeignKey
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_referredByCustomerId_fkey"
  FOREIGN KEY ("referredByCustomerId") REFERENCES "customers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: the singleton settings row, same shape as free_trial_settings.
CREATE TABLE "referral_settings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rewardPlanId" TEXT,
    "loyalFriendMonths" INTEGER NOT NULL DEFAULT 3,
    "friendsRequired" INTEGER NOT NULL DEFAULT 3,
    "friendMonths" INTEGER NOT NULL DEFAULT 1,
    "rewardDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "referral_settings"
  ADD CONSTRAINT "referral_settings_rewardPlanId_fkey"
  FOREIGN KEY ("rewardPlanId") REFERENCES "subscription_plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: free months actually granted.
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "reason" "ReferralRewardReason" NOT NULL,
    "sourceJson" JSONB NOT NULL,
    "subscriptionId" TEXT,
    "rewardDays" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_subscriptionId_key" ON "referral_rewards"("subscriptionId");
CREATE INDEX "referral_rewards_referrerId_idx" ON "referral_rewards"("referrerId");

-- AddForeignKey
ALTER TABLE "referral_rewards"
  ADD CONSTRAINT "referral_rewards_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "referral_rewards"
  ADD CONSTRAINT "referral_rewards_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: how much of each invited customer's paid time has been
-- spent on a reward. Without this the same months would earn a reward on
-- every sweep, forever.
CREATE TABLE "referral_credits" (
    "id" TEXT NOT NULL,
    "referredCustomerId" TEXT NOT NULL,
    "monthsSpent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_credits_referredCustomerId_key" ON "referral_credits"("referredCustomerId");

-- AddForeignKey
ALTER TABLE "referral_credits"
  ADD CONSTRAINT "referral_credits_referredCustomerId_fkey"
  FOREIGN KEY ("referredCustomerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
