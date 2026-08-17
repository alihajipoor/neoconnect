-- Write each plan's currently-effective route set down explicitly.
--
-- THIS MUST LAND BEFORE "no routes selected" STARTS MEANING "no service".
-- The join table is empty today, and empty currently means "every route
-- this plan is eligible for". Flip the meaning first and every customer
-- on every plan loses service at the same moment.
--
-- Effective set = what provisionAll would hand this plan right now:
--   * the route's entry protocol is in the plan's protocolsAllowed, and
--   * the route is on the plan's side of the relay/direct split.
--
-- After this runs nothing has changed behaviourally -- each plan simply
-- says out loud what it was already being served by, which is what lets
-- relayOnly and the implicit fallback both be removed next.
--
-- Only plans that have no selection yet, so re-running is a no-op and an
-- operator who has already curated a plan by hand is not overwritten.
INSERT INTO "_PlanAllowedRoutes" ("A", "B")
SELECT r.id, p.id
FROM "subscription_plans" p
JOIN "routes" r ON TRUE
JOIN "protocol_configs" ec ON ec.id = r."entryProtocolConfigId"
WHERE ec.protocol = ANY (p."protocolsAllowed")
  AND (
    (p."relayOnly" AND r."exitProtocolConfigId" IS NOT NULL)
    OR (NOT p."relayOnly" AND r."exitProtocolConfigId" IS NULL)
  )
  AND NOT EXISTS (
    SELECT 1 FROM "_PlanAllowedRoutes" x WHERE x."B" = p.id
  )
ON CONFLICT DO NOTHING;
