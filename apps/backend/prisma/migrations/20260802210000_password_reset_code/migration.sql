-- A short, typeable code for password reset, alongside the existing
-- emailed token.
--
-- The token is a JWT and only ever reached the customer inside a link.
-- A desktop client cannot rely on receiving one -- webmail strips custom
-- URI schemes, which is the same bug that gave email verification its
-- code path. Without this a customer who forgot their password had no
-- route back into the product at all.
ALTER TABLE "customers"
  ADD COLUMN "passwordResetCode" TEXT,
  ADD COLUMN "passwordResetCodeExpiresAt" TIMESTAMP(3);
