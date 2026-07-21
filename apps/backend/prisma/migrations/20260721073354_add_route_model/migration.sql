/*
  Warnings:

  - You are about to drop the column `relayTargetNodeId` on the `nodes` table. All the data in the column will be lost.
  - Added the required column `routeId` to the `protocol_users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentCommandType" ADD VALUE 'CONFIGURE_ROUTE';
ALTER TYPE "AgentCommandType" ADD VALUE 'REMOVE_ROUTE';

-- DropForeignKey
ALTER TABLE "nodes" DROP CONSTRAINT "nodes_relayTargetNodeId_fkey";

-- AlterTable
ALTER TABLE "nodes" DROP COLUMN "relayTargetNodeId";

-- DeleteRows
-- Pre-launch dev/test data only (no real customers yet) -- clears any
-- existing protocol_users rows so the new required routeId column can
-- be added without a default value.
DELETE FROM "protocol_users";

-- AlterTable
ALTER TABLE "protocol_users" ADD COLUMN     "routeId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entryProtocolConfigId" TEXT NOT NULL,
    "exitProtocolConfigId" TEXT,
    "uplinkCredentialsJson" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protocol_users_routeId_idx" ON "protocol_users"("routeId");

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_entryProtocolConfigId_fkey" FOREIGN KEY ("entryProtocolConfigId") REFERENCES "protocol_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_exitProtocolConfigId_fkey" FOREIGN KEY ("exitProtocolConfigId") REFERENCES "protocol_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocol_users" ADD CONSTRAINT "protocol_users_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
