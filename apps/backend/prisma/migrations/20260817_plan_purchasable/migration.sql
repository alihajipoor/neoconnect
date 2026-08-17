-- Split "usable" from "listed for sale".
--
-- isActive was doing both jobs, and that combination silently broke the
-- free trial: the Trial plan was marked inactive to keep it out of the
-- purchase list, SubscriptionsService.create refuses an inactive plan,
-- so every signup threw and nobody got a trial. Nothing reported it,
-- because the failure looked like "no trial configured".
--
-- Defaults true so every existing plan keeps appearing exactly as it
-- does today; an operator hides one by unticking it, rather than by
-- deactivating a plan they still want to work.
ALTER TABLE "subscription_plans"
    ADD COLUMN IF NOT EXISTS "isPurchasable" BOOLEAN NOT NULL DEFAULT true;
