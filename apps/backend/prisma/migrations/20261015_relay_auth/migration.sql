-- Sign-up and sign-in through the Iranian relay of last resort
-- (docs/relay-last-resort.md).
--
-- Additive and safe on a live database. Every new column is nullable,
-- and NULL is what the previous backend leaves in it: an account with no
-- signup channel, no recovery code and no relay state, a session with no
-- channel, an attempt with no `via`. The three tables are new and the
-- previous backend never reads them. No address is stored anywhere here:
-- the daily stats and traffic buckets are counts by network and by box.
-- CreateEnum
CREATE TYPE "SignupChannel" AS ENUM ('NORMAL', 'RELAY', 'SOCIAL');

-- CreateEnum
CREATE TYPE "AccessChannel" AS ENUM ('NORMAL', 'RELAY');

-- CreateEnum
CREATE TYPE "RelayAuthMode" AS ENUM ('OFF', 'AUTO', 'INTRANET');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "recoveryCodeHash" TEXT,
ADD COLUMN     "recoveryCodeSetAt" TIMESTAMP(3),
ADD COLUMN     "relayMailAt" TIMESTAMP(3),
ADD COLUMN     "relayUnverifiedSince" TIMESTAMP(3),
ADD COLUMN     "signupChannel" "SignupChannel";

-- AlterTable
ALTER TABLE "customer_sessions" ADD COLUMN     "channel" "AccessChannel";

-- AlterTable
ALTER TABLE "client_attempts" ADD COLUMN     "via" TEXT;

-- CreateTable
CREATE TABLE "relay_auth_settings" (
    "id" TEXT NOT NULL,
    "mode" "RelayAuthMode" NOT NULL DEFAULT 'AUTO',
    "hostingAsns" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "intranetDeclaredAt" TIMESTAMP(3),
    "intranetEndedAt" TIMESTAMP(3),
    "suspectedSince" TIMESTAMP(3),
    "suspicionAlertedAt" TIMESTAMP(3),
    "capsRaisedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relay_auth_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_daily_stats" (
    "day" DATE NOT NULL,
    "box" TEXT NOT NULL DEFAULT '',
    "asn" INTEGER NOT NULL DEFAULT 0,
    "signups" INTEGER NOT NULL DEFAULT 0,
    "signIns" INTEGER NOT NULL DEFAULT 0,
    "refusals" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "relay_daily_stats_pkey" PRIMARY KEY ("day","box","asn")
);

-- CreateTable
CREATE TABLE "relay_traffic_buckets" (
    "start" TIMESTAMP(3) NOT NULL,
    "ir" INTEGER NOT NULL DEFAULT 0,
    "other" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "relay_traffic_buckets_pkey" PRIMARY KEY ("start")
);

-- CreateIndex
CREATE INDEX "customers_relayUnverifiedSince_idx" ON "customers"("relayUnverifiedSince");

