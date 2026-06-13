-- CreateEnum
CREATE TYPE "SecretAuditAction" AS ENUM ('VAULT_CREATED', 'VAULT_DELETED', 'ITEM_CREATED', 'ITEM_UPDATED', 'ITEM_DELETED', 'MEMBERSHIP_GRANTED', 'MEMBERSHIP_REVOKED', 'KEYPAIR_CREATED', 'KEYPAIR_RESET');

-- CreateTable
CREATE TABLE "secret_vaults" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "secret_vaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_items" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "secret_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_memberships" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "wrapNonce" TEXT NOT NULL,
    "wrappedDek" TEXT NOT NULL,
    "wrapVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_keypairs" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEncByPassphrase" TEXT NOT NULL,
    "passphraseSalt" TEXT NOT NULL,
    "passphraseIv" TEXT NOT NULL,
    "kdfParams" JSONB NOT NULL,
    "privateKeyEncByRecovery" TEXT NOT NULL,
    "recoverySalt" TEXT NOT NULL,
    "recoveryIv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_keypairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_audit_logs" (
    "id" SERIAL NOT NULL,
    "action" "SecretAuditAction" NOT NULL,
    "actorId" UUID,
    "vaultId" TEXT,
    "itemId" TEXT,
    "targetUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secret_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "secret_items_vaultId_idx" ON "secret_items"("vaultId");

-- CreateIndex
CREATE INDEX "vault_memberships_userId_idx" ON "vault_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "vault_memberships_vaultId_userId_key" ON "vault_memberships"("vaultId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_keypairs_userId_key" ON "user_keypairs"("userId");

-- CreateIndex
CREATE INDEX "secret_audit_logs_vaultId_idx" ON "secret_audit_logs"("vaultId");

-- CreateIndex
CREATE INDEX "secret_audit_logs_createdAt_idx" ON "secret_audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "secret_items" ADD CONSTRAINT "secret_items_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "secret_vaults"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "secret_vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_memberships" ADD CONSTRAINT "vault_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_keypairs" ADD CONSTRAINT "user_keypairs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_audit_logs" ADD CONSTRAINT "secret_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
-- Partial UNIQUE index: GLOBAL vault-name uniqueness among LIVE rows only (deletedAt IS NULL). Prisma
-- can't express a partial unique index in PSL (no `@unique` on SecretVault.name — that would emit a
-- FULL unique index and re-introduce the ghost-row collision a soft-deleted vault would cause), so it
-- lives here as raw SQL. A soft-deleted vault frees its name for reuse/restore (ADR-0041). Mirrors the
-- User.email / ServiceAccount.tokenHash live-only pattern. NOT drift — see
-- docs/03-decisions/0061-secret-manager-zero-knowledge.md §2 and docs/05-runbooks/prisma-migrations.md.
CREATE UNIQUE INDEX "secret_vaults_name_live_key"
    ON "secret_vaults"("name")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
-- Partial UNIQUE index: GLOBAL handle uniqueness among LIVE rows only (deletedAt IS NULL). The §8 KB
-- chip `{{ lazyit_secret.HANDLE }}` MUST resolve to EXACTLY ONE live item — the deliberate contract for
-- slice 4 (ADR-0061 §8). Global (not per-vault) on purpose. Prisma can't express a partial unique index
-- in PSL (no `@unique` on SecretItem.handle), so it lives here as raw SQL; a soft-deleted item frees its
-- handle for reuse/restore (ADR-0041). NOT drift.
CREATE UNIQUE INDEX "secret_items_handle_live_key"
    ON "secret_items"("handle")
    WHERE "deletedAt" IS NULL;
