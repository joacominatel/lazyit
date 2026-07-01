-- Programmatic secret retrieval via a service account (ADR-0080, extends ADR-0061 + ADR-0048).
-- Adds the machine crypto identity (ServiceAccountKeypair), the SA→vault wrapped-DEK join
-- (ServiceAccountVaultMembership), the SA actor/target soft-ref columns + audit actions on the
-- append-only SecretAuditLog, and the at-most-one-actor CHECK (human XOR service-account).
-- Every column here holds ONLY ciphertext / public material / metadata — the server never decrypts (INV-10).

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "SecretAuditAction" ADD VALUE 'SA_KEYPAIR_CREATED';
ALTER TYPE "SecretAuditAction" ADD VALUE 'ITEMS_FETCHED';

-- AlterTable
ALTER TABLE "secret_audit_logs" ADD COLUMN     "serviceAccountId" TEXT,
ADD COLUMN     "targetServiceAccountId" TEXT;

-- CreateTable
CREATE TABLE "service_account_keypairs" (
    "id" TEXT NOT NULL,
    "serviceAccountId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "privateKeySalt" TEXT NOT NULL,
    "privateKeyIv" TEXT NOT NULL,
    "kdfParams" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "service_account_keypairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_account_vault_memberships" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "serviceAccountId" TEXT NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "wrapNonce" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "wrapVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_account_vault_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_account_keypairs_serviceAccountId_key" ON "service_account_keypairs"("serviceAccountId");

-- CreateIndex
CREATE INDEX "service_account_vault_memberships_serviceAccountId_idx" ON "service_account_vault_memberships"("serviceAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "service_account_vault_memberships_vaultId_serviceAccountId_key" ON "service_account_vault_memberships"("vaultId", "serviceAccountId");

-- CreateIndex
CREATE INDEX "secret_audit_logs_serviceAccountId_idx" ON "secret_audit_logs"("serviceAccountId");

-- AddForeignKey
ALTER TABLE "service_account_keypairs" ADD CONSTRAINT "service_account_keypairs_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_vault_memberships" ADD CONSTRAINT "service_account_vault_memberships_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "secret_vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_vault_memberships" ADD CONSTRAINT "service_account_vault_memberships_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AT-MOST-ONE-ACTOR CHECK (ADR-0048 fork #4 belt-and-suspenders, ADR-0080). An audit row's actor is
-- EITHER a human (actorId) OR a service account (serviceAccountId), never both. Raw SQL (not expressible
-- in the Prisma schema), mirroring the ADR-0048 at-most-one-actor CHECKs on the other audit-bearing tables.
ALTER TABLE "secret_audit_logs" ADD CONSTRAINT "secret_audit_logs_one_actor_chk"
  CHECK (NOT ("actorId" IS NOT NULL AND "serviceAccountId" IS NOT NULL));
