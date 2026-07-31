-- Reporter attribution on a topology node (ADR-0074 §8, issue #1134). `POST /infra/report` creates a
-- row for every unknown host, so an unbounded reporter is a DB-fill DoS. The cap that bounds it counts
-- LIVE PENDING proposals per reporting service account, which needs a trustworthy per-reporter key:
-- `reportingSource` is a client-chosen body field an attacker can rotate per request, so it cannot be
-- one. This column is derived SERVER-side from the bearer token instead.
--
-- Upgrade-safe: purely additive and NULLABLE, no backfill. Rows that predate it stay NULL (they simply
-- share the "unattributed" budget bucket) and self-heal on the reporting host's next check-in, which
-- stamps the column — at most one report cadence (15 min by default) after the upgrade.

-- AlterTable
ALTER TABLE "infra_nodes" ADD COLUMN     "reportedBySaId" TEXT;

-- CreateIndex
-- The budget probe runs on the create branch of every unknown-host report: count LIVE PENDING rows for
-- one reporter. The composite keeps it an index lookup rather than a table scan.
CREATE INDEX "infra_nodes_reportedBySaId_state_idx" ON "infra_nodes"("reportedBySaId", "state");

-- AddForeignKey
-- SetNull, mirroring every other service-account attribution: revoking/deleting the account must never
-- cascade into the topology graph (and, incidentally, frees that reporter's budget).
ALTER TABLE "infra_nodes" ADD CONSTRAINT "infra_nodes_reportedBySaId_fkey" FOREIGN KEY ("reportedBySaId") REFERENCES "service_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
