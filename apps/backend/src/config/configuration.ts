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
});
