-- Community links, served so they can change without an app release.
-- Additive: one new table, nothing existing touched.
CREATE TABLE "app_links" (
    "id" TEXT NOT NULL,
    "websiteUrl" TEXT,
    "discordUrl" TEXT,
    "instagramUrl" TEXT,
    "telegramUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "app_links_pkey" PRIMARY KEY ("id")
);
