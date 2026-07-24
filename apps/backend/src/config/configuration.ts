export default () => ({
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl: process.env.DATABASE_URL,
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
  },
  security: {
    // AES-256-GCM key for ProtocolUser.credentialsJson envelope
    // encryption (see modules/protocol-users/credentials-crypto.ts) --
    // 32 raw bytes, hex-encoded (64 hex chars).
    credentialsEncryptionKey: process.env.CREDENTIALS_ENCRYPTION_KEY,
  },
  alerting: {
    // Optional generic webhook (Slack/Discord/Telegram-via-adapter/custom
    // endpoint all accept a plain JSON POST) -- alerting is a silent
    // no-op when unset, see modules/alerting.
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
  },
});
