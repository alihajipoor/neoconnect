-- Unlimited-traffic plans: null dataCapBytes means no cap.
--
-- Only drops NOT NULL. Every existing plan and subscription keeps the
-- cap it already had, so nothing in production changes behaviour until
-- somebody deliberately sets a plan to unlimited.

ALTER TABLE "subscription_plans" ALTER COLUMN "dataCapBytes" DROP NOT NULL;
ALTER TABLE "subscriptions" ALTER COLUMN "dataCapBytes" DROP NOT NULL;
