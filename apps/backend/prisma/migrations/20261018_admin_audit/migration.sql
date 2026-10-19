-- Every change an admin makes through the API (AdminAuditInterceptor).
CREATE TABLE "admin_audit_entries" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "email" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_entries_createdAt_idx" ON "admin_audit_entries"("createdAt");
CREATE INDEX "admin_audit_entries_adminId_createdAt_idx" ON "admin_audit_entries"("adminId", "createdAt");
