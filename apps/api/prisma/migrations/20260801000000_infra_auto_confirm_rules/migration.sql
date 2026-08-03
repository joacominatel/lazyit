-- Operator-authored auto-confirm rules for the ADR-0074 PENDING review tray (§1 amendment, #1145).
--
-- ADDITIVE ONLY: one new enum and one new table. No existing table is touched, no column is dropped
-- or made NOT NULL without a default, and there is nothing to backfill — an instance that upgrades
-- lands with zero rules, which is byte-identical to the behaviour it had before (every discovered
-- host keeps arriving PENDING until a human confirms it). Rules only ever apply to reports that
-- arrive AFTER a human saves one; they are never retroactive.

-- CreateEnum
CREATE TYPE "InfraAutoConfirmScope" AS ENUM ('HOST', 'CONTAINER', 'ANY');

-- CreateTable
CREATE TABLE "infra_auto_confirm_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" "InfraAutoConfirmScope" NOT NULL DEFAULT 'HOST',
    "hostnamePattern" TEXT,
    "subnetCidr" TEXT,
    "reportedKind" "InfraNodeKind",
    "confirmAsKind" "InfraNodeKind",
    "trackAsAsset" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "infra_auto_confirm_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infra_auto_confirm_rules_enabled_idx" ON "infra_auto_confirm_rules"("enabled");

-- CreateIndex
CREATE INDEX "infra_auto_confirm_rules_createdById_idx" ON "infra_auto_confirm_rules"("createdById");

-- AddForeignKey
-- SetNull, never Cascade: a rule is instance policy. Deleting the operator who wrote it must not
-- silently retire a decision the estate depends on — it leaves the rule running and unattributed,
-- which the rules list surfaces.
ALTER TABLE "infra_auto_confirm_rules" ADD CONSTRAINT "infra_auto_confirm_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
