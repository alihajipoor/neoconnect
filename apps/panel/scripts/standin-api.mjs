#!/usr/bin/env node
// DEV ONLY: a stand-in for the backend API, so the panel's pages can be
// rendered and measured with no real backend and no real data.
//
// Every answer is invented: example.com addresses, 192.0.2.x (TEST-NET-1)
// IPs, made-up names. The shapes follow src/lib/types.ts, which mirrors
// the backend's responses. Content is a realistic mix -- most emails 18 to
// 30 characters; names, plans, statuses, dates and numbers varied; some rows
// expired, suspended or offline -- with a few deliberately awkward values
// (very long emails, names and numbers) mixed in. A list made only of the
// awkward ones hides what an ordinary row looks like on a phone.
//
//   node scripts/standin-api.mjs [--port 4999]
//
// GET /__variant?empty=1 switches every list to empty (and back with
// empty=0), so one running server serves both variants. Writes (POST,
// PATCH, PUT, DELETE) answer a plausible success and change nothing.

import http from "node:http";

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const pad = (n, w = 4) => String(n).padStart(w, "0");

const state = { empty: false };

// ------------------------------------------------------------- fixtures

const LONG_EMAIL = "maximilian.alexander-hutchinson.support+refunds-2026@subdomain.example.com";
const FIRST = ["sara", "ali", "emma", "reza", "nima", "leila", "omid", "jonas", "arash", "neda", "kian", "mina", "lucas", "shirin", "farhad", "yasmin", "babak", "chloe", "pouya", "taraneh", "daniel", "hana", "milad"];
const LAST = ["ahmadi", "larsen", "karimi", "novak", "rahimi", "moradi", "schmidt", "jafari", "sadeghi", "nazari", "bauer", "farahani", "rostami", "kazemi", "bahrami", "ebrahimi", "silva"];
/** Mostly 18 to 30 characters, in the shapes people really use; a few very
 * long ones and one very short. */
const email = (i) => {
  if (i === 2 || i === 57) return LONG_EMAIL;
  if (i === 9) return "office.network.admin.for.the.whole-building@subdomain.example.com";
  if (i === 30) return "al@example.com";
  const f = FIRST[i % FIRST.length];
  const l = LAST[(i * 7) % LAST.length];
  switch (i % 6) {
    case 0:
    case 1:
    case 2:
      return `${f}.${l}@example.com`;
    case 3:
      return `${f}${1980 + ((i * 13) % 40)}@example.net`;
    case 4:
      return `${f[0]}${l}@example.org`;
    default:
      return `${f}.${l}.work@example.com`;
  }
};

const NODE_NAMES = [
  "germany-3",
  "finland-4",
  "turkey-1",
  "netherlands-2",
  "uk-1",
  "france-1",
  "sweden-1",
  "ir-relay-2-tehran-backup-route",
  "germany-2",
  "singapore-1",
];
const nodes = NODE_NAMES.map((name, i) => ({
  id: `node_standin_${pad(i)}`,
  name,
  role: i === 7 ? "RELAY" : i % 3 === 0 ? "EXIT" : "STANDALONE",
  region: ["eu-central", "eu-north", "tr-istanbul", "eu-west", "uk-south", "eu-west-paris", "eu-north-stockholm", "ir-tehran", "eu-central", "ap-southeast"][i],
  publicIp: `192.0.2.${10 + i}`,
  status: ["ONLINE", "ONLINE", "OFFLINE", "PENDING", "ONLINE", "DISABLED", "ONLINE", "ONLINE", "ONLINE", "OFFLINE"][i],
  lastHeartbeatAt: i === 3 ? null : iso(-60_000 * (i + 1) * (i === 2 || i === 9 ? 600 : 1)),
  agentVersion: i === 3 ? null : i === 6 ? "v0.2.12-rc.1+build.20261114" : i % 4 === 1 ? "v0.2.11" : "v0.2.12",
  agentPubKey: i === 3 ? null : "ed25519:STANDINkeyAAAAC3NzaC1lZDI1NTE5AAAAIStandInPublicKeyForLayoutOnly",
  createdAt: iso(-200 * DAY),
  updatedAt: iso(-DAY),
}));

const PROTOCOLS = ["XRAY_VLESS_REALITY", "XRAY_VLESS_TLS", "XRAY_VMESS", "XRAY_TROJAN", "SHADOWSOCKS", "WIREGUARD", "OPENVPN", "IKEV2"];
const protocolConfigs = [];
nodes.forEach((node, n) => {
  PROTOCOLS.slice(0, 4 + (n % 4)).forEach((protocol, p) => {
    protocolConfigs.push({
      id: `pc_standin_${pad(n)}_${p}`,
      nodeId: node.id,
      protocol,
      listenPort: 443 + p * 1000 + n,
      transport: protocol.startsWith("XRAY") ? ["TCP", "WS", "GRPC"][p % 3] : null,
      inboundTag: p % 3 === 1 ? `vless-tls-ws-exit-${node.name}-inbound` : null,
      publicParamsJson: {
        sni: "www.a-very-long-server-name-indication.example.com",
        publicKey: "STANDINx25519PublicKeyValueThatIsLongAndUnbreakable0123456789abcdef",
        shortId: "0123456789abcdef",
      },
      isEnabled: p !== 2,
      createdAt: iso(-100 * DAY),
      updatedAt: iso(-2 * DAY),
    });
  });
});

