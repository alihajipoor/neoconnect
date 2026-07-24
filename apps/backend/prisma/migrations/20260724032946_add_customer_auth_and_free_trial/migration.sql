-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "free_trial_settings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trialPlanId" TEXT,
    "trialRouteId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "free_trial_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "free_trial_settings" ADD CONSTRAINT "free_trial_settings_trialPlanId_fkey" FOREIGN KEY ("trialPlanId") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_trial_settings" ADD CONSTRAINT "free_trial_settings_trialRouteId_fkey" FOREIGN KEY ("trialRouteId") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
