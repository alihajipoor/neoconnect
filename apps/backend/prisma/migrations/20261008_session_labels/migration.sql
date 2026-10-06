-- What a signed-in device calls itself, for the plan's device limit
-- (docs/device-slots.md): "Neoxify is in use on Windows PC since 14:02".
--
-- Set from headers the app sends when it signs in or claims a slot
-- (X-Neoxify-Device-Label, X-Neoxify-Device-Platform). A generic label
-- such as "Windows PC" or "Android phone (Pixel 7)", never a hostname;
-- the backend also drops anything that looks like one.
--
-- Additive and safe on a live database: two nullable columns, NULL on
-- every existing session (shown as "another device"). The previous
-- backend creates sessions without naming them, which leaves them NULL.
ALTER TABLE "customer_sessions" ADD COLUMN "label" TEXT;
ALTER TABLE "customer_sessions" ADD COLUMN "platform" TEXT;
