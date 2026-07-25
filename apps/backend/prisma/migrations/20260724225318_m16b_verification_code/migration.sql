-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "emailVerificationCode" TEXT,
ADD COLUMN     "emailVerificationCodeExpiresAt" TIMESTAMP(3);
