-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "maxDownloadMbps" INTEGER,
ADD COLUMN     "maxUploadMbps" INTEGER;
