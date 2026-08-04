-- Beta telemetry: one row per reported connection attempt.
--
-- Every failure in this beta cost a screenshot and a round trip to
-- diagnose. The app already computes which protocols it tried, whether
-- traffic actually crossed the tunnel, and which control-plane address
-- answered -- it showed that to the customer and discarded it.
--
-- Reports are accepted without authentication on purpose: the most
-- valuable ones come from somebody who could not sign in. That is also
-- why every column is bounded and the table is swept on a short
-- retention window rather than kept.

CREATE TYPE "ClientAttemptKind" AS ENUM ('REGISTER', 'SIGN_IN', 'CONNECT');

CREATE TYPE "ClientAttemptOutcome" AS ENUM (
  'SUCCESS',
  'CONTROL_PLANE_UNREACHABLE',
  'REJECTED',
  'NOT_CARRYING_TRAFFIC',
  'ENGINE_FAILED',
  'PERMISSION_DENIED',
  'OTHER'
);

CREATE TABLE "client_attempts" (
  "id"           TEXT NOT NULL,
  "kind"         "ClientAttemptKind" NOT NULL,
  "outcome"      "ClientAttemptOutcome" NOT NULL,
  "customerId"   TEXT,
  "platform"     TEXT NOT NULL,
  "appVersion"   TEXT NOT NULL,
  "routeId"      TEXT,
  "protocol"     TEXT,
  "attemptsJson" JSONB,
  "apiEndpoint"  TEXT,
  "reason"       TEXT,
  "ip"           TEXT,
  "occurredAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "client_attempts_pkey" PRIMARY KEY ("id")
);

-- Deleting a customer must not delete the record that they could not get
-- in, so the link is severed rather than cascaded.
ALTER TABLE "client_attempts"
  ADD CONSTRAINT "client_attempts_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The retention sweep and the panel's default view both order by time.
CREATE INDEX "client_attempts_createdAt_idx" ON "client_attempts"("createdAt");
-- "show me the failures, newest first" is the whole point of the page.
CREATE INDEX "client_attempts_outcome_createdAt_idx" ON "client_attempts"("outcome", "createdAt");
CREATE INDEX "client_attempts_customerId_idx" ON "client_attempts"("customerId");
