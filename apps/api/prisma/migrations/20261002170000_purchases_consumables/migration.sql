-- Purchases Phase 1b (ADR-0099, #1476): consumable purchase lines received into stock, and the document type
-- label. ADDITIVE ONLY: three NULLABLE columns with no default, two indexes, two foreign keys and one CHECK.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten, backfilled or inferred.
--   * `purchase_order_lines."consumableId"` is NULL on every existing line (no line is CONSUMABLE yet: the
--     kind is TEXT validated on write, and no earlier build could write it).
--   * `consumable_movements."purchaseOrderLineId"` is NULL on every existing movement: no past IN is
--     attributed to a purchase (guessing would forge history). `currentStock` is untouched. The ledger stays
--     append-only — the column is set at insert by a new receipt, never updated.
--   * `attachments."label"` is NULL on every existing document ("no type").
--   * The foreign keys and the CHECK are validated against columns that are NULL on every row, so adding
--     them cannot fail on a populated table. The recent_activity view reads none of these columns.

-- AlterTable
ALTER TABLE "consumable_movements" ADD COLUMN     "purchaseOrderLineId" TEXT;

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "consumableId" TEXT;

-- CreateIndex
CREATE INDEX "consumable_movements_purchaseOrderLineId_idx" ON "consumable_movements"("purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "purchase_order_lines_consumableId_idx" ON "purchase_order_lines"("consumableId");

-- AddForeignKey
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_consumableId_fkey" FOREIGN KEY ("consumableId") REFERENCES "consumables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK (raw SQL — no PSL syntax; runbook prisma-migrations §3), mirroring the ADR-0098 movement CHECKs:
-- a purchase receipt only ever ADDS stock, so the line id is allowed on an IN only. Prisma neither emits nor
-- reports it, so `migrate diff` stays clean.
ALTER TABLE "consumable_movements" ADD CONSTRAINT "consumable_movements_purchase_line_only_on_in"
  CHECK ("purchaseOrderLineId" IS NULL OR "type" = 'IN'::"ConsumableMovementType");
