-- DropForeignKey
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_protocolUserId_fkey";

-- AlterTable
ALTER TABLE "usage_records" ALTER COLUMN "protocolUserId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_protocolUserId_fkey" FOREIGN KEY ("protocolUserId") REFERENCES "protocol_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
