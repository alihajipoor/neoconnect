-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "defaultRouteId" TEXT;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_defaultRouteId_fkey" FOREIGN KEY ("defaultRouteId") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
