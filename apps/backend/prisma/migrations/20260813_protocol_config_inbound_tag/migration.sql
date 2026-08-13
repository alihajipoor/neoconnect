-- Which Xray inbound serves a ProtocolConfig.
--
-- Null keeps today's behaviour exactly: the agent uses the inbound tag
-- it was started with for that protocol, which is what every existing
-- row relies on and what every non-relay node will continue to use.
--
-- Needed because a relay node runs one inbound per exit it forwards to.
-- The routing rule a relayed route installs matches on the entry inbound
-- tag alone, so two relayed routes sharing one inbound means the second
-- silently uses the first one's exit. Measured 2026-08-13: a credential
-- issued on the ir1 -> france-1 route exited at finland1's address.
ALTER TABLE "protocol_configs"
    ADD COLUMN IF NOT EXISTS "inboundTag" TEXT;
