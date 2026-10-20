-- When the owner was last told a node is heartbeating again, for the cooldown on new gap pages (NodesService.pageHeartbeatGaps). Additive.
ALTER TABLE "nodes" ADD COLUMN "heartbeatBackPagedAt" TIMESTAMP(3);