const routes = protocolConfigs.slice(0, 18).map((pc, i) => ({
  id: `route_standin_${pad(i)}`,
  name: i === 0 ? "Backup route via germany-3 to finland-4 exit, REALITY over TCP" : `${nodes.find((n) => n.id === pc.nodeId).name} ${["Stealth", "TLS", "VMess", "Trojan", "Shadowsocks", "WireGuard", "OpenVPN"][i % 7]}`,
  entryProtocolConfigId: pc.id,
  exitProtocolConfigId: i % 4 === 0 ? protocolConfigs[(i + 9) % protocolConfigs.length].id : null,
  isEnabled: i % 5 !== 4,
  createdAt: iso(-90 * DAY),
  updatedAt: iso(-3 * DAY),
  protocolUserCount: [412, 87, 1530, 3, 0, 268, 941][i % 7],
}));

const PLAN_NAMES = [
  "Ultimate Max 12 months, every country and gaming",
  "Basic 1 month",
  "Standard 3 months",
  "Internal test",
  "Free trial",
  "Ultimate 28",
];
const plans = PLAN_NAMES.map((name, i) => ({
  id: `plan_standin_${pad(i)}`,
  name,
  dataCapBytes: [null, "53687091200", "214748364800", null, "5368709120", "107374182400"][i],
  durationDays: [365, 30, 90, 7, 3, 28][i],
  priceUsd: ["129.00", "4.99", "12.00", "0.00", "0.00", "19.95"][i],
  maxConcurrentConnections: i === 0 ? null : 3,
  maxDownloadMbps: i === 1 ? 100 : null,
  maxUploadMbps: i === 1 ? 20 : null,
  protocolsAllowed: PROTOCOLS.slice(0, 3 + i),
  isActive: i !== 3,
  isPurchasable: i < 3,
  defaultRouteId: routes[i].id,
  allowedRoutes: routes.slice(0, 4 + i * 2).map((r) => ({ id: r.id })),
  createdAt: iso(-300 * DAY),
  updatedAt: iso(-5 * DAY),
}));

const admins = [
  { email: "owner@example.com", role: "SUPERADMIN", mfaEnabled: true },
  { email: "support.agent.with.a.long.address@example.com", role: "SUPPORT", mfaEnabled: false },
  { email: "billing@example.com", role: "BILLING", mfaEnabled: true },
  { email: "reseller.partner.shop-number-one@example.com", role: "RESELLER", mfaEnabled: false },
  ...Array.from({ length: 8 }, (_, i) => ({ email: email(i * 5 + 1), role: i % 3 ? "SUPPORT" : "BILLING", mfaEnabled: i % 2 === 0 })),
].map((a, i) => ({ id: `adm_standin_${pad(i)}`, ...a, createdAt: iso(-400 * DAY + i * DAY), updatedAt: iso(-DAY) }));

const customers = Array.from({ length: 100 }, (_, i) => ({
  id: `cus_standin_${pad(i + 1)}`,
  email: email(i),
  telegramId: i % 3 === 0 ? null : i === 4 ? "@a_rather_long_telegram_handle_2026" : `@${FIRST[i % FIRST.length]}${i}`,
  referralCode: i % 4 === 0 ? null : `NX${(i * 7919).toString(36).toUpperCase().padStart(5, "0")}`,
  status: i % 9 === 4 || i === 3 ? "DISABLED" : "ACTIVE",
  emailVerifiedAt: i % 5 === 0 ? null : iso(-30 * DAY),
  createdAt: iso(-(i * 3 + (i % 5)) * DAY),
  updatedAt: iso(-i * DAY + 1000),
  signupChannel: ["NORMAL", "RELAY", "SOCIAL", null][i % 4],
  relayUnverifiedSince: i % 4 === 1 && i % 5 === 0 ? iso(-2 * DAY) : null,
  recoveryCodeSetAt: i % 4 === 1 ? iso(-3 * DAY) : null,
}));

const subscriptions = (customerId) =>
  plans.slice(0, 4).map((plan, i) => ({
    id: `sub_standin_${pad(i)}`,
    customerId,
    planId: plan.id,
    primaryNodeId: nodes[i].id,
    status: ["ACTIVE", "SUSPENDED", "EXPIRED", "PENDING"][i],
    startAt: iso(-20 * DAY),
    expireAt: iso([212, 9, -4, 30][i] * DAY),
    dataCapBytes: plan.dataCapBytes,
    dataUsedBytes: ["18253611008", "51539607552", "4831838208", "0"][i],
    autoRenew: i === 0,
    createdAt: iso(-20 * DAY),
    updatedAt: iso(-DAY),
  }));

