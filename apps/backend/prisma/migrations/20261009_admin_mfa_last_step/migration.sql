-- The last TOTP time-step an admin's code was accepted for, so the same
-- code cannot be accepted twice inside its ~90 s validity window
-- (RFC 6238 section 5.2). Written by the MFA step's conditional update.
--
-- Additive and safe on a live database: one nullable column, NULL for
-- every existing admin (the next accepted code sets it). The previous
-- backend neither reads nor writes it.
ALTER TABLE "admin_users" ADD COLUMN "mfaLastStep" INTEGER;
