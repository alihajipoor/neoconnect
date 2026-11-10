-- Each node as a door to the panel API, learned by the backend itself
-- (modules/node-doors): the port that answered, the SNI sent, the pin of
-- the certificate's key and the one before it, and when the check last
-- passed. Additive: six nullable columns with no default, which Postgres
-- adds without rewriting or scanning the table.
ALTER TABLE "nodes"
  ADD COLUMN "doorPort" INTEGER,
  ADD COLUMN "doorSni" TEXT,
  ADD COLUMN "doorPin" TEXT,
  ADD COLUMN "doorPreviousPin" TEXT,
  ADD COLUMN "doorPinChangedAt" TIMESTAMP(3),
  ADD COLUMN "doorVerifiedAt" TIMESTAMP(3);
