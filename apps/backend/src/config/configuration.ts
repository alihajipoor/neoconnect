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
    // table as a failure mode. Needs no scopes at all: the repo is
    // public and only public release metadata is read. Left unset (local
    // dev, CI) the calls are made anonymously and everything still
    // works, just against the smaller budget.
    token: process.env.GITHUB_API_TOKEN,
  },
  alerting: {
    // Optional generic webhook (Slack/Discord/Telegram-via-adapter/custom
    // endpoint all accept a plain JSON POST) -- alerting is a silent
    // no-op when unset, see modules/alerting.
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
  },
});
