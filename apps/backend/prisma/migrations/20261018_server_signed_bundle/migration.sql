-- The server-signed endpoint list, served at /endpoints/bundle2 beside
-- the offline one. Additive: both columns are empty until the first.
ALTER TABLE "endpoint_bundle_state" ADD COLUMN "serverSigned" TEXT,
ADD COLUMN "serverVersion" INTEGER NOT NULL DEFAULT 0;