const invoiceRows = Array.from({ length: 100 }, (_, i) => ({
  id: `inv_standin_${pad(i)}`,
  invoiceNumber: `NX-2026-${pad(100000 + i, 8)}`,
  planNameSnapshot: PLAN_NAMES[i % PLAN_NAMES.length],
  amountUsd: ["4.99", "12.00", "19.95", "129.00", "4.99", "12.00"][i % 6],
  currency: "USD",
  status: ["PAID", "ISSUED", "OVERDUE", "VOID", "DRAFT"][i % 5],
  issuedAt: iso(-(i * 2 + (i % 3)) * DAY),
  customer: { email: email(i) },
  paymentTransaction: i % 3 === 0 ? null : { provider: ["STRIPE", "NOWPAYMENTS", "PLISIO_CRYPTO_GATEWAY"][i % 3] },
}));

const voucherRows = Array.from({ length: 60 }, (_, i) => ({
  id: `vch_standin_${pad(i)}`,
  code: i === 0 ? "ULTIMATE-MAX-GIFT-2026-ABCDEFGHIJKLMNOP" : `NX-${(i * 104729).toString(36).toUpperCase().padStart(6, "0")}`,
  planId: plans[i % plans.length].id,
  plan: { id: plans[i % plans.length].id, name: plans[i % plans.length].name, durationDays: 30, priceUsd: "4.99" },
  maxRedemptions: i % 3 === 0 ? null : [1, 50, 200][i % 3],
  redeemedCount: i % 3 === 1 ? 1 : (i * 7) % 60,
  expiresAt: i % 2 ? iso((i % 5 === 1 ? -3 : 30) * DAY) : null,
  isActive: i % 4 !== 3,
  note: i % 7 === 1 ? "Given to the partner shop for the spring campaign; check with billing before reissuing" : i % 3 === 0 ? "Spring campaign" : null,
  _count: { redemptions: i % 3 === 1 ? 1 : (i * 7) % 60 },
  createdAt: iso(-i * DAY),
  updatedAt: iso(-i * DAY),
}));

const ticketRows = (status) =>
  Array.from({ length: 25 }, (_, i) => ({
    id: `tkt_standin_${status.toLowerCase()}_${pad(i + 1)}`,
    subject:
      i === 0
        ? "The app says connected but no website opens on my home network since yesterday evening, please help"
        : ["Cannot connect on mobile data", "Refund for last month", "How do I add a second device?", "Payment went through but no plan", "Slow speeds in the evening", "Change my email address"][i % 6],
    status,
    lastMessageAt: iso(-i * 3_600_000),
    customer: { id: customers[i].id, email: customers[i].email },
    _count: { messages: [1, 3, 2, 7, 4, 12][i % 6] },
  }));

const ticket = (id) => ({
  id,
  customerId: customers[0].id,
  customer: { id: customers[0].id, email: customers[0].email },
  subject: ticketRows("OPEN")[0].subject,
  status: "OPEN",
  lastMessageAt: iso(-3_600_000),
  createdAt: iso(-2 * DAY),
  updatedAt: iso(-3_600_000),
  messages: Array.from({ length: 12 }, (_, i) => ({
    id: `msg_standin_${pad(i)}`,
    ticketId: id,
    fromAdmin: i % 2 === 1,
    body:
      i === 0
        ? "Hello, the app shows Connected but nothing loads. Here is what it printed: https://www.a-very-long-example-domain-name.example.com/path/that/does/not/break/anywhere/0123456789abcdefghijklmnopqrstuvwxyz"
        : `Message ${i}. ${"Some ordinary words that make a paragraph wrap across a few lines. ".repeat(1 + (i % 3))}`,
    createdAt: iso(-2 * DAY + i * 3_600_000),
  })),
  _count: { messages: 12 },
});

