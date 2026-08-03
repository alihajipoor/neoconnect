-- CreateTable
CREATE TABLE "payment_settings" (
    "id" TEXT NOT NULL,
    "stripeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stripePublishableKey" TEXT,
    "stripeSecretKeyEncrypted" TEXT,
    "stripeWebhookSecretEncrypted" TEXT,
    "nowPaymentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "nowPaymentsApiKeyEncrypted" TEXT,
    "nowPaymentsIpnSecretEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);
