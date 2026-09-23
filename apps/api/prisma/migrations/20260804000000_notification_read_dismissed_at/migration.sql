-- Per-user notification dismiss (ADR-0056 §7 amendment, issue #1309). ADDITIVE ONLY (upgrade-safe over
-- live data): one new NULLABLE column on the per-user read join. No default, no backfill, no index, no
-- existing row touched. `ADD COLUMN` of a nullable column without a default is a catalog-only change on
-- PostgreSQL, so it does not rewrite a populated `notification_reads`.
--
-- Existing data: every existing read row gets `dismissedAt = NULL` (not dismissed), so every notification
-- stays visible in every bell exactly as before until a user dismisses it. The `notifications` event
-- table is not altered — dismiss never mutates or deletes the shared event.

-- AlterTable
ALTER TABLE "notification_reads" ADD COLUMN "dismissedAt" TIMESTAMP(3);
