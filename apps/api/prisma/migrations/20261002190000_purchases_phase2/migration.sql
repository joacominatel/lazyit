-- Purchases Phase 2 (ADR-0099, #1477): document extraction behind its own AI switch, and LICENSE lines.
-- ADDITIVE ONLY: one defaulted boolean, one nullable column, one defaulted integer, one index, one foreign key.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten, backfilled or inferred.
--   * `ai_settings."documentExtractionEnabled"` is `false` on the singleton row (when one exists): document
--     extraction is OFF on every upgraded instance, so no purchase document leaves the host until an admin
--     turns it on in Settings → AI. The chat, MCP and web-search settings are untouched.
--   * `purchase_order_lines."applicationId"` is NULL on every existing line (no line is LICENSE yet: the kind
--     is TEXT validated on write, and no earlier build could write it).
--   * `purchase_order_lines."appliedSeats"` is 0 on every existing line. It counts only for LICENSE lines, so
--     no existing line's received count, pending count or receipt state changes.
--   * No application's `seatsPurchased` or `renewalDate` changes: only an explicit apply ever writes them.
--   * The foreign key is validated against a column that is NULL on every row, so adding it cannot fail on a
--     populated table.

-- AlterTable
ALTER TABLE "ai_settings" ADD COLUMN     "documentExtractionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "applicationId" TEXT,
ADD COLUMN     "appliedSeats" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "purchase_order_lines_applicationId_idx" ON "purchase_order_lines"("applicationId");

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
