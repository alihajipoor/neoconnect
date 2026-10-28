-- Seven days of where each customer's connections went (modules/site-visits). Additive.
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "protocol" TEXT,
    "inboundTag" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "site_visits_customerId_lastSeen_idx" ON "site_visits"("customerId", "lastSeen");
CREATE INDEX "site_visits_lastSeen_idx" ON "site_visits"("lastSeen");

ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
