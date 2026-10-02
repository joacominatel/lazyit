-- Purchases flows (ADR-0099, #1473): linking assets to purchase lines and purchase documents. ADDITIVE ONLY:
-- three enum VALUES appended at the tail, nothing else.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: nothing is rewritten, backfilled or validated.
--   * `asset_history` gains two event types (PURCHASE_LINKED, PURCHASE_UNLINKED); existing rows keep theirs.
--     The recent_activity view lowercases the type generically, so it needs no change.
--   * `attachments` gains a parent type (PURCHASE_ORDER); every existing row stays ASSET or ARTICLE.
--   * No asset is linked by this migration: every `assets."purchaseOrderLineId"` stays as it is (NULL on every
--     instance that has not linked anything yet). Linking is a manual, audited action.
--
-- The ACKNOWLEDGED / AGENT_LINKED / CONSUMABLE_* precedent: `ADD VALUE` APPENDS to the type — O(1), never
-- rewrites a table. Safe inside this migration's transaction on PostgreSQL 12+ (the compose image pins 18)
-- because no value is USED within the same transaction. Appended at the tail here and in the PSL enums, so
-- the two orders stay in step.

-- AlterEnum
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'PURCHASE_LINKED';
ALTER TYPE "AssetHistoryEventType" ADD VALUE 'PURCHASE_UNLINKED';

-- AlterEnum
ALTER TYPE "AttachmentEntityType" ADD VALUE 'PURCHASE_ORDER';
