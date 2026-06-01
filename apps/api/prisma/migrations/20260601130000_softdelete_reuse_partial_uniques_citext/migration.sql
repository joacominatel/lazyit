-- Soft-delete REUSE policy (ADR-0041): "Restore + partial unique indexes".
--
-- Every @unique on a soft-deletable model was a FULL unique index, so a soft-deleted (but still
-- present) email/slug/sku/name/serial/assetTag kept colliding forever against an invisible ghost
-- row — making the value impossible to recreate or restore. This migration replaces each of those
-- full unique indexes with a PARTIAL unique index `WHERE "deletedAt" IS NULL`, scoping uniqueness to
-- LIVE rows only. Prisma cannot express a partial unique index in PSL (the `@unique` attributes were
-- removed from schema.prisma), so the partial indexes live here as raw SQL — exactly the
-- AssetAssignment precedent (`asset_assignments_assetId_userId_active_key`). See
-- docs/03-decisions/0041-soft-delete-reuse-and-restore.md and docs/05-runbooks/prisma-migrations.md §3.
--
-- It also makes `users.email` CASE-INSENSITIVE (citext): with OIDC/JIT live, "Bob@x" and "bob@x" are
-- the same mailbox and must never mint two users. The citext extension is created first so the
-- column type change below succeeds.

-- citext must exist before the email column can be re-typed to it.
CREATE EXTENSION IF NOT EXISTS citext;

-- DropIndex — replace each FULL unique with a partial one (created at the bottom of this migration).
DROP INDEX "application_categories_name_key";

-- DropIndex
DROP INDEX "article_categories_name_key";

-- DropIndex
DROP INDEX "articles_slug_key";

-- DropIndex
DROP INDEX "asset_categories_name_key";

-- DropIndex
DROP INDEX "asset_models_sku_key";

-- DropIndex
DROP INDEX "assets_assetTag_key";

-- DropIndex
DROP INDEX "assets_serial_key";

-- DropIndex
DROP INDEX "consumable_categories_name_key";

-- DropIndex
DROP INDEX "consumables_sku_key";

-- DropIndex
DROP INDEX "users_email_key";

-- AlterTable — email becomes case-insensitive (citext). Existing values are preserved; comparisons
-- and the partial unique index below are now case-insensitive.
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE CITEXT;

-- ---------------------------------------------------------------------------------------------------
-- Partial UNIQUE indexes — raw SQL Prisma cannot represent (it neither emits nor reports these on
-- `migrate diff`, so the drift check stays green). Uniqueness applies to LIVE rows only
-- (`"deletedAt" IS NULL`); soft-deleted rows are exempt, freeing the value for reuse and letting a
-- Restore reclaim it. Index names mirror the dropped `_key` indexes with an `_active` suffix, in the
-- AssetAssignment style.
-- ---------------------------------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "users_email_active_key"
    ON "users"("email")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "asset_categories_name_active_key"
    ON "asset_categories"("name")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "asset_models_sku_active_key"
    ON "asset_models"("sku")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "assets_serial_active_key"
    ON "assets"("serial")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "assets_assetTag_active_key"
    ON "assets"("assetTag")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "article_categories_name_active_key"
    ON "article_categories"("name")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_active_key"
    ON "articles"("slug")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "application_categories_name_active_key"
    ON "application_categories"("name")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "consumable_categories_name_active_key"
    ON "consumable_categories"("name")
    WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "consumables_sku_active_key"
    ON "consumables"("sku")
    WHERE "deletedAt" IS NULL;
