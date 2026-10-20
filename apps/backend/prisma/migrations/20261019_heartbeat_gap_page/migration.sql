-- When the owner was paged that a node stopped heartbeating (NodesService.pageHeartbeatGaps). Additive.
ALTER TABLE "nodes" ADD COLUMN "heartbeatGapPagedAt" TIMESTAMP(3);
