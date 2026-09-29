-- Social sign-in: Google, Apple and Facebook.

-- An account created through a provider has never had a password.
ALTER TABLE "customers" ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE', 'APPLE', 'FACEBOOK');

CREATE TABLE "customer_identities" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);

-- The pair is the identity. A subject is only unique within its
-- provider, so neither column is a key on its own.
CREATE UNIQUE INDEX "customer_identities_provider_subject_key"
    ON "customer_identities"("provider", "subject");
CREATE INDEX "customer_identities_customerId_idx"
    ON "customer_identities"("customerId");

ALTER TABLE "customer_identities"
    ADD CONSTRAINT "customer_identities_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