const PLATFORMS = ["windows", "android", "ios", "macos", "linux"];
const OUTCOMES = ["SUCCESS", "CONTROL_PLANE_UNREACHABLE", "REJECTED", "NOT_CARRYING_TRAFFIC", "ENGINE_FAILED", "PERMISSION_DENIED", "OTHER"];
const clientAttempts = Array.from({ length: 100 }, (_, i) => ({
  id: `att_standin_${pad(i)}`,
  kind: ["REGISTER", "SIGN_IN", "CONNECT", "SESSION"][i % 4],
  outcome: OUTCOMES[i % OUTCOMES.length],
  customerId: i % 6 === 0 ? null : customers[i % customers.length].id,
  customer: i % 6 === 0 ? null : { id: customers[i % customers.length].id, email: customers[i % customers.length].email },
  platform: PLATFORMS[i % PLATFORMS.length],
  appVersion: i % 2 ? "0.9.64" : "0.2.35-beta.4+build.20261114",
  routeId: i % 3 ? routes[i % routes.length].id : null,
  protocol: i % 3 ? PROTOCOLS[i % PROTOCOLS.length] : null,
  attemptsJson:
    i % 4 === 2
      ? PROTOCOLS.slice(0, 6).map((protocol, r) => ({
          protocol,
          result: r === 5 ? "connected" : "timeout after 15000 ms: tls handshake did not complete",
          routeId: routes[r].id,
          carried: r === 5,
          downKbps: r === 5 ? 123456 : undefined,
          upKbps: r === 5 ? 65432 : undefined,
        }))
      : null,
  apiEndpoint: i % 7 === 1 ? "https://api.example.com -> dns timeout; https://api-backup.example.com -> tcp reset; 192.0.2.44:443 -> tls alert 40" : null,
  reason: i % 5 === 1 ? "Engine exited with code 23: failed to listen on 127.0.0.1:10808, address already in use by another process" : null,
  ip: `192.0.2.${100 + (i % 100)}`,
  occurredAt: i % 3 === 0 ? iso(-i * 600_000 - 7_200_000) : null,
  asn: i % 4 ? 197207 + i : null,
  sessionSeconds: i % 4 === 3 ? 98765 : null,
  createdAt: iso(-i * 600_000),
}));

const activity = () => ({
  now: {
    lastSeenAt: iso(-120_000),
    connected: { nodeName: NODE_NAMES[0], protocol: "XRAY_VLESS_REALITY", lastTrafficAt: iso(-60_000), bytesLast10Min: "98765432109" },
  },
  devices: Array.from({ length: 6 }, (_, i) => ({
    sessionId: `ses_standin_${pad(i)}`,
    platform: [...PLATFORMS, null][i],
    label: i === 0 ? "Maximilian's very long gaming desktop computer name in the living room" : `Device ${i}`,
    channel: i % 2 ? "RELAY" : "NORMAL",
    createdAt: iso(-10 * DAY),
    lastUsedAt: iso(-i * 3_600_000),
    revoked: i === 5,
    appVersion: i === 5 ? null : "0.9.64",
  })),
  attempts: Array.from({ length: 50 }, (_, i) => ({
    id: `catt_standin_${pad(i)}`,
    at: iso(-i * 900_000),
    kind: ["CONNECT", "SIGN_IN", "SESSION"][i % 3],
    outcome: OUTCOMES[i % OUTCOMES.length],
    platform: PLATFORMS[i % PLATFORMS.length],
    appVersion: "0.9.64",
    network: i % 4 ? { asn: 197207, name: "Mobile Communication Company of a Very Long Operator Name PJS" } : null,
    ip: i % 5 === 0 ? null : `192.0.2.${150 + (i % 50)}`,
    throughServer: i % 10 === 5 ? NODE_NAMES[0] : null,
    noAddress: i % 5 === 0 ? (i % 10 ? "relay" : "erased") : null,
    server: i % 7 === 0 ? NODE_NAMES[1] : null,
    protocol: i % 3 ? PROTOCOLS[i % PROTOCOLS.length] : null,
    reason: i % 4 === 1 ? "tls: handshake timeout after 15000 ms while dialling 192.0.2.11:443 through the relay" : null,
    sessionSeconds: i % 3 === 2 ? 98765 : null,
    rungs:
      i % 3 === 0
        ? PROTOCOLS.slice(0, 5).map((protocol, r) => ({
            protocol,
            server: NODE_NAMES[r],
            result: r === 4 ? "connected" : "timeout",
            carried: r === 4 ? true : null,
            downKbps: r === 4 ? 123456 : null,
            upKbps: r === 4 ? 65432 : null,
          }))
        : [],
  })),
  traffic: Array.from({ length: 28 }, (_, i) => ({
    day: new Date(NOW - Math.floor(i / 2) * DAY).toISOString().slice(0, 10),
    nodeName: NODE_NAMES[i % NODE_NAMES.length],
    protocol: PROTOCOLS[i % PROTOCOLS.length],
    bytesUp: String(((i * 37) % 90 + 3) * 1_048_576),
    bytesDown: String(((i * 53) % 900 + 40) * 1_048_576),
  })),
});

