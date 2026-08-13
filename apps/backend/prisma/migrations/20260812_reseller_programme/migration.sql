-- The reseller programme: a panel role, per-plan voucher capacity, and
-- an owner recorded on every code a reseller mints.
--
-- Resellers pay the operator directly, outside every payment system, and
-- hand subscriptions on to their own customers as vouchers. The capacity
-- they bought is held here as per-plan token balances; minting a voucher
-- spends one, deleting an unredeemed one gives it back.
--
-- Deliberately reuses the existing Voucher/VoucherRedemption tables
-- rather than adding a parallel reseller-voucher concept. A voucher a
-- reseller cut and a voucher the operator cut redeem through exactly the
-- same code path, including the race-safe redemption counter -- the only
-- difference is who owns it, which is what issuedByAdminId records.

-- Postgres orders enum values by creation and existing rows sort by that
-- order, so this is appended rather than inserted among the others.
-- IF NOT EXISTS keeps a re-run harmless.
--
-- Note this migration only ADDS the value and never writes it. Postgres
-- forbids using a new enum value in the same transaction that created it,
-- and Prisma wraps a migration in one -- so granting someone the RESELLER
-- role has to happen in a later statement, which it does (from the panel).
ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'RESELLER';

-- How many vouchers of one plan a reseller may still mint.
--
-- Per plan, not one shared wallet: capacity is sold as "10 Starter,
-- 5 Pro", and a single balance would let someone who paid for ten cheap
-- plans mint ten expensive ones instead.
CREATE TABLE IF NOT EXISTS "reseller_token_balances" (
    "id"          TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "planId"      TEXT NOT NULL,
    -- CHECK, not just application logic. The spend is a conditional
    -- UPDATE guarded on balance > 0, but a constraint here is what makes
    -- a negative balance impossible rather than merely unlikely -- and
    -- an overdrawn reseller is free subscriptions.
    "balance"     INTEGER NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_token_balances_pkey" PRIMARY KEY ("id")
);

-- One row per reseller per plan. Also what makes granting capacity a
-- safe upsert instead of a read-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS "reseller_token_balances_adminUserId_planId_key"
    ON "reseller_token_balances" ("adminUserId", "planId");

CREATE INDEX IF NOT EXISTS "reseller_token_balances_planId_idx"
    ON "reseller_token_balances" ("planId");

-- Cascade: deleting the admin account deletes its balances, because a
-- balance belonging to nobody is not a record worth keeping. The plan
-- reference does NOT cascade -- a plan with outstanding reseller
-- capacity against it should refuse to be deleted rather than silently
-- voiding what someone paid for.
ALTER TABLE "reseller_token_balances"
    ADD CONSTRAINT "reseller_token_balances_adminUserId_fkey"
    FOREIGN KEY ("adminUserId") REFERENCES "admin_users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reseller_token_balances"
    ADD CONSTRAINT "reseller_token_balances_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "subscription_plans" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who minted the code, and who it was sent to.
--
-- Both nullable, and both nullable for real reasons rather than for
-- convenience: issuedByAdminId is null for the codes the operator cuts
-- directly (every voucher that exists today), and recipientEmail is null
-- for a code generated to be handed over in person, which is a supported
-- case the reseller UI offers on purpose.
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "issuedByAdminId" TEXT;
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "recipientEmail"  TEXT;

-- Every reseller-facing query filters on this, so it is indexed: the
-- history list, the balance reconciliation, and the ownership check that
-- stops one reseller revoking another's code.
CREATE INDEX IF NOT EXISTS "vouchers_issuedByAdminId_idx"
    ON "vouchers" ("issuedByAdminId");

-- SET NULL rather than CASCADE. Deleting an admin account must not delete
-- the vouchers they issued: those may already be redeemed, and a
-- VoucherRedemption pointing at a vanished voucher would lose the record
-- of why a customer has the subscription they have.
ALTER TABLE "vouchers"
    ADD CONSTRAINT "vouchers_issuedByAdminId_fkey"
    FOREIGN KEY ("issuedByAdminId") REFERENCES "admin_users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
