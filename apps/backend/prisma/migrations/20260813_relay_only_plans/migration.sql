-- Plans that may only be served by relayed routes.
--
-- Ultimate is sold as the Iran relay path specifically: less data than
-- the cheaper tiers, for more money, because what it sells is the route
-- rather than the allowance. Serving it from a direct route would be a
-- different product wearing its name.
--
-- The inverse matters more, and is the reason this has to exist BEFORE
-- any relayed Route does. ProtocolUsersService.provisionAll() hands
-- every enabled Route whose entry protocol a plan allows to every
-- subscription on that plan. Create an Iran relay route without this
-- column and all 15 live customers are provisioned onto it within the
-- next sweep -- relayed traffic crosses two servers and the Iran side
-- costs more per gigabyte, so that is paying twice over to serve people
-- who never asked for it, silently.
--
-- Defaults false, so every existing plan keeps exactly today's
-- behaviour and no live subscription changes.
ALTER TABLE "subscription_plans"
    ADD COLUMN IF NOT EXISTS "relayOnly" BOOLEAN NOT NULL DEFAULT false;