const ispTraffic = (i) => ({
  bytesUp: String(1234567890123 * (i + 1)),
  bytesDown: String(98765432109876 * (i + 1)),
  customers: 1234 + i,
  withUpload: 987 + i,
  typicalBytes: i % 3 ? "1234567890" : null,
});
const ispRoute = (i) => ({
  routeId: routes[i % routes.length].id,
  routeName: routes[i % routes.length].name,
  nodeName: NODE_NAMES[i % NODE_NAMES.length],
  protocol: PROTOCOLS[i % PROTOCOLS.length],
  transport: i % 2 ? "WS" : "TCP",
  isRelay: i % 3 === 0,
});
const isp = () => ({
  windowHours: 72,
  truncated: true,
  networks: Array.from({ length: 12 }, (_, n) => ({
    asn: 197207 + n * 1000,
    org: n === 0 ? "Mobile Communication Company of a Very Long Operator Name PJS" : n % 4 === 3 ? null : ["Example Telecom", "Northwind Mobile", "Contoso Fibre", "Fabrikam Net"][n % 4],
    routes: Array.from({ length: 6 }, (_, r) => ({
      ...ispRoute(r + n),
      tried: [48, 31, 12, 7, 5, 2][r],
      carried: [41, 18, 11, 2, 5, 0][r],
      sustained: [37, 12, 9, 1, 4, 0][r],
      worked: [35, 11, 9, 1, 3, 0][r],
      tag: r % 3 === 0 ? { code: r % 2 ? "failingOnYourIsp" : "worksOnYourIsp", customers: 123, outOf: 456, windowHours: 72 } : null,
      traffic: ispTraffic(r),
    })),
  })),
  unattributed: Array.from({ length: 5 }, (_, i) => ({ ...ispRoute(i), traffic: ispTraffic(i) })),
  withoutRoute: { bytesUp: "123456789012345", bytesDown: "987654321098765432", customers: 4321 },
  dataset: { loaded: true, ranges: 123456, loadedAt: iso(-DAY) },
});

const reachability = () =>
  nodes.map((node, i) => ({
    nodeId: node.id,
    name: node.name,
    region: node.region,
    agentStatus: node.status,
    verdict: [null, "REACHABLE", "DEGRADED", "UNREACHABLE", "INCONCLUSIVE"][i % 5],
    probesOk: i % 5 === 0 ? null : 3,
    probesAnswered: i % 5 === 0 ? null : 7,
    medianLatencyMs: i % 5 === 0 ? null : 1234,
    checkedAt: i % 5 === 0 ? null : iso(-600_000),
    port: 443,
    detail: Array.from({ length: i % 5 === 0 ? 0 : 7 }, (_, p) => ({
      vantage: `ir${p + 1}.vantage-point-with-a-long-hostname.example.net`,
      asn: p % 2 ? `AS${197207 + p}` : null,
      city: p % 3 ? "Tehran" : null,
      ok: p % 2 === 0,
      latencyMs: p % 2 === 0 ? 234 : null,
      error: p % 2 ? "Connection timed out after 10000 ms while waiting for the TCP handshake" : null,
    })),
    openSince: i % 5 === 3 ? iso(-DAY) : null,
    alertDelivered: i % 5 === 3 ? false : null,
  }));

const FAMILIES = ["client", "traffic", "probe", "inside"];
const incident = (i, open) => ({
  id: `inc_standin_${open ? "open" : "closed"}_${pad(i)}`,
  nodeId: nodes[i % nodes.length].id,
  status: open ? "OPEN" : ["CLEARED", "REPLACED", "RETIRED"][i % 3],
  verdict: i % 2 ? "LIKELY_BLOCKED" : "SUSPECT",
  openedAt: iso(-3 * DAY),
  lastSeenAt: iso(-600_000),
  likelyAt: i % 2 ? iso(-2 * DAY) : null,
  closedAt: open ? null : iso(-DAY),
  reopenedAt: i === 1 ? iso(-DAY / 2) : null,
  evidenceJson: {
    evaluatedAt: iso(-600_000),
    current: i % 2 ? "LIKELY_BLOCKED" : "SUSPECT",
    reason: "Connects fail on 7 of 9 Iranian networks while the same networks reach other servers; probes from inside time out",
    since: { client: iso(-3 * DAY), probe: iso(-2 * DAY) },
    families: FAMILIES.map((family, f) => ({
      family,
      firing: f % 2 === 0,
      thin: f === 3,
      healthy: f === 1,
      summary: `${family}: 1234 tried, 987 failed against a baseline of 12 percent over the last six hours`,
      networks: Array.from({ length: 4 }, (_, n) => ({
        asn: 197207 + n,
        org: n === 0 ? "Mobile Communication Company of a Very Long Operator Name PJS" : n === 3 ? null : `Operator ${n}`,
        tried: 1234,
        failed: 987,
        baseline: n % 2 ? 0.12 : null,
        failing: n % 2 === 0,
      })),
    })),
    outage: i === 0 ? "A country-wide outage on 2026-11-13 is likely; signals from every server dropped together" : null,
    blockType: ["address", "protocol", "tunnel", null][i % 4],
    thinResidential: i === 2,
    country: "ir",
    clearing: open && i === 2 ? "shown working again" : null,
  },
  pagedAt: i % 2 ? iso(-2 * DAY) : null,
  pageError: i === 2 ? "Webhook answered 502 Bad Gateway from https://hooks.example.com/very/long/path/to/the/pager" : null,
  pageAttempts: 3,
  remindedAt: null,
  recoveryNotifiedAt: null,
  keptAt: i === 3 ? iso(-DAY) : null,
  snoozedUntil: i === 4 ? iso(DAY) : null,
  actedBy: i === 3 ? "owner@example.com" : null,
  actionNote: i === 3 ? "Kept: the provider says the address is clean, waiting one more day before replacing" : null,
  node: { name: nodes[i % nodes.length].name, region: nodes[i % nodes.length].region, status: nodes[i % nodes.length].status },
});

