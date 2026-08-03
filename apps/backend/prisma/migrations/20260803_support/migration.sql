-- Async support tickets, presented in the app as a chat.
-- Additive: three new tables and one enum, nothing existing altered.

CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'ANSWERED', 'RESOLVED');

CREATE TABLE "support_settings" (
    "id" TEXT NOT NULL,
    "acceptingTickets" BOOLEAN NOT NULL DEFAULT false,
    "awayMessage" TEXT,
    "replyWithinHours" INTEGER DEFAULT 24,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerLastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_customerId_idx" ON "support_tickets"("customerId");
CREATE INDEX "support_tickets_status_lastMessageAt_idx" ON "support_tickets"("status", "lastMessageAt");

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromAdmin" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_messages_ticketId_createdAt_idx" ON "support_messages"("ticketId", "createdAt");

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
