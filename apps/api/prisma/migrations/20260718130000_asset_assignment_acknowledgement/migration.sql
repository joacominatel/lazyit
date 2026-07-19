-- Check-out acknowledgement (ADR-0089 Part B, issue #1029). Purely ADDITIVE:
--   1. A new AssetHistoryEventType value (ACKNOWLEDGED). Safe to add in this migration on PostgreSQL
--      12+ (the value is NOT used within this same migration — only future INSERTs reference it).
--   2. Additive lifecycle metadata on the already-mutable `asset_assignments` join: `acknowledgedAt`,
--      `acknowledgedById` (FK -> users, SetNull, mirroring assignedById/releasedById) and
--      `acknowledgeNote`. NOT an append-only violation — the immutable trail is the ACKNOWLEDGED
--      asset_history row.
-- No data backfill, no drops, no destructive change.

-- AlterEnum
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'ACKNOWLEDGED';

-- AlterTable
ALTER TABLE "asset_assignments" ADD COLUMN     "acknowledgeNote" TEXT,
ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" UUID;

-- AddForeignKey
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