const gameProfileRows = Array.from({ length: 100 }, (_, i) => ({
  id: `game_standin_${pad(i)}`,
  slug: i === 0 ? "a-very-long-game-slug-that-goes-on-and-on-forever" : `game-${pad(i)}`,
  displayName: i === 0 ? "The Extraordinarily Long Title of a Game: Remastered Ultimate Collector's Edition" : `${["Starfall", "Iron", "Kingdoms of", "Last", "Neon", "Frost"][i % 6]} ${["Arena", "Legends", "Ash", "Outpost", "Drift", "Tactics", "Online"][i % 7]}`,
  iconKey: i % 3 ? `icon-${i}` : null,
  publisher: i % 4 ? ["Northwind Games", "Example Interactive", "Some Publisher Interactive Entertainment Worldwide Ltd."][i % 3] : null,
  hostnames: ["launcher.game.example.com", "login.game.example.com", "store.game.example.com", "account-management.game.example.com"],
  excludeHostnames: i % 2 ? ["cdn-patch-download.game.example.com"] : [],
  destinationAsn: i % 5 ? null : "AS57976",
  prefixComplete: i % 2 === 0,
  canaryHostname: i % 3 ? "login.game.example.com" : null,
  sortOrder: i,
  isActive: i % 6 !== 5,
  createdAt: iso(-50 * DAY),
  updatedAt: iso(-DAY),
}));
const gameProfile = (id) => ({
  ...(gameProfileRows.find((g) => g.id === id) ?? gameProfileRows[0]),
  processNames: ["Game.exe", "GameLauncher-x64-Shipping.exe"],
  destinationCidrs: ["192.0.2.0/24"],
  notes: "Patch CDN left direct on purpose; a multi-gigabyte update through a node eats a metered plan.",
});

const resolvers = nodes.slice(0, 5).map((node, i) => ({
  id: `res_standin_${pad(i)}`,
  nodeId: node.id,
  node: { id: node.id, name: node.name, region: node.region },
  dohHost: "doh.a-long-resolver-hostname-for-gaming.example.com",
  dohPort: 8443,
  proxyIp: `192.0.2.${60 + i}`,
  proxyPort: 443,
  isEnabled: i !== 2,
  confirmedAt: i % 2 ? null : iso(-600_000),
  lastError: i % 2 ? "Probe failed: certificate for doh.example.com expired 2026-11-01T00:00:00Z" : null,
  createdAt: iso(-30 * DAY),
  updatedAt: iso(-DAY),
}));

const resellerVouchers = Array.from({ length: 50 }, (_, i) => ({
  id: `rv_standin_${pad(i)}`,
  code: `RS-${pad(i, 8)}-STANDIN-CODE`,
  plan: { id: plans[i % plans.length].id, name: plans[i % plans.length].name },
  recipientEmail: i % 3 ? email(i) : null,
  createdAt: iso(-i * DAY),
  expiresAt: i % 2 ? iso(60 * DAY) : null,
  isActive: i % 5 !== 4,
  redeemedCount: i % 2,
  redeemedAt: i % 2 ? iso(-i * DAY + 3600_000) : null,
  canRevoke: i % 2 === 0,
}));

const live = () => ({
  at: iso(),
  users: Array.from({ length: 24 }, (_, i) => ({
    customerId: customers[i].id,
    email: customers[i].email,
    nodeName: NODE_NAMES[i % NODE_NAMES.length],
    protocol: PROTOCOLS[i % PROTOCOLS.length],
    lastTrafficAt: iso(-i * 9_000),
    bytesLast10Min: String([254803968, 12582912, 1073741824, 524288, 87031808][i % 5] + i * 4096),
  })),
});

const relayAuth = () => ({
  settings: {
    mode: "AUTO",
    hostingAsns: [16509, 14061, 24940, 16276, 63949, 20473, 8075, 15169, 13335, 396982],
    intranetDeclaredAt: iso(-10 * DAY),
    intranetEndedAt: iso(-9 * DAY),
    suspectedSince: iso(-DAY),
    suspicionAlertedAt: iso(-DAY),
    capsRaisedAt: null,
  },
  tier: "normal",
  caps: { global: 1000000, perNetwork: 50000, hosting: 10 },
  hold: false,
  today: {
    signups: 123456,
    signIns: 654321,
    refusals: 1234,
    rows: Array.from({ length: 10 }, (_, i) => ({
      box: `relay-box-${i}.example.net`,
      asn: 197207 + i,
      org: i === 0 ? "Mobile Communication Company of a Very Long Operator Name PJS" : i % 3 ? `Operator ${i}` : null,
      signups: 12345,
      signIns: 54321,
      refusals: 123,
    })),
  },
  detector: { ir: 1234, other: 4321, irMedian: 12.5, otherMedian: 3.25, holds: true, at: iso(-600_000) },
});

