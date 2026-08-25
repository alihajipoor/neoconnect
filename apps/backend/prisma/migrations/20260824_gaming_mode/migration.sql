-- Gaming Mode: game profiles, plan features, the node-side resolver, and the
-- per-customer resolver token.
--
-- Four new tables and one new enum. Nothing existing is altered, so this
-- migration cannot change the behaviour of anything already running -- every
-- row that exists today is untouched and every table it adds starts empty.
-- That is deliberate: gaming mode is gated on a measurement that has not been
-- taken yet (docs/design/gaming-mode.md, instrument #1 -- consumer-ISP
-- reachability from inside Iran), so the schema has to be able to land
-- ahead of the decision to sell it, and to sit inert until then.
--
-- Read docs/design/gaming-mode.md before extending this. The one thing that
-- keeps being assumed and is false: this is NOT a lower-ping feature. From
-- Tehran the direct path to Blizzard's EU game server is 72.0 ms and the best
-- path through our fleet is 72.8 ms; the other four nodes are 28-66 ms worse.
-- Nothing here exists to support a latency claim.
--
-- Two decisions worth recording:
--
-- plan_features is a join table rather than another boolean column on
-- subscription_plans. subscription_plans already carries the two cautionary
-- tales: relayOnly, whose enforcement was removed leaving a column nothing
-- reads, and isActive, which did two jobs and silently broke the free trial
-- for every signup until isPurchasable was split out of it. A row that is
-- present or absent cannot drift from itself, and "which plans grant this"
-- becomes an index lookup rather than a scan.
--
-- gaming_resolvers.confirmedAt is nullable with no default, and NULL means
-- "never confirmed" rather than "missing data" -- the same decision as
-- routes.uplinkAssertedAt, taken for the same reason. Thirteen relay routes
-- once reported ONLINE while every one of them was dead, because their health
-- was inferred from a neighbouring signal instead of measured. A resolver
-- that has never acked is never offered to a client.
--
-- The statements below were generated with
--   prisma migrate diff --from-schema-datamodel <previous> --                       --to-schema-datamodel prisma/schema.prisma --script
-- rather than hand-written, so the constraint and index names match exactly
-- what Prisma expects to find. There is no down migration; this repo has
-- never had one.

-- CreateEnum
CREATE TYPE "PlanFeatureKey" AS ENUM ('GAMING_DNS', 'GAMING_PRIVATE_EXIT');

-- CreateTable
CREATE TABLE "plan_features" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "feature" "PlanFeatureKey" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_profiles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "iconKey" TEXT,
    "publisher" TEXT,
    "hostnames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeHostnames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "processNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "destinationCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "destinationAsn" TEXT,
    "prefixComplete" BOOLEAN NOT NULL DEFAULT false,
    "canaryHostname" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gaming_resolvers" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "dohHost" TEXT NOT NULL,
    "dohPort" INTEGER NOT NULL DEFAULT 443,
    "proxyIp" TEXT NOT NULL,
    "proxyPort" INTEGER NOT NULL DEFAULT 443,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gaming_resolvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gaming_resolver_tokens" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "gaming_resolver_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_features_feature_idx" ON "plan_features"("feature");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_planId_feature_key" ON "plan_features"("planId", "feature");

-- CreateIndex
CREATE UNIQUE INDEX "game_profiles_slug_key" ON "game_profiles"("slug");

-- CreateIndex
CREATE INDEX "game_profiles_isActive_sortOrder_idx" ON "game_profiles"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "gaming_resolvers_nodeId_key" ON "gaming_resolvers"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "gaming_resolver_tokens_customerId_key" ON "gaming_resolver_tokens"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "gaming_resolver_tokens_token_key" ON "gaming_resolver_tokens"("token");

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gaming_resolvers" ADD CONSTRAINT "gaming_resolvers_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gaming_resolver_tokens" ADD CONSTRAINT "gaming_resolver_tokens_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

