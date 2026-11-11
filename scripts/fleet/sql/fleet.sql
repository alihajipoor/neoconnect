-- Every query `fleet` runs against production, by name.
--
-- A block starts at "-- @@ <name> (read|write) <variables>" and ends at
-- the next one. lib/remote.sh `q <name> key=value` copies one block to
-- the panel host as a file and runs it with psql variables: there is no
-- id, address or name of ours in this file, and nothing is ever inlined
-- into a command line.
--
-- Rules these follow, each paid for once:
--   * named columns only: protocol_configs."publicParamsJson" holds
--     OpenVPN keys and the Shadowsocks server key, so only named keys of
--     it are read;
--   * read blocks run inside BEGIN READ ONLY (the wrapper adds it);
--   * write blocks run in one transaction, end with a SELECT that shows
--     the result, and are refused without a fresh database dump;
--   * every "isEnabled" is qualified: routes and protocol_configs both
--     have one, and an ambiguous column once rolled a whole retirement
--     back.

-- @@ node-field (read) name col
SELECT :"col" FROM nodes WHERE name = :'name';

-- @@ node-row (read) name
SELECT id, role, region, status,
       coalesce(round(extract(epoch FROM now() - "lastHeartbeatAt"))::text, ''),
       coalesce("agentVersion", ''),
       ("mirrorHost" IS NOT NULL),
       coalesce("realityDest", ''),
       coalesce("realityDestReachable"::text, ''),
       ("agentPubKey" IS NOT NULL)
  FROM nodes WHERE name = :'name';

-- @@ name-count (read) name
SELECT count(*) FROM nodes WHERE name = :'name';

-- @@ next-name (read) base
SELECT :'base' || '-' || (coalesce(max(substring(name FROM '-([0-9]+)$')::int), 0) + 1)
  FROM nodes WHERE name ~ ('^' || :'base' || '-[0-9]+$');

-- @@ heartbeats (read)
SELECT name, status, coalesce(round(extract(epoch FROM now() - "lastHeartbeatAt"))::text, '')
  FROM nodes WHERE status NOT IN ('DISABLED', 'PENDING') ORDER BY name;

-- @@ online-names (read)
SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM nodes WHERE status = 'ONLINE';

-- @@ peer-pick (read) name region
SELECT n.name
  FROM nodes n
  LEFT JOIN protocol_configs pc ON pc."nodeId" = n.id AND pc."isEnabled"
 WHERE n.status = 'ONLINE' AND n.role IN ('STANDALONE', 'EXIT') AND n.name <> :'name'
 GROUP BY n.id, n.name, n.region
 ORDER BY (n.region = :'region') DESC, count(pc.id) DESC, n.name
 LIMIT 1;

-- @@ region-dest (read) region
SELECT "realityDest" FROM nodes
 WHERE region = :'region' AND "realityDest" IS NOT NULL
 ORDER BY (status = 'ONLINE') DESC, "createdAt" DESC LIMIT 1;

-- @@ fleet-agent-version (read)
SELECT mode() WITHIN GROUP (ORDER BY "agentVersion") FROM nodes WHERE status = 'ONLINE' AND "agentVersion" IS NOT NULL;

-- @@ snapshot (read)
SELECT '== servers: name | role | region | status | heartbeat age s | agent | mirror set | door checked';
SELECT name, role, region, status,
       coalesce(round(extract(epoch FROM now() - "lastHeartbeatAt"))::text, '-'),
       coalesce("agentVersion", '-'), ("mirrorHost" IS NOT NULL), ("doorVerifiedAt" IS NOT NULL)
  FROM nodes ORDER BY (status = 'DISABLED'), name;
SELECT '== plans: name | active | relay only | routes | active subscriptions | default route';
SELECT sp.name, sp."isActive", sp."relayOnly",
       (SELECT count(*) FROM "_PlanAllowedRoutes" par WHERE par."B" = sp.id),
       (SELECT count(*) FROM subscriptions s WHERE s."planId" = sp.id AND s.status = 'ACTIVE'),
       coalesce(d.name, '-')
  FROM subscription_plans sp LEFT JOIN routes d ON d.id = sp."defaultRouteId" ORDER BY sp.name;
