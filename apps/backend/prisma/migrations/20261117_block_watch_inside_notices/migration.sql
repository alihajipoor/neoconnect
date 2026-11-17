-- Block watch: the one early notice for an incident our inside boxes
-- raised, and a record of what was told outside incidents (an inside box
-- that went silent or came back, and each digest's delivery). Additive.
ALTER TABLE "block_incidents" ADD COLUMN     "insideNoticedAt" TIMESTAMP(3),
ADD COLUMN     "insideNoticeError" TEXT,
ADD COLUMN     "insideNoticeAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "block_watch_notices" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vantage" TEXT,
    "lastRoundAt" TIMESTAMP(3),
    "delivered" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_watch_notices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "block_watch_notices_kind_createdAt_idx" ON "block_watch_notices"("kind", "createdAt");
CREATE INDEX "block_watch_notices_vantage_createdAt_idx" ON "block_watch_notices"("vantage", "createdAt");
