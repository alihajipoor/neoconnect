-- The signed endpoint bundle and its configured panel addresses.
--
-- One row, created lazily by the service. Additive and empty: nothing
-- reads it until an operator uploads a signed bundle, and until then the
-- public route answers 404 rather than an empty list -- a client must be
-- able to tell "no bundle published" from "a bundle saying go nowhere".
CREATE TABLE "endpoint_bundle_state" (
    "id" TEXT NOT NULL,
    "panelBasesJson" TEXT NOT NULL DEFAULT '[]',
    "signed" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "endpoint_bundle_state_pkey" PRIMARY KEY ("id")
);