// ---------------------------------------------------------------- routes

const E = (list) => (state.empty ? [] : list);

/** [method, pattern, handler(match, url) -> body | {status, body, total}] */
const ROUTES = [
  ["GET", /^\/auth\/me$/, () => admins[0]],
  ["GET", /^\/admins$/, () => E(admins)],
  ["GET", /^\/customers$/, (m, url) => list(E(customers), url, 123456)],
  ["GET", /^\/customers\/([^/]+)\/activity$/, () => (state.empty ? { now: { lastSeenAt: null, connected: null }, devices: [], attempts: [], traffic: [] } : activity())],
  ["GET", /^\/customers\/([^/]+)$/, (m) => ({ ...customers[0], id: m[1], emailVerifiedAt: null, signupChannel: "RELAY", recoveryCodeSetAt: iso(-DAY) })],
  ["GET", /^\/subscriptions$/, (m, url) => E(subscriptions(url.searchParams.get("customerId") ?? customers[0].id))],
  ["GET", /^\/plans$/, () => E(plans)],
  ["GET", /^\/nodes$/, () => E(nodes)],
  ["GET", /^\/routes$/, () => E(routes)],
  ["GET", /^\/protocol-configs$/, () => E(protocolConfigs)],
  ["GET", /^\/invoices\/summary$/, () => ({
    since: iso(-30 * DAY),
    invoiceCount: state.empty ? 0 : 1287,
    totalUsd: state.empty ? "0.00" : "18436.55",
    byPlan: E(plans.map((p) => ({ name: p.name, amountUsd: ["6450.00", "2994.00", "4320.00", "0.00", "0.00", "4672.55"][plans.indexOf(p)] }))),
    byProvider: E(["STRIPE", "NOWPAYMENTS", "PLISIO_CRYPTO_GATEWAY"].map((provider, i) => ({ provider, amountUsd: ["11204.30", "6012.25", "1220.00"][i] }))),
  })],
  ["GET", /^\/invoices$/, (m, url) => list(E(invoiceRows), url, 98765)],
  ["GET", /^\/vouchers$/, (m, url) => list(E(voucherRows), url, 6000)],
  ["GET", /^\/support\/settings$/, () => ({ acceptingTickets: false, awayMessage: "We are away for the holidays and will answer every message when we are back, usually within a day.", replyWithinHours: 24, updatedAt: iso(-DAY) })],
  ["GET", /^\/support\/tickets\/([^/]+)$/, (m) => ticket(m[1])],
  ["GET", /^\/support\/tickets$/, (m, url) => list(E(ticketRows(url.searchParams.get("status") ?? "OPEN")), url, 250)],
  ["GET", /^\/client-attempts\/summary$/, () => E(OUTCOMES.map((outcome, i) => ({ outcome, count: 123456 - i * 1000 })))],
  ["GET", /^\/client-attempts$/, () => E(clientAttempts)],
  ["GET", /^\/reachability$/, () => E(reachability())],
  ["GET", /^\/block-watch$/, () => ({
    mode: "notify",
    country: "ir",
    lastCycleAt: iso(-600_000),
    open: E(Array.from({ length: 5 }, (_, i) => incident(i, true))),
    closed: E(Array.from({ length: 6 }, (_, i) => incident(i, false))),
  })],
  ["GET", /^\/isp-recommendations$/, () => (state.empty ? { ...isp(), truncated: false, networks: [], unattributed: [], withoutRoute: { bytesUp: "0", bytesDown: "0", customers: 0 } } : isp())],
  ["GET", /^\/monitor\/live$/, () => (state.empty ? { at: iso(), users: [] } : live())],
  ["GET", /^\/gaming\/profiles\/([^/]+)$/, (m) => gameProfile(m[1])],
  ["GET", /^\/gaming\/profiles$/, (m, url) => list(E(gameProfileRows), url, 1480)],
  ["GET", /^\/gaming\/resolvers$/, () => E(resolvers)],
  ["GET", /^\/gaming\/plan-features$/, () => E(plans.map((p, i) => ({ planId: p.id, planName: p.name, features: i % 2 ? ["GAMING_DNS"] : ["GAMING_DNS", "GAMING_PRIVATE_EXIT"] })))],
  ["GET", /^\/reseller\/balances$/, () => E(plans.map((p, i) => ({ plan: { id: p.id, name: p.name, priceUsd: p.priceUsd, durationDays: p.durationDays, isActive: i !== 3 }, balance: 123456 - i })))],
  ["GET", /^\/reseller\/vouchers$/, (m, url) => list(E(resellerVouchers), url, 5000)],
  ["GET", /^\/resellers$/, () => E(Array.from({ length: 12 }, (_, i) => ({
    id: `adm_reseller_${pad(i)}`,
    email: i === 0 ? LONG_EMAIL : email(i + 40),
    createdAt: iso(-i * 10 * DAY),
    balances: plans.slice(0, 1 + (i % 5)).map((p, b) => ({ balance: [40, 12, 0, 250, 3][b], plan: { id: p.id, name: p.name } })),
    vouchersIssued: [1290, 45, 0, 312, 8][i % 5],
  })))],
  ["GET", /^\/free-trial-settings$/, () => ({ id: "fts_standin", enabled: true, trialPlanId: plans[4].id, trialRouteId: routes[0].id, updatedAt: iso(-DAY) })],
  ["GET", /^\/referral-settings$/, () => ({ id: "rfs_standin", enabled: true, rewardPlanId: plans[0].id, loyalFriendMonths: 3, friendsRequired: 5, friendMonths: 1, rewardDays: 30, updatedAt: iso(-DAY) })],
  ["GET", /^\/email-settings$/, () => ({ id: "ems_standin", enabled: true, host: "smtp.a-long-mail-provider-hostname.example.com", port: 587, secure: false, username: "connect-mailer-account@example.com", fromAddress: "Neoxify Connect <connect-mailer-account@example.com>", updatedAt: iso(-DAY) })],
  ["GET", /^\/payment-settings$/, () => ({ id: "pys_standin", stripeEnabled: true, stripePublishableKey: "pk_test_STANDIN0000000000000000000000000000000000000000000000", stripeSecretKeySet: true, stripeWebhookSecretSet: false, nowPaymentsEnabled: true, nowPaymentsApiKeySet: true, nowPaymentsIpnSecretSet: false, plisioEnabled: false, plisioApiKeySet: false, updatedAt: iso(-DAY) })],
  ["GET", /^\/app-links$/, () => ({ websiteUrl: "https://www.example.com/a/long/path/to/the/website/landing-page?utm_source=app", discordUrl: "https://discord.example.com/invite/abcdefghijklmnop", instagramUrl: null, telegramUrl: "https://t.example.com/a_very_long_channel_name_for_announcements" })],
  ["GET", /^\/relay-auth$/, () => relayAuth()],
  ["POST", /^\/auth\/refresh$/, () => ({ status: 401, body: { message: "stand-in: no refresh" } })],
  ["POST", /^\/auth\/mfa\/setup$/, () => ({ secret: "STANDINSECRETBASE32AAAAAAAAAAAA", otpauthUrl: "otpauth://totp/Neoxify:owner@example.com?secret=STANDINSECRETBASE32AAAAAAAAAAAA", qrCodeDataUrl: "" })],
  ["POST", /^\/nodes\/([^/]+)\/enrollment-tokens$/, () => ({ token: "standin-enrollment-token-0123456789abcdefghijklmnopqrstuvwxyz", expiresAt: iso(DAY), installCommand: "curl -fsSL https://get.example.com/install.sh | sudo bash -s -- --token standin-enrollment-token-0123456789abcdefghijklmnopqrstuvwxyz" })],
];

