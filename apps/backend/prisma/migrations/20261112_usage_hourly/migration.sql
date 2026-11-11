-- usage_hourly: usage_records older than the days kept, added up per
-- subscription, node and UTC hour (docs/usage-retention.md).
--
-- Additive only: a new, empty table. Nothing is moved or deleted here;
-- the retention job (modules/data-retention) does that, in batches, when
-- an operator or the nightly schedule runs it.
--
-- The foreign keys cascade, unlike usage_records': a rolled-up hour
-- belongs to its subscription and node and goes with them, and a backend
-- rolled back to before this table (which knows nothing of it) can still
-- delete a subscription, a customer or a node. Adding them to an empty
-- table takes a brief lock on subscriptions and nodes and validates
-- nothing.

-- CreateTable
CREATE TABLE "usage_hourly" (
    "subscriptionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "bytesUp" BIGINT NOT NULL,
    "bytesDown" BIGINT NOT NULL,
    "records" INTEGER NOT NULL,
    "lastReportedAt" TIMESTAMP(3) NOT NULL,
    "lastUpAt" TIMESTAMP(3),

    CONSTRAINT "usage_hourly_pkey" PRIMARY KEY ("subscriptionId","nodeId","hourStart")
);

-- CreateIndex
CREATE INDEX "usage_hourly_nodeId_hourStart_idx" ON "usage_hourly"("nodeId", "hourStart");

-- AddForeignKey
ALTER TABLE "usage_hourly" ADD CONSTRAINT "usage_hourly_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_hourly" ADD CONSTRAINT "usage_hourly_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
