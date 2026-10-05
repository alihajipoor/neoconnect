/** Parses LOGIN_CHALLENGE_GRACE_FAILURES, treating unset/empty/garbage
 * as "leave the default alone". */
function challengeGrace(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export default () => ({
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl: process.env.DATABASE_URL,
  // Where this API is reachable from a customer's browser, used to build
  // links that go in emails. Must be the public address including any
  // path prefix nginx proxies under (/api), not the container's own port.
  publicApiUrl: process.env.PUBLIC_API_URL,
  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
    refreshTtl: process.env.JWT_REFRESH_TTL ?? "7d",
  },
  // Deliberately separate secrets from `jwt` above, not just a different
  // payload shape on the same secret (unlike the MFA challenge token) --
  // customers and admins are different trust domains, and a leaked
  // customer secret shouldn't have any bearing on admin session security
  // or vice versa. See modules/customer-auth.
  customerJwt: {
    accessSecret: process.env.CUSTOMER_JWT_ACCESS_SECRET,
    refreshSecret: process.env.CUSTOMER_JWT_REFRESH_SECRET,
    accessTtl: process.env.CUSTOMER_JWT_ACCESS_TTL ?? "15m",
    refreshTtl: process.env.CUSTOMER_JWT_REFRESH_TTL ?? "7d",
  },
  loginGuard: {
    // How many recent failures a sign-in attempt may carry before a
    // solved proof-of-work challenge becomes mandatory. 0 = required on
    // every attempt, which is the desired end state and the one-variable
    // way to get there.
    //
    // Do NOT set it to 0 while customers are running a client that
    // cannot solve one: no desktop or Android build released so far
    // ships pow.ts, so 0 today refuses their first attempt, not just
    // their sixth. See LoginGuardService's comment for how that was
    // established.
    //
    // An empty value counts as unset, not as 0: docker-compose passes
    // through variables that are merely absent from .env as "", and
    // "" -> Number() -> 0 would silently switch enforcement on and lock
    // out every customer on a released client.
    challengeGraceFailures: challengeGrace(process.env.LOGIN_CHALLENGE_GRACE_FAILURES),
  },
  agentGateway: {
    grpcPort: parseInt(process.env.AGENT_GRPC_PORT ?? "50051", 10),
    // When both are set (production, mounted from the host's certbot
    // directory), the gRPC server terminates real TLS. When unset (local
    // dev, no domain/cert), it falls back to plaintext -- fine for
    // localhost, never for a real deployment.
    tlsCertPath: process.env.AGENT_TLS_CERT_PATH,
    tlsKeyPath: process.env.AGENT_TLS_KEY_PATH,
  },
  billing: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    nowpaymentsApiKey: process.env.NOWPAYMENTS_API_KEY,
    nowpaymentsIpnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
    // No IPN secret: Plisio signs callbacks with the API key itself.
    plisioApiKey: process.env.PLISIO_API_KEY,
  },
  security: {
    // AES-256-GCM key for ProtocolUser.credentialsJson envelope
    // encryption (see modules/protocol-users/credentials-crypto.ts) --
    // 32 raw bytes, hex-encoded (64 hex chars).
    credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
    // HMAC key behind the opaque per-customer exit handles the location
    // list carries (see modules/routes/exit-handle.ts). Any high-entropy
    // string; it is never compared against anything a client sends, only
    // used to mint.
    //
    // Falls back to CREDENTIALS_ENCRYPTION_KEY, under its own derivation
    // label, so that a deployment which has not set the new variable
    // still serves handles rather than silently shipping a dead feature.
    // Safe as key reuse goes -- the derived key is domain-separated and
    // the base secret is one no deployment can rotate casually anyway,
    // since rotating it would strand every stored credential blob -- and
    // stability is what a saved per-game preference depends on.
    //
    // With neither set, every exit handle is null: the client gets no
    // exit vocabulary and reports every placement as unknown, which is
    // the behaviour that shipped before handles existed. An unkeyed
    // handle would be the same string for every customer, which is the
    // one property this must never have, so absent beats improvised.
    //
    // `||`, not `??`. docker-compose.prod.yml passes
    // `EXIT_HANDLE_SECRET: ${EXIT_HANDLE_SECRET:-}`, which sets it to the
    // EMPTY STRING when the .env does not mention it -- and `??` only
    // falls back on undefined, so the empty string won and every handle
    // was null in production from 2026-08-26 (when handles shipped) to
    // 2026-10-05, with CREDENTIALS_ENCRYPTION_KEY sitting right there.
    // Found when the per-ISP attestations, which share this secret,
    // came out absent on the first deploy that carried them.
    exitHandleSecret: process.env.EXIT_HANDLE_SECRET || process.env.CREDENTIALS_ENCRYPTION_KEY,
  },
  integrations: {
    // Shared secret machine callers present as X-Service-Token. Currently
    // just the Discord bot. Guarded routes are read-only and fail closed
    // when this is unset -- see common/guards/service-token.guard.ts.
    serviceToken: process.env.INTEGRATIONS_SERVICE_TOKEN,
  },
  github: {
    // Optional read-only token for the release-feed lookups in
    // modules/updates. Unauthenticated calls get 60 an hour per IP,
    // authenticated ones 5,000 -- so this takes the rate ceiling off the
    // table as a failure mode. Needs no scopes at all: those lookups go
    // to alihajipoor/neoxify-releases, which is public and holds only
    // binaries, and must stay public because customers download from it
    // without credentials. The source repository being private does not
    // change what this token is for. Left unset (local dev, CI) the
    // calls are made anonymously and everything still works, just
    // against the smaller budget.
    token: process.env.GITHUB_API_TOKEN,
  },
  alerting: {
    // Optional generic webhook (Slack/Discord/Telegram-via-adapter/custom
    // endpoint all accept a plain JSON POST) -- alerting is a silent
    // no-op when unset, see modules/alerting.
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
  },
  reachability: {
    // Probing nodes from inside Iran. See modules/reachability.
    //
    // On by default: the condition it catches -- a node that heartbeats
    // happily while being blocked at the border -- is invisible to
    // everything else in this system, and an operator who has to
    // remember to switch monitoring on does not have monitoring.
    enabled: process.env.REACHABILITY_ENABLED !== "false",

    // Vantage country, ISO alpha-2 lowercase. The alerting is written
    // against whatever this is rather than against Iran specifically,
    // so a second country needs configuration rather than code.
    country: (process.env.REACHABILITY_COUNTRY ?? "ir").toLowerCase(),

    // The port probed. 443 because that is where the REALITY and TLS
    // inbounds live and what a blocked customer is failing to reach;
    // filtering is per IP *and* port, so this is not an arbitrary pick.
    port: Number(process.env.REACHABILITY_PORT ?? 443),

    // Consecutive failing cycles before the operator is emailed. Two, at
    // the default half-hourly cadence, means roughly an hour of genuine
    // unreachability -- long enough that a single bad cycle at the probe
    // provider cannot page anyone, short enough to matter.
    failuresBeforeAlert: Number(process.env.REACHABILITY_FAILURES_BEFORE_ALERT ?? 2),

    // How long probe history is kept. It is diagnostic, not accounting.
    retentionDays: Number(process.env.REACHABILITY_RETENTION_DAYS ?? 30),

    // Comma-separated override for who gets alerted. Unset, every
    // SUPERADMIN in admin_users is mailed, which is the right default
    // precisely because it needs no maintenance.
    recipients: process.env.REACHABILITY_ALERT_EMAILS,
  },
  asn: {
    // Which network (autonomous system) a caller is on, for the per-ISP
    // recommendations in the location picker. See modules/network-identity.
    //
    // An offline table rather than a lookup service: nothing about a
    // customer's address leaves this process, no request waits on a
    // third party, and the dataset (iptoasn.com, public domain under
    // PDDL 1.0) costs nothing to use or redistribute. It is fetched once
    // a day, not per request.
    //
    // Off under test, so a test run never reaches the internet. Off
    // entirely with ASN_LOOKUP_ENABLED=false, which leaves every ASN
    // null: no tags in the picker, nothing else changes.
    enabled: process.env.ASN_LOOKUP_ENABLED !== "false" && process.env.NODE_ENV !== "test",
    // "none" disables the download and uses only the file at
    // `datasetPath` -- for a host that cannot reach iptoasn.com and has
    // the file put there by other means. Not the empty string for that:
    // Compose's `${ASN_DATASET_URL:-}` passes an unset variable through
    // as empty, and that must mean "default", not "off".
    datasetUrl:
      process.env.ASN_DATASET_URL === "none"
        ? ""
        : process.env.ASN_DATASET_URL || "https://iptoasn.com/data/ip2asn-combined.tsv.gz",
    // Where the downloaded file is kept, so a restart with the download
    // unreachable still has yesterday's table rather than none.
    datasetPath: process.env.ASN_DATASET_PATH,
  },
});