function list(items, url, total) {
  const take = Number(url.searchParams.get("take") ?? 100) || 100;
  const skip = Number(url.searchParams.get("skip") ?? 0) || 0;
  return { body: items.slice(skip, skip + take), total: state.empty ? 0 : Math.max(total, items.length) };
}

// ---------------------------------------------------------------- server

export function startStandin({ port = 4999, host = "127.0.0.1", log = false } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname === "/__variant") {
      if (url.searchParams.has("empty")) state.empty = url.searchParams.get("empty") === "1";
      return send(200, { ...state });
    }
    // Drain the body; nothing is stored.
    req.resume();
    req.on("end", () => {
      const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (log) console.log(req.method, url.pathname + url.search, route ? "" : "(default)");
      if (!route) {
        if (req.method === "GET") return send(404, { message: `stand-in has no answer for GET ${url.pathname}` });
        // Any write: a plausible success that changes nothing.
        return send(req.method === "DELETE" ? 200 : 201, { ok: true, deleted: true, id: "standin_write" });
      }
      const out = route[2](url.pathname.match(route[1]), url);
      if (out && typeof out === "object" && !Array.isArray(out) && "body" in out && ("total" in out || "status" in out)) {
        const headers = "total" in out ? { "X-Total-Count": String(out.total), "Access-Control-Expose-Headers": "X-Total-Count" } : {};
        return send(out.status ?? 200, out.body, headers);
      }
      return send(200, out);
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("standin-api.mjs")) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 4999;
  await startStandin({ port, log: process.argv.includes("--log") });
  console.log(`stand-in API on http://127.0.0.1:${port}`);
}
