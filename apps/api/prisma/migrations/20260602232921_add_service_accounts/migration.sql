-- Service Accounts (ADR-0048): a non-human principal that authenticates with a lazyit-native token
-- (lzit_sa_<id>_<secret>) and is authorized by direct permission grants from the @lazyit/shared
-- catalog — never a Role, never ADMIN-equivalent. This migration adds the three SA tables, the
-- additive nullable serviceAccountId actor columns on the 6 audit-bearing append-only tables, the
-- partial-unique tokenHash index, and the at-most-one-actor CHECK constraints (raw SQL Prisma can't
-- express in PSL — invisible to `migrate diff`, so the drift check stays green; see
-- docs/05-runbooks/prisma-migrations.md §3).

-- CreateEnum
CREATE TYPE "ServiceAccountAuditAction" AS ENUM ('MINT', 'ROTATE', 'REVOKE', 'RESTORE', 'PERMISSION_CHANGE');

-- AlterTable
ALTER TABLE "asset_assignments" ADD COLUMN     "assignedBySaId" TEXT,
ADD COLUMN     "releasedBySaId" TEXT;

-- AlterTable
ALTER TABLE "asset_history" ADD COLUMN     "serviceAccountId" TEXT;

-- AlterTable
ALTER TABLE "article_versions" ADD COLUMN     "serviceAccountId" TEXT;

-- AlterTable
ALTER TABLE "article_links" ADD COLUMN     "serviceAccountId" TEXT;

-- AlterTable
ALTER TABLE "access_grants" ADD COLUMN     "grantedBySaId" TEXT,
ADD COLUMN     "revokedBySaId" TEXT;

-- AlterTable
ALTER TABLE "consumable_movements" ADD COLUMN     "serviceAccountId" TEXT;

-- CreateTable
CREATE TABLE "service_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "service_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_account_permissions" (
    "serviceAccountId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "service_account_permissions_pkey" PRIMARY KEY ("serviceAccountId","permission")
);

-- CreateTable
CREATE TABLE "service_account_audit_log" (
    "id" SERIAL NOT NULL,
    "serviceAccountId" TEXT NOT NULL,
    "action" "ServiceAccountAuditAction" NOT NULL,
    "actorId" UUID,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_account_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_accounts_isActive_idx" ON "service_accounts"("isActive");

-- CreateIndex
CREATE INDEX "service_account_permissions_serviceAccountId_idx" ON "service_account_permissions"("serviceAccountId");

-- CreateIndex
CREATE INDEX "service_account_audit_log_serviceAccountId_id_idx" ON "service_account_audit_log"("serviceAccountId", "id");

-- AddForeignKey
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_permissions" ADD CONSTRAINT "service_account_permissions_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_audit_log" ADD CONSTRAINT "service_account_audit_log_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_account_audit_log" ADD CONSTRAINT "service_account_audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assignedBySaId_fkey" FOREIGN KEY ("assignedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_releasedBySaId_fkey" FOREIGN KEY ("releasedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_history" ADD CONSTRAINT "asset_history_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_links" ADD CONSTRAINT "article_links_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_grantedBySaId_fkey" FOREIGN KEY ("grantedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_revokedBySaId_fkey" FOREIGN KEY ("revokedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- Service-account constraints Prisma cannot express in PSL (raw SQL — invisible to `migrate diff`, so
-- the drift check stays green). See ADR-0048 and docs/05-runbooks/prisma-migrations.md §3.
-- ---------------------------------------------------------------------------------------------------

-- TOKEN-HASH UNIQUENESS AMONG LIVE ROWS (ADR-0048 / soft-delete-reuse precedent ADR-0041): a service
-- account's tokenHash must be unique, but only among LIVE rows — a soft-deleted (revoked) account must
-- not block re-using an (astronomically unlikely) identical hash, and Restore must be able to reclaim
-- it. A PARTIAL unique index WHERE "deletedAt" IS NULL (Prisma can't express a partial unique in PSL,
-- mirroring the User.email / AssetAssignment precedent). No plain @unique (that re-introduces the
-- ghost-row collision).
CREATE UNIQUE INDEX "service_accounts_tokenHash_live_key"
  ON "service_accounts" ("tokenHash") WHERE "deletedAt" IS NULL;

-- AT-MOST-ONE-ACTOR (ADR-0048): on every audit-bearing append-only row, at most ONE of (human actor,
-- service-account actor) may be set — never both. An audited action is performed by a human OR a
-- service account, never simultaneously. Counting the non-null actors per actor-slot must be <= 1.
-- This is the DB-level guarantee behind ActorService.resolve(principal), so a row attributed to two
-- principals can never be persisted. (assetId/articleId/… etc. remain required as before.)
ALTER TABLE "asset_history" ADD CONSTRAINT "asset_history_one_actor"
  CHECK ((("performedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);

ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_one_actor"
  CHECK ((("performedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);

ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_one_actor"
  CHECK ((("editedById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);

ALTER TABLE "article_links" ADD CONSTRAINT "article_links_one_actor"
  CHECK ((("createdById" IS NOT NULL)::int + ("serviceAccountId" IS NOT NULL)::int) <= 1);

-- AssetAssignment and AccessGrant carry TWO actor slots each (assigned/released, granted/revoked) — one
-- CHECK per slot.
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assigned_one_actor"
  CHECK ((("assignedById" IS NOT NULL)::int + ("assignedBySaId" IS NOT NULL)::int) <= 1);
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_released_one_actor"
  CHECK ((("releasedById" IS NOT NULL)::int + ("releasedBySaId" IS NOT NULL)::int) <= 1);

ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_one_actor"
  CHECK ((("grantedById" IS NOT NULL)::int + ("grantedBySaId" IS NOT NULL)::int) <= 1);
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_revoked_one_actor"
  CHECK ((("revokedById" IS NOT NULL)::int + ("revokedBySaId" IS NOT NULL)::int) <= 1);
