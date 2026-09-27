-- Consumable deliveries: an optional delivery TARGET on an OUT movement, returnable items and returns
-- (ADR-0098, issue #1364). ADDITIVE ONLY (upgrade-safe over live data): two new enum VALUES, one
-- defaulted column on `consumables`, five new columns on `consumable_movements` (three nullable target
-- FKs, a defaulted `returnable` snapshot, a nullable self-FK `returnOfId`), four indexes and four CHECKs.
-- No column is dropped, nothing is made NOT NULL without a default, nothing is backfilled.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE:
--   * Every existing consumable reads `returnable = false` (the column default) — nothing becomes
--     "outstanding" retroactively.
--   * Every existing movement reads NO target, `returnable = false`, `returnOfId = NULL` — exactly
--     today's meaning (an untargeted IN/OUT/ADJUSTMENT). All four CHECKs below hold for such a row, so
--     adding them validates the populated table without a failure.
--   * Stock (`consumables.currentStock`) is not touched.

-- AlterEnum: the ACKNOWLEDGED / AGENT_LINKED precedent. `ADD VALUE` APPENDS to the type — O(1), never
-- rewrites `asset_history`. Safe inside this migration's transaction on PostgreSQL 12+ (the compose image
-- pins 18) because neither value is USED within the same transaction: only future INSERTs reference
-- them. Appended at the tail here and at the tail of the PSL enum, so the two orders stay in step.
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'CONSUMABLE_DELIVERED';
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'CONSUMABLE_RETURNED';

-- AlterTable: the delivery target (at most one), the returnable SNAPSHOT and the return linkage.
ALTER TABLE "consumable_movements" ADD COLUMN     "returnOfId" INTEGER,
ADD COLUMN     "returnable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "targetAssetId" TEXT,
ADD COLUMN     "targetLocationId" TEXT,
ADD COLUMN     "targetUserId" UUID;

-- AlterTable: the per-consumable returnable flag (default false).
ALTER TABLE "consumables" ADD COLUMN     "returnable" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "consumable_movements_targetUserId_idx" ON "consumable_movements"("targetUserId");

-- CreateIndex
CREATE INDEX "consumable_movements_targetAssetId_idx" ON "consumable_movements"("targetAssetId");

-- CreateIndex
CREATE INDEX "consumable_movements_targetLocationId_idx" ON "consumable_movements"("targetLocationId");

-- CreateIndex
CREATE INDEX "consumable_movements_returnOfId_idx" ON "consumable_movements"("returnOfId");

-- AddForeignKey: RESTRICT on every target — a delivery is history-bearing (mirrors ADR-0019). Soft
-- deletes are UPDATEs of `deletedAt` and never fire ON DELETE, so offboarding a user, retiring an asset
-- or archiving a location is unaffected; only a genuine hard delete of a delivered-to row is refused.
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_targetAssetId_fkey" FOREIGN KEY ("targetAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_targetLocationId_fkey" FOREIGN KEY ("targetLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: a return points at the delivery it gives back. RESTRICT — the ledger is append-only.
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_returnOfId_fkey" FOREIGN KEY ("returnOfId") REFERENCES "consumable_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECKs (raw SQL — no PSL syntax; runbook prisma-migrations §3). Prisma neither emits nor reports these
-- as drift. The service enforces the same rules with clean 400s; these are the database backstop.
-- (1) At most ONE delivery target.
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_at_most_one_target"
  CHECK (num_nonnulls("targetUserId", "targetAssetId", "targetLocationId") <= 1);
-- (2) A target only on an OUT (a delivery is stock leaving the shelf).
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_target_only_on_out"
  CHECK ("type" = 'OUT'::"ConsumableMovementType"
         OR num_nonnulls("targetUserId", "targetAssetId", "targetLocationId") = 0);
-- (3) A return link only on an IN (a return puts stock back).
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_return_only_on_in"
  CHECK ("returnOfId" IS NULL OR "type" = 'IN'::"ConsumableMovementType");
-- (4) The returnable snapshot only on a TARGETED OUT (a delivery with a recipient).
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_returnable_only_on_delivery"
  CHECK ("returnable" = false
         OR ("type" = 'OUT'::"ConsumableMovementType"
             AND num_nonnulls("targetUserId", "targetAssetId", "targetLocationId") = 1));
