-- Per-ISP recommendations in the location picker.
--
-- Two additions to the attempt log, both swept with the row on the
-- existing 14-day retention:
--
-- * `asn`: which network the client was on before its tunnel came up,
--   from a signed attestation the server itself issued at /health/ip. The
--   network only -- an autonomous system number -- never a location. The
--   IP column is unchanged and its retention is not extended.
-- * `sessionSeconds`, with a new SESSION kind: a tunnel that kept passing
--   its health checks, and for how long. A CONNECT success says traffic
--   crossed once; this says it kept crossing.
--
-- Entirely additive. Old clients send neither and their rows read as
-- they always have; nothing depends on these columns until the new
-- clients and the route-list tags are deployed. Safe to apply while the
-- API is serving.
--
-- The enum value is added on its own statement and used by nothing in
-- this migration, which is what Postgres requires of ADD VALUE inside a
-- transaction.

ALTER TYPE "ClientAttemptKind" ADD VALUE IF NOT EXISTS 'SESSION';

ALTER TABLE "client_attempts" ADD COLUMN "asn" INTEGER;
ALTER TABLE "client_attempts" ADD COLUMN "sessionSeconds" INTEGER;

-- Serves the one query the tags make: one network's reports inside the
-- last two days.
CREATE INDEX "client_attempts_asn_createdAt_idx" ON "client_attempts"("asn", "createdAt");
