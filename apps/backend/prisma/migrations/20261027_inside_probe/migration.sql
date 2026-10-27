-- Data checks against each node from boxes inside the watched country (modules/inside-probe). Additive.
CREATE TABLE "inside_probe_checks" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "vantage" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "connectMs" INTEGER,
    "downBytes" INTEGER NOT NULL,
    "downMs" INTEGER NOT NULL,
    "upBytes" INTEGER NOT NULL,
    "upMs" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inside_probe_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inside_probe_checks_nodeId_checkedAt_idx" ON "inside_probe_checks"("nodeId", "checkedAt");
CREATE INDEX "inside_probe_checks_checkedAt_idx" ON "inside_probe_checks"("checkedAt");

ALTER TABLE "inside_probe_checks" ADD CONSTRAINT "inside_probe_checks_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
