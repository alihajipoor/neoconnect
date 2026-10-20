-- Block watch (modules/block-watch). Additive only.
CREATE TYPE "BlockVerdict" AS ENUM ('SUSPECT', 'LIKELY_BLOCKED');
CREATE TYPE "BlockIncidentStatus" AS ENUM ('OPEN', 'CLEARED', 'REPLACED', 'RETIRED');

CREATE TABLE "block_incidents" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "publicIp" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ir',
    "status" "BlockIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "verdict" "BlockVerdict" NOT NULL DEFAULT 'SUSPECT',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "likelyAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "quietCycles" INTEGER NOT NULL DEFAULT 0,
    "evidenceJson" JSONB NOT NULL,
    "pagedAt" TIMESTAMP(3),
    "pageError" TEXT,
    "remindedAt" TIMESTAMP(3),
    "recoveryNotifiedAt" TIMESTAMP(3),
    "digestedAt" TIMESTAMP(3),
    "keptAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "actedBy" TEXT,
    "actionNote" TEXT,

    CONSTRAINT "block_incidents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "block_incidents_nodeId_status_idx" ON "block_incidents"("nodeId", "status");
CREATE INDEX "block_incidents_status_openedAt_idx" ON "block_incidents"("status", "openedAt");

ALTER TABLE "block_incidents" ADD CONSTRAINT "block_incidents_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
