-- VLESS over ordinary TLS, alongside the existing REALITY variant.
--
-- Added after XRAY_VLESS_REALITY rather than at the end of the type so
-- the two VLESS variants read together; Postgres allows this and it does
-- not renumber anything already stored.
ALTER TYPE "Protocol" ADD VALUE IF NOT EXISTS 'XRAY_VLESS_TLS' AFTER 'XRAY_VLESS_REALITY';
