-- Custom asset statuses (ADR-0101, #1524): an operator-defined name mapped to one built-in AssetStatus.
--
-- Additive only. One NEW table and one NULLABLE column on "assets" with no default: every existing asset
-- reads statusLabelId = NULL (a bare built-in status, exactly as before) and its "status" is untouched. No
-- backfill, no row is rewritten, and the "AssetStatus" enum is reused as is (the new table's "kind" column
-- is typed by it; no value is added or altered). The FK on assets is validated against a column that is
-- NULL on every row, and nothing in the recent_activity view references the new column.

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "statusLabelId" TEXT;

-- CreateTable
CREATE TABLE "asset_status_labels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AssetStatus" NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "order" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "asset_status_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_status_labels_kind_idx" ON "asset_status_labels"("kind");

-- CreateIndex
CREATE INDEX "assets_statusLabelId_idx" ON "assets"("statusLabelId");

-- The name is unique among LIVE labels only (ADR-0041): a PARTIAL unique index Prisma cannot express, so it
-- lives here and not in the schema (drift stays green — see docs/05-runbooks/prisma-migrations.md §3).
-- Case-sensitive, like the category names. A soft-deleted label frees its name for reuse; restoring it while
-- a live label holds the name is a 409.
CREATE UNIQUE INDEX "asset_status_labels_name_active_key"
    ON "asset_status_labels"("name")
    WHERE "deletedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_statusLabelId_fkey" FOREIGN KEY ("statusLabelId") REFERENCES "asset_status_labels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
