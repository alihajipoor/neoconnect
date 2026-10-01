-- Measuring whether a node is reachable from Iran.
--
-- `nodes.status` answers a different question than the one that matters.
-- The agent heartbeats over an outbound connection the node opens
-- itself, so a node stays ONLINE while being comprehensively blocked at
-- the Iranian border: the daemon is alive, and no customer can reach it.
-- turkey-1 sat ONLINE with zero successful connections for three days
-- and nothing in the system said anything was wrong.
--
-- So reachability is probed from outside, from vantage points inside
-- Iran, and recorded here. INCONCLUSIVE is a first-class verdict rather
-- than a failure: when the probe provider is down or rate-limits us
-- every node looks dead at once, and that must never be mistaken for
-- the fleet being filtered.
--
-- Entirely additive. Nothing reads these tables until the new module
-- runs, so this is safe to apply while the API is serving.

CREATE TYPE "ReachabilityVerdict" AS ENUM ('REACHABLE', 'DEGRADED', 'UNREACHABLE', 'INCONCLUSIVE');

CREATE TABLE "node_reachability_checks" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ir',
    "port" INTEGER NOT NULL,
    "verdict" "ReachabilityVerdict" NOT NULL,
    "probesOk" INTEGER NOT NULL,
    "probesAnswered" INTEGER NOT NULL,
    "probesRequested" INTEGER NOT NULL,
    "medianLatencyMs" INTEGER,
    "detailJson" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_reachability_checks_pkey" PRIMARY KEY ("id")
);

-- The first index serves the per-node history the panel draws and the
-- "last N cycles" lookup the alerting does every run. The second serves
-- the fleet-wide latest-per-node view and the retention sweep, which
-- both scan by time across all nodes.
CREATE INDEX "node_reachability_checks_nodeId_checkedAt_idx" ON "node_reachability_checks"("nodeId", "checkedAt");
CREATE INDEX "node_reachability_checks_checkedAt_idx" ON "node_reachability_checks"("checkedAt");

CREATE TABLE "node_reachability_alerts" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ir',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "notifyError" TEXT,

    CONSTRAINT "node_reachability_alerts_pkey" PRIMARY KEY ("id")
);

-- "Is there a live incident for this node" is asked once per node per
-- cycle, and is the check that stops a half-hourly email about an
-- outage already reported.
CREATE INDEX "node_reachability_alerts_nodeId_resolvedAt_idx" ON "node_reachability_alerts"("nodeId", "resolvedAt");

-- CASCADE on both: a deleted node's probe history is of no interest, and
-- RESTRICT here would make the node undeletable once it had ever been
-- probed.
ALTER TABLE "node_reachability_checks" ADD CONSTRAINT "node_reachability_checks_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "node_reachability_alerts" ADD CONSTRAINT "node_reachability_alerts_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
