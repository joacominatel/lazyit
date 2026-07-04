-- Make `Location` hierarchical — issue #845. Adds a self-referential `parentId` (adjacency list) so
-- a location can hang off any other (a FREE tree: site → room → rack is a convention, not enforced;
-- the only structural rule, NO CYCLES, lives in LocationsService — the DB can't express it). The
-- existing `type` enum doubles as the node "kind" (no new column). onDelete: SetNull mirrors
-- Asset.locationId — a hard-removed parent orphans its children to roots (normal deletes are soft).
-- Generated OFFLINE via `prisma migrate diff` (schema-to-schema, NO database connection) — mirrors the
-- notification-opt-out / local-auth migration precedents. Additive + nullable, so no backfill and no
-- lock risk on existing rows.

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "locations_parentId_idx" ON "locations"("parentId");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

