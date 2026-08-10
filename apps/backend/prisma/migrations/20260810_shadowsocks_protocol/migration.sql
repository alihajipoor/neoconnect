-- Shadowsocks 2022 as a protocol a node can offer.
--
-- Served by the same xray-core process as the VLESS and Trojan
-- inbounds, so this adds a protocol without adding a daemon: one more
-- inbound, the same gRPC hot-add path, the same stats.
--
-- Its own enum member rather than a transport of an existing Xray
-- protocol, because the credential is a different shape -- a pre-shared
-- key pair rather than a UUID -- and the client builds a shadowsocks
-- outbound rather than a VLESS one.
--
-- Added after OPENVPN rather than in protocol order: Postgres enum
-- values are ordered by creation and existing rows sort by that order,
-- so inserting in the middle with BEFORE would reorder every query that
-- sorts on this column. Appending changes nothing already stored.

ALTER TYPE "Protocol" ADD VALUE IF NOT EXISTS 'SHADOWSOCKS';
