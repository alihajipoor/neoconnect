-- Block watch: an incident clears only on evidence the server works again
-- (the signals and networks that fired are kept to check against), a
-- cleared one that comes back is re-opened, and a page counts as sent
-- only once it reached somebody. Additive.
ALTER TABLE "block_incidents" ADD COLUMN     "failedAsns" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "firedFamilies" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pageAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reopenedAt" TIMESTAMP(3);