SELECT '== plan routes: plan | entry server | exit server | routes';
SELECT sp.name, n.name, coalesce(xn.name, '-'), count(*)
  FROM subscription_plans sp
  JOIN "_PlanAllowedRoutes" par ON par."B" = sp.id JOIN routes r ON r.id = par."A"
  JOIN protocol_configs pc ON pc.id = r."entryProtocolConfigId" JOIN nodes n ON n.id = pc."nodeId"
  LEFT JOIN protocol_configs xc ON xc.id = r."exitProtocolConfigId" LEFT JOIN nodes xn ON xn.id = xc."nodeId"
 GROUP BY sp.name, n.name, xn.name ORDER BY sp.name, n.name, xn.name;
SELECT '== open block incidents: server | opened';
SELECT n.name, b."openedAt" FROM block_incidents b JOIN nodes n ON n.id = b."nodeId" WHERE b.status = 'OPEN';
SELECT '== open reachability alerts: server | count';
SELECT n.name, count(*) FROM node_reachability_alerts a JOIN nodes n ON n.id = a."nodeId"
 WHERE a."resolvedAt" IS NULL GROUP BY n.name;

-- @@ routes-of (read) name
-- Direct routes entering the server, and relay routes that exit on it.
SELECT CASE WHEN r."exitProtocolConfigId" IS NULL THEN 'direct' ELSE 'relay' END,
       r.id, e.protocol::text || '/' || e.transport::text, r."isEnabled", r.name
  FROM routes r
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE (ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name'
 ORDER BY 1, 3;

-- @@ route-ids (read) name kind
SELECT coalesce(string_agg(id, ',' ORDER BY id), '') FROM (
  SELECT r.id, CASE WHEN r."exitProtocolConfigId" IS NULL THEN 'direct' ELSE 'relay' END AS kind
    FROM routes r
    JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
    LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
   WHERE (ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name') t
 WHERE kind = :'kind';

-- @@ plan-input (read) incoming outgoing fallback only
-- Three JSON documents for lib/planlist.mjs: the plans as they are now,
-- the routes coming in, the routes going out, and a fallback server's
-- routes for a default that is leaving. A server name of '' gives an
-- empty side. Incoming and fallback take enabled routes only; outgoing
-- takes every route, enabled or not, because a plan may still hold it.
SELECT 'plans ' || coalesce(json_agg(json_build_object(
         'id', sp.id, 'name', sp.name, 'relayOnly', sp."relayOnly",
         'activeSubs', (SELECT count(*) FROM subscriptions s WHERE s."planId" = sp.id AND s.status = 'ACTIVE'),
         'routeIds', (SELECT coalesce(json_agg(par."A" ORDER BY par."A"), '[]'::json)
                        FROM "_PlanAllowedRoutes" par WHERE par."B" = sp.id),
         'defaultRouteId', sp."defaultRouteId")), '[]'::json)::text
  FROM subscription_plans sp
 WHERE :'only' = '' OR sp.name = ANY (string_to_array(:'only', ','));
WITH side AS (
  SELECT s.side, r.id, (r."exitProtocolConfigId" IS NOT NULL) AS relay, r."isEnabled" AS on_,
         CASE WHEN r."exitProtocolConfigId" IS NOT NULL THEN 'relay:' ELSE '' END
           || e.protocol::text || '/' || e.transport::text AS shape
    FROM (VALUES ('incoming', :'incoming'), ('outgoing', :'outgoing'), ('fallback', :'fallback')) AS s(side, node)
    JOIN nodes nd ON nd.name = s.node
    JOIN protocol_configs pc ON pc."nodeId" = nd.id
    JOIN routes r ON (r."entryProtocolConfigId" = pc.id AND r."exitProtocolConfigId" IS NULL)
                  OR r."exitProtocolConfigId" = pc.id
    JOIN protocol_configs e ON e.id = r."entryProtocolConfigId")
SELECT s.side || ' ' || json_build_object(
         'direct', coalesce((SELECT json_agg(id ORDER BY id) FROM side x
                              WHERE x.side = s.side AND NOT relay AND (on_ OR s.side = 'outgoing')), '[]'::json),
         'relay',  coalesce((SELECT json_agg(id ORDER BY id) FROM side x
                              WHERE x.side = s.side AND relay AND (on_ OR s.side = 'outgoing')), '[]'::json),
         'byShape', coalesce((SELECT json_object_agg(shape, id) FROM side x
                               WHERE x.side = s.side AND on_), '{}'::json),
         'shapes', coalesce((SELECT json_object_agg(id, shape) FROM side x WHERE x.side = s.side), '{}'::json))::text
  FROM (VALUES ('incoming'), ('outgoing'), ('fallback')) AS s(side);

-- @@ plan-holds (read) name
-- How many of the server's routes each plan still holds, and whether
-- the plan's default route is one of them.
SELECT sp.name,
       count(par."A") FILTER (WHERE par."A" IN (SELECT id FROM (
           SELECT r.id FROM routes r
             JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
             LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
            WHERE (ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name') t)),
       coalesce((SELECT true FROM routes r
             JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
             LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
            WHERE r.id = sp."defaultRouteId"
              AND ((ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name')), false),
       count(par."A")
  FROM subscription_plans sp LEFT JOIN "_PlanAllowedRoutes" par ON par."B" = sp.id
 GROUP BY sp.id, sp.name, sp."defaultRouteId" ORDER BY sp.name;

-- @@ revoked (read) name
-- Shared credentials still ACTIVE on the server's routes, and plans
-- with subscribers that would be left with no enabled route.
SELECT 'active-creds', count(*)
  FROM protocol_users pu JOIN routes r ON r.id = pu."routeId"
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE pu.status = 'ACTIVE' AND pu."sessionId" IS NULL
   AND ((ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name');
SELECT 'empty-plans', count(*) FROM (
  SELECT sp.id FROM subscription_plans sp
    LEFT JOIN "_PlanAllowedRoutes" par ON par."B" = sp.id
    LEFT JOIN routes r ON r.id = par."A" AND r."isEnabled"
   WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s."planId" = sp.id AND s.status = 'ACTIVE')
   GROUP BY sp.id HAVING count(r.id) = 0) t;

-- @@ open-incident (read) name
SELECT b.id FROM block_incidents b JOIN nodes n ON n.id = b."nodeId"
 WHERE n.name = :'name' AND b.status = 'OPEN';

-- @@ retire-disable (write) name
-- Only from OFFLINE: an agent that is still connected would flip the row
-- back on its next Hello, so the agent is stopped first and the routes
-- go off only if the server really became DISABLED.
UPDATE nodes SET status = 'DISABLED', "updatedAt" = now() WHERE name = :'name' AND status = 'OFFLINE';
UPDATE routes r SET "isEnabled" = false
  FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
 WHERE n.name = :'name' AND n.status = 'DISABLED' AND r."isEnabled"
   AND (r."entryProtocolConfigId" = pc.id OR r."exitProtocolConfigId" = pc.id);
SELECT n.status, count(r.id) FILTER (WHERE r."isEnabled")
  FROM nodes n LEFT JOIN protocol_configs pc ON pc."nodeId" = n.id
  LEFT JOIN routes r ON r."entryProtocolConfigId" = pc.id OR r."exitProtocolConfigId" = pc.id
 WHERE n.name = :'name' GROUP BY n.status;

-- @@ retire-keys (write) name
-- The agent's Hello is not checked against the status, so a Hello on the
-- old key would bring a DISABLED server back ONLINE. No key, no Hello.
UPDATE nodes SET "agentPubKey" = NULL, "mirrorHost" = NULL, "updatedAt" = now()
 WHERE name = :'name' AND status = 'DISABLED';
SELECT status, ("agentPubKey" IS NULL), ("mirrorHost" IS NULL) FROM nodes WHERE name = :'name';

-- @@ alerts-resolve (write) name
UPDATE node_reachability_alerts a SET "resolvedAt" = now()
  FROM nodes n WHERE n.id = a."nodeId" AND n.name = :'name' AND a."resolvedAt" IS NULL;
SELECT count(*) FROM node_reachability_alerts a JOIN nodes n ON n.id = a."nodeId"
 WHERE n.name = :'name' AND a."resolvedAt" IS NULL;

-- @@ node-names (read) name
-- Every name of ours the panel publishes for the server. REALITY's
-- serverName is somebody else's site, so it is left out.
SELECT DISTINCT v FROM (
  SELECT n."mirrorHost" AS v FROM nodes n WHERE n.name = :'name'
  UNION SELECT pc."publicParamsJson"->>'serverName' FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
         WHERE n.name = :'name' AND pc.protocol::text <> 'XRAY_VLESS_REALITY'
  UNION SELECT pc."publicParamsJson"->>'endpointHost' FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
         WHERE n.name = :'name') t
 WHERE v IS NOT NULL AND v !~ '^[0-9.:]+$';

-- @@ mirror-set (write) name host
-- No API sets this. It must be a name on the server's certificate, never
-- an address; the endpoint draft then includes the mirror by itself.
UPDATE nodes SET "mirrorHost" = :'host', "updatedAt" = now() WHERE name = :'name' AND "mirrorHost" IS NULL;
SELECT ("mirrorHost" = :'host') FROM nodes WHERE name = :'name';

-- @@ config-diff (read) name peer
-- Rows only where the new server's protocol set differs from its peer's:
-- a protocol one has and the other lacks, or different parameter keys.
WITH a AS (
  SELECT n.name, pc.protocol::text || '/' || pc.transport::text || '/' || pc.security::text AS shape,
         (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(pc."publicParamsJson"::jsonb) k) AS keys
    FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
   WHERE n.name IN (:'name', :'peer') AND pc."isEnabled")
SELECT coalesce(x.shape, y.shape), coalesce(x.keys, 'MISSING'), coalesce(y.keys, 'MISSING')
  FROM (SELECT * FROM a WHERE name = :'name') x
  FULL JOIN (SELECT * FROM a WHERE name = :'peer') y USING (shape)
 WHERE x.keys IS DISTINCT FROM y.keys;

-- @@ config-names (read) name host
-- Each config's published endpoint, judged here and never printed:
-- WireGuard and OpenVPN by address (names are poisoned where customers
-- are), IKEv2 and the TLS protocols by the certificate name.
SELECT pc.protocol::text || '/' || pc.transport::text,
       CASE WHEN pc.protocol::text IN ('WIREGUARD', 'OPENVPN')
              THEN split_part(pc."publicParamsJson"->>'endpoint', ':', 1) = n."publicIp"
            WHEN pc.protocol::text = 'IKEV2' THEN pc."publicParamsJson"->>'endpointHost' = :'host'
            WHEN pc.protocol::text IN ('XRAY_VLESS_TLS', 'XRAY_TROJAN') THEN pc."publicParamsJson"->>'serverName' = :'host'
            ELSE true END
  FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId" WHERE n.name = :'name' ORDER BY 1;

-- @@ reality-config (read) name
SELECT pc.id FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
 WHERE n.name = :'name' AND pc.protocol::text = 'XRAY_VLESS_REALITY' AND pc."isEnabled";

-- @@ node-ports (read) name
SELECT pc.protocol::text || '/' || pc.transport::text, pc."listenPort"
  FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId" WHERE n.name = :'name' ORDER BY 1;

-- @@ relay-free-sets (read) relay
-- Entry sets on the relay box that no route uses: four inbounds tagged
-- <protocol>-<set>-in, one per relay protocol. A disabled route still
-- holds its entry, so only a set with no route at all is free.
SELECT sfx FROM (
  SELECT substring(pc."inboundTag" FROM '-([a-z0-9]+)-in$') AS sfx,
         count(*) AS n, count(DISTINCT pc.protocol) AS protos,
         sum((SELECT count(*) FROM routes r WHERE r."entryProtocolConfigId" = pc.id)) AS routes
    FROM protocol_configs pc JOIN nodes nd ON nd.id = pc."nodeId"
   WHERE nd.name = :'relay' AND nd.role = 'RELAY' AND pc."isEnabled"
     AND pc."inboundTag" ~ '-[a-z0-9]+-in$'
     AND pc.protocol::text IN ('XRAY_VLESS_REALITY', 'XRAY_VLESS_TLS', 'XRAY_TROJAN', 'SHADOWSOCKS')
   GROUP BY 1) t
 WHERE n = 4 AND protos = 4 AND routes = 0 ORDER BY sfx;

-- @@ relay-set-of (read) name
-- The entry set the relay routes to this exit sit on.
SELECT DISTINCT substring(e."inboundTag" FROM '-([a-z0-9]+)-in$')
  FROM routes r JOIN protocol_configs e ON e.id = r."entryProtocolConfigId"
  JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" JOIN nodes nx ON nx.id = x."nodeId"
 WHERE nx.name = :'name';

-- @@ relay-asserted (read) name
SELECT r.name, r."isEnabled",
       coalesce(round(extract(epoch FROM now() - r."uplinkAssertedAt"))::text, 'never'),
       coalesce(round(extract(epoch FROM now() - r."entryAssertedAt"))::text, 'never'),
       left(coalesce(r."uplinkLastError", ''), 60), left(coalesce(r."entryLastError", ''), 60)
  FROM routes r JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" JOIN nodes nx ON nx.id = x."nodeId"
 WHERE nx.name = :'name' ORDER BY r.name;

-- @@ commands-recent (read) minutes
SELECT n.name, c.type, c.status, count(*)
  FROM agent_commands c JOIN nodes n ON n.id = c."nodeId"
 WHERE c."createdAt" > now() - (:'minutes' || ' minutes')::interval
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- @@ provision (read) name
-- Shared credentials on the server's direct routes, against the number
-- there should be: one per direct route for every active subscription of
-- every plan that holds the route.
SELECT 'have', count(*) FROM protocol_users pu JOIN routes r ON r.id = pu."routeId"
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
 WHERE ne.name = :'name' AND r."exitProtocolConfigId" IS NULL AND pu.status = 'ACTIVE' AND pu."sessionId" IS NULL;
SELECT 'want', count(*) FROM routes r
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  JOIN "_PlanAllowedRoutes" par ON par."A" = r.id
  JOIN subscriptions s ON s."planId" = par."B" AND s.status = 'ACTIVE'
 WHERE ne.name = :'name' AND r."exitProtocolConfigId" IS NULL;
SELECT 'not-acked', count(*) FROM agent_commands c JOIN nodes n ON n.id = c."nodeId"
 WHERE n.name = :'name' AND c."createdAt" > now() - interval '30 minutes' AND c.status::text <> 'ACKED';

-- @@ test-creds (read) name email
-- The test account's own shared credentials on the server's routes, Xray
-- protocols only (the ones a scripted client can dial): shape | route |
-- credential | direct or relay.
SELECT e.protocol::text || '/' || e.transport::text, r.id, pu.id,
       CASE WHEN r."exitProtocolConfigId" IS NULL THEN 'direct' ELSE 'relay' END
  FROM protocol_users pu
  JOIN subscriptions s ON s.id = pu."subscriptionId" AND s.status = 'ACTIVE'
  JOIN customers c ON c.id = s."customerId"
  JOIN routes r ON r.id = pu."routeId"
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE c.email = :'email' AND pu.status = 'ACTIVE' AND pu."sessionId" IS NULL
   AND ((ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name')
   AND e.protocol::text IN ('XRAY_VLESS_REALITY', 'XRAY_VLESS_TLS', 'XRAY_TROJAN', 'SHADOWSOCKS')
 ORDER BY 4, 1;

-- @@ inside-latest (read) name
-- The newest inside-probe reading per vantage and port. This, and bytes
-- real customers moved, is the answer to "is it blocked": the panel's
-- Reachability page is a TCP connect and stays green while data is held.
SELECT DISTINCT ON (c.vantage, c.port) c.vantage, c.port, c.verdict, c."downBytes", c."upBytes",
       round(extract(epoch FROM now() - c."checkedAt") / 60)
  FROM inside_probe_checks c JOIN nodes n ON n.id = c."nodeId"
 WHERE n.name = :'name' ORDER BY c.vantage, c.port, c."checkedAt" DESC;

-- @@ door (read) name
SELECT ("doorVerifiedAt" IS NOT NULL), coalesce("doorPort"::text, '-'),
       coalesce(round(extract(epoch FROM now() - "doorVerifiedAt") / 60)::text, '-')
  FROM nodes WHERE name = :'name';

-- @@ leftovers (read) name
SELECT 'routes-in-plans', count(*) FROM "_PlanAllowedRoutes" par WHERE par."A" IN (
  SELECT r.id FROM routes r
    JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
    LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
   WHERE (ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name');
SELECT 'enabled-routes', count(*) FROM routes r
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE r."isEnabled" AND ((ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name');
SELECT 'relay-routes-left', count(*) FROM routes r
  JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" JOIN nodes nx ON nx.id = x."nodeId" WHERE nx.name = :'name';
SELECT 'plan-defaults', count(*) FROM subscription_plans sp JOIN routes r ON r.id = sp."defaultRouteId"
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE ne.name = :'name' OR nx.name = :'name';
SELECT 'pinned-subscriptions', count(*) FROM subscriptions s JOIN nodes n ON n.id = s."primaryNodeId" WHERE n.name = :'name';
SELECT 'gaming-resolvers', count(*) FROM gaming_resolvers g JOIN nodes n ON n.id = g."nodeId" WHERE n.name = :'name';
SELECT 'open-incidents', count(*) FROM block_incidents b JOIN nodes n ON n.id = b."nodeId"
 WHERE n.name = :'name' AND b.status = 'OPEN';
SELECT 'open-alerts', count(*) FROM node_reachability_alerts a JOIN nodes n ON n.id = a."nodeId"
 WHERE n.name = :'name' AND a."resolvedAt" IS NULL;
SELECT 'status', status FROM nodes WHERE name = :'name';
SELECT 'key-cleared', ("agentPubKey" IS NULL) FROM nodes WHERE name = :'name';

-- @@ status-node (read) name
SELECT 'row', n.role, n.region, n.status,
       coalesce(round(extract(epoch FROM now() - n."lastHeartbeatAt"))::text, '-'), coalesce(n."agentVersion", '-'),
       ("mirrorHost" IS NOT NULL), ("doorVerifiedAt" IS NOT NULL), coalesce(n."doorPort"::text, '-')
  FROM nodes n WHERE n.name = :'name';
SELECT 'plan', sp.name, count(*) FROM subscription_plans sp
  JOIN "_PlanAllowedRoutes" par ON par."B" = sp.id JOIN routes r ON r.id = par."A"
  JOIN protocol_configs e ON e.id = r."entryProtocolConfigId" JOIN nodes ne ON ne.id = e."nodeId"
  LEFT JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" LEFT JOIN nodes nx ON nx.id = x."nodeId"
 WHERE (ne.name = :'name' AND r."exitProtocolConfigId" IS NULL) OR nx.name = :'name'
 GROUP BY sp.name ORDER BY sp.name;
SELECT 'relay-routes', count(*) FILTER (WHERE r."isEnabled"), count(*) FROM routes r
  JOIN protocol_configs x ON x.id = r."exitProtocolConfigId" JOIN nodes nx ON nx.id = x."nodeId" WHERE nx.name = :'name';
SELECT 'bytes-24h', count(DISTINCT u."subscriptionId") FILTER (WHERE u."bytesUp" > 0),
       coalesce(round(sum(u."bytesUp") / 1e6), 0), coalesce(round(sum(u."bytesDown") / 1e6), 0)
  FROM usage_records u JOIN nodes n ON n.id = u."nodeId"
 WHERE n.name = :'name' AND u."reportedAt" > now() - interval '24 hours';

-- @@ status-names (read)
SELECT name FROM nodes WHERE status <> 'DISABLED' ORDER BY (role = 'RELAY'), name;
