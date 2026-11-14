-- admin_trusted_devices: browsers an admin trusted at the two-factor
-- step, so a sign-in there asks for the password but not the code
-- (TrustedDevicesService). Only the SHA-256 of each browser's token is
-- stored.
--
-- Additive only: one new, empty table. No existing column changes. The
-- foreign key cascades, so deleting an admin takes its devices with it,
-- and a backend rolled back to before this table (which knows nothing of
-- it) can still delete an admin. Adding it to an empty table takes a
-- brief lock on admin_users and validates nothing.

-- CreateTable
CREATE TABLE "admin_trusted_devices" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_trusted_devices_tokenHash_key" ON "admin_trusted_devices"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_trusted_devices_adminId_createdAt_idx" ON "admin_trusted_devices"("adminId", "createdAt");

-- AddForeignKey
ALTER TABLE "admin_trusted_devices" ADD CONSTRAINT "admin_trusted_devices_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
