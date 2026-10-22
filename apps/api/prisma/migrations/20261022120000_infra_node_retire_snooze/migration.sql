-- Retire lifecycle + offline-alert snooze for infra nodes (#1701, epic #1146 Q11 + Q15).
--
-- ADDITIVE ONLY: three nullable columns on `infra_nodes` and one SetNull foreign key. Nothing is
-- dropped, renamed or made NOT NULL, and there is nothing to backfill.
--
-- WHAT HAPPENS TO EXISTING DATA ON UPDATE: every existing node reads `retiredAt = NULL` (not retired)
-- and `alertsSnoozedUntil = NULL` (not snoozed), which is exactly today's behaviour: the staleness
-- sweeper keeps judging and announcing them as before. No index: both columns are read only as extra
-- predicates on queries that are already narrowed by `source`/`status`, and on the per-node row.

-- AlterTable
ALTER TABLE "infra_nodes" ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "retiredById" UUID,
ADD COLUMN     "alertsSnoozedUntil" TIMESTAMP(3);

-- AddForeignKey
-- SetNull, never Cascade: deleting the operator who retired a node must not delete or un-retire it.
ALTER TABLE "infra_nodes" ADD CONSTRAINT "infra_nodes_retiredById_fkey" FOREIGN KEY ("retiredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
