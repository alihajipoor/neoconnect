-- Splits "how is this carried" and "what is it wrapped in" out of the
-- Protocol enum, which had conflated them (XRAY_VLESS_REALITY names a
-- protocol AND its security, leaving a WebSocket variant nowhere to go).

CREATE TYPE "Transport" AS ENUM ('TCP', 'WS', 'GRPC');
CREATE TYPE "TransportSecurity" AS ENUM ('NONE', 'TLS', 'REALITY');

-- Defaults chosen so every existing row keeps behaving exactly as it
-- does today without being touched: WireGuard and OpenVPN carry
-- themselves, so TCP/NONE is the honest "not applicable here".
ALTER TABLE "protocol_configs"
  ADD COLUMN "transport" "Transport" NOT NULL DEFAULT 'TCP',
  ADD COLUMN "security" "TransportSecurity" NOT NULL DEFAULT 'NONE';

-- Backfill the one case the defaults would describe wrongly. An existing
-- XRAY_VLESS_REALITY inbound is REALITY-secured by definition -- the name
-- says so -- and leaving it as NONE would make the client build a config
-- with no security block and fail to connect.
UPDATE "protocol_configs"
  SET "security" = 'REALITY'
  WHERE "protocol" = 'XRAY_VLESS_REALITY';
